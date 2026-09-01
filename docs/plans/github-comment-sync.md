# Syncing GitHub review comments to and from the report page

Status: brainstorm. Nothing implemented. Line references are against `c4f2af6`.

Designed view of this document (diagram, tables, full reasoning):
<https://claude.ai/code/artifact/e1d92e55-9d77-44a9-8fd6-6589a0a71412>

## The goal

A reader walking a slice's call graph sees the PR's review conversation in
place — the thread anchored to the line it is about, in the panel where that
line is showing — and can write back without leaving the page. The sync job
is whatever keeps those two copies of one conversation from drifting apart.

## The constraint that reframes everything

The navigation server lives and dies with the page: ephemeral port, one PR,
shutdown ~3s after the page unloads (`shutdownGraceMs`, `serve.ts:59`). There
is no daemon and nowhere to put one.

So "sync job" cannot mean a process that watches your PRs. It means a loop
that runs while you are reading, over a store that outlives the reading.
Every draft is written through to disk the moment it changes, because the
only thing holding it is about to exit.

## Architecture

The server is the only participant that holds the token; the disk is the only
participant that holds a draft.

    page  <-- relative fetch -->  nav server  <-- GraphQL read / REST write -->  GitHub
                                       |
                                  comment store (~/.deep-review, on disk)

- The page never learns the token and never learns GitHub's shapes. It asks
  for threads and hands over drafts.
- Reads go over GraphQL, writes over REST. Not aesthetics — a capability
  boundary: thread grouping, `isResolved`, `isOutdated` and
  `resolveReviewThread` are GraphQL-only.
- One JSON file per PR at `~/.deep-review/comments/<owner>/<repo>/<n>.json`.
  Deliberately not the tmp work dir: a reaped cache costing a re-clone is
  fine, costing an unsent review is not.

Store shape: `{ pr, viewer, fetchedAt, etag, threads[], drafts[] }`. An
`Anchor` is `{ path, side, line, startLine?, sha, text, context[] }` — `text`
and `context` carry no weight until a force-push, and then they are the only
thing that can find the line again.

## What exists today

| Piece | Where | State |
| --- | --- | --- |
| GitHub client | `pr/src/github.ts` | 57 lines, plain fetch, one endpoint; no pagination/retry/ETag/rate-limit |
| Commit SHAs | `pr/src/github.ts`, `slicer/src/types.ts:70` | base, merge-base, head — persisted in the slices JSON |
| Head-side line numbers | `slicer/src/annotate.ts:17` | `newLineNumbers[i]` = GitHub `line` with `side: RIGHT` |
| Base-side line numbers | — | **missing.** No `oldLineNumbers`; `DiffRow.kind === "del"` carries no number (`diffView.ts:421`) |
| DOM to anchor | `explorer.ts:366-399` | `positionOf` already returns `{file, side, line, column}`. Reuse verbatim |
| Nav server | `review/src/serve.ts` | GET-only + `POST /shutdown`; no request-body reader exists yet |
| Page/server transport | `explorer.ts:339-364` | page served from `/`, all fetches relative; `navFetch` no-ops under `file://` |

Not a foundation: `packages/shared`'s `findingSchema`. Nothing under
`packages/*` imports it, and it has no `side`, no sha, no PR ref.

Prior art outside the repo: the `finalizing-pr` skill already hand-rolls the
read half — `gh api .../pulls/<n>/comments`, filtered to `cursor[bot]`, polled
every 60s. That names the first consumer: bot findings, anchored to a line.

## Anchoring — the whole problem

The coordinate systems mostly agree: our base worktree is at the merge base
(GitHub's `LEFT`) and our head worktree is the PR head (`RIGHT`). Use
`line` + `side`; never compute GitHub's legacy `position`, which is an offset
into *GitHub's* patch text while our diff comes from local `git diff`.

Two gaps:

1. **Removed lines have no address.** Add `oldLineNumbers` to `IndexedHunk`
   (a mirror of the existing loop), widen `DiffRow`'s `del` variant with a
   line number, and add `data-line`/`data-side` to `lineRow`. ~10 lines, and
   it should land before any comment UI — retrofitting an address into a
   rendered row later is worse.

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

## Drift

Three cases, one function: `remap(anchor, fromSha, toSha)` — positional via
`git diff` (the clone is already in the work dir), content-match on
`Anchor.text` as fallback.

1. **Head moved while reading.** Detected on poll. Don't silently re-anchor
   the page — say "3 new commits; this report is from `c4f2af6`" and offer a
   re-run. Drafts follow via `remap`.
2. **Force-push / rebase.** Positional mapping is meaningless; content match
   is all there is. On failure mark the draft `unanchored` and keep it. Never
   drop a draft.
3. **Remote comments older than our head.** Their `line` refers to their own
   `original_commit_id`. V0: a tray labelled outdated. Later: `remap` forward.

## Pushing

- **Batch, don't drip.** Drafts accumulate, then one
  `POST /pulls/{n}/reviews` with `comments[]` and an `event`. One review, one
  notification, revisable until sent. Replies are the exception — they can't
  be batched, so they go individually to `/pulls/comments/{id}/replies`.
- **Idempotency**, since GitHub offers no key: embed the draft uuid as
  `<!-- dr:9f2c... -->`, which the markdown renderer drops. On resync a
  remote comment carrying a known uuid reconciles instead of duplicating.
  (Visible in the raw body and GitHub's edit box — see open question 2.)
- **Never post without an explicit submit.** Add `--dry-run`. The write half
  of the loop is a queue drainer, not an autonomous agent.
- Keep `packages/pr` dependency-free: a shared `githubRequest()` for token,
  headers, retry and rate-limit accounting, with a thin `githubGraphql()`
  beside it. No client library.

## The loop

Polling — webhooks need a public endpoint. ~20s while
`document.visibilityState === "visible"`, ~120s hidden, stopped on
`pagehide`. REST honours `If-None-Match` and a 304 is free; GraphQL has no
ETags but one query per 20s is ~180/hour against 5,000 points. Back off on
`x-ratelimit-remaining`, and paginate.

**Stray-server hazard.** Any incoming request cancels a pending shutdown
(`serve.ts:82-85`) — that is what lets a reload survive. But an `EventSource`
reconnects on its own and a poll can fire mid-unload; either landing inside
the 3s grace window resurrects a server the page meant to kill, orphaning a
process that holds a warm language service and a GitHub token. Gate the
poller on `pagehide`, and treat comment-route requests as *not* a heartbeat —
only a real `/alive` should cancel an accepted shutdown. This is also the
reason to prefer plain polling over SSE.

## Failure modes

Each needs a specific visible answer; "sync failed" is not one.

| Failure | Reader sees | Store does |
| --- | --- | --- |
| No/invalid token | "Sign in to sync — `gh auth refresh -h github.com`" | read-only; drafts still writable |
| No PR-write scope | submit disabled, with the reason | drafts persist |
| Rate-limited | "Resuming at 14:32" | back off to the reset timestamp |
| Network down | "Offline — 3 drafts queued" | queue, retry with jitter |
| 422 on submit | that one comment is called out, not the whole review | that draft `failed`; the rest still post |
| Head moved | banner naming new commit count and the report's sha | `remap` drafts, keep the mirror |
| Comment deleted/edited remotely | it changes or disappears | remote wins — the mirror is a cache |
| Two tabs on one PR | nothing unusual | store is per-PR; last write wins per uuid |
| Static `--out` copy | threads render from the snapshot, gutter offers nothing | untouched; `navFetch` already no-ops |

## Build order

Ordered by dependency, not preference.

1. **Read-only threads, in place.** GraphQL `reviewThreads` to the store to
   threads rendered at their line. Unresolved inline, resolved/outdated in a
   tray, per-slice comment counts on the deck pips — and because slices
   *partition* the diff, every inline comment belongs to exactly one slice,
   so "which slice is the argument about" falls out for free. No write path,
   retires the manual Bugbot poll, worth shipping alone.
2. **Draft and submit.** Gutter marker opens a composer; write-through to the
   store; a pending-review drawer; one explicit submit with an event choice.
3. **Replies, resolution, live updates.** GraphQL resolve/unresolve,
   visibility-aware polling, unread marks. Where the stray-server hazard
   bites.
4. **Drift, properly.** `remap`, the permalink fallback, `side: LEFT` anchors,
   outdated comments mapped forward.

## Vocabulary to add to CONTEXT.md

`CONTEXT.md` has no term for any of this, and its "Navigation server" entry
frames the server as a thing that answers *questions* — which a write path
contradicts.

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
4. Store under `~/.deep-review` or the tmp work dir? _Assumed: home dir._
5. GraphQL reads from day one, or a REST-only V0 blind to resolution state?
   _Assumed: GraphQL._
