# Hardware

> Moved out of README.md to keep it short. Index: [`docs/README.md`](../README.md).

---

## Hardware

**There are two supported boards.** Board 1 is the one everything below defaults to and the one all
the optional add-ons are for. Board 2 is bigger, faster over USB, and does not have working audio
yet.

| | board 1 — the default | board 2 |
|---|---|---|
| what it is | ELEGOO **E32R28T** / E32N28T — 2.8" ESP32, 240x320 ILI9341 | LCDwiki **ES3C35P** — 3.5" ESP32-S3, 320x480 ST77922 |
| touch | resistive, one-time 5-point calibration on first boot | capacitive, factory-aligned, no calibration |
| USB | CH340 serial, `/dev/cu.usbserial-*` | native USB, `/dev/cu.usbmodem*` |
| flash it | `./flash.sh` | `./flash.sh --board 2` |
| microphone | fits a MAX4466 module — dictation works | has a real I2S mic on board, **no software for it yet** |
| beeper | 1W speaker, needs-input beep | speaker present, **not driven yet** |
| auto-sleep | yes, wakes on a held touch | **no** — the chip cannot wake from deep sleep by touch, so it is disabled |
| screenshots | ~18s each | ~0.4s each |

Everything else is the same firmware and the same host: the same three tabs, the same session list,
the same remote answering, the same pairing. Board 2's layout is **re-derived** for 320x480 rather
than scaled up, so the extra pixels become more rows and more air — four sessions keep their titles
where board 1 loses them at four, and the keyboard's keys grow from 22x40 to 30x54.

The rest of this section is board 1.

| | part | what to buy |
|---|---|---|
| **Required** | Display board | [ELEGOO E32R28T / E32N28T](https://www.amazon.com/dp/B0FJQ6RK39) — 2.8" ESP32, 240x320 ILI9341, USB-C (2-pack) |
| Optional | Battery | [3.7V 3000mAh LiPo](https://www.amazon.com/dp/B08T6GT7DV) — JST 1.25, protection circuit (4-pack) |
| Optional | Speaker | [1W 8Ω mini speaker](https://www.amazon.com/dp/B0D7SC3ZFG) — JST-PH 1.25 (10-pack) |
| Optional | Microphone | [MAX4466 electret amp module](https://www.amazon.com/dp/B08N4FNFTR) — adjustable gain (6-pack) |
| Optional | Case | print it yourself — [`case/`](case/) |

*The exact parts this was built and tested with, not recommendations. Note the
multipacks. Listings go stale, so the specs below are what actually matter if an
ASIN has moved on.*

The board is a 240x320 ILI9341 LCD with an XPT2046 resistive touch panel, and
talks to the Mac over **USB (CH340 USB-serial) and/or BLE** — both are always enabled on the device
simultaneously, and the host script sends to whichever are currently
connected (it's normal and expected for both to be connected at once).
Pin mapping (LCD + touch + battery ADC + audio) is documented at the top
of `firmware/deckhand_display/deckhand_display.ino`.

Optional add-ons — the battery and speaker just plug in; the microphone needs
three wires:

- **Battery** — a 1S LiPo on the JST 1.25 battery connector (tested with a
  3000mAh cell, which is what the case is sized for). Charging and power switching are pure hardware: the
  board's TP4054 charges at ~290mA whenever USB-C is present, and a P-FET
  power path runs the module from the battery the moment USB is unplugged.
  The firmware reads the level through the board's divider on IO34 and
  shows it in the footer and on SETTINGS. Heads-up: there is no VBUS-sense
  pin, so a *data-less* wall charger displays as "on battery" even while
  the hardware is charging.
- **Speaker** — a 1W 8Ω mini speaker on the JP1 terminals, driven by the
  onboard FM8002E amplifier. Used for the needs-input beep. Volume is set on
  the device (SETTINGS → DISPLAY & SOUND → VOLUME: LOW/MED/HIGH); the levels
  are the `VOL_PRESETS` duty values in the firmware.

- **Microphone** — a MAX4466 electret amp module, for dictating to a session
  (see *Talking to a session*). Three wires to the board's 4-pin **Expand**
  connector:

  | module pad | goes to |
  |---|---|
  | `VCC` | **3.3 V — never 5 V** |
  | `GND` | GND |
  | `OUT` | **IO35** |

  `IO35` isn't a choice: touch takes ADC1's 32/33/36/39 and the battery divider
  takes 34, leaving it as the only free ADC1 channel — and ADC1 is mandatory
  because ADC2 is dead while Bluetooth is active. **Never power it from 5 V**
  even though the module accepts 2.4–5.5 V: IO35 is not 5 V tolerant. Identify
  3.3 V and GND from the header's silkscreen and *meter them before plugging in* —
  reverse polarity drags the 3.3 V rail and the board won't boot, which looks
  exactly like bricked firmware (dark screen, no serial, while esptool still
  answers).
  To check it, tap **SETTINGS → ACTIONS → MIC TEST** for a live level meter. A
  working module idles at **~1.65 V** (VCC/2); a reading pinned near 0 means `OUT`
  isn't connected or it has no power. Aim for a silent floor of ~100–150 on the
  gain trimmer.

Bluetooth is **BLE** (a custom GATT service, the Nordic UART Service
pattern), not classic Bluetooth SPP. SPP was tried first and abandoned:
macOS's classic-BT stack would silently accept writes into a connection
with no real over-the-air session, a failure mode that recurred even
after a full unpair/restart/re-pair. BLE is far more actively maintained
on macOS since it's what nearly all modern accessories use.
