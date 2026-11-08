// node release/check-host-imports.mjs <staged-host-dir>
//
// Every import in the staged host must RESOLVE in the staged tree. build-release.sh's
// smoke test cannot load index.mjs - it would start CoreBluetooth, and a Node with no
// Info.plist is killed by TCC on the spot - so a module index.mjs imports but that was
// never committed (`git archive` leaves it out) used to ship and crash the host at
// start with nothing in the build noticing. Static, so nothing runs: each relative
// import must be a staged file, and each package must resolve from the staged
// node_modules. Exits 1 naming every miss.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const dir = path.resolve(process.argv[2] ?? ".");
const require = createRequire(path.join(dir, "/"));
// Real import statements only, never prose: a comment saying `... from "x"` must not
// count (the first version of this check flagged a dozen sentences). Anchored forms:
// `import ... from "x"` on one line, the `} from "x"` that closes a multi-line import,
// `export ... from "x"`, a bare `import "x"`, and a dynamic `import("x")`.
const IMPORTS = [
  /^\s*(?:import|export)\s[^\n]*?\bfrom\s*["']([^"']+)["']/gm,
  /^\s*\}\s*from\s*["']([^"']+)["']/gm,
  /^\s*import\s*["']([^"']+)["']/gm,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
];

const bad = [];
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".mjs"))) {
  const src = fs.readFileSync(path.join(dir, f), "utf8");
  const specs = new Set(IMPORTS.flatMap((re) => [...src.matchAll(re)].map((m) => m[1])));
  for (const spec of specs) {
    if (spec.startsWith("node:")) continue;
    if (spec.startsWith(".")) {
      if (!fs.existsSync(path.join(dir, spec))) bad.push(`${f}: ${spec} is not in the bundle`);
      continue;
    }
    try { require.resolve(spec); } catch { bad.push(`${f}: package ${spec} does not resolve`); }
  }
}
if (bad.length) {
  console.error(bad.join("\n"));
  process.exit(1);
}
console.log("  every host import resolves");
