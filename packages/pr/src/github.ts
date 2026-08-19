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
}

interface PrApiResponse {
  title: string;
  body: string | null;
  html_url: string;
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
  };
}
