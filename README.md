# github-core-clone — a GitHub-compatible git forge in one Node process

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/calebpaschal35/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/calebpaschal35/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone forge with no dependencies and no outside service: git smart HTTP
(upload-pack v2/v0, receive-pack v0), REST v3, GraphQL v4 and an MCP endpoint, all
backed by one in-memory store so every surface agrees about every repository.

## Layout

- `main.ts` — the lifecycle: bind an ephemeral port, register it with the env, poll
  `/done`, exit 0.
- `app.ts` — the HTTP shell: bearer-token auth, routing, JSON bodies, request ids.
- `store.ts` — the store and the git object model: SHA-1 addressing, trees, commits,
  tags, pack read/write (plain and delta), reachability, shallow boundaries.
- `gitproto.ts` — pkt-lines, sideband framing, ref advertisements, fetch selection,
  push validation and per-ref reports.
- `rest.ts` — REST v3 handlers and the shared issue/pull/content logic.
- `graphql.ts` — a small GraphQL parser and executor (viewer, repository, issues with
  cursor pagination, pull requests, `__type` introspection, `node(id:)`, batching, and
  the create/close/merge/comment mutations).
- `mcp.ts` — MCP over JSON-RPC: `server/discover` (2026-07-28) with the legacy
  `initialize` fallback, `tools/list`, and `tools/call` for create_repo, get_repo,
  create_issue, list_issues, create_pull_request, merge_pull_request, get_issue and
  list_pull_requests.

## Notes

- Objects are content-addressed exactly like git's: blob/tree/commit/tag over
  `<type> <size>\0<bytes>`, packs are plain entries with a SHA-1 trailer, and pushes
  are validated as fast-forwards (a new commit must descend from the old tip; a
  refusal reports exactly `non-fast-forward`).
- REST content writes are real git commits, so a file PUT over REST is fetchable over
  git and a git push shows up in `GET /commits` and `GET /contents`.
- Pull-request merges are squash merges: one commit on the base branch whose tree is
  the base tree with the head's changes applied, with conflict detection against the
  base's current tip.
- Timestamps come from a fixed base plus a monotonic counter, so ordering is stable
  and deterministic across runs.

---

<sub>Entered on [make.fun](https://make.fun/?ref=hrrz9v0m&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
