import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { tool, type ToolSet } from "ai";
import { z } from "zod";

const MAX_LINES = 400;
const MAX_MATCHES = 100;

/**
 * Resolve a repo-relative path inside a worktree, refusing anything that
 * escapes it. The agent's paths come from a model, so they are input.
 */
function resolveInside(root: string, relative: string): string {
  const resolved = path.resolve(root, relative);
  const prefix = path.resolve(root) + path.sep;
  if (resolved !== path.resolve(root) && !resolved.startsWith(prefix)) {
    throw new Error(`Path "${relative}" is outside the repository.`);
  }
  return resolved;
}

/**
 * Report a failed tool call back to the model instead of throwing. A missing
 * path is a guess the agent should get to correct; letting it propagate would
 * end the run over a typo.
 */
function safely(run: () => string): string {
  try {
    return run();
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function numbered(lines: string[], firstLine: number): string {
  const width = String(firstLine + lines.length - 1).length;
  return lines
    .map((line, i) => `${String(firstLine + i).padStart(width)}\t${line}`)
    .join("\n");
}

export interface ReadToolOptions {
  /** Worktree at the PR's head commit. */
  headDir: string;
  /** Worktree at the PR's base commit, for reading code the PR deleted. */
  baseDir: string;
}

const sideSchema = z
  .enum(["head", "base"])
  .default("head")
  .describe(
    "Which revision to read. 'head' is the PR's code; use 'base' only to see what the PR removed.",
  );

/**
 * The tools the agent explores with. Deliberately read-only and deliberately
 * small: the PR's diff, description, and tickets are already in the prompt,
 * so what is left is looking at the code around the change.
 */
export function createReadTools({
  headDir,
  baseDir,
}: ReadToolOptions): ToolSet {
  const rootFor = (side: "head" | "base"): string =>
    side === "base" ? baseDir : headDir;

  return {
    read_file: tool({
      description:
        "Read a source file from the repository. Returns numbered lines. Use this to see the code around a change — the function being called, the interface being implemented, the test that covers it.",
      inputSchema: z.object({
        path: z.string().describe("Repo-relative path, e.g. src/report.ts"),
        startLine: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-based first line. Omit to start at the top."),
        endLine: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            `1-based last line, inclusive. At most ${MAX_LINES} lines are returned.`,
          ),
        side: sideSchema,
      }),
      execute: ({ path: filePath, startLine, endLine, side }) =>
        safely(() => {
          const full = resolveInside(rootFor(side), filePath);
          const all = readFileSync(full, "utf8").split("\n");
          const first = startLine ?? 1;
          const last = Math.min(
            endLine ?? first + MAX_LINES - 1,
            first + MAX_LINES - 1,
            all.length,
          );
          if (first > all.length) {
            return `${filePath} has ${all.length} lines; ${first} is past the end.`;
          }
          const body = numbered(all.slice(first - 1, last), first);
          const suffix =
            last < all.length
              ? `\n... ${all.length - last} more lines (file has ${all.length}).`
              : "";
          return body + suffix;
        }),
    }),

    list_directory: tool({
      description:
        "List the entries of a directory, to find where something lives before reading it.",
      inputSchema: z.object({
        path: z
          .string()
          .default(".")
          .describe("Repo-relative directory, e.g. src or '.' for the root."),
        side: sideSchema,
      }),
      execute: ({ path: dirPath, side }) =>
        safely(() => {
          const full = resolveInside(rootFor(side), dirPath);
          const entries = readdirSync(full).sort();
          return (
            entries
              .map((name) => {
                const isDir = statSync(path.join(full, name)).isDirectory();
                return isDir ? `${name}/` : name;
              })
              .join("\n") || "(empty)"
          );
        }),
    }),

    search: tool({
      description:
        "Search the repository for a pattern (git grep, POSIX extended regex). Use it to find a symbol's definition or its other call sites.",
      inputSchema: z.object({
        pattern: z.string().min(1).describe("Extended regular expression."),
        pathspec: z
          .string()
          .optional()
          .describe("Optional path or glob to limit the search, e.g. 'src/**'."),
        side: sideSchema,
      }),
      execute: ({ pattern, pathspec, side }) => {
        const args = [
          "grep",
          "--no-color",
          "-n",
          "-I",
          "-E",
          "-e",
          pattern,
          "--",
          pathspec ?? ".",
        ];
        let out: string;
        try {
          out = execFileSync("git", args, {
            cwd: rootFor(side),
            encoding: "utf8",
            maxBuffer: 32 * 1024 * 1024,
          });
        } catch (error) {
          // git grep exits 1 for no matches and higher for real failures,
          // such as a pattern that is not a valid regex.
          const status = (error as { status?: number }).status;
          if (status === 1) return "No matches.";
          const stderr = (error as { stderr?: string }).stderr ?? "";
          return `Error: git grep failed${stderr ? `: ${stderr.trim()}` : "."}`;
        }
        const lines = out.split("\n").filter(Boolean);
        if (lines.length <= MAX_MATCHES) return lines.join("\n");
        return [
          ...lines.slice(0, MAX_MATCHES),
          `... ${lines.length - MAX_MATCHES} more matches; narrow the pattern or pass a pathspec.`,
        ].join("\n");
      },
    }),
  };
}
