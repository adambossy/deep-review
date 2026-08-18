import { z } from "zod";

/** Severity of a review finding, ordered from most to least urgent. */
export const severitySchema = z.enum(["blocker", "major", "minor", "nit"]);
export type Severity = z.infer<typeof severitySchema>;

export const reviewStatusSchema = z.enum(["pending", "in_progress", "completed"]);
export type ReviewStatus = z.infer<typeof reviewStatusSchema>;

/** A single finding attached to a location in the diff. */
export const findingSchema = z.object({
  id: z.string(),
  reviewId: z.string(),
  file: z.string(),
  line: z.number().int().positive(),
  severity: severitySchema,
  summary: z.string().min(1),
  detail: z.string().default(""),
  createdAt: z.string().datetime(),
});
export type Finding = z.infer<typeof findingSchema>;

/** A review of one diff/branch. */
export const reviewSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  repo: z.string().min(1),
  baseRef: z.string().min(1),
  headRef: z.string().min(1),
  status: reviewStatusSchema,
  createdAt: z.string().datetime(),
});
export type Review = z.infer<typeof reviewSchema>;

export const createReviewInputSchema = reviewSchema.pick({
  title: true,
  repo: true,
  baseRef: true,
  headRef: true,
});
export type CreateReviewInput = z.infer<typeof createReviewInputSchema>;

export const createFindingInputSchema = findingSchema.pick({
  file: true,
  line: true,
  severity: true,
  summary: true,
  detail: true,
});
export type CreateFindingInput = z.infer<typeof createFindingInputSchema>;

const severityRank: Record<Severity, number> = {
  blocker: 0,
  major: 1,
  minor: 2,
  nit: 3,
};

/** Sort findings most-severe first, then by file and line for stable output. */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      severityRank[a.severity] - severityRank[b.severity] ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );
}
