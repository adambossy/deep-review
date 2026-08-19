import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PrInfo } from "./github.js";

export interface Checkouts {
  /** Working tree at the merge base — the PR's "before". */
  baseDir: string;
  /** Working tree at the PR's head commit. */
  headDir: string;
  /**
   * The commit the PR branched from: `git merge-base baseSha headSha`, not
   * `baseSha` itself. GitHub reports `base.sha` as the current tip of the base
   * branch, so on a branch that has fallen behind, diffing against it pulls in
   * every unrelated commit that landed on the base since. This is the commit
   * GitHub's own "Files changed" compares against.
   */
  mergeBaseSha: string;
  /** `git diff mergeBase head` output. */
  diffText: string;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
}

export function defaultWorkDir(info: PrInfo): string {
  return path.join(
    os.tmpdir(),
    "deep-review",
    `${info.owner}-${info.repo}-pr${info.number}`,
  );
}

function ensureWorktree(repoDir: string, dir: string, sha: string): void {
  if (existsSync(dir)) {
    const current = git(["rev-parse", "HEAD"], dir).trim();
    if (current === sha) return;
    git(["worktree", "remove", "--force", dir], repoDir);
  }
  git(["worktree", "add", "--detach", dir, sha], repoDir);
}

/**
 * Clone (blob-less, cached under workDir) and materialize base + head
 * worktrees for the PR, plus the diff between them.
 */
export function prepareCheckouts(info: PrInfo, workDir?: string): Checkouts {
  const root = workDir ?? defaultWorkDir(info);
  mkdirSync(root, { recursive: true });
  const repoDir = path.join(root, "repo");

  if (!existsSync(repoDir)) {
    git(
      ["clone", "--filter=blob:none", "--no-checkout", info.cloneUrl, repoDir],
      root,
    );
  }

  try {
    git(["fetch", "--force", "origin", info.baseSha, info.headSha], repoDir);
  } catch {
    // Some servers refuse fetching bare SHAs; the base branch and the PR
    // head ref together are guaranteed to contain both commits.
    git(
      ["fetch", "--force", "origin", info.baseRef, `refs/pull/${info.number}/head`],
      repoDir,
    );
  }

  const mergeBaseSha = git(
    ["merge-base", info.baseSha, info.headSha],
    repoDir,
  ).trim();

  const baseDir = path.join(root, "base");
  const headDir = path.join(root, "head");
  ensureWorktree(repoDir, baseDir, mergeBaseSha);
  ensureWorktree(repoDir, headDir, info.headSha);

  const diffText = git(
    ["diff", "--unified=3", mergeBaseSha, info.headSha],
    repoDir,
  );

  return { baseDir, headDir, mergeBaseSha, diffText };
}
