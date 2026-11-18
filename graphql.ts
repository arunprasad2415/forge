// graphql.ts: the GitHub GraphQL v4 surface, for the documents gh and github-mcp-server send.
//
// A hand-written parser (no dependency) turns the document into operations, then an executor
// walks each selection set against the store. Introspection answers from the same schema table
// the executor validates against, so a field the schema does not hold is a 200 with an errors
// array naming it, exactly as GitHub answers one.

import { HttpError, globalId, parseGlobalId } from './store.ts';

// ---------------------------------------------------------------- the schema

const SCHEMA = {
  User: ['id', 'login', 'name', 'email', 'avatarUrl', 'databaseId'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closed', 'closedAt', 'author', 'labels', 'comments', 'repository'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'mergedAt', 'createdAt', 'updatedAt', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'mergeCommit', 'files', 'comments', 'author', 'isDraft'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changes', 'status'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'url'],
  Ref: ['name', 'target'],
  Label: ['id', 'name', 'color', 'description'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
};

const ENUMS = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  MergeStateStatus: ['BEHIND', 'BLOCKED', 'CLEAN', 'DIRTY', 'DRAFT', 'HAS_HOOKS', 'UNKNOWN', 'UNSTABLE'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
};

// ---------------------------------------------------------------- tokenizer

const PUNCTUATORS = ['{', '}', '(', ')', '[', ']', ':', ',', '!', '=', '|', '&', '@', '$'];

function tokenize(source) {
  const tokens = [];
  let pos = 0;
  while (pos < source.length) {
    const char = source[pos];
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ',') {
      pos += 1;
      continue;
    }
    if (char === '#') {
      while (pos < source.length && source[pos] !== '\n') pos += 1;
      continue;
    }
    if (char === '"') {
      let end = pos + 1;
      let value = '';
      while (end < source.length && source[end] !== '"') {
        if (source[end] === '\\') {
          const next = source[end + 1];
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
          end += 2;
          continue;
        }
        value += source[end];
        end += 1;
      }
      tokens.push({ kind: 'string', value });
      pos = end + 1;
      continue;
    }
    if (source.startsWith('...', pos)) {
      tokens.push({ kind: 'punct', value: '...' });
      pos += 3;
      continue;
    }
    if (PUNCTUATORS.includes(char)) {
      tokens.push({ kind: 'punct', value: char });
      pos += 1;
      continue;
    }
    if (/[0-9]/.test(char) || (char === '-' && /[0-9]/.test(source[pos + 1] ?? ''))) {
      let end = pos + 1;
      while (end < source.length && /[0-9.eE+-]/.test(source[end])) end += 1;
      tokens.push({ kind: 'number', value: Number(source.slice(pos, end)) });
      pos = end;
      continue;
    }
    if (/[_A-Za-z]/.test(char)) {
      let end = pos + 1;
      while (end < source.length && /[_0-9A-Za-z]/.test(source[end])) end += 1;
      tokens.push({ kind: 'name', value: source.slice(pos, end) });
      pos = end;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(char)}`);
  }
  return tokens;
}

// ---------------------------------------------------------------- parser

class Parser {
  constructor(source) {
    this.tokens = tokenize(source);
    this.index = 0;
  }

  peek(offset = 0) {
    return this.tokens[this.index + offset] ?? null;
  }

  next() {
    const token = this.tokens[this.index];
    this.index += 1;
    return token;
  }

  isPunct(value, offset = 0) {
    const token = this.peek(offset);
    return token !== null && token.kind === 'punct' && token.value === value;
  }

  isName(value, offset = 0) {
    const token = this.peek(offset);
    return token !== null && token.kind === 'name' && token.value === value;
  }

  expectPunct(value) {
    const token = this.next();
    if (!token || token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
    return token;
  }

  expectName() {
    const token = this.next();
    if (!token || token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument() {
    const operations = [];
    const fragments = new Map();
    while (this.index < this.tokens.length) {
      if (this.isPunct('{')) {
        operations.push({ type: 'query', name: null, variables: {}, selections: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'fragment') {
        const name = this.expectName();
        this.expectName();
        fragments.set(name, this.parseSelectionSet());
        continue;
      }
      if (keyword !== 'query' && keyword !== 'mutation' && keyword !== 'subscription') throw new Error(`unknown operation ${keyword}`);
      let name = null;
      if (this.peek() && this.peek().kind === 'name') name = this.expectName();
      let variables = {};
      if (this.isPunct('(')) variables = this.parseVariableDefinitions();
      this.skipDirectives();
      operations.push({ type: keyword, name, variables, selections: this.parseSelectionSet() });
    }
    return { operations, fragments };
  }

  parseVariableDefinitions() {
    this.expectPunct('(');
    const definitions = {};
    while (!this.isPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      const type = this.parseType();
      let defaultValue;
      if (this.isPunct('=')) {
        this.next();
        defaultValue = this.parseValue();
      }
      definitions[name] = { type, defaultValue };
    }
    this.expectPunct(')');
    return definitions;
  }

  parseType() {
    let type = '';
    if (this.isPunct('[')) {
      this.next();
      type = `[${this.parseType()}]`;
      this.expectPunct(']');
    } else {
      type = this.expectName();
    }
    if (this.isPunct('!')) {
      this.next();
      type += '!';
    }
    return type;
  }

  parseSelectionSet() {
    this.expectPunct('{');
    const selections = [];
    while (!this.isPunct('}')) {
      if (this.isPunct('...')) {
        this.next();
        if (this.isName('on')) {
          this.next();
          const on = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'inline', on, selections: this.parseSelectionSet() });
          continue;
        }
        const name = this.expectName();
        this.skipDirectives();
        selections.push({ kind: 'spread', name });
        continue;
      }
      selections.push(this.parseField());
    }
    this.expectPunct('}');
    return selections;
  }

  parseField() {
    let name = this.expectName();
    let alias = null;
    if (this.isPunct(':')) {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args = this.isPunct('(') ? this.parseArguments() : {};
    this.skipDirectives();
    const selections = this.isPunct('{') ? this.parseSelectionSet() : null;
    return { kind: 'field', name, alias, args, selections };
  }

  parseArguments() {
    this.expectPunct('(');
    const args = {};
    while (!this.isPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  parseValue() {
    const token = this.peek();
    if (!token) throw new Error('unexpected end of document');
    if (token.kind === 'punct' && token.value === '$') {
      this.next();
      return { variable: this.expectName() };
    }
    if (token.kind === 'string' || token.kind === 'number') {
      this.next();
      return token.value;
    }
    if (token.kind === 'punct' && token.value === '[') {
      this.next();
      const list = [];
      while (!this.isPunct(']')) list.push(this.parseValue());
      this.expectPunct(']');
      return list;
    }
    if (token.kind === 'punct' && token.value === '{') {
      this.next();
      const object = {};
      while (!this.isPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        object[name] = this.parseValue();
      }
      this.expectPunct('}');
      return object;
    }
    if (token.kind === 'name') {
      this.next();
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return { enum: token.value };
    }
    throw new Error(`unexpected token ${JSON.stringify(token.value)}`);
  }

  skipDirectives() {
    while (this.isPunct('@')) {
      this.next();
      this.expectName();
      if (this.isPunct('(')) this.parseArguments();
    }
  }
}

/** Resolve {variable}, {enum} and nested lists/objects inside an argument value. */
function resolveValue(value, variables) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, variables));
  if (typeof value === 'object') {
    if (typeof value.variable === 'string') return variables[value.variable] ?? null;
    if (typeof value.enum === 'string') return value.enum;
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = resolveValue(item, variables);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------- execution

/** The fields of the small helper types the executor builds on the fly. */
const GENERIC_FIELDS = {
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  Edge: ['node', 'cursor'],
  TypeInfo: ['name', 'kind', 'fields', 'enumValues', 'inputFields', 'description'],
  FieldInfo: ['name', 'type', 'args', 'description'],
  EnumValueInfo: ['name', 'description'],
  Commit: ['oid', 'id', 'abbreviatedOid', 'message', 'committedDate'],
  Schema: ['types', 'queryType', 'mutationType'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
};

/** Whether `type` holds a field named `name`: the schema, a connection's four, or a helper type. */
function knownField(type, name) {
  if (SCHEMA[type] && SCHEMA[type].includes(name)) return true;
  if (type.endsWith('Connection')) return ['nodes', 'edges', 'pageInfo', 'totalCount'].includes(name);
  const generic = GENERIC_FIELDS[type];
  return Boolean(generic && generic.includes(name));
}

class Execution {
  constructor(store, login) {
    this.store = store;
    this.login = login;
    this.errors = [];
  }

  error(message, path) {
    this.errors.push({ message, path, locations: [{ line: 1, column: 1 }] });
  }

  /** Run one operation document against the store. */
  run(document, variables) {
    const parsed = new Parser(document).parseDocument();
    const operation = parsed.operations[0];
    if (!operation) throw new Error('the document holds no operation');
    const merged = {};
    for (const [name, definition] of Object.entries(operation.variables)) {
      merged[name] = variables[name] !== undefined ? variables[name] : definition.defaultValue !== undefined ? resolveValue(definition.defaultValue, variables) : null;
    }
    const root = { __type: 'Query', operation: operation.type };
    const data = this.selectionSet(root, operation.selections, merged, [], parsed.fragments);
    return { data, errors: this.errors.length > 0 ? this.errors : undefined };
  }

  /** Execute a selection set against `node`. */
  selectionSet(node, selections, variables, path, fragments) {
    const out = {};
    for (const selection of selections) {
      if (selection.kind === 'inline') {
        if (node !== null && node.__type === selection.on) Object.assign(out, this.selectionSet(node, selection.selections, variables, path, fragments));
        else if (node !== null && selection.on === 'Node') Object.assign(out, this.selectionSet(node, selection.selections, variables, path, fragments));
        continue;
      }
      if (selection.kind === 'spread') {
        const fragment = fragments.get(selection.name);
        if (fragment) Object.assign(out, this.selectionSet(node, fragment, variables, path, fragments));
        continue;
      }
      const key = selection.alias ?? selection.name;
      const args = {};
      for (const [name, value] of Object.entries(selection.args ?? {})) args[name] = resolveValue(value, variables);
      const type = node === null || node === undefined ? 'Query' : node.__type;
      if (type === 'Query' || type === 'Mutation') {
        const resolved = this.rootField(node, selection.name, args, path);
        out[key] = this.finish(resolved, selection, variables, [...path, key], fragments, type);
        continue;
      }
      if (!knownField(type, selection.name)) {
        this.error(`Field '${selection.name}' doesn't exist on type '${type}'`, [...path, key]);
        out[key] = null;
        continue;
      }
      const resolved = this.field(node, selection.name, args, path);
      out[key] = this.finish(resolved, selection, variables, [...path, key], fragments, type);
    }
    return out;
  }

  /** Wrap a resolved value into the reply, recursing when the selection asks for children. */
  finish(value, selection, variables, path, fragments, parentType) {
    if (value === undefined) value = null;
    if (Array.isArray(value)) {
      return value.map((item, index) => this.finish(item, selection, variables, [...path, index], fragments, parentType));
    }
    if (value === null) return null;
    if (typeof value === 'object') {
      if (value.__type && selection.selections) return this.selectionSet(value, selection.selections, variables, path, fragments);
      if (value.__type && !selection.selections) {
        this.error(`Field '${selection.name}' of type '${value.__type}' must have a selection of subfields`, path);
        return null;
      }
      return value;
    }
    if (selection.selections) {
      this.error(`Field '${selection.name}' must not have a selection since type 'String' has no subfields`, path);
      return null;
    }
    return value;
  }

  /** The Query and Mutation root fields. */
  rootField(node, name, args, path) {
    if (node.operation === 'mutation') return this.mutationField(name, args, path);
    if (name === '__typename') return 'Query';
    if (name === 'viewer') return { __type: 'User', login: this.login, id: globalId('User', 1000), name: this.login, email: `${this.login}@example.invalid`, databaseId: 1000, avatarUrl: '' };
    if (name === '__schema') return { __type: 'Schema', types: [] };
    if (name === '__type') {
      const typeName = args.name;
      if (!SCHEMA[typeName] && !ENUMS[typeName]) return null;
      return {
        __type: 'TypeInfo',
        kind: ENUMS[typeName] ? 'ENUM' : 'OBJECT',
        name: typeName,
        fields: SCHEMA[typeName] ? SCHEMA[typeName].map((field) => ({ __type: 'FieldInfo', name: field })) : null,
        enumValues: ENUMS[typeName] ? ENUMS[typeName].map((value) => ({ __type: 'EnumValueInfo', name: value })) : null,
      };
    }
    if (name === 'repository') {
      const repo = this.store.getRepo(args.owner, args.name);
      return repo ? { __type: 'Repository', repo } : null;
    }
    if (name === 'node') {
      const parsed = parseGlobalId(args.id);
      if (!parsed) return null;
      if (parsed.kind === 'Repository') {
        const repo = this.store.repoById.get(parsed.id);
        return repo ? { __type: 'Repository', repo } : null;
      }
      if (parsed.kind === 'Issue' || parsed.kind === 'PullRequest') {
        for (const repo of this.store.repos.values()) {
          if (parsed.kind === 'Issue') {
            const issue = repo.issues.find((candidate) => candidate.id === parsed.id);
            if (issue) return { __type: 'Issue', repo, issue };
          } else {
            const pull = repo.pulls.find((candidate) => candidate.id === parsed.id);
            if (pull) return { __type: 'PullRequest', repo, pull };
          }
        }
      }
      return null;
    }
    if (name === 'search') {
      return { __type: 'IssueConnection', nodes: [], pageInfo: pageInfo(false, null, null), totalCount: 0 };
    }
    this.error(`Field '${name}' doesn't exist on type 'Query'`, path);
    return null;
  }

  /** The mutation fields gh sends. */
  mutationField(name, args, path) {
    const input = args.input ?? {};
    if (name === 'createIssue') {
      const repo = this.repoByGlobalId(input.repositoryId);
      if (!repo) throw new HttpError(200, 'Could not resolve to a Repository with the global id');
      const issue = this.store.createIssue(repo, { title: input.title, body: input.body, labels: input.labelIds, author: this.login });
      return { __type: 'CreateIssuePayload', issue: { __type: 'Issue', repo, issue }, clientMutationId: input.clientMutationId ?? null };
    }
    if (name === 'closeIssue') {
      const parsed = parseGlobalId(input.issueId);
      const found = parsed ? this.findIssueById(parsed.id) : null;
      if (!found) throw new HttpError(200, 'Could not resolve to an Issue with the global id');
      this.store.updateIssue(found.repo, found.issue.number, { state: 'closed' });
      return { __type: 'CloseIssuePayload', issue: { __type: 'Issue', repo: found.repo, issue: found.issue }, clientMutationId: input.clientMutationId ?? null };
    }
    if (name === 'createPullRequest') {
      const repo = this.repoByGlobalId(input.repositoryId);
      if (!repo) throw new HttpError(200, 'Could not resolve to a Repository with the global id');
      const pull = this.store.createPull(repo, { title: input.title, body: input.body, head: input.headRefName, base: input.baseRefName });
      return { __type: 'CreatePullRequestPayload', pullRequest: { __type: 'PullRequest', repo, pull }, clientMutationId: input.clientMutationId ?? null };
    }
    if (name === 'mergePullRequest') {
      const parsed = parseGlobalId(input.pullRequestId);
      const found = parsed ? this.findPullById(parsed.id) : null;
      if (!found) throw new HttpError(200, 'Could not resolve to a PullRequest with the global id');
      this.store.mergePull(found.repo, found.pull);
      return { __type: 'MergePullRequestPayload', pullRequest: { __type: 'PullRequest', repo: found.repo, pull: found.pull }, clientMutationId: input.clientMutationId ?? null };
    }
    if (name === 'addComment') {
      const parsed = parseGlobalId(input.subjectId);
      const found = parsed ? this.findIssueById(parsed.id) : null;
      if (!found) throw new HttpError(200, 'Could not resolve to an Issue with the global id');
      const comment = this.store.addComment(found.repo, found.issue.number, input.body);
      return {
        __type: 'AddCommentPayload',
        commentEdge: { __type: 'IssueCommentEdge', node: { __type: 'IssueComment', comment, repo: found.repo }, cursor: 'edge' },
        clientMutationId: input.clientMutationId ?? null,
      };
    }
    this.error(`Field '${name}' doesn't exist on type 'Mutation'`, path);
    return null;
  }

  repoByGlobalId(id) {
    const parsed = parseGlobalId(id);
    if (!parsed || parsed.kind !== 'Repository') return null;
    return this.store.repoById.get(parsed.id) ?? null;
  }

  findIssueById(id) {
    for (const repo of this.store.repos.values()) {
      const issue = repo.issues.find((candidate) => candidate.id === id);
      if (issue) return { repo, issue };
    }
    return null;
  }

  findPullById(id) {
    for (const repo of this.store.repos.values()) {
      const pull = repo.pulls.find((candidate) => candidate.id === id);
      if (pull) return { repo, pull };
    }
    return null;
  }

  /** One field of a typed node. */
  field(node, name, args) {
    const type = node.__type;
    if (type === 'User') {
      if (name === 'login') return node.login;
      if (name === 'id') return node.id;
      if (name === 'name') return node.name;
      if (name === 'email') return node.email;
      if (name === 'databaseId') return node.databaseId;
      if (name === 'avatarUrl') return node.avatarUrl ?? '';
    }
    if (type === 'TypeInfo') {
      if (name === 'name') return node.name;
      if (name === 'kind') return node.kind;
      if (name === 'fields') return node.fields;
      if (name === 'enumValues') return node.enumValues;
      if (name === 'inputFields') return null;
    }
    if (type === 'FieldInfo' || type === 'EnumValueInfo') {
      if (name === 'name') return node.name;
    }
    if (type === 'Repository') return this.repositoryField(node.repo, name, args);
    if (type === 'CreateIssuePayload' || type === 'CloseIssuePayload') {
      if (name === 'issue') return node.issue ?? null;
      if (name === 'clientMutationId') return node.clientMutationId ?? null;
    }
    if (type === 'CreatePullRequestPayload' || type === 'MergePullRequestPayload') {
      if (name === 'pullRequest') return node.pullRequest ?? null;
      if (name === 'clientMutationId') return node.clientMutationId ?? null;
    }
    if (type === 'AddCommentPayload') {
      if (name === 'commentEdge') return node.commentEdge ?? null;
      if (name === 'clientMutationId') return node.clientMutationId ?? null;
    }
    if (type === 'IssueCommentEdge') {
      if (name === 'node') return node.node ?? null;
      if (name === 'cursor') return node.cursor ?? null;
    }
    if (type === 'Ref') {
      if (name === 'name') return node.name;
      if (name === 'target') return { __type: 'Commit', oid: node.oid };
    }
    if (type === 'Commit') {
      if (name === 'oid') return node.oid;
      if (name === 'id') return globalId('Commit', node.oid.slice(0, 12));
      if (name === 'abbreviatedOid') return node.oid.slice(0, 7);
    }
    if (type === 'Issue') return this.issueField(node, name, args);
    if (type === 'IssueComment') {
      if (name === 'id') return globalId('IssueComment', node.comment.id);
      if (name === 'body') return node.comment.body;
      if (name === 'createdAt') return node.comment.created_at;
      if (name === 'author') return { __type: 'User', login: node.comment.user, id: globalId('User', 1000) };
    }
    if (type === 'Label') {
      if (name === 'name') return node.label.name;
      if (name === 'color') return node.label.color;
      if (name === 'description') return node.label.description ?? '';
      if (name === 'id') return globalId('Label', node.label.name);
    }
    if (type === 'PullRequest') return this.pullField(node, name, args);
    if (type === 'PullRequestFile') {
      if (name === 'path') return node.file.filename;
      if (name === 'additions') return node.file.additions;
      if (name === 'deletions') return node.file.deletions;
      if (name === 'changes') return node.file.changes;
      if (name === 'status') return String(node.file.status).toUpperCase();
    }
    if (type === 'PageInfo') {
      if (name === 'hasNextPage') return node.hasNextPage;
      if (name === 'hasPreviousPage') return node.hasPreviousPage ?? false;
      if (name === 'endCursor') return node.endCursor;
      if (name === 'startCursor') return node.startCursor ?? null;
    }
    if (type.endsWith('Connection')) {
      if (name === 'nodes') return node.nodes;
      if (name === 'totalCount') return node.totalCount ?? node.nodes.length;
      if (name === 'pageInfo') return node.pageInfo;
      if (name === 'edges') return node.nodes.map((child, index) => ({ __type: 'Edge', node: child, cursor: `edge-${index}` }));
    }
    if (type === 'Edge') {
      if (name === 'node') return node.node;
      if (name === 'cursor') return node.cursor;
    }
    return null;
  }

  repositoryField(repo, name, args) {
    if (name === 'id') return globalId('Repository', repo.id);
    if (name === 'databaseId') return repo.id;
    if (name === 'name') return repo.name;
    if (name === 'nameWithOwner') return repo.fullName;
    if (name === 'description') return repo.description;
    if (name === 'isPrivate') return repo.private;
    if (name === 'createdAt') return repo.createdAt;
    if (name === 'url') return `https://github.com/${repo.fullName}`;
    if (name === 'owner') return { __type: 'User', login: repo.owner, id: globalId('User', 1000) };
    if (name === 'viewerPermission') return 'ADMIN';
    if (name === 'hasIssuesEnabled') return true;
    if (name === 'defaultBranchRef') {
      const oid = repo.headOid();
      if (!oid) return null;
      return { __type: 'Ref', name: repo.defaultBranch, oid };
    }
    if (name === 'issue') {
      const issue = repo.issues.find((candidate) => candidate.number === Number(args.number));
      return issue ? { __type: 'Issue', repo, issue } : null;
    }
    if (name === 'issues') return this.issueConnection(repo, args);
    if (name === 'pullRequest') {
      const pull = repo.pulls.find((candidate) => candidate.number === Number(args.number));
      return pull ? { __type: 'PullRequest', repo, pull } : null;
    }
    if (name === 'pullRequests') {
      let pulls = [...repo.pulls];
      const states = Array.isArray(args.states) ? args.states : null;
      if (states) pulls = pulls.filter((pull) => states.includes(pullState(pull)));
      pulls.sort((a, b) => b.number - a.number);
      const first = Number.isFinite(args.first) ? args.first : pulls.length;
      const nodes = pulls.slice(0, first).map((pull) => ({ __type: 'PullRequest', repo, pull }));
      return { __type: 'PullRequestConnection', nodes, pageInfo: pageInfo(pulls.length > nodes.length, nodes.length > 0 ? `cursor-${pulls[nodes.length - 1].number}` : null, null), totalCount: pulls.length };
    }
    return null;
  }

  /** issues(first, after, states, orderBy) as a cursor connection. */
  issueConnection(repo, args) {
    let issues = [...repo.issues];
    const states = Array.isArray(args.states) ? args.states : null;
    if (states) issues = issues.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
    const orderBy = args.orderBy ?? {};
    const direction = orderBy.direction === 'ASC' ? 'asc' : 'desc';
    issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
    let start = 0;
    if (typeof args.after === 'string' && args.after !== '') {
      const decoded = decodeCursor(args.after);
      const index = issues.findIndex((issue) => issue.number === decoded);
      start = index < 0 ? issues.length : index + 1;
    }
    const first = Number.isFinite(args.first) ? args.first : issues.length;
    const page = issues.slice(start, start + first);
    const nodes = page.map((issue) => ({ __type: 'Issue', repo, issue }));
    const hasNext = start + first < issues.length;
    return {
      __type: 'IssueConnection',
      nodes,
      pageInfo: pageInfo(hasNext, page.length > 0 ? encodeCursor(page[page.length - 1].number) : null, page.length > 0 ? encodeCursor(page[0].number) : null),
      totalCount: issues.length,
    };
  }

  issueField(node, name, args) {
    const { repo, issue } = node;
    if (name === 'id') return globalId('Issue', issue.id);
    if (name === 'number') return issue.number;
    if (name === 'title') return issue.title;
    if (name === 'body') return issue.body;
    if (name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
    if (name === 'createdAt') return issue.created_at;
    if (name === 'updatedAt') return issue.updated_at;
    if (name === 'closed') return issue.state === 'closed';
    if (name === 'closedAt') return issue.closed_at;
    if (name === 'author') return { __type: 'User', login: issue.user, id: globalId('User', 1000) };
    if (name === 'labels') {
      const first = Number.isFinite(args.first) ? args.first : issue.labels.length;
      const nodes = issue.labels.slice(0, first).map((label) => ({ __type: 'Label', label }));
      return { __type: 'LabelConnection', nodes, pageInfo: pageInfo(false, null, null), totalCount: issue.labels.length };
    }
    if (name === 'comments') {
      const comments = this.store.listComments(repo, issue.number).map((comment) => ({ __type: 'IssueComment', comment, repo }));
      const first = Number.isFinite(args.first) ? args.first : comments.length;
      return { __type: 'IssueCommentConnection', nodes: comments.slice(0, first), pageInfo: pageInfo(comments.length > first, null, null), totalCount: comments.length };
    }
    if (name === 'repository') return { __type: 'Repository', repo };
    return null;
  }

  pullField(node, name, args) {
    const { repo, pull } = node;
    const tips = this.store.pullTips(repo, pull);
    if (name === 'id') return globalId('PullRequest', pull.id);
    if (name === 'number') return pull.number;
    if (name === 'title') return pull.title;
    if (name === 'body') return pull.body;
    if (name === 'state') return pullState(pull);
    if (name === 'merged') return pull.merged === true;
    if (name === 'mergeable') return this.store.pullMergeable(repo, pull) ? 'MERGEABLE' : pull.merged ? 'UNKNOWN' : 'CONFLICTING';
    if (name === 'mergedAt') return pull.merged_at;
    if (name === 'createdAt') return pull.created_at;
    if (name === 'updatedAt') return pull.updated_at;
    if (name === 'isDraft') return false;
    if (name === 'headRefName') return pull.head;
    if (name === 'baseRefName') return pull.base;
    if (name === 'headRefOid') return tips.head;
    if (name === 'baseRefOid') return tips.base;
    if (name === 'mergeCommit') return pull.merge_commit_sha ? { __type: 'Commit', oid: pull.merge_commit_sha } : null;
    if (name === 'author') return { __type: 'User', login: pull.user, id: globalId('User', 1000) };
    if (name === 'files') {
      const files = this.store.pullFiles(repo, pull).map((file) => ({ __type: 'PullRequestFile', file }));
      const first = Number.isFinite(args.first) ? args.first : files.length;
      return { __type: 'PullRequestFileConnection', nodes: files.slice(0, first), pageInfo: pageInfo(files.length > first, null, null), totalCount: files.length };
    }
    if (name === 'comments') return { __type: 'IssueCommentConnection', nodes: [], pageInfo: pageInfo(false, null, null), totalCount: 0 };
    return null;
  }
}

function pullState(pull) {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pageInfo(hasNextPage, endCursor, startCursor) {
  return { __type: 'PageInfo', hasNextPage, hasPreviousPage: false, endCursor: endCursor ?? null, startCursor: startCursor ?? null };
}

function encodeCursor(number) {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor) {
  const text = Buffer.from(String(cursor), 'base64').toString('utf8');
  const value = Number(text.split(':').pop());
  return Number.isFinite(value) ? value : -1;
}

/** Execute one GraphQL request body: a single operation or an array of them. */
export function handleGraphQL(store, body, login) {
  const documents = Array.isArray(body) ? body : [body];
  const answers = [];
  for (const document of documents) {
    if (!document || typeof document.query !== 'string' || document.query.trim() === '') {
      answers.push({ errors: [{ message: 'A query string is required' }] });
      continue;
    }
    const execution = new Execution(store, login);
    try {
      const result = execution.run(document.query, document.variables ?? {});
      answers.push(result.errors ? { data: result.data, errors: result.errors } : { data: result.data });
    } catch (err) {
      answers.push({ data: null, errors: [{ message: err instanceof Error ? err.message : 'query failed' }] });
    }
  }
  return Array.isArray(body) ? answers : answers[0];
}
