export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

const PR_URL = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/;

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
