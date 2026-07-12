// Deckhand host script: polls local Claude Code usage (via ccusage) and streams
// it as JSON lines to the ELEGOO ESP32 display, over USB serial and/or BLE -
// whichever the device currently has connected. The two transports are
// independent: this script always tries both, and sends to whichever are
// live each tick.
//
// BLE needs to run inside DeckhandBLE.app (see that bundle's Info.plist) rather
// than as a bare `node` process - macOS's TCC framework kills a plain node
// process outright (not even a permission prompt) if it touches CoreBluetooth
// without an Info.plist declaring NSBluetoothAlwaysUsageDescription.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { SerialPort } from "serialport";
import noble from "@abandonware/noble";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CCUSAGE_BIN = path.join(__dirname, "node_modules", ".bin", "ccusage");

// When launched via `open DeckhandBLE.app` (needed for the Bluetooth permission
// prompt - see DeckhandBLE.app/Contents/Info.plist), stdout/stderr aren't
// inherited by whatever shell launched it, so console.log alone goes
// nowhere useful. Write directly to a log file too, always.
const LOG_FILE = "/tmp/deckhand-host.log";
const logStream = createWriteStream(LOG_FILE, { flags: "a" });
const rawLog = console.log.bind(console);
const rawError = console.error.bind(console);
console.log = (...args) => {
  logStream.write(args.map(String).join(" ") + "\n");
  rawLog(...args);
};
console.error = (...args) => {
  logStream.write(args.map(String).join(" ") + "\n");
  rawError(...args);
};

// FALLBACK quota source: written by ~/.claude/deckhand-statusline.mjs, which
// Claude Code invokes after every assistant message in a *terminal* session
// (the desktop app and VS Code extension never fire it, so this can go
// hours-stale). Kept as the fallback for when the OAuth endpoint below
// fails or changes shape. See https://code.claude.com/docs/en/statusline
const RATE_LIMIT_CACHE = path.join(os.homedir(), ".claude", "deckhand-rate-limits.json");

// PRIMARY quota source: the same endpoint Claude Code's own /usage screen
// uses. Works with zero sessions open, and the numbers are account-wide
// (terminal, VS Code, desktop app, and claude.ai all draw from the same
// 5h/7d windows). Undocumented, so any failure just falls back to the
// statusLine cache above. Authenticated with the OAuth token Claude Code
// stores in the macOS Keychain; we only ever READ that token - if it's
// expired we retry the Keychain once (Claude Code rotates it) and
// otherwise give up until the next poll, rather than refreshing it
// ourselves and risking invalidating Claude Code's session.
const OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_KEYCHAIN_SERVICE = "Claude Code-credentials";
// Gentle cadence: the endpoint rate-limits bursty callers (observed HTTP
// 429 after several rapid host restarts), and quota % barely moves in five
// minutes anyway.
const OAUTH_POLL_INTERVAL_MS = 5 * 60_000;
const OAUTH_429_BACKOFF_MS = 15 * 60_000;
// Last successful fetch, persisted so host restarts (one per firmware flash
// during development) neither lose good data nor fire a burst of startup
// polls into the endpoint's rate limiter.
const OAUTH_CACHE_FILE = "/tmp/deckhand-oauth-usage.json";

// Written by ~/.claude/deckhand-session-hook.mjs (registered for SessionStart,
// UserPromptSubmit, Stop, SessionEnd). One file per session_id; deleted on
// SessionEnd. This is what powers the SESSIONS tab.
const SESSIONS_DIR = path.join(os.homedir(), ".claude", "deckhand-sessions");
const SESSION_STALE_MS = 20 * 60 * 1000; // 20 min with no update = treat as dead

const BAUD_RATE = 115200;
const POLL_INTERVAL_MS = 5000;
const RECONNECT_INTERVAL_MS = 3000;

// Drop a file at this path to send a one-off command to the device over
// whichever transport(s) are already open. Opening a FRESH USB connection
// pulses the CH340's reset line and reboots the ESP32, which is not what you
// want when e.g. triggering recalibration - the command has to ride an
// already-open connection instead.
const COMMAND_TRIGGER_PATH = path.join(os.homedir(), ".claude", "deckhand-device-command");

// Nordic UART Service - must match the UUIDs in deckhand_display.ino exactly.
// noble wants lowercase, no dashes.
const BLE_SERVICE_UUID = "6e400001b5a3f393e0a9e50e24dcca9e";
const BLE_RX_CHAR_UUID = "6e400002b5a3f393e0a9e50e24dcca9e";
const BLE_TX_CHAR_UUID = "6e400003b5a3f393e0a9e50e24dcca9e"; // device -> host notifications

// Remote answers: the device sends "ANSWER <id12> <pid> <optionIdx>" when
// the user taps an option on an asking session's detail screen; we write it
// where the (blocked, waiting) session hook picks it up and turns it into a
// real hook decision.
const ANSWERS_DIR = path.join(os.homedir(), ".claude", "deckhand-answers");
// Heartbeat the session hook checks before blocking on a remote answer.
const HOST_ALIVE = "/tmp/deckhand-host-alive";
// Conservative chunk size that doesn't depend on MTU negotiation succeeding -
// 20 bytes is the default ATT payload before any negotiation, so this works
// even in the worst case.
const BLE_CHUNK_SIZE = 20;

async function runCcusage(args) {
  const { stdout } = await execFileAsync(CCUSAGE_BIN, [...args, "--json"], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function readRateLimits() {
  try {
    return JSON.parse(await fs.readFile(RATE_LIMIT_CACHE, "utf8"));
  } catch {
    return {}; // no statusline invocation yet this session
  }
}

function minutesUntilMs(epochMs) {
  if (!epochMs) return null;
  return Math.max(0, Math.round((epochMs - Date.now()) / 60000));
}

function minutesUntil(epochSeconds) {
  return minutesUntilMs(epochSeconds ? epochSeconds * 1000 : null);
}

// ---------- OAuth usage polling ----------
let oauthUsage = null; // last successful fetch, plus fetchedAt
try {
  oauthUsage = JSON.parse(await fs.readFile(OAUTH_CACHE_FILE, "utf8"));
} catch {
  // no persisted snapshot yet
}

// The 429 back-off deadline survives host restarts here. The host restarts
// on every firmware flash during development, and an immediate poll per
// restart once compounded into an hours-long rate-limit penalty.
const OAUTH_BACKOFF_STATE = "/tmp/deckhand-oauth-backoff.json";

async function readOauthToken() {
  const { stdout } = await execFileAsync("security", [
    "find-generic-password",
    "-s",
    OAUTH_KEYCHAIN_SERVICE,
    "-w",
  ]);
  return JSON.parse(stdout).claudeAiOauth?.accessToken ?? null;
}

async function fetchOauthUsage(token) {
  return fetch(OAUTH_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(10_000),
  });
}

async function pollOauthUsage() {
  try {
    // Still inside a persisted back-off window (possibly from a previous
    // run of this script)? Wait it out instead of re-tripping the limit.
    try {
      const state = JSON.parse(await fs.readFile(OAUTH_BACKOFF_STATE, "utf8"));
      const waitMs = state.notBefore - Date.now();
      if (waitMs > 0) {
        console.error(`OAuth usage: honoring back-off, retrying in ${Math.ceil(waitMs / 60000)}m`);
        setTimeout(pollOauthUsage, waitMs);
        return;
      }
    } catch {
      // no back-off state, proceed
    }

    // Read the token fresh on every poll (cheap at this cadence). Claude
    // Code rotates it; holding a cached copy once pinned the poller in a
    // rate-limit loop while the Keychain already had a good token.
    const token = await readOauthToken();
    if (!token) throw new Error("no OAuth token in Keychain");

    const resp = await fetchOauthUsage(token);
    if (resp.status === 429) {
      const retryAfterSec = parseInt(resp.headers.get("retry-after") ?? "", 10);
      const backoffMs = Number.isFinite(retryAfterSec)
        ? Math.min(retryAfterSec * 1000, 60 * 60_000)
        : OAUTH_429_BACKOFF_MS;
      await fs
        .writeFile(OAUTH_BACKOFF_STATE, JSON.stringify({ notBefore: Date.now() + backoffMs }))
        .catch(() => {});
      console.error(`OAuth usage: rate limited, backing off ${Math.ceil(backoffMs / 60000)}m`);
      setTimeout(pollOauthUsage, backoffMs);
      return;
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    await fs.rm(OAUTH_BACKOFF_STATE, { force: true });

    const data = await resp.json();
    // Per-model weekly caps live in the limits array as "weekly_scoped"
    // entries; we only surface Fable's since that's the scarce one.
    const fableLimit = (data.limits ?? []).find(
      (l) => l.kind === "weekly_scoped" && /fable/i.test(l.scope?.model?.display_name ?? "")
    );
    oauthUsage = {
      fiveHourPct: data.five_hour?.utilization ?? null,
      fiveHourResetsAtMs: data.five_hour?.resets_at ? Date.parse(data.five_hour.resets_at) : null,
      sevenDayPct: data.seven_day?.utilization ?? null,
      sevenDayResetsAtMs: data.seven_day?.resets_at ? Date.parse(data.seven_day.resets_at) : null,
      weekFablePct: fableLimit?.percent ?? null,
      fetchedAt: Date.now(),
    };
    await fs.writeFile(OAUTH_CACHE_FILE, JSON.stringify(oauthUsage)).catch(() => {});
  } catch (err) {
    // Keep any previous oauthUsage; readUsage falls back to the statusLine
    // cache once it's older than OAUTH_FRESH_MS.
    console.error(`OAuth usage: ${err.message} (statusLine cache will be used)`);
  }
  setTimeout(pollOauthUsage, OAUTH_POLL_INTERVAL_MS);
}

// Truncates a long path to fit the device's screen, keeping the most
// specific (rightmost) part, which is the part worth reading at a glance.
function truncatePath(p, maxLen) {
  if (!p || p.length <= maxLen) return p;
  return "..." + p.slice(-(maxLen - 3));
}

// Claude Code doesn't hand the model to most hook events (desktop-app
// sessions never see it at all), but every assistant message in the session
// transcript records which model produced it. Read the tail of the JSONL and
// take the most recent occurrence - this also tracks mid-session /model
// switches, which a SessionStart-time snapshot would not.
async function modelFromTranscript(transcriptPath) {
  if (!transcriptPath) return "";
  try {
    const fh = await fs.open(transcriptPath, "r");
    try {
      const { size } = await fh.stat();
      const len = Math.min(size, 64 * 1024);
      if (len === 0) return "";
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, size - len);
      const matches = buf.toString("utf8").match(/"model":"(claude-[a-z0-9.-]+)"/g);
      if (!matches || matches.length === 0) return "";
      return matches[matches.length - 1]
        .slice('"model":"'.length, -1)
        .replace(/-\d{8}$/, ""); // drop dated suffixes like -20251001
    } finally {
      await fh.close();
    }
  } catch {
    return ""; // transcript missing/unreadable - fall back to the hook's value
  }
}

async function gitBranch(cwd) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "branch", "--show-current"], {
      timeout: 1000,
    });
    return stdout.trim();
  } catch {
    return ""; // not a git repo, or git not available
  }
}

async function readSessions() {
  let files;
  try {
    files = await fs.readdir(SESSIONS_DIR);
  } catch {
    return []; // no sessions have run since this file was introduced
  }

  const records = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const filePath = path.join(SESSIONS_DIR, file);
    try {
      const record = JSON.parse(await fs.readFile(filePath, "utf8"));
      if (Date.now() - record.updated_at > SESSION_STALE_MS) {
        await fs.rm(filePath, { force: true }); // terminal likely closed without SessionEnd
        continue;
      }
      // The filename IS the session id - carry it so the device can match
      // sessions across polls even when two sessions share a project name.
      records.push({ ...record, id: path.basename(file, ".json") });
    } catch {
      // ignore unreadable/partially-written file this tick
    }
  }

  // Urgency first, recency second: the display fits 6 sessions, and when
  // there are more, a session that NEEDS INPUT must never be the hidden one.
  const rank = (r) => (r.status === "asking" ? 0 : r.status === "waiting" ? 1 : 2);
  records.sort((a, b) => rank(a) - rank(b) || b.updated_at - a.updated_at);
  const top = records.slice(0, 6);

  const list = await Promise.all(
    top.map(async (record) => {
      const item = {
        id: (record.id || "").slice(0, 12), // 12 uuid chars is plenty to disambiguate
        name: (path.basename(record.cwd || "") || "unknown").slice(0, 20),
        status: record.status,
        path: truncatePath(record.cwd || "", 48),
        model: ((await modelFromTranscript(record.transcript)) || record.model || "").slice(0, 20),
        branch: (await gitBranch(record.cwd || "")).slice(0, 20),
      };
      // Pending question (already truncated by the hook) rides along so the
      // device can display it and offer the options as buttons.
      if (record.ask) item.ask = record.ask;
      return item;
    })
  );
  return {
    list,
    total: records.length,
    // Only nonzero with 7+ simultaneously-asking sessions, but if that ever
    // happens the device must say so rather than hide it.
    hiddenAsking: records.slice(6).filter((r) => r.status === "asking").length,
  };
}

function sumModelTokens(mb) {
  return (
    (mb.inputTokens ?? 0) +
    (mb.outputTokens ?? 0) +
    (mb.cacheCreationTokens ?? 0) +
    (mb.cacheReadTokens ?? 0)
  );
}

async function readUsage() {
  const [blocksResp, weeklyResp, rateLimits, sessions] = await Promise.all([
    runCcusage(["blocks", "--active"]),
    runCcusage(["weekly"]),
    readRateLimits(),
    readSessions(),
  ]);

  const activeBlock = blocksResp.blocks.find((b) => b.isActive);
  const currentWeek = weeklyResp.weekly.at(-1) ?? { totalTokens: 0, modelBreakdowns: [] };
  const fiveHour = rateLimits.five_hour;
  const sevenDay = rateLimits.seven_day;
  const fableBreakdown = (currentWeek.modelBreakdowns ?? []).find((mb) =>
    /fable/i.test(mb.modelName)
  );

  // Use whichever quota source is genuinely NEWER. An OAuth snapshot from 30
  // minutes ago (endpoint in a rate-limit back-off) still beats a statusLine
  // cache that only updates in terminal sessions - for a desktop-app-only
  // user that cache can be days old. Reset countdowns stay live either way,
  // since they're computed from absolute timestamps; only the % ages, and
  // quotaAgeSec tells the device exactly how much.
  const oauthAt = oauthUsage?.fetchedAt ?? 0;
  const cacheAt = rateLimits.written_at ?? 0;
  const useOauth = !!oauthUsage && oauthAt >= cacheAt;
  const quotaAt = useOauth ? oauthAt : cacheAt;

  return {
    fiveHourPct: useOauth ? oauthUsage.fiveHourPct : (fiveHour?.used_percentage ?? null),
    fiveHourResetInMin: useOauth
      ? minutesUntilMs(oauthUsage.fiveHourResetsAtMs)
      : minutesUntil(fiveHour?.resets_at),
    sessionTokens: activeBlock?.totalTokens ?? 0,
    sevenDayPct: useOauth ? oauthUsage.sevenDayPct : (sevenDay?.used_percentage ?? null),
    sevenDayResetInMin: useOauth
      ? minutesUntilMs(oauthUsage.sevenDayResetsAtMs)
      : minutesUntil(sevenDay?.resets_at),
    weekAllTokens: currentWeek.totalTokens ?? 0,
    weekFableTokens: fableBreakdown ? sumModelTokens(fableBreakdown) : 0,
    weekFablePct: useOauth ? oauthUsage.weekFablePct : null,
    quotaSource: useOauth ? "oauth" : "cache",
    // How old the quota numbers actually are, so the device can flag stale
    // data on screen - the footer's freshness only covers the transport.
    quotaAgeSec: quotaAt > 0 ? Math.round((Date.now() - quotaAt) / 1000) : null,
    sessions: sessions.list,
    sessionsTotal: sessions.total,
    hiddenAsking: sessions.hiddenAsking,
    // Seconds since local midnight, so the device can render a live clock
    // without needing to know the timezone - it just ticks this forward
    // with millis() between updates and re-syncs on every poll.
    hostSecondsSinceMidnight:
      new Date().getHours() * 3600 + new Date().getMinutes() * 60 + new Date().getSeconds(),
  };
}

// ---------- Device -> host lines (both transports) ----------
let lastAnswerKey = "";
let lastAnswerAt = 0;

async function handleDeviceLine(line, via) {
  console.log(`[device/${via}] ${line}`);
  if (!line.startsWith("ANSWER ")) return;
  // The device sends on USB and BLE simultaneously - process one copy.
  if (line === lastAnswerKey && Date.now() - lastAnswerAt < 3000) return;
  lastAnswerKey = line;
  lastAnswerAt = Date.now();
  const parts = line.trim().split(/\s+/); // ANSWER <id12> <pid> <idx>
  if (parts.length !== 4) return;
  const [, id12, pid, idxStr] = parts;
  const idx = parseInt(idxStr, 10);
  if (!Number.isInteger(idx) || idx < 0) return;
  try {
    const files = await fs.readdir(SESSIONS_DIR);
    const file = files.find((f) => f.endsWith(".json") && f.startsWith(id12));
    if (!file) {
      console.error(`Remote answer: no session matching ${id12}`);
      return;
    }
    const sessionId = path.basename(file, ".json");
    let label = "";
    try {
      const rec = JSON.parse(await fs.readFile(path.join(SESSIONS_DIR, file), "utf8"));
      label = rec.ask?.options?.[idx] ?? "";
    } catch {
      // label is best-effort garnish for the question-answer path
    }
    await fs.mkdir(ANSWERS_DIR, { recursive: true });
    await fs.writeFile(
      path.join(ANSWERS_DIR, `${sessionId}.json`),
      JSON.stringify({ pid, idx, label, written_at: Date.now() })
    );
    console.log(`Remote answer: ${id12} prompt ${pid} -> [${idx}] ${label}`);
  } catch (err) {
    console.error("Remote answer failed:", err.message);
  }
}

// ---------- USB transport ----------
let usbPort = null;

async function findUsbPort() {
  if (process.env.SERIAL_PORT) return process.env.SERIAL_PORT;
  const ports = await SerialPort.list();
  const usb = ports.find(
    (p) =>
      (p.vendorId ?? "").toLowerCase() === "1a86" || // CH340
      /usbserial|wchusbserial|SLAB_USBtoUART/i.test(p.path)
  );
  return usb?.path ?? null;
}

async function connectUsb() {
  const portPath = await findUsbPort();
  if (!portPath) {
    setTimeout(connectUsb, RECONNECT_INTERVAL_MS);
    return;
  }
  console.log(`USB: connecting to ${portPath} @ ${BAUD_RATE}...`);
  const port = new SerialPort({ path: portPath, baudRate: BAUD_RATE });

  try {
    await new Promise((resolve, reject) => {
      port.once("open", resolve);
      port.once("error", reject);
    });
  } catch (err) {
    console.error("USB: connect failed:", err.message);
    setTimeout(connectUsb, RECONNECT_INTERVAL_MS);
    return;
  }
  console.log("USB: connected.");
  usbPort = port;

  let rxBuf = "";
  port.on("data", (chunk) => {
    rxBuf += chunk.toString("utf8");
    let idx;
    while ((idx = rxBuf.indexOf("\n")) !== -1) {
      const line = rxBuf.slice(0, idx).trim();
      rxBuf = rxBuf.slice(idx + 1);
      if (line) handleDeviceLine(line, "usb");
    }
  });
  port.on("close", () => {
    console.log("USB: disconnected, will retry...");
    usbPort = null;
    setTimeout(connectUsb, RECONNECT_INTERVAL_MS);
  });
  port.on("error", (err) => console.error("USB: error:", err.message));
}

// ---------- BLE transport ----------
let bleCharacteristic = null;

// Scans for every device rather than filtering by our 128-bit service UUID:
// that UUID is 16 bytes, which usually doesn't fit in the 31-byte primary
// BLE advertisement packet alongside anything else, so a UUID-filtered scan
// can miss the ESP32 entirely. Matching by local name is more reliable.
function startBleScan() {
  console.log("BLE: scanning for Deckhand...");
  noble.startScanningAsync([], false).catch((err) => {
    console.error("BLE: scan failed to start:", err.message);
  });
}

function startBle() {
  noble.on("stateChange", (state) => {
    console.log(`BLE: adapter state = ${state}`);
    if (state === "poweredOn") startBleScan();
    else noble.stopScanningAsync().catch(() => {});
  });

  noble.on("discover", async (peripheral) => {
    const name = peripheral.advertisement.localName || "";
    if (name !== "Deckhand") return;
    await noble.stopScanningAsync().catch(() => {});
    console.log(`BLE: found ${name}, connecting...`);
    try {
      await peripheral.connectAsync();
      const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
        [BLE_SERVICE_UUID],
        [BLE_RX_CHAR_UUID, BLE_TX_CHAR_UUID]
      );
      bleCharacteristic = characteristics.find((c) => c.uuid === BLE_RX_CHAR_UUID) ?? null;
      if (!bleCharacteristic) {
        console.error("BLE: RX characteristic not found on peripheral");
        await peripheral.disconnectAsync().catch(() => {});
        return;
      }
      // Subscribe to the device's TX notifications - the device->host lane
      // that carries remote answers (and anything else it wants logged).
      const txChar = characteristics.find((c) => c.uuid === BLE_TX_CHAR_UUID);
      if (txChar) {
        let bleLineBuf = "";
        txChar.on("data", (buf) => {
          bleLineBuf += buf.toString("utf8");
          let i;
          while ((i = bleLineBuf.indexOf("\n")) !== -1) {
            const line = bleLineBuf.slice(0, i).trim();
            bleLineBuf = bleLineBuf.slice(i + 1);
            if (line) handleDeviceLine(line, "ble");
          }
        });
        await txChar.subscribeAsync().catch((err) => {
          console.error("BLE: TX subscribe failed:", err.message);
        });
      }
      console.log("BLE: connected and ready.");
      peripheral.once("disconnect", () => {
        console.log("BLE: disconnected, re-scanning...");
        bleCharacteristic = null;
        startBleScan();
      });
    } catch (err) {
      console.error("BLE: connect failed:", err.message);
      bleCharacteristic = null;
      startBleScan();
    }
  });
}

async function sendOverBle(text) {
  const characteristic = bleCharacteristic;
  if (!characteristic) return;
  const buf = Buffer.from(text, "utf8");
  for (let i = 0; i < buf.length; i += BLE_CHUNK_SIZE) {
    try {
      await characteristic.writeAsync(buf.subarray(i, i + BLE_CHUNK_SIZE), true);
    } catch (err) {
      console.error("BLE: write failed:", err.message);
      return;
    }
  }
}

// ---------- Shared tick: compute usage once, send to whichever transports are live ----------
async function tick() {
  try {
    // Heartbeat for the session hook: it only blocks waiting for a remote
    // answer when a display is genuinely connected right now.
    await fs
      .writeFile(HOST_ALIVE, JSON.stringify({ connected: !!(usbPort || bleCharacteristic), at: Date.now() }))
      .catch(() => {});

    const usage = await readUsage();
    const line = JSON.stringify(usage) + "\n";
    if (usbPort) usbPort.write(line);
    if (bleCharacteristic) await sendOverBle(line);
    console.log(
      `5h=${usage.fiveHourPct ?? "?"}% (resets ${usage.fiveHourResetInMin ?? "?"}m) ` +
        `7d=${usage.sevenDayPct ?? "?"}% (resets ${usage.sevenDayResetInMin ?? "?"}m) ` +
        `sessionTok=${usage.sessionTokens} weekTok=${usage.weekAllTokens} ` +
        `weekFableTok=${usage.weekFableTokens} weekFablePct=${usage.weekFablePct ?? "?"} ` +
        `src=${usage.quotaSource} sessions(${usage.sessionsTotal})=${JSON.stringify(usage.sessions)} ` +
        `via=${[usbPort && "usb", bleCharacteristic && "ble"].filter(Boolean).join(",") || "none"}`
    );
  } catch (err) {
    console.error("Failed to read usage:", err.message);
  }
  setTimeout(tick, POLL_INTERVAL_MS);
}

setInterval(async () => {
  try {
    const command = (await fs.readFile(COMMAND_TRIGGER_PATH, "utf8")).trim();
    await fs.rm(COMMAND_TRIGGER_PATH, { force: true });
    if (command) {
      console.log(`Sending command to device: ${command}`);
      if (usbPort) usbPort.write(command + "\n");
      if (bleCharacteristic) await sendOverBle(command + "\n");
    }
  } catch {
    // no trigger file waiting, nothing to do
  }
}, 500);

connectUsb();
startBle();
// If the persisted snapshot is still inside the poll interval, wait out the
// remainder instead of polling on startup - restarts must not burst the
// endpoint's rate limiter.
{
  const age = oauthUsage ? Date.now() - oauthUsage.fetchedAt : Infinity;
  setTimeout(pollOauthUsage, age < OAUTH_POLL_INTERVAL_MS ? OAUTH_POLL_INTERVAL_MS - age : 0);
}
tick();
