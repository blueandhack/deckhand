// Checks host/project-replies.mjs without a filesystem, a device, or a running
// host - the whole point of that module taking an INJECTED reader.
//
// Two tracks, following the shape host/project-index-check.mjs established:
//   suite(makeMod, check)  - behavioural, against fake readers built in-process
//   suiteHost(check, src)  - structural, over host/index.mjs's own source text,
//                            for the one rule that lives entirely in index.mjs:
//                            the tick (readUsage) must never build either reply.
// Both get a real run and a --selftest run against deliberately broken
// stand-ins, so every assertion here is proven to be able to FAIL, not just
// to pass (CLAUDE.md: "an assertion that cannot fail is a defect").
import * as realModule from "./project-replies.mjs";
import { cwdFromLines, projectLabel, SCAN_LINES } from "./project-index.mjs";
import fs from "node:fs";

const SELFTEST = process.argv.includes("--selftest");
const HOST_SRC = fs.readFileSync(new URL("./index.mjs", import.meta.url), "utf8");

// ---------------------------------------------------------------------------
// A tiny in-memory "filesystem": { dirName: { files: { fileName: { ms, lines,
// title, turns } } } }. readersFrom() turns that into the five functions
// makeProjectReplies() expects, throwing on anything not in the fixture - the
// same failure shape a real fs.readdir/fs.stat would give on a missing path,
// which is what exercises this module's own try/catch-and-continue paths.
function readersFrom(fixture) {
  const dir = (d) => {
    const p = fixture[d];
    if (!p) throw new Error(`no such dir: ${d}`);
    return p;
  };
  const file = (d, f) => {
    const ff = dir(d).files[f];
    if (!ff) throw new Error(`no such file: ${d}/${f}`);
    return ff;
  };
  return {
    listDirs: async () => Object.keys(fixture),
    listFiles: async (d) => Object.keys(dir(d).files),
    statMs: async (d, f) => file(d, f).ms,
    headLines: async (d, f, n) => (file(d, f).lines || []).slice(0, n),
    sessionInfo: async (d, f) => ({
      title: file(d, f).title ?? "",
      turns: file(d, f).turns ?? 0,
    }),
  };
}

// A hyphen-only opaque key SHORT ENOUGH to survive the 22-char device cap
// unshortened, so an equality assertion against it proves the module used the
// key WHOLE rather than decoding or truncating it for an unrelated reason.
const OPAQUE_KEY = "-a-b-c";
// A directory name outside the device's font range (0x20-0x7E) - ö is
// 'o' with an umlaut/diaeresis.
const NON_ASCII_KEY = "-Users-yujia-wörk";

function fixtureBasic() {
  return {
    // cwd found on the newest of two transcripts -> label comes from the cwd,
    // not the directory name.
    "-Users-yujia-work-claude-plugins": {
      files: {
        "aaaaaaaaaaaa-old.jsonl": { ms: 1000, lines: [] },
        "bbbbbbbbbbbb-new.jsonl": {
          ms: 2000,
          lines: [
            '{"type":"queue-operation","operation":"enqueue"}',
            '{"cwd":"/Users/yujia/work/claude-plugins"}',
          ],
        },
      },
    },
    // no cwd anywhere in the (short, hyphen-only) newest transcript -> THE
    // directory name is the label, taken WHOLE and never decoded.
    [OPAQUE_KEY]: {
      files: { "cccccccccccc.jsonl": { ms: 500, lines: [] } },
    },
    // a non-ASCII cwd - proves deviceText() actually transliterated rather
    // than merely capping. "café" NFD-decomposes to e + a combining acute,
    // which to-ascii.mjs's COMBINING branch drops, yielding "cafe".
    "-Users-yujia-work-cafe": {
      files: {
        "dddddddddddd.jsonl": {
          ms: 3000,
          lines: ['{"cwd":"/Users/yujia/work/café"}'],
        },
      },
    },
    // a directory with files but none of them .jsonl - not a project, must
    // not appear in the reply nor count toward the inventory.
    "-Users-yujia-not-a-project": {
      files: { "notes.txt": { ms: 1, lines: [] } },
    },
    // a directory name that is itself outside the device's font range
    // (0x20-0x7E) - `k` must be skipped rather than mangled, since it has to
    // round-trip exactly for PROJSESS to work. Has a real .jsonl, so if the
    // skip were missing this WOULD otherwise be listed.
    [NON_ASCII_KEY]: {
      files: { "eeeeeeeeeeee.jsonl": { ms: 999, lines: [] } },
    },
  };
}

function fixtureManySessions(n) {
  const files = {};
  for (let i = 0; i < n; i++) {
    // First 12 characters must be unique and stable - that's the id the
    // device can ever send back (see project-index.mjs's pickTranscript()).
    const stem = String(i).padStart(12, "0");
    files[`${stem}.jsonl`] = { ms: 1000 + i, title: `session ${i}`, turns: i };
  }
  return { proj: { files } };
}

// ---------------------------------------------------------------------------
function suite(makeMod, check) {
  return (async () => {
    const mod = makeMod(readersFrom(fixtureBasic()));
    const res = await mod.buildProjectsReply();

    check("the projects reply has exactly one top-level key, 'items'",
      Object.keys(res.projs).sort(), ["items"]);
    check("a project with no .jsonl at all is not listed",
      res.projs.items.some((it) => it.k === "-Users-yujia-not-a-project"), false);
    check("a project whose directory name is outside device-ASCII is skipped, not shipped",
      res.projs.items.some((it) => it.k === NON_ASCII_KEY), false);
    check("every ASCII project with at least one .jsonl is listed, and only those",
      res.projs.items.length, 3);

    for (const it of res.projs.items) {
      check(`projs["${it.k}"] has exactly the wire fields k,n,c,t`,
        Object.keys(it).sort(), ["c", "k", "n", "t"]);
      check(`projs["${it.k}"].n is capped at 22`, it.n.length <= 22, true);
    }

    const byKey = Object.fromEntries(res.projs.items.map((it) => [it.k, it]));
    check("a resolved cwd yields its own last path segment as the label",
      byKey["-Users-yujia-work-claude-plugins"].n, "claude-plugins");
    check("no cwd found -> the directory name is the label, taken WHOLE (never decoded)",
      byKey[OPAQUE_KEY].n, OPAQUE_KEY);
    check("a non-ASCII cwd's label is transliterated by deviceText, not merely capped",
      byKey["-Users-yujia-work-cafe"].n, "cafe");
    check("a project's session count (c) is the number of its .jsonl files",
      byKey["-Users-yujia-work-claude-plugins"].c, 2);

    // The skip must be NAMED, not silent - CLAUDE.md's rule that "silence and
    // 'impossible here' must never look alike from the other end" applies to
    // this Mac's own log just as much as to the wire. Captured rather than
    // just trusted, so a fix that skips quietly still fails this suite.
    {
      const seen = [];
      const realError = console.error;
      console.error = (...args) => seen.push(args.join(" "));
      try { await mod.buildProjectsReply(); }
      finally { console.error = realError; }
      check("the skipped non-ASCII directory is logged BY NAME",
        seen.some((line) => line.includes(NON_ASCII_KEY)), true);
    }

    // -----------------------------------------------------------------
    const withInventory = await mod.countInventory();
    check("countInventory counts only directories that hold a .jsonl",
      withInventory.projectCount, 3);
    check("countInventory sums every project's .jsonl count",
      withInventory.sessionTotal, 4);

    // -----------------------------------------------------------------
    const sessMod = makeMod(readersFrom({
      proj: {
        files: {
          "111111111111.jsonl": { ms: 3000, title: "Third (newest)", turns: 9 },
          "222222222222.jsonl": { ms: 1000, title: "First (oldest)", turns: 1 },
          "333333333333.jsonl": { ms: 2000, title: "Second", turns: 5 },
        },
      },
    }));
    const sr = await sessMod.buildProjSessReply("proj", ["222222222222"]);
    check("the projsess reply has exactly the wire fields k,items,total",
      Object.keys(sr.projsess).sort(), ["items", "k", "total"]);
    check("projsess.k echoes the key asked for", sr.projsess.k, "proj");
    check("projsess is sorted newest first",
      sr.projsess.items.map((it) => it.id),
      ["111111111111", "333333333333", "222222222222"]);
    check("the session named in liveIds is marked live:1 and no other is",
      sr.projsess.items.map((it) => it.live), [0, 0, 1]);
    for (const it of sr.projsess.items) {
      check(`projsess item "${it.id}" has exactly the wire fields id,t,n,w,live`,
        Object.keys(it).sort(), ["id", "live", "n", "t", "w"]);
      check(`projsess item "${it.id}"'s id is at most 12 characters`, it.id.length <= 12, true);
    }

    // -----------------------------------------------------------------
    const longTitle = "x".repeat(80);
    const capMod = makeMod(readersFrom({
      proj: { files: { "444444444444.jsonl": { ms: 1, title: longTitle, turns: 0 } } },
    }));
    const capRes = await capMod.buildProjSessReply("proj", []);
    check("a session title longer than 40 characters is capped at 40",
      capRes.projsess.items[0].t.length, 40);

    // -----------------------------------------------------------------
    const manyN = 75;
    const manyMod = makeMod(readersFrom(fixtureManySessions(manyN)));
    const manyRes = await manyMod.buildProjSessReply("proj", []);
    check(`a project with ${manyN} sessions ships at most PROJSESS_CAP (${realModule.PROJSESS_CAP}) of them`,
      manyRes.projsess.items.length, realModule.PROJSESS_CAP);
    check("...but the TRUE total is still stated, not the capped count",
      manyRes.projsess.total, manyN);

    // -----------------------------------------------------------------
    // AN UNKNOWN KEY AND AN EMPTY PROJECT MUST NOT LOOK THE SAME. They used to
    // be the same three fields, and the consequence was on the glass: the key
    // echoes back UNCHANGED, so the device's staleness strcmp matched and level
    // 2 drew "No sessions found" for a project whose own row had just said it
    // has N sessions. It is reachable in ordinary use - a device whose key
    // buffer truncated the directory name asks exactly this way, and so does a
    // second paired Mac that simply does not hold this project. Checked as a
    // PAIR, deliberately: the refusal assertion alone would pass on a module
    // that stamped `e` on every reply, so the empty-project case below is what
    // makes this one mean "distinguishable" rather than "present".
    const missingKeyMod = makeMod(readersFrom(fixtureBasic()));
    const missing = await missingKeyMod.buildProjSessReply("does-not-exist", []);
    check("an unknown project key is REFUSED BY NAME rather than answered with an empty list",
      {
        k: missing.projsess.k,
        items: missing.projsess.items,
        total: missing.projsess.total,
        named: typeof missing.projsess.e === "string" && missing.projsess.e.length > 0,
      },
      { k: "does-not-exist", items: [], total: 0, named: true });

    const emptyProjMod = makeMod(readersFrom({ "-a-real-but-empty-project": { files: { "notes.md": { ms: 1 } } } }));
    const emptyRes = await emptyProjMod.buildProjSessReply("-a-real-but-empty-project", []);
    check("a project that REALLY has no transcripts answers an empty list and no refusal",
      emptyRes, { projsess: { k: "-a-real-but-empty-project", items: [], total: 0 } });

    const brokenDirsMod = makeMod({
      listDirs: async () => { throw new Error("readdir failed"); },
      listFiles: async () => [],
      statMs: async () => 0,
      headLines: async () => [],
      sessionInfo: async () => ({ title: "", turns: 0 }),
    });
    check("a readdir failure answers an empty projects list rather than throwing",
      await brokenDirsMod.buildProjectsReply(), { projs: { items: [] } });
    check("a readdir failure answers a zeroed inventory rather than throwing",
      await brokenDirsMod.countInventory(), { projectCount: 0, sessionTotal: 0 });
  })();
}

// Runs suite(makeMod, check) to completion, collecting pass/fail rather than
// exiting, so --selftest can run it many times (real module, then each broken
// stand-in) in one process.
async function run(makeMod, quiet) {
  const failures = [];
  let pass = 0;
  const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) { pass++; if (!quiet) console.log(`  PASS  ${name}`); }
    else {
      failures.push(name);
      if (!quiet) console.log(`  FAIL  ${name}` +
        `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
    }
  };
  try { await suite(makeMod, check); }
  catch (e) { failures.push(`THREW: ${e.message}`); if (!quiet) console.log(`  FAIL  THREW: ${e.stack || e.message}`); }
  return { pass, failures };
}

// ---------------------------------------------------------------------------
// countUserTurns() IN ISOLATION - it has no readers to fake, so it gets its
// own tiny suite/run rather than being folded into suite()/run() above (which
// only ever exercises whatever a `makeMod(readers)` factory produces, and
// countUserTurns is a plain exported function, not part of that factory's
// output). A user turn, a tool_result masquerading as a "user" record, an
// assistant turn, and a queue-operation meta line - exactly the mix that made
// a raw non-blank-line count 64x too high on a real transcript (measured:
// 10,992 shipped vs. 171 lines a person actually wrote). Only the first is a
// turn a PERSON authored.
const TURN_LINES = [
  '{"type":"user","message":{"content":"hello there"}}',
  '{"type":"user","message":{"content":[{"type":"tool_result","content":"ok","is_error":false}]}}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}',
  '{"type":"queue-operation","operation":"enqueue"}',
  "", // a blank line, as real transcripts have between some records
];

function runTurns(countUserTurnsFn, quiet) {
  const failures = [];
  let pass = 0;
  const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) { pass++; if (!quiet) console.log(`  PASS  ${name}`); }
    else {
      failures.push(name);
      if (!quiet) console.log(`  FAIL  ${name}` +
        `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
    }
  };
  try {
    check("countUserTurns counts only user-authored turns, not tool_result/assistant/meta lines",
      countUserTurnsFn(TURN_LINES), 1);
  } catch (e) { failures.push(`THREW: ${e.message}`); if (!quiet) console.log(`  FAIL  THREW: ${e.message}`); }
  return { pass, failures };
}

// ---------------------------------------------------------------------------
// THE STRUCTURAL HALF. Bound to readUsage's FUNCTION BODY specifically (never
// the whole file - "a rule a neighbouring line can satisfy is not a rule"),
// via brace-depth matching rather than the first "\n}" - readUsage is long
// and full of nested object literals, so a naive search would stop at the
// first nested closing brace and silently certify only a fragment.
function bodyOf(hostSrc, fnName) {
  const at = hostSrc.indexOf(`async function ${fnName}(`);
  if (at < 0) return "";
  const braceStart = hostSrc.indexOf("{", at);
  if (braceStart < 0) return "";
  let depth = 0, i = braceStart;
  for (; i < hostSrc.length; i++) {
    if (hostSrc[i] === "{") depth++;
    else if (hostSrc[i] === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return hostSrc.slice(at, i);
}

function suiteHost(check, hostSrc) {
  const body = bodyOf(hostSrc, "readUsage");
  // PAIRED, DELIBERATELY (CLAUDE.md / task-3 ruling PF-2, T3-B): the negative
  // assertion below is `!/re/.test(body)`, which is true for an EMPTY string
  // too - so on its own it would pass vacuously if readUsage were deleted or
  // renamed. This assertion makes that failure visible by name.
  check("readUsage's own function body was found (not empty, not renamed away)",
    body.length > 0, true);
  check("the tick payload does not carry the project inventory (readUsage never builds buildProjectsReply or a projsess reply)",
    body.length > 0 && !/buildProjectsReply|projsess/.test(body), true);

  // sessionInfo() is index.mjs's real-fs wiring for a session's turn count -
  // bound to ITS body, again paired with a "found" assertion, so a
  // regression back to a raw non-blank-line count (the 64x-too-high defect
  // this fix round exists to close) fails by name rather than the suite
  // simply going quiet on it.
  const siBody = bodyOf(hostSrc, "sessionInfo");
  check("sessionInfo's own function body was found (not empty, not renamed away)",
    siBody.length > 0, true);
  check("sessionInfo counts turns via countUserTurns(), not a raw line count",
    siBody.length > 0 && /countUserTurns\(/.test(siBody), true);
}

function runHost(hostSrc, quiet) {
  const failures = [];
  let pass = 0;
  const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) { pass++; if (!quiet) console.log(`  PASS  ${name}`); }
    else {
      failures.push(name);
      if (!quiet) console.log(`  FAIL  ${name}` +
        `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
    }
  };
  try { suiteHost(check, hostSrc); }
  catch (e) { failures.push(`THREW: ${e.message}`); if (!quiet) console.log(`  FAIL  THREW: ${e.message}`); }
  return { pass, failures };
}

// ---------------------------------------------------------------------------
if (!SELFTEST) {
  const r = await run(realModule.makeProjectReplies, false);
  const rt = runTurns(realModule.countUserTurns, false);
  const rh = runHost(HOST_SRC, false);
  const total = r.failures.length + rt.failures.length + rh.failures.length;
  console.log(`\n${total} failure(s)`);
  process.exit(total ? 1 : 0);
}

// --- teeth. Each behavioural fault is a broken STAND-IN makeMod(readers),
// built from the SAME readers the real one gets - most by post-processing the
// real module's own (correct) output in the one specific way the named
// historical bug would have, a few others via a standalone broken
// reimplementation of the one function being mis-behaved, so this module
// deleted entirely still fails these the same way it fails the real run.
const faults = [
  ["an unknown project key answers an ordinary empty list again (the shipped bug)",
    (readers) => {
      const real = realModule.makeProjectReplies(readers);
      return {
        ...real,
        buildProjSessReply: async (key, liveIds = []) => {
          const res = await real.buildProjSessReply(key, liveIds);
          if (res.projsess.e) delete res.projsess.e;  // BUG: silence the refusal
          return res;
        },
      };
    }],
  ["the opaque-fallback label is decoded (hyphens read as path separators) instead of used whole",
    (readers) => {
      const real = realModule.makeProjectReplies(readers);
      return {
        ...real,
        buildProjectsReply: async () => {
          const res = await real.buildProjectsReply();
          for (const it of res.projs.items) {
            // Only the fallback case (label === key) is corrupted, matching
            // the exact defect CLAUDE.md names: "-Users-yujia-work-claude-
            // plugins" decoded into a path instead of kept whole.
            if (it.n === it.k) {
              const parts = it.k.split("-").filter(Boolean);
              it.n = parts.length ? parts[parts.length - 1] : it.k;
            }
          }
          return res;
        },
      };
    }],
  ["a project's label skips deviceText (raw, untransliterated cwd segment shipped)",
    (readers) => ({
      ...realModule.makeProjectReplies(readers),
      buildProjectsReply: async () => {
        let dirs = [];
        try { dirs = await readers.listDirs(); } catch { return { projs: { items: [] } }; }
        const out = [];
        for (const d of dirs) {
          let files = [];
          try { files = await readers.listFiles(d); } catch { continue; }
          const jsonls = files.filter((f) => f.endsWith(".jsonl"));
          if (!jsonls.length) continue;
          let newestMs = 0, newestFile = null;
          for (const f of jsonls) {
            let ms = 0;
            try { ms = await readers.statMs(d, f); } catch { /* keep 0 */ }
            if (ms > newestMs) { newestMs = ms; newestFile = f; }
          }
          let lines = [];
          if (newestFile) { try { lines = await readers.headLines(d, newestFile, SCAN_LINES); } catch { /* keep [] */ } }
          const cwd = cwdFromLines(lines);
          const label = cwd ? (projectLabel(cwd) || d) : d;
          out.push({ k: d, n: label, c: jsonls.length, t: -1 }); // BUG: no deviceText()
        }
        out.sort((a, b) => b.c - a.c);
        return { projs: { items: out } };
      },
    })],
  ["a session title skips deviceText (raw, uncapped title shipped)",
    (readers) => ({
      ...realModule.makeProjectReplies(readers),
      buildProjSessReply: async (key, liveIds = []) => {
        const ids = liveIds instanceof Set ? liveIds : new Set(liveIds);
        let files = [];
        try { files = await readers.listFiles(key); } catch { return { projsess: { k: key, items: [], total: 0 } }; }
        const jsonls = files.filter((f) => f.endsWith(".jsonl"));
        const meta = [];
        for (const f of jsonls) {
          let ms = 0;
          try { ms = await readers.statMs(key, f); } catch { /* keep 0 */ }
          meta.push({ file: f, id12: f.slice(0, 12), ms });
        }
        meta.sort((a, b) => b.ms - a.ms);
        const total = meta.length;
        const items = [];
        for (const m of meta.slice(0, realModule.PROJSESS_CAP)) {
          let info = { title: "", turns: 0 };
          try { info = await readers.sessionInfo(key, m.file); } catch { /* keep fallback */ }
          items.push({ id: m.id12, t: info.title || "", n: info.turns || 0, w: -1, live: ids.has(m.id12) ? 1 : 0 }); // BUG: no cap/deviceText on t
        }
        return { projsess: { k: key, items, total } };
      },
    })],
  ["the session list ignores PROJSESS_CAP and ships every session",
    (readers) => {
      const real = realModule.makeProjectReplies(readers);
      return {
        ...real,
        buildProjSessReply: async (key, liveIds = []) => {
          const ids = liveIds instanceof Set ? liveIds : new Set(liveIds);
          let files = [];
          try { files = await readers.listFiles(key); } catch { return { projsess: { k: key, items: [], total: 0 } }; }
          const jsonls = files.filter((f) => f.endsWith(".jsonl"));
          const meta = [];
          for (const f of jsonls) {
            let ms = 0;
            try { ms = await readers.statMs(key, f); } catch { /* keep 0 */ }
            meta.push({ file: f, id12: f.slice(0, 12), ms });
          }
          meta.sort((a, b) => b.ms - a.ms);
          const items = [];
          for (const m of meta) { // BUG: no .slice(0, PROJSESS_CAP)
            let info = { title: "", turns: 0 };
            try { info = await readers.sessionInfo(key, m.file); } catch { /* keep fallback */ }
            items.push({
              id: m.id12,
              t: (info.title || "").slice(0, 40),
              n: info.turns || 0,
              w: -1,
              live: ids.has(m.id12) ? 1 : 0,
            });
          }
          return { projsess: { k: key, items, total: meta.length } };
        },
      };
    }],
  ["the true session total is replaced by the (post-cap) shipped count",
    (readers) => {
      const real = realModule.makeProjectReplies(readers);
      return {
        ...real,
        buildProjSessReply: async (key, liveIds) => {
          const res = await real.buildProjSessReply(key, liveIds);
          res.projsess.total = res.projsess.items.length; // BUG
          return res;
        },
      };
    }],
  ["the live flag is never set, even for a session named in liveIds",
    (readers) => {
      const real = realModule.makeProjectReplies(readers);
      return {
        ...real,
        buildProjSessReply: async (key, liveIds) => {
          const res = await real.buildProjSessReply(key, liveIds);
          for (const it of res.projsess.items) it.live = 0; // BUG
          return res;
        },
      };
    }],
  ["the session list is not sorted newest-first",
    (readers) => {
      const real = realModule.makeProjectReplies(readers);
      return {
        ...real,
        buildProjSessReply: async (key, liveIds) => {
          const res = await real.buildProjSessReply(key, liveIds);
          res.projsess.items.reverse(); // BUG
          return res;
        },
      };
    }],
  ["countInventory counts every directory, not only ones holding a .jsonl",
    (readers) => ({
      ...realModule.makeProjectReplies(readers),
      countInventory: async () => {
        let dirs = [];
        try { dirs = await readers.listDirs(); } catch { return { projectCount: 0, sessionTotal: 0 }; }
        let projectCount = 0, sessionTotal = 0;
        for (const d of dirs) {
          projectCount++; // BUG: no jsonl-count guard
          let files = [];
          try { files = await readers.listFiles(d); } catch { continue; }
          sessionTotal += files.filter((f) => f.endsWith(".jsonl")).length;
        }
        return { projectCount, sessionTotal };
      },
    })],
  ["a non-ASCII directory name ships anyway instead of being skipped",
    (readers) => ({
      ...realModule.makeProjectReplies(readers),
      buildProjectsReply: async () => {
        // Same shape as the real function, minus the DEVICE_ASCII guard -
        // the exact regression finding 3 exists to prevent: `k` corrupted
        // (or here, merely un-filtered) on its way to the wire.
        let dirs = [];
        try { dirs = await readers.listDirs(); } catch { return { projs: { items: [] } }; }
        const out = [];
        for (const d of dirs) {
          let files = [];
          try { files = await readers.listFiles(d); } catch { continue; }
          const jsonls = files.filter((f) => f.endsWith(".jsonl"));
          if (!jsonls.length) continue;
          out.push({ k: d, n: d.slice(0, 22), c: jsonls.length, t: -1 }); // BUG: no ASCII guard
        }
        out.sort((a, b) => b.c - a.c);
        return { projs: { items: out } };
      },
    })],
];

let caught = 0;
for (const [name, makeMod] of faults) {
  const r = await run(makeMod, true);
  if (r.failures.length) {
    caught++;
    console.log(`  caught  ${name}`);
    console.log(`            by: ${r.failures[0]}` +
      (r.failures.length > 1 ? ` (+${r.failures.length - 1} more)` : ""));
  } else {
    console.log(`  MISSED  ${name}  <- no assertion notices this`);
  }
}

// countUserTurns faults - its own small loop, mirroring the pattern above but
// against runTurns() rather than run().
const turnFaults = [
  ["countUserTurns reverts to counting every non-blank line, tool_result/assistant/meta included",
    (lines) => lines.filter((l) => l && l.trim().length > 0).length],
];

let turnCaught = 0;
for (const [name, fn] of turnFaults) {
  const r = runTurns(fn, true);
  if (r.failures.length) {
    turnCaught++;
    console.log(`  caught  ${name}`);
    console.log(`            by: ${r.failures[0]}` +
      (r.failures.length > 1 ? ` (+${r.failures.length - 1} more)` : ""));
  } else {
    console.log(`  MISSED  ${name}  <- no assertion notices this`);
  }
}

// Host structural faults, following project-index-check.mjs's own pattern.
const hostFaults = [
  ["readUsage is deleted outright",
    (() => {
      const at = HOST_SRC.indexOf("async function readUsage(");
      const braceStart = HOST_SRC.indexOf("{", at);
      let depth = 0, i = braceStart;
      for (; i < HOST_SRC.length; i++) {
        if (HOST_SRC[i] === "{") depth++;
        else if (HOST_SRC[i] === "}") { depth--; if (depth === 0) { i++; break; } }
      }
      return HOST_SRC.slice(0, at) + HOST_SRC.slice(i);
    })()],
  ["readUsage regresses to folding the project inventory into the tick",
    HOST_SRC.replace(
      "async function readUsage() {",
      "async function readUsage() {\n  await buildProjectsReply(); // regression: inventory back on the tick\n"
    )],
  ["sessionInfo regresses to a raw non-blank-line count instead of countUserTurns()",
    HOST_SRC.replace(
      "return { title: tx.title, turns: countUserTurns(lines) };",
      'return { title: tx.title, turns: lines.filter((l) => l.trim().length > 0).length };'
    )],
];

let hostCaught = 0;
for (const [name, hostSrc] of hostFaults) {
  const r = runHost(hostSrc, true);
  if (r.failures.length) {
    hostCaught++;
    console.log(`  caught  ${name}`);
    console.log(`            by: ${r.failures[0]}` +
      (r.failures.length > 1 ? ` (+${r.failures.length - 1} more)` : ""));
  } else {
    console.log(`  MISSED  ${name}  <- no assertion notices this`);
  }
}

const totalFaults = faults.length + turnFaults.length + hostFaults.length;
const totalCaught = caught + turnCaught + hostCaught;
console.log(`\nselftest: ${totalCaught}/${totalFaults} faults caught`);
process.exit(totalCaught === totalFaults ? 0 : 1);
