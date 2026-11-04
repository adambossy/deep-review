import { isStepCount, ToolLoopAgent } from "ai";
import { resolveModel, streamWithProgress, type ReasoningEffort } from "./agent.js";
import type { DiffIndex } from "./annotate.js";
import { buildPrompt } from "./prompt.js";
import { createReadTools } from "./tools.js";
import type { PrContext, Slice } from "./types.js";

/*
 * A port of pstack's `/how` skill: explorers trace separate angles of the
 * change in parallel, then one explainer reconciles their findings into an
 * architectural walkthrough. The prompts below are the skill's
 * `references/explorer-prompt.md` and `references/explainer-prompt.md`,
 * adapted to this agent's read tools and to the Markdown the explorer page
 * renders (no mermaid, no tables).
 *
 * The skill splits the question into angles itself; here the slicer already
 * has, so the top slices are the angles.
 */

const MAX_EXPLORERS = 4;
const EXPLORER_STEPS = 30;
const EXPLAINER_STEPS = 20;

const TOOLS_NOTE = `You have read-only tools over the repository at the PR's head (and its base, for code the PR removed): read_file, search, and list_directory.`;

const EXPLORER_INSTRUCTIONS = `Other explorers are investigating different slices of the same change in parallel. Don't try to cover everything. Focus on your assigned angle and go deep.

${TOOLS_NOTE}

## Output

### Components Found
The key types, services, classes, and abstractions. For each: name, file path, and a one-sentence description of what it does.

### Flow
The execution flow step by step. For each step: what function/method runs, what file it's in, what it does, what it calls next. Include the data that flows between steps.

### Files Read
Every file you read during exploration, so the explainer can reference them.

### Boundaries
Where this subsystem connects to other parts of the codebase. The inputs and outputs.

### Non-Obvious Things
Anything surprising, historically motivated, or easy to get wrong. Things that look like they should work one way but work another.

### Open Questions
Anything you couldn't fully trace or understand. Be honest about gaps.`;

const EXPLAINER_OUTPUT = `## Output Format

Use this structure, adapted to what makes sense for the question. Not every section is needed for every question. Write each section as a \`##\` heading.

### Overview
1-2 paragraphs. What is this thing, what does it do, why does it exist. Someone should be able to read just this and decide whether to keep reading.

### Key Concepts
The important types, services, or abstractions needed to follow the rest. Brief definitions, not exhaustive.

### How It Works
The core of the explanation, and the longest section. Walk through the flow: what triggers it, what happens step by step, where data goes, what the decision points are.

Use prose, not pseudocode. Reference specific files and functions so the reader knows where to look, but don't dump large code blocks unless a snippet is essential to a point.

When the flow involves multiple components talking to each other, or data transforming through stages, include an ASCII diagram in a fenced code block. The page this is shown on does not render mermaid or tables, so use neither. A diagram should clarify, not decorate. If prose covers the flow, skip the diagram.

### Where Things Live
A brief file/directory map. Just the ones someone would need to start working here.

### Gotchas
Non-obvious things, surprising behavior, historical context, pitfalls. Skip this section if there's nothing worth calling out.

## Communication Style

- Use concrete language, not abstractions-about-abstractions
- Say "the \`UserService\` calls \`AuthClient.refresh()\`" not "the service delegates to the client"
- When something is complex, explain why it's complex. Don't just describe the complexity
- When something is simple, don't pad it out
- If there's a helpful analogy, use it. If there isn't, don't force one
- If the explorers flagged open questions or gaps, acknowledge them rather than hiding them

Reply with the explanation alone, as Markdown, with no preamble.`;

const EXPLAINER_PREAMBLE = `You are writing an architectural explanation for a senior engineer.`;

const EXPLAINER_GOAL = `Write an explanation a senior engineer unfamiliar with this area could read and walk away with a solid mental model, understanding the architecture well enough to start working in it confidently.`;

/** The skill's simple path: one agent explores and explains in one pass. */
const SOLO_INSTRUCTIONS = `${EXPLAINER_PREAMBLE} Explore the code yourself, then write one coherent, well-structured explanation.

${EXPLAINER_GOAL}

${TOOLS_NOTE}

${EXPLAINER_OUTPUT}`;

const SYNTHESIS_INSTRUCTIONS = `${EXPLAINER_PREAMBLE} Multiple explorer agents have traced different slices of the codebase in parallel and gathered findings. Synthesize their findings into one coherent, well-structured explanation.

The explorers each investigated a different angle of the same change. Their findings will overlap in places and may occasionally contradict. Reconcile them. Merge overlapping descriptions, resolve contradictions by checking the code yourself, and combine the separate slices into a unified picture.

${EXPLAINER_GOAL}

${TOOLS_NOTE} Use them to check anything, clarify a detail, or fill a gap. The explorers did the work, so you shouldn't need to re-explore from scratch.

${EXPLAINER_OUTPUT}`;

function question(context: PrContext): string {
  const { info } = context;
  return `How does ${info.owner}/${info.repo}#${info.number} work? Explain what the change does and how the code it touches fits together once it lands, so a reviewer can build a mental model before reading the diff.`;
}

function angle(slice: Slice): string {
  const files = [...new Set(slice.fragments.map((f) => f.file))];
  return [
    `**${slice.title}** — ${slice.summary}`,
    ``,
    `Files: ${files.join(", ")}`,
    ...(slice.target ? [`Centered on \`${slice.target.name}\` in ${slice.target.file}.`] : []),
  ].join("\n");
}

export interface ExplainOptions {
  model: string;
  effort?: ReasoningEffort;
  onProgress?: (message: string) => void;
}

/**
 * The "How it works" walkthrough of one PR, as Markdown. A PR the slicer
 * read as a single change takes the skill's simple path; anything larger
 * gets one explorer per top slice before the explainer writes it up.
 */
export async function explainPr(
  context: PrContext,
  index: DiffIndex,
  slices: Slice[],
  options: ExplainOptions,
): Promise<string> {
  const report = options.onProgress ?? (() => {});
  const { model, providerOptions } = resolveModel(options.model, options.effort);
  const tools = createReadTools({ headDir: context.headDir, baseDir: context.baseDir });
  const run = async (
    label: string,
    instructions: string,
    prompt: string,
    steps: number,
  ): Promise<string> => {
    const agent = new ToolLoopAgent({
      model,
      instructions,
      tools,
      stopWhen: isStepCount(steps),
      ...(providerOptions ? { providerOptions } : {}),
    });
    const stream = await streamWithProgress(
      (onStepFinish) => agent.stream({ prompt, onStepFinish }),
      (message) => report(`[${label}]${message}`),
    );
    return (await stream.text).trim();
  };

  const pr = buildPrompt(context, index);
  const q = `## Question\n\n> ${question(context)}`;

  let markdown: string;
  if (slices.length <= 1) {
    report("How it works: one explainer (single-slice PR).");
    markdown = await run("explainer", SOLO_INSTRUCTIONS, `${q}\n\n${pr}`, EXPLAINER_STEPS + EXPLORER_STEPS);
  } else {
    const angles = slices.slice(0, MAX_EXPLORERS);
    report(`How it works: ${angles.length} explorers, then an explainer.`);
    const findings = await Promise.all(
      // The shared PR prompt leads so parallel explorers can reuse a cached prefix.
      angles.map((s, i) =>
        run(`explorer ${i + 1}`, EXPLORER_INSTRUCTIONS, `${pr}\n\n${q}\n\n## Your Exploration Angle\n\n${angle(s)}`, EXPLORER_STEPS),
      ),
    );
    const all = findings.map((f, i) => `### Explorer ${i + 1}: ${angles[i]!.title}\n\n${f}`).join("\n\n");
    markdown = await run("explainer", SYNTHESIS_INSTRUCTIONS, `${q}\n\n## Explorer Findings\n\n${all}\n\n${pr}`, EXPLAINER_STEPS);
  }
  if (!markdown) throw new Error("The explainer returned no text.");
  return markdown;
}
