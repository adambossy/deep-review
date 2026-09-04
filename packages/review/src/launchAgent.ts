/**
 * Installing the watcher as a launchd agent — the part that makes `watch`
 * something you turn on once rather than something you remember to run.
 *
 * launchd is what survives the things a poll loop must survive: a reboot, a
 * closed lid, a crash. It is also a different world from a login shell —
 * nothing sources your profile there — so the secrets the watcher needs are
 * captured at install time. They go into a 0600 file under the state dir
 * rather than into the plist: `~/Library/LaunchAgents` is an ordinary
 * world-readable directory, and an API key does not belong in one.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { stateDir } from "./daemon.js";

export const AGENT_LABEL = "com.deep-review.watcher";

export function plistPath(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${AGENT_LABEL}.plist`);
}

export function watcherLogFile(): string {
  return path.join(stateDir(), "watcher.log");
}

/** The 0600 file the agent reads its environment from. */
export function watcherEnvFile(): string {
  return path.join(stateDir(), "watcher.env");
}

/**
 * What the watcher cannot work without, and what it merely likes to have.
 * A model key is required because a build slices; a GitHub token is required
 * because `assignee:@me` is meaningless without one.
 */
const MODEL_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GROK_API_KEY"];
const GITHUB_KEYS = ["GITHUB_TOKEN", "GH_TOKEN"];
const CARRIED = [
  ...MODEL_KEYS,
  ...GITHUB_KEYS,
  "DEEP_REVIEW_REPO",
  "DEEP_REVIEW_HOME",
  "LINEAR_API_KEY",
];

/** The variables to carry into the agent, read from this shell. */
export function captureEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const captured: Record<string, string> = {};
  for (const name of CARRIED) {
    const value = env[name];
    if (value) captured[name] = value;
  }
  return captured;
}

/** What is missing that would make an installed watcher fail silently at 3am. */
export function missingEnv(captured: Record<string, string>): string[] {
  const missing: string[] = [];
  if (!MODEL_KEYS.some((name) => captured[name])) {
    missing.push(`a model key (${MODEL_KEYS.join(", ")})`);
  }
  if (!GITHUB_KEYS.some((name) => captured[name])) {
    missing.push(`a GitHub token (${GITHUB_KEYS.join(" or ")})`);
  }
  return missing;
}

export function writeEnvFile(captured: Record<string, string>): string {
  const file = watcherEnvFile();
  mkdirSync(stateDir(), { recursive: true });
  const body = Object.entries(captured)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n");
  writeFileSync(file, `${body}\n`, { mode: 0o600 });
  // writeFileSync only applies the mode when it creates the file; an
  // existing one keeps whatever it had, so say it again.
  chmodSync(file, 0o600);
  return file;
}

/** Load that file into this process, for a watcher launchd started. */
export function loadEnvFile(file = watcherEnvFile()): void {
  try {
    process.loadEnvFile(file);
  } catch {
    // Not installed, or nothing captured: the ambient environment stands.
  }
}

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export interface AgentPlistOptions {
  /** argv for the agent: the same interpreter and CLI that installed it. */
  programArguments: string[];
  logFile: string;
}

/**
 * `KeepAlive` only on a crash: a watcher told to stop should stay stopped,
 * and `ThrottleInterval` keeps a boot-looping one from spinning the CPU.
 */
export function renderAgentPlist(options: AgentPlistOptions): string {
  const args = options.programArguments
    .map((arg) => `    <string>${escapeXml(arg)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(options.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(options.logFile)}</string>
</dict>
</plist>
`;
}

/**
 * Flags that describe *this* invocation rather than how to run the CLI, and
 * so must not be carried into a respawn: an inherited `--eval` would make
 * launchd run this moment's script forever instead of the watcher.
 */
const NOT_INHERITABLE = new Set(["-e", "--eval", "-p", "--print", "-i", "--interactive"]);

export function inheritableExecArgv(execArgv: string[] = process.execArgv): string[] {
  const kept: string[] = [];
  for (let i = 0; i < execArgv.length; i += 1) {
    const arg = execArgv[i]!;
    const [name] = arg.split("=");
    if (!NOT_INHERITABLE.has(name!)) {
      kept.push(arg);
      continue;
    }
    // `--eval SCRIPT` takes its script as the next argument; `--eval=X` carries it.
    if (!arg.includes("=")) i += 1;
  }
  return kept;
}

/**
 * The argv that reruns this same CLI as a foreground watcher. Mirrors how
 * the daemon respawns itself: this process's interpreter and loader flags,
 * because a `.ts` entry point plain node cannot take is exactly what a dev
 * checkout runs, and absolute because launchd has no working directory or
 * PATH worth relying on.
 *
 * Which repos to watch is not in here: the watcher reads `watch.json` on
 * every poll, so the file can change without reinstalling the agent, and
 * there is no argv form — and so no environment form — that widens it.
 */
export function watcherArgv(intervalMs?: number): string[] {
  const argv = [
    process.execPath,
    ...inheritableExecArgv(),
    path.resolve(process.argv[1] ?? ""),
    "watch",
    "--foreground",
  ];
  if (intervalMs !== undefined) argv.push("--interval", String(Math.round(intervalMs / 1000)));
  return argv;
}

/**
 * Paths that will not still be there at the next login. An agent installed
 * from a git worktree or a temp dir points at a loader that gets deleted,
 * and the failure surfaces at 3am in a log nobody is reading — so say so
 * now, while there is someone to tell.
 */
export function transientPaths(argv: string[]): string[] {
  const transient = /\/\.claude\/worktrees\/|^\/tmp\/|^\/private\/var\/folders\//;
  return argv.filter((arg) => arg.startsWith("/") && transient.test(arg));
}

function launchctl(args: string[]): void {
  execFileSync("launchctl", args, { stdio: ["ignore", "ignore", "pipe"] });
}

function domain(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

export function agentInstalled(): boolean {
  return existsSync(plistPath());
}

/** Is launchd holding the agent right now? */
export function agentLoaded(): boolean {
  try {
    launchctl(["print", `${domain()}/${AGENT_LABEL}`]);
    return true;
  } catch {
    return false;
  }
}

export interface InstallResult {
  plist: string;
  envFile: string;
  captured: string[];
}

/** Write the plist and hand it to launchd, replacing any earlier one. */
export function installAgent(
  options: {
    intervalMs?: number | undefined;
    force?: boolean | undefined;
  } = {},
): InstallResult {
  const captured = captureEnv();
  const missing = missingEnv(captured);
  if (missing.length > 0) {
    throw new Error(
      `The watcher needs ${missing.join(" and ")}, and this shell has none set.\n` +
        "It runs outside your shell — nothing sources your profile there — so it " +
        "can only ever have what is captured here. Export them and run this again.",
    );
  }
  const argv = watcherArgv(options.intervalMs);
  const transient = transientPaths(argv);
  if (transient.length > 0 && !options.force) {
    throw new Error(
      `This CLI runs from a path that will not outlive the checkout:\n  ${transient.join("\n  ")}\n` +
        "An agent installed from here stops working the moment it is removed, " +
        "and does so silently. Install from your main checkout, or pass --force " +
        "if you know this path is permanent.",
    );
  }
  const envFile = writeEnvFile(captured);
  const file = plistPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    renderAgentPlist({ programArguments: argv, logFile: watcherLogFile() }),
  );
  // Replace rather than reload: bootstrap on an already-loaded label fails,
  // and a stale definition is worse than a moment with none.
  uninstallAgent({ keepPlist: true });
  launchctl(["bootstrap", domain(), file]);
  return { plist: file, envFile, captured: Object.keys(captured) };
}

/** Take the agent out of launchd, and (unless asked otherwise) off disk. */
export function uninstallAgent(options: { keepPlist?: boolean } = {}): void {
  try {
    launchctl(["bootout", `${domain()}/${AGENT_LABEL}`]);
  } catch {
    // Not loaded; nothing to take out.
  }
  if (!options.keepPlist) rmSync(plistPath(), { force: true });
}
