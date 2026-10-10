#!/usr/bin/env node
// PROJECTS WITH TWO MACS - structural checks, every one bound to a FUNCTION BODY.
//
// The defect this guards: both Macs answer a PROJECTS broadcast, and the `projs`
// absorption wrote from projects[0] every time, so the second answer erased the
// first and only one Mac's projects ever showed. Below level 1 the same broadcast
// let the Mac WITHOUT a project answer "this Mac has no such project" over the real
// list, and broadcast the transcript fetch to both. The fix: every row records its
// Mac, each reply replaces only its own Mac's rows inside a fair share, and level 2
// and level 3 are ADDRESSED to that Mac.
//
// Run with --selftest to inject each fault into an in-memory copy and require that
// it FAILS by name. An assertion that cannot fail is a defect (CLAUDE.md).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(DIR, f), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

// Brace-matched body of the block that OPENS at the first `{` after `sig`.
function block(src, sig) {
  const at = src.indexOf(sig);
  if (at < 0) return "";
  const open = src.indexOf("{", at);
  let d = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") d++;
    else if (src[i] === "}" && --d === 0) return src.slice(open, i + 1);
  }
  return "";
}

function run(files) {
  const INO = strip(files.ino), PROJ = strip(files.proj), SCROLL = strip(files.scroll);
  const HOST = files.host;
  const fails = [];
  const ok = (name, cond) => { if (!cond) fails.push(name); };

  // 1. LEVEL 0 - the list. A reply replaces ITS OWN Mac's rows, never the list.
  const projs = block(INO, "if (!projs.isNull())");
  ok("projs: the absorption block is found", projs.length > 200);
  ok("projs: rows are appended after the OTHER Mac's - n starts at projectCount, not 0",
     /int n = projectCount,/.test(projs) && !/int n = 0,/.test(projs));
  ok("projs: room is made per Mac before anything is stored",
     /projMakeRoomFor\(host,/.test(projs) && /const uint8_t host = replyHostSlot\(\)/.test(projs));
  ok("projs: every stored row records the Mac it came from", /p\.hostSlot = host;/.test(projs));
  ok("projs: a row is stored only while the Mac's share has room", /room <= 0/.test(projs) && /room--;/.test(projs));

  const room = block(PROJ, "int projMakeRoomFor(uint8_t host, int incoming)");
  ok("room: the replying Mac's OLD rows are removed first - its reply replaces them",
     /projects\[r\]\.hostSlot != host/.test(room));
  ok("room: a Mac over its FAIR share gives way, so neither can crowd the other out",
     /PROJ_SLOTS \/ \(projHostsListed\(\) \+ 1\)/.test(room) && /held > most/.test(room));
  ok("room: reclaimed from the victim's LEAST-active end (the list is kept sorted)",
     /for \(int r = projectCount - 1; r >= 0; r--\)/.test(room));

  // The device must order the merged list by the SAME field the host sorts by, or
  // one Mac's list silently reorders. Parsed from BOTH sides, never transcribed.
  const hostKey = (/out\.sort\(\(a, b\) => b\.(\w+) - a\.\1\)/.exec(HOST) || [])[1];
  const devKey = (/projects\[j\]\.(\w+) < t\.\1/.exec(block(PROJ, "void projSortRows()")) || [])[1];
  const field = { c: "count", t: "tod", n: "name" };
  ok(`sort: the device orders by the host's own key (host b.${hostKey}, device .${devKey})`,
     hostKey && devKey && field[hostKey] === devKey);
  ok("sort: it is STABLE (strict <), so one Mac's ties keep the host's order",
     /projects\[j\]\.count < t\.count/.test(block(PROJ, "void projSortRows()")));
  ok("projs: the merged list is sorted after the reply lands", /projSortRows\(\);/.test(projs));

  // 2. Attribution. A payload that names itself wins; otherwise the transport.
  const rhs = block(PROJ, "uint8_t replyHostSlot()");
  ok("attribution: a self-identifying payload (curLink) is trusted first",
     rhs.indexOf("curLink >= 0") >= 0 && rhs.indexOf("curLink >= 0") < rhs.indexOf("usbHostId"));
  ok("attribution: otherwise the USB Mac, or the Mac learned for THIS BLE slot",
     /curLineFromUsb \? usbHostId/.test(rhs) && /bleLinks\[curRxBleSlot\]\.hostId/.test(rhs));
  // curRxBleSlot - not bleFrameSlot, which goes stale after the drain - so a
  // MULTITEST injection is never attributed to whichever central spoke last.
  ok("attribution: the BLE slot is marked ONLY around the real drain, then cleared",
     /curRxBleSlot = \(int8_t\) bleFrameSlot;\s*for \(size_t i = 0; i < got; i\+\+\)\s*feedChar\([^;]*\);\s*curRxBleSlot = -1;/.test(INO.replace(/#if BOARD_HAS_PROJECTS|#endif/g, "")));
  ok("attribution: each BLE slot learns its Mac from that Mac's own payload",
     /strlcpy\(bleLinks\[curRxBleSlot\]\.hostId, hid,/.test(INO));
  ok("attribution: a reaped slot forgets its Mac", /bleLinks\[i\]\.hostId\[0\] = '\\0';/.test(INO));

  // 3. LEVEL 1 - one project's sessions, from that project's Mac only.
  ok("level 1: opening a project remembers its Mac with its key",
     /projOpenHost = projects\[pos\]\.hostSlot;/.test(block(PROJ, "void projOpenLevel1(int pos)")));
  ok("level 1: the PROJSESS request is ADDRESSED to that Mac, not broadcast",
     /sendLineToHost\(m, projOpenHost\);/.test(block(PROJ, "void requestProjSessions(const char* key)")));
  const ps = block(INO, "if (!projsess.isNull())");
  const iGuard = ps.indexOf("replyHostSlot() != projOpenHost");
  ok("level 1: a reply from the OTHER Mac is refused BEFORE it touches any psess state",
     iGuard >= 0 && iGuard < ps.indexOf("psessPending = false"));

  // 4. LEVEL 2 - the transcript.
  const sob = block(SCROLL, "void scrollOpenById(");
  ok("level 2: the transcript fetch is ADDRESSED when the project's Mac is known",
     /scrollFetch\(id12, scrollProjHost, false\);/.test(sob));
  ok("level 2: scrollProjHost is one-shot, so a later caller that names nothing broadcasts",
     /scrollProjHost = 255;/.test(sob));
  ok("level 2: BOTH callers name the Mac immediately before opening",
     /scrollProjHost = projOpenHost;\s*scrollOpenById\(psess\[pos\]/.test(PROJ) &&
     /scrollProjHost = projOpenHost;\s*scrollOpenById\(psess\[si\]/.test(INO));

  // 5. The row says which Mac, and the tag is IN the signature (CLAUDE.md: every
  // drawn field must be, or a second Mac connecting leaves the rows untagged).
  const draw = block(PROJ, "void drawProjectRow(int pos)");
  ok("row: the Mac tag is drawn, from dispMacTag (\"\" with one Mac)", /dispMacTag\(p\.hostSlot\)/.test(draw));
  ok("row: the tag takes width from the NAME, never from PROJ_META_W",
     /fitText\(nameBuf, sizeof\(nameBuf\), p\.name, nameZoneW - macW\)/.test(draw));
  ok("row: the tag is part of the row signature",
     /dispMacTag\(p\.hostSlot\)\);/.test(block(PROJ, "for (int pos = 0; pos < projectCount; pos++)")));

  // 6. Stale Macs - a Mac that left must not keep rows that address it.
  ok("stale: a fresh request first forgets the rows of Macs no longer talking",
     /projDropStaleHosts\(\);\s*sendLineToHost\("PROJECTS"\);/.test(block(PROJ, "void requestProjects()")));
  return fails;
}

const files = {
  ino: read("deckhand_display.ino"), proj: read("projects.ino"), scroll: read("scrollback.ino"),
  host: fs.readFileSync(path.join(DIR, "..", "..", "host", "project-replies.mjs"), "utf8"),
};

if (process.argv.includes("--selftest")) {
  const faults = [
    ["the original bug: the list written from projects[0] again", "ino", "int n = projectCount,", "int n = 0,"],
    ["rows never record their Mac", "ino", "p.hostSlot = host;", ""],
    ["a reply appends instead of replacing its own Mac's rows", "proj", "projects[r].hostSlot != host", "true"],
    ["no fair share - first Mac to answer fills the list", "proj", "held > most", "false"],
    ["device sorts by recency while the host sorts by activity", "proj", "projects[j].count < t.count", "projects[j].tod < t.tod"],
    ["attribution trusts the transport over a self-identifying payload", "proj",
     "if (curLink >= 0 && curLink < MAX_LINKS) return (uint8_t) curLink;", ""],
    ["the stale bleFrameSlot used instead of the drain-scoped marker", "ino",
     "curRxBleSlot = (int8_t) bleFrameSlot;", ""],
    ["PROJSESS broadcast again", "proj", "sendLineToHost(m, projOpenHost);", "sendLineToHost(m);"],
    ["the other Mac's psess reply accepted", "ino", "replyHostSlot() != projOpenHost", "false"],
    ["transcript broadcast again", "scroll", "scrollFetch(id12, scrollProjHost, false);", "scrollFetch(id12, 0, true);"],
    ["the Mac tag left out of the row signature", "proj",
     "projectIsLive(pos) ? 1 : 0, dispMacTag(p.hostSlot));", "projectIsLive(pos) ? 1 : 0, \"\");"],
    ["a departed Mac's rows kept for ever", "proj", "  projDropStaleHosts();\n", "\n"],
  ];
  let caught = 0;
  for (const [name, file, from, to] of faults) {
    const copy = { ...files };
    if (!copy[file].includes(from)) { console.log(`  BROKEN  ${name} - injection text not found`); continue; }
    copy[file] = copy[file].replace(from, to);
    const f = run(copy);
    if (f.length) { caught++; console.log(`  caught  ${name}\n            by: ${f[0]}`); }
    else console.log(`  MISSED  ${name}`);
  }
  console.log(`selftest: ${caught}/${faults.length} injected faults caught`);
  process.exit(caught === faults.length ? 0 : 1);
}

const fails = run(files);
for (const f of fails) console.log(`  FAIL  ${f}`);
console.log(fails.length ? `${fails.length} failed` : "projects-multimac: all checks passed");
process.exit(fails.length ? 1 : 0);
