// Headless check of the settings mock: it draws every screen into an op list and
// asserts three things about the result - that no string leaves Spleen's
// 0x20..0x7E, that nothing lands off the panel, and that no content text reaches
// the footer.
//
// AND, SINCE THE MOCK IS COMMITTED AS THE NORMATIVE GEOMETRIC SPEC, that its
// constants ARE the firmware's. Everything above is a check on the PICTURE; a
// picture drawn from numbers nobody compares to the header is a spec that can go
// silently wrong while still reporting 50/50 - the same class of defect as an
// assertion that cannot fail. K is bound name-for-name to board_es3c35p.h through
// the geometry checkers' own consts() parser, so a header change that the mock
// does not follow fails HERE, by name, with both numbers printed.
import fs from "node:fs";
import { consts, fnBody, readSource } from "../../../firmware/deckhand_display/geom-common.mjs";
const D=new URL("./",import.meta.url).pathname;
globalThis.document={getElementById:()=>null,querySelectorAll:()=>[],createElement:()=>({appendChild(){},style:{},getContext:()=>null})};
globalThis.addEventListener=()=>{};
const src=fs.readFileSync(D+"spleenfonts.js","utf8")+fs.readFileSync(D+"settings.js","utf8")
  +"\nglobalThis.__X={SCREENS,P,K,WAS,HOME_ROWS,BAD_CHARS,ADV,CELL,F};";
new Function(src)();
const {SCREENS,P,K,WAS,HOME_ROWS,BAD_CHARS,ADV,CELL,F}=globalThis.__X;
let fail=0,n=0;
const chk=(c,m)=>{n++; if(!c){fail++; console.log("  FAIL "+m);}};

// ---- the mock against the header ------------------------------------------
// consts() is the parser the three geometry checkers use, so this reads the same
// values they certify rather than a second transcription of the header.
{
  const H=consts("deckhand_display.ino", consts("board_es3c35p.h"));
  let bound=0;
  for(const [name,val] of Object.entries(K)){
    if(name==="contentBottom") continue;   // a function on the device, checked below
    if(!(name in H)){
      chk(false, `K.${name} is not a constant board_es3c35p.h defines for this board - `
                +`either it is misnamed, or it belongs in WAS with the page it describes`);
      continue;
    }
    bound++;
    chk(H[name]===val, `K.${name} is ${val}, the firmware says ${H[name]}`);
  }
  // contentBottom() is BOARD_H - FOOTER_H on the device; the mock derives it the
  // same way, so what is asserted is the identity rather than the number.
  chk(K.contentBottom===H.BOARD_H-H.FOOTER_H,
      `contentBottom ${K.contentBottom} == BOARD_H - FOOTER_H (${H.BOARD_H-H.FOOTER_H})`);
  // WAS holds the geometry of pages this mock still DRAWS and the firmware no
  // longer has - the pre-branch pager pages under their plain names, and the
  // SEVEN-GROUP design the 2026-09-12 amendment replaced under a G7_ prefix. It is
  // deliberately unbound: a before picture that tracked the header would stop being
  // a before picture the moment the header moved. Sharing a NAME with K is expected
  // and not a fault - the redesign kept most of the names and moved the values,
  // which is exactly what a before picture has to show.
  //
  // WHAT MUST NOT HAPPEN is a WAS entry that says nothing: one whose value the
  // header (or K) already gives is a duplicate free to drift, and is how a live
  // constant gets parked out of the bind. So every entry EARNS its place by
  // differing from what ships. THE G7_ PREFIX IS RESOLVED BEFORE THAT TEST rather
  // than exempted from it - a marker that bought an entry its way out of the rule
  // would be the escape hatch the rule exists to close.
  let g7 = 0;
  for(const [name,val] of Object.entries(WAS)){
    const base = name.replace(/^G7_/, "");
    if(base !== name) g7++;
    if(base in K)
      chk(val!==K[base],
          `WAS.${name} is ${val}, the same as K.${base} - it records nothing and belongs in K`);
    else
      chk(!(base in H),
          `WAS.${name} is still a live constant (header says ${base} is ${H[base]}) - it belongs in K`);
  }
  console.log(`  header bind: ${bound} of ${Object.keys(K).length-1} mock constants `
             +`checked against board_es3c35p.h, ${Object.keys(WAS).length} in WAS `
             +`(${Object.keys(WAS).length-g7} pre-branch, ${g7} seven-group)`);

  // ---- HOME's rows against the firmware's OWN table -----------------------
  // The picture below draws six named rows. The names are not the mock's to
  // choose: settingsGroupTitle() is the one table the back band's title and HOME's
  // row name both read, so a group renamed there and not here would leave this
  // mock drawing a menu the device does not have. Parsed out of that function's
  // body, in its own order, rather than transcribed - the same rule the geometry
  // checkers follow for constants, arriving on the strings.
  {
    const body = fnBody(readSource("settings.ino"),
                        "const char* settingsGroupTitle", "settings.ino");
    const titles = [...body.matchAll(/return "([^"]+)";/g)].map(m => m[1]);
    chk(titles.length === H.SET_GROUP_COUNT,
        `settingsGroupTitle() yields ${titles.length} names, SET_GROUP_COUNT is ${H.SET_GROUP_COUNT}`);
    chk(HOME_ROWS.length === H.SET_GROUP_COUNT,
        `HOME draws ${HOME_ROWS.length} rows, SET_GROUP_COUNT is ${H.SET_GROUP_COUNT}`);
    HOME_ROWS.forEach(([name], i) => {
      chk(titles[i] === name,
          `HOME row ${i} is "${name}", settingsGroupTitle() says "${titles[i]}"`);
    });
    // And the summaries fit the lane the header sizes: HOME_SUB_CHARS is what
    // renderSettingsHome() pads to, so a summary longer than it is a summary the
    // device truncates - invisible in a mock that does not measure it.
    for(const [name, sub] of HOME_ROWS)
      chk(sub.length <= H.HOME_SUB_CHARS,
          `HOME's "${name}" summary is ${sub.length} chars, HOME_SUB_CHARS is ${H.HOME_SUB_CHARS}`);
  }
}

// ---- the picture ----------------------------------------------------------
for(const [g,list] of Object.entries(SCREENS)) for(const [name,fn] of list){
  BAD_CHARS.clear();
  const p=new P("DARK",false); p.fill(p.t.bg); fn(p);
  const label=`${g}/${name}`;
  chk(BAD_CHARS.size===0, `${label}: non-ASCII ${[...BAD_CHARS]}`);
  let minY=1e9,maxY=-1e9,minX=1e9,maxX=-1e9,txtMax=-1e9,txtMin=1e9;
  for(const o of p.ops){
    let x,y,w,h;
    if(o[0]==="r"){[,x,y,w,h]=o;}
    else if(o[0]==="s"){[,x,y,w,h]=o;}
    else if(o[0]==="c"||o[0]==="co"){x=o[1]-o[3];y=o[2]-o[3];w=h=2*o[3];}
    else if(o[0]==="t"){const[,s,tx,ty,f]=o;x=tx;y=ty;w=s.length*ADV[f];h=CELL[f];
      txtMax=Math.max(txtMax,ty+h-1); txtMin=Math.min(txtMin,ty);}
    else continue;
    minX=Math.min(minX,x);maxX=Math.max(maxX,x+w-1);minY=Math.min(minY,y);maxY=Math.max(maxY,y+h-1);
  }
  chk(minX>=0&&maxX<K.BOARD_W, `${label}: x out of panel (${minX}..${maxX})`);
  chk(minY>=0&&maxY<K.BOARD_H, `${label}: y out of panel (${minY}..${maxY})`);
  // no text may run into the footer band or the tab bar's underline region
  chk(txtMax<K.BOARD_H, `${label}: text below panel (${txtMax})`);
  const bodyText=p.ops.filter(o=>o[0]==="t"&&o[3]>=K.CONTENT_Y&&o[3]<K.contentBottom);
  const worst=Math.max(...bodyText.map(o=>o[3]+CELL[o[4]]-1));
  chk(worst<K.contentBottom, `${label}: content text reaches ${worst}, footer starts ${K.contentBottom}`);
  console.log(`  ${label.padEnd(28)} content ink ends ${String(worst).padStart(3)}  (footer ${K.contentBottom}, slack ${K.contentBottom-worst-1})`);
}
console.log(`\n${n-fail} checks passed, ${fail} failed`);
process.exit(fail?1:0);
