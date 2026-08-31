export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

const PR_URL = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/;
const PR_NUMBER = /^#?(\d+)$/;
const REPO_SLUG = /^([^/\s]+)\/([^/\s]+)$/;

export function parsePrUrl(url: string): PrRef {
  const match = PR_URL.exec(url.trim());
  if (!match) {
    throw new Error(
      `Not a GitHub PR URL: ${url} (expected https://github.com/<owner>/<repo>/pull/<number>)`,
    );
  }
  const [, owner, repo, number] = match;
  return { owner: owner!, repo: repo!, number: Number(number!) };
}

/**
 * A PR URL, or a bare PR number (`10511`, `#10511`) against `defaultRepo`
 * ("owner/repo") — the number is only meaningful once a repo names it.
 */
export function parsePrTarget(target: string, defaultRepo?: string): PrRef {
  const trimmed = target.trim();
  const number = PR_NUMBER.exec(trimmed);
  if (!number) return parsePrUrl(trimmed);

  if (!defaultRepo) {
    throw new Error(
      `A PR number needs a repo: pass --repo <owner>/<repo>, set DEEP_REVIEW_REPO, or give the full PR URL.`,
    );
  }
  const slug = REPO_SLUG.exec(defaultRepo.trim());
  if (!slug) {
    throw new Error(`Not an <owner>/<repo> slug: ${defaultRepo}`);
  }
  const [, owner, repo] = slug;
  return { owner: owner!, repo: repo!, number: Number(number[1]!) };
}

export function prUrl(ref: PrRef): string {
  return `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`;
}
