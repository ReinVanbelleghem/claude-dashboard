export type TokenKind = "cmd" | "path" | "img" | "paste";
export type Segment = { text: string; kind: "plain" | TokenKind };

/** A collapsed paste, as it reads in the box. */
export const PASTE_RE = /\[Pasted text #(\d+) \+(\d+) lines\]/g;

/** Long enough that it drowns the composer rather than reading as a message. */
export const COLLAPSE_LINES = 12;

export function pasteMarker(n: number, lines: number): string {
  return `[Pasted text #${n} +${lines} lines]`;
}

/**
 * Put the real text back where its markers are, on the way to the model.
 *
 * The collapse is a display concern only — what gets sent has to be exactly what was
 * pasted, or the message quietly means something different from what it looks like.
 * A marker with no stored text is left alone rather than dropped, so text typed to
 * look like a marker survives too.
 */
export function expandPastes(text: string, store: Map<number, string>): string {
  return text.replace(PASTE_RE, (whole, n) => store.get(Number(n)) ?? whole);
}

/**
 * The `@path` fragment being typed at the caret, for the file picker.
 *
 * Same word-boundary rule as the slash matcher, so an email address or a decorator
 * is not mistaken for a file reference. Slashes and dots are part of the fragment —
 * `@src/components/App.ts` has to keep matching as you type through it.
 */
export function atTokenAt(
  draft: string,
  caret: number,
): { word: string; start: number } | null {
  const at = /(?:^|\s)@([\w./:-]*)$/.exec(draft.slice(0, caret));
  return at ? { word: at[1], start: caret - at[1].length - 1 } : null;
}

type Candidate = { start: number; end: number; kind: TokenKind };

/**
 * Split composer text into plain runs and the things worth marking in it.
 *
 * Four kinds get picked out, and each is matched against something *known* rather
 * than guessed at, so a mark always means something:
 *
 * - `/skill-name` — only when the session reports that command. An unrecognised
 *   `/foo` stays plain, which makes the colour an answer to "did I spell it right".
 * - a file path — only one this composer put there, from an `@` completion or a
 *   pasted file. Recognising paths by shape would light up prose like `and/or` and
 *   would still miss the real ones that contain spaces.
 * - `@fragment` — the reference being typed, before it resolves to a path.
 * - `[Image #1]` / `[Pasted text #1 +400 lines]` — markers standing in for content
 *   that is not in the textarea at all.
 *
 * Overlaps resolve earliest-first then longest, so a path that is a prefix of a
 * longer one cannot claim its position.
 */
export function tokenizeComposer(
  text: string,
  known: Set<string>,
  paths: string[] = [],
): Segment[] {
  const found: Candidate[] = [];

  const markers = /(\[Image #\d+\])|(\[Pasted text #\d+ \+\d+ lines\])/g;
  for (let m = markers.exec(text); m; m = markers.exec(text)) {
    found.push({
      start: m.index,
      end: m.index + m[0].length,
      kind: m[1] !== undefined ? "img" : "paste",
    });
  }

  const slash = /(?:^|\s)(\/[\w:-]+)/g;
  for (let m = slash.exec(text); m; m = slash.exec(text)) {
    const start = m.index + m[0].length - m[1].length;
    if (known.has(m[1].slice(1))) found.push({ start, end: start + m[1].length, kind: "cmd" });
  }

  const at = /(?:^|\s)(@[\w./:-]*)/g;
  for (let m = at.exec(text); m; m = at.exec(text)) {
    const start = m.index + m[0].length - m[1].length;
    found.push({ start, end: start + m[1].length, kind: "path" });
  }

  // Longest first, so the outer match wins when one path contains another.
  for (const p of [...new Set(paths)].sort((a, b) => b.length - a.length)) {
    if (!p) continue;
    for (let i = text.indexOf(p); i !== -1; i = text.indexOf(p, i + 1)) {
      found.push({ start: i, end: i + p.length, kind: "path" });
    }
  }

  found.sort((a, b) => a.start - b.start || b.end - a.end);

  const out: Segment[] = [];
  let last = 0;
  const push = (kind: Segment["kind"], from: number, to: number) => {
    if (to <= from) return;
    if (kind === "plain" && out.length && out[out.length - 1].kind === "plain") {
      out[out.length - 1].text += text.slice(from, to);
      return;
    }
    out.push({ kind, text: text.slice(from, to) });
  };

  for (const c of found) {
    if (c.start < last) continue; // Already inside a token that was taken.
    push("plain", last, c.start);
    push(c.kind, c.start, c.end);
    last = c.end;
  }
  push("plain", last, text.length);
  return out;
}

/**
 * Splice text in at the caret, spacing it from whatever it lands between.
 *
 * A pasted path almost always belongs mid-sentence ("have a look at <path> and tell
 * me…"), so it needs a space on either side — but only where there is not one
 * already, or repeated pastes leave a trail of double spaces. Returns the new caret
 * position too: it has to end up after the inserted text, not back where the paste
 * happened.
 */
export function insertAtCaret(
  draft: string,
  caret: number,
  text: string,
): { text: string; caret: number } {
  const at = Math.max(0, Math.min(caret, draft.length));
  const before = draft.slice(0, at);
  const after = draft.slice(at);
  const lead = before && !/\s$/.test(before) ? " " : "";
  // A trailing space only when something follows that needs separating, or when the
  // insert is at the very end — there the space is what lets you keep typing.
  const trail = after ? (/^\s/.test(after) ? "" : " ") : " ";
  return {
    text: `${before}${lead}${text}${trail}${after}`,
    caret: before.length + lead.length + text.length + trail.length,
  };
}
