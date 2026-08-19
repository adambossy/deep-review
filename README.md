# Deep Review

A full-stack TypeScript tool for code review.

Project vocabulary lives in [CONTEXT.md](./CONTEXT.md).

## Structure

- `apps/server` — [Hono](https://hono.dev) API on Node. Reviews and findings, backed by an in-memory store (swap in a database via `src/store.ts`).
- `apps/web` — Vite + React UI. Proxies `/api` to the server in dev.
- `packages/shared` — Zod schemas and types shared by both (reviews, findings, severities).
- `packages/call-graph` — analyze how a function's callers/callees change across a GitHub PR, using the TypeScript language service's call hierarchy. Includes an HTML report generator and CLI.

## Getting started

```sh
pnpm install
pnpm dev        # server on :3001, web on :5173
```

## Scripts

Run from the repo root:

| Command          | What it does                          |
| ---------------- | ------------------------------------- |
| `pnpm dev`       | Start server and web app in watch mode |
| `pnpm build`     | Build every package                   |
| `pnpm typecheck` | Type-check every package              |
| `pnpm test`      | Run all tests (Vitest)                |

## API

- `GET /api/health`
- `GET /api/reviews` · `POST /api/reviews`
- `GET /api/reviews/:id` · `PATCH /api/reviews/:id/status`
- `GET /api/reviews/:id/findings` · `POST /api/reviews/:id/findings`

Request/response shapes live in `packages/shared/src/index.ts`.

## PR call-graph analysis

Given a PR URL and a function name, `@deep-review/call-graph` checks out the
PR's base and head commits, asks the TypeScript language service for the
function's callers (incoming calls) and callees (outgoing calls) in each
revision, and pairs every related function with the PR diff hunks that touch
it.

```sh
pnpm --filter @deep-review/call-graph cli \
  https://github.com/sindresorhus/ky/pull/874 calculateRetryDelay \
  --out report.html
```

The HTML report shows callers above the target function and callees below,
each entry collapsible, with a Before / After / Both toggle. Source is
syntax-highlighted; the exact call to the target is marked inside each
caller; elided regions get GitHub-style expanders (20 lines per click) with
a breadcrumb of the enclosing symbols. `--layout columns` renders a
two-pane sliding variant: callers | target by default; clicking a call site
in the target's source slides the panes left (iOS-style) to show
target | callee, with thin clickable rails on either edge to slide back and
forth. `--layout explorer` goes further: it recursively walks the call graph
out from the function in both directions, expanding through every function
the PR changed and stopping at the first unchanged caller/callee boundaries.
Each function is a panel in the same two-pane slider — tap a highlighted
call to walk down the stack, tap a "called by" row to walk up — so a change
that cuts deep through the stack can be traced end to end from either
boundary. Use `--json` for the raw result instead. Programmatic use:

```ts
import { analyzePrCallGraph, createCallGraphReport } from "@deep-review/call-graph";

const result = await analyzePrCallGraph({ prUrl, functionName }); // data
await createCallGraphReport({ prUrl, functionName, outFile });    // data + HTML page
```

Languages: TypeScript/JavaScript are analyzed with an in-process TypeScript
language service; Python with `pyright-langserver` over LSP (bundled — no
install needed). The backend is chosen per PR from which file types the diff
touches, falling back across languages when the function isn't found.

Notes: set `GITHUB_TOKEN` for private repos; `#private` methods can be named
with or without the `#`; the clone is cached per-PR under the system tmp dir
(override with `--work-dir`). Dependencies of the analyzed repo are not
installed, so calls that resolve through `node_modules` / site-packages may
be missed.
