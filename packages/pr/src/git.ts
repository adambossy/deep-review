import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
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

/**
 * Whether a failed git command died of the network rather than of its
 * arguments: GitHub resetting a long pack download mid-stream is routine
 * for a repo this size, and trying again is the whole fix.
 */
export function isTransientGitError(error: unknown): boolean {
  const e = error as { stderr?: unknown; message?: unknown } | null;
  const text = `${String(e?.stderr ?? "")}\n${String(e?.message ?? "")}`;
  return /RPC failed|Connection reset|timed out|early EOF|unexpected disconnect|remote end hung up|Could not resolve host|from promisor remote|invalid index-pack output/i.test(
    text,
  );
}

const NETWORK_ATTEMPTS = 3;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run a git step that talks to the remote, again after a pause when it
 * fails for a network reason. `reset` undoes whatever a failed attempt left
 * half-done so the next one starts clean.
 */
function withNetworkRetry<T>(run: () => T, reset: () => void = () => {}): T {
  for (let attempt = 1; ; attempt++) {
    try {
      return run();
    } catch (error) {
      if (attempt >= NETWORK_ATTEMPTS || !isTransientGitError(error)) throw error;
      reset();
      sleepSync(2000 * attempt);
    }
  }
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
  // A blob-less clone downloads file contents here, so this is a network step.
  withNetworkRetry(
    () => git(["worktree", "add", "--detach", dir, sha], repoDir),
    () => {
      rmSync(dir, { recursive: true, force: true });
      git(["worktree", "prune"], repoDir);
    },
  );
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
    // Clone beside the cache and move it in only once whole: a clone cut
    // off midway must not leave a `repo/` that every later build trusts.
    const partialDir = `${repoDir}.partial`;
    const clear = () => rmSync(partialDir, { recursive: true, force: true });
    clear();
    withNetworkRetry(
      () =>
        git(
          ["clone", "--filter=blob:none", "--no-checkout", info.cloneUrl, partialDir],
          root,
        ),
      clear,
    );
    renameSync(partialDir, repoDir);
  }

  withNetworkRetry(() => {
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
  });

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
