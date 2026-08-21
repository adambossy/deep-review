/**
 * Whether a repo-relative path is a test file. Callers found in test files
 * are kept out of the call graph and surfaced as "tested by" rows instead.
 */
export function isTestFile(path: string): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(base)) return true;
  if (/^test_[^/]*\.py$/.test(base) || /_test\.py$/.test(base)) return true;
  return /(^|\/)(__tests__|tests?)\//.test(path);
}
