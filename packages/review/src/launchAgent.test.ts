import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_LABEL,
  captureEnv,
  inheritableExecArgv,
  transientPaths,
  watcherArgv,
  loadEnvFile,
  missingEnv,
  renderAgentPlist,
  watcherEnvFile,
  writeEnvFile,
} from "./launchAgent.js";

describe("renderAgentPlist", () => {
  const plist = renderAgentPlist({
    programArguments: ["/usr/local/bin/node", "/opt/cli.js", "watch", "--foreground"],
    logFile: "/tmp/watcher.log",
  });

  it("names the agent and every argument", () => {
    expect(plist).toContain(`<string>${AGENT_LABEL}</string>`);
    expect(plist).toContain("<string>/opt/cli.js</string>");
    expect(plist).toContain("<string>--foreground</string>");
  });

  it("restarts on a crash but not on a clean stop", () => {
    expect(plist).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/);
    expect(plist).toContain("<key>ThrottleInterval</key>");
  });

  it("starts itself at login", () => {
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
  });

  it("carries no secrets — the plist directory is world-readable", () => {
    const withSecrets = renderAgentPlist({
      programArguments: ["/bin/node", "/opt/cli.js"],
      logFile: "/tmp/w.log",
    });
    expect(withSecrets).not.toContain("OPENAI_API_KEY");
    expect(withSecrets).not.toContain("GITHUB_TOKEN");
    expect(withSecrets).not.toContain("EnvironmentVariables");
  });

  it("escapes a path that would otherwise break the XML", () => {
    const odd = renderAgentPlist({
      programArguments: ["/bin/node", "/opt/a&b/cli.js"],
      logFile: "/tmp/w.log",
    });
    expect(odd).toContain("/opt/a&amp;b/cli.js");
    expect(odd).not.toContain("/opt/a&b/cli.js");
  });
});

describe("captureEnv / missingEnv", () => {
  it("takes only the variables the watcher needs", () => {
    const captured = captureEnv({
      OPENAI_API_KEY: "sk-1",
      GITHUB_TOKEN: "gh-1",
      DEEP_REVIEW_REPO: "acme/widgets",
      UNRELATED: "no",
    });
    expect(captured).toEqual({
      OPENAI_API_KEY: "sk-1",
      GITHUB_TOKEN: "gh-1",
      DEEP_REVIEW_REPO: "acme/widgets",
    });
  });

  it("reports what would make an unattended run fail", () => {
    expect(missingEnv({})).toHaveLength(2);
    expect(missingEnv({ OPENAI_API_KEY: "sk-1" })).toEqual([
      "a GitHub token (GITHUB_TOKEN or GH_TOKEN)",
    ]);
    expect(missingEnv({ ANTHROPIC_API_KEY: "a", GH_TOKEN: "g" })).toEqual([]);
  });
});

describe("writeEnvFile", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "agent-test-"));
    process.env.DEEP_REVIEW_HOME = home;
  });

  afterEach(() => {
    delete process.env.DEEP_REVIEW_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it("is readable only by its owner", () => {
    const file = writeEnvFile({ OPENAI_API_KEY: "sk-secret" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("stays 0600 when rewritten over an existing file", () => {
    writeEnvFile({ OPENAI_API_KEY: "sk-1" });
    const file = writeEnvFile({ OPENAI_API_KEY: "sk-2" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("round-trips into a process that sources it", () => {
    writeEnvFile({ DEEP_REVIEW_REPO: "acme/widgets" });
    delete process.env.DEEP_REVIEW_REPO;
    loadEnvFile(watcherEnvFile());
    expect(process.env.DEEP_REVIEW_REPO).toBe("acme/widgets");
    delete process.env.DEEP_REVIEW_REPO;
  });

  it("leaves the environment alone when nothing was installed", () => {
    expect(() => loadEnvFile(path.join(home, "absent.env"))).not.toThrow();
  });
});

describe("inheritableExecArgv", () => {
  it("keeps the loader flags that make a .ts entry point runnable", () => {
    const argv = ["--require", "/x/preflight.cjs", "--import", "file:///x/loader.mjs"];
    expect(inheritableExecArgv(argv)).toEqual(argv);
  });

  it("drops --eval and the script it carries", () => {
    // Inheriting this would make launchd rerun this moment's script forever.
    expect(inheritableExecArgv(["--import", "/x.mjs", "--eval", "console.log(1)"])).toEqual([
      "--import",
      "/x.mjs",
    ]);
    expect(inheritableExecArgv(["--eval=console.log(1)", "--import", "/x.mjs"])).toEqual([
      "--import",
      "/x.mjs",
    ]);
  });

  it("drops the other flags that describe this invocation only", () => {
    expect(inheritableExecArgv(["-p", "1+1", "--interactive"])).toEqual([]);
  });
});

describe("watcherArgv", () => {
  it("reruns this CLI in the foreground at the asked interval", () => {
    const argv = watcherArgv(300_000);
    expect(argv.slice(-4)).toEqual(["watch", "--foreground", "--interval", "300"]);
  });

  it("carries no repo: the file decides, and can change without a reinstall", () => {
    // The scope used to ride in argv as --repo, and its absence meant every
    // repo the token could see. Now it lives only in watch.json, read each
    // poll — there is no argv the agent could be installed with that widens it.
    expect(watcherArgv(300_000)).not.toContain("--repo");
  });
});

describe("transientPaths", () => {
  it("spots a loader living inside a git worktree", () => {
    const found = transientPaths([
      "/usr/local/bin/node",
      "/Users/x/code/app/.claude/worktrees/wt/node_modules/tsx/loader.mjs",
      "watch",
    ]);
    expect(found).toHaveLength(1);
  });

  it("spots a temp dir", () => {
    expect(transientPaths(["/private/var/folders/ab/cd/T/cli.js"])).toHaveLength(1);
  });

  it("is happy with a normal checkout", () => {
    expect(
      transientPaths(["/usr/local/bin/node", "/Users/x/code/deep-review/packages/review/src/cli.ts"]),
    ).toEqual([]);
  });
});
