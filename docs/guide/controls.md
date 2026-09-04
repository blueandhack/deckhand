# Controls

> Moved out of README.md to keep it short. Index: [`docs/README.md`](../README.md).

---

## Controls

- **Tabs**: tap USAGE / SESSIONS / SETTINGS in the top bar.
- **Session detail**: tap a session row. **`< Back`** (top row) returns to the
  list; tapping the card opens the **history reader** — what you asked, what
  Claude said, what it ran, what came back, and what you allowed or denied,
  pulled from the Mac on demand. A `CHAT`/`ALL` chip filters conversation vs
  commands, and you move with `< PREV`/`NEXT >`, the scrubber bar, or by tapping
  a row to read that entry in full.
- **Record button**: `• REC`, a fourth slot at the right end of the tab bar.
  **Tap** to start recording, tap again to stop. It is drawn as a tab — same font
  and same accent underline when active — because pressed there means what active
  means on its neighbours; the leading dot is what says this one *does* something
  rather than going somewhere. See *Talking to a session*.
- **Brightness / sleep timeout / volume**: `-`/`+` steppers on SETTINGS. The
  whole left/right third of each card is a hit zone, which is much larger than
  the keys look, and the label sits between them so tapping it can't nudge the
  value. Sleep = backlight off after 15s–5m of no touch, or OFF to never sleep;
  any touch wakes it (that touch is consumed, so it won't also press whatever is
  underneath).
- **Sound**: SETTINGS toggle; turning it on plays the beep as a speaker test.
- **Power off**: tap **POWER OFF** on the SETTINGS tab, or hold the **BOOT** key
  ~1 second. This is ESP32 deep sleep
  (a true software power-off doesn't exist): screen, backlight, CPU, and
  radio all stop, dropping from ~100–150mA to a few mA — weeks of standby
  on battery instead of hours. **Touch the screen to turn it back on.**
  (Wake is deliberately touch, not the BOOT key — GPIO0 is a strapping
  pin, and waking with it held would boot into the serial bootloader.)
  The RESET key is always a hard power-on.
- **Auto power-off on battery**: if the device runs **on battery** with no
  active session for 20 minutes, it deep-sleeps by itself to save the
  battery (touch to wake) — the same power-down as holding BOOT. It **never**
  auto-sleeps while on USB power, no matter how long it's idle. Touch or any
  active session resets the 20-minute timer. (This is separate from, and
  goes further than, the SETTINGS "SLEEP AFTER" backlight dimming, which only
  turns the backlight off.)
- Settings (brightness, sleep, sound, touch calibration) persist across
  reboots and reflashes.
