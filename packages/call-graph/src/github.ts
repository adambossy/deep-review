import type { PrRef } from "./prUrl.js";

export interface PrInfo extends PrRef {
  title: string;
  baseRef: string;
  baseSha: string;
  headSha: string;
  cloneUrl: string;
}

interface PrApiResponse {
  title: string;
  base: { ref: string; sha: string; repo: { clone_url: string } };
  head: { sha: string };
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
    baseRef: pr.base.ref,
    baseSha: pr.base.sha,
    headSha: pr.head.sha,
    cloneUrl: pr.base.repo.clone_url,
  };
}
