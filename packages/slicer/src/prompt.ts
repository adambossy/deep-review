import type { DiffIndex } from "./annotate.js";
import { renderAnnotatedDiff } from "./annotate.js";
import type { AgentOutput } from "./schema.js";
import type { PrContext } from "./types.js";

function ticketSection(context: PrContext): string {
  if (context.tickets.length === 0) return "No linked Linear tickets.";
  return context.tickets
    .map((t) =>
      [
        `### ${t.identifier}: ${t.title} (${t.state})`,
        t.url,
        t.description || "(no description)",
      ].join("\n"),
    )
    .join("\n\n");
}

/** The whole PR as one prompt: what it is for, then what it changed. */
export function buildPrompt(context: PrContext, index: DiffIndex): string {
  const { info } = context;
  const files = new Set(index.hunks.map((h) => h.file)).size;
  return [
    `# Pull request`,
    `${info.owner}/${info.repo}#${info.number} — ${info.title}`,
    `Opened by ${info.author || "unknown"}, merging ${info.headRef} into ${info.baseRef}.`,
    ``,
    `## Description`,
    info.body.trim() || "(no description)",
    ``,
    `## Linked tickets`,
    ticketSection(context),
    ``,
    `## Diff`,
    `${index.hunks.length} hunks across ${files} files, ${index.changedLineCount} changed lines.`,
    ``,
    renderAnnotatedDiff(index),
  ].join("\n");
}

/** Hands validation failures back to the agent with its own output attached. */
export function buildRepairPrompt(
  previous: AgentOutput,
  errors: string[],
): string {
  return [
    `Your slices did not partition the diff. These problems were found:`,
    ``,
    ...errors.map((e) => `- ${e}`),
    ``,
    `Here is what you returned:`,
    ``,
    "```json",
    JSON.stringify(previous, null, 2),
    "```",
    ``,
    `Return the corrected result. Keep the slices and the ordering you chose — adjust only the fragment bounds needed to fix the problems above, adding a slice only if some uncovered change genuinely has no home in the existing ones.`,
  ].join("\n");
}
