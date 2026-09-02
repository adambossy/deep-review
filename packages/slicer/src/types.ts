import type { LinearIssue, PrInfo } from "@deep-review/pr";

/**
 * A stable address for one hunk: its head-side path (base-side for deleted
 * files) and its 0-based index among that file's hunks — e.g.
 * `src/report.ts#2`.
 */
export type HunkId = string;

/**
 * A contiguous run of lines inside one hunk, and the unit a slice is built
 * from. Hunks are too coarse to assign: a newly added file is a single hunk
 * that may serve several unrelated purposes. Fragments cut it finer.
 */
export interface Fragment {
  /**
   * `<hunkId>@<startLine>-<endLine>` — e.g. `src/report.ts#2@14-31`. Derived,
   * so the same fragment of the same PR always gets the same id.
   */
  id: string;
  hunkId: HunkId;
  /** Head-side path, or the base-side path when the file was deleted. */
  file: string;
  /**
   * Inclusive 1-based bounds within the hunk body, counting every line the
   * hunk carries — context, additions, and deletions alike. These are the
   * numbers shown in the annotated diff handed to the model.
   */
  startLine: number;
  endLine: number;
  /** What this run of lines does, in the model's words. */
  summary: string;
}

/**
 * A set of fragments that together accomplish one coherent change. Slices
 * partition the PR: every changed line belongs to exactly one slice.
 */
export interface Slice {
  /** `slice-1`, `slice-2`, … in priority order. */
  id: string;
  title: string;
  /** What this change does and why the PR needs it. */
  summary: string;
  /** Why it sits at this rank — what makes it more or less central. */
  rationale: string;
  /**
   * The function this slice is most about, when one stands out. The seam to
   * the call-graph tool: this is the target to walk.
   */
  target?: {
    file: string;
    name: string;
  };
  fragments: Fragment[];
}

/** Everything the slicing run produced, and enough context to interpret it. */
export interface SliceReport {
  pr: {
    url: string;
    owner: string;
    repo: string;
    number: number;
    title: string;
    /** The PR description as authored, Markdown and all. Empty when it has none. */
    description: string;
    /** The PR's author, as a GitHub login. Empty when GitHub reports none. */
    author: string;
    /** The tip of the base branch, as GitHub reports it. */
    baseSha: string;
    /** The commit the PR branched from; the diff's "before". */
    mergeBaseSha: string;
    headSha: string;
  };
  /** Linear tickets referenced by the PR that resolved to real issues. */
  tickets: LinearIssue[];
  /** The model's one-paragraph read of what the PR as a whole is doing. */
  overview: string;
  /** Ordered most to least central to the PR's purpose. */
  slices: Slice[];
  model: string;
  generatedAt: string;
}

export interface PrContext {
  info: PrInfo;
  tickets: LinearIssue[];
  /** Base and head worktrees the read tools are scoped to. */
  baseDir: string;
  headDir: string;
  /** The commit baseDir is checked out at. */
  mergeBaseSha: string;
  diffText: string;
}
