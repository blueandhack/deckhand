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
  const candidateSlice = cut(src, "async function listUsbCandidates()", "\nlet lastUsbScanSig",
    ["SerialPort.list()", "1a86", "303a", "SERIAL_PORT"], "listUsbCandidates");
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

// SerialPort.list() is the thing under test in listUsbCandidates, so it is the
// one stub whose contents the suite sets per case.
let __ports = [];
const SerialPort = { list: async () => __ports };

${primarySlice}
${linkSlice}
${candidateSlice}
${nameSlice}
${dedupSlice}
${battSlice}

// The REAL BATT arm, lifted out of handleDeviceLine: which key a reading is
// filed under is part of what is under test.
function handleBattLine(line, via) {
${battArm}
}

// A fake serial port with the surface sendToLink actually touches.
function fakePort(link) {
  return {
    destroyed: false,
    writable: true,
    write: (text) => __sent.push({ link, text }),
  };
}
function addLink(id, name = "") {
  const l = { id, kind: "usb", path: "/dev/tty." + id.slice(4), name, scrollGen: 0,
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
  listUsbCandidates, usbIdFor, viaKind, usbLinkFor, linkFor, sendToLink,
  liveLinks, broadcastToDevices, replyLinkFor, linkLabel,
  deviceNameFor, senderKey, senderDescription,
  isDuplicateFrom, lastAnswerBySender, lastPromptBySender,
  handleBattLine, battByDevice, batteryForHeartbeat, primaryUsbName,
  BLE_LINK,
};
`;
}

async function loadHost(src) {
  const body = buildSource(src);
  const url = "data:text/javascript;base64," + Buffer.from(body, "utf8").toString("base64");
  return (await import(url)).api;
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------
const B1 = "Deckhand-0528";  // board 1, CH340, /dev/tty.usbserial-10
const B2 = "Deckhand-C114";  // board 2, native USB CDC, /dev/tty.usbmodem1101

async function main({ indexPath = INDEX } = {}) {
  const src = fs.readFileSync(indexPath, "utf8");
  const api = await loadHost(src);

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

  // ---- 8. STRUCTURE: what running the code cannot see ----
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

    const pulse = extractBody(src, "function armHelloPulse(link)");
    ok("STRUCTURE: the HELLO pulse holds DTR false - asserting it is the bootloader, not a reboot",
      /dtr: false, rts: true/.test(pulse) && /dtr: false, rts: false/.test(pulse) &&
      !/dtr: true/.test(pulse));
    ok("STRUCTURE: the pulse fires at most ONCE per link, so a board that never HELLOs " +
       "is not power-cycled forever",
      /link\.pulsed/.test(pulse));
    ok("STRUCTURE: the pulse is skipped once the link has a name",
      /if \(link\.name \|\|/.test(pulse));

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
    ["the pulse loses its once-per-link guard and power-cycles a silent board forever",
     (s) => s.replace("    if (link.name || !usbLinks.includes(link) || link.pulsed) return;\n    link.pulsed = true;",
                      "    if (!usbLinks.includes(link)) return;")],
    ["the pulse fires even once the link HAS a name, rebooting a healthy board",
     (s) => s.replace("    if (link.name || !usbLinks.includes(link) || link.pulsed) return;",
                      "    if (!usbLinks.includes(link) || link.pulsed) return;")],
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
