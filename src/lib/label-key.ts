/**
 * The `\label` / `\ref`-family key under the cursor, or null. Mirrors the
 * command families the Rust rename touches so the rename dialog seeds the key
 * the user is pointing at. Pure (no store/IPC deps) so it unit-tests in
 * isolation.
 */
const CMD_BEFORE =
  /\\(?:labelcref|namecref|cpageref|Cpageref|vpageref|autoref|nameref|pageref|eqref|crefrange|Crefrange|label|cref|Cref|vref|Vref|ref)\*?(?:\[[^\]]*\])?$/;

export function labelKeyAtCursor(doc: string, pos: number): string | null {
  const backStop = Math.max(0, pos - 400);
  let open = -1;
  for (let i = pos - 1; i >= backStop; i--) {
    const c = doc[i];
    if (c === "}") return null;
    if (c === "{" && doc[i - 1] !== "\\") {
      open = i;
      break;
    }
  }
  if (open === -1) return null;
  const fwdStop = Math.min(doc.length, pos + 400);
  let close = -1;
  for (let i = pos; i < fwdStop; i++) {
    const c = doc[i];
    if (c === "}") {
      close = i;
      break;
    }
    if (c === "{") return null;
  }
  if (close === -1) return null;
  if (!CMD_BEFORE.test(doc.slice(Math.max(0, open - 60), open))) return null;
  const inner = doc.slice(open + 1, close);
  // The comma segment covering the cursor.
  const offset = pos - (open + 1);
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === ",") {
      if (i >= offset) break;
      start = i + 1;
    }
  }
  let end = inner.indexOf(",", Math.max(start, offset));
  if (end === -1) end = inner.length;
  const key = inner.slice(start, end).trim();
  return key || null;
}
