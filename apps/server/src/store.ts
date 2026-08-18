import { randomUUID } from "node:crypto";
import type {
  CreateFindingInput,
  CreateReviewInput,
  Finding,
  Review,
  ReviewStatus,
} from "@deep-review/shared";

/**
 * In-memory store, keyed by review id. Swap for a real database once the
 * data model settles; the route layer only depends on this interface.
 */
export class ReviewStore {
  private reviews = new Map<string, Review>();
  private findings = new Map<string, Finding[]>();

  listReviews(): Review[] {
    return [...this.reviews.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }

  getReview(id: string): Review | undefined {
    return this.reviews.get(id);
  }

  createReview(input: CreateReviewInput): Review {
    const review: Review = {
      id: randomUUID(),
      ...input,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    this.reviews.set(review.id, review);
    this.findings.set(review.id, []);
    return review;
  }

  setStatus(id: string, status: ReviewStatus): Review | undefined {
    const review = this.reviews.get(id);
    if (!review) return undefined;
    const updated = { ...review, status };
    this.reviews.set(id, updated);
    return updated;
  }

  listFindings(reviewId: string): Finding[] | undefined {
    return this.findings.get(reviewId);
  }

  addFinding(reviewId: string, input: CreateFindingInput): Finding | undefined {
    const existing = this.findings.get(reviewId);
    if (!existing) return undefined;
    const finding: Finding = {
      id: randomUUID(),
      reviewId,
      ...input,
      createdAt: new Date().toISOString(),
    };
    existing.push(finding);
    return finding;
  }
}
