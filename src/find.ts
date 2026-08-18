const ALL = "find-match";
const CURRENT = "find-current";

export const REVEAL_ALL = "find:reveal-all";

type TextRun = { node: Text; start: number };

type HighlightCtor = new (...ranges: Range[]) => unknown;
type Registry = { set(name: string, value: unknown): void; delete(name: string): void };

const registry = (): Registry | null =>
  (CSS as unknown as { highlights?: Registry }).highlights ?? null;

const highlightCtor = (): HighlightCtor | null =>
  (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight ?? null;

export function expandCollapsed(root: ParentNode) {
  for (const d of root.querySelectorAll("details:not([open])")) {
    (d as HTMLDetailsElement).open = true;
  }
  window.dispatchEvent(new CustomEvent(REVEAL_ALL));
}

function searchable(node: Text): boolean {
  const el = node.parentElement;
  if (!el || !el.isConnected) return false;
  if (el.closest("[data-find-skip]")) return false;
  const tag = el.tagName;
  if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEXTAREA") return false;
  return !!(el.offsetParent || el.getClientRects().length);
}

function collect(root: HTMLElement): { text: string; runs: TextRun[] } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      (node as Text).data && searchable(node as Text)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT,
  });

  const runs: TextRun[] = [];
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const t = node as Text;
    runs.push({ node: t, start: text.length });
    text += t.data;
  }
  return { text, runs };
}

function locate(runs: TextRun[], offset: number): { node: Text; offset: number } | null {
  let lo = 0;
  let hi = runs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const run = runs[mid];
    if (offset < run.start) hi = mid - 1;
    else if (offset > run.start + run.node.data.length) lo = mid + 1;
    else return { node: run.node, offset: offset - run.start };
  }
  return null;
}

export const MATCH_LIMIT = 2000;

export function findRanges(root: HTMLElement, query: string): Range[] {
  if (!query.trim()) return [];
  const { text, runs } = collect(root);
  if (!text) return [];

  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const ranges: Range[] = [];

  let at = haystack.indexOf(needle);
  while (at !== -1 && ranges.length < MATCH_LIMIT) {
    const from = locate(runs, at);
    const to = locate(runs, at + needle.length);
    if (from && to) {
      const range = document.createRange();
      range.setStart(from.node, from.offset);
      range.setEnd(to.node, to.offset);
      ranges.push(range);
    }
    at = haystack.indexOf(needle, at + needle.length);
  }
  return ranges;
}

export function paint(ranges: Range[], current: number) {
  const reg = registry();
  const Ctor = highlightCtor();
  if (!reg || !Ctor) return;
  reg.set(ALL, new Ctor(...ranges.filter((_, i) => i !== current)));
  const hit = ranges[current];
  reg.set(CURRENT, hit ? new Ctor(hit) : new Ctor());
}

export function clearPaint() {
  const reg = registry();
  if (!reg) return;
  reg.delete(ALL);
  reg.delete(CURRENT);
}

export function reveal(range: Range) {
  const anchor = range.startContainer.parentElement;
  if (!anchor) return;
  for (const d of ancestorDetails(anchor)) d.open = true;
  anchor.scrollIntoView({ block: "center", inline: "nearest" });
}

function ancestorDetails(el: Element): HTMLDetailsElement[] {
  const out: HTMLDetailsElement[] = [];
  for (let node = el.closest("details"); node; node = node.parentElement?.closest("details") ?? null) {
    if (!node.open) out.push(node);
  }
  return out;
}

export function findRoot(): HTMLElement {
  const drawer = document.querySelector<HTMLElement>(".drawer");
  return drawer ?? document.body;
}
