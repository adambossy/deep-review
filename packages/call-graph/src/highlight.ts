/**
 * Minimal TypeScript/JavaScript tokenizer for HTML syntax highlighting.
 * Tracks block-comment and template-literal state across lines.
 */

export interface Token {
  start: number;
  end: number;
  cls: "kw" | "str" | "com" | "num" | "fn" | "type" | "lit";
}

/** An extra highlight layered over the tokens (call sites, links). */
export interface Mark {
  start: number;
  end: number;
  cls: string;
  attrs?: string;
}

export type Language = "ts" | "py";

/** Pick the tokenizer language for a file path. */
export function languageOf(path: string): Language {
  return /\.pyi?$/.test(path) ? "py" : "ts";
}

interface LanguageRules {
  keywords: Set<string>;
  literals: Set<string>;
  /** Line-comment introducer. */
  lineComment: string;
  /** Block comments: TS `/* … *​/`; none for Python. */
  blockComment: boolean;
  /** Multi-line strings: TS template literals / Python triple quotes. */
  multilineStrings: Array<{ open: string; close: string }>;
}

const RULES: Record<Language, LanguageRules> = {
  ts: {
    keywords: new Set(
      (
        "abstract as async await break case catch class const continue debugger default delete do else enum export " +
        "extends finally for from function get if implements import in infer instanceof interface is keyof let module " +
        "namespace new of override private protected public readonly return satisfies set static switch throw try type " +
        "typeof var void while with yield"
      ).split(" "),
    ),
    literals: new Set(["true", "false", "null", "undefined", "this", "super", "NaN", "Infinity"]),
    lineComment: "//",
    blockComment: true,
    multilineStrings: [{ open: "`", close: "`" }],
  },
  py: {
    keywords: new Set(
      (
        "and as assert async await break case class continue def del elif else except finally for from global if " +
        "import in is lambda match nonlocal not or pass raise return try while with yield"
      ).split(" "),
    ),
    literals: new Set(["True", "False", "None", "self", "cls"]),
    lineComment: "#",
    blockComment: false,
    multilineStrings: [
      { open: '"""', close: '"""' },
      { open: "'''", close: "'''" },
    ],
  },
};

const WORD_START = /[A-Za-z_$#]/;
const WORD = /^[A-Za-z_$#][\w$]*/;
const NUMBER = /^(?:0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?)n?/;

/** "code", or the closing delimiter of an unterminated comment/string. */
type LineState = { kind: "code" } | { kind: "comment"; close: string } | { kind: "string"; close: string };

function findUnescaped(text: string, quote: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === quote) return i;
  }
  return -1;
}

function findClose(text: string, close: string, from: number): number {
  return close.length === 1 ? findUnescaped(text, close, from) : text.indexOf(close, from);
}

function tokenizeLine(
  text: string,
  state: LineState,
  rules: LanguageRules,
): { tokens: Token[]; next: LineState } {
  const tokens: Token[] = [];
  let i = 0;

  if (state.kind !== "code") {
    const cls = state.kind === "comment" ? ("com" as const) : ("str" as const);
    const end = findClose(text, state.close, 0);
    if (end === -1) {
      if (text.length) tokens.push({ start: 0, end: text.length, cls });
      return { tokens, next: state };
    }
    tokens.push({ start: 0, end: end + state.close.length, cls });
    i = end + state.close.length;
  }

  while (i < text.length) {
    const ch = text[i]!;

    if (text.startsWith(rules.lineComment, i)) {
      tokens.push({ start: i, end: text.length, cls: "com" });
      break;
    }
    if (rules.blockComment && text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) {
        tokens.push({ start: i, end: text.length, cls: "com" });
        return { tokens, next: { kind: "comment", close: "*/" } };
      }
      tokens.push({ start: i, end: end + 2, cls: "com" });
      i = end + 2;
      continue;
    }
    const multi = rules.multilineStrings.find((m) => text.startsWith(m.open, i));
    if (multi) {
      const end = findClose(text, multi.close, i + multi.open.length);
      if (end === -1) {
        tokens.push({ start: i, end: text.length, cls: "str" });
        return { tokens, next: { kind: "string", close: multi.close } };
      }
      tokens.push({ start: i, end: end + multi.close.length, cls: "str" });
      i = end + multi.close.length;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = findUnescaped(text, ch, i + 1);
      const stop = end === -1 ? text.length : end + 1;
      tokens.push({ start: i, end: stop, cls: "str" });
      i = stop;
      continue;
    }
    if (/\d/.test(ch)) {
      const match = NUMBER.exec(text.slice(i));
      const end = i + (match ? match[0].length : 1);
      tokens.push({ start: i, end, cls: "num" });
      i = end;
      continue;
    }
    if (WORD_START.test(ch)) {
      const word = WORD.exec(text.slice(i))![0];
      const end = i + word.length;
      let cls: Token["cls"] | null = null;
      if (rules.keywords.has(word)) cls = "kw";
      else if (rules.literals.has(word)) cls = "lit";
      else if (/^\s*\(/.test(text.slice(end)) || word.startsWith("#")) cls = "fn";
      else if (/^[A-Z]/.test(word)) cls = "type";
      if (cls) tokens.push({ start: i, end, cls });
      i = end;
      continue;
    }
    i++;
  }
  return { tokens, next: { kind: "code" } };
}

/** Tokenize a run of consecutive lines, carrying multi-line state. */
export function tokenizeLines(lines: readonly string[], lang: Language = "ts"): Token[][] {
  const rules = RULES[lang];
  let state: LineState = { kind: "code" };
  return lines.map((line) => {
    const { tokens, next } = tokenizeLine(line, state, rules);
    state = next;
    return tokens;
  });
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Render one line to HTML: syntax token spans, with marks layered on top. */
export function renderLine(text: string, tokens: readonly Token[], marks: readonly Mark[] = []): string {
  const clamped = marks.map((m) => ({
    ...m,
    start: Math.max(0, Math.min(m.start, text.length)),
    end: Math.max(0, Math.min(m.end, text.length)),
  }));
  const cuts = new Set<number>([0, text.length]);
  for (const t of tokens) {
    cuts.add(t.start);
    cuts.add(t.end);
  }
  for (const m of clamped) {
    cuts.add(m.start);
    cuts.add(m.end);
  }
  const points = [...cuts].sort((a, b) => a - b);

  let out = "";
  for (let p = 0; p < points.length - 1; p++) {
    const a = points[p]!;
    const b = points[p + 1]!;
    if (a >= b) continue;
    const segment = escapeHtml(text.slice(a, b));
    const token = tokens.find((t) => t.start <= a && t.end >= b);
    const active = clamped.filter((m) => m.start <= a && m.end >= b);
    const classes = [
      ...(token ? [`tok-${token.cls}`] : []),
      ...active.map((m) => m.cls),
    ];
    const attrs = active
      .map((m) => m.attrs)
      .filter(Boolean)
      .join(" ");
    out +=
      classes.length || attrs
        ? `<span class="${classes.join(" ")}"${attrs ? " " + attrs : ""}>${segment}</span>`
        : segment;
  }
  return out;
}
