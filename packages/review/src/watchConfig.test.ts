import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addWatchedRepo,
  parseWatchConfig,
  readWatchConfig,
  watchConfigFile,
} from "./watchConfig.js";

describe("parseWatchConfig", () => {
  it("reads a repo named with an empty entry as one to watch with the default query", () => {
    // Naming the repo is all opting in should take.
    expect(parseWatchConfig({ repos: { "acme/widgets": {} } })).toEqual({
      repos: [{ repo: "acme/widgets" }],
      problems: [],
    });
  });

  it("keeps each repo's own query, trimmed", () => {
    const parsed = parseWatchConfig({
      repos: { "acme/widgets": { query: " is:open is:pr review-requested:@me " } },
    });
    expect(parsed.repos).toEqual([{ repo: "acme/widgets", query: "is:open is:pr review-requested:@me" }]);
  });

  it("reads no repos from a document without any", () => {
    // `{}` and `{"repos": {}}` both mean watch nothing — never everything.
    expect(parseWatchConfig({}).repos).toEqual([]);
    expect(parseWatchConfig({ repos: {} }).repos).toEqual([]);
    expect(parseWatchConfig(null).repos).toEqual([]);
  });

  it("skips an entry whose query names a repo, since that would widen the search", () => {
    const parsed = parseWatchConfig({
      repos: { "acme/widgets": { query: "is:open repo:acme/other" }, "acme/gadgets": {} },
    });
    expect(parsed.repos).toEqual([{ repo: "acme/gadgets" }]);
    expect(parsed.problems).toEqual([expect.stringMatching(/acme\/widgets: its query names a repo/)]);
  });

  it("skips what it cannot make sense of, naming each problem, and keeps the rest", () => {
    const parsed = parseWatchConfig({
      repos: {
        "not-a-repo": {},
        "acme/widgets": "is:open",
        "acme/gadgets": { query: 7 },
        "acme/gizmos": { query: "" },
        "acme/things": {},
      },
    });
    expect(parsed.repos).toEqual([{ repo: "acme/things" }]);
    expect(parsed.problems).toHaveLength(4);
  });

  it("reports a repos field of the wrong shape rather than guessing at it", () => {
    expect(parseWatchConfig({ repos: ["acme/widgets"] }).repos).toEqual([]);
    expect(parseWatchConfig({ repos: ["acme/widgets"] }).problems).toHaveLength(1);
  });
});

describe("readWatchConfig / addWatchedRepo", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "watch-config-test-"));
    process.env.DEEP_REVIEW_HOME = home;
  });

  afterEach(() => {
    delete process.env.DEEP_REVIEW_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it("lives under the state dir, beside the watcher's own state", () => {
    expect(watchConfigFile()).toBe(path.join(home, "watch.json"));
  });

  it("reads no repos and no problems when there is no file", () => {
    // A fresh install; nothing is wrong, and nothing is watched.
    expect(readWatchConfig()).toEqual({ repos: [], problems: [] });
  });

  it("reads no repos and one problem when the file is not JSON", () => {
    writeFileSync(watchConfigFile(), "nope");
    const parsed = readWatchConfig();
    expect(parsed.repos).toEqual([]);
    expect(parsed.problems).toEqual([expect.stringContaining("could not be read")]);
  });

  it("adds a repo to a file that did not exist, as a readable document", () => {
    const { added } = addWatchedRepo("acme/widgets");
    expect(added).toBe(true);
    expect(JSON.parse(readFileSync(watchConfigFile(), "utf8"))).toEqual({
      repos: { "acme/widgets": {} },
    });
  });

  it("adds a repo beside the ones already there, keeping their queries", () => {
    writeFileSync(
      watchConfigFile(),
      JSON.stringify({ repos: { "acme/gadgets": { query: "is:open label:x" } } }),
    );
    addWatchedRepo("acme/widgets");
    expect(readWatchConfig().repos).toEqual([
      { repo: "acme/gadgets", query: "is:open label:x" },
      { repo: "acme/widgets" },
    ]);
  });

  it("leaves a repo already named alone, query and all", () => {
    writeFileSync(
      watchConfigFile(),
      JSON.stringify({ repos: { "acme/widgets": { query: "is:open label:x" } } }),
    );
    expect(addWatchedRepo("acme/widgets").added).toBe(false);
    expect(readWatchConfig().repos).toEqual([{ repo: "acme/widgets", query: "is:open label:x" }]);
  });

  it("refuses to overwrite a file it cannot parse", () => {
    // Whatever that file was trying to say would be lost; it is the user's
    // to fix, not one flag's to replace.
    writeFileSync(watchConfigFile(), "{ not json");
    expect(() => addWatchedRepo("acme/widgets")).toThrow();
    expect(readFileSync(watchConfigFile(), "utf8")).toBe("{ not json");
  });
});
