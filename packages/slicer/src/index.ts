export {
  slicePr,
  prepare,
  buildSlicePrompt,
  loadRenderEntry,
  loadSliceReport,
  writeSliceReport,
  defaultOutFile,
  type SliceOptions,
} from "./slice.js";
export { renderSliceReportsHtml, type RenderEntry } from "./html.js";
export { buildPrompt, buildRepairPrompt } from "./prompt.js";
export {
  runSliceAgent,
  DEFAULT_MODEL,
  apiKeyEnvVars,
  hasApiKeyForModel,
  type SliceAgentOptions,
  type ReasoningEffort,
} from "./agent.js";
export {
  indexDiff,
  renderAnnotatedDiff,
  type DiffIndex,
  type IndexedHunk,
} from "./annotate.js";
export { validateSlices, type ValidationResult } from "./validate.js";
export {
  countDelta,
  fragmentDelta,
  fragmentTotals,
  reportTotals,
  type KindTotals,
  type LineDelta,
  type SizeTotals,
} from "./stats.js";
export { FRAGMENT_KINDS } from "./types.js";
export {
  agentOutputSchema,
  agentSliceSchema,
  agentFragmentSchema,
  type AgentOutput,
} from "./schema.js";
export type * from "./types.js";
