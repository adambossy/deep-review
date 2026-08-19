import { anthropic } from "@ai-sdk/anthropic";
import { isStepCount, Output, ToolLoopAgent } from "ai";
import type { DiffIndex } from "./annotate.js";
import { buildPrompt, buildRepairPrompt } from "./prompt.js";
import { agentOutputSchema, type AgentOutput } from "./schema.js";
import { createReadTools } from "./tools.js";
import type { PrContext, Slice } from "./types.js";
import { validateSlices } from "./validate.js";

export const DEFAULT_MODEL = "claude-opus-5";
const DEFAULT_MAX_STEPS = 40;
const DEFAULT_REPAIRS = 2;

/**
 * Rough prompt ceiling, in tokens, leaving room for tool results and the
 * output. Checked before the call so an oversized diff reports its own size
 * rather than surfacing a provider error about a number nobody can act on.
 */
const MAX_PROMPT_TOKENS = 500_000;

const INSTRUCTIONS = `You break a pull request into slices: sets of changes that each accomplish one coherent thing, ordered from most to least central to what the PR is for.

## What you are given

The PR's title, description, and any linked Linear tickets, followed by the full diff. The diff is annotated: each hunk begins with a \`=== HUNK <id>\` line, and every line of that hunk's body carries two numbers. The first is the hunk-local line number, counting from 1 at the top of the hunk body and including context, added, and removed lines alike. The second is the line's position in the file at the PR's head, blank for removed lines.

You cite the first number. The second is only there so you can line the diff up against what \`read_file\` returns.

## Fragments

A hunk is one contiguous block of the diff, which makes it too coarse to assign directly: a newly added file arrives as a single hunk that may hold several unrelated things. So you assign **fragments** — contiguous runs of hunk-local lines — to slices instead. A fragment is \`{hunkId, startLine, endLine}\`, and a slice holds as many fragments as it needs, from as many hunks as it needs.

Two rules govern this, and both are checked mechanically:

1. **Every added and removed line must be in exactly one fragment.** Not zero, not two. If a change is boring, put it in a low-ranked slice — do not leave it out.
2. **Fragments must not overlap**, within a slice or across slices.

Context lines (the ones with a leading space) do not have to be covered, but a fragment may span them freely when the run of changes it describes is interrupted by one.

## Doing the work

Read the description and the tickets first: they tell you what the PR is *for*, which is what the ordering depends on. Then read the diff.

Where the diff alone does not tell you whether something is central or incidental, look. Use \`read_file\` to see the function a changed line calls, the interface it implements, or the test that exercises it. Use \`search\` to find a symbol's other call sites. A change that looks mechanical often turns out to be load-bearing, and a change that looks substantial often turns out to be a rename with a wide blast radius. Spend your tool calls resolving exactly those questions.

## Ordering

Rank by this test: if this slice were reverted and everything else kept, how much of the PR's stated purpose would be lost? The change that defeats the PR's purpose entirely goes first.

That usually puts the new behavior or the core fix at the top; the supporting changes it needs to work below it; then tests, then the mechanical fallout — renames, import updates, formatting, generated files, lockfiles — at the bottom. Follow the actual PR rather than the template: in a refactor, the mechanical change *is* the point and belongs first.

## Slice size

Aim for the granularity a reviewer would want to read in one sitting: enough slices that each has a single subject, few enough that the first two or three genuinely carry the PR. A one-line PR is one slice. Resist splitting a coherent change across slices just because it spans several files, and resist collecting unrelated changes into a "miscellaneous" slice when they have distinct subjects.

Set \`target\` when one function is clearly what a slice is about — it becomes the entry point for a call-graph walk. Leave it off when no single function stands out. Do not guess.`;

export interface SliceAgentOptions {
  model?: string;
  maxSteps?: number;
  /** How many times to hand validation errors back for repair. */
  maxRepairs?: number;
  onProgress?: (message: string) => void;
}

/**
 * Run the slicing agent over one PR, repairing the output until its slices
 * partition the diff or the repair budget runs out.
 */
export async function runSliceAgent(
  context: PrContext,
  index: DiffIndex,
  options: SliceAgentOptions = {},
): Promise<{ overview: string; slices: Slice[]; model: string }> {
  const modelId = options.model ?? process.env.DEEP_REVIEW_MODEL ?? DEFAULT_MODEL;
  const report = options.onProgress ?? (() => {});

  const agent = new ToolLoopAgent({
    model: anthropic(modelId),
    instructions: INSTRUCTIONS,
    tools: createReadTools({
      headDir: context.headDir,
      baseDir: context.baseDir,
    }),
    stopWhen: isStepCount(options.maxSteps ?? DEFAULT_MAX_STEPS),
    output: Output.object({ schema: agentOutputSchema }),
  });

  const prompt = buildPrompt(context, index);
  const estimatedTokens = Math.ceil(prompt.length / 4);
  if (estimatedTokens > MAX_PROMPT_TOKENS) {
    throw new Error(
      `The diff is too large to slice in one pass: ~${estimatedTokens.toLocaleString()} tokens of prompt ` +
        `(${index.changedLineCount.toLocaleString()} changed lines across ${index.hunks.length} hunks) ` +
        `against a ceiling of ${MAX_PROMPT_TOKENS.toLocaleString()}. ` +
        `Check that the diff is what you expect — a vendored directory or a generated file can dominate it.`,
    );
  }
  report(`Prompt is ~${estimatedTokens.toLocaleString()} tokens.`);

  let result = await agent.generate({ prompt });
  let output = result.output;
  report(`Agent proposed ${output.slices.length} slices.`);

  const maxRepairs = options.maxRepairs ?? DEFAULT_REPAIRS;
  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    const validation = validateSlices(output, index);
    if (validation.ok) {
      return { overview: output.overview, slices: validation.slices, model: modelId };
    }
    if (attempt === maxRepairs) {
      throw new Error(
        [
          `The agent's slices still did not partition the diff after ${maxRepairs} repair attempts:`,
          ...validation.errors.map((e) => `  - ${e}`),
        ].join("\n"),
      );
    }
    report(
      `Slices did not partition the diff (${validation.errors.length} problems); asking for a repair.`,
    );
    result = await agent.generate({
      prompt: `${prompt}\n\n---\n\n${buildRepairPrompt(output, validation.errors)}`,
    });
    output = result.output;
  }

  throw new Error("unreachable");
}
