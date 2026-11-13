// Claude Code token counts for the USAGE tab, read incrementally from the
// transcripts - what `ccusage blocks --active` and `ccusage weekly` used to supply.
//
// WHY NOT CCUSAGE. ccusage re-reads EVERY transcript on every run and filters after:
// measured 2026-11-13 on this Mac (1.3 GB in ~/.claude/projects), each run took 3-4s
// and peaked at ~1.25 GB, `--since` changed neither, and the host ran the two reports
// in parallel and started the next pair as soon as the last finished - so ~2.5 GB was
// resident almost continuously, for three numbers. This reads each transcript ONCE,
// then only the bytes appended since, and keeps four numbers per usage record.
//
// WHAT IS COUNTED, and where it deliberately differs from ccusage 20:
//   - Claude Code transcripts only. ccusage 20's `weekly` became `agent: "all"` and
//     adds Codex (and any other agent CLI it finds), but these figures sit on the
//     CLAUDE quota cards (5h and 7d) - Codex has its own strip.
//   - "Fable" is every model named claude-...fable..., summed. The host used
//     `modelBreakdowns.find(/fable/i)`: the FIRST match only, and any model with
//     "fable" anywhere in its name - this week that was a local Qwen model called
//     "...Defiant-Fable...", so the FABLE line showed its tokens.
//   - The week is the CURRENT one. `weekly.at(-1)` was the last week WITH data, so
//     on a Monday before any use it showed the whole previous week beside a 7d bar.
// Everything else follows ccusage, and claude-tokens-check.mjs compares the two
// on this Mac's real transcripts.
//
//   record   a JSONL line with message.usage.{input_tokens,output_tokens} numbers
//            and a timestamp; tokens = input + output + cache creation + cache read
//   dedupe   `${message.id}:${requestId ?? ""}`, the largest copy wins; a record
//            with no message id is always counted (measured against ccusage 20)
//   block    5h, starting at the UTC hour floor of its first record; a record more
//            than 5h after the block's start starts a new one (which covers a 5h
//            gap); active while now < start+5h and now - last < 5h
//   week     Monday 00:00 local time (ccusage 20's `period`)

import fs from "node:fs/promises";
import path from "node:path";

export const BLOCK_MS = 5 * 3600_000;
// Kept in memory: enough for the current week (<= 7 days) and for the 5h block
// chain to reach back to a gap that fixes its phase. Older records are dropped.
export const RETAIN_MS = 8 * 24 * 3600_000;
// ONE read buffer for the reader's lifetime. A fresh 1 MB buffer per file was 863
// allocations on the first read, all OUTSIDE the JS heap, so they waited for a GC
// that little else was triggering: measured 99-124 MB resident afterwards against
// 3 MB of records. 256 KB: lines are ~3.5 KB on average, so larger buys nothing.
export const CHUNK = 256 * 1024;
const USAGE = Buffer.from('"usage"');
const FABLE = /^claude-.*fable/i;

// 53-bit string hash (cyrb53): the dedupe key as a NUMBER, so ~40k keys cost a
// number each rather than a 60-byte string each. A collision would drop one record;
// at 53 bits and tens of thousands of keys the odds are ~1e-7.
export function hash53(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/// The record from the five fields that matter, or null. Shared by both parsers
/// below so they cannot disagree about what a field MEANS, only about reading it.
function recordFrom(timestamp, requestId, id, model, u) {
  if (!u || typeof u !== "object" || typeof u.input_tokens !== "number" || typeof u.output_tokens !== "number") return null;
  const ts = typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
  if (!Number.isFinite(ts)) return null;
  const tok = u.input_tokens + u.output_tokens +
    (typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : 0) +
    (typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : 0);
  // Keyed on the message id, with the request id when there is one. Claude Code
  // writes one line PER CONTENT BLOCK of a reply, each repeating the message's
  // usage, and a reply served without a request id (a local model behind Claude
  // Code, and some Claude replies) still repeats its message id: keying only when
  // both existed counted those replies once per block - 31k-374k tokens a day too
  // many against ccusage 20 on this Mac's own transcripts.
  return {
    ts,
    tok,
    fable: typeof model === "string" && FABLE.test(model),
    h: typeof id === "string" ? hash53(`${id}:${typeof requestId === "string" ? requestId : ""}`) : null,
  };
}

/// One transcript line -> { ts, tok, fable, h } or null, by JSON.parse. The
/// REFERENCE: simple enough to trust, and what claude-tokens-check.mjs holds the
/// byte scanner to. Not used on the hot path - see parseUsageBytes.
export function parseUsageLine(line) {
  let d;
  try { d = JSON.parse(line); } catch { return null; }
  const m = d?.message;
  if (!m || typeof m !== "object") return null;
  return recordFrom(d.timestamp, d.requestId, m.id, m.model, m.usage);
}

// ---- the byte scanner ----
// JSON.parse of a whole assistant line builds the entire reply - code, file
// contents, tool input - to read five small fields. Over this Mac's week that was
// 148 MB of usage lines in two seconds, and V8 kept the heap it grew to: 58-66 MB
// resident after the first read, against 3 MB of live records. This walks the
// line's structure in place, steps OVER every value it does not need without
// making a string of it, and decodes only timestamp, requestId, message.id,
// message.model and message.usage (a small object). Inside a JSON string every
// quote is escaped, so finding a string's end is a search for an unescaped quote.
const K = (s) => Buffer.from(s);
const K_MESSAGE = K("message"), K_TIMESTAMP = K("timestamp"), K_REQUEST = K("requestId");
const K_ID = K("id"), K_MODEL = K("model"), K_USAGE = K("usage");
const keyIs = (b, s, e, k) => e - s === k.length && b.compare(k, 0, k.length, s, e) === 0;
const isWs = (c) => c === 32 || c === 10 || c === 13 || c === 9;
function ws(b, i, end) { while (i < end && isWs(b[i])) i++; return i; }
// i at an opening quote -> index just past its closing quote, or -1.
function skipString(b, i, end) {
  let j = i + 1;
  for (;;) {
    const q = b.indexOf(34, j);
    if (q < 0 || q >= end) return -1;
    let k = q - 1;
    while (b[k] === 92) k--;
    if ((q - 1 - k) % 2 === 0) return q + 1; // an even run of backslashes: not escaped
    j = q + 1;
  }
}
// i at any value -> index just past it, or -1.
function skipValue(b, i, end) {
  const c = b[i];
  if (c === 34) return skipString(b, i, end);
  if (c === 123 || c === 91) {
    let depth = 0;
    for (let j = i; j < end; ) {
      const x = b[j];
      if (x === 34) { j = skipString(b, j, end); if (j < 0) return -1; continue; }
      if (x === 123 || x === 91) depth++;
      else if ((x === 125 || x === 93) && --depth === 0) return j + 1;
      j++;
    }
    return -1;
  }
  let j = i;
  while (j < end && b[j] !== 44 && b[j] !== 125 && b[j] !== 93 && !isWs(b[j])) j++;
  return j > i ? j : -1;
}
// i at '{'; calls visit(keyStart, keyEnd, valueStart, valueEnd) for every member.
// Returns the index just past the object, or -1 on anything malformed.
function walkObject(b, i, end, visit) {
  if (b[i] !== 123) return -1;
  let j = ws(b, i + 1, end);
  if (b[j] === 125) return j + 1;
  for (;;) {
    if (b[j] !== 34) return -1;
    const ke = skipString(b, j, end);
    if (ke < 0) return -1;
    let v = ws(b, ke, end);
    if (b[v] !== 58) return -1;
    v = ws(b, v + 1, end);
    const ve = skipValue(b, v, end);
    if (ve < 0) return -1;
    visit(j + 1, ke - 1, v, ve);
    j = ws(b, ve, end);
    if (b[j] === 44) { j = ws(b, j + 1, end); continue; }
    return b[j] === 125 ? j + 1 : -1;
  }
}
// A captured value: JSON.parse of its own small slice (a string or the usage object).
const val = (b, s, e) => { try { return JSON.parse(b.toString("utf8", s, e)); } catch { return undefined; } };

/// One transcript line, as bytes [start, end) of `b` -> the same result as
/// parseUsageLine on that line. The hot path.
export function parseUsageBytes(b, start, end) {
  let timestamp, requestId, id, model, usage, sawMessage = false;
  const s = ws(b, start, end);
  const top = walkObject(b, s, end, (ks, ke, vs, ve) => {
    if (keyIs(b, ks, ke, K_TIMESTAMP)) timestamp = b[vs] === 34 ? val(b, vs, ve) : undefined;
    else if (keyIs(b, ks, ke, K_REQUEST)) requestId = b[vs] === 34 ? val(b, vs, ve) : undefined;
    else if (keyIs(b, ks, ke, K_MESSAGE)) {
      // Each occurrence starts afresh, as JSON.parse's last-key-wins would.
      sawMessage = b[vs] === 123;
      id = model = usage = undefined;
      if (!sawMessage) return;
      if (walkObject(b, vs, ve, (mks, mke, mvs, mve) => {
        if (keyIs(b, mks, mke, K_ID)) id = b[mvs] === 34 ? val(b, mvs, mve) : undefined;
        else if (keyIs(b, mks, mke, K_MODEL)) model = b[mvs] === 34 ? val(b, mvs, mve) : undefined;
        else if (keyIs(b, mks, mke, K_USAGE)) usage = b[mvs] === 123 ? val(b, mvs, mve) : undefined;
      }) < 0) sawMessage = false;
    }
  });
  if (top < 0 || ws(b, top, end) !== end || !sawMessage) return null;
  return recordFrom(timestamp, requestId, id, model, usage);
}

/// Monday 00:00 local time of the week containing `now`. Pure.
export function weekStartMs(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

/// Records deduplicated, then in time order. Copies of one reply can carry
/// DIFFERENT usage - a line per content block, output_tokens still growing - so
/// which copy wins moves the total. The LARGEST wins (ties: the first in the order
/// given, which read() makes files earliest-first, lines in order). Measured
/// against ccusage 20 over 25 days of this Mac's transcripts: "first copy wins" was
/// off by up to 11,881 tokens a day, "largest" by at most 5,680 (0.0013%), and no
/// other rule (last, smallest, most output) came closer.
export function dedupe(records) {
  const byKey = new Map();
  const out = [];
  for (const r of records) {
    if (r.h === null) { out.push(r); continue; }
    const prev = byKey.get(r.h);
    if (!prev || r.tok > prev.tok) byKey.set(r.h, r);
  }
  for (const r of byKey.values()) out.push(r);
  return out.sort((a, b) => a.ts - b.ts);
}

/// The three figures from a set of records (any order, duplicates allowed). Pure.
export function summarize(records, now) {
  const out = dedupe(records);

  let sessionTokens = 0;
  let start = null, last = null, sum = 0;
  for (const r of out) {
    // ccusage also breaks a block on a gap of more than 5h since the previous
    // record, but that is implied: the previous record is at or after the block's
    // start, so a record 5h past it is 5h past the start too. One test, not two -
    // the second could never change a result, so no check could ever see it go.
    if (start === null || r.ts - start > BLOCK_MS) {
      start = Math.floor(r.ts / 3600_000) * 3600_000; // the UTC hour floor
      sum = 0;
    }
    sum += r.tok;
    last = r.ts;
  }
  if (start !== null && now < start + BLOCK_MS && now - last < BLOCK_MS) sessionTokens = sum;

  const ws = weekStartMs(now);
  let weekAllTokens = 0, weekFableTokens = 0;
  for (const r of out) {
    if (r.ts < ws) continue;
    weekAllTokens += r.tok;
    if (r.fable) weekFableTokens += r.tok;
  }
  return { sessionTokens, weekAllTokens, weekFableTokens };
}

/// The incremental reader. `root` is ~/.claude/projects. Each call to read()
/// walks the tree (readdir + stat only), reads only bytes appended since the last
/// call, and returns the three figures. A file that shrank is read again from 0.
export function makeClaudeTokens({ root, now = () => Date.now(), retainMs = RETAIN_MS }) {
  const files = new Map(); // path -> { offset, records: [], first }
  const buf = Buffer.allocUnsafeSlow(CHUNK); // reused by every read; see CHUNK
  let cached = null;       // the last summary, reused while nothing changed

  // Every record, files earliest-first (by the earliest record ever read from each,
  // kept even after that record ages out) and each file in line order: the order
  // dedupe() needs to pick the copy ccusage picks.
  const records = () => [...files.values()].sort((a, b) => a.first - b.first).flatMap((f) => f.records);

  async function walk(dir, out) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full, out);
      else if (e.name.endsWith(".jsonl")) out.push(full);
    }
  }

  // Bytes [from, size) of one file, line by line, parsing only lines that contain
  // "usage" - most bytes are tool output and prose. Returns the offset just past
  // the last COMPLETE line (a line still being written is left for the next call).
  //
  // NO LINE IS COPIED UNLESS IT IS PARSED. Every read starts at a line boundary
  // and only the complete lines in it are looked at; the next read starts at the
  // first incomplete one. The first version carried an incomplete line over with
  // Buffer.concat, so a multi-MB tool result (a base64 image) was re-copied once
  // per 256 KB chunk: measured 168 MB resident after one pass over this Mac's
  // transcripts with the PARSER SWITCHED OFF, memory macOS's allocator keeps after
  // it is freed. A line longer than a whole chunk is walked in place to find its
  // end, and read into a buffer of its own only if it contains "usage" (the
  // largest such line measured was 0.1 MB).
  async function readFrom(file, from, size, records) {
    let fh;
    try { fh = await fs.open(file, "r"); } catch { return from; }
    const read = async (at, len) => (await fh.read(buf, 0, Math.min(CHUNK, len), at)).bytesRead;
    try {
      let pos = from;
      while (pos < size) {
        const n = await read(pos, size - pos);
        if (!n) break;
        const chunk = buf.subarray(0, n);
        const last = chunk.lastIndexOf(10);
        if (last === -1) {
          // One line longer than the buffer. Find its end without keeping it.
          const back = USAGE.length - 1; // overlap, so "usage" across a seam is seen
          let hasUsage = chunk.indexOf(USAGE) !== -1, p = pos + n, end = -1;
          while (p < size) {
            const m = await read(p - back, size - (p - back));
            if (m <= back) break;
            const c = buf.subarray(0, m);
            const nl = c.indexOf(10, back);
            const u = hasUsage ? -1 : c.indexOf(USAGE);
            if (u !== -1 && (nl === -1 || u < nl)) hasUsage = true;
            if (nl !== -1) { end = p - back + nl; break; }
            p = p - back + m;
          }
          if (end === -1) break; // still being written: leave it for the next call
          if (hasUsage) {
            const line = Buffer.allocUnsafe(end - pos);
            await fh.read(line, 0, line.length, pos);
            const r = parseUsageBytes(line, 0, line.length);
            if (r) records.push(r);
          }
          pos = end + 1;
          continue;
        }
        // Complete lines [0, last]. One forward search for "usage", reused until
        // the lines pass it, so no byte is searched twice.
        let s = 0, u = chunk.indexOf(USAGE);
        while (s <= last) {
          const nl = chunk.indexOf(10, s);
          if (u !== -1 && u < s) u = chunk.indexOf(USAGE, s);
          if (u !== -1 && u < nl) {
            const r = parseUsageBytes(chunk, s, nl);
            if (r) records.push(r);
          }
          s = nl + 1;
        }
        pos += last + 1;
      }
      return pos;
    } finally {
      await fh.close().catch(() => {});
    }
  }

  async function read() {
    const t = now();
    const cutoff = t - retainMs;
    const list = [];
    await walk(root, list);
    const seen = new Set();
    let changed = false;
    for (const file of list) {
      let st;
      try { st = await fs.stat(file); } catch { continue; }
      if (st.mtimeMs < cutoff) continue; // nothing in it can be recent enough
      seen.add(file);
      let f = files.get(file);
      if (f && st.size < f.offset) { f = null; changed = true; } // rewritten: start over
      if (!f) { f = { offset: 0, records: [], first: Infinity }; files.set(file, f); }
      if (st.size > f.offset) {
        const before = f.records.length;
        f.offset = await readFrom(file, f.offset, st.size, f.records);
        for (let i = before; i < f.records.length; i++) if (f.records[i].ts < f.first) f.first = f.records[i].ts;
        if (f.records.length !== before) changed = true;
      }
    }
    for (const file of files.keys()) {
      if (!seen.has(file)) { files.delete(file); changed = true; }
    }
    // Drop what has aged out, in place, so a file read once a week ago does not
    // keep a week of records it no longer needs.
    for (const f of files.values()) {
      if (f.records.length && f.records[0].ts < cutoff) {
        const kept = f.records.filter((r) => r.ts >= cutoff);
        if (kept.length !== f.records.length) { f.records = kept; changed = true; }
      }
    }
    // The block's ACTIVE test and the week boundary depend on the clock, so the
    // summary is recomputed when time has moved materially, not only on new data.
    if (!changed && cached && t - cached.at < 60_000 && weekStartMs(t) === cached.week) return cached.value;
    const value = summarize(records(), t);
    cached = { at: t, week: weekStartMs(t), value };
    return value;
  }

  return { read, records, stats: () => ({ files: files.size, records: [...files.values()].reduce((n, f) => n + f.records.length, 0) }) };
}
