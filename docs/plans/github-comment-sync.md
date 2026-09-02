# Syncing GitHub review comments to and from the report page

Status: brainstorm. Nothing implemented.

Targets the world after the multi-PR server (branch `worktree-multi-pr-server`,
draft PR #3, through `1e08f5e`) — not `main`. Line references are against that
branch. An earlier revision of this plan was written against the single-PR
server and assumed the server dies with the page; that premise is gone, and
this revision is substantially shorter because of it.

Designed view of this document (diagram, tables, full reasoning):
<https://claude.ai/code/artifact/e1d92e55-9d77-44a9-8fd6-6589a0a71412>

## The goal

A reader walking a slice's call graph sees the PR's review conversation in
place — the thread anchored to the line it is about, in the panel where that
line is showing — and can write back without leaving the page. The sync job
is whatever keeps those two copies of one conversation from drifting apart.

## What the server now gives us

One long-lived server holds every PR being read. It is started detached by
the first `pr-review` invocation, discovered through a health-verified
lockfile, and never stops on its own. That inverts the old plan's central
constraint, and hands us five things this plan previously had to design:

| Need | Already there | Where |
| --- | --- | --- |
| A place to run background work | The server outlives every page and every terminal | `daemon.ts` `runDaemon`, `ensureServer` |
| A durable state directory | `~/.deep-review` (`$DEEP_REVIEW_HOME`), with a `slices/<...>.json` naming precedent and a `work/` clone cache explicitly kept out of the tmp dir macOS purges | `daemon.ts` `stateDir`, `cachedSliceFile` |
| A JSON request-body reader | `readJsonBody` (1MB cap, 400 on non-JSON) | `serve.ts:98` |
| Write endpoints as a going concern | `POST /prs`, `DELETE /prs/:key`, `POST /quit`, `POST <base>/gone` | `serve.ts` |
| CSRF defence on mutating routes | `crossSite()` runs before routing, so any endpoint added here inherits it | `serve.ts:123` |
| Head-movement detection | `currentHeadSha` hook, `PrView.headSha`, and "re-adding a moved head drops the stale build and rebuilds" | `daemon.ts` `runDaemon`, `registry.ts` |

Note the house style: CONTEXT.md's `Navigation server` entry lists *daemon* under
_Avoid_ in prose — "the CLI knows it as the server." This document follows that.

## What that deletes from the earlier plan

- **The session-scoped sync loop.** Sync no longer has to run only while you
  are reading. It can cover every PR in the registry.
- **The stray-server hazard**, which was a whole callout. `POST <base>/gone`
  now releases only that PR's language services after a 3s grace; the server
  never dies from a page closing, so nothing a poll does can resurrect a
  process. What remains is one line of care: **comment routes must not call
  `registry.sessionFor()` or `pageAlive()`**, or a background poll will pin
  language services warm and cancel the session-release grace. SSE also
  becomes viable, since there is no shutdown left to accidentally cancel.
- **The store-location question.** `stateDir()` exists and is already the home
  of durable per-PR JSON. Settled.
- **"Comment routes would be the server's first write path."** False now.
- **Inventing head-move polling.** The registry already keys builds by head
  commit and rebuilds on a move; consume that instead.

## Architecture

    pr-review <pr>  ──ensureServer()──>  one long-lived server (127.0.0.1:<port>)
                                              │
       index of all PRs at  /                 ├── /pr/:owner/:repo/:number/   page + nav
       lockfile ~/.deep-review/server.json    ├── /pr/.../comments            threads (GET)
                                              ├── /pr/.../drafts              write (POST)
                                              │
                                              ├──> GitHub   read GraphQL / write REST
                                              └──> ~/.deep-review/
                                                     server.json, server.log
                                                     slices/slices-<o>-<r>-pr<n>.json
                                                     comments/<o>-<r>-pr<n>.json   ← new
                                                     work/   durable clones + worktrees

The server is the only participant that holds a token; the disk is the only
one that holds a draft. The page never learns either.

**The page contract changed** and this plan must follow it: fetches are no
longer root-relative. The renderer injects `window.NAV_BASE` (the PR's mount
path) and `navUrl()` in `explorer.ts` prefixes every request. So the routes
are `<base>/comments` and `<base>/drafts`, reached through `navUrl()`, never
`/comments`. A static `--out` copy renders with an empty `NAV_BASE` and
`navFetch` no-ops off http(s), so it degrades exactly as before.

One concrete edit needed: under a PR prefix every non-GET returns 405 except
`/gone` (`serve.ts:347` for `/gone`, `:360` for the blanket 405). A write route has to be named there explicitly.

## The comment store

One JSON file per PR at `~/.deep-review/comments/<owner>-<repo>-pr<n>.json`,
following `cachedSliceFile`'s naming exactly (owner included — otherwise
`vercel/swr#100` and a fork's `swr#100` collide).

Shape: `{ pr, viewer, fetchedAt, etag, threads[], drafts[] }`. An `Anchor` is
`{ path, side, line, startLine?, sha, text, context[] }` — `text` and
`context` carry no weight until a force-push, and then they are the only
thing that can find the line again.

Why disk and not the registry: the registry is **in-memory only**, so a
restart forgets its entries. Slice JSONs survive that because they are on
disk; unsent drafts must too. A cache losing a clone costs a re-clone; a
cache losing an unsent review costs the review.

## Where the sync loop runs

The one genuinely open architectural question, and the server's author has a
view worth weighing: there is **no general scheduler, job runner, or plugin
extension point** — only the registry's build queue and an unref'd eviction
sweep — and their recommendation is a separate process talking to the
server's HTTP API via the lockfile.

Three options:

1. **Lazy, on demand, in-process (recommended to start).** No loop at all.
   `GET <base>/comments` refreshes from GitHub if its cached copy is older
   than N seconds, and the page polls that route the way `indexPage.ts`
   already polls `/prs` every 2s. This mirrors the server's own stated
   philosophy — "nothing is resolved ahead of time and nothing is capped; the
   page starts small and learns as it is read" — and exactly how
   `sessionFor()` starts language services on the first question. Zero new
   machinery, and it covers the entire read half.
2. **A separate sync process.** What the author suggests. Buys polling for
   PRs nobody has open, at the cost of re-solving the lifecycle problem the
   server just solved — who starts it, who keeps it alive, another lockfile.
3. **An in-server extension point.** The author notes a second session (a
   PR-assignment watcher, branch `worktree-pr-watcher`) has asked for the
   same thing, and that two askers may justify designing one — but wants to
   coordinate before anyone writes it.

Recommendation: build option 1, which needs no decision from anyone, and let
options 2/3 be settled by whether the watcher actually lands. Do not design a
scheduler for a single consumer.

## What still has to be built

The server changes where things run. It does not touch the hard part, which
is anchoring — all of the following stands unchanged.

### Anchoring

Coordinate systems mostly agree: our base worktree is at the merge base
(GitHub's `LEFT`) and our head worktree is the PR head (`RIGHT`). Use
`line` + `side`; never compute GitHub's legacy `position`, which is an offset
into *GitHub's* patch text while our diff comes from local `git diff`.

Two gaps:

1. **Removed lines have no address.** Add `oldLineNumbers` to `IndexedHunk`
   (a mirror of the existing loop in `slicer/src/annotate.ts`), widen
   `DiffRow`'s `del` variant with a line number, and add `data-line`/
   `data-side` to `lineRow`. ~10 lines, and it should land before any comment
   UI — retrofitting an address into a rendered row later is worse.

2. **GitHub refuses comments on unchanged code**, and the explorer exists to
   walk *out* of the diff, where the most useful comment is often "this
   caller was never going to survive that signature change." Options: allow
   diff lines only (cheap, amputates the differentiator); fall back to a
   PR-level comment quoting the excerpt plus a
   `.../blob/<headSha>/<path>#L12-L20` permalink, which GitHub expands into a
   rendered snippet; or `subject_type: "file"` (in-diff files only).
   **Recommended: the permalink fallback, with the gutter labelling itself
   `inline` vs `note` before the reader types.** Silently downgrading a
   carefully-placed comment is how a tool loses trust.

### Drift

Three cases, one function: `remap(anchor, fromSha, toSha)` — positional via
`git diff`, content-match on `Anchor.text` as fallback. This gets *easier*
under the server: `work/` holds durable clones, so the two commits being
diffed are reliably on disk instead of in a tmp dir that may have been purged.

1. **Head moved.** No longer needs its own poller — `PrView.headSha` and the
   `currentHeadSha` hook already detect it, and re-adding a moved PR rebuilds
   the page. Surface what the registry already knows; `remap` the drafts.
2. **Force-push / rebase.** Positional mapping is meaningless; content match
   is all there is. On failure mark the draft `unanchored` and keep it. Never
   drop a draft.
3. **Remote comments older than our head.** Their `line` refers to their own
   `original_commit_id`. V0: a tray labelled outdated. Later: `remap` forward.

### Pushing

- **Batch, don't drip.** Drafts accumulate, then one
  `POST /pulls/{n}/reviews` with `comments[]` and an `event`. One review, one
  notification, revisable until sent. Replies are the exception — they can't
  be batched, so they go individually to `/pulls/comments/{id}/replies`.
- **Idempotency**, since GitHub offers no key: embed the draft uuid as
  `<!-- dr:9f2c... -->`, which the markdown renderer drops. On resync a
  remote comment carrying a known uuid reconciles instead of duplicating.
- **Never post without an explicit submit.** Add `--dry-run`. The write half
  is a queue drainer, not an autonomous agent. The `crossSite()` gate covers
  the drive-by case for free, but it is not a substitute for intent.
- **Read over GraphQL, write over REST** — a capability boundary, not taste.
  Thread grouping, `isResolved`, `isOutdated` and `resolveReviewThread` are
  GraphQL-only, and a review tool that shows settled arguments as if they
  were open is mostly noise. Keep `packages/pr` dependency-free: a shared
  `githubRequest()` for token, headers, retry and rate-limit accounting, with
  a thin `githubGraphql()` beside it. No client library.

## Failure modes

Two rows here are new, created by the server's own longevity.

| Failure | Reader sees | Store does |
| --- | --- | --- |
| **Server started without a token** — it inherits the env of whichever shell spawned it, which may not be the one you are in | "This server has no GitHub token — `pr-review stop`, then re-run from a shell that has one" | read-only; drafts still writable |
| **Token expired under a long-lived server** — a process that runs for weeks outlives credentials | the 401 named plainly, not "sync failed" | read the token per request, not once at boot |
| No PR-write scope | submit disabled, with the reason | drafts persist |
| Rate-limited | "Resuming at 14:32" | back off to the reset timestamp |
| Network down | "Offline — 3 drafts queued" | queue, retry with jitter |
| 422 on submit | that one comment is called out, not the whole review | that draft `failed`; the rest still post |
| Head moved | the registry already knows; surface it | `remap` drafts, keep the mirror |
| Comment deleted/edited remotely | it changes or disappears | remote wins — the mirror is a cache |
| Server restarted | threads reload; drafts are still there | in-memory registry forgets, the store does not |
| Static `--out` copy | threads render from the snapshot, gutter offers nothing | untouched; `navFetch` no-ops off http(s) |

## Build order

1. **Read-only threads, in place.** GraphQL `reviewThreads` → the store →
   threads rendered at their line, fetched lazily by `GET <base>/comments`.
   Unresolved inline, resolved/outdated in a tray, per-slice comment counts on
   the deck pips — and because slices *partition* the diff, every inline
   comment belongs to exactly one slice, so "which slice is the argument
   about" falls out for free. No write path, no new background machinery,
   retires the manual `cursor[bot]` poll in the `finalizing-pr` skill. Worth
   shipping alone.
2. **Counts on the index.** Newly possible, and cheap: the index at `/` lists
   every PR the server holds, so it can carry "3 unresolved · 1 new" per row.
   The single-PR server could not have offered this at all.
3. **Draft and submit.** `POST <base>/drafts` (name it in the per-PR 405
   allowlist); write-through to the store; a pending-review drawer; one
   explicit submit with an event choice.
4. **Replies and resolution.** GraphQL resolve/unresolve; unread marks.
5. **Drift, properly.** `remap`, the permalink fallback, `side: LEFT` anchors,
   outdated comments mapped forward.

## Vocabulary to add to CONTEXT.md

CONTEXT.md now carries `Navigation server`, `Registry` and `Lockfile`. These
slot beside them, in the same house style.

- **Thread** — one GitHub review conversation: an anchor plus its comments in
  order. _Avoid_: discussion, conversation (overloaded).
- **Anchor** — where a thread or draft attaches: path, side, line range, and
  the commit those numbers are counted in. Carries the line's text so it can
  be found again when the numbers move. _Avoid_: position (collides with
  GitHub's legacy patch offset), location.
- **Draft** — a comment written on the page and not yet on GitHub. _Avoid_:
  pending (collides with GitHub's PENDING review state).
- **Pending review** — the drafts that will be submitted as a single review.
- **Mirror** — the local copy of GitHub's threads. A cache, never a source:
  on any disagreement, remote wins.
- **Remap** — moving an anchor from one commit's line numbering to another's.
- **Unanchored** — a thread or draft whose line cannot be found in the
  current head. Kept, never dropped. _Avoid_: orphaned, stale (stale
  describes the report, not the anchor).
- **Tray** — where unanchored, resolved, and outdated threads live, having no
  line to sit on.

## Open questions

1. Batch drafts into one review, or post each as written? _Assumed: batch._
2. Is a hidden `<!-- dr:uuid -->` marker acceptable, given it shows in the raw
   body and GitHub's edit box? _Assumed: yes; fuzzy matching is less
   reliable._
3. Off-diff comments: permalinked note, or not commentable? _Assumed: the
   note, though it is two comment kinds to teach._
4. **Where the loop lives** (replaces the old store-location question, now
   settled): lazy on-demand, a separate process, or a shared in-server
   extension point built with the PR-watcher? _Assumed: lazy, and revisit
   only if the watcher lands._
5. GraphQL reads from day one, or a REST-only V0 blind to resolution state?
   _Assumed: GraphQL._

## Fed back to the server's author

The env-inheritance point is worth their attention independently of this
plan: a server spawned by `ensureServer()` keeps the environment of whichever
invocation spawned it, so `GITHUB_TOKEN` is frozen at spawn time. That is
already true for the private-repo path in `fetchPrInfo`, not just for
comments — a reader who exports a token and re-runs `pr-review` will still be
served by a tokenless server started earlier, with no signal saying why.
