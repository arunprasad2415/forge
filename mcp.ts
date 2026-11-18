// mcp.ts: the Model Context Protocol endpoint, JSON-RPC 2.0 over streamable HTTP.
//
// The suite speaks the 2026-07-28 revision: no handshake, every request declaring its revision
// in _meta, and server/discover answering the server's identity, capabilities and the revisions
// it supports. The initialize handshake of the earlier revisions is answered too, so a client
// that predates server/discover still connects.
//
// The tools act on the same store as REST, which is what the parity checks read back.

import { globalId } from './store.ts';

export const PREFERRED_REVISION = '2026-07-28';
export const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'github-core-clone-forge', version: '1.0.0' };

/** One tool: its schema and the store call behind it. */
const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user and return it.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'owner/repo, when the caller sends it that way.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Open an issue on a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Label names.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List a repository\'s issues, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Which issues to list.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch.' },
        base: { type: 'string', description: 'The base branch.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
        merge_method: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'How to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'get_pull_request',
    description: 'Read one pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List a repository\'s pull requests.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Which pull requests to list.' },
      },
      required: ['owner', 'repo'],
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

/** A tools/call result carrying one JSON object. */
function toolResult(payload, text) {
  return {
    content: [{ type: 'text', text: text ?? JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: false,
  };
}

function toolFailure(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Split owner/repo when a caller sends only full_name. */
function ownerRepo(args) {
  if (typeof args.owner === 'string' && typeof args.repo === 'string') return { owner: args.owner, repo: args.repo };
  if (typeof args.full_name === 'string' && args.full_name.includes('/')) {
    const [owner, ...rest] = args.full_name.split('/');
    return { owner, repo: rest.join('/') };
  }
  return { owner: args.owner, repo: args.repo };
}

/** The reply to one tools/call. */
function callTool(store, login, name, args) {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) return { error: { code: -32602, message: `Unknown tool: ${name}` } };
  const missing = (tool.inputSchema.required ?? []).filter((key) => args[key] === undefined || args[key] === null);
  if (missing.length > 0) return { error: { code: -32602, message: `Missing required argument: ${missing.join(', ')}` } };
  const target = ownerRepo(args);
  try {
    if (name === 'create_repo') {
      const repo = store.createRepo(login, String(args.name), { description: typeof args.description === 'string' ? args.description : '', private: args.private === true });
      return { result: toolResult({ id: repo.id, name: repo.name, full_name: repo.fullName, owner: repo.owner, private: repo.private, default_branch: repo.defaultBranch, description: repo.description }) };
    }
    if (name === 'get_repo') {
      const repo = store.getRepo(target.owner, target.repo);
      if (!repo) return { result: toolFailure(`Repository ${target.owner}/${target.repo} not found`) };
      return { result: toolResult({ id: repo.id, name: repo.name, full_name: repo.fullName, owner: repo.owner, private: repo.private, default_branch: repo.defaultBranch, description: repo.description }) };
    }
    if (name === 'create_issue') {
      const repo = store.getRepo(target.owner, target.repo);
      if (!repo) return { result: toolFailure(`Repository ${target.owner}/${target.repo} not found`) };
      const issue = store.createIssue(repo, { title: String(args.title), body: typeof args.body === 'string' ? args.body : '', labels: args.labels, author: login });
      return { result: toolResult({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state, labels: issue.labels.map((label) => label.name), created_at: issue.created_at, repository: repo.fullName }) };
    }
    if (name === 'list_issues') {
      const repo = store.getRepo(target.owner, target.repo);
      if (!repo) return { result: toolFailure(`Repository ${target.owner}/${target.repo} not found`) };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = store.listIssues(repo, { state, direction: 'asc' });
      return { result: toolResult({ total: issues.length, issues: issues.map((issue) => ({ id: issue.id, number: issue.number, title: issue.title, state: issue.state })) }) };
    }
    if (name === 'create_pull_request') {
      const repo = store.getRepo(target.owner, target.repo);
      if (!repo) return { result: toolFailure(`Repository ${target.owner}/${target.repo} not found`) };
      const pull = store.createPull(repo, { title: String(args.title), body: typeof args.body === 'string' ? args.body : '', head: String(args.head), base: String(args.base ?? repo.defaultBranch) });
      return { result: toolResult({ id: pull.id, number: pull.number, pull_number: pull.number, title: pull.title, state: pull.state, head: pull.head, base: pull.base, head_sha: pull.headSha, base_sha: pull.baseSha }) };
    }
    if (name === 'merge_pull_request') {
      const repo = store.getRepo(target.owner, target.repo);
      if (!repo) return { result: toolFailure(`Repository ${target.owner}/${target.repo} not found`) };
      const pull = store.findPull(repo, Number(args.pull_number));
      const merged = store.mergePull(repo, pull);
      return { result: toolResult({ number: pull.number, merged: true, sha: merged.commit, message: merged.message }) };
    }
    if (name === 'get_pull_request') {
      const repo = store.getRepo(target.owner, target.repo);
      if (!repo) return { result: toolFailure(`Repository ${target.owner}/${target.repo} not found`) };
      const pull = store.findPull(repo, Number(args.pull_number));
      return { result: toolResult({ number: pull.number, title: pull.title, state: pull.state, merged: pull.merged, head: pull.head, base: pull.base }) };
    }
    if (name === 'list_pull_requests') {
      const repo = store.getRepo(target.owner, target.repo);
      if (!repo) return { result: toolFailure(`Repository ${target.owner}/${target.repo} not found`) };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const pulls = store.listPulls(repo, { state });
      return { result: toolResult({ total: pulls.length, pull_requests: pulls.map((pull) => ({ number: pull.number, title: pull.title, state: pull.state, head: pull.head, base: pull.base })) }) };
    }
  } catch (err) {
    return { result: toolFailure(err instanceof Error ? err.message : 'tool failed') };
  }
  return { error: { code: -32602, message: `Unknown tool: ${name}` } };
}

/** Handle one JSON-RPC message; answers the reply object, or null for a notification. */
function handleMessage(store, login, message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const id = message.id === undefined ? null : message.id;
  const isNotification = message.id === undefined;
  const method = typeof message.method === 'string' ? message.method : '';
  const params = message.params && typeof message.params === 'object' ? message.params : {};
  const reply = (result) => (isNotification ? null : { jsonrpc: '2.0', id, result });
  const fail = (code, text) => (isNotification ? null : { jsonrpc: '2.0', id, error: { code, message: text } });

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : PREFERRED_REVISION;
    const version = SUPPORTED_VERSIONS.includes(requested) ? requested : PREFERRED_REVISION;
    return reply({ protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: 'A GitHub-compatible forge: repositories, issues, pull requests and git over smart HTTP.' });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled' || method === 'notifications/roots/list_changed') return null;
  if (method === 'server/discover') {
    return reply({
      resultType: 'complete',
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: 'A GitHub-compatible forge: repositories, issues, pull requests and git over smart HTTP.',
    });
  }
  if (method === 'ping') return reply({});
  if (method === 'tools/list') return reply({ tools: TOOLS });
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    const outcome = callTool(store, login, name, args);
    if (outcome.error) return fail(outcome.error.code, outcome.error.message);
    return reply(outcome.result);
  }
  if (method === 'resources/list') return reply({ resources: [] });
  if (method === 'prompts/list') return reply({ prompts: [] });
  return fail(-32601, `Method not found: ${method}`);
}

/**
 * Handle one POST /mcp. `body` is the raw text; answers {status, body} where body is JSON.
 */
export function handleMcp(store, login, raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (Array.isArray(parsed)) {
    const answers = [];
    for (const message of parsed) {
      const answer = handleMessage(store, login, message);
      if (answer) answers.push(answer);
    }
    if (answers.length === 0) return { status: 202, body: null };
    return { status: 200, body: answers };
  }
  const answer = handleMessage(store, login, parsed);
  if (answer === null) return { status: 202, body: null };
  return { status: 200, body: answer };
}

export { globalId };
