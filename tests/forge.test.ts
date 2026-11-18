// forge.test.ts: the forge's own tests, run with `node --test tests/`.
//
// Every test boots the real server on an ephemeral port and speaks to it over HTTP the way the
// trial's suite does: REST v3, GraphQL v4, MCP and git smart HTTP. Nothing is stubbed, so a
// green run means the wire actually answers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.ts';
import { buildCommit, buildTree, decodePktLines, encodePktLines, hashObject, pktLine, readPack, writePack } from '../gitcore.ts';

const TOKEN = 'test-token';

/** Boot one server and answer {base, close}. */
async function boot() {
  const server = createApp();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function client(base) {
  const call = async (method, path, body, options = {}) => {
    const headers = {};
    if (options.token !== false) headers.authorization = `Bearer ${TOKEN}`;
    let payload;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const response = await fetch(`${base}${path}`, { method, headers, body: payload });
    const text = await response.text();
    let json;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, headers: response.headers, text, json };
  };
  return {
    get: (path, options) => call('GET', path, undefined, options),
    post: (path, body, options) => call('POST', path, body, options),
    put: (path, body, options) => call('PUT', path, body, options),
    patch: (path, body, options) => call('PATCH', path, body, options),
    del: (path, body, options) => call('DELETE', path, body, options),
    raw: call,
  };
}

const OWNER = 'adaiversen';

async function makeRepo(api, name) {
  const created = await api.post('/api/v3/user/repos', { name, private: true, description: 'test repository' });
  assert.equal(created.status, 201);
  assert.equal(created.json.name, name);
  return `/api/v3/repos/${OWNER}/${name}`;
}

/** The contents API's first commit on the default branch. */
async function seedFile(api, repoPath, path, content) {
  const put = await api.put(`${repoPath}/contents/${path}`, { message: `add ${path}`, content: Buffer.from(content).toString('base64') });
  assert.equal(put.status, 201);
  return put.json;
}

// ---------------------------------------------------------------- the lifecycle

test('the server answers the boot probe and stays up', async () => {
  const server = await boot();
  try {
    const health = await client(server.base).get('/healthz', { token: false });
    assert.equal(health.status, 200);
    assert.deepEqual(health.json, { ok: true });
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------- REST v3

test('repositories: create, read, patch, delete', async () => {
  const server = await boot();
  const api = client(server.base);
  try {
    const repoPath = await makeRepo(api, 'rest-repo');
    const read = await api.get(repoPath);
    assert.equal(read.status, 200);
    assert.equal(read.json.private, true);
    assert.equal(read.json.default_branch, 'main');
    assert.ok(read.headers.get('x-github-request-id'));

    const patched = await api.patch(repoPath, { description: 'changed' });
    assert.equal(patched.status, 200);
    assert.equal(patched.json.description, 'changed');

    assert.equal((await api.del(repoPath)).status, 204);
    assert.equal((await api.get(repoPath)).status, 404);
  } finally {
    await server.close();
  }
});

test('contents: create, read back base64, stale sha is 409, delete', async () => {
  const server = await boot();
  const api = client(server.base);
  try {
    const repoPath = await makeRepo(api, 'contents-repo');
    const created = await seedFile(api, repoPath, 'docs/readme.md', 'hello forge\n');
    assert.match(created.content.sha, /^[0-9a-f]{40}$/);

    const read = await api.get(`${repoPath}/contents/docs/readme.md`);
    assert.equal(read.status, 200);
    assert.equal(Buffer.from(read.json.content, 'base64').toString('utf8'), 'hello forge\n');
    assert.equal(read.json.size, 12);
    assert.equal(read.json.sha, created.content.sha);

    const update = await api.put(`${repoPath}/contents/docs/readme.md`, {
      message: 'update',
      content: Buffer.from('second\n').toString('base64'),
      sha: created.content.sha,
    });
    assert.equal(update.status, 200);

    const stale = await api.put(`${repoPath}/contents/docs/readme.md`, {
      message: 'stale',
      content: Buffer.from('third\n').toString('base64'),
      sha: created.content.sha,
    });
    assert.equal(stale.status, 409);

    const deleted = await api.del(`${repoPath}/contents/docs/readme.md`, { message: 'remove', sha: update.json.content.sha });
    assert.equal(deleted.status, 200);
    assert.equal((await api.get(`${repoPath}/contents/docs/readme.md`)).status, 404);
  } finally {
    await server.close();
  }
});

test('issues: create, label validation, list order, close, comments', async () => {
  const server = await boot();
  const api = client(server.base);
  try {
    const repoPath = await makeRepo(api, 'issues-repo');
    assert.equal((await api.post(`${repoPath}/labels`, { name: 'bug', color: 'ededed' })).status, 201);

    const first = await api.post(`${repoPath}/issues`, { title: 'one', body: 'first' });
    assert.equal(first.status, 201);
    assert.equal(first.json.state, 'open');
    assert.equal(first.json.number, 1);
    const second = await api.post(`${repoPath}/issues`, { title: 'two', body: 'second', labels: ['bug'] });
    assert.equal(second.json.number, 2);
    assert.deepEqual(second.json.labels.map((label) => label.name), ['bug']);

    const bad = await api.post(`${repoPath}/issues`, { title: 'three', labels: ['nope'] });
    assert.equal(bad.status, 422);
    assert.equal(typeof bad.json.message, 'string');

    const ascending = await api.get(`${repoPath}/issues?state=open&sort=created&direction=asc&per_page=100`);
    assert.deepEqual(ascending.json.map((issue) => issue.number), [1, 2]);
    const descending = await api.get(`${repoPath}/issues?state=open&sort=created&direction=desc&per_page=100`);
    assert.deepEqual(descending.json.map((issue) => issue.number), [2, 1]);

    const closed = await api.patch(`${repoPath}/issues/1`, { state: 'closed' });
    assert.equal(closed.json.state, 'closed');
    const open = await api.get(`${repoPath}/issues?state=open&per_page=100`);
    assert.deepEqual(open.json.map((issue) => issue.number), [2]);

    const comment = await api.post(`${repoPath}/issues/2/comments`, { body: 'a comment' });
    assert.equal(comment.status, 201);
    const comments = await api.get(`${repoPath}/issues/2/comments`);
    assert.equal(comments.json.length, 1);
    assert.equal(comments.json[0].body, 'a comment');
  } finally {
    await server.close();
  }
});

test('pulls: branch, files, squash merge, conflict is 405', async () => {
  const server = await boot();
  const api = client(server.base);
  try {
    const repoPath = await makeRepo(api, 'pulls-repo');
    const base = await seedFile(api, repoPath, 'docs/readme.md', 'base\n');
    assert.equal((await api.post(`${repoPath}/git/refs`, { ref: 'refs/heads/feature', sha: base.commit.sha })).status, 201);
    const headCommit = await api.put(`${repoPath}/contents/docs/feature.md`, {
      message: 'feature work',
      content: Buffer.from('feature\n').toString('base64'),
      branch: 'feature',
    });
    assert.equal(headCommit.status, 201);

    const pull = await api.post(`${repoPath}/pulls`, { title: 'Feature', body: 'body', head: 'feature', base: 'main' });
    assert.equal(pull.status, 201);
    assert.equal(pull.json.state, 'open');
    assert.equal(pull.json.head.sha, headCommit.json.commit.sha);

    const files = await api.get(`${repoPath}/pulls/${pull.json.number}/files`);
    assert.equal(files.status, 200);
    assert.deepEqual(files.json.map((file) => file.filename), ['docs/feature.md']);
    assert.equal(files.json[0].status, 'added');
    assert.ok(files.json[0].additions >= 1);

    const merged = await api.put(`${repoPath}/pulls/${pull.json.number}/merge`, { merge_method: 'squash' });
    assert.equal(merged.status, 200);
    assert.equal(merged.json.merged, true);
    const after = await api.get(`${repoPath}/pulls/${pull.json.number}`);
    assert.equal(after.json.merged, true);
    assert.equal(after.json.state, 'closed');
    assert.equal(after.json.merge_commit_sha, merged.json.sha);

    const mergedContent = await api.get(`${repoPath}/contents/docs/feature.md?ref=main`);
    assert.equal(Buffer.from(mergedContent.json.content, 'base64').toString('utf8'), 'feature\n');

    // A second branch from the old base changes the same file: after the first merge it conflicts.
    assert.equal((await api.post(`${repoPath}/git/refs`, { ref: 'refs/heads/other', sha: base.commit.sha })).status, 201);
    await api.put(`${repoPath}/contents/docs/readme.md`, { message: 'other', content: Buffer.from('other\n').toString('base64'), branch: 'other' });
    const conflictPull = await api.post(`${repoPath}/pulls`, { title: 'Other', body: '', head: 'other', base: 'main' });
    const conflict = await api.put(`${repoPath}/pulls/${conflictPull.json.number}/merge`, {});
    assert.equal(conflict.status, 405);
  } finally {
    await server.close();
  }
});

test('protocol: 401 without a token, JSON 404, 400 on malformed JSON, request ids', async () => {
  const server = await boot();
  const api = client(server.base);
  try {
    const repoPath = await makeRepo(api, 'protocol-repo');
    const anonymous = await api.get(repoPath, { token: false });
    assert.equal(anonymous.status, 401);
    assert.equal(typeof anonymous.json.message, 'string');

    const missing = await api.get('/api/v3/repos/adaiversen/no-such-repo');
    assert.equal(missing.status, 404);
    assert.equal(missing.json.message, 'Not Found');
    assert.match(missing.headers.get('content-type') ?? '', /application\/json/);

    const malformed = await api.post('/api/v3/user/repos', '{"name":');
    assert.equal(malformed.status, 400);
    assert.equal(typeof malformed.json.message, 'string');
  } finally {
    await server.close();
  }
});

test('repositories: pagination links the next page and ends', async () => {
  const server = await boot();
  const api = client(server.base);
  try {
    for (let index = 0; index < 25; index += 1) await makeRepo(api, `page-repo-${index}`);
    const seen = [];
    let url = '/api/v3/user/repos?per_page=10';
    let pages = 0;
    while (url !== null && pages < 10) {
      const page = await api.get(url);
      assert.equal(page.status, 200);
      assert.ok(page.json.length <= 10);
      seen.push(...page.json.map((repo) => repo.name));
      const link = page.headers.get('link');
      const match = link === null ? null : /<([^>]+)>;\s*rel="next"/.exec(link);
      url = match === null ? null : match[1].replace(server.base, '');
      pages += 1;
    }
    assert.equal(pages, 3);
    assert.equal(new Set(seen).size, 25);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------- git smart HTTP

/** Build a nested tree body for a path -> blob oid map, the way git nests directories. */
function nestedTree(files, objects) {
  const root = new Map();
  for (const [path, oid] of Object.entries(files)) {
    const segments = path.split('/');
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      if (!node.has(segment)) node.set(segment, new Map());
      node = node.get(segment);
    }
    node.set(segments[segments.length - 1], oid);
  }
  const write = (node, objects) => {
    const entries = [];
    for (const [name, value] of node) {
      if (value instanceof Map) entries.push({ mode: '40000', name, oid: write(value, objects) });
      else entries.push({ mode: '100644', name, oid: value });
    }
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    objects.push({ type: 'tree', data });
    return oid;
  };
  return write(root, objects);
}

/** Push one commit made of `files` to `branch`, over the real receive-pack protocol. */
async function pushCommit(base, owner, repo, branch, files, parents, message, oldOid) {
  const objects = [];
  const blobs = {};
  for (const [path, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    const oid = hashObject('blob', data);
    objects.push({ type: 'blob', data });
    blobs[path] = oid;
  }
  const tree = nestedTree(blobs, objects);
  const commitData = buildCommit({
    tree,
    parents,
    author: { name: 'tester', email: 'tester@example.invalid', time: 1700000000 },
    committer: { name: 'tester', email: 'tester@example.invalid', time: 1700000000 },
    message,
  });
  const commit = hashObject('commit', commitData);
  objects.push({ type: 'commit', data: commitData });
  const pack = writePack(objects);
  const old = oldOid ?? parents[0] ?? '0'.repeat(40);
  const body = Buffer.concat([
    encodePktLines([`${old} ${commit} refs/heads/${branch}\0report-status side-band-64k\n`, 'flush']),
    pack,
  ]);
  const response = await fetch(`${base}/${owner}/${repo}.git/git-receive-pack`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/x-git-receive-pack-request' },
    body,
  });
  assert.equal(response.status, 200);
  const { packets } = decodePktLines(Buffer.from(await response.arrayBuffer()));
  const report = packets
    .filter((packet) => packet.kind === 'data' && packet.payload[0] === 1)
    .map((packet) => packet.payload.subarray(1).toString('utf8'))
    .join('');
  return { commit, report };
}

/** v2 ls-refs over the real endpoint. */
async function lsRefs(base, owner, repo) {
  const response = await fetch(`${base}/${owner}/${repo}.git/git-upload-pack`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/x-git-upload-pack-request', 'git-protocol': 'version=2' },
    body: encodePktLines(['command=ls-refs\n', 'delim', 'symrefs\n', 'peel\n', 'flush']),
  });
  assert.equal(response.status, 200);
  const { packets } = decodePktLines(Buffer.from(await response.arrayBuffer()));
  return packets
    .filter((packet) => packet.kind === 'data')
    .map((packet) => packet.payload.toString('utf8').trim())
    .filter((line) => line !== '');
}

test('git: a push is reported, ls-refs sees it, and a clone carries every object', async () => {
  const server = await boot();
  const api = client(server.base);
  try {
    await makeRepo(api, 'git-repo');
    const pushed = await pushCommit(server.base, OWNER, 'git-repo', 'main', { 'a.txt': 'alpha\n', 'src/b.txt': 'beta\n' }, [], 'first commit');
    assert.match(pushed.report, /unpack ok/);
    assert.match(pushed.report, /ok refs\/heads\/main/);

    const refs = await lsRefs(server.base, OWNER, 'git-repo');
    assert.ok(refs.some((line) => line === `${pushed.commit} refs/heads/main`));
    assert.ok(refs.some((line) => line.startsWith(`${pushed.commit} HEAD symref-target:refs/heads/main`)));

    // A full fetch: every object the commit reaches must arrive and recompute to its id.
    const advertisement = await fetch(`${server.base}/${OWNER}/git-repo.git/info/refs?service=git-upload-pack`, {
      headers: { authorization: `Bearer ${TOKEN}`, 'git-protocol': 'version=2' },
    });
    const advertised = decodePktLines(Buffer.from(await advertisement.arrayBuffer())).packets
      .filter((packet) => packet.kind === 'data')
      .map((packet) => packet.payload.toString('utf8'));
    assert.ok(advertised.includes('version 2\n'));
    assert.ok(advertised.some((line) => line.startsWith('fetch=')));

    const fetched = await fetch(`${server.base}/${OWNER}/git-repo.git/git-upload-pack`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/x-git-upload-pack-request', 'git-protocol': 'version=2' },
      body: encodePktLines(['command=fetch\n', 'delim', 'want ' + pushed.commit + '\n', 'done\n', 'flush']),
    });
    assert.equal(fetched.status, 200);
    const { packets } = decodePktLines(Buffer.from(await fetched.arrayBuffer()));
    const chunks = packets.filter((packet) => packet.kind === 'data' && packet.payload[0] === 1).map((packet) => packet.payload.subarray(1));
    const pack = Buffer.concat(chunks);
    assert.equal(pack.toString('ascii', 0, 4), 'PACK');
    const read = readPack(pack);
    const types = [...read.objects.values()].map((object) => object.type).sort();
    assert.deepEqual(types, ['blob', 'blob', 'commit', 'tree', 'tree']);
    for (const [oid, object] of read.objects) assert.equal(hashObject(object.type, object.data), oid);
    const blob = [...read.objects.values()].find((object) => object.type === 'blob' && object.data.toString('utf8') === 'beta\n');
    assert.ok(blob);
  } finally {
    await server.close();
  }
});

test('git: a non-fast-forward push is refused per ref and the ref does not move', async () => {
  const server = await boot();
  const api = client(server.base);
  try {
    await makeRepo(api, 'git-ff-repo');
    const first = await pushCommit(server.base, OWNER, 'git-ff-repo', 'main', { 'a.txt': 'one\n' }, [], 'first');
    const second = await pushCommit(server.base, OWNER, 'git-ff-repo', 'main', { 'a.txt': 'two\n' }, [first.commit], 'second');

    // A sibling of `second` from the same parent: its push is not a fast-forward.
    const sibling = await pushCommit(server.base, OWNER, 'git-ff-repo', 'main', { 'a.txt': 'three\n' }, [first.commit], 'sibling', second.commit);
    assert.match(sibling.report, /ng refs\/heads\/main non-fast-forward/);

    const refs = await lsRefs(server.base, OWNER, 'git-ff-repo');
    assert.ok(refs.some((line) => line === `${second.commit} refs/heads/main`));
  } finally {
    await server.close();
  }
});

test('git: a missing repository is a 404 and a malformed body is survivable', async () => {
  const server = await boot();
  const api = client(server.base);
  try {
    await makeRepo(api, 'git-survive');
    const missing = await api.get('/adaiversen/git-missing.git/info/refs?service=git-upload-pack', { token: false });
    assert.equal(missing.status, 404);
    const malformed = await fetch(`${server.base}/adaiversen/git-survive.git/git-upload-pack`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/x-git-upload-pack-request' },
      body: 'zzzznot-a-pkt-line',
    });
    assert.ok(malformed.status >= 400);
    const healthy = await api.get('/adaiversen/git-survive.git/info/refs?service=git-upload-pack', { token: false });
    assert.equal(healthy.status, 200);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------- GraphQL v4

async function graphql(base, query, variables) {
  const response = await fetch(`${base}/api/graphql`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables: variables ?? {} }),
  });
  return { status: response.status, json: await response.json() };
}

test('graphql: viewer, repository fields and introspection', async () => {
  const server = await boot();
  const api = client(server.base);
  try {
    const repoPath = await makeRepo(api, 'graphql-repo');
    await seedFile(api, repoPath, 'readme.md', '# hello\n');

    const viewer = await graphql(server.base, 'query { viewer { login } }');
    assert.equal(viewer.status, 200);
    assert.equal(viewer.json.data.viewer.login, OWNER);

    const repository = await graphql(
      server.base,
      'query RepositoryFields($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id databaseId name nameWithOwner defaultBranchRef { name } viewerPermission hasIssuesEnabled } }',
      { owner: OWNER, name: 'graphql-repo' },
    );
    assert.equal(repository.json.data.repository.name, 'graphql-repo');
    assert.equal(repository.json.data.repository.nameWithOwner, `${OWNER}/graphql-repo`);
    assert.equal(repository.json.data.repository.defaultBranchRef.name, 'main');
    assert.equal(repository.json.data.repository.hasIssuesEnabled, true);
    assert.notEqual(String(repository.json.data.repository.id), String(repository.json.data.repository.databaseId));

    const introspection = await graphql(server.base, 'query { Issue: __type(name: "Issue") { fields { name } } }');
    const names = introspection.json.data.Issue.fields.map((field) => field.name);
    for (const required of ['id', 'number', 'title', 'state', 'body']) assert.ok(names.includes(required), required);

    const invalid = await graphql(server.base, 'query { viewer { login noSuchFieldOnViewer } }');
    assert.equal(invalid.status, 200);
    assert.ok(invalid.json.errors.some((error) => error.message.includes('noSuchFieldOnViewer')));

    const anonymous = await fetch(`${server.base}/api/graphql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ viewer { login } }' }) });
    assert.equal(anonymous.status, 401);
  } finally {
    await server.close();
  }
});

test('graphql: createIssue, closeIssue, ordering and cursor pagination', async () => {
  const server = await boot();
  const api = client(server.base);
  try {
    const repoPath = await makeRepo(api, 'graphql-issues');
    const repo = await graphql(server.base, 'query ($o: String!, $n: String!) { repository(owner: $o, name: $n) { id } }', { o: OWNER, n: 'graphql-issues' });
    const repositoryId = repo.json.data.repository.id;

    for (let index = 1; index <= 7; index += 1) {
      await api.post(`${repoPath}/issues`, { title: `issue ${index}`, body: 'body' });
    }
    const created = await graphql(
      server.base,
      'mutation ($input: CreateIssueInput!) { createIssue(input: $input) { issue { number id state } } }',
      { input: { repositoryId, title: 'from graphql', body: 'body' } },
    );
    assert.equal(created.json.data.createIssue.issue.state, 'OPEN');
    const number = created.json.data.createIssue.issue.number;
    const restRead = await api.get(`${repoPath}/issues/${number}`);
    assert.equal(restRead.json.title, 'from graphql');

    const closed = await graphql(server.base, 'mutation ($input: CloseIssueInput!) { closeIssue(input: $input) { issue { number state } } }', {
      input: { issueId: created.json.data.createIssue.issue.id },
    });
    assert.equal(closed.json.data.closeIssue.issue.state, 'CLOSED');
    assert.equal((await api.get(`${repoPath}/issues/${number}`)).json.state, 'closed');

    const ordered = await graphql(
      server.base,
      'query ($o: String!, $n: String!) { repository(owner: $o, name: $n) { issues(first: 10, states: [OPEN], orderBy: {field: CREATED_AT, direction: DESC}) { nodes { number state } } } }',
      { o: OWNER, n: 'graphql-issues' },
    );
    const numbers = ordered.json.data.repository.issues.nodes.map((node) => node.number);
    assert.deepEqual(numbers, [7, 6, 5, 4, 3, 2, 1]);
    assert.ok(ordered.json.data.repository.issues.nodes.every((node) => node.state === 'OPEN'));

    const firstPage = await graphql(
      server.base,
      'query ($o: String!, $n: String!, $first: Int!, $after: String) { repository(owner: $o, name: $n) { issues(first: $first, after: $after) { nodes { number } pageInfo { hasNextPage endCursor } } } }',
      { o: OWNER, n: 'graphql-issues', first: 5, after: null },
    );
    assert.equal(firstPage.json.data.repository.issues.nodes.length, 5);
    assert.equal(firstPage.json.data.repository.issues.pageInfo.hasNextPage, true);
    const secondPage = await graphql(
      server.base,
      'query ($o: String!, $n: String!, $first: Int!, $after: String) { repository(owner: $o, name: $n) { issues(first: $first, after: $after) { nodes { number } pageInfo { hasNextPage } } } }',
      { o: OWNER, n: 'graphql-issues', first: 5, after: firstPage.json.data.repository.issues.pageInfo.endCursor },
    );
    assert.equal(secondPage.json.data.repository.issues.nodes.length, 3);
    assert.equal(secondPage.json.data.repository.issues.pageInfo.hasNextPage, false);
  } finally {
    await server.close();
  }
});

test('graphql: two operations in one body answer in order', async () => {
  const server = await boot();
  try {
    const response = await fetch(`${server.base}/api/graphql`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify([{ query: '{ viewer { login } }' }, { query: '{ SearchType: __type(name: "SearchType") { enumValues { name } } }' }]),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.length, 2);
    assert.equal(body[0].data.viewer.login, OWNER);
    assert.ok(body[1].data.SearchType.enumValues.some((value) => value.name === 'ISSUE'));
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------- MCP

async function mcp(base, message, token = true) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (token) headers.authorization = `Bearer ${TOKEN}`;
  const response = await fetch(`${base}/mcp`, { method: 'POST', headers, body: typeof message === 'string' ? message : JSON.stringify(message) });
  const text = await response.text();
  let json = null;
  try {
    json = text === '' ? null : JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

test('mcp: discover, tools/list, tools/call and their REST effect', async () => {
  const server = await boot();
  const api = client(server.base);
  try {
    const discover = await mcp(server.base, { jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} });
    assert.equal(discover.status, 200);
    assert.equal(discover.json.result.serverInfo.name, 'github-core-clone-forge');
    assert.ok(discover.json.result.supportedVersions.includes('2026-07-28'));

    const listed = await mcp(server.base, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const tools = listed.json.result.tools;
    assert.ok(tools.length >= 6);
    for (const name of ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request']) {
      assert.ok(tools.some((tool) => tool.name === name), name);
    }
    assert.ok(tools.every((tool) => typeof tool.description === 'string' && tool.description !== '' && tool.inputSchema.type === 'object'));

    const secondList = await mcp(server.base, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
    assert.deepEqual(secondList.json.result.tools, tools);

    const created = await mcp(server.base, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'create_repo', arguments: { name: 'mcp-repo' } } });
    assert.equal(created.json.result.isError, false);
    const repoPath = `/api/v3/repos/${OWNER}/mcp-repo`;
    assert.equal((await api.get(repoPath)).status, 200);

    const issue = await mcp(server.base, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'create_issue', arguments: { owner: OWNER, repo: 'mcp-repo', title: 'over mcp', body: 'body' } },
    });
    assert.equal(issue.json.result.isError, false);
    const listedIssues = await api.get(`${repoPath}/issues?state=all`);
    assert.equal(listedIssues.json[0].title, 'over mcp');

    const unknown = await mcp(server.base, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } });
    assert.equal(unknown.json.error.code, -32602);

    const missing = await mcp(server.base, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'create_issue', arguments: {} } });
    assert.equal(missing.json.error.code, -32602);

    const parseError = await mcp(server.base, '{"jsonrpc": "2.0", "id": 424242, "method": "tools/list"');
    assert.equal(parseError.status, 400);
    assert.equal(parseError.json.error.code, -32700);

    const unauthenticated = await mcp(server.base, { jsonrpc: '2.0', id: 8, method: 'tools/list', params: {} }, false);
    assert.equal(unauthenticated.status, 401);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------- determinism

test('two runs of the same request sequence leave the same bytes', async () => {
  const run = async () => {
    const server = await boot();
    const api = client(server.base);
    try {
      const repoPath = await makeRepo(api, 'determinism');
      await seedFile(api, repoPath, 'a.txt', 'alpha\n');
      const issue = await api.post(`${repoPath}/issues`, { title: 'one', body: 'body' });
      const repo = await api.get(repoPath);
      return JSON.stringify({ issue: issue.json, repo: repo.json });
    } finally {
      await server.close();
    }
  };
  assert.equal(await run(), await run());
});
