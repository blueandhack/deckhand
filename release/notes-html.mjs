#!/usr/bin/env node
// Release notes Markdown -> the HTML Sparkle shows in its update window.
//
//   node release/notes-html.mjs release/notes/0.1.3.md   > notes.html
//
// WHY THIS EXISTS. Sparkle shows release notes only when the appcast carries them, and
// generate_appcast writes none unless handed an HTML file - so through 0.1.3 the update
// window was EMPTY, while the same notes sat on the GitHub release page. publish.sh now
// embeds this file's output in the feed item as <description>.
//
// A deliberately small subset - what these notes actually use: paragraphs, ### headings,
// "- " and "1. " lists, **bold**, *italic*, `code`, [links](url). Not a general Markdown
// engine, and no dependency: the release machine needs nothing new. Anything it does not
// recognise comes out as escaped text, never as raw HTML.
import fs from "node:fs";

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function inline(s) {
  // Escape first, then add only the markup we generate, so no input can inject HTML.
  // Code spans are cut out BEFORE the other rules run (the odd parts of the split), so
  // `a*b*c` stays literal instead of italicising its middle. A link URL may not contain
  // `"`: esc() leaves quotes alone (text needs them, e.g. 2.8"), and one inside href=""
  // would close the attribute and open another - notes-check.mjs asserts both.
  return esc(s).split(/(`[^`]+`)/).map((part, i) => i % 2
    ? `<code>${part.slice(1, -1)}</code>`
    : part
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s"]+)\)/g, '<a href="$2">$1</a>')
  ).join("");
}

export function notesHtml(md) {
  const out = [];
  let para = [], list = null;
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(" "))}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`); list = null; } };
  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) {
      flushPara(); flushList();
      const n = Math.min(4, m[1].length + 1);   // "###" -> h4: the window's own title is the h1
      out.push(`<h${n}>${inline(m[2])}</h${n}>`);
      continue;
    }
    if ((m = /^\s*(-|\d+\.)\s+(.*)$/.exec(line))) {
      flushPara();
      const tag = m[1] === "-" ? "ul" : "ol";
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push(m[2]);
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) { list.items[list.items.length - 1] += " " + line.trim(); continue; }
    flushList();
    para.push(line.trim());
  }
  flushPara(); flushList();
  return out.join("\n");
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) {
  const file = process.argv[2];
  if (!file) { console.error("usage: notes-html.mjs <notes.md>"); process.exit(2); }
  process.stdout.write(notesHtml(fs.readFileSync(file, "utf8")) + "\n");
}
