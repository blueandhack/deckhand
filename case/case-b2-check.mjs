#!/usr/bin/env node
// Offline checks for board 2's KICKSTAND HINGE and blade.
//
// Two halves, reported separately, because they prove different things and one of
// them proves less than it looks:
//
//   STRUCTURAL - reads the .scad's own TEXT. This is the half that binds. It fails
//                when a derivation is replaced by a hand-computed literal, or when
//                the hinge reaches back into m3_clear.
//   GEOMETRIC  - runs OpenSCAD and measures the exported meshes. Every constant it
//                uses is PARSED from an echo, never transcribed here, so reverting
//                a constant in the .scad moves the checker's own expectations too
//                and can still fail.
//
// Run:  node case/case-b2-check.mjs [--selftest]
// --selftest injects four faults and exits 0 ONLY if every one of them is caught
// by the assertion that is supposed to catch it, BY NAME.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCAD = join(HERE, 'deckhand_case_b2.scad');
const SELFTEST = process.argv.includes('--selftest');

let failures = [];
function check(name, ok, detail) {
  if (ok) { if (!SELFTEST) console.log(`  ok   ${name}${detail ? '  ' + detail : ''}`); }
  else { failures.push(name); if (!SELFTEST) console.log(`  FAIL ${name}${detail ? '  ' + detail : ''}`); }
}

// ---------------------------------------------------------------- helpers
// Pull one module's BODY out of the source. Assertions must bind to the body and
// not to the file: replacing a body wholesale once passed 70 assertions in this
// repo because a copy of the expression lived in the next module along.
function moduleBody(src, name) {
  const start = src.indexOf(`module ${name}(`);
  if (start < 0) throw new Error(`module ${name}() not found`);
  const open = src.indexOf('{', start);
  let depth = 0, i = open;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(open, i + 1);
}

function scadEcho(scadPath, exprs, defines = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'b2chk-'));
  const probe = join(dir, 'probe.scad');
  const out = join(dir, 'out.echo');
  writeFileSync(probe,
    `include <${scadPath}>\n` +
    exprs.map(e => `echo("@@", "${e}", ${e});`).join('\n') + '\n');
  const args = ['--export-format=echo', '-o', out, '-D', 'part="none"'];
  for (const [k, v] of Object.entries(defines)) args.push('-D', `${k}=${v}`);
  args.push(probe);
  execFileSync('openscad', args, { stdio: ['ignore', 'ignore', 'ignore'] });
  const text = readFileSync(out, 'utf8');
  const vals = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^ECHO: "@@", "([^"]+)", (.+)$/);
    if (m) vals[m[1]] = parseFloat(m[2]);
  }
  rmSync(dir, { recursive: true, force: true });
  return vals;
}

// Signed volume of a binary STL. The RIGHT measure for "does the folded blade go
// INTO the cover": the blade now rests FLAT on the plateau, so the intersection is
// a real coplanar surface with 16 facets and zero height. A facet COUNT calls that
// a collision; a volume calls it contact, which is what it is.
function stlVolume(path) {
  const b = readFileSync(path);
  const n = b.readUInt32LE(80);
  let V = 0;
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50 + 12;
    const p = [];
    for (let k = 0; k < 3; k++)
      p.push([b.readFloatLE(o + k * 12), b.readFloatLE(o + k * 12 + 4), b.readFloatLE(o + k * 12 + 8)]);
    const [a, c, d] = p;
    V += (a[0] * (c[1] * d[2] - d[1] * c[2])
        - a[1] * (c[0] * d[2] - d[0] * c[2])
        + a[2] * (c[0] * d[1] - d[0] * c[1])) / 6;
  }
  return Math.abs(V);
}

// Ray-sample the upper surface of a mesh on a vertical line.
function heightAt(tris, x, y) {
  let best = -Infinity;
  for (const [a, b, c] of tris) {
    const den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(den) < 1e-9) continue;
    const w1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / den;
    const w2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / den;
    const w3 = 1 - w1 - w2;
    if (w1 < -1e-6 || w2 < -1e-6 || w3 < -1e-6) continue;
    const z = w1 * a[2] + w2 * b[2] + w3 * c[2];
    if (z > best) best = z;
  }
  return best;
}
function stlTris(path) {
  const b = readFileSync(path);
  const n = b.readUInt32LE(80);
  const T = [];
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50 + 12, v = [];
    for (let k = 0; k < 3; k++)
      v.push([b.readFloatLE(o + k * 12), b.readFloatLE(o + k * 12 + 4), b.readFloatLE(o + k * 12 + 8)]);
    T.push(v);
  }
  return T;
}

// ---------------------------------------------------------------- the checks
function run(scadPath) {
  failures = [];
  const src = readFileSync(scadPath, 'utf8');

  // ---- STRUCTURAL: the .scad's own text ----
  const standBody = moduleBody(src, 'stand');
  const coverBody = moduleBody(src, 'cover');

  check('ks_barrel is DERIVED from the head and the rim, not a literal',
    /ks_barrel\s*=\s*(?:mm\()?\s*ks_head_d\s*\+\s*2\s*\*\s*ks_head_rim\s*\)?\s*;/.test(src),
    '(a hand-computed copy is what goes stale when the head moves)');

  // Every derived FIT goes through mm(). Without it btn_guide_d evaluates to
  // 4.199999999999999 and moves six vertices in the exported cover - a hash change
  // on a revision whose claim was that the cover does not change.
  for (const c of ['ks_barrel', 'ks_head_d', 'ks_bore', 'ks_pilot', 'btn_guide_d']) {
    const m = src.match(new RegExp(`^${c}\\s*=\\s*([^;]+);`, 'm'));
    check(`${c} is quantised with mm()`, !!m && /^mm\(/.test(m[1].trim()),
      m ? `= ${m[1].trim()}` : '(not found)');
  }

  // The button pair the gauge settled: hole loses print_shrink, stem gains
  // print_grow, and what is left is the fit you can actually assemble.
  const bt = scadEcho(scadPath,
    ['btn_stem_d', 'btn_guide_d', 'btn_fit', 'print_shrink', 'print_grow']);
  const printedClear = (bt.btn_guide_d - bt.print_shrink) - (bt.btn_stem_d + bt.print_grow);
  check('the button actually goes in', printedClear >= 0.2 && printedClear <= 0.5,
    `printed stem ${(bt.btn_stem_d + bt.print_grow).toFixed(2)} in printed hole ` +
    `${(bt.btn_guide_d - bt.print_shrink).toFixed(2)} = ${printedClear >= 0 ? '+' : ''}` +
    `${printedClear.toFixed(2)} (negative is the defect that started this)`);

  check('stand() bores with ks_bore and never reaches into m3_clear',
    /\bks_bore\b/.test(standBody) && !/\bm3_clear\b/.test(standBody),
    '(M2 must not leak out of the hinge)');

  check('cover() still uses m3_clear for the stack screws',
    /\bm3_clear\b/.test(coverBody),
    '(the four case screws stay M3)');

  for (const c of ['ks_pilot', 'ks_head_d', 'ks_bore']) {
    const m = src.match(new RegExp(`^${c}\\s*=\\s*([^;]+);`, 'm'));
    check(`${c} carries print_shrink`,
      !!m && /print_shrink/.test(m[1]),
      m ? `= ${m[1].trim()}` : '(not found)');
  }

  // ---- GEOMETRIC: parsed constants and measured meshes ----
  const v = scadEcho(scadPath, [
    'ks_barrel', 'ks_head_d', 'ks_head_rim', 'ks_bore', 'ks_pilot',
    'ks_boss_w', 'ks_ear_w', 'ks_head_h', 'ks_hgap', 'ks_leaf_th',
    'ks_leaf_l', 'ks_lug_y', 'total_th', 'out_w'
  ]);

  const rim = (v.ks_barrel - v.ks_head_d) / 2;
  check('buried head keeps its rim', rim >= v.ks_head_rim - 1e-6,
    `rim ${rim.toFixed(2)} >= ${v.ks_head_rim} (0.6 cracked)`);

  const bossWall = (v.ks_barrel - v.ks_pilot) / 2;
  check('boss wall survives a thread-forming screw', bossWall >= 2.0,
    `wall ${bossWall.toFixed(2)} >= 2.00`);

  const noseWall = (v.ks_barrel - v.ks_bore) / 2;
  check('nose wall around the axle bore', noseWall >= 1.5,
    `wall ${noseWall.toFixed(2)} >= 1.50`);

  const engage = 8 - (v.ks_ear_w - v.ks_head_h) - v.ks_hgap;
  check('an M2 x 8 reaches into the boss', engage >= 4.0 && engage <= v.ks_boss_w,
    `engagement ${engage.toFixed(2)} in a ${v.ks_boss_w} boss`);

  // meshes
  const dir = mkdtempSync(join(tmpdir(), 'b2geo-'));
  const probe = join(dir, 'p.scad');
  writeFileSync(probe,
    `part="none"; what="stand";\ninclude <${scadPath}>\n` +
    `if (what=="hit") intersection(){ translate([out_w,0,total_th]) rotate([0,180,0]) cover(); stand_placed(); }\n` +
    `else stand_placed();\n`);
  const build = (what, file, extra = []) => execFileSync('openscad',
    ['--export-format=binstl', '-o', file, '-D', '$fn=28', '-D', 'part="none"',
     '-D', `what="${what}"`, ...extra, probe],
    { stdio: ['ignore', 'ignore', 'ignore'] });

  const hit = join(dir, 'hit.stl'), st = join(dir, 'st.stl');
  build('hit', hit); build('stand', st);

  const hv = stlVolume(hit);
  check('the folded blade does not penetrate the cover', hv < 1e-3,
    `intersection volume ${hv.toFixed(4)} mm3 (contact is coplanar, so 0)`);

  const tris = stlTris(st);
  const y0 = v.ks_lug_y + 18, y1 = v.ks_lug_y + v.ks_leaf_l - 14;
  const hs = [];
  for (let y = y0; y <= y1; y += 2) {
    const h = heightAt(tris, v.out_w / 2, y);
    if (h > -1e8) hs.push(h - v.total_th);
  }
  const spread = Math.max(...hs) - Math.min(...hs);
  check('the blade is CONSTANT thickness, not a wedge', spread < 0.05,
    `varies ${spread.toFixed(3)} mm over y ${y0.toFixed(0)}..${y1.toFixed(0)}; ` +
    `sits ${Math.max(...hs).toFixed(2)} above the case`);

  check('the blade sits at ks_leaf_th', Math.abs(Math.max(...hs) - v.ks_leaf_th) < 0.05,
    `measured ${Math.max(...hs).toFixed(2)} vs ks_leaf_th ${v.ks_leaf_th}`);

  rmSync(dir, { recursive: true, force: true });
  return failures;
}

// ---------------------------------------------------------------- selftest
// An assertion that cannot fail is a defect. Each fault below must be caught by
// the NAMED assertion that exists to catch it - not merely by "something failed".
const FAULTS = [
  { name: 'ks_barrel hand-computed back to a literal',
    patch: s => s.replace(/ks_barrel\s*=\s*mm\(ks_head_d \+ 2\*ks_head_rim\);/, 'ks_barrel  = 7.0;'),
    expect: 'ks_barrel is DERIVED from the head and the rim, not a literal' },
  { name: 'stand() reaches back into m3_clear',
    patch: s => s.replace(/^(\s*)bore = ks_bore;/m, '$1bore = m3_clear + 0.3;'),
    expect: 'stand() bores with ks_bore and never reaches into m3_clear' },
  { name: 'ks_pilot loses its print_shrink term',
    patch: s => s.replace(/^ks_pilot\s*=\s*mm\(1\.6 \+ print_shrink\);/m, 'ks_pilot   = 1.6;'),
    expect: 'ks_pilot carries print_shrink' },
  // NOT "set the stem back to 4.0": btn_guide_d is derived FROM the stem now, so
  // moving the stem drags the hole with it and the fit stays correct - which is the
  // derivation doing its job. The defect this has to catch is the original wrong
  // RELATION, where the clearance was stated as a modelled figure and the hole
  // never carried print_shrink at all.
  { name: 'btn_guide_d goes back to the modelled-clearance relation',
    patch: s => s.replace(/^btn_guide_d\s*=\s*mm\([^;]+\);/m,
                          'btn_guide_d  = btn_stem_d + 0.2;'),
    expect: 'the button actually goes in' },
  { name: 'btn_guide_d loses mm() and drifts off 4.2',
    patch: s => s.replace(/^btn_guide_d\s*=\s*mm\(([^;]+)\);/m, 'btn_guide_d  = $1;'),
    expect: 'btn_guide_d is quantised with mm()' },
  { name: 'the blade goes back to a wedge',
    patch: s => s.replace(/^ks_leaf_ramp = 10;/m, 'ks_leaf_ramp = 55;'),
    expect: 'the blade is CONSTANT thickness, not a wedge' },
  { name: 'the axle is dropped so the blade buries itself',
    patch: s => s.replace(/^ks_axle_z\s*=\s*-ks_bz;/m, 'ks_axle_z  = -ks_bz + 3.0;'),
    expect: 'the folded blade does not penetrate the cover' },
];

if (!SELFTEST) {
  console.log('board 2 kickstand hinge — structural + geometric\n');
  const f = run(SCAD);
  console.log(f.length ? `\n${f.length} FAILED` : '\nall checks passed');
  process.exit(f.length ? 1 : 0);
} else {
  console.log('selftest: each fault must be caught BY NAME\n');
  const src = readFileSync(SCAD, 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'b2self-'));
  let bad = 0;
  for (const flt of FAULTS) {
    const patched = flt.patch(src);
    if (patched === src) { console.log(`  FAIL  ${flt.name}: patch did not apply`); bad++; continue; }
    const p = join(dir, 'deckhand_case_b2.scad');
    writeFileSync(p, patched);
    let caught;
    try { caught = run(p).includes(flt.expect); }
    catch (e) { caught = false; }
    console.log(`  ${caught ? 'ok   ' : 'FAIL '} ${flt.name}\n         -> ${flt.expect}`);
    if (!caught) bad++;
  }
  rmSync(dir, { recursive: true, force: true });
  console.log(bad ? `\n${bad} fault(s) NOT caught` : '\nevery fault caught');
  process.exit(bad ? 1 : 0);
}
