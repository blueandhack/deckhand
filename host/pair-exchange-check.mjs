#!/usr/bin/env node
// pair-exchange-check.mjs - the HOST's half of wireless pairing, exercised.
//
// WHY THIS EXISTS. Everything else about pairing is checked somewhere:
// pair-crypto-check.mjs pins the derivations and reads the FIRMWARE sources,
// and DeckhandMenuBar's --pair-check drives Swift against synthetic JSON. The
// state machine in host/index.mjs - which exchange a reply belongs to, when the
// key material is wiped, what puts the normal BLE scan back - had ZERO
// automated coverage, and a whole-branch review proved the gap by injection:
//
//   pairReplyIsOurs -> `return true`      (the per-exchange stamping deleted)
//   pairEnd's `b.fill(0)` loop removed    (priv/shared/key left live)
//
// Both left all 18 checkers and every selftest green. Those are exactly the two
// defects this branch's own fix rounds were written to close, so they are the
// two faults --selftest re-injects here.
//
// IT DRIVES THE REAL FUNCTIONS, NOT A MIRROR. The pairing region of index.mjs
// is SLICED OUT BY SOURCE TEXT and evaluated with noble-shaped stubs around it,
// so deleting the real code deletes the thing under test - the weakness this
// repo already records in sessions-rank-check.mjs's mirror half, where the
// mirror would keep passing with the comparator gone.
//
// THE VACUITY TRAP IS THE THING TO WATCH. The throwaway harness this is built
// from reported a clean pass while starting no exchange at all, because the BLE
// UUID constants were missing from its prelude and discovery quietly found no
// characteristics. So the constants are PARSED out of index.mjs rather than
// transcribed, every slice is asserted non-empty and asserted to contain a
// token only the real code has, and the suite's FIRST assertions prove an
// exchange genuinely opened, sent a real PAIRREQ, and derived a code the
// simulated device independently agrees with. Nothing downstream is worth
// reading until those pass.
//
//   node host/pair-exchange-check.mjs
//   node host/pair-exchange-check.mjs --selftest
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(HERE, "index.mjs");

// ---------- slicing the real state machine out of index.mjs ----------

// Every cut asserts BOTH markers were found and that what came back still
// contains a token only the real code has. A silent empty slice is how a
// harness comes to test nothing and say so cheerfully.
function cut(src, from, to, must, label) {
  const a = src.indexOf(from);
  if (a === -1) throw new Error(`slice "${label}": start marker not found: ${from}`);
  const b = src.indexOf(to, a + from.length);
  if (b === -1) throw new Error(`slice "${label}": end marker not found: ${to}`);
  const text = src.slice(a, b);
  for (const m of must) {
    if (!text.includes(m)) throw new Error(`slice "${label}" is missing ${m} - the anchors have moved`);
  }
  return text;
}

// Constants are PARSED, never transcribed: a UUID copied into this file could
// drift from index.mjs, and a wrong one makes discovery find nothing - which is
// precisely the shape of the vacuous pass above.
function constant(src, name, re) {
  const m = src.match(re);
  if (!m) throw new Error(`could not parse ${name} out of index.mjs`);
  return m[1];
}

function buildSource(src) {
  const SERVICE = constant(src, "BLE_SERVICE_UUID", /const BLE_SERVICE_UUID = "([0-9a-f]{32})";/);
  const RX = constant(src, "BLE_RX_CHAR_UUID", /const BLE_RX_CHAR_UUID = "([0-9a-f]{32})";/);
  const TX = constant(src, "BLE_TX_CHAR_UUID", /const BLE_TX_CHAR_UUID = "([0-9a-f]{32})";/);
  const CHUNK = constant(src, "BLE_CHUNK_SIZE", /const BLE_CHUNK_SIZE = (\d+);/);

  const timeoutSlice = cut(src, "const BLE_WRITE_TIMEOUT_MS = 3000;", "// MEASURED TWICE, hours apart:",
    ["function withTimeout("], "withTimeout");
  const nameSlice = cut(src, "const VALID_DEVICE_NAME", "\n\n", ["isValidDeviceName"], "isValidDeviceName");
  const viaSlice = cut(src, "function deviceNameFor(via) {", "\nasync function loadPairing()",
    ["deviceNameFor", "senderDescription"], "deviceNameFor");
  const dispatchSlice = cut(src, '  if (line.startsWith("PAIRPUB ")) {',
    "  // Device announces its unique BLE name over USB",
    ["handlePairPub", "handlePairDone", "handlePairFail"], "pairing dispatch");
  const pairSlice = cut(src, "// ---------- Wireless pairing: the Mac's half ----------",
    "// ---------- Shared tick: compute usage once",
    ["function pairReplyIsOurs", "async function pairEnd", "async function pairStart",
     "async function handlePairPub", "async function pairConfirm", "async function pairCancel"],
    "pairing section");

  // A data: module has no base to resolve against, so the two real modules it
  // pulls in have to be named as file: URLs.
  const crypto = pathToFileURL(path.join(HERE, "pair-crypto.mjs")).href;
  const ascii = pathToFileURL(path.join(HERE, "to-ascii.mjs")).href;

  return `
import { generateKeypair, deriveShared, deriveCode, deriveKey, pairProof } from ${JSON.stringify(crypto)};
import { toAscii } from ${JSON.stringify(ascii)};

// ---- stubs standing in for everything the pairing code talks to ----
const BLE_SERVICE_UUID = ${JSON.stringify(SERVICE)};
const BLE_RX_CHAR_UUID = ${JSON.stringify(RX)};
const BLE_TX_CHAR_UUID = ${JSON.stringify(TX)};
const BLE_CHUNK_SIZE = ${CHUNK};

// Timers are OWNED by the test. pairArm()'s shortest fuse is 15s and the
// exchange window is 120s, so a real clock would make the timeout and the
// scan-finish paths untestable; these record instead of firing, and the suite
// fires the one it means. globalThis.setTimeout is untouched, so the harness
// still has a real one for settling microtasks.
const __timers = new Map();
let __timerSeq = 0;
function setTimeout(fn, ms) { const id = ++__timerSeq; __timers.set(id, { fn, ms }); return id; }
function clearTimeout(id) { __timers.delete(id); }

const __logs = [];
const console = {
  log: (...a) => __logs.push(a.map(String).join(" ")),
  error: (...a) => __logs.push(a.map(String).join(" ")),
};

let hostId = "9f3c1a20";
let hostLabel = "harness-mac";
let selectedDevice = "";
let usbDeviceName = "";
let bleDeviceName = "";
let bleCharacteristic = null;
let blePeripheral = null;

let __scanRestores = 0;
function startBleScan() { __scanRestores++; }

const noble = {
  state: "poweredOn",
  failScan: false,
  stopScanningAsync: async () => {},
  startScanningAsync: async () => { if (noble.failScan) throw new Error("adapter busy"); },
};

const __remembered = [];
async function rememberDevice(name, secret = "") { __remembered.push({ name, secret }); }

${timeoutSlice}
${nameSlice}
${viaSlice}
${pairSlice}

// The REAL dispatch block, lifted out of handleDeviceLine: which handler a line
// reaches, and what \`via\`/\`pairGen\` it carries, is part of what is under test.
async function handleDeviceLine(line, via, pairGen = 0) {
${dispatchSlice}
}

// ---- the seam the suite drives ----
export const api = {
  pairStatus, pairScanStart, pairScanFinish, pairStart, pairConfirm, pairCancel, pairEnd,
  handleDeviceLine, deviceNameFor, senderDescription, isValidDeviceName,
  exchange: () => pairExchange,
  state: () => pairState,
  generation: () => pairGeneration,
  tearingDown: () => pairTearingDown,
  scanning: () => pairScanning,
  logs: __logs,
  remembered: __remembered,
  scanRestores: () => __scanRestores,
  noble,
  uuids: { BLE_SERVICE_UUID, BLE_RX_CHAR_UUID, BLE_TX_CHAR_UUID, BLE_CHUNK_SIZE },
  see: (name, peripheral, at = Date.now()) =>
    pairScanSeen.set(name, { name, rssi: -40, peripheral, at }),
  forgetSightings: () => pairScanSeen.clear(),
  setBle: (o) => {
    if ("characteristic" in o) bleCharacteristic = o.characteristic;
    if ("peripheral" in o) blePeripheral = o.peripheral;
    if ("bleName" in o) bleDeviceName = o.bleName;
    if ("usbName" in o) usbDeviceName = o.usbName;
    if ("selected" in o) selectedDevice = o.selected;
  },
  timers: () => [...__timers.entries()].map(([id, t]) => ({ id, ...t })),
  fire: async (pred = () => true) => {
    let n = 0;
    for (const [id, t] of [...__timers.entries()]) {
      if (!pred(t)) continue;
      __timers.delete(id);
      t.fn();
      n++;
    }
    await new Promise((r) => globalThis.setTimeout(r, 0));
    await new Promise((r) => globalThis.setTimeout(r, 0));
    return n;
  },
  settle: async () => {
    await new Promise((r) => globalThis.setTimeout(r, 0));
    await new Promise((r) => globalThis.setTimeout(r, 0));
  },
};
`;
}

async function loadMachine(src) {
  const body = buildSource(src);
  const url = "data:text/javascript;base64," + Buffer.from(body, "utf8").toString("base64");
  const mod = await import(url);
  return mod.api;
}

// ---------- a device on the other end of the link ----------

import { EventEmitter } from "node:events";
import {
  generateKeypair, deriveShared, deriveCode, deriveKey, pairProof,
} from "./pair-crypto.mjs";

class Char extends EventEmitter {
  constructor(uuid, dev) { super(); this.uuid = uuid; this.dev = dev; }
  async subscribeAsync() { this.subscribed = true; }
  async writeAsync(buf) { this.dev.receive(buf.toString("utf8")); }
}

// A simulated device: it runs the SAME derivations the firmware does (through
// the same pinned module), so "the codes agree" is a real agreement rather than
// an echo of what the Mac computed.
class FakeDevice extends EventEmitter {
  constructor(name, uuids) {
    super();
    this.name = name;
    this.id = `id-${name}`;
    this.state = "disconnected";
    this.rx = new Char(uuids.BLE_RX_CHAR_UUID, this);
    this.tx = new Char(uuids.BLE_TX_CHAR_UUID, this);
    this.written = [];
    this.buf = "";
    const kp = generateKeypair();
    this.priv = kp.priv;
    this.pub = kp.pub;
    this.connects = 0;
    this.disconnects = 0;
  }
  async connectAsync() { this.connects++; this.state = "connected"; }
  async disconnectAsync() { this.disconnects++; this.state = "disconnected"; this.emit("disconnect"); }
  async discoverSomeServicesAndCharacteristicsAsync() {
    return { services: [], characteristics: [this.rx, this.tx] };
  }
  receive(text) {
    this.buf += text;
    let i;
    while ((i = this.buf.indexOf("\n")) !== -1) {
      const l = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!l) continue;
      this.written.push(l);
      if (l.startsWith("PAIRREQ ")) {
        const [, , pubAHex] = l.split(" ");
        this.pubA = Buffer.from(pubAHex, "hex");
        this.shared = deriveShared(this.priv, this.pubA);
        this.code = deriveCode(this.shared, this.pubA, this.pub);
        this.key = deriveKey(this.shared, this.pubA, this.pub);
        this.proof = pairProof(this.key);
      }
    }
  }
  lastWrite() { return this.written[this.written.length - 1] ?? ""; }
  // What a notify on the exchange's own link looks like, stamped with the
  // generation THAT reader was opened for - which is the whole mechanism
  // pairReplyIsOurs() exists to use.
  say(api, line, gen) { return api.handleDeviceLine(line, "pair", gen); }
  drop() { this.state = "disconnected"; this.emit("disconnect"); }
}

// ---------- the suite ----------

async function run(src, quiet) {
  let pass = 0;
  const failures = [];
  const ok = (name, cond) => {
    if (cond) { pass++; if (!quiet) console.log(`  ok    ${name}`); }
    else { failures.push(name); if (!quiet) console.log(`  FAIL  ${name}`); }
  };

  let api;
  try {
    api = await loadMachine(src);
  } catch (err) {
    failures.push(`THREW while building the machine: ${err.message}`);
    return { pass, failures };
  }
  const logged = (frag) => api.logs.some((l) => l.includes(frag));
  const since = () => api.logs.length;
  const loggedSince = (n, frag) => api.logs.slice(n).some((l) => l.includes(frag));

  const dev = () => new FakeDevice("Deckhand-0528", api.uuids);
  async function open(d = dev()) {
    api.see(d.name, d);
    await api.pairStart(d.name);
    await api.settle();
    return d;
  }

  try {
    // ---- IS THIS HARNESS EVEN RUNNING THE MACHINE? Nothing below is worth
    // reading until these pass; the harness this grew from reported a clean
    // sweep of everything while starting no exchange at all.
    ok("VACUITY: the BLE service/RX/TX UUIDs were PARSED out of index.mjs, not transcribed",
      /^[0-9a-f]{32}$/.test(api.uuids.BLE_SERVICE_UUID) &&
      /^[0-9a-f]{32}$/.test(api.uuids.BLE_RX_CHAR_UUID) &&
      /^[0-9a-f]{32}$/.test(api.uuids.BLE_TX_CHAR_UUID) &&
      api.uuids.BLE_RX_CHAR_UUID !== api.uuids.BLE_TX_CHAR_UUID);
    ok("VACUITY: the machine starts idle with no exchange",
      api.state() === "idle" && api.exchange() === null);

    const d0 = await open();
    ok("VACUITY: PAIRSTART actually OPENED an exchange", api.exchange() !== null);
    ok("VACUITY: it connected and discovered the real characteristics",
      d0.connects === 1 && !!api.exchange()?.rxChar && !!api.exchange()?.txChar);
    ok("VACUITY: a real PAIRREQ reached the device, carrying this Mac's hostId and public key",
      /^PAIRREQ [0-9a-f]{8} [0-9a-f]{64} /.test(d0.lastWrite()));
    ok("VACUITY: the state is awaiting-code with no code yet",
      api.state() === "awaiting-code" && api.pairStatus().code === "");

    const gen0 = api.exchange().gen;
    await d0.say(api, `PAIRPUB ${d0.pub.toString("hex")}`, gen0);
    ok("VACUITY: the device's PAIRPUB derived a six-digit code",
      /^[0-9]{6}$/.test(api.pairStatus().code));
    ok("VACUITY: the Mac's code EQUALS the one the device derived independently",
      api.pairStatus().code === d0.code);
    ok("VACUITY: the Mac derived the same 128-bit key the device did",
      api.exchange().key.toString("hex") === d0.key.toString("hex"));
    await api.pairCancel();
    await api.settle();

    // ---- 1. A LATE REPLY FROM AN ABANDONED EXCHANGE ----
    // The reviewer's first injection (pairReplyIsOurs -> true) lands here.
    {
      const a = await open();
      const genA = api.exchange().gen;
      await api.pairCancel();          // the user gave up on this one
      await api.settle();
      const b = await open(dev());
      const genB = api.exchange().gen;
      ok("GENERATION: a fresh exchange takes a NEW generation, never a reused one", genB > genA);

      const n0 = since();
      // The abandoned exchange's reader is still stamped with genA.
      await a.say(api, `PAIRPUB ${a.pub.toString("hex")}`, genA);
      ok("LATE REPLY: a PAIRPUB stamped with an ABANDONED exchange's generation is DROPPED",
        api.pairStatus().code === "");
      ok("LATE REPLY: the drop is LOGGED rather than swallowed in silence",
        loggedSince(n0, "PAIRPUB DROPPED"));
      // An unstamped caller (every non-pairing transport's default) matches nothing.
      await b.say(api, `PAIRPUB ${b.pub.toString("hex")}`, 0);
      ok("LATE REPLY: generation 0 - every other caller's default - matches no exchange",
        api.pairStatus().code === "");
      // A shared transport binds to the device it is connected to, not to luck.
      api.setBle({ bleName: "Deckhand-BEEF" });
      await api.handleDeviceLine(`PAIRPUB ${b.pub.toString("hex")}`, "ble", 0);
      ok("LATE REPLY: a PAIRPUB over BLE from a DIFFERENT device than this exchange's is DROPPED",
        api.pairStatus().code === "");
      api.setBle({ bleName: "" });

      // ...and the real one still gets through.
      await b.say(api, `PAIRPUB ${b.pub.toString("hex")}`, genB);
      ok("LATE REPLY: the exchange's OWN reply is still accepted after the late one was dropped",
        api.pairStatus().code === b.code && api.pairStatus().code !== "");
      ok("LATE REPLY: the code is the CURRENT exchange's, never the abandoned peer's",
        api.pairStatus().code !== a.code);

      const n1 = since();
      await a.say(api, "PAIRDONE 9f3c1a20", genA);
      ok("LATE REPLY: a PAIRDONE from an abandoned exchange stores NOTHING",
        api.remembered.length === 0 && loggedSince(n1, "PAIRDONE DROPPED"));
      const n2 = since();
      await a.say(api, "PAIRFAIL refused", genA);
      ok("LATE REPLY: a PAIRFAIL from an abandoned exchange does not end THIS exchange",
        api.exchange() !== null && loggedSince(n2, "DROPPED"));
      await api.pairCancel();
      await api.settle();
    }

    // ---- 2. KEY MATERIAL IS ZEROED ON EVERY EXIT ----
    // The reviewer's second injection (pairEnd's b.fill(0) deleted) lands here.
    // The Buffers are captured BEFORE the exit, because pairEnd nulls the
    // fields as well as filling them - checking the object afterwards would
    // pass on a machine that only nulled.
    const zeroed = (b) => Buffer.isBuffer(b) && b.length > 0 && b.every((x) => x === 0);
    async function exitWipes(label, arrange, act) {
      const d = await open();
      await d.say(api, `PAIRPUB ${d.pub.toString("hex")}`, api.exchange().gen);
      const ex = api.exchange();
      const held = { priv: ex.priv, shared: ex.shared, key: ex.key, code: ex.code, proof: ex.proof };
      ok(`WIPE (${label}): the exchange really held live key material before the exit`,
        Buffer.isBuffer(held.priv) && Buffer.isBuffer(held.shared) && Buffer.isBuffer(held.key) &&
        !zeroed(held.priv) && !zeroed(held.shared) && !zeroed(held.key) &&
        held.code !== "" && held.proof !== "");
      if (arrange) await arrange(d, ex);
      await act(d, ex);
      await api.settle();
      ok(`WIPE (${label}): the private key, the shared secret and the derived key are all ZEROED`,
        zeroed(held.priv) && zeroed(held.shared) && zeroed(held.key));
      ok(`WIPE (${label}): the exchange is closed and publishes no code`,
        api.exchange() === null && api.pairStatus().code === "");
      return d;
    }

    await exitWipes("success", null, async (d) => {
      await api.pairConfirm();
      await d.say(api, "PAIRDONE 9f3c1a20", api.exchange().gen);
    });
    ok("WIPE (success): the derived key was stored as this device's pairing",
      api.remembered.length === 1 && api.remembered[0].name === "Deckhand-0528" &&
      /^[0-9a-f]{32}$/.test(api.remembered[0].secret));
    api.remembered.length = 0;

    await exitWipes("cancel", null, async () => { await api.pairCancel(); });
    await exitWipes("timeout", null, async () => { await api.fire(); });
    await exitWipes("PAIRFAIL", null, async (d) => {
      await d.say(api, "PAIRFAIL cancelled", api.exchange().gen);
    });
    await exitWipes("the link dropping", null, async (d) => { d.drop(); });
    ok("WIPE: nothing was stored on any of the four failing exits", api.remembered.length === 0);

    // "Replacing start": on this side a second PAIRSTART cannot replace a live
    // exchange at all - it is REFUSED - so no exchange is ever abandoned with
    // its key material still live. That refusal IS the guarantee.
    {
      const a = await open();
      const ex = api.exchange();
      const held = { priv: ex.priv };
      const n = since();
      const b = new FakeDevice("Deckhand-BEEF", api.uuids);
      api.see(b.name, b);
      await api.pairStart(b.name);
      await api.settle();
      ok("REPLACING START: a second PAIRSTART is REFUSED while an exchange is live",
        api.exchange() === ex && b.connects === 0 && loggedSince(n, "PAIRSTART ignored"));
      ok("REPLACING START: nothing was abandoned, so the first exchange's key material is untouched",
        !zeroed(held.priv));
      await api.pairCancel();
      await api.settle();
      ok("REPLACING START: cancelling first wipes it, and only then may a new exchange open",
        zeroed(held.priv) && api.exchange() === null);
      await api.pairStart(b.name);
      await api.settle();
      ok("REPLACING START: the replacement exchange opens against the device that was asked for",
        api.exchange() !== null && api.exchange().name === b.name && b.connects === 1);
      await api.pairCancel();
      await api.settle();
      void a;
    }

    // ---- 3. A DISCONNECT ENDS THE EXCHANGE, RATHER THAN WAITING OUT THE TIMER ----
    {
      const d = await open();
      await d.say(api, `PAIRPUB ${d.pub.toString("hex")}`, api.exchange().gen);
      ok("DISCONNECT: a timer is armed while the exchange is live", api.timers().length > 0);
      d.drop();
      await api.settle();
      ok("DISCONNECT: the dropped link ENDS the exchange at once",
        api.exchange() === null && api.state() === "failed");
      ok("DISCONNECT: it says the link dropped rather than that something timed out",
        logged("dropped before the exchange finished"));
      ok("DISCONNECT: the exchange timer is cleared, so nothing fires 120s later",
        api.timers().length === 0);
      ok("DISCONNECT: the heartbeat stops publishing a live pairing",
        api.pairStatus().code === "" && api.pairStatus().sec === 0);
    }

    // ---- 4. THE SCAN GOES BACK ON EVERY EXIT ----
    {
      const before = api.scanRestores();
      const d = await open();
      await api.pairCancel();
      await api.settle();
      ok("SCAN: cancelling an exchange we opened a link for puts the normal BLE scan back",
        api.scanRestores() === before + 1);

      const b2 = api.scanRestores();
      const d2 = await open();
      d2.drop();
      await api.settle();
      ok("SCAN: a dropped link puts the scan back too", api.scanRestores() === b2 + 1);

      const b3 = api.scanRestores();
      const d3 = await open();
      await api.fire();
      ok("SCAN: a timed-out exchange puts the scan back", api.scanRestores() === b3 + 1);

      const b4 = api.scanRestores();
      const d4 = await open();
      await d4.say(api, `PAIRPUB ${d4.pub.toString("hex")}`, api.exchange().gen);
      await api.pairConfirm();
      await d4.say(api, "PAIRDONE 9f3c1a20", api.exchange().gen);
      await api.settle();
      ok("SCAN: a SUCCESSFUL pairing puts the scan back as well", api.scanRestores() === b4 + 1);
      api.remembered.length = 0;

      // ...and it restores the host's INVARIANT rather than a remembered flag:
      // a live link means no scan, so pairing with the connected device must
      // leave that link exactly as it found it.
      const live = new FakeDevice("Deckhand-0528", api.uuids);
      live.state = "connected";
      api.setBle({ characteristic: {}, peripheral: live, bleName: live.name });
      const b5 = api.scanRestores();
      api.see(live.name, live);
      await api.pairStart(live.name);
      await api.settle();
      ok("SCAN: pairing with the device already on the live link does not open a link of its own",
        api.exchange() !== null && api.exchange().ownLink === false);
      await api.pairCancel();
      await api.settle();
      ok("SCAN: and it neither disconnects that link nor restarts a scan under it",
        api.scanRestores() === b5 && live.disconnects === 0);
      api.setBle({ characteristic: null, peripheral: null, bleName: "" });

      // The scan path's own exits.
      const b6 = api.scanRestores();
      await api.pairScanStart();
      ok("SCAN: PAIRSCAN takes the radio and reports itself scanning",
        api.scanning() === true && api.state() === "scanning");
      await api.fire();
      ok("SCAN: when the 5s listing ends, the normal scan is back and the state returns to idle",
        api.scanRestores() === b6 + 1 && api.scanning() === false && api.state() === "idle");

      const b7 = api.scanRestores();
      api.noble.failScan = true;
      await api.pairScanStart();
      api.noble.failScan = false;
      ok("SCAN: a scan that FAILS to start also puts the normal scan back",
        api.scanRestores() === b7 + 1 && api.scanning() === false && api.state() === "failed");
      void d;
    }

    // ---- 5. PAIRCONFIRM SENDS THE PROOF ONLY WHEN AN EXCHANGE IS PENDING ----
    {
      const n0 = since();
      await api.pairConfirm();
      ok("CONFIRM: with no exchange running it sends nothing and says so",
        loggedSince(n0, "PAIRCONFIRM ignored - no exchange is running"));

      const d = await open();
      const n1 = since();
      await api.pairConfirm();
      ok("CONFIRM: before the device has answered there is no proof to send, and none is sent",
        d.written.filter((l) => l.startsWith("PAIROK ")).length === 0 &&
        loggedSince(n1, "PAIRCONFIRM ignored - the device has not answered yet"));
      ok("CONFIRM: a refused confirm leaves the exchange alone rather than ending it",
        api.exchange() !== null && api.state() === "awaiting-code");

      await d.say(api, `PAIRPUB ${d.pub.toString("hex")}`, api.exchange().gen);
      await api.pairConfirm();
      await api.settle();
      const proofLine = d.written.filter((l) => l.startsWith("PAIROK "));
      ok("CONFIRM: once the device has answered, exactly one PAIROK goes out",
        proofLine.length === 1);
      ok("CONFIRM: the proof is the one the DEVICE independently computes from the derived key",
        proofLine[0] === `PAIROK ${d.proof}`);
      ok("CONFIRM: the state moves to verifying - the tap on the glass is still owed",
        api.state() === "verifying" && api.remembered.length === 0);
      await api.pairCancel();
      await api.settle();
    }

    // ---- 6. A PAIRING LINK IS NOT A PAIRED DEVICE ----
    // An ANSWER/PROMPT arriving on the unauthenticated pairing link fails
    // closed either way; what this pins is that the refusal names the right
    // subject instead of some other Mac's pairing.
    {
      api.setBle({ usbName: "Deckhand-USB1", selected: "Deckhand-SEL1" });
      ok("ATTRIBUTION: a line on the pairing link is attributed to NO paired device",
        api.deviceNameFor("pair") === "");
      ok("ATTRIBUTION: usb and ble still resolve the way they always did",
        api.deviceNameFor("usb") === "Deckhand-USB1" && api.deviceNameFor("ble") === "");
      ok("ATTRIBUTION: a refusal on the pairing link SAYS it came from the pairing link",
        /PAIRING link/.test(api.senderDescription("pair", "")) &&
        !/unknown device/.test(api.senderDescription("pair", "")));
      ok("ATTRIBUTION: an unidentified ble/usb sender still reads as an unknown device",
        /unknown device/.test(api.senderDescription("ble", "")));
      api.setBle({ usbName: "", selected: "" });
    }

    // ---- 7. THE REFUSALS THAT COST NOTHING TO GET WRONG AND EVERYTHING TO MISS ----
    {
      // The sightings this suite has been injecting all along would otherwise
      // make "was not in the last scan" unreachable.
      api.forgetSightings();
      const n0 = since();
      await api.pairStart("not-a-deckhand");
      ok("REFUSAL: PAIRSTART refuses a name that is not Deckhand-XXXX",
        api.exchange() === null && loggedSince(n0, "is not a Deckhand-XXXX device name"));

      const n1 = since();
      await api.pairStart("Deckhand-0528");
      ok("REFUSAL: PAIRSTART refuses a device that was in no scan",
        api.exchange() === null && loggedSince(n1, "was not in the last scan"));

      const stale = new FakeDevice("Deckhand-0528", api.uuids);
      api.see(stale.name, stale, Date.now() - 10 * 60_000);
      const n2 = since();
      await api.pairStart(stale.name);
      ok("REFUSAL: a STALE sighting is refused by name rather than connected to",
        api.exchange() === null && stale.connects === 0 && loggedSince(n2, "that sighting is stale"));

      const d = await open();
      const n3 = since();
      await d.say(api, "PAIRPUB nothex", api.exchange().gen);
      ok("REFUSAL: a malformed public key ends the exchange instead of being derived from",
        api.exchange() === null && loggedSince(n3, "malformed"));

      const d2 = await open();
      const n4 = since();
      await d2.say(api, "PAIRDONE deadbeef", api.exchange().gen);
      ok("REFUSAL: a PAIRDONE naming a DIFFERENT Mac stores nothing",
        api.remembered.length === 0 && loggedSince(n4, "not this Mac"));
      const n5 = since();
      await d2.say(api, "PAIRDONE 9f3c1a20", api.exchange().gen);
      ok("REFUSAL: a PAIRDONE arriving before any key was derived stores nothing and ends it",
        api.remembered.length === 0 && api.exchange() === null &&
        loggedSince(n5, "before a key was derived"));
      await api.pairCancel();
      await api.settle();
    }
  } catch (err) {
    failures.push(`THREW: ${err.message}`);
  }

  return { pass, failures };
}

// ---------- teeth ----------
//
// Both faults are the ones a whole-branch review actually injected, and both
// left every other checker in this repo green.
const FAULTS = [
  {
    name: "pairReplyIsOurs -> `return true` (the per-exchange stamping deleted)",
    apply(src) {
      const a = src.indexOf("function pairReplyIsOurs(ex, via, gen) {");
      if (a === -1) throw new Error("pairReplyIsOurs not found");
      const b = src.indexOf("\n}\n", a);
      if (b === -1) throw new Error("pairReplyIsOurs has no end");
      return src.slice(0, a) +
        "function pairReplyIsOurs(ex, via, gen) { return true;" +
        src.slice(b);
    },
  },
  {
    name: "pairEnd's `b.fill(0)` loop deleted (priv/shared/key left live)",
    apply(src) {
      const line = "      for (const b of [ex.priv, ex.shared, ex.key]) if (Buffer.isBuffer(b)) b.fill(0);\n";
      if (!src.includes(line)) throw new Error("the wipe loop is not where the fault expects it");
      return src.replace(line, "");
    },
  },
];

const real = fs.readFileSync(INDEX, "utf8");

async function selftest() {
  console.log("selftest: re-injecting the two faults the whole-branch review used\n");
  let caught = 0;
  for (const f of FAULTS) {
    let mutated;
    try {
      mutated = f.apply(real);
    } catch (err) {
      console.log(`  MISSED  ${f.name}  <- could not be injected: ${err.message}`);
      continue;
    }
    if (mutated === real) {
      console.log(`  MISSED  ${f.name}  <- the injection changed nothing`);
      continue;
    }
    const { failures } = await run(mutated, true);
    if (failures.length) {
      caught++;
      console.log(`  caught  ${f.name}`);
      for (const name of failures) console.log(`            by: ${name}`);
    } else {
      console.log(`  MISSED  ${f.name}  <- no assertion notices this`);
    }
  }
  console.log(`\nselftest: ${caught}/${FAULTS.length} injected faults caught`);
  process.exit(caught === FAULTS.length ? 0 : 1);
}

if (process.argv.includes("--selftest")) {
  await selftest();
} else {
  const { pass, failures } = await run(real, false);
  // A THREW entry never reached an ok() call, so it would otherwise be counted
  // and never named - the same hole pair-crypto-check.mjs already closed.
  failures.filter((f) => f.startsWith("THREW")).forEach((f) => console.log(`  FAIL  ${f}`));
  console.log(failures.length
    ? `\n${failures.length} check(s) FAILED`
    : `\n${pass} pairing state-machine assertions pass`);
  process.exit(failures.length ? 1 : 0);
}
