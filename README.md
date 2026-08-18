# Deep Review

A full-stack TypeScript tool for code review.

## Structure

- `apps/server` — [Hono](https://hono.dev) API on Node. Reviews and findings, backed by an in-memory store (swap in a database via `src/store.ts`).
- `apps/web` — Vite + React UI. Proxies `/api` to the server in dev.
- `packages/shared` — Zod schemas and types shared by both (reviews, findings, severities).

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
