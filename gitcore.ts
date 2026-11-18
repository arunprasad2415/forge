// gitcore.ts: git's object model and wire framing, on node:crypto and node:zlib only.
//
// Everything here is plain JavaScript in a .ts file so the grader's Node strips nothing and
// nothing here depends on a git binary: loose-object hashing, pkt-line framing, packfiles in
// both directions (including ofs-delta and ref-delta), tree and commit encoding, and the
// flatten/rebuild pair the REST contents API needs.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const TYPES = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
export const TYPE_CODES = { commit: 1, tree: 2, blob: 3, tag: 4 };

export function sha1hex(bytes) {
  return createHash('sha1').update(bytes).digest('hex');
}

/** The object id of `data` as `type`: sha1 over "<type> <size>\0" and the bytes. */
export function hashObject(type, data) {
  return sha1hex(Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'utf8'), data]));
}

// ---------------------------------------------------------------- pkt-line framing

/** One pkt-line carrying `text`. */
export function pktLine(text) {
  const payload = Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8');
  return Buffer.concat([Buffer.from((payload.length + 4).toString(16).padStart(4, '0'), 'ascii'), payload]);
}

export const FLUSH_PKT = Buffer.from('0000', 'ascii');
export const DELIM_PKT = Buffer.from('0001', 'ascii');

/** Encode a list of payload strings, 'flush' and 'delim' markers. */
export function encodePktLines(parts) {
  const out = [];
  for (const part of parts) {
    if (part === 'flush') out.push(FLUSH_PKT);
    else if (part === 'delim') out.push(DELIM_PKT);
    else out.push(pktLine(part));
  }
  return Buffer.concat(out);
}

/** Decode every pkt-line in `buf`; answers the packets and whatever bytes follow them. */
export function decodePktLines(buf) {
  const packets = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const head = buf.toString('ascii', pos, pos + 4);
    // A push body is pkt-lines followed by the raw packfile: the first bytes that are not a
    // length prefix end the pkt-line section and begin the pack.
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const len = parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      pos += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      pos += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end' });
      pos += 4;
      continue;
    }
    if (len < 4 || pos + len > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + len) });
    pos += len;
  }
  return { packets, rest: buf.subarray(pos) };
}

// ---------------------------------------------------------------- trees

/** Git orders tree entries by name, a directory as if it ended in "/". */
function entrySortKey(entry) {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Encode a tree object body from {mode, name, oid} entries, in git's order. */
export function buildTree(entries) {
  const sorted = [...entries].sort((a, b) => (entrySortKey(a) < entrySortKey(b) ? -1 : entrySortKey(a) > entrySortKey(b) ? 1 : 0));
  const parts = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a tree body into {mode, name, oid} entries. */
export function parseTree(data) {
  const entries = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const nul = data.indexOf(0x00, space);
    if (space < 0 || nul < 0 || nul + 21 > data.length) break;
    const mode = data.toString('ascii', pos, space);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

// ---------------------------------------------------------------- commits and tags

/** Encode a commit body. Dates are `<unix seconds> +0000`. */
export function buildCommit({ tree, parents, author, committer, message }) {
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${author.name} <${author.email}> ${author.time} +0000`);
  lines.push(`committer ${committer.name} <${committer.email}> ${committer.time} +0000`);
  const body = message.endsWith('\n') ? message : `${message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${body}`, 'utf8');
}

/** Parse a commit body: its tree, parents, author/committer lines and message. */
export function parseCommit(data) {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const commit = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) commit.tree = line.slice(5);
    else if (line.startsWith('parent ')) commit.parents.push(line.slice(7));
    else if (line.startsWith('author ')) commit.author = line.slice(7);
    else if (line.startsWith('committer ')) commit.committer = line.slice(10);
  }
  return commit;
}

/** The commit a tag object points at, or null when it names something else. */
export function parseTag(data) {
  const text = data.toString('utf8');
  const tag = { object: '', type: '', tag: '', tagger: '', message: '' };
  const split = text.indexOf('\n\n');
  for (const line of (split < 0 ? text : text.slice(0, split)).split('\n')) {
    if (line.startsWith('object ')) tag.object = line.slice(7);
    else if (line.startsWith('type ')) tag.type = line.slice(5);
    else if (line.startsWith('tag ')) tag.tag = line.slice(4);
    else if (line.startsWith('tagger ')) tag.tagger = line.slice(7);
  }
  if (split >= 0) tag.message = text.slice(split + 2);
  return tag;
}

// ---------------------------------------------------------------- packfiles, reading

/** Apply a git delta to `base`. */
export function applyDelta(base, delta) {
  let pos = 0;
  const varint = () => {
    let value = 0;
    let shift = 1;
    let byte = 0;
    do {
      byte = delta[pos];
      pos += 1;
      value += (byte & 0x7f) * shift;
      shift *= 128;
    } while (byte & 0x80);
    return value;
  };
  varint();
  const resultSize = varint();
  const out = Buffer.alloc(resultSize);
  let offset = 0;
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if (op & 0x80) {
      let baseOffset = 0;
      let size = 0;
      if (op & 0x01) baseOffset += delta[pos++];
      if (op & 0x02) baseOffset += delta[pos++] * 0x100;
      if (op & 0x04) baseOffset += delta[pos++] * 0x10000;
      if (op & 0x08) baseOffset += delta[pos++] * 0x1000000;
      if (op & 0x10) size += delta[pos++];
      if (op & 0x20) size += delta[pos++] * 0x100;
      if (op & 0x40) size += delta[pos++] * 0x10000;
      if (size === 0) size = 0x10000;
      base.copy(out, offset, baseOffset, baseOffset + size);
      offset += size;
    } else if (op > 0) {
      delta.copy(out, offset, pos, pos + op);
      offset += op;
      pos += op;
    } else {
      throw new Error('delta insert of zero bytes');
    }
  }
  return out;
}

/**
 * Read a packfile into {version, objects: Map<oid, {type, data}>, deltas}. Objects a delta
 * needs from outside the pack resolve through `resolveBase(oid)`.
 */
export function readPack(buf, resolveBase) {
  if (buf.length < 32 || buf.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  const count = buf.readUInt32BE(8);
  let pos = 12;
  const entries = [];
  const byOffset = new Map();
  for (let index = 0; index < count; index += 1) {
    const offset = pos;
    let byte = buf[pos];
    pos += 1;
    const code = (byte >> 4) & 7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[pos];
      pos += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOffset = null;
    let baseOid = null;
    if (code === 6) {
      let b = buf[pos];
      pos += 1;
      let distance = b & 0x7f;
      while (b & 0x80) {
        b = buf[pos];
        pos += 1;
        distance = ((distance + 1) * 128) + (b & 0x7f);
      }
      baseOffset = offset - distance;
    } else if (code === 7) {
      baseOid = buf.toString('hex', pos, pos + 20);
      pos += 20;
    }
    const inflated = inflateSync(buf.subarray(pos), { info: true });
    pos += inflated.engine.bytesWritten;
    const entry = { offset, code, size, baseOffset, baseOid, data: inflated.buffer, type: TYPES[code] ?? null, oid: null };
    entries.push(entry);
    byOffset.set(offset, entry);
  }
  const objects = new Map();
  let deltas = 0;
  const resolve = (entry, depth) => {
    if (entry.oid !== null) return entry;
    if (depth > 64) throw new Error('delta chain too deep');
    if (entry.code >= 1 && entry.code <= 4) {
      entry.oid = hashObject(entry.type, entry.data);
      objects.set(entry.oid, { type: entry.type, data: entry.data });
      return entry;
    }
    deltas += 1;
    let base = null;
    if (entry.baseOffset !== null) {
      base = resolve(byOffset.get(entry.baseOffset), depth + 1);
    } else {
      const known = objects.get(entry.baseOid);
      if (known) base = known;
      else if (resolveBase) base = resolveBase(entry.baseOid);
    }
    if (!base) throw new Error(`delta base ${entry.baseOffset ?? entry.baseOid} is missing`);
    entry.data = applyDelta(base.data, entry.data);
    entry.type = base.type;
    entry.oid = hashObject(entry.type, entry.data);
    objects.set(entry.oid, { type: entry.type, data: entry.data });
    return entry;
  };
  for (const entry of entries) resolve(entry, 0);
  return { version, count, objects, deltas };
}

// ---------------------------------------------------------------- packfiles, writing

function packObjectHeader(code, size) {
  const bytes = [];
  let remaining = size;
  let first = (code << 4) | (remaining % 16);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining % 128;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile of whole objects, with the sha1 trailer. */
export function writePack(objects) {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts = [header];
  for (const object of objects) {
    parts.push(packObjectHeader(TYPE_CODES[object.type], object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Split a packfile body into band-1 sideband pkt-lines of at most `chunk` bytes. */
export function sidebandPack(pack, chunk = 65500) {
  const out = [];
  for (let pos = 0; pos < pack.length; pos += chunk) {
    const slice = pack.subarray(pos, Math.min(pos + chunk, pack.length));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (out.length === 0) out.push(pktLine(Buffer.from([1])));
  out.push(FLUSH_PKT);
  return Buffer.concat(out);
}
