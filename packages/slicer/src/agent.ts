import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { createXai } from "@ai-sdk/xai";
import { isStepCount, Output, ToolLoopAgent } from "ai";
import type { DiffIndex } from "./annotate.js";
import { buildPrompt, buildRepairPrompt } from "./prompt.js";
import { agentOutputSchema, type AgentOutput } from "./schema.js";
import { createReadTools } from "./tools.js";
import type { PrContext, Slice } from "./types.js";
import { validateSlices } from "./validate.js";

export const DEFAULT_MODEL = "gpt-5.6-sol";
const DEFAULT_MAX_STEPS = 40;
const DEFAULT_REPAIRS = 2;

export type ReasoningEffort = "medium" | "high" | "xhigh";
const DEFAULT_EFFORT: ReasoningEffort = "xhigh";

/**
 * Picks the AI SDK provider by model id prefix and, where the provider
 * supports it, sets its reasoning-effort knob. Each provider names this
 * option differently (`effort` for Anthropic, `reasoningEffort` for OpenAI
 * and xAI), so the mapping lives here rather than at call sites.
 */
function resolveModel(modelId: string, effort?: ReasoningEffort) {
  if (modelId.startsWith("gpt-")) {
    return {
      model: openai.responses(modelId),
      providerOptions: {
        openai: {
          // The slicer's schema marks fields like `target` as optional, which
          // the strict structured-output mode OpenAI otherwise defaults to
          // rejects (it requires every property to be listed in `required`).
          strictJsonSchema: false,
          ...(effort ? { reasoningEffort: effort } : {}),
        },
      },
    };
  }
  if (modelId.startsWith("grok-")) {
    const apiKey = process.env.XAI_API_KEY ?? process.env.GROK_API_KEY;
    const xai = createXai(apiKey ? { apiKey } : {});
    return {
      model: xai(modelId),
      providerOptions: effort ? { xai: { reasoningEffort: effort } } : undefined,
    };
  }
  return {
    model: anthropic(modelId),
    providerOptions: effort ? { anthropic: { effort } } : undefined,
  };
}

/**
 * The environment variables a given model id can take its API key from, for
 * CLI preflight checks — any one of them satisfies the requirement.
 */
export function apiKeyEnvVars(modelId: string): string[] {
  if (modelId.startsWith("gpt-")) return ["OPENAI_API_KEY"];
  if (modelId.startsWith("grok-")) return ["XAI_API_KEY", "GROK_API_KEY"];
  return ["ANTHROPIC_API_KEY"];
}

/** Whether any of the model's acceptable API key env vars is set. */
export function hasApiKeyForModel(modelId: string): boolean {
  return apiKeyEnvVars(modelId).some((name) => Boolean(process.env[name]));
}

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
  /** Reasoning effort, where the resolved provider supports it. */
  effort?: ReasoningEffort;
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
): Promise<{ overview: string; slices: Slice[]; model: string; llmMs: number }> {
  const modelId = options.model ?? process.env.DEEP_REVIEW_MODEL ?? DEFAULT_MODEL;
  const report = options.onProgress ?? (() => {});
  const { model, providerOptions } = resolveModel(modelId, options.effort ?? DEFAULT_EFFORT);
  let llmMs = 0;

  const agent = new ToolLoopAgent({
    model,
    instructions: INSTRUCTIONS,
    tools: createReadTools({
      headDir: context.headDir,
      baseDir: context.baseDir,
    }),
    stopWhen: isStepCount(options.maxSteps ?? DEFAULT_MAX_STEPS),
    output: Output.object({ schema: agentOutputSchema }),
    ...(providerOptions ? { providerOptions } : {}),
  });

  // Streamed (rather than a single blocking generate() call) so long real-world
  // runs show live progress — reasoning and tool-call activity — instead of
  // going dark for the whole call.
  const timedGenerate = async (args: { prompt: string }): Promise<{ output: AgentOutput }> => {
    const start = performance.now();
    let step = 0;
    let reasoningChars = 0;
    let lastHeartbeat = start;
    try {
      const stream = await agent.stream({
        prompt: args.prompt,
        onStepFinish: (event: { toolCalls?: { toolName: string }[] }) => {
          step += 1;
          const elapsed = ((performance.now() - start) / 1000).toFixed(1);
          const calls =
            event.toolCalls?.map((c) => c.toolName).join(", ") || "(no tool calls)";
          report(`  step ${step} (${elapsed}s elapsed): ${calls}`);
        },
      });
      for await (const part of stream.fullStream) {
        if (part.type === "reasoning-delta") {
          reasoningChars += part.text?.length ?? 0;
          const now = performance.now();
          if (now - lastHeartbeat > 15_000) {
            lastHeartbeat = now;
            report(
              `    ...thinking (${((now - start) / 1000).toFixed(0)}s elapsed, ~${reasoningChars.toLocaleString()} reasoning chars so far)`,
            );
          }
        } else if (part.type === "tool-call") {
          report(
            `    tool-call: ${part.toolName} (${((performance.now() - start) / 1000).toFixed(1)}s elapsed)`,
          );
        } else if (part.type === "error") {
          report(`    stream error: ${String((part as { error?: unknown }).error)}`);
        }
      }
      const output = (await stream.output) as AgentOutput;
      return { output };
    } finally {
      llmMs += performance.now() - start;
    }
  };

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

  let result = await timedGenerate({ prompt });
  let output = result.output;
  report(`Agent proposed ${output.slices.length} slices.`);

  const maxRepairs = options.maxRepairs ?? DEFAULT_REPAIRS;
  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    const validation = validateSlices(output, index);
    if (validation.ok) {
      return { overview: output.overview, slices: validation.slices, model: modelId, llmMs };
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
    result = await timedGenerate({
      prompt: `${prompt}\n\n---\n\n${buildRepairPrompt(output, validation.errors)}`,
    });
    output = result.output;
  }

  throw new Error("unreachable");
}
