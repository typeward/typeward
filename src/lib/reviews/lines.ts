/** Review offsets are CM6/LF-space (CM6 splits on \r\n but joins with \n), so
 * every consumer of file content in the review pipeline must normalize through
 * this before mapping offsets — disk reads preserve CRLF, and a CRLF file
 * otherwise shifts every anchor up by its preceding \r count. */
export function toLF(s: string): string {
  return s.includes("\r") ? s.replace(/\r\n?/g, "\n") : s;
}

/** Shared offset→line mapping for review/annotation anchoring. 1-based line
 * numbers; allocation-free (no slice/split per call). */
export function offsetToLine(content: string, offset: number): number {
  if (offset <= 0) return 1;
  const end = Math.min(offset, content.length);
  let line = 1;
  for (let i = 0; i < end; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
}

/** Offset range [from, to) of a 1-based line, excluding its trailing newline.
 * Used as the fallback anchor when a PDF selection can't be matched to specific
 * words (E10b). Clamps a past-EOF line to the last line. Allocation-free. */
export function lineRange(content: string, line: number): { from: number; to: number } {
  let from = 0;
  let cur = 1;
  for (let i = 0; i < content.length && cur < line; i++) {
    if (content.charCodeAt(i) === 10) {
      cur++;
      from = i + 1;
    }
  }
  let to = content.indexOf("\n", from);
  if (to < 0) to = content.length;
  return { from, to };
}
