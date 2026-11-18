// githttp.ts: git's smart HTTP transport, served from the store with no git binary anywhere.
//
// Three entry points, all mounted under /<owner>/<repo>.git:
//   GET  /info/refs?service=...   the v0 advertisement (or the v2 capability advertisement)
//   POST /git-upload-pack         protocol v2 ls-refs and fetch, framed in side-band-64k
//   POST /git-receive-pack        protocol v0 push, report-status inside side-band-64k
//
// The pack writer sends whole objects (no deltas), which is legal for any client; the pack
// reader accepts ofs-delta and ref-delta anyway, since a client may push them.

import { decodePktLines, encodePktLines, parseCommit, parseTag, readPack, sidebandPack, writePack, ZERO_OID } from './gitcore.ts';

const AGENT = 'git/2.43.0';

const UPLOAD_PACK_CAPS = [
  'multi_ack_detailed',
  'side-band-64k',
  'thin-pack',
  'ofs-delta',
  'shallow',
  'no-progress',
  'include-tag',
  'agent=' + AGENT,
  'object-format=sha1',
].join(' ');

const RECEIVE_PACK_CAPS = ['report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', 'agent=' + AGENT, 'object-format=sha1'].join(' ');

/** Every ref this repository advertises, in git's order, with peeled tags. */
function refList(store, repo) {
  const out = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name);
    if (!oid) continue;
    out.push({ name, oid, peeled: peeledOf(store, repo, oid) });
  }
  return out;
}

/** The commit an annotated tag peels to, or null. */
function peeledOf(store, repo, oid) {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return null;
  const commit = store.peelToCommit(repo, oid);
  return commit && commit !== oid ? commit : null;
}

/** GET /<owner>/<repo>.git/info/refs */
export function infoRefs(store, repo, service, wantsV2) {
  const isUpload = service === 'git-upload-pack';
  const contentType = isUpload ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement';
  const head = repo.headOid();
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const parts = [];

  if (isUpload && wantsV2) {
    parts.push('version 2\n');
    parts.push(`agent=${AGENT}\n`);
    parts.push('ls-refs=unborn\n');
    parts.push('fetch=shallow wait-for-done\n');
    parts.push('server-option\n');
    parts.push('object-format=sha1\n');
    parts.push('flush');
    return { status: 200, contentType, body: encodePktLines(parts) };
  }

  parts.push(`# service=${service}\n`);
  parts.push('flush');
  const refs = refList(store, repo);
  const caps = isUpload ? `${UPLOAD_PACK_CAPS} symref=HEAD:${headRef}` : RECEIVE_PACK_CAPS;
  if (refs.length === 0) {
    parts.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    let first = true;
    if (head) {
      parts.push(`${head} HEAD\0${caps}\n`);
      first = false;
    }
    for (const ref of refs) {
      const suffix = first ? `\0${caps}` : '';
      parts.push(`${ref.oid} ${ref.name}${suffix}\n`);
      first = false;
      if (ref.peeled) parts.push(`${ref.peeled} ${ref.name}^{}\n`);
    }
  }
  parts.push('flush');
  return { status: 200, contentType, body: encodePktLines(parts) };
}

/** The lines of a v2 command request: everything after the capability section. */
function commandArgs(packets) {
  let afterDelim = false;
  const args = [];
  for (const packet of packets) {
    if (packet.kind === 'delim' || packet.kind === 'flush') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!afterDelim) continue;
    args.push(line);
  }
  return args;
}

/** GET-style parsing of a v0 command body's ref updates. */
function receiveCommands(packets) {
  const commands = [];
  const capabilities = new Set();
  let first = true;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const raw = packet.payload.toString('utf8').replace(/\n$/, '');
    if (raw === '') continue;
    let line = raw;
    if (first) {
      const nul = raw.indexOf('\0');
      if (nul >= 0) {
        line = raw.slice(0, nul);
        for (const cap of raw.slice(nul + 1).split(' ')) if (cap) capabilities.add(cap);
      }
      first = false;
    }
    const [oldOid, newOid, ...rest] = line.split(' ');
    const ref = rest.join(' ');
    if (!oldOid || !newOid || !ref) continue;
    commands.push({ oldOid, newOid, ref });
  }
  return { commands, capabilities };
}

/** The commits and trees a fetch must send, honouring haves and a shallow boundary. */
function planFetch(store, repo, { wants, haves, shallowSet, depth }) {
  const includeCommits = new Set();
  const boundaries = new Set();
  const extraObjects = new Set();

  for (const want of wants) {
    const object = repo.objects.get(want);
    if (object && object.type === 'tag') extraObjects.add(want);
    const tip = store.peelToCommit(repo, want);
    if (!tip) continue;
    const seen = new Set();
    let frontier = [{ oid: tip, distance: 1 }];
    while (frontier.length > 0) {
      const next = [];
      for (const item of frontier) {
        if (seen.has(item.oid)) continue;
        seen.add(item.oid);
        const commit = repo.objects.get(item.oid);
        if (!commit || commit.type !== 'commit') continue;
        includeCommits.add(item.oid);
        const parents = parseCommit(commit.data).parents;
        if (parents.length === 0) continue;
        if (depth != null) {
          if (item.distance < depth) for (const parent of parents) next.push({ oid: parent, distance: item.distance + 1 });
          else boundaries.add(item.oid);
        } else if (!shallowSet.has(item.oid)) {
          for (const parent of parents) next.push({ oid: parent, distance: item.distance + 1 });
        }
      }
      frontier = next;
    }
  }

  // What the client already has: its haves, their trees, and (bounded by its own shallow
  // boundary) their ancestors.
  const haveCommits = new Set();
  const haveObjects = new Set();
  for (const have of haves) {
    haveObjects.add(have);
    const tip = store.peelToCommit(repo, have);
    if (!tip) continue;
    const seen = new Set();
    let frontier = [tip];
    while (frontier.length > 0) {
      const next = [];
      for (const oid of frontier) {
        if (seen.has(oid)) continue;
        seen.add(oid);
        const commit = repo.objects.get(oid);
        if (!commit || commit.type !== 'commit') continue;
        haveCommits.add(oid);
        const tree = parseCommit(commit.data).tree;
        for (const oid2 of store.treeObjects(repo, tree)) haveObjects.add(oid2);
        if (shallowSet.has(oid)) continue;
        for (const parent of parseCommit(commit.data).parents) next.push(parent);
      }
      frontier = next;
    }
  }

  const send = [];
  const sent = new Set();
  const add = (oid) => {
    if (!oid || sent.has(oid) || haveObjects.has(oid)) return;
    const object = repo.objects.get(oid);
    if (!object) return;
    sent.add(oid);
    send.push({ type: object.type, data: object.data });
  };
  for (const oid of extraObjects) add(oid);
  for (const oid of includeCommits) {
    if (haveCommits.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    const commit = parseCommit(object.data);
    for (const treeOid of store.treeObjects(repo, commit.tree)) add(treeOid);
    add(oid);
  }
  const unshallow = [...shallowSet].filter((oid) => includeCommits.has(oid) && !boundaries.has(oid));
  return { objects: send, boundaries: [...boundaries], unshallow };
}

/** POST /<owner>/<repo>.git/git-upload-pack, protocol v2. */
export function uploadPackV2(store, repo, body) {
  const { packets } = decodePktLines(body);
  const command = packets.find((packet) => packet.kind === 'data' && packet.payload.toString('utf8').startsWith('command='));
  const name = command ? command.payload.toString('utf8').trim().slice('command='.length) : '';
  if (name === 'ls-refs') {
    const args = commandArgs(packets);
    const prefixes = args.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice('ref-prefix '.length));
    const wantSymrefs = args.includes('symrefs');
    const wantPeel = args.includes('peel');
    const wantUnborn = args.includes('unborn');
    // A clone asks the same ls-refs of an unchanged repository every time: keep that answer.
    const cacheKey = `${repo.refsVersion}:${wantSymrefs ? 1 : 0}${wantPeel ? 1 : 0}${wantUnborn ? 1 : 0}:${prefixes.join(',')}`;
    if (prefixes.length === 0) {
      const cached = repo.refsCache.get(cacheKey);
      if (cached !== undefined) {
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: cached };
      }
    }
    const parts = [];
    const matches = (refName) => prefixes.length === 0 || prefixes.some((prefix) => refName.startsWith(prefix));
    const headRef = `refs/heads/${repo.defaultBranch}`;
    const head = repo.headOid();
    if (matches('HEAD')) {
      if (head) parts.push(`${head} HEAD${wantSymrefs ? ` symref-target:${headRef}` : ''}\n`);
      else if (wantUnborn) parts.push(`unborn HEAD${wantSymrefs ? ` symref-target:${headRef}` : ''}\n`);
    }
    for (const ref of refList(store, repo)) {
      if (!matches(ref.name)) continue;
      const peel = wantPeel && ref.peeled ? ` peeled:${ref.peeled}` : '';
      parts.push(`${ref.oid} ${ref.name}${peel}\n`);
    }
    parts.push('flush');
    const body = encodePktLines(parts);
    if (prefixes.length === 0) repo.refsCache.set(cacheKey, body);
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body };
  }
  if (name === 'fetch') {
    const args = commandArgs(packets);
    const wants = args.filter((line) => line.startsWith('want ')).map((line) => line.slice(5).trim());
    const haves = args.filter((line) => line.startsWith('have ')).map((line) => line.slice(5).trim());
    const shallowSet = new Set(args.filter((line) => line.startsWith('shallow ')).map((line) => line.slice(8).trim()));
    const deepen = args.find((line) => line.startsWith('deepen '));
    const depth = deepen ? Number(deepen.slice(7).trim()) : null;
    const usableDepth = Number.isFinite(depth) ? depth : null;
    // A shallow clone of one commit asks for the same bytes every time: build that pack once.
    const cacheKey = wants.length === 1 && haves.length === 0 && shallowSet.size === 0 && usableDepth !== null ? `${wants[0]}:${usableDepth}` : null;
    const cached = cacheKey === null ? undefined : repo.packCache.get(cacheKey);
    if (cached !== undefined) {
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: cached };
    }
    const plan = planFetch(store, repo, { wants, haves, shallowSet, depth: usableDepth });
    const parts = [];
    if (usableDepth != null || plan.boundaries.length > 0 || plan.unshallow.length > 0) {
      parts.push('shallow-info\n');
      for (const oid of plan.unshallow) parts.push(`unshallow ${oid}\n`);
      for (const oid of plan.boundaries) parts.push(`shallow ${oid}\n`);
      parts.push('flush');
    }
    parts.push('packfile\n');
    const header = encodePktLines(parts);
    const pack = writePack(plan.objects);
    const body = Buffer.concat([header, sidebandPack(pack)]);
    if (cacheKey !== null) repo.packCache.set(cacheKey, body);
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body };
  }
  return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: `unsupported command ${name}` })) };
}

/** POST /<owner>/<repo>.git/git-receive-pack, protocol v0. */
export function receivePack(store, repo, body) {
  const { packets, rest } = decodePktLines(body);
  const { commands, capabilities } = receiveCommands(packets);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (rest.length > 0) {
    try {
      const read = readPack(rest);
      for (const [oid, object] of read.objects) if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  const lines = [`unpack ${unpackDetail}\n`];
  for (const command of commands) {
    if (!unpackOk) {
      lines.push(`ng ${command.ref} unpacker error\n`);
      continue;
    }
    const current = repo.ref(command.ref);
    if (command.newOid === ZERO_OID) {
      if (current) repo.deleteRef(command.ref);
      lines.push(`ok ${command.ref}\n`);
      continue;
    }
    if (command.oldOid !== ZERO_OID && current !== command.oldOid) {
      lines.push(`ng ${command.ref} fetch first\n`);
      continue;
    }
    if (command.ref.startsWith('refs/heads/') && command.oldOid !== ZERO_OID) {
      if (!store.isAncestor(repo, command.oldOid, command.newOid)) {
        lines.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
    }
    if (!repo.objects.has(command.newOid) && !store.isCommit(repo, command.newOid)) {
      lines.push(`ng ${command.ref} missing necessary objects\n`);
      continue;
    }
    repo.setRef(command.ref, command.newOid);
    lines.push(`ok ${command.ref}\n`);
  }
  const report = encodePktLines([...lines, 'flush']);
  const sideband = capabilities.has('side-band-64k');
  if (!sideband) {
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: report };
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: sidebandPack(report) };
}

/** The commit a tag object names, for the REST tags view. */
export function tagTarget(repo, oid) {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return null;
  return parseTag(object.data);
}
