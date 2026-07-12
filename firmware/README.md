# Firmware

`deckhand_display/deckhand_display.ino` is the ESP32 sketch. The Arduino
directory name and the `.ino` name must stay identical - that's an Arduino
requirement.

## TFT_eSPI configuration

TFT_eSPI is configured through a `User_Setup.h` that lives *inside the
library folder*, not here - that's just how TFT_eSPI works. `User_Setup.h`
in this directory is a copy of the working config for the ELEGOO
E32R28T/E32N28T board. Before compiling, copy it over the library's default:

```
cp firmware/User_Setup.h ~/Documents/Arduino/libraries/TFT_eSPI/User_Setup.h
```

(Path may differ if your Arduino sketchbook is elsewhere - it's wherever
`arduino-cli config get directories.user` points, under
`libraries/TFT_eSPI/`.)

## Libraries

From the Arduino Library Manager (or `arduino-cli lib install`):
`TFT_eSPI`, `ArduinoJson`, `XPT2046_Touchscreen`. `Preferences`, `BLEDevice`,
`BLEServer`, `BLEUtils`, `BLE2902` all ship with the `esp32:esp32` core.

## Build / flash

See the repository README's **Setup** section for the exact `arduino-cli`
commands (the FQBN flags matter on this board).
