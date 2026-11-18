// app.ts: the HTTP server, its router and the JSON discipline every surface shares.
//
// The routes, in the order the suite meets them:
//   GET  /healthz                      the env's boot probe
//   /api/v3/...                        REST v3 (auth required, JSON always, request id always)
//   POST /api/graphql                  GraphQL v4 (401 without a token)
//   POST /mcp                          MCP over streamable HTTP (401 without a token)
//   /<owner>/<repo>.git/<service>      git smart HTTP
//   anything else                      404 with {"message": "Not Found"}
//
// Two layers, and nothing between them:
//   route(request)   the router above: one synchronous function from a parsed request to a
//                    {status, headers, body} reply. Every surface's behaviour lives here, and
//                    it is exactly the behaviour the conformance checks read.
//   the wire         a hand-rolled HTTP/1.1 keep-alive server on node:net. The trial's workloads
//                    are thousands of tiny requests on one warm socket, so the transport is the
//                    hot path: parsing is a buffer scan, a reply is one write() of one
//                    pre-assembled buffer, and a GET's bytes are reused until something writes.
//
// The reply cache is what makes the read workload cheap: a GET is answered from the bytes it
// answered with before, until any request that can change the store (anything but GET/HEAD) has
// been served. Nothing else is cached here; the store caches its own repeatable answers.

import { createServer } from 'node:net';
import { Store, HttpError } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { infoRefs, receivePack, uploadPackV2 } from './githttp.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;
/** How many serialized GET replies to keep before starting over. */
const MAX_CACHED_REPLIES = 4096;

const EMPTY = Buffer.alloc(0);
const CRLF = Buffer.from('\r\n', 'latin1');
const HEAD_END = Buffer.from('\r\n\r\n', 'latin1');
const EMPTY_QUERY = Object.freeze({});

const REASONS = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Payload Too Large',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

/** A parsed request: the method, the raw target, lowercased headers and the body bytes. */
interface Request {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer;
}

/** A reply: what the router decides, before it becomes bytes. */
interface Reply {
  status: number;
  headers: Record<string, string>;
  body: Buffer | null;
}

/** The bearer token on a request, if any. */
function tokenOf(headers) {
  const header = headers.authorization;
  if (typeof header === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) return match[1].trim();
    if (header.trim() !== '') return header.trim();
  }
  const shop = headers['x-shopify-access-token'];
  if (typeof shop === 'string' && shop !== '') return shop;
  return null;
}

/** Parse a JSON body, answering 400 for anything that is not JSON. */
function parseJson(buffer) {
  if (buffer.length === 0) return {};
  let text;
  try {
    text = buffer.toString('utf8').trim();
  } catch {
    throw new HttpError(400, 'Problems parsing JSON');
  }
  if (text === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Problems parsing JSON');
  }
}

/** The origin a request reached us on, for absolute pagination links. */
function originOf(headers) {
  const host = headers.host;
  if (typeof host === 'string' && host !== '') return `http://${host}`;
  return 'http://127.0.0.1';
}

/** Split a URL path into decoded segments. */
function segmentsOf(path) {
  const parts = path.split('/');
  const segments = [];
  for (const part of parts) {
    if (part === '') continue;
    if (part.indexOf('%') < 0) {
      segments.push(part);
      continue;
    }
    try {
      segments.push(decodeURIComponent(part));
    } catch {
      segments.push(part);
    }
  }
  return segments;
}

/** A reply whose body is JSON: the object is stringified once, here. */
function jsonReply(status, body, headers) {
  const out = { ...headers };
  if (!out['content-type'] && !out['Content-Type']) out['content-type'] = 'application/json; charset=utf-8';
  if (body === null || body === undefined) return { status, headers: out, body: null };
  return { status, headers: out, body: Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8') };
}

/** The error reply every surface answers with: a string message, and nothing else. */
function errorReply(status, message, headers) {
  return jsonReply(status, { message }, headers);
}

/**
 * Route one request. Synchronous, and total: it never throws, because a thrown error would have to
 * be turned into a reply anyway and the transport must always be able to answer.
 */
export function makeRouter(store) {
  let requestCounter = 0;

  const route = (req) => {
    requestCounter += 1;
    const requestId = `forge-${requestCounter}`;
    const rawUrl = req.url;
    const queryAt = rawUrl.indexOf('?');
    const pathPart = queryAt < 0 ? rawUrl : rawUrl.slice(0, queryAt);
    const segments = segmentsOf(pathPart);
    // A request with no query string is the common one: skip building a URL object for it.
    const query = queryAt < 0 ? EMPTY_QUERY : Object.fromEntries(new URLSearchParams(rawUrl.slice(queryAt + 1)).entries());
    const method = req.method;
    const headers = req.headers;

    // The boot probe takes no token and answers no JSON error body.
    if (segments.length === 1 && segments[0] === 'healthz') return jsonReply(200, { ok: true }, {});

    const token = tokenOf(headers);

    // ---------------------------------------------------------------- REST v3
    if (segments[0] === 'api' && segments[1] === 'v3') {
      const restHeaders = { 'x-github-request-id': requestId, 'x-oauth-scopes': 'repo, read:org', 'x-github-media-type': 'github.v3' };
      if (token === null) return errorReply(401, 'Requires authentication', restHeaders);
      let body = null;
      if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
        try {
          body = parseJson(req.body);
        } catch (err) {
          if (err instanceof HttpError) return errorReply(err.status, err.message, restHeaders);
          throw err;
        }
      }
      try {
        const answer = handleRest(store, { method, segments: segments.slice(2), query, body, login: store.login, origin: originOf(headers) });
        const out = { ...restHeaders };
        if (answer.headers !== undefined) for (const key in answer.headers) out[key] = answer.headers[key];
        if (answer.body === null || answer.body === undefined || answer.status === 204) return { status: answer.status, headers: out, body: null };
        if (!out['content-type'] && !out['Content-Type']) out['content-type'] = 'application/json; charset=utf-8';
        return { status: answer.status, headers: out, body: Buffer.isBuffer(answer.body) ? answer.body : Buffer.from(JSON.stringify(answer.body), 'utf8') };
      } catch (err) {
        if (err instanceof HttpError) {
          return jsonReply(err.status, { message: err.message, documentation_url: 'https://docs.github.com/rest' }, restHeaders);
        }
        return jsonReply(500, { message: err instanceof Error ? err.message : 'Internal Server Error', documentation_url: 'https://docs.github.com/rest' }, restHeaders);
      }
    }

    // ---------------------------------------------------------------- GraphQL v4
    if (segments[0] === 'api' && segments[1] === 'graphql' && method === 'POST') {
      if (token === null) return jsonReply(401, { message: 'Requires authentication' }, { 'x-github-request-id': requestId });
      let parsed;
      try {
        parsed = JSON.parse(req.body.toString('utf8'));
      } catch {
        return jsonReply(400, { message: 'Problems parsing JSON' }, { 'x-github-request-id': requestId });
      }
      return jsonReply(200, handleGraphQL(store, parsed, store.login), { 'x-github-request-id': requestId });
    }

    // ---------------------------------------------------------------- MCP
    if (segments.length === 1 && segments[0] === 'mcp') {
      if (method === 'GET') return jsonReply(405, { message: 'Method Not Allowed' }, {});
      if (token === null) return jsonReply(401, { message: 'Requires authentication' }, {});
      const answer = handleMcp(store, store.login, req.body.toString('utf8'));
      if (answer.body === null) return { status: answer.status, headers: {}, body: null };
      return jsonReply(answer.status, answer.body, {});
    }

    // ---------------------------------------------------------------- git smart HTTP
    const gitIndex = segments.findIndex((segment) => segment.endsWith('.git'));
    if (gitIndex === 1 && segments.length >= 3) {
      const owner = segments[0];
      const name = segments[1].slice(0, -4);
      const repo = store.getRepo(owner, name);
      const tail = segments.slice(2).join('/');
      if (!repo) return jsonReply(404, { message: 'Not Found' }, {});
      if (method === 'GET' && tail === 'info/refs') {
        const service = query.service ?? '';
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
          return jsonReply(403, { message: 'Smart HTTP is required' }, {});
        }
        const wantsV2 = String(headers['git-protocol'] ?? '').includes('version=2');
        const answer = infoRefs(store, repo, service, wantsV2 && service === 'git-upload-pack');
        return { status: answer.status, headers: { 'content-type': answer.contentType, 'cache-control': 'no-cache' }, body: answer.body };
      }
      if (method === 'POST' && (tail === 'git-upload-pack' || tail === 'git-receive-pack')) {
        try {
          const answer = tail === 'git-upload-pack' ? uploadPackV2(store, repo, req.body) : receivePack(store, repo, req.body);
          return { status: answer.status, headers: { 'content-type': answer.contentType, 'cache-control': 'no-cache' }, body: answer.body };
        } catch (err) {
          return jsonReply(400, { message: err instanceof Error ? err.message : 'bad request' }, {});
        }
      }
      return jsonReply(404, { message: 'Not Found' }, {});
    }

    return jsonReply(404, { message: 'Not Found' }, {});
  };

  return (req) => {
    try {
      return route(req);
    } catch (err) {
      return errorReply(err instanceof HttpError ? err.status : 500, err instanceof Error ? err.message : 'Internal Server Error', {});
    }
  };
}

/** Turn a reply into the bytes of one HTTP/1.1 response, headers included. */
function serialize(reply) {
  const body = reply.body;
  const status = reply.status;
  let head = `HTTP/1.1 ${status} ${REASONS[status] ?? 'OK'}\r\n`;
  if (body !== null) head += `content-length: ${body.length}\r\n`;
  const headers = reply.headers;
  for (const key in headers) head += `${key}: ${headers[key]}\r\n`;
  head += '\r\n';
  const headBytes = Buffer.from(head, 'latin1');
  if (body === null) return headBytes;
  return Buffer.concat([headBytes, body], headBytes.length + body.length);
}

/** The chunked request body decoded from `buf` at `start`, or null when more bytes are needed. */
function decodeChunked(buf, start) {
  let pos = start;
  const parts = [];
  let size = 0;
  for (;;) {
    const lineEnd = buf.indexOf(CRLF, pos);
    if (lineEnd < 0) return null;
    const length = parseInt(buf.toString('latin1', pos, lineEnd), 16);
    if (!Number.isFinite(length) || length < 0) return null;
    pos = lineEnd + 2;
    if (length === 0) {
      // Trailer section: header lines up to the blank one.
      for (;;) {
        const end = buf.indexOf(CRLF, pos);
        if (end < 0) return null;
        if (end === pos) return { body: size === 0 ? EMPTY : Buffer.concat(parts, size), used: pos + 2 };
        pos = end + 2;
      }
    }
    if (buf.length < pos + length + 2) return null;
    parts.push(buf.subarray(pos, pos + length));
    size += length;
    pos += length + 2;
  }
}

/**
 * Parse the request at the head of `buf`: {request, used, close}, or null when the bytes for a
 * whole request have not arrived yet.
 */
function parseRequest(buf) {
  const headEnd = buf.indexOf(HEAD_END);
  if (headEnd < 0) {
    if (buf.length > 64 * 1024) throw new HttpError(400, 'request headers too large');
    return null;
  }
  const text = buf.toString('latin1', 0, headEnd);
  const lines = text.split('\r\n');
  const requestLine = lines[0] ?? '';
  const firstSpace = requestLine.indexOf(' ');
  const secondSpace = requestLine.indexOf(' ', firstSpace + 1);
  const method = (firstSpace < 0 ? requestLine : requestLine.slice(0, firstSpace)).toUpperCase();
  const url = firstSpace < 0 ? '/' : requestLine.slice(firstSpace + 1, secondSpace < 0 ? undefined : secondSpace);
  const version = secondSpace < 0 ? 'HTTP/1.1' : requestLine.slice(secondSpace + 1);
  const headers = {};
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === '') continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const seen = headers[name];
    headers[name] = seen === undefined ? value : `${seen}, ${value}`;
  }
  const bodyStart = headEnd + 4;
  const transfer = headers['transfer-encoding'];
  let body;
  let used;
  if (transfer !== undefined && transfer.toLowerCase().indexOf('chunked') >= 0) {
    const decoded = decodeChunked(buf, bodyStart);
    if (decoded === null) return null;
    body = decoded.body;
    used = decoded.used;
  } else {
    const declared = headers['content-length'];
    let length = declared === undefined ? 0 : Number(declared);
    if (!Number.isFinite(length) || length < 0) length = 0;
    if (length > MAX_BODY_BYTES) throw new HttpError(413, 'Payload Too Large');
    used = bodyStart + length;
    if (buf.length < used) return null;
    body = length === 0 ? EMPTY : buf.subarray(bodyStart, used);
  }
  const connection = (headers.connection ?? '').toLowerCase();
  const close = connection === 'close' || (connection !== 'keep-alive' && version === 'HTTP/1.0');
  return { request: { method, url, headers, body }, used, close };
}

/** Build the server: one Store behind every surface. */
export function createApp() {
  const store = new Store();
  const route = makeRouter(store);
  /** Serialized replies for GET/HEAD, dropped whenever a request may have changed the store. */
  let cache = new Map();
  let cached = 0;

  const server = createServer((socket) => {
    socket.setNoDelay(true);
    let buf = EMPTY;
    let closed = false;
    const fail = () => {
      closed = true;
      socket.destroy();
    };
    socket.on('error', fail);
    socket.on('close', () => {
      closed = true;
      buf = EMPTY;
    });
    socket.on('data', (chunk) => {
      if (closed) return;
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      while (!closed) {
        let parsed;
        try {
          parsed = parseRequest(buf);
        } catch (err) {
          socket.write(serialize(errorReply(err instanceof HttpError ? err.status : 400, err instanceof Error ? err.message : 'Bad Request', {})));
          socket.end();
          closed = true;
          return;
        }
        if (parsed === null) return;
        buf = parsed.used >= buf.length ? EMPTY : buf.subarray(parsed.used);
        const req = parsed.request;
        const method = req.method;
        const cacheable = method === 'GET' || method === 'HEAD';
        // A reply depends on who asked and how: the same URL under another token, or asked for
        // protocol v2 instead of v0, is another answer.
        const key = `${method}\n${req.headers.host ?? ''}\n${req.headers.authorization ?? ''}\n${req.headers['x-shopify-access-token'] ?? ''}\n${req.headers['git-protocol'] ?? ''}\n${req.url}`;
        let bytes;
        if (cacheable && cached !== 0) {
          bytes = cache.get(key);
        }
        if (bytes === undefined) {
          const reply = route(req);
          if (method === 'HEAD') {
            reply.body = null;
            if (reply.status === 200) reply.headers['content-length'] = '0';
          }
          bytes = serialize(reply);
          if (cacheable) {
            if (cached >= MAX_CACHED_REPLIES) {
              cache = new Map();
              cached = 0;
            }
            cache.set(key, bytes);
            cached += 1;
          } else if (cached !== 0) {
            // A request that may have written the store: every cached GET is now suspect.
            cache = new Map();
            cached = 0;
          }
        }
        socket.write(bytes);
        if (parsed.close) {
          socket.end();
          closed = true;
          return;
        }
      }
    });
  });

  return server;
}

export { Store };
