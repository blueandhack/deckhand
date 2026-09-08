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


// Cross-section of a mesh on the plane axis=val, as [[u,z],[u,z]] segments.
function sectionSegs(T, axis, val){
  const S=[], o = axis===0?1:0;
  for(const t of T){
    const d=[t[0][axis]-val,t[1][axis]-val,t[2][axis]-val];
    const hits=[];
    for(let i=0;i<3;i++){const j=(i+1)%3;
      if((d[i]<0&&d[j]>=0)||(d[j]<0&&d[i]>=0)){
        const f=d[i]/(d[i]-d[j]);
        hits.push([t[i][o]+f*(t[j][o]-t[i][o]), t[i][2]+f*(t[j][2]-t[i][2])]);}}
    if(hits.length===2) S.push(hits);
  }
  return S;
}
// Every crossing of the horizontal line z with those segments, sorted.
function crossings(S, z){
  const o=[];
  for(const [a,b] of S){
    const lo=Math.min(a[1],b[1]), hi=Math.max(a[1],b[1]);
    if(z<lo-1e-9||z>hi+1e-9) continue;
    o.push(Math.abs(b[1]-a[1])<1e-9 ? Math.min(a[0],b[0])
          : a[0]+(z-a[1])/(b[1]-a[1])*(b[0]-a[0]));
  }
  o.sort((p,q)=>p-q);
  const u=[];                       // a tangency yields the same crossing twice,
  for(const x of o)                 // which would read as a zero-thickness wall
    if(!u.length || x-u[u.length-1] > 1e-6) u.push(x);
  return u;
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
    'ks_leaf_l', 'ks_lug_y', 'total_th', 'out_w',
    'cover_rise', 'cover_th', 'soft_r', 'cover_edge_top', 'cover_edge_shoulder',
    'z_pcb_b', 'screw_pillar_gap', 'screw_boss_d', 'screw_pad_z',
    'holes()[0][0]', 'holes()[0][1]'
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

  // ---- the cover's OUTER EDGE, measured by slicing it ----
  // The flange this guards against was found by slicing, not by reading the
  // source: at z=5.00 the skin stood at 2.100 and at 5.05 at 2.850 - a 0.75 mm
  // lip on a 0.01 mm ledge, with ZERO wall thickness under it. It came of a
  // taper hull and a rim soft_box disagreeing about one outline, so what is
  // asserted is the property neither of them individually had: going down the
  // outside, the cover only ever gets WIDER until the rim's bottom chamfer.
  // ASSEMBLY frame, the same one stand_placed() uses - the plan extents of the two
  // meshes are compared below, and cover()'s own frame is both flipped and offset.
  writeFileSync(join(dir,'c.scad'),
    `part="none";\ninclude <${scadPath}>\n` +
    `translate([out_w,0,total_th]) rotate([0,180,0]) cover();\n`);
  const cvf = join(dir,'cover.stl');
  execFileSync('openscad', ['--export-format=binstl','-o',cvf,'-D','$fn=48',
    '-D','part="none"', join(dir,'c.scad')], { stdio:['ignore','ignore','ignore'] });
  const cs = sectionSegs(stlTris(cvf), 1, 54);
  const zLast = v.cover_rise + v.cover_th - v.soft_r*0.5;   // before the bottom chamfer
  let worstStep = 0, worstZ = 0, minWall = Infinity;
  let prevW = null;
  for (let d = 0; d <= zLast + 1e-9; d += 0.05) {          // d = depth below the outer face
    const z = v.total_th - d;
    const c = crossings(cs, z);
    if (c.length < 2) continue;
    const w = c[c.length-1] - c[0];                // full outside width at this depth
    if (prevW !== null && prevW - w > worstStep) { worstStep = prevW - w; worstZ = d; }
    prevW = w;
    if (d >= 2.2) { const t = c[1]-c[0]; if (t < minWall) minWall = t; }
  }
  check('the outside never steps back inward - no perimeter flange',
    worstStep < 0.15,
    worstStep < 0.15 ? `widens monotonically to the chamfer`
                     : `steps in ${worstStep.toFixed(2)} mm at depth ${worstZ.toFixed(2)}`);
  check('the skirt keeps a wall', minWall > 1.2,
    `thinnest ${minWall.toFixed(2)} mm over z 2.2..${zLast.toFixed(1)} (the flange measured 0.00)`);

  // ---- the kickstand blade must land on FLAT plateau, not on the fillet ----
  // Both extents are MEASURED off the two meshes. The flat top is read as the
  // cover's topmost face, not recomputed from edge_t1 - a derivation checked
  // against its own term always holds.
  const ct = stlTris(cvf);
  const flat = {x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity};
  for (const t of ct) for (const p of t) if (Math.abs(p[2]-v.total_th) < 0.01) {
    flat.x0=Math.min(flat.x0,p[0]); flat.x1=Math.max(flat.x1,p[0]);
    flat.y0=Math.min(flat.y0,p[1]); flat.y1=Math.max(flat.y1,p[1]);
  }
  const blTris = stlTris(st);       // the PLACED stand, folded
  const bl = {x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity};
  for (const t of blTris) for (const p of t) if (p[2] < v.total_th + 0.15) {
    bl.x0=Math.min(bl.x0,p[0]); bl.x1=Math.max(bl.x1,p[0]);
    bl.y0=Math.min(bl.y0,p[1]); bl.y1=Math.max(bl.y1,p[1]);
  }
  const marg = [bl.x0-flat.x0, flat.x1-bl.x1, bl.y0-flat.y0, flat.y1-bl.y1];
  check('the folded blade lands on FLAT plateau, not on the top fillet',
    Math.min(...marg) >= 0.4,
    `margins  -x ${marg[0].toFixed(2)}  +x ${marg[1].toFixed(2)}  ` +
    `-y ${marg[2].toFixed(2)}  +y ${marg[3].toFixed(2)}  (tip was 0.12 before ks_leaf_l was derived)`);

  // ---- the screw pillar must stop SHORT of the board, and not by much ----
  // Reported as "you did not count board thickness". It was counted - the pillar
  // bottomed at exactly z_pcb_b - but the nominal was ZERO, the only such fit in
  // the file. The two failures are not symmetric, which is why this is a band and
  // not a minimum: too LONG and the pillar grounds on the board before the cover's
  // rim reaches the body, so the seam gapes and no screw fixes it; too SHORT and
  // the pillar stops clamping the board and becomes decoration.
  const hx = v['holes()[0][0]'], hy = v['holes()[0][1]'];
  let pillarZ = Infinity;
  for (const t of ct) for (const p of t) {
    const dx = p[0]-hx, dy = p[1]-hy;
    if (dx*dx + dy*dy <= (v.screw_boss_d/2 + 0.2)**2 && p[2] < pillarZ) pillarZ = p[2];
  }
  const short = pillarZ - v.z_pcb_b;
  // THE UPPER BOUND IS GONE ON PURPOSE. It used to be 0.6, on the reasoning that a
  // bigger gap gives up the clamp - which is true, and has been chosen deliberately
  // (screw_pillar_gap = 2.0). AN ASSERTION THAT ENCODES A REJECTED PREFERENCE IS NOT
  // A CHECK, it is a disagreement that fails the build every time. What remains is
  // the half that is still a DEFECT rather than a decision: grounding on the board.
  // >= 0, NOT >= 0.15. The 0.15 was a margin I wanted and the design does not: a
  // zero nominal here is now a choice (screw_pillar_gap = 0), so asserting a margin
  // would be encoding a rejected preference again. What is still a DEFECT rather
  // than a decision is the pillar reaching PAST the board's back - interference,
  // where the two solids occupy the same space.
  check('the screw pillar does not reach past the board', short >= -1e-6,
    `bottoms at ${pillarZ.toFixed(3)}, board back is ${v.z_pcb_b.toFixed(3)} ` +
    `-> ${short.toFixed(3)} mm (negative is interference; 0 is a zero-clearance fit)`);
  const pillarLen = (v.total_th - v.z_pcb_b) - v.screw_pad_z - v.screw_pillar_gap;
  check('the pillar is still a pillar', pillarLen >= 5.0,
    `${pillarLen.toFixed(2)} mm long below its landing`);

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
  // The historical construction, restored verbatim: a rim that chamfers its own top
  // plus a taper whose hull reaches the FULL rim outline. Each is fine alone.
  { name: 'the cover goes back to a rim and a taper that disagree at z=rim0',
    patch: s => s
      .replace(/      if \(!\(cover_rise > 0 && cover_taper\)\)\n        translate\(\[wall-0\.1/,
               '      translate([wall-0.1')
      .replace(/          cover_outer\(\);/,
`          hull(){
            translate([plat_x0+pw/2, plat_y0+ph/2, 0])
              linear_extrude(0.01) rrect_c(pw, ph, 3);
            translate([wall-0.1+(in_w+0.2)/2, wall-0.1+(in_h+0.2)/2, rim0])
              linear_extrude(0.01) rrect_c(in_w+0.2, in_h+0.2, max(oc_r-wall,2));
          }`),
    expect: 'the outside never steps back inward - no perimeter flange' },
  { name: 'ks_leaf_margin stops tracking the top fillet (blade too WIDE)',
    patch: s => s.replace(/^ks_leaf_margin = 0\.6 \+ edge_t1\([^;]+;/m, 'ks_leaf_margin = 0.6;'),
    expect: 'the folded blade lands on FLAT plateau, not on the top fillet' },
  { name: 'ks_leaf_l goes back to a fraction of the case (blade too LONG)',
    patch: s => s.replace(/^ks_leaf_l  = plat_y1 - edge_t1\([\s\S]*?cover_rise\) - ks_lug_y - 0\.6;/m,
                          'ks_leaf_l  = out_h*0.60;'),
    expect: 'the folded blade lands on FLAT plateau, not on the top fillet' },
  { name: 'the pillar drives INTO the board',
    patch: s => s.replace(/^screw_pillar_gap = 0\.0;/m, 'screw_pillar_gap = -0.5;'),
    expect: 'the screw pillar does not reach past the board' },
  { name: 'the pillar is cut back until it is only a stub',
    patch: s => s.replace(/^screw_pillar_gap = 0\.0;/m, 'screw_pillar_gap = 9.0;'),
    expect: 'the pillar is still a pillar' },
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
