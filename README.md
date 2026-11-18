# arunprasad2415/forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/arunprasad2415/forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/arunprasad2415/forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge: one Node process that serves git smart HTTP, the REST v3 API, the
GraphQL v4 API and a Model Context Protocol endpoint from its own in-memory store, with no
dependencies, no git binary and no network beyond the client.

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 node main.ts   # binds an ephemeral port, registers, serves
node --test tests/forge.test.ts                      # the forge's own test suite
```

The process binds port 0, POSTs the port it got to `$MAKEFUN_ENV_URL/register`, and long-polls
`$MAKEFUN_ENV_URL/done` until the client says the trial is over. Every surface answers on that
one port.

## What it serves

**git smart HTTP** at `/<owner>/<repo>.git` — `info/refs`, `git-upload-pack` and
`git-receive-pack`, implemented against `node:zlib` and `node:crypto`:

- protocol v2 for fetch: the capability advertisement, `ls-refs` with `symrefs`, `peel`, `unborn`
  and `ref-prefix` filtering, and `fetch` with `want`/`have`/`done`, `thin-pack`, `ofs-delta`,
  `shallow` and `deepen`, answered in `side-band-64k` frames;
- protocol v0 for receive-pack: `report-status`, `side-band-64k`, `delete-refs`, per-ref `ok`/`ng`
  lines, fast-forward enforcement (`ng <ref> non-fast-forward`) and tag/branch deletes;
- packfiles in both directions: a reader that resolves `ofs-delta` and `ref-delta` chains and
  verifies every object's SHA-1, and a writer that emits whole objects with the sha1 trailer.

**REST v3** under `/api/v3` — repositories (create, read, patch, delete, paginated lists with
`Link: rel="next"`), branches, commits, the contents API (base64 blobs, sha checks, 409 on a stale
sha, directory listings, delete-with-commit), labels, issues with labels/comments/state filters,
and pull requests with their files, `merge_commit_sha` and squash merges (405 when the base has
moved past the head).

**GraphQL v4** at `/api/graphql` — a hand-written parser and executor for the documents `gh` and
`github-mcp-server` send: `viewer`, `repository`, `node(id:)`, `__type` introspection,
`issues(first:, after:, states:, orderBy:)` with cursors, `pullRequests`, `pullRequest.files`, and
the `createIssue`, `closeIssue`, `createPullRequest`, `mergePullRequest` and `addComment`
mutations. Two operations in one body answer two results in order; an unknown field is HTTP 200
with an `errors` array naming it.

**MCP** at `/mcp` — JSON-RPC 2.0 over streamable HTTP on revision `2026-07-28` (`server/discover`
with `supportedVersions`) and the earlier handshake revisions: `tools/list` with eight tools
(`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`,
`merge_pull_request`, `get_pull_request`, `list_pull_requests`), `tools/call` against the same
store REST reads, `-32602` for an unknown tool or a missing argument, `-32700` with HTTP 400 for a
body that is not JSON, and 401 without a token.

## Layout

| file | what it holds |
| --- | --- |
| `main.ts` | the lifecycle: bind, register, poll `/done`, exit 0 |
| `app.ts` | the HTTP server, the router and the JSON/request-id discipline |
| `gitcore.ts` | objects, pkt-lines, packfiles both ways, trees, commits, tags |
| `githttp.ts` | the smart-HTTP handlers (advertisement, ls-refs, fetch, receive-pack) |
| `store.ts` | the store: repositories, refs, objects, issues, labels, comments, pull requests |
| `rest.ts` | the REST v3 routes and their GitHub shapes |
| `graphql.ts` | the GraphQL parser, executor and introspection |
| `mcp.ts` | the MCP JSON-RPC endpoint and its tools |
| `tests/forge.test.ts` | 15 tests that boot the server and speak to every surface over HTTP |

## Determinism

Nothing reads a clock or a random source: object ids come from the bytes, dates from a fixed epoch
plus a per-repository counter, and request ids from a counter. Two runs of the same requests leave
the same state, byte for byte.

---

<sub>Entered on [make.fun](https://make.fun/?ref=github-core-clone-01&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
