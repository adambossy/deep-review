import { parseUnifiedDiff } from "@deep-review/pr";
import { describe, expect, it } from "vitest";
import { indexDiff } from "./annotate.js";
import { agentOutputSchema, sliceReportSchema, type AgentOutput } from "./schema.js";
import { validateSlices } from "./validate.js";

const DIFF = `diff --git a/src/new.ts b/src/new.ts
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,4 @@
+export const a = 1;
+export const b = 2;
+export const c = 3;
+export const d = 4;
`;

const index = indexDiff(parseUnifiedDiff(DIFF));

const output = (
  ...slices: { title: string; fragments: [number, number][] }[]
): AgentOutput => ({
  overview: "adds four constants",
  slices: slices.map((s) => ({
    title: s.title,
    summary: "s",
    rationale: "r",
    fragments: s.fragments.map(([startLine, endLine]) => ({
      hunkId: "src/new.ts#0",
      startLine,
      endLine,
      summary: "f",
      kind: "core" as const,
    })),
  })),
});

describe("validateSlices", () => {
  it("splits one hunk across several slices", () => {
    const result = validateSlices(
      output(
        { title: "First half", fragments: [[1, 2]] },
        { title: "Second half", fragments: [[3, 4]] },
      ),
      index,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slices.map((s) => s.id)).toEqual(["slice-1", "slice-2"]);
    expect(result.slices[0]!.fragments[0]!.id).toBe("src/new.ts#0@1-2");
    expect(result.slices[1]!.fragments[0]!.file).toBe("src/new.ts");
  });

  it("rejects a changed line no slice claims", () => {
    const result = validateSlices(
      output({ title: "Partial", fragments: [[1, 2]] }),
      index,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      "Hunk src/new.ts#0 has changed lines in no slice: 3-4.",
    ]);
  });

  it("rejects a line two slices claim", () => {
    const result = validateSlices(
      output(
        { title: "One", fragments: [[1, 3]] },
        { title: "Two", fragments: [[3, 4]] },
      ),
      index,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain("lines 3 are claimed by more than one");
    expect(result.errors[0]).toContain('"One", "Two"');
  });

  it("rejects a fragment running past the end of its hunk", () => {
    const result = validateSlices(
      output({ title: "Too long", fragments: [[1, 9]] }),
      index,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain("which has only 4 lines");
  });

  it("rejects a reference to a hunk that does not exist", () => {
    const result = validateSlices(
      {
        overview: "o",
        slices: [
          {
            title: "Ghost",
            summary: "s",
            rationale: "r",
            fragments: [
              { hunkId: "src/gone.ts#0", startLine: 1, endLine: 1, summary: "f", kind: "core" },
            ],
          },
        ],
      },
      index,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain('references hunk "src/gone.ts#0"');
  });
});

describe("fragment kind", () => {
  it("carries the agent's kind onto the persisted fragment", () => {
    const result = validateSlices(output({ title: "All", fragments: [[1, 4]] }), index);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slices[0]!.fragments[0]!.kind).toBe("core");
  });

  it("is required in the agent's output", () => {
    const raw = output({ title: "All", fragments: [[1, 4]] }) as unknown as {
      slices: { fragments: Record<string, unknown>[] }[];
    };
    delete raw.slices[0]!.fragments[0]!.kind;
    expect(agentOutputSchema.safeParse(raw).success).toBe(false);
  });

  it("is optional in a saved report, so older reports still load", () => {
    const saved = {
      pr: {
        url: "u", owner: "a", repo: "b", number: 1, title: "t",
        baseSha: "b", mergeBaseSha: "m", headSha: "h",
      },
      tickets: [],
      overview: "o",
      slices: [
        {
          id: "slice-1", title: "s", summary: "s", rationale: "r",
          fragments: [
            { id: "src/new.ts#0@1-4", hunkId: "src/new.ts#0", file: "src/new.ts", startLine: 1, endLine: 4, summary: "f" },
          ],
        },
      ],
      model: "m",
      generatedAt: "now",
    };
    expect(sliceReportSchema.safeParse(saved).success).toBe(true);
  });
});
