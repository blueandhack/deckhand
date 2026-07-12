#!/usr/bin/env node
// Claude Code statusLine hook for the "deckhand" ESP32 usage display project.
//
// This is the ONLY place the real "% of plan quota used" numbers exist -
// they come from Anthropic's server-side rate limiting and are handed to
// Claude Code per-response, not stored anywhere in the local transcripts.
// This script mirrors them into a small cache file that the host script
// (../Projects/deckhand/host/index.mjs) polls and forwards to the display.
//
// It also still prints a normal status line so your terminal keeps showing
// something useful instead of going blank.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CACHE_PATH = path.join(os.homedir(), ".claude", "deckhand-rate-limits.json");
const DEBUG_LOG = path.join(os.homedir(), ".claude", "deckhand-statusline-debug.log");

try {
  fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()} invoked\n`);
} catch {
  // best-effort debug trail only
}

let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  let data;
  try {
    data = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  const model = data.model?.display_name ?? "Claude";
  const rate = data.rate_limits ?? {};
  const fiveHour = rate.five_hour;
  const sevenDay = rate.seven_day;

  // Merge with whatever we already have so an absent field (e.g. before the
  // first API response) doesn't blank out the last known good reading.
  let cache = {};
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch {
    // no cache yet, that's fine
  }

  if (fiveHour) cache.five_hour = fiveHour;
  if (sevenDay) cache.seven_day = sevenDay;
  cache.written_at = Date.now();

  const tmpPath = CACHE_PATH + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(cache));
  fs.renameSync(tmpPath, CACHE_PATH);

  const parts = [];
  if (fiveHour?.used_percentage != null) {
    parts.push(`5h: ${Math.round(fiveHour.used_percentage)}%`);
  }
  if (sevenDay?.used_percentage != null) {
    parts.push(`7d: ${Math.round(sevenDay.used_percentage)}%`);
  }

  console.log(parts.length ? `[${model}] | ${parts.join(" ")}` : `[${model}]`);
});
