# Type scale, art, themes, screenshots and chrome

> Extracted verbatim from CLAUDE.md. **The measurements are the point** - they were
> taken on real hardware at a specific commit, so do not paraphrase or "tidy" them.
> If you change the behaviour, change the number and say what you measured.

Index: [`docs/README.md`](../README.md). The rules an agent must not miss stay in
[`CLAUDE.md`](../../CLAUDE.md).

---

- **Code-friendly detail rendering.** The detail can be a code block, so `\n` is preserved
  end-to-end: the hook's `cleanMultiline()` (in `deckhand-session-hook.mjs`, used for the
  `detail` field only — `title`/`options` still use single-line `clean()`) keeps newlines while
  stripping tabs→spaces, ``` fences, and other control bytes; the device's ask-parse sanitize
  loop blanks control bytes **except `\n`**; and `wrapLineLen`/`countWrappedLines`/
  `drawWrappedText` treat `\n` as a hard line break. `detailLooksLikeCode(kind, detail)` (true
  for any `perm` prompt, or any detail containing a `\n`) drives the *style* in both
  `drawAskDetail` and `drawReader`: the **Cozette** bitmap font on a `COLOR_CARD` panel for
  code, the larger proportional font 2 for plain one-line prose. `isPerm`/`isPlan` still pick
  the badge label and button colors — only the text styling moved to `isCode`.
- **Cozette code font.** Code blocks render in Cozette 6x13 (`Cozette6x13.h`), an Adafruit-GFX
  bitmap font, *not* a numbered GLCD font — a hand-hinted bitmap font stays crisp at this
  panel's low DPI where a downscaled/anti-aliased vector font goes fuzzy. It's selected through
  the `FONT_CODE` sentinel (200, not a real TFT_eSPI font number): `applyContentFont()` maps it
  to `tft.setFreeFont(&Cozette6x13)` and any real number to `setTextFont()` (which also clears
  the GFX font, so the two never leak). Only `countWrappedLines`/`drawWrappedText` — i.e. the
  ask detail and full-screen reader — ever pass `FONT_CODE`; the per-second footer/USAGE fields
  stay on GLCD, so the flicker-free redraw discipline is untouched. TFT_eSPI's free-font path
  only engages when the active font is 1 **and** `gfxFont` is set (which `setFreeFont` does), and
  with `TL_DATUM` it adds the ascent so the text top lands at the given `y`. The header is
  regenerated from the upstream BDF by `firmware/deckhand_display/bdf2gfx.py` (see its docstring);
  the 668KB BDF itself is deliberately **not** committed — the ~1KB header is self-contained.
- **The type scale is three rungs, and `UI_FONTS[]` IS PER BOARD.** It maps a font id to
  `(face, size, cellH)`, behind the same `#if BOARD_USES_TFT_ESPI` every other board split uses:
  board 1 is `T_META`/`T_BODY` → Cozette 6x13, `T_HEAD` → Terminus 10x18 bold, `T_HERO` →
  Cozette 12x26; board 2 is **Spleen 8x16 / 12x24 / 32x64, every rung NATIVE at size 1** — no
  entry on that board is a mechanical upscale of another. The ids are the legacy TFT_eSPI numbers
  the ~72 existing call sites already pass, so the registry landed **inert** — adding a face, or a
  whole second family for a second board, cost zero changes at those sites.
  **WHY 8x16 AND NOT 12x24, WHICH IS THE COUNTER-INTUITIVE PART OF THE WHOLE CHANGE.** Board 2 has
  twice the pixels but is only 15% denser (6.489 vs 5.624 px/mm), so **the same pixel size is
  physically SMALLER there** — Cozette 6x13 is 2.31mm tall on board 1 and 2.00mm on board 2, which
  is why "just keep the fonts and spend the pixels on air" left body text a step down from board 1
  rather than equal to it. Spleen 8x16 is **2.47mm**, restoring parity, and it keeps a **32**-character
detail-card lane against board 1's 31, so every existing character-budget argument carries over
  instead of needing re-invention. 12x24 would have been 3.70mm and **21** columns — a third of the
  card's text gone to make the text bigger than board 1's.
  | | board 1 | board 2 at 6x13 | board 2 at 8x16 | board 2 at 12x24 |
  |---|---|---|---|---|
  | cell height | 2.31mm | 2.00mm | **2.47mm** | 3.70mm |
  | detail-card lane | 31 cols | 43 | **32** | 21 |
  **The lane row is `CARD_W - 2*PAD`, and it has to name WHICH lane** — an earlier version of this
  table read `34 | 42 | 32 | 21`, which is reproducible from no lane in the code: it compared board
  1's *keyboard* lane against board 2's *detail-card* one and the 42 fitted a 256px lane that exists
  nowhere. There is no single "the card lane" on either board. The four that matter, board 1 then
  board 2: detail card (`CARD_W - 2*PAD`) **31 / 32**, keyboard (`CARD_W - 12`) **34 / 35**,
  voice and confirm panels (`CARD_W - 8`) **34 / 36**, full-width ask and reader **36 / 37**.
  **`CARD_HERO_SIZE` NO LONGER EXISTS ON BOARD 2.** Board 1's hero is Cozette 6x13 pushed to
  `setTextSize(3)` — one mechanical step past its own `T_HERO` registry entry, which is already
  size 2 — so that board needs a constant naming the override. Board 2's `T_HERO` is Spleen 32x64
  at size 1, so there is no scale factor left to name and the constant is gone from
  `board_es3c35p.h` rather than set to 1. At 64px the hero is 9.86mm against board 1's 6.9mm —
  *bigger*, not merely matched, because Spleen's only rung above 12x24 is 32x64 and there is
  nothing between them to land closer.
  **`TEXT_ADV` and `CODE_LINE_H`/`HERO_LINE_H` exist because literals describe ONE board's face.**
  Every character-lane division used to be `/ 6` and every code line step a literal `13` — both
  Cozette's — and after board 2's face changed those literals went on being right-looking and
  wrong. The named per-board pair is what a lane or a stacked block derives from now, and the
  geometry checkers assert each against the parsed `UI_FONTS[]` table (`uiLineH()` is not a
  constant expression, so a board header cannot `static_assert` it itself).
  **THE FULL-SCREEN READER WAS STILL DOING IT, AND IT IS THE SAME DEFECT THIS FILE ALREADY RECORDS
  ONCE — the 13px step under a 16px cell.** `drawReader()` hardcoded `lineH = isCode ? 14 : 18`;
  the 14 is Cozette 6x13's cell plus a row of leading, i.e. **board 1's face**. Board 2 draws Spleen
  8x16, so `drawString`'s opaque box erased rows 14..15 of every code line — 2 of that face's 4
  descender rows — and since **every `perm` ask reads as code**, this clipped g/j/p/q/y in whole
  commands. The identical literal had already been fixed at the ask PREVIEW and the voice-confirm
  panel; **this site was missed, and it is the one that renders the command in full.** That is the
  transferable part: a literal fixed at two of its three sites is not fixed.
  Measured on the glass before and after by decoding the `SCREENSHOT` PNG and counting inked rows —
  an all-`g` line inked y135..143 with **144..145 BLANK**, against **145..154** after, where row 154
  is the `g`'s closing bar: **210px of ink per line that was being erased outright**. Pitch measured
  14 then 16 straight from the ink periodicity. (Board-2 framebuffer evidence, as above: it proves
  what the renderer composed, which is exactly the question here.)
  **The fix is per-board and the naive one is wrong.** `CODE_LINE_H` unconditionally would take
  board 1 from 14 to **13** — tighter than it ships, and it moves that board's binary. So
  `READER_CODE_LINE_H` is board 1 `CODE_LINE_H + 1` (14, unchanged) and board 2 `CODE_LINE_H` (16,
  the bare cell, matching the `HIST_LINE_H` the history list and full-entry pager either side of it
  already use). The prose 18 is judged and KEPT on both boards — `T_BODY`'s cell is 13 and 16, so 18
  is leading rather than a defect — and named only so the whole ternary is derived rather than half
  of it. Board 2's reader pagination goes 25 → 22 code lines, which is the correct consequence;
  nothing stated the old count, and the page budget `requestHistory()` sends the Mac is
  `HIST_LINE_H`-based and untouched.
  **The checker assertion that should have caught it was TRANSCRIBED, and was wrong in BOTH arms.**
  `settings-geom-check.mjs` modelled the two steps as `HIST_LINE_H` and `uiLineH(T_HEAD)` against a
  real 14/18 — board 1's prose arm agreed only because Terminus's cell **happens** to be 18. It now
  PARSES `drawReader()`'s own ternary and resolves each token against the board's constant table
  (a literal resolves to itself, so a revert is still measured; an unknown token throws rather than
  passing), then asserts both steps `>=` the code face's cell height taken from the parsed
  `UI_FONTS[]`. Four fault injections fail by name. Same rule as everywhere else here: **a checker
  must PARSE the constant it certifies, never TRANSCRIBE it** — this is the third time that has
  bitten.
  **Every Spleen glyph in 0x20..0x7E has `xOffset == 0` and `width == xAdvance == 8`, so
  `textWidth`'s last-character rule is a NO-OP on board 2** — a column count that divides exactly
  is exact for *any* string there. Cozette is not like that: its advance is a uniform 6 but
  `max(xOffset + width)` is **7** (space, `4`, `q`), so board 1's own 34-column lane is 1px hot for
  a line ending in one of those three (harmless — the ink stops 3px inside the card). The checkers
  assert the monospace property rather than assuming it, so a regenerated Spleen that broke it
  fails loudly instead of quietly invalidating every lane derived from `TEXT_ADV`. Two cheaper options were tested and ruled out, not argued about: Cozette's
  `cozette_hidpi.bdf` is a **byte-identical mechanical 2x upscale** (decoded glyph-for-glyph), and
  a 1px synthetic double-strike has nowhere to go because **78 of 95 glyphs already reach or pass
  the 6px advance** (`4` reaches 7). So Cozette offers exactly one size and its double, and a
  genuine middle rung has to come from another family.
  **`T_TITLE` still resolves to body on purpose.** It is used inside `uiButton`, the single shared
  button style, so pointing it at `T_HEAD` would widen EVERY button label on the device —
  Allow/Deny and the confirm dialogs included — by 67%, past widths chosen for a 6px face
  (`CALIBRATE TOUCH` is 90px at 6x13 and 150px at 10x18). It migrates with the settings/overlay
  restyle, where those widths get re-derived.
  **`drawIfChanged` derives its erase height from the registry, never a literal.** It used to
  compute `th = 13 * tft.textsize`, baking Cozette's cell height into every field's erase
  rectangle; any taller face clears part of its own box and ghosts on every update. Same class of
  silent bug as a change-only cache shorter than the string it holds.
  Session names use all three rungs: `drawSessionRow` walks 12x26 → 10x18 → 6x13 and takes the
  first whose measured width fits, so a long name shrinks a step instead of being cut. The shrunk
  name is centred in the 26px band the big font would have filled — the old hardcoded `+6` was
  exactly `(26 - 13) / 2`, so the offset is now derived and reproduces it. `fitText` returns an
  empty string when nothing fits at all, which is reachable at 10px where it was not at 6px, so
  the ladder falls through to the smallest rung rather than draw a blank name.
  Cost: **+3524 bytes of flash total, zero RAM** (`PROGMEM`) — 2850 of that is the Terminus font
  data itself (roughly what a second added face would cost), the rest is the registry table,
  tokens, and comments, plus the ladder code. Regenerate with
  `python3 bdf2gfx.py <bdf> <Name> <yAdvance> > <Name>.h`; the BDFs are **not** committed (Cozette
  667KB, Terminus 235KB) but the generated headers and both licence texts
  (`licenses/Terminus-OFL.txt`, `licenses/Cozette-MIT.txt`) are. The same recipe vendored the three
  Spleen faces for board 2's type scale (`Spleen8x16.h`/`Spleen12x24.h`/`Spleen32x64.h`, run with
  yAdvance 16/24/64) — same rule, BDFs not committed (Spleen 8x16 154KB, 12x24 217KB, 32x64
  682KB), only the generated headers and `licenses/Spleen-BSD-2-Clause.txt` are, and each was
  passed through `--verify` against its own BDF before being trusted.
  `bdf2gfx.py --verify <bdf> <header>` decodes a header and compares it glyph-for-glyph with its
  source, and `--selftest` corrupts one byte of `A` and fails if that goes unnoticed — the same
  teeth-proving trick as `palette-check.mjs --selftest`. **Both need a BDF, and the BDFs are
  deliberately uncommitted, so neither is runnable from a fresh checkout** — unlike every other
  check in this repo, which is why it is the one that exits non-zero if you run the whole list.
  Fetch the BDF first (`--selftest <bdf> <header>`); bare `--selftest` raises
  `FileNotFoundError` rather than printing usage. That check earned its place: the
  generator had only ever been run on Cozette, whose glyphs are tightly cropped, and Terminus
  declares a uniform full-cell `BBX` that exercises packing paths which had never run.
- **The BRIGHTNESS / SLEEP AFTER / VOLUME steppers put the label in the MIDDLE column, and that
  is what makes the keys fit.** The label used to sit top-left, in the same column as the left
  key, so the keys had to start below it - at `+14` in a 56px card whose 2px border owns
  `+54..+55`, which left them ending flush on that border with no padding at all. Moving the label
  above the value it names frees the whole interior height: keys are now **44px** (4px OVER
  `TAP_MIN`, not merely at it) at `+6..+49`, with 4px of air top and bottom. Label centres at
  `+15`, value at `+32`, and the bar at `+43..+48`.
  Three things worth keeping:
  - **The value renders in `T_HEAD`** (Terminus 10x18 bold), and the `+`/`-` glyphs too. At body
    size the number was the same weight as the label naming it, and a 6px glyph on a 44px key was
    a speck. This is the type scale's middle rung doing the job it was added for.
  - **Only BRIGHTNESS gets a bar.** It is the one continuous 0-100 setting, so the bar says where
    in the range you are. Sleep and volume are discrete presets whose label already says that, and
    a bar there would be decoration.
  - **The touch zones are much bigger than the keys and always were**: `stepperHit` claims the
    left third of the card for decrement and the right third for increment, over the full card
    height - roughly 72x56 each, against a 44px key. Worth knowing before "fixing" a hit test that
    is not the problem. The centred label spans x 87..153, clear of both zones, so a tap on it
    cannot step the value by accident.

- **The battery reading is coloured by level, and charging is a STATE rather than a level.**
  `colorForBattery` bands at <=10 `COLOR_BAD`, <=30 `COLOR_WARN`, else `COLOR_GOOD` - note this is
  INVERTED against the usage palette's meaning, where a HIGH percentage is the bad one.
  `colorForBatteryState` wraps it: charging returns `COLOR_ACCENT` and full returns `COLOR_GOOD`,
  because while power is coming in 8% is not a warning, and a charging device sitting there showing
  an alarm about a problem actively being solved is just noise. The glyph and the number both go
  through it, so the two can never disagree.
  **Colour is not the only carrier**, which is what keeps this inside the colour-blind rule the rest
  of the UI follows: the reading is printed as a NUMBER, the glyph carries a proportional FILL, and
  charging/full say so in words. The three bands stay legible to a deuteranope eye and in flat
  greyscale without the colour doing any work.
  **Both readings cache their COLOUR next to their text.** `drawIfChanged` compares text only, so a
  colour that flips while the string stays identical would never reach the panel - plugging in at a
  steady charge leaves the settings row reading `42% 3.85V` while its colour should go from good to
  accent. `battTextColorCache` / `battRowColorCache` bust the text cache on a flip. This is the same
  guard `renderUsageTab` needs for its stale-dimmed hero numbers, and it is easy to forget precisely
  because the common case (the number moved too) hides it.

- **Screen flip (180°) for charging.** SETTINGS › DISPLAY & SOUND has two half-width toggles
  sharing the bottom row — SOUND and NORMAL/FLIPPED — because a full-width row for each doesn't
  fit (only 32px remain under it). Flipping swaps `tft.setRotation()` between `SCREEN_ROTATION`
  and `2`; both are portrait, so no layout constant moves. The catch is touch: the panel is glued
  to the glass and does **not** rotate with the image, so `getTouchPoint()` mirrors its mapped
  result (`w-1-x`, `h-1-y`) when flipped — that keeps ONE calibration valid for both orientations
  instead of forcing a recalibration on every flip. Consequently `runCalibration()` **forces the
  unflipped rotation** for its duration (crosshairs would otherwise be drawn mirrored and the
  saved `calData` would come out inverted), and every call site restores the user's choice with
  `applyScreenRotation()` afterwards. Persisted as NVS `flip`, loaded in `setup()` right after
  `loadOrRunCalibration()` (which is where `prefs.begin` happens) — so it also survives the
  deep-sleep/wake cycle, since wake re-runs `setup()`.
- **"Working" spinner — the Claude spark (the one timer-driven redraw).** A working session cycles
  8 frames of the Claude spark (`drawWorkingSpinner`), advanced by `tickWorkingSpinner()` from
  `loop()` every `ANIM_INTERVAL_MS` (120ms, ~1s per cycle). The art lives in `ClaudeSpark.h`,
  **generated** by `firmware/deckhand_display/spark2c.py`; the source frames
  (`SparkFrames.swift`) are **not** kept in the repo, so `ClaudeSpark.h` IS the art now — to change
  it, supply the frames again and run `python3 spark2c.py <frames> > ClaudeSpark.h` (the script
  takes a .swift with quoted base64, or one base64 PNG per line). The source PNGs are 60x60 RGBA that are
  pure black with 4 alpha levels, i.e. **masks**: the converter keeps only alpha, box-filters to
  32x32 and quantises to 2 bits, so the firmware tints them with the status colour at draw time
  (one copy serves any colour, and no PNG decoder is needed on-device). Cost: **2KB flash**
  (8x32x32x2bits) and only a **64-byte** line buffer — it blits one ROW at a time rather than
  composing a whole 2KB frame. `fillRect` is used rather than `pushImage` for the same byte-order reason as the crab (see the
  easter-egg note) — it takes an ordinary colour, so no `swapBytes` juggling. Further compression isn't worth it, measured: RLE saves only 8%
  (the art is too detailed for long runs), zlib 45% but needs a runtime inflate, and 1bpp halves
  it at the cost of the anti-aliased edges.
  **32x32 is a floor, not a preference**: at the old dot size (14-18px) the thin spokes turn to
  mush, and 24px is marginal — measured, not guessed. It still fits the row's indicator slot
  (spans x 15..46 with the name starting at x=48) and the tightest 38px row (y+3..y+35), so no
  text moved. Each frame is composed into `sparkBuf` and pushed as ONE `pushImage` rather than
  1024 `drawPixel` calls, and because it repaints the whole box there's no separate clear.
  **The spinner is a BLIT, so its rectangle must clear the row's rounded corner.** It paints a
  full 32x32 area including background pixels, and at the old centre (`SESSION_ROW_X + 20`) that
  rect started at x=12 while the corner's 2px border reaches x~12.9 on the spinner's topmost row -
  so the blit's `COLOR_CARD` background bit a notch out of the border. On LIGHT, where
  `COLOR_CARD` is white, it read as a white nick in the card's rounded corner. The centre is now
  `SESSION_DOT_CX` = `SESSION_ROW_X + 23`: the rect is x 15..46, clear of the border by 2.1px and
  2px short of the name lane at x=48.
  **`SESSION_DOT_CX` exists because TWO paths draw that indicator** - `drawSessionRow()` on a
  repaint and `tickWorkingSpinner()` every 120ms - and when the fix was applied to only one of
  them the animation happily redrew at the old x four times a second, undoing it. Any change to
  where the indicator sits has to be to that constant, never to a call site.
  This is the sole place that repaints on a timer instead of on a value change; it stays within
  the flicker-free discipline because it's one small blit, never a cleared region. Gated to the
  sessions list actually being visible (`!isAsleep && !octoActive && !showingDetail &&
  !readerActive && currentTab == TAB_SESSIONS`), and it deliberately does **not** touch
  `lastNonIdleMillis` — an animation must never look like activity to the auto-sleep timer. The
  spark is a distinct radiating shape, and motion is an extra cue, never the only one.
  **WHAT CARRIES THE NON-HUE HALF DIFFERS PER BOARD NOW, AND THIS SENTENCE USED TO CLAIM
  OTHERWISE FOR BOTH.** On **board 1** it is unchanged and literal: working is told apart from
  asking (filled square) and waiting (hollow ring) by **shape alone**. On **board 2** the agent
  mark replaced the square and the ring at every status — that was the deliberate trade §5 of the
  sessions redesign made, because the mark has to say WHICH AGENT and status already owns the
  colour — so the mark's shape now distinguishes Claude from Codex and no longer distinguishes one
  status from another. The status carrier there is the **status pill's FORM** (filled = asking,
  outlined = waiting, boxless dim text = working) on every ordinary row, and on the **expanded band
  card** — which draws no pill and no indicator at all, its border being hue — it is the **status
  WORD** from `labelForStatus`. That word is therefore load-bearing rather than decorative:
  `sessions-geom-check.mjs` asserts the three are distinct, non-empty strings, and collapsing two of
  them left every checker at zero failures before it did. The colour-never-alone rule holds on both
  boards; only the thing carrying it moved.
- **Codex's "working" animation — the Codex mark, rotating (`CodexMark.h`).** A Codex
  session that is working gets its own animation next to the Claude spark, generated by
  `firmware/deckhand_display/codex2c.py` from the Codex mark SVG. Same format as the
  spark (8 frames, 32x32, **2 bits of alpha**, tinted with the status colour at draw
  time), so `drawAgentSpinner()` is one blitter over two tables and the only difference
  is which art it reads — the status colour still means status, and the **shape** is
  what says which tool. Costs another 2KB of flash.
  Three things about generating it are load-bearing:
  - **The glyphs are HOLES, not shapes.** The mark is one path with three contours and
    `fill-rule="evenodd"`: an 8-lobed blob, a chevron, and an underscore, where the
    latter two punch through. Split into separate paths they stop being holes, so the
    script draws the blob white and then paints the two glyphs **black** over a black
    background — which reproduces the holes exactly and makes luminance the mask.
  - **Only the blob rotates.** Rotating the glyphs too would spin the `>_` prompt
    upside down; leaving them upright keeps the mark readable in every frame while the
    lobes carry the motion. 8 frames x 45 degrees = one full turn, so the loop is
    seamless. 45 is not a no-op despite the 8 lobes: measured at **19.5/255** mean
    absolute luminance difference from the original, because the lobes are organic
    rather than exactly repeated. (If they ever were exact, 45 would emit 8 identical
    frames and the step would have to become 45/8.)
  - **Rasterising uses headless Google Chrome**, because this toolchain has no SVG
    rasteriser at all — no `rsvg-convert`, `inkscape`, `cairosvg`, or even Pillow. The
    script also contains its own ~40-line PNG reader (zlib inflate + unfilter) for the
    same reason. Frames render at 128px and are box-filtered 4x4 down to 32, which is
    where the anti-aliasing comes from.
  - **SVG numbers can run together with no separator** — `M8.086.457` is *two* numbers,
    and a naive `[\d.]+` swallows both and then fails to parse. The contour splitter
    scans numbers properly, and converts each later contour's relative `m` into an
    absolute `M` (a `z` returns to the contour's own start, so contour 2 opens relative
    to where contour 1 began, not to the origin).
- **BOARD 2 FIRST: on that board `SCREENSHOT` reads the SHADOW FRAMEBUFFER, not the panel, so a
  capture is correct by construction even when the glass is wrong.** Everything in this bullet is
  about board 1, where `readRect` really does read the panel. Do not use a board-2 capture as
  evidence about colour — use `COLORTEST`. See the verification trap under Two boards; it cost this
  repo nine tasks of misplaced confidence. (`SCREENSHOT` is also 0.4s on board 2 against ~18s here,
  because native USB CDC replaces the CH340.)
- **The device screenshots ITSELF, and the panel really can be read back.** `SCREENSHOT` (via the
  command-trigger file) reads the framebuffer with `readRect()` and ships it as base64 RGB565;
  `finishShot()` in `host/index.mjs` rebuilds it and writes a PNG straight to `~/Deckhand-shots/`
  (zlib is in node and a PNG is four chunks, so no external encoder and no intermediate file).
  `TAB 0|1|2` and `PAGE 0..3` switch what is displayed first, because the capture path can only
  record what is currently on the glass - without them every screenshot is of whatever tab someone
  last touched. 240x320x2 = 153,600 bytes -> ~205KB of base64 -> **~18s at 115200**, measured. Nothing is blanked
  or redrawn while it runs, so the capture is exactly what was on the glass.
  Two measured facts underpin it, and the second cost a wasted capture:
  - **Readback works.** The FAB note says it is unreliable here; that is a SPEED argument about
    per-pixel reads for transparency, not a correctness one. Four known colours written and read
    back on this wiring came back bit-identical at `SPI_READ_FREQUENCY 20000000`.
  - **`readRect()` returns pixels BYTE-SWAPPED and `readPixel()` does not.** Writing `0xF800`
    yields `readPixel=0xF800` but `readRect=0x00F8` - the same internal order sprites use, and the
    same trap `pushImage` set for the crab art. The firmware un-swaps before encoding so the wire
    format is plain big-endian RGB565. The failure is nasty because it is not obviously a failure:
    the first capture was a perfectly sharp, correctly-laid-out screenshot with purple text where
    near-black belonged.
- **The standalone screen (`drawWaitingScreen()`) — what shows before the host has ever spoken.**
  The ship's-wheel mark turning, the wordmark, the device's own name, a state line, and the
  command to run on a Cozette panel. It is the first thing anyone sees, and three things about
  it are load-bearing:
  - **The old instruction was a command that RELIABLY FAILS.** It read "Run host/index.mjs on
    your Mac" — the exact thing macOS TCC SIGABRTs the moment noble touches CoreBluetooth. The
    screen now says `open DeckhandBLE.app`. Anything added here has to be a command that works
    from a fresh checkout, not the shortest way to describe the file.
  - **It only ever claims what the device can actually KNOW, and the cable is not on that list.**
    There is no VBUS-sense pin and `usbLinkActive()` keys off received bytes — which are zero
    until the host runs — so "USB connected" is unknowable here and is never stated.
    `bleConnected` and the NVS pairing store are real, and every branch derives from those:
    a live BLE link or a recent `lastRxMillis` means the host demonstrably EXISTS, so those
    branches say "waiting for the next/first update" and offer **no** command — telling someone
    to launch an app that is already running is the failure mode this replaced. The recent-RX
    branch is what makes `RECAL` and a mic test honest, since both reset `everReceived` while
    the host keeps ticking. A Mac is named only when exactly one is paired: `activeHost` is
    still -1 until a payload arrives, so with several the device genuinely cannot tell which is
    yours.
  - **`firstEver` had to start CLEARING the content area.** The tab's static chrome only paints
    its own boxes, so a 64px mark, a wordmark and a command panel survive underneath it. The old
    two lines of text sat inside card 1 and were mostly overdrawn by luck; at this size the
    residue is guaranteed.
  It lives on USAGE (`waitingScreenVisible()`), because `renderUsageTab` bails on `!everReceived`
  and that tab would otherwise be empty card outlines. SETTINGS stays reachable and useful while
  waiting — it shows the link and pairing state, which is exactly what you want when nothing is
  arriving.
- **The logo (`DeckhandLogo.h`, generated by `logo2c.py` from `docs/logo.svg`) — FOUR LAYERS, so
  the wheel can turn while the hand holding it stays put.** This is the one piece of art in the
  sketch that keeps its **own colours** rather than being tinted, because it is the project's mark
  and not a status glyph — so it deliberately does not go through `blit2bpp`. The split comes
  straight from the SVG's own paint order: `LOGO_BG` (96x96 RGB565: the tile gradient plus the arm
  and palm BEHIND the wheel), `LOGO_TILE` (2bpp rounded-rect silhouette), `LOGO_WHEEL` (2bpp x8,
  the only thing that moves) and `LOGO_FG` (2bpp, the four fingers wrapping IN FRONT of the rim).
  ~41KB of flash.
  Three implementation facts are load-bearing:
  - **Composed and pushed ONE ROW at a time** (`static uint16_t row[96]`, 192 bytes). A whole frame
    is 18KB against ~70KB of free heap after the BLE stack, and per-pixel `fillRect` is hopeless
    here because the tile is a **gradient** — runs of equal colour average 2–3px, so a frame would
    cost thousands of calls instead of 96. This is also the one place `pushImage` is used against
    the screen, so it sets `setSwapBytes(true)` (and restores it): `row[]` holds ordinary RGB565.
  - **`LOGO_BG` is generated with SQUARE corners on purpose, and `LOGO_TILE` does the shaping.**
    Baking a page colour into the art would put a hard square of the wrong shade behind the mark
    under one of DARK/LIGHT — and it is a coin flip which. Fading the corners through the tile mask
    into the live `COLOR_BG` is what makes one copy of the art correct in both themes.
  - **Not 8 pre-composited full-colour frames**, which would be 147KB against 41KB, for art on a
    screen you rarely see. The hub is punched out as a hole so the tile shows through it; the
    source paints it `#1B5FA6` against a gradient reading ~`#2F76B8` there, which across a ~3px dot
    is not a difference anyone can see, and a fifth layer for it would be.
  **The rotation step is 60/8 = 7.5°, and that is forced — do not "tidy" it to 45.** The wheel has
  EXACT 6-fold symmetry (three spokes drawn as full diameters give six arms; six grips at
  0/60/…/300), so a 60° turn is a no-op: 8 frames at 45° would neither loop seamlessly (45 does
  not divide 60) nor complete a cycle, and 8 at 60° would emit 8 identical frames. This is the
  hazard `codex2c.py` flags as hypothetical for its own mark; here it is real, because these arms
  are `use` clones rather than hand-drawn lobes. Only the WHEEL layer rotates - spinning the hand
  too would turn the arm upside down. The generator refuses to emit a static cycle,
  since a dead-still wheel on a waiting screen reads as a hung device — the one thing the
  animation exists to rule out — and it **measures motion rather than comparing frames for
  equality**, which is the difference between a guard and a decoration: a rotation that is a
  visual no-op still leaves frames differing by rasteriser sub-pixel noise, so an equality test
  can miss it. **The threshold is resolution-dependent and must be re-measured if the size or the
  art changes** — at 96x96 the real 7.5° step moves at least 0.161 mean absolute alpha (units of
  0–3) against frame 0, where at 64x64 the same step measured 0.371, so it is not a constant to
  copy around. `MIN_MOTION` is 0.05: ~3x under the signal, and above the noise. Proven by running
  it — forcing a 60° step exits 1.
  The tick is `tickWaitingWheel()` at 250ms (one turn every 2s), gated on
  `waitingScreenVisible()` and deliberately not touching `lastNonIdleMillis`.
- Easter egg: 5 taps on the footer within 4s summons **Clawd** — the real crab-walk sprite
  animation. 20 frames of 51x36 in `ClawdCrab.h`, **generated** by
  `firmware/deckhand_display/crab2c.py`; the source frames (`CrabFrames.swift`)
  are **not** kept in the repo, so `ClawdCrab.h` IS the art now — to change it, supply the frames
  again and run `python3 crab2c.py <frames> > ClawdCrab.h`. PNG alpha is composited
  against `COLOR_BG` **at build time**, then the frames are **RLE'd as (palette index, run length)
  pairs** with runs never crossing a row. That RLE *is* the draw format: `drawCrab` turns each run
  straight into one `fillRect`, so nothing is decompressed into RAM, the art is 21KB instead of
  37KB (RGB565 raw would be 73KB), and a frame costs ~527 draw calls instead of 1836 pixels.
  Palette entry 0 is `COLOR_BG` and is skipped, since the target was just cleared. Drawn into a
  `TFT_eSprite` (240x108, ~51KB, returned on exit) pushed whole — the one sanctioned full-region
  redraw, since sprites can't flicker — with a direct-draw fallback, and `octoActive` gates
  `handleLine`'s draw path while data keeps flowing.
  **Two TFT_eSPI traps caused real bugs here, both silent — use `fillRect`, not `pushImage`, when
  drawing generated art:** (1) `pushImage` takes a raw buffer whose byte order depends on the
  target's `swapBytes` flag, and **a sprite stores its pixels byte-SWAPPED internally**
  (`TFT_eSprite::drawPixel` does `color>>8 | color<<8`; `pushSprite` then pushes with
  `swapBytes=false`) — getting this wrong is what made the colours come out wrong. `fillRect`
  takes an ordinary `0xF800`-style colour and handles the internal representation itself, so it is
  correct on both a sprite and the screen with no flag juggling. (2) **`pushImage` is NOT virtual**
  — only `drawPixel`/`drawChar`/`readPixel`/`setWindow`/`pushColor` are — so through a `TFT_eSPI&`
  reference it binds to the SCREEN version and bypasses the sprite entirely; that's why the crab
  was invisible at first. `drawCrab` is **templated on the target type** so the right overload
  resolves at compile time. The old procedural art only worked because `fillRect`/`drawCircle`
  route through the virtual `drawPixel`.
- **`firmware/tft_setup/User_Setup.h` is BOARD 1 ONLY.** Board 2 does not link TFT_eSPI at all
  (`BOARD_USES_TFT_ESPI 0`), so nothing in that file affects it and copying it into the library is
  not part of a board-2 setup.
- **TFT_eSPI's pin/driver config now lives in THIS REPO at `firmware/tft_setup/User_Setup.h`**, and
  is copied into the library. TFT_eSPI reads it from a file *inside the library*, so it used to
  exist only there - which meant reinstalling or updating TFT_eSPI silently wiped the board's pin
  mapping, with no record of it anywhere in the repo. Restore a local machine with:
  `cp firmware/tft_setup/User_Setup.h ~/Documents/Arduino/libraries/TFT_eSPI/`
  The committed copy is byte-identical (comments aside) to the one that builds today, and the only
  file ever modified inside that library is this one - `User_Setup_Select.h` is stock and includes
  `User_Setup.h` by default, which is what makes the drop-in work.
- Colors deliberately avoid a green/yellow/red scheme (the `COLOR_GOOD`/`WARN`/`BAD` constants
  use a blue/orange/reddish-purple palette instead) because a green/yellow/red scheme collapses
  under the most common colour-vision deficiency, and status is never conveyed by color alone.
  **WHAT THE SECOND CARRIER IS DIFFERS PER BOARD, and this sentence named only board 1's.**
  On **board 1** it is `drawStatusDot`'s shape: filled circle = working, filled square = asking,
  hollow ring = waiting. On **board 2** that same function draws the **agent mark at every
  status** — §5 of the sessions redesign spent the indicator's shape on saying WHICH AGENT,
  because status already owns the colour — so the shape there separates Claude from Codex and no
  longer separates one status from another. The carrier is the **status pill's FORM** (filled /
  outlined / boxless dim text) on every ordinary row, and on the **expanded band card**, which
  draws no pill and no indicator at all, it is the **status WORD** from `labelForStatus`. Both
  substitutes are asserted in `sessions-geom-check.mjs` — the pill's form, and the three words
  being distinct — because each is now the only thing standing between two states. The longer
  note under the "working" spinner further down says the same thing from the animation's side.
- **The theme control has THREE modes - DARK, LIGHT and AUTO - and AUTO is a CLOCK, not a
  sensor.** This board has no light to measure: every ADC1 channel is spoken for (touch on
  32/33/36/39, battery 34, mic 35) and ADC2 is unusable while BT is up, so an LDR would need
  hardware that does not exist. AUTO therefore keys off `hostNowSec()` - LIGHT from
  `THEME_LIGHT_FROM` (07:00) to `THEME_LIGHT_TO` (19:00), DARK otherwise. That clock comes from the
  host but advances from `millis()` once a base has been set, so AUTO keeps working while the Mac
  is away or asleep. With no clock at all it resolves to **DARK** - the device boots before the
  host connects, and a full-white screen is the worse thing to guess wrong at 3am.
  `themeMode` (what the user chose) is now distinct from `themeIndex` (which palette is live); in
  AUTO the second is derived from the first. Both share the existing `"theme"` NVS key, so an
  install that stored 0 or 1 still reads back as DARK or LIGHT and only 2 is new.
  Three things are load-bearing:
  - **`tickAutoTheme()` defers while any full-screen surface is up** - the reader, history pager,
    session detail, voice card, crab, or sleep. Switching palettes forces a full repaint, and doing
    that under something the user is reading would wipe it. It re-checks every 30s, so the switch
    simply lands when they return to a tab; a threshold crossing happens twice a day and being 30s
    late costs nothing.
  - **The control is a `uiButton`, not a `uiToggle`** - three states cannot be a boolean. It cycles
    DARK -> LIGHT -> AUTO and shows the mode it is in, keeping its neighbours' convention: filled
    and accented once off the default, outlined and grey while on it.
  - **It needed its own `themeBtnCache`, and that cache MUST be reset in `resetSettingsCaches()`.**
    It used to be drawn inside the flip toggle's cache block, which worked only because the sole
    thing that changed it was a tap that forced a full repaint anyway. AUTO breaks that assumption -
    it changes the palette on a timer with no tap involved - and an unreset cache leaves the button
    BLANK after a page repaint, which is the same trap `drawSettingsStatic()` already documents.

- **DARK and LIGHT themes, switchable on-device and persisted in NVS.** The nine `COLOR_*`
  tokens (`COLOR_BG`/`CARD`/`LABEL`/`VALUE`/`ACCENT`/`GOOD`/`WARN`/`BAD`/`UNKNOWN`) are no longer
  `const` — they're plain globals rewritten from a `THEMES[]` table by `applyTheme(uint8_t)`. They
  kept their original names and stayed globals deliberately: those nine names are referenced 385
  times across this sketch, so a whole theme system costs zero changes at those call sites.
  **A theme switch MUST call `forceFullRepaint()`** — every change-only cache in this sketch keys
  on CONTENT (`drawIfChanged` on the text it's given, `drawPaceBar` on `(pct, tick)`), so a
  colour-only change is otherwise skipped entirely and the screen keeps the old palette.
  `firmware/deckhand_display/palette-check.mjs` is the authority on both palettes: it checks text
  contrast AND that the status trio (`good`/`warn`/`bad`) stays separable both for a deuteranope
  approximation and in flat greyscale, and its `--selftest` flag proves the checker has teeth by
  feeding it a deliberately broken palette it must reject. This caught a real near-miss: the first
  LIGHT candidate passed every contrast check but failed separability, with luminance gaps of only
  4%, 1%, and 5% between its three status colours — indistinguishable in greyscale despite looking
  fine in colour. DARK deliberately keeps its own sub-AA `good`-on-`card` contrast (3.38, below the
  usual 4.5 body-text threshold) because that pair is a pill fill and bar segment, not body text,
  and the palette was chosen with that trade-off in mind rather than by accident.
  `drawCrosshair()` draws in `COLOR_VALUE` rather than literal `TFT_WHITE`, because under LIGHT
  (near-white background, near-black value) a literal white crosshair would be invisible and
  touch calibration would become impossible to complete. The crab easter egg deliberately does
  NOT theme its art: `ClawdCrab.h`'s alpha is composited against black **at build time**, so its
  anti-aliased fringe can't follow a theme. Its background isn't hard-coded to DARK, though —
  `startOctopus()`/`renderOctoFrame()` clear with the **live** `COLOR_BG`, and `drawCrab()` skips
  palette index 0 (the build-time black) rather than substituting the live background — so under
  LIGHT the crab appears on the light-grey background with a dark anti-aliased fringe around it,
  not on a dark background.
- If Bluetooth permission ever gets stuck (the process crashes again after previously working,
  usually after iterating on `DeckhandBLE.app`'s signature), reset the cached TCC decision with
  `tccutil reset BluetoothAlways com.deckhand.ble-host` before assuming the code is broken.
- `DeckhandBLE.app` embeds a literal copy of `node` + `libnode.147.dylib`, so it's tied to whatever
  Homebrew node version was current when it was built. After `brew upgrade node`, re-copy both
  files into `host/DeckhandBLE.app/Contents/MacOS/` and re-run
  `codesign --force --deep --sign - host/DeckhandBLE.app`. The bundled files are mode 444, so
  `rm` them first — `cp` onto a read-only destination fails. This has actually bitten: node moved to
  26.7.0 (needing `libada.4.dylib`) while the bundle still referenced `libada.3.dylib`, and the app
  died at launch with a DYLD "Library missing" crash and no log file. The re-signed bundle keeps its
  Bluetooth permission (identifier `com.deckhand.ble-host` is unchanged), so no `tccutil` reset is
  needed for a straight rebuild:

  ```
  cd host && NODE=$(readlink -f $(which node))
  rm -f DeckhandBLE.app/Contents/MacOS/{Deckhand,libnode.147.dylib}
  cp "$NODE" DeckhandBLE.app/Contents/MacOS/Deckhand
  cp "$(dirname $(dirname $NODE))/lib/libnode.147.dylib" DeckhandBLE.app/Contents/MacOS/
  codesign --force --deep --sign - DeckhandBLE.app
  ```
