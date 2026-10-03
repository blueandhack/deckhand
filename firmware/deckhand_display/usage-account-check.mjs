#!/usr/bin/env node
// USAGE-PER-ACCOUNT CHECKER - runs on the Mac, needs no hardware.
//
//   node usage-account-check.mjs             check the mirror and the sketch
//   node usage-account-check.mjs --selftest  prove it has teeth
//
// WHY THIS EXISTS. mergeUsage() used to assume both Macs poll ONE Claude account, so
// it took the freshest reading from ANY link - which, with two Macs signed into two
// different accounts, swapped one person's quota for the other's at the OAuth poll
// cadence, and (pinned) borrowed one account's Codex reading for the other. It now
// groups links into ACCOUNTS (linksShareAccount(): both name an `acct` and the names
// agree) and merges freshest-wins only WITHIN an account, showing the selected one.
//
// TWO HALVES, REPORTED SEPARATELY, because a mirror binds nothing:
//   MIRROR      a JS re-implementation of the grouping, selection and freshest-wins
//               rules, run against the cases the design names. Proves the ALGORITHM.
//               It keeps passing with the real code deleted.
//   STRUCTURAL  reads the firmware's own text, each assertion bound to ONE FUNCTION
//               BODY (fnBody) - never to the file, where a neighbouring line could
//               satisfy it. Only this half says anything about the sketch.
//
// --selftest applies each fault below as an EDIT to the real source text and requires
// it to be caught BY THE ASSERTION IT EXISTS FOR, by name; and runs the mirror's cases
// against deliberately broken mirrors, which must fail. A fault whose anchor has moved
// changes nothing and is reported as a MISS rather than credited.
import fs from "fs";
import { DIR, fnBody, stripComments } from "./geom-common.mjs";

const SELFTEST = process.argv.includes("--selftest");

// ---------------------------------------------------------------------------
// Parse, never transcribe: MAX_LINKS comes out of the sketch.
const MAIN0 = stripComments("deckhand_display.ino");
const USAGE0 = stripComments("usage.ino");
// Every OTHER .ino in the sketch, listed from the directory rather than transcribed,
// so a file added later is covered by (b) without anyone remembering to add it.
const ALL_INO = fs.readdirSync(DIR).filter((f) => f.endsWith(".ino") &&
  f !== "deckhand_display.ino" && f !== "usage.ino").sort();
const mlm = /#define\s+MAX_LINKS\s+(\d+)/.exec(MAIN0);
if (!mlm) throw new Error("MAX_LINKS #define not found in deckhand_display.ino");
const MAX_LINKS = Number(mlm[1]);

// ===========================================================================
// MIRROR
// ===========================================================================
const NONE = () => ({ fiveHourPct: -1, sevenDayPct: -1, quotaAgeSec: -1,
                      sessionTokens: 0, weekAllTokens: 0, weekFableTokens: 0,
                      cxPct: -1, cxAgeSec: -1 });
function makeMirror(broken = {}) {
  const st = { links: [], sel: "", count: 0, first: [], acct: [], src: [], cxSrc: [],
               selIdx: -1, usage: NONE(), usageSource: -1, cxSource: -1 };
  const share = (a, b) => {
    if (a === b) return true;
    const x = st.links[a].acct, y = st.links[b].acct;
    if (broken.acctlessMerge) return x === y;
    return !!x && !!y && x === y;
  };
  const keyFor = (l) => (st.links[l].acct ? st.links[l].acct : "@" + st.links[l].hostId);
  const hasClaude = (u) => u.fiveHourPct >= 0 || u.sevenDayPct >= 0 ||
    (!broken.pctOnly && (u.sessionTokens > 0 || u.weekAllTokens > 0 || u.weekFableTokens > 0));
  const keyLive = (key) => st.links.some((l, i) => l && l.used && keyFor(i) === key);
  const mergeAccount = (a) => {
    const rep = st.first[a];
    let best = -1, bestCx = -1;
    for (let i = 0; i < MAX_LINKS; i++) {
      const L = st.links[i];
      if (!L || !L.used) continue;
      if (!broken.noGuard && !share(rep, i)) continue;
      const u = L.usage;
      if (hasClaude(u)) {
        if (best < 0 || (u.quotaAgeSec >= 0 &&
            (st.links[best].usage.quotaAgeSec < 0 || u.quotaAgeSec < st.links[best].usage.quotaAgeSec))) best = i;
      }
      if (u.cxPct >= 0) {
        if (bestCx < 0 || (u.cxAgeSec >= 0 &&
            (st.links[bestCx].usage.cxAgeSec < 0 || u.cxAgeSec < st.links[bestCx].usage.cxAgeSec))) bestCx = i;
      }
    }
    if (broken.cxFallback && bestCx < 0) {
      for (let i = 0; i < MAX_LINKS; i++)
        if (st.links[i] && st.links[i].used && st.links[i].usage.cxPct >= 0) { bestCx = i; break; }
    }
    const m = NONE();
    if (best >= 0) { const u = st.links[best].usage;
      m.fiveHourPct = u.fiveHourPct; m.sevenDayPct = u.sevenDayPct; m.quotaAgeSec = u.quotaAgeSec;
      m.sessionTokens = u.sessionTokens; m.weekAllTokens = u.weekAllTokens; m.weekFableTokens = u.weekFableTokens; }
    if (bestCx >= 0) { const u = st.links[bestCx].usage; m.cxPct = u.cxPct; m.cxAgeSec = u.cxAgeSec; }
    st.acct[a] = m; st.src[a] = best; st.cxSrc[a] = bestCx;
  };
  const merge = () => {
    st.count = 0; st.first = [];
    for (let i = 0; i < MAX_LINKS; i++) {
      const L = st.links[i];
      if (!L || !L.used) continue;
      if (!hasClaude(L.usage) && L.usage.cxPct < 0) continue;
      let seen = false;
      for (let a = 0; a < st.count; a++) if (share(st.first[a], i)) { seen = true; break; }
      if (!seen) st.first[st.count++] = i;
    }
    for (let a = 0; a < st.count; a++) mergeAccount(a);
    let sel = st.count > 0 ? 0 : -1;
    if (st.sel) {
      let found = -1;
      for (let a = 0; a < st.count; a++) {
        const k = broken.selBySlot ? String(st.first[a]) : keyFor(st.first[a]);
        if (k === st.sel) { found = a; break; }
      }
      if (found >= 0) sel = found;
      else if (broken.stickyDeparted) sel = Math.min(Number(st.selIdx), st.count - 1);
      else if (broken.clearKeyOnAbsent || !keyLive(st.sel)) st.sel = "";
    }
    // The latch: an unselected page holds the account it is SHOWING, by key.
    if (!broken.noLatch && !st.sel && sel >= 0)
      st.sel = broken.selBySlot ? String(st.first[sel]) : keyFor(st.first[sel]);
    st.selIdx = sel;
    const noMac = broken.guardOnCount ? st.count === 0 : broken.guardOnSel ? sel < 0
                : st.links.filter((l) => l && l.used).length === 0;
    if (noMac) { st.usageSource = st.cxSource = -1; return; }
    st.usageSource = sel >= 0 ? st.src[sel] : -1;
    st.cxSource = sel >= 0 ? st.cxSrc[sel] : -1;
    const m = sel >= 0 ? st.acct[sel] : NONE();
    if (broken.noClear) {
      if (st.usageSource >= 0) { st.usage.fiveHourPct = m.fiveHourPct; st.usage.sevenDayPct = m.sevenDayPct; }
      if (st.cxSource >= 0) st.usage.cxPct = m.cxPct;
    } else st.usage = { ...m };
  };
  const select = (idx) => {
    if (idx < 0 || idx >= st.count) return false;
    st.sel = broken.selBySlot ? String(st.first[idx]) : keyFor(st.first[idx]);
    return true;
  };
  const cycle = () => (st.count < 2 ? false : select((st.selIdx + 1) % st.count));
  const link = (i, hostId, acct, u) => { st.links[i] = { used: true, hostId, acct, usage: { ...NONE(), ...u } }; };
  const drop = (i) => { st.links[i].used = false; };
  return { st, merge, select, cycle, link, drop };
}

function mirrorCases(M) {
  const out = [];
  const t = (name, fn) => { let r; try { r = fn(); } catch (e) { r = false; } out.push([name, !!r]); };
  t("same acct on 2 links merges into ONE account, and the fresher quotaAgeSec wins", () => {
    const m = M(); m.link(0, "aaaa0001", "11112222", { fiveHourPct: 30, quotaAgeSec: 300 });
    m.link(1, "bbbb0002", "11112222", { fiveHourPct: 31, quotaAgeSec: 10 }); m.merge();
    return m.st.count === 1 && m.st.usage.fiveHourPct === 31 && m.st.usageSource === 1;
  });
  t("a negative (never measured) age never beats a real one", () => {
    const m = M(); m.link(0, "aaaa0001", "11112222", { fiveHourPct: 50, quotaAgeSec: -1 });
    m.link(1, "bbbb0002", "11112222", { fiveHourPct: 40, quotaAgeSec: 900 }); m.merge();
    return m.st.count === 1 && m.st.usage.fiveHourPct === 40 && m.st.usageSource === 1;
  });
  t("two acct-less links NEVER merge (Review Focus 1) - two accounts", () => {
    const m = M(); m.link(0, "aaaa0001", "", { fiveHourPct: 30, quotaAgeSec: 300 });
    m.link(1, "bbbb0002", "", { fiveHourPct: 5, quotaAgeSec: 1 }); m.merge();
    return m.st.count === 2 && m.st.usage.fiveHourPct === 30 && m.st.usageSource === 0;
  });
  t("different acct gives 2 accounts, and the first is shown even when the second is fresher", () => {
    const m = M(); m.link(0, "aaaa0001", "11112222", { fiveHourPct: 30, quotaAgeSec: 300 });
    m.link(1, "bbbb0002", "33334444", { fiveHourPct: 5, quotaAgeSec: 1 }); m.merge();
    return m.st.count === 2 && m.st.selIdx === 0 && m.st.usage.fiveHourPct === 30;
  });
  t("selection follows the KEY, not the slot (Review Focus 3)", () => {
    const m = M(); m.link(0, "aaaa0001", "11112222", { fiveHourPct: 30, quotaAgeSec: 3 });
    m.link(1, "bbbb0002", "33334444", { fiveHourPct: 5, quotaAgeSec: 1 }); m.merge();
    m.select(1); m.merge();
    if (m.st.usage.fiveHourPct !== 5) return false;
    // Slot 0's Mac leaves; slot 1's account (the selected one) keeps its slot... then
    // a third Mac lands in the freed slot 0 and sorts first. The page must STAY on B.
    m.drop(0); m.merge();
    m.link(0, "cccc0003", "55556666", { fiveHourPct: 77, quotaAgeSec: 2 }); m.merge();
    if (!(m.st.selIdx === 1 && m.st.usage.fiveHourPct === 5 && m.st.usageSource === 1)) return false;
    // linkForHost()'s full-table recycle: a FOURTH Mac takes B's own slot in one step,
    // with no merge in between. An index (or slot) selection would now silently show
    // D; by key, B is gone and the page falls back to account 0.
    m.link(1, "dddd0004", "77778888", { fiveHourPct: 99, quotaAgeSec: 1 }); m.merge();
    return m.st.selIdx === 0 && m.st.usage.fiveHourPct === 77;
  });
  t("the selected account's LINK going (its Mac stopped talking) falls back to account 0 in the SAME merge and forgets the key (Review Focus 2)", () => {
    const m = M(); m.link(0, "aaaa0001", "11112222", { fiveHourPct: 30, sevenDayPct: 40, quotaAgeSec: 3 });
    m.link(1, "bbbb0002", "33334444", { fiveHourPct: 11, sevenDayPct: 22, quotaAgeSec: 1 }); m.merge();
    m.select(1); m.merge();
    if (m.st.usage.fiveHourPct !== 11) return false;
    m.drop(1); m.merge();
    // B's key is FORGOTTEN - and, since the latch landed, the account now on screen
    // (A) is re-latched in the same merge. Before the latch this read sel === "";
    // the property it pins (B's key does not survive its Mac leaving) is unchanged.
    return m.st.selIdx === 0 && m.st.usage.fiveHourPct === 30 && m.st.usage.sevenDayPct === 40 &&
           m.st.sel === "11112222";
  });
  t("account B with no Codex shows NO Codex (cxSource -1) even when account A has Codex (Review Focus 4)", () => {
    const m = M(); m.link(0, "aaaa0001", "11112222", { fiveHourPct: 30, quotaAgeSec: 3, cxPct: 33, cxAgeSec: 5 });
    m.link(1, "bbbb0002", "33334444", { fiveHourPct: 11, quotaAgeSec: 1 }); m.merge();
    m.select(1); m.merge();
    return m.st.cxSource === -1 && m.st.usage.cxPct === -1 && m.st.usageSource === 1;
  });
  t("fewer than 2 accounts makes the tap cycle inert (returns false)", () => {
    const m = M(); m.link(0, "aaaa0001", "11112222", { fiveHourPct: 30, quotaAgeSec: 3 });
    m.link(1, "bbbb0002", "11112222", { fiveHourPct: 31, quotaAgeSec: 1 }); m.merge();
    const one = m.cycle() === false;
    const m2 = M(); m2.link(0, "aaaa0001", "11112222", { fiveHourPct: 30, quotaAgeSec: 3 });
    m2.link(1, "bbbb0002", "33334444", { fiveHourPct: 5, quotaAgeSec: 1 }); m2.merge();
    return one && m2.cycle() === true;
  });
  t("THE FREEZE: the departed source's figures CLEAR when the survivor has no Claude reading", () => {
    // The pre-fix trace: R (no Claude reading, Codex only) ticks while feedfeed is
    // alive; feedfeed is then pruned, and the re-merge finds no Claude source. The old
    // mergeUsage() only overwrote `usage` when it found one, so feedfeed's 11/22 stayed.
    const m = M(); m.link(0, "c5325381", "", { cxPct: 40, cxAgeSec: 5 });
    m.link(1, "feedfeed", "", { fiveHourPct: 11, sevenDayPct: 22, quotaAgeSec: 1 }); m.merge();
    m.select(1); m.merge();
    m.drop(1); m.merge();
    return m.st.usage.fiveHourPct === -1 && m.st.usage.sevenDayPct === -1 && m.st.usageSource === -1 &&
           m.st.cxSource === 0;
  });
  // ---- fix round 1 ----
  t("the selected link departs and the survivor has NO reading at all: usage clears, usageSource -1 (the early-return guard)", () => {
    const m = M(); m.link(0, "aaaa0001", "", { fiveHourPct: 30, sevenDayPct: 40, quotaAgeSec: 3 });
    m.link(1, "bbbb0002", "", {}); m.merge();
    if (m.st.usage.fiveHourPct !== 30) return false;
    m.drop(0); m.merge();
    return m.st.count === 0 && m.st.usage.fiveHourPct === -1 && m.st.usage.sevenDayPct === -1 &&
           m.st.usageSource === -1 && m.st.cxSource === -1;
  });
  t("a TOKEN-ONLY link (null pcts, OAuth not yet / 429) forms an account and supplies its tokens", () => {
    const m = M(); m.link(0, "aaaa0001", "", { weekAllTokens: 31930000, sessionTokens: 5000 }); m.merge();
    return m.st.count === 1 && m.st.usageSource === 0 && m.st.usage.weekAllTokens === 31930000 &&
           m.st.usage.fiveHourPct === -1;
  });
  t("a token-only reading (age -1) never beats a real percentage on the same account, in either slot order", () => {
    const a = M(); a.link(0, "aaaa0001", "11112222", { weekAllTokens: 9 });
    a.link(1, "bbbb0002", "11112222", { fiveHourPct: 40, quotaAgeSec: 900, weekAllTokens: 8 }); a.merge();
    const b = M(); b.link(0, "bbbb0002", "11112222", { fiveHourPct: 40, quotaAgeSec: 900, weekAllTokens: 8 });
    b.link(1, "aaaa0001", "11112222", { weekAllTokens: 9 }); b.merge();
    return a.st.usage.fiveHourPct === 40 && a.st.usageSource === 1 && b.st.usage.fiveHourPct === 40 && b.st.usageSource === 0;
  });
  t("one NO-READING tick from the selected account's only Mac shows account 0 but KEEPS the key, and reselects when the reading returns", () => {
    const m = M(); m.link(0, "aaaa0001", "11112222", { fiveHourPct: 30, quotaAgeSec: 3 });
    m.link(1, "bbbb0002", "33334444", { fiveHourPct: 11, quotaAgeSec: 1 }); m.merge();
    m.select(1); m.merge();
    if (m.st.usage.fiveHourPct !== 11) return false;
    m.link(1, "bbbb0002", "33334444", {}); m.merge();          // host restart: first tick, no reading
    const during = m.st.selIdx === 0 && m.st.usage.fiveHourPct === 30 && m.st.sel === "33334444";
    m.link(1, "bbbb0002", "33334444", { fiveHourPct: 12, quotaAgeSec: 2 }); m.merge();
    return during && m.st.selIdx === 1 && m.st.usage.fiveHourPct === 12;
  });
  t("the key is forgotten only when NO used link maps to it any more (its Mac stopped talking)", () => {
    const m = M(); m.link(0, "aaaa0001", "11112222", { fiveHourPct: 30, quotaAgeSec: 3 });
    m.link(1, "bbbb0002", "33334444", { fiveHourPct: 11, quotaAgeSec: 1 }); m.merge();
    m.select(1); m.merge();
    m.link(1, "bbbb0002", "33334444", {}); m.merge();
    if (m.st.sel !== "33334444") return false;
    m.drop(1); m.merge();
    // Forgotten = no longer B's key. It is A's now (re-latched to the page on screen);
    // before the latch this read sel === "". Same property: B's key did not survive.
    if (m.st.sel !== "11112222") return false;
    m.link(1, "bbbb0002", "33334444", { fiveHourPct: 12, quotaAgeSec: 2 }); m.merge();
    return m.st.selIdx === 0 && m.st.usage.fiveHourPct === 30;
  });
  // ---- final-review fix: the latch ----
  t("an UNSELECTED view survives a slot swap: the account on screen stays on screen when the two Macs trade slots", () => {
    const m = M(); m.link(0, "aaaa0001", "11112222", { fiveHourPct: 30, quotaAgeSec: 3 });
    m.link(1, "bbbb0002", "33334444", { fiveHourPct: 11, quotaAgeSec: 1 }); m.merge();   // nobody has tapped
    if (!(m.st.selIdx === 0 && m.st.usage.fiveHourPct === 30)) return false;
    // The two Macs trade slots in one step (linkForHost()'s recycle), no merge between.
    m.link(0, "bbbb0002", "33334444", { fiveHourPct: 11, quotaAgeSec: 1 });
    m.link(1, "aaaa0001", "11112222", { fiveHourPct: 30, quotaAgeSec: 3 }); m.merge();
    return m.st.selIdx === 1 && m.st.usage.fiveHourPct === 30 && m.st.usageSource === 1 &&
           m.st.sel === "11112222";
  });
  return out;
}

// ===========================================================================
// STRUCTURAL
// ===========================================================================
// The block opened by the `{` at or after `from`, brace-matched, braces included.
function blockFrom(text, from) {
  const open = text.indexOf("{", from);
  if (open < 0) return null;
  let d = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") d++;
    else if (text[i] === "}") { d--; if (d === 0) return { start: open, end: i + 1, text: text.slice(open, i + 1) }; }
  }
  return null;
}
// Brace depth of position p inside a function body (the body's own `{` counts 1).
function depthAt(body, p) {
  let d = 0;
  for (let i = 0; i < p; i++) { if (body[i] === "{") d++; else if (body[i] === "}") d--; }
  return d;
}

function structural(ok, over) {
  const main = over.main != null ? over.main : MAIN0;
  const usageSrc = over.usage != null ? over.usage : USAGE0;
  // fnBody THROWS on a missing function, which would abort every later assertion and
  // hide which of them the sketch fails. This reports the miss BY NAME and returns ""
  // - and every assertion below that reads a body also requires it to be non-empty,
  // so "" can never satisfy a negative test vacuously.
  const fb = (src, sig, where) => {
    try { return fnBody(src, sig, where); } catch (e) { ok(`found ${sig.replace(/\s*\{$/, "")} in ${where}`, false); return ""; }
  };

  // ---- the HostLink fields and their parse ----
  const hl = blockFrom(main, main.indexOf("struct HostLink {"));
  ok("HostLink carries acct[12] and acctTag[8]",
     !!hl && /\bchar\s+acct\[12\]\s*=\s*""\s*;/.test(hl.text) && /\bchar\s+acctTag\[8\]\s*=\s*""\s*;/.test(hl.text));
  const hlFn = fb(main, "void handleLine(const String& line) {", "deckhand_display.ino");
  const curBlk = blockFrom(hlFn, hlFn.indexOf("if (curLink >= 0) {", hlFn.indexOf("curLink = linkForHost(hid, true);")));
  ok("handleLine() parses acct and acctTag into THIS payload's link, beside hostTag",
     !!curBlk &&
     /copyField\(hostLinks\[curLink\]\.acct,\s*sizeof\(hostLinks\[curLink\]\.acct\),\s*doc\["acct"\]\s*\|\s*""\)/.test(curBlk.text) &&
     /copyField\(hostLinks\[curLink\]\.acctTag,\s*sizeof\(hostLinks\[curLink\]\.acctTag\),\s*doc\["acctTag"\]\s*\|\s*""\)/.test(curBlk.text));

  // ---- linksShareAccount / accountKeyFor ----
  const share = fb(usageSrc, "bool linksShareAccount(int a, int b) {", "usage.ino");
  ok("(f) linksShareAccount() joins two links only when BOTH name an acct and the names agree",
     /return\s+x\[0\]\s*&&\s*y\[0\]\s*&&\s*strcmp\(x,\s*y\)\s*==\s*0\s*;/.test(share) &&
     /const char\*\s*x\s*=\s*hostLinks\[a\]\.acct;/.test(share) &&
     /const char\*\s*y\s*=\s*hostLinks\[b\]\.acct;/.test(share));
  const keyFn = fb(usageSrc, "void accountKeyFor(int link, char* out, size_t n) {", "usage.ino");
  ok("(g) accountKeyFor() keys an acct-less link as '@' + hostId, which no hex acct can equal",
     /snprintf\(out,\s*n,\s*"@%s",\s*hostLinks\[link\]\.hostId\)/.test(keyFn) &&
     /if\s*\(hostLinks\[link\]\.acct\[0\]\)\s*strlcpy\(out,\s*hostLinks\[link\]\.acct,\s*n\)/.test(keyFn));

  // ---- mergeAccount: (c) and the per-source clear ----
  const acc = fb(usageSrc, "static void mergeAccount(int a) {", "usage.ino");
  const decl = /int\s+rep\s*=\s*usageAcctFirstLink\[a\]\s*,\s*best\s*=\s*-1\s*,\s*bestCx\s*=\s*-1\s*;/.exec(acc);
  ok("mergeAccount() starts best/bestCx at -1 and takes the account's representative from usageAcctFirstLink[a]",
     !!decl);
  const loops = [...acc.matchAll(/\bfor\s*\(/g)];
  let guardedLoop = null, firstStmtOk = false;
  if (loops.length === 1) {
    guardedLoop = blockFrom(acc, loops[0].index);
    const header = /for\s*\(\s*int\s+(\w+)\s*=/.exec(acc.slice(loops[0].index));
    const iv = header ? header[1] : "?";
    const first = guardedLoop ? guardedLoop.text.slice(1).trimStart() : "";
    const g = /^if\s*\(([^;{}]*)\)\s*continue\s*;/.exec(first);
    firstStmtOk = !!g && new RegExp(`!\\s*linksShareAccount\\(\\s*rep\\s*,\\s*${iv}\\s*\\)`).test(g[1]) &&
                  /(^|\|\|)\s*!\s*hostLinks\[\w+\]\.used\s*(\|\||$)/.test(g[1].replace(/\s+/g, " ").trim());
  }
  const assigns = [...acc.matchAll(/\b(bestCx|best)\s*=(?!=)/g)].filter((m) => !(decl && m.index >= decl.index && m.index < decl.index + decl[0].length));
  const stray = guardedLoop ? assigns.filter((m) => m.index < guardedLoop.start || m.index >= guardedLoop.end) : assigns;
  ok(`(c) mergeAccount() has exactly ONE loop, its first statement is the !linksShareAccount(rep, i) ` +
     `continue, and EVERY best/bestCx assignment (Claude AND Codex) sits inside it - no ` +
     `cross-account fallback` +
     (stray.length ? ` [${stray.length} assignment(s) outside the guarded loop: ${stray.map((m) => m[0].trim()).join(", ")}]` : "") +
     (loops.length !== 1 ? ` [${loops.length} loops]` : ""),
     loops.length === 1 && firstStmtOk && stray.length === 0 && assigns.length >= 2);

  const mDecl = /\bUsage\s+m\s*;/.exec(acc);
  const ifBest = blockFrom(acc, acc.search(/if\s*\(\s*best\s*>=\s*0\s*\)\s*\{/));
  const ifCx = blockFrom(acc, acc.search(/if\s*\(\s*bestCx\s*>=\s*0\s*\)\s*\{/));
  const claudeSets = [...acc.matchAll(/\bm\.(fiveHourPct|sevenDayPct|quotaAgeSec|fiveHourResetInMin|sevenDayResetInMin|sessionTokens|weekAllTokens|weekFableTokens|weekFablePct)\s*=(?!=)/g)];
  const cxSets = [...acc.matchAll(/\bm\.(cxPct|cxResetInMin|cxWindowMin|cxAgeSec)\s*=(?!=)/g)];
  const inside = (ms, b) => !!b && ms.every((m) => m.index > b.start && m.index < b.end);
  const storeAt = acc.search(/usageAcct\[a\]\s*=\s*m\s*;/);
  ok("(d1) mergeAccount() starts from a default (no-reading) Usage and fills each source ONLY under its own best >= 0 guard, " +
     "storing the result unconditionally",
     !!mDecl && claudeSets.length === 9 && cxSets.length === 4 && inside(claudeSets, ifBest) && inside(cxSets, ifCx) &&
     storeAt >= 0 && depthAt(acc, storeAt) === 1);

  // ---- mergeUsage: (a), (b), (d2), selection ----
  const mu = fb(usageSrc, "void mergeUsage() {", "usage.ino");
  ok("(a) mergeUsage() groups links with linksShareAccount() and merges EACH account through mergeAccount()",
     /linksShareAccount\(\s*usageAcctFirstLink\[a\]\s*,\s*i\s*\)/.test(mu) &&
     /for\s*\(\s*int\s+a\s*=\s*0\s*;\s*a\s*<\s*usageAcctCount\s*;\s*a\+\+\s*\)\s*mergeAccount\(a\)\s*;/.test(mu));
  const pinHits = [["deckhand_display.ino", main], ["usage.ino", usageSrc], ...ALL_INO.map((f) => [f, stripComments(f)])]
    .filter(([, s]) => /\busagePinHostId\b|\busageCyclePin\b/.test(s)).map(([f]) => f);
  ok("(b) usagePinHostId/usageCyclePin appear nowhere in the (comment-stripped) sketch, mergeUsage() included" +
     (pinHits.length ? ` [still in ${pinHits.join(", ")}]` : ""),
     mu.length > 0 && pinHits.length === 0 && !/usagePinHostId/.test(mu));
  const copyLine = [...mu.matchAll(/^[ \t]*(.*)\busage\s*=\s*(\w+)\s*;[ \t]*$/gm)];
  const plain = copyLine.filter((m) => m[1].trim() === "" && depthAt(mu, m.index) === 1);
  const mRef = plain.length === 1 ? plain[0][2] : "__no_copy__";
  const bind = new RegExp(`const\\s+Usage&\\s+${mRef}\\s*=\\s*sel\\s*>=\\s*0\\s*\\?\\s*usageAcct\\[sel\\]\\s*:\\s*(\\w+)\\s*;`).exec(mu);
  const noneOk = bind && new RegExp(`\\bUsage\\s+${bind[1]}\\s*;`).test(mu);
  ok("(d) clear-on-no-source: mergeUsage() copies the selected account's reading into `usage` as ONE whole-struct " +
     "copy, unconditionally (falling back to a default no-reading Usage), with no field-wise usage.X = left",
     plain.length === 1 && !!bind && !!noneOk && !/\busage\.\w+\s*=(?!=)/.test(mu));
  const selFound = /if\s*\(\s*found\s*>=\s*0\s*\)\s*sel\s*=\s*found\s*;\s*else\s+if\s*\(\s*!\s*usageAccountKeyLive\(\s*usageAcctSel\s*\)\s*\)\s*usageAcctSel\[0\]\s*=\s*'\\0'\s*;/.test(mu);
  ok("mergeUsage() resolves the selection BY KEY (accountKeyFor + strcmp against usageAcctSel) and forgets the key ONLY when " +
     "usageAccountKeyLive() says no used link maps to it",
     /accountKeyFor\(\s*usageAcctFirstLink\[a\]/.test(mu) && /strcmp\(\s*\w+\s*,\s*usageAcctSel\s*\)\s*==\s*0/.test(mu) && selFound &&
     /int\s+sel\s*=\s*usageAcctCount\s*>\s*0\s*\?\s*0\s*:\s*-1\s*;/.test(mu));

  const live = fb(usageSrc, "static bool usageAccountKeyLive(const char* key) {", "usage.ino");
  ok("usageAccountKeyLive() walks the USED links and compares each one's accountKeyFor() against the key",
     /for\s*\(\s*int\s+i\s*=\s*0\s*;\s*i\s*<\s*MAX_LINKS\s*;/.test(live) &&
     /if\s*\(\s*!\s*hostLinks\[i\]\.used\s*\)\s*continue\s*;/.test(live) &&
     /accountKeyFor\(\s*i\s*,/.test(live) && /if\s*\(\s*strcmp\(\s*\w+\s*,\s*key\s*\)\s*==\s*0\s*\)\s*return\s+true\s*;/.test(live) &&
     /return\s+false\s*;\s*$/.test(live.trimEnd()));

  // (d0) THE EARLY RETURN. A guard wider than "no Mac at all" (usageAcctCount == 0,
  // sel < 0) returns while Macs are still talking with no reading between them - and
  // since the parse no longer writes the global for a link, the departed account's
  // numbers would then stay up for good. Exactly ONE return may precede the copy, and
  // its own if-condition must be exactly usedLinkCount() == 0.
  const copyAt = mu.search(/^[ \t]*usage\s*=\s*\w+\s*;[ \t]*$/m);
  const rets = copyAt >= 0 ? [...mu.slice(0, copyAt).matchAll(/\breturn\b/g)] : [];
  let guardCond = null;
  if (rets.length === 1) {
    const ifAt = mu.lastIndexOf("if", rets[0].index);
    const open = mu.indexOf("(", ifAt);
    let d = 0, close = -1;
    for (let i = open; i < mu.length; i++) { if (mu[i] === "(") d++; else if (mu[i] === ")") { d--; if (d === 0) { close = i; break; } } }
    const blk = close > 0 ? blockFrom(mu, close) : null;
    if (blk && rets[0].index > blk.start && rets[0].index < blk.end &&
        /^\s*$/.test(mu.slice(close + 1, blk.start))) guardCond = mu.slice(open + 1, close).replace(/\s+/g, " ").trim();
  }
  ok(`(d0) mergeUsage()'s ONLY return before the copy is guarded by exactly usedLinkCount() == 0` +
     ` [${rets.length} return(s), guard "${guardCond}"]`,
     copyAt >= 0 && rets.length === 1 && guardCond === "usedLinkCount() == 0");

  // (m) THE LATCH. An unselected page shows account 0 - the lower SLOT, which is not an
  // identity: two Macs swap slots and the page silently became the other account's.
  // mergeUsage() must, at the top level of its body and AFTER the by-key resolution
  // (so a key forgotten there is re-latched in the same call), store the DISPLAYED
  // account's key - usageAcctFirstLink[sel], never a fixed slot - when the key is empty.
  const latch = /if\s*\(\s*!\s*usageAcctSel\[0\]\s*&&\s*sel\s*>=\s*0\s*\)\s*accountKeyFor\(\s*usageAcctFirstLink\[sel\]\s*,\s*usageAcctSel\s*,\s*sizeof\(usageAcctSel\)\s*\)\s*;/.exec(mu);
  const forgetAt = mu.search(/usageAcctSel\[0\]\s*=\s*'\\0'\s*;/);
  const selIdxAt = mu.search(/usageAcctSelIdx\s*=\s*sel\s*;/);
  ok("(m) mergeUsage() LATCHES the displayed account's key (accountKeyFor(usageAcctFirstLink[sel], usageAcctSel, ...)) " +
     "when usageAcctSel is empty, at the top level, after the key is resolved/forgotten and before usageAcctSelIdx = sel" +
     (latch ? ` [depth ${depthAt(mu, latch.index)}]` : " [no latch statement]"),
     !!latch && depthAt(mu, latch.index) === 1 && forgetAt >= 0 && latch.index > forgetAt &&
     selIdxAt > latch.index);

  const hc = fb(usageSrc, "static bool usageHasClaude(const Usage& u) {", "usage.ino");
  const hcTerms = ["u.fiveHourPct >= 0", "u.sevenDayPct >= 0", "u.sessionTokens > 0", "u.weekAllTokens > 0", "u.weekFableTokens > 0"];
  const hcRet = /return\s+([^;]+);/.exec(hc);
  const hcGot = hcRet ? hcRet[1].split("||").map((t) => t.replace(/\s+/g, " ").trim()) : [];
  ok("usageHasClaude() counts a TOKEN-ONLY reading (null pcts) as a Claude reading, and both the account filter and " +
     `the freshest loop use it [${hcGot.join(" | ")}]`,
     hcGot.length === hcTerms.length && hcTerms.every((t) => hcGot.includes(t)) &&
     /if\s*\(\s*!\s*usageHasClaude\(\s*u\s*\)\s*&&\s*u\.cxPct\s*<\s*0\s*\)\s*continue\s*;/.test(mu) &&
     /if\s*\(\s*usageHasClaude\(\s*u\s*\)\s*\)/.test(acc));

  // ---- the cycle ----
  const cyc = fb(usageSrc, "bool usageCycleAccount() {", "usage.ino");
  ok("usageCycleAccount() is inert below two accounts and steps through usageSelectAccount()",
     /if\s*\(\s*usageAcctCount\s*<\s*2\s*\)\s*return\s+false\s*;/.test(cyc) &&
     /return\s+usageSelectAccount\(\s*\(\s*usageAcctSelIdx\s*\+\s*1\s*\)\s*%\s*usageAcctCount\s*\)\s*;/.test(cyc));
  const selFn = fb(usageSrc, "bool usageSelectAccount(int idx) {", "usage.ino");
  ok("usageSelectAccount() range-checks idx and stores the account's KEY, not its index",
     /if\s*\(\s*idx\s*<\s*0\s*\|\|\s*idx\s*>=\s*usageAcctCount\s*\)\s*return\s+false\s*;/.test(selFn) &&
     /accountKeyFor\(\s*usageAcctFirstLink\[idx\]\s*,\s*usageAcctSel\s*,\s*sizeof\(usageAcctSel\)\s*\)/.test(selFn));
  const touch = blockFrom(main, main.indexOf("if (currentTab == TAB_USAGE && sy >= CONTENT_Y && everReceived)"));
  ok("the USAGE tap pages ACCOUNTS: it calls usageCycleAccount(), then re-merges and renders",
     !!touch && /if\s*\(\s*usageCycleAccount\(\)\s*\)\s*\{\s*mergeUsage\(\);\s*(?:\/\/[^\n]*)?\s*renderUsageTab\(\);/.test(touch.text));

  // ---- THE GLASS (Task 3): the card header names the ACCOUNT ----
  // (h) THE GATE. The header's text label exists to tell two ACCOUNTS apart, so it
  // shows with more than one account - not with more than one Mac: two Macs on ONE
  // account are one page, and a Mac tag there names nothing the reader can act on.
  const chrome = fb(usageSrc, "void drawCardChrome(", "usage.ino");
  const showText = /\bbool\s+showText\s*=\s*([^;]*);/.exec(chrome);
  const gate = showText ? showText[1].replace(/\s+/g, " ").trim() : "";
  ok(`(h) drawCardChrome() gates the text label on usageAcctCount > 1, not usedLinkCount() > 1 [gate "${gate}"]`,
     chrome.length > 0 && /\busageAcctCount\s*>\s*1\b/.test(gate) && !/usedLinkCount\(\)/.test(chrome) &&
     /else\s+if\s*\(\s*showText\s*\)\s*\{/.test(chrome));
  // (h2) A NAMED account shows its name even when the Mac has an icon: the person
  // named the account, and the name is what tells two accounts apart. So the icon
  // branch must step aside for it, and only when the label would show at all.
  const named = /\bbool\s+(\w+)\s*=\s*usageAcctCount\s*>\s*1\s*&&\s*usageAcctNamed\(\)\s*;/.exec(chrome);
  ok("(h2) drawCardChrome() draws a NAMED account's label (usageAcctNamed(), behind the usageAcctCount > 1 gate) " +
     "in place of the Mac's icon",
     !!named && new RegExp(`\\bbool\\s+showIcon\\s*=\\s*cardEmoji\\s*>=\\s*0\\s*&&\\s*!\\s*${named[1]}\\s*;`).test(chrome) &&
     /if\s*\(\s*showIcon\s*\)\s*\{/.test(chrome));
  // (h3) The pinned/auto chrome is GONE, not repurposed: no pin bar, no accent tag.
  ok("(h3) drawCardChrome() carries no pin bar (CARD_PIN_BAR_Y) and no accent colour - there is no pinned/auto left to mark",
     chrome.length > 0 && !/CARD_PIN_BAR_Y|COLOR_ACCENT/.test(chrome));
  // (k) The label itself: acctTag when the account was named, else the Mac's tag,
  // from the Claude source - or the account's first link when the account has only
  // a Codex reading (usageSourceLink -1), so the header still names whose page it is.
  const lbl = fb(usageSrc, "static int usageAcctLabelLink() {", "usage.ino");
  const lblFn = fb(usageSrc, "const char* usageAcctLabel() {", "usage.ino");
  const namedFn = fb(usageSrc, "bool usageAcctNamed() {", "usage.ino");
  ok("(k) usageAcctLabel() is the selected account's acctTag when set, else its Mac's linkTag(), from the Claude " +
     "source or (no Claude source) the account's first link; usageAcctNamed() reads the SAME link",
     /usageSourceLink\s*>=\s*0\s*\?\s*usageSourceLink\s*:\s*\(\s*usageAcctSelIdx\s*>=\s*0\s*\?\s*usageAcctFirstLink\[usageAcctSelIdx\]\s*:\s*-1\s*\)/.test(lbl) &&
     /=\s*usageAcctLabelLink\(\)\s*;/.test(lblFn) &&
     /return\s+hostLinks\[(\w+)\]\.acctTag\[0\]\s*\?\s*hostLinks\[\1\]\.acctTag\s*:\s*linkTag\(\1\)\s*;/.test(lblFn) &&
     /=\s*usageAcctLabelLink\(\)\s*;/.test(namedFn) && /hostLinks\[\w+\]\.acctTag\[0\]/.test(namedFn));
  const stat = fb(usageSrc, "void drawUsageStatic() {", "usage.ino");
  const chromeCalls = [...stat.matchAll(/drawCardChrome\(([^;]*)\);/g)].map((m) => m[1]);
  ok(`(k2) every drawCardChrome() call in drawUsageStatic() passes usageAcctLabel() as the tag [${chromeCalls.length} call(s)]`,
     chromeCalls.length >= 4 && chromeCalls.every((a) => /,\s*usageAcctLabel\(\)\s*(,|$)/.test(a)) &&
     !/linkTag\(\s*usageSourceLink\s*\)/.test(stat));

  // (i) THE BUST. An account switch can move values without moving the text any
  // cache compares, and the label/indicator live on the CHROME, which repaints only
  // through this bust. So BOTH arms of renderUsageTab()'s #if BOARD_USAGE_V2 must
  // carry an account term: a local whose value reads usageAcctSelIdx or
  // usageAcctCount, compared in the bust's own condition AND recorded in its block.
  const rut = fb(usageSrc, "void renderUsageTab() {", "usage.ino");
  const bustArms = (() => {
    const s = rut.indexOf("static int srcCache");
    const ifAt = s >= 0 ? rut.lastIndexOf("#if BOARD_USAGE_V2", s) : -1;
    const elseAt = ifAt >= 0 ? rut.indexOf("#else", ifAt) : -1;
    const endAt = elseAt >= 0 ? rut.indexOf("#endif", elseAt) : -1;
    return endAt > 0 ? [["BOARD_USAGE_V2", rut.slice(ifAt, elseAt)], ["#else", rut.slice(elseAt, endAt)]] : [];
  })();
  const armHasAcct = (arm) => {
    const now = /\bint\s+(\w+)\s*=\s*([^;]*\busageAcct(?:SelIdx|Count)\b[^;]*);/.exec(arm);
    if (!now) return { ok: false, why: "no local reads usageAcctSelIdx/usageAcctCount" };
    const cond = /if\s*\(\s*srcCache\s*!=\s*usageSourceLink([^{]*)\)\s*\{/.exec(arm);
    if (!cond) return { ok: false, why: "no `if (srcCache != usageSourceLink ...) {` bust" };
    const t = new RegExp(`\\b(\\w+)\\s*!=\\s*${now[1]}\\b`).exec(cond[1]);
    if (!t) return { ok: false, why: `${now[1]} is not in the bust's condition` };
    const blk = blockFrom(arm, cond.index + cond[0].length - 1);
    if (!blk || !new RegExp(`\\b${t[1]}\\s*=\\s*${now[1]}\\s*;`).test(blk.text))
      return { ok: false, why: `${t[1]} is never set from ${now[1]} inside the bust` };
    return { ok: true, why: `${t[1]} != ${now[1]} (= ${now[2].trim()})`, now: now[2] };
  };
  const arms = bustArms.map(([n, a]) => [n, armHasAcct(a)]);
  ok(`(i) the chrome bust carries an ACCOUNT term on BOTH arms of #if BOARD_USAGE_V2 ` +
     `[${arms.map(([n, r]) => `${n}: ${r.why}`).join("; ") || "arms not found"}]`,
     arms.length === 2 && arms.every(([, r]) => r.ok));
  ok("(i2) renderUsageTab() keeps no pin term (pinCache/pinNow) - the pin is gone, and a constant term busts nothing",
     rut.length > 0 && !/\bpin(Cache|Now)\b/.test(rut));
  // (i3) The packing's bound. K > MAX_LINKS is a CONSERVATIVE, SUFFICIENT
  // condition, not the exact one: with every count < K, selIdx * K + count is
  // injective whatever the selection is, so the term cannot alias without leaning
  // on mergeUsage()'s own invariant. The EXACT condition is weaker - the selection
  // is always -1 (count 0) or < count, and under that invariant any K >= 1 is
  // already injective at MAX_LINKS 2 (only K = 0 aliases there: (0 of 2) and
  // (1 of 2) both pack to 2). The bound is kept because it costs nothing and
  // survives MAX_LINKS growing or that invariant ever loosening. A count is at most
  // MAX_LINKS (one account per link at worst). Parsed from BOTH arms.
  const packs = arms.map(([, r]) => r.now && /usageAcctSelIdx\s*\*\s*(\d+)\s*\+\s*usageAcctCount/.exec(r.now));
  ok(`(i3) acctNow = usageAcctSelIdx * K + usageAcctCount with K > MAX_LINKS (${MAX_LINKS}) on both arms - every ` +
     `count < K, so no (selection, count) pair can alias another [K = ${packs.map((p) => (p ? p[1] : "?")).join(", ")}]`,
     packs.length === 2 && packs.every((p) => p && Number(p[1]) > MAX_LINKS));
  // (i4) THE LABEL TERM, on BOTH arms. The header's text (and whether it is a NAME,
  // which decides label-vs-icon) can change with nothing else in the tuple moving:
  // acctTag/tag are rewritten by every payload, and a host restarted with a new
  // DECKHAND_ACCOUNT_TAG inside LINK_STALE_MS keeps its slot. So each arm must
  // build a string from usageAcctNamed() AND usageAcctLabel(), compare it with
  // strcmp in the bust's own condition, and copy it into the cache in the block -
  // and the cache must be sized from HostLink::tag (+1 for the named byte).
  const armHasLabel = (arm) => {
    const cache = /static\s+char\s+(\w+)\[\s*1\s*\+\s*sizeof\(HostLink::tag\)\s*\]\s*=\s*""\s*;/.exec(arm);
    if (!cache) return { ok: false, why: "no label cache sized 1 + sizeof(HostLink::tag)" };
    const fill = /snprintf\(\s*(\w+)\s*,[^;]*usageAcctNamed\(\)[^;]*usageAcctLabel\(\)\s*\)\s*;/.exec(arm);
    if (!fill) return { ok: false, why: "no local built from usageAcctNamed() and usageAcctLabel()" };
    const cond = /if\s*\(\s*srcCache\s*!=\s*usageSourceLink([^{]*)\)\s*\{/.exec(arm);
    if (!cond || !new RegExp(`strcmp\\(\\s*${cache[1]}\\s*,\\s*${fill[1]}\\s*\\)\\s*!=\\s*0`).test(cond[1]))
      return { ok: false, why: `strcmp(${cache[1]}, ${fill[1]}) != 0 is not in the bust's condition` };
    const blk = blockFrom(arm, cond.index + cond[0].length - 1);
    if (!blk || !new RegExp(`strlcpy\\(\\s*${cache[1]}\\s*,\\s*${fill[1]}\\s*,\\s*sizeof\\(${cache[1]}\\)\\s*\\)`).test(blk.text))
      return { ok: false, why: `${cache[1]} is never set from ${fill[1]} inside the bust` };
    return { ok: true, why: `strcmp(${cache[1]}, ${fill[1]})` };
  };
  const lArms = bustArms.map(([n, a]) => [n, armHasLabel(a)]);
  ok(`(i4) the chrome bust carries the LABEL term (named + text) on BOTH arms of #if BOARD_USAGE_V2 ` +
     `[${lArms.map(([n, r]) => `${n}: ${r.why}`).join("; ") || "arms not found"}]`,
     lArms.length === 2 && lArms.every(([, r]) => r.ok));
  // (h4) The icon and its bust term read the SAME link the label does.
  const emojiArms = bustArms.map(([, a]) => /int\s+emojiNow\s*=\s*emojiIdForLink\(\s*usageAcctLabelLink\(\)\s*\)\s*;/.test(a));
  ok("(h4) drawCardChrome()'s icon and both arms' emojiNow read usageAcctLabelLink(), the link the label reads - " +
     "never usageSourceLink, which is -1 for a Codex-only account whose label falls back to its first link",
     /int\s+cardEmoji\s*=\s*emojiIdForLink\(\s*usageAcctLabelLink\(\)\s*\)\s*;/.test(chrome) &&
     emojiArms.length === 2 && emojiArms.every(Boolean));

  // (j) THE CODEX ROW'S TAG comes from cxSourceLink, and cxSourceLink is the
  // SELECTED account's own Codex source - never borrowed from the Claude source.
  const cxRow = fb(usageSrc, "void renderCodexRow() {", "usage.ino");
  ok("(j) renderCodexRow() takes its tag and icon from cxSourceLink (never usageSourceLink), and mergeUsage() sets " +
     "cxSourceLink from the selected account's own usageAcctCxSrc[sel]",
     /linkTag\(\s*cxSourceLink\s*\)/.test(cxRow) && /emojiIdForLink\(\s*cxSourceLink\s*\)/.test(cxRow) &&
     !/\busageSourceLink\b/.test(cxRow) &&
     /cxSourceLink\s*=\s*sel\s*>=\s*0\s*\?\s*usageAcctCxSrc\[sel\]\s*:\s*-1\s*;/.test(mu));

  // (l) THE VERB. USAGEACCT <n>: absolute (idempotent under the host's double
  // delivery), and EVERY early return clears `buf` first - processCompletedLine's
  // accumulator, which a refusal left full re-matches the same verb for ever.
  const pcl = fb(main, "void processCompletedLine(String& buf, unsigned long* lastRxTimestamp, bool fromUsb) {",
                 "deckhand_display.ino");
  const uaAt = pcl.indexOf('} else if (buf.startsWith("USAGEACCT")) {');
  const ua = uaAt >= 0 ? blockFrom(pcl, uaAt + 1) : null;
  const uaText = ua ? ua.text : "";
  const uaRets = [...uaText.matchAll(/\breturn\s*;/g)];
  const unguarded = uaRets.filter((m) =>
    !/buf\s*=\s*""\s*;[ \t]*(\/\/[^\n]*)?$/.test(uaText.slice(0, m.index).trimEnd()));
  ok(`(l) USAGEACCT's every early return is preceded by buf = "" [${uaRets.length} return(s), ${unguarded.length} without]`,
     !!ua && uaRets.length >= 3 && unguarded.length === 0);
  const refusals = [...uaText.matchAll(/USAGEACCT refused: ([^"\\]*)/g)].map((m) => m[1].trim());
  ok(`(l2) USAGEACCT refuses BY NAME on a surface, a wrong tab, and a bad index, selects through ` +
     `usageSelectAccount() (absolute, never usageCycleAccount()), then re-merges and renders [${refusals.length} refusal(s)]`,
     !!ua && refusals.length >= 4 &&
     /currentTab\s*!=\s*TAB_USAGE/.test(uaText) && /usageSelectAccount\(\s*arg\.toInt\(\)\s*\)/.test(uaText) &&
     !/usageCycleAccount/.test(uaText) &&
     /mergeUsage\(\);\s*renderUsageTab\(\);/.test(uaText));
  ok("(l3) USAGEACCT's surface refusal NAMES the surface (printf of the active one), and its success line " +
     "reports idx= and count= rather than a 0-based \"%d/%d\" that reads as 1-based",
     !!ua && /Serial\.printf\("USAGEACCT refused: the %s /.test(uaText) &&
     /Serial\.printf\("USAGEACCT idx=%d count=%d /.test(uaText) && !/"USAGEACCT %d\/%d/.test(uaText));

  // ---- (e) the payload parse writes the LINK ----
  const a0 = main.indexOf('doc["fiveHourPct"]');
  const lineStart = a0 >= 0 ? main.lastIndexOf("\n", a0) + 1 : -1;
  const z0 = a0 >= 0 ? main.indexOf("mergeUsage();", a0) : -1;
  const blk = a0 >= 0 && z0 > a0 ? main.slice(lineStart, z0) : "";
  const prevLine = lineStart > 1 ? main.slice(main.lastIndexOf("\n", lineStart - 2) + 1, lineStart) : "";
  const loc = /^\s*Usage\s+(\w+)\s*;\s*$/.exec(prevLine);
  const lv = loc ? loc[1] : "__no_local__";
  const writes = [...blk.matchAll(new RegExp(`\\b${lv}\\.(\\w+)\\s*=\\s*doc\\[`, "g"))].map((m) => m[1]);
  ok("(e) the payload parse fills a LOCAL Usage (all 13 fields) and parks it in hostLinks[curLink].usage - " +
     "it never writes the global usage.X directly",
     blk.length > 0 && !!loc && writes.length === 13 && !/\busage\.\w+\s*=(?!=)/.test(blk) &&
     new RegExp(`if\\s*\\(\\s*curLink\\s*>=\\s*0\\s*\\)\\s*hostLinks\\[curLink\\]\\.usage\\s*=\\s*${lv}\\s*;\\s*else\\s+usage\\s*=\\s*${lv}\\s*;`).test(blk));

  // ---- the defaults the clear depends on ----
  const us = blockFrom(main, main.indexOf("struct Usage {"));
  ok("struct Usage's own defaults are the no-reading sentinels the whole-struct clear relies on (-1 pct and age, both sources)",
     !!us && ["fiveHourPct", "sevenDayPct", "quotaAgeSec", "cxPct", "cxAgeSec"]
       .every((f) => new RegExp(`\\b(int|long)\\s+${f}\\s*=\\s*-1\\s*;`).test(us.text)));
}

function run(over, quiet) {
  const failures = []; let pass = 0;
  const ok = (name, cond) => {
    if (cond) { pass++; if (!quiet) console.log(`  ok    ${name}`); }
    else { failures.push(name); if (!quiet) console.log(` FAIL   ${name}`); }
  };
  try { structural(ok, over); } catch (e) { failures.push(`THREW: ${e.message}`); if (!quiet) console.log(` FAIL   THREW: ${e.message}`); }
  return { pass, failures };
}

if (!SELFTEST) {
  console.log("MIRROR (proves the algorithm; binds nothing in the sketch):");
  const mc = mirrorCases(makeMirror);
  for (const [n, r] of mc) console.log(`  ${r ? "ok  " : "FAIL"}  ${n}`);
  const mFail = mc.filter(([, r]) => !r).length;
  console.log("\nSTRUCTURAL (reads the sketch, each assertion bound to one function body):");
  const r = run({}, false);
  console.log(`\nmirror: ${mc.length - mFail}/${mc.length} pass; structural: ${r.pass}/${r.pass + r.failures.length} pass`);
  if (mFail || r.failures.length) process.exit(1);
  console.log("USAGE merges freshest-wins only WITHIN an account and shows the selected one");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// --selftest
let caught = 0, total = 0;
console.log("mirror faults (a broken mirror must FAIL its named case):");
const mirrorFaults = [
  ["no account guard in the freshest loop", { noGuard: true }, "different acct gives 2 accounts"],
  ["acct-less links merge", { acctlessMerge: true }, "acct-less links NEVER merge"],
  ["Codex falls back to another account", { cxFallback: true }, "Review Focus 4"],
  ["selection stored by slot, not key", { selBySlot: true }, "follows the KEY"],
  ["a departed selection is kept", { stickyDeparted: true }, "Review Focus 2"],
  ["usage only overwritten when a source exists (the freeze)", { noClear: true }, "THE FREEZE"],
  ["early return guarded on usageAcctCount == 0", { guardOnCount: true }, "early-return guard"],
  ["early return guarded on sel < 0", { guardOnSel: true }, "early-return guard"],
  ["only percentages count as a Claude reading", { pctOnly: true }, "TOKEN-ONLY"],
  ["the key is cleared the moment its account leaves the LIST", { clearKeyOnAbsent: true }, "KEEPS the key"],
  ["no latch: an unselected page follows whichever Mac holds slot 0", { noLatch: true }, "survives a slot swap"],
];
for (const [name, broken, expect] of mirrorFaults) {
  total++;
  const fails = mirrorCases(() => makeMirror(broken)).filter(([, r]) => !r).map(([n]) => n);
  const named = fails.find((n) => n.includes(expect));
  if (named) { caught++; console.log(`  caught  ${name}\n            by: ${named}`); }
  else console.log(`  MISSED  ${name}  <- ${fails.length ? `failed only [${fails.join("; ")}]` : "no case notices"}`);
}

console.log("\nsource faults (an edit to the real text must FAIL its named assertion):");
const sub = (src, a, b) => src.replace(a, b);
const sourceFaults = [
  ["1. delete the linksShareAccount guard in mergeAccount()",
    { usage: sub(USAGE0, /if \(!hostLinks\[i\]\.used \|\| !linksShareAccount\(rep, i\)\) continue;/, "if (!hostLinks[i].used) continue;") },
    "(c)"],
  ["2. restore a Codex fallback after the loop",
    { usage: sub(USAGE0, /\n(\s*)Usage m;/, "\n$1if (bestCx < 0) bestCx = best;\n$1Usage m;") },
    "(c)"],
  ["3. delete the clear-on-no-source (copy into usage only when a source exists)",
    { usage: sub(USAGE0, /\n(\s*)usage = m;/, "\n$1if (usageSourceLink >= 0) usage = m;") },
    "(d)"],
  ["3b. mergeAccount() starts from the CURRENT global instead of a no-reading Usage",
    { usage: sub(USAGE0, /\bUsage m;/, "Usage m = usage;") },
    "(d1)"],
  ["4. acct-less links share an account (\"\" == \"\")",
    { usage: sub(USAGE0, /return x\[0\] && y\[0\] && strcmp\(x, y\) == 0;/, "return strcmp(x, y) == 0;") },
    "(f)"],
  ["5. the parse writes the global again",
    { main: sub(MAIN0, /\bu\.fiveHourPct = doc/, "usage.fiveHourPct = doc") },
    "(e)"],
  ["6. the pin comes back",
    { usage: sub(USAGE0, /\nint usageSourceLink = -1;/, "\nchar usagePinHostId[12] = \"\";\nint usageSourceLink = -1;") },
    "(b)"],
  ["7. mergeUsage() stops grouping by account",
    { usage: sub(USAGE0, /if \(linksShareAccount\(usageAcctFirstLink\[a\], i\)\)/, "if (usageAcctFirstLink[a] == i)") },
    "(a)"],
  // The remaining structural assertions, each proven able to fail by its own name.
  ["8. acct-less keys lose the '@', so hostId \"feedfeed\" can equal an acct \"feedfeed\"",
    { usage: sub(USAGE0, /"@%s"/, '"%s"') },
    "(g)"],
  ["9. the cycle steps with ONE account (a page flip that moves nothing)",
    { usage: sub(USAGE0, /if \(usageAcctCount < 2\) return false;/, "if (usageAcctCount < 1) return false;") },
    "usageCycleAccount() is inert"],
  ["10. the selection is stored as an index, not a key",
    { usage: sub(USAGE0, /accountKeyFor\(usageAcctFirstLink\[idx\], usageAcctSel, sizeof\(usageAcctSel\)\);/,
                 "snprintf(usageAcctSel, sizeof(usageAcctSel), \"%d\", idx);") },
    "usageSelectAccount()"],
  ["11. a departed selection's key is kept for ever",
    { usage: sub(USAGE0, /if \(found >= 0\) sel = found;\s*else if \(!usageAccountKeyLive\(usageAcctSel\)\) usageAcctSel\[0\] = '\\0';/, "if (found >= 0) sel = found;") },
    "mergeUsage() resolves the selection BY KEY"],
  ["11b. the key is cleared the moment its account leaves the LIST (one no-reading tick snaps the page back)",
    { usage: sub(USAGE0, /else if \(!usageAccountKeyLive\(usageAcctSel\)\) usageAcctSel/, "else usageAcctSel") },
    "mergeUsage() resolves the selection BY KEY"],
  ["11c. usageAccountKeyLive() counts a link that has stopped talking",
    { usage: sub(USAGE0, /\n\s*if \(!hostLinks\[i\]\.used\) continue;\n(\s*accountKeyFor\(i, k)/, "\n$1") },
    "usageAccountKeyLive()"],
  ["17. the early return is guarded on usageAcctCount == 0",
    { usage: sub(USAGE0, /if \(usedLinkCount\(\) == 0\) \{ usageSourceLink/, "if (usageAcctCount == 0) { usageSourceLink") },
    "(d0)"],
  ["18. the early return is guarded on sel < 0",
    { usage: sub(USAGE0, /if \(usedLinkCount\(\) == 0\) \{ usageSourceLink/, "if (sel < 0) { usageSourceLink") },
    "(d0)"],
  ["19. a SECOND early return slips in before the copy",
    { usage: sub(USAGE0, /\n(\s*)Usage none;/, "\n$1if (sel < 0) return;\n$1Usage none;") },
    "(d0)"],
  ["20. usageHasClaude() goes back to percentages only",
    { usage: sub(USAGE0, / \|\|\s*u\.sessionTokens > 0 \|\| u\.weekAllTokens > 0 \|\| u\.weekFableTokens > 0/, "") },
    "usageHasClaude()"],
  ["21. the account filter stops using usageHasClaude() (inline pct-only test)",
    { usage: sub(USAGE0, /if \(!usageHasClaude\(u\) && u\.cxPct < 0\) continue;/, "if (u.fiveHourPct < 0 && u.sevenDayPct < 0 && u.cxPct < 0) continue;") },
    "usageHasClaude()"],
  ["12. the USAGE tap goes back to a link pin",
    { main: sub(MAIN0, /if \(usageCycleAccount\(\)\) \{/, "if (usageCycleLinks()) {") },
    "the USAGE tap pages ACCOUNTS"],
  ["13. the parse stops reading acct",
    { main: sub(MAIN0, /\n\s*copyField\(hostLinks\[curLink\]\.acct, [^\n]*/, "") },
    "handleLine() parses acct"],
  ["14. Usage's cxPct default stops meaning 'no reading'",
    { main: sub(MAIN0, /int cxPct = -1;/, "int cxPct = 0;") },
    "struct Usage's own defaults"],
  ["15. HostLink's acct buffer shrinks below an 8-hex hash + NUL",
    { main: sub(MAIN0, /char  acct\[12\] = "";/, 'char  acct[8] = "";') },
    "HostLink carries"],
  ["16. mergeAccount() starts best at slot 0, so an account with no Claude reading borrows slot 0's",
    { usage: sub(USAGE0, /best = -1, bestCx = -1;/, "best = 0, bestCx = -1;") },
    "mergeAccount() starts best/bestCx at -1"],
  // ---- Task 3: the glass and the verb ----
  ["22. the header label goes back to the Mac-count gate (usedLinkCount() > 1)",
    { usage: sub(USAGE0, /(bool showText = [^;]*)usageAcctCount > 1;/, "$1usedLinkCount() > 1;") },
    "(h)"],
  ["23. the BOARD_USAGE_V2 arm's bust loses its account term",
    { usage: sub(USAGE0, /acctCache != acctNow \|\| /, "") },
    "(i)"],
  ["24. the #else (board 1) arm's bust loses its account term",
    { usage: (() => {
        const s = USAGE0.indexOf("static int srcCache");
        const e = s >= 0 ? USAGE0.indexOf("#else", s) : -1;
        return e < 0 ? USAGE0 : USAGE0.slice(0, e) + USAGE0.slice(e).replace(/acctCache != acctNow \|\| /, "");
      })() },
    "(i)"],
  ["25. the pin's constant term comes back in place of the account term",
    { usage: sub(USAGE0, /int acctNow = usageAcctSelIdx \* 8 \+ usageAcctCount;/, "int pinNow = 0;  int acctNow = usageAcctSelIdx * 8 + usageAcctCount;") },
    "(i2)"],
  ["26. the packing multiplier drops to MAX_LINKS (2), below the conservative every-count-under-K bound " +
   "(not a live alias at MAX_LINKS 2, since sel < count - the bound is what this proves enforced)",
    { usage: sub(USAGE0, /int acctNow = usageAcctSelIdx \* 8 \+ usageAcctCount;/, "int acctNow = usageAcctSelIdx * 2 + usageAcctCount;") },
    "(i3)"],
  ["27. the Codex row's tag is taken from the Claude source",
    { usage: sub(USAGE0, /linkTag\(cxSourceLink\)/, "linkTag(usageSourceLink)") },
    "(j)"],
  ["28. a named account's label yields to the Mac's icon again",
    { usage: sub(USAGE0, /bool showIcon = cardEmoji >= 0 && !named;/, "bool showIcon = cardEmoji >= 0;") },
    "(h2)"],
  ["29. the pin bar comes back",
    { usage: sub(USAGE0, /(\n\s*)if \(showIcon\) \{/, "$1if (usageAcctCount > 1) tft.fillRect(0, y0 + CARD_PIN_BAR_Y, 1, 3, COLOR_ACCENT);$1if (showIcon) {") },
    "(h3)"],
  ["30. usageAcctLabel() ignores the person's account name",
    { usage: sub(USAGE0, /return hostLinks\[src\]\.acctTag\[0\] \? hostLinks\[src\]\.acctTag : linkTag\(src\);/, "return linkTag(src);") },
    "(k)"],
  ["31. a card's chrome is handed the Mac's tag instead of the account's label",
    { usage: sub(USAGE0, /("WEEK - 7 DAY, ALL MODELS", )usageAcctLabel\(\)/, "$1linkTag(usageSourceLink)") },
    "(k2)"],
  ["32. a USAGEACCT refusal returns without clearing buf (it would re-match for ever)",
    { main: (() => {
        const a = MAIN0.indexOf('} else if (buf.startsWith("USAGEACCT")) {');
        if (a < 0) return MAIN0;
        const z = MAIN0.indexOf("return;", a);
        const b = MAIN0.lastIndexOf('buf = "";', z);
        return b > a ? MAIN0.slice(0, b) + MAIN0.slice(b + 'buf = "";'.length) : MAIN0;
      })() },
    "(l)"],
  ["34. the V2 arm's bust loses its label term (a renamed account keeps its old header)",
    { usage: sub(USAGE0, /acctCache != acctNow \|\| strcmp\(labelCache, labelNow\) != 0 \|\|/, "acctCache != acctNow ||") },
    "(i4)"],
  ["35. the #else (board 1) arm's bust loses its label term",
    { usage: (() => {
        const s0 = USAGE0.indexOf("static int srcCache");
        const e = s0 >= 0 ? USAGE0.indexOf("#else", s0) : -1;
        return e < 0 ? USAGE0 : USAGE0.slice(0, e) +
          USAGE0.slice(e).replace(/acctCache != acctNow \|\| strcmp\(labelCache, labelNow\) != 0 \|\|/, "acctCache != acctNow ||");
      })() },
    "(i4)"],
  ["36. the label term stops carrying the NAMED state (a new name keeps the old icon)",
    { usage: USAGE0.replace(/snprintf\(labelNow, sizeof\(labelNow\), "%c%s", usageAcctNamed\(\) \? '1' : '0', usageAcctLabel\(\)\);/g,
                            'snprintf(labelNow, sizeof(labelNow), "%s", usageAcctLabel());') },
    "(i4)"],
  ["37. the icon goes back to reading usageSourceLink",
    { usage: sub(USAGE0, /int cardEmoji = emojiIdForLink\(usageAcctLabelLink\(\)\);/, "int cardEmoji = emojiIdForLink(usageSourceLink);") },
    "(h4)"],
  ["38. the surface refusal stops naming the surface",
    { main: sub(MAIN0, /Serial\.printf\("USAGEACCT refused: the %s /, 'Serial.printf("USAGEACCT refused: a surface ') },
    "(l3)"],
  ["39. the latch is removed (an unselected page follows slot 0 through a swap)",
    { usage: sub(USAGE0, /\n\s*if \(!usageAcctSel\[0\] && sel >= 0\)\s*accountKeyFor\(usageAcctFirstLink\[sel\], usageAcctSel, sizeof\(usageAcctSel\)\);/, "") },
    "(m)"],
  ["39b. the latch keys a fixed SLOT (link 0), not the displayed account",
    { usage: sub(USAGE0, /accountKeyFor\(usageAcctFirstLink\[sel\], usageAcctSel, sizeof\(usageAcctSel\)\);/, "accountKeyFor(0, usageAcctSel, sizeof(usageAcctSel));") },
    "(m)"],
  ["39c. the latch runs BEFORE the key is resolved (a forgotten key stays empty for a whole tick)",
    { usage: (() => {
        const L = /\n(\s*)if \(!usageAcctSel\[0\] && sel >= 0\)\s*accountKeyFor\(usageAcctFirstLink\[sel\], usageAcctSel, sizeof\(usageAcctSel\)\);/;
        const m = L.exec(USAGE0);
        if (!m) return USAGE0;
        const without = USAGE0.replace(L, "");
        return without.replace(/\n(\s*)if \(usageAcctSel\[0\]\) \{/, `\n$1${m[0].trim()}\n$1if (usageAcctSel[0]) {`);
      })() },
    "(m)"],
  ["33. USAGEACCT steps RELATIVELY (the host's double delivery toggles it there and back)",
    { main: sub(MAIN0, /!usageSelectAccount\(arg\.toInt\(\)\)/, "!usageCycleAccount()") },
    "(l2)"],
];
for (const [name, over, expect] of sourceFaults) {
  total++;
  const unchanged = (over.main == null || over.main === MAIN0) && (over.usage == null || over.usage === USAGE0);
  if (unchanged) { console.log(`  MISSED  ${name}  <- the injection did not apply (anchor moved)`); continue; }
  const r = run(over, true);
  const named = r.failures.find((f) => f.startsWith(expect));
  if (named) { caught++; console.log(`  caught  ${name}\n            by: ${named.slice(0, 150)}`); }
  else console.log(`  MISSED  ${name}  <- ${r.failures.length ? `failed only [${r.failures.map((f) => f.slice(0, 60)).join("; ")}]` : "no assertion notices this"}`);
}
console.log(`\nselftest: ${caught}/${total} faults caught`);
process.exit(caught === total ? 0 : 1);
