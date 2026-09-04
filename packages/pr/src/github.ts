import type { PrRef } from "./prUrl.js";

export interface PrInfo extends PrRef {
  title: string;
  /** The PR description, as authored. Empty when the PR has no body. */
  body: string;
  author: string;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  cloneUrl: string;
  htmlUrl: string;
  /** Open, or closed — where "closed" covers merged too; see `merged`. */
  state: "open" | "closed";
  /** True only for a PR that was merged; a closed-unmerged PR is `closed` and false. */
  merged: boolean;
}

interface PrApiResponse {
  title: string;
  body: string | null;
  html_url: string;
  state: "open" | "closed";
  merged: boolean;
  user: { login: string } | null;
  base: { ref: string; sha: string; repo: { clone_url: string } };
  head: { ref: string; sha: string };
}

/** Fetch PR metadata. Uses GITHUB_TOKEN / GH_TOKEN when set (needed for private repos). */
export async function fetchPrInfo(ref: PrRef): Promise<PrInfo> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const res = await fetch(
    `https://api.github.com/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    },
  );
  if (!res.ok) {
    throw new Error(
      `GitHub API returned ${res.status} for ${ref.owner}/${ref.repo}#${ref.number}` +
        (res.status === 404 && !token
          ? " (private repo? set GITHUB_TOKEN)"
          : ""),
    );
  }
  const pr = (await res.json()) as PrApiResponse;
  return {
    ...ref,
    title: pr.title,
    body: pr.body ?? "",
    author: pr.user?.login ?? "",
    baseRef: pr.base.ref,
    baseSha: pr.base.sha,
    headRef: pr.head.ref,
    headSha: pr.head.sha,
    cloneUrl: pr.base.repo.clone_url,
    htmlUrl: pr.html_url,
    state: pr.state,
    merged: pr.merged,
  };
}

/** One open PR assigned to the authenticated user, as the search API reports it. */
export interface AssignedPr extends PrRef {
  title: string;
  htmlUrl: string;
  /** When the PR was last touched, ISO 8601 — the watcher's re-dispatch signal. */
  updatedAt: string;
  draft: boolean;
}

interface SearchResponse {
  items: {
    number: number;
    title: string;
    html_url: string;
    updated_at: string;
    draft?: boolean;
    /** `https://api.github.com/repos/<owner>/<repo>` — the only place the search result names the repo. */
    repository_url: string;
  }[];
}

const REPO_URL = /\/repos\/([^/]+)\/([^/]+)$/;

export interface AssignedPrQuery {
  /** Limit to one `owner/repo`. Without it, every repo the token can see. */
  repo?: string | undefined;
}

/**
 * The search for "PRs waiting on me", as GitHub spells it.
 *
 * Assigned and open is not the same as needing review, and the difference is
 * most of the list: a draft is not ready to be read, and one already approved
 * has been read. Both are excluded, so what comes back is work outstanding
 * rather than everything with your name on it.
 */
export function assignedPrsQuery(options: AssignedPrQuery = {}): string {
  return [
    "is:open",
    "is:pr",
    "assignee:@me",
    "archived:false",
    // Ready to review, and not yet signed off.
    "-is:draft",
    "-review:approved",
    ...(options.repo ? [`repo:${options.repo}`] : []),
  ].join(" ");
}

/**
 * The open PRs waiting on the token's owner for review.
 *
 * This asks for *state*, not for events: every call reports the full set, so
 * a caller that has been asleep for a night catches up on one poll and needs
 * no cursor arithmetic to do it. Requires a token — `assignee:@me` has no
 * meaning without one.
 */
export async function listAssignedPrs(
  options: AssignedPrQuery = {},
): Promise<AssignedPr[]> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not set; it is needed to find your assigned PRs.");
  const query = encodeURIComponent(assignedPrsQuery(options));
  const res = await fetch(`https://api.github.com/search/issues?q=${query}&per_page=100`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub search returned ${res.status}`);
  }
  const body = (await res.json()) as SearchResponse;
  const prs: AssignedPr[] = [];
  for (const item of body.items) {
    const match = REPO_URL.exec(item.repository_url);
    // A result whose repo we cannot name is one we could never build; skip
    // it rather than failing the whole poll over one odd row.
    if (!match) continue;
    prs.push({
      owner: match[1]!,
      repo: match[2]!,
      number: item.number,
      title: item.title,
      htmlUrl: item.html_url,
      updatedAt: item.updated_at,
      draft: item.draft ?? false,
    });
  }
  return prs;
}
