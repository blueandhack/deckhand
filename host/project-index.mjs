// The project side of ~/.claude/projects/, as PURE functions over injected data.
// Nothing here touches the filesystem; index.mjs does the readdir and hands the
// results in, which is what makes it testable with no hardware and no Mac state.
//
// SCAN_LINES is 40 because the cwd is not on line 1 - the measured file opens
// with two queue-operation records and carries cwd on line 3 - and reading the
// whole file to find one field would turn a 16-project listing into 132 full
// file reads.
export const SCAN_LINES = 40;

const RE_CWD = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/;

export function cwdFromLines(lines) {
  for (const line of lines.slice(0, SCAN_LINES)) {
    const m = RE_CWD.exec(line);
    if (m) return m[1];
  }
  return null;
}

// The last path segment, and NOTHING derived from the directory name. See the
// checker's header for why decoding the directory name is forbidden.
export function projectLabel(cwd) {
  const parts = String(cwd).split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

export function pickTranscript(files, id12) {
  if (!id12) return { ok: false, reason: "empty" };
  const hits = files.filter((f) => f.endsWith(".jsonl") && f.startsWith(id12));
  if (hits.length === 0) return { ok: false, reason: "none" };
  if (hits.length > 1) return { ok: false, reason: "ambiguous" };
  return { ok: true, file: hits[0] };
}
