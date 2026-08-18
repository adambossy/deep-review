import type { CreateReviewInput, Finding, Review } from "@deep-review/shared";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function listReviews(): Promise<Review[]> {
  return request("/api/reviews");
}

export function createReview(input: CreateReviewInput): Promise<Review> {
  return request("/api/reviews", { method: "POST", body: JSON.stringify(input) });
}

export function listFindings(reviewId: string): Promise<Finding[]> {
  return request(`/api/reviews/${reviewId}/findings`);
}
