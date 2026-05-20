import { diffWords, diffLines } from "diff";

export interface DiffPart {
  value: string;
  added?: boolean;
  removed?: boolean;
}

export function computeMarkdownDiff(
  previous: string,
  latest: string,
): DiffPart[] {
  return diffWords(previous, latest).map((p) => ({
    value: p.value,
    added: p.added,
    removed: p.removed,
  }));
}

export function computeLineDiff(
  previous: string,
  latest: string,
): DiffPart[] {
  return diffLines(previous, latest).map((p) => ({
    value: p.value,
    added: p.added,
    removed: p.removed,
  }));
}
