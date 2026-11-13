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

// THE RETURN VALUE IS A COPY, NOT THE CAPTURE. V8 builds a regex capture as a
// SLICED string - a pointer into the line it was matched in - so returning m[1]
// handed back a 30-byte path that kept its whole line alive. The line it was
// found in is a transcript's opening queue-operation record, which embeds the
// entire first prompt: measured 2026-11-13 at ~131KB each, and makeProjectReplies'
// cwdCache holds one per project directory for the life of the host. 796 of them
// were 104MB of a 124MB live heap after 29 hours (a heap snapshot of the running
// host: every one retained as `parent` of a sliced string in cwdCache). A Buffer
// round trip is the copy that is guaranteed to allocate a fresh flat string;
// slice()/concat() are free to hand back another view of the same parent.
export function cwdFromLines(lines) {
  for (const line of lines.slice(0, SCAN_LINES)) {
    const m = RE_CWD.exec(line);
    if (m) return Buffer.from(m[1], "utf8").toString("utf8");
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
