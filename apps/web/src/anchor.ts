import type { Anchor } from "@comment-md/api";

const CONTEXT_LEN = 32;

// Extracts the visible text of a DOM tree in document order along with
// per-character ranges so we can map text offsets back to (node, offset).
export interface FlatText {
  text: string;
  segments: Array<{ node: Text; start: number; end: number }>;
}

export function flattenText(
  root: HTMLElement,
  excludeAncestor?: string,
): FlatText {
  const segments: FlatText["segments"] = [];
  let text = "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (excludeAncestor) {
        let p = (node as Text).parentElement;
        while (p && p !== root.parentElement) {
          if (p.matches(excludeAncestor)) return NodeFilter.FILTER_REJECT;
          p = p.parentElement;
        }
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node = walker.nextNode() as Text | null;
  while (node) {
    const value = node.nodeValue ?? "";
    const start = text.length;
    text += value;
    segments.push({ node, start, end: start + value.length });
    node = walker.nextNode() as Text | null;
  }
  return { text, segments };
}

// Build an Anchor from the current selection. If `excludeAncestor` is set
// (e.g. ".diff-del" in diff mode), text inside matching ancestors is dropped
// from both the flat text used for offsets and the captured quote — so the
// anchor only refers to content present in the latest version.
export function buildAnchorFromSelection(
  root: HTMLElement,
  selection: Selection,
  excludeAncestor?: string,
): Anchor | null {
  if (selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (range.collapsed) return null;
  if (
    !root.contains(range.startContainer) ||
    !root.contains(range.endContainer)
  ) {
    return null;
  }
  const flat = flattenText(root, excludeAncestor);

  let firstStart = -1;
  let lastEnd = -1;
  let quote = "";

  for (const seg of flat.segments) {
    const segLen = seg.end - seg.start;
    let cStart: number;
    let cEnd: number;
    try {
      cStart = range.comparePoint(seg.node, 0);
      cEnd = range.comparePoint(seg.node, segLen);
    } catch {
      continue;
    }
    if (cStart === 1) break; // segment entirely after range
    if (cEnd === -1) continue; // segment entirely before range

    const nStart =
      seg.node === range.startContainer ? range.startOffset : 0;
    const nEnd =
      seg.node === range.endContainer ? range.endOffset : segLen;
    if (nEnd <= nStart) continue;

    const segText = (seg.node.nodeValue ?? "").slice(nStart, nEnd);
    if (firstStart === -1) firstStart = seg.start + nStart;
    lastEnd = seg.start + nEnd;
    quote += segText;
  }

  if (firstStart === -1 || !quote.trim()) return null;
  const prefix = flat.text.slice(Math.max(0, firstStart - CONTEXT_LEN), firstStart);
  const suffix = flat.text.slice(
    lastEnd,
    Math.min(flat.text.length, lastEnd + CONTEXT_LEN),
  );
  return { quote, prefix, suffix, start: firstStart, end: lastEnd };
}

// Locate an anchor in the current document text. Returns [start, end] or null.
export function locateAnchor(flat: FlatText, anchor: Anchor): [number, number] | null {
  if (!anchor.quote) return null;
  const text = flat.text;
  // 1. Try exact match at recorded position
  const exactAt = text.slice(anchor.start, anchor.end);
  if (exactAt === anchor.quote) {
    return [anchor.start, anchor.end];
  }
  // 2. Find all occurrences of the quote and pick the one whose prefix/suffix match best.
  const indices: number[] = [];
  let idx = text.indexOf(anchor.quote);
  while (idx !== -1) {
    indices.push(idx);
    idx = text.indexOf(anchor.quote, idx + 1);
  }
  if (indices.length === 0) return null;
  if (indices.length === 1) {
    return [indices[0]!, indices[0]! + anchor.quote.length];
  }
  let best = indices[0]!;
  let bestScore = -1;
  for (const i of indices) {
    const prefix = text.slice(Math.max(0, i - CONTEXT_LEN), i);
    const suffix = text.slice(i + anchor.quote.length, i + anchor.quote.length + CONTEXT_LEN);
    const score =
      commonSuffixLen(prefix, anchor.prefix) + commonPrefixLen(suffix, anchor.suffix) -
      Math.abs(i - anchor.start) / 1000;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return [best, best + anchor.quote.length];
}

function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

function commonSuffixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

// Map a flat-text [start,end] back to DOM ranges. Returns an array of
// per-text-node ranges (start text node offset, end text node offset) for
// highlighting.
export interface DomRange {
  node: Text;
  start: number;
  end: number;
}

export function rangesFromFlat(
  flat: FlatText,
  start: number,
  end: number,
): DomRange[] {
  const out: DomRange[] = [];
  for (const seg of flat.segments) {
    if (seg.end <= start) continue;
    if (seg.start >= end) break;
    const s = Math.max(seg.start, start) - seg.start;
    const e = Math.min(seg.end, end) - seg.start;
    out.push({ node: seg.node, start: s, end: e });
  }
  return out;
}
