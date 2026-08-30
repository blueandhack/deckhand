// ---------------------------------------------------------------------------
// Board 2 settings mock. Every glyph is the REAL Spleen bitmap, extracted from
// Spleen8x16.h / Spleen12x24.h (the headers the firmware links). Every constant
// is the value parsed out of board_es3c35p.h. Nothing here is drawn with a Mac
// font: the device has 1-bit 8x16 and 12x24 cells and nothing in between.
// ---------------------------------------------------------------------------
const F = { 1: SPLEEN_FONTS.Spleen8x16, 3: SPLEEN_FONTS.Spleen12x24 };
const ADV = { 1: 8, 3: 12 }, CELL = { 1: 16, 3: 24 };

// THEMES[] from deckhand_display.ino:378, field order bg,card,label,value,accent,good,warn,bad,unknown
const RAW = {
  DARK:  [0x0000,0x18C4,0x8410,0xFFFF,0xFD20,0x0396,0xE4E0,0xCBD4,0x7BEF],
  LIGHT: [0xEF5C,0xFFFF,0x62CA,0x18C3,0xB240,0x12F4,0xB3A0,0x6887,0x8C30],
};
const NAMES = ["bg","card","label","value","accent","good","warn","bad","unknown"];
function c565(v){const r=(v>>11&31)*255/31,g=(v>>5&63)*255/63,b=(v&31)*255/31;
  return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;}
const TH = {}; for(const k in RAW){TH[k]={}; RAW[k].forEach((v,i)=>TH[k][NAMES[i]]=c565(v));}

// board_es3c35p.h, parsed values
const K = {
  W:320, H:480, TAB_BAR_H:46, CONTENT_Y:46, FOOTER_H:20, contentBottom:460,
  CARD_X:12, CARD_W:296, PAD:18, SP1:4, SP2:8, SP3:12, R:8,
  TAP_MIN:46, H_ROW:46, H_BTN:50, BORDER_CARD:2, BORDER_CTRL:1,
  PAGER_H:54, PAGER_BTN_W:60, PAGER_BTN_X0:8, PAGE_TOP:104,
  DEV_CARD_Y:116, DEV_CARD_H:200,
  DROW_BT:34, DROW_USB:58, DROW_BATT:82, DROW_TEMP:106, DROW_ID:130, DROW_MAC0:154, DROW_MAC1:178,
  LINK_CARD_Y:328, LINK_CARD_H:128,
  LROW_HOST:34, LROW_PAYLOAD:58, LROW_FLUSH:82, LROW_UPTIME:106,
  STEPPER_CARD_H:80, STEP_LABEL_CY:12, STEP_VALUE_CY:43, STEP_BAR_Y:66,
  STEP_BTN_TOP:8, STEP_BTN_SIZE:64, STEP_BAR_H:8, STEP_BAR_GAP:10,
  P1_TOP:12, P1_GAP:12, P2_TOP:12, P2_BTN_H:50, P2_GAP:12,
  P1_THIRD_W:(296-16)/3|0, CONN_TEXT_W:112, CONN_TEXT_H:16,
};
K.P1_BRIGHT_Y = K.PAGE_TOP + K.P1_TOP;                    // 116
K.P1_SLEEP_Y  = K.P1_BRIGHT_Y + K.STEPPER_CARD_H + K.P1_GAP;  // 208
K.P1_VOL_Y    = K.P1_SLEEP_Y  + K.STEPPER_CARD_H + K.P1_GAP;  // 300
K.P1_SOUND_Y  = K.P1_VOL_Y    + K.STEPPER_CARD_H + K.P1_GAP;  // 392
K.P1_FLIP_X   = K.CARD_X + K.P1_THIRD_W + 8;
K.P1_THEME_X  = K.CARD_X + 2*(K.P1_THIRD_W + 8);
K.P2_MIC_Y  = K.PAGE_TOP + K.P2_TOP;                      // 116  (BOARD_HAS_MIC is 1)
K.P2_CAL_Y  = K.P2_MIC_Y  + K.P2_BTN_H + K.P2_GAP;        // 178
K.P2_PAIR_Y = K.P2_CAL_Y  + K.P2_BTN_H + K.P2_GAP;        // 240
K.P2_PWR_Y  = K.P2_PAIR_Y + K.P2_BTN_H + K.P2_GAP;        // 302
K.P2_HINT_Y = K.P2_PWR_Y  + K.P2_BTN_H + K.SP3;           // 364
K.P3_ANY_Y  = K.PAGE_TOP + K.SP1/2;                       // 106
K.P3_LIST_Y = K.P3_ANY_Y + K.H_ROW + K.SP1;               // 156

// Every string that reaches the panel must be inside Spleen's 0x20..0x7E. This
// mock ENFORCES that rather than trusting it - the middle-dot trap in CLAUDE.md
// has been paid for three times, and a mock that can draw a glyph the device
// cannot is exactly the flattering instrument this repo keeps banning.
const BAD_CHARS = new Set();
function ascii(s){ for(const ch of String(s)){ const cp=ch.codePointAt(0);
  if(cp<0x20||cp>0x7E) BAD_CHARS.add(ch); } return String(s); }

class P {
  constructor(theme, showBoxes){ this.t = TH[theme]; this.boxes = showBoxes; this.ops = []; }
  _r(x,y,w,h,col){ this.ops.push(["r",x,y,w,h,col]); }
  fill(col){ this._r(0,0,K.W,K.H,col); }
  rect(x,y,w,h,col){ this._r(x,y,w,h,col); }
  // Rounded rect, drawn the way uiFillRound does: a plain body plus corner insets.
  round(x,y,w,h,r,col){
    this._r(x+r,y,w-2*r,h,col); this._r(x,y+r,r,h-2*r,col); this._r(x+w-r,y+r,r,h-2*r,col);
    this.ops.push(["c",x+r,y+r,r,col],["c",x+w-r-1,y+r,r,col],
                  ["c",x+r,y+h-r-1,r,col],["c",x+w-r-1,y+h-r-1,r,col]);
  }
  stroke(x,y,w,h,r,t,col){
    for(let i=0;i<t;i++) this.ops.push(["s",x+i,y+i,w-2*i,h-2*i,r,col]);
  }
  card(x,y,w,h,border){ this.round(x,y,w,h,K.R,this.t.card);
    this.stroke(x,y,w,h,K.R,K.BORDER_CARD,border||this.t.label); }
  dot(cx,cy,r,col,fill=true){ this.ops.push([fill?"c":"co",cx,cy,r,col]); }
  tw(s,f){ return String(s).length * ADV[f]; }
  // datum: TL (y = cell top) or MC (y = centre). MC's paint top is cy - 3h/8 -
  // TFT_eSPI centres on the ASCENT, so the box sits low by half the descent.
  // Measured in board_es3c35p.h: a 24px box under MC at cy paints cy-9..cy+14,
  // and uiButton's 16px label at cy paints cy-6..cy+9.
  text(s,x,y,{f=1,c,datum="TL"}={}){
    s = ascii(s); const w = this.tw(s,f), h = CELL[f];
    let tx = x, ty = y;
    if(datum==="MC"){ tx = x - w/2 | 0; ty = y - (3*h/8) | 0; }
    else if(datum==="TR"){ tx = x - w; }
    else if(datum==="MR"){ tx = x - w; ty = y - (3*h/8) | 0; }
    else if(datum==="ML"){ ty = y - (3*h/8) | 0; }
    if(this.boxes) this.ops.push(["box",tx,ty,w,h]);
    this.ops.push(["t",s,tx,ty,f,c||this.t.value]);
    return w;
  }
  paint(ctx){
    for(const o of this.ops){
      if(o[0]==="r"){ ctx.fillStyle=o[5]; ctx.fillRect(o[1],o[2],o[3],o[4]); }
      else if(o[0]==="c"){ ctx.fillStyle=o[4]; ctx.beginPath();
        ctx.arc(o[1]+0.5,o[2]+0.5,o[3],0,7); ctx.fill(); }
      else if(o[0]==="co"){ ctx.strokeStyle=o[4]; ctx.lineWidth=2; ctx.beginPath();
        ctx.arc(o[1]+0.5,o[2]+0.5,o[3],0,7); ctx.stroke(); }
      else if(o[0]==="s"){ ctx.strokeStyle=o[6]; ctx.lineWidth=1;
        const [,x,y,w,h,r]=o; ctx.beginPath();
        ctx.moveTo(x+r,y+0.5); ctx.arcTo(x+w-0.5,y+0.5,x+w-0.5,y+h-0.5,r);
        ctx.arcTo(x+w-0.5,y+h-0.5,x+0.5,y+h-0.5,r); ctx.arcTo(x+0.5,y+h-0.5,x+0.5,y+0.5,r);
        ctx.arcTo(x+0.5,y+0.5,x+w-0.5,y+0.5,r); ctx.closePath(); ctx.stroke(); }
      else if(o[0]==="box"){ ctx.strokeStyle="rgba(255,0,120,.75)"; ctx.lineWidth=1;
        ctx.strokeRect(o[1]+0.5,o[2]+0.5,o[3]-1,o[4]-1); }
      else if(o[0]==="t"){
        const [,s,x,y,f,col]=o; ctx.fillStyle=col; const g=F[f].glyphs, w=ADV[f], h=CELL[f];
        for(let i=0;i<s.length;i++){
          const rows=g[s.charCodeAt(i)]; if(!rows) continue;
          for(let r=0;r<h;r++){ const v=rows[r]; if(!v) continue;
            for(let c2=0;c2<w;c2++) if(v>>(w-1-c2)&1) ctx.fillRect(x+i*w+c2,y+r,1,1); }
        }
      }
    }
  }
}

// ---- shared chrome -------------------------------------------------------
function tabBar(p,{rec=true}={}){
  p.rect(0,0,K.W,K.TAB_BAR_H,p.t.card);
  const slot = rec ? 40 : 0, tw = ((K.W-slot)/3)|0;
  ["USAGE","SESSIONS","SETTINGS"].forEach((s,i)=>{
    const active = i===2;
    p.text(s, i*tw+tw/2, K.TAB_BAR_H/2, {f:1,c:active?p.t.value:p.t.label,datum:"MC"});
    if(active) p.rect(i*tw+8, K.TAB_BAR_H-5, tw-16, 3, p.t.accent);
  });
  if(rec){ const x=3*tw; p.text("REC", x+slot/2+4, K.TAB_BAR_H/2, {f:1,c:p.t.label,datum:"MC"});
    p.dot(x+9, K.TAB_BAR_H/2, 3, p.t.label); }
}
function footer(p){
  const y=K.contentBottom;
  p.rect(0,y,K.W,K.FOOTER_H,p.t.bg);
  p.text("14:31", 12, y+2, {f:1,c:p.t.label});
  p.text("78%", 135, y+2, {f:1,c:p.t.good});
  p.text("2s ago", K.W-12, y+2, {f:1,c:p.t.label,datum:"TR"});
}
function pagerBand(p,page){
  const titles=["STATUS","DISPLAY & SOUND","ACTIONS","PAIRED MACS"];
  const cy=K.CONTENT_Y+K.PAGER_H/2, by=K.CONTENT_Y+4, bh=K.PAGER_H-8;
  for(const side of [0,1]){
    const bx = side===0 ? K.PAGER_BTN_X0 : K.W-K.PAGER_BTN_X0-K.PAGER_BTN_W;
    p.round(bx,by,K.PAGER_BTN_W,bh,K.R,p.t.card);
    p.stroke(bx,by,K.PAGER_BTN_W,bh,K.R,K.BORDER_CTRL,p.t.accent);
    p.text(side===0?"<":">", bx+K.PAGER_BTN_W/2, cy, {f:1,c:p.t.accent,datum:"MC"});
  }
  p.text(titles[page], K.W/2, cy-5, {f:1,c:p.t.value,datum:"MC"});
  const sp=12, x0=K.W/2-(3*sp)/2;
  for(let i=0;i<4;i++) p.dot(x0+i*sp, cy+8, 3, i===page?p.t.accent:p.t.label, i===page);
}
function stepper(p,y,label,value,bar){
  p.card(K.CARD_X,y,K.CARD_W,K.STEPPER_CARD_H);
  const bs=K.STEP_BTN_SIZE, bt=y+K.STEP_BTN_TOP;
  for(const [bx,g] of [[K.CARD_X+K.PAD,"-"],[K.CARD_X+K.CARD_W-K.PAD-bs,"+"]]){
    p.round(bx,bt,bs,bs,K.R,p.t.card); p.stroke(bx,bt,bs,bs,K.R,K.BORDER_CTRL,p.t.accent);
    p.text(g,bx+bs/2,bt+bs/2,{f:3,c:p.t.accent,datum:"MC"});
  }
  p.text(label, K.W/2, y+K.STEP_LABEL_CY, {f:1,c:p.t.label,datum:"MC"});
  p.text(value, K.W/2, y+K.STEP_VALUE_CY, {f:3,c:p.t.value,datum:"MC"});
  if(bar!=null){
    const x0=K.CARD_X+K.PAD+bs+K.STEP_BAR_GAP, x1=K.CARD_X+K.CARD_W-K.PAD-bs-K.STEP_BAR_GAP;
    p.rect(x0,y+K.STEP_BAR_Y,x1-x0,K.STEP_BAR_H,p.t.card==="#000"?p.t.label:p.t.unknown);
    p.rect(x0,y+K.STEP_BAR_Y,(x1-x0)*bar|0,K.STEP_BAR_H,p.t.accent);
  }
}
function button(p,x,y,w,h,label,tint,filled){
  const bg = filled ? tint : p.t.card;
  p.round(x,y,w,h,K.R,bg); p.stroke(x,y,w,h,K.R,K.BORDER_CTRL,tint);
  p.text(label,x+w/2,y+h/2,{f:1,c:filled?p.t.card:tint,datum:"MC"});
}

// ===========================================================================
// WHAT SHIPS TODAY
// ===========================================================================
function curStatus(p){
  tabBar(p); pagerBand(p,0);
  const X=K.CARD_X, W=K.CARD_W, y=K.DEV_CARD_Y;
  p.card(X,y,W,K.DEV_CARD_H);
  p.text("DEVICE", X+K.PAD, y+6, {f:1,c:p.t.label});
  const conn=(dy,lab,ok)=>{
    p.dot(X+K.PAD+6, y+dy+8, 6, ok?p.t.good:p.t.label);
    p.text(lab, X+K.PAD+20, y+dy, {f:1,c:p.t.value});
    p.text(ok?"Connected":"Not connected", X+W-K.PAD, y+dy, {f:1,c:ok?p.t.good:p.t.label,datum:"TR"});
  };
  conn(K.DROW_BT,"Bluetooth",true); conn(K.DROW_USB,"USB",true);
  p.dot(X+K.PAD+6, y+K.DROW_BATT+8, 6, p.t.good);
  p.text("Battery", X+K.PAD+20, y+K.DROW_BATT, {f:1,c:p.t.value});
  p.text("    78% 4.05V ~5h", X+W-K.PAD, y+K.DROW_BATT, {f:1,c:p.t.good,datum:"TR"});
  p.text("SoC temp", X+K.PAD+20, y+K.DROW_TEMP, {f:1,c:p.t.value});
  p.text(" 46.6 C", X+W-K.PAD, y+K.DROW_TEMP, {f:1,c:p.t.good,datum:"TR"});
  p.text("Deckhand-C114  paired x2", X+K.PAD, y+K.DROW_ID, {f:1,c:p.t.good});
  p.text("Mac  air  2s ago", X+K.PAD, y+K.DROW_MAC0, {f:1,c:p.t.value});
  p.text("Mac  studio  3s ago", X+K.PAD, y+K.DROW_MAC1, {f:1,c:p.t.value});
  const ly=K.LINK_CARD_Y;
  p.card(X,ly,W,K.LINK_CARD_H);
  p.text("LINK", X+K.PAD, ly+6, {f:1,c:p.t.label});
  [["HOST","ticking 2s",K.LROW_HOST],["PAYLOAD","779 B",K.LROW_PAYLOAD],
   ["FLUSH","1.1 ms",K.LROW_FLUSH],["UPTIME","4h 12m",K.LROW_UPTIME]].forEach(([l,v,dy])=>{
    p.text(l, X+K.PAD, ly+dy, {f:1,c:p.t.label});
    p.text(v, X+W-K.PAD, ly+dy, {f:1,c:p.t.value,datum:"TR"});
  });
  footer(p);
}
function curDisplay(p){
  tabBar(p); pagerBand(p,1);
  stepper(p,K.P1_BRIGHT_Y,"BRIGHTNESS","90%",0.9);
  stepper(p,K.P1_SLEEP_Y,"SLEEP AFTER","30s",null);
  stepper(p,K.P1_VOL_Y,"VOLUME","MED",null);
  const w=K.P1_THIRD_W, y=K.P1_SOUND_Y, h=K.H_ROW;
  button(p,K.CARD_X,y,w,h,"SOUND",p.t.accent,true);
  button(p,K.P1_FLIP_X,y,w,h,"NORMAL",p.t.label,false);
  button(p,K.P1_THEME_X,y,w,h,"DARK",p.t.label,false);
  footer(p);
}
function curActions(p){
  tabBar(p); pagerBand(p,2);
  button(p,K.CARD_X,K.P2_MIC_Y,K.CARD_W,K.P2_BTN_H,"MIC TEST",p.t.accent,false);
  button(p,K.CARD_X,K.P2_CAL_Y,K.CARD_W,K.P2_BTN_H,"CALIBRATE TOUCH",p.t.accent,false);
  button(p,K.CARD_X,K.P2_PAIR_Y,K.CARD_W,K.P2_BTN_H,"RESET PAIRING",p.t.warn,false);
  button(p,K.CARD_X,K.P2_PWR_Y,K.CARD_W,K.P2_BTN_H,"POWER OFF",p.t.bad,false);
  p.text("power off = deep sleep, RESET to wake", K.W/2, K.P2_HINT_Y, {f:1,c:p.t.label,datum:"MC"});
  footer(p);
}
function curPairing(p){
  tabBar(p); pagerBand(p,3);
  const row=(y,lab,sel,tag)=>{
    p.round(K.CARD_X,y,K.CARD_W,K.H_ROW,K.R,sel?p.t.accent:p.t.card);
    p.stroke(K.CARD_X,y,K.CARD_W,K.H_ROW,K.R,K.BORDER_CTRL,sel?p.t.accent:p.t.label);
    p.text(lab,K.CARD_X+K.SP3,y+K.H_ROW/2,{f:1,c:sel?p.t.card:p.t.value,datum:"ML"});
    if(tag) p.text(tag,K.CARD_X+K.CARD_W-K.SP3-40-K.SP2,y+K.H_ROW/2,{f:1,c:sel?p.t.card:p.t.label,datum:"MR"});
  };
  row(K.P3_ANY_Y,"ANY MAC",true,"SELECTED");
  ["air  a3f2","studio  9c01","mini  4b7e","lab  0f19"].forEach((n,i)=>{
    const y=K.P3_LIST_Y+i*(K.H_ROW+K.SP1); row(y,n,false,null);
    p.text("x",K.CARD_X+K.CARD_W-20,y+K.H_ROW/2,{f:1,c:p.t.bad,datum:"MC"});
  });
  footer(p);
}

// ===========================================================================
// A - NAVIGATION: a HOME screen, and one tap to any group
// The pager band (46..103) becomes a BACK band of the same height, so every
// sub-page keeps PAGE_TOP 104 and today's layouts drop in untouched.
// ===========================================================================
const HOME_ROWS = [
  ["Status",  "Both links up   78%   46 C", "good"],
  ["Display", "90%   sleep 30s   DARK",     null],
  ["Sound",   "ON   volume MED   mic",      null],
  ["Pairing", "2 Macs   any may answer",    null],
  ["Actions", "calibrate, pairing, power",  null],
];
const HOME_Y0 = 54, HOME_H = 70, HOME_STEP = HOME_H + 12;
function homeScreen(p){
  tabBar(p);
  HOME_ROWS.forEach(([name,sub,state],i)=>{
    const y = HOME_Y0 + i*HOME_STEP;
    p.card(K.CARD_X,y,K.CARD_W,HOME_H);
    p.text(name, K.CARD_X+K.PAD, y+14, {f:3,c:p.t.value});
    p.text(sub,  K.CARD_X+K.PAD, y+44, {f:1,c:state==="good"?p.t.good:p.t.label});
    p.text(">",  K.CARD_X+K.CARD_W-K.PAD, y+HOME_H/2, {f:3,c:p.t.accent,datum:"MR"});
  });
  footer(p);
}
function backBand(p,title){
  const by=K.CONTENT_Y+4, bh=K.PAGER_H-8, bx=K.PAGER_BTN_X0;
  p.round(bx,by,K.PAGER_BTN_W,bh,K.R,p.t.card);
  p.stroke(bx,by,K.PAGER_BTN_W,bh,K.R,K.BORDER_CTRL,p.t.accent);
  p.text("<", bx+K.PAGER_BTN_W/2, by+bh/2, {f:3,c:p.t.accent,datum:"MC"});
  p.text(title, bx+K.PAGER_BTN_W+16, K.CONTENT_Y+K.PAGER_H/2, {f:3,c:p.t.value,datum:"ML"});
}
function aDisplay(p){
  tabBar(p); backBand(p,"Display");
  stepper(p,K.P1_BRIGHT_Y,"BRIGHTNESS","90%",0.9);
  stepper(p,K.P1_SLEEP_Y,"SLEEP AFTER","30s",null);
  stepper(p,K.P1_VOL_Y,"VOLUME","MED",null);
  const w=K.P1_THIRD_W,y=K.P1_SOUND_Y,h=K.H_ROW;
  button(p,K.CARD_X,y,w,h,"SOUND",p.t.accent,true);
  button(p,K.P1_FLIP_X,y,w,h,"NORMAL",p.t.label,false);
  button(p,K.P1_THEME_X,y,w,h,"DARK",p.t.label,false);
  footer(p);
}

// ===========================================================================
// B - CONTENT: hierarchy instead of eleven identical rows
// ===========================================================================
function bStatus(p,withBack){
  tabBar(p); withBack?backBand(p,"Status"):pagerBand(p,0);
  const X=K.CARD_X,W=K.CARD_W;
  const block=(y,h,cap,big,bigCol,l1,l2)=>{
    p.card(X,y,W,h);
    p.text(cap, X+K.PAD, y+8, {f:1,c:p.t.label});
    p.text(big, X+K.PAD, y+34, {f:3,c:bigCol});
    if(l1) p.text(l1, X+K.PAD, y+66, {f:1,c:p.t.label});
    if(l2) p.text(l2, X+K.PAD, y+86, {f:1,c:p.t.label});
  };
  block(116,112,"CONNECTION","Both links up",p.t.good,
        "USB and Bluetooth, 2s ago","Deckhand-C114");
  block(240,112,"POWER","78%  4.05V",p.t.good,
        "about 5h left on battery","SoC 46.6 C");
  p.card(X,364,W,92);
  p.text("HOST", X+K.PAD, 364+8, {f:1,c:p.t.label});
  p.text("779 B per tick",  X+K.PAD, 364+34, {f:1,c:p.t.value});
  p.text("flush 1.1 ms",    X+K.PAD, 364+56, {f:1,c:p.t.value});
  p.text("up 4h 12m",  X+W-K.PAD, 364+34, {f:1,c:p.t.value,datum:"TR"});
  p.text("2 Macs",     X+W-K.PAD, 364+56, {f:1,c:p.t.value,datum:"TR"});
  footer(p);
}
function bActions(p,withBack){
  tabBar(p); withBack?backBand(p,"Actions"):pagerBand(p,2);
  const X=K.CARD_X,W=K.CARD_W,H=56;   // 3 buttons, not 4 - MIC TEST lives on Sound
  const cap=(y,s)=>p.text(s,X+K.PAD,y,{f:1,c:p.t.label});
  cap(120,"SETUP");
  button(p,X,146,W,H,"CALIBRATE TOUCH",p.t.accent,false);
  // Destructive actions are SEPARATED, captioned, and carry a solid severity
  // spine - so severity survives greyscale and colour-blindness, which an
  // outline hue alone does not.
  cap(228,"CANNOT BE UNDONE");
  const sev=(y,label,col)=>{
    button(p,X,y,W,H,label,col,false);
    p.rect(X+2,y+K.R,4,H-2*K.R,col);
    p.dot(X+4,y+K.R,2,col); p.dot(X+4,y+H-K.R-1,2,col);
  };
  sev(254,"RESET PAIRING",p.t.warn);
  sev(322,"POWER OFF",p.t.bad);
  p.text("power off = deep sleep, RESET to wake",K.W/2,402,{f:1,c:p.t.label,datum:"MC"});
  footer(p);
}
// --- Sound: the group HOME promised and nothing drew ---------------------
// Output and input together, because a mic test IS a sound test - and it is the
// one action you run repeatedly (it is how MIC_GAIN gets settled, per MICMON).
// Moving it here is what takes ACTIONS down to three, so ACTIONS becomes purely
// "things that change or end state".
function bSound(p,withBack){
  tabBar(p); withBack?backBand(p,"Sound"):pagerBand(p,1);
  const X=K.CARD_X,W=K.CARD_W;
  p.text("ALERTS", X+K.PAD, 116, {f:1,c:p.t.label});
  button(p,X,140,W,K.H_ROW,"SOUND ON",p.t.accent,true);
  // uiHint's lane is the PANEL, not the card - 32 chars = 256px centred on 320.
  p.text("beeps when a session needs input", K.W/2, 197, {f:1,c:p.t.label,datum:"MC"});
  // No bar under VOLUME, deliberately: board_es3c35p.h records that only
  // BRIGHTNESS gets one, because it is the single continuous 0-100 setting and
  // a bar under three named presets would be decoration.
  stepper(p,218,"VOLUME","MED",null);
  button(p,X,310,W,50,"TEST BEEP",p.t.accent,false);
  p.text("MICROPHONE", X+K.PAD, 374, {f:1,c:p.t.label});
  button(p,X,398,W,50,"MIC TEST",p.t.accent,false);
  footer(p);
}
// --- Display -----------------------------------------------------------
// VOLUME left for Sound, which freed 92px. It is NOT padding: THEME stops being
// a cramped third-width CYCLE button and becomes a 3-segment selector that shows
// all three options at once, and AUTO finally gets to say what it means.
function bDisplay(p,withBack){
  tabBar(p); withBack?backBand(p,"Display"):pagerBand(p,1);
  const X=K.CARD_X,W=K.CARD_W;
  stepper(p,K.P1_BRIGHT_Y,"BRIGHTNESS","90%",0.9);
  stepper(p,K.P1_SLEEP_Y,"SLEEP AFTER","30s",null);
  p.text("THEME", X+K.PAD, 298, {f:1,c:p.t.label});
  // A cycle button shows one state and hides the other two. Three segments show
  // the whole choice - and THEME has three states, so it was never a uiToggle.
  const seg=((W-8)/3)|0;
  ["DARK","LIGHT","AUTO"].forEach((lab,i)=>{
    const on = i===0;
    button(p, X+i*(seg+4), 318, seg, K.H_ROW, lab, on?p.t.accent:p.t.label, on);
  });
  // AUTO is a CLOCK, not a sensor: every ADC1 channel on this board is spoken
  // for, so there is no light to measure. Saying so is the same rule that stops
  // the farewell screen promising a touch wake this board does not have.
  p.text("AUTO = light 07:00 to 19:00", K.W/2, 377, {f:1,c:p.t.label,datum:"MC"});
  button(p,X,396,W,K.H_ROW,"NORMAL",p.t.label,false);
  footer(p);
}

// --- Pairing: the live Mac rows move here, where the Macs already are ----
// Today they are on page 0 AND page 3. Consolidating frees two rows on the
// busiest page and gives the pairing list the one thing it lacked: whether a
// remembered Mac is actually connected right now.
function bPairing(p,withBack){
  tabBar(p); withBack?backBand(p,"Pairing"):pagerBand(p,3);
  const X=K.CARD_X,W=K.CARD_W;
  p.text("ANSWER PROMPTS FROM", X+K.PAD, 116, {f:1,c:p.t.label});
  p.round(X,138,W,K.H_ROW,K.R,p.t.accent);
  p.stroke(X,138,W,K.H_ROW,K.R,K.BORDER_CTRL,p.t.accent);
  p.text("ANY MAC",X+K.SP3,138+K.H_ROW/2,{f:1,c:p.t.card,datum:"ML"});
  p.text("SELECTED",X+W-K.SP3,138+K.H_ROW/2,{f:1,c:p.t.card,datum:"MR"});
  p.text("PAIRED MACS", X+K.PAD, 196, {f:1,c:p.t.label});
  const macs=[["air  a3f2","connected, 2s ago",true],["studio  9c01","connected, 3s ago",true],
              ["mini  4b7e","last seen 2d ago",false],["lab  0f19","last seen 9d ago",false]];
  macs.forEach(([n,sub,live],i)=>{
    const y=218+i*60;
    p.card(X,y,W,52);
    p.dot(X+K.PAD+4,y+18,4,live?p.t.good:p.t.label,live);
    p.text(n, X+K.PAD+18, y+10, {f:1,c:p.t.value});
    p.text(sub, X+K.PAD+18, y+30, {f:1,c:live?p.t.good:p.t.label});
    p.text("x", X+W-24, y+26, {f:3,c:p.t.bad,datum:"MC"});
  });
  footer(p);
}

// ===========================================================================
// driver
// ===========================================================================
const SCREENS = {
  ab: [["HOME",homeScreen],["Status",p=>bStatus(p,true)],["Display",p=>bDisplay(p,true)],
       ["Sound",p=>bSound(p,true)],["Pairing",p=>bPairing(p,true)],["Actions",p=>bActions(p,true)]],
  cur:[["STATUS",curStatus],["DISPLAY & SOUND",curDisplay],["ACTIONS",curActions],["PAIRED MACS",curPairing]],
};
let THEME="DARK", SCALE=1.5, BOXES=false;
function draw(){
  BAD_CHARS.clear();
  for(const [group,list] of Object.entries(SCREENS)){
    const host=document.getElementById("s-"+group); if(!host) continue;
    host.innerHTML="";
    list.forEach(([cap,fn])=>{
      const fig=document.createElement("figure");
      const cv=document.createElement("canvas");
      cv.width=K.W; cv.height=K.H;
      cv.style.width=(K.W*SCALE)+"px"; cv.style.height=(K.H*SCALE)+"px";
      cv.style.imageRendering="pixelated";
      const ctx=cv.getContext("2d");
      const p=new P(THEME,BOXES); p.fill(p.t.bg); fn(p); p.paint(ctx);
      fig.appendChild(cv);
      const fc=document.createElement("figcaption"); fc.textContent=cap;
      fig.appendChild(fc); host.appendChild(fig);
    });
  }
  const el=document.getElementById("asciicheck");
  if(el){
    if(BAD_CHARS.size===0){
      el.className="ok";
      el.textContent="ASCII check: every string drawn above is inside Spleen's 0x20..0x7E. "
        +"Nothing here would render as a blank box on the device.";
    } else {
      el.className="bad";
      el.textContent="ASCII check FAILED - these would draw as blank boxes: "
        +[...BAD_CHARS].map(c=>`${c} (U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4,"0")})`).join(", ");
    }
  }
}
addEventListener("DOMContentLoaded",()=>{
  document.querySelectorAll("input[name=th]").forEach(r=>r.onchange=e=>{THEME=e.target.value;draw();});
  const sc=document.getElementById("scale"); if(sc) sc.onchange=e=>{SCALE=+e.target.value;draw();};
  const bx=document.getElementById("boxes"); if(bx) bx.onchange=e=>{BOXES=e.target.checked;draw();};
  draw();
});
