import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PrInfo } from "./github.js";

export interface Checkouts {
  /** Working tree at the PR's base commit. */
  baseDir: string;
  /** Working tree at the PR's head commit. */
  headDir: string;
  /** `git diff base head` output. */
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
    "deep-review-call-graph",
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

  const baseDir = path.join(root, "base");
  const headDir = path.join(root, "head");
  ensureWorktree(repoDir, baseDir, info.baseSha);
  ensureWorktree(repoDir, headDir, info.headSha);

  const diffText = git(
    ["diff", "--unified=3", info.baseSha, info.headSha],
    repoDir,
  );

  return { baseDir, headDir, diffText };
}
