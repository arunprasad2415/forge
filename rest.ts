// rest.ts: the GitHub REST v3 surface the suite drives, over the shared store.
//
// Every reply is application/json with an X-GitHub-Request-Id, every error carries a string
// message, and the repository/issue/pull shapes are the ones the conformance checks read:
// default_branch, head/base with ref+sha, merge_commit_sha, base64 contents with sha and size.

import { HttpError, globalId, isoAt } from './store.ts';
import { ZERO_OID } from './gitcore.ts';

const API_VERSION = '2022-11-28';

/** The API root's body. */
function apiRoot() {
  return {
    current_user_url: '/api/v3/user',
    repository_url: '/api/v3/repos/{owner}/{repo}',
    user_url: '/api/v3/users/{user}',
    rate_limit_url: '/api/v3/rate_limit',
    installed_version: '3.0.0',
  };
}

/** A repository object in GitHub's shape. */
export function repoJson(store, repo) {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: repo.fullName,
    private: repo.private,
    owner: { login: repo.owner, id: 1000, type: 'User', site_admin: false },
    description: repo.description,
    fork: false,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    has_issues: true,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    clone_url: `${repo.owner}/${repo.name}.git`,
    html_url: `https://github.com/${repo.fullName}`,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

/** An issue object in GitHub's shape. */
export function issueJson(store, repo, issue) {
  return {
    id: 100000 + issue.id,
    node_id: globalId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label, index) => ({ id: 200000 + index, name: label.name, color: label.color, description: label.description ?? '' })),
    user: { login: issue.user, id: 1000, type: 'User' },
    assignee: null,
    assignees: [],
    comments: issue.comments,
    locked: false,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    repository_url: `/api/v3/repos/${repo.fullName}`,
  };
}

/** A comment object in GitHub's shape. */
function commentJson(repo, comment) {
  return {
    id: 300000 + comment.id,
    node_id: globalId('IssueComment', comment.id),
    body: comment.body,
    user: { login: comment.user, id: 1000, type: 'User' },
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    issue_url: `/api/v3/repos/${repo.fullName}/issues/${comment.issue}`,
  };
}

/** A pull request object in GitHub's shape. */
export function pullJson(store, repo, pull) {
  const tips = store.pullTips(repo, pull);
  return {
    id: 400000 + pull.id,
    node_id: globalId('PullRequest', pull.id),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: { login: pull.user, id: 1000, type: 'User' },
    head: { ref: pull.head, sha: tips.head, label: `${repo.owner}:${pull.head}`, user: { login: repo.owner } },
    base: { ref: pull.base, sha: tips.base, label: `${repo.owner}:${pull.base}`, user: { login: repo.owner } },
    merged: pull.merged === true,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    mergeable: store.pullMergeable(repo, pull),
    draft: false,
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    commits: 1,
    changed_files: store.pullFiles(repo, pull).length,
  };
}

/** A commit list entry. */
function commitJson(repo, oid) {
  const object = repo.objects.get(oid);
  const commit = object ? parseCommitLoose(object.data) : { tree: '', parents: [], author: '', committer: '', message: '' };
  const author = identityOf(commit.author);
  const committer = identityOf(commit.committer);
  // GitHub reports a commit's message as it was written, without the newline git stores after it.
  const message = commit.message.endsWith('\n') ? commit.message.slice(0, -1) : commit.message;
  return {
    sha: oid,
    node_id: globalId('Commit', oid.slice(0, 12)),
    commit: {
      message,
      author: { name: author.name, email: author.email, date: isoAt(Number(author.time) - 1700000000) },
      committer: { name: committer.name, email: committer.email, date: isoAt(Number(committer.time) - 1700000000) },
      tree: { sha: commit.tree },
    },
    author: { login: repo.owner, id: 1000, type: 'User' },
    committer: { login: repo.owner, id: 1000, type: 'User' },
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

function parseCommitLoose(data) {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const out = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) out.tree = line.slice(5);
    else if (line.startsWith('parent ')) out.parents.push(line.slice(7));
    else if (line.startsWith('author ')) out.author = line.slice(7);
    else if (line.startsWith('committer ')) out.committer = line.slice(10);
  }
  return out;
}

/** "Name <email> 1700000001 +0000" -> its parts. */
function identityOf(line) {
  const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line ?? '');
  if (!match) return { name: line ?? '', email: '', time: '1700000000' };
  return { name: match[1], email: match[2], time: match[3] };
}

/** A base64 body for one blob. */
function base64Of(repo, oid) {
  const object = repo.objects.get(oid);
  return object ? object.data.toString('base64') : '';
}

function sizeOf(repo, oid) {
  const object = repo.objects.get(oid);
  return object ? object.data.length : 0;
}

/** Decode a contents request body's content (base64, per the API). */
function decodeContent(value) {
  if (typeof value !== 'string') throw new HttpError(422, 'Invalid request: content is required');
  return Buffer.from(value.replace(/\n/g, ''), 'base64');
}

/**
 * Route one REST call. `ctx` is {method, segments, query, body, login, origin}; the answer is
 * {status, body, headers}. Errors throw HttpError and the caller renders them.
 */
export function handleRest(store, ctx) {
  const { method, segments, query, body } = ctx;
  const path = segments.join('/');
  const login = ctx.login ?? store.login;

  if (segments.length === 0) {
    if (method !== 'GET') throw new HttpError(404, 'Not Found');
    return { status: 200, body: apiRoot() };
  }
  if (path === 'meta' && method === 'GET') {
    return { status: 200, body: { verifiable_password_authentication: false, installed_version: '3.0.0', hooks: [], git: [], ssh_key_fingerprints: {} } };
  }
  if (path === 'user' && method === 'GET') {
    return { status: 200, body: { login, id: 1000, node_id: globalId('User', 1000), type: 'User', name: login, email: `${login}@example.invalid`, public_repos: store.listRepos(login).length, total_private_repos: 0 } };
  }
  if (path === 'user/repos') {
    if (method === 'GET') return listUserRepos(store, ctx, login);
    if (method === 'POST') return createRepo(store, ctx, login);
  }
  if (path === 'user/orgs' && method === 'GET') return { status: 200, body: [] };
  if (path === 'rate_limit' && method === 'GET') return { status: 200, body: { resources: {}, rate: { limit: 5000, remaining: 4999, reset: 1700000000, used: 1 } } };

  if (segments[0] === 'repos' && segments.length >= 3) {
    const repo = store.requireRepo(segments[1], segments[2]);
    return routeRepo(store, ctx, repo);
  }
  throw new HttpError(404, 'Not Found');
}

/** GET /user/repos with Link pagination. */
function listUserRepos(store, ctx, login) {
  const repos = store.listRepos(login).map((repo) => repoJson(store, repo));
  const perPage = clampInt(ctx.query.per_page, 30, 1, 100);
  const page = clampInt(ctx.query.page, 1, 1, 100000);
  const start = (page - 1) * perPage;
  const slice = repos.slice(start, start + perPage);
  const headers = {};
  if (start + perPage < repos.length) {
    const url = `${ctx.origin}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
    headers.link = `<${url}>; rel="next"`;
  }
  return { status: 200, body: slice, headers };
}

function clampInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

/** POST /user/repos */
function createRepo(store, ctx, login) {
  const body = ctx.body ?? {};
  const name = typeof body.name === 'string' ? body.name : '';
  const repo = store.createRepo(login, name, {
    description: typeof body.description === 'string' ? body.description : '',
    private: body.private === true,
    defaultBranch: typeof body.default_branch === 'string' && body.default_branch !== '' ? body.default_branch : 'main',
  });
  if (body.auto_init === true) {
    const path = 'README.md';
    store.writeFile(repo, { path, content: `# ${name}\n`, message: 'Initial commit' });
  }
  return { status: 201, body: repoJson(store, repo) };
}

/** Everything under /repos/{owner}/{repo}. */
function routeRepo(store, ctx, repo) {
  const { method, segments, query, body } = ctx;
  const rest = segments.slice(3);
  const path = rest.join('/');

  if (rest.length === 0) {
    if (method === 'GET') return { status: 200, body: repoJson(store, repo) };
    if (method === 'PATCH') {
      if (typeof body?.description === 'string') repo.description = body.description;
      if (typeof body?.name === 'string' && body.name !== '' && body.name !== repo.name) {
        if (store.getRepo(repo.owner, body.name)) throw new HttpError(422, 'Repository creation failed: name already exists on this account');
        store.repos.delete(store.key(repo.owner, repo.name));
        repo.name = body.name;
        store.repos.set(store.key(repo.owner, repo.name), repo);
      }
      if (body?.private === true || body?.private === false) repo.private = body.private;
      if (typeof body?.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
      repo.updatedAt = isoAt(repo.tick());
      return { status: 200, body: repoJson(store, repo) };
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo.owner, repo.name);
      return { status: 204, body: null };
    }
    throw new HttpError(404, 'Not Found');
  }

  if (path === 'branches' && method === 'GET') {
    const branches = [...repo.refs.keys()]
      .filter((name) => name.startsWith('refs/heads/'))
      .sort()
      .map((name) => ({
        name: name.slice('refs/heads/'.length),
        commit: { sha: repo.refs.get(name), url: `/api/v3/repos/${repo.fullName}/commits/${repo.refs.get(name)}` },
        protected: false,
      }));
    return { status: 200, body: branches };
  }

  if (rest[0] === 'branches' && rest.length === 2 && method === 'GET') {
    const name = decodeURIComponent(rest[1]);
    const oid = repo.ref(`refs/heads/${name}`);
    if (!oid) throw new HttpError(404, 'Branch not found');
    return { status: 200, body: { name, commit: { sha: oid }, protected: false } };
  }

  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const ref = query.sha ?? repo.defaultBranch;
    const tip = store.resolveRef(repo, ref);
    if (!tip) throw new HttpError(404, 'Not Found');
    const perPage = clampInt(query.per_page, 30, 1, 100);
    const history = store.history(repo, tip).slice(0, perPage);
    return { status: 200, body: history.map((entry) => commitJson(repo, entry.oid)) };
  }

  if (rest[0] === 'commits' && rest.length === 2 && method === 'GET') {
    const oid = store.resolveRef(repo, rest[1]);
    if (!oid) throw new HttpError(404, 'Not Found');
    return { status: 200, body: commitJson(repo, oid) };
  }

  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && method === 'POST') {
      const ref = typeof body?.ref === 'string' ? body.ref : '';
      const sha = typeof body?.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/') || !sha) throw new HttpError(422, 'Invalid request: ref and sha are required');
      if (repo.refs.has(ref)) throw new HttpError(422, 'Reference already exists');
      repo.setRef(ref, sha);
      return { status: 201, body: { ref, node_id: globalId('Ref', ref), object: { sha, type: 'commit' } } };
    }
    if (rest.length >= 4 && rest[2] === 'heads' && method === 'GET') {
      const name = decodeURIComponent(rest.slice(3).join('/'));
      const oid = repo.ref(`refs/heads/${name}`);
      if (!oid) throw new HttpError(404, 'Not Found');
      return { status: 200, body: { ref: `refs/heads/${name}`, object: { sha: oid, type: 'commit' } } };
    }
    if (rest.length >= 4 && rest[2] === 'tags' && method === 'GET') {
      const name = decodeURIComponent(rest.slice(3).join('/'));
      const oid = repo.ref(`refs/tags/${name}`);
      if (!oid) throw new HttpError(404, 'Not Found');
      return { status: 200, body: { ref: `refs/tags/${name}`, object: { sha: oid, type: 'tag' } } };
    }
    throw new HttpError(404, 'Not Found');
  }

  if (rest[0] === 'contents') return routeContents(store, ctx, repo, rest.slice(1));

  if (rest[0] === 'labels') {
    if (rest.length === 1 && method === 'GET') return { status: 200, body: [...repo.labels.values()].map((label, index) => ({ id: 200000 + index, name: label.name, color: label.color, description: label.description ?? '' })) };
    if (rest.length === 1 && method === 'POST') {
      const label = store.createLabel(repo, body ?? {});
      return { status: 201, body: { id: 200000, name: label.name, color: label.color, description: label.description } };
    }
    throw new HttpError(404, 'Not Found');
  }

  if (rest[0] === 'issues') return routeIssues(store, ctx, repo, rest.slice(1));
  if (rest[0] === 'pulls') return routePulls(store, ctx, repo, rest.slice(1));

  throw new HttpError(404, 'Not Found');
}

/** /repos/{o}/{r}/contents[/path] */
function routeContents(store, ctx, repo, rest) {
  const { method, query, body } = ctx;
  const rawPath = rest.map((segment) => decodeURIComponent(segment)).join('/');
  const ref = query.ref;
  const commit = store.resolveRef(repo, ref);

  if (method === 'GET') {
    if (!commit) throw new HttpError(404, 'Not Found');
    if (rawPath === '') {
      const tree = store.commitTree(repo, commit);
      const entries = tree ? listTree(store, repo, tree, '') : [];
      return { status: 200, body: entries };
    }
    const files = store.filesAt(repo, commit);
    const entry = files.get(rawPath);
    if (!entry) {
      const tree = store.commitTree(repo, commit);
      const dir = tree ? findDir(store, repo, tree, rawPath) : null;
      if (!dir) throw new HttpError(404, 'Not Found');
      return { status: 200, body: listTree(store, repo, dir, rawPath) };
    }
    return {
      status: 200,
      body: {
        type: 'file',
        encoding: 'base64',
        size: sizeOf(repo, entry.oid),
        name: rawPath.split('/').pop(),
        path: rawPath,
        content: base64Of(repo, entry.oid),
        sha: entry.oid,
        url: `/api/v3/repos/${repo.fullName}/contents/${rawPath}`,
        git_url: `/api/v3/repos/${repo.fullName}/git/blobs/${entry.oid}`,
      },
    };
  }

  if (method === 'PUT') {
    const content = decodeContent(body?.content);
    const branch = typeof body?.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const result = store.writeFile(repo, {
      path: rawPath,
      content,
      message: typeof body?.message === 'string' ? body.message : `Update ${rawPath}`,
      branch,
      expectedSha: body?.sha,
    });
    return {
      status: result.created ? 201 : 200,
      body: {
        content: {
          name: rawPath.split('/').pop(),
          path: rawPath,
          sha: result.content,
          size: content.length,
          encoding: 'base64',
          content: content.toString('base64'),
          type: 'file',
        },
        commit: { sha: result.commit, message: typeof body?.message === 'string' ? body.message : `Update ${rawPath}`, node_id: globalId('Commit', result.commit.slice(0, 12)) },
      },
    };
  }

  if (method === 'DELETE') {
    const branch = typeof body?.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const result = store.removeFile(repo, {
      path: rawPath,
      message: typeof body?.message === 'string' ? body.message : `Delete ${rawPath}`,
      branch,
      expectedSha: body?.sha,
    });
    return { status: 200, body: { commit: { sha: result.commit, message: typeof body?.message === 'string' ? body.message : `Delete ${rawPath}` } } };
  }

  throw new HttpError(404, 'Not Found');
}

/** The entries of one tree, as the contents API lists them. */
function listTree(store, repo, treeOid, prefix) {
  const object = repo.objects.get(treeOid);
  if (!object) return [];
  const entries = [];
  for (const entry of parseTreeLoose(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') entries.push({ type: 'dir', name: entry.name, path, sha: entry.oid, size: 0 });
    else entries.push({ type: 'file', name: entry.name, path, sha: entry.oid, size: sizeOf(repo, entry.oid) });
  }
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The tree oid at `path` under `treeOid`, or null. */
function findDir(store, repo, treeOid, path) {
  let current = treeOid;
  for (const segment of path.split('/')) {
    const object = repo.objects.get(current);
    if (!object) return null;
    const entry = parseTreeLoose(object.data).find((candidate) => candidate.name === segment);
    if (!entry) return null;
    current = entry.oid;
  }
  return current;
}

function parseTreeLoose(data) {
  const entries = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const nul = data.indexOf(0x00, space);
    if (space < 0 || nul < 0) break;
    entries.push({ mode: data.toString('ascii', pos, space), name: data.toString('utf8', space + 1, nul), oid: data.toString('hex', nul + 1, nul + 21) });
    pos = nul + 21;
  }
  return entries;
}

/** /repos/{o}/{r}/issues[...] */
function routeIssues(store, ctx, repo, rest) {
  const { method, query, body } = ctx;
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = typeof query.state === 'string' ? query.state : 'open';
      const sort = typeof query.sort === 'string' ? query.sort : 'created';
      const direction = typeof query.direction === 'string' ? query.direction : 'desc';
      const labels = typeof query.labels === 'string' && query.labels !== '' ? query.labels.split(',') : [];
      const issues = store.listIssues(repo, { state, sort, direction, labels });
      const perPage = clampInt(query.per_page, 30, 1, 100);
      return { status: 200, body: issues.slice(0, perPage).map((issue) => issueJson(store, repo, issue)) };
    }
    if (method === 'POST') {
      const issue = store.createIssue(repo, { title: body?.title, body: body?.body, labels: body?.labels, author: ctx.login });
      return { status: 201, body: issueJson(store, repo, issue) };
    }
    throw new HttpError(404, 'Not Found');
  }
  const number = Number(rest[0]);
  if (rest.length === 1) {
    if (method === 'GET') return { status: 200, body: issueJson(store, repo, store.findIssue(repo, number)) };
    if (method === 'PATCH') return { status: 200, body: issueJson(store, repo, store.updateIssue(repo, number, body ?? {})) };
    throw new HttpError(404, 'Not Found');
  }
  if (rest.length === 2 && rest[1] === 'comments') {
    if (method === 'GET') return { status: 200, body: store.listComments(repo, number).map((comment) => commentJson(repo, comment)) };
    if (method === 'POST') {
      const comment = store.addComment(repo, number, body?.body);
      return { status: 201, body: commentJson(repo, comment) };
    }
  }
  throw new HttpError(404, 'Not Found');
}

/** /repos/{o}/{r}/pulls[...] */
function routePulls(store, ctx, repo, rest) {
  const { method, query, body } = ctx;
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = typeof query.state === 'string' ? query.state : 'open';
      const pulls = store.listPulls(repo, { state });
      const perPage = clampInt(query.per_page, 30, 1, 100);
      return { status: 200, body: pulls.slice(0, perPage).map((pull) => pullJson(store, repo, pull)) };
    }
    if (method === 'POST') {
      const pull = store.createPull(repo, { title: body?.title, body: body?.body, head: body?.head, base: body?.base ?? repo.defaultBranch });
      return { status: 201, body: pullJson(store, repo, pull) };
    }
    throw new HttpError(404, 'Not Found');
  }
  const number = Number(rest[0]);
  const pull = store.findPull(repo, number);
  if (rest.length === 1) {
    if (method === 'GET') return { status: 200, body: pullJson(store, repo, pull) };
    if (method === 'PATCH') {
      if (typeof body?.state === 'string' && ['open', 'closed'].includes(body.state)) {
        pull.state = body.state;
        pull.updated_at = isoAt(repo.tick());
      }
      if (typeof body?.title === 'string' && body.title !== '') pull.title = body.title;
      if (typeof body?.body === 'string') pull.body = body.body;
      return { status: 200, body: pullJson(store, repo, pull) };
    }
    throw new HttpError(404, 'Not Found');
  }
  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    return { status: 200, body: store.pullFiles(repo, pull) };
  }
  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    const result = store.mergePull(repo, pull);
    return { status: 200, body: { sha: result.commit, merged: true, message: result.message } };
  }
  throw new HttpError(404, 'Not Found');
}

export { API_VERSION, ZERO_OID };
