#!/usr/bin/env node
// Checks the host's MULTI-DEVICE path: two boards cabled at once.
//
//   node host/multi-device-check.mjs
//   node host/multi-device-check.mjs --selftest
//
// WHY THIS EXISTS. `findUsbPort()` returned the FIRST matching port for a year
// and nothing noticed, because there was only ever one board on the desk. With
// two plugged in the host drove whichever the OS enumerated first and left the
// other announcing HELLO to nobody - and the log said `via=usb,ble`, which reads
// identically whether that is one board on two transports or two boards on one
// each. Every assertion below is aimed at a failure of that shape: silent, and
// invisible in the one line a human reads.
//
// HOW IT IS BUILT, and the four rules this repo makes checkers follow:
//
//  - It PARSES what it certifies. Every function under test is SLICED OUT of
//    index.mjs by source text and executed - there is no re-implementation here
//    to keep passing after the real code is deleted. Every cut asserts both
//    markers were found AND that the text still contains a token only the real
//    code has, so an empty slice cannot pass quietly.
//  - Assertions are bound to FUNCTION BODIES, not to the file. The structural
//    half below reads the body of the function it names (extractBody), so a copy
//    of the same expression living in a neighbouring function cannot satisfy it.
//  - Nothing here is vacuous. --selftest injects each fault into a COPY and the
//    run must FAIL, naming which assertion caught it. A fault that is caught by
//    a DIFFERENT assertion than the one meant to guard it is visible in that
//    name, which is the point of printing it.
//  - The two halves are reported separately: BEHAVIOUR runs the sliced code,
//    STRUCTURE reads its text. Behaviour alone cannot see a global creeping back
//    in; structure alone proves nothing runs.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(HERE, "index.mjs");

let pass = 0;
let structPass = 0;
const failures = [];
let quiet = false;
let inStructural = false;
function ok(name, cond) {
  if (cond) {
    if (inStructural) structPass++;
    else pass++;
    if (!quiet) console.log(`  ok    ${name}`);
  } else {
    failures.push(name);
    if (!quiet) console.log(`  FAIL  ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Slicing the real code out of index.mjs
// ---------------------------------------------------------------------------
function cut(src, from, to, must, label) {
  const a = src.indexOf(from);
  if (a === -1) throw new Error(`slice "${label}": start marker not found: ${from}`);
  const b = src.indexOf(to, a + from.length);
  if (b === -1) throw new Error(`slice "${label}": end marker not found: ${to}`);
  const text = src.slice(a, b);
  for (const m of must)
    if (!text.includes(m)) throw new Error(`slice "${label}" is missing ${m} - the anchors have moved`);
  return text;
}

// The body of ONE named function, brace-matched from its signature. A rule a
// NEIGHBOURING LINE can satisfy is not a rule: every structural assertion below
// reads one of these rather than the whole file, so deleting a guard and leaving
// a lookalike next door still fails.
function extractBody(src, signature) {
  const a = src.indexOf(signature);
  if (a === -1) throw new Error(`function not found: ${signature}`);
  const open = src.indexOf("{", a + signature.length - 1);
  if (open === -1) throw new Error(`no body for: ${signature}`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced body for: ${signature}`);
}

function buildSource(src) {
  const linkSlice = cut(src, "const usbLinks = [];", "// Which ports are ours.",
    ["const BLE_LINK", "const usbIdFor", "const viaKind", "const usbLinkFor",
     "function linkFor", "async function sendToLink", "const liveLinks",
     "async function broadcastToDevices", "function replyLinkFor", "function linkLabel"],
    "link registry");
  const candidateSlice = cut(src, "const USB_VID_CH340", "\nlet lastUsbScanSig",
    ["SerialPort.list()", "1a86", "303a", "SERIAL_PORT", "async function listUsbCandidates()"],
    "listUsbCandidates");
  // THE HALF THAT WAS MISSING. listUsbCandidates() returning both boards proves
  // nothing about anything turning them into links, and for three commits nothing
  // here read the loop that does: reverting `for (const p of candidates)` to
  // `candidates.slice(0, 1)` - THE ORIGINAL DEFECT - passed every assertion in this
  // file. So the scan, the open, the close handler and the HELLO pulse are sliced
  // out and EXECUTED against a stub SerialPort.
  const scanSlice = cut(src, 'let lastUsbScanSig = "";', "async function connectUsb()",
    ["async function scanUsbPorts()", "async function openUsbLink(portPath, vid = \"\")",
     "usbLinks.push(link);", "function armHelloPulse(link)", "usbPulsedPaths",
     "function usbIsCh340(link)", "USB_OPEN_TIMEOUT_MS", "forgetBatteryFor(battKey)",
     "WHOAMI_WAIT_MS"],
    "scan / open / pulse");
  const scrollKeySlice = cut(src, "const SCROLL_REQ_DEDUP_MS", "const scrollAckWaiters",
    ["const scrollSenderKey", "function scrollReqDropped", "const scrollReqSeen"],
    "history dedupe key");
  const nameSlice = cut(src, "function deviceNameFor(via) {", "\nasync function loadPairing()",
    ["deviceNameFor", "senderKey", "senderDescription"], "deviceNameFor");
  const dedupSlice = cut(src, "const DEVICE_DEDUP_MS", "// ---------- audio capture sink ----------",
    ["lastAnswerBySender", "lastPromptBySender", "function isDuplicateFrom"], "answer/prompt dedup");
  const battSlice = cut(src, "const battByDevice = new Map();", "// STARTS at 20",
    ["function batteryForHeartbeat"], "battery store");
  const primarySlice = cut(src, "function primaryUsbName()", "let bleDeviceName",
    ["usbLinks.some", "usbLinks.find"], "primaryUsbName");
  // The BATT arm of handleDeviceLine, lifted whole: whether a reading is stored
  // PER DEVICE is a property of the arm, not of the store it writes into.
  const battArm = cut(src, '  if (line.startsWith("BATT ")) {',
    "  // History request from the detail screen.",
    ["battByDevice.set", "senderKey(via)"], "BATT arm");

  const ascii = pathToFileURL(path.join(HERE, "to-ascii.mjs")).href;
  return `
import { toAscii } from ${JSON.stringify(ascii)};

// ---- stubs for everything the sliced code talks to ----
const __sent = [];                       // every write, as { link, text }
let bleCharacteristic = null;
let bleDeviceName = "";
let selectedDevice = "";
const __bleWrites = [];
async function sendOverBle(text, gapMs = 0) { __bleWrites.push({ text, gapMs }); }

// The sliced host code LOGS, and its refusals are part of what is asserted (a
// board left anonymous and a board never considered look identical from the Mac).
// A module-level \`console\` shadows the global for the whole module, so the lines
// are captured instead of drowning the checker's own output.
const __log = [];
const console = {
  log: (...a) => __log.push(a.join(" ")),
  error: (...a) => __log.push(a.join(" ")),
};

const BAUD_RATE = 115200;
function onAudioFrame() {}
const __deviceLines = [];
async function handleDeviceLine(line, via) { __deviceLines.push({ line, via }); }

// SerialPort is BOTH the list() under test in listUsbCandidates and the
// constructor openUsbLink calls, so the stub is a class with a static list().
// It presents exactly the surface the real code touches: an ASYNCHRONOUS
// open/error (a synchronous emit would fire before .once() is attached, which is
// the real ordering too), on()/once() for data/close/error, set() for the modem
// lines, and write().
let __ports = [];
const __opened = [];        // every port the code constructed, oldest first
let __openMode = "open";    // "open" | "error" | "hang" | "throw"
class SerialPort {
  static async list() { return __ports; }
  constructor(opts) {
    if (__openMode === "throw") throw new Error("stub: the constructor threw synchronously");
    this.path = opts.path;
    this.baudRate = opts.baudRate;
    this.destroyed = false;
    this.writable = true;
    this.sets = [];          // every set({dtr,rts}) - this is how a pulse is observed
    this.writes = [];
    // ONE ORDERED LOG OF BOTH. sets[] and writes[] each prove a thing happened
    // and neither can prove WHICH CAME FIRST - and "ask before you reboot" is an
    // ORDERING claim, not a pair of existence claims. A host that pulsed the board
    // and then asked WHOAMI would satisfy both arrays and be exactly the defect.
    this.ops = [];
    this._h = new Map();
    __opened.push(this);
    const mode = __openMode;
    if (mode !== "hang")
      setTimeout(() => {
        if (mode === "open") this.emit("open");
        else this.emit("error", new Error("stub: open failed"));
      }, 0);
  }
  on(ev, fn) {
    if (!this._h.has(ev)) this._h.set(ev, []);
    this._h.get(ev).push(fn);
    return this;
  }
  once(ev, fn) { return this.on(ev, fn); }
  emit(ev, arg) { for (const fn of [...(this._h.get(ev) ?? [])]) fn(arg); }
  set(opts, cb) { this.sets.push(opts); this.ops.push({ op: "set", opts }); cb(null); }
  write(text) { this.writes.push(text); this.ops.push({ op: "write", text }); return true; }
}

${primarySlice}
${linkSlice}
${candidateSlice}
${scrollKeySlice}
${scanSlice}
${nameSlice}
${dedupSlice}
${battSlice}

// The REAL BATT arm, lifted out of handleDeviceLine: which key a reading is
// filed under is part of what is under test.
function handleBattLine(line, via) {
${battArm}
}

// A fake serial port with the surface sendToLink actually touches - plus set(),
// because armHelloPulse() is real code here and a pulse is OBSERVED as a set().
function fakePort(link) {
  const p = {
    destroyed: false,
    writable: true,
    sets: [],
    writes: [],
    ops: [],
    write: (text) => { p.writes.push(text); p.ops.push({ op: "write", text }); __sent.push({ link, text }); return true; },
    set: (opts, cb) => { p.sets.push(opts); p.ops.push({ op: "set", opts }); cb(null); },
  };
  return p;
}
// The vid is derived from the id rather than defaulted, so a link added as
// "usb:usbmodem1101" is board 2 in every assertion that reads it, the way it is
// on the desk.
function addLink(id, name = "", vid = /usbmodem/.test(id) ? "303a" : "1a86") {
  const l = { id, kind: "usb", path: "/dev/tty." + id.slice(4), vid, name, scrollGen: 0,
              shot: null, audioCap: null, audioStream: null };
  l.port = fakePort(id);
  usbLinks.push(l);
  return l;
}

export const api = {
  usbLinks,
  addLink,
  clearLinks: () => { usbLinks.length = 0; },
  sent: __sent,
  bleWrites: __bleWrites,
  clearSent: () => { __sent.length = 0; __bleWrites.length = 0; },
  setPorts: (p) => { __ports = p; },
  setBle: (o) => {
    if ("characteristic" in o) bleCharacteristic = o.characteristic;
    if ("bleName" in o) bleDeviceName = o.bleName;
    if ("selected" in o) selectedDevice = o.selected;
  },
  // --- the scan / open / pulse surface ---
  scanUsbPorts, openUsbLink, armHelloPulse, usbOpening, usbIsCh340,
  setOpenMode: (m) => { __openMode = m; },
  resetPorts: () => { __opened.length = 0; __ports = []; usbPulsedPaths.clear(); },
  clearPulsedPaths: () => usbPulsedPaths.clear(),
  opened: __opened,
  portFor: (p) => [...__opened].reverse().find((x) => x.path === p) ?? null,
  log: () => __log,
  clearLog: () => { __log.length = 0; },
  HELLO_GRACE_MS, WHOAMI_WAIT_MS, USB_OPEN_TIMEOUT_MS, MAX_BATT_DEVICES, MAX_PULSED_PATHS,
  scrollSenderKey, scrollReqDropped, scrollReqSeen, SCROLL_REQ_DEDUP_MS,
  listUsbCandidates, usbIdFor, viaKind, usbLinkFor, linkFor, sendToLink,
  liveLinks, broadcastToDevices, replyLinkFor, linkLabel,
  deviceNameFor, senderKey, senderDescription,
  isDuplicateFrom, lastAnswerBySender, lastPromptBySender,
  handleBattLine, battByDevice, batteryForHeartbeat, primaryUsbName,
  forgetBatteryFor, boundBatteryStore,
  BLE_LINK,
};
`;
}

// EVERY LOAD IS A FRESH MODULE. The specifier used to be built from the SLICED
// text alone, so a fault injected OUTSIDE every slice produced a byte-identical
// data: URL and node handed back the CACHED module - with lastPromptBySender still
// holding the previous run's probe. Eleven of --selftest's faults were then all
// reported as "caught by" one unrelated DEDUPE assertion: every one of them was
// genuinely caught when run alone, but the name printed was a constant, and
// CLAUDE.md's whole point is that naming the catcher is what makes a failure
// readable. A nonce makes the specifier unique whatever the fault touched.
let __loadNonce = 0;
async function loadHost(src) {
  const body = `${buildSource(src)}\n// unique per load: ${++__loadNonce} ${process.pid}\n`;
  const url = "data:text/javascript;base64," + Buffer.from(body, "utf8").toString("base64");
  return (await import(url)).api;
}

// The scan/open/pulse sections need timers to run; a settle is one macrotask plus
// however long the case under test needs.
const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------
const B1 = "Deckhand-0528";  // board 1, CH340, /dev/tty.usbserial-10
const B2 = "Deckhand-C114";  // board 2, native USB CDC, /dev/tty.usbmodem1101

// The harness drives the pulse and the open timeout, so both are collapsed to
// something a test can wait on. They are the documented env overrides ("the env
// override exists to EXERCISE this path"), not a back door - and because the
// harness sets them, the DEFAULTS are asserted structurally by PARSING them out of
// index.mjs, which is the only half a transcribed literal would not cover.
const OPEN_TIMEOUT_MS = 40;
process.env.DECKHAND_HELLO_GRACE_MS = "0";
process.env.DECKHAND_WHOAMI_WAIT_MS = "5";
process.env.DECKHAND_USB_OPEN_TIMEOUT_MS = String(OPEN_TIMEOUT_MS);
delete process.env.DECKHAND_NO_USB_RESET;

async function main({ indexPath = INDEX } = {}) {
  const src = fs.readFileSync(indexPath, "utf8");
  const api = await loadHost(src);
  // Every module-level store the suite writes into, cleared UP FRONT. A fresh
  // module makes this redundant today; it is here so a future load that is not
  // fresh cannot make one section's leftovers into another section's failure.
  api.clearLinks();
  api.clearSent();
  api.clearLog();
  api.usbOpening.clear();
  api.clearPulsedPaths();
  api.battByDevice.clear();
  api.lastAnswerBySender.clear();
  api.lastPromptBySender.clear();
  api.scrollReqSeen.clear();

  // ---- 1. EVERY MATCHING PORT, NOT THE FIRST ----
  // The defect this whole file exists for. Note the assertion is on the COUNT
  // and on BOTH paths being present: "returns board 2" passes a check for
  // "returns something".
  {
    const twoBoards = [
      { path: "/dev/tty.debug-console" },
      { path: "/dev/tty.usbmodem1101", vendorId: "303a" },
      { path: "/dev/tty.usbserial-10", vendorId: "1a86" },
    ];
    api.setPorts(twoBoards);
    delete process.env.SERIAL_PORT;
    const got = await api.listUsbCandidates();
    const paths = got.map((p) => p.path);
    ok("PORTS: both boards are candidates, not just the first one the OS enumerated",
      got.length === 2 &&
      paths.includes("/dev/tty.usbmodem1101") &&
      paths.includes("/dev/tty.usbserial-10"));
    ok("PORTS: a non-board tty is not a candidate",
      !paths.includes("/dev/tty.debug-console"));

    // ORDER-INDEPENDENT. A `.find()` regression would still return board 1 when
    // board 1 is listed first, so the same case is run reversed: only opening
    // every match survives both orders.
    api.setPorts([...twoBoards].reverse());
    const rev = (await api.listUsbCandidates()).map((p) => p.path);
    ok("PORTS: still both when the OS enumerates them the other way round",
      rev.length === 2 && rev.includes("/dev/tty.usbmodem1101") && rev.includes("/dev/tty.usbserial-10"));

    process.env.SERIAL_PORT = "/dev/tty.usbserial-10";
    const pinned = (await api.listUsbCandidates()).map((p) => p.path);
    ok("PORTS: SERIAL_PORT still RESTRICTS to exactly one - the documented escape hatch",
      pinned.length === 1 && pinned[0] === "/dev/tty.usbserial-10");
    delete process.env.SERIAL_PORT;

    ok("PORTS: a link id is derived from the port PATH, so it exists before any HELLO",
      api.usbIdFor("/dev/tty.usbserial-10") === "usb:usbserial-10" &&
      api.usbIdFor("/dev/cu.usbmodem1101") === "usb:usbmodem1101");
    ok("PORTS: the two boards get DIFFERENT ids",
      api.usbIdFor("/dev/tty.usbserial-10") !== api.usbIdFor("/dev/tty.usbmodem1101"));
  }

  // ---- 2. FAN-OUT: ONE COPY PER LINK, AND NO DEVICE GETS MORE THAN BEFORE ----
  {
    api.clearLinks();
    api.clearSent();
    const l1 = api.addLink("usb:usbserial-10", B1);
    const l2 = api.addLink("usb:usbmodem1101", B2);
    api.setBle({ characteristic: {}, bleName: B2 });

    await api.broadcastToDevices("PAYLOAD\n");
    const perLink = (id) => api.sent.filter((s) => s.link === id).length;
    ok("FAN-OUT: board 1 receives the payload at all - it received nothing before this change",
      perLink(l1.id) === 1);
    ok("FAN-OUT: board 2 receives exactly one USB copy",
      perLink(l2.id) === 1);
    ok("FAN-OUT: the BLE peer receives exactly one copy",
      api.bleWrites.length === 1);
    ok("FAN-OUT: three links means THREE writes, never four - the fan-out is per link, " +
       "not per device times transports",
      api.sent.length + api.bleWrites.length === 3);
    // The rule stated as the device sees it. Board 2 is on two links and has
    // always had to tolerate two copies (KBTEST/KBPROBE/KBBUBBLE/POWERPROBE
    // dedupe for exactly this); board 1 adds a link, not a copy.
    const copiesTo = (name) =>
      api.sent.filter((s) => api.usbLinkFor(s.link)?.name === name).length +
      (api.BLE_LINK.name === name ? api.bleWrites.length : 0);
    ok("FAN-OUT: no device receives more than the two copies a cabled BLE device always got",
      copiesTo(B1) === 1 && copiesTo(B2) === 2);

    // A dead port must not silently eat a device's copy.
    api.clearSent();
    l1.port.writable = false;
    const sent = await api.broadcastToDevices("PAYLOAD\n");
    ok("FAN-OUT: a link whose port is not writable is REPORTED as not sent, not counted",
      sent === 2 && api.sent.filter((s) => s.link === l1.id).length === 0);
    l1.port.writable = true;
  }

  // ---- 3. IDENTITY: THE HOST REFUSES TO GUESS WHICH BOARD SPOKE ----
  {
    api.clearLinks();
    const l1 = api.addLink("usb:usbserial-10", B1);
    const l2 = api.addLink("usb:usbmodem1101", B2);
    api.setBle({ characteristic: {}, bleName: B2, selected: B2 });

    ok("IDENTITY: each link answers with ITS OWN name",
      api.deviceNameFor(l1.id) === B1 && api.deviceNameFor(l2.id) === B2);
    ok("IDENTITY: ble answers with the device BLE connected to",
      api.deviceNameFor("ble") === B2);
    ok("IDENTITY: the pairing link is still attributed to NO paired device",
      api.deviceNameFor("pair") === "");

    // The dangerous case: a link that never saw a HELLO, with a second board
    // attached. Guessing `selectedDevice` here attributes one board's ANSWER to
    // the other - it fails closed on the HMAC, but the refusal names the wrong
    // subject, which is the defect class this repo keeps paying for.
    l1.name = "";
    ok("IDENTITY: an UNNAMED link with a second board attached resolves to nothing - " +
       "it must not inherit the selected device",
      api.deviceNameFor(l1.id) === "");
    ok("IDENTITY: an unnamed link still has a distinct sender key, so two unknown " +
       "boards are two senders",
      api.senderKey(l1.id) !== api.senderKey(l2.id));
    ok("IDENTITY: a refusal on an unnamed link names the LINK it arrived on",
      api.senderDescription(l1.id, "").includes(l1.id));

    // With ONE link the old fallback survives, because there is nothing to
    // confuse it with and removing it would break a host that attached mid-run.
    api.clearLinks();
    const only = api.addLink("usb:usbserial-10", "");
    api.setBle({ selected: B1 });
    ok("IDENTITY: with ONE usb link the pre-existing fallback to the selection is kept",
      api.deviceNameFor(only.id) === B1);
  }

  // ---- 4. THE DEDUPE KEYS ON THE SENDER ----
  // The subtlest correctness risk in the whole change: a wrong answer reaching
  // Claude is the worst outcome available here.
  {
    api.clearLinks();
    api.addLink("usb:usbmodem1101", B2);
    api.addLink("usb:usbserial-10", B1);
    api.setBle({ characteristic: {}, bleName: B2, selected: B2 });
    api.lastAnswerBySender.clear();

    const line = "ANSWER abc123def456 4711 0 0123456789abcdef";
    // One device, two transports: the second copy is the duplicate this guard
    // has always existed for.
    ok("DEDUPE: board 2's own USB copy is taken",
      api.isDuplicateFrom(api.lastAnswerBySender, "usb:usbmodem1101", line) === false);
    ok("DEDUPE: the SAME device's BLE copy of the SAME line is dropped",
      api.isDuplicateFrom(api.lastAnswerBySender, "ble", line) === true);
    // Two devices, same line: entirely ordinary (the same option index on the
    // same prompt) and MUST NOT collapse.
    ok("DEDUPE: a DIFFERENT board sending the SAME line is NOT a duplicate",
      api.isDuplicateFrom(api.lastAnswerBySender, "usb:usbserial-10", line) === false);
    ok("DEDUPE: and that board's own second copy still is",
      api.isDuplicateFrom(api.lastAnswerBySender, "usb:usbserial-10", line) === true);
    // A different line from the same device is a different answer.
    ok("DEDUPE: a different line from the same board is taken",
      api.isDuplicateFrom(api.lastAnswerBySender, "usb:usbserial-10", line + "x") === false);


    // THE REACHABLE DEFECT, and the reason the map is a map. Two boards cannot
    // actually emit the SAME answer line - the HMAC is signed with each device's
    // own key - so the assertion above is the mechanism, not the incident. The
    // incident is INTERLEAVING: with one last-writer-wins slot, board 1 speaking
    // between board 2's two transports moves the slot off board 2's line, and
    // board 2's second copy then sails through as new. It is rejected downstream
    // because the nonce is single-use, which presents in the log as an
    // authentication failure on an answer that was perfectly good - exactly the
    // noise this guard was added to stop.
    api.lastAnswerBySender.clear();
    const a2 = "ANSWER abc123def456 4711 0 aaaaaaaaaaaaaaaa";  // board 2 signs with its key
    const a1 = "ANSWER abc123def456 4711 0 bbbbbbbbbbbbbbbb";  // board 1 signs with its own
    ok("DEDUPE: board 2's USB copy is taken",
      api.isDuplicateFrom(api.lastAnswerBySender, "usb:usbmodem1101", a2) === false);
    ok("DEDUPE: board 1's own answer, arriving between board 2's two copies, is taken",
      api.isDuplicateFrom(api.lastAnswerBySender, "usb:usbserial-10", a1) === false);
    ok("DEDUPE: board 2's BLE copy is STILL a duplicate - another board speaking in " +
       "between must not un-deduplicate it",
      api.isDuplicateFrom(api.lastAnswerBySender, "ble", a2) === true);

    // Messages and answers must not suppress each other. The precondition is
    // established HERE rather than relied on from an earlier case: board 2's
    // newest ANSWER is this exact line, so if the two maps were one object the
    // prompt would be swallowed as a duplicate of it. An earlier version cleared
    // the prompt map first, which made this pass with the maps SHARED - the
    // selftest caught that, and it is the reason this reads the way it does.
    const shared = "SHARED-LINE-PROBE";
    ok("DEDUPE: board 2's answer of the probe line is taken",
      api.isDuplicateFrom(api.lastAnswerBySender, "usb:usbmodem1101", shared) === false);
    ok("DEDUPE: the prompt map is separate, so a message is not swallowed by an answer",
      api.lastAnswerBySender.get(api.senderKey("usb:usbmodem1101"))?.line === shared &&
      api.isDuplicateFrom(api.lastPromptBySender, "usb:usbmodem1101", shared) === false);
  }

  // ---- 5. REPLIES GO BACK TO THE BOARD THAT ASKED ----
  {
    api.clearLinks();
    const l2 = api.addLink("usb:usbmodem1101", B2);
    const l1 = api.addLink("usb:usbserial-10", B1);
    api.setBle({ characteristic: {}, bleName: B2 });

    ok("REPLY: board 1's request is answered on board 1's cable",
      api.replyLinkFor(l1.id) === l1);
    ok("REPLY: board 2's request is answered on board 2's cable",
      api.replyLinkFor(l2.id) === l2);
    ok("REPLY: a BLE request from a CABLED device is answered on THAT device's cable - " +
       "the old USB-beats-BLE optimisation, now scoped to the right device",
      api.replyLinkFor("ble") === l2);

    // ...and when the BLE peer is NOT cabled, the reply must stay on BLE rather
    // than being pushed down some other board's wire.
    api.setBle({ bleName: "Deckhand-FFFF" });
    ok("REPLY: a BLE request from a device with no cable stays on BLE",
      api.replyLinkFor("ble")?.kind === "ble");
    api.setBle({ bleName: B2 });

    // Writes actually land on the link they were routed to.
    api.clearSent();
    await api.sendToLink(api.replyLinkFor(l1.id), "HIST-FOR-BOARD-1\n");
    ok("REPLY: the write lands on board 1's port and nowhere else",
      api.sent.length === 1 && api.sent[0].link === l1.id && api.bleWrites.length === 0);
  }

  // ---- 6. TWO BATTERIES, TWO READINGS ----
  {
    api.clearLinks();
    api.addLink("usb:usbmodem1101", B2);
    api.addLink("usb:usbserial-10", B1);
    api.setBle({ characteristic: {}, bleName: B2, selected: B2 });
    api.battByDevice.clear();

    api.handleBattLine("BATT mv=4162 pct=96 state=2 left=-1", "usb:usbmodem1101");
    api.handleBattLine("BATT mv=4230 pct=100 state=3 left=-1", "usb:usbserial-10");
    ok("BATTERY: two boards produce TWO readings, not one overwriting the other",
      api.battByDevice.size === 2);
    const byName = new Map([...api.battByDevice.values()].map((b) => [b.device, b]));
    ok("BATTERY: each reading carries the device it came from",
      byName.get(B1)?.pct === 100 && byName.get(B2)?.pct === 96);
    ok("BATTERY: the heartbeat publishes the SELECTED device's reading, not the last to speak",
      api.batteryForHeartbeat().device === B2 && api.batteryForHeartbeat().pct === 96);
    api.setBle({ selected: B1 });
    ok("BATTERY: selecting the other board moves the heartbeat to ITS reading",
      api.batteryForHeartbeat().device === B1 && api.batteryForHeartbeat().pct === 100);
    // A single unnamed board must still show a battery, which is how this
    // behaved before there was any per-device store at all.
    api.clearLinks();
    api.addLink("usb:usbserial-10", "");
    api.battByDevice.clear();
    api.setBle({ characteristic: null, bleName: "", selected: "" });
    api.handleBattLine("BATT mv=4000 pct=50 state=1 left=-1", "usb:usbserial-10");
    ok("BATTERY: an unnamed single board still publishes a reading (the pre-existing behaviour)",
      api.batteryForHeartbeat()?.pct === 50);

    // BOUNDED, and not only pruned on close: an UNNAMED link keys on its port path,
    // CLAUDE.md's own note is that ports renumber, and a key that renumbered is one
    // no close handler will ever name again. Without a ceiling the heartbeat's
    // `batts` array grows for the life of the process and lists phantom boards.
    api.clearLinks();
    api.battByDevice.clear();
    for (let i = 0; i < api.MAX_BATT_DEVICES + 5; i++) {
      const l = api.addLink(`usb:usbserial-1${i}`, "");
      api.handleBattLine(`BATT mv=4000 pct=${i} state=1 left=-1`, l.id);
    }
    ok(`BATTERY: ${api.MAX_BATT_DEVICES + 5} renumbered ports leave at most MAX_BATT_DEVICES ` +
       `(${api.MAX_BATT_DEVICES}) readings - the store is a ceiling, not a history`,
      api.battByDevice.size === api.MAX_BATT_DEVICES);
    ok("BATTERY: and it is the OLDEST that was evicted, so the freshest boards survive",
      [...api.battByDevice.values()].every((b) => b.pct >= 5));

    // A reading is NOT dropped while the same device is still reachable elsewhere:
    // a cabled board that is also on BLE keeps its battery when the cable goes.
    api.clearLinks();
    api.battByDevice.clear();
    const cabled = api.addLink("usb:usbmodem1101", B2);
    api.setBle({ characteristic: {}, bleName: B2, selected: B2 });
    api.handleBattLine("BATT mv=4162 pct=96 state=2 left=-1", cabled.id);
    api.clearLinks(); // the cable came out
    api.forgetBatteryFor(B2);
    ok("BATTERY: a reading is KEPT while the same device is still reachable on another link",
      api.battByDevice.size === 1);
    api.setBle({ characteristic: null, bleName: "" });
    api.forgetBatteryFor(B2);
    ok("BATTERY: and DROPPED once nothing can refresh it",
      api.battByDevice.size === 0);
  }

  // ---- 7. THE LOG CAN TELL THE BOARDS APART ----
  // `via=usb,ble` read identically whether that was one board on two transports
  // or two boards on one each. That ambiguity is what hid the second board, so
  // it is asserted rather than left to taste.
  {
    api.clearLinks();
    api.addLink("usb:usbmodem1101", B2);
    api.addLink("usb:usbserial-10", B1);
    api.setBle({ characteristic: {}, bleName: B2 });
    const tags = api.liveLinks().map((l) => api.linkLabel(l.id));
    ok("LOG: the tick's via= names three DISTINCT links",
      new Set(tags).size === 3);
    ok("LOG: a named link is labelled by its device, so a device line is attributable",
      tags.includes(`usb:${B1}`) && tags.includes(`usb:${B2}`));
    api.usbLinkFor("usb:usbserial-10").name = "";
    ok("LOG: an unnamed link falls back to its port, never to another board's name",
      api.linkLabel("usb:usbserial-10") === "usb:usbserial-10");
  }

  // ---- 8. THE SCAN AND THE OPEN: CANDIDATES BECOME LINKS ----
  // Section 1 proves listUsbCandidates() returns both boards. It proves NOTHING
  // about anything turning them into links, and that gap was the whole hole in this
  // file: reverting `for (const p of candidates)` to `candidates.slice(0, 1)` - THE
  // ORIGINAL DEFECT, one board driven and the other left announcing HELLO to nobody
  // - passed every assertion here. So the real scanUsbPorts() and openUsbLink() are
  // executed against a stub SerialPort.
  {
    api.clearLinks();
    api.usbOpening.clear();
    api.resetPorts();
    api.clearLog();
    api.setOpenMode("open");
    api.battByDevice.clear();
    api.setBle({ characteristic: null, bleName: "", selected: "" });
    api.setPorts([
      { path: "/dev/cu.usbmodem1101", vendorId: "303a" },
      { path: "/dev/cu.usbserial-10", vendorId: "1a86" },
    ]);
    await api.scanUsbPorts();
    await settle();

    ok("SCAN: BOTH candidates become live links - the scan opens every port it found, " +
       "not the first one the OS enumerated",
      api.usbLinks.length === 2 &&
      api.usbLinks.map((l) => l.path).sort().join(",") ===
        "/dev/cu.usbmodem1101,/dev/cu.usbserial-10");
    ok("SCAN: each link carries the vendor id it was opened with, so the two boards are " +
       "distinguishable BEFORE any HELLO",
      api.usbLinkFor("usb:usbmodem1101")?.vid === "303a" &&
      api.usbLinkFor("usb:usbserial-10")?.vid === "1a86");
    ok("SCAN: no path is left marked in-flight once the opens have settled",
      api.usbOpening.size === 0);

    // A re-scan every 3 seconds must reopen NOTHING that is already open. Without
    // the guard usbLinks and the file-descriptor table grow for the life of the
    // process - the days-long-leak shape.
    await api.scanUsbPorts();
    await settle();
    ok("SCAN: a second scan over the same ports opens nothing - links and descriptors " +
       "do not grow every 3 seconds",
      api.usbLinks.length === 2 && api.opened.length === 2);

    // The close handler is the other half: without the splice a dead link keeps
    // occupying the path and the scan refuses to reopen it forever.
    api.handleBattLine("BATT mv=4162 pct=96 state=2 left=-1", "usb:usbmodem1101");
    api.handleBattLine("BATT mv=4230 pct=100 state=3 left=-1", "usb:usbserial-10");
    ok("CLOSE: two live links have filed two battery readings (the precondition)",
      api.battByDevice.size === 2);
    const closing = api.portFor("/dev/cu.usbserial-10");
    ok("CLOSE: board 1's port was actually opened, so the close path can be exercised at all " +
       "(asserted first: every assertion below it would otherwise pass vacuously or throw)",
      !!closing);
    closing?.emit("close");
    ok("CLOSE: a closed port is spliced out of usbLinks",
      api.usbLinks.length === 1 && api.usbLinks[0].path === "/dev/cu.usbmodem1101");
    ok("CLOSE: and that link's battery reading is DROPPED - nothing used to delete one, " +
       "so the heartbeat republished every dead board every 5 seconds forever",
      api.battByDevice.size === 1 && [...api.battByDevice.values()][0].pct === 96);
    await api.scanUsbPorts();
    await settle();
    ok("CLOSE: the next scan reopens the freed path, so a replug comes back",
      api.usbLinks.length === 2 && api.opened.length === 3);
  }

  // ---- 9. THE HELLO PULSE REACHES BOARD 1 AND ONLY BOARD 1 ----
  // `{dtr:false, rts:true}` is also esptool's USB-Serial-JTAG reset, so it reboots
  // board 2 as well - and on board 2 the port IS the SoC, so the reset drops the USB
  // device, the link is spliced, and `link.pulsed` dies with it. The user's cost is
  // a board rebooted six seconds after a watchdog restart, losing an open answer
  // window or an in-flight capture.
  {
    api.clearLinks();
    api.usbOpening.clear();
    api.resetPorts();
    api.clearLog();
    api.setOpenMode("open");
    api.setPorts([
      { path: "/dev/cu.usbmodem1101", vendorId: "303a" },
      { path: "/dev/cu.usbserial-10", vendorId: "1a86" },
    ]);
    await api.scanUsbPorts();
    // HELLO_GRACE_MS is 0 and DECKHAND_WHOAMI_WAIT_MS is 5, so by now the host has
    // asked, waited, and pulsed if it was going to.
    await settle(120);
    const b1port = api.portFor("/dev/cu.usbserial-10");
    const b2port = api.portFor("/dev/cu.usbmodem1101");
    ok("PULSE: both boards' ports were actually opened (asserted first, so nothing below " +
       "passes vacuously over a port that is not there)",
      !!b1port && !!b2port);

    // ---- ASK BEFORE REBOOTING ----
    // HELLO is a boot-only 15s burst, so a host that attached to an already-running
    // board never hears it, and an unnamed link cannot authenticate an ANSWER. The
    // old cure was to reboot the board into a fresh burst; asking costs nothing and
    // works on both boards, and on board 2 the reboot was never available at all.
    const firstWhoami = (port) => port.ops.findIndex((o) => o.op === "write" && o.text === "WHOAMI\n");
    const firstSet = (port) => port.ops.findIndex((o) => o.op === "set");
    ok("WHOAMI: an anonymous CH340 link is ASKED its name",
      !!b1port && firstWhoami(b1port) >= 0);
    ok("WHOAMI: an anonymous native-USB link is asked too - it is the board the pulse can " +
       "never help, so asking is its ONLY route out of anonymity",
      !!b2port && firstWhoami(b2port) >= 0);
    ok("WHOAMI: the ask comes BEFORE the reset pulse on the same port - the ordering IS the " +
       "fix, since a reboot costs an open answer window and an ask costs one line",
      !!b1port && firstSet(b1port) >= 0 && firstWhoami(b1port) < firstSet(b1port));
    ok("WHOAMI: and the ask is logged with the reason HELLO was never heard, so a silent " +
       "board and a board nobody asked are told apart from the Mac",
      api.log().some((l) => /Asking it WHOAMI/.test(l) && /boot-only/.test(l)));
    ok("WHOAMI: an unanswered ask NAMES THE AMBIGUITY it cannot resolve - firmware older " +
       "than WHOAMI ignores it in silence, and an answer in flight is also silence",
      api.log().some((l) => /did not answer WHOAMI/.test(l) && /older/.test(l)));

    ok("PULSE: board 1's unnamed CH340 link IS pulsed - node does not drive that chip's " +
       "modem lines, so without this the board never announces its name and cannot answer",
      !!b1port && b1port.sets.length > 0 && b1port.sets[0].rts === true && b1port.sets[0].dtr === false);
    ok("PULSE: board 2's native-USB link is NOT pulsed - there that sequence is esptool's " +
       "reset, which reboots a healthy board and drops the port mid-answer",
      !!b2port && b2port.sets.length === 0);
    ok("PULSE: and the refusal NAMES ITS CAUSE - from the Mac, a board deliberately left " +
       "anonymous and a board nothing ever considered look identical",
      api.log().some((l) => /usbmodem1101/.test(l) && /not a CH340/.test(l)));

    // The half a vendor gate alone would not fix. On a board whose port DOES go away
    // (which is what the reset causes), `link.pulsed` dies with the link object, so a
    // reopen arms a fresh pulse: "once per link" becomes a loop.
    api.clearLog();
    b1port?.emit("close");
    await api.scanUsbPorts();
    await settle(120); // the reopened link is asked WHOAMI first, and only then refused the pulse
    const again = api.portFor("/dev/cu.usbserial-10");
    ok("PULSE: a link closed and REOPENED on the same path is not pulsed a second time - " +
       "link.pulsed dies with the link, the path record outlives it",
      !!again && again !== b1port && again.sets.length === 0);
    ok("PULSE: and that refusal names its cause too",
      api.log().some((l) => /already been pulsed once/.test(l)));

    // A BOARD THAT ANSWERS IS NEVER REBOOTED. The port answers WHOAMI the way real
    // firmware does - by naming itself on the link - rather than the test poking
    // link.name in from outside, so the arm under test is the one that reads it.
    api.clearLinks();
    api.clearPulsedPaths();
    api.clearLog();
    const answers = api.addLink("usb:usbserial-10", ""); // a CH340: the pulse IS available here
    const rawWrite = answers.port.write;
    answers.port.write = (text) => {
      const r = rawWrite(text);
      if (text === "WHOAMI\n") answers.name = B1;
      return r;
    };
    api.armHelloPulse(answers);
    await settle(120);
    ok("WHOAMI: a board that answers is NOT pulsed - the whole point, since it is a CH340 " +
       "and every older rule would have rebooted it",
      answers.port.sets.length === 0);
    ok("WHOAMI: and the answer is logged as such, naming the board and saying no reset was needed",
      api.log().some((l) => /answered WHOAMI/.test(l) && l.includes(B1)));
    ok("WHOAMI: an answered ask leaves no reset refusal behind either - a named board is " +
       "neither rebooted nor reported as unauthenticatable",
      !api.log().some((l) => /Pulsing RTS/.test(l) || /not a CH340/.test(l)));

    // A link that HAS a name is never pulsed at all, and neither is one that has
    // already been spliced out. Armed directly so the grace period is not a race.
    api.clearLinks();
    api.clearPulsedPaths();
    const named = api.addLink("usb:usbserial-10", B1);
    api.armHelloPulse(named);
    await settle(20);
    ok("PULSE: a link that already has a name is never pulsed - a healthy board is not rebooted",
      named.port.sets.length === 0);

    api.clearLinks();
    api.clearPulsedPaths();
    const gone = api.addLink("usb:usbserial-10", "");
    api.armHelloPulse(gone);
    api.clearLinks(); // the close handler spliced it before the timer fired
    await settle(20);
    ok("PULSE: a link already spliced out of usbLinks is not pulsed", gone.port.sets.length === 0);

    api.clearLinks();
    api.clearPulsedPaths();
    api.clearLog();
    const off = api.addLink("usb:usbserial-10", "");
    process.env.DECKHAND_NO_USB_RESET = "1";
    api.armHelloPulse(off);
    await settle(120);
    delete process.env.DECKHAND_NO_USB_RESET;
    ok("PULSE: DECKHAND_NO_USB_RESET=1 turns it off entirely - the documented escape hatch " +
       "for anyone who would rather have an anonymous link than a reboot",
      off.port.sets.length === 0);
    ok("WHOAMI: DECKHAND_NO_USB_RESET=1 still ASKS - that variable buys \"do not reboot my " +
       "board\", and the anonymity was only ever the price of the escape hatch",
      off.port.writes.includes("WHOAMI\n"));
    ok("WHOAMI: and that refusal names its cause too, rather than the silent early return " +
       "it used to be",
      api.log().some((l) => /DECKHAND_NO_USB_RESET=1/.test(l) && /NOT be pulsed/.test(l)));
  }

  // ---- 10. A FAILED, HUNG OR THROWING OPEN RELEASES THE PATH ----
  // usbOpening is what stops a 3s re-scan double-opening a port. A path left in it
  // is a board that is dark for the life of the process, with nothing in the log but
  // a stuck "connecting to".
  {
    api.clearLinks();
    api.usbOpening.clear();
    api.resetPorts();
    api.clearLog();
    api.setPorts([{ path: "/dev/cu.usbserial-10", vendorId: "1a86" }]);

    api.setOpenMode("error");
    await api.scanUsbPorts();
    await settle();
    ok("OPEN: a port that ERRORS on open releases its path, so the next scan retries it",
      api.usbLinks.length === 0 && api.usbOpening.size === 0);
    ok("OPEN: and the failure names its cause AND says the path was released",
      api.log().some((l) => /connect to \/dev\/cu\.usbserial-10 failed/.test(l) && /released/.test(l)));

    api.setOpenMode("hang");
    api.clearLog();
    await api.scanUsbPorts();
    await settle();
    ok("OPEN: an open that emits neither \"open\" nor \"error\" is held in flight, not lost",
      api.usbOpening.has("/dev/cu.usbserial-10"));
    await settle(OPEN_TIMEOUT_MS + 40);
    ok("OPEN: and it TIMES OUT and releases the path - without a bound that board is dark " +
       "for the life of the process",
      api.usbOpening.size === 0 && api.usbLinks.length === 0);
    ok("OPEN: the timeout names itself rather than logging nothing",
      api.log().some((l) => /no "open" and no "error"/.test(l)));

    api.setOpenMode("throw");
    api.clearLog();
    await api.scanUsbPorts();
    await settle();
    ok("OPEN: a constructor that throws SYNCHRONOUSLY still releases the path - " +
       "the un-awaited call had no .catch() and pinned it forever",
      api.usbOpening.size === 0 && api.usbLinks.length === 0);
    ok("OPEN: and that failure names its cause",
      api.log().some((l) => /usbserial-10/.test(l) && /released/.test(l)));
    api.setOpenMode("open");
  }

  // ---- 11. THE HISTORY DEDUPE MUST NOT SPLIT ONE DEVICE IN TWO ----
  // senderKey() falls back to the LINK ID for an unnamed link. That is right for an
  // ANSWER and wrong here: one device that is cabled (unnamed) and on BLE then keys
  // as two senders, the request is served twice, and the `since:` arm's own comment
  // says the reader shows every new message doubled.
  {
    api.clearLinks();
    api.scrollReqSeen.clear();
    const anon = api.addLink("usb:usbmodem1101", "");  // host attached mid-run: no HELLO seen
    api.addLink("usb:usbserial-10", B1);               // a second cable, so deviceNameFor refuses to guess
    api.setBle({ characteristic: {}, bleName: B2, selected: B2 });

    ok("HISTORY: senderKey() would split that device in two (the precondition this " +
       "assertion exists for)",
      api.senderKey(anon.id) !== api.senderKey("ble"));
    ok("HISTORY: the history key does NOT - while any usb link is anonymous every sender " +
       "collapses, so a device's two transports cannot be served twice into one reader",
      api.scrollSenderKey(anon.id) === api.scrollSenderKey("ble") &&
      api.scrollSenderKey("usb:usbserial-10") === api.scrollSenderKey("ble"));

    // ...and once every link has a name, per-sender keying comes back, so two boards
    // asking for the same session are each served.
    anon.name = B2;
    ok("HISTORY: with every link named, two boards are two senders again and neither is " +
       "answered with silence",
      api.scrollSenderKey("usb:usbserial-10") === B1 &&
      api.scrollSenderKey(anon.id) === B2 &&
      api.scrollSenderKey(anon.id) === api.scrollSenderKey("ble"));

    api.clearLog();
    api.scrollReqDropped(anon.id, "k|s|chat|tail:65536");
    ok("HISTORY: a dropped duplicate is LOGGED with its cause and its key - silence and " +
       "\"impossible here\" look identical from the Mac",
      api.log().some((l) => /duplicate history request/.test(l) && /k\|s\|chat\|tail:65536/.test(l)));
  }

  // ---- 12. STRUCTURE: what running the code cannot see ----
  // A module-level capture buffer creeping back in still PASSES every behavioural
  // assertion above, because nothing above captures a screenshot. These read the
  // BODY of the function they name.
  inStructural = true;
  {
    ok("STRUCTURE: no module-level shot/audio capture globals survive - two boards " +
       "captured at once would interleave into one buffer",
      !/^let shotCapture\b/m.test(src) &&
      !/^let audioCapture\b/m.test(src) &&
      !/^let audioStream\b/m.test(src));
    ok("STRUCTURE: no module-level usbPort/usbDeviceName survive",
      !/^let usbPort\b/m.test(src) && !/^let usbDeviceName\b/m.test(src));

    const finishShot = extractBody(src, "async function finishShot(link)");
    ok("STRUCTURE: finishShot reads the capture off ITS LINK",
      /link\.shot/.test(finishShot));
    ok("STRUCTURE: finishShot names the device in the file it writes, so two captures " +
       "cannot be told apart only by their dimensions",
      /link\.name \|\| link\.id/.test(finishShot));

    const onFrame = extractBody(src, "function onAudioFrame(seq, payload, link)");
    ok("STRUCTURE: an audio ack goes back down the link the frame came up",
      /sendToLink\(link,/.test(onFrame) && /link\.audioStream/.test(onFrame));

    const hello = extractBody(src, "async function handleDeviceLine(line, via, pairGen = 0)");
    ok("STRUCTURE: HELLO is matched on the KIND of the via, not the literal \"usb\" - " +
       "a literal is false for every real link id and would skip the arm in silence",
      /viaKind\(via\) === "usb"/.test(hello) && !/via === "usb"/.test(hello));
    ok("STRUCTURE: PROVISION is written to the link the HELLO arrived on, never broadcast - " +
       "a key is per device",
      /sendToLink\(\s*helloLink,/.test(hello));

    const pairOurs = extractBody(src, "function pairReplyIsOurs(ex, via, gen)");
    ok("STRUCTURE: a pairing reply on usb is matched against THAT LINK's name",
      /usbLinkFor\(via\)/.test(pairOurs) && /l\.name === ex\.name/.test(pairOurs));

    const scroll = extractBody(src, "async function sendScrollback(id, filter, maxBytes, link)");
    ok("STRUCTURE: a scrollback fetch is superseded only by a later fetch TO THE SAME BOARD",
      /gen !== link\.scrollGen/.test(scroll));
    ok("STRUCTURE: the chunk budget is THIS link's transport, not \"is any usb port open\"",
      /const onUsb = link\?\.kind === "usb"/.test(scroll) &&
      /onUsb \? SCROLL_WIRE_CHUNK_BYTES/.test(scroll) &&
      !/usbPort \? SCROLL_WIRE_CHUNK_BYTES/.test(scroll));

    // --- the scan and the open, read as text as well as run ---
    const scan = extractBody(src, "async function scanUsbPorts()");
    ok("STRUCTURE: scanUsbPorts loops over EVERY candidate - the original defect was " +
       "taking one of them",
      /for \(const p of candidates\)/.test(scan) &&
      !/candidates\.slice/.test(scan) && !/candidates\[0\]/.test(scan) && !/candidates\.find/.test(scan));
    ok("STRUCTURE: scanUsbPorts skips a path that is already open OR already opening - " +
       "without it the same port is reopened every 3s and descriptors leak",
      /usbLinks\.some\(\(l\) => l\.path === p\.path\)/.test(scan) && /usbOpening\.has\(p\.path\)/.test(scan));
    ok("STRUCTURE: the un-awaited open has a .catch() that RELEASES the path and names " +
       "the cause - an unhandled rejection there pinned the path for the whole process",
      /openUsbLink\(p\.path,[\s\S]*?\)\.catch\(/.test(scan) && /usbOpening\.delete\(p\.path\)/.test(scan));

    const open = extractBody(src, 'async function openUsbLink(portPath, vid = "")');
    ok("STRUCTURE: openUsbLink registers EVERY link it opens, unconditionally",
      /\n  usbLinks\.push\(link\);\n/.test(open));
    ok("STRUCTURE: openUsbLink arms the HELLO pulse on the link it just opened",
      /\n  armHelloPulse\(link\);\n/.test(open));
    ok("STRUCTURE: the link records the vendor id it was opened with, which is how the " +
       "two boards are told apart before any HELLO",
      /\n    vid,/.test(open));
    ok("STRUCTURE: the close handler splices the link out, so a replug is reopened",
      /usbLinks\.splice\(i, 1\)/.test(open));
    ok("STRUCTURE: the close handler drops that link's battery reading, keyed BEFORE the " +
       "splice because deviceNameFor() answers out of usbLinks",
      /const battKey = senderKey\(link\.id\);/.test(open) &&
      /forgetBatteryFor\(battKey\);/.test(open) &&
      open.indexOf("const battKey") < open.indexOf("usbLinks.splice"));
    ok("STRUCTURE: the open is BOUNDED - a port that emits neither \"open\" nor \"error\" " +
       "must not pin its path forever",
      /Promise\.race\(/.test(open) && /USB_OPEN_TIMEOUT_MS/.test(open) &&
      /clearTimeout\(timer\)/.test(open));

    // CONSTANTS ARE PARSED, NEVER TRANSCRIBED: a literal on this side means reverting
    // the constant in index.mjs does not fail anything. Each parse is asserted to have
    // SUCCEEDED first, because a regex that matched nothing makes every test over it
    // vacuous.
    const graceM = /const HELLO_GRACE_MS = Number\(process\.env\.DECKHAND_HELLO_GRACE_MS \|\| (\d+)\)/.exec(src);
    ok("STRUCTURE: HELLO_GRACE_MS's default is PARSED out of index.mjs", !!graceM);
    const graceMs = graceM ? Number(graceM[1]) : NaN;
    ok(`STRUCTURE: the pulse waits a REAL grace period before resetting a board ` +
       `(parsed ${graceM ? graceMs : "nothing"}ms; 0 resets every board the instant it connects)`,
      Number.isFinite(graceMs) && graceMs >= 1000);

    const openTmoM = /const USB_OPEN_TIMEOUT_MS = Number\(process\.env\.DECKHAND_USB_OPEN_TIMEOUT_MS \|\| (\d+)\)/.exec(src);
    ok("STRUCTURE: USB_OPEN_TIMEOUT_MS's default is PARSED out of index.mjs", !!openTmoM);
    const openTmo = openTmoM ? Number(openTmoM[1]) : NaN;
    ok(`STRUCTURE: a hung open is bounded by a real timeout (parsed ${openTmoM ? openTmo : "nothing"}ms), ` +
       `long enough not to abort a slow but working open`,
      Number.isFinite(openTmo) && openTmo >= 2000 && openTmo <= 60000);

    const battMaxM = /const MAX_BATT_DEVICES = (\d+);/.exec(src);
    ok("STRUCTURE: MAX_BATT_DEVICES is PARSED out of index.mjs", !!battMaxM);
    ok(`STRUCTURE: the battery store is BOUNDED (parsed ${battMaxM ? battMaxM[1] : "nothing"}) - ` +
       `ports renumber, so a close handler can leave a key it will never name again`,
      !!battMaxM && Number(battMaxM[1]) > 0 && Number(battMaxM[1]) <= 64);

    const forget = extractBody(src, "function forgetBatteryFor(key)");
    ok("STRUCTURE: a reading is deleted when its last link closes, but KEPT while the same " +
       "device is still reachable on another link (the cabled-and-BLE case)",
      /battByDevice\.delete\(key\)/.test(forget) && /for \(const l of liveLinks\(\)\)/.test(forget));
    const bound = extractBody(src, "function boundBatteryStore()");
    ok("STRUCTURE: the bound evicts the OLDEST reading, not an arbitrary one",
      /MAX_BATT_DEVICES/.test(bound) && /b\.at < oldestAt/.test(bound) && /battByDevice\.delete\(oldestKey\)/.test(bound));

    // --- THE OTHER HALF OF THE SAME PRUNE, which was missing for the whole of the
    // multi-device branch. Everything above binds the USB close handler; the BLE
    // one cleared bleCharacteristic/blePeripheral/bleDeviceName and never called
    // forgetBatteryFor, so a board 2 taken off the cable kept republishing a stale
    // `batts` entry in the 5s heartbeat with a growing ageSec - the phantom board
    // that prune's own comment claims it removes. Bound to the DISCONNECT
    // CALLBACK's own body, brace-matched, not to the file: forgetBatteryFor is
    // called from the USB handler next door and a file-wide match reads as passing
    // while this handler does nothing.
    {
      const at = src.indexOf('peripheral.once("disconnect", () => {');
      ok("STRUCTURE: the BLE disconnect handler is found", at >= 0);
      let disc = "";
      if (at >= 0) {
        const open = src.indexOf("{", src.indexOf("=> {", at));
        let d = 0;
        for (let i = open; i < src.length; i++) {
          if (src[i] === "{") d++;
          else if (src[i] === "}" && --d === 0) { disc = src.slice(open, i + 1); break; }
        }
      }
      ok("STRUCTURE: the BLE disconnect handler's own body is delimited", disc.length > 60);
      ok("STRUCTURE: it drops that device's battery reading too, the way the USB close " +
         "handler does - otherwise a board off the cable republishes a phantom `batts` " +
         "entry in the heartbeat for ever",
        /forgetBatteryFor\(/.test(disc));
      // ORDER, both ways round, because both are wrong in a way that looks right:
      // the key must be taken BEFORE bleDeviceName is cleared (senderKey reads it,
      // and afterwards the key is the bare "ble"), and the prune must run AFTER
      // bleCharacteristic is cleared (forgetBatteryFor keeps the reading if any LIVE
      // link answers to that key, and liveLinks() counts the BLE link while that is
      // still set - so called first it would find this very link and never prune).
      const iKey = disc.indexOf("const battKey"), iName = disc.indexOf("bleDeviceName = \"\"");
      const iChar = disc.indexOf("bleCharacteristic = null"), iForget = disc.indexOf("forgetBatteryFor(");
      ok("STRUCTURE: it keys the reading BEFORE clearing bleDeviceName, which senderKey reads",
        iKey >= 0 && iName > iKey);
      ok("STRUCTURE: and prunes AFTER clearing bleCharacteristic, or liveLinks() still counts " +
         "this very link and the prune declines every time",
        iChar >= 0 && iForget > iChar);
    }

    // --- THE BLE CHUNK SIZE IS NOT TUNED FROM SOMEONE ELSE'S LINK ---
    // The device answers every command on EVERY live transport and reports each BLE
    // link separately (`BLEMTU link=<i> mtu=<m>`), broadcasting all of them. So a
    // cabled board's BLEMTU arrives here over USB, and with two Macs on one board
    // this Mac sees the other Mac's MTU - and nothing on the wire says which index
    // is ours. Clamped to 20 against a 180-byte link costs 3.1x throughput; raised
    // to 180 against a 23-byte link is DROPPED SILENTLY by CoreBluetooth.
    {
      const at = src.indexOf('if (line.startsWith("BLEMTU "))');
      ok("STRUCTURE: the BLEMTU arm is found in index.mjs", at >= 0);
      const open = at >= 0 ? src.indexOf("{", at) : -1;
      let arm = "";
      if (open >= 0) {
        let d = 0;
        for (let i = open; i < src.length; i++) {
          if (src[i] === "{") d++;
          else if (src[i] === "}" && --d === 0) { arm = src.slice(open, i + 1); break; }
        }
      }
      ok("STRUCTURE: the BLEMTU arm's own body is delimited", arm.length > 100);
      ok("STRUCTURE: it refuses to retune from a report that did not arrive over BLE",
        /viaKind\(via\)\s*!==\s*"ble"[\s\S]{0,40}return/.test(arm));
      ok("STRUCTURE: it files the report under its own link index rather than overwriting " +
         "one global from whichever report arrived last",
        /link=\(\\d\+\)/.test(arm) && /bleMtuByLink\.set\(/.test(arm));
      ok("STRUCTURE: and sizes the writes from the SMALLEST link reported - undersizing " +
         "costs throughput, oversizing is dropped in silence",
        /Math\.min\(\.\.\.bleMtuByLink\.values\(\)\)/.test(arm) &&
        /bleChunkSize = want/.test(arm));
      ok("STRUCTURE: the per-link reports are cleared on disconnect - indices are reused, " +
         "and a stale 23 would pin every later connection at the floor",
        /bleMtuByLink\.clear\(\)/.test(src.slice(src.indexOf('peripheral.once("disconnect"'))));
    }

    // --- THE SCROLLACK WAITER'S KEY, which WHOAMI made unstable ---
    // waitForScrollAck keys at SEND time through the link it was handed;
    // replyLinkFor maps at ARRIVAL time and only finds the cabled link once
    // bleDeviceName matches a USB link's name. Before this branch a USB link could
    // acquire its name only during the 15s boot burst, so that mapping was settled
    // before any fetch began - WHOAMI lets a name land mid-fetch, moving the key
    // from "ble:gen:seq" to "usb:<path>:gen:seq" and stalling the fetch at chunk 0
    // for the full timeout. So BOTH candidates are tried.
    {
      const at = src.indexOf('if (line.startsWith("SCROLLACK "))');
      ok("STRUCTURE: the SCROLLACK arm is found in index.mjs", at >= 0);
      const open = at >= 0 ? src.indexOf("{", at) : -1;
      let arm = "";
      if (open >= 0) {
        let d = 0;
        for (let i = open; i < src.length; i++) {
          if (src[i] === "{") d++;
          else if (src[i] === "}" && --d === 0) { arm = src.slice(open, i + 1); break; }
        }
      }
      ok("STRUCTURE: the SCROLLACK arm's own body is delimited", arm.length > 80);
      // THE ITERATED ARRAY, not merely the two calls. `for (const l of [mapped])`
      // leaves both calls and the loop spelled out while trying one candidate,
      // which is the whole defect - so the two names are PARSED from their own
      // assignments and the array's items are checked to include both.
      const mappedN = (/const (\w+) = replyLinkFor\(via\);/.exec(arm) || [])[1];
      const arrivedN = (/const (\w+) = linkFor\(via\);/.exec(arm) || [])[1];
      const listM = /for \(const \w+ of \[([^\]]*)\]\)/.exec(arm);
      const items = listM ? listM[1].split(",").map((x) => x.trim()) : [];
      ok(`STRUCTURE: both candidates are named from their own calls [${mappedN || "?"}, ${arrivedN || "?"}]`,
        !!mappedN && !!arrivedN && mappedN !== arrivedN);
      ok("STRUCTURE: and the loop tries BOTH of them, because WHOAMI can change that " +
         `mapping in the middle of a fetch [${items.join(", ") || "no loop"}]`,
        items.includes(mappedN) && items.includes(arrivedN));
      ok("STRUCTURE: and each candidate is keyed with its OWN scrollGen, so a superseded " +
         "fetch cannot be resolved by a stale ack",
        /ackKey\(l\.id, l\.scrollGen, seq\)/.test(arm));
    }

    // --- the history dedupe key ---
    const sskM = /const scrollSenderKey = \(via\) =>([\s\S]*?);\n/.exec(src);
    ok("STRUCTURE: scrollSenderKey is PARSED out of index.mjs", !!sskM);
    ok("STRUCTURE: an unnamed usb link makes every history sender unattributable, so one " +
       "device's two transports cannot present as two devices and double the reader",
      !!sskM && /usbLinks\.some\(\(l\) => !l\.name\)/.test(sskM[1]) && /senderKey\(via\)/.test(sskM[1]));
    ok("STRUCTURE: both history arms key on scrollSenderKey(), never on senderKey() - " +
       "senderKey falls back to the LINK ID, which is what split one device in two",
      (hello.match(/\$\{scrollSenderKey\(via\)\}\|\$\{id\}/g) || []).length === 2 &&
      !/\$\{senderKey\(via\)\}\|\$\{id\}/.test(hello));
    ok("STRUCTURE: a dropped duplicate NAMES ITS CAUSE rather than returning in silence",
      (hello.match(/return scrollReqDropped\(via, reqKey\)/g) || []).length === 2 &&
      /console\.log\(/.test(extractBody(src, "function scrollReqDropped(via, reqKey)")));
    ok("STRUCTURE: the BATT arm bounds the store it writes into",
      /boundBatteryStore\(\);/.test(hello));

    const pulse = extractBody(src, "function armHelloPulse(link)");
    ok("STRUCTURE: the pulse is gated on the board being a CH340 - on a native-USB board " +
       "that sequence is esptool's reset and drops the port under an open answer window",
      /usbIsCh340\(link\)/.test(pulse));
    const ch340 = extractBody(src, "function usbIsCh340(link)");
    ok("STRUCTURE: usbIsCh340 decides from the VENDOR ID, which is known before any HELLO",
      /link\.vid === USB_VID_CH340/.test(ch340) && /const USB_VID_CH340 = "1a86";/.test(src));
    ok("STRUCTURE: the once-only record is keyed on the PATH and lives OUTSIDE the link " +
       "object, so a close/reopen cannot turn \"once\" into a loop on a board whose port " +
       "the reset drops",
      /usbPulsedPaths\.has\(link\.path\)/.test(pulse) &&
      /usbPulsedPaths\.set\(link\.path/.test(pulse) &&
      /^const usbPulsedPaths = new Map\(\);/m.test(src));
    const pulseMaxM = /const MAX_PULSED_PATHS = (\d+);/.exec(src);
    ok("STRUCTURE: MAX_PULSED_PATHS is PARSED out of index.mjs", !!pulseMaxM);
    ok(`STRUCTURE: the pulse record is bounded (parsed ${pulseMaxM ? pulseMaxM[1] : "nothing"})`,
      !!pulseMaxM && Number(pulseMaxM[1]) > 0 && /usbPulsedPaths\.delete\(usbPulsedPaths\.keys\(\)/.test(pulse));

    ok("STRUCTURE: the HELLO pulse holds DTR false - asserting it is the bootloader, not a reboot",
      /dtr: false, rts: true/.test(pulse) && /dtr: false, rts: false/.test(pulse) &&
      !/dtr: true/.test(pulse));
    ok("STRUCTURE: the pulse fires at most ONCE per link, so a board that never HELLOs " +
       "is not power-cycled forever",
      /link\.pulsed/.test(pulse));
    ok("STRUCTURE: the pulse is skipped once the link has a name",
      /if \(link\.name \|\|/.test(pulse));

    // ---- WHOAMI: read out of armHelloPulse's OWN body ----
    // A rule a neighbouring line can satisfy is not a rule, and "the host asks
    // before it reboots" is entirely about where the ask sits inside THIS body.
    const askAt = pulse.indexOf('sendToLink(link, "WHOAMI');
    ok("STRUCTURE: armHelloPulse ASKS the board its name, in its own body", askAt >= 0);
    const ch340At = pulse.indexOf("usbIsCh340(link)");
    const rtsAt = pulse.indexOf("dtr: false, rts: true");
    ok("STRUCTURE: the ask is asserted findable BEFORE anything is measured against it, so " +
       "no ordering assertion below can pass over a missing ask",
      askAt >= 0 && ch340At >= 0 && rtsAt >= 0);
    ok("STRUCTURE: the WHOAMI ask precedes the CH340 gate and the RTS pulse in the source - " +
       "asking is free and works on both boards, rebooting works on one and costs a session",
      askAt >= 0 && askAt < ch340At && askAt < rtsAt);
    ok("STRUCTURE: the ask is bounded by a WAIT rather than awaited forever - an unanswered " +
       "WHOAMI must fall through, not hang the arm",
      /WHOAMI_WAIT_MS/.test(pulse) && /setTimeout\(r, WHOAMI_WAIT_MS\)/.test(pulse));
    ok("STRUCTURE: an ANSWERED ask returns before the fallback, so a named board is never " +
       "rebooted",
      /if \(link\.name\) \{[\s\S]{0,240}?return;/.test(pulse));
    ok("STRUCTURE: the FALLBACK IS STILL REACHABLE - the unanswered arm falls through to the " +
       "CH340 gate rather than returning, because firmware older than WHOAMI never answers",
      askAt >= 0 && !/did not answer WHOAMI[\s\S]{0,600}?\n      return;/.test(pulse));
    ok("STRUCTURE: the unanswered path names its cause, and names it as an AMBIGUITY the host " +
       "cannot resolve (old firmware and an answer in flight are both silence)",
      /did not answer WHOAMI/.test(pulse) && /indistinguishable/.test(pulse));
    const whoWaitM = /const WHOAMI_WAIT_MS = Number\(process\.env\.DECKHAND_WHOAMI_WAIT_MS \|\| (\d+)\)/.exec(src);
    ok("STRUCTURE: WHOAMI_WAIT_MS's default is PARSED out of index.mjs", !!whoWaitM);
    ok(`STRUCTURE: the ask gets a REAL window before the fallback (parsed ${whoWaitM ? whoWaitM[1] : "nothing"}ms) - ` +
       "the harness collapses it to 5ms, which is the half a transcribed literal would not cover",
      !!whoWaitM && Number(whoWaitM[1]) >= 250);

    const trigger = src.slice(src.indexOf("// FANNED OUT TO EVERY DEVICE"));
    ok("STRUCTURE: a device command is broadcast once per link and the log NAMES the targets - " +
       "silence and \"impossible here\" look identical from the Mac",
      /broadcastToDevices\(command \+ "\\n"\)/.test(trigger) &&
      /Sending command to \$\{targets\.length\} link\(s\)/.test(trigger));
  }
  inStructural = false;
}

// ---------------------------------------------------------------------------
// --selftest: each fault goes into a COPY in a temp dir, never the repo file,
// and the run must FAIL. An assertion that cannot fail is a defect.
// ---------------------------------------------------------------------------
async function selftest() {
  const os = await import("node:os");
  const box = fs.mkdtempSync(path.join(os.tmpdir(), "deckhand-multidev-selftest-"));
  const orig = fs.readFileSync(INDEX, "utf8");

  const faults = [
    ["the port scan reverted to .find() - the ORIGINAL defect, one board driven and one ignored",
     (s) => s.replace("  const mine = ports.filter(", "  const mine = [ports.find(")
              .replace(/\/usbserial\|wchusbserial\|SLAB_USBtoUART\|usbmodem\/i\.test\(p\.path\)\n  \);/,
                       "/usbserial|wchusbserial|SLAB_USBtoUART|usbmodem/i.test(p.path)\n  )].filter(Boolean);")],
    ["SERIAL_PORT stopped restricting, so pinning a board no longer pins anything",
     (s) => s.replace('  if (process.env.SERIAL_PORT) {', "  if (false) {")],
    ["the link id came from the device name, so a link has no identity until HELLO",
     (s) => s.replace('const usbIdFor = (portPath) => `usb:${portPath.replace(/^\\/dev\\/(tty|cu)\\./, "")}`;',
                      'const usbIdFor = () => "usb";')],
    ["the fan-out sends only to the first link - board 1 goes dark again",
     (s) => s.replace("  for (const link of liveLinks()) if (await sendToLink(link, text, gapMs)) sent++;",
                      "  const one = liveLinks()[0];\n  if (one && (await sendToLink(one, text, gapMs))) sent++;")],
    ["the fan-out sends to every link TWICE - four copies to a cabled board",
     (s) => s.replace("  for (const link of liveLinks()) if (await sendToLink(link, text, gapMs)) sent++;",
                      "  for (const link of liveLinks()) { if (await sendToLink(link, text, gapMs)) sent++; await sendToLink(link, text, gapMs); }")],
    ["an unwritable port counted as sent, so a dead link hides itself",
     (s) => s.replace("    if (!link.port || link.port.destroyed || !link.port.writable) return false;",
                      "    if (!link.port) return false;\n    if (!link.port.writable) return true;")],
    ["deviceNameFor guesses the selected device for an unnamed link - one board's " +
     "answer attributed to the other",
     (s) => s.replace("  if (usbLinks.length <= 1) return selectedDevice;\n  return \"\";",
                      "  return selectedDevice;")],
    ["deviceNameFor reads a host-wide name instead of the link's own",
     (s) => s.replace("  const link = usbLinkFor(via);\n  if (link?.name) return link.name;",
                      "  const link = usbLinkFor(via);\n  if (usbLinks[0]?.name) return usbLinks[0].name;")],
    ["the sender key collapses to the line again - two boards' answers become one",
     (s) => s.replace('const senderKey = (via) => deviceNameFor(via) || via;',
                      'const senderKey = () => "any";')],
    // Aimed at the INTERLEAVING assertion specifically: sender keying survives,
    // but the map holds only the most recent sender - which is what a single
    // last-writer-wins slot was. Every other dedupe assertion still passes.
    ["the dedupe remembers only the LAST sender, so a second board un-deduplicates the first",
     (s) => s.replace("  map.set(key, { line, at: now });", "  map.clear();\n  map.set(key, { line, at: now });")],
    ["the dedupe stops keying on the sender at all",
     (s) => s.replace("  const key = senderKey(via);", '  const key = "one";')],
    ["the dedupe never fires, so one device's two transports both reach Claude",
     (s) => s.replace("  if (prev && prev.line === line && now - prev.at < DEVICE_DEDUP_MS) return true;",
                      "  if (false) return true;")],
    ["answer and prompt share one dedupe map, so a message swallows an answer",
     (s) => s.replace("const lastPromptBySender = new Map();", "const lastPromptBySender = lastAnswerBySender;")],
    ["replies go to the first usb link again - board 1's history down board 2's cable",
     (s) => s.replace("  return linkFor(via);\n}\n\n// How a link is NAMED in the log.",
                      "  return usbLinks[0] ?? linkFor(via);\n}\n\n// How a link is NAMED in the log.")],
    ["a BLE reply is pushed down SOME board's cable even when that peer has none",
     (s) => s.replace("    const cabled = usbLinks.find((l) => l.name === bleDeviceName);",
                      "    const cabled = usbLinks[0];")],
    // senderKey(via) is left in the expression on purpose: removing it entirely
    // would trip the BATT slice's own must-token and be "caught" by a throw
    // rather than by the assertion that is supposed to guard this.
    ["BATT filed under one key again - two boards overwrite each other",
     (s) => s.replace("      battByDevice.set(senderKey(via), {",
                      "      battByDevice.set(senderKey(via) && \"one\", {")],
    ["the reading loses the device it came from",
     (s) => s.replace("        device: deviceNameFor(via) || null,", "        device: null,")],
    ["the heartbeat publishes whichever board spoke LAST rather than the selected one",
     (s) => s.replace("    if (want && b.device === want) return b;\n", "")],
    ["the log labels every link the same, so a device line is unattributable",
     (s) => s.replace("  return l?.name ? `usb:${l.name}` : via;", '  return "usb";')],
    ["an unnamed link is labelled with another board's name",
     (s) => s.replace("  return l?.name ? `usb:${l.name}` : via;",
                      "  return `usb:${l?.name || usbLinks.find((x) => x.name)?.name || via}`;")],
    // ---- the three host defects the branch review named, each reverted ----
    ["the BLE disconnect handler stops pruning the battery, so a board off the cable " +
     "republishes a phantom `batts` entry for ever",
     (s) => s.replace(/\n\s*forgetBatteryFor\(battKey\);\n(\s*)startBleScan\(\);/, "\n$1startBleScan();")],
    ["it prunes BEFORE tearing the link down, so liveLinks() finds this very link and " +
     "the prune declines every time",
     (s) => s.replace(/(const battKey = senderKey\("ble"\);)/,
                      "$1\n        forgetBatteryFor(battKey);")
             .replace(/\n\s*forgetBatteryFor\(battKey\);\n(\s*)startBleScan\(\);/, "\n$1startBleScan();")],
    ["the BLE chunk size is retuned from a BLEMTU read off the USB cable again",
     (s) => s.replace(/\n\s*if \(viaKind\(via\) !== "ble"\) return;/, "")],
    ["and from whichever link reported LAST rather than the smallest, so this Mac sizes " +
     "its writes off the other Mac's MTU",
     (s) => s.replace("const smallest = Math.min(...bleMtuByLink.values());",
                      "const smallest = +m[1];")],
    ["SCROLLACK resolves through the mapped link ALONE, so a name landing mid-fetch " +
     "moves the key and stalls the fetch at chunk 0",
     (s) => s.replace("    for (const l of [mapped, arrived]) {", "    for (const l of [mapped]) {")],
    // ---- structural faults: invisible to every behavioural assertion above ----
    ["a module-level shotCapture creeps back, so two captures interleave into one PNG",
     (s) => s.replace("const SHOT_DIR = path.join(os.homedir(), \"Deckhand-shots\");",
                      "const SHOT_DIR = path.join(os.homedir(), \"Deckhand-shots\");\nlet shotCapture = null;")],
    ["finishShot reads a global capture instead of the link's",
     (s) => s.replace("  const cap = link.shot;\n  link.shot = null;",
                      "  const cap = globalThis.__cap;\n  globalThis.__cap = null;")],
    ["the screenshot filename drops the device, so two boards' captures are told apart " +
     "only by their dimensions",
     (s) => s.replace("  const who = (link.name || link.id).replace(/[^A-Za-z0-9_.-]/g, \"_\");",
                      "  const who = \"board\";")],
    ["the audio ack goes back to whichever link is first",
     (s) => s.replace("  sendToLink(link, `AUDIO ack ${seq}\\n`);",
                      "  sendToLink(usbLinks[0], `AUDIO ack ${seq}\\n`);")],
    ["HELLO matched on the literal \"usb\" again - false for every real link id, " +
     "so the arm is skipped in silence",
     (s) => s.replace('if (line.startsWith("HELLO ") && viaKind(via) === "usb") {',
                      'if (line.startsWith("HELLO ") && via === "usb") {')],
    ["PROVISION broadcast instead of sent to the link that said HELLO - board 2 " +
     "handed board 1's secret",
     (s) => s.replace("      await sendToLink(\n        helloLink,", "      await broadcastToDevices(\n        ")],
    ["a pairing reply on usb matched against any link's name",
     (s) => s.replace("    return !!l && !!l.name && l.name === ex.name;",
                      "    return usbLinks.some((x) => x.name === ex.name);")],
    ["the scrollback generation went back to a host-wide counter - one board's fetch " +
     "supersedes the other's",
     (s) => s.replace("    if (!link || gen !== link.scrollGen) {", "    if (false) {")],
    ["the HELLO pulse asserts DTR, which is the BOOTLOADER rather than a reboot",
     (s) => s.replace("    await set({ dtr: false, rts: true });", "    await set({ dtr: true, rts: true });")],
    ["the pulse loses its once-only guard and power-cycles a silent board forever",
     (s) => s.replace("    if (link.pulsed || usbPulsedPaths.has(link.path)) {", "    if (false) {")],
    ["the once-only guard goes back to link.pulsed alone, which DIES WITH THE LINK - " +
     "a close and reopen re-pulses the same board",
     (s) => s.replace("    if (link.pulsed || usbPulsedPaths.has(link.path)) {", "    if (link.pulsed) {")],
    // ---- WHOAMI: the host asks before it reboots ----
    ["the host stopped asking WHOAMI and went straight to the reset - board 2 is then " +
     "unreachable by any means and stays anonymous until someone reboots it by hand",
     (s) => s.replace('    if (await sendToLink(link, "WHOAMI\\n")) {', "    if (false) {")],
    ["the CH340 gate moved AHEAD of the ask, so the one board the pulse can never help is " +
     "also the one board that is never asked",
     (s) => s.replace('    if (await sendToLink(link, "WHOAMI\\n")) {',
                      '    if (!usbIsCh340(link)) { console.log("not a CH340"); return; }\n' +
                      '    if (await sendToLink(link, "WHOAMI\\n")) {')],
    ["the WHOAMI answer is ignored, so a board that just named itself is rebooted anyway",
     (s) => s.replace("      if (link.name) {\n        console.log(`USB: ${link.id} answered WHOAMI",
                      "      if (false) {\n        console.log(`USB: ${link.id} answered WHOAMI")],
    ["an unanswered WHOAMI returns instead of falling through - firmware older than WHOAMI " +
     "never answers, so board 1 loses the reset that was its only route to a name",
     (s) => s.replace("indistinguishable from here, so falling back to the older behaviour.`\n      );\n",
                      "indistinguishable from here, so falling back to the older behaviour.`\n      );\n      return;\n")],
    ["WHOAMI_WAIT_MS's default went to 0 - the board is asked and reset in the same tick, " +
     "which is the old behaviour wearing the new code's name",
     (s) => s.replace("Number(process.env.DECKHAND_WHOAMI_WAIT_MS || 1500)",
                      "Number(process.env.DECKHAND_WHOAMI_WAIT_MS || 0)")],
    ["the pulse fires even once the link HAS a name, rebooting a healthy board",
     (s) => s.replace("    if (link.name || !usbLinks.includes(link)) return;",
                      "    if (!usbLinks.includes(link)) return;")],
    ["the pulse stops checking which board it is - board 2's port IS the SoC, so that " +
     "sequence resets it and drops the USB device mid-answer",
     (s) => s.replace("    if (!usbIsCh340(link)) {", "    if (false) {")],
    ["usbIsCh340 stops reading the vendor id and says yes to everything",
     (s) => s.replace("  if (link.vid) return link.vid === USB_VID_CH340;", "  if (link.vid) return true;")],
    // ---- the scan / open pair: every one of these passed 42+14 assertions before ----
    ["the port scan opens only the FIRST candidate - THE ORIGINAL DEFECT this whole " +
     "change exists to fix, one board driven and the other left announcing HELLO to nobody",
     (s) => s.replace("  for (const p of candidates) {", "  for (const p of candidates.slice(0, 1)) {")],
    ["openUsbLink registers only the first link, so the second board is opened and dropped",
     (s) => s.replace("\n  usbLinks.push(link);\n", "\n  if (usbLinks.length === 0) usbLinks.push(link);\n")],
    ["the scan lost its already-open / in-flight guard - the same port is reopened every " +
     "3s and links and file descriptors grow without bound",
     (s) => s.replace("    if (usbLinks.some((l) => l.path === p.path) || usbOpening.has(p.path)) continue;\n", "")],
    ["the close handler stopped splicing, so a dead link holds the path and a replugged " +
     "board is never reopened",
     (s) => s.replace("    if (i >= 0) usbLinks.splice(i, 1);\n", "")],
    ["HELLO_GRACE_MS's default went to 0 - every board reset the instant it connects",
     (s) => s.replace("Number(process.env.DECKHAND_HELLO_GRACE_MS || 6000)",
                      "Number(process.env.DECKHAND_HELLO_GRACE_MS || 0)")],
    ["openUsbLink no longer arms the HELLO pulse, so board 1 never announces its name",
     (s) => s.replace("\n  armHelloPulse(link);\n", "\n")],
    // ---- the minor findings, each with its own teeth ----
    ["a hung open is unbounded again, pinning the path in usbOpening for the life of the " +
     "process - that board is dark and the log says only \"connecting to\"",
     (s) => s.replace("            USB_OPEN_TIMEOUT_MS\n          );", "            2147483647\n          );")],
    ["a failed open stops releasing its path, so the next scan skips that board forever",
     (s) => s.replace("    usbOpening.delete(portPath);\n    try {\n      port?.destroy?.();",
                      "    try {\n      port?.destroy?.();")],
    ["a closed link's battery reading is never dropped - the heartbeat republishes every " +
     "dead board every 5 seconds, forever",
     // Neutered rather than deleted, on purpose: deleting the call would trip the
     // scan slice's own must-token and be "caught" by a THROW rather than by the
     // assertion that is supposed to guard it - the same reason the BATT fault above
     // leaves senderKey(via) in its expression.
     (s) => s.replace("    forgetBatteryFor(battKey);", "    if (false) forgetBatteryFor(battKey);")],
    ["the battery store stops being bounded, so a board that renumbers grows it without end",
     (s) => s.replace("      boundBatteryStore();", "")],
    ["forgetBatteryFor drops a reading even while the device is still on another link",
     (s) => s.replace("  for (const l of liveLinks()) if (senderKey(l.id) === key) return;\n", "")],
    ["the history dedupe keys on senderKey() again - an unnamed cable and the SAME " +
     "device's BLE link become two senders and every new message in the reader is doubled",
     (s) => s.replace("const scrollSenderKey = (via) =>\n  usbLinks.some((l) => !l.name) ? \"(unattributable)\" : senderKey(via);",
                      "const scrollSenderKey = (via) => senderKey(via);")],
    ["a dropped duplicate history request goes back to being silent",
     (s) => s.replace("      if (scrollReqSeen.has(reqKey)) return scrollReqDropped(via, reqKey);\n      scrollReqSeen.set(reqKey, now);\n      await sendScrollbackSince(",
                      "      if (scrollReqSeen.has(reqKey)) return;\n      scrollReqSeen.set(reqKey, now);\n      await sendScrollbackSince(")],
    ["the device-command log stops naming its targets, so a missed board is invisible",
     (s) => s.replace("    console.log(`Sending command to ${targets.length} link(s) [${targets.join(\", \")}]: ${command}`);",
                      "    console.log(`Sending command to device: ${command}`);")],
  ];

  let caught = 0, injected = 0;
  for (let i = 0; i < faults.length; i++) {
    const [name, mutate] = faults[i];
    const mutated = mutate(orig);
    if (mutated === orig) { console.log(`  NOT INJECTED (pattern no longer matches): ${name}`); continue; }
    injected++;
    const p = path.join(box, `index-${i}.mjs`);
    fs.writeFileSync(p, mutated);
    const before = failures.length;
    pass = 0; structPass = 0;
    quiet = true;
    try {
      await main({ indexPath: p });
    } catch {
      // A slice that no longer parses, or a throw from the mutated code, is
      // also a catch - but it must be RECORDED as one rather than passing.
      failures.push(`THREW while loading the mutated host`);
    }
    quiet = false;
    inStructural = false;
    const found = failures.length > before;
    // NAME THE CATCHER. "caught" alone does not say whether the assertion that
    // fired is the one meant to guard this fault; a slice that stopped matching
    // also "catches" everything and would hide a toothless assertion.
    const by = found ? failures[before] : "";
    console.log(`  ${found ? "caught  " : "MISSED  "} ${name}${found ? `\n            by: ${by}` : ""}`);
    if (found) caught++;
    failures.length = before;
  }
  fs.rmSync(box, { recursive: true, force: true });
  console.log(`\nselftest: ${caught}/${injected} injected faults caught (${faults.length} defined)`);
  process.exit(caught === injected && injected === faults.length ? 0 : 1);
}

if (process.argv.includes("--selftest")) {
  await selftest();
} else {
  await main({});
  console.log(`\n${pass} behaviour + ${structPass} structural assertions passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(failures.length ? 1 : 0);
}
