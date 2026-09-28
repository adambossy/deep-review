import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isTransientGitError, prepareCheckouts } from "./git.js";
import type { PrInfo } from "./github.js";

describe("isTransientGitError", () => {
  it("recognizes GitHub dropping a pack download", () => {
    expect(
      isTransientGitError({
        stderr:
          "error: RPC failed; curl 56 Recv failure: Connection reset by peer\nfatal: early EOF\nfatal: fetch-pack: invalid index-pack output",
      }),
    ).toBe(true);
    expect(
      isTransientGitError({
        stderr: "fatal: could not fetch f2e14ab26aad395ba84e0f004927a99ce10fd103 from promisor remote",
      }),
    ).toBe(true);
  });

  it("leaves real failures alone", () => {
    expect(isTransientGitError({ stderr: "fatal: invalid reference: deadbeef" })).toBe(false);
    expect(isTransientGitError(null)).toBe(false);
  });
});

describe("prepareCheckouts", () => {
  let scratch: string;
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  function sh(args: string[], cwd: string): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  }

  it("clones past a partial clone an earlier run left behind", () => {
    scratch = mkdtempSync(path.join(os.tmpdir(), "pr-git-"));
    const origin = path.join(scratch, "origin");
    mkdirSync(origin);
    sh(["init", "-q", "-b", "main"], origin);
    const commit = (text: string) => {
      writeFileSync(path.join(origin, "a.txt"), text);
      sh(["add", "."], origin);
      sh(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", text], origin);
      return sh(["rev-parse", "HEAD"], origin);
    };
    const baseSha = commit("one\n");
    const headSha = commit("two\n");

    const work = path.join(scratch, "work");
    mkdirSync(path.join(work, "repo.partial", ".git"), { recursive: true });

    const info: PrInfo = {
      owner: "o",
      repo: "r",
      number: 1,
      title: "t",
      body: "",
      author: "a",
      baseRef: "main",
      baseSha,
      headRef: "main",
      headSha,
      cloneUrl: `file://${origin}`,
      htmlUrl: "",
      state: "open",
      merged: false,
    };
    const checkouts = prepareCheckouts(info, work);

    expect(existsSync(path.join(work, "repo.partial"))).toBe(false);
    expect(checkouts.mergeBaseSha).toBe(baseSha);
    expect(checkouts.diffText).toContain("+two");
  });
});
