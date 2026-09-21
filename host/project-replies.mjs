// The two on-demand project replies, as PURE functions over an INJECTED reader.
//
// WHY INJECTED RATHER THAN TOUCHING node:fs DIRECTLY. host/index.mjs is a
// service that starts polling and driving the wire the moment it is imported -
// nothing could ever call these builders in isolation there, and no device
// requests them yet (that lands in a later task). Injecting the reader is what
// host/session-lookup.mjs, host/project-index.mjs, host/ask-chips.mjs and
// host/wire-fit.mjs already do to stay testable with no hardware and no Mac
// state; this module needs actual directory/file reads, so it takes the reader
// as an argument instead of having none. host/index.mjs wires the real
// fs-backed one; host/project-replies-check.mjs wires fakes.
//
// makeProjectReplies({ listDirs, listFiles, statMs, headLines, sessionInfo }):
//   listDirs()              -> Promise<string[]>            names under PROJECTS_DIR
//   listFiles(dir)          -> Promise<string[]>             filenames inside one project dir
//   statMs(dir, file)       -> Promise<number>                that file's mtimeMs
//   headLines(dir, file, n) -> Promise<string[]>              the file's first n lines
//   sessionInfo(dir, file)  -> Promise<{title, turns}>        see the note above buildProjSessReply
//
// FIVE, NOT FOUR. The task brief that seeded this module named four readers
// (listDirs/listFiles/statMs/headLines). A fifth, sessionInfo, was added
// because the same brief also says a session's title must come from
// host/index.mjs's existing transcriptInfo() - "reuse it, do not write
// another" - and transcriptInfo() is a 64KB-tail-and-four-regexes read that
// has no business being reimplemented against headLines() here. Keeping it as
// its own injected function lets the real wiring in index.mjs hand over the
// actual transcriptInfo() call (satisfying "do not write another") while this
// module stays a pure function of whatever the caller injects (satisfying
// testability). The other four keep exactly the shape and meaning the brief
// named. See host/project-replies-check.mjs and the task-3 report for the
// full rationale.
//
// NEVER DECODE A PROJECT DIRECTORY NAME. "-Users-yujia-work-claude-plugins" is
// /Users/yujia/work/claude-plugins, not .../claude/plugins - the hyphen in a
// project's own name is indistinguishable from the path separator the hook
// encoded. project-index.mjs's projectLabel() only ever reads the CWD found
// inside a transcript; when no cwd was found, the directory name is used
// WHOLE, as an opaque key, never split or decoded.
import { SCAN_LINES, cwdFromLines, projectLabel } from "./project-index.mjs";
import { deviceText } from "./to-ascii.mjs";

// The PROJSESS session list is capped for the same reason the tick's session
// rows are: the wire, not the Mac, is the scarce resource. Exported so the
// checker PARSES this value rather than transcribing "60" a second time (see
// CLAUDE.md, "a checker must parse the constant it certifies").
export const PROJSESS_CAP = 60;

// Seconds since LOCAL midnight - the device's own clock unit (see
// host/index.mjs:1106, secondsSinceMidnight, which this duplicates rather
// than importing). Duplicated deliberately rather than imported: index.mjs
// imports THIS module to get its real reader wired up, so an import running
// the other way would be circular. host/to-ascii.mjs documents the same
// "duplicated on purpose" tradeoff for toAscii() vs. its copy in
// claude-hooks/deckhand-session-hook.mjs, for the analogous reason (that copy
// can only import node builtins). Returns -1 when the moment is not today, so
// the device can say "earlier" rather than showing a time from another day.
function secondsSinceMidnight(ms) {
  if (!ms) return -1;
  const d = new Date(ms), now = new Date();
  if (d.toDateString() !== now.toDateString()) return -1;
  return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
}

// A session's transcript is one JSON record per line, and most of those
// records are NOT something the person typed: tool_use, tool_result, system
// and summary/meta lines (queue-operation and friends) all share the file.
// Counting every non-blank line - the first version of this did - measured
// 10,992 on this repo's own largest session against 171 lines a person
// actually wrote: 64x too high, and entirely PLAUSIBLE on a session row, so
// nobody would have caught it without independently counting.
//
// A genuine user turn is a record with type "user" whose content is NOT a
// tool result. Claude Code's own transcript format has no field that says
// "this is what the user typed" more directly than that - a "user"-typed
// record with an array `content` made only of tool_result blocks is the
// SDK feeding a tool's output back in, not the person; there is no existing
// helper elsewhere in host/ for this distinction (histItems() in index.mjs
// branches on `b.type === "tool_result"` per content BLOCK for a different
// purpose - building the scrollback/reader preview - so this reuses that
// same field-level test rather than inventing a new one).
export function countUserTurns(lines) {
  let n = 0;
  for (const line of lines) {
    if (!line || !line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== "user") continue;
    const c = d.message?.content;
    if (typeof c === "string") { n++; continue; } // a plain-text user turn
    if (!Array.isArray(c)) continue;
    if (c.some((b) => b && b.type === "tool_result")) continue; // the tool's own output, not the person
    n++;
  }
  return n;
}

// THE FONTS ARE ASCII 0x20..0x7E AND NOTHING ELSE (CLAUDE.md) - an
// out-of-range byte draws nothing and advances nothing, so it is invisible
// corruption rather than a fallback glyph. Every other device-bound string in
// this module goes through deviceText(), but `k` cannot: the device stores it
// and sends it back verbatim to ask for that project's sessions (PROJSESS
// <key>), so transliterating it would break the round-trip to the real
// directory - toAscii() is lossy (e.g. every unmappable character collapses
// to the same '?'), and a wire key must be exact or it is wrong. So a
// directory name outside the device's own font range is skipped entirely
// rather than mangled - see the skip site below.
const DEVICE_ASCII = /^[\x20-\x7e]*$/;

export function makeProjectReplies({ listDirs, listFiles, statMs, headLines, sessionInfo }) {
  // Keyed by directory: a project's cwd never changes once written, so
  // resolving it costs a bounded read (headLines, not the whole file) at most
  // ONCE per project for the life of this process rather than once per
  // PROJECTS request.
  const cwdCache = new Map();

  // Reads SCAN_LINES lines of the NEWEST .jsonl in `dir` and hands them to
  // cwdFromLines. "Newest" is resolved independently of buildProjectsReply's
  // own scan (a second, cheap stat pass) so this function stays callable and
  // testable on its own - readdir/stat is the "costs nothing" tier this
  // repo's project-index scan is built on; only the CONTENT read is bounded
  // and cached.
  async function cwdForProject(dir, jsonlFiles) {
    if (cwdCache.has(dir)) return cwdCache.get(dir);
    let newestFile = null, newestMs = -1;
    for (const f of jsonlFiles) {
      let ms = 0;
      try { ms = await statMs(dir, f); } catch { ms = 0; }
      if (ms > newestMs) { newestMs = ms; newestFile = f; }
    }
    let lines = [];
    if (newestFile) {
      try { lines = await headLines(dir, newestFile, SCAN_LINES); } catch { lines = []; }
    }
    const cwd = cwdFromLines(lines);
    cwdCache.set(dir, cwd);
    return cwd;
  }

  // readdir + stat ONLY for the listing itself - no full file reads - so a
  // 16-project listing costs nothing beyond the one bounded cwd read per
  // project (and that one is cached after the first request). The label
  // comes from the cwd found inside ONE jsonl per project, never from
  // decoding the directory name - see the module header.
  async function buildProjectsReply() {
    let dirs = [];
    try { dirs = await listDirs(); } catch { return { projs: { items: [] } }; }
    const out = [];
    for (const d of dirs) {
      let files = [];
      try { files = await listFiles(d); } catch { continue; }
      const jsonls = files.filter((f) => f.endsWith(".jsonl"));
      if (!jsonls.length) continue; // a project dir with no transcript is not a project
      // SKIPPED, NOT TRANSLITERATED - see DEVICE_ASCII's comment above: `k`
      // must round-trip to this exact directory, which toAscii() cannot
      // guarantee. Named so silence here is never mistaken for "impossible" -
      // the device end has no other way to learn a project went missing.
      if (!DEVICE_ASCII.test(d)) {
        console.error(`PROJECTS: skipping "${d}" - its directory name is not pure device-ASCII (0x20-0x7E) and cannot be sent as a wire key without corrupting the round-trip.`);
        continue;
      }
      let newestMs = 0;
      for (const f of jsonls) {
        let ms = 0;
        try { ms = await statMs(d, f); } catch { ms = 0; }
        if (ms > newestMs) newestMs = ms;
      }
      const cwd = await cwdForProject(d, jsonls);
      // FALLBACK IS THE OPAQUE DIRECTORY NAME, TAKEN WHOLE. Never
      // projectLabel() on a missing cwd - that function only strips the last
      // "/"-separated segment of a REAL path, and has no idea `d` is a
      // hyphen-encoded path rather than an ordinary label. Calling it on `d`
      // would silently decode the directory name, which is exactly the
      // defect this module exists to avoid.
      const label = cwd ? (projectLabel(cwd) || d) : d;
      out.push({
        k: d,
        n: deviceText(label, 22),
        c: jsonls.length,
        t: secondsSinceMidnight(newestMs),
      });
    }
    // Most-active project first - the one someone is most likely to open.
    out.sort((a, b) => b.c - a.c);
    return { projs: { items: out } };
  }

  // One project's sessions, newest first, capped at PROJSESS_CAP with the
  // TRUE total still stated (so the device can say "60 of 214" rather than
  // silently truncating). `liveIds` - an id12 Set or array - marks whichever
  // of these sessions is in the CURRENT tick's list; the caller (index.mjs)
  // supplies it, since only it knows which sessions are live right now.
  //
  // TWO PASSES, DELIBERATELY. The first pass is readdir + stat only (cheap)
  // and decides the ORDER and the CAP; sessionInfo() - which opens each
  // transcript - only runs for the up-to-PROJSESS_CAP sessions that will
  // actually be sent, not for every session the project has ever had.
  async function buildProjSessReply(key, liveIds = []) {
    const ids = liveIds instanceof Set ? liveIds : new Set(liveIds);
    let files = [];
    try {
      files = await listFiles(key);
    } catch (err) {
      // AN UNKNOWN KEY IS REFUSED BY NAME, NOT ANSWERED WITH AN EMPTY LIST.
      // The two are completely different facts and they used to be the same
      // three bytes on the wire: `{k, items: [], total: 0}` for a project that
      // genuinely has no transcripts, and the SAME reply for a key this Mac has
      // never heard of. Because the key echoes back unchanged, the device's own
      // staleness strcmp matched and level 2 painted "No sessions found" over a
      // project whose level-1 row had just said it has N sessions - nothing at
      // either end naming a cause. It is reachable in ordinary use: a device
      // whose key buffer truncated the directory name (four of this Mac's
      // sixteen projects are 64 characters or longer) asks EXACTLY this way, and
      // so does any Mac that simply does not hold this project - RESUME's own
      // "another paired Mac may hold it" case, one level up.
      // `e` is the whole refusal: the device shows its own named state for it
      // (projects.ino's PROJ_STATE_REFUSED) instead of the empty-list lie.
      return {
        projsess: {
          k: key, items: [], total: 0,
          e: `unknown project key (${String(err?.code || err?.message || "no such directory")})`,
        },
      };
    }
    const jsonls = files.filter((f) => f.endsWith(".jsonl"));
    const meta = [];
    for (const f of jsonls) {
      let ms = 0;
      try { ms = await statMs(key, f); } catch { ms = 0; }
      // The id the device can ever send back is the first 12 characters - see
      // project-index.mjs's pickTranscript(), which resolves the same prefix
      // the other way.
      meta.push({ file: f, id12: f.slice(0, 12), ms });
    }
    meta.sort((a, b) => b.ms - a.ms);
    const total = meta.length;
    const capped = meta.slice(0, PROJSESS_CAP);
    const items = [];
    for (const m of capped) {
      let info = { title: "", turns: 0 };
      try { info = await sessionInfo(key, m.file); } catch { /* keep the empty fallback */ }
      items.push({
        id: m.id12,
        t: deviceText(info.title || "", 40),
        n: Number.isFinite(info.turns) ? info.turns : 0,
        w: secondsSinceMidnight(m.ms),
        live: ids.has(m.id12) ? 1 : 0,
      });
    }
    return { projsess: { k: key, items, total } };
  }

  // The tick's two counters: how many projects have at least one transcript,
  // and the sum of every project's transcript count. readdir ONLY - no stat,
  // no content read - so this is cheap enough to run every 5s. Kept separate
  // from buildProjectsReply on purpose: that function does a bounded content
  // read per project (for the cwd label) and this one must not, since it
  // runs on the tick and buildProjectsReply deliberately does not (see
  // host/index.mjs's readUsage()).
  async function countInventory() {
    let dirs = [];
    try { dirs = await listDirs(); } catch { return { projectCount: 0, sessionTotal: 0 }; }
    let projectCount = 0, sessionTotal = 0;
    for (const d of dirs) {
      // Kept in step with buildProjectsReply's own skip, so this counter
      // never claims more projects than PROJECTS would ever list.
      if (!DEVICE_ASCII.test(d)) continue;
      let files = [];
      try { files = await listFiles(d); } catch { continue; }
      const n = files.filter((f) => f.endsWith(".jsonl")).length;
      if (n > 0) { projectCount++; sessionTotal += n; }
    }
    return { projectCount, sessionTotal };
  }

  return { buildProjectsReply, buildProjSessReply, countInventory };
}
