export interface HighlightSegment {
  text: string;
  match: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function splitHighlight(text: string, needle: string): HighlightSegment[] {
  const query = needle.trim();
  if (!query || !text) return [{ text, match: false }];
  const pattern = new RegExp(escapeRegExp(query), "giu");
  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (const found of text.matchAll(pattern)) {
    const start = found.index;
    if (start > cursor) segments.push({ text: text.slice(cursor, start), match: false });
    segments.push({ text: found[0], match: true });
    cursor = start + found[0].length;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false });
  return segments.length > 0 ? segments : [{ text, match: false }];
}
