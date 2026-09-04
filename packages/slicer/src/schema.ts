import { z } from "zod";
import { FRAGMENT_KINDS } from "./types.js";

/**
 * What the agent returns. Fragments are defined inline on the slice that owns
 * them rather than in a separate table keyed by id: a slice cannot then
 * reference a fragment that does not exist, and the model never has to keep
 * two lists in sync. Stable fragment ids are derived afterwards.
 */
export const agentFragmentSchema = z.object({
  hunkId: z
    .string()
    .describe("The id from the `=== HUNK <id>` line, copied exactly."),
  startLine: z
    .number()
    .int()
    .positive()
    .describe("First hunk-local line of this run, from the left-hand column."),
  endLine: z
    .number()
    .int()
    .positive()
    .describe("Last hunk-local line of this run, inclusive."),
  summary: z
    .string()
    .min(1)
    .describe("What this run of lines does, in one sentence."),
  kind: z
    .enum(FRAGMENT_KINDS)
    .describe(
      "core: behavior the PR exists to change, and the logic supporting it. " +
        "test: test code exercising core changes. " +
        "boilerplate: mechanical fallout (imports, renames, wiring, config, lockfiles, generated files, formatting), " +
        "and any test that only exercises boilerplate.",
    ),
});

export const agentSliceSchema = z.object({
  title: z
    .string()
    .min(1)
    .describe("A short noun phrase naming the change, e.g. 'Retry budget'."),
  summary: z.string().min(1).describe("What this change does and why."),
  rationale: z
    .string()
    .min(1)
    .describe("Why it belongs at this rank relative to the other slices."),
  target: z
    .object({
      file: z.string().min(1),
      name: z.string().min(1).describe("The function's name, not its call."),
    })
    .optional()
    .describe(
      "The one function this slice is most about, if a single function stands out. Omit otherwise — do not guess.",
    ),
  fragments: z.array(agentFragmentSchema).min(1),
});

export const agentOutputSchema = z.object({
  overview: z
    .string()
    .min(1)
    .describe("One paragraph on what the PR as a whole is doing."),
  slices: z
    .array(agentSliceSchema)
    .min(1)
    .describe("Ordered most to least central to the PR's purpose."),
});

/**
 * The persisted artifact, for reading a report back in — regenerating the
 * HTML from a saved run rather than paying for the agent again.
 */
export const sliceReportSchema = z.object({
  pr: z.object({
    url: z.string(),
    owner: z.string(),
    repo: z.string(),
    number: z.number().int().positive(),
    title: z.string(),
    // Optional: reports written before the description was persisted are
    // still readable, and loadRenderEntry fills these from the fetch it
    // already makes.
    description: z.string().optional(),
    author: z.string().optional(),
    baseSha: z.string(),
    mergeBaseSha: z.string(),
    headSha: z.string(),
  }),
  tickets: z.array(
    z.object({
      identifier: z.string(),
      title: z.string(),
      description: z.string(),
      url: z.string(),
      state: z.string(),
    }),
  ),
  overview: z.string(),
  slices: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      summary: z.string(),
      rationale: z.string(),
      target: z.object({ file: z.string(), name: z.string() }).optional(),
      fragments: z.array(
        z.object({
          id: z.string(),
          hunkId: z.string(),
          file: z.string(),
          startLine: z.number().int().positive(),
          endLine: z.number().int().positive(),
          summary: z.string(),
          // Optional: reports written before fragments were classified still
          // load, and render with an unsplit line count.
          kind: z.enum(FRAGMENT_KINDS).optional(),
        }),
      ),
    }),
  ),
  model: z.string(),
  generatedAt: z.string(),
});

export type AgentOutput = z.infer<typeof agentOutputSchema>;
export type AgentSlice = z.infer<typeof agentSliceSchema>;
export type AgentFragment = z.infer<typeof agentFragmentSchema>;
