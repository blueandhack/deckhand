import fs from "node:fs";
const D=new URL("./",import.meta.url).pathname;
globalThis.document={getElementById:()=>null,querySelectorAll:()=>[],createElement:()=>({appendChild(){},style:{},getContext:()=>null})};
globalThis.addEventListener=()=>{};
const src=fs.readFileSync(D+"spleenfonts.js","utf8")+fs.readFileSync(D+"settings.js","utf8")
  +"\nglobalThis.__X={SCREENS,P,K,BAD_CHARS,ADV,CELL,F};";
new Function(src)();
const {SCREENS,P,K,BAD_CHARS,ADV,CELL,F}=globalThis.__X;
let fail=0,n=0;
const chk=(c,m)=>{n++; if(!c){fail++; console.log("  FAIL "+m);}};
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
  chk(minX>=0&&maxX<K.W, `${label}: x out of panel (${minX}..${maxX})`);
  chk(minY>=0&&maxY<K.H, `${label}: y out of panel (${minY}..${maxY})`);
  // no text may run into the footer band or the tab bar's underline region
  chk(txtMax<K.H, `${label}: text below panel (${txtMax})`);
  const bodyText=p.ops.filter(o=>o[0]==="t"&&o[3]>=K.CONTENT_Y&&o[3]<K.contentBottom);
  const worst=Math.max(...bodyText.map(o=>o[3]+CELL[o[4]]-1));
  chk(worst<K.contentBottom, `${label}: content text reaches ${worst}, footer starts ${K.contentBottom}`);
  console.log(`  ${label.padEnd(28)} content ink ends ${String(worst).padStart(3)}  (footer ${K.contentBottom}, slack ${K.contentBottom-worst-1})`);
}
console.log(`\n${n-fail} checks passed, ${fail} failed`);
process.exit(fail?1:0);
