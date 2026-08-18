import { zValidator } from "@hono/zod-validator";
import {
  createFindingInputSchema,
  createReviewInputSchema,
  reviewStatusSchema,
  sortFindings,
} from "@deep-review/shared";
import { Hono } from "hono";
import { z } from "zod";
import { ReviewStore } from "./store.js";

export function createApp(store = new ReviewStore()) {
  const app = new Hono()
    .get("/api/health", (c) => c.json({ ok: true }))

    .get("/api/reviews", (c) => c.json(store.listReviews()))

    .post("/api/reviews", zValidator("json", createReviewInputSchema), (c) =>
      c.json(store.createReview(c.req.valid("json")), 201),
    )

    .get("/api/reviews/:id", (c) => {
      const review = store.getReview(c.req.param("id"));
      return review ? c.json(review) : c.json({ error: "not found" }, 404);
    })

    .patch(
      "/api/reviews/:id/status",
      zValidator("json", z.object({ status: reviewStatusSchema })),
      (c) => {
        const review = store.setStatus(c.req.param("id"), c.req.valid("json").status);
        return review ? c.json(review) : c.json({ error: "not found" }, 404);
      },
    )

    .get("/api/reviews/:id/findings", (c) => {
      const findings = store.listFindings(c.req.param("id"));
      return findings
        ? c.json(sortFindings(findings))
        : c.json({ error: "not found" }, 404);
    })

    .post(
      "/api/reviews/:id/findings",
      zValidator("json", createFindingInputSchema),
      (c) => {
        const finding = store.addFinding(c.req.param("id"), c.req.valid("json"));
        return finding ? c.json(finding, 201) : c.json({ error: "not found" }, 404);
      },
    );

  return app;
}

export type App = ReturnType<typeof createApp>;
