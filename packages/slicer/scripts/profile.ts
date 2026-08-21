import process from "node:process";
import os from "node:os";
import path from "node:path";
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

const PR_URL = "https://github.com/vercel/swr/pull/2950";
const WORK_DIR = path.join(os.tmpdir(), "deep-review-profile-swr-2950");

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

interface RunResult {
  model: string;
  effort: ReasoningEffort;
  ok: boolean;
  error?: string;
  prepMs?: number;
  llmMs?: number;
  agentWallMs?: number;
  totalMs?: number;
  sliceCount?: number;
}

async function runOne(model: string, effort: ReasoningEffort): Promise<RunResult> {
  const label = `${model} @ ${effort}`;
  console.error(`\n=== ${label} ===`);
  const t0 = performance.now();
  try {
    // Reuse the same clone/worktree across runs — only the model changes.
    const { context, index } = await prepare({
      prUrl: PR_URL,
      workDir: WORK_DIR,
      onProgress: (m) => console.error(`  [prep] ${m}`),
    });
    const t1 = performance.now();

    const { slices, llmMs } = await runSliceAgent(context, index, {
      model,
      effort,
      onProgress: (m) => console.error(`  [agent] ${m}`),
    });
    const t2 = performance.now();

    const result: RunResult = {
      model,
      effort,
      ok: true,
      prepMs: t1 - t0,
      llmMs,
      agentWallMs: t2 - t1,
      totalMs: t2 - t0,
      sliceCount: slices.length,
    };
    console.error(
      `  done: total=${(result.totalMs! / 1000).toFixed(1)}s llm=${(llmMs / 1000).toFixed(1)}s prep=${(result.prepMs! / 1000).toFixed(1)}s slices=${slices.length}`,
    );
    return result;
  } catch (err) {
    const totalMs = performance.now() - t0;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  FAILED after ${(totalMs / 1000).toFixed(1)}s: ${message}`);
    return { model, effort, ok: false, error: message, totalMs };
  }
}

async function main(): Promise<void> {
  const results: RunResult[] = [];
  for (const model of MODELS) {
    for (const effort of EFFORTS) {
      results.push(await runOne(model, effort));
      writeFileSync(
        path.join(import.meta.dirname, "..", "profile-results.json"),
        JSON.stringify(results, null, 2),
        "utf8",
      );
    }
  }

  console.error("\n\n=== Summary ===");
  console.error(
    "model".padEnd(16) +
      "effort".padEnd(10) +
      "total(s)".padEnd(10) +
      "llm(s)".padEnd(10) +
      "prep(s)".padEnd(10) +
      "slices",
  );
  for (const r of results) {
    if (!r.ok) {
      console.error(`${r.model.padEnd(16)}${r.effort.padEnd(10)}FAILED: ${r.error}`);
      continue;
    }
    console.error(
      r.model.padEnd(16) +
        r.effort.padEnd(10) +
        (r.totalMs! / 1000).toFixed(1).padEnd(10) +
        (r.llmMs! / 1000).toFixed(1).padEnd(10) +
        (r.prepMs! / 1000).toFixed(1).padEnd(10) +
        r.sliceCount,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
