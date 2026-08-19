export {
  slicePr,
  buildSlicePrompt,
  loadRenderEntry,
  writeSliceReport,
  defaultOutFile,
  type SliceOptions,
} from "./slice.js";
export { renderSliceReportsHtml, type RenderEntry } from "./html.js";
export { buildPrompt, buildRepairPrompt } from "./prompt.js";
export { runSliceAgent, DEFAULT_MODEL, type SliceAgentOptions } from "./agent.js";
export {
  indexDiff,
  renderAnnotatedDiff,
  type DiffIndex,
  type IndexedHunk,
} from "./annotate.js";
export { validateSlices, type ValidationResult } from "./validate.js";
export {
  agentOutputSchema,
  agentSliceSchema,
  agentFragmentSchema,
  type AgentOutput,
} from "./schema.js";
export type * from "./types.js";
