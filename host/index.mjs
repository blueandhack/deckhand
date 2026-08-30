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

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { createWriteStream, renameSync, statSync, appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from "node:fs";
import crypto from "node:crypto";
import { SerialPort } from "serialport";
import noble from "@abandonware/noble";
import { mergeById } from "./sessions-merge.mjs";
import {
  voiceSha,
  verifyVoiceAnswer,
  capUtf8,
  ANSWER_TEXT_MAX_BYTES as VOICE_ANSWER_TEXT_MAX_BYTES,
} from "./voice-answer.mjs";
import { resolveSessionId } from "./session-lookup.mjs";
import { verifyPrompt, verifyTypedAnswer } from "./typed-answer.mjs";
import { macTag } from "./host-tag.mjs";
import { toAscii, deviceText } from "./to-ascii.mjs";
import { fitPayload } from "./wire-fit.mjs";
import { asciiFit, describeOffenders } from "./wire-ascii.mjs";
import { resolveMacEmoji } from "./mac-emoji.mjs";
import { lineTargetsUs, stripAddress } from "./line-address.mjs";
import { formatRunStartLine } from "./run-ledger.mjs";
import { classifyStall, stallMessage } from "./watchdog.mjs";
import { pickTokens, describeChildError, CCUSAGE_TIMEOUT_MS } from "./ccusage.mjs";
// The wireless-pairing derivations. Pure functions with no I/O and no clock,
// pinned byte for byte against pairing.ino by pair-crypto-check.mjs - do not
// reimplement any of them here.
import {
  generateKeypair,
  deriveShared,
  deriveCode,
  deriveKey,
  pairProof,
} from "./pair-crypto.mjs";

const execFileAsync = promisify(execFile);
import {
  shouldRefreshCodex,
  windowExpired,
  CODEX_BACKOFF_MS,
} from "./codex-refresh.mjs";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Spawned as `<this node> <script>`, NOT by executing the .bin shebang. That
// shebang is `#!/usr/bin/env node`, which needs `node` on PATH - and under
// launchd PATH is minimal, while this machine's node is nvm-managed at
// ~/.nvm/versions/node/<version>/bin and is on no standard path at all. The
// symptom was ugly and indirect: `env: node: No such file or directory` every
// tick, readUsage() throwing, no payload sent, and a device stuck on "waiting
// for the first update" while the host looked perfectly healthy.
//
// process.execPath is the node inside DeckhandBLE.app, so it always exists and
// never depends on PATH or on which node version happens to be selected - the
// same reason the mic decoder is spawned this way.
const CCUSAGE_JS = path.join(__dirname, "node_modules", "ccusage", "src", "cli.js");

// When launched via `open DeckhandBLE.app` (needed for the Bluetooth permission
// prompt - see DeckhandBLE.app/Contents/Info.plist), stdout/stderr aren't
// inherited by whatever shell launched it, so console.log alone goes
// nowhere useful. Write directly to a log file too, always.
// PER-USER runtime directory, and the "per-user" part is load-bearing on a Mac
// with more than one account. All of this state used to sit at fixed
// /tmp/deckhand-* paths, which collide two ways: the second user's host cannot
// write files the first user created (they land mode 644, owned by whoever got
// there first), and - worse - the second user's session HOOK would read the
// first user's heartbeat, conclude a display was connected, and block up to 90s
// on every permission prompt with no device anywhere to answer it. Mode 0700 also
// means another account cannot read your heartbeat even by accident.
//
// The hook derives this identically (see claude-hooks/deckhand-session-hook.mjs);
// the two MUST agree or remote answering silently stops working. DECKHAND_TMP
// stays the override/test seam it already was, used verbatim when set.
const RUNTIME_DIR = process.env.DECKHAND_TMP || `/tmp/deckhand-${process.getuid()}`;
try {
  mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
} catch {
  // Nothing to fall back to; the writes below will surface it.
}
const LOG_FILE = path.join(RUNTIME_DIR, "host.log");
// ROTATED, because this appends a ~700-byte tick line every 5s: measured at 4.4 MB/day,
// ~131 MB/month. One previous generation is kept (.1) so a crash's context survives the
// rotation that follows it. Size is tracked from what we write rather than by stat()ing on
// every line - the counter is seeded from the existing file at startup.
const LOG_MAX_BYTES = 5 * 1024 * 1024;
let logStream = createWriteStream(LOG_FILE, { flags: "a" });
let logBytes = 0;
try {
  logBytes = statSync(LOG_FILE).size;
} catch {
  logBytes = 0;
}
function rotateLogIfNeeded() {
  if (logBytes < LOG_MAX_BYTES) return;
  const old = logStream;
  logBytes = 0;
  try {
    renameSync(LOG_FILE, `${LOG_FILE}.1`); // replaces any previous generation
  } catch {
    return; // couldn't rotate (permissions, races) - keep writing to the same file
  }
  logStream = createWriteStream(LOG_FILE, { flags: "a" });
  old.end();
}
// ---------------------------------------------------------------------------
// RESTART LEDGER — how we find out whether the supervisor is earning its place.
//
// A supervisor cannot be proven correct by argument; only time tells you whether
// it is catching anything. But a restart used to leave almost no trace - launchd
// keeps no history and the host's log simply resumed mid-stream - so a month
// later you would be no wiser. One line per start fixes that, and turns "is this
// working?" into something you can read off `deckhand-service.sh status`.
//
// The interesting column is "last tick", not "duration". A run that lasted 5h
// but whose last tick was 4h before it ended did not die - it HUNG, which is the
// exact failure that started all this, and the pair of numbers tells them apart.
// It costs no per-tick I/O: the tick heartbeat is already written every 5s, so
// the previous run's final tick is simply read back from it at startup.
//
// BUT THE TWO COLUMNS HAVE DIFFERENT LIFETIMES, and conflating them is what made
// this ledger lie for its first 182 entries. The duration comes from this file,
// under ~/.claude, which survives everything; the last tick comes from the
// heartbeat in the runtime dir under /tmp, WHICH MACOS CLEARS AT BOOT. So a
// missing heartbeat is the ordinary state after a reboot and means "unknown",
// never "hung". run-ledger.mjs keeps the two apart and is the tested half.
const RUN_STATE = path.join(os.homedir(), ".claude", "deckhand-run-state.json");
const RESTART_LOG = path.join(os.homedir(), ".claude", "deckhand-restarts.log");
let runStartedAt = Date.now();
let watchdogFires = 0;
let suspendResumes = 0;   // machine sleeps, kept apart from real hangs

function readJsonSync(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function recordRunStart() {
  const prev = readJsonSync(RUN_STATE);
  const beat = readJsonSync(HOST_ALIVE);
  let n = 1;
  if (prev) {
    n = (prev.startNumber || 0) + 1;
    // The arithmetic lives in run-ledger.mjs so run-ledger-check.mjs can test
    // it. A missing endReason means the previous run never got to record one
    // (SIGKILL, or the machine went down under it), and a missing heartbeat
    // means /tmp was cleared - which is NOT a hang, and used to be reported as
    // the longest possible one. See that file's header.
    try {
      appendFileSync(RESTART_LOG, formatRunStartLine({ n, prev, beat, at: Date.now() }));
    } catch {}
  }
  try {
    writeFileSync(
      RUN_STATE,
      JSON.stringify({ startNumber: n, startedAt: runStartedAt, pid: process.pid, watchdogFires: 0, suspendResumes: 0 })
    );
  } catch {}
}

// Best-effort and synchronous: this runs on the way out, so a stream would not
// flush in time (measured - the buffered line is simply lost).
function recordRunEnd(reason) {
  const cur = readJsonSync(RUN_STATE);
  if (!cur || cur.pid !== process.pid) return; // a newer run owns the file now
  try {
    writeFileSync(
      RUN_STATE,
      JSON.stringify({ ...cur, watchdogFires, suspendResumes, endReason: reason, endedAt: Date.now() })
    );
  } catch {}
}

for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => {
    recordRunEnd(sig);
    process.exit(0);
  });
}

// A death must leave evidence. Everything above writes through a STREAM, whose
// buffered contents are lost if the process exits before it drains - so the two
// handlers below append synchronously instead. Without this, the host simply
// vanished and the log's last line was an ordinary tick, which tells you nothing
// about why. (Zero crash reports have ever been filed for this bundle, so the
// deaths we have seen were exits and hangs, not signals.)
function logFatalSync(label, err) {
  const line = `${new Date().toISOString()} ${label}: ${err?.stack || err}\n`;
  try {
    appendFileSync(LOG_FILE, line);
  } catch {
    // last resort only - if even this fails there is nowhere left to record it
  }
  try {
    process.stderr.write(line);
  } catch {}
}

// An unhandled rejection TERMINATES the process on modern Node. For a status
// display that is the wrong trade: one stray rejection in a peripheral path
// (a transcript read, a voice child) should not take the screen down with it.
// Log it loudly and keep serving; the watchdog covers the loop itself.
process.on("unhandledRejection", (reason) => {
  logFatalSync("UNHANDLED REJECTION (continuing)", reason);
});

// An uncaught exception leaves the process in an unknown state, so this one does
// exit - but only after recording why, so the supervisor's restart has a cause
// attached to it rather than an unexplained gap in the log.
process.on("uncaughtException", (err) => {
  logFatalSync("UNCAUGHT EXCEPTION (exiting)", err);
  recordRunEnd(`uncaught exception: ${err?.message || err}`);
  process.exit(1);
});

const rawLog = console.log.bind(console);
const rawError = console.error.bind(console);
function writeLog(line) {
  logStream.write(line);
  logBytes += Buffer.byteLength(line);
  rotateLogIfNeeded();
}
console.log = (...args) => {
  writeLog(args.map(String).join(" ") + "\n");
  rawLog(...args);
};
console.error = (...args) => {
  writeLog(args.map(String).join(" ") + "\n");
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
// Token refresh (so an always-on host isn't stuck when the ~8h access token
// expires and no Claude Code surface is running to renew it - the app-only
// case). Same public OAuth client Claude Code uses; we only ever exchange a
// still-valid refresh token, then write the rotated tokens straight back to the
// same keychain item so Claude Code stays in sync. Verified interoperable.
const OAUTH_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_REFRESH_MARGIN_MS = 5 * 60_000; // refresh this long before expiry
// Gentle cadence: the endpoint rate-limits bursty callers (observed HTTP
// 429 after several rapid host restarts), and quota % barely moves in five
// minutes anyway.
const OAUTH_POLL_INTERVAL_MS = 5 * 60_000;
const OAUTH_429_BACKOFF_MS = 15 * 60_000;
// Last successful fetch, persisted so host restarts (one per firmware flash
// during development) neither lose good data nor fire a burst of startup
// polls into the endpoint's rate limiter.
const OAUTH_CACHE_FILE = path.join(RUNTIME_DIR, "oauth-usage.json");

// Written by ~/.claude/deckhand-session-hook.mjs (registered for SessionStart,
// UserPromptSubmit, Stop, SessionEnd). One file per session_id; deleted on
// SessionEnd. This is what powers the SESSIONS tab.
const SESSIONS_DIR = path.join(os.homedir(), ".claude", "deckhand-sessions");
const SESSION_STALE_MS = 20 * 60 * 1000; // 20 min with no update = treat as dead

// Must match Serial.begin() in the firmware exactly - a mismatch yields pure
// garbage, not a degraded link. Stays at 115200: every higher rate silently drops
// bytes on this CH340 (measured 87% at 230400, 81-94% at 460800, unusable at
// 921600). See the note at Serial.begin() in the firmware.
const BAUD_RATE = 115200;
const POLL_INTERVAL_MS = 5000;
// Every child process this host spawns is bounded. An un-timed execFile is the
// same hazard as an un-timed await: it does not throw, it just never returns.
const KEYCHAIN_TIMEOUT_MS = 10_000;   // `security` blocks on a locked keychain
const VOICE_CHILD_TIMEOUT_MS = 180_000; // whisper/mic-wav are slow but not endless
const RECONNECT_INTERVAL_MS = 3000;
// Mirrors REMOTE_WAIT_MS in claude-hooks/deckhand-session-hook.mjs, per agent.
// ADVISORY ONLY - it drives the keyboard's countdown and nothing else. If the
// hook's value ever changes and this is missed, the countdown is wrong and no
// decision is affected. It must never gate whether an answer is sent.
// Mirrors the hook's REMOTE_WAIT_MS per agent, for the keyboard's countdown ONLY -
// it never gates whether an answer is accepted. Claude Code's wait now defaults to
// "forever", read from the same config file the hook reads, so the two cannot drift
// apart by editing one of them. When the wait is effectively unlimited there is
// nothing meaningful to count down to, so `ask.sec` is omitted entirely and the
// device draws no countdown rather than a 24-hour one.
const REMOTE_WAIT_CONFIG = path.join(os.homedir(), ".claude", "deckhand-remote-wait");
function configuredWaitMs() {
  let raw = "";
  try {
    raw = readFileSync(REMOTE_WAIT_CONFIG, "utf8").trim().toLowerCase();
  } catch {
    return null; // no config = the hook's default, which is unlimited
  }
  if (!raw || raw === "forever" || raw === "0") return null;
  const secs = Number.parseFloat(raw);
  if (!Number.isFinite(secs) || secs <= 0) return null;
  return secs * 1000;
}
const HOOK_WAIT_MS = { cc: configuredWaitMs(), cx: 15_000 };

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
//
// The device and the Mac RACE for this: the hook only ever waits on a
// PermissionRequest, whose dialog Claude Code shows concurrently, so both
// surfaces are live and the first answer wins. See the measured note at the top
// of claude-hooks/deckhand-session-hook.mjs for why that event and not the
// PreToolUse one.
const ANSWERS_DIR = path.join(os.homedir(), ".claude", "deckhand-answers");
// Heartbeat the session hook checks before blocking on a remote answer.
const HOST_ALIVE = path.join(RUNTIME_DIR, "host-alive");
// The device's own battery reading, from its BATT line (once a minute). Kept with
// the time it arrived, because that line stops the instant the link drops and a
// reading from an hour ago is not a battery level - the same reason quotaAgeSec
// exists for the OAuth cache.
let lastBatt = null;
// Conservative chunk size that doesn't depend on MTU negotiation succeeding -
// 20 bytes is the default ATT payload before any negotiation, so this works
// even in the worst case.
const BLE_CHUNK_SIZE = 20;

// ---------- Remote-answer authentication (A + B), MULTI-PAIRING ----------
// This Mac remembers MANY devices, each with its OWN secret, so a pairing is the
// couple (this Mac, that device). That isolation is the point: forgetting one
// device revokes only that pair, and a leaked key can't authenticate answers
// coming from any other device.
//
//   { version: 2, hostId, devices: [ { name, secret, label, lastSeen } ], selected }
//
// `hostId` is this Mac's stable identity. It goes to the device on PROVISION and
// rides in every payload, so a device paired with several Macs knows which of
// its stored keys to sign an answer with. v1 files ({ secret, device }) are
// migrated in place on first load, keeping the existing pair working.
const PAIR_FILE = path.join(os.homedir(), ".claude", "deckhand-secret");
const MAX_PAIRED_DEVICES = 8;
let hostId = "";                 // this Mac, e.g. "9f3c1a20"
let hostLabel = os.hostname().replace(/\.local$/, "");
// Short display form for the device's session rows. DECKHAND_MAC_TAG overrides it.
let hostTag = macTag(hostLabel, process.env.DECKHAND_MAC_TAG || "");
const MAC_EMOJI_FILE = path.join(os.homedir(), ".claude", "deckhand-mac-emoji");
// Re-read per tick rather than cached at startup: the menu-bar picker writes this file
// and the change should show on the device within a tick, not at the next restart.
function currentMacEmoji() {
  let file = "";
  try {
    file = readFileSync(MAC_EMOJI_FILE, "utf8");
  } catch {
    // not set
  }
  return resolveMacEmoji({ env: process.env.DECKHAND_MAC_EMOJI || "", file });
}
let pairedDevices = [];          // [{ name, secret, label, lastSeen }]
let selectedDevice = "";         // "" = auto (talk to any remembered device)
let usbDeviceName = "";          // device currently on USB (learned from HELLO)
let bleDeviceName = "";          // device currently on BLE
// May the device DECIDE prompts, not just display them? On by default, because
// it costs the Mac nothing: the hook only ever waits on a PermissionRequest, and
// Claude Code shows that dialog concurrently - so the two surfaces race and the
// first answer wins. Turn it off to make the device a read-only mirror.
// Persisted alongside the pairings; toggled from the menu-bar app.
let remoteAnswer = true;

const deviceEntry = (name) => pairedDevices.find((d) => d.name === name) ?? null;
// A device name is always "Deckhand-XXXX" with XXXX from the eFuse MAC. Validate
// it before it can ever become a pairing: during the baud experiments, corrupted
// HELLO lines (garbled by a mismatched rate) minted junk entries like
// "Deckhand-\ufffd\ufffd\u0002v2", which burn slots in a list capped at
// MAX_PAIRED_DEVICES and would eventually push a real device out.
const VALID_DEVICE_NAME = /^Deckhand-[0-9A-Fa-f]{4}$/;
const isValidDeviceName = (n) => typeof n === "string" && VALID_DEVICE_NAME.test(n);


// The device we're actually talking to on a given transport. Answers are
// verified with THAT device's key, never a blanket one.
// BLE always knows who it connected to. USB learns the name from HELLO, which
// the device only bursts for ~15s after boot - so if we attached mid-run we may
// not have it, and fall back to the device we believe is selected. That's safe:
// if the guess is wrong the HMAC simply fails and the answer is rejected.
function deviceNameFor(via) {
  // A PAIRING LINK HAS NO PAIRED DEVICE, BY CONSTRUCTION. It is opened to
  // create a key, so until PAIRDONE there is none - and falling through to the
  // usb/selected branch would attribute an ANSWER or PROMPT arriving there to
  // whichever Mac-side pairing happened to be current. It fails CLOSED either
  // way (the HMAC is checked against that other device's key, which this peer
  // does not have), but the refusal would then name the wrong subject, and a
  // log line that misnames its subject is the class this repo keeps paying
  // for. "" means "no paired device", which is exactly true here.
  if (via === "pair") return "";
  if (via === "ble") return bleDeviceName;
  return usbDeviceName || selectedDevice;
}

// How a refusal names where the line came from. The pairing link is named as
// such rather than left to read as an unknown ble/usb device, because those are
// different facts: one is a device we could not identify, the other is a link
// that cannot have an identity yet.
function senderDescription(via, from) {
  if (via === "pair")
    return "over the PAIRING link, which is unauthenticated by construction (no key exists until PAIRDONE)";
  return `via ${via}${from ? ` from ${from}` : " (unknown device)"}`;
}

async function loadPairing() {
  let p = null;
  try {
    p = JSON.parse(await fs.readFile(PAIR_FILE, "utf8"));
  } catch {
    // no file yet
  }
  if (p && Array.isArray(p.devices)) {
    hostId = p.hostId ?? "";
    const before = p.devices.length;
    pairedDevices = p.devices.filter((d) => d && d.secret && isValidDeviceName(d.name));
    if (pairedDevices.length !== before)
      console.log(`Auth: dropped ${before - pairedDevices.length} malformed device name(s) from the pairing file.`);
    selectedDevice = p.selected ?? "";
    // Absent (a file written before this flag existed) means ON - the default.
    remoteAnswer = p.remoteAnswer !== false;
  } else if (p && p.secret) {
    // ---- migrate v1: a single { secret, device } becomes one entry ----
    hostId = "";
    pairedDevices = p.device
      ? [{ name: p.device, secret: p.secret, label: "", lastSeen: Date.now() }]
      : [];
    selectedDevice = p.device ?? "";
    console.log(
      `Auth: migrated pairing file to multi-device format${p.device ? ` (kept ${p.device})` : ""}.`
    );
  }
  if (!hostId) {
    hostId = crypto.randomBytes(4).toString("hex");
    console.log(`Auth: this Mac's pairing id is ${hostId} (${hostLabel}).`);
  }
  // A selection pointing at a device we no longer remember is meaningless.
  if (selectedDevice && !deviceEntry(selectedDevice)) selectedDevice = "";
  await savePairing();
}

async function savePairing() {
  const body = {
    version: 2,
    hostId,
    hostLabel,
    devices: pairedDevices,
    selected: selectedDevice,
    remoteAnswer,
  };
  await fs
    .writeFile(PAIR_FILE, JSON.stringify(body, null, 2), { mode: 0o600 })
    .catch((e) => console.error("Auth: could not save pairing file:", e.message));
  // writeFile's `mode` only applies when it CREATES the file, so a pre-existing
  // file (restored from a backup, copied between machines, made by an older
  // build) would keep whatever loose permissions it had. This holds every
  // device's key now, so tighten it every time.
  await fs.chmod(PAIR_FILE, 0o600).catch(() => {});
}

// Find this device's pairing, minting a fresh per-pair key the first time we
// meet it. Only ever called for a device seen over USB, which is the trusted
// link - a BLE peer can't talk us into creating a pairing for itself.
// A `secret` is supplied ONLY by the wireless-pairing path, where both ends
// derived the same key from the exchange rather than the Mac minting one. It
// routes through here rather than pushing its own entry so the MAX_PAIRED_DEVICES
// eviction stays in one place.
async function rememberDevice(name, secret = "") {
  let entry = deviceEntry(name);
  if (!entry) {
    entry = { name, secret: secret || crypto.randomBytes(16).toString("hex"), label: "", lastSeen: 0 };
    pairedDevices.push(entry);
    // Oldest-seen entries fall off the end rather than growing without bound.
    if (pairedDevices.length > MAX_PAIRED_DEVICES) {
      pairedDevices.sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
      const dropped = pairedDevices.splice(MAX_PAIRED_DEVICES);
      for (const d of dropped) console.log(`Auth: forgot ${d.name} (pairing list full).`);
    }
    console.log(
      secret
        ? `Auth: new pairing with ${name} (key derived on both sides, never transmitted).`
        : `Auth: new pairing with ${name} (its own key).`
    );
  } else if (secret && entry.secret !== secret) {
    entry.secret = secret;
    console.log(`Auth: replaced ${name}'s key with the one just derived wirelessly.`);
  }
  entry.lastSeen = Date.now();
  await savePairing();
  return entry;
}

// Per-prompt nonce so an ANSWER can't be replayed and is bound to one
// prompt. Same nonce is sent for a given pid across ticks (the device HMACs
// whatever it last received); pruned once the prompt is long gone.
const askNonces = new Map(); // pid -> { nonce, seen, first }
// A transcript waiting for the human to confirm it on the device. Keyed by the
// ask's pid, so a second dictation for the same prompt simply replaces the
// first. Pruned with the nonces - once a prompt is gone, so is any text for it.
const pendingVoiceAnswers = new Map(); // pid -> { text, sha, at }
// Nonce for a typed MESSAGE to a READY session. askNonces cannot serve this: it is
// keyed by an ask's pid, and a READY session has no pending prompt and therefore no
// pid at all. Keyed by the FULL session id, since the payload's id is truncated to
// 12 characters and the device signs against that shorter form.
const promptNonces = new Map(); // full session id -> { nonce, seen }
function nonceForSession(id) {
  let e = promptNonces.get(id);
  if (!e) {
    e = { nonce: crypto.randomBytes(8).toString("hex"), seen: Date.now() };
    promptNonces.set(id, e);
  } else {
    e.seen = Date.now();
  }
  return e.nonce;
}
// SINGLE USE. A captured frame must not be able to re-run the same instruction, and
// unlike an answer - which the Mac's own dialog would have closed - nothing else
// here would stop a replay.
function consumeSessionNonce(id) {
  promptNonces.delete(id);
}
function nonceForPid(pid) {
  let e = askNonces.get(pid);
  if (!e) {
    // `first` is set ONCE and never rewritten. `seen` cannot serve this purpose:
    // it is refreshed on every tick below so the entry survives pruning, so a
    // countdown derived from it would sit at the full budget forever.
    e = { nonce: crypto.randomBytes(8).toString("hex"), seen: Date.now(), first: Date.now() };
    askNonces.set(pid, e);
  } else {
    e.seen = Date.now();
  }
  return e.nonce;
}
function pruneNonces() {
  const now = Date.now();
  for (const [pid, e] of askNonces) if (now - e.seen > 60_000) askNonces.delete(pid);
  // Same window: a session that stops being READY stops having its nonce refreshed
  // below, so it must not leave a usable credential behind.
  for (const [id, e] of promptNonces) if (now - e.seen > 60_000) promptNonces.delete(id);
  for (const [pid, e] of pendingVoiceAnswers) {
    if (Date.now() - e.at > 5 * 60_000) pendingVoiceAnswers.delete(pid);
  }
}

// Keyed with the secret of the DEVICE that sent the answer, so a device we're
// paired with can only ever authenticate as itself.
function expectedHmac(deviceName, nonce, pid, idx) {
  const entry = deviceEntry(deviceName);
  if (!entry) return "";
  return crypto
    .createHmac("sha256", entry.secret)
    .update(`${nonce}:${pid}:${idx}`)
    .digest("hex")
    .slice(0, 16);
}

async function runCcusage(args) {
  const { stdout } = await execFileAsync(process.execPath, [CCUSAGE_JS, ...args, "--json"], {
    maxBuffer: 10 * 1024 * 1024,
    // This runs on EVERY tick, so an un-timed hang here stalls the whole poll
    // loop - the same failure class as the BLE write, just with a child process
    // instead of a callback. execFile's timeout also kills the child, so a slow
    // ccusage cannot accumulate orphans one per tick.
    timeout: CCUSAGE_TIMEOUT_MS,
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
// Codex usage refresh. Codex has no endpoint to poll, so a stale figure can only be
// refreshed by making Codex CLI actually run - see codex-refresh.mjs for why that is a
// guarded, quota-spending decision. Both stamps are PERSISTED for the same reason the
// OAuth poller's are: this host restarts often, and an in-memory guard would let every
// restart spend another turn.
const CODEX_ATTEMPT_STATE = path.join(RUNTIME_DIR, "codex-refresh-attempt.json");
const CODEX_BACKOFF_STATE = path.join(RUNTIME_DIR, "codex-refresh-backoff.json");
// Absolute, and overridable. NOT a bare "codex": launchd gives this process a minimal
// PATH, which is exactly how ccusage's `#!/usr/bin/env node` shebang failed invisibly -
// env: node: No such file or directory every tick, with the device stuck on "waiting
// for the first update" while everything else looked healthy.
const CODEX_BIN = process.env.CODEX_BIN || path.join(os.homedir(), ".local", "bin", "codex");
// The refresh turn runs here so its rollout can be recognised and skipped: it is a real
// Codex thread, and without this it would appear on the device as a session nobody
// started, for up to SESSION_STALE_MS.
const CODEX_REFRESH_CWD = path.join(RUNTIME_DIR, "codex-refresh");
// Codex records the RESOLVED cwd, and on macOS /tmp is a symlink to /private/tmp - so
// the rollout says /private/tmp/deckhand-501/codex-refresh while RUNTIME_DIR says
// /tmp/... and a string compare misses. Found exactly that way: the phantom session row
// this skip exists to prevent appeared anyway, complete with a typed-message nonce.
// Resolved lazily and cached, because the directory does not exist until the first
// refresh creates it (realpath throws on a missing path).
let codexRefreshCwdReal = null;
function isCodexRefreshCwd(cwd) {
  if (!cwd) return false;
  if (cwd === CODEX_REFRESH_CWD) return true;
  if (codexRefreshCwdReal === null) {
    try {
      codexRefreshCwdReal = realpathSync(CODEX_REFRESH_CWD);
    } catch {
      return false; // not created yet: nothing of ours can have produced this rollout
    }
  }
  return cwd === codexRefreshCwdReal;
}
const CODEX_REFRESH_ENABLED = (process.env.DECKHAND_CODEX_REFRESH || "on").toLowerCase() !== "off";
const CODEX_LOGIN_TIMEOUT_MS = 15_000; // `codex login status` makes no model call
const CODEX_REFRESH_TIMEOUT_MS = 120_000; // one tiny turn; bounded like every child here

const OAUTH_BACKOFF_STATE = path.join(RUNTIME_DIR, "oauth-backoff.json");
// Last poll ATTEMPT (success OR failure), persisted across restarts. The
// back-off file only exists after a 429; this bounds every network hit to at
// most one per poll interval regardless of how many times the host restarts,
// so a burst of dev reflashes can't escalate the endpoint's rate limiter.
const OAUTH_ATTEMPT_STATE = path.join(RUNTIME_DIR, "oauth-attempt.json");

async function readOauthCredential() {
  // `security` blocks indefinitely on a locked keychain or an auth prompt, so
  // every call to it is bounded - an unbounded one stalls the OAuth chain.
  const { stdout } = await execFileAsync("security", [
    "find-generic-password",
    "-s",
    OAUTH_KEYCHAIN_SERVICE,
    "-w",
  ], { timeout: KEYCHAIN_TIMEOUT_MS });
  return JSON.parse(stdout);
}

// Exchange the (still-valid) refresh token for a fresh access token and write
// the rotated tokens back into the SAME keychain item in place, preserving
// every other field Claude Code stored. Only ever called when the access token
// is expired/near-expiry; refuses if the refresh token itself is expired (that
// needs a real re-login, and we must not hammer the token endpoint).
async function refreshOauthToken(cred, retried = false) {
  const o = cred.claudeAiOauth;
  if (!o?.refreshToken) throw new Error("no refresh token in Keychain");
  const triedToken = o.refreshToken;
  // Deliberately NOT pre-rejecting on refreshTokenExpiresAt. That timestamp
  // goes stale: the endpoint rotates the refresh token without always restating
  // its lifetime, so the value we hold can describe a token we no longer have.
  // Refusing on it stranded a perfectly good credential ("refresh token expired"
  // while Claude Code itself was working fine). The server is authoritative -
  // ask it, and treat only its rejection as a real logout.

  const resp = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: o.refreshToken,
      client_id: OAUTH_CLIENT_ID,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    // 400/401 from the token endpoint is the server saying this grant is dead
    // (invalid_grant) - that IS a real re-login, unlike a 5xx or a timeout.
    let detail = "";
    try {
      const e = await resp.json();
      detail = e.error || e.error_description || "";
    } catch {}
    if (resp.status === 400 || resp.status === 401) {
      // Refresh tokens ROTATE, and Claude Code itself refreshes the same one we
      // do - so "invalid_grant" often just means it beat us to it and our copy
      // is one generation stale. Re-read the keychain: if the stored token has
      // moved on, retry once with the current one instead of declaring a
      // logout. Only a genuinely dead grant should ask the user to sign in.
      if (!retried) {
        const fresh = await readOauthCredential().catch(() => null);
        const newTok = fresh?.claudeAiOauth?.refreshToken;
        if (newTok && newTok !== triedToken) {
          console.log("OAuth: refresh token had been rotated elsewhere - retrying with the current one.");
          return refreshOauthToken(fresh, true);
        }
      }
      throw new Error(
        `refresh rejected${detail ? ` (${detail})` : ""} - sign in to Claude Code again`
      );
    }
    throw new Error(`token refresh HTTP ${resp.status}`);
  }
  const d = await resp.json();
  if (!d.access_token) throw new Error("refresh response missing access_token");

  const now = Date.now();
  o.accessToken = d.access_token;
  if (d.expires_in) o.expiresAt = now + d.expires_in * 1000;
  if (d.refresh_token) {
    o.refreshToken = d.refresh_token; // rotates - MUST persist
    // New token, and the response didn't say how long it lives: drop the old
    // expiry instead of carrying it forward, or it ends up describing the
    // token we just replaced (which is what stranded us in the first place).
    if (d.refresh_token_expires_in) o.refreshTokenExpiresAt = now + d.refresh_token_expires_in * 1000;
    else delete o.refreshTokenExpiresAt;
  } else if (d.refresh_token_expires_in) {
    o.refreshTokenExpiresAt = now + d.refresh_token_expires_in * 1000;
  }

  // Update the keychain item in place (-U), matched by its own account + service.
  // Value passed as a direct argv (no shell) so the token bytes aren't mangled.
  const meta = (await execFileAsync("security", ["find-generic-password", "-s", OAUTH_KEYCHAIN_SERVICE],
    { timeout: KEYCHAIN_TIMEOUT_MS })).stdout;
  const acct = (meta.match(/"acct"<blob>="([^"]*)"/) || [])[1];
  if (!acct) throw new Error("could not read keychain account");
  await execFileAsync("security", [
    "add-generic-password", "-U", "-a", acct, "-s", OAUTH_KEYCHAIN_SERVICE, "-w", JSON.stringify(cred),
  ], { timeout: KEYCHAIN_TIMEOUT_MS });
  console.log(`OAuth: refreshed access token (valid ${(d.expires_in / 3600).toFixed(1)}h), rotated tokens persisted.`);
  return o.accessToken;
}

// A currently-valid access token, refreshing proactively if it's expired or
// within the margin. Returns { token, cred } so a 401 can trigger one reactive
// retry without re-reading.
async function getFreshAccessToken() {
  const cred = await readOauthCredential();
  const o = cred.claudeAiOauth;
  if (!o?.accessToken) throw new Error("no OAuth token in Keychain");
  if (!o.expiresAt || o.expiresAt < Date.now() + OAUTH_REFRESH_MARGIN_MS) {
    return { token: await refreshOauthToken(cred), cred, refreshed: true };
  }
  return { token: o.accessToken, cred, refreshed: false };
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

    // Minimum spacing between network hits, enforced across restarts. Each
    // restart is a fresh process that would otherwise poll immediately with a
    // stale cache; persisting the last ATTEMPT time (not just successes) keeps
    // a burst of reflashes to one hit per interval, so we never escalate the
    // limiter. Cheap files, so this is belt-and-suspenders with the back-off.
    try {
      const { at } = JSON.parse(await fs.readFile(OAUTH_ATTEMPT_STATE, "utf8"));
      const sinceAttempt = Date.now() - at;
      if (sinceAttempt >= 0 && sinceAttempt < OAUTH_POLL_INTERVAL_MS) {
        setTimeout(pollOauthUsage, OAUTH_POLL_INTERVAL_MS - sinceAttempt);
        return;
      }
    } catch {
      // no attempt record, proceed
    }

    // Read the token fresh on every poll (cheap at this cadence). Claude Code
    // rotates it; holding a cached copy once pinned the poller in a rate-limit
    // loop while the Keychain already had a good token. Refresh proactively if
    // it's expired/near-expiry so an always-on host survives the app being shut.
    const { token, cred, refreshed } = await getFreshAccessToken();

    // Record the attempt BEFORE the network call so a failure (429, timeout)
    // still counts against the spacing above - otherwise a failing endpoint
    // would let every restart retry immediately.
    await fs.writeFile(OAUTH_ATTEMPT_STATE, JSON.stringify({ at: Date.now() })).catch(() => {});

    let resp = await fetchOauthUsage(token);
    // A 401 with a token we didn't just refresh means it was rejected anyway
    // (revoked/rotated elsewhere) - refresh once and retry, never in a loop.
    if (resp.status === 401 && !refreshed) {
      console.error("OAuth usage: 401 on a non-expired token, refreshing once and retrying");
      resp = await fetchOauthUsage(await refreshOauthToken(cred));
    }
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

// Two facts, ONE tail read. Claude Code doesn't hand the model to most hook events
// (desktop-app sessions never see it at all), and it doesn't hand over the session title
// at all - but the transcript records both: every assistant message carries its model,
// and Claude Code writes `ai-title` records (plus `custom-title` if you named the session
// yourself). Reading the file twice would double the I/O for every session on every 5s
// tick, so both come out of the same 64KB window.
//
// Taking the LAST occurrence of each matters: it tracks a mid-session /model switch and a
// retitled session, which a SessionStart-time snapshot would not.
const RE_MODEL = /"model":"(claude-[a-z0-9.-]+)"/g;
const RE_AI_TITLE = /"aiTitle":"((?:[^"\\]|\\.)*)"/g;
const RE_CUSTOM_TITLE = /"customTitle":"((?:[^"\\]|\\.)*)"/g;
// What you last asked this session, verbatim. Claude Code writes a `last-prompt` record
// for it, which is the most informative single line about what a session is actually
// doing - far better than model+branch for "which one was this again?".
const RE_LAST_PROMPT = /"lastPrompt":"((?:[^"\\]|\\.)*)"/g;

// Seconds since LOCAL midnight, which is the device's own clock format (it ticks
// hostSecondsSinceMidnight forward with millis() between polls). Deliberately not an
// epoch: `long` on ESP32 is 32-bit and a millisecond epoch overflows it - the bug that
// silently broke the voice card. Returns -1 when the moment isn't today, so the device
// can say "earlier" instead of printing a time from a different day as if it were now.
function secondsSinceMidnight(ms) {
  if (!ms) return -1;
  const d = new Date(ms), now = new Date();
  if (d.toDateString() !== now.toDateString()) return -1;
  return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
}

function lastMatch(re, text) {
  re.lastIndex = 0; // shared global regex - a stale lastIndex would skip the start
  let m, last = "";
  while ((m = re.exec(text)) !== null) last = m[1];
  return last;
}

// The captured group is still JSON-escaped, and the device's font renders control bytes
// as garbage, so unescape then flatten to a single line.
function cleanTitle(raw) {
  if (!raw) return "";
  let s = raw;
  try {
    s = JSON.parse(`"${raw}"`);
  } catch {
    // keep the raw text rather than losing the title over one odd escape
  }
  return s.replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim();
}

async function transcriptInfo(transcriptPath) {
  const out = { model: "", title: "", prompt: "", startedMs: 0 };
  if (!transcriptPath) return out;
  try {
    const fh = await fs.open(transcriptPath, "r");
    try {
      const st = await fh.stat();
      const { size } = st;
      // When the session began. Taken from the transcript's birthtime rather than adding
      // a field to the hook: a hook change would need reinstalling into ~/.claude before
      // it did anything, and this stat is already paid for.
      out.startedMs = st.birthtimeMs || st.ctimeMs || 0;
      const len = Math.min(size, 64 * 1024);
      if (len === 0) return out;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, size - len);
      // The window can slice a line in half; that's harmless here because every regex
      // needs its closing quote, so a truncated record simply doesn't match.
      const text = buf.toString("utf8");
      const model = lastMatch(RE_MODEL, text);
      if (model) out.model = model.replace(/-\d{8}$/, ""); // drop dated suffixes
      // A title you set yourself outranks a generated one.
      out.title = cleanTitle(lastMatch(RE_CUSTOM_TITLE, text) || lastMatch(RE_AI_TITLE, text));
      out.prompt = cleanTitle(lastMatch(RE_LAST_PROMPT, text));
      return out;
    } finally {
      await fh.close();
    }
  } catch {
    return out; // transcript missing/unreadable - fall back to the hook's values
  }
}

// The PROJECT name, not the current directory's name. The hook rewrites `cwd` on
// every event with Claude Code's live working directory, so a `cd` into a
// subdirectory renamed the session on the device mid-task ("core" became "host").
// The git repo ROOT is stable across any `cd` within the repo and is what a person
// means by "the project", so use that and fall back to the raw cwd outside a repo.
//
// Cached by cwd: this runs per session per 5s tick, and spawning git that often for
// an answer that never changes is waste.
const repoRootCache = new Map();
async function projectName(cwd) {
  if (!cwd) return "unknown";
  if (repoRootCache.has(cwd)) return repoRootCache.get(cwd);
  let name = path.basename(cwd) || "unknown";
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      timeout: 1000,
    });
    const root = stdout.trim();
    if (root) name = path.basename(root);
  } catch {
    // not a git repo (or no git) - the directory name is the best we have
  }
  repoRootCache.set(cwd, name);
  return name;
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

// ---------- Codex sessions + usage ----------
// Codex has no hook mechanism, so nothing can push state at us the way
// deckhand-session-hook.mjs does for Claude Code. What it does have is a rollout
// JSONL per thread, appended live, plus a cheap index of threads. So this half is
// PULL, not push, and everything below is derived by reading those files.
//
// Where the facts come from (verified against real rollouts on this machine):
//   sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl - the file's MTIME is the activity
//   time; see codexRolloutFiles for why session_index.jsonl is NOT used:
//     session_meta   (first record)  -> cwd, originator, thread_source
//     turn_context   (once per turn) -> cwd, model
//     event_msg task_started/task_complete -> working vs idle
//     event_msg token_count -> .rate_limits, which is the usage number
const CODEX_DIR = path.join(os.homedir(), ".codex");
const CODEX_SESSIONS_DIR = path.join(CODEX_DIR, "sessions");

// Discovery walks the rollout files and uses each file's MTIME as the activity time.
// It deliberately does NOT use session_index.jsonl, even though that file exists and
// looks like exactly the right index: Codex appends to a rollout LIVE but only
// rewrites the index later, so a thread being actively used reads as 26 minutes idle
// in the index while its rollout was touched 1 minute ago. Keying freshness off the
// index made an in-progress Codex session invisible on the device - the first thing
// that went wrong in real use.
// Walking is cheap (one directory per day, a couple of dozen files after months of
// use) so it happens every tick rather than being cached into staleness. An earlier
// version cached id->path lookups INCLUDING misses, which permanently hid any thread
// whose rollout did not exist yet at first look.
async function codexRolloutFiles() {
  const out = [];
  const stack = [CODEX_SESSIONS_DIR];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) {
        // rollout-<ISO timestamp>-<uuid>.jsonl - the id is the trailing uuid
        const stem = e.name.slice("rollout-".length, -".jsonl".length);
        const id = stem.slice(-36);
        try {
          const st = await fs.stat(full);
          out.push({ id, file: full, mtimeMs: st.mtimeMs });
        } catch {
          /* vanished between readdir and stat */
        }
      }
    }
  }
  return out;
}

// HEAD **and** TAIL, not the whole file: session_meta is the FIRST record (cwd,
// thread_source) while status and rate_limits are in the LAST ones, and a long thread's
// rollout runs to megabytes. Two windows keep this O(1) per thread. A window can slice
// a line in half, so every line is parsed defensively.
const CODEX_READ_BYTES = 65536;
async function readCodexRollout(file) {
  let fh;
  try {
    fh = await fs.open(file, "r");
    const { size } = await fh.stat();
    const bufs = [];
    const head = Buffer.alloc(Math.min(CODEX_READ_BYTES, size));
    await fh.read(head, 0, head.length, 0);
    bufs.push(head);
    if (size > CODEX_READ_BYTES) {
      const tailLen = Math.min(CODEX_READ_BYTES, size - CODEX_READ_BYTES);
      const tail = Buffer.alloc(tailLen);
      await fh.read(tail, 0, tailLen, size - tailLen);
      bufs.push(tail);
    }
    const out = {};
    for (const buf of bufs) {
      for (const line of buf.toString("utf8").split("\n")) {
        if (!line.startsWith("{")) continue;
        let d;
        try {
          d = JSON.parse(line);
        } catch {
          continue; // a partial line at a window edge, or a write in flight
        }
        const p = d.payload && typeof d.payload === "object" ? d.payload : {};
        if (d.type === "session_meta") {
          out.cwd = p.cwd || out.cwd;
          out.threadSource = p.thread_source || out.threadSource;
        } else if (d.type === "turn_context") {
          if (p.cwd) out.cwd = p.cwd; // later turns win: this is the LIVE cwd
          if (p.model) out.model = p.model;
        } else if (d.type === "event_msg") {
          if (p.type === "task_started" || p.type === "task_complete" || p.type === "turn_aborted") {
            out.lastTask = p.type;
          }
          if (p.type === "token_count" && p.rate_limits) out.rateLimits = p.rate_limits;
        }
      }
    }
    return out;
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

// Latest rate_limits seen from any Codex thread. Kept across ticks because a thread
// that has gone quiet still holds the newest number we ever saw - and unlike the
// Claude side there is no endpoint to ask, so the rollouts are the only source.
let codexRateLimits = null;

async function readCodexSessions() {
  let files;
  try {
    files = await codexRolloutFiles();
  } catch {
    return []; // Codex not installed, or it has never run
  }

  const out = [];
  for (const f of files) {
    const roll = await readCodexRollout(f.file);
    if (!roll) continue;
    if (roll.rateLimits && (!codexRateLimits || f.mtimeMs >= codexRateLimits.at)) {
      codexRateLimits = { ...roll.rateLimits, at: f.mtimeMs };
    }
    if (Date.now() - f.mtimeMs > SESSION_STALE_MS) continue;
    // Subagent threads are Codex talking to itself (auto-review, guardian). They are
    // not something a person is waiting on, and they would crowd the 6-row list.
    if (roll.threadSource && roll.threadSource !== "user") continue;
    // Our own usage-refresh turn is a real Codex thread with thread_source "user", so
    // nothing above excludes it. Left in, it would show on the device as a session
    // nobody started, for up to SESSION_STALE_MS, and could push a real one off the
    // 6-row list. Its rate_limits are still harvested above - that is the entire point
    // of running it; only the session ROW is suppressed.
    if (isCodexRefreshCwd(roll.cwd)) continue;
    out.push({
      id: f.id.slice(0, 12),
      cwd: roll.cwd || "",
      // No "asking": Codex writes no approval event to the rollout, so the device can
      // only ever show a Codex thread as working or waiting. Saying so matters - this
      // display exists to show who needs input.
      status: roll.lastTask === "task_started" ? "working" : "waiting",
      model: roll.model || "",
      updated_at: f.mtimeMs,
      agent: "codex",
    });
  }
  return out;
}

// ---------- Refreshing the Codex figure ----------
// Reading Codex usage is passive: the host scrapes `token_count.rate_limits` out of
// whatever rollout Codex CLI last wrote. If you only use the ChatGPT app, Codex CLI
// never runs, nothing is ever written, and the figure freezes - observed here at ~24h
// stale, showing a percentage for a 7-day window that had already reset.
//
// The only way to refresh it is to make Codex CLI take a real turn, which spends a
// little of the very quota being measured. Every guard below exists to bound that:
// preconditions are checked cheapest-first and short-circuit, the attempt stamp is
// written BEFORE the spawn (so a crash mid-turn still counts as an attempt), and a
// failure backs off for hours rather than retrying on the next 5s tick.
async function readStamp(file) {
  try {
    const { at } = JSON.parse(await fs.readFile(file, "utf8"));
    return Number.isFinite(at) ? at : 0;
  } catch {
    return 0; // absent or corrupt: shouldRefreshCodex() decides what that means
  }
}

async function maybeRefreshCodexUsage() {
  const ageSec = codexRateLimits?.at
    ? Math.round((Date.now() - codexRateLimits.at) / 1000)
    : null;
  const [lastAttemptMs, backoffUntilMs] = await Promise.all([
    readStamp(CODEX_ATTEMPT_STATE),
    readStamp(CODEX_BACKOFF_STATE),
  ]);
  if (
    !shouldRefreshCodex({
      ageSec,
      lastAttemptMs,
      backoffUntilMs,
      now: Date.now(),
      enabled: CODEX_REFRESH_ENABLED,
    })
  ) {
    return;
  }

  // Cheapest precondition first: is Codex even here? An absent binary is the common
  // case (this feature must cost nothing on a machine without Codex), so it is checked
  // before anything that spawns.
  try {
    await fs.access(CODEX_BIN);
  } catch {
    await noteCodexAttempt("codex CLI not found");
    return;
  }

  // Then: logged in? This makes NO model call, so it costs no quota - which is what
  // makes it worth doing before the turn rather than discovering it from a failure.
  try {
    const { stdout } = await execFileAsync(CODEX_BIN, ["login", "status"], {
      timeout: CODEX_LOGIN_TIMEOUT_MS,
    });
    if (!/logged in/i.test(stdout)) {
      await noteCodexAttempt(`not logged in (${stdout.trim().slice(0, 60)})`);
      return;
    }
  } catch (err) {
    await noteCodexAttempt(`login status failed: ${err.message}`);
    return;
  }

  // Stamp the attempt BEFORE spending anything. If this process dies mid-turn, the
  // attempt still counts - otherwise a crash loop would spend a turn per restart.
  await fs.writeFile(CODEX_ATTEMPT_STATE, JSON.stringify({ at: Date.now() })).catch(() => {});
  try {
    await fs.mkdir(CODEX_REFRESH_CWD, { recursive: true });
    // --sandbox read-only: `codex exec` forces bypassPermissions on APPROVALS (measured,
    // and documented in CLAUDE.md), so the sandbox policy is the only thing left
    // constraining a model-generated command. This turn runs unattended, so it gets the
    // most restrictive policy that still completes.
    // --skip-git-repo-check: the scratch cwd is deliberately not a repo.
    // The prompt is chosen to give the model nothing to do but answer.
    await execFileAsync(
      CODEX_BIN,
      ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "reply with the single word: ok"],
      { cwd: CODEX_REFRESH_CWD, timeout: CODEX_REFRESH_TIMEOUT_MS, maxBuffer: 1024 * 1024 }
    );
    console.log(`Codex: refreshed usage (previous reading ${ageSec == null ? "none" : `${ageSec}s old`}).`);
  } catch (err) {
    await noteCodexAttempt(`refresh turn failed: ${err.message}`);
  }
}

// A failure backs off for hours. Without this a machine that is logged out, rate
// limited, or offline would spawn a child every 5s forever.
async function noteCodexAttempt(why) {
  console.log(`Codex: usage refresh skipped - ${why} (backing off ${Math.round(CODEX_BACKOFF_MS / 3600_000)}h).`);
  await fs
    .writeFile(CODEX_ATTEMPT_STATE, JSON.stringify({ at: Date.now() }))
    .catch(() => {});
  await fs
    .writeFile(CODEX_BACKOFF_STATE, JSON.stringify({ at: Date.now() + CODEX_BACKOFF_MS }))
    .catch(() => {});
}

// Codex reports ONE window in `primary` (10080 minutes = 7 days on this plan);
// `secondary` is null here but is passed through if a plan ever populates it.
function codexUsage() {
  const rl = codexRateLimits;
  if (!rl) return {};
  const win = (w) =>
    w && typeof w.used_percent === "number"
      ? {
          pct: Math.round(w.used_percent),
          resetInMin: w.resets_at ? Math.max(0, Math.round((w.resets_at * 1000 - Date.now()) / 60000)) : null,
          windowMin: w.window_minutes ?? null,
        }
      : null;
  // A window that has already reset describes a period that no longer exists, so its
  // percentage is not a reading of anything current. The device shows "--" for a figure
  // it has never measured; this belongs on the same side of that line. Observed live: a
  // 5% figure whose resets_at had passed ~21h earlier, still drawn as 5%.
  const primary = windowExpired(rl.primary, Date.now()) ? null : win(rl.primary);
  const secondary = windowExpired(rl.secondary, Date.now()) ? null : win(rl.secondary);
  return {
    cxPct: primary?.pct ?? null,
    cxResetMin: primary?.resetInMin ?? null,
    cxWin: primary?.windowMin ?? null,
    cxPct2: secondary?.pct ?? null,
    cxResetMin2: secondary?.resetInMin ?? null,
    cxPlan: rl.plan_type || null,
    // Same reason the Claude quota carries quotaAgeSec: a number read out of a file
    // that stopped being written is not a live reading, and the device dims it.
    cxAgeSec: rl.at ? Math.round((Date.now() - rl.at) / 1000) : null,
  };
}

// ---------- Session history (on demand) ----------
// The device asks for this when you open a session's detail screen; it is NOT part of
// the 5s payload. A transcript runs to thousands of lines and megabytes, so pushing any
// of it every tick would be waste - and the device's line buffer is already sized for
// asks carrying 1400-char details.
//
// Everything comes from Claude Code's own transcript JSONL, whose path the hook gives us
// per session. What each entry becomes on screen:
//   user    (string or [text])   -> "you"    what you typed
//   assistant [text]             -> "claude" what it said
//   assistant [tool_use]         -> "ran"    tool name + a one-line summary of the input
//   user    [tool_result]        -> "out"    the result, or "no" when is_error
//   [thinking] and the meta types (last-prompt, mode, ai-title, ...) are dropped: they
//   are not what a person is trying to catch up on.
// A DENIED permission and a CHOSEN option both arrive as tool_results, which is how
// "what I chose" shows up without needing a separate channel.
// Paged from HERE, not shipped as a window. Measured on a real transcript: 2515 entries,
// 584KB at full text length, of which the conversation alone is 122KB - and the device has
// ~94KB of free heap after the BLE stack. So no buffer on the device can ever hold a
// session's history. Instead the Mac holds all of it and serves ONE SCREEN at a time; the
// device stores only what it is displaying. History length is then unbounded, and every
// transfer stays small enough to be instant over USB and tolerable over BLE.
//
// Everything comes from Claude Code's own transcript JSONL, whose path the hook records per
// session: `user`->`you`, `assistant [text]`->`claude`, `[tool_use]`->`ran` (tool name plus
// the one interesting field, never a JSON dump), `[tool_result]`->`out`, or `no` when
// is_error. `[thinking]` and the meta record types are dropped - they are not what a person
// is catching up on. A DENIED permission and a CHOSEN option both arrive as tool_results,
// which is how "what I chose" appears without needing a separate channel.
// Two lengths, because the reader has two levels. The LIST shows a preview so a screen
// holds several entries; opening one fetches it WHOLE. A single cap can't serve both - at
// 600 the list was sparse and long messages were still cut mid-sentence.
const HIST_PREVIEW_CAP = 300;
const HIST_FULL_CAP = 4000;   // matches the device's full-entry buffer
// DEFAULTS ONLY. These two used to be the whole answer, and they are board 1's:
// Cozette 6px across a 216px text column is 36 characters, and its list holds 16
// rows. A device with a bigger reader (board 2: 296px = 49 columns, 23 rows) would
// have been paginated to board 1's numbers and arrived about half full, with
// nothing on either side reporting an error - the bigger reader would just have
// looked like it held less. So the DEVICE now reports its own budget as a trailing
// `<cols>x<lines>` token on the HISTORY request and these are the fallback for a
// request that carries none. Board 1 deliberately sends no token (it would change
// a binary this port holds byte-identical) and pins these numbers with a
// static_assert instead - see requestHistory() in firmware/.../reader.ino.
const HIST_LINE_CHARS = 36;   // Cozette 6px across board 1's 216px text column
const HIST_PAGE_LINES = 16;   // rows in board 1's list; the device reports its own
// The device reports the rows it can DRAW; the slack is the host's own, because it
// is the host's estimate that is loose - `ceil(len / cols)` is a character count,
// where the device word-wraps, so a page laid out to the exact row count
// overflows. Applied here rather than shaved off device-side for that reason: it
// belongs to whoever owns the approximation.
const HIST_PAGE_SLACK = 2;

// Parses the trailing budget token from a HISTORY request. Defensive on purpose:
// this is device-authored text, and a malformed value must fall back to board 1's
// numbers rather than throw inside handleDeviceLine or - worse - produce a 0-line
// page budget, which would make histPaginate emit one page per entry. Bounds are
// sanity rails, not policy: 8 columns is narrower than any panel that could draw a
// word, and 400x200 is far past any panel this firmware runs on.
function histBudget(token) {
  const m = /^(\d{1,4})x(\d{1,4})$/.exec(String(token ?? ""));
  if (!m) return { cols: HIST_LINE_CHARS, lines: HIST_PAGE_LINES };
  const cols = Number.parseInt(m[1], 10);
  const lines = Number.parseInt(m[2], 10);
  if (cols < 8 || cols > 400 || lines < 4 || lines > 200) {
    return { cols: HIST_LINE_CHARS, lines: HIST_PAGE_LINES };
  }
  return { cols, lines };
}

function histFlatten(v, max = HIST_PREVIEW_CAP) {
  // toAscii first: this is transcript text, the most non-ASCII source in the
  // system, and the reader's page budget is char-counted while the device's line
  // guard counts bytes. It also fixes the marker below - it used to be U+2026,
  // which is outside both fonts' 0x20..0x7E range and so drew as NOTHING, giving
  // a truncated preview no visible sign that anything was missing.
  const t = toAscii(v)
    .replace(/[\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? t.slice(0, max - 3) + "..." : t;
}

// One line that says what a tool call actually did. The interesting field differs per tool,
// and a raw JSON dump of the input is unreadable at 240px.
function histToolSummary(name, input, max = HIST_PREVIEW_CAP) {
  const i = input && typeof input === "object" ? input : {};
  const first =
    i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.query ?? i.url ?? i.prompt ?? "";
  return histFlatten(first ? `${name}: ${first}` : name, max);
}

// session id -> transcript path, learned while building each payload (the hook puts the path
// in the session record; the device only ever sends us the id).
const transcriptById = new Map();
// id -> { mtimeMs, items } so a transcript is parsed once per version, not once per page
// turn. Paging through 300 screens must not re-read a megabyte each time.
// BOUNDED, because a parsed transcript is big: a real one is 2500 entries / ~600KB of
// strings, and this process runs for days. Only one session's history is ever on screen,
// so keeping the 2 most recently used is plenty and caps the cost at ~1.2MB instead of
// growing by another transcript for every session ever opened.
const HIST_CACHE_MAX = 2;
const histCache = new Map();

async function histItems(id) {
  const transcript = transcriptById.get(id);
  if (!transcript) return [];
  let st;
  try {
    st = await fs.stat(transcript);
  } catch {
    return [];
  }
  const hit = histCache.get(id);
  if (hit && hit.mtimeMs === st.mtimeMs) {
    histCache.delete(id);
    histCache.set(id, hit);   // touch: most recently used goes last
    return hit.items;
  }

  let text;
  try {
    text = await fs.readFile(transcript, "utf8"); // whole file: paging needs all of it
  } catch {
    return [];
  }
  const items = [];
  // Each entry keeps its preview AND its full text. The full text is never sent with a
  // page - only when that entry is opened - so the list stays small.
  const push = (r, t) => {
    if (t) items.push({ r, t: histFlatten(t, HIST_PREVIEW_CAP), full: histFlatten(t, HIST_FULL_CAP) });
  };
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.type !== "user" && d.type !== "assistant") continue;
    const c = d.message?.content;
    if (typeof c === "string") {
      push("you", c);
      continue;
    }
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text") push(d.type === "user" ? "you" : "claude", b.text);
      else if (b.type === "image") push("you", "(image)");
      else if (b.type === "tool_use") push("ran", histToolSummary(b.name, b.input, HIST_FULL_CAP));
      else if (b.type === "tool_result") {
        const body = Array.isArray(b.content)
          ? b.content.map((x) => (typeof x === "string" ? x : x?.text ?? "")).join(" ")
          : b.content;
        push(b.is_error ? "no" : "out", body);
      }
      // thinking: deliberately dropped
    }
  }
  histCache.delete(id); // re-insert so Map iteration order is least-recently-used first
  histCache.set(id, { mtimeMs: st.mtimeMs, items });
  while (histCache.size > HIST_CACHE_MAX) histCache.delete(histCache.keys().next().value);
  return items;
}

// Page boundaries for one filter, computed the way the device lays the screen out: each
// entry costs a label line plus its wrapped text, and an entry is never split across a page
// because that makes it unreadable.
function histPaginate(items, budget = { cols: HIST_LINE_CHARS, lines: HIST_PAGE_LINES }) {
  const pages = [];
  const cols = budget.cols;
  // Never below 2: one entry always costs a label row plus at least one text row,
  // and a budget under that would put every entry on its own page.
  const perPage = Math.max(2, budget.lines - HIST_PAGE_SLACK);
  let used = 0;
  items.forEach((it, i) => {
    const lines = 1 + Math.max(1, Math.ceil(it.t.length / cols));
    if (used === 0 || used + lines > perPage) {
      pages.push(i);
      used = lines;
    } else {
      used += lines;
    }
  });
  if (!pages.length) pages.push(0);
  return pages;
}

// `HISTORY <id> <chat|all> item:<n>` - one entry, WHOLE. This is the second level of the
// reader: the list shows previews, and opening a row fetches all of it. Without this a
// message longer than the screen was simply unreachable.
async function sendHistoryItem(id, filter, index) {
  const all = await histItems(id);
  const chatOnly = filter !== "all";
  const items = chatOnly ? all.filter((x) => x.r === "you" || x.r === "claude") : all;
  const it = items[index];
  const line =
    JSON.stringify({ hist: { id, full: { i: index, r: it ? it.r : "out", t: it ? it.full : "" } } }) + "\n";
  if (usbPort) usbPort.write(line);
  else if (bleCharacteristic) await sendOverBle(line);
  console.log(`History: ${id} entry ${index} in full (${line.length} bytes)`);
}

// `HISTORY <id> <chat|all> <page|last>`. Replies with just that page plus the page count,
// so the device can show "12/340" and scrub without ever holding the whole thing.
async function sendHistory(id, filter, want, budget) {
  const all = await histItems(id);
  const chatOnly = filter !== "all";
  const items = chatOnly ? all.filter((x) => x.r === "you" || x.r === "claude") : all;
  const bounds = histPaginate(items, budget);
  const pages = bounds.length;
  let page = want === "last" ? pages - 1 : Number.parseInt(want, 10);
  if (!Number.isFinite(page)) page = pages - 1;
  page = Math.max(0, Math.min(pages - 1, page));
  const from = bounds[page];
  const to = page + 1 < pages ? bounds[page + 1] : items.length;
  const line =
    JSON.stringify({
      hist: {
        id,
        f: chatOnly ? "chat" : "all",
        page,
        pages,
        from,                       // global index of the first row, for "open this entry"
        total: items.length,
        items: items.slice(from, to).map((x) => ({ r: x.r, t: x.t })),   // previews only
      },
    }) + "\n";
  // USB when USB is up, BLE only as a fallback - never both. BLE writes go out in 20-byte
  // chunks with a response awaited on each, so at the 30ms connection interval macOS
  // negotiates even a few KB is seconds, with the tick loop blocked behind it. Both
  // transports reach the same device, so USB simply wins.
  if (usbPort) usbPort.write(line);
  else if (bleCharacteristic) await sendOverBle(line);
  console.log(
    `History: ${id} ${chatOnly ? "chat" : "all"} page ${page + 1}/${pages} ` +
      `(${to - from} of ${items.length} entries, ${line.length} bytes) via ${usbPort ? "usb" : "ble"}`
  );
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
      // The record says which tool wrote it (the hook stamps it). Only fall back to
      // "claude" for records written before that field existed.
      records.push({
        ...record,
        id: path.basename(file, ".json"),
        agent: record.agent === "codex" ? "codex" : "claude",
      });
    } catch {
      // ignore unreadable/partially-written file this tick
    }
  }

  // Codex threads join the SAME list and the same ranking, so a mixed set sorts by
  // how much it needs you rather than by which tool it came from. They arrive
  // pre-shaped by readCodexSessions().
  // Codex arrives from both directions now; the hook record wins where both exist.
  const merged = mergeById(await readCodexSessions(), records);
  records.length = 0;
  records.push(...merged);

  // Urgency first, recency second: the display fits 6 sessions, and when
  // there are more, a session that NEEDS INPUT must never be the hidden one.
  const rank = (r) => (r.status === "asking" ? 0 : r.status === "waiting" ? 1 : 2);
  records.sort((a, b) => rank(a) - rank(b) || b.updated_at - a.updated_at);
  const top = records.slice(0, 6);

  const list = await Promise.all(
    top.map(async (record) => {
      // One tail read per session per tick, giving both the live model and the session
      // title. Codex has neither in this shape, so it doesn't pay for the read.
      const tx =
        record.agent === "codex"
          ? { model: "", title: "", prompt: "", startedMs: 0 }
          : await transcriptInfo(record.transcript);
      const item = {
        id: (record.id || "").slice(0, 12), // 12 uuid chars is plenty to disambiguate
        // 22, matching what the device can actually draw: a tall row's name lane fits 22
        // characters once it drops to the small font, and SessionInfo.name is char[24].
        // Sending more would only be trimmed to "..." on arrival.
        name: deviceText(await projectName(record.cwd || ""), 22),
        status: record.status,
        // 64, not 48: the detail screen gives the path two lines of ~31 characters, and
        // the old cap threw away the middle of any deep worktree path.
        path: truncatePath(toAscii(record.cwd || ""), 64),
        model: deviceText(
          record.agent === "codex" ? record.model || "" : tx.model || record.model || "",
          20,
        ),
        branch: deviceText(await gitBranch(record.cwd || ""), 20),
        // Only sent when there IS one, so a titleless session costs no payload bytes.
        // 40 chars: the device's title lane fits ~28 and trims the rest with "...", and
        // this rides in every tick alongside asks that can claim 1400 chars.
        ...(tx.title ? { title: deviceText(tx.title, 40) } : {}),
        // WHICH APP owns this session, stamped by the hook from the environment it
        // inherits (see owningApp() there). Passed through for the MENU-BAR app,
        // which uses the bundle id to jump to that app rather than only revealing
        // the folder; the device ignores it. Only-when-present for the same reason
        // as `title`, and absent for a Codex thread read off a rollout, where no
        // hook ran to observe an environment.
        // Transliterated but NOT capped: the menu bar resolves this bundle id to
        // jump to the owning app, so a truncated one would break that, while a
        // multi-byte one would still be spending the device's line budget.
        ...(record.app?.id ? { app: toAscii(record.app.id) } : {}),
        ...(record.app?.entry ? { appEntry: toAscii(record.app.entry) } : {}),
        // Detail-screen extras. Short keys and only-when-present, because these ride in
        // EVERY tick: the prompt is the expensive one at ~100 chars x 6 sessions.
        ...(tx.prompt ? { prompt: deviceText(tx.prompt, 100) } : {}),
        // Wall-clock times as seconds-since-local-midnight (see secondsSinceMidnight):
        // when the session began, and when it last did anything.
        startSec: secondsSinceMidnight(tx.startedMs),
        actSec: secondsSinceMidnight(record.updated_at),
        // Short on purpose: this rides in every payload, and the device's line
        // buffer is sized for asks carrying 1400-char details.
        agent: record.agent === "codex" ? "cx" : "cc",
      };
      // Remember where this session's transcript lives, keyed by the SAME truncated id
      // the device sees - that id is all it can send back when asking for history.
      if (record.transcript) transcriptById.set(item.id, record.transcript);
      // Pending question (already truncated by the hook) rides along so the
      // device can display it and offer the options as buttons. We attach a
      // per-prompt nonce; the device HMACs it back so we can trust the answer.
      // A nonce for a typed MESSAGE, present ONLY while this session is READY.
      // Omitted otherwise, so the device is never holding a credential for a state
      // in which it must not offer typing - the same reason ask.answerable is
      // stamped per prompt rather than read from a live global.
      if (record.status === "waiting" && record.id) item.pnonce = nonceForSession(record.id);
      if (record.ask) {
        // A SPREAD, not a field list, and that is what carries the hook's newer
        // fields through untouched - `optDescs` (the per-option descriptions,
        // parallel to `options`) rides here with no code of its own. Do not
        // turn this into an allow-list of named fields: every future field the
        // hook learns to publish would then have to be added in two places, and
        // forgetting the second one is silent - the device simply never sees it.
        item.ask = { ...record.ask, nonce: nonceForPid(record.ask.pid) };
        // Only questions can be answered by voice: emitDecision carries free
        // text for a question and discards it for a plan, and a spoken answer to
        // a permission prompt could only ever be a DENY.
        item.ask.voice = record.ask.kind === "question";
        // Seconds left before the hook stops waiting, for the keyboard countdown.
        const ne = askNonces.get(record.ask.pid);
        // No budget configured (the "forever" default) means no countdown to draw.
        if (ne && HOOK_WAIT_MS[item.agent] != null) {
          const budget = HOOK_WAIT_MS[item.agent];
          item.ask.sec = Math.max(0, Math.round((budget - (Date.now() - ne.first)) / 1000));
        }
        const pend = pendingVoiceAnswers.get(record.ask.pid);
        if (pend) {
          item.ask.voiceText = pend.text;
          item.ask.voiceSha = pend.sha;
        }
      }
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

// Last good token counts, so a ccusage failure costs the COUNT and not the
// tick - see host/ccusage.mjs for why Promise.all was the wrong combinator.
let lastTokens = null;
let tokensStaleLogged = false;

// Never rejects: a failed read yields null and the tick carries on without it.
async function tryCcusage(args) {
  try {
    return await runCcusage(args);
  } catch (err) {
    console.error(`ccusage ${args.join(" ")}: ${describeChildError(err)}`);
    return null;
  }
}

async function readUsage() {
  // Still Promise.all, but the ccusage calls CANNOT REJECT any more - the
  // resilience is in tryCcusage rather than in the combinator, which keeps the
  // destructuring readable. These four are INDEPENDENT sources and ccusage
  // supplies only the three token counts, so rejecting as a unit is what let
  // one 20s timeout throw away the hero percentages, the session list and the
  // clock, publish nothing, and freeze the menu bar on the previous reading.
  const [blocksResp, weeklyResp, rateLimits, sessions] = await Promise.all([
    tryCcusage(["blocks", "--active"]),
    tryCcusage(["weekly"]),
    readRateLimits(),
    readSessions(),
  ]);

  const activeBlock = blocksResp?.blocks?.find((b) => b.isActive);
  const currentWeek = weeklyResp?.weekly?.at(-1) ?? null;
  const fiveHour = rateLimits.five_hour;
  const sevenDay = rateLimits.seven_day;
  const fableBreakdown = (currentWeek?.modelBreakdowns ?? []).find((mb) =>
    /fable/i.test(mb.modelName)
  );

  // A missing reading must not read as a measured zero, so each field is null
  // when its call failed and pickTokens decides between fresh and last-known.
  const tokens = pickTokens(
    {
      sessionTokens: blocksResp ? (activeBlock?.totalTokens ?? 0) : null,
      weekAllTokens: weeklyResp ? (currentWeek?.totalTokens ?? 0) : null,
      weekFableTokens: weeklyResp ? (fableBreakdown ? sumModelTokens(fableBreakdown) : 0) : null,
    },
    lastTokens
  );
  if (!tokens.stale) lastTokens = { ...tokens };
  // Logged on the EDGE, not per tick: these run every 5s and a stale-token
  // line each time would bury the tick lines it sits between.
  if (tokens.stale !== tokensStaleLogged) {
    console.error(
      tokens.stale
        ? `Token counts are STALE - carrying the last reading forward${tokens.everMeasured ? "" : " (nothing measured yet)"}.`
        : "Token counts are live again."
    );
    tokensStaleLogged = tokens.stale;
  }

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
    sessionTokens: tokens.sessionTokens,
    sevenDayPct: useOauth ? oauthUsage.sevenDayPct : (sevenDay?.used_percentage ?? null),
    sevenDayResetInMin: useOauth
      ? minutesUntilMs(oauthUsage.sevenDayResetsAtMs)
      : minutesUntil(sevenDay?.resets_at),
    weekAllTokens: tokens.weekAllTokens,
    weekFableTokens: tokens.weekFableTokens,
    weekFablePct: useOauth ? oauthUsage.weekFablePct : null,
    quotaSource: useOauth ? "oauth" : "cache",
    // How old the quota numbers actually are, so the device can flag stale
    // data on screen - the footer's freshness only covers the transport.
    quotaAgeSec: quotaAt > 0 ? Math.round((Date.now() - quotaAt) / 1000) : null,
    ...codexUsage(),
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
// Same duplicate for the same reason (the device sends on both transports at once).
// Kept separate from the answer key so a message and an answer cannot suppress each
// other, which sharing one variable would allow.
let lastPromptKey = "";
let lastPromptAt = 0;

// ---------- audio capture sink ----------
// MICREC dumps ~445 base64 lines back to back. Those must NOT go through
// console.log: it writes to the log file AND to stdout, and under `open
// DeckhandBLE.app` stdout has no reader - so once that pipe fills, the write
// blocks, this reader stops draining the serial port, and the OS buffer
// overflows. MEASURED: at 460800 that lost ~19% of the lines (362 of 445
// arriving), and the surviving mu-law decoded as loud garbage that Whisper
// confidently transcribed as words nobody said. Writing straight to a file keeps
// the reader hot and keeps a megabyte of base64 out of the log.
const AUDIO_DIR = path.join(os.homedir(), "Deckhand-audio");
const SHOT_DIR = path.join(os.homedir(), "Deckhand-shots");
let shotCapture = null;

// Rebuilds the panel image and writes a PNG directly - no intermediate text file
// and no external encoder. zlib is in node, and a PNG is four chunks, so the
// whole thing is cheaper than shipping a decoder script the user has to run.
async function finishShot() {
  const cap = shotCapture;
  shotCapture = null;
  if (!cap) return;
  const m = cap.header.match(/w=(\d+) h=(\d+)/);
  const w = m ? Number(m[1]) : 240, h = m ? Number(m[2]) : 320;
  if (cap.rows.length !== h) {
    console.log(`SHOT: incomplete - ${cap.rows.length}/${h} rows, not written`);
    return;
  }
  // RGB565 big-endian (the device serialises it that way so there is nothing to
  // guess) -> 8-bit RGB, expanding each channel by replicating its high bits so
  // full-scale stays full-scale rather than 31/32 of it.
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0;                                  // PNG filter: none
    const px = Buffer.from(cap.rows[y], "base64");
    for (let x = 0; x < w; x++) {
      const v = (px[x * 2] << 8) | px[x * 2 + 1];
      const r = (v >> 11) & 31, g = (v >> 5) & 63, b = v & 31;
      raw[o++] = (r << 3) | (r >> 2);
      raw[o++] = (g << 2) | (g >> 4);
      raw[o++] = (b << 3) | (b >> 2);
    }
  }
  const zlib = await import("node:zlib");
  const idat = zlib.deflateSync(raw, { level: 9 });
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;  // 8-bit RGB
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0)),
  ]);
  await fs.mkdir(SHOT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const out = path.join(SHOT_DIR, `shot-${stamp}.png`);
  await fs.writeFile(out, png);
  console.log(`SHOT: ${w}x${h} -> ${out} (${(png.length / 1024).toFixed(1)}KB, ` +
              `${((Date.now() - cap.started) / 1000).toFixed(1)}s)`);
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}
// Captures are never overwritten (each is timestamped), so without this the directory only
// grows - ~100KB to 1MB per take. Age-based, with a floor on the count so a long quiet
// spell can't wipe the lot: the newest AUDIO_KEEP_MIN survive regardless of age, which
// matters because comparing an old capture against a new one is a real workflow here.
// Only capture-*/stream-*.txt are considered; latest.wav and latest-clean.wav are
// regenerated by mic-wav.mjs and left alone.
const AUDIO_KEEP_DAYS = 7;
const AUDIO_KEEP_MIN = 10;
async function pruneAudioCaptures() {
  let names;
  try {
    names = await fs.readdir(AUDIO_DIR);
  } catch {
    return;
  }
  const takes = [];
  for (const n of names) {
    if (!/^(capture|stream)-\d+\.txt$/.test(n)) continue;
    const full = path.join(AUDIO_DIR, n);
    try {
      takes.push({ full, n, mtimeMs: (await fs.stat(full)).mtimeMs });
    } catch {
      /* vanished */
    }
  }
  takes.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
  const cutoff = Date.now() - AUDIO_KEEP_DAYS * 86400_000;
  let removed = 0;
  for (let i = AUDIO_KEEP_MIN; i < takes.length; i++) {
    if (takes[i].mtimeMs >= cutoff) continue;
    try {
      await fs.rm(takes[i].full, { force: true });
      removed++;
    } catch {
      /* leave it */
    }
  }
  if (removed) console.log(`Audio: pruned ${removed} capture(s) older than ${AUDIO_KEEP_DAYS}d`);
}
// ---------- voice -> prompt ----------
// HOW a dictation aimed at a session gets delivered.
//   "clipboard" (default) - put the transcript on the Mac's clipboard and post a
//       notification; YOU paste it into the session yourself.
//   "dispatch"            - the original behaviour: spawn `claude -p --resume <id>`.
// Clipboard is the default because dispatch has three problems that showed up the first
// time it was used in anger: the headless run becomes a SECOND author appending to the
// same conversation concurrently (both were writing to one transcript, neither able to
// see the other), a headless `claude -p` does not fire PermissionRequest so nothing that
// needs approval can finish, and a mis-heard word goes straight to work - a real
// dictation came through as "make sure there is no sensitive data and SOME sensitive
// information", inverting half the instruction. Handing it to you costs hands-free
// operation and fixes all three: it arrives as an ordinary message, in one voice, with
// permissions behaving normally, and you get to read it before anything acts on it.
const VOICE_DELIVERY = process.env.DECKHAND_VOICE_DELIVERY || "clipboard";
const PBCOPY_BIN = "/usr/bin/pbcopy";
const OSASCRIPT_BIN = "/usr/bin/osascript";

function copyToClipboard(text) {
  return new Promise((resolve) => {
    try {
      const p = spawn(PBCOPY_BIN, { stdio: ["pipe", "ignore", "ignore"] });
      p.on("error", () => resolve(false));
      p.on("close", (code) => resolve(code === 0));
      p.stdin.end(text);
    } catch {
      resolve(false);
    }
  });
}

// AppleScript string literals are double-quoted with backslash escapes, and a stray quote
// or newline in a transcript would otherwise break the script (or worse, change it).
function asLiteral(s) {
  return `"${String(s).replace(/[\\"]/g, " ").replace(/[\r\n]+/g, " ").slice(0, 200)}"`;
}

function notify(title, subtitle, body) {
  return new Promise((resolve) => {
    execFile(
      OSASCRIPT_BIN,
      ["-e", `display notification ${asLiteral(body)} with title ${asLiteral(title)} subtitle ${asLiteral(subtitle)}`],
      () => resolve()
    );
  });
}

// Absolute paths on purpose: this process is launched via `open DeckhandBLE.app`,
// which does NOT inherit the shell's PATH, so bare "claude"/"whisper-cli" are not
// findable. Overridable for a different install.
const CLAUDE_BIN = process.env.CLAUDE_BIN || path.join(os.homedir(), ".local/bin/claude");
const WHISPER_BIN = process.env.WHISPER_BIN || "/opt/homebrew/bin/whisper-cli";
// Vocabulary priming. Whisper has no idea what this project's nouns are: a real
// dictation of "update CLAUDE.md" came back as "update core code MD5". An initial
// prompt biases the decoder toward expected terms and costs nothing - no bigger
// model, no extra time. --carry-initial-prompt re-applies it to every window, which
// matters for a 30s+ dictation (otherwise it only conditions the first 30s).
const WHISPER_PROMPT =
  process.env.WHISPER_PROMPT ||
  "Deckhand, CLAUDE.md, README.md, ESP32, firmware, flash, BLE, ADPCM, Whisper, " +
    "git commit, refactor, repository, session, transcript, host script, microphone.";
// What dictation needs, checked as TWO separate things because they fail in
// identically-looking ways. `brew install whisper-cpp` deliberately ships no model, so a
// binary-only install turns "whisper-cli: ENOENT" into "failed to load model". On this
// machine BOTH were missing, which produced 26 logged failures and zero transcripts
// while the device only ever said FAILED.
function voiceMissing() {
  if (!existsSync(WHISPER_BIN)) return `whisper not installed (${WHISPER_BIN})`;
  if (!existsSync(WHISPER_MODEL)) return `whisper model missing (${WHISPER_MODEL})`;
  return null;
}

const WHISPER_MODEL =
  process.env.WHISPER_MODEL || path.join(os.homedir(), ".cache/whisper.cpp/ggml-large-v3-turbo-q5_0.bin");

// Transcribe a saved capture, and - if the dictation was aimed at a session -
// hand the text to that session as a new prompt.
//
// The channel is `claude -p --resume <session_id>`, which is the only supported
// way to add a turn to an existing conversation: hooks can observe and decide, but
// they cannot inject a prompt into a RUNNING interactive session. So this appends
// to the conversation headlessly, which is the right shape for this device anyway
// - the whole point is that you are not sitting at the Mac.
//
// Deliberately left at the DEFAULT permission mode. A dictated instruction still
// has to clear the normal permission prompts, which the device itself can answer
// (see the remote-answering note) - so a misheard command cannot quietly run a
// tool. Raising it to acceptEdits/bypassPermissions would remove that safeguard,
// and that is the user's call to make, not a default to inherit.
async function transcribeAndDispatch(captureFile, target) {
  const wav = path.join(AUDIO_DIR, "latest.wav");
  const clean = path.join(AUDIO_DIR, "latest-clean.wav");
  // Tell the device work has actually STARTED, so its recording bar can go from
  // PROCESSING (its own guess, based on having finished sending) to TRANSCRIBING
  // (confirmed). If this never arrives the device keeps saying PROCESSING, which is
  // exactly the right report for a capture that never reached the Mac. Deliberately
  // NOT one of the states that raises the result card - it is progress, not a result.
  setVoice("working", {});
  try {
    // process.execPath, not "node": this process is the node copy inside
    // DeckhandBLE.app and has no PATH to find a bare "node" with.
    await execFileAsync(process.execPath, [path.join(__dirname, "mic-wav.mjs"), captureFile, wav],
      { timeout: VOICE_CHILD_TIMEOUT_MS });
  } catch (err) {
    console.error(`Voice: decode failed (truncated capture?): ${err.message.split("\n")[0]}`);
    return;
  }
  let text = "";
  try {
    const args = ["-m", WHISPER_MODEL, "-f", clean, "-nt"];
    if (WHISPER_PROMPT) args.push("--prompt", WHISPER_PROMPT, "--carry-initial-prompt");
    const { stdout } = await execFileAsync(WHISPER_BIN, args, {
      maxBuffer: 4 * 1024 * 1024,
      timeout: VOICE_CHILD_TIMEOUT_MS,
    });
    text = stdout.replace(/\s+/g, " ").trim();
  } catch (err) {
    const miss = voiceMissing();
    console.error(`Voice: whisper failed: ${miss || err.message.split("\n")[0]}`);
    setVoice("error", {
      reply: miss ? `${miss} - run host/install-voice.sh` : "transcription failed",
    });
    return;
  }
  if (!text) {
    console.log("Voice: nothing recognised - not dispatching.");
    return;
  }
  console.log(`Voice: transcript = "${text}"`);
  setVoice("heard", { text });
  if (!target || target === "-") {
    console.log("Voice: no target session (recorded from a tab, not a session) - kept as a memo.");
    setVoice("memo", { text });
    return;
  }
  await deliverTextToSession(target, text);
}

// Hand text to a session. This is the shared tail of a dictation aimed at a session
// and a typed message from the keyboard: the same act, so the delivery choice
// (DECKHAND_VOICE_DELIVERY) has to mean the same thing for both, and keeping one
// copy is what stops them drifting.
//
// `tag` changes only the LOG prefix. The setVoice states are deliberately identical
// - the device's result card and the menu bar's row key off those strings, and a
// typed message should surface exactly the way a dictation does.
async function deliverTextToSession(target, text, tag = "Voice") {
  // The device only knows the first 12 chars of the id; resolve the real one.
  // Through resolveSessionId, which REFUSES an ambiguous prefix - the find() this
  // replaced silently took the first match.
  let sessionId = null, cwd = null;
  try {
    const found = resolveSessionId(await fs.readdir(SESSIONS_DIR), target);
    if (!found.ok) {
      console.error(`${tag}: ${found.reason} session for ${target} - transcript not dispatched.`);
      setVoice("error", { text, reply: `no matching session (${found.reason})` });
      return;
    }
    sessionId = found.id;
    cwd =
      JSON.parse(await fs.readFile(path.join(SESSIONS_DIR, `${sessionId}.json`), "utf8")).cwd ||
      undefined;
  } catch {}
  if (!sessionId) {
    console.error(`${tag}: could not read the session record for ${target} - not dispatched.`);
    setVoice("error", { text, reply: "no matching session" });
    return;
}
const where = cwd ? await projectName(cwd) : target;
if (VOICE_DELIVERY !== "dispatch") {
  const ok = await copyToClipboard(text);
  if (!ok) {
    console.error(`${tag}: could not reach pbcopy - text NOT delivered.`);
    setVoice("error", { text, reply: "clipboard unavailable" });
    return;
  }
  console.log(`${tag}: copied to the clipboard for ${where} (${sessionId}) - paste it there.`);
  await notify("Deckhand heard you", `Paste into ${where}`, text);
  setVoice("clip", { text, session: target, reply: `Copied. Paste it into ${where} on your Mac.` });
  return;
}

console.log(`${tag}: -> session ${sessionId}${cwd ? ` (cwd ${cwd})` : ""}`);
setVoice("sent", { text, session: target });
// Detached: a dictated task can run for minutes and must not block this poller.
const child = execFile(
  CLAUDE_BIN,
  ["-p", "--resume", sessionId, text],
  // stdin ignored on purpose: `claude -p` otherwise waits on it and warns
  // "no stdin data received in 3s" before proceeding.
  { cwd, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
  (err, stdout, stderr) => {
    if (err) {
      console.error(`${tag}: claude failed: ${(stderr || err.message).split("\n")[0]}`);
      setVoice("error", { reply: (stderr || err.message).split("\n")[0] });
      return;
    }
    // Log the reply itself, not just its length: without it a dictation is a
    // black hole - you can see that something happened but never what.
    const reply = stdout.trim().replace(/\s+/g, " ");
    console.log(
      `${tag}: claude replied (${reply.length} chars): ` +
        (reply.length > 400 ? reply.slice(0, 400) + " ..." : reply)
    );
    setVoice("done", { reply });
  }
);
child.unref?.();
}

// Same decode-and-transcribe as a dictation, but the result is PARKED for
// confirmation rather than delivered. Nothing here writes an answer file - the
// device has to sign the text first.
async function transcribeForAnswer(captureFile, pid) {
  const wav = path.join(AUDIO_DIR, "latest.wav");
  const clean = path.join(AUDIO_DIR, "latest-clean.wav");
  // Tell the device work has actually STARTED, so its recording bar can go from
  // PROCESSING (its own guess, based on having finished sending) to TRANSCRIBING
  // (confirmed). If this never arrives the device keeps saying PROCESSING, which is
  // exactly the right report for a capture that never reached the Mac. Deliberately
  // NOT one of the states that raises the result card - it is progress, not a result.
  setVoice("working", {});
  try {
    await execFileAsync(process.execPath, [path.join(__dirname, "mic-wav.mjs"), captureFile, wav],
      { timeout: VOICE_CHILD_TIMEOUT_MS });
  } catch (err) {
    // mic-wav.mjs refuses a capture under 98% complete, because a truncated one
    // transcribes as confident nonsense - exactly what must not become an answer.
    console.error(`Voice answer: decode failed (truncated capture?): ${err.message.split("\n")[0]}`);
    setVoice("askerror", { reply: "capture incomplete - record again" });
    return;
  }
  let text = "";
  try {
    const args = ["-m", WHISPER_MODEL, "-f", clean, "-nt"];
    if (WHISPER_PROMPT) args.push("--prompt", WHISPER_PROMPT, "--carry-initial-prompt");
    const { stdout } = await execFileAsync(WHISPER_BIN, args, {
      maxBuffer: 4 * 1024 * 1024, timeout: VOICE_CHILD_TIMEOUT_MS });
    text = stdout.replace(/\s+/g, " ").trim();
  } catch (err) {
    const missA = voiceMissing();
    console.error(`Voice answer: whisper failed: ${missA || err.message.split("\n")[0]}`);
    setVoice("askerror", { reply: "transcription failed" });
    return;
  }
  if (!text) {
    setVoice("askerror", { reply: "nothing recognised - record again" });
    return;
  }
  // TRANSLITERATE HERE, AT THE PARK SITE, AND NOWHERE ELSE. Whisper is the
  // highest non-ASCII-density source in the system - em-dashes, curly quotes and
  // ellipses in almost every sentence - and this string ends up on the CONFIRM
  // SCREEN, whose entire purpose is proving a human read THESE EXACT WORDS before
  // signing them. Untransliterated it reached the wire intact and the device drew
  // holes exactly where the punctuation was: "Yes - let's go ahead..." rendered as
  // "Yes  lets go ahead". Both fonts are 0x20..0x7E, so an out-of-range byte draws
  // nothing and advances nothing.
  //
  // THE OBVIOUS FIX IS THE WRONG ONE: doing this in the payload builder, where
  // `item.ask.voiceText = pend.text` is assigned, would desync the text the device
  // DISPLAYS from the text that gets signed. It does NOT produce a rejection -
  // sessions.ino:2259 builds "nonce:pid:TEXT:<sha16>" from the voiceSha the host
  // SENT rather than re-hashing what it draws, and this host verifies against its
  // own parked copy, which still matches - so the answer is ACCEPTED and the human
  // has authorised words they never read, silently. It has to happen before
  // voiceSha() below, which is why it is on this line and not that one.
  //
  // Cap AFTER, and cap in BYTES: the device displays the capped string, so that is
  // the string that must be signed, and hashing before capping would sign text the
  // human never saw. capUtf8 stays even though its input is now ASCII - it is the
  // last line of defence and costs nothing on ASCII (see VOICE_ANSWER_TEXT_MAX_BYTES;
  // the device stores this in a fixed char[204]).
  text = capUtf8(toAscii(text), VOICE_ANSWER_TEXT_MAX_BYTES);
  pendingVoiceAnswers.set(pid, { text, sha: voiceSha(text), at: Date.now() });
  console.log(`Voice answer: pid=${pid} transcript = "${text}"`);
  setVoice("askheard", { text });
}

let audioCapture = null; // { header, lines: [], started }

async function finishAudioCapture(complete) {
  if (!audioCapture) return;
  const cap = audioCapture;
  audioCapture = null;
  const claimed = Number((cap.header.match(/samples=(\d+)/) ?? [, 0])[1]);
  const bytes = cap.lines.reduce((n, l) => n + l.length, 0);
  // BYTES PER SAMPLE, from the header, because this estimate feeds a completeness
  // guard and being wrong here is dangerous in the LENIENT direction. Every codec
  // before board 2 was one byte per sample (mu-law) or packed tighter (ADPCM), so
  // dividing base64 bytes by 1 was right by accident. pcm16 is TWO, and without
  // this a 10s capture reported "200%" - which means a capture truncated by half
  // would have read as a clean 100% and sailed through the 98% refusal that exists
  // precisely to stop Whisper inventing words over misaligned audio.
  const bits = Number((cap.header.match(/bits=(\d+)/) ?? [, 8])[1]);
  const bytesPerSample = bits >= 16 ? 2 : 1;
  const got = Math.floor((bytes * 3) / 4 / bytesPerSample);
  const file = path.join(AUDIO_DIR, `capture-${cap.started}.txt`);
  try {
    await fs.mkdir(AUDIO_DIR, { recursive: true });
    await fs.writeFile(
      file,
      [cap.header, ...cap.lines.map((l) => `AUDIO d ${l}`), "AUDIO end"].join("\n") + "\n"
    );
  } catch (err) {
    console.error(`Audio: could not save capture: ${err.message}`);
    return;
  }
  const pct = claimed ? Math.round((got / claimed) * 100) : 0;
  console.log(
    `Audio: saved ${file} (${cap.lines.length} lines, ~${got}/${claimed} samples = ${pct}%` +
      `${complete ? "" : ", NO 'AUDIO end' - truncated"}${pct < 98 ? ", INCOMPLETE" : ""})`
  );
  // One-shot captures get transcribed too. They carry no target, so they land as a
  // memo rather than being dispatched anywhere.
  if (pct >= 98) transcribeAndDispatch(file, "-").catch((e) => console.error("Voice:", e.message));
  pruneAudioCaptures().catch(() => {});
}

// ---------- streaming audio sink ----------
// Frames are ACKed so the device can throttle itself. Without that a host stall
// (a ccusage spawn, a slow log write) silently overflows the OS serial buffer -
// the failure that once produced a truncated capture Whisper "transcribed" as
// words nobody said. The device allows MIC_STREAM_WINDOW frames in flight.
// The last voice exchange, published to BOTH surfaces so a dictation is never
// invisible: into the device payload (it draws a result card) and into the
// heartbeat (the menu bar shows it). Before this, the only way to know what you
// had said - or whether Claude acted on it - was to tail the host log.
// Text is capped: the device's line buffer has to hold a whole payload, and asks
// already claim up to 1400 chars of it.
let lastVoice = null; // { seq, at, state, text, reply, session }
let voiceSeq = 0;
const VOICE_TEXT_MAX = 200;
const VOICE_REPLY_MAX = 420;
// An answer transcript is capped by BYTES, not characters, and lower than a
// dictation's: the device stores it in a fixed char[204] and DISPLAYS it on one
// screen, and the whole design rests on the signed hash covering exactly the
// text a human read. Whisper emits multi-byte punctuation freely, so a
// character cap can overflow the device buffer and be silently truncated there
// while the host hashes the full string - verification would pass and the host
// would write text nobody saw.
function setVoice(state, fields = {}) {
  lastVoice = {
    // Small monotonic counter for the DEVICE. Date.now() is ~1.79e12 and `long` on
    // ESP32 is 32-bit, so a ms timestamp overflows and every comparison against it
    // is meaningless. `at` stays for the Mac side, which has no such limit.
    seq: ++voiceSeq,
    at: Date.now(),
    state,
    text: deviceText(fields.text ?? lastVoice?.text ?? "", VOICE_TEXT_MAX),
    reply: deviceText(fields.reply ?? "", VOICE_REPLY_MAX),
    session: fields.session ?? lastVoice?.session ?? "",
  };
}

let audioStream = null; // { header, rate, chunks: [], expectSeq, gaps, started }

function onAudioFrame(seq, payload) {
  if (!audioStream) return; // frame outside a stream: nothing to attach it to
  if (seq !== audioStream.expectSeq) {
    audioStream.gaps++;
    console.error(`Audio: frame gap - expected ${audioStream.expectSeq}, got ${seq}`);
  }
  audioStream.expectSeq = seq + 1;
  audioStream.chunks.push(Buffer.from(payload));
  if (usbPort) usbPort.write(`AUDIO ack ${seq}\n`);
}

async function finishAudioStream(tail) {
  if (!audioStream) return;
  const st = audioStream;
  audioStream = null;
  const data = Buffer.concat(st.chunks);
  const file = path.join(AUDIO_DIR, `stream-${st.started}.txt`);
  try {
    await fs.mkdir(AUDIO_DIR, { recursive: true });
    // Written as the same base64 text envelope mic-wav.mjs already understands,
    // so the decoder needs no new file format - only the ima4 codec.
    const lines = [];
    for (let i = 0; i < data.length; i += 144)
      lines.push("AUDIO d " + data.subarray(i, i + 144).toString("base64"));
    // Normalise to the SAME "AUDIO begin ..." envelope one-shot captures use, so
    // mic-wav.mjs needs no new file format.
    const f = (k, d) => (st.header.match(new RegExp(k + "=(-?\\d+)")) ?? [, d])[1];
    // THE CODEC MUST COME FROM THE DEVICE, not be assumed. This used to hardcode
    // `bits=4 codec=ima4` because ADPCM was the only thing that had ever streamed,
    // and a board 2 pcm16 stream would therefore have been written to disk CLAIMING
    // TO BE ADPCM - so mic-wav.mjs would have run the IMA decoder over linear PCM
    // and produced exactly the loud garbage that makes Whisper invent sentences.
    // The device already announces `codec=` in its stream header; this reads it.
    const codec = (st.header.match(/codec=(\w+)/) ?? [, "ima4"])[1];
    // bits, and how many samples a byte carries, per codec. ima4 is 2 samples a
    // byte (4-bit), ulaw 1, pcm16 half. An unknown codec falls back to the ima4
    // numbers, which is what every pre-board-2 stream was and keeps those files
    // byte-identical to what this wrote before.
    const SHAPE = { ima4: [4, 2], ulaw: [8, 1], pcm16: [16, 0.5], pcm: [16, 0.5] };
    const [bits, samplesPerByte] = SHAPE[codec] ?? SHAPE.ima4;
    const header =
      `AUDIO begin rate=${f("rate", 16000)} bits=${bits} codec=${codec} ` +
      `scale=${f("scale", 8)} ` +
      `samples=${st.samples ?? Math.floor(data.length * samplesPerByte)} ` +
      `dc=${f("dc", 0)} bytes=${data.length}`;
    await fs.writeFile(file, [header, ...lines, "AUDIO end"].join("\n") + "\n");
  } catch (err) {
    console.error(`Audio: could not save stream: ${err.message}`);
    return;
  }
  console.log(
    `Audio: saved ${file} (${data.length} bytes, ${st.chunks.length} frames, ` +
      `${(st.samples
            ? st.samples / 16000
            : (data.length * (({ ima4: 2, ulaw: 1, pcm16: 0.5, pcm: 0.5 })[
                 (st.header.match(/codec=(\w+)/) ?? [, "ima4"])[1]] ?? 2)) / 16000
          ).toFixed(1)}s at 16kHz ` +
      `${(st.header.match(/codec=(\w+)/) ?? [, "ima4"])[1]}, gaps=${st.gaps})  ${tail}`
  );
  // Fire and forget: transcription plus a dictated task can take a while, and the
  // serial reader must keep draining throughout.
  // An answer capture never dispatches: its text has to be confirmed on the
  // device before it is allowed to become a decision.
  if (st.answerPid) {
    transcribeForAnswer(file, st.answerPid).catch((e) => console.error("Voice answer:", e.message));
  } else {
    transcribeAndDispatch(file, st.target).catch((e) => console.error("Voice:", e.message));
  }
  pruneAudioCaptures().catch(() => {});
}

// A confirmed spoken answer. The device signs a hash of the text it DISPLAYED,
// so verifying here proves both that the paired device authorised it and that
// the text is the one a human read.
async function handleVoiceAnswer(parts, via) {
  const [, id12, pid, , sha16, mac] = parts;
  const entry = askNonces.get(pid);
  const from = deviceNameFor(via);
  const dev = from ? deviceEntry(from) : null;
  const pend = pendingVoiceAnswers.get(pid);

  if (!pend) {
    console.error(`Voice answer: no pending transcript for prompt ${pid} - ignoring.`);
    return;
  }
  const v = verifyVoiceAnswer({
    secret: dev?.secret, nonce: entry?.nonce, pid, sha16, mac, text: pend.text,
  });
  if (!v.ok) {
    // Loud on purpose: "text does not match the signed hash" is the tamper case
    // and must not look like an ordinary rejection.
    console.error(
      `Voice answer REJECTED (${v.why}) for prompt ${pid} ` +
        `${senderDescription(via, from)} - ignoring.`
    );
    return;
  }
  askNonces.delete(pid);          // single-use, as with an option answer
  pendingVoiceAnswers.delete(pid);

  try {
    const files = await fs.readdir(SESSIONS_DIR);
    const file = files.find((f) => f.endsWith(".json") && f.startsWith(id12));
    if (!file) {
      console.error(`Voice answer: no session matching ${id12}`);
      return;
    }
    const sessionId = path.basename(file, ".json");
    let rec = null;
    try {
      rec = JSON.parse(await fs.readFile(path.join(SESSIONS_DIR, file), "utf8"));
    } catch (err) {
      console.error(`Voice answer: could not read session record for ${sessionId}: ${err.message}`);
      return;
    }
    // Defence in depth: ask.voice gates the BUTTON, not the write. A transcript
    // parked against a plan would land as idx:0, which emitDecision turns into
    // {behavior:"allow"} - silently approving a plan. The kind is re-checked
    // here so the device is not the only thing standing between a stray pid and
    // an auto-approval.
    if (rec?.ask?.kind !== "question" || rec?.ask?.pid !== pid) {
      console.error(`Voice answer REJECTED (not a pending question) for prompt ${pid} - ignoring.`);
      return;
    }
    await fs.mkdir(ANSWERS_DIR, { recursive: true });
    // idx 0 and the transcript as `label`: emitDecision builds its message from
    // `answer.label || \`option ${idx+1}\``, so the spoken text flows through the
    // existing question path untouched. The hook is NOT modified.
    await fs.writeFile(
      path.join(ANSWERS_DIR, `${sessionId}.json`),
      JSON.stringify({ pid, idx: 0, label: pend.text, voice: true, written_at: Date.now() })
    );
    console.log(`Voice answer accepted for ${sessionId} (pid ${pid}): "${pend.text}"`);
    setVoice("asksent", { text: pend.text, reply: "sent to Claude" });
  } catch (err) {
    console.error(`Voice answer: could not write answer file: ${err.message}`);
  }
}

// The typed sibling of handleVoiceAnswer. Same shape, one real difference: there is
// no parked transcript to look up, because the text arrives in the frame. Every
// other guard is deliberately identical - especially the ask.kind re-check, which
// is what stops a chosen pid reaching emitDecision's {behavior:"allow"} plan branch.
// PROMPT <id12> <base64text> <hmac> - a typed message aimed at a READY session.
//
// Distinct from ANSWER in every way that matters: nothing is waiting on it, there is
// no pid, and it is signed against a per-SESSION nonce with the PROMPT label.
async function handleTypedPrompt(line, via) {
  // The device transmits on USB and BLE simultaneously, so a single SEND arrives
  // twice. Without this the first copy is accepted and the second is REJECTED for
  // "missing pairing/nonce state" - correct behaviour (the nonce is single-use) that
  // reads in the log as an authentication failure on every message sent. Same guard
  // the answer path already uses, and the window matches it.
  if (line === lastPromptKey && Date.now() - lastPromptAt < 3000) return;
  lastPromptKey = line;
  lastPromptAt = Date.now();
  const parts = line.trim().split(/\s+/);
  if (parts.length !== 4) {
    console.error("Prompt: malformed frame - ignoring.");
    return;
  }
  const [, id12, b64, mac] = parts;

  let record = null;
  try {
    const found = resolveSessionId(await fs.readdir(SESSIONS_DIR), id12);
    if (!found.ok) {
      console.error(`Prompt: ${found.reason} session for ${id12} - refusing.`);
      return;
    }
    record = JSON.parse(await fs.readFile(path.join(SESSIONS_DIR, `${found.id}.json`), "utf8"));
    record.id = found.id;
  } catch (err) {
    console.error(`Prompt: could not read the session record - refusing (${err.message}).`);
    return;
  }

  // RE-CHECK READY HERE. The device gates its own button on status too, but a gate
  // that exists only on the device is not a gate - the same reason handleVoiceAnswer
  // re-reads the record before writing an answer file. A missing or non-waiting
  // status must REJECT, never fall through.
  if (record.status !== "waiting") {
    console.error(`Prompt: session ${id12} is "${record.status}", not waiting - refusing.`);
    return;
  }

  const from = deviceNameFor(via);
  const dev = from ? deviceEntry(from) : null;
  const nonce = promptNonces.get(record.id)?.nonce;
  const v = verifyPrompt({ secret: dev?.secret, nonce, id12, b64, mac });
  if (!v.ok) {
    console.error(
      `Prompt REJECTED for session ${id12} ` +
        `${senderDescription(via, from)} - ${v.why}.`
    );
    return;
  }
  consumeSessionNonce(record.id); // single-use: no replay
  console.log(`Prompt: accepted ${v.text.length} chars for ${id12} from ${from}.`);
  await deliverTextToSession(id12, v.text, "Prompt");
}

async function handleTypedAnswer(parts, via) {
  const [, id12, pid, , b64, mac] = parts;
  const entry = askNonces.get(pid);
  const from = deviceNameFor(via);
  const dev = from ? deviceEntry(from) : null;

  const v = verifyTypedAnswer({ secret: dev?.secret, nonce: entry?.nonce, pid, b64, mac });
  if (!v.ok) {
    // Loud on purpose: "text is empty, over the cap, or not printable ASCII" and
    // "bad hmac" are a foreign peer, not an ordinary rejection.
    console.error(
      `Typed answer REJECTED (${v.why}) for prompt ${pid} ` +
        `${senderDescription(via, from)} - ignoring.`
    );
    return;
  }
  const text = v.text;
  askNonces.delete(pid); // single-use, as with an option or voice answer

  try {
    const files = await fs.readdir(SESSIONS_DIR);
    const file = files.find((f) => f.endsWith(".json") && f.startsWith(id12));
    if (!file) {
      console.error(`Typed answer: no session matching ${id12}`);
      return;
    }
    const sessionId = path.basename(file, ".json");
    let rec = null;
    try {
      rec = JSON.parse(await fs.readFile(path.join(SESSIONS_DIR, file), "utf8"));
    } catch (err) {
      console.error(`Typed answer: could not read session record for ${sessionId}: ${err.message}`);
      return;
    }
    // Defence in depth, identical to handleVoiceAnswer: ask.kind is re-checked here
    // so the device is not the only thing standing between a stray pid and an
    // auto-approval of a plan (emitDecision's answer.idx === 0 branch is `allow`).
    if (rec?.ask?.kind !== "question" || rec?.ask?.pid !== pid) {
      console.error(`Typed answer REJECTED (not a pending question) for prompt ${pid} - ignoring.`);
      return;
    }
    await fs.mkdir(ANSWERS_DIR, { recursive: true });
    await fs.writeFile(
      path.join(ANSWERS_DIR, `${sessionId}.json`),
      JSON.stringify({ pid, idx: 0, label: text, typed: true, written_at: Date.now() })
    );
    console.log(`Typed answer accepted for ${sessionId} (pid ${pid}): "${text}"`);
    setVoice("asksent", { text, reply: "sent to Claude" });
  } catch (err) {
    console.error(`Typed answer: could not write answer file: ${err.message}`);
  }
}

// `pairGen` is set ONLY by a pairing link's own reader, which stamps every
// line with the exchange whose connection it belongs to. Every other caller
// leaves it 0, and 0 matches no exchange - see pairReplyIsOurs().
async function handleDeviceLine(line, via, pairGen = 0) {
  // Before ANY logging: a line addressed to the other Mac is not ours to log,
  // authenticate, or act on.
  if (!lineTargetsUs(line, hostId)) return;
  // Strip the address ONCE, here, before any parser below ever sees the
  // line - see stripAddress's own comment. Every parser past this point
  // (ANSWER, HISTORY, PROMPT's strict `parts.length !== 4`) predates
  // addressing and is a positional destructure with no idea a trailing
  // token could exist; PROMPT is the one that actually broke on it.
  line = stripAddress(line);

  // BATT mv=3854 pct=42 state=3 left=312 pcth=81 span=27
  //
  // `left` is MINUTES, and -1 means "not measurable yet" - a different statement
  // from 0, which must not be shown as one: for the first ~20 minutes off USB the
  // device's trend is still inside its own ADC noise. pcth/span are the estimate's
  // provenance and stay in the log rather than the heartbeat.
  if (line.startsWith("PROMPT ")) {
    await handleTypedPrompt(line, via);
    return;
  }
  if (line.startsWith("BATT ")) {
    const f = {};
    for (const kv of line.slice(5).trim().split(/\s+/)) {
      const [k, v] = kv.split("=");
      if (k) f[k] = Number.parseInt(v, 10);
    }
    if (Number.isFinite(f.mv) && Number.isFinite(f.pct)) {
      lastBatt = {
        mv: f.mv,
        pct: f.pct,
        state: Number.isFinite(f.state) ? f.state : null,
        leftMin: Number.isFinite(f.left) && f.left >= 0 ? f.left : null,
        at: Date.now(),
      };
    }
  }
  // History request from the detail screen. Handled here rather than in the tick so the
  // transcript is only read when someone is actually looking at it.
  if (line.startsWith("HISTORY ")) {
    // The 4th token is the device's reader budget, `<cols>x<lines>` - absent from
    // board 1 and from any pre-budget firmware, which is exactly why histBudget()
    // falls back rather than validating. It matters only to the page layout, so
    // the item: path (one whole entry, no pagination) ignores it.
    const [id, filter = "chat", want = "last", budgetTok] = line.slice(8).trim().split(/\s+/);
    console.log(`[device/${via}] ${line}`);
    if (want.startsWith("item:")) await sendHistoryItem(id, filter, Number.parseInt(want.slice(5), 10) || 0);
    else await sendHistory(id, filter, want, histBudget(budgetTok));
    return;
  }
  // Audio first, and deliberately unlogged - see the note above.
  if (via === "usb") {
    // Screenshot: same shape as an audio capture - a header, base64 rows, an end
    // marker - and deliberately unlogged for the same reason (a quarter of a
    // megabyte of base64 must not go near the log, and console.log also writes to
    // a stdout nobody is draining under `open`).
    if (line.startsWith("SHOT begin ")) {
      shotCapture = { header: line, rows: [], started: Date.now() };
      console.log(`[device/${via}] ${line}`);
      return;
    }
    if (line.startsWith("SHOT d ")) {
      if (shotCapture) shotCapture.rows.push(line.slice(7));
      return; // never logged
    }
    if (line === "SHOT end") {
      await finishShot();
      return;
    }
    if (line.startsWith("AUDIO begin ")) {
      if (audioCapture) await finishAudioCapture(false);
      audioCapture = { header: line, lines: [], started: Date.now() };
      console.log(`[device/${via}] ${line}`);
      return;
    }
    if (line.startsWith("AUDIO d ")) {
      if (audioCapture) audioCapture.lines.push(line.slice(8));
      return; // never logged
    }
    if (line === "AUDIO end") {
      await finishAudioCapture(true);
      return;
    }
    if (line.startsWith("AUDIO stream ")) {
      const tm = line.match(/target=(\S+)/);
      const am = line.match(/answer=(\S+)/);
      const answerPid = am && am[1] !== "-" ? am[1] : "";
      // A new answer recording supersedes any transcript already parked for
      // this prompt. Cleared on ARRIVAL rather than on success, so a failed
      // attempt cannot leave the previous text confirmable - RE-RECORD exists
      // to discard text, and must never end up transmitting it.
      if (answerPid) pendingVoiceAnswers.delete(answerPid);
      audioStream = {
        header: line,
        target: tm ? tm[1] : "-",
        answerPid,
        chunks: [], expectSeq: 0, gaps: 0, started: Date.now(),
      };
      console.log(`[device/${via}] ${line}`);
      return;
    }
    if (line.startsWith("AUDIO streamend")) {
      const m = line.match(/samples=(\d+)/);
      if (audioStream && m) audioStream.samples = parseInt(m[1], 10);
      console.log(`[device/${via}] ${line}`);
      await finishAudioStream(line.replace("AUDIO streamend ", ""));
      return;
    }
  }
  console.log(`[device/${via}] ${line}`);

  // ---- wireless pairing, on whichever transport it arrives ----
  // These are handled here rather than on the pairing link alone because the
  // device answers on EVERY live transport: a cabled device sends PAIRPUB over
  // USB as well, and the state machine takes the first and ignores the rest.
  // `via`/`pairGen` are passed on rather than dropped: they are the ONLY
  // evidence of which exchange a reply belongs to, because nothing in the wire
  // format says so.
  if (line.startsWith("PAIRPUB ")) {
    await handlePairPub(line.slice(8).trim(), via, pairGen);
    return;
  }
  if (line === "PAIRDONE" || line.startsWith("PAIRDONE ")) {
    await handlePairDone(line.slice(8).trim(), via, pairGen);
    return;
  }
  if (line === "PAIRFAIL" || line.startsWith("PAIRFAIL ")) {
    await handlePairFail(line.slice(8).trim(), via, pairGen);
    return;
  }

  // Device announces its unique BLE name over USB (trusted): pin BLE to it,
  // and push it the shared secret so it can authenticate answers. HELLO is
  // only honored over USB - a BLE peer must not be able to steer us.
  if (line.startsWith("HELLO ") && via === "usb") {
    // "HELLO <name> [v2]" - v2 firmware understands the per-Mac PROVISION form.
    // Older firmware sends just the name and stores ONE secret, so we send it
    // the bare key instead; that still works, because the key we send is this
    // pair's own key and the device signs with exactly what it was given.
    const [name, proto = ""] = line.slice(6).trim().split(/\s+/);
    if (name && !isValidDeviceName(name)) {
      console.error(`Auth: ignoring HELLO with malformed name ${JSON.stringify(name)} (line corruption?).`);
      return;
    }
    if (name) {
      usbDeviceName = name;
      const entry = await rememberDevice(name); // mints a key for a new device
      // Nothing chosen yet (first run, or the selection was forgotten): adopt
      // the device that's physically plugged in. An existing choice is left
      // alone, so plugging a second unit in to charge doesn't steal the link.
      if (!selectedDevice) {
        selectedDevice = name;
        await savePairing();
        console.log(`Auth: selected ${name}.`);
      }
      // hostId tells a device paired with several Macs which key to sign with.
      if (usbPort) {
        usbPort.write(
          proto === "v2"
            ? `PROVISION ${hostId} ${entry.secret} ${hostLabel}\n` // USB only
            : `PROVISION ${entry.secret}\n` // pre-multi-pairing firmware
        );
      }
    }
    return;
  }

  if (!line.startsWith("ANSWER ")) return;
  // In mirror mode nothing is waiting for an answer file and the Mac owns the
  // decision, so drop taps rather than leaving a file that could decide a LATER
  // prompt. (Current firmware won't send these - it renders the options
  // read-only - but an older build on the same key still would.)
  if (!remoteAnswer) {
    console.log("Remote answer ignored - mirror mode (answer on the Mac, or enable it in the menu bar).");
    return;
  }
  // The device sends on USB and BLE simultaneously - process one copy.
  if (line === lastAnswerKey && Date.now() - lastAnswerAt < 3000) return;
  lastAnswerKey = line;
  lastAnswerAt = Date.now();
  const parts = line.trim().split(/\s+/);
  // Voice form: ANSWER <id12> <pid> TEXT <sha16> <hmac>. Checked before the
  // option form so the two parsers never see each other's shape.
  if (parts[3] === "TEXT") {
    await handleVoiceAnswer(parts, via);
    return;
  }
  // Typed form: ANSWER <id12> <pid> TYPED <base64text> <hmac>. Like TEXT this is
  // checked before the option form, so the two parsers never see each other's shape.
  if (parts[3] === "TYPED") {
    await handleTypedAnswer(parts, via);
    return;
  }
  if (parts.length < 4) return;
  const [, id12, pid, idxStr, mac] = parts;
  const idx = parseInt(idxStr, 10);
  if (!Number.isInteger(idx) || idx < 0) return;

  // Authenticate: the answer must carry a valid HMAC over the nonce we issued
  // for THIS prompt. Rejects forged answers from an impersonating peripheral
  // and replays (the nonce is consumed on success).
  const entry = askNonces.get(pid);
  const from = deviceNameFor(via); // which paired device this arrived from
  const want = entry && from ? expectedHmac(from, entry.nonce, pid, idx) : "";
  const good =
    !!want &&
    typeof mac === "string" &&
    mac.length === want.length &&
    crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want));
  if (!good) {
    console.error(
      `Remote answer REJECTED (bad/missing auth) for prompt ${pid} ` +
        `${senderDescription(via, from)} - ignoring.`
    );
    return;
  }
  askNonces.delete(pid); // single-use: no replay

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
    console.log(`Remote answer: ${id12} prompt ${pid} -> [${idx}] ${label} (auth ok)`);
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
      (p.vendorId ?? "").toLowerCase() === "1a86" || // CH340 (board 1)
      (p.vendorId ?? "").toLowerCase() === "303a" || // Espressif native USB (board 2)
      /usbserial|wchusbserial|SLAB_USBtoUART|usbmodem/i.test(p.path)
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

  // Accumulates BYTES, not a string. Streaming audio arrives as raw binary frames
  // ("AUDIO bin <seq> <n>" then exactly n bytes), and `chunk.toString("utf8")`
  // would mangle every byte outside ASCII - lossily and silently. So the reader is
  // a small state machine over a Buffer: line mode until a frame header says how
  // many raw bytes follow, then byte-count mode for exactly that many.
  let rxBuf = Buffer.alloc(0);
  let wantBytes = 0; // >0 = mid-frame, collecting binary
  let wantSeq = 0;
  port.on("data", (chunk) => {
    rxBuf = rxBuf.length ? Buffer.concat([rxBuf, chunk]) : chunk;
    for (;;) {
      if (wantBytes > 0) {
        if (rxBuf.length < wantBytes) return; // wait for the rest of the frame
        const payload = rxBuf.subarray(0, wantBytes);
        rxBuf = rxBuf.subarray(wantBytes);
        wantBytes = 0;
        onAudioFrame(wantSeq, payload);
        continue;
      }
      const idx = rxBuf.indexOf(0x0a); // '\n'
      if (idx === -1) return;
      const line = rxBuf.subarray(0, idx).toString("latin1").trim();
      rxBuf = rxBuf.subarray(idx + 1);
      const m = line.match(/^AUDIO bin (\d+) (\d+)$/);
      if (m) {
        wantSeq = parseInt(m[1], 10);
        wantBytes = parseInt(m[2], 10);
        continue;
      }
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
let blePeripheral = null; // kept so switching devices can drop the old link

// Drop the current BLE link and go back to scanning - used when the chosen
// device changes, so we don't stay stuck on the previous one.
async function rescanBle(why) {
  if (blePeripheral) {
    console.log(`BLE: ${why}, disconnecting from ${bleDeviceName || "device"}...`);
    await blePeripheral.disconnectAsync().catch(() => {});
    // the 'disconnect' handler clears state and restarts the scan
  } else {
    startBleScan();
  }
}

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
    // A PAIRING SCAN LISTS, IT DOES NOT CONNECT. For its 5 seconds the normal
    // auto-connect is suppressed outright: the user is choosing from the list,
    // and grabbing one of them mid-scan would both shorten the list and connect
    // to a device they had not picked. pairScanFinish() puts the normal scan back.
    if (pairScanning) {
      if (name === "Deckhand" || name.startsWith("Deckhand-")) {
        // STAMPED, because this Map holds a live noble peripheral handle and it
        // is what PAIRSTART later hands to connectAsync. Entries used to live
        // until the next scan, so a handle an hour old - from a device since
        // moved, slept or re-advertised under a new address - was connected to
        // as if it were fresh. pairScanPrune() ages them out; the stamp is what
        // lets it, and what lets PAIRSTART say WHY it refused.
        pairScanSeen.set(name, { name, rssi: peripheral.rssi ?? -127, peripheral, at: Date.now() });
      }
      return;
    }
    // Never race an exchange for its own peripheral: the pairing link owns that
    // connection and its TX listener, and a second connect would re-subscribe
    // underneath it.
    if (pairExchange && pairExchange.ownLink && peripheral.id === pairExchange.peripheralId) return;
    // Connect only to OUR device, so we never grab a neighbour's unit in a
    // shared room: the one that's been chosen, else any device we're already
    // paired with, else any "Deckhand[-XXXX]" as a first-run bootstrap.
    if (selectedDevice) {
      if (name !== selectedDevice) return;
    } else if (pairedDevices.length) {
      if (!deviceEntry(name)) return;
    } else if (name !== "Deckhand" && !name.startsWith("Deckhand-")) {
      return;
    }
    await noble.stopScanningAsync().catch(() => {});
    console.log(`BLE: found ${name}, connecting...`);
    try {
      // noble keeps its own idea of the peripheral's state, and it can still say
      // "connected" from a link that no longer exists - after the host restarts while
      // BLE was up, or after the device sleeps and re-advertises. connectAsync() then
      // throws "Peripheral already connected", which used to be caught as an ordinary
      // failure and retried by rescanning - finding the SAME stale object and throwing
      // again, forever. Observed wedged in exactly that loop with USB unplugged, so the
      // device had no transport at all while the host looked perfectly healthy.
      if (peripheral.state !== "connected") await peripheral.connectAsync();
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
        // noble caches the Characteristic object PER PERIPHERAL, so a
        // reconnect to the same device hands back the same object with
        // whatever "data" listener a previous connection already attached -
        // never removed on disconnect, because there was no disconnect
        // handler on the characteristic itself, only on the peripheral.
        // Without this, every reconnect adds ANOTHER handler with its own
        // closed-over bleLineBuf, so one real device line gets handled N
        // times: N answer-file writes, N authentication-failure logs, N x
        // the work on a 120s audio stream. Found via
        // MaxListenersExceededWarning plus visibly duplicated handling of
        // every line after a few reconnects - this branch makes reconnects
        // routine (two Macs, either one can drop and rejoin), so it is no
        // longer the rare case it used to be.
        txChar.removeAllListeners("data");
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
      blePeripheral = peripheral;
      bleDeviceName = name; // answers over BLE are verified with THIS device's key
      console.log(`BLE: connected to ${name} and ready.`);
      peripheral.once("disconnect", () => {
        console.log("BLE: disconnected, re-scanning...");
        bleCharacteristic = null;
        blePeripheral = null;
        bleDeviceName = "";
        startBleScan();
      });
    } catch (err) {
      console.error("BLE: connect failed:", err.message);
      bleCharacteristic = null;
      blePeripheral = null;
      bleDeviceName = "";
      // ALWAYS tear the peripheral down before retrying. Without this a stale
      // "connected" state survives the retry and the next attempt fails identically -
      // which is the loop this comment exists because of. Disconnecting resets noble's
      // state so the rescan gets a genuinely fresh link.
      await peripheral.disconnectAsync().catch(() => {});
      // A small pause too: a tight scan/connect/fail cycle spins the radio and fills
      // the log with thousands of identical lines, which buries whatever else is wrong.
      setTimeout(startBleScan, 2000);
    }
  });
}

// A promise that CANNOT hang. noble's writeAsync never settles if the adapter
// disappears mid-write - it does not reject, it simply never calls back - and an
// await that never settles is not something try/catch can save you from.
const BLE_WRITE_TIMEOUT_MS = 3000;
function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// MEASURED TWICE, hours apart: a stuck BLE write killed the poll loop outright.
// tick()'s `setTimeout(tick, ...)` sits after every await, so a write that never
// settles means tick() never returns, never reschedules, and the host stops
// sending forever - while its serial READER, being event-driven and independent,
// keeps logging device lines as if nothing were wrong. Both times the line after
// the last tick was "BLE: adapter state = poweredOff", and both times the device
// went blank while the Mac still looked healthy.
//
// The symptom is deceptive on the device too: SETTINGS shows Bluetooth
// "connected" (the link really does re-establish) but USB "disconnected",
// because the device infers USB from bytes RECEIVED - so a host that has stopped
// transmitting looks like a USB fault rather than a stalled host.
async function sendOverBle(text) {
  const characteristic = bleCharacteristic;
  if (!characteristic) return;
  const buf = Buffer.from(text, "utf8");
  for (let i = 0; i < buf.length; i += BLE_CHUNK_SIZE) {
    try {
      await withTimeout(
        characteristic.writeAsync(buf.subarray(i, i + BLE_CHUNK_SIZE), true),
        BLE_WRITE_TIMEOUT_MS,
        "BLE write"
      );
    } catch (err) {
      console.error("BLE: write failed:", err.message);
      return;
    }
  }
}

// ---------- Wireless pairing: the Mac's half ----------
//
// The cable's security value was never the wire - it was proof that a person
// was HOLDING the device. This replaces that proof with a code shown on BOTH
// screens and a CONFIRM tap on the glass, and it never puts the 128-bit pairing
// key on the air: both ends DERIVE it from an ephemeral X25519 exchange. See
// docs/superpowers/specs/2026-08-30-wireless-pairing.md, and pair-crypto.mjs
// for the derivations, which must agree byte for byte with pairing.ino.
//
// THE USER TYPES NOTHING. An earlier design had the code typed into the Mac,
// and it was broken: the proof derives from the shared secret alone, so ANY
// peer that completes the ECDH computes a valid one without ever seeing the
// code. What commits is the tap on the device, bound to the peer that did the
// exchange. The Mac's job here is to derive its own code, PUBLISH it in the
// heartbeat for the menu bar to draw, and send the proof when the user says the
// two agree.
//
// NOTHING SECRET IS WRITTEN OR LOGGED. The private key and the shared secret
// live in `pairExchange` and are zeroed by pairEnd() on every exit path -
// success, refusal, timeout and teardown alike. The derived key reaches disk
// only through savePairing(), which is where every pairing key has always
// lived. The six digits are deliberately kept out of host.log too: the log
// rotates and persists, and the heartbeat (mode-0700 runtime dir) is the one
// channel the menu bar reads.
const PAIR_SCAN_MS = 5000;
const PAIR_CONNECT_TIMEOUT_MS = 15_000;
const PAIR_PUB_TIMEOUT_MS = 15_000;    // the device answers a PAIRREQ immediately
const PAIR_EXCHANGE_MS = 120_000;      // matches the device's own PAIR_WINDOW_MS
// The device sanitises and truncates this itself (PAIR_LABEL_BYTES), so this cap
// only keeps the line short; it is not the display budget.
const PAIR_LABEL_MAX = 32;
// How long a SIGHTING is good for. The scan list holds live noble peripheral
// handles and PAIRSTART hands the chosen one straight to connectAsync, so an
// old handle is a connect to whatever that object still believes it points at.
// 120s is the human timescale this whole feature already runs on - the device's
// own pairing window - so anything older means the user has wandered off and
// should look again rather than have us guess.
const PAIR_SCAN_FRESH_MS = 120_000;

let pairState = "idle";      // idle | scanning | awaiting-code | verifying | done | failed
let pairError = "";
let pairScanning = false;
let pairScanTimer = null;
const pairScanSeen = new Map();  // name -> { name, rssi, peripheral, at }
let pairExchange = null;
let pairTimer = null;
let pairDeadline = 0;
// Monotonic, one per exchange, never reused. It is what a reply arriving on an
// exchange's OWN link is matched against - see pairReplyIsOurs().
let pairGeneration = 0;
// pairEnd() nulls pairExchange FIRST (so nothing can act on a half-wiped one)
// and only then closes the link, which is bounded at 15s. Without this flag
// pairBusy() was false for that whole window, so a PAIRCANCEL->PAIRSTART inside
// it sailed past the guard and the OLD teardown's startBleScan() then fired
// underneath the new connect. "Busy" has to mean "not ready for a new exchange",
// which includes still putting the last one away.
let pairTearingDown = false;

const pairBusy = () => pairExchange !== null || pairTearingDown;

function pairSecsLeft() {
  if (!pairDeadline) return 0;
  return Math.max(0, Math.round((pairDeadline - Date.now()) / 1000));
}

// Drops sightings whose handles have gone stale, which both keeps the menu's
// list to what PAIRSTART would actually accept and lets noble's peripheral
// objects go. Called from pairStatus(), i.e. every tick, and from PAIRSTART.
function pairScanPrune(now = Date.now()) {
  for (const [name, d] of pairScanSeen) {
    if (now - (d.at ?? 0) > PAIR_SCAN_FRESH_MS) pairScanSeen.delete(name);
  }
}

// WHICH EXCHANGE A REPLY BELONGS TO IS NOT ON THE WIRE, so it is derived from
// where the reply ARRIVED. Every pairing reply used to bind to whatever
// `pairExchange` happened to be current, and that is reachable with no attacker
// at all: an exchange that times out at 15s, a retry, and the FIRST device's
// slow PAIRPUB lands in the second exchange - setting `code` from a peer that
// never did this ECDH, after which `if (ex.code) return;` swallows the real
// reply. The codes then disagree and nothing is stored, so it fails safe, but
// the user gets a dead exchange under a log line saying it was answered.
//
//   "pair" - the exchange's own link, whose reader stamps the generation it
//            was opened for. A reader left over from an abandoned exchange
//            therefore stamps a generation that no longer matches, and 0 (every
//            other caller's default) matches nothing.
//   "ble"/"usb" - a shared transport, so the test is that the transport is
//            actually connected to the device THIS exchange is with.
function pairReplyIsOurs(ex, via, gen) {
  if (via === "pair") return gen !== 0 && gen === ex.gen;
  if (via === "ble") return !!bleDeviceName && bleDeviceName === ex.name;
  if (via === "usb") return !!usbDeviceName && usbDeviceName === ex.name;
  return false;
}

// Logged rather than dropped in silence: a swallowed reply presents as pairing
// simply not working, which is the whole complaint above.
function pairReplyAccepted(ex, kind, via, gen) {
  if (pairReplyIsOurs(ex, via, gen)) return true;
  const where = via === "pair" ? `the pairing link of exchange #${gen}` : `the ${via} link`;
  console.log(
    `Pair: ${kind} DROPPED - it arrived on ${where}, which is not the exchange with ` +
      `${ex.name} (#${ex.gen}). A late reply from an abandoned exchange must never be ` +
      `taken for this one's.`
  );
  return false;
}

// What the menu bar renders from. `code` is OUR derived code - it is not a
// secret from the local user (they are about to read the same six digits off
// the device), and publishing it here is the whole point: nothing is typed and
// nothing is compared host-side.
function pairStatus() {
  pairScanPrune();
  return {
    state: pairState,
    devices: [...pairScanSeen.values()]
      .map((d) => ({ name: d.name, rssi: d.rssi }))
      .sort((a, b) => b.rssi - a.rssi),
    name: pairExchange ? pairExchange.name : "",
    label: pairExchange ? pairExchange.label : "",
    code: pairExchange ? pairExchange.code : "",
    error: pairError,
    sec: pairSecsLeft(),
  };
}

// Every await inside a pairing path is bounded, because an await that never
// settles is this repo's documented worst failure: tick()'s setTimeout sits
// after every await, so one unsettled promise stops the host sending forever
// while it still looks perfectly healthy.
async function pairWrite(characteristic, text) {
  if (!characteristic) throw new Error("no write characteristic");
  const buf = Buffer.from(text, "utf8");
  for (let i = 0; i < buf.length; i += BLE_CHUNK_SIZE) {
    await withTimeout(
      characteristic.writeAsync(buf.subarray(i, i + BLE_CHUNK_SIZE), true),
      BLE_WRITE_TIMEOUT_MS,
      "pairing write"
    );
  }
}

function pairArm(ms, why) {
  if (pairTimer) clearTimeout(pairTimer);
  pairTimer = setTimeout(() => {
    pairTimer = null;
    pairEnd("failed", why, `timed out - ${why}`).catch((err) =>
      console.error("Pair: teardown after timeout failed:", err.message)
    );
  }, Math.max(1000, ms));
}

// ONE exit for every ending, so the wipe cannot be forgotten on a path added
// later - the same reason pairDeriveAll() on the device is single-exit.
async function pairEnd(nextState, error, note) {
  const ex = pairExchange;
  pairExchange = null;
  // Held across the awaits below, so pairBusy() keeps meaning "not ready for a
  // new exchange" while the old link is still coming down. Only the call that
  // actually HAS the exchange owns the flag; a concurrent pairEnd() with
  // nothing to tear down must not clear it underneath this one.
  if (ex) pairTearingDown = true;
  pairState = nextState;
  pairError = error || "";
  pairDeadline = 0;
  if (pairTimer) {
    clearTimeout(pairTimer);
    pairTimer = null;
  }
  try {
    if (ex) {
      for (const b of [ex.priv, ex.shared, ex.key]) if (Buffer.isBuffer(b)) b.fill(0);
      ex.priv = null;
      ex.shared = null;
      ex.key = null;
      ex.proof = "";
      ex.code = "";
      // Only a link WE opened is ours to take down. Pairing with the device that
      // is already the live link must leave that link exactly as it found it -
      // losing a working connection because someone opened a pairing menu would
      // be worse than the feature is worth.
      if (ex.ownLink) {
        // Ours to remove BEFORE we disconnect, or our own disconnect calls it -
        // and, worse, noble caches peripherals, so a handler left behind would
        // ride that object into whatever the next connection uses it for.
        if (ex.onDisconnect) {
          try {
            ex.peripheral.removeListener("disconnect", ex.onDisconnect);
          } catch {
            // the peripheral may already be gone
          }
          ex.onDisconnect = null;
        }
        try {
          ex.txChar?.removeAllListeners("data");
        } catch {
          // the characteristic may already be gone with the link
        }
        // Skipped when the link is ALREADY gone - which is exactly the case the
        // disconnect handler above arrives in. noble's disconnectAsync() waits
        // for a 'disconnect' event that has already been emitted, so it would
        // sit out the full 15s timeout and hold pairTearingDown with it.
        if (ex.peripheral.state !== "disconnected") {
          try {
            await withTimeout(ex.peripheral.disconnectAsync(), PAIR_CONNECT_TIMEOUT_MS, "pairing disconnect");
          } catch (err) {
            console.error(`Pair: could not close the pairing link cleanly: ${err.message}`);
          }
        }
        // We stopped the scan to connect; put it back if nothing else is up.
        if (!bleCharacteristic) startBleScan();
      }
    }
  } finally {
    if (ex) pairTearingDown = false;
  }
  if (note) console.log(`Pair: ${note}`);
}

async function pairScanStart() {
  if (pairScanning) {
    console.log("Pair: a scan is already running.");
    return;
  }
  if (pairBusy()) {
    console.log(
      pairExchange
        ? "Pair: PAIRSCAN ignored - an exchange is in progress (PAIRCANCEL first)."
        : "Pair: PAIRSCAN ignored - the last exchange is still closing its link; try again in a moment."
    );
    return;
  }
  if (noble.state !== "poweredOn") {
    pairState = "failed";
    pairError = `bluetooth is ${noble.state}`;
    console.error(`Pair: cannot scan - bluetooth adapter is ${noble.state}.`);
    return;
  }
  pairScanning = true;          // set BEFORE any await: the discover handler reads it
  pairScanSeen.clear();
  pairError = "";
  pairState = "scanning";
  try {
    await withTimeout(noble.stopScanningAsync(), PAIR_CONNECT_TIMEOUT_MS, "stop scan");
    // allowDuplicates: a 5s list wants every advertiser's freshest RSSI, not one
    // sighting each.
    await withTimeout(noble.startScanningAsync([], true), PAIR_CONNECT_TIMEOUT_MS, "pairing scan");
  } catch (err) {
    pairScanning = false;
    pairState = "failed";
    pairError = `scan failed: ${err.message}`;
    console.error(`Pair: scan failed to start: ${err.message}`);
    if (!bleCharacteristic) startBleScan();
    return;
  }
  console.log(`Pair: scanning ${PAIR_SCAN_MS / 1000}s for nearby Deckhand devices...`);
  pairScanTimer = setTimeout(() => {
    pairScanFinish().catch((err) => console.error("Pair: scan teardown failed:", err.message));
  }, PAIR_SCAN_MS);
}

// RESTORES THE HOST'S NORMAL INVARIANT rather than a remembered flag: this code
// scans while disconnected and does not while connected, so that is what gets
// put back - on the happy path, on a failed start, and on the timeout alike.
async function pairScanFinish() {
  pairScanTimer = null;
  pairScanning = false;
  try {
    await withTimeout(noble.stopScanningAsync(), PAIR_CONNECT_TIMEOUT_MS, "stop scan");
  } catch (err) {
    console.error(`Pair: could not stop the pairing scan: ${err.message}`);
  }
  if (!bleCharacteristic) startBleScan();
  const list = [...pairScanSeen.values()].sort((a, b) => b.rssi - a.rssi);
  console.log(
    list.length
      ? `Pair: scan found ${list.length} device(s): ${list.map((d) => `${d.name} (${d.rssi} dBm)`).join(", ")}.`
      : "Pair: scan found no Deckhand devices - is one advertising?"
  );
  if (pairState === "scanning") pairState = "idle";
}

async function pairStart(name) {
  if (pairBusy()) {
    console.log(
      pairExchange
        ? "Pair: PAIRSTART ignored - an exchange is already running (PAIRCANCEL first)."
        : "Pair: PAIRSTART ignored - the last exchange is still closing its link; try again in a moment."
    );
    return;
  }
  if (pairScanning) {
    console.log("Pair: PAIRSTART ignored - a scan is still running.");
    return;
  }
  if (!isValidDeviceName(name)) {
    pairState = "failed";
    pairError = `${name || "(no name)"} is not a Deckhand-XXXX device name`;
    console.error(`Pair: PAIRSTART ignored - ${pairError}.`);
    return;
  }
  // The scan list is the normal route. The device already on the live link is
  // accepted too, so re-pairing the connected one does not need a scan first.
  //
  // A STALE SIGHTING IS REFUSED BY NAME rather than connected to. The Map holds
  // the noble peripheral object itself, and that handle is only as good as the
  // advertisement it came from; the live link is exempt because it is not a
  // remembered handle at all - it is the connection we are using right now.
  const hit = pairScanSeen.get(name);
  const hitAgeMs = hit ? Date.now() - (hit.at ?? 0) : 0;
  if (hit && hitAgeMs > PAIR_SCAN_FRESH_MS) {
    pairScanSeen.delete(name);
    pairState = "failed";
    pairError = `${name} was last seen ${Math.round(hitAgeMs / 1000)}s ago - that sighting is stale`;
    console.error(`Pair: ${pairError}; run PAIRSCAN again rather than connecting to a stale handle.`);
    return;
  }
  pairScanPrune();
  const peripheral =
    (hit && hit.peripheral) || (blePeripheral && bleDeviceName === name ? blePeripheral : null);
  if (!peripheral) {
    pairState = "failed";
    pairError = `${name} was not in the last scan`;
    console.error(`Pair: ${pairError} - run PAIRSCAN first.`);
    return;
  }

  const { priv, pub } = generateKeypair();
  // ASCII only and capped: this crosses a wire whose every other text field is
  // ASCII by construction, and the device blanks anything else anyway.
  const label = toAscii(hostLabel).replace(/[^\x20-\x7E]/g, "").slice(0, PAIR_LABEL_MAX).trim();
  pairExchange = {
    name,
    gen: ++pairGeneration,
    peripheral,
    peripheralId: peripheral.id,
    ownLink: peripheral !== blePeripheral,
    priv,
    pub,
    shared: null,
    key: null,
    code: "",
    proof: "",
    label,
    rxChar: null,
    txChar: null,
    onDisconnect: null,
  };
  const ex = pairExchange;
  pairError = "";
  // "awaiting-code" from here: the user's job is already to watch for the two
  // codes, and `code` stays "" until the device answers, which is what the menu
  // bar shows a spinner for.
  pairState = "awaiting-code";
  pairDeadline = Date.now() + PAIR_EXCHANGE_MS;
  pairArm(PAIR_PUB_TIMEOUT_MS, "the device never answered with its public key (is its pairing window open?)");

  try {
    if (pairExchange.ownLink) {
      // Connecting takes the radio; the background scan has to yield for it and
      // is restored by pairEnd().
      await withTimeout(noble.stopScanningAsync(), PAIR_CONNECT_TIMEOUT_MS, "stop scan");
    }
    if (peripheral.state !== "connected") {
      await withTimeout(peripheral.connectAsync(), PAIR_CONNECT_TIMEOUT_MS, "pairing connect");
    }
    if (pairExchange !== ex) return;   // cancelled while we were connecting
    // THE LINK DROPPING WAS THE ONE FAILURE THIS PATH COULD NOT SEE. The main
    // BLE path has watched for it since the start; this one had nothing, so a
    // peripheral that went away after PAIRPUB left `pairExchange` non-null with
    // priv/shared/key UN-ZEROED and the heartbeat publishing awaiting-code, the
    // six digits and a counting `sec` for the rest of the 120s - a dead
    // exchange the menu bar draws as a live pairing. It was bounded by the
    // timer, but "every failure closes the exchange" should be satisfied by
    // NOTICING the failure, not by outliving it.
    //
    // Registered only after the ownership check above, so a pairEnd() that has
    // already run cannot leave a handler behind on a noble-cached peripheral.
    if (ex.ownLink) {
      ex.onDisconnect = () => {
        if (pairExchange !== ex) return;   // pairEnd() already took it down
        pairEnd(
          "failed",
          "the pairing link dropped",
          `the link to ${name} dropped before the exchange finished`
        ).catch((err) => console.error("Pair: teardown after a dropped link failed:", err.message));
      };
      peripheral.once("disconnect", ex.onDisconnect);
    }
    const { characteristics } = await withTimeout(
      peripheral.discoverSomeServicesAndCharacteristicsAsync(
        [BLE_SERVICE_UUID],
        [BLE_RX_CHAR_UUID, BLE_TX_CHAR_UUID]
      ),
      PAIR_CONNECT_TIMEOUT_MS,
      "pairing discover"
    );
    const rx = characteristics.find((c) => c.uuid === BLE_RX_CHAR_UUID) ?? null;
    const tx = characteristics.find((c) => c.uuid === BLE_TX_CHAR_UUID) ?? null;
    if (!rx) throw new Error("the device exposes no RX characteristic");
    if (pairExchange !== ex) return;   // cancelled while we were connecting
    pairExchange.rxChar = rx;
    // On the LIVE link the existing subscription already funnels every device
    // line into handleDeviceLine, so a second listener would double-handle
    // everything - the exact defect the main path's removeAllListeners exists
    // for. Only a link we opened gets a reader of its own.
    if (pairExchange.ownLink) {
      if (!tx) throw new Error("the device exposes no TX characteristic");
      pairExchange.txChar = tx;
      tx.removeAllListeners("data");
      let buf = "";
      // Stamped with THIS exchange's generation. noble caches the characteristic
      // per peripheral, so a re-pair of the same device attaches a new listener
      // to the same object and a notify still in flight from the previous
      // attempt would otherwise arrive looking exactly like this one's reply.
      const gen = ex.gen;
      tx.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        let i;
        while ((i = buf.indexOf("\n")) !== -1) {
          const l = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (l) handleDeviceLine(l, "pair", gen);
        }
      });
      await withTimeout(tx.subscribeAsync(), PAIR_CONNECT_TIMEOUT_MS, "pairing subscribe");
    }
    if (pairExchange !== ex) return;   // cancelled while we were subscribing
    await pairWrite(rx, `PAIRREQ ${hostId} ${pub.toString("hex")} ${label}\n`);
    console.log(`Pair: PAIRREQ sent to ${name} as "${label}"; waiting for its public key.`);
  } catch (err) {
    if (pairExchange === ex) {
      await pairEnd("failed", err.message, `could not start the exchange with ${name}: ${err.message}`);
      return;
    }
    // Cancelled or timed out underneath us: pairEnd() has already wiped the
    // keys, but a connect that completed AFTER it would leave a link nobody
    // owns, so close it here rather than hoping.
    console.error(`Pair: exchange with ${name} failed after it ended: ${err.message}`);
    if (ex.ownLink) {
      await withTimeout(peripheral.disconnectAsync(), PAIR_CONNECT_TIMEOUT_MS, "pairing disconnect").catch(() => {});
    }
  }
}

// PAIRPUB <pubB:64hex>
async function handlePairPub(hex, via, gen) {
  const ex = pairExchange;
  if (!ex) {
    console.log("Pair: PAIRPUB ignored - no exchange is running.");
    return;
  }
  // BOUND TO ITS EXCHANGE FIRST. A public key is the one reply that CHANGES
  // state irreversibly for this exchange (it sets `code`, after which the real
  // reply is swallowed by the dedup below), so the source test comes before
  // anything else touches `ex`.
  if (!pairReplyAccepted(ex, "PAIRPUB", via, gen)) return;
  // The device sends on every live transport at once, so a cabled device
  // delivers this twice. The first one wins; a second is not an error.
  if (ex.code) return;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    await pairEnd("failed", "the device's public key was malformed", "the device's public key was malformed");
    return;
  }
  const pubB = Buffer.from(hex, "hex");
  let shared;
  try {
    shared = deriveShared(ex.priv, pubB);
  } catch (err) {
    // MEASURED IN TASK 1: node THROWS on all four classic low-order X25519
    // points (all-zero, one, and both order-8 points) rather than returning an
    // attacker-known shared secret. That is the Mac failing CLOSED against a
    // contributory-behaviour attack - but an uncaught rejection here would kill
    // the poll loop, so the throw is caught, named, and ends the exchange.
    await pairEnd(
      "failed",
      "the device's public key was rejected",
      `the device's public key was rejected by X25519 (${err.message}) - a low-order point or a corrupt line`
    );
    return;
  }
  ex.shared = shared;
  ex.code = deriveCode(shared, ex.pub, pubB);
  ex.key = deriveKey(shared, ex.pub, pubB);
  ex.proof = pairProof(ex.key);
  pairState = "awaiting-code";
  pairArm(
    Math.max(1000, pairDeadline - Date.now()),
    "nobody said whether the codes matched"
  );
  // The CODE IS NOT LOGGED, deliberately: it belongs on the two screens and in
  // the heartbeat the menu bar reads, not in a rotating file on disk.
  console.log(`Pair: ${ex.name} answered - compare the six digits on its screen with the ones in the menu.`);
}

// The user clicked Match. Nothing is compared here: the proof says only that we
// did the same ECDH, and the device commits on ITS OWN tap.
async function pairConfirm() {
  const ex = pairExchange;
  if (!ex) {
    console.log("Pair: PAIRCONFIRM ignored - no exchange is running.");
    return;
  }
  if (!ex.proof) {
    console.log("Pair: PAIRCONFIRM ignored - the device has not answered yet.");
    return;
  }
  pairState = "verifying";
  try {
    await pairWrite(ex.rxChar, `PAIROK ${ex.proof}\n`);
  } catch (err) {
    await pairEnd("failed", err.message, `could not send the proof: ${err.message}`);
    return;
  }
  console.log("Pair: proof sent - now tap CONFIRM on the device to store the key.");
  pairArm(
    Math.max(1000, pairDeadline - Date.now()),
    "the device never confirmed - its CONFIRM button has to be tapped inside the 120s window"
  );
}

// PAIRDONE <hostId> - sent ONLY after the tap on the glass, and it is the only
// thing that makes the derived key a stored pairing on this side too.
async function handlePairDone(id, via, gen) {
  const ex = pairExchange;
  if (!ex) {
    console.log("Pair: PAIRDONE ignored - no exchange is running.");
    return;
  }
  if (!pairReplyAccepted(ex, "PAIRDONE", via, gen)) return;
  if (id && id.toLowerCase() !== hostId.toLowerCase()) {
    console.log(`Pair: PAIRDONE ignored - it names ${id}, not this Mac (${hostId}).`);
    return;
  }
  if (!ex.key) {
    await pairEnd("failed", "PAIRDONE arrived before a key was derived", "PAIRDONE arrived before a key was derived");
    return;
  }
  const name = ex.name;
  // hex, lowercase - the same form PROVISION has always stored, so a wirelessly
  // paired Mac answers prompts through exactly the existing code path.
  const secret = ex.key.toString("hex");
  await rememberDevice(name, secret);
  await pairEnd("done", "", `paired with ${name}. Its key was DERIVED on both sides and never transmitted.`);
}

// PAIRFAIL <reason>
//
// IT CARRIES NO hostId, so the address check handlePairDone makes on its own
// argument has no counterpart here; what CAN be checked is where the line
// arrived, which is the same binding every other reply now gets. That is
// weaker than an address and it is the strongest thing available on this side.
//
// NOTED, NOT FIXED (it is a firmware change): the "the device has no hostId to
// address it with" rationale below is true only of `closed`, which is refused
// before any PAIRREQ is read. Once a PAIRREQ has been ACCEPTED the device knows
// the requesting hostId, so every later failure - a malformed key, a bad proof,
// a CANCEL tap, the window expiring - could carry the trailing `to=<hostId>`
// address that every other device->host line already uses, and would then be
// filtered by lineTargetsUs() before it ever reached here.
async function handlePairFail(reason, via, gen) {
  const ex = pairExchange;
  if (!ex) {
    // `PAIRFAIL closed` is broadcast (the device has no hostId to address it
    // with yet), so one can arrive for somebody else's attempt. Logged, not acted on.
    console.log(`Pair: PAIRFAIL ${reason} ignored - no exchange is running.`);
    return;
  }
  if (!pairReplyAccepted(ex, `PAIRFAIL ${reason || "(no reason)"}`, via, gen)) return;
  await pairEnd("failed", reason || "refused", `the device refused: ${reason || "(no reason given)"}`);
}

// Nothing a pairing handler throws may escape into the command loop's
// "no trigger file" catch, and nothing it throws may leave an exchange open.
async function pairCommand(name, fn) {
  try {
    await fn();
  } catch (err) {
    console.error(`Pair: ${name} failed: ${err.message}`);
    if (pairExchange) {
      await pairEnd("failed", err.message, `exchange abandoned after ${name} threw`).catch(() => {});
    } else {
      pairState = "failed";
      pairError = err.message;
    }
  }
}

async function pairCancel() {
  if (pairScanTimer) {
    clearTimeout(pairScanTimer);
    await pairScanFinish();
  }
  const ex = pairExchange;
  if (!ex) {
    if (pairTearingDown) {
      console.log("Pair: nothing to cancel - the last exchange is already closing.");
      return;
    }
    pairState = "idle";
    pairError = "";
    console.log("Pair: nothing to cancel.");
    return;
  }
  // Told, not merely dropped: the device would otherwise hold its window open
  // showing a code for a Mac that has gone away.
  try {
    await pairWrite(ex.rxChar, "PAIRCANCEL\n");
  } catch (err) {
    console.error(`Pair: could not tell the device we cancelled: ${err.message}`);
  }
  await pairEnd("idle", "", "cancelled.");
}

// ---------- Shared tick: compute usage once, send to whichever transports are live ----------
// Belt and braces over the BLE write timeout above. That fix bounds the ONE await
// known to hang; this bounds the whole function, because any future await added
// inside tick() would kill the poller in exactly the same way - silently, with no
// error, no log line, and a device that simply goes stale. A `finally` would not
// help: it runs when a function completes, and the failure mode is one that never
// completes.
//
// The generation counter is what stops the cure being worse than the disease: if
// a stalled tick eventually DOES resume, it must not carry on scheduling
// alongside the replacement the watchdog started, or every stall would
// permanently double the tick rate.
const TICK_WATCHDOG_MS = 30_000;      // 6 missed ticks at POLL_INTERVAL_MS
let tickGeneration = 0;
let lastTickCompleted = Date.now();

// The char/byte invariant is asserted at the point of send (host/wire-ascii.mjs),
// and what it finds is logged on the EDGE rather than per tick: an upstream field
// that skips the transliteration is wrong on EVERY tick, and a line every 5s would
// bury the tick lines it sits between - the same rule ccusage's staleness follows.
// The signature is the offender LIST, so a NEW field appearing says so even while
// an old one is still broken, and the all-clear is worth a line of its own.
let lastWireAsciiSig = "";

async function tick(generation = tickGeneration) {
  try {
    pruneNonces();
    // Heartbeat for the session hook: it only blocks waiting for a remote
    // answer when a display is genuinely connected right now AND the user has
    // opted into device answering (otherwise blocking would hide the Mac's own
    // dialog, which is exactly what mirror mode avoids).
    await fs
      .writeFile(
        HOST_ALIVE,
        JSON.stringify({
          connected: !!(usbPort || bleCharacteristic),
          remoteAnswer,
          at: Date.now(),
          // `device` = who we're actually talking to (falls back to the choice);
          // `devices`/`selected` let the menu bar render the picker without ever
          // reading the secrets file.
          device: bleDeviceName || usbDeviceName || selectedDevice || null,
          selected: selectedDevice || null,
          devices: pairedDevices.map((d) => d.name),
          // The menu-bar picker's icon submenu. `icon` is the fully-resolved
          // value (env beats the picker's file, same as what the device is
          // shown) so the checkmark is right regardless of source; `iconFromEnv`
          // is what makes the picker disable itself and say so, rather than
          // showing a checkmark a click could never move. The menu-bar app
          // can't read the host's launchd environment or the plist itself
          // (that would be a third source of truth), so this heartbeat is the
          // only way it learns either fact.
          icon: currentMacEmoji(),
          iconFromEnv: !!resolveMacEmoji({ env: process.env.DECKHAND_MAC_EMOJI || "", file: "" }),
          voice: lastVoice,
          // The pairing dialog's whole state, INCLUDING the code this Mac
          // derived - the menu bar draws it for the user to compare against the
          // device's screen, and never reads the secrets file. It is not secret
          // from the local user, and this file lives in a mode-0700 runtime dir.
          pairing: pairStatus(),
          // ageSec is computed on the way out rather than stored, so a stale
          // reading cannot look fresh just because the heartbeat itself is.
          batt: lastBatt
            ? { ...lastBatt, ageSec: Math.round((Date.now() - lastBatt.at) / 1000) }
            : null,
        })
      )
      .catch(() => {});

    const usage = await readUsage();
    // Fired from the tick because readUsage() is what refreshes codexRateLimits, so the
    // staleness it decides on is current. Deliberately NOT awaited: the guards inside
    // bound it to at most one turn per 6h, and a turn takes seconds - awaiting it would
    // put a model call inside the 5s poll loop, which is the stall shape tick() has a
    // watchdog for. Errors are swallowed by the function itself.
    maybeRefreshCodexUsage().catch(() => {});
    // hostId rides along so a device paired with several Macs knows which of
    // its stored keys to sign this prompt's answer with. remoteAnswer tells the
    // device whether its option buttons are live or read-only, so it never
    // offers a control that can't do anything.
    const hostEmoji = currentMacEmoji();
    // MEASURED, NOT ASSUMED. feedChar() clears its whole buffer past 16000 bytes
    // and the remainder of the line lands in the emptied one, so an over-guard
    // line does not merely fail to arrive - it freezes the screen for as long as
    // the prompt causing it is pending, silently. host/to-ascii.mjs removes the
    // char/byte multiplier that made this reachable with ordinary text; this is
    // the backstop that does not depend on being right about every future field,
    // and it is the only thing that covers a STALE HOOK in ~/.claude still
    // emitting untransliterated text. What it sheds is LOGGED - a silent
    // truncation would be the same class of defect as the freeze.
    //
    // ASCII FIRST, THEN FIT, and that order is load-bearing: transliteration
    // changes the SIZE of the line (a CJK run collapses to one '?', an ellipsis
    // grows to three dots), so fitting before it would measure a line that is not
    // the one being written. asciiFit walks the payload STRUCTURALLY rather than
    // checking a list of field names, because the field nobody remembered to add
    // to the list is precisely the field that skipped the transliteration - which
    // is how ask.voiceText got past every cap assertion in the repo. A violation
    // is REPAIRED so the device can draw and budget for it, except on a field the
    // device SIGNS (ask.voiceText), where repair would let the confirm screen
    // display text that is not what gets signed - that one is SUPPRESSED instead.
    const wire = asciiFit({
      ...usage, hostId, hostTag, ...(hostEmoji ? { hostEmoji } : {}), remoteAnswer, voice: lastVoice,
    });
    if (wire.offenders.length) {
      const sig = wire.offenders.join("|");
      if (sig !== lastWireAsciiSig) {
        lastWireAsciiSig = sig;
        console.log(`Wire: NON-ASCII device-bound text at the boundary - ` +
                    `${describeOffenders(wire.offenders)}. Whatever produces that field is ` +
                    `skipping deviceText()/toAscii(), so its character cap is not a byte cap. ` +
                    `Repaired so the device can draw it, EXCEPT any field the device signs, ` +
                    `which is suppressed instead - see host/wire-ascii.mjs.`);
      }
    } else if (lastWireAsciiSig) {
      lastWireAsciiSig = "";
      console.log("Wire: device-bound text is ASCII again.");
    }
    const fitted = fitPayload(wire.payload);
    const line = fitted.line;
    if (fitted.dropped.length) {
      console.log(`Wire: payload was ${fitted.was} bytes against the device's 16000-byte line ` +
                  `buffer - sent ${fitted.bytes} after dropping ${fitted.dropped.join("; ")}`);
    }
    if (usbPort) usbPort.write(line);
    if (bleCharacteristic) await sendOverBle(line);
    console.log(
      `5h=${usage.fiveHourPct ?? "?"}% (resets ${usage.fiveHourResetInMin ?? "?"}m) ` +
        `7d=${usage.sevenDayPct ?? "?"}% (resets ${usage.sevenDayResetInMin ?? "?"}m) ` +
        `sessionTok=${usage.sessionTokens} weekTok=${usage.weekAllTokens} ` +
        `weekFableTok=${usage.weekFableTokens} weekFablePct=${usage.weekFablePct ?? "?"} ` +
        `src=${usage.quotaSource} ` +
        // qage/cxage are HOW OLD the two quota readings are, in seconds, and they
        // are here for the menu-bar app rather than for a human reading the log:
        // this tick line is the Mac's only view of the numbers, so without them
        // the menu can only show a percentage frozen by a long OAuth back-off as
        // though it were live. The device already gets the same two fields in its
        // payload; publishing them here keeps ONE source for the age instead of
        // letting the Mac re-derive it from a file mtime and drift.
        `qage=${usage.quotaAgeSec ?? "?"} cxage=${usage.cxAgeSec ?? "?"} ` +
        `codex=${usage.cxPct == null ? "?" : `${usage.cxPct}%`}` +
        `${usage.cxWin ? `/${Math.round(usage.cxWin / 1440)}d` : ""}` +
        `${usage.cxResetMin == null ? "" : ` (resets ${usage.cxResetMin}m)`} ` +
        `sessions(${usage.sessionsTotal})=${JSON.stringify(usage.sessions)} ` +
        `via=${[usbPort && "usb", bleCharacteristic && "ble"].filter(Boolean).join(",") || "none"}`
    );
  } catch (err) {
    console.error("Failed to read usage:", err.message);
  }
  lastTickCompleted = Date.now();
  // Only the current generation may reschedule - see the watchdog below.
  if (generation === tickGeneration) {
    setTimeout(() => tick(generation), POLL_INTERVAL_MS);
  }
}

// `lastWatchdogRun` is what tells a hung promise from a sleeping Mac: a stuck
// await leaves this interval running every 5s, while a suspend freezes it for
// as long as the stall. All 14 stalls in the run this was written from were
// sleeps - see watchdog.mjs for the measurement and the one known limitation.
let lastWatchdogRun = null;
setInterval(() => {
  const now = Date.now();
  const verdict = classifyStall({
    now,
    lastTickCompleted,
    lastWatchdogRun,
    thresholdMs: TICK_WATCHDOG_MS,
    intervalMs: POLL_INTERVAL_MS,
  });
  lastWatchdogRun = now;
  if (verdict.verdict === "ok") return;

  console.error(stallMessage(verdict));
  lastTickCompleted = Date.now();   // don't re-fire every interval while it recovers
  // Counted apart so the ledger's "watchdog fires" means HANGS. Folding sleeps
  // in is what made 236 fires look like 236 near-misses.
  if (verdict.hung) watchdogFires++;
  else suspendResumes++;
  // Restart the chain either way. After a suspend the pending setTimeout would
  // fire on its own, but kicking it here closes the window where the heartbeat
  // is stale and the menu bar shows nothing; the orphaned generation cannot
  // reschedule, so at worst this costs one duplicate tick.
  tick(++tickGeneration);           // orphans the stuck chain: its generation is now stale
}, POLL_INTERVAL_MS);

setInterval(async () => {
  try {
    const command = (await fs.readFile(COMMAND_TRIGGER_PATH, "utf8")).trim();
    await fs.rm(COMMAND_TRIGGER_PATH, { force: true });
    if (!command) return;
    // FORGET is a host-side command (from the menu-bar app), not forwarded to
    // the device: drop the BLE pin so we re-pair to whatever device is next
    // plugged in over USB (its HELLO re-pins us). The device keeps its own
    // secret until a new Mac re-provisions it; use the device's "Reset pairing"
    // button to wipe that side.
    // SELECT <name> — choose which remembered device to talk to. "SELECT" with
    // no name (or "SELECT auto") goes back to "any remembered device".
    // REMOTE on|off — may the device DECIDE prompts, or only display them?
    // Host-side only (the device learns it from the payload flag). "off" is
    // mirror mode: the hook never blocks, so the Mac keeps its own dialog.
    if (command === "REMOTE" || command.startsWith("REMOTE ")) {
      const arg = command.slice(6).trim().toLowerCase();
      const want = arg === "on" ? true : arg === "off" ? false : !remoteAnswer;
      if (want !== remoteAnswer) {
        remoteAnswer = want;
        await savePairing();
      }
      console.log(
        remoteAnswer
          ? "Remote answering ON - device and Mac both live; first answer wins."
          : "Remote answering OFF - the device mirrors prompts read-only; the Mac decides them."
      );
      return;
    }
    // ---- wireless pairing, host-side only and never forwarded ----
    // PAIRSCAN lists nearby devices; PAIRSTART <name> runs the exchange;
    // PAIRCONFIRM is the user clicking Match (the device still needs its own
    // CONFIRM tap); PAIRCANCEL abandons it. Each awaits nothing unbounded and
    // each failure path names its cause - a pairing that silently stops is the
    // worst outcome available here.
    // Each is run through pairCommand(), because THIS loop's outer catch is a
    // bare `catch {}` meaning "no trigger file waiting" - anything a pairing
    // handler threw would vanish into it, and a pairing that silently stops is
    // exactly the outcome this feature must not have.
    if (command === "PAIRSCAN") return pairCommand("PAIRSCAN", () => pairScanStart());
    if (command === "PAIRSTART" || command.startsWith("PAIRSTART "))
      return pairCommand("PAIRSTART", () => pairStart(command.slice(9).trim()));
    if (command === "PAIRCONFIRM") return pairCommand("PAIRCONFIRM", () => pairConfirm());
    if (command === "PAIRCANCEL") return pairCommand("PAIRCANCEL", () => pairCancel());
    if (command === "SELECT" || command.startsWith("SELECT ")) {
      const want = command.slice(6).trim();
      if (!want || want.toLowerCase() === "auto") {
        selectedDevice = "";
        await savePairing();
        console.log("Auth: selection cleared - will talk to any remembered device.");
        await rescanBle("selection cleared");
      } else if (!deviceEntry(want)) {
        console.error(`Auth: SELECT ${want} ignored - not a remembered device.`);
      } else if (want !== selectedDevice) {
        selectedDevice = want;
        await savePairing();
        console.log(`Auth: selected ${want}.`);
        await rescanBle(`switching to ${want}`);
      }
      return;
    }
    // FORGET [name] — drop one pairing (its key with it). With no name, forget
    // whichever device is current. The device keeps its own copy until a new Mac
    // re-provisions it or you use its own "Reset pairing" button.
    if (command === "FORGET" || command.startsWith("FORGET ")) {
      const want = command.slice(6).trim() || bleDeviceName || usbDeviceName || selectedDevice;
      if (!want) {
        console.log("Auth: FORGET ignored - no device to forget.");
        return;
      }
      const before = pairedDevices.length;
      pairedDevices = pairedDevices.filter((d) => d.name !== want);
      if (pairedDevices.length === before) {
        console.error(`Auth: FORGET ${want} ignored - not a remembered device.`);
        return;
      }
      if (selectedDevice === want) selectedDevice = "";
      await savePairing();
      console.log(`Auth: forgot ${want} (its key is gone); re-pairs on its next USB HELLO.`);
      if (bleDeviceName === want) await rescanBle(`forgot ${want}`);
      return;
    }
    // EMOJI <name> — set this Mac's icon (from the menu-bar app). Host-side only, like
    // FORGET: the device learns the icon from the payload's hostEmoji field, not from a
    // command.
    if (command.startsWith("EMOJI ")) {
      const want = resolveMacEmoji({ env: "", file: command.slice(6) });
      if (!want) {
        console.error(`Icon: EMOJI ignored - "${command.slice(6).trim()}" is not a known icon name.`);
        return;
      }
      let saved = true;
      await fs.writeFile(MAC_EMOJI_FILE, want).catch((err) => {
        saved = false;
        console.error(`Icon: could not save: ${err.message}`);
      });
      if (saved) {
        // Truthiness of DECKHAND_MAC_EMOJI is NOT the right test here: currentMacEmoji()
        // only lets the env var override when it resolves to a VALID name. A truthy-but-
        // invalid env (a typo'd name) does not override anything - the file wins on the
        // next tick - so claiming an override in that case tells the user their click had
        // no effect when it did. Route through the same resolver so the message can never
        // disagree with what actually displays.
        const envOverrides = !!resolveMacEmoji({ env: process.env.DECKHAND_MAC_EMOJI || "", file: "" });
        console.log(`Icon: this Mac is now ${want}${envOverrides ? " (but DECKHAND_MAC_EMOJI overrides it)" : ""}.`);
      }
      return;
    }
    console.log(`Sending command to device: ${command}`);
    if (usbPort) usbPort.write(command + "\n");
    if (bleCharacteristic) await sendOverBle(command + "\n");
  } catch {
    // no trigger file waiting, nothing to do
  }
}, 500);

await loadPairing();
console.log(
  `Auth: ${pairedDevices.length} paired device(s)${
    pairedDevices.length ? `: ${pairedDevices.map((d) => d.name).join(", ")}` : ""
  }.`
);
if (selectedDevice) console.log(`Auth: BLE pinned to ${selectedDevice}.`);
else if (pairedDevices.length) console.log("Auth: no device selected - will take any remembered one.");
console.log(
  remoteAnswer
    ? "Prompts: answerable on the device AND on the Mac (first answer wins)."
    : "Prompts: mirror only (shown on the device, decided on the Mac)."
);
connectUsb();
startBle();
// Kick the poller; it self-throttles on the persisted back-off AND last-attempt
// state, so a restart never bursts the endpoint's rate limiter even with a
// stale cache - no need to compute a startup delay here anymore.
console.log(
  VOICE_DELIVERY === "dispatch"
    ? "Voice: dictation will RUN HEADLESSLY (claude -p --resume). Set DECKHAND_VOICE_DELIVERY=clipboard to hand it to you instead."
    : "Voice: dictation goes to the CLIPBOARD + a notification; paste it yourself. Set DECKHAND_VOICE_DELIVERY=dispatch for the old headless behaviour."
);
// Checked at STARTUP, not only on first use. The old behaviour accepted a capture, spent
// the transfer, and failed at the end - so a missing dependency presented as "dictation
// is broken" rather than as something to install.
{
  const miss = voiceMissing();
  console.log(
    miss
      ? `Voice: DICTATION DISABLED - ${miss}. Run host/install-voice.sh to fix it.`
      : "Voice: whisper ready."
  );
}
setTimeout(pollOauthUsage, 0);
// Prune once at startup too: captures accumulate across runs, and a host that is only
// restarted occasionally would otherwise never clear anything left by the previous one.
pruneAudioCaptures().catch(() => {});
recordRunStart();
tick();
