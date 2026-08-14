# Type Scale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Terminus 10x18 bold as a third type rung (`T_HEAD`) behind a font registry, fix the baked-in cell height in `drawIfChanged`, and use the new rung to turn `drawSessionRow`'s 12x26→6x13 name cliff into a three-step ladder.

**Architecture:** A `UI_FONTS[]` registry maps font ids to `(GFXfont*, size, cellH)`. Every id in use today keeps its current face, so the registry lands **inert** — all 72 existing call sites render byte-identically. The new rung arrives as a new id, `T_HEAD = 3`, and is adopted at exactly one site.

**Tech Stack:** Arduino/ESP32, TFT_eSPI (Adafruit_GFX free fonts), Python 3 (`bdf2gfx.py`), Terminus BDF (SIL OFL).

**Spec:** `docs/superpowers/specs/2026-08-14-type-scale-design.md`

## Global Constraints

- **This repo has no test suite or linter.** Firmware verification is "compile, flash, watch the Serial Monitor / host log, and check the physical screen." Automated checks in this plan are host-side Python only. Do not invent a firmware test framework.
- **Compile baseline to measure against:** `Sketch uses 1298694 bytes (41%)`, `Global variables use 76556 bytes (23%)`. Expected after Task 4: ≈ +2850 B flash, ~0 B RAM.
- **Compile command** (from repo root): `arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" firmware/deckhand_display`
- **Flash command:** find the port dynamically — it renumbers. `PORT=$(ls /dev/cu.usbserial-* | head -1)`, then
  `arduino-cli upload -p "$PORT" --fqbn "esp32:esp32:esp32:UploadSpeed=115200,FlashMode=dio,FlashFreq=80,PartitionScheme=huge_app" firmware/deckhand_display`
- **Do NOT open a second USB serial connection** to send ad-hoc commands — opening one pulses the CH340 reset line and reboots the ESP32. Use the trigger file `~/.claude/deckhand-device-command`.
- **`T_TITLE` must keep its value of 2 and must NOT be repurposed.** It is used inside `uiButton`, the single shared button style; redefining it would flip every button label on the device — Allow/Deny and the confirm dialogs included — to a face 67% wider than their fixed widths assume.
- **The flicker-free redraw discipline is absolute:** every field is redrawn only when its value changes, using fixed-width padded strings compared against a per-field cache. Never clear-then-redraw a large area. Any new element follows `drawIfChanged` / `drawBar` / `drawCardBorder`.
- **A change-only cache shorter than the string it stores stops noticing changes.** `drawIfChanged` compares `cacheSize` bytes. Any new or widened field must have its cache checked against its padded length.
- **Font ids in use today:** `1` (`T_META`), `2` (`T_BODY`, `T_TITLE`), `4` (hero), `200` (`FONT_CODE`). Id `3` is free and becomes `T_HEAD`.
- **Arduino auto-prototype hazard:** the build system generates function prototypes and inserts them before user types are defined. Keep the `UiFont` struct out of every function signature — accessors return primitives only, and the struct appears solely inside function bodies.
- **Terminus is SIL OFL.** Redistributing generated glyph data requires the copyright notice and licence to travel with it.
- **The generated `.bdf` source files are NOT committed** (the 668KB Cozette BDF deliberately isn't; Terminus's is 1.1MB). Only the generated `.h` and the licence text are committed, and the fetch command is documented.
- Docs live in **two** files: `CLAUDE.md` is the source of truth and `AGENTS.md` is a generated verbatim copy below an 11-line header. Never hand-edit `AGENTS.md`; regenerate it.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `firmware/deckhand_display/bdf2gfx.py` | modify | BDF → Adafruit_GFX header conversion; gains true attribution, `--verify`, `--selftest` |
| `firmware/deckhand_display/Terminus10x18b.h` | create (generated) | The new face's glyph data, ~2850 B `PROGMEM` |
| `firmware/deckhand_display/licenses/OFL-Terminus.txt` | create | OFL text for Terminus |
| `firmware/deckhand_display/licenses/OFL-Cozette.txt` | create | OFL text for Cozette (pre-existing compliance gap in the same area) |
| `firmware/deckhand_display/deckhand_display.ino` | modify | Font registry, `setUIFont`, `uiLineH`, `drawIfChanged` erase geometry, `drawSessionRow` ladder |
| `CLAUDE.md` / `AGENTS.md` | modify | Document the scale and the `T_TITLE` deferral |

---

### Task 1: `bdf2gfx.py` — real attribution, `--verify`, `--selftest`

The generator has only ever been run on one font, and it hard-codes Cozette's copyright into
every header it emits. Before generating a second font we make it (a) tell the truth about what
it generated and (b) prove its own output is correct.

**Files:**
- Modify: `firmware/deckhand_display/bdf2gfx.py`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `parse_props(path) -> dict[str, str]` — font-level `STARTPROPERTIES` values, quotes stripped.
  - `verify(bdf_path, header_path) -> list[str]` — empty list means the header matches the BDF.
  - `selftest(bdf_path, header_path) -> list[str]` — empty list means the checker has teeth.
  - CLI: `python3 bdf2gfx.py --verify <bdf> <header>` and `python3 bdf2gfx.py --selftest <bdf> <header>`, exit 0 on pass, 1 on failure.

- [ ] **Step 1: Fetch the Cozette BDF that the shipped header was generated from**

This is the known-good anchor: the header in the tree must verify against it.

```bash
cd firmware/deckhand_display
curl -sSL -o /tmp/cozette.bdf \
  https://github.com/slavfox/Cozette/releases/latest/download/cozette.bdf
ls -l /tmp/cozette.bdf
```

Expected: a file of roughly 650-700 KB.

- [ ] **Step 2: Write the failing test — run `--verify` before it exists**

```bash
cd firmware/deckhand_display
python3 bdf2gfx.py --verify /tmp/cozette.bdf Cozette6x13.h; echo "exit=$?"
```

Expected: FAIL. Without the new CLI, `--verify` is treated as the BDF path and the script raises
`FileNotFoundError: '--verify'` (exit 1).

- [ ] **Step 3: Add `import os` and `parse_props()`**

At the top of the file change `import sys, re` to:

```python
import sys, re, os
```

Then add this function immediately after `parse_bdf()`:

```python
def parse_props(path):
    """Font-level STARTPROPERTIES values (FAMILY_NAME, COPYRIGHT, PIXEL_SIZE, ...).

    Read so a generated header carries its OWN font's attribution: emitting one
    font's glyphs under another's copyright is a licensing defect, not cosmetics.
    The block sits before the first STARTCHAR, so stopping at ENDPROPERTIES is
    both correct and cheap.
    """
    props = {}
    inblock = False
    with open(path, "r", errors="replace") as f:
        for ln in f:
            ln = ln.rstrip("\n")
            if ln.startswith("STARTPROPERTIES"):
                inblock = True
                continue
            if ln.startswith("ENDPROPERTIES"):
                break
            if not inblock:
                continue
            parts = ln.split(None, 1)
            if len(parts) == 2:
                props[parts[0]] = parts[1].strip().strip('"')
    return props
```

- [ ] **Step 4: Add `verify()`**

Add after `parse_props()`:

```python
def _header_tables(src):
    """Pull the bitmap bytes, glyph table and yAdvance back out of a generated header."""
    def section(tag):
        return src.split(f"{tag}[] PROGMEM")[1].split("};")[0]
    bm = [int(x, 16) for x in re.findall(r"0x([0-9A-Fa-f]{2})", section("Bitmaps"))]
    tbl = [tuple(int(v) for v in t) for t in re.findall(
        r"\{\s*(-?\d+),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)\s*\}",
        section("Glyphs"))]
    m = re.search(r"0x[0-9A-Fa-f]{2},\s*0x[0-9A-Fa-f]{2},\s*(\d+)\s*\}", src)
    return bm, tbl, (int(m.group(1)) if m else None)


def verify(bdf_path, header_path):
    """Decode a generated header and compare it glyph-for-glyph with its source BDF.

    Returns a list of problems; empty means the header is faithful. This exists
    because bdf2gfx.py had only ever been run against Cozette, whose glyphs are
    tightly cropped; a font with a uniform full-cell BBX exercises packing paths
    that had never run.
    """
    glyphs = parse_bdf(bdf_path)
    props = parse_props(bdf_path)
    src = open(header_path).read()
    bm, tbl, yadv = _header_tables(src)
    problems = []

    expected_count = LAST - FIRST + 1
    if len(tbl) != expected_count:
        problems.append(f"glyph table has {len(tbl)} entries, expected {expected_count}")

    if yadv is None:
        problems.append("no yAdvance found in the GFXfont initialiser")
    elif "FONT_ASCENT" in props and "FONT_DESCENT" in props:
        want = int(props["FONT_ASCENT"]) + int(props["FONT_DESCENT"])
        if yadv != want:
            problems.append(f"yAdvance {yadv} != FONT_ASCENT+FONT_DESCENT {want}")

    for i, code in enumerate(range(FIRST, LAST + 1)):
        if i >= len(tbl):
            break
        off, w, h, adv, xo, yo = tbl[i]
        g = glyphs.get(code)
        if g is None:
            continue
        (sw, sh, sxo, syo), dw, rows = g
        want = (sw, sh, dw if dw is not None else 6, sxo, -(syo + sh))
        if (w, h, adv, xo, yo) != want:
            problems.append(f"0x{code:02X} {chr(code)!r}: metrics {(w, h, adv, xo, yo)} != {want}")
            continue
        expect = glyph_bits((sw, sh, sxo, syo), rows)
        got = []
        bit = off * 8
        truncated = False
        for _ in range(w * h):
            if (bit >> 3) >= len(bm):
                problems.append(f"0x{code:02X} {chr(code)!r}: bitmap truncated")
                truncated = True
                break
            got.append((bm[bit >> 3] >> (7 - (bit & 7))) & 1)
            bit += 1
        if not truncated and got != expect:
            problems.append(f"0x{code:02X} {chr(code)!r}: bitmap differs")
    return problems
```

- [ ] **Step 5: Add `selftest()`**

Add after `verify()`:

```python
def selftest(bdf_path, header_path):
    """Prove --verify has teeth: a one-byte corruption MUST be caught.

    Mirrors palette-check.mjs --selftest. A checker that cannot fail is not a
    check. 'A' is corrupted specifically because it is guaranteed to have inked
    pixels that verify() actually reads - flipping a byte inside a blank glyph
    would go undetected for legitimate reasons and make this test lie.
    """
    clean = verify(bdf_path, header_path)
    if clean:
        return ["header does not verify before tampering: " + "; ".join(clean[:3])]

    src = open(header_path).read()
    bm, tbl, _ = _header_tables(src)
    off = tbl[0x41 - FIRST][0]          # 'A'
    if off >= len(bm):
        return ["cannot corrupt 'A': offset past the end of the bitmap"]
    bm[off] ^= 0xFF

    head, rest = src.split("Bitmaps[] PROGMEM = {", 1)
    _body, tail = rest.split("};", 1)
    lines = ["  " + ", ".join(f"0x{b:02X}" for b in bm[i:i + 16]) + ","
             for i in range(0, len(bm), 16)]
    tampered = head + "Bitmaps[] PROGMEM = {\n" + "\n".join(lines) + "\n};" + tail

    tmp = header_path + ".selftest"
    with open(tmp, "w") as f:
        f.write(tampered)
    try:
        caught = verify(bdf_path, tmp)
    finally:
        os.remove(tmp)

    if not caught:
        return ["a corrupted bitmap byte was NOT caught - the checker has no teeth"]
    return []
```

- [ ] **Step 6: Wire up the CLI**

Replace the final block:

```python
if __name__ == "__main__":
    main()
```

with:

```python
def _run_check(kind, bdf_path, header_path):
    problems = (verify if kind == "--verify" else selftest)(bdf_path, header_path)
    label = os.path.basename(header_path)
    if problems:
        print(f"FAIL {label}: {len(problems)} problem(s)")
        for p in problems[:20]:
            print("  " + p)
        if len(problems) > 20:
            print(f"  ... and {len(problems) - 20} more")
        return 1
    word = "matches its BDF" if kind == "--verify" else "selftest passed (corruption caught)"
    print(f"PASS {label}: {word}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) >= 4 and sys.argv[1] in ("--verify", "--selftest"):
        sys.exit(_run_check(sys.argv[1], sys.argv[2], sys.argv[3]))
    main()
```

- [ ] **Step 7: Run the checks — both must pass against the shipped header**

```bash
cd firmware/deckhand_display
python3 bdf2gfx.py --verify   /tmp/cozette.bdf Cozette6x13.h; echo "exit=$?"
python3 bdf2gfx.py --selftest /tmp/cozette.bdf Cozette6x13.h; echo "exit=$?"
```

Expected:
```
PASS Cozette6x13.h: matches its BDF
exit=0
PASS Cozette6x13.h: selftest passed (corruption caught)
exit=0
```

If `--verify` fails here, STOP: either the generator or the committed header is wrong, and that
must be understood before generating a second font.

- [ ] **Step 8: Confirm no stray temp file survived**

```bash
ls firmware/deckhand_display/*.selftest 2>/dev/null && echo "LEAKED" || echo "clean"
```

Expected: `clean`.

- [ ] **Step 9: Replace the hard-coded attribution in `main()`**

In `main()`, after `glyphs = parse_bdf(bdf)` add:

```python
    props = parse_props(bdf)
```

Then replace these three lines:

```python
    out.append("// Cozette 6x13 - Adafruit_GFX font, printable ASCII 0x20-0x7E only.")
    out.append("// Generated from cozette.bdf by bdf2gfx.py. (c) Ines, OFL/MIT.")
    out.append("// Used for the code-block detail/reader rendering (crisp bitmap at this DPI).")
```

with:

```python
    family = props.get("FAMILY_NAME", name)
    weight = props.get("WEIGHT_NAME", "")
    pixsz = props.get("PIXEL_SIZE", str(yadv))
    copyr = props.get("COPYRIGHT", "see the source font's own licence")
    face = f"{family} {pixsz}px" + (f" {weight}" if weight and weight != "Medium" else "")
    out.append(f"// {face} - Adafruit_GFX font, printable ASCII 0x20-0x7E only.")
    out.append(f"// Generated from {os.path.basename(bdf)} by bdf2gfx.py - do not edit by hand.")
    out.append(f"// {copyr}")
    out.append("// Licence: firmware/deckhand_display/licenses/ has the full text.")
```

- [ ] **Step 10: Update the module docstring**

Replace the docstring's second paragraph (the two lines beginning
`Cozette is (c) Ines / the.moonwit.ch, MIT/OFL licensed.`) with:

```
Attribution is read from the BDF's own STARTPROPERTIES block, so a generated
header always carries its own font's copyright. Only printable ASCII
0x20..0x7E is emitted (all the renderer needs).

Self-check the output against its source, and prove the checker has teeth:

    python3 bdf2gfx.py --verify   cozette.bdf Cozette6x13.h
    python3 bdf2gfx.py --selftest cozette.bdf Cozette6x13.h
```

- [ ] **Step 11: Confirm the attribution change did not alter glyph data**

Regenerating Cozette must change only comments. Prove it:

```bash
cd firmware/deckhand_display
python3 bdf2gfx.py /tmp/cozette.bdf Cozette6x13 13 > /tmp/cozette-regen.h 2>/dev/null
diff <(grep -v '^//' Cozette6x13.h) <(grep -v '^//' /tmp/cozette-regen.h) && echo "DATA IDENTICAL"
python3 bdf2gfx.py --verify /tmp/cozette.bdf /tmp/cozette-regen.h
```

Expected: `DATA IDENTICAL`, then `PASS`. Do **not** overwrite the committed `Cozette6x13.h` —
its data is unchanged and leaving it alone keeps this task's diff to the generator.

- [ ] **Step 12: Commit**

```bash
git add firmware/deckhand_display/bdf2gfx.py
git commit -m "Make bdf2gfx read attribution from the BDF, and verify its own output

The generator stamped Cozette's copyright onto every header it emitted, so
generating a second font would ship that font's glyphs under the wrong
notice. Attribution now comes from the BDF's own STARTPROPERTIES.

--verify decodes a generated header and compares it glyph-for-glyph with its
source; --selftest corrupts one byte of 'A' and fails if that goes unnoticed,
the same teeth-proving trick palette-check.mjs uses. This matters because the
generator had only ever run against Cozette, whose glyphs are tightly cropped."
```

---

### Task 2: Generate `Terminus10x18b.h` and add the licence texts

**Files:**
- Create: `firmware/deckhand_display/Terminus10x18b.h`
- Create: `firmware/deckhand_display/licenses/OFL-Terminus.txt`
- Create: `firmware/deckhand_display/licenses/OFL-Cozette.txt`

**Interfaces:**
- Consumes: `verify()` / CLI from Task 1.
- Produces: `const GFXfont Terminus10x18b` — the symbol Task 3's registry points at. Also
  `Terminus10x18bBitmaps[]` and `Terminus10x18bGlyphs[]`.

- [ ] **Step 1: Fetch Terminus and confirm the licence ships with it**

```bash
cd /tmp && rm -rf terminus-src && mkdir terminus-src && cd terminus-src
curl -sSL --max-time 60 -o t.tgz \
  https://downloads.sourceforge.net/project/terminus-font/terminus-font-4.49/terminus-font-4.49.1.tar.gz
tar xzf t.tgz && cd terminus-font-4.49.1
ls OFL.TXT && grep -m1 'FONTBOUNDINGBOX' ter-u18b.bdf
```

Expected: `OFL.TXT` exists, and `FONTBOUNDINGBOX 10 18 0 -3`.

- [ ] **Step 2: Generate the header**

`yAdvance` is 18 = `FONT_ASCENT` 15 + `FONT_DESCENT` 3.

```bash
cd /Users/yujia/projects/deckhand/firmware/deckhand_display
python3 bdf2gfx.py /tmp/terminus-src/terminus-font-4.49.1/ter-u18b.bdf Terminus10x18b 18 \
  > Terminus10x18b.h
```

Expected on stderr: `glyphs=95 bitmap_bytes=2185 table_bytes=665`.

- [ ] **Step 3: Verify the generated header against its BDF**

This is the step that proves the generator handled a font whose `BBX` is a uniform full cell.

```bash
cd /Users/yujia/projects/deckhand/firmware/deckhand_display
python3 bdf2gfx.py --verify   /tmp/terminus-src/terminus-font-4.49.1/ter-u18b.bdf Terminus10x18b.h
python3 bdf2gfx.py --selftest /tmp/terminus-src/terminus-font-4.49.1/ter-u18b.bdf Terminus10x18b.h
```

Expected: `PASS` for both.

- [ ] **Step 4: Confirm the attribution landed and the metrics are right**

```bash
head -6 Terminus10x18b.h
grep -c '^  0x' Terminus10x18b.h
grep '0x20, 0x7E' Terminus10x18b.h
```

Expected: the comment block names **Terminus 18px Bold** and carries
`Copyright (C) 2020 Dimitar Toshkov Zhekov`; the `GFXfont` initialiser ends `0x20, 0x7E, 18 };`.

- [ ] **Step 5: Add the licence texts**

```bash
cd /Users/yujia/projects/deckhand/firmware/deckhand_display
mkdir -p licenses
cp /tmp/terminus-src/terminus-font-4.49.1/OFL.TXT licenses/OFL-Terminus.txt
curl -sSL --max-time 30 -o licenses/OFL-Cozette.txt \
  https://raw.githubusercontent.com/slavfox/Cozette/master/LICENSE
head -3 licenses/OFL-Terminus.txt licenses/OFL-Cozette.txt
wc -l licenses/*.txt
```

Both files must be non-empty and contain licence text. Cozette's is added because this task is
where font redistribution compliance is being handled, and it had the same gap.

- [ ] **Step 6: Commit**

```bash
cd /Users/yujia/projects/deckhand
git add firmware/deckhand_display/Terminus10x18b.h firmware/deckhand_display/licenses/
git commit -m "Add Terminus 10x18 bold, and the OFL texts for both bundled faces

Terminus 4.49.1 ter-u18b, printable ASCII only: 2185B of bitmap plus a 665B
glyph table. It verifies glyph-for-glyph against its BDF, which is the first
time bdf2gfx has been proven on a font with a uniform full-cell BBX rather
than Cozette's tightly-cropped glyphs.

The BDF itself is not committed (1.1MB); the fetch command is in the plan and
the generator docstring. Both fonts are OFL, so their licence texts now travel
with the generated glyph data."
```

---

### Task 3: Font registry, and font-derived erase geometry

Lands **inert**: every font id in use keeps its current face, so the screen must look
pixel-identical afterwards. The `drawIfChanged` fix has no visible effect yet — it is what makes
Task 4 possible without ghosting.

**Files:**
- Modify: `firmware/deckhand_display/deckhand_display.ino:30` (include)
- Modify: `firmware/deckhand_display/deckhand_display.ino:126-139` (font block)
- Modify: `firmware/deckhand_display/deckhand_display.ino:623-625` (tokens)
- Modify: `firmware/deckhand_display/deckhand_display.ino:2144` (erase height)

**Interfaces:**
- Consumes: `const GFXfont Terminus10x18b` from Task 2.
- Produces:
  - `struct UiFont { const GFXfont* gfx; uint8_t size; uint8_t cellH; };`
  - `static const UiFont UI_FONTS[5]`
  - `inline uint8_t uiFontIdx(uint8_t f)` — clamps any id to a valid index
  - `inline uint8_t uiTextSize(uint8_t f)` — unchanged signature, now table-driven
  - `inline int uiLineH(uint8_t f)` — unchanged signature, now returns the rendered cell height
  - `void setUIFont(uint8_t f)` — unchanged signature, now selects family *and* size
  - `const uint8_t T_HEAD = 3`

- [ ] **Step 1: Add the include**

At line 30, after `#include "Cozette6x13.h"`, add:

```c
#include "Terminus10x18b.h"
```

- [ ] **Step 2: Replace the font block**

Replace lines **121-139** — the `// ---------- Fonts ----------` comment through the closing brace
of `setUIFont` — with:

```c
// ---------- Fonts ----------
// A small registry maps a font id to a face, an integer scale and the RENDERED
// cell height. Ids are the legacy TFT_eSPI numbers the call sites already pass,
// so this table is a pure lookup: 1/2 -> Cozette 6x13, 4 -> Cozette 12x26,
// FONT_CODE -> body. Adding a face therefore costs nothing at the ~72 existing
// call sites, and a new rung is opt-in by id.
//
// Cozette is one hand-hinted bitmap font (a downscaled vector font goes fuzzy at
// this panel's DPI), but it ships only 6x13 and a mechanically-doubled 12x26 -
// no bold, no middle size, and 78 of its 95 glyphs already fill the 6px advance
// so a synthetic double-strike has nowhere to go. T_HEAD is Terminus 10x18 bold,
// the rung between them.
//
// cellH is what actually reaches the panel, size already applied. It is the one
// number the erase geometry in drawIfChanged depends on - see the note there.
// (Kept here, after the enums, so it isn't the file's first function definition -
// see the enum note above about auto-prototype insertion order. The UiFont type
// deliberately appears in no function SIGNATURE for the same reason: the Arduino
// build inserts generated prototypes above this point.)
const uint8_t FONT_CODE = 200;

struct UiFont { const GFXfont* gfx; uint8_t size; uint8_t cellH; };
static const UiFont UI_FONTS[] = {
  { &Cozette6x13,    1, 13 },  // 0 unused - aliases body so a bad id degrades to text
  { &Cozette6x13,    1, 13 },  // 1 T_META
  { &Cozette6x13,    1, 13 },  // 2 T_BODY (and T_TITLE, pending migration)
  { &Terminus10x18b, 1, 18 },  // 3 T_HEAD
  { &Cozette6x13,    2, 26 },  // 4 T_HERO
};

inline uint8_t uiFontIdx(uint8_t f) { return (f >= 1 && f <= 4) ? f : 2; }
inline uint8_t uiTextSize(uint8_t f) { return UI_FONTS[uiFontIdx(f)].size; }
inline int uiLineH(uint8_t f) { return UI_FONTS[uiFontIdx(f)].cellH; }
void setUIFont(uint8_t f) {
  const UiFont& uf = UI_FONTS[uiFontIdx(f)];
  tft.setFreeFont(uf.gfx);
  tft.setTextSize(uf.size);
}
```

- [ ] **Step 3: Add the `T_HEAD` token and note the `T_TITLE` deferral**

Replace lines 623-625:

```c
const uint8_t T_TITLE = 2;   // card/section titles, button labels, values
const uint8_t T_BODY  = 2;   // normal readable text
const uint8_t T_META  = 1;   // secondary labels, hints, units
```

with:

```c
// Semantic type tokens. These are font ids into UI_FONTS - see the registry above.
const uint8_t T_HERO  = 4;   // hero numbers (Cozette 12x26)
const uint8_t T_HEAD  = 3;   // display names and headings (Terminus 10x18 bold)
const uint8_t T_TITLE = 2;   // PENDING MIGRATION to T_HEAD - see below
const uint8_t T_BODY  = 2;   // normal readable text
const uint8_t T_META  = 1;   // secondary labels, hints, units
// T_TITLE deliberately still resolves to body. It is used inside uiButton, the
// single shared button style, so pointing it at T_HEAD would silently widen
// EVERY button label on the device - Allow/Deny and the confirm dialogs
// included - by 67%, past fixed widths chosen for a 6px face ("CALIBRATE TOUCH"
// is 90px at 6x13 and 150px at 10x18). That migration belongs with the
// settings/overlay restyle, where the button widths get re-derived.
```

- [ ] **Step 4: Make the erase rectangle font-derived**

In `drawIfChanged`, replace line 2144:

```c
    int th = 13 * tft.textsize;
```

with:

```c
    // Cell height comes from the registry, not a baked-in 13. A taller face
    // (T_HEAD is 18px) would otherwise clear only part of its own box and ghost
    // on every update - the same class of silent bug as a too-short cache.
    // uiLineH already has the font's own scale applied, so divide it back out
    // and re-apply the size actually in effect: the `size` argument above can
    // override the font's, and the erase height has to follow that override.
    int th = (uiLineH(font) / uiTextSize(font)) * tft.textsize;
```

- [ ] **Step 5: Confirm no hard-coded cell height survives in the draw helpers**

```bash
cd /Users/yujia/projects/deckhand/firmware/deckhand_display
grep -n '13 \* tft.textsize\|13 \* uiTextSize' deckhand_display.ino || echo "none left"
```

Expected: `none left`.

**Do NOT also "clean up" the `lineH` arguments passed to `drawWrappedText`.** They look like
duplicated cell heights and are not: `lineH` is a *leading* parameter, and the call sites pass
deliberately different values — `11` for the detail screen's prompt and path (tighter than the
13px cell), `13` for code blocks, `17` for the ask title (looser), plus the computed `dLineH`
and `HIST_LINE_H`. Replacing them with `uiLineH(font)` would retighten the ask title and loosen
the detail screen — two layouts outside this sub-project. Confirm they are untouched:

```bash
git diff -U0 -- deckhand_display.ino | grep -E '^[-+].*drawWrappedText\(' || echo "no call sites touched"
```

Expected: `no call sites touched`.

- [ ] **Step 6: Compile and compare against the baseline**

```bash
cd /Users/yujia/projects/deckhand
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" firmware/deckhand_display \
  2>&1 | grep -E 'Sketch uses|Global variables|error'
```

Expected: compiles clean. Flash grows by roughly 2850 B over the `1298694` baseline (the linker
may also inline the new accessors slightly differently). RAM stays near `76556` — the font is
`PROGMEM`. If flash grew by **less than ~2000 B**, the linker probably dropped the unused font;
that is fine at this task and it will appear once Task 4 references it.

- [ ] **Step 7: Flash and confirm nothing changed on screen**

```bash
cd /Users/yujia/projects/deckhand
PORT=$(ls /dev/cu.usbserial-* | head -1); echo "port=$PORT"
arduino-cli upload -p "$PORT" \
  --fqbn "esp32:esp32:esp32:UploadSpeed=115200,FlashMode=dio,FlashFreq=80,PartitionScheme=huge_app" \
  firmware/deckhand_display
```

This task is inert, so the acceptance criterion is **no visible difference**. Walk all three tabs
(USAGE, SESSIONS, SETTINGS) and confirm every field still renders, at the same size and position,
with no blanks and no ghosting. A blank field means a change-only cache was invalidated without a
repaint; a doubled/clipped field means the erase geometry is wrong.

- [ ] **Step 8: Commit**

```bash
git add firmware/deckhand_display/deckhand_display.ino
git commit -m "Put the fonts behind a registry, and derive erase height from it

setUIFont hard-coded Cozette and inferred size from 'f == 4 ? 2 : 1', so the
UI had exactly one size and its double - T_TITLE, T_BODY and T_META all
resolved to 6x13. UI_FONTS maps each id to (face, size, cellH); every id in
use keeps its current face, so this lands inert and the ~72 existing call
sites render byte-identically.

drawIfChanged's 'th = 13 * tft.textsize' baked the Cozette cell height into
every field's erase rectangle: any taller face would clear part of its box and
ghost on each update. It now comes from the registry, re-applying the size
override the signature already accepts.

T_HEAD (Terminus 10x18 bold) is declared but not yet used. T_TITLE stays on
body deliberately - it lives inside uiButton."
```

---

### Task 4: The three-rung name ladder in `drawSessionRow`

**Files:**
- Modify: `firmware/deckhand_display/deckhand_display.ino:2962-2984`

**Interfaces:**
- Consumes: `T_HEAD`, `T_HERO`, `T_BODY`, `uiLineH(uint8_t)`, `setUIFont(uint8_t)` from Task 3;
  `fitText(char*, size_t, const char*, int)` unchanged at line 2905.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Replace the two-step fallback with the ladder**

Replace lines 2962-2984 — the comment block through the `tft.drawString(nameBuf, ...)` call —
with:

```c
  // Three rungs, largest first: 12x26 -> 10x18 -> 6x13, taking the first whose
  // measured width fits the lane, so a long project name is shown WHOLE rather
  // than cut short. Before T_HEAD existed this was a single 26->13 cliff.
  // Compact rows start at the bottom rung, exactly as they always have: 26px
  // does not fit a 41-63px row.
  static const uint8_t NAME_RUNGS[] = { T_HERO, T_HEAD, T_BODY };
  char nameBuf[28]; // host caps the name at 22, plus "..." and a NUL
  uint8_t nameFont = T_BODY;
  for (int r = large ? 0 : 2; r < 3; r++) {
    nameFont = NAME_RUNGS[r];
    setUIFont(nameFont);
    if (tft.textWidth(s.name) <= laneW) break;
  }
  fitText(nameBuf, sizeof(nameBuf), s.name, laneW);
  if (nameBuf[0] == '\0' && nameFont != T_BODY) {
    // fitText gives up entirely when not even one character plus "..." fits.
    // That is reachable at 10px in a narrow lane where it never was at 6px, so
    // fall to the smallest rung rather than render a blank name.
    nameFont = T_BODY;
    setUIFont(nameFont);
    fitText(nameBuf, sizeof(nameBuf), s.name, laneW);
  }
  tft.setTextColor(COLOR_VALUE, COLOR_CARD);
  tft.setTextDatum(TL_DATUM);
  // A shrunk name is centred in the 26px band the big font would have filled, so
  // it doesn't hang off the top of the row with a gap under it. The old hardcoded
  // +6 was exactly this: (26 - 13) / 2. A title row starts 2px higher to buy the
  // third line its space.
  int nameTop = y + (showTitle ? 4 : 6);
  int nameOffset = large ? (uiLineH(T_HERO) - uiLineH(nameFont)) / 2 : 0;
  tft.drawString(nameBuf, nameX, nameTop + nameOffset);
```

Note the `bool smallName` declaration on old line 2967 disappears with this replacement — it had
no other reader.

- [ ] **Step 2: Confirm `smallName` really is gone and nothing else referenced it**

```bash
cd /Users/yujia/projects/deckhand/firmware/deckhand_display
grep -n 'smallName' deckhand_display.ino || echo "no references left"
```

Expected: `no references left`.

- [ ] **Step 3: Check the offsets arithmetically before flashing**

The three rungs must land at the offsets the old code produced for the two it had.

```bash
python3 -c "
band=26
for name,cell,old in [('T_HERO',26,0),('T_HEAD',18,None),('T_BODY',13,6)]:
    new=(band-cell)//2
    verdict='new rung' if old is None else ('OK' if new==old else f'REGRESSION was {old}')
    print(f'  {name:7} cell {cell:2}  offset {new}  {verdict}')"
```

Expected: `T_HERO` 0 OK, `T_HEAD` 4 new rung, `T_BODY` 6 OK.

Also confirm no rung collides with the title line, which is drawn at `y + 32`: the tallest name
box starts at `y + 4` and is 26px, ending at `y + 30`.

- [ ] **Step 4: Compile**

```bash
cd /Users/yujia/projects/deckhand
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" firmware/deckhand_display \
  2>&1 | grep -E 'Sketch uses|Global variables|error'
```

Expected: clean, and flash now ≈ `1301544` (baseline + 2850) since the font is genuinely
referenced. Record the actual numbers.

- [ ] **Step 5: Flash**

```bash
cd /Users/yujia/projects/deckhand
PORT=$(ls /dev/cu.usbserial-* | head -1)
arduino-cli upload -p "$PORT" \
  --fqbn "esp32:esp32:esp32:UploadSpeed=115200,FlashMode=dio,FlashFreq=80,PartitionScheme=huge_app" \
  firmware/deckhand_display
```

- [ ] **Step 6: Run the five hardware checks from the spec**

Drive both the row count and the name length with fake session files rather than waiting for
real ones. The displayed name comes from the git root of `cwd`, falling back to the directory
name outside a repo — so plain directories under `/tmp` give exact control over name length.

```bash
mk() {  # mk <id> <dirname> <status>
  mkdir -p "/tmp/$2"
  printf '{"session_id":"%s","cwd":"/tmp/%s","status":"%s","updated_at":%s000}\n' \
    "$1" "$2" "$3" "$(date +%s)" > ~/.claude/deckhand-sessions/"$1".json
}

# check 3 - one of each rung, on tall rows
mk tA api working                       # short  -> 12x26
mk tB deckhand-firmware waiting         # medium -> 10x18
mk tC a-very-long-project-name asking   # long   -> 6x13, trimmed with "..."
```

Then for checks 1, 2, 4 keep those three up; for check 5 vary the count:

```bash
rm -f ~/.claude/deckhand-sessions/t?.json && mk tA api working          # 1 row
# (re-run the three-session block above for 3 rows)
for i in A B C D E F; do mk "t$i" "proj-$i" working; done               # 6 rows
```

For check 2, change a live row's status in place and watch for ghosting:

```bash
mk tA api asking     # same id, new status - the row must repaint cleanly
```

**Delete them all afterwards**, or they linger until the host's `SESSION_STALE_MS` prune:

```bash
rm -f ~/.claude/deckhand-sessions/t?.json
```

| # | Check | Pass criterion |
|---|---|---|
| 1 | A Terminus name beside its Cozette sub-line | baselines look aligned; the name is not riding high or low against the sub-line |
| 2 | A session whose name or status changes while visible | no ghosting, no leftover pixels from the previous string |
| 3 | Short / medium / very long names | each picks a visibly different rung; a long name is trimmed with `...`, never blank |
| 4 | Toggle DARK ⇄ LIGHT (SETTINGS › DISPLAY & SOUND) | Terminus renders correctly on card fill in both |
| 5 | 1, 3 and 6 sessions | the 90px cap and `SESSION_TITLE_MIN_H` (85) still clear the status pill; no overlap |

- [ ] **Step 7: Commit**

```bash
git add firmware/deckhand_display/deckhand_display.ino
git commit -m "Give session names a middle rung instead of a 26->13 cliff

drawSessionRow tried 12x26 and dropped straight to 6x13, a 50% step its own
comment called 'one hard step, not a gradient'. With T_HEAD available it walks
12x26 -> 10x18 -> 6x13 and takes the first that fits the measured lane.

Centring generalises rather than staying hardcoded: the old +6 for a shrunk
name was exactly (26 - 13) / 2, so the offset is now derived from the chosen
rung's cell height and reproduces the old value at the bottom rung.

fitText can return an empty string when nothing fits at all, which is reachable
at 10px in a narrow lane where it was not at 6px; the ladder falls through to
the smallest rung rather than render a blank name."
```

---

### Task 5: Document the type scale

**Files:**
- Modify: `CLAUDE.md`
- Modify: `AGENTS.md` (regenerated, never hand-edited)

**Interfaces:**
- Consumes: the final state of Tasks 1-4.
- Produces: nothing.

- [ ] **Step 1: Add a type-scale bullet to `CLAUDE.md`**

Insert immediately after the existing `**Cozette code font.**` bullet (search for
`Cozette code font`), matching the surrounding style — dense, reason-first, recording what was
measured rather than what was intended:

```markdown
- **The type scale is three rungs, and two of them are Cozette's only options.** `UI_FONTS[]`
  maps a font id to `(face, size, cellH)`: `T_META`/`T_BODY` → Cozette 6x13, `T_HEAD` → Terminus
  10x18 bold, `T_HERO` → Cozette 12x26. The ids are the legacy TFT_eSPI numbers the ~72 existing
  call sites already pass, so the registry landed **inert** — adding a face cost zero changes at
  those sites. Two cheaper options were tested and ruled out, not argued about: Cozette's
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
  Cost: **+2850 bytes of flash** per face, zero RAM (`PROGMEM`). Regenerate with
  `python3 bdf2gfx.py <bdf> <Name> <yAdvance> > <Name>.h`; the BDFs are **not** committed (Cozette
  668KB, Terminus 1.1MB) but the generated headers and both OFL texts (`licenses/`) are.
  `bdf2gfx.py --verify <bdf> <header>` decodes a header and compares it glyph-for-glyph with its
  source, and `--selftest` corrupts one byte of `A` and fails if that goes unnoticed — the same
  teeth-proving trick as `palette-check.mjs --selftest`. That check earned its place: the
  generator had only ever been run on Cozette, whose glyphs are tightly cropped, and Terminus
  declares a uniform full-cell `BBX` that exercises packing paths which had never run.
```

- [ ] **Step 2: Regenerate `AGENTS.md`**

`AGENTS.md` is a verbatim copy of `CLAUDE.md` below an 11-line header. Never hand-edit it.

```bash
cd /Users/yujia/projects/deckhand
{ head -n 11 AGENTS.md; tail -n +4 CLAUDE.md; } > AGENTS.md.new && mv AGENTS.md.new AGENTS.md
```

- [ ] **Step 3: Confirm the two files agree**

```bash
cd /Users/yujia/projects/deckhand
diff <(tail -n +12 AGENTS.md) <(tail -n +4 CLAUDE.md) && echo "IN SYNC"
head -11 AGENTS.md | tail -3
```

Expected: `IN SYNC`, and the header's last lines are intact.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md AGENTS.md
git commit -m "Document the three-rung type scale and why T_TITLE stayed behind

Records the two measurements that killed the cheaper options - Cozette's hidpi
BDF being a byte-identical 2x upscale, and 78 of 95 glyphs already filling the
6px advance - so neither gets retried, plus the drawIfChanged erase-height trap
and the deliberate T_TITLE deferral."
```

---

## Verification Summary

| Layer | Check | Where |
|---|---|---|
| Generator | `--verify` passes on the shipped `Cozette6x13.h` | Task 1 Step 7 |
| Generator | `--selftest` catches a corrupted byte | Task 1 Step 7 |
| Generator | Regenerating Cozette changes comments only | Task 1 Step 11 |
| Font data | `--verify` + `--selftest` pass on `Terminus10x18b.h` | Task 2 Step 3 |
| Build | Compiles; flash ≈ +2850 B, RAM ≈ unchanged | Task 3 Step 6, Task 4 Step 4 |
| Regression | No hard-coded cell height remains | Task 3 Step 5 |
| Regression | Registry is inert — no visible change on any tab | Task 3 Step 7 |
| Arithmetic | Rung offsets reproduce the old values | Task 4 Step 3 |
| Hardware | The five spec checks | Task 4 Step 6 |
| Docs | `CLAUDE.md` and `AGENTS.md` in sync | Task 5 Step 3 |

## Rollback

The registry is inert by construction. To back out the visible change, revert Task 4 alone: the
font, registry, erase fix and generator improvements all stay without changing a pixel.
