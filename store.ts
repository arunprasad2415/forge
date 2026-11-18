// store.ts: the forge's own state, in memory, and every write path the surfaces share.
//
// One Store holds the repositories; a repository holds its git objects, its refs, and its
// issues, labels, comments and pull requests. REST, GraphQL and MCP all mutate this same
// state, which is what makes an issue created over MCP readable over REST with the same id.
//
// Everything is deterministic: object ids come from the bytes, dates from FIXED_EPOCH plus a
// per-repository sequence, and nothing reads a clock. A replay of the same requests therefore
// leaves the same state, byte for byte.

import { buildCommit, buildTree, hashObject, parseCommit, parseTree, sha1hex, ZERO_OID } from './gitcore.ts';

/** The instant every generated date counts from, so two runs write the same bytes. */
export const FIXED_EPOCH = 1700000000;

/** The single account this forge serves: the login the trial token names. */
export const TOKEN_LOGIN = 'adaiversen';
export const TOKEN_EMAIL = 'adaiversen@example.invalid';

export const DEFAULT_BRANCH = 'main';

/** An ISO date `offset` seconds after the fixed epoch. */
export function isoAt(offset) {
  return new Date((FIXED_EPOCH + offset) * 1000).toISOString().replace('.000Z', 'Z');
}

/** A Relay-style opaque id for one object. */
export function globalId(kind, id) {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64');
}

/** Read the kind and numeric id back out of a global id. */
export function parseGlobalId(value) {
  if (typeof value !== 'string') return null;
  let text = '';
  try {
    text = Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const colon = text.indexOf(':');
  if (colon < 0) return null;
  const id = Number(text.slice(colon + 1));
  if (!Number.isFinite(id)) return null;
  return { kind: text.slice(0, colon), id };
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** One repository: its objects, refs and the issue/pull bookkeeping. */
class Repository {
  constructor(id, owner, name, options) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.description = options.description ?? '';
    this.private = options.private === true;
    this.defaultBranch = options.defaultBranch ?? DEFAULT_BRANCH;
    this.createdAt = isoAt(0);
    this.updatedAt = isoAt(0);
    this.objects = new Map();
    this.refs = new Map();
    this.issues = [];
    this.issueSeq = 0;
    this.pulls = [];
    this.pullSeq = 0;
    this.labels = new Map();
    this.comments = [];
    this.commentSeq = 0;
    this.clock = 0;
    /** Packs already built for one commit at one depth, keyed "<tip>:<depth>": a clone is repeatable. */
    this.packCache = new Map();
    /** Bumped on every ref change, so a cached ls-refs answer is dropped when the refs move. */
    this.refsVersion = 0;
    this.refsCache = new Map();
  }

  /** The next tick of this repository's deterministic clock. */
  tick() {
    this.clock += 1;
    this.updatedAt = isoAt(this.clock);
    return this.clock;
  }

  get fullName() {
    return `${this.owner}/${this.name}`;
  }

  putObject(type, data) {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid) {
    return this.objects.get(oid) ?? null;
  }

  ref(name) {
    return this.refs.get(name) ?? null;
  }

  setRef(name, oid) {
    this.refs.set(name, oid);
    this.refsVersion += 1;
  }

  deleteRef(name) {
    this.refs.delete(name);
    this.refsVersion += 1;
  }

  headRef() {
    return `refs/heads/${this.defaultBranch}`;
  }

  headOid() {
    return this.ref(this.headRef());
  }
}

export class Store {
  constructor() {
    this.repos = new Map();
    this.repoById = new Map();
    this.nextRepoId = 1001;
    this.login = TOKEN_LOGIN;
    this.email = TOKEN_EMAIL;
  }

  // ------------------------------------------------------------ repositories

  key(owner, name) {
    return `${String(owner).toLowerCase()}/${String(name).toLowerCase()}`;
  }

  getRepo(owner, name) {
    return this.repos.get(this.key(owner, name)) ?? null;
  }

  requireRepo(owner, name) {
    const repo = this.getRepo(owner, name);
    if (!repo) throw new HttpError(404, 'Not Found');
    return repo;
  }

  createRepo(owner, name, options = {}) {
    if (typeof name !== 'string' || name.trim() === '') throw new HttpError(422, 'Repository name is required');
    if (this.getRepo(owner, name)) throw new HttpError(422, `Repository creation failed: name already exists on this account: ${name}`);
    const repo = new Repository(this.nextRepoId, owner, name, options);
    this.nextRepoId += 1;
    this.repos.set(this.key(owner, name), repo);
    this.repoById.set(repo.id, repo);
    return repo;
  }

  deleteRepo(owner, name) {
    const repo = this.getRepo(owner, name);
    if (!repo) throw new HttpError(404, 'Not Found');
    this.repos.delete(this.key(owner, name));
    this.repoById.delete(repo.id);
  }

  listRepos(owner) {
    const wanted = String(owner).toLowerCase();
    return [...this.repos.values()].filter((repo) => repo.owner.toLowerCase() === wanted).sort((a, b) => a.id - b.id);
  }

  // ------------------------------------------------------------ trees

  /** Every file path under `treeOid`, with its blob oid and mode. */
  flatten(treeOid, prefix = '', out = new Map()) {
    const tree = this.objectOf(treeOid);
    if (!tree || tree.type !== 'tree') return out;
    for (const entry of parseTree(tree.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') this.flatten(entry.oid, path, out);
      else if (entry.mode === '160000') out.set(path, { oid: entry.oid, mode: entry.mode });
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
    return out;
  }

  objectOf(oid) {
    for (const repo of this.repos.values()) {
      const found = repo.objects.get(oid);
      if (found) return found;
    }
    return null;
  }

  /** The tree of one commit in `repo`, or null. */
  commitTree(repo, commitOid) {
    const commit = repo.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return null;
    return parseCommit(commit.data).tree;
  }

  /** Build nested trees for a path -> {oid, mode} map and answer the root tree's oid. */
  writeTree(repo, files) {
    const root = new Map();
    for (const [path, entry] of files) {
      const segments = path.split('/').filter((segment) => segment !== '');
      let node = root;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const segment = segments[index];
        if (!node.has(segment)) node.set(segment, new Map());
        const next = node.get(segment);
        if (!(next instanceof Map)) throw new HttpError(422, `path ${path} collides with a file`);
        node = next;
      }
      node.set(segments[segments.length - 1], entry);
    }
    const write = (node) => {
      const entries = [];
      for (const [name, value] of node) {
        if (value instanceof Map) {
          entries.push({ mode: '40000', name, oid: write(value) });
        } else {
          entries.push({ mode: value.mode ?? '100644', name, oid: value.oid });
        }
      }
      return repo.putObject('tree', buildTree(entries));
    };
    return write(root);
  }

  /** The files of a commit, or an empty map for an unborn branch. */
  filesAt(repo, commitOid) {
    if (!commitOid) return new Map();
    const tree = this.commitTree(repo, commitOid);
    return tree ? this.flatten(tree) : new Map();
  }

  /** Every tree and blob oid under `treeOid`, the tree itself included: what a clone needs. */
  treeObjects(repo, treeOid, out = new Set()) {
    if (!treeOid || out.has(treeOid)) return out;
    const object = repo.objects.get(treeOid);
    if (!object || object.type !== 'tree') return out;
    out.add(treeOid);
    for (const entry of parseTree(object.data)) {
      if (entry.mode === '40000') this.treeObjects(repo, entry.oid, out);
      else out.add(entry.oid);
    }
    return out;
  }

  // ------------------------------------------------------------ commits

  /** Write a commit over `files` and answer its oid. */
  createCommit(repo, { files, parents, message, author }) {
    const tree = this.writeTree(repo, files);
    const who = author ?? { name: this.login, email: this.email };
    const time = FIXED_EPOCH + repo.tick();
    const data = buildCommit({ tree, parents, author: { ...who, time }, committer: { ...who, time }, message });
    return repo.putObject('commit', data);
  }

  /** Every commit reachable from `tip`, newest first, as {oid, commit, depth}. */
  history(repo, tip, limit = 10000) {
    const out = [];
    const seen = new Set();
    let frontier = tip ? [tip] : [];
    while (frontier.length > 0 && out.length < limit) {
      const next = [];
      for (const oid of frontier) {
        if (!oid || seen.has(oid)) continue;
        seen.add(oid);
        const object = repo.objects.get(oid);
        if (!object || object.type !== 'commit') continue;
        const commit = parseCommit(object.data);
        out.push({ oid, commit });
        for (const parent of commit.parents) if (!seen.has(parent)) next.push(parent);
      }
      frontier = next;
    }
    return out;
  }

  /** Whether `ancestor` is `descendant` or one of its ancestors. */
  isAncestor(repo, ancestor, descendant) {
    if (!ancestor || !descendant) return false;
    if (ancestor === descendant) return true;
    // A push almost always advances one commit: answer that without walking the history.
    const direct = repo.objects.get(descendant);
    if (direct && direct.type === 'commit') {
      const parents = parseCommit(direct.data).parents;
      if (parents.length === 1 && parents[0] === ancestor) return true;
      if (parents.includes(ancestor)) return true;
    }
    const seen = new Set();
    let frontier = [descendant];
    while (frontier.length > 0) {
      const next = [];
      for (const oid of frontier) {
        if (seen.has(oid)) continue;
        seen.add(oid);
        const object = repo.objects.get(oid);
        if (!object || object.type !== 'commit') continue;
        for (const parent of parseCommit(object.data).parents) {
          if (parent === ancestor) return true;
          next.push(parent);
        }
      }
      frontier = next;
    }
    return false;
  }

  /** Whether `oid` exists in `repo` as a commit. */
  isCommit(repo, oid) {
    const object = repo.objects.get(oid);
    return Boolean(object && object.type === 'commit');
  }

  // ------------------------------------------------------------ contents

  /** Resolve a ref-ish name (branch, tag, commit sha) to a commit oid. */
  resolveRef(repo, ref) {
    if (!ref) return repo.headOid();
    if (repo.refs.has(ref)) {
      const oid = repo.refs.get(ref);
      return this.peelToCommit(repo, oid);
    }
    if (repo.refs.has(`refs/heads/${ref}`)) return this.peelToCommit(repo, repo.refs.get(`refs/heads/${ref}`));
    if (repo.refs.has(`refs/tags/${ref}`)) return this.peelToCommit(repo, repo.refs.get(`refs/tags/${ref}`));
    if (repo.objects.has(ref)) return this.peelToCommit(repo, ref);
    return null;
  }

  /** Follow tag objects down to the commit they name. */
  peelToCommit(repo, oid) {
    let current = oid;
    for (let depth = 0; depth < 8; depth += 1) {
      const object = repo.objects.get(current);
      if (!object) return null;
      if (object.type === 'commit') return current;
      if (object.type !== 'tag') return null;
      const text = object.data.toString('utf8');
      const line = text.split('\n').find((entry) => entry.startsWith('object '));
      if (!line) return null;
      current = line.slice(7).trim();
    }
    return null;
  }

  /** Commit one file write; answers {commit, content}. */
  writeFile(repo, { path, content, message, branch, expectedSha, author }) {
    const ref = `refs/heads/${branch ?? repo.defaultBranch}`;
    const tip = repo.ref(ref);
    const files = new Map(this.filesAt(repo, tip));
    const current = files.get(path);
    if (expectedSha !== undefined && expectedSha !== null && expectedSha !== '') {
      const actual = current ? current.oid : null;
      if (actual !== expectedSha) throw new HttpError(409, `${path} does not match ${expectedSha}`);
    } else if (current) {
      throw new HttpError(422, `Invalid request: sha is required to update ${path}`);
    }
    const blob = repo.putObject('blob', Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8'));
    files.set(path, { oid: blob, mode: '100644' });
    const commit = this.createCommit(repo, { files, parents: tip ? [tip] : [], message: message ?? `Update ${path}`, author });
    repo.setRef(ref, commit);
    if (!repo.headOid() && repo.defaultBranch === (branch ?? repo.defaultBranch)) repo.setRef(repo.headRef(), commit);
    return { commit, content: blob, created: !current };
  }

  /** Commit one file deletion; answers {commit}. */
  removeFile(repo, { path, message, branch, expectedSha, author }) {
    const ref = `refs/heads/${branch ?? repo.defaultBranch}`;
    const tip = repo.ref(ref);
    if (!tip) throw new HttpError(404, 'Not Found');
    const files = new Map(this.filesAt(repo, tip));
    const current = files.get(path);
    if (!current) throw new HttpError(404, 'Not Found');
    if (expectedSha && current.oid !== expectedSha) throw new HttpError(409, `${path} does not match ${expectedSha}`);
    files.delete(path);
    const commit = this.createCommit(repo, { files, parents: [tip], message: message ?? `Delete ${path}`, author });
    repo.setRef(ref, commit);
    return { commit };
  }

  // ------------------------------------------------------------ issues

  createIssue(repo, { title, body, labels, author }) {
    if (typeof title !== 'string' || title === '') throw new HttpError(422, 'Invalid request: title is required');
    const names = Array.isArray(labels) ? labels.map((label) => (typeof label === 'string' ? label : label && label.name)) : [];
    const missing = names.filter((name) => !repo.labels.has(name));
    if (missing.length > 0) throw new HttpError(422, `Invalid request: label ${missing[0]} does not exist`);
    repo.issueSeq += 1;
    const tick = repo.tick();
    const issue = {
      id: repo.issueSeq,
      number: repo.issueSeq,
      title,
      body: typeof body === 'string' ? body : '',
      state: 'open',
      labels: names.map((name) => ({ ...repo.labels.get(name) })),
      user: author ?? this.login,
      created_at: isoAt(tick),
      updated_at: isoAt(tick),
      closed_at: null,
      comments: 0,
    };
    repo.issues.push(issue);
    return issue;
  }

  findIssue(repo, number) {
    const found = repo.issues.find((issue) => issue.number === Number(number));
    if (!found) throw new HttpError(404, 'Not Found');
    return found;
  }

  updateIssue(repo, number, patch) {
    const issue = this.findIssue(repo, number);
    if (typeof patch.title === 'string' && patch.title !== '') issue.title = patch.title;
    if (typeof patch.body === 'string') issue.body = patch.body;
    if (patch.state === 'open' || patch.state === 'closed') {
      if (issue.state !== patch.state) {
        issue.state = patch.state;
        issue.closed_at = patch.state === 'closed' ? isoAt(repo.tick()) : null;
      }
    }
    if (Array.isArray(patch.labels)) {
      const names = patch.labels.map((label) => (typeof label === 'string' ? label : label && label.name));
      const missing = names.filter((name) => !repo.labels.has(name));
      if (missing.length > 0) throw new HttpError(422, `Invalid request: label ${missing[0]} does not exist`);
      issue.labels = names.map((name) => ({ ...repo.labels.get(name) }));
    }
    issue.updated_at = isoAt(repo.tick());
    issue.jsonBody = undefined;
    return issue;
  }

  listIssues(repo, { state = 'open', sort = 'created', direction = 'desc', labels = [] } = {}) {
    let issues = [...repo.issues];
    if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
    if (labels.length > 0) issues = issues.filter((issue) => labels.every((name) => issue.labels.some((label) => label.name === name)));
    issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
    return issues;
  }

  createLabel(repo, { name, color, description }) {
    if (typeof name !== 'string' || name === '') throw new HttpError(422, 'Invalid request: name is required');
    if (repo.labels.has(name)) throw new HttpError(422, `Validation Failed: label already exists: ${name}`);
    const label = { name, color: typeof color === 'string' ? color.replace(/^#/, '') : 'ededed', description: description ?? '' };
    repo.labels.set(name, label);
    return label;
  }

  addComment(repo, number, body) {
    const issue = this.findIssue(repo, number);
    if (typeof body !== 'string' || body === '') throw new HttpError(422, 'Invalid request: body is required');
    repo.commentSeq += 1;
    const tick = repo.tick();
    const comment = { id: repo.commentSeq, issue: issue.number, body, user: this.login, created_at: isoAt(tick), updated_at: isoAt(tick) };
    repo.comments.push(comment);
    issue.comments += 1;
    issue.jsonBody = undefined;
    return comment;
  }

  listComments(repo, number) {
    this.findIssue(repo, number);
    return repo.comments.filter((comment) => comment.issue === Number(number));
  }

  // ------------------------------------------------------------ pull requests

  createPull(repo, { title, body, head, base }) {
    const headRef = `refs/heads/${head}`;
    const baseRef = `refs/heads/${base}`;
    const headOid = repo.ref(headRef);
    const baseOid = repo.ref(baseRef);
    if (!headOid) throw new HttpError(422, `Validation Failed: head ref ${head} does not exist`);
    if (!baseOid) throw new HttpError(422, `Validation Failed: base ref ${base} does not exist`);
    if (typeof title !== 'string' || title === '') throw new HttpError(422, 'Invalid request: title is required');
    repo.pullSeq += 1;
    const tick = repo.tick();
    const pull = {
      id: repo.pullSeq,
      number: repo.pullSeq,
      title,
      body: typeof body === 'string' ? body : '',
      state: 'open',
      head,
      base,
      headSha: headOid,
      baseSha: baseOid,
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      created_at: isoAt(tick),
      updated_at: isoAt(tick),
      user: this.login,
    };
    repo.pulls.push(pull);
    return pull;
  }

  findPull(repo, number) {
    const found = repo.pulls.find((pull) => pull.number === Number(number));
    if (!found) throw new HttpError(404, 'Not Found');
    return found;
  }

  /** The pull's current tips, re-read from its refs (a branch may have moved). */
  pullTips(repo, pull) {
    return {
      head: repo.ref(`refs/heads/${pull.head}`) ?? pull.headSha,
      base: repo.ref(`refs/heads/${pull.base}`) ?? pull.baseSha,
    };
  }

  /** Whether the pull can be merged: its base tip is an ancestor of its head tip. */
  pullMergeable(repo, pull) {
    if (pull.merged) return false;
    const tips = this.pullTips(repo, pull);
    return this.isAncestor(repo, tips.base, tips.head);
  }

  /** The files a pull changes, with the line counts GitHub reports. */
  pullFiles(repo, pull) {
    const tips = this.pullTips(repo, pull);
    const before = this.filesAt(repo, tips.base);
    const after = this.filesAt(repo, tips.head);
    const paths = new Set([...before.keys(), ...after.keys()]);
    const out = [];
    for (const path of [...paths].sort()) {
      const left = before.get(path);
      const right = after.get(path);
      if (left && right && left.oid === right.oid) continue;
      const leftText = left ? this.textOf(repo, left.oid) : '';
      const rightText = right ? this.textOf(repo, right.oid) : '';
      const additions = right ? countAdded(leftText, rightText) : 0;
      const deletions = left ? countAdded(rightText, leftText) : 0;
      const status = !left ? 'added' : !right ? 'removed' : 'modified';
      out.push({ filename: path, status, additions, deletions, changes: additions + deletions, sha: right ? right.oid : left.oid });
    }
    return out;
  }

  textOf(repo, oid) {
    const object = repo.objects.get(oid);
    if (!object) return '';
    return object.data.toString('utf8');
  }

  /** Squash-merge a pull onto its base branch; answers the merge commit. */
  mergePull(repo, pull) {
    if (!this.pullMergeable(repo, pull)) throw new HttpError(405, 'Pull Request is not mergeable');
    const tips = this.pullTips(repo, pull);
    const headTree = this.commitTree(repo, tips.head);
    if (!headTree) throw new HttpError(405, 'Pull Request is not mergeable');
    const files = new Map(this.flatten(headTree));
    const message = `${pull.title} (#${pull.number})\n\n${pull.body}`.trimEnd();
    const commit = this.createCommit(repo, { files, parents: [tips.base], message });
    repo.setRef(`refs/heads/${pull.base}`, commit);
    pull.state = 'closed';
    pull.merged = true;
    pull.merged_at = isoAt(repo.tick());
    pull.merge_commit_sha = commit;
    pull.headSha = tips.head;
    pull.baseSha = tips.base;
    pull.updated_at = pull.merged_at;
    return { commit, message };
  }

  listPulls(repo, { state = 'open' } = {}) {
    let pulls = [...repo.pulls];
    if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
    pulls.sort((a, b) => a.number - b.number);
    return pulls;
  }
}

/** Lines of `right` that are not in `left`, counted as multiset difference. */
function countAdded(leftText, rightText) {
  if (rightText === '') return 0;
  const left = new Map();
  for (const line of leftText.split('\n')) left.set(line, (left.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of rightText.split('\n')) {
    const count = left.get(line) ?? 0;
    if (count > 0) left.set(line, count - 1);
    else added += 1;
  }
  return added;
}

export { ZERO_OID, sha1hex };
