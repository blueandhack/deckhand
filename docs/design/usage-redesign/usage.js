// ---------------------------------------------------------------------------
// Board 2 USAGE tab v2 mock. Every glyph is the REAL Spleen bitmap, extracted
// from Spleen8x16.h / Spleen12x24.h / Spleen32x64.h (the headers the firmware
// links) by gfx-extract.mjs. Every geometry constant in K is the value parsed
// out of board_es3c35p.h - see check.mjs, which binds K to the header by name.
//
// Four layouts are drawn: the pre-branch baseline ("today", WAS) and three
// options that were compared before picking one - A (Subtract), B (Now / Week
// / Codex), C (Urgency ladder). B is what board_es3c35p.h actually derives;
// A and C are kept as the record of what was rejected and why (see LAYOUTS'
// own blurbs). Only B's and today's numbers are bound to the header - A and C
// draw their own unbound literals, because nothing in the header answers to
// them.
// ---------------------------------------------------------------------------

// THEMES[] from deckhand_display.ino, field order bg,card,label,value,accent,good,warn,bad,unknown
const RAW = {
  DARK:  [0x0000,0x18C4,0x8410,0xFFFF,0xFD20,0x0396,0xE4E0,0xCBD4,0x7BEF],
  LIGHT: [0xEF5C,0xFFFF,0x62CA,0x18C3,0xB240,0x12F4,0xB3A0,0x6887,0x8C30],
};
const CNAMES = ["bg","card","label","value","accent","good","warn","bad","unknown"];
const c565 = v => `rgb(${Math.round((v>>11&31)*255/31)},${Math.round((v>>5&63)*255/63)},${Math.round((v&31)*255/31)})`;
const TH = {}; for (const k in RAW) { TH[k] = {}; RAW[k].forEach((v,i) => TH[k][CNAMES[i]] = c565(v)); }

// ---------------------------------------------------------------------------
// K - every constant this mock shares with board_es3c35p.h, under the header's
// own name. check.mjs parses the header (through the geometry checkers' own
// consts()) and asserts every one of these against it, so the mock cannot
// drift from the header while still reporting itself trustworthy.
// ---------------------------------------------------------------------------
const K = {
  BOARD_W:320, BOARD_H:480, TAB_BAR_H:46, CONTENT_Y:46, FOOTER_H:20,
  CARD_X:12, CARD_W:296, PAD:18, BAR_H:12, R_MD:12, BORDER_CARD:2,
  TAB_REC_W:40, TAB_COUNT:3, SP_2:8,
  // v1, still live and still drawn by the "today" (WAS) baseline panel.
  CARD_H:164, CODEX_H:56, CARD1_Y:54, CARD2_Y:226, CODEX_Y:398,
  CARD_PIN_BAR_Y:3, CARD_LABEL_Y:6, CARD_HERO_Y:24, CARD_HERO_H:65,
  CARD_BAR_Y:95, CARD_STATS_Y:118, CARD_FOOT_Y:140,
  CODEX_TEXT_Y:8, CODEX_BAR_Y:37,
  MAC_EMOJI_SIZE:16, FOOTER_BATT_X:135, FOOTER_BATT_TEXT_X:160,
  // v2 (BOARD_USAGE_V2) - what layout B, the selected design, actually draws.
  BOARD_USAGE_V2:1, NOW_CARD_H:182, WEEK_CARD_H:144,
  NOW_HERO_Y:26, NOW_BAR_Y:99, NOW_SPARK_Y:120, NOW_SPARK_H:32, NOW_META_Y:158,
  WEEK_NUM_Y:26, WEEK_BURN_Y:30, WEEK_BAR_Y:58, WEEK_META_Y:78,
  WEEK_FABLE_Y:99, WEEK_FABLE_BAR_Y:123,
  CARD_HERO_W:132,
  // Task 1 dropped the wall-clock suffix from the Codex row and shrank the pad
  // width alongside it - 12/20 was the pre-fix state, kept in WAS below as the
  // "today" panel's own numbers.
  CODEX_LANE_CHARS:14, CODEX_RIGHT_CHARS:18,
};
// contentBottom()/CONTENT_ROWS/the LANE_* triple are DERIVED, not declared -
// there is no such name in the header - so check.mjs asserts the identity
// rather than the number, the same treatment it gives contentBottom.
K.contentBottom  = K.BOARD_H - K.FOOTER_H;              // 460
K.CONTENT_ROWS   = K.contentBottom - K.CONTENT_Y;       // 414
K.LANE_X0        = K.CARD_X + K.PAD;                    // 30
K.LANE_X1        = K.CARD_X + K.CARD_W - K.PAD;         // 290
K.LANE_W         = K.LANE_X1 - K.LANE_X0;               // 260
// SIDE_X0/SIDE_CHARS ARE declared in the header, but as a derivation from
// CARD_HERO_W/PAD/TEXT_ADV - reproduced here the same way so a change to
// CARD_HERO_W moves both, and check.mjs still binds the RESULT by name.
K.SIDE_X0    = K.LANE_X0 + K.CARD_HERO_W + 8;           // 170
K.SIDE_CHARS = Math.floor((K.LANE_X1 - K.SIDE_X0) / 8); // 15

// ---------------------------------------------------------------------------
// WAS - the constants of the page THIS branch replaced, kept because the
// "today" panel is a before picture and has to keep drawing it. Deliberately
// OUT of K and therefore out of check.mjs's header bind: a before picture
// that tracked the header would stop being a before picture the moment the
// header moved. check.mjs asserts every entry here actually DIFFERS from
// what ships - a value equal to K's (or to the header's) records nothing and
// is how a live constant would escape the bind.
// ---------------------------------------------------------------------------
const WAS = {
  CODEX_LANE_CHARS:12, CODEX_RIGHT_CHARS:20,
};

// font ids as the sketch uses them: T_META 1, T_BODY 2, T_HEAD 3, T_HERO 8
const FID = { 1:"Spleen8x16", 2:"Spleen8x16", 3:"Spleen12x24", 8:"Spleen32x64" };
const face = f => SPLEEN_FONTS[FID[f]];
const adv  = f => face(f).w, cell = f => face(f).h;
const tw   = (s,f) => String(s).length * adv(f);

// ---------------------------------------------------------------------------
// formatters, transcribed from usage.ino
// ---------------------------------------------------------------------------
const fmtTokens = t => t>=1e6 ? `${(t/1e6).toFixed(2)}M tok` : t>=1e3 ? `${(t/1e3).toFixed(1)}K tok` : `${t} tok`;
const fmtResetIn = m => m<0 ? "no data yet" : m>=1440 ? `${(m/1440)|0}d ${((m/60)|0)%24}h left`
  : m>=60 ? `${(m/60)|0}h ${m%60}m left` : `${m}m left`;
const fmtDur = m => m>=1440 ? `${(m/1440)|0}d ${((m/60)|0)%24}h` : m>=60 ? `${(m/60)|0}h ${m%60}m` : `${m}m`;
const at = (now,m) => { const s=(now+m*60)%86400; return `${String((s/3600)|0).padStart(2,"0")}:${String(((s/60)|0)%60).padStart(2,"0")}`; };

// ---------------------------------------------------------------------------
// BURN RATE. Two estimators, picked by window length rather than preference -
// see docs/design/usage-redesign/README.md for the derivation. Transcribed
// unchanged from the published exploration.
// ---------------------------------------------------------------------------
const BURN_MIN_PCT = 3, BURN_MAX_PCT = 97;
const OAUTH_POLL_MIN = 5;
const BURN_MIN_ELAPSED = OAUTH_POLL_MIN;
const BURN_RING_MIN_SPAN = 30, BURN_RING_MIN_RISE = 3;
const BURN_RING_MAX_WIN = 2880;
const GATED = { txt:"burn --", gated:true };
function burnAvg(pct,resetMin,winMin) {
  if (pct<0||resetMin<0||winMin<=0) return GATED;
  const elapsed = winMin-resetMin;
  if (elapsed<BURN_MIN_ELAPSED||pct<BURN_MIN_PCT) return GATED;
  if (pct>BURN_MAX_PCT) return { txt:"empty now", urgent:true };
  const left = Math.round((100-pct)/(pct/elapsed));
  return left<resetMin ? { txt:`empty ~${fmtDur(left)}`, min:left, urgent:true }
                        : { txt:"resets first", min:left, urgent:false };
}
function burnRing(series,pct,resetMin) {
  if (!series||pct<0||resetMin<0) return GATED;
  const n = series.length; let sx=0,sy=0,sxx=0,sxy=0;
  for (let i=0;i<n;i++) { const x=i*RING_STEP_MIN,y=series[i]; sx+=x; sy+=y; sxx+=x*x; sxy+=x*y; }
  const den = n*sxx-sx*sx; if (!den) return GATED;
  const slope = (n*sxy-sx*sy)/den;
  const rise = series[n-1]-series[0];
  if (RING_SPAN_MIN<BURN_RING_MIN_SPAN||rise<BURN_RING_MIN_RISE||slope<=0) return GATED;
  if (pct>BURN_MAX_PCT) return { txt:"empty now", urgent:true };
  const left = Math.round((100-pct)/slope);
  return left<resetMin ? { txt:`empty ~${fmtDur(left)}`, min:left, urgent:true }
                        : { txt:"resets first", min:left, urgent:false };
}
function burnFor(pct,resetMin,winMin,series,stale) {
  if (stale) return GATED;
  return (winMin>0&&winMin<=BURN_RING_MAX_WIN&&series) ? burnRing(series,pct,resetMin) : burnAvg(pct,resetMin,winMin);
}
const pctCol = (t,p) => p<0 ? t.unknown : p>=90 ? t.bad : p>=70 ? t.warn : t.good;

// 16x16 stand-in for MacEmoji16.h's "wave". Generated, not transcribed - see
// README.md for what this does and does not vouch for.
const ICON = (() => { const r=[]; for (let y=0;y<16;y++) { let v=0; for (let x=0;x<16;x++) {
  const a=8+Math.round(2.6*Math.sin((x/16)*Math.PI*2)), b=13+Math.round(2.0*Math.sin((x/16)*Math.PI*2+1));
  v = v*2 + ((y===a||y===a+1||y===b)?1:0); } r.push(v); } return r; })();

// 32-bit rows exceed the range of |0/>>>, so bit extraction divides rather
// than shifts (used by the hero glyph decode, at draw time AND at paint time).
const TWO = Array.from({length:33}, (_,i) => Math.pow(2,i));

// ---------------------------------------------------------------------------
// The painter. Builds TWO things per call: a compact op list (`ops`, painted
// only by the browser) and field/card METADATA (`fields`/`cards`, built by
// `_reg()`), which is what check.mjs's picture assertions actually read - the
// same data the in-browser checker already used, so running headlessly is not
// a second implementation of the checks, only a second place to run them.
// `_f()` never touches a canvas: it pushes an op. `paint(ctx)` is the replay,
// called only by the browser - the same seam settings.js already has.
// ---------------------------------------------------------------------------
class P {
  constructor(theme) { this.t = TH[theme]; this.ops = []; this.fields = []; this.cards = []; this.cur = null; }
  _f(x,y,w,h,col) { if (w<=0||h<=0) return; this.ops.push(["r",x,y,w,h,col]); }
  fill(col) { this._f(0,0,K.BOARD_W,K.BOARD_H,col); }
  rect(x,y,w,h,col) { this._f(x,y,w,h,col); }
  round(x,y,w,h,r,col) { this.ops.push(["rr",x,y,w,h,r,col]); }
  strokeRound(x,y,w,h,r,t,col) { this.ops.push(["rs",x,y,w,h,r,t,col]); }
  hline(x,y,w,col) { this._f(x,y,w,1,col); }
  // a card, and everything drawn after it attaches to it for the checks
  card(name,y,h,border) {
    this.round(K.CARD_X,y,K.CARD_W,h,K.R_MD,this.t.card);
    this.strokeRound(K.CARD_X,y,K.CARD_W,h,K.R_MD,K.BORDER_CARD,border||this.t.label);
    this.cur = { name,y,h,fields:[] }; this.cards.push(this.cur); return this.cur;
  }
  _reg(kind,txt,x,y,w,h,lane,inks,always) {
    const f = { kind,txt,x,y,w,h,lane, always:!!always, inks:inks||[{x,y,w,h}],
                chrome:!!this.chromeMode, card:this.cur };
    this.fields.push(f); if (this.cur) this.cur.fields.push(f); return f;
  }
  // datum: "TL" (y = cell top) | "TR" (x = right edge) | "MC" (centre; TFT_eSPI
  // centres on the ascent, so the box top is cy - 3h/8)
  text(s,x,y,fid,fg,bg,datum="TL",clear="ifchanged",lane=null) {
    s = String(s); const w = tw(s,fid), ch = cell(fid);
    let x0 = datum==="TR" ? x-w : x, y0 = datum==="MC" ? Math.round(y-3*ch/8) : y;
    if (datum==="MC") x0 = Math.round(x-w/2);
    const bx = clear==="ifchanged" ? x0-1 : x0, by = clear==="ifchanged" ? y0-1 : y0;
    const bw = clear==="ifchanged" ? w+2 : w,  bh = clear==="ifchanged" ? ch+2 : ch;
    if (bg) this._f(bx,by,bw,bh,bg);
    const inks = [];
    for (let i=0;i<s.length;i++) {
      // INK is per glyph, not per string: the Codex row deliberately draws its
      // Mac icon into a run of reserved SPACES inside the label, so an extent-
      // based model would report that as a collision and an interior gap as
      // safe. A space carries no ink and cannot be erased.
      if (s[i]!==" ") inks.push({ x:x0+i*adv(fid), y:y0, w:face(fid).w, h:ch });
    }
    this.ops.push(["t",s,x0,y0,fid,fg]);
    return this._reg("text",s,bx,by,bw,bh,lane,inks);
  }
  // drawBigNumber: clears exactly the box it is handed, then draws.
  hero(s,x,y,w,h,fg,bg) {
    this._f(x,y,w,h,bg);
    this.ops.push(["hero",s,x,y,h,fg]);
    const F = SPLEEN_FONTS.Spleen32x64, yy = y + Math.round((h-F.h)/2);
    return this._reg("hero",s,x,y,w,h,w,[{x,y:yy,w:s.length*F.w,h:F.h}]);
  }
  // drawPaceBar: clears (x-1, y-4, w+2, h+8) to cover the tick's overhang.
  paceBar(x,y,w,h,pct,tick,fg) {
    this._f(x-1,y-4,w+2,h+8,this.t.card);
    this.ops.push(["bar",x,y,w,h,pct,tick,fg]);
    // the tick can land anywhere along the bar, so the whole span counts as ink
    return this._reg("bar","",x-1,y-4,w+2,h+8,w,[{x,y:y-4,w,h:h+8}]);
  }
  // PROPOSED, layout B and C only: a 30-sample trend. Needs new device state.
  spark(x,y,w,h,series,fg) {
    this._f(x-1,y-1,w+2,h+2,this.t.card);
    this.ops.push(["spark",x,y,w,h,series,fg]);
    return this._reg("spark","",x-1,y-1,w+2,h+2,w,[{x,y,w,h}]);
  }
  icon(x,y,bg) {
    this._f(x,y,16,16,bg);
    this.ops.push(["icon",x,y]);
    return this._reg("icon","",x,y,16,16,16,null,true);
  }
  // ---- browser-only replay. check.mjs never calls this - it runs against
  // `fields`/`cards` above, which never touched a canvas in the first place.
  paint(ctx) {
    const path = (x,y,w,h,r) => { ctx.beginPath(); ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r);
      ctx.arcTo(x+w,y+h,x,y+h,r); ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath(); };
    const glyphs = (s,x0,y0,fid,col) => {
      const F = face(fid), gw = F.w; ctx.fillStyle = col;
      for (let i=0;i<s.length;i++) {
        const rows = F.glyphs[s.codePointAt(i)]; if (!rows) continue;
        const gx = x0+i*gw;
        for (let ry=0;ry<rows.length;ry++) {
          const v = rows[ry]; if (!v) continue; let run=0;
          for (let bx=0;bx<gw;bx++) {
            const on = gw<=16 ? (v>>>(gw-1-bx))&1 : Math.floor(v/TWO[gw-1-bx])%2;
            if (on) run++; else if (run) { ctx.fillRect(gx+bx-run,y0+ry,run,1); run=0; }
          }
          if (run) ctx.fillRect(gx+gw-run,y0+ry,run,1);
        }
      }
    };
    for (const o of this.ops) {
      const k = o[0];
      if (k==="r") { ctx.fillStyle=o[5]; ctx.fillRect(o[1],o[2],o[3],o[4]); }
      else if (k==="rr") { const [,x,y,w,h,r,col]=o; path(x,y,w,h,r); ctx.fillStyle=col; ctx.fill(); }
      else if (k==="rs") { const [,x,y,w,h,r,t,col]=o; path(x+t/2,y+t/2,w-t,h-t,Math.max(0,r-t/2));
        ctx.lineWidth=t; ctx.strokeStyle=col; ctx.stroke(); }
      else if (k==="t") glyphs(o[1],o[2],o[3],o[4],o[5]);
      else if (k==="hero") { const [,s,x,y,h,fg]=o; const F=SPLEEN_FONTS.Spleen32x64;
        glyphs(s,x,y+Math.round((h-F.h)/2),8,fg); }
      else if (k==="bar") { const [,x,y,w,h,pct,tick,fg]=o, t=this.t;
        path(x,y,w,h,h/2); ctx.fillStyle=t.bg; ctx.fill();
        const cl=pct<0?0:Math.min(100,pct), filled=Math.round(w*cl/100);
        if (filled>=h) { path(x,y,filled,h,h/2); ctx.fillStyle=fg; ctx.fill(); }
        else if (filled>0) { ctx.beginPath(); ctx.arc(x+h/2,y+h/2,h/2,0,7); ctx.fillStyle=fg; ctx.fill(); }
        if (tick>=0) { const tx=x+Math.round((w-3)*Math.min(100,tick)/100); ctx.fillStyle=t.value; ctx.fillRect(tx,y-4,3,h+8); } }
      else if (k==="spark") { const [,x,y,w,h,series,fg]=o, t=this.t;
        const n=series.length, cw=Math.floor(w/n);
        ctx.fillStyle=t.label; ctx.fillRect(x,y+h-1,cw*n,1);
        const cyOf = v => y+h-3-Math.round((h-5)*Math.max(0,Math.min(100,v))/100);
        let prev=null;
        for (let i=0;i<n;i++) { const cy=cyOf(series[i]), last=i===n-1;
          if (prev!==null&&prev!==cy) { const a0=Math.min(prev,cy),a1=Math.max(prev,cy);
            ctx.fillStyle=fg; ctx.fillRect(x+i*cw-1,a0,2,a1-a0+2); }
          ctx.fillStyle = last?t.value:fg; ctx.fillRect(x+i*cw,cy,cw-1,last?4:2); prev=cy; } }
      else if (k==="icon") { const [,x,y]=o; ctx.fillStyle=this.t.value;
        for (let ry=0;ry<16;ry++) { const v=ICON[ry]; if (!v) continue;
          for (let bx=0;bx<16;bx++) if ((v>>>(15-bx))&1) ctx.fillRect(x+bx,y+ry,1,1); } }
      else if (k==="box") { ctx.strokeStyle="rgba(255,64,129,.85)"; ctx.lineWidth=1;
        ctx.strokeRect(o[1]+.5,o[2]+.5,o[3]-1,o[4]-1); }
    }
  }
}

// ---------------------------------------------------------------------------
// States. A layout that only works at 47% is not a layout, so every option is
// drawn under all six.
// ---------------------------------------------------------------------------
const NOW = 14*3600+18*60+7;
const RING_SLOTS = 31, RING_STEP_MIN = 5;         // span = (31-1)*5 = exactly 150 min
const RING_SPAN_MIN = (RING_SLOTS-1)*RING_STEP_MIN;
const mkSpark = p => { if (p<0) return null;
  const n = RING_SLOTS, a = [];
  for (let i=0;i<n;i++) { const base = p*0.55+(p*0.45)*(i/(n-1));
    a.push(Math.max(0,Math.round(base+1.6*Math.sin(i*1.7)+0.9*Math.sin(i*0.6)))); }
  a[n-1] = p; return a; };
const STATES = {
  nominal:{lbl:"nominal",fh:72,fhR:134,fhT:1.20e6,sd:61,sdR:7680,sdT:31.9e6,fbP:61,fbT:30.1e6,
    cx:44,cxR:4460,cxW:10080,age:5,cxAge:40,macs:1,icon:true,tag:"studio",bat:63,fresh:"5s ago"},
  critical:{lbl:"critical",fh:97,fhR:12,fhT:2.44e6,sd:100,sdR:5240,sdT:52.6e6,fbP:100,fbT:41.8e6,
    cx:96,cxR:900,cxW:10080,age:8,cxAge:60,macs:1,icon:true,tag:"studio",bat:9,fresh:"3s ago"},
  stale:{lbl:"stale",fh:72,fhR:134,fhT:1.20e6,sd:61,sdR:7680,sdT:31.9e6,fbP:61,fbT:30.1e6,
    cx:44,cxR:4460,cxW:10080,age:11400,cxAge:14000,macs:1,icon:true,tag:"studio",bat:41,fresh:"stale 190s"},
  empty:{lbl:"no data",fh:-1,fhR:-1,fhT:0,sd:-1,sdR:-1,sdT:0,fbP:-1,fbT:0,
    cx:-1,cxR:-1,cxW:-1,age:-1,cxAge:-1,macs:1,icon:false,tag:"",bat:63,fresh:"no data"},
  // padLeftTo() returns early when the string is already longer than the pad
  // width - it never truncates - so the Codex right field is not bounded by
  // CODEX_RIGHT_CHARS at all. This is the state that reaches the real worst
  // case the header's own comment names, "100%  23h 59m left" at 18 chars.
  cxworst:{lbl:"Codex worst case",fh:72,fhR:134,fhT:1.20e6,sd:61,sdR:7680,sdT:31.9e6,fbP:61,fbT:30.1e6,
    cx:100,cxR:1439,cxW:10080,age:5,cxAge:40,macs:1,icon:false,tag:"",bat:63,fresh:"5s ago"},
  twomacs:{lbl:"two Macs",fh:72,fhR:134,fhT:1.20e6,sd:61,sdR:7680,sdT:31.9e6,fbP:61,fbT:30.1e6,
    cx:44,cxR:4460,cxW:10080,age:5,cxAge:40,macs:2,icon:false,tag:"studio",bat:63,fresh:"5s ago"},
};
const isStale = d => d.age>900, isCxStale = d => d.cxAge>900;
const heroTxt = p => p<0 ? "--" : `${p}%`;
const staleTxt = d => { const m=(d.age/60)|0; return m<60 ? `stale ${m}m` : `stale ${(m/60)|0}h`; };

// ---------------------------------------------------------------------------
// Chrome: the tab bar and footer, so every panel below is honest edge to edge.
// ---------------------------------------------------------------------------
function chrome(p,d) {
  const t = p.t; p.fill(t.bg); p.chromeMode = true;
  p.rect(0,0,K.BOARD_W,K.TAB_BAR_H,t.card);
  const tabsW = K.BOARD_W-K.TAB_REC_W, tabW = Math.floor(tabsW/K.TAB_COUNT);
  ["USAGE","SESSIONS","SETTINGS"].forEach((L,i) => {
    p.text(L,i*tabW+Math.floor(tabW/2),Math.floor(K.TAB_BAR_H/2),1,i===0?t.value:t.label,t.card,"MC","string");
    if (i===0) p.rect(i*tabW+8,K.TAB_BAR_H-3,tabW-16,3,t.accent);
  });
  const rx = tabsW+Math.floor((K.TAB_REC_W-27)/2), cy = Math.floor(K.TAB_BAR_H/2);
  p.ops.push(["r",rx,cy-3,6,6,t.label]); // record dot, approximated as a small square - cosmetic only
  p.text("REC",rx+9,cy-8,1,t.label,null,"TL","string");
  // footer
  p.hline(0,K.contentBottom,K.BOARD_W,t.label);
  p.rect(0,K.contentBottom+1,K.BOARD_W,K.FOOTER_H-1,t.bg);
  const fy = K.contentBottom+4;
  p.text(`${String((NOW/3600)|0).padStart(2,"0")}:${String(((NOW/60)|0)%60).padStart(2,"0")}:${String(NOW%60).padStart(2,"0")}`,
    10,fy,1,t.label,t.bg);
  const bc = d.bat<=10?t.bad:d.bat<=30?t.warn:t.good;
  p.rect(K.FOOTER_BATT_X,fy,21,9,t.bg);
  p.rect(K.FOOTER_BATT_X,fy,18,1,bc); p.rect(K.FOOTER_BATT_X,fy+8,18,1,bc);
  p.rect(K.FOOTER_BATT_X,fy,1,9,bc);  p.rect(K.FOOTER_BATT_X+17,fy,1,9,bc);
  p.rect(K.FOOTER_BATT_X+18,fy+2,2,5,bc);
  p.rect(K.FOOTER_BATT_X+2,fy+2,Math.round(14*d.bat/100),5,bc);
  p.text(`${d.bat}%`,K.FOOTER_BATT_TEXT_X,fy,1,bc,t.bg);
  p.text(d.fresh,K.BOARD_W-10,fy,1,d.fresh.startsWith("stale")||d.fresh==="no data"?t.bad:t.label,t.bg,"TR");
  p.chromeMode = false;
}
// label row shared by every card: caption left, Mac icon or tag right
function capRow(p,y,label,d,src=true) {
  const t = p.t;
  p.text(label,K.LANE_X0,y+K.CARD_LABEL_Y,1,t.label,t.card,"TL","string",K.LANE_W);
  if (!src) return;
  if (d.icon) p.icon(K.LANE_X1-K.MAC_EMOJI_SIZE,y+K.CARD_LABEL_Y,t.card);
  else if (d.tag && d.macs>1) p.text(d.tag,K.LANE_X1,y+K.CARD_LABEL_Y,1,t.label,t.card,"TR","string");
}
// the reclaimed space: a narrow hero box plus right-aligned fact lines
function heroSide(p,y,heroY,pct,lines,stale) {
  const t = p.t;
  p.hero(heroTxt(pct),K.LANE_X0,y+heroY,K.CARD_HERO_W,K.CARD_HERO_H,stale?t.label:t.value,t.card);
  const n = lines.length, blk = n*16+(n-1)*6, y0 = y+heroY+Math.round((K.CARD_HERO_H-blk)/2);
  lines.forEach((L,i) => { p.text(L.s,K.LANE_X1,y0+i*22,1,L.c||t.label,t.card,"TR","ifchanged",K.SIDE_CHARS*8); });
}
// ONE builder for the Codex label, used by the baseline AND by the fix, so the
// only thing that differs between them is the RIGHT field's length - which is
// what the label lane is bounded by. Transcribed from renderCodexRow.
function codexLabel(d) {
  const showTag = !!(d.tag && d.macs>1 && !d.icon);
  const dd = d.cxW>0 ? ((d.cxW/1440)|0) : 0;
  const lab = d.icon   ? (d.cxW>0?`CX    ${dd}d`:"CX")
            : showTag  ? `CX ${d.tag}`
            : d.cxW>0  ? `CODEX  ${dd}d` : "CODEX";
  return { lab, showTag };
}
const padR = (s,n) => s.length>=n ? s : s+" ".repeat(n-s.length);
const padL = (s,n) => s.length>=n ? s : " ".repeat(n-s.length)+s;
const tickOf = (r,w) => (r>=0&&w>0) ? 100-Math.trunc(r*100/w) : -1;

// ===========================================================================
// TODAY (WAS) - the before picture, drawn from what shipped pre-branch. Uses
// WAS.CODEX_LANE_CHARS/CODEX_RIGHT_CHARS deliberately, NOT K's - this panel
// exists to keep showing the stale numbers Task 1 fixed, not to track them.
// ===========================================================================
function drawToday(p,d) {
  const t = p.t, st = isStale(d);
  const card = (y,label,pct,tok,resetR,win,fable) => {
    const col = pctCol(t,pct);
    p.card(label,y,K.CARD_H,col);
    capRow(p,y,label,d);
    // THE DEFECT: the hero is handed the whole 260px lane, so it erases
    // everything beside it on every repaint. 132 of those px are never inked.
    p.hero(heroTxt(pct),K.LANE_X0,y+K.CARD_HERO_Y,K.LANE_W,K.CARD_HERO_H,st?t.label:t.value,t.card);
    p.paceBar(K.LANE_X0,y+K.CARD_BAR_Y,K.LANE_W,K.BAR_H,pct,tickOf(resetR,win),col);
    p.text(padR(tok>0?fmtTokens(tok):"",12),K.LANE_X0,y+K.CARD_STATS_Y,2,t.label,t.card,"TL","ifchanged",K.LANE_W);
    // padTo (RIGHT pad) with TR_DATUM - so this field is inset by (16-len)*8px
    // and its apparent position MOVES with its content. Reproduced faithfully.
    p.text(padR(resetR<0&&pct>=0?"starts on use":fmtResetIn(resetR),16),
      K.LANE_X1,y+K.CARD_STATS_Y,2,t.label,t.card,"TR","ifchanged",K.LANE_W);
    if (fable) p.text(padR(fable,18),K.LANE_X0,y+K.CARD_FOOT_Y,1,t.label,t.card,"TL","ifchanged",K.LANE_W);
    p.text(padL(st?staleTxt(d):(resetR>=0?`at ${at(NOW,resetR)}`:""),10),
      K.LANE_X1,y+K.CARD_FOOT_Y,1,st?t.bad:t.label,t.card,"TR","ifchanged",K.LANE_W);
  };
  card(K.CARD1_Y,"SESSION - 5 HOUR WINDOW",d.fh,d.fhT,d.fhR,300,null);
  const fb = d.fbP>=0&&d.fbT>=1e6 ? `Fable: ${d.fbP}% ${(d.fbT/1e6).toFixed(1)}M` : d.fbP>=0 ? `Fable: ${d.fbP}%` : "";
  card(K.CARD2_Y,"WEEK - 7 DAY, ALL MODELS",d.sd,d.sdT,d.sdR,10080,fb);
  // Codex: one line, and the STALE 12-character label ceiling (WAS, not K).
  const cs = isCxStale(d), have = d.cx>=0, col = have ? pctCol(t,d.cx) : t.unknown;
  p.card("codex",K.CODEX_Y,K.CODEX_H,col);
  const { lab, showTag } = codexLabel(d);
  let right = !have ? "--" : d.cxR>=0 ? (showTag ? `${d.cx}%  ${fmtResetIn(d.cxR)}`
              : `${d.cx}%  ${fmtResetIn(d.cxR)}  ${at(NOW,d.cxR)}`) : `${d.cx}%`;
  right = padL(right,WAS.CODEX_RIGHT_CHARS);
  // DRAW ORDER MATTERS AND IS THE FIRMWARE'S: renderCodexRow draws the label in
  // full, then the right field, whose clear box erases whatever the label left
  // under it. So the ceiling is derived from where the right field's clear box
  // actually starts - which depends on CONTENT, not on CODEX_RIGHT_CHARS.
  const rightX = K.LANE_X1-right.length*8;
  const laneCeil = Math.floor((rightX-1-K.LANE_X0)/8);
  p.text(padR(lab,WAS.CODEX_LANE_CHARS),K.LANE_X0,K.CODEX_Y+K.CODEX_TEXT_Y,2,t.label,t.card,"TL","ifchanged",K.LANE_W);
  if (d.icon) p.icon(K.LANE_X0+tw("CX",2)+4,K.CODEX_Y+K.CODEX_TEXT_Y,t.card);
  p.text(right,K.LANE_X1,K.CODEX_Y+K.CODEX_TEXT_Y,2,cs?t.label:(have?t.value:t.label),t.card,"TR","ifchanged",K.LANE_W);
  p.laneCeil = laneCeil; p.laneNeed = lab.length;
  p.paceBar(K.LANE_X0,K.CODEX_Y+K.CODEX_BAR_Y,K.LANE_W,K.BAR_H,have?d.cx:0,
    (have&&d.cxR>=0&&d.cxW>0)?tickOf(d.cxR,d.cxW):-1,cs?t.label:col);
}

// ---------------------------------------------------------------------------
// Shared by A / B / C: a Codex row whose right field is SHORT (the "big"
// two-line variant used by A, and the fixed one-line variant used by B - both
// drop the wall-clock suffix, which is the whole fix: the countdown beside it
// already says the same thing in relative terms).
// ---------------------------------------------------------------------------
function codexRow(p,d,y,h,big) {
  const t = p.t, cs = isCxStale(d), have = d.cx>=0, col = have ? pctCol(t,d.cx) : t.unknown;
  p.card("codex",y,h,col);
  if (big) capRow(p,y,d.cxW>0?`CODEX - ${(d.cxW/1440)|0} DAY WINDOW`:"CODEX",d);
  if (big) {
    p.text(have?`${d.cx}%`:"--",K.LANE_X0,y+26,3,cs?t.label:t.value,t.card,"TL","ifchanged",K.LANE_W);
    p.text(padL(have?fmtResetIn(d.cxR):"no data yet",16),K.LANE_X1,y+30,1,t.label,t.card,"TR","ifchanged",K.SIDE_CHARS*8+40);
    p.paceBar(K.LANE_X0,y+58,K.LANE_W,K.BAR_H,have?d.cx:0,(have&&d.cxR>=0&&d.cxW>0)?tickOf(d.cxR,d.cxW):-1,cs?t.label:col);
  } else {
    const { lab:lab2, showTag:st2 } = codexLabel(d);
    const right = padL(have?(d.cxR>=0?`${d.cx}%  ${fmtResetIn(d.cxR)}`:`${d.cx}%`):"--",15);
    const rightX = K.LANE_X1-right.length*8;
    p.laneCeil = Math.floor((rightX-1-K.LANE_X0)/8);
    p.laneNeed = lab2.length;
    p.text(padR(lab2,K.CODEX_LANE_CHARS),K.LANE_X0,y+K.CODEX_TEXT_Y,2,t.label,t.card,"TL","ifchanged",K.LANE_W);
    if (d.icon) p.icon(K.LANE_X0+tw("CX",2)+4,y+K.CODEX_TEXT_Y,t.card);
    p.text(right,K.LANE_X1,y+K.CODEX_TEXT_Y,2,cs?t.label:(have?t.value:t.label),t.card,"TR","ifchanged",K.LANE_W);
    p.paceBar(K.LANE_X0,y+K.CODEX_BAR_Y,K.LANE_W,K.BAR_H,have?d.cx:0,(have&&d.cxR>=0&&d.cxW>0)?tickOf(d.cxR,d.cxW):-1,cs?t.label:col);
  }
}

// ---------------------------------------------------------------------------
// A - SUBTRACT. Same three-block stack, one meta row folded away, and the
// 132px beside each hero put to work. No new device state at all. NOT what
// the header derives (B was picked) - unbound, illustrative only.
// ---------------------------------------------------------------------------
function drawA(p,d) {
  const t = p.t, st = isStale(d);
  let col = pctCol(t,d.fh);
  p.card("5h",54,140,col);
  capRow(p,54,"SESSION - 5 HOUR",d);
  heroSide(p,54,K.CARD_HERO_Y,d.fh,[
    { s:padL(burnAvg(d.fh,d.fhR,300).txt,15), c:burnAvg(d.fh,d.fhR,300).urgent?t.warn:t.label },
    { s:padL(d.fhR>=0?fmtResetIn(d.fhR):"no data yet",15) }],st);
  p.paceBar(K.LANE_X0,54+K.CARD_BAR_Y,K.LANE_W,K.BAR_H,d.fh,tickOf(d.fhR,300),col);
  p.text(padR(d.fhT>0?fmtTokens(d.fhT):"",12),K.LANE_X0,54+K.CARD_STATS_Y,2,t.label,t.card,"TL","ifchanged",K.LANE_W);
  p.text(padL(st?staleTxt(d):(d.fhR>=0?`at ${at(NOW,d.fhR)}`:""),10),
    K.LANE_X1,54+K.CARD_STATS_Y,1,st?t.bad:t.label,t.card,"TR","ifchanged",K.LANE_W);
  col = pctCol(t,d.sd);
  p.card("7d",202,164,col);
  capRow(p,202,"WEEK - 7 DAY, ALL MODELS",d);
  heroSide(p,202,K.CARD_HERO_Y,d.sd,[
    { s:padL(burnAvg(d.sd,d.sdR,10080).txt,15), c:burnAvg(d.sd,d.sdR,10080).urgent?t.warn:t.label },
    { s:padL(d.sdR>=0?fmtResetIn(d.sdR):"no data yet",15) }],st);
  p.paceBar(K.LANE_X0,202+K.CARD_BAR_Y,K.LANE_W,K.BAR_H,d.sd,tickOf(d.sdR,10080),col);
  p.text(padR(d.sdT>0?fmtTokens(d.sdT):"",12),K.LANE_X0,202+K.CARD_STATS_Y,2,t.label,t.card,"TL","ifchanged",K.LANE_W);
  p.text(padL(d.fbP>=0?`FABLE  ${d.fbP}%  ${d.fbT>=1e6?(d.fbT/1e6).toFixed(1)+"M":"--"}`:"FABLE  --",17),
    K.LANE_X1,202+K.CARD_STATS_Y,2,t.label,t.card,"TR","ifchanged",K.LANE_W);
  p.paceBar(K.LANE_X0,202+140,K.LANE_W,K.BAR_H,d.fbP<0?0:d.fbP,tickOf(d.sdR,10080),d.fbP<0?t.unknown:pctCol(t,d.fbP));
  codexRow(p,d,374,78,true);
}
// ---------------------------------------------------------------------------
// B - NOW / WEEK / CODEX. THE SELECTED DESIGN - board_es3c35p.h derives this
// one. A semantic hierarchy: the 5-hour window is the one that actually stops
// you working, so it alone keeps the 64px hero and gains the sparkline; the
// week collapses to a 24px number carrying Fable's bar in the same card.
// ---------------------------------------------------------------------------
function leadCard(p,d,y,h,label,pct,resetR,win,tok,st) {
  const t = p.t, col = pctCol(t,pct), sp = mkSpark(pct);
  const b = burnFor(pct,resetR,win,sp,st);
  p.card("lead",y,h,col);
  capRow(p,y,label,d);
  heroSide(p,y,K.NOW_HERO_Y,pct,[
    { s:padL(b.txt,15), c:b.urgent?(pct>=90?t.bad:t.warn):t.label },
    { s:padL(resetR>=0?fmtResetIn(resetR):"no data yet",15) }],st);
  p.paceBar(K.LANE_X0,y+K.NOW_BAR_Y,K.LANE_W,K.BAR_H,pct,tickOf(resetR,win),col);
  if (sp) p.spark(K.LANE_X0,y+K.NOW_SPARK_Y,K.LANE_W,K.NOW_SPARK_H,sp,st?t.label:col);
  else { p.rect(K.LANE_X0-1,y+K.NOW_SPARK_Y-1,K.LANE_W+2,K.NOW_SPARK_H+2,t.card); p.hline(K.LANE_X0,y+K.NOW_SPARK_Y+K.NOW_SPARK_H-2,K.LANE_W,t.label); }
  p.text(padR(tok>0?fmtTokens(tok):"",12),K.LANE_X0,y+K.NOW_META_Y,2,t.label,t.card,"TL","ifchanged",K.LANE_W);
  p.text(padL(st?staleTxt(d):(sp?"LAST 2.5H":"no history"),13),
    K.LANE_X1,y+K.NOW_META_Y,1,st?t.bad:t.label,t.card,"TR","ifchanged",K.LANE_W);
}
function drawB(p,d) {
  const t = p.t, st = isStale(d);
  const nowY = K.CARD1_Y;
  const weekY = nowY + K.NOW_CARD_H + K.SP_2;                 // 244
  const codexY = weekY + K.WEEK_CARD_H + K.SP_2;               // 396
  leadCard(p,d,nowY,K.NOW_CARD_H,"NOW - 5 HOUR WINDOW",d.fh,d.fhR,300,d.fhT,st);
  // WEEK, 144: secondary, so a 24px number rather than a 64px hero. Its burn is
  // the AVERAGE - the ring is blind at a 7-day window (see burnFor).
  const col = pctCol(t,d.sd), b = burnFor(d.sd,d.sdR,10080,null,st);
  p.card("7d",weekY,K.WEEK_CARD_H,col);
  capRow(p,weekY,"WEEK - 7 DAY, ALL MODELS",d);
  p.text(heroTxt(d.sd),K.LANE_X0,weekY+K.WEEK_NUM_Y,3,st?t.label:t.value,t.card,"TL","ifchanged",K.CARD_HERO_W);
  p.text(padL(b.txt,15),K.LANE_X1,weekY+K.WEEK_BURN_Y,1,b.urgent?(d.sd>=90?t.bad:t.warn):t.label,t.card,"TR","ifchanged",K.SIDE_CHARS*8);
  p.paceBar(K.LANE_X0,weekY+K.WEEK_BAR_Y,K.LANE_W,K.BAR_H,d.sd,tickOf(d.sdR,10080),col);
  p.text(padR(d.sdT>0?fmtTokens(d.sdT):"",12),K.LANE_X0,weekY+K.WEEK_META_Y,2,t.label,t.card,"TL","ifchanged",K.LANE_W);
  p.text(padL(st?staleTxt(d):(d.sdR>=0?fmtResetIn(d.sdR):"no data yet"),12),
    K.LANE_X1,weekY+K.WEEK_META_Y,2,st?t.bad:t.label,t.card,"TR","ifchanged",K.LANE_W);
  p.text(padR(d.fbP>=0?`FABLE  ${d.fbP}%`:"FABLE  --",10),K.LANE_X0,weekY+K.WEEK_FABLE_Y,2,t.label,t.card,"TL","ifchanged",K.LANE_W);
  p.text(padL(d.fbT>=1e6?fmtTokens(d.fbT):"",12),K.LANE_X1,weekY+K.WEEK_FABLE_Y,2,t.label,t.card,"TR","ifchanged",K.LANE_W);
  p.paceBar(K.LANE_X0,weekY+K.WEEK_FABLE_BAR_Y,K.LANE_W,K.BAR_H,d.fbP<0?0:d.fbP,tickOf(d.sdR,10080),d.fbP<0?t.unknown:pctCol(t,d.fbP));
  codexRow(p,d,codexY,K.CODEX_H,false);
}

// ---------------------------------------------------------------------------
// C - URGENCY LADDER. Rows sort by how close to trouble they are and the
// leader expands. The cost is that the geometry becomes state-dependent. NOT
// what the header derives - unbound, illustrative only.
// ---------------------------------------------------------------------------
function rankItems(d) {
  const it = [
    { lab:"SESSION 5H",   pct:d.fh, r:d.fhR, w:300,     tok:d.fhT },
    { lab:"WEEK 7D ALL",  pct:d.sd, r:d.sdR, w:10080,   tok:d.sdT },
    { lab:"WEEK 7D FABLE",pct:d.fbP,r:d.sdR, w:10080,   tok:d.fbT },
    { lab:"CODEX 7D",     pct:d.cx, r:d.cxR, w:d.cxW,   tok:0 },
  ];
  return it.slice().sort((a,b) => (b.pct-a.pct)||(a.w-b.w));
}
function drawC(p,d) {
  const t = p.t, st = isStale(d), it = rankItems(d);
  const L = it[0];
  leadCard(p,d,54,186,`TIGHTEST: ${L.lab}`,L.pct,L.r,L.w,L.tok,st);
  [248,318,388].forEach((y,i) => {
    const o = it[i+1], col = o.pct<0 ? t.unknown : pctCol(t,o.pct);
    p.card("row"+i,y,64,col);
    const right = padL(o.pct<0?"--":`${o.pct}%  ${o.r>=0?fmtResetIn(o.r):"no data"}`,15);
    const rightX = K.LANE_X1-right.length*8;
    const ceil = Math.floor((rightX-1-K.LANE_X0)/8);
    p.laneCeil = ceil; p.laneNeed = Math.max(p.laneNeed||0,o.lab.length);
    p.text(padR(o.lab,ceil),K.LANE_X0,y+8,2,t.label,t.card,"TL","ifchanged",K.LANE_W);
    p.text(right,K.LANE_X1,y+8,2,st?t.label:t.value,t.card,"TR","ifchanged",K.LANE_W);
    p.paceBar(K.LANE_X0,y+40,K.LANE_W,K.BAR_H,o.pct<0?0:o.pct,(o.r>=0&&o.w>0)?tickOf(o.r,o.w):-1,col);
  });
}

// ---------------------------------------------------------------------------
const LAYOUTS = [
  { id:"today", n:"0", title:"Today", tag:"what shipped", draw:drawToday,
    col:"8 + 164 + 8 + 164 + 8 + 56 + 6",
    blurb:"Two structurally identical 164px cards, then a 56px Codex line. The hero is handed the whole 260px lane, so 132px beside every percentage is erased on each repaint; the Codex label lane is bounded at 12 characters by its neighbour - the defect Task 1 fixed." },
  { id:"A", n:"A", title:"Subtract", tag:"no new state", draw:drawA,
    col:"8 + 140 + 8 + 164 + 8 + 78 + 8",
    blurb:"The stack and its symmetry survive. Card 1 loses 24px by folding two meta rows into one; the burn verdict and the countdown move into the space beside the hero. Fable becomes a real bar inside the WEEK card, and Codex gets two lines so its label lane stops being bounded at all." },
  { id:"B", n:"B", title:"Now / Week / Codex", tag:"selected - what shipped", draw:drawB,
    col:"8 + 182 + 8 + 144 + 8 + 56 + 8",
    blurb:"A semantic hierarchy instead of a repeated template. NOW keeps the 64px hero and gains a 30-sample sparkline; WEEK drops to a 24px number and carries Fable's bar in the same card; Codex keeps one line and gains characters of label lane for free. board_es3c35p.h derives exactly this." },
  { id:"C", n:"C", title:"Urgency ladder", tag:"state-dependent", draw:drawC,
    col:"8 + 186 + 8 + 64 + 6 + 64 + 6 + 64 + 8",
    blurb:"Four caps as peers, sorted by how close to trouble each is, with the leader expanded. Switch the state and the order changes. Its cost is real: the geometry now depends on data, so it needs new cache-bust terms and three checkers taught about a layout that moves." },
];

// ---------------------------------------------------------------------------
// THE CHECKS. Each is written so that reverting the thing it guards makes it
// fail. Two are deliberately stricter than the shipping checker:
//   - the column must sum to EXACTLY K.CONTENT_ROWS, where usage-geom-check.mjs
//     asserts only air > 0 and therefore cannot see the drift it exists for;
//   - a LATER field's clear box may not touch an EARLIER field's ink, per
//     glyph. That is the real device hazard, and it is directional: the
//     reverse repairs itself on the next draw, which is exactly the argument
//     renderCodexRow's own comment makes about its right field.
// This is the SAME function the in-browser checker calls - it reads only
// `fields`/`cards`, which never touch a canvas, so it needs no browser.
// ---------------------------------------------------------------------------
const hit = (a,b) => a.x<b.x+b.w && b.x<a.x+a.w && a.y<b.y+b.h && b.y<a.y+a.h;
const risk = (clearer,victim) => {
  if (victim.always) return false;
  for (const ink of victim.inks) if (hit(ink,clearer)) return true;
  return false;
};
function runChecks(L,p,d) {
  const out = [], base = L.id==="today";
  const A = (ok,msg,known) => out.push({ ok:!!ok, known:!ok&&!!known, who:L.n, msg });
  const txt = p.fields.filter(f => f.kind==="text");

  const bad = new Set();
  txt.forEach(f => { for (const ch of f.txt) { const c=ch.codePointAt(0); if (c<0x20||c>0x7E) bad.add(ch); } });
  A(!bad.size, bad.size?`non-ASCII would draw as nothing: ${[...bad].join(" ")}`
    :`all ${txt.length} strings inside Spleen's 0x20..0x7E`);

  const cs = p.cards, last = cs[cs.length-1], air = K.contentBottom-(last.y+last.h);
  const terms = L.col.split("+").map(t => +t.trim());
  const dsum = terms.reduce((a,b) => a+b,0);
  A(dsum===K.CONTENT_ROWS,`declared column ${L.col} = ${dsum}, must be exactly ${K.CONTENT_ROWS} (${K.contentBottom} - ${K.CONTENT_Y})`);
  const drawn = [cs[0].y-K.CONTENT_Y];
  cs.forEach((c,i) => { drawn.push(c.h); if (i<cs.length-1) drawn.push(cs[i+1].y-(c.y+c.h)); });
  drawn.push(air);
  A(drawn.join()===terms.join(), drawn.join()===terms.join()
    ? `drawn column ${drawn.join(" + ")} matches what is declared`
    : `drawn column ${drawn.join(" + ")} does NOT match the declared ${L.col}`);
  A(air>0,`column ends at ${last.y+last.h}, ${air}px of air above the footer (never flush)`);

  cs.forEach(c => {
    const ceil = c.y+c.h-3, bot = Math.max(...c.fields.map(f => f.y+f.h-1));
    A(bot<=ceil,`"${c.name}" h=${c.h}: last clear ends +${bot-c.y}, border ceiling +${ceil-c.y}${bot<=ceil?` (${ceil-bot} rows clear)`:` - OVER by ${bot-ceil}`}`);
  });

  let clash = 0, first = "";
  for (let j=0;j<p.fields.length;j++) for (let i=0;i<j;i++) {
    const X = p.fields[i], Y = p.fields[j];
    if (X.card!==Y.card||X.chrome||Y.chrome) continue;
    if (!hit(X,Y)) continue;
    let bad2 = null;
    if (risk(Y,X)) bad2 = [Y,X]; else if (risk(X,Y)) bad2 = [X,Y];
    if (bad2) { clash++; if (!first) first = `"${bad2[0].txt||bad2[0].kind}" clears over "${bad2[1].txt||bad2[1].kind}"`; }
  }
  A(!clash, clash?`${clash} clear box(es) erase earlier ink: ${first}`
    :`no clear box erases earlier ink (${p.fields.reduce((a,f) => a+f.inks.length,0)} glyph rects tested)`, base);

  let oob = 0; p.fields.forEach(f => { if (f.chrome) return;
    if (f.x<0||f.x+f.w>K.BOARD_W||f.y<K.CONTENT_Y||f.y+f.h>K.contentBottom) oob++; });
  A(!oob, oob?`${oob} field(s) cross the tab bar or footer`:`nothing crosses the tab bar or the footer divider`);

  if (p.laneCeil!=null)
    A(p.laneNeed<=p.laneCeil,`Codex label lane: needs ${p.laneNeed} chars, ceiling is ${p.laneCeil}`
      +(p.laneNeed<=p.laneCeil?"":" - the right field's clear box eats the tail"), base);
  return out;
}

// ===========================================================================
// BROWSER DRIVER. Guarded on every DOM read (`if (!host) return`, `document.
// getElementById(...) || null`) so this section is INERT under check.mjs's
// stubbed `document` - the same seam settings.js's own driver uses, which is
// what lets one file serve both the page and the headless gate.
// ===========================================================================
const UI = { state:"nominal", dev:"DARK", scale:1, boxes:false };
function render() {
  const d = STATES[UI.state], strip = document.getElementById("strip");
  if (!strip) return;                                   // check.mjs's stub: nothing to draw into
  strip.innerHTML = ""; const all = [];
  LAYOUTS.forEach(L => {
    const st = document.createElement("div"); st.className = "station";
    st.innerHTML = `<div class="stationhd"><span class="n">${L.n}</span><span class="t">${L.title}</span>`
      +`<span class="xs">${L.tag}</span></div>`;
    const bez = document.createElement("div"); bez.className = "bezel";
    const cv = document.createElement("canvas"); cv.width = K.BOARD_W; cv.height = K.BOARD_H;
    cv.style.width = (K.BOARD_W*UI.scale)+"px"; cv.style.height = (K.BOARD_H*UI.scale)+"px";
    cv.setAttribute("role","img");
    cv.setAttribute("aria-label",`${L.title} layout, ${d.lbl} state, ${UI.dev.toLowerCase()} panel`);
    bez.appendChild(cv); st.appendChild(bez);
    const cap = document.createElement("p"); cap.className = "cap";
    cap.innerHTML = `<b>${L.col}</b> = ${K.CONTENT_ROWS}`;
    st.appendChild(cap); strip.appendChild(st);

    const ctx = cv.getContext("2d"); if (ctx) ctx.imageSmoothingEnabled = false;
    const p = new P(UI.dev);
    chrome(p,d); L.draw(p,d);
    if (ctx) {
      p.paint(ctx);
      if (UI.boxes) { ctx.save();
        p.fields.filter(f => !f.chrome).forEach(f => {
          ctx.strokeStyle = "rgba(255,64,129,.85)"; ctx.lineWidth = 1;
          ctx.strokeRect(f.x+.5,f.y+.5,f.w-1,f.h-1); });
        ctx.restore(); }
    }
    all.push([L, runChecks(L,p,d)]);
  });
  const box = document.getElementById("checks");
  if (box) box.innerHTML = "";
  let ok=0, kn=0, bad=0, tot=0;
  all.forEach(([L,rs]) => rs.forEach(r => { tot++;
    const cls = r.ok?"ok":r.known?"known":"fail"; if (r.ok) ok++; else if (r.known) kn++; else bad++;
    if (!box) return;
    const row = document.createElement("div"); row.className = "row "+cls;
    row.innerHTML = `<span class="mk">${r.ok?"✓":r.known?"!":"✗"}</span><span class="who">${L.title}</span><span class="msg"></span>`;
    row.querySelector(".msg").textContent = r.msg+(r.known?"  (known defect in what shipped)":"");
    box.appendChild(row);
  }));
  const tl = document.getElementById("tally");
  if (tl) {
    tl.textContent = `${ok}/${tot} pass, state "${d.lbl}"`
      +(kn?`  ·  ${kn} known defect${kn>1?"s":""} in the baseline`:"")
      +(bad?`  ·  ${bad} FAILING`:"");
    tl.style.color = bad?"var(--bad)":kn?"var(--warn)":"";
  }
}
if (document.querySelectorAll) document.querySelectorAll("button.seg").forEach(b => b.addEventListener("click", () => {
  const g = b.dataset.state?"state":b.dataset.dev?"dev":b.dataset.scale?"scale":"ov";
  if (g==="ov") { UI.boxes = !UI.boxes; b.setAttribute("aria-pressed",String(UI.boxes)); }
  else {
    const key = g, val = g==="state"?b.dataset.state:g==="dev"?b.dataset.dev:+b.dataset.scale;
    UI[key] = val;
    document.querySelectorAll(`button.seg[data-${g}]`).forEach(o => o.setAttribute("aria-pressed",String(o===b)));
  }
  render();
}));
// Test seam: ?state=critical&dev=LIGHT lets the whole sweep be reached without
// clicking - the same reason DECKHAND_TMP exists for the menu-bar app.
if (typeof location !== "undefined") {
  const h = new URLSearchParams(location.hash.slice(1));
  if (STATES[h.get("state")]) UI.state = h.get("state");
  if (TH[h.get("dev")]) UI.dev = h.get("dev");
  if (h.get("boxes")) UI.boxes = true;
  if (document.querySelectorAll) {
    document.querySelectorAll("button.seg[data-state]").forEach(b => b.setAttribute("aria-pressed",String(b.dataset.state===UI.state)));
    document.querySelectorAll("button.seg[data-dev]").forEach(b => b.setAttribute("aria-pressed",String(b.dataset.dev===UI.dev)));
  }
  render();
}
