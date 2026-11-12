#!/usr/bin/env node
// Checks the release-notes path: Markdown -> HTML (notes-html.mjs) -> the feed item's
// <description> (embed-notes.mjs) -> publish.sh, and the committed feed against the
// committed notes.
//   node release/notes-check.mjs              - assert every claim
//   node release/notes-check.mjs --selftest   - prove the claims have teeth
//
// WHY THE SAFETY HALF. The HTML lands in Sparkle's update window, a web view, so the
// notes must not be able to carry markup of their own. Three defects were found while
// writing this file, all now asserted: a `"` in a link URL closed href="" and opened a
// second attribute; `*` inside a code span was italicised; and embedNotes() handed the
// notes to String.replace as a REPLACEMENT STRING, so "$1" in the notes became the
// item's <title> and "$$" collapsed to "$".
//
// THE SELFTEST MUTATES THE REAL SOURCE, it does not re-implement it: each fault is a
// textual edit of notes-html.mjs / embed-notes.mjs (or of publish.sh's or the feed's
// text), the edited copies are imported from a scratch directory, and the named claim
// must FAIL. A fault whose edit no longer applies counts as blind, so the selftest
// cannot go vacuous when the source is reworded.
//
// Not covered: embedNotes()'s "]]>" split. notesHtml() escapes ">", so no notes can
// produce "]]>" and the split is belt-and-braces - an edit removing it is undetectable
// by construction, and no assertion here pretends otherwise.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = {
  html: fs.readFileSync(path.join(here, "notes-html.mjs"), "utf8"),
  embed: fs.readFileSync(path.join(here, "embed-notes.mjs"), "utf8"),
};
const TEXT = {
  appcast: fs.readFileSync(path.join(here, "appcast.xml"), "utf8"),
  publish: fs.readFileSync(path.join(here, "publish.sh"), "utf8"),
};
const NOTES = Object.fromEntries(fs.readdirSync(path.join(here, "notes"))
  .filter((f) => /^\d+\.\d+\.\d+\.md$/.test(f))
  .map((f) => [f.slice(0, -3), fs.readFileSync(path.join(here, "notes", f), "utf8")]));

// Load a (possibly edited) copy of both modules from a fresh directory, so ESM's module
// cache can never hand back an earlier copy.
async function load(src) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notes-check-"));
  fs.writeFileSync(path.join(dir, "notes-html.mjs"), src.html);
  fs.writeFileSync(path.join(dir, "embed-notes.mjs"), src.embed);
  const h = await import(pathToFileURL(path.join(dir, "notes-html.mjs")).href);
  const e = await import(pathToFileURL(path.join(dir, "embed-notes.mjs")).href);
  fs.rmSync(dir, { recursive: true, force: true });
  return { inline: h.inline, notesHtml: h.notesHtml, embedNotes: e.embedNotes };
}

// The text of <description> as an XML parser reads it - CDATA unwrapped - or null.
function xmlDescription(xml, xpath = "string(//description)") {
  const r = spawnSync("xmllint", ["--xpath", xpath, "-"], { input: xml, encoding: "utf8" });
  return r.status === 0 ? r.stdout : null;
}
const wellFormed = (xml) => spawnSync("xmllint", ["--noout", "-"], { input: xml }).status === 0;

const item = (v, extra = "") =>
  `        <item>\n            <title>${v}</title>${extra}\n            <sparkle:shortVersionString>${v}</sparkle:shortVersionString>\n            <enclosure url="https://x/${v}.dmg" sparkle:edSignature="SIG${v}"/>\n        </item>\n`;
const feed = (...items) =>
  `<?xml version="1.0" standalone="yes"?>\n<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0">\n    <channel>\n${items.join("")}    </channel>\n</rss>`;

function claims({ inline, notesHtml, embedNotes }, text) {
  const out = [];
  const c = (name, fn) => { let ok; try { ok = !!fn(); } catch { ok = false; } out.push([name, ok]); };

  // ---- Markdown -> HTML ----
  c("### is h4 (the window's own title is the h1)", () => notesHtml("### What's new") === "<h4>What's new</h4>");
  c("# is h2", () => notesHtml("# Top") === "<h2>Top</h2>");
  c("lines of one paragraph join with a space; a blank line splits paragraphs",
    () => notesHtml("a\nb\n\nc") === "<p>a b</p>\n<p>c</p>");
  c("- items are one <ul>", () => notesHtml("- a\n- b") === "<ul><li>a</li><li>b</li></ul>");
  c("1. items are one <ol>", () => notesHtml("1. a\n2. b") === "<ol><li>a</li><li>b</li></ol>");
  c("switching - to 1. closes one list and opens the other",
    () => notesHtml("- a\n1. b") === "<ul><li>a</li></ul>\n<ol><li>b</li></ol>");
  c("an indented line continues the list item", () => notesHtml("- a\n  more") === "<ul><li>a more</li></ul>");
  c("a paragraph after a list closes the list", () => notesHtml("- a\nafter") === "<ul><li>a</li></ul>\n<p>after</p>");
  c("**bold**, *italic*, `code`", () => inline("**b** *i* `c`") === "<strong>b</strong> <em>i</em> <code>c</code>");
  c("an http(s) link becomes <a href>", () => inline("[Issues](https://x.org/i)") === '<a href="https://x.org/i">Issues</a>');
  c("a quote in text is kept as text (2.8\" must read as 2.8\")", () => inline('the 2.8" display') === 'the 2.8" display');

  // ---- nothing in the notes becomes markup of its own ----
  c("raw HTML in the notes comes out escaped", () => {
    const h = notesHtml("<script>alert(1)</script> & <img src=x onerror=y>");
    return !/<script|<img/.test(h) && h.includes("&lt;script&gt;") && h.includes("&amp;");
  });
  c("raw HTML inside **bold** is escaped too", () => !/<img/.test(inline("**<img src=x>**")));
  c("an unsupported construct (> quote) is escaped text, not markup", () => notesHtml("> q") === "<p>&gt; q</p>");
  c("a non-http link is not linked (javascript:)", () => !inline("[x](javascript:alert(1))").includes("<a"));
  c("a quote in a link URL cannot open a second attribute", () => {
    const h = inline('[x](https://a.org/"onmouseover="alert(1))');
    const tags = h.match(/<a\b[^>]*>/g) ?? [];
    // As TEXT the attribute is harmless; inside a tag it is not.
    return tags.every((t) => /^<a href="[^"]*">$/.test(t)) && !/<[^>]*onmouseover/.test(h);
  });
  c("`*` inside a code span stays literal", () => inline("`a*b*c` and `**x**`") === "<code>a*b*c</code> and <code>**x**</code>");

  // ---- the committed notes convert cleanly ----
  for (const [v, md] of Object.entries(NOTES)) {
    c(`notes/${v}.md leaves no Markdown behind and no tag we did not generate`, () => {
      const h = notesHtml(md);
      const stripped = h.replace(/<\/?(p|h[2-4]|ul|ol|li|strong|em|code)>|<a href="https?:\/\/[^"]*">|<\/a>/g, "");
      return h.length > 0 && !/\*\*|`|\]\(http/.test(h) && !stripped.includes("<");
    });
  }

  // ---- embedding into the feed ----
  const two = feed(item("0.1.10"), item("0.1.1"));
  const once = embedNotes(two, "0.1.1", "- one");
  c("embeds into the named version's item only; the other item is byte-identical",
    () => once.includes(item("0.1.10")) && (once.match(/<description>/g) ?? []).length === 1);
  c("0.1.1 does not match the 0.1.10 item (whole-tag match, not a prefix)", () => {
    const i10 = once.indexOf("<title>0.1.10</title>"), i1 = once.indexOf("<title>0.1.1</title>");
    const d = once.indexOf("<description>");
    return d > i1 && i1 > i10;
  });
  c("the description sits directly after the item's <title>",
    () => /<title>0\.1\.1<\/title>\n\s*<description><!\[CDATA\[/.test(once));
  c("embedding the same notes twice equals embedding once (an old description is replaced)",
    () => embedNotes(once, "0.1.1", "- one") === once);
  c("new notes replace the old ones, still exactly one description", () => {
    const again = embedNotes(once, "0.1.1", "- two");
    return (again.match(/<description>/g) ?? []).length === 1 && again.includes("two") && !again.includes("one</li>");
  });
  c("the enclosure and its signature are untouched", () => once.includes('<enclosure url="https://x/0.1.1.dmg" sparkle:edSignature="SIG0.1.1"/>'));
  c("a version with no item is refused (null), not written nowhere", () => embedNotes(two, "9.9.9", "x") === null);
  c("an item with no <title> is refused (null), not silently left without notes",
    () => embedNotes(feed("        <item><sparkle:shortVersionString>1.0.0</sparkle:shortVersionString></item>\n"), "1.0.0", "x") === null);
  const tricky = "costs $1, $& and $$ and $` and $' & <b> ]]> end";
  c("$ patterns in the notes round-trip through an XML parser verbatim (a function replacer)", () => {
    const xml = embedNotes(feed(item("1.0.0")), "1.0.0", tricky);
    return wellFormed(xml) && xmlDescription(xml).trim() === notesHtml(tricky);
  });

  // ---- the committed feed and publish.sh ----
  c("the committed feed is well-formed XML", () => wellFormed(text.appcast));
  const versions = [...text.appcast.matchAll(/<sparkle:shortVersionString>([^<]+)</g)].map((m) => m[1]);
  c("the committed feed has at least one item", () => versions.length > 0);
  for (const v of versions) {
    c(`the committed feed's ${v} item carries notes/${v}.md exactly (re-embedding changes nothing)`,
      () => v in NOTES && embedNotes(text.appcast, v, NOTES[v]) === text.appcast);
  }
  c("publish.sh copies the feed, THEN embeds the notes, THEN commits it", () => {
    const at = (re) => text.publish.search(re);
    const cp = at(/cp "\$DIST\/appcast\.xml" "\$R\/appcast\.xml"/);
    const emb = at(/node "\$R\/embed-notes\.mjs" "\$R\/appcast\.xml" "\$VERSION" "\$KEPT_NOTES" \|\| die/);
    const add = at(/git add "\$R\/appcast\.xml"/);
    return cp >= 0 && emb > cp && add > emb;
  });
  c("publish.sh defaults to the kept notes file", () => /\[ -z "\$NOTES" \] && \[ -f "\$KEPT_NOTES" \] && NOTES="\$KEPT_NOTES"/.test(text.publish));
  return out;
}

let failed = 0;
const real = await load(SRC);
if (spawnSync("xmllint", ["--version"]).status !== 0) console.log("  NOTE  xmllint missing: every XML claim below FAILS rather than passing unread");
for (const [name, ok] of claims(real, TEXT)) {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}`);
  if (!ok) failed++;
}

if (process.argv.includes("--selftest")) {
  console.log("SELFTEST (each edit of the real source must fail its named claim)");
  const edit = (file, find, repl) => ({ file, find, repl });
  const faults = [
    ["no escaping", edit("html", "return esc(s).split(", "return s.split("), "raw HTML in the notes comes out escaped"],
    ["a quote allowed in a link URL", edit("html", String.raw`[^)\s"]+`, String.raw`[^)\s]+`), "a quote in a link URL"],
    ["any scheme linked", edit("html", String.raw`(https?:\/\/`, String.raw`([a-z]+:`), "a non-http link is not linked"],
    ["code spans not protected", edit("html", "i % 2\n", "false\n"), "`*` inside a code span"],
    ["heading one level too high", edit("html", "m[1].length + 1", "m[1].length"), "### is h4"],
    ["list type switch ignored", edit("html", "if (!list || list.tag !== tag)", "if (!list)"), "switching - to 1."],
    ["a string replacer", edit("embed", "item.replace(TITLE, (t) => `${t}\\n            ${desc}`)", "item.replace(/(<title>[^<]*<\\/title>)/, `$1\\n            ${desc}`)"), "$ patterns in the notes"],
    ["the old description kept", edit("embed", String.raw`replace(/\s*<description>[\s\S]*?<\/description>/, "")`, "slice(0)"), "embedding the same notes twice"],
    ["version matched as a prefix", edit("embed", "${version}</sparkle:shortVersionString>", "${version}"), "0.1.1 does not match the 0.1.10 item"],
    ["no <title> silently accepted", edit("embed", "if (!TITLE.test(item)) return null;", ""), "an item with no <title> is refused"],
    ["publish.sh embeds after the commit's git add", edit("publish", null, (t) => t.replace(/  node "\$R\/embed-notes\.mjs"[^\n]*\n/, "").replace(/git commit -q/, (m) => `node "$R/embed-notes.mjs" "$R/appcast.xml" "$VERSION" "$KEPT_NOTES" || die x\n${m}`)), "publish.sh copies the feed, THEN embeds"],
    ["the committed feed lost its notes", edit("appcast", null, (t) => t.replace(/\s*<description>[\s\S]*?<\/description>/, "")), "the committed feed's"],
  ];
  let blind = 0;
  for (const [what, e, claim] of faults) {
    const src = { ...SRC }, text = { ...TEXT };
    const target = e.file in src ? src : text;
    const before = target[e.file];
    target[e.file] = typeof e.repl === "function" ? e.repl(before) : before.replace(e.find, e.repl);
    if (target[e.file] === before) { console.log(`  BLIND ${what} (the edit no longer applies - reword it)`); blind++; continue; }
    const results = claims(await load(src), text);
    const hit = results.filter(([n]) => n.startsWith(claim));
    if (hit.length && hit.some(([, ok]) => !ok)) console.log(`  caught ${what} -> "${hit.find(([, ok]) => !ok)[0]}"`);
    else { console.log(`  BLIND ${what}`); blind++; }
  }
  console.log(blind ? `selftest FAILED: ${blind} blind` : `selftest passed: all ${faults.length} faults caught`);
  process.exit(blind || failed ? 1 : 0);
}
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
