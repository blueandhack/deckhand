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

// ---------------------------------------------------------------------------
// K - EVERY CONSTANT THIS MOCK SHARES WITH THE FIRMWARE, under the firmware's own
// name. check.mjs parses board_es3c35p.h (through the checkers' own geom-common
// consts()) and asserts every one of these against it, so the mock cannot drift
// from the header while still reporting 50/50 - an unbound spec being the same
// class of defect as an assertion that cannot fail. The names are the HEADER's
// names on purpose: a translation table between the two is one more place for a
// drift to hide.
// ---------------------------------------------------------------------------
const K = {
  BOARD_W:320, BOARD_H:480, TAB_BAR_H:46, CONTENT_Y:46, FOOTER_H:20,
  CARD_X:12, CARD_W:296, PAD:18, SP_1:4, SP_2:8, SP_3:12, R_MD:12,
  TAP_MIN:46, H_ROW:46, H_BTN:50, BORDER_CARD:2, BORDER_CTRL:1,
  PAGER_H:54, PAGER_BTN_W:60, PAGER_BTN_X0:8, PAGE_TOP:104,
  STEPPER_CARD_H:80, STEP_LABEL_CY:12, STEP_VALUE_CY:43, STEP_BAR_Y:66,
  STEP_BTN_TOP:8, STEP_BTN_SIZE:64, STEP_BAR_H:8, STEP_BAR_GAP:10,
  SET_CAP_STEP:24,
  // HOME
  HOME_Y0:54, HOME_ROW_H:70, HOME_GAP:12, HOME_Y0_BOT:8,
  HOME_NAME_DY:14, HOME_SUB_DY:44,
  // Status
  ST_CONN_Y:116, ST_CONN_H:112, ST_PWR_Y:240, ST_PWR_H:112,
  ST_HOST_Y:364, ST_HOST_H:92,
  ST_CAP_DY:8, ST_BIG_DY:34, ST_L1_DY:66, ST_L2_DY:86,
  ST_HOST_R1_DY:34, ST_HOST_R2_DY:56,
  // Display
  P1_TOP:12, P1_GAP:12, P1_BRIGHT_Y:116, P1_SLEEP_Y:208,
  P1_THEME_CAP_Y:298, P1_THEME_Y:322, P1_THEME_SEG_W:96, P1_THEME_GAP:4,
  P1_AUTO_HINT_Y:381, P1_FLIP_Y:400,
  // Sound
  PS_ALERTS_Y:116, PS_SOUND_Y:140, PS_WHAT_HINT_Y:197, PS_VOL_Y:218,
  PS_BEEP_Y:310, PS_BTN_H:50, PS_MIC_CAP_Y:374, PS_MIC_Y:398,
  // Actions
  P2_TOP:12, P2_GAP:12, P2_BTN_H:56, P2_SPINE_W:4,
  P2_SETUP_CAP_Y:116, P2_CAL_Y:140, P2_DANGER_CAP_Y:222,
  P2_PAIR_Y:246, P2_PWR_Y:314, P2_HINT_Y:394,
  // Pairing
  P3_ANY_CAP_Y:116, P3_ANY_Y:138, P3_LIST_CAP_Y:196, P3_LIST_Y:218,
  P3_ROW_H:52, P3_ROW_STEP:60, P3_ROW_DOT_R:4,
  P3_ROW_NAME_DY:10, P3_ROW_SUB_DY:30, P3_ROW_TEXT_DX:18, P3_X_W:46,
};
// contentBottom() is a FUNCTION on the device, not a const, so it is derived here
// the way the device derives it and check.mjs asserts that identity separately.
K.contentBottom = K.BOARD_H - K.FOOTER_H;                 // 460

// ---------------------------------------------------------------------------
// WAS - the constants of the page this branch REPLACED, kept because the "what
// ships today" column below is a before picture and has to keep drawing it. They
// are deliberately OUT of K and therefore out of check.mjs's header bind: a
// before picture that tracked the header would stop being a before picture the
// moment the header moved, which is the one thing it must not do. Nothing here
// may share a name with K - check.mjs asserts that, so a live constant cannot be
// quietly parked in here to escape the bind.
// ---------------------------------------------------------------------------
const WAS = {
  DEV_CARD_Y:116, DEV_CARD_H:200,
  DROW_BT:34, DROW_USB:58, DROW_BATT:82, DROW_TEMP:106, DROW_ID:130,
  DROW_MAC0:154, DROW_MAC1:178,
  LINK_CARD_Y:328, LINK_CARD_H:128,
  LROW_HOST:34, LROW_PAYLOAD:58, LROW_FLUSH:82, LROW_UPTIME:106,
  // The old DISPLAY & SOUND page: three steppers and a row of three thirds.
  P1_THIRD_W:(296-16)/3|0, P1_VOL_Y:300, P1_SOUND_Y:392,   // (CARD_W - 16) / 3
  // The old four-button ACTIONS page, at its own 50px button height.
  P2_BTN_H:50, P2_MIC_Y:116, P2_CAL_Y:178, P2_PAIR_Y:240, P2_PWR_Y:302,
  P2_HINT_Y:364,
  // The old PAIRED MACS page: one uiListRow per Mac, no state line.
  P3_ANY_Y:106, P3_LIST_Y:156,
};
WAS.P1_FLIP_X  = K.CARD_X + WAS.P1_THIRD_W + 8;
WAS.P1_THEME_X = K.CARD_X + 2*(WAS.P1_THIRD_W + 8);

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
  fill(col){ this._r(0,0,K.BOARD_W,K.BOARD_H,col); }
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
  card(x,y,w,h,border){ this.round(x,y,w,h,K.R_MD,this.t.card);
    this.stroke(x,y,w,h,K.R_MD,K.BORDER_CARD,border||this.t.label); }
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
  p.rect(0,0,K.BOARD_W,K.TAB_BAR_H,p.t.card);
  const slot = rec ? 40 : 0, tw = ((K.BOARD_W-slot)/3)|0;
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
  p.rect(0,y,K.BOARD_W,K.FOOTER_H,p.t.bg);
  p.text("14:31", 12, y+2, {f:1,c:p.t.label});
  p.text("78%", 135, y+2, {f:1,c:p.t.good});
  p.text("2s ago", K.BOARD_W-12, y+2, {f:1,c:p.t.label,datum:"TR"});
}
function pagerBand(p,page){
  const titles=["STATUS","DISPLAY & SOUND","ACTIONS","PAIRED MACS"];
  const cy=K.CONTENT_Y+K.PAGER_H/2, by=K.CONTENT_Y+4, bh=K.PAGER_H-8;
  for(const side of [0,1]){
    const bx = side===0 ? K.PAGER_BTN_X0 : K.BOARD_W-K.PAGER_BTN_X0-K.PAGER_BTN_W;
    p.round(bx,by,K.PAGER_BTN_W,bh,K.R_MD,p.t.card);
    p.stroke(bx,by,K.PAGER_BTN_W,bh,K.R_MD,K.BORDER_CTRL,p.t.accent);
    p.text(side===0?"<":">", bx+K.PAGER_BTN_W/2, cy, {f:1,c:p.t.accent,datum:"MC"});
  }
  p.text(titles[page], K.BOARD_W/2, cy-5, {f:1,c:p.t.value,datum:"MC"});
  const sp=12, x0=K.BOARD_W/2-(3*sp)/2;
  for(let i=0;i<4;i++) p.dot(x0+i*sp, cy+8, 3, i===page?p.t.accent:p.t.label, i===page);
}
function stepper(p,y,label,value,bar){
  p.card(K.CARD_X,y,K.CARD_W,K.STEPPER_CARD_H);
  const bs=K.STEP_BTN_SIZE, bt=y+K.STEP_BTN_TOP;
  for(const [bx,g] of [[K.CARD_X+K.PAD,"-"],[K.CARD_X+K.CARD_W-K.PAD-bs,"+"]]){
    p.round(bx,bt,bs,bs,K.R_MD,p.t.card); p.stroke(bx,bt,bs,bs,K.R_MD,K.BORDER_CTRL,p.t.accent);
    p.text(g,bx+bs/2,bt+bs/2,{f:3,c:p.t.accent,datum:"MC"});
  }
  p.text(label, K.BOARD_W/2, y+K.STEP_LABEL_CY, {f:1,c:p.t.label,datum:"MC"});
  p.text(value, K.BOARD_W/2, y+K.STEP_VALUE_CY, {f:3,c:p.t.value,datum:"MC"});
  if(bar!=null){
    const x0=K.CARD_X+K.PAD+bs+K.STEP_BAR_GAP, x1=K.CARD_X+K.CARD_W-K.PAD-bs-K.STEP_BAR_GAP;
    p.rect(x0,y+K.STEP_BAR_Y,x1-x0,K.STEP_BAR_H,p.t.card==="#000"?p.t.label:p.t.unknown);
    p.rect(x0,y+K.STEP_BAR_Y,(x1-x0)*bar|0,K.STEP_BAR_H,p.t.accent);
  }
}
function button(p,x,y,w,h,label,tint,filled){
  const bg = filled ? tint : p.t.card;
  p.round(x,y,w,h,K.R_MD,bg); p.stroke(x,y,w,h,K.R_MD,K.BORDER_CTRL,tint);
  p.text(label,x+w/2,y+h/2,{f:1,c:filled?p.t.card:tint,datum:"MC"});
}

// ===========================================================================
// WHAT SHIPS TODAY
// ===========================================================================
function curStatus(p){
  tabBar(p); pagerBand(p,0);
  const X=K.CARD_X, W=K.CARD_W, y=WAS.DEV_CARD_Y;
  p.card(X,y,W,WAS.DEV_CARD_H);
  p.text("DEVICE", X+K.PAD, y+6, {f:1,c:p.t.label});
  const conn=(dy,lab,ok)=>{
    p.dot(X+K.PAD+6, y+dy+8, 6, ok?p.t.good:p.t.label);
    p.text(lab, X+K.PAD+20, y+dy, {f:1,c:p.t.value});
    p.text(ok?"Connected":"Not connected", X+W-K.PAD, y+dy, {f:1,c:ok?p.t.good:p.t.label,datum:"TR"});
  };
  conn(WAS.DROW_BT,"Bluetooth",true); conn(WAS.DROW_USB,"USB",true);
  p.dot(X+K.PAD+6, y+WAS.DROW_BATT+8, 6, p.t.good);
  p.text("Battery", X+K.PAD+20, y+WAS.DROW_BATT, {f:1,c:p.t.value});
  p.text("    78% 4.05V ~5h", X+W-K.PAD, y+WAS.DROW_BATT, {f:1,c:p.t.good,datum:"TR"});
  p.text("SoC temp", X+K.PAD+20, y+WAS.DROW_TEMP, {f:1,c:p.t.value});
  p.text(" 46.6 C", X+W-K.PAD, y+WAS.DROW_TEMP, {f:1,c:p.t.good,datum:"TR"});
  p.text("Deckhand-C114  paired x2", X+K.PAD, y+WAS.DROW_ID, {f:1,c:p.t.good});
  p.text("Mac  air  2s ago", X+K.PAD, y+WAS.DROW_MAC0, {f:1,c:p.t.value});
  p.text("Mac  studio  3s ago", X+K.PAD, y+WAS.DROW_MAC1, {f:1,c:p.t.value});
  const ly=WAS.LINK_CARD_Y;
  p.card(X,ly,W,WAS.LINK_CARD_H);
  p.text("LINK", X+K.PAD, ly+6, {f:1,c:p.t.label});
  [["HOST","ticking 2s",WAS.LROW_HOST],["PAYLOAD","779 B",WAS.LROW_PAYLOAD],
   ["FLUSH","1.1 ms",WAS.LROW_FLUSH],["UPTIME","4h 12m",WAS.LROW_UPTIME]].forEach(([l,v,dy])=>{
    p.text(l, X+K.PAD, ly+dy, {f:1,c:p.t.label});
    p.text(v, X+W-K.PAD, ly+dy, {f:1,c:p.t.value,datum:"TR"});
  });
  footer(p);
}
function curDisplay(p){
  tabBar(p); pagerBand(p,1);
  stepper(p,K.P1_BRIGHT_Y,"BRIGHTNESS","90%",0.9);
  stepper(p,K.P1_SLEEP_Y,"SLEEP AFTER","30s",null);
  stepper(p,WAS.P1_VOL_Y,"VOLUME","MED",null);
  const w=WAS.P1_THIRD_W, y=WAS.P1_SOUND_Y, h=K.H_ROW;
  button(p,K.CARD_X,y,w,h,"SOUND",p.t.accent,true);
  button(p,WAS.P1_FLIP_X,y,w,h,"NORMAL",p.t.label,false);
  button(p,WAS.P1_THEME_X,y,w,h,"DARK",p.t.label,false);
  footer(p);
}
function curActions(p){
  tabBar(p); pagerBand(p,2);
  button(p,K.CARD_X,WAS.P2_MIC_Y,K.CARD_W,WAS.P2_BTN_H,"MIC TEST",p.t.accent,false);
  button(p,K.CARD_X,WAS.P2_CAL_Y,K.CARD_W,WAS.P2_BTN_H,"CALIBRATE TOUCH",p.t.accent,false);
  button(p,K.CARD_X,WAS.P2_PAIR_Y,K.CARD_W,WAS.P2_BTN_H,"RESET PAIRING",p.t.warn,false);
  button(p,K.CARD_X,WAS.P2_PWR_Y,K.CARD_W,WAS.P2_BTN_H,"POWER OFF",p.t.bad,false);
  p.text("power off = deep sleep, RESET to wake", K.BOARD_W/2, WAS.P2_HINT_Y, {f:1,c:p.t.label,datum:"MC"});
  footer(p);
}
function curPairing(p){
  tabBar(p); pagerBand(p,3);
  const row=(y,lab,sel,tag)=>{
    p.round(K.CARD_X,y,K.CARD_W,K.H_ROW,K.R_MD,sel?p.t.accent:p.t.card);
    p.stroke(K.CARD_X,y,K.CARD_W,K.H_ROW,K.R_MD,K.BORDER_CTRL,sel?p.t.accent:p.t.label);
    p.text(lab,K.CARD_X+K.SP_3,y+K.H_ROW/2,{f:1,c:sel?p.t.card:p.t.value,datum:"ML"});
    if(tag) p.text(tag,K.CARD_X+K.CARD_W-K.SP_3-40-K.SP_2,y+K.H_ROW/2,{f:1,c:sel?p.t.card:p.t.label,datum:"MR"});
  };
  row(WAS.P3_ANY_Y,"ANY MAC",true,"SELECTED");
  ["air  a3f2","studio  9c01","mini  4b7e","lab  0f19"].forEach((n,i)=>{
    const y=WAS.P3_LIST_Y+i*(K.H_ROW+K.SP_1); row(y,n,false,null);
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
function homeScreen(p){
  tabBar(p);
  HOME_ROWS.forEach(([name,sub,state],i)=>{
    const y = K.HOME_Y0 + i*(K.HOME_ROW_H + K.HOME_GAP);
    p.card(K.CARD_X,y,K.CARD_W,K.HOME_ROW_H);
    p.text(name, K.CARD_X+K.PAD, y+K.HOME_NAME_DY, {f:3,c:p.t.value});
    p.text(sub,  K.CARD_X+K.PAD, y+K.HOME_SUB_DY, {f:1,c:state==="good"?p.t.good:p.t.label});
    p.text(">",  K.CARD_X+K.CARD_W-K.PAD, y+K.HOME_ROW_H/2, {f:3,c:p.t.accent,datum:"MR"});
  });
  footer(p);
}
function backBand(p,title){
  const by=K.CONTENT_Y+4, bh=K.PAGER_H-8, bx=K.PAGER_BTN_X0;
  p.round(bx,by,K.PAGER_BTN_W,bh,K.R_MD,p.t.card);
  p.stroke(bx,by,K.PAGER_BTN_W,bh,K.R_MD,K.BORDER_CTRL,p.t.accent);
  p.text("<", bx+K.PAGER_BTN_W/2, by+bh/2, {f:3,c:p.t.accent,datum:"MC"});
  p.text(title, bx+K.PAGER_BTN_W+16, K.CONTENT_Y+K.PAGER_H/2, {f:3,c:p.t.value,datum:"ML"});
}
function aDisplay(p){
  tabBar(p); backBand(p,"Display");
  stepper(p,K.P1_BRIGHT_Y,"BRIGHTNESS","90%",0.9);
  stepper(p,K.P1_SLEEP_Y,"SLEEP AFTER","30s",null);
  stepper(p,WAS.P1_VOL_Y,"VOLUME","MED",null);
  const w=WAS.P1_THIRD_W,y=WAS.P1_SOUND_Y,h=K.H_ROW;
  button(p,K.CARD_X,y,w,h,"SOUND",p.t.accent,true);
  button(p,WAS.P1_FLIP_X,y,w,h,"NORMAL",p.t.label,false);
  button(p,WAS.P1_THEME_X,y,w,h,"DARK",p.t.label,false);
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
    p.text(cap, X+K.PAD, y+K.ST_CAP_DY, {f:1,c:p.t.label});
    p.text(big, X+K.PAD, y+K.ST_BIG_DY, {f:3,c:bigCol});
    if(l1) p.text(l1, X+K.PAD, y+K.ST_L1_DY, {f:1,c:p.t.label});
    if(l2) p.text(l2, X+K.PAD, y+K.ST_L2_DY, {f:1,c:p.t.label});
  };
  block(K.ST_CONN_Y,K.ST_CONN_H,"CONNECTION","Both links up",p.t.good,
        "USB and Bluetooth, 2s ago","Deckhand-C114");
  block(K.ST_PWR_Y,K.ST_PWR_H,"POWER","78%  4.05V",p.t.good,
        "about 5h left on battery","SoC 46.6 C");
  const hy=K.ST_HOST_Y;
  p.card(X,hy,W,K.ST_HOST_H);
  p.text("HOST", X+K.PAD, hy+K.ST_CAP_DY, {f:1,c:p.t.label});
  p.text("779 B per tick",  X+K.PAD, hy+K.ST_HOST_R1_DY, {f:1,c:p.t.value});
  p.text("flush 1.1 ms",    X+K.PAD, hy+K.ST_HOST_R2_DY, {f:1,c:p.t.value});
  p.text("up 4h 12m",  X+W-K.PAD, hy+K.ST_HOST_R1_DY, {f:1,c:p.t.value,datum:"TR"});
  p.text("2 Macs",     X+W-K.PAD, hy+K.ST_HOST_R2_DY, {f:1,c:p.t.value,datum:"TR"});
  footer(p);
}
function bActions(p,withBack){
  tabBar(p); withBack?backBand(p,"Actions"):pagerBand(p,2);
  const X=K.CARD_X,W=K.CARD_W,H=K.P2_BTN_H;  // 3 buttons, not 4 - MIC TEST lives on Sound
  // LEVEL WITH THE OTHER FOUR GROUPS: the caption starts at 116 like bStatus,
  // bDisplay, bSound and bPairing, and the caption step is 24 like bSound's. This
  // group used to start at 120 with a 26px step, which was this file's own
  // inconsistency rather than a decision - a 4px jog as you move between groups.
  // board_es3c35p.h's P2_TOP/SET_CAP_STEP match, and settings-geom-check.mjs
  // asserts the five groups' tops are EQUAL rather than asserting any one value.
  const cap=(y,s)=>p.text(s,X+K.PAD,y,{f:1,c:p.t.label});
  cap(K.P2_SETUP_CAP_Y,"SETUP");
  button(p,X,K.P2_CAL_Y,W,H,"CALIBRATE TOUCH",p.t.accent,false);
  // Destructive actions are SEPARATED, captioned, and carry a solid severity
  // spine - so severity survives greyscale and colour-blindness, which an
  // outline hue alone does not.
  cap(K.P2_DANGER_CAP_Y,"CANNOT BE UNDONE");
  // The spine: BORDER_CTRL inside the button's own left edge, R_MD to H - R_MD so
  // it never crosses a corner arc, and its ends rounded at half its width.
  const sev=(y,label,col)=>{
    button(p,X,y,W,H,label,col,false);
    const sw=K.P2_SPINE_W, sx=X+K.BORDER_CTRL;
    p.rect(sx,y+K.R_MD,sw,H-2*K.R_MD,col);
    p.dot(sx+sw/2,y+K.R_MD,sw/2,col); p.dot(sx+sw/2,y+H-K.R_MD-1,sw/2,col);
  };
  sev(K.P2_PAIR_Y,"RESET PAIRING",p.t.warn);
  sev(K.P2_PWR_Y,"POWER OFF",p.t.bad);
  p.text("power off = deep sleep, RESET to wake",K.BOARD_W/2,K.P2_HINT_Y,{f:1,c:p.t.label,datum:"MC"});
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
  p.text("ALERTS", X+K.PAD, K.PS_ALERTS_Y, {f:1,c:p.t.label});
  button(p,X,K.PS_SOUND_Y,W,K.H_ROW,"SOUND ON",p.t.accent,true);
  // uiHint's lane is the PANEL, not the card - 32 chars = 256px centred on 320.
  p.text("beeps when a session needs input", K.BOARD_W/2, K.PS_WHAT_HINT_Y, {f:1,c:p.t.label,datum:"MC"});
  // No bar under VOLUME, deliberately: board_es3c35p.h records that only
  // BRIGHTNESS gets one, because it is the single continuous 0-100 setting and
  // a bar under three named presets would be decoration.
  stepper(p,K.PS_VOL_Y,"VOLUME","MED",null);
  button(p,X,K.PS_BEEP_Y,W,K.PS_BTN_H,"TEST BEEP",p.t.accent,false);
  p.text("MICROPHONE", X+K.PAD, K.PS_MIC_CAP_Y, {f:1,c:p.t.label});
  button(p,X,K.PS_MIC_Y,W,K.PS_BTN_H,"MIC TEST",p.t.accent,false);
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
  p.text("THEME", X+K.PAD, K.P1_THEME_CAP_Y, {f:1,c:p.t.label});
  // A cycle button shows one state and hides the other two. Three segments show
  // the whole choice - and THEME has three states, so it was never a uiToggle.
  // The caption's step is SET_CAP_STEP, the one step every captioned control on
  // this board takes; P1_THEME_CAP_STEP was a second name for it and is gone.
  ["DARK","LIGHT","AUTO"].forEach((lab,i)=>{
    const on = i===0;
    button(p, X+i*(K.P1_THEME_SEG_W+K.P1_THEME_GAP), K.P1_THEME_Y,
           K.P1_THEME_SEG_W, K.H_ROW, lab, on?p.t.accent:p.t.label, on);
  });
  // AUTO is a CLOCK, not a sensor: every ADC1 channel on this board is spoken
  // for, so there is no light to measure. Saying so is the same rule that stops
  // the farewell screen promising a touch wake this board does not have.
  p.text("AUTO = light 07:00 to 19:00", K.BOARD_W/2, K.P1_AUTO_HINT_Y, {f:1,c:p.t.label,datum:"MC"});
  // THE LABEL NAMES ITS SUBJECT. It is the one control on this group with no
  // caption over it, and "NORMAL" alone under a hint about AUTO said nothing
  // about what was normal - the SOUND group's toggle next door already reads
  // "SOUND ON"/"SOUND OFF".
  button(p,X,K.P1_FLIP_Y,W,K.H_ROW,"SCREEN NORMAL",p.t.label,false);
  footer(p);
}

// --- Pairing: the live Mac rows move here, where the Macs already are ----
// Today they are on page 0 AND page 3. Consolidating frees two rows on the
// busiest page and gives the pairing list the one thing it lacked: whether a
// remembered Mac is actually connected right now.
function bPairing(p,withBack){
  tabBar(p); withBack?backBand(p,"Pairing"):pagerBand(p,3);
  const X=K.CARD_X,W=K.CARD_W;
  p.text("ANSWER PROMPTS FROM", X+K.PAD, K.P3_ANY_CAP_Y, {f:1,c:p.t.label});
  const ay=K.P3_ANY_Y;
  p.round(X,ay,W,K.H_ROW,K.R_MD,p.t.accent);
  p.stroke(X,ay,W,K.H_ROW,K.R_MD,K.BORDER_CTRL,p.t.accent);
  p.text("ANY MAC",X+K.SP_3,ay+K.H_ROW/2,{f:1,c:p.t.card,datum:"ML"});
  p.text("SELECTED",X+W-K.SP_3,ay+K.H_ROW/2,{f:1,c:p.t.card,datum:"MR"});
  p.text("PAIRED MACS", X+K.PAD, K.P3_LIST_CAP_Y, {f:1,c:p.t.label});
  const macs=[["air  a3f2","connected, 2s ago",true],["studio  9c01","connected, 3s ago",true],
              ["mini  4b7e","last seen 2d ago",false],["lab  0f19","last seen 9d ago",false]];
  macs.forEach(([n,sub,live],i)=>{
    const y=K.P3_LIST_Y+i*K.P3_ROW_STEP;
    p.card(X,y,W,K.P3_ROW_H);
    p.dot(X+K.PAD+K.P3_ROW_DOT_R,y+K.P3_ROW_NAME_DY+8,K.P3_ROW_DOT_R,live?p.t.good:p.t.label,live);
    p.text(n, X+K.PAD+K.P3_ROW_TEXT_DX, y+K.P3_ROW_NAME_DY, {f:1,c:p.t.value});
    p.text(sub, X+K.PAD+K.P3_ROW_TEXT_DX, y+K.P3_ROW_SUB_DY, {f:1,c:live?p.t.good:p.t.label});
    p.text("x", X+W-K.P3_X_W/2, y+K.P3_ROW_H/2, {f:3,c:p.t.bad,datum:"MC"});
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
      cv.width=K.BOARD_W; cv.height=K.BOARD_H;
      cv.style.width=(K.BOARD_W*SCALE)+"px"; cv.style.height=(K.BOARD_H*SCALE)+"px";
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
