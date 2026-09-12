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
  BACK_BTN_W:60, BACK_TITLE_DX:16,
  STEPPER_CARD_H:80, STEP_LABEL_CY:12, STEP_VALUE_CY:43, STEP_BAR_Y:66,
  STEP_BTN_TOP:8, STEP_BTN_SIZE:64, STEP_BAR_H:8, STEP_BAR_GAP:10,
  SET_CAP_STEP:24, SET_GROUP_COUNT:6,
  // HOME - six rows, one per group, at the 58/10 pitch Task 1 landed and the
  // six-group amendment did NOT move.
  HOME_Y0:54, HOME_ROW_H:58, HOME_GAP:10, HOME_Y0_BOT:8,
  HOME_NAME_DY:8, HOME_SUB_DY:36, HOME_SUB_CHARS:30,
  // Device - two SLIMMED live cards (112 -> 70 each) over the diagnostics block
  ST_CONN_Y:116, ST_CONN_H:70, ST_PWR_Y:198, ST_PWR_H:70,
  ST_CAP_DY:6, ST_BIG_DY:24, ST_L1_DY:50,
  ST_VERDICT_CHARS:14, ST_BIG_CHARS:11, ST_LINE_CHARS:28,
  DEV_DIAG_CAP_Y:280, DEV_DIAG_Y:304, DEV_DIAG_STEP:18, DEV_DIAG_LINES:6,
  DEV_DIAG_CHARS:32, DEV_DIAG_TEMP_LINE:1, DEV_AIR_BOT:49,
  // Display
  P1_TOP:12, P1_GAP:12, P1_BRIGHT_Y:116, P1_SLEEP_Y:208,
  P1_THEME_CAP_Y:298, P1_THEME_Y:322, P1_THEME_SEG_W:96, P1_THEME_GAP:4,
  P1_AUTO_HINT_Y:381, P1_FLIP_Y:400, P1_AIR_BOT:14,
  // Sound
  PS_ALERTS_Y:116, PS_SOUND_Y:140, PS_WHAT_HINT_Y:197, PS_VOL_Y:218,
  PS_BEEP_Y:310, PS_BTN_H:50, PS_MIC_CAP_Y:374, PS_MIC_Y:398, PS_AIR_BOT:12,
  // Danger - TWO buttons and one caption, both of them destructive
  P2_TOP:12, P2_BTN_H:56, P2_SPINE_W:4,
  P2_DANGER_CAP_Y:116, P2_PAIR_Y:140, P2_PWR_Y:208, P2_AIR_BOT:174,
  // Pairing
  P3_ANY_CAP_Y:116, P3_ANY_Y:138, P3_LIST_CAP_Y:196, P3_LIST_Y:218,
  P3_ROW_H:52, P3_ROW_STEP:60, P3_ROW_DOT_R:4,
  P3_ROW_NAME_DY:10, P3_ROW_SUB_DY:30, P3_ROW_TEXT_DX:18, P3_X_W:46,
  P3_SUB_CHARS:20, P3_EMPTY_HINT_Y:304,
  // Messages
  P4_CAP_Y:116, P4_ROW_Y:140, P4_ROW_STEP:80, P4_HINT_Y:370,
  P4_LABEL_CHARS:32, P4_AIR_BOT:80,
};
K.contentBottom = K.BOARD_H - K.FOOTER_H;                 // 460

// ---------------------------------------------------------------------------
// WAS - the geometry of pages this mock still DRAWS but the firmware no longer
// has. Two before pictures live in here and they are different vintages, which is
// why the second carries a prefix:
//
//   plain names   the PRE-BRANCH device - the four-page chevron pager, drawn in
//                 the "what ships today" column at the foot of the page.
//   G7_*          the SEVEN-GROUP design this mock itself drew until the six-group
//                 AMENDMENT (2026-09-12) replaced it, when board 1's Macs page
//                 turned out to spend 216 of its 222px and RESET PAIRING had
//                 nowhere to go. Kept and marked rather than deleted, which is this
//                 repo's rule about descriptions that turned out to be wrong: a
//                 reader comparing the spec's body against its amendment can see
//                 both pictures instead of taking the difference on trust.
//
// Everything here is deliberately OUT of K and therefore out of check.mjs's header
// bind: a before picture that tracked the header would stop being a before picture
// the moment the header moved, which is the one thing it must not do. THE RULE THAT
// KEEPS THAT HONEST is that every entry must actually DIFFER from what ships -
// check.mjs resolves the G7_ prefix and asserts it, so a live constant cannot be
// quietly parked in here (under either spelling) to escape the bind.
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

  // ---- the SEVEN-GROUP design, replaced by the six-group amendment ----------
  // HOME at seven rows: Status, Display, Sound, Pairing, Messages, About, Actions.
  // 54 + 7*50 + 6*8 + 8 == 460, the same closing identity at a tighter pitch.
  G7_HOME_ROW_H:50, G7_HOME_GAP:8, G7_HOME_SUB_DY:32,
  // Status at three FULL-HEIGHT cards. The HOST card is what the DIAGNOSTICS block
  // replaced, and taking the two live cards 112 -> 70 is what paid for it.
  G7_ST_CONN_H:112, G7_ST_PWR_Y:240, G7_ST_PWR_H:112,
  G7_ST_HOST_Y:364, G7_ST_HOST_H:92,
  G7_ST_CAP_DY:8, G7_ST_BIG_DY:34, G7_ST_L1_DY:66, G7_ST_L2_DY:86,
  G7_ST_HOST_R1_DY:34, G7_ST_HOST_R2_DY:56,
  // Actions with CALIBRATE TOUCH still on it, under a SETUP caption, above the two
  // destructive buttons. RULING 12 moved that button to board 1's DEVICE group and
  // left the group holding exactly two verbs, which is what renamed it Danger.
  G7_P2_SETUP_CAP_Y:116, G7_P2_CAL_Y:140, G7_P2_DANGER_CAP_Y:222,
  G7_P2_PAIR_Y:246, G7_P2_PWR_Y:314, G7_P2_HINT_Y:394,
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
// WHAT SHIPS NOW - HOME and its six groups, on BOTH boards
// The pager band (46..103) became a BACK band of exactly the same height, so
// every group keeps PAGE_TOP 104 and no page body had to be re-derived. Drawn
// here at board 2's geometry; board 1 draws the same surfaces out of its own
// header, 134px shorter, and carries none of the section captions (see
// BOARD_SETTINGS_FITS_CAPTIONS).
// ===========================================================================

// The SIX group names in SET_DEVICE..SET_DANGER order and the summary each row
// carries, taken from settingsGroupTitle() and settingsHomeSummary(). check.mjs
// asserts the names against the firmware's own table and the summaries against
// HOME_SUB_CHARS, so a row that outgrows its lane fails here rather than on glass.
const HOME_ROWS = [
  ["Device",   "Both links up   78%   46 C",  "good"],
  ["Display",  "90%   sleep 30s   DARK",      null],
  ["Sound",    "ON   volume MED   mic",       null],
  ["Pairing",  "2 Macs   any may answer",     null],
  ["Messages", "send NEXT",                   null],
  // Danger is LAST and that is the one ordering rule this menu protects: it is the
  // only group that destroys state. The six-group amendment PRESERVED that rule
  // rather than reversing it, which the five-group set would have had to do.
  ["Danger",   "reset pairing, power off",    null],
];
function homeRows(p,rows,rowH,gap,subDy){
  rows.forEach(([name,sub,state],i)=>{
    const y = K.HOME_Y0 + i*(rowH + gap);
    p.card(K.CARD_X,y,K.CARD_W,rowH);
    p.text(name, K.CARD_X+K.PAD, y+K.HOME_NAME_DY, {f:3,c:p.t.value});
    p.text(sub,  K.CARD_X+K.PAD, y+subDy, {f:1,c:state==="good"?p.t.good:p.t.label});
    // A plain ASCII ">", never U+203A or U+2026: every face on this device declares
    // 0x20..0x7E and nothing else, so a real chevron draws as nothing AND advances
    // nothing. BAD_CHARS would catch it here; the device would just go blank.
    p.text(">",  K.CARD_X+K.CARD_W-K.PAD, y+rowH/2, {f:3,c:p.t.accent,datum:"MR"});
  });
}
function homeScreen(p){
  // HOME owns the WHOLE content area - no band above it, because the tab bar
  // already says SETTINGS and a second title would be chrome repeating itself.
  tabBar(p);
  homeRows(p,HOME_ROWS,K.HOME_ROW_H,K.HOME_GAP,K.HOME_SUB_DY);
  footer(p);
}
function backBand(p,title){
  const by=K.CONTENT_Y+4, bh=K.PAGER_H-8, bx=K.PAGER_BTN_X0;
  p.round(bx,by,K.BACK_BTN_W,bh,K.R_MD,p.t.card);
  p.stroke(bx,by,K.BACK_BTN_W,bh,K.R_MD,K.BORDER_CTRL,p.t.accent);
  // THE WHOLE BAND is the back target, not just the key - there is one control in
  // it, so unlike the chevron pager there is no 45/55 split to leave a dead zone.
  p.text("<", bx+K.BACK_BTN_W/2, by+bh/2, {f:3,c:p.t.accent,datum:"MC"});
  p.text(title, bx+K.BACK_BTN_W+K.BACK_TITLE_DX, K.CONTENT_Y+K.PAGER_H/2,
         {f:3,c:p.t.value,datum:"ML"});
}
// A page caption: T_META, TL, at the card's own left inset. drawGroupCaption().
function cap(p,y,s){ p.text(s,K.CARD_X+K.PAD,y,{f:1,c:p.t.label}); }
// uiHint(): T_META, centred on the PANEL rather than on the card.
function hint(p,y,s){ p.text(s,K.BOARD_W/2,y,{f:1,c:p.t.label,datum:"MC"}); }
function padTo(s,n){ return s.length>=n ? s : s + " ".repeat(n-s.length); }

// --- Device -------------------------------------------------------------
// TWO live cards at 70px - down from 112 - over a six-line DIAGNOSTICS block.
// The cards each lost a second line to the block below them (the device name and
// the paired count went to Pairing; the SoC temp became a diagnostics column),
// and that is what paid for eleven facts that used to be a card and a whole page.
function devDiagLine(left,right){
  // devDiagLine(): the right column flush to the lane's right edge, the left
  // padded and truncated to what is left. One padded field, not two, because both
  // faces are monospace and one opaque box cannot leave a seam down the middle.
  const rl = Math.min(right.length, K.DEV_DIAG_CHARS);
  const at = K.DEV_DIAG_CHARS - rl;
  return padTo(left.slice(0,at), at) + right.slice(0,rl);
}
const DIAG = [
  ["779 B per tick", "flush 1.1 ms"],
  ["SoC 46.6 C",     ""],                       // DEV_DIAG_TEMP_LINE - alone, and coloured
  ["BT 34:85:18:9b:2c:14", "2 Macs"],
  ["Deckhand-C114",  "up 4h 12m"],
  ["ES3C35P",        "a3f21c9"],
  ["Sep 12 2026",    "07:45:14"],
];
function bDevice(p){
  tabBar(p); backBand(p,"Device");
  const X=K.CARD_X, W=K.CARD_W, x=X+K.PAD;
  const liveCard=(y,h,capS,big,bigCol,line)=>{
    p.card(X,y,W,h);
    p.text(capS, x, y+K.ST_CAP_DY, {f:1,c:p.t.label});
    // The PHRASE names the state on its own, in greyscale and to a colour-blind
    // eye; the colour is an accent on it and never the carrier.
    p.text(padTo(big,K.ST_VERDICT_CHARS), x, y+K.ST_BIG_DY, {f:3,c:bigCol});
    p.text(padTo(line,K.ST_LINE_CHARS),   x, y+K.ST_L1_DY,  {f:1,c:p.t.label});
  };
  liveCard(K.ST_CONN_Y,K.ST_CONN_H,"CONNECTION","Both links up",p.t.good,
           "USB and Bluetooth, 2s ago");
  liveCard(K.ST_PWR_Y,K.ST_PWR_H,"POWER","78%  4.05V",p.t.good,
           "~5h left on battery");
  cap(p,K.DEV_DIAG_CAP_Y,"DIAGNOSTICS");
  DIAG.forEach(([l,r],i)=>{
    // Line DEV_DIAG_TEMP_LINE is the one with no right column, BECAUSE it is the
    // one whose colour means something: a line here is one padded field with one
    // colour, so a temperature sharing a line would colour its neighbour too.
    const col = i===K.DEV_DIAG_TEMP_LINE ? p.t.good : p.t.value;
    p.text(devDiagLine(l,r), x, K.DEV_DIAG_Y + i*K.DEV_DIAG_STEP, {f:1,c:col});
  });
  footer(p);
}

// --- Danger --------------------------------------------------------------
// TWO buttons, ONE caption, and both of them destroy state - which is what the
// group is called Danger for. CALIBRATE TOUCH left for board 1's Device group
// (RULING 12) and board 2 does not offer it at all, so what is left is exactly
// the two verbs that cannot be undone, on both boards.
function severity(p,y,label,col){
  button(p,K.CARD_X,y,K.CARD_W,K.P2_BTN_H,label,col,false);
  // The spine carries severity as INK MASS, so it survives greyscale and
  // colour-blindness where an outline hue alone does not. Its Y-INSET is what
  // keeps it off the corner arcs, not its width: R_MD to H - R_MD.
  const sw=K.P2_SPINE_W, sx=K.CARD_X+K.BORDER_CTRL;
  p.rect(sx,y+K.R_MD,sw,K.P2_BTN_H-2*K.R_MD,col);
  p.dot(sx+sw/2,y+K.R_MD,sw/2,col); p.dot(sx+sw/2,y+K.P2_BTN_H-K.R_MD-1,sw/2,col);
}
function bDanger(p){
  tabBar(p); backBand(p,"Danger");
  cap(p,K.P2_DANGER_CAP_Y,"CANNOT BE UNDONE");
  // POWER OFF is LAST because it is the more severe of the two: a reset costs the
  // keys, a power-off costs the device until someone presses RESET.
  severity(p,K.P2_PAIR_Y,"RESET PAIRING",p.t.warn);
  severity(p,K.P2_PWR_Y,"POWER OFF",p.t.bad);
  // The ONLY thing that says what POWER OFF does BEFORE the tap - the confirm
  // dialog says it after, which is too late to be the affordance. This board
  // cannot wake on touch, so the sentence says RESET (BOARD_HAS_TOUCH_SLEEP_WAKE).
  hint(p,K.P2_PWR_Y+K.P2_BTN_H+K.SP_3,"power off = deep sleep, RESET to wake");
  footer(p);
}

// --- Messages ------------------------------------------------------------
// THE ROWS SAY WHAT THEY MEAN, not what they are called: "NEXT" alone is not a
// setting anybody can act on, "NEXT   after this turn" is. Three uiListRows
// rather than three segments, because each needs a phrase and a 96px segment
// cannot hold one - and three full-width rows with a gap between them make the
// hit boxes unmistakable.
function bMessages(p){
  tabBar(p); backBand(p,"Messages");
  cap(p,K.P4_CAP_Y,"HOW MY MESSAGES LAND");
  const rows=[["NOW    interrupt the turn",false],["NEXT   after this turn",true],
              ["LATER  after the queue",false]];
  rows.forEach(([lab,on],i)=>{
    const y=K.P4_ROW_Y+i*K.P4_ROW_STEP;
    p.round(K.CARD_X,y,K.CARD_W,K.H_ROW,K.R_MD,on?p.t.accent:p.t.card);
    if(!on) p.stroke(K.CARD_X,y,K.CARD_W,K.H_ROW,K.R_MD,K.BORDER_CTRL,p.t.label);
    p.text(lab,K.CARD_X+K.SP_3,y+K.H_ROW/2,{f:1,c:on?p.t.bg:p.t.value,datum:"ML"});
    // Selection is FILL plus the tag plus position, never colour alone.
    if(on) p.text("ON",K.CARD_X+K.CARD_W-K.SP_3,y+K.H_ROW/2,{f:1,c:p.t.bg,datum:"MR"});
  });
  // THE PRECEDENCE RULE, and it earns its line: DECKHAND_INBOX_PRIORITY on the Mac
  // overrides this, and without the line the failure is silent on a device with no
  // error channel.
  hint(p,K.P4_HINT_Y,"the Mac can override this");
  footer(p);
}

// --- Sound ---------------------------------------------------------------
// Output AND input, because a mic test IS a sound test - and it is the one action
// you run repeatedly (MIC_GAIN gets settled by watching MICMON). Moving it here
// is what left the destructive group holding only destructive verbs.
function bSound(p){
  tabBar(p); backBand(p,"Sound");
  const X=K.CARD_X,W=K.CARD_W;
  cap(p,K.PS_ALERTS_Y,"ALERTS");
  button(p,X,K.PS_SOUND_Y,W,K.H_ROW,"SOUND ON",p.t.accent,true);
  hint(p,K.PS_WHAT_HINT_Y,"beeps when a session needs input");
  // No bar under VOLUME, deliberately: only BRIGHTNESS gets one, because it is the
  // single continuous 0-100 setting and a bar under three named presets would be
  // decoration.
  stepper(p,K.PS_VOL_Y,"VOLUME","MED",null);
  button(p,X,K.PS_BEEP_Y,W,K.PS_BTN_H,"TEST BEEP",p.t.accent,false);
  cap(p,K.PS_MIC_CAP_Y,"MICROPHONE");
  button(p,X,K.PS_MIC_Y,W,K.PS_BTN_H,"MIC TEST",p.t.accent,false);
  footer(p);
}
// --- Display -------------------------------------------------------------
// VOLUME left for Sound, which freed 92px. It is NOT padding: THEME stops being a
// cramped third-width CYCLE button - it has three states, so it was never a
// toggle - and becomes three segments that show the whole choice at once.
function bDisplay(p){
  tabBar(p); backBand(p,"Display");
  const X=K.CARD_X,W=K.CARD_W;
  stepper(p,K.P1_BRIGHT_Y,"BRIGHTNESS","90%",0.9);
  stepper(p,K.P1_SLEEP_Y,"SLEEP AFTER","30s",null);
  cap(p,K.P1_THEME_CAP_Y,"THEME");
  ["DARK","LIGHT","AUTO"].forEach((lab,i)=>{
    const on = i===0;
    button(p, X+i*(K.P1_THEME_SEG_W+K.P1_THEME_GAP), K.P1_THEME_Y,
           K.P1_THEME_SEG_W, K.H_ROW, lab, on?p.t.accent:p.t.label, on);
  });
  // AUTO is a CLOCK, not a sensor: every ADC1 channel here is spoken for, so there
  // is no light to measure. Saying so is the same rule that stops the farewell
  // screen promising a touch wake this board does not have.
  hint(p,K.P1_AUTO_HINT_Y,"AUTO = light 07:00 to 19:00");
  // THE LABEL NAMES ITS SUBJECT - "NORMAL" alone said nothing about what was normal.
  button(p,X,K.P1_FLIP_Y,W,K.H_ROW,"SCREEN NORMAL",p.t.label,false);
  footer(p);
}

// --- Pairing -------------------------------------------------------------
// The live Mac rows moved here from the old page 0, where they were a second,
// differently-formatted copy of this list. What the list gained is the one thing
// it lacked: whether a remembered Mac is connected right now.
const MACS = [["air  a3f2","connected, 2s ago",true,true],
              ["studio  9c01","connected, 3s ago",true,false],
              ["mini  4b7e","last seen 2d ago",false,false],
              ["lab  0f19","last seen 9d ago",false,false]];
function bPairing(p,n){
  tabBar(p); backBand(p,"Pairing");
  const X=K.CARD_X,W=K.CARD_W;
  cap(p,K.P3_ANY_CAP_Y,"ANSWER PROMPTS FROM");
  const ay=K.P3_ANY_Y;
  // The ANY row keeps the component it always had: it is a CHOICE, not a Mac, so
  // it stays a uiListRow where the rows under it are cards.
  p.round(X,ay,W,K.H_ROW,K.R_MD,p.t.accent);
  p.text("ANY MAC",X+K.SP_3,ay+K.H_ROW/2,{f:1,c:p.t.bg,datum:"ML"});
  p.text("SELECTED",X+W-K.SP_3,ay+K.H_ROW/2,{f:1,c:p.t.bg,datum:"MR"});
  cap(p,K.P3_LIST_CAP_Y,"PAIRED MACS");
  MACS.slice(0,n).forEach(([name,sub,live,only],i)=>{
    const y=K.P3_LIST_Y+i*K.P3_ROW_STEP;
    // Selection is the card's BORDER plus the ONLY tag - two carriers, never hue
    // alone - and the card keeps COLOR_CARD because the row's second line and its
    // live dot were coloured against that surface.
    p.card(X,y,W,K.P3_ROW_H, only?p.t.accent:p.t.label);
    p.dot(X+K.PAD+K.P3_ROW_DOT_R,y+K.P3_ROW_NAME_DY+8,K.P3_ROW_DOT_R,live?p.t.good:p.t.label,live);
    p.text(name, X+K.PAD+K.P3_ROW_TEXT_DX, y+K.P3_ROW_NAME_DY, {f:1,c:p.t.value});
    p.text(sub,  X+K.PAD+K.P3_ROW_TEXT_DX, y+K.P3_ROW_SUB_DY, {f:1,c:live?p.t.good:p.t.label});
    if(only) p.text("ONLY", X+W-(K.P3_X_W+K.SP_2), y+K.P3_ROW_NAME_DY, {f:1,c:p.t.accent,datum:"TR"});
    // Drawn from the SAME constant that hit-tests it, so the glyph and its tap
    // target cannot drift apart.
    p.text("x", X+W-K.P3_X_W/2, y+K.P3_ROW_H/2, {f:3,c:p.t.bad,datum:"MC"});
  });
  // PAIR NEW MAC TAKES THE LIST'S NEXT FREE SLOT, and its ABSENCE at four Macs is
  // how this page says "full" - the same limit twice over, since the slot with no
  // room on the screen is also the slot with no room in NVS.
  if(n<MACS.length)
    button(p,X,K.P3_LIST_Y+n*K.P3_ROW_STEP,W,K.H_ROW,"PAIR NEW MAC",p.t.accent,false);
  footer(p);
}

// ===========================================================================
// THE SEVEN-GROUP DESIGN, replaced by the amendment of 2026-09-12
// Kept and marked rather than deleted. Only the three screens the amendment
// actually moved are drawn: Display, Sound and Pairing were identical in both,
// so a fourth and fifth picture would say nothing. Every constant below comes
// from WAS.G7_*, which check.mjs asserts is NOT what the header says today.
// ===========================================================================
const G7_HOME_ROWS = [
  ["Status",  "Both links up   78%   46 C", "good"],
  ["Display", "90%   sleep 30s   DARK",     null],
  ["Sound",   "ON   volume MED   mic",      null],
  ["Pairing", "2 Macs   any may answer",    null],
  ["Messages","send NEXT",                  null],
  ["About",   "Sep 12 2026",                null],
  ["Actions", "calibrate, pairing, power",  null],
];
function g7Home(p){
  tabBar(p);
  homeRows(p,G7_HOME_ROWS,WAS.G7_HOME_ROW_H,WAS.G7_HOME_GAP,WAS.G7_HOME_SUB_DY);
  footer(p);
}
function g7Status(p){
  tabBar(p); backBand(p,"Status");
  const X=K.CARD_X,W=K.CARD_W,x=X+K.PAD;
  const block=(y,h,capS,big,bigCol,l1,l2)=>{
    p.card(X,y,W,h);
    p.text(capS, x, y+WAS.G7_ST_CAP_DY, {f:1,c:p.t.label});
    p.text(big,  x, y+WAS.G7_ST_BIG_DY, {f:3,c:bigCol});
    if(l1) p.text(l1, x, y+WAS.G7_ST_L1_DY, {f:1,c:p.t.label});
    if(l2) p.text(l2, x, y+WAS.G7_ST_L2_DY, {f:1,c:p.t.label});
  };
  block(K.ST_CONN_Y,WAS.G7_ST_CONN_H,"CONNECTION","Both links up",p.t.good,
        "USB and Bluetooth, 2s ago","Deckhand-C114");
  block(WAS.G7_ST_PWR_Y,WAS.G7_ST_PWR_H,"POWER","78%  4.05V",p.t.good,
        "about 5h left on battery","SoC 46.6 C");
  const hy=WAS.G7_ST_HOST_Y;
  p.card(X,hy,W,WAS.G7_ST_HOST_H);
  p.text("HOST", x, hy+WAS.G7_ST_CAP_DY, {f:1,c:p.t.label});
  p.text("779 B per tick",  x, hy+WAS.G7_ST_HOST_R1_DY, {f:1,c:p.t.value});
  p.text("flush 1.1 ms",    x, hy+WAS.G7_ST_HOST_R2_DY, {f:1,c:p.t.value});
  p.text("up 4h 12m",  X+W-K.PAD, hy+WAS.G7_ST_HOST_R1_DY, {f:1,c:p.t.value,datum:"TR"});
  p.text("2 Macs",     X+W-K.PAD, hy+WAS.G7_ST_HOST_R2_DY, {f:1,c:p.t.value,datum:"TR"});
  footer(p);
}
function g7Actions(p){
  tabBar(p); backBand(p,"Actions");
  cap(p,WAS.G7_P2_SETUP_CAP_Y,"SETUP");
  button(p,K.CARD_X,WAS.G7_P2_CAL_Y,K.CARD_W,K.P2_BTN_H,"CALIBRATE TOUCH",p.t.accent,false);
  cap(p,WAS.G7_P2_DANGER_CAP_Y,"CANNOT BE UNDONE");
  severity(p,WAS.G7_P2_PAIR_Y,"RESET PAIRING",p.t.warn);
  severity(p,WAS.G7_P2_PWR_Y,"POWER OFF",p.t.bad);
  hint(p,WAS.G7_P2_HINT_Y,"power off = deep sleep, RESET to wake");
  footer(p);
}

// ===========================================================================
// driver
// ===========================================================================
const SCREENS = {
  // WHAT SHIPS: HOME and all six groups, plus the Macs page at its WORST CASE -
  // four slots filled, which is the only case the geometry has to survive and the
  // one where PAIR NEW MAC is correctly absent.
  now: [["HOME",homeScreen],["Device",bDevice],["Display",bDisplay],["Sound",bSound],
        ["Pairing",p=>bPairing(p,3)],["Messages",bMessages],["Danger",bDanger],
        ["Pairing - 4 Macs",p=>bPairing(p,4)]],
  // The seven-group design the amendment replaced; only the screens it moved.
  g7: [["HOME - 7 groups",g7Home],["Status",g7Status],["Actions",g7Actions]],
  // The pre-branch device: four pages behind a chevron pager.
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
