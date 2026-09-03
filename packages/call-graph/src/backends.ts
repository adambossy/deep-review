import type { LanguageBackend, ServiceState } from "./backend.js";
import { LspBackend, pyrightConfig } from "./lspBackend.js";
import { TsBackend } from "./tsBackend.js";

const TS_EXTENSIONS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const PY_EXTENSIONS = /\.pyi?$/;

/**
 * One language backend per language over a checkout, each started on its
 * first use — so a TypeScript-only PR never spawns pyright, and a file is
 * only ever handed to the service that understands it.
 */
export class Backends {
  private ts: TsBackend | null = null;
  private py: LspBackend | null = null;

  constructor(private rootDir: string) {}

  for(file: string): LanguageBackend | null {
    if (TS_EXTENSIONS.test(file)) return (this.ts ??= new TsBackend(this.rootDir));
    if (PY_EXTENSIONS.test(file)) return (this.py ??= new LspBackend(this.rootDir, pyrightConfig()));
    return null;
  }

  /** Whether requests to this backend go over a wire and should be issued in parallel. */
  batched(backend: LanguageBackend): boolean {
    return backend === this.py;
  }

  /**
   * One state for every service started so far: a failure anywhere is a
   * failure, otherwise anything still starting means starting, otherwise
   * ready if anything is up at all.
   */
  status(): ServiceState {
    const states = [this.ts, this.py].filter((b) => b !== null).map((b) => b.status());
    if (states.includes("failed")) return "failed";
    if (states.includes("starting")) return "starting";
    if (states.includes("ready")) return "ready";
    return "idle";
  }

  dispose(): void {
    this.ts?.dispose();
    this.py?.dispose();
  }
}
