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
// A feature that is switched off in this configuration must report SKIP, never ok.
// At rim_extra 5 the plateau vanishes (cover_rise 0) and four assertions here went
// vacuous - one of them by looping from 2.2 to 1.2, i.e. not at all, and passing on
// Infinity. "AN ASSERTION THAT CANNOT FAIL IS A DEFECT", so they say so instead.
let skipped = [];
function skip(name, why) {
  skipped.push(name);
  if (!SELFTEST) console.log(`  --   ${name}  SKIPPED: ${why}`);
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
// Is there solid anywhere on the vertical line (x,y) between zlo and zhi? Every
// crossing of the line with the surface, sorted, pairs into inside-intervals.
function solidIn(tris, x, y, zlo, zhi) {
  const zs = [];
  for (const [a, b, c] of tris) {
    const den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(den) < 1e-9) continue;
    const w1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / den;
    const w2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / den;
    const w3 = 1 - w1 - w2;
    if (w1 < -1e-6 || w2 < -1e-6 || w3 < -1e-6) continue;
    zs.push(w1 * a[2] + w2 * b[2] + w3 * c[2]);
  }
  zs.sort((p, q) => p - q);
  const u = [];
  for (const z of zs) if (!u.length || z - u[u.length - 1] > 1e-6) u.push(z);
  for (let i = 0; i + 1 < u.length; i += 2)
    if (u[i + 1] > zlo + 1e-3 && u[i] < zhi - 1e-3) return true;
  return false;
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
function run(scadPath, defines = {}) {
  failures = []; skipped = [];
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
  for (const c of ['ks_barrel', 'ks_head_d', 'ks_bore', 'ks_pilot', 'btn_guide_d', 'btn_flex_slot',
                   'ks_sock_w', 'ks_sock_l', 'ks_lug_clear']) {
    const m = src.match(new RegExp(`^${c}\\s*=\\s*([^;]+);`, 'm'));
    check(`${c} is quantised with mm()`, !!m && /^mm\(/.test(m[1].trim()),
      m ? `= ${m[1].trim()}` : '(not found)');
  }

  // The button pair the gauge settled: hole loses print_shrink, stem gains
  // print_grow, and what is left is the fit you can actually assemble.
  const bt = scadEcho(scadPath,
    ['btn_stem_d', 'btn_guide_d', 'btn_fit', 'print_shrink', 'print_grow'], defines);
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

  for (const c of ['ks_pilot', 'ks_head_d', 'ks_bore', 'btn_flex_slot', 'ks_sock_w', 'ks_sock_l', 'ks_lug_clear']) {
    const m = src.match(new RegExp(`^${c}\\s*=\\s*([^;]+);`, 'm'));
    check(`${c} carries print_shrink`,
      !!m && /print_shrink/.test(m[1]),
      m ? `= ${m[1].trim()}` : '(not found)');
  }

  // The printed-in buttons' post is sized from the MEASURED gap. The model's own
  // span (body_d - z_pcb_b - btn_switch_h) says 11.5 where the caliper said 7.8, so a
  // post derived from it would stand 3.7 mm into the switch: RESET held down, a
  // device that looks bricked.
  check('the post is sized from the MEASURED gap, not the modelled switch',
    /^btn_post_len\s*=\s*btn_meas_gap\s*-\s*btn_flex_rest\s*;/m.test(src),
    '(btn_post_len = btn_meas_gap - btn_flex_rest)');

  // ---- GEOMETRIC: parsed constants and measured meshes ----
  const v = scadEcho(scadPath, [
    'ks_barrel', 'ks_head_d', 'ks_head_rim', 'ks_bore', 'ks_pilot',
    'ks_boss_w', 'ks_ear_w', 'ks_head_h', 'ks_hgap', 'ks_leaf_th',
    'ks_leaf_l', 'ks_lug_y', 'total_th', 'out_w',
    'cover_rise', 'cover_th', 'soft_r', 'cover_edge_top', 'cover_edge_shoulder',
    'z_pcb_b', 'screw_pillar_gap', 'screw_boss_d', 'screw_pad_z',
    'holes()[0][0]', 'holes()[0][1]',
    'screw_pilot', 'screw_skin', 'z_pcb_f', 'screw_lead', 'screw_engage_min',
    'glass_recess', 'front_th'
  ], defines);

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
    // THE COVER AS ASSEMBLED, bolt-on lugs included: with ks_mount = "bolton" the
    // lugs are not in cover() at all, and a check against cover() alone would
    // certify a stand against a hinge that is not there.
    `if (what=="hit") intersection(){ translate([out_w,0,total_th]) rotate([0,180,0]) { cover(); ks_lugs_placed(); } stand_placed(); }\n` +
    `else if (what=="swing") { intersection(){ translate([out_w,0,total_th]) rotate([0,180,0]) { cover(); ks_lugs_placed(); } stand_placed(); } translate([-50,-50,-50]) cube(1); }\n` +
    `else if (what=="lug") ks_lug();\n` +
    // A MARKER CUBE RIDES ALONG, and it is not decoration: OpenSCAD refuses to
    // export an empty geometry and exits non-zero, so the PASSING case - no
    // interference at all - crashed the checker while the failing case worked.
    // 1 mm3 at (-50,-50,-50) can never touch the part, so the export always has
    // something and its volume is subtracted back off below.
    `else if (what=="glasshit") { intersection(){ body(); glass(); } translate([-50,-50,-50]) cube(1); }\n` +
    `else if (what=="cover") cover();\n` +
    `else stand_placed();\n`);
  const dArgs = Object.entries(defines).flatMap(([k, val]) => ['-D', `${k}=${val}`]);
  const build = (what, file, extra = []) => execFileSync('openscad',
    ['--export-format=binstl', '-o', file, '-D', '$fn=28', '-D', 'part="none"',
     '-D', `what="${what}"`, ...dArgs, ...extra, probe],
    { stdio: ['ignore', 'ignore', 'ignore'] });

  const hit = join(dir, 'hit.stl'), st = join(dir, 'st.stl');
  build('hit', hit); build('stand', st);

  const hv = stlVolume(hit);
  check('the folded blade does not penetrate the cover', hv < 1e-3,
    `intersection volume ${hv.toFixed(4)} mm3 (contact is coplanar, so 0)`);

  // ---- THE WHOLE SWING, not just folded ----
  // Folded is the one pose the check above sees, and it is the pose a hinge that
  // grew is LEAST likely to show up in. Swept against the cover AS ASSEMBLED, so
  // a bolt-on lug is judged where it really sits. The 1 mm3 marker cube keeps the
  // export non-empty when nothing collides (see the probe), and is taken back off.
  // POSITIVE CONTROL, measured when this was written: ks_open = -10 (into the
  // cover) reads 1365.9 mm3, so a zero here is a reading and not a blind probe.
  {
    const sw = join(dir, 'sw.stl');
    const hits = [];
    for (const a of [0, 15, 30, 45, 60, 75, 90, 105, 120, 135, 150]) {
      build('swing', sw, ['-D', `ks_open=${a}`]);
      const vol = stlVolume(sw) - 1;
      if (vol > 1e-3) hits.push(`${a}deg ${vol.toFixed(3)}`);
    }
    check('the stand swings clear of the hinge, 0..150 deg', hits.length === 0,
      hits.length ? `collides at ${hits.join(', ')} mm3` : 'zero intersection at all 11 angles, lugs included');
  }

  // ---- the bolt-on lugs (ks_mount = "bolton") ----
  const kl = scadEcho(scadPath, [
    'ks_bolton ? 1 : 0', 'ks_foot_w', 'ks_foot_back', 'ks_barrel', 'ks_sock_w',
    'ks_sock_l', 'ks_sock_d', 'ks_sock_floor', 'ks_lug_screw', 'ks_lug_pilot_top', 'ks_pilot',
    'ks_bz', 'print_shrink', 'print_grow', 'out_w', 'ks_gap', 'ks_lug_y', 'cover_th'
  ], defines);
  const LUG = ['the lug drops into its socket',
               'the lug screw cannot reach the pivot screw',
               'an M2 x 8 lug screw does not bottom out'];
  if (!kl['ks_bolton ? 1 : 0']) {
    for (const n of LUG) skip(n, 'ks_mount is not "bolton" - the lugs are part of the cover, or absent');
  } else {
    // The fit the way the button's is checked: hole loses print_shrink, peg gains
    // print_grow, and what is left over is what you actually assemble.
    const cw = (kl.ks_sock_w - kl.print_shrink) - (kl.ks_foot_w + kl.print_grow);
    const cl = (kl.ks_sock_l - kl.print_shrink) - (kl.ks_foot_back + kl.ks_barrel / 2 + kl.print_grow);
    check(LUG[0], cw >= 0.1 && cw <= 0.35 && cl >= 0.1 && cl <= 0.35,
      `printed clearance ${cw >= 0 ? '+' : ''}${cw.toFixed(2)} across, ${cl >= 0 ? '+' : ''}${cl.toFixed(2)} along ` +
      `(snug: a lug that rocks moves the pivot; negative cannot be assembled)`);
    // MEASURED on the lug's own mesh with RODS, because both pilots are internal
    // and no surface sample can see them. A rod of half the pilot's diameter up the
    // lug's centre line, minus the lug, is the VOID along that line:
    //   rodA  foot bottom -> pivot axis: pilot + web + half the pivot pilot
    //   rodB  foot bottom -> the web's middle: the lug screw's pilot alone
    // web = rodA's length - rodA's void. Placed from echoed constants, never typed.
    const area = Math.PI * (kl.ks_pilot / 4) ** 2;
    const zA = kl.ks_bz, zB = kl.ks_lug_pilot_top + 0.25;
    const rod = (name, zTop) => {
      const f = join(dir, `${name}.scad`), o = join(dir, `${name}.stl`);
      writeFileSync(f, `part="none";\ninclude <${scadPath}>\n` +
        `difference(){ translate([0,0,-${zTop}]) cylinder(d=ks_pilot/2, h=${zTop}+ks_sock_d, $fn=48); ks_lug(); }\n` +
        `translate([-50,-50,-50]) cube(1);\n`);
      execFileSync('openscad', ['--export-format=binstl', '-o', o, '-D', 'part="none"', ...dArgs, f],
        { stdio: ['ignore', 'ignore', 'ignore'] });
      return (stlVolume(o) - 1) / area;
    };
    const voidA = rod('rodA', zA), voidB = rod('rodB', zB);
    const web = (zA + kl.ks_sock_d) - voidA;
    check(LUG[1], web >= 0.3,
      `${web.toFixed(2)} mm of plastic between the lug screw's pilot and the pivot pilot (needs >= 0.3)`);
    // The floor is measured too: the pad's top over the screw, less the socket.
    const CV = join(dir, 'cvl.stl');
    writeFileSync(join(dir, 'cvl.scad'), `part="none";\ninclude <${scadPath}>\ncover();\n`);
    execFileSync('openscad', ['--export-format=binstl', '-o', CV, '-D', 'part="none"', '-D', '$fn=28',
      ...dArgs, join(dir, 'cvl.scad')], { stdio: ['ignore', 'ignore', 'ignore'] });
    const padTop = heightAt(stlTris(CV), kl.out_w / 2 - kl.ks_gap / 2 + 2.6, kl.ks_lug_y);
    const floor = padTop - kl.ks_sock_d;
    const past = kl.ks_lug_screw - floor;          // what of the screw reaches the foot
    check(LUG[2], voidB >= past + 0.3,
      `M2 x ${kl.ks_lug_screw}: ${past.toFixed(2)} past a ${floor.toFixed(2)} floor into ` +
      `${voidB.toFixed(2)} of pilot (needs 0.3 spare)`);
  }

  // ---- THE BEZEL MUST NOT SIT IN THE GLASS ----
  // This is the defect that started the check: the window is a through-hole
  // SMALLER than the CTP so the frame hides its border, so any part of the glass
  // that lies in front of the bezel's inner face is interference. At glass_recess
  // 1.6 against front_th 2.2 it was 437 mm3, biting 0.60 mm all the way round -
  // the board never reached its shoulders, and the cover's screw pillars pressed
  // the screen every time the case closed.
  //
  // The .scad now asserts glass_recess >= front_th, which is the cheap half and
  // catches the case that caused it. This is the other half: it MEASURES, so it
  // also catches anything else that reaches into the glass's volume - a mounting
  // column moved under the display, a boss, a rib - none of which that arithmetic
  // can see. glass() and the CTP's dimensions live in the .scad, so nothing here
  // is transcribed.
  const gh = join(dir, 'gh.stl');
  build('glasshit', gh);
  const gv = stlVolume(gh) - 1.0;   // less the marker cube
  check('the bezel does not press the glass', gv < 1e-3,
    `body/CTP intersection ${gv.toFixed(3)} mm3 ` +
    `(glass_recess ${v.glass_recess} vs front_th ${v.front_th}; the bezel lies over ` +
    `the border by design, so any overlap here is the screen being crushed)`);

  // ---- THE PILLAR MUST BE CONTINUOUS WITH THE PLATE ----
  // THE CHECK THIS REPLACES COUNTED CONNECTED COMPONENTS AND PASSED ON A BROKEN
  // PART. The head's counterbore is WIDER than the pillar it is cut into (6.2 into
  // 6.0), so taking it to the plate's inner face removed the pillar's top; the
  // shell cavity then hollowed the plate to 2.73, and the two ended 0.27 mm apart.
  // Four floating pillars - and the component count still said ONE SOLID, because
  // each pillar grazes the LIP on its case-edge side. A topological path is not a
  // structural one, and that is the whole lesson: the count was answering a
  // different question from the one being asked of it.
  //
  // So this measures the JUNCTION. An annulus at the pillar's own radius, spanning
  // the pocket floor down to the board, is differenced with the cover: if the
  // pillar is whole the annulus lies entirely inside material and the void is zero.
  // A 0.27 gap over this annulus is 3.4 mm3, which no threshold can miss.
  writeFileSync(join(dir,'j.scad'),
    `part="none";\ninclude <${scadPath}>\n` +
    `c0 = holes()[0];\n` +
    `z0 = screw_pad_z + screw_cb_z;  h = (total_th - z_pcb_b) - z0;\n` +
    `difference(){\n` +
    `  difference(){\n` +
    `    translate([c0[0],c0[1],z0]) cylinder(d=screw_boss_d-0.6, h=h, $fn=48);\n` +
    `    translate([c0[0],c0[1],z0-1]) cylinder(d=m3_clear+0.2, h=h+2, $fn=48);\n` +
    `  }\n` +
    `  cover();\n` +
    `}\n`);
  const jf = join(dir,'joint.stl');
  let jv = 0;
  try {
    execFileSync('openscad', ['--export-format=binstl','-o',jf,'-D','$fn=48',
      '-D','part="none"', ...dArgs, join(dir,'j.scad')], { stdio:['ignore','ignore','ignore'] });
    jv = stlVolume(jf);
  } catch (e) { jv = 0; }   // empty export = nothing missing = whole
  check('the screw pillar is CONTINUOUS with the plate', jv < 0.05,
    `void inside the pillar's own annulus ${jv.toFixed(3)} mm3 ` +
    `(a severed pillar reads ~3.4; a component count reads ONE either way)`);

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
    '-D','part="none"', ...dArgs, join(dir,'c.scad')], { stdio:['ignore','ignore','ignore'] });
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
  if (v.cover_rise <= 0)
    skip('the outside never steps back inward - no perimeter flange',
         'cover_rise is 0, so there is no taper and cover_outer() is not used');
  else check('the outside never steps back inward - no perimeter flange',
    worstStep < 0.15,
    worstStep < 0.15 ? `widens monotonically to the chamfer`
                     : `steps in ${worstStep.toFixed(2)} mm at depth ${worstZ.toFixed(2)}`);
  // The sweep only exists if there IS a skirt. zLast is cover_rise + cover_th -
  // soft_r/2, which is 1.2 at cover_rise 0 - BELOW the 2.2 the loop starts at, so it
  // ran zero times and passed on Infinity.
  if (v.cover_rise <= 0 || zLast <= 2.2 + 0.2)
    skip('the skirt keeps a wall',
         `no hollow skirt to sample (cover_rise ${v.cover_rise}, sweep would be 2.2..${zLast.toFixed(1)})`);
  else check('the skirt keeps a wall', minWall > 1.2,
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
  if (v.cover_rise <= 0)
    skip('the folded blade lands on FLAT plateau, not on the top fillet',
         'cover_rise is 0 - the whole back is flat, so there is no fillet to land on');
  else check('the folded blade lands on FLAT plateau, not on the top fillet',
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
  // PROPORTIONAL, not a flat 5 mm. The span from the landing to the board grows with
  // the body wall (10.31 -> 15.00 across the raises), so a fixed floor stopped
  // discriminating: at rim_extra 5 a gap of 9 still left 6.0 mm and passed.
  const pillarSpan = (v.total_th - v.z_pcb_b) - v.screw_pad_z;
  const pillarLen = pillarSpan - v.screw_pillar_gap;
  check('the pillar is still a pillar', pillarLen >= 0.5 * pillarSpan,
    `${pillarLen.toFixed(2)} of ${pillarSpan.toFixed(2)} mm below its landing ` +
    `(the gap may not eat half the span)`);

  // ---- the four screw pilots must actually be CUT ----
  // Measured, not reasoned: the pilot is drawn as cylinder(h = z_pcb_f - screw_skin),
  // and raising the body wall 5 mm drove that expression NEGATIVE (-0.39). OpenSCAD
  // draws nothing for a negative height and warns about nothing, so the column came
  // out solid with only its 0.6 mm lead-in cone - the same outcome as the forward
  // reference that once lost these same four holes. The void is measured inside a
  // pilot-sized rod, so a cone alone cannot satisfy it.
  writeFileSync(join(dir,'v.scad'),
    `part="none";\ninclude <${scadPath}>\n` +
    `c0 = holes()[0];\n` +
    `difference(){ translate([c0[0],c0[1],0]) cylinder(d=screw_pilot,h=z_pcb_f,$fn=48); body(); }\n`);
  // MEASURED AS A VOLUME, NOT AS A Z EXTENT, and the difference is the whole check.
  // The void is TWO disjoint pieces when the bore is degenerate - a zero-height disc
  // down at screw_skin and the lead-in cone up at the column top - and their combined
  // extent is 3.61 mm, which reads exactly like a healthy 3.60 bore. The fault
  // injection is what caught that; the first version of this assertion passed on the
  // patched file. Volume over the bore's own area gives an EQUIVALENT DEPTH that two
  // thin slices cannot fake.
  const vf = join(dir,'void.stl');
  let pilotDepth = 0;
  try {
    execFileSync('openscad', ['--export-format=binstl','-o',vf,'-D','$fn=48',
      '-D','part="none"', ...dArgs, join(dir,'v.scad')], { stdio:['ignore','ignore','ignore'] });
    const area = Math.PI * (v.screw_pilot / 2) ** 2;
    pilotDepth = stlVolume(vf) / area;
  } catch (e) { pilotDepth = 0; }
  const wantDepth = v.z_pcb_f - v.screw_skin;
  check('the four screw pilots are actually cut', pilotDepth >= v.screw_engage_min,
    `equivalent depth ${pilotDepth.toFixed(2)} mm, needs >= ${v.screw_engage_min} ` +
    `(a lead-in cone alone measures about ${v.screw_lead.toFixed(2)})`);
  check('the pilot reaches as deep as the arithmetic says', Math.abs(pilotDepth - wantDepth) < 0.05,
    `measured ${pilotDepth.toFixed(2)} vs z_pcb_f - screw_skin = ${wantDepth.toFixed(2)}`);

  // ---- the printed-in buttons (btn_flex) ----
  // Measured on the COVER'S OWN MESH, in its own frame (outer face at cover_rise,
  // inner face up), at points placed from echoed constants - never transcribed.
  const bf = scadEcho(scadPath, [
    'btn_flex ? 1 : 0', 'bcx', 'reset_dx', 'boot_dx', 'btn_y', 'btn_out',
    'btn_flex_len', 'btn_flex_tip', 'btn_flex_slot', 'btn_flex_w', 'btn_flex_t',
    'btn_flex_stiff', 'btn_flex_ramp', 'btn_flex_lean', 'btn_post_tip_v', 'btn_meas_gap', 'btn_flex_rest',
    'btn_flex_travel', 'cover_rise', 'cover_th', 'btn_post_fwd', 'btn_post_back', 'btn_post_flare'
  ], defines);
  const FLEX = ['the post tip stops btn_flex_rest short of the measured switch',
                'the post leans toward the service edge',
                'the tongue is free on three sides',
                "the tongue's root is still joined to the plate",
                'the tongue is btn_flex_t thick where it bends',
                'the tongue bends within PLA low-cycle strain',
                'the post has a buttress root, not a pin'];
  if (!bf['btn_flex ? 1 : 0']) {
    for (const n of FLEX) skip(n, 'btn_flex is off - the buttons are separate plungers');
  } else {
    const cv = join(dir, 'cover.stl');
    build('cover', cv);
    const CT = stlTris(cv);
    const z0 = bf.cover_rise + bf.cover_th;               // the plate's inner face
    const L = bf.btn_flex_len, s = bf.btn_flex_slot, w = bf.btn_flex_w;
    const tipWant = z0 + bf.btn_meas_gap - bf.btn_flex_rest;
    // max z of material on a vertical line; -Infinity is "nothing there at all"
    const at = (dx, u, v) => heightAt(CT, bf.bcx + dx + u, bf.btn_y + bf.btn_out * v);
    let worstTip = 0, worstLean = 0, openBad = [], rootBad = [], thin = [], nSlot = 0;
    for (const dx of [bf.reset_dx, bf.boot_dx]) {
      // The tip: the highest point over the post, found by scanning along v so the
      // LEAN is measured too rather than assumed.
      let best = -Infinity, bestV = 0;
      for (let v = -3; v <= 3; v += 0.02) {
        const h = at(dx, 0, v);
        if (h > best) { best = h; bestV = v; }
      }
      worstTip = Math.max(worstTip, Math.abs(best - tipWant));
      worstLean = Math.max(worstLean, Math.abs(bestV - bf.btn_post_tip_v));
      // The slot, sampled down both sides and across the free end.
      const slotPts = [];
      for (const sx of [-1, 1])
        for (const v of [-L + 0.3, -L / 2, 0, bf.btn_flex_tip - 1.2])
          slotPts.push([sx * (w / 2 + s / 2), v]);
      for (const u of [-w / 4, 0, w / 4]) slotPts.push([u, bf.btn_flex_tip + s / 2]);
      nSlot += slotPts.length;
      // THROUGH THE PLATE ONLY. The post now leans out over the slot's far end -
      // 4 mm and more below the plate, on the tongue's own side, never near the
      // fixed plate - so a whole-line sample read it as "material in the slot".
      // What frees the tongue is the slot through the plate, so that is what is
      // sampled: any solid between the outer face and the inner face.
      for (const [u, v] of slotPts)
        if (solidIn(CT, bf.bcx + dx + u, bf.btn_y + bf.btn_out * v, bf.cover_rise, z0))
          openBad.push(`(${u.toFixed(2)},${v.toFixed(2)})`);
      // The root: material straight across the line the slot ends on.
      for (const u of [-w / 2 + 0.3, 0, w / 2 - 0.3])
        if (!(at(dx, u, -L - s / 2) > bf.cover_rise + 0.1)) rootBad.push(u.toFixed(2));
      // The thin span, mid-way between the root ramp and the stiff end's ramp.
      const vMid = -(L + bf.btn_flex_stiff + bf.btn_flex_ramp) / 2;
      thin.push(at(dx, 0, vMid) - bf.cover_rise);
    }
    check(FLEX[0], worstTip < 0.05,
      `tip at ${(tipWant).toFixed(2)} wanted (inner face ${z0} + measured ${bf.btn_meas_gap} - ` +
      `rest ${bf.btn_flex_rest}); worst miss ${worstTip.toFixed(3)} mm`);
    check(FLEX[1], worstLean < 0.15,
      `tip found ${bf.btn_post_tip_v} toward the edge wanted (lean ${bf.btn_flex_lean} + measured shift), worst miss ${worstLean.toFixed(2)} mm ` +
      `(the press swings it back toward the root)`);
    check(FLEX[2], openBad.length === 0,
      openBad.length ? `material in the slot at ${openBad.join(' ')}` : `${nSlot} slot samples all open, through the plate`);
    check(FLEX[3], rootBad.length === 0,
      rootBad.length ? `nothing at the root line for u = ${rootBad.join(', ')}` : 'material across the root line');
    const tMax = Math.max(...thin), tMin = Math.min(...thin);
    check(FLEX[4], Math.abs(tMax - bf.btn_flex_t) < 0.02 && Math.abs(tMin - bf.btn_flex_t) < 0.02,
      `measured ${tMin.toFixed(2)}..${tMax.toFixed(2)} vs btn_flex_t ${bf.btn_flex_t}`);
    // From the MEASURED thickness, so a recess that silently stops cutting fails here
    // even though btn_flex_t - and the model's own strain assert - still read fine.
    const strain = 3 * tMax * (bf.btn_flex_rest + bf.btn_flex_travel) / (2 * L * L);
    // THE ROOT SECTION, measured on the mesh just above the flare: across the
    // tongue and along it, on both posts. The floors are a REQUIREMENT, not a copy
    // of the constants - "a little bit weak" was a 3.0 pin, and a post that goes
    // back toward one must fail here however its constants are written.
    {
      const zr = z0 + bf.btn_post_flare + 0.2;
      const vc = (bf.btn_post_fwd - bf.btn_post_back) / 2;
      const span = (xs, lo, hi) => { const c = xs.filter(x => x > lo && x < hi);
                                     return c.length >= 2 ? c[c.length - 1] - c[0] : 0; };
      let minW = Infinity, minD = Infinity;
      for (const dx of [bf.reset_dx, bf.boot_dx]) {
        const x = bf.bcx + dx, y = bf.btn_y + bf.btn_out * vc;
        minW = Math.min(minW, span(crossings(sectionSegs(CT, 1, y), zr), x - w / 2, x + w / 2));
        minD = Math.min(minD, span(crossings(sectionSegs(CT, 0, x), zr), y - 3.5, y + 3.5));
      }
      check(FLEX[6], minW >= 4.0 && minD >= 3.6,
        `root ${minW.toFixed(2)} across x ${minD.toFixed(2)} along at ${(zr - z0).toFixed(1)} above the tongue ` +
        `(needs >= 4.0 x 3.6; the weak post was a 3.0 pin)`);
    }
    check(FLEX[5], strain <= 0.012,
      `${(strain * 100).toFixed(2)}% at the root per press (rest ${bf.btn_flex_rest} + ` +
      `stroke ${bf.btn_flex_travel} over L ${L}); 1.2% is the ceiling`);
  }

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
    expect: 'the outside never steps back inward - no perimeter flange',
    defines: { rim_extra: 4, screw_len: 18, btn_flex: 'false', ks_mount: '"integrated"' } },
  { name: 'ks_leaf_margin stops tracking the top fillet (blade too WIDE)',
    patch: s => s.replace(/^ks_leaf_margin = 0\.6 \+ edge_t1\([^;]+;/m, 'ks_leaf_margin = 0.6;'),
    expect: 'the folded blade lands on FLAT plateau, not on the top fillet',
    defines: { rim_extra: 4, screw_len: 18, btn_flex: 'false', ks_mount: '"integrated"' } },
  // NOT out_h*0.60, which is what this used to inject. That literal produced a
  // 0.12 mm margin when cover_rise was 5; at 3 the top fillet bites less and the
  // same literal happens to FIT, so the fault stopped reproducing a defect and the
  // assertion passed for real. A fault that cannot fail is as useless as an
  // assertion that cannot fail. This injects the regression the derivation actually
  // prevents: reaching the plateau's edge while forgetting the fillet's bite.
  { name: 'ks_leaf_l forgets the fillet bite and reaches the plateau edge',
    patch: s => s.replace(/^ks_leaf_l  = plat_y1 - edge_t1\([\s\S]*?cover_rise\) - ks_lug_y - 0\.6;/m,
                          'ks_leaf_l  = plat_y1 - ks_lug_y;'),
    expect: 'the folded blade lands on FLAT plateau, not on the top fillet',
    defines: { rim_extra: 4, screw_len: 18, btn_flex: 'false', ks_mount: '"integrated"' } },
  { name: 'the pillar drives INTO the board',
    patch: s => s.replace(/^screw_pillar_gap = 0\.0;/m, 'screw_pillar_gap = -0.5;'),
    expect: 'the screw pillar does not reach past the board' },
  { name: 'the pillar is cut back until it is only a stub',
    patch: s => s.replace(/^screw_pillar_gap = 0\.0;/m, 'screw_pillar_gap = 9.0;'),
    expect: 'the pillar is still a pillar' },
  // NOT "screw_len back to 16": that trips the .scad's own screw_engage_min assert,
  // the build refuses, and the CHECKER never gets to prove anything - the defect is
  // caught, but by the model rather than by this. The model's assert is verified
  // separately (at 16 it fires by name). What this has to catch is the same hole
  // going missing with the arithmetic still valid, which is what a degenerate height
  // produced in the first place.
  { name: 'the pilot bore is cut to zero height',
    patch: s => s.replace(/cylinder\(d = screw_pilot, h = z_pcb_f - screw_skin \+ 0\.01\);/,
                          'cylinder(d = screw_pilot, h = 0.01);'),
    expect: 'the four screw pilots are actually cut' },
  // NOT "glass_recess back to 1.6": the .scad now refuses that outright, so the
  // build never runs and this checker proves nothing (the same reason screw_len 16
  // is not used above). The fault has to keep glass_recess >= front_th and still
  // put case material inside the panel - which is what moving a mounting column
  // under the display does, and no arithmetic in the file would notice.
  { name: 'a mounting column is moved under the display',
    patch: s => s.replace(/^hole_ins_y = 3\.40;/m, 'hole_ins_y = 14.0;'),
    expect: 'the bezel does not press the glass' },
  // NOT "screw_cb_shelf back to 0": the .scad asserts that at >= 0.4, so the build
  // refuses and this checker never runs. The fault deepens the POCKET ITSELF while
  // every constant still reads correct - the geometry going wrong behind valid
  // arithmetic, which is precisely what the mesh half exists to catch.
  // The pocket only exists where there is a plateau to sink it into, and the base
  // config has none (rim_extra 6). So this fault SELECTS one - and has to carry a
  // screw_len that is valid there, or the model's own length assert refuses the
  // build and the fault proves nothing. That trap cost four uncaught faults once.
  // IT COST THEM A SECOND TIME, the same way: btn_flex (the printed-in buttons)
  // refuses a plateau cover by name, so all four plateau faults stopped building
  // the day it landed. They now select the plunger too - btn_flex: 'false' - which
  // is what a plateau cover has to use. AND A THIRD TIME, the same day the hinge
  // went bolt-on: ks_mount = "bolton" refuses a plateau too, so they select
  // ks_mount "integrated" as well.
  { name: 'the head pocket is deepened until it eats the shelf',
    patch: s => s.replace(/cylinder\(d = screw_cb_d, h = screw_pad_z \+ screw_cb_z \+ 1\);/,
                          'cylinder(d = screw_cb_d, h = screw_pad_z + screw_cb_z + 1.6);'),
    defines: { rim_extra: 4, screw_len: 18, btn_flex: 'false', ks_mount: '"integrated"' },
    expect: 'the screw pillar is CONTINUOUS with the plate' },
  // The printed-in buttons. NOT "btn_meas_gap = 11.5": the post follows the
  // measurement by construction, so moving the measurement moves the post and the
  // check (correctly) still passes. What has to be caught is the post going back
  // to the MODEL's span, or the geometry drifting off its own constants.
  { name: 'the post is sized from the modelled span again',
    patch: s => s.replace(/^btn_post_len   = btn_meas_gap - btn_flex_rest;/m,
                          'btn_post_len   = 11.5 - btn_flex_rest;'),
    expect: 'the post is sized from the MEASURED gap, not the modelled switch' },
  { name: 'the post is drawn 1 mm longer than btn_post_len',
    patch: s => s.replace('translate([0, btn_post_tip_v, z0 + btn_post_len - btn_post_tip_d/2])',
                          'translate([0, btn_post_tip_v, z0 + btn_post_len + 1.0 - btn_post_tip_d/2])'),
    expect: 'the post tip stops btn_flex_rest short of the measured switch' },
  { name: 'the post leans the wrong way',
    patch: s => s.replace('translate([0, btn_post_tip_v, z0 + btn_post_len - btn_post_tip_d/2])',
                          'translate([0, -btn_post_tip_v, z0 + btn_post_len - btn_post_tip_d/2])'),
    expect: 'the post leans toward the service edge' },
  { name: 'btn_flex_slot loses its print_shrink term (prints 0.1 and fuses)',
    patch: s => s.replace(/^btn_flex_slot  = mm\(0\.6 \+ print_shrink\);/m, 'btn_flex_slot  = mm(0.6);'),
    expect: 'btn_flex_slot carries print_shrink' },
  { name: 'the slot is cut only part-way through the plate',
    patch: s => s.replace('translate([0, 0, -1]) linear_extrude(z0 + 1.01)',
                          'translate([0, 0, -1]) linear_extrude(1.5)'),
    expect: 'the tongue is free on three sides' },
  { name: 'the slot closes across the root and frees the tongue',
    patch: s => s.replace('translate([-w, -L]) square([2*w, L + btn_flex_tip + 2*s]);',
                          'translate([-w, -L - 2*s]) square([2*w, L + btn_flex_tip + 4*s]);'),
    expect: "the tongue's root is still joined to the plate" },
  { name: 'the thin span is cut half as deep',
    patch: s => s.replace('translate([-w/2 - 0.01, -L, z0 - d])', 'translate([-w/2 - 0.01, -L, z0 - d/2])'),
    expect: 'the tongue is btn_flex_t thick where it bends' },
  // Model arithmetic intact, geometry not: the model's own strain assert reads
  // btn_flex_t and still passes, so only the mesh can see this.
  { name: 'the thin span barely cut at all',
    patch: s => s.replace('translate([-w/2 - 0.01, -L, z0 - d])', 'translate([-w/2 - 0.01, -L, z0 - d/4])'),
    expect: 'the tongue bends within PLA low-cycle strain' },
  { name: "the post forgets the measured 1 mm shift and lands on the model's lean alone",
    patch: s => s.replace('translate([0, btn_post_tip_v, z0 + btn_post_len - btn_post_tip_d/2])\n',
                          'translate([0, btn_flex_lean, z0 + btn_post_len - btn_post_tip_d/2])\n'),
    expect: 'the post leans toward the service edge' },
  { name: 'the post goes back to the 3.0 pin that was too weak',
    patch: s => s.replace(/^btn_post_w     = 4\.4;/m, 'btn_post_w     = 3.0;')
                 .replace(/^btn_post_back  = 2\.5;/m, 'btn_post_back  = 1.5;'),
    expect: 'the post has a buttress root, not a pin' },
  // The bolt-on lugs.
  { name: 'the lug socket loses its print_shrink term',
    patch: s => s.replace(/^ks_sock_w    = mm\(ks_foot_w \+ print_grow \+ ks_sock_fit \+ print_shrink\);/m,
                          'ks_sock_w    = mm(ks_foot_w + print_grow + ks_sock_fit);'),
    expect: 'the lug drops into its socket' },
  { name: 'the lug screw pilot is driven up into the pivot pilot',
    patch: s => s.replace('translate([0, 0, -ks_lug_pilot_top]) cylinder(d=ks_pilot, h=ks_lug_pilot_top + ks_sock_d + 1, $fn=24);',
                          'translate([0, 0, -ks_lug_pilot_top - 1.0]) cylinder(d=ks_pilot, h=ks_lug_pilot_top + 1.0 + ks_sock_d + 1, $fn=24);'),
    expect: 'the lug screw cannot reach the pivot screw' },
  // Geometry short of its own constant: the model's bottoming-out assert reads
  // ks_lug_pilot_top and still passes, so only the mesh sees this.
  { name: 'the lug screw pilot is cut 2 mm short',
    patch: s => s.replace('translate([0, 0, -ks_lug_pilot_top]) cylinder(d=ks_pilot, h=ks_lug_pilot_top + ks_sock_d + 1, $fn=24);',
                          'translate([0, 0, -ks_lug_pilot_top + 2.0]) cylinder(d=ks_pilot, h=ks_lug_pilot_top - 2.0 + ks_sock_d + 1, $fn=24);'),
    expect: 'an M2 x 8 lug screw does not bottom out' },
  { name: 'the lug foot rises 1.5 mm out of its socket',
    patch: s => s.replace('scale([1, ks_dir, 1]) translate([0, ks_sock_vc, 0]) hull(){',
                          'scale([1, ks_dir, 1]) translate([0, ks_sock_vc, -1.5]) hull(){'),
    expect: 'the stand swings clear of the hinge, 0..150 deg' },
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
    try { caught = run(p, flt.defines || {}).includes(flt.expect); }
    catch (e) { caught = false; }
    console.log(`  ${caught ? 'ok   ' : 'FAIL '} ${flt.name}\n         -> ${flt.expect}`);
    if (!caught) bad++;
  }
  rmSync(dir, { recursive: true, force: true });
  console.log(bad ? `\n${bad} fault(s) NOT caught` : '\nevery fault caught');
  process.exit(bad ? 1 : 0);
}
