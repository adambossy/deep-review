import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentLabel,
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
  // An explicit label, not agentLabel()'s default: this suite should not
  // depend on whatever $DEEP_REVIEW_HOME happens to be at collection time.
  const plist = renderAgentPlist({
    programArguments: ["/usr/local/bin/node", "/opt/cli.js", "watch", "--foreground"],
    logFile: "/tmp/watcher.log",
    label: "com.deep-review.watcher.test",
  });

  it("names the agent and every argument", () => {
    expect(plist).toContain("<string>com.deep-review.watcher.test</string>");
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

  it("carries its own state dir, so the spawned process can find its env file", () => {
    // launchd starts the agent with none of this shell's environment, so
    // without this, loadWatcherEnv's very first lookup — where is my own
    // watcher.env? — falls back to the default state dir and reads THAT
    // one's files instead of this agent's, silently.
    const scoped = renderAgentPlist({
      programArguments: ["/bin/node", "/opt/cli.js"],
      logFile: "/tmp/w.log",
      stateDir: "/Users/x/.deep-review-test",
    });
    expect(scoped).toContain("<key>EnvironmentVariables</key>");
    expect(scoped).toContain("<key>DEEP_REVIEW_HOME</key>");
    expect(scoped).toContain("<string>/Users/x/.deep-review-test</string>");
  });

  it("omits EnvironmentVariables when no state dir is given", () => {
    const plain = renderAgentPlist({
      programArguments: ["/bin/node", "/opt/cli.js"],
      logFile: "/tmp/w.log",
    });
    expect(plain).not.toContain("EnvironmentVariables");
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

describe("agentLabel", () => {
  const defaultHome = path.join(os.homedir(), ".deep-review");
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "agent-label-test-"));
  });

  afterEach(() => {
    delete process.env.DEEP_REVIEW_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it("keeps the bare label for the default state dir", () => {
    // The real, currently-running agent on this machine was installed
    // under that label; changing it here would orphan that agent.
    process.env.DEEP_REVIEW_HOME = defaultHome;
    expect(agentLabel()).toBe("com.deep-review.watcher");
  });

  it("gives a non-default state dir a label — and plist — of its own", () => {
    // Sharing a label across two state dirs means whichever installs last
    // silently owns the other's agent, argv, log file and secrets — the
    // exact failure a test suite pointing DEEP_REVIEW_HOME at a temp dir
    // would otherwise risk against the real installed agent.
    process.env.DEEP_REVIEW_HOME = home;
    const label = agentLabel();
    expect(label).not.toBe("com.deep-review.watcher");
    expect(label.startsWith("com.deep-review.watcher.")).toBe(true);
  });

  it("is deterministic for the same state dir", () => {
    process.env.DEEP_REVIEW_HOME = home;
    expect(agentLabel()).toBe(agentLabel());
  });

  it("differs between two different state dirs", () => {
    const other = mkdtempSync(path.join(os.tmpdir(), "agent-label-test-"));
    try {
      process.env.DEEP_REVIEW_HOME = home;
      const first = agentLabel();
      process.env.DEEP_REVIEW_HOME = other;
      const second = agentLabel();
      expect(first).not.toBe(second);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
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
