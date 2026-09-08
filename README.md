# Deep Review

A full-stack TypeScript tool for code review.

Project vocabulary lives in [CONTEXT.md](./CONTEXT.md).

## Quick start

```sh
pnpm install
pnpm dev        # server on :3001, web on :5173
```

Authenticate to GitHub once. Nothing here shells out to `gh`, so the login on
its own is not enough — hand the token it holds to the command that needs it:

```sh
gh auth login
export GITHUB_TOKEN=$(gh auth token)
```

Then hand a PR to the slice explorer — the tool's primary interface, stacking
slices vertically and each slice's call graph horizontally:

```sh
export OPENAI_API_KEY=...   # or ANTHROPIC_API_KEY / GROK_API_KEY, see below
pnpm --filter @deep-review/review cli https://github.com/vercel/swr/pull/2950
```

This slices the PR with an agent, walks a call graph from each slice's target function, serves the page from a local navigation server and opens it. It will automatically open the page with the slicing progress for you to monitor.

To have the server listen to new PRs as they get assigned to you, run the following once: 

```sh
pr-review watch --repo spara-ai/spara-app
```

That both adds the repo to `~/.deep-review/watch.json` and turns watching on, installing a launchd agent that survives logout and reboot. 

### Adding PRs to the server

One long-lived local server holds every PR you add. The first invocation
starts it, later ones add their PRs to it, and each PR keeps its own URL until
the server is stopped. A PR builds in the background — its URL opens at once
and turns into the explorer when it is ready.

```sh
# One PR by URL; starts the server if it isn't already up.
pnpm --filter @deep-review/review cli https://github.com/vercel/swr/pull/2950

# Several at once as bare numbers, with the repo named separately
# (or set DEEP_REVIEW_REPO=vercel/swr and drop --repo).
pnpm --filter @deep-review/review cli 2950 2951 2952 --repo vercel/swr

# Reuse a saved slicing run instead of paying for the agent again.
pnpm --filter @deep-review/review cli 2950 --repo vercel/swr --slices slices.json

# Stay attached until the PRs you added have finished building.
pnpm --filter @deep-review/review cli 2950 --repo vercel/swr --wait

# What the server holds, and how to stop it.
pnpm --filter @deep-review/review cli status
pnpm --filter @deep-review/review cli stop
```

After `pnpm build`, the same CLI is on your path as `pr-review`, so those read
`pr-review 2950 --repo vercel/swr`. `--help` lists every flag, including
`--max-graphs <n>` to cap the slow call-graph analysis, `--save <file>` to keep
this run's slice JSON, and `--out <file>` for a static copy of the page.

Environment: a model key is required unless `--slices` is given —
`OPENAI_API_KEY` for the default model (`gpt-5.6-sol`), `ANTHROPIC_API_KEY` for
`claude-*` models, `GROK_API_KEY` for `grok-*`; `GITHUB_TOKEN` (or `GH_TOKEN`)
for private repos, and required outright by `watch`, whose `assignee:@me` query
has no meaning without a token to resolve it against; `LINEAR_API_KEY` is
optional and enables linked-ticket context. A `.env` in the package or repo
root is picked up automatically, so `GITHUB_TOKEN=$(gh auth token)` can live
there instead of being passed per invocation.

## Structure

- `apps/server` — [Hono](https://hono.dev) API on Node. Reviews and findings, backed by an in-memory store (swap in a database via `src/store.ts`).
- `apps/web` — Vite + React UI. Proxies `/api` to the server in dev.
- `packages/shared` — Zod schemas and types shared by both (reviews, findings, severities).
- `packages/pr` — one PR's raw material: URL parsing, GitHub metadata, linked Linear tickets, base/head worktrees, and unified-diff parsing. Depended on by the two analysis packages below.
- `packages/call-graph` — analyze how a function's callers/callees change across a GitHub PR, using the TypeScript language service's call hierarchy. Includes an HTML report generator and CLI.
- `packages/slicer` — break a PR's diff into prioritized slices with an agent. Includes a CLI.
- `packages/review` — the two together: slices on the vertical axis, call graphs on the horizontal. Includes the `pr-review` CLI.



## Scripts

Run from the repo root:


| Command          | What it does                           |
| ---------------- | -------------------------------------- |
| `pnpm dev`       | Start server and web app in watch mode |
| `pnpm build`     | Build every package                    |
| `pnpm typecheck` | Type-check every package               |
| `pnpm test`      | Run all tests (Vitest)                 |




## API

- `GET /api/health`
- `GET /api/reviews` · `POST /api/reviews`
- `GET /api/reviews/:id` · `PATCH /api/reviews/:id/status`
- `GET /api/reviews/:id/findings` · `POST /api/reviews/:id/findings`

Request/response shapes live in `packages/shared/src/index.ts`.

## Watching your assigned PRs

`pr-review watch` turns the whole thing around: instead of asking for a
review, a review is waiting when a PR is assigned to you.

```sh
pr-review watch          # on; survives logout, reboot and a closed lid
pr-review status         # what is being watched, and what the server holds
pr-review watch --off    # off
```

It checks GitHub every five minutes (`--interval <seconds>`) for the PRs
waiting on your review, and hands each new one to the same long-lived server
every other invocation uses — starting it if it is not up, so there is never
a server to start yourself. New PRs simply appear on the server's index,
built and ready.

Which repos it watches is the business of one file, `~/.deep-review/watch.json`
(under `$DEEP_REVIEW_HOME`, beside the rest of the state). `pr-review watch --repo <owner>/<repo>` adds a repo to it; or write it yourself:

```json
{
  "repos": {
    "acme/widgets": {},
    "acme/gadgets": { "query": "is:open is:pr review-requested:@me -is:draft" }
  }
}
```

Each key is a repo to watch, and naming it is all opting in takes: an empty
entry uses the default query below. An entry may instead carry its own
`query`, in GitHub search syntax, for a repo where "waiting on me" is spelled
differently. Leave `repo:` out of it — the repo is the key, and is appended for
you, so no entry's query can reach into a repo other than the one it is filed
under; one that tries is skipped with a note in the log. The file is read on
every check, so adding a repo needs no reinstall.

A repo not named in the file is never watched. Not queried, not touched, not
on the server: there is no default that means "every repo your token can see",
and no flag or environment variable that widens the list. An empty file, or
none, means nothing is watched, and each check says so in the log.
`DEEP_REVIEW_REPO` still names the repo a bare PR number refers to; it plays
no part in what is watched.

"Waiting on your review" is narrower than "assigned to you", and deliberately:
a draft is not ready to be read, and one you have already approved has been
read. Both are excluded, so the list is work outstanding rather than
everything carrying your name. The default query, for each repo, is exactly:

```
is:open is:pr assignee:@me archived:false -is:draft -review:approved repo:<owner>/<repo>
```

The check asks for the *current* set of such PRs rather than for events,
which is what makes a laptop the right place to run it: a webhook delivered to
a sleeping machine is lost, but one poll after the lid opens sees everything
that happened overnight. Missing a check costs nothing by construction.

A PR is handed over once, when it first appears in that list — not every time
it changes, because `updated_at` moves on every comment and a rebuild means a
paid slicing run. Anything that drops out of the list is forgotten, so
approving a PR and having it reassigned, or unassigning and reassigning, is
the deliberate way to ask for it again.

Once a PR is merged or closed, its page leaves the server's index on the next  
check, so the index shows only what can still be acted on. Leaving the list is  
not what triggers this — approval, unassignment and turning back into a draft  
all do that, and none of them finish a PR — so every PR handed over is asked  
about directly until GitHub says it is closed.