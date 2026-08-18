import type { Finding, Review } from "@deep-review/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";

const jsonHeaders = { "Content-Type": "application/json" };

describe("reviews API", () => {
  it("creates a review and lists it", async () => {
    const app = createApp();
    const created = await app.request("/api/reviews", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        title: "Add auth middleware",
        repo: "acme/api",
        baseRef: "main",
        headRef: "feature/auth",
      }),
    });
    expect(created.status).toBe(201);
    const review = (await created.json()) as Review;
    expect(review.status).toBe("pending");

    const list = await app.request("/api/reviews");
    expect(await list.json()).toHaveLength(1);
  });

  it("rejects invalid input", async () => {
    const app = createApp();
    const res = await app.request("/api/reviews", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ title: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("adds findings and returns them sorted by severity", async () => {
    const app = createApp();
    const created = await app.request("/api/reviews", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        title: "t",
        repo: "r",
        baseRef: "main",
        headRef: "head",
      }),
    });
    const { id } = (await created.json()) as Review;

    for (const severity of ["nit", "blocker"] as const) {
      const res = await app.request(`/api/reviews/${id}/findings`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          file: "src/a.ts",
          line: 10,
          severity,
          summary: `a ${severity}`,
          detail: "",
        }),
      });
      expect(res.status).toBe(201);
    }

    const findings = (await (
      await app.request(`/api/reviews/${id}/findings`)
    ).json()) as Finding[];
    expect(findings.map((f) => f.severity)).toEqual(["blocker", "nit"]);
  });

  it("404s on unknown review", async () => {
    const app = createApp();
    const res = await app.request("/api/reviews/nope/findings");
    expect(res.status).toBe(404);
  });
});
