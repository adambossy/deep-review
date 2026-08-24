import process from "node:process";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { prepare, runSliceAgent, type ReasoningEffort } from "../src/index.js";

function loadEnvFile(): void {
  const repoRoot = path.join(import.meta.dirname, "..", "..", "..");
  for (const candidate of [path.join(repoRoot, ".env")]) {
    try {
      process.loadEnvFile(candidate);
      return;
    } catch {
      // try the next
    }
  }
}

loadEnvFile();

// Private repos need a token for both the GitHub REST metadata call and the
// git clone/fetch; `gh` already holds one via the user's local login, so
// borrow it instead of asking the user to mint and paste one.
if (!process.env.GITHUB_TOKEN && !process.env.GH_TOKEN) {
  try {
    process.env.GITHUB_TOKEN = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
    }).trim();
  } catch {
    // Left unset; fetchPrInfo will report the private-repo hint itself.
  }
}

const PR_URLS = process.env.PROFILE_PRS?.split(",") ?? [
  "https://github.com/spara-ai/spara-app/pull/10302",
  "https://github.com/spara-ai/spara-app/pull/10160",
];

const EFFORTS: ReasoningEffort[] = (process.env.PROFILE_EFFORTS?.split(",") as ReasoningEffort[]) ?? [
  "medium",
  "high",
  "xhigh",
];
const MODELS = process.env.PROFILE_MODELS?.split(",") ?? [
  "claude-opus-5",
  "gpt-5.6-sol",
  "grok-4.6",
];

// grok-4.6 has been flaky about producing a diff-partitioning result; retry
// it from scratch (fresh sample, not just a repair round) rather than give
// up after one attempt.
const MAX_ATTEMPTS = Number(process.env.PROFILE_MAX_ATTEMPTS ?? 6);

interface RunResult {
  prUrl: string;
  model: string;
  effort: ReasoningEffort;
  ok: boolean;
  error?: string;
  attempts?: number;
  llmMs?: number;
  totalMs?: number;
  sliceCount?: number;
}

async function runOne(
  prUrl: string,
  model: string,
  effort: ReasoningEffort,
  workDir: string,
): Promise<RunResult> {
  const label = `${model} @ ${effort}`;
  console.error(`\n=== ${prUrl} — ${label} ===`);

  const { context, index } = await prepare({ prUrl, workDir });

  let lastError = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const t0 = performance.now();
    try {
      const { slices, llmMs } = await runSliceAgent(context, index, {
        model,
        effort,
        onProgress: (m) => console.error(`  [agent attempt ${attempt}] ${m}`),
      });
      const totalMs = performance.now() - t0;
      console.error(
        `  done (attempt ${attempt}): total=${(totalMs / 1000).toFixed(1)}s llm=${(llmMs / 1000).toFixed(1)}s slices=${slices.length}`,
      );
      return {
        prUrl,
        model,
        effort,
        ok: true,
        attempts: attempt,
        llmMs,
        totalMs,
        sliceCount: slices.length,
      };
    } catch (err) {
      const totalMs = performance.now() - t0;
      lastError = err instanceof Error ? err.message : String(err);
      console.error(
        `  attempt ${attempt} FAILED after ${(totalMs / 1000).toFixed(1)}s: ${lastError}`,
      );
      if (attempt < MAX_ATTEMPTS) {
        console.error(`  retrying (${attempt + 1}/${MAX_ATTEMPTS})...`);
      }
    }
  }
  return {
    prUrl,
    model,
    effort,
    ok: false,
    attempts: MAX_ATTEMPTS,
    error: `Gave up after ${MAX_ATTEMPTS} attempts: ${lastError}`,
  };
}

async function main(): Promise<void> {
  const results: RunResult[] = [];
  const resultsFile = path.join(import.meta.dirname, "..", "profile-results.json");

  for (const prUrl of PR_URLS) {
    const prSlug = prUrl.split("/").slice(-3).join("-");
    const workDir = path.join(os.tmpdir(), `deep-review-profile-${prSlug}`);
    for (const model of MODELS) {
      for (const effort of EFFORTS) {
        results.push(await runOne(prUrl, model, effort, workDir));
        writeFileSync(resultsFile, JSON.stringify(results, null, 2), "utf8");
      }
    }
  }

  console.error("\n\n=== Summary ===");
  console.error(
    "pr".padEnd(14) +
      "model".padEnd(16) +
      "effort".padEnd(10) +
      "total(s)".padEnd(10) +
      "llm(s)".padEnd(10) +
      "attempts".padEnd(10) +
      "slices",
  );
  for (const r of results) {
    const pr = r.prUrl.split("/").pop() ?? r.prUrl;
    if (!r.ok) {
      console.error(
        `${pr.padEnd(14)}${r.model.padEnd(16)}${r.effort.padEnd(10)}FAILED (${r.attempts} attempts): ${r.error}`,
      );
      continue;
    }
    console.error(
      pr.padEnd(14) +
        r.model.padEnd(16) +
        r.effort.padEnd(10) +
        (r.totalMs! / 1000).toFixed(1).padEnd(10) +
        (r.llmMs! / 1000).toFixed(1).padEnd(10) +
        String(r.attempts).padEnd(10) +
        r.sliceCount,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
