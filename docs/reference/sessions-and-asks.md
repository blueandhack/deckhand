# Session rows, the detail screen, asks and the keyboard

> Extracted verbatim from CLAUDE.md. **The measurements are the point** - they were
> taken on real hardware at a specific commit, so do not paraphrase or "tidy" them.
> If you change the behaviour, change the number and say what you measured.

Index: [`docs/README.md`](../README.md). The rules an agent must not miss stay in
[`CLAUDE.md`](../../CLAUDE.md).

---

- **BOARD 1 HAS THE STATUS BAND CARD NOW, DERIVED FROM ITS OWN CELLS.** It was board 2's
  alone, and the sentence explaining why - "board 1 has no surplus height to give" - was
  false: its list area is 264px and its tallest ordinary row is 90, so ONE session (69% of
  9,452 measured ticks) drew a 90px row and then **174px of empty tab, 66% of the tab**,
  against the 48% that motivated the card on board 2. The zeros were a consequence of
  `sessionExpCandidateH()` living inside `#if !BOARD_USES_TFT_ESPI`, not of the arithmetic.
  The port is ONE implementation reading two headers: the guards in `sessions.ino` were
  widened rather than a board-1 arm copied in.
  - **The blocks, and how the leadings were derived.** Each block is one line of INK plus
    its leading. Board 1's ink is fixed by its faces (name 26, every body line 13, a rule 1)
    and comes to 145px for the full stack; the band takes 34 of the 264, leaving 230, i.e.
    **85px of leading to distribute against board 2's 122**. Each block therefore takes
    board 2's own leading scaled by 85/122 = 0.697 and floored, which spends 77 and leaves
    8px outside the card as list area. The reason board 1 is *tighter* than a proportional
    scale is that **its name is not scaled**: the hero rung's 26px cell stays, which is 2px
    MORE than board 2's head-rung name on a panel with 64% of the height.
    band 34 + name 32 + sub 24 + title 2x15 + rule 12 + LAST PROMPT 21 + prompt 4x18 +
    rule 12 + path 15 + pad 4 = **`SESSION_EXP_MAX_H` 256**, with
    **`SESSION_EXP_MIN_H` 220** the same stack at `PROMPT_MIN`.
  - **The band is 34 because the MARK does not scale.** Board 2's 44 is `TAB_BAR_H` less the
    card's border, which here would give 32 - but `drawAgentMark` is a 32x32 blit on both
    boards, drawn on the card interior, so `SESSION_BAND_H - BORDER_CARD >= SPARK_SIZE`
    binds instead. The mark sits FLUSH in the band's 32-row interior with no clearance
    either side. Seen on the glass: band rows 40..71, mark ink reaching both.
  - **THE BAND CANNOT CARRY THE MARK *AND* THE FULL STATUS PHRASE, and that is measured.**
    The word lane is `ROW_W - 2*BORDER_CARD - 2*PAD - SPARK_SIZE - MARK_GAP - DUR_CHARS*ADV
    - 1` = **141px** on board 1 against 199 on board 2, and `labelForStatus`'s
    "NEEDS YOUR INPUT" inks 16 x T_HEAD's 10px advance = **160**. Clearing it would need
    `2*SESSION_BAND_PAD + SESSION_BAND_MARK_GAP <= 9`, so no pad this card can afford
    closes it. The mark stays - it is the card's only agent carrier and its only motion,
    since the row indicator is skipped there - and `bandStatusWord()` **measures** and drops
    to `shortLabelForStatus()`, the words board 1's own tall-row pill already draws:
    WORKING / NEEDS INPUT / READY, longest 110 of 141. Board 2 never takes that branch.
    One mechanism on both boards, not a second vocabulary; the pill's two literals moved
    into that function so there is one table rather than two.
  - **THE LADDER: board 1's card is a ONE-session behaviour where board 2's is one-to-two.**
    `leftover = 264 - (n-1)*(rowH + 3)` against the 220 floor: **1 -> 256 (the cap)**,
    2 -> 171, 3 -> 86, 4 -> 66, 5 -> 52, 6 -> 44, all refused. At two sessions the ladder
    gives both rows their 90px cap and 171 is left; a card there would have 137px for a
    186px body - no leading and no rules, the "card of air" the design forbids. Refused
    deliberately, and the **81px of trailing air at two sessions is the accepted cost**, not
    a regression: it is the ladder's own `SESSION_ROW_H_MAX` and predates this work.
  - **The spine is 5px, not board 2's 6, and it is STATIC.** `SESSION_DOT_CX - SPARK_SIZE/2`
    is x=15 and the spine starts at x=10, so its ink must end at 14 - at 6 its last column
    would be erased by the indicator blit four times a second, the defect board 2 measured
    at 17 pixels. The Codex knockout's period is `ON 6 + OFF 4 = 10` against a straight
    section of `rowH - 22`, so **two gaps need rowH >= 42**: board 1's 41px (five sessions)
    and 38px (six, under the "+N more" strip) rungs carry ONE. Unfixable rather than
    untried (ON > `SESSION_SPINE_W` and OFF >= 2/3 of it give P >= 10 on a 5px spine) and
    unreachable in practice - 5 and 6 sessions are 0 of 9,452 ticks. `sessions-geom-check`
    asserts two gaps on every rung reachable at four or fewer sessions and one below that.
  - **NO SHIMMER, NO CROSSFADE, NO PULSE ON BOARD 1**, deliberately and by name.
    `SESSION_SHIMMER_*` and `SESSION_PULSE_MAX` do not exist in `board_e32r28t.h`. Board 2
    composes into a PSRAM shadow framebuffer and flushes once, so a travelling light rides a
    flush that was happening anyway; board 1 draws STRAIGHT TO THE GLASS, where the same
    animation is a per-frame repaint with no flush to hide behind and no `PERF` command to
    measure it with. `sessionXfadeT`/`sessionPulseA`/`sessionBandFill` are three
    `static inline` stubs there, so `drawSessionBand`'s source text is identical on both
    boards and its fade terms fold away. **The band's MARK still animates on board 1** -
    `tickWorkingSpinner` advances it in place - so the one-session working card is not
    static.
  - **The touch hit test now walks `sessionRowAtY()` on both boards.** Board 1 kept a
    uniform-slot division (`(sy - Y0) / (rowH + GAP)`) while its binary was held
    byte-identical; with a 256px first row that division reports the wrong session for
    every tap below the card. `SESSION_ROW_SIG_LEN` also grew 176 -> 304 there, because the
    band card signs its prompt and path - 768 bytes of DRAM, the price of the card.
  - **Seen on board 1's REAL PANEL** (`SCREENSHOT` reads the glass on board 1, unlike board
    2's framebuffer read), 2026-09-05, LIGHT, one working session: band 38..71 with the
    mark, `WORKING` and `54s`; name ink 77..94; sub 105..116 with the Mac icon
    right-anchored at x=207; title 129..140; rule at 148; `LAST PROMPT` 157..164; four
    prompt lines at 177/195/213/231; rule at 253; path 261..272; card border 38..279.
    Every one of those is the model's own number - **except that `uiStrokeRound` paints the
    bottom border one row BELOW `y + rowH - 2` on this board**, so a 241px card's ring lands
    at 278..279 rather than 277..278. That is pre-existing (an ordinary 63px row does the
    same, and the extra row falls inside `SESSION_ROW_GAP`), and it is written down here
    because it cost half an hour of believing the card was 242px tall.
    `MULTITEST` at 2, 3 and 4 sessions confirmed the ladder on the glass: two 90px rows,
    three 86px rows and four 63px rows, spines visible on each, and **no band card at any
    of them**.

- **The session DETAIL screen is laid out by a running cursor, and its extra text all
  comes from the same transcript read.** It USED to carry name, title, status pill (with
  `for 12m - 14:31` beside it), LAST PROMPT, PATH, and then MODEL/GIT BRANCH and
  STARTED/AGENT as **paired columns** rather than a four-row ladder — the pairing is what
  bought room for the new text without a taller card. **That is the card §7 replaced on
  BOTH boards; the paragraphs below it are kept because their reasoning is still what the
  current card rests on, and the "§7 IS NOW BOTH BOARDS' CARD" note says what changed.**
  Offsets are a `cy` cursor, not the
  hand-derived `cardY + 78 / +120 / +158` constants it used to have; those had to be
  re-derived by hand whenever a field moved, which is how the screen drifted sparse.
  Where the values come from: `lastPrompt` and the title from the **same 64KB tail** as
  the model, the start time from the transcript's **birthtime** (deliberately not a new
  hook field — that would need reinstalling into `~/.claude` before it did anything),
  last-active from the record the host already has. Times ride as **seconds since local
  midnight**, never an epoch — `long` here is 32-bit and a ms epoch overflows it, the same
  trap that silently broke the voice card — with **-1 meaning "not today"**, drawn as
  "earlier" instead of a time from another day masquerading as this one.
  Three things are load-bearing, and two of them are the same silent bug:
  - **A change-only cache shorter than the string it stores stops noticing changes.**
    `drawIfChanged` compares `cacheSize` bytes, so `detailDurCache[16]` holding a 22-char
    `"for 12m - 14:31"` never compared the trailing clock — the time would have frozen
    while the duration beside it kept ticking. Same for `detailSigCache[208]` against a
    signature that now runs to ~327 chars: edits past that point would never repaint.
    Now 28 and 352. **Any new field must have its cache checked against its padded
    length.**
  - **The detail signature must include `title` and `prompt` but NOT `actSec`.** The first
    two are drawn on the static card, so omitting them means a new prompt never repaints
    the screen you are reading. `actSec` changes on every event, and a full card repaint
    per tick is exactly the flicker the discipline exists to prevent — it reaches the
    screen through `renderDetailDuration`'s own per-second cache instead.
  - **Last-active appears ONCE, beside the pill.** It was briefly also a STARTED/LAST
    ACTIVE column pair, which both said the same thing twice and created a field that
    could only update by repainting the whole card. The column pairs with AGENT instead,
    and both of those never change for a session.
  **§7 IS NOW BOTH BOARDS' CARD. The pill, the `for 12m - 14:31` line and BOTH column
  pairs are gone from BOTH — §7 of the sessions redesign heads the card with the same
  status band the sessions tab's first row wears (44px on board 2, 34 on board 1) and
  closes it with ONE dim `T_META` line.** The `#if BOARD_USES_TFT_ESPI` arms in
  `drawSessionDetail` and `renderDetailDuration` were WIDENED rather than copied into, so
  the card is one implementation reading two headers; `DETAIL_PAD_Y`, `DETAIL_PILL_STEP`,
  `DETAIL_COL_LBL_STEP`, `DETAIL_COL_VAL_STEP`, `pillLabel()`, `drawColValue()` and
  `detailPillY` are all deleted, and `s.agent` joined the detail signature on board 1 too
  (the band's MARK is the only thing on that card that now says which agent it is).
  **Board 1's own numbers, derived in `board_e32r28t.h` and never chosen:**
  `DETAIL_CARD_H` **224 → 210** and `DETAIL_AIR` **0 → 5**. The ceiling its footer sets is
  **211**, so the old 224 was 13px OVER it — that is the defect two `KNOWN[1]` entries
  recorded (the "answer this one on your Mac" line invisible under the history hint), and
  it is fixed by the card shrinking. `DETAIL_AIR` is the scaled leading budget: the ink is
  162px, the ceiling leaves **47px** of leading against board 2's 66, every boundary is one
  term in `6*AIR + 14`, and `6*5 + 14 = 44` is the most of the 47 that fits (AIR 6 needs 50).
  The band's word lane on board 1's detail card is **133px**, not the 141 of its own list
  row (the card is 8px narrower than the row), and `bandStatusWord()` lands on the same
  `WORKING / NEEDS INPUT / READY` there — asserted, so a card narrow enough to shorten a
  word the tab still spells out fails by name.
  **The meta line's THIRD fact is dropped by MEASUREMENT, not by a board flag.** `metaFacts()`
  composes `model - branch - HH:MM`, the caller measures it against the lane the Mac cluster
  leaves and recomposes without the clock if it does not fit — the same compose-measure-fall-back
  `bandStatusWord()` uses. Board 1's lane is `216 - 2*14 = 188` at `TEXT_ADV` 6; with a second
  Mac up the cluster costs `8 + 13 + 4 + 7*6 = 67`, leaving 121 against a 126px three-fact
  line, **over by 5** — so it carries two facts there and three when only one Mac is
  connected. **SEEN both ways on the glass**:
  `shot-2026-09-05T14-28-28-Deckhand-0528.png` (`opus-5 - compose-surface`, the clock dropped
  because the branch is 15 characters) and `shot-2026-09-05T14-31-57-Deckhand-0528.png`
  (`opus-5 - main - 07:30`, all three). Board 2 keeps three at its 260px lane (168 + 84 = 252,
  8 to spare) and drops the clock on a long branch for the same measured reason —
  `shot-2026-09-05T14-28-11-Deckhand-C114.png`. Which board is FORCED to give one up is
  pinned by `DETAIL_META_FACTS` in `sessions-geom-check.mjs`, the way `BAND_WORDS` pins the
  status words. **Board 1 has no shimmer, crossfade or pulse** — `sessionXfadeT()`,
  `sessionPulseA()` and `sessionBandFill()` are `static inline` stubs there, so the shared
  band text folds to `t = -1` and a flat fill at compile time.
  **On board 2:** The band carries the agent MARK, the status WORD at `T_HEAD`
  and the duration; the meta line carries `model - branch - <status-since HH:MM>` on the
  left with the Mac's icon (and, with a second Mac up, its tag) right-anchored to the
  card's text edge. `DETAIL_CARD_H` went 326 → 330 → **300** across the two tasks and
  `DETAIL_AIR` 4 → **8**. Six things about it are load-bearing:
  - **THE CARD'S CEILING IS 331 AND IT IS DERIVED, SO 350 WAS NEVER AVAILABLE.** §7 asked
    for ~350. Both the "answer this one on your Mac" line and the history hint are
    `MC_DATUM` `T_META`, and `drawString` centres on the ASCENT while painting a box
    ascent+descent tall — so the answer line at `cardY + H + 8` inks `H+98..H+113` and the
    hint at `contentBottom() - 10` inks `444..459`. They collide **at H = 331**, so 330 is
    the largest legal card. `sessions-geom-check.mjs` derives that number from the hint,
    asserts `DETAIL_CARD_H` against it rather than against a literal, and PRINTS it.
    Measuring the BASELINE instead of the box is what once put the header's own comment 3px
    low.
  - **The band costs MORE than the pill it replaces, and the meta line is what paid for
    it.** Band 44, minus the 10px top pad it replaces, minus the 28px pill block = **+6px of
    ink**, on a card that had 4px of slack — which is why task 2 could only reach 330 and
    sat exactly at the ceiling. Task 3's meta line then returned **55px** (four labels and
    four values became one line), and that surplus went where `DETAIL_AIR`'s own note has
    always said surplus should go: around the content (air 4 → 8, six boundaries widened),
    with the rest GIVEN BACK rather than held as blank card. Content ends at `+295`, two
    clear rows above the border, 30px inside the ceiling. A fixed-height card whose blocks
    are optional already looks sparse when a session has no title and no prompt, so holding
    the surplus would have shown as an empty third of the card in the common case.
  - **The band does NOT carry the wall-clock, and §7's prose asks for it.** Measured at this
    board's real geometry: `4m - 09:34` is 10 characters at `TEXT_ADV` = 80px, which leaves
    the word 144px against a `NEEDS YOUR INPUT` that inks **192** — a collision of 48. The
    band's duration lane is a fixed 3 characters (`SESSION_BAND_DUR_CHARS`) for the same
    reason, and the checker asserts that lane on THIS surface so re-adding the clock fails
    rather than merely looking cramped.
  - **`started` IS DROPPED, and that is what buys room for the Mac.** In the 260px lane at
    `TEXT_ADV` 8, `model - branch - HH:MM` is 21 characters = 168px and the Mac cluster is
    84, fitting with 8px to spare; restore `started` and the same line is 29 characters =
    232, i.e. **316 against 260**. Both halves are asserted, the second deliberately — it
    encodes WHY the field is absent, so a future reader who re-adds it fails there instead
    of shipping a clipped line.
  - **The clock is the STATUS-SINCE instant, NOT `s.actSec`, and that is the only reason it
    can be a static field.** `actSec` advances on every event while nothing else on the card
    does, so drawing it here would freeze silently between repaints, and putting it in the
    signature would repaint a 296x300 card every 5s — the two failures this screen's rules
    already name. `hostNowSec()` minus the elapsed time is stable to within the ±1s two
    independent `floor(ms/1000)` terms can disagree by, and `status` is already in the
    signature. `s.agent` had to JOIN the signature, board 2 only: the band's mark is drawn
    from it and nothing else on that card carries the agent any more.
  - **THE BAND ON THIS CARD WAS COMPLETELY STATIC, AND THE FIX IS A THIRD TICK.** Both
    existing ticks early-return on `showingDetail`, so on this screen nothing repainted the
    band AND `animPhase` never advanced — which is why it was fully dead rather than merely
    slow: the ~5s host tick does repaint the card, but the phase it draws was frozen too.
    The mark sat still two taps from an identical band that turns, so the screen read as
    broken rather than as a deliberate difference. **Found on the glass**, like everything
    else on this card. `tickDetailBandAnim()` (sessions.ino, board 2 only, called from
    `loop()` between the two existing ticks) now advances the mark, the crossfade and the
    pulse at the DETAIL card's own coordinates. It is a third tick rather than a relaxed
    gate on the other two, and that is the safety argument rather than a preference: those
    two paint at the sessions LIST's coordinates — a band at `sessionRowYAt(0)`, a shimmer
    down every row — so letting them through here would paint the list's geometry on top of
    a full-screen card. Measured afterwards: **219–235 of the mark's 1024 pixels differ
    between captures**, where before it was frozen. **That is FRAMEBUFFER evidence, not the
    panel** — board 2's `SCREENSHOT` reads the shadow buffer (see the verification trap under
    Two boards) — which is the right instrument for this particular question: what was frozen
    was the renderer's own `animPhase`, so "the composed frame now changes" IS the claim. It
    says nothing about how the mark looks on the glass, and the original report came from a
    person watching the device.
  - **`showingDetail` IS ALSO TRUE ON THE ASK SCREEN, which has no band at all.** It is set
    in one place and the ask screen is drawn through the same entry point
    (`drawSessionDetail` hands off to `drawAskDetail` on `askPid`), so a tick that trusted
    `showingDetail` would blit a 32x32 spark into the middle of an Allow/Deny screen.
    `detailBandVisible()` asks `askPid` the same way `drawSessionDetail` and
    `renderDetailDuration` already do, and refuses every other full-screen surface too —
    **the keyboard in particular runs with `showingDetail` still true**, which
    `closeKeyboard()`'s own note records. Verified: 0 differing pixels in the band's mark
    box across 25s of a live ask screen, while 71 changed elsewhere on the same frame.
  - **The card used to CLEAR `xfadeId` before painting its band, and that line is now GONE —
    the same defect wearing its own fix.** It was correct for as long as nothing advanced a
    fade here: `handleLine()` starts a fade and repaints this card in the SAME tick, before
    `loop()` reaches `tickSessionAnim()`'s clear, so the band was painted at frame 0 of a
    fade nothing would ever advance and STAYED there — "WAITING FOR YOU" and "WORKING"
    superimposed at half strength each, on a card already wearing the new status colour in
    its border. With `tickDetailBandAnim()` advancing it, clearing on every card repaint
    would abort every fade on its FIRST frame instead. `tickSessionAnim()` still clears for
    every other reason it is gated out; only the detail card is exempt. **The old
    assertion's inverse is asserted now**, and it depends on `fnSrc` stripping comments,
    because the forbidden line is quoted verbatim in the comment that replaced it.
  - **The band's duration had to stop reading `bandFillShown` and re-ask `sessionBandFill()`,
    for a reason its own comment stated.** That comment justified the record with "HERE
    nothing repaints it at all (`tickSessionAnim` and `tickWorkingSpinner` both early-return
    on `showingDetail`), so the record is exact" — which stopped being true the moment
    something did. With the band animating under it, the record is a frame old mid-fade and
    that field paints an OPAQUE box in it. It now takes the sessions tab's own trade,
    spelled out at that call site: bounded by one step of the ramp, self-healing at the next
    reconcile.
  - **The pulse is reachable on this card only for an `asking` session with NO ask object**,
    since one with an `askPid` is drawn as the ask screen, which has no band. It is written
    anyway rather than left out: the alternative is a band that breathes on one surface and
    not on the other for a state that can reach both.
  **The four §7 defects the mockup round found, recorded as FOUND-AND-RESOLVED rather than
  quietly rewritten.** §7 was the one surface never visually reviewed before its spec was
  written, and it says so; mocking it at the real geometry is what turned that caveat into
  four measured numbers. (1) The band cannot hold word + duration + wall-clock — the word
  lane is 144px against a 192px `NEEDS YOUR INPUT`, over by 48. (2) The same defect seen
  from the other end: the meta line cannot hold `started` either once the Mac is on it — the
  mockup measured 312px in a 268px lane, and the shipped assertion, taken at the card's real
  `CARD_W - 2*PAD`, is **316 in 260**. The two disagree by the 8px the mockup gave the lane, which
  is worth knowing rather than smoothing over: the mockup was right about the collision and 8px
  optimistic about its size, and the number to trust is the one the checker derives. (3) §7 absorbs the AGENT column into the band and never
  says where the MAC goes — and it cannot go in the band, where even the icon alone leaves
  the word 4px short. (4) The TYPE chip was sized to `TAP_MIN` against a tap zone it never
  provided. All four were shown measured AND rendered, and the resolutions chosen were: band
  = word + duration, meta line drops `started`, Mac on the meta line, chip 76x26. **A spec
  that reads as though it were right all along teaches nothing** — the transferable part is
  that a layout described in prose at one board's geometry produced four collisions at
  another's, and that rendering it is what found them.
- **The session TITLE is a third row line, and it comes from the transcript, not a hook.**
  Claude Code writes `{"type":"ai-title","aiTitle":...}` records into the session
  transcript (and `custom-title` if you named the session yourself) — no hook event
  carries it. `transcriptInfo()` pulls the title and the model out of the **same 64KB tail
  read**, so this costs no extra I/O per session per tick; a `custom-title` outranks an
  `ai-title`, and the newest of each wins so a retitled session updates. Verified on real
  transcripts: all four projects on this machine resolve a title, including a **28MB**
  one, so the tail window is not the practical limit it looks like. If no record lands in
  that window the row simply falls back to the two-line layout.
  The row height cap went **72 → 90** to make space. That is arithmetic, not taste: with
  `avail = 264`, 1–2 sessions land on the cap and 3 comes out at 86, so all three clear
  `SESSION_TITLE_MIN_H` (85) while 4+ stay at 63/50/41 and keep the old layout. 85 is
  itself forced — the sub-line ends at `y+60` and the pill top is `y+rowH-22`, so a
  shorter row would draw the pill over the text.
  **The title MUST be in the row's repaint signature.** Leave it out and the row keeps
  showing a stale title forever, since nothing else about the row changed — the silent
  failure this change-only redraw discipline is prone to. The signature and
  `rowSigCache` grew 96 → 160 because a 40-char title no longer fits beside the rest.
  Codex rows carry no title (nothing in a rollout was verifiable as one) and collapse
  back to two lines. Cost: **+912 bytes of RAM, ~100 bytes of flash.**
- **A long project name SHRINKS one step rather than being cut, and the lane is measured
  rather than counted.** `drawSessionRow` computes the name's available width from what
  actually sits at the top of the row — the `CLAUDE`/`CODEX` tag on tall rows, the status
  pill (`textWidth(label) + 12`) on compact ones — because those labels differ in width
  (`WORKING` is two characters wider than `READY`). It then walks the ladder — 12x26 →
  10x18 → 6x13 — and takes the first whose measured width fits, so a long name is shown
  whole; a shrunk name is re-centred in the 26px band the big font would have filled.
  `fitText()` trims with **three ASCII dots**, since Cozette6x13 is `0x20-0x7E` only and
  U+2026 would draw as a blank box. Three things worth knowing before touching it:
  - **The middle rung had to come from a second font family.** Cozette alone only offers
    6x13 and a mechanical 2x scale of it (12x26) — nothing in between, so "shrink one
    step" used to mean a single hard jump straight from 12px to 6px. `uiTextSize()` now
    returns a registry index rather than a raw 2-or-1 scale factor, and the type-scale
    work added Terminus 10x18 bold as the rung between them, which is why the ladder is
    three steps (12x26 → 10x18 → 6x13) rather than one.
  - **The old fixed 11/12-character cap was both too small and too big.** Measured: compact
    rows had room for 18-20 characters and were showing 11, while a tall row's 12-character
    name ran to x=192 against a `CLAUDE` tag whose left edge is x=184 — **an 8px overlap**.
    Any hardcoded character count reintroduces one or the other.
  - Costs nothing in the redraw discipline: rows repaint wholesale when their
    `name|status|sub` signature changes, so a per-row font size needs no extra cache.
    Measured cost of the whole change: **+288 bytes of flash, zero RAM**.
  The host caps the name at **22** to match what the small font can draw on a tall row
  (`SessionInfo.name` is `char[24]`); sending more would only be trimmed on arrival. Status urgency is encoded as pill
  fill (solid = asking, outline = waiting, boxless dim text = working), consistent with the
  color-never-alone rule.
- The OAuth usage endpoint rate-limits bursty callers (HTTP 429, observed after several rapid
  host restarts). The poller backs off 15 minutes on 429 (persisted to `<runtime dir>/oauth-backoff.json`
  across restarts, honoring Retry-After) — don't "fix" apparent staleness by polling faster.
  **Two** persisted guards keep restarts from bursting the limiter: the back-off above, and a
  last-ATTEMPT timestamp (`<runtime dir>/oauth-attempt.json`, written just before every network
  hit — success or failure) that `pollOauthUsage` checks to enforce a minimum `OAUTH_POLL_INTERVAL_MS`
  (5 min) between hits regardless of how many times the host restarts. The back-off alone wasn't
  enough: between a back-off expiring and the next 429, each dev reflash's startup poll hit the
  endpoint immediately (startup used to schedule off the last *success* time), which is what
  compounded into hours-long penalties. Startup now just calls `setTimeout(pollOauthUsage, 0)`
  and lets those two guards self-throttle.
- **OAuth token refresh (the host renews its own access token).** The Keychain access token lives
  ~8h; when it expires and no Claude Code surface is running to renew it (the app-only + always-on
  case), the host was left sending an expired token and getting HTTP **401** — distinct from the
  429 rate-limit, and not fixed by the guards above. `getFreshAccessToken()` now checks
  `claudeAiOauth.expiresAt` and, if within `OAUTH_REFRESH_MARGIN_MS` (5 min) of expiry, calls
  `refreshOauthToken()`: POST `grant_type=refresh_token` to `console.anthropic.com/v1/oauth/token`
  with the same public `OAUTH_CLIENT_ID` Claude Code uses, then writes the **rotated** tokens
  (access + the new refresh token + both expiries) back into the *same* keychain item in place
  (`security add-generic-password -U -a <acct> -s "Claude Code-credentials" -w <json>`), preserving
  every other field. A `pollOauthUsage` 401 on a not-just-refreshed token triggers one reactive
  refresh+retry (never a loop). This **reverses the old "never mutate the credential" rule** —
  deliberately, because it's the only way the app-only case stays live — but the safeguards are
  load-bearing: only ever exchange a **still-valid** refresh token (bail with a clear
  "sign in again" error if the refresh token is expired, so we don't hammer the token endpoint or
  imply a refresh can fix a real logout), and the rotated refresh token MUST be persisted or Claude
  Code's next refresh fails with `invalid_grant`. Verified interoperable (dry-run refresh → 200,
  persisted, usage endpoint then 200; and the live path via a force-expired token → auto-refresh).
  The host also sends `quotaAgeSec` so the USAGE cards can flag stale quota ("stale 3h" in the
  alert color) — the footer's freshness only vouches for the transport, not the data. When
  `quotaAgeSec > 900` (15 min) the big hero % is also **dimmed** to `COLOR_LABEL` (via
  `renderCard`), so a frozen value — e.g. a 5-hour % stuck at "0%" while the OAuth poller is in
  a long 429 back-off — doesn't masquerade as a live reading. `renderUsageTab` busts the
  `pctNCache` on each stale-flag flip, since `drawBigNumber` only repaints on a text change and
  a stale % often keeps the same digits.
- The needs-input beep is capped at 3 per asking-event (`beepsLeft` budget carried across
  polls). Sessions are matched across polls **by id, never by name** — two sessions on the
  same project share a name, and name-matching once made an asking session look newly-asking
  every poll (endless beeping).
- The device line buffers (`feedChar`'s 16000-**BYTE** guard, the 16384-byte BLE stream buffer) are
  sized for payloads carrying `ask` objects; shrinking them silently drops whole updates. They
  were bumped from 8000/8192 when the ask caps grew (title 34, detail 1400, options 4×32,
  `askDetail[1424]`/`askTitle[36]`/`askOpts[4][34]`) so up to 6 simultaneous asks with full
  1400-char details can't overflow one JSON line. ArduinoJson v7's `JsonDocument` is elastic, so
  the parse side has no fixed capacity - the line guard and RAM (`SessionInfo`×6 plus a
  `prevSessions`×6 diff copy) are the real ceilings.
  **THAT GUARD COUNTS BYTES AND EVERY CAP ABOVE IT COUNTED CHARACTERS, AND THIS FILE CALLED IT A
  "16000-char guard" FOR AS LONG AS THE MISMATCH EXISTED.** `buf.length()` on an Arduino String is
  bytes; `title` 34, `detail` 1400 and `options` 32 were all JS `.slice()`, i.e. UTF-16 code units,
  and `clean()`/`cleanMultiline()` stripped control bytes only — so everything from U+0080 up
  crossed at up to **3 bytes each**. The two units were never reconciled, and the device's own
  `askDetail[1424]`/`askOpts[4][34]` have the same disease, since `copyField` truncates by BYTE.
  **Measured, not modelled from the caps:** six asking sessions of all-wide text with **no new
  fields at all** is **37,425 bytes against a 16,000 guard — 2.3x over**. And it does not take six:
  **ONE session carrying a multi-byte question at the 1400-char cap is 17,893 bytes.** A single
  question asked in CJK does it.
  **THE FAILURE MODE IS THE IMPORTANT PART, AND IT IS NOT A DROPPED LINE.** The guard **CLEARS THE
  BUFFER MID-LINE**, so the remainder of that same line accumulates into the emptied buffer,
  `processCompletedLine()` gets a JSON fragment, `handleLine()` returns early on the parse error,
  and **every tick carrying that prompt is lost**. The screen freezes at its last good state for as
  long as the prompt is pending, while both links, both heartbeats and both menu bars look perfectly
  healthy and nothing anywhere logs why — the "healthy process doing no useful work" shape this file
  already documents three times over (the stalled tick, the `ccusage` all-or-nothing tick, the
  nvm-PATH `readUsage()` throw).
  **FIX, LAYER 1: device-bound text is ASCII on the host, so characters and bytes are ONE UNIT BY
  CONSTRUCTION.** Not a bigger guard — `askDetail[1424]` and friends are fixed too, so raising it
  only moves the truncation. The justification is that the bytes were never worth anything:
  **both fonts declare `0x20..0x7E`, and an out-of-range byte draws nothing and advances nothing**,
  so every non-ASCII byte was budget spent on an invisible glyph. Stripping them costs no
  information the device could ever have shown, and it makes every character cap exact in bytes at
  once rather than patching one and leaving the next wrong. `toAscii()` transliterates what actually
  appears — em-dashes, curly quotes, ellipses, arrows, accented Latin via NFD — and marks anything
  else with a single `?`, **collapsing a RUN to one** so a CJK sentence does not become a wall of
  them. In the hook it goes inside `clean()`/`cleanMultiline()`, the single funnel every ask field
  already takes; in the host at each device-bound cap site. **Transliterate THEN cap, never the
  reverse**: the ellipsis is one character in and three out, so capping first lets a field grow back
  past its own cap. Result: WIDE **37,425 → 14,237**, and the ASCII floor is **unchanged at
  14,237** — the two are now the same number, and that identity IS the reconciliation. **Every
  payload that was already fine is byte-identical**, verified against 267 real captured payloads.
  **FIX, LAYER 2: `host/wire-fit.mjs` — the host REFUSES to emit a line the device cannot receive.**
  It measures every tick line against `feedChar`'s own 16,000-byte guard before writing it and sheds
  until it fits: largest `ask.detail` first (the prompt survives and stays answerable, with a marker
  saying where to read it), then `optDescs`, then whole sessions off the urgency-sorted **TAIL**,
  with any `asking` row it drops counted into `hiddenAsking`. Tier 3 is what makes this **TOTAL**
  where the transliteration is merely thorough: a 200KB session still yields a sendable line, and it
  covers any future field, any hook version, and — the case no checker can reach — **a STALE hook
  still installed in `~/.claude`, emitting untransliterated text until someone runs `install.sh`**.
  Everything shed is LOGGED, because a silent truncation would be the same class of defect as the
  freeze. Both shedding loops are bounded by the session count: this runs inside the 5s tick and a
  spin there would be worse than the freeze it prevents, which a fault-injection run proved by
  hanging on an unbounded one.
  **`ask.voiceText` BYPASSED layer 1, and the obvious fix was WRONG.** It is parked by
  `handleVoiceAnswer` under `capUtf8`'s byte cap and assigned straight into the payload, so it never
  met `clean()` — and Whisper is the densest non-ASCII source in the system. The budget never
  noticed, because 150 bytes is 150 bytes either way; what it cost was the GLASS. *"Yes - let's go
  ahead... but don't touch the cache"* reached the wire at 47 chars / 55 bytes and drew as
  `Yes  lets go ahead but dont touch the cache` — **holes exactly where the punctuation was**, on
  the one screen whose entire purpose is proving a human read THESE EXACT WORDS before signing them.
  Now 49 chars / 49 bytes and drawn in full. **The fix had to be at the PARK SITE, before
  `voiceSha()`.** Transliterating in the payload builder — where `item.ask.voiceText` is assigned,
  which is the obvious place — desyncs the text the device DISPLAYS from the text that gets signed.
  **This file used to say the host would then REJECT valid answers. It would not, and the correction
  matters more than the original claim did.** `sessions.ino:2259` builds `nonce:pid:TEXT:<sha16>`
  from the `voiceSha` the host SENT — the device does not re-hash what it draws — and the host
  verifies by re-hashing its own PARKED copy, which still matches. So the answer is **ACCEPTED**:
  the human reads one string and authorises another, with a valid signature and nothing logged.
  A rejection would have been loud and self-limiting; this is a silent divergence on the one screen
  whose entire purpose is binding what was read to what was signed. That is why the send-time guard
  (`host/wire-ascii.mjs`) **suppresses** `voiceText`/`voiceSha` rather than repairing them when the
  park site has failed — a missing confirm screen is a visible, safe failure. That ordering is
  asserted, and the plausible wrong fix is one of the injected faults: moving it fails 6 assertions
  by name.
  **Found en route:** `histFlatten`'s truncation marker was **U+2026**, outside both fonts, so a
  truncated history preview showed no sign whatsoever of having been cut. Three ASCII dots now — the
  fourth instance of the trap this file already records for `fitText`'s ellipsis, the `CLAUDE/air`
  tag separator and the PAIRED MACS middle dot.
  **Worth recording as METHOD: on a finite domain, EXHAUSTIVE beats fuzz and costs under a second.**
  The drift guard between `host/to-ascii.mjs` and the hook's forced inline copy runs over **71,738
  strings** — a hand-written corpus, a seeded fuzz sweep including lone surrogates on both sides,
  every map key PARSED out of the module, every BMP code point, and an astral stride. A mutated
  `"Ø": "O"` → `"0"` was caught by the exhaustive half and **missed entirely by 5,000 fuzz
  strings**. The copy is duplicated rather than imported for the reason `capBytes()` duplicates
  `capUtf8()`: `install.sh` copies that hook alone into `~/.claude`, so it can only ever import node
  builtins.
  **A TRIPWIRE deliberately asserts that something is STILL WRONG.** With `optDescs` at its cap on
  all four options of all six sessions, the line is over the guard **even in pure ASCII** — a
  residue no transliteration can reach, because it is a CAP decision. It is far outside real traffic
  (one asking session at the cap is 3,741 bytes) and `wire-fit.mjs` now handles it at send time, but
  the assertion stays: **if it ever fits, the reasoning behind these caps must be re-derived.**
- The ask/answer screen: tapping an asking session's row opens option buttons wired to
  `sendAnswerToHost()` (which transmits on USB **and** BLE TX notify, in ≤20-byte chunks).
  Long detail text pages by tapping the text block — deliberate: drag-scrolling flickers and
  misfires on this resistive panel, discrete pages don't.
- **AN ASK'S OPTIONS CARRY THEIR DESCRIPTIONS ACROSS THE WIRE, AND BOARD 2 DRAWS THEM.**
  `AskUserQuestion` puts "what this option means, or what happens if you pick
  it" in each option's `description`, and `buildAsk()` discarded it on the very line that took
  `label` — so a four-way question reached the device as four bare labels and **the information you
  need in order to CHOOSE never left the Mac**. `ask.optDescs` is now emitted parallel to
  `ask.options`, and **only when at least one description is non-empty**, so an Allow/Deny prompt's
  payload does not grow by a byte and absence is byte-identical to the old record (asserted against
  `git show HEAD:` of the hook itself). A device that does not know the field ignores it — the same
  backward-compatible shape as the trailing `to=<hostId>` address, so no protocol version bump.
  `host/index.mjs` needed no functional change: the pass-through is the existing
  `{ ...record.ask, nonce }` spread, and a comment pins that as the invariant, since turning it into
  a named field list is the one edit that breaks this silently.
  **THE CAP IS 416 NOW, DERIVED FROM 674 MEASURED DESCRIPTIONS, AND THE 96 IT REPLACED WAS A FOSSIL
  THAT CONCEALED A MISSING GUARD.** Reported off the glass — "options' long description not show
  full, it cut" — and measured out of the hook's own debug log rather than estimated: median **210**
  bytes, p75 258, p90 313, p99 412, max 606, and **625 of 674 (92.7%) were truncated mid-word at
  96**. The old justification was "a description may not cost more bytes than the LABEL it
  explains", computed as 32 chars × 3 bytes — and **that multiplier died when device-bound text
  became ASCII**: a 32-character label is now 32 BYTES, so the same convention yields 32 and the 96
  it licensed was already 3× its own stated derivation. A bound whose arithmetic no longer holds is
  not a bound. Worse, while it sat there looking like one it hid the bound that was **genuinely
  missing**: nothing anywhere asserted that the hook's cap and the device's `ASK_OPT_DESC_BYTES`
  buffer agree. They matched only because someone kept them in step by hand, and `copyField`
  truncates by BYTE, so a drift would have been cut in silence on arrival.
  Two real bounds replace it, both parsed from their own files: **exact parity** with the device
  buffer (`ASK_OPT_DESC_BYTES` = cap + 1, so 417), and **two concurrently asking sessions at the cap
  fitting `feedChar`'s guard** (one is 5,021 bytes; two is ordinary traffic — two Macs, or two
  projects). The saturated 6-session case cannot set this cap, being already over budget with the
  field absent entirely — that is `wire-fit.mjs`'s problem.
  **The "optDescs must stay a rounding term" assertion was deliberately RELAXED** from
  `detail > marginal * 5` to `detail > marginal`. Keeping 5× would have capped this at **~203 bytes,
  the MEDIAN**, so half of every description would still be cut — the complaint, unfixed. The field
  is a real term now by choice; its ceiling is its own budget rather than a ratio against a
  neighbour, and the detail cap is still dominant at 2.5×.
  **Two transcribed-not-parsed bugs fell out of raising it, both inside checkers.** The
  codepoint-boundary behaviour test fed a hardcoded **200 em-dashes** tuned to a 96-byte cap, so the
  moment the cap passed 200 the input stopped overflowing it and two assertions failed — the rule
  biting inside the checker whose whole subject is parsed caps; its length is derived now. And
  `sessions-geom-check.mjs` had an assertion whose **condition disagreed with its own message**: it
  claimed "well inside `drawWrappedText`'s 80-line stop" while testing `descCols * 3 >= cap`, a
  different claim that held only because 34 × 3 = 102 cleared 96. Both `countWrappedLines` and
  `drawWrappedText` really do hard-stop at 80 lines, so the fixed condition tests that, with the 80
  parsed out of the firmware — 416 bytes needs 13 lines, and the lane's real ceiling is **2,720**.
  **Cost:** board 2 RAM **+7,680** (66,436 → 74,116, exactly 4 slots × 6 sessions × 320) and flash
  +8, `.bin` size unchanged so re-baselined at +0 bytes with a differing hash. **Board 1
  `UNCHANGED`** — it stores 1 byte per slot and draws no descriptions.

  **THE ORIGINAL 96-BYTE REASONING IS KEPT BELOW AS THE RECORD OF WHAT WAS WRONG WITH IT.**

  **THE 96-BYTE CAP WAS A STATED CONVENTION, MECHANICALLY ENFORCED — NOT A DERIVATION FROM THE WIRE
  BUDGET.** The convention: *a description may not cost more bytes than the LABEL it explains*, and
  a label is capped at 32 characters, so its byte ceiling is 32 x 3 = **96**. Both numbers are
  parsed out of the hook, so 97 fails by name. It is capped in BYTES on a codepoint boundary, not
  characters, because the device stores each in a fixed `char[]` and truncates by BYTE — and real
  descriptions are full of em-dashes and curly quotes at 3 bytes each (measured on a real captured
  payload, where all four options carried at least one).
  **Say plainly why it is a convention and not arithmetic: the first attempt DERIVED 64 from the
  wire budget and the derivation was wrong.** It read "64 lands at 15,923 with 77 to spare", which
  was computed off the *no-parked-voice* baseline while the row above it presented the parked-voice
  case as the worst one — at 64 with a parked transcript it is 17,093, i.e. **1,093 OVER**, not 77
  under. That number then went into a 20-line source comment. And the model was in the wrong unit
  anyway (see the byte-budget note under the line buffers): the saturated case is over the guard
  with this field **absent**, so **no value survives it, including zero** — which is exactly why the
  worst case cannot set this cap. Cutting to 64 bought nothing against the case it was cut for and
  cost real information on every question: it truncated `trade-off` to `trade-of`.
  `host/ask-optdescs-check.mjs` is the point of the fix — 47 assertions, `--selftest` catching 5/5
  injected faults — and it exists because **the first attempt's arithmetic lived in a scratchpad
  that ceased to exist, so nobody could re-run it.** A number nobody can re-derive is not a
  measurement.
  **THE DEVICE NOW STORES AND DRAWS THEM, on board 2 only, and the storage is per board for a
  reason the header spells out.** `SessionInfo` is SHARED, so the member is compiled into both
  boards whether or not a pixel of it is ever drawn — what is not shared is the COST.
  `ASK_OPT_DESC_BYTES` is **97** on board 2 (the hook's 96 plus the NUL) and **1** on board 1, the
  smallest legal array size, so every slot there can only ever hold `""`. Sizing board 1 to the real
  cap would spend `4 x 97 x MAX_SESSIONS` = **2,328 bytes of DRAM** on the board whose ~26KB of free
  heap is the binding constraint on the audio path, for text its panel does not render. It is a
  per-board CONSTANT rather than an `#if` at the declaration, and that was forced rather than
  chosen: behind an `#if` the checkers parse ONE arm and report it for BOTH boards, which is exactly
  the false reading `BATT_LEFT_BYTES` was fixed for.
  **THE DETAIL SIGNATURE TAKES A 32-BIT FNV-1a HASH OF THE DESCRIPTIONS, because verbatim is not
  tight — it is IMPOSSIBLE.** Four descriptions plus their separators are `4 x (1 + 96)` = **388
  bytes** on their own against a **384-byte** `detailSigCache`, and the rest of the signature needs
  the room too; hashing brings the worst case to **372/384**. **It is not a birthday problem**, and
  that distinction is the whole argument: `buildDetailSignature` compares against the ONE
  immediately-previous cached value, never against a population, so a missed repaint needs a
  collision with that single value — p ≈ 2⁻³² per event, not `sqrt`. The obvious cheaper shape,
  a per-slot prefix, is **strictly worse**: 12 bytes of headroom buys 3 characters a slot, and real
  descriptions SHARE prefixes (`Allow this…` / `Deny…`), so prefix-N collides at rates that are
  actually reachable.
  **ONE chip, ONE reader, TWO sections.** The ask header has exactly one top-right slot and
  `READ ALL` owned it, so the question was never where the new button goes but what the one button
  means. It now opens a reader carrying the question's own detail FIRST and then every option with
  its description, paged as a single document, and it appears when EITHER the detail overflowed or
  any description exists. The label moved with it — board 2's chip says **`READ MORE`**, because
  `READ ALL` is a promise about the DETAIL and in the new case it is a lie in the direction that
  costs information: a detail that already fits, beside a chip saying READ ALL, tells a reader there
  is nothing behind it, so the descriptions would be reachable and never found. `READ MORE` is true
  in all three states. `ASK_READ_BTN_LABEL` is a per-board macro (the shape `WAKE_HINT` already
  uses); board 1 keeps `READ ALL`.
  **Three alternatives were considered and each lost for a nameable reason**, recorded so they are
  not re-proposed: giving the new button the slot whenever descriptions exist — a long detail
  becomes unreachable exactly when the question is most complex, against this repo's rule never to
  offer a control that cannot work; **two half-width chips** — 43-45px, under `TAP_MIN` 46, with
  labels shrinking to about four characters; and moving the detail into the reader always — it costs
  the at-a-glance command preview that makes a permission prompt answerable in one tap.
  **The accepted cost is that a long detail can push the options to a later page, and the screen
  SIGNPOSTS it** rather than leaving an enabled NEXT to be inferred: one body row is reserved on
  page 1 for `WHAT THE OPTIONS MEAN - PAGE n`, naming the same heading the section opens with. That
  page number is the only new arithmetic here that actively MISLEADS when wrong — a row naming the
  wrong page sends a reader somewhere with no options on it, from which the honest conclusion is
  that there are none — so it is asserted by **WALKING THE PAGER**, not by restating the division:
  the bounds come from `drawReader`'s own parsed `pageLo`/`pageHi` and the 1-based number from the
  same expression the header's `n/m` counter uses, evaluated with C's TRUNCATING division over every
  reachable detail length at both line steps. `+1 → +2` and `+1 → +0` each fail by name.
  **BOARD 1 HELD BYTE-IDENTICAL THROUGH ALL OF IT, and the three natural shapes all moved it** —
  measured against `board-baseline.mjs --check 1`, not reasoned about: two sibling `if`s sharing one
  chip block cost **+8 bytes**; the chip factored into a function cost **+60** (not inlined); and
  nesting it inside `if (askReadOffered)` came out at **+0 bytes with DIFFERENT CONTENT** — one
  `mul16s` with its operands swapped. **That third one is the strongest evidence this repo has for
  why the retired size check had to be replaced**, because a size comparison passes it. What ships
  instead is the chip's draw written once per `#if` arm (duplication guarded by a checker assertion
  rather than trusted) and `askReadOffered` spelled as a function-like MACRO on board 1 so its
  argument cannot perturb register allocation in `handleAskTouch`.
  **The dissent is recorded rather than settled:** the reviewer would have re-baselined board 1 and
  written the natural shape, on the argument that holding byte-identity is letting a check reach
  into the shape of the source. The counter-argument is the `+0`-bytes case above — the cost of
  finding it was three builds, and it is the sort of thing that is only ever found by looking.
  **Costs, measured:** board 1 **+336 bytes of flash, +24 RAM** (the 1-byte-per-slot placeholder,
  re-baselined deliberately with the deltas in the commit message); board 2 **+384 / +2,328** for
  the storage, then **+1,248** for the section, signpost, second chip copy and `READTEST`, then
  **+112** for `READTEST`'s two refusal lines.
  **`READTEST` (board 2 only) exists for the reason `TAB`/`PAGE`/`KBTEST`/`EMOJITEST` do:** the
  reader needs a finger on the chip and `SCREENSHOT` can only record what is already on the glass.
  Both its refusals PRINT their cause (`no ask is pending`, `another full-screen surface is up`) —
  the rule `POWERPROBE`'s `not on battery (unplug USB; state=2 mv=3866)` exists for, since from the
  Mac silence and impossibility look identical.
  **WHAT IS STILL OPEN.** Board 1 draws no descriptions at all — it stores a placeholder and its
  chip still says `READ ALL`, which is honest there because there is nothing else behind it. The
  96-byte cap truncated every real description to about a third, mid-word — **FIXED, see the cap
  paragraph above; this sentence is corrected rather than deleted because it called the truncation a
  convention's cost and not a bug, and a person looking at the glass disagreed.** It was a convention's
  cost and not a bug. And the wire's own unit mismatch, above, is untouched: a question in CJK can
  still overflow `feedChar`'s guard **with this field absent entirely**. **No screenshot in this
  work vouches for the panel's colours** — board 2's `SCREENSHOT` reads the shadow framebuffer, so
  it proves the renderer self-consistent and nothing about the glass (see the verification trap
  under Two boards).
