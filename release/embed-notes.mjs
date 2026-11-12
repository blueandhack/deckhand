#!/usr/bin/env node
// Put a version's release notes INTO its appcast item, so Sparkle's update window shows
// them (through 0.1.3 it showed nothing - see notes-html.mjs).
//
//   node release/embed-notes.mjs <appcast.xml> <x.y.z> <notes.md>
//
// Rewrites the item whose <sparkle:shortVersionString> is x.y.z, replacing any
// <description> it already has. The notes are NOT covered by the EdDSA signature -
// generate_appcast signs the enclosure (the DMG), not the feed's text - so adding them
// after generate_appcast changes nothing Sparkle verifies. Refuses (exit 1) when the
// version's item is not in the file, rather than writing notes nowhere.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { notesHtml } from "./notes-html.mjs";

export function embedNotes(xml, version, md) {
  // CDATA cannot contain "]]>"; split it across two sections if the notes ever do.
  const html = notesHtml(md).replace(/]]>/g, "]]]]><![CDATA[>");
  const desc = `<description><![CDATA[\n${html}\n]]></description>`;
  const items = [...xml.matchAll(/<item>[\s\S]*?<\/item>/g)];
  const it = items.find((m) => m[0].includes(`<sparkle:shortVersionString>${version}</sparkle:shortVersionString>`));
  if (!it) return null;
  let item = it[0].replace(/\s*<description>[\s\S]*?<\/description>/, "");
  const TITLE = /<title>[^<]*<\/title>/;
  if (!TITLE.test(item)) return null;    // nowhere to anchor the notes: refuse, never drop them
  // A FUNCTION replacer: a string one would read `$1`, `$&`, `$$` in the NOTES as patterns
  // ("costs $1" became the item's <title>). notes-check.mjs asserts the round trip.
  item = item.replace(TITLE, (t) => `${t}\n            ${desc}`);
  return xml.slice(0, it.index) + item + xml.slice(it.index + it[0].length);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const [file, version, notes] = process.argv.slice(2);
  if (!file || !version || !notes) { console.error("usage: embed-notes.mjs <appcast.xml> <x.y.z> <notes.md>"); process.exit(2); }
  const out = embedNotes(fs.readFileSync(file, "utf8"), version, fs.readFileSync(notes, "utf8"));
  if (out === null) { console.error(`embed-notes: no item with a <title> for ${version} in ${file}`); process.exit(1); }
  fs.writeFileSync(file, out);
  console.log(`embedded ${notes} into ${file} (${version})`);
}
