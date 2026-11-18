// app.ts: the HTTP server, its router and the JSON discipline every surface shares.
//
// The routes, in the order the suite meets them:
//   GET  /healthz                      the env's boot probe
//   /api/v3/...                        REST v3 (auth required, JSON always, request id always)
//   POST /api/graphql                  GraphQL v4 (401 without a token)
//   POST /mcp                          MCP over streamable HTTP (401 without a token)
//   /<owner>/<repo>.git/<service>      git smart HTTP
//   anything else                      404 with {"message": "Not Found"}

import { createServer } from 'node:http';
import { Store, HttpError } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { infoRefs, receivePack, uploadPackV2 } from './githttp.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** Read a whole request body. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Payload Too Large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The bearer token on a request, if any. */
function tokenOf(req) {
  const header = req.headers.authorization;
  if (typeof header === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) return match[1].trim();
    if (header.trim() !== '') return header.trim();
  }
  const shop = req.headers['x-shopify-access-token'];
  if (typeof shop === 'string' && shop !== '') return shop;
  return null;
}

/** Parse a JSON body, answering 400 for anything that is not JSON. */
function parseJson(buffer) {
  const text = buffer.toString('utf8').trim();
  if (text === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Problems parsing JSON');
  }
}

/** The origin a request reached us on, for absolute pagination links. */
function originOf(req) {
  const host = req.headers.host;
  if (typeof host === 'string' && host !== '') return `http://${host}`;
  return 'http://127.0.0.1';
}

/** Split a URL path into decoded segments. */
function segmentsOf(url) {
  return url.pathname
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

/** Build the server: one Store behind every surface. */
export function createApp() {
  const store = new Store();
  let requestCounter = 0;

  const send = (res, status, body, headers) => {
    const out = { ...headers };
    if (body === null || body === undefined || status === 204) {
      res.writeHead(status, out);
      res.end();
      return;
    }
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8');
    if (!out['content-type'] && !out['Content-Type']) out['content-type'] = 'application/json; charset=utf-8';
    out['content-length'] = String(payload.length);
    res.writeHead(status, out);
    res.end(payload);
  };

  const sendError = (res, status, message, headers = {}) => {
    send(res, status, { message, documentation_url: 'https://docs.github.com/rest' }, headers);
  };

  const handler = async (req, res) => {
    requestCounter += 1;
    const requestId = `forge-${requestCounter}`;
    const url = new URL(req.url ?? '/', 'http://localhost');
    const segments = segmentsOf(url);
    const query = Object.fromEntries(url.searchParams.entries());
    const method = (req.method ?? 'GET').toUpperCase();

    // The boot probe takes no token and answers no JSON error body.
    if (segments.length === 1 && segments[0] === 'healthz') {
      send(res, 200, { ok: true });
      return;
    }

    const token = tokenOf(req);

    // ---------------------------------------------------------------- REST v3
    if (segments[0] === 'api' && segments[1] === 'v3') {
      const headers = { 'x-github-request-id': requestId, 'x-oauth-scopes': 'repo, read:org', 'x-github-media-type': 'github.v3' };
      if (token === null) {
        sendError(res, 401, 'Requires authentication', headers);
        return;
      }
      let body = null;
      if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
        const raw = await readBody(req);
        body = parseJson(raw);
      }
      try {
        const answer = handleRest(store, { method, segments: segments.slice(2), query, body, login: store.login, origin: originOf(req) });
        send(res, answer.status, answer.body, { ...headers, ...(answer.headers ?? {}) });
      } catch (err) {
        if (err instanceof HttpError) sendError(res, err.status, err.message, headers);
        else sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error', headers);
      }
      return;
    }

    // ---------------------------------------------------------------- GraphQL v4
    if (segments[0] === 'api' && segments[1] === 'graphql' && method === 'POST') {
      if (token === null) {
        send(res, 401, { message: 'Requires authentication' }, { 'x-github-request-id': requestId });
        return;
      }
      const raw = await readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        send(res, 400, { message: 'Problems parsing JSON' }, { 'x-github-request-id': requestId });
        return;
      }
      send(res, 200, handleGraphQL(store, parsed, store.login), { 'x-github-request-id': requestId });
      return;
    }

    // ---------------------------------------------------------------- MCP
    if (segments.length === 1 && segments[0] === 'mcp') {
      if (method === 'GET') {
        send(res, 405, { message: 'Method Not Allowed' });
        return;
      }
      if (token === null) {
        send(res, 401, { message: 'Requires authentication' });
        return;
      }
      const raw = await readBody(req);
      const answer = handleMcp(store, store.login, raw.toString('utf8'));
      if (answer.body === null) {
        res.writeHead(answer.status, {});
        res.end();
        return;
      }
      send(res, answer.status, answer.body);
      return;
    }

    // ---------------------------------------------------------------- git smart HTTP
    const gitIndex = segments.findIndex((segment) => segment.endsWith('.git'));
    if (gitIndex === 1 && segments.length >= 3) {
      const owner = segments[0];
      const name = segments[1].slice(0, -4);
      const repo = store.getRepo(owner, name);
      const tail = segments.slice(2).join('/');
      if (!repo) {
        send(res, 404, { message: 'Not Found' });
        return;
      }
      if (method === 'GET' && tail === 'info/refs') {
        const service = query.service ?? '';
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
          send(res, 403, { message: 'Smart HTTP is required' });
          return;
        }
        const wantsV2 = String(req.headers['git-protocol'] ?? '').includes('version=2');
        const answer = infoRefs(store, repo, service, wantsV2 && service === 'git-upload-pack');
        send(res, answer.status, answer.body, { 'content-type': answer.contentType, 'cache-control': 'no-cache' });
        return;
      }
      if (method === 'POST' && (tail === 'git-upload-pack' || tail === 'git-receive-pack')) {
        const body = await readBody(req);
        try {
          const answer =
            tail === 'git-upload-pack'
              ? uploadPackV2(store, repo, body)
              : receivePack(store, repo, body);
          send(res, answer.status, answer.body, { 'content-type': answer.contentType, 'cache-control': 'no-cache' });
        } catch (err) {
          send(res, 400, { message: err instanceof Error ? err.message : 'bad request' });
        }
        return;
      }
      send(res, 404, { message: 'Not Found' });
      return;
    }

    send(res, 404, { message: 'Not Found' });
  };

  return createServer((req, res) => {
    handler(req, res).catch((err) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      const status = err instanceof HttpError ? err.status : 500;
      const body = Buffer.from(JSON.stringify({ message: err instanceof Error ? err.message : 'Internal Server Error' }), 'utf8');
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length) });
      res.end(body);
    });
  });
}

export { Store };
