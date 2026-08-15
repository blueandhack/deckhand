// TFT_eSPI configuration for the ELEGOO 2.8" ESP32 touchscreen (ILI9341).
//
// THIS IS THE ONLY COPY. TFT_eSPI reads its pin/driver config from a file inside
// the LIBRARY, not from the sketch, so reinstalling or updating the library wipes
// it and the build then fails in confusing ways. Keeping it here means the repo
// carries its own build config, and CI can install a clean TFT_eSPI and drop this
// over the top. To restore a local machine:
//
//   cp firmware/tft_setup/User_Setup.h ~/Documents/Arduino/libraries/TFT_eSPI/
//
// User_Setup.h for the ELEGOO E32R28T / E32N28T 2.8" ESP32-32E display module.
// Pin mapping taken from the official LCDWIKI demo instructions (CR2024-MI2830).
// Part of the Deckhand Claude Code status display project.

#define ILI9341_DRIVER

#define TFT_MISO 12
#define TFT_MOSI 13
#define TFT_SCLK 14
#define TFT_CS   15  // Chip select
#define TFT_DC    2  // Data/command
#define TFT_RST  -1  // Shared with EN, tie to -1 (reset via board EN)
#define TFT_BL   21  // Backlight control (handled manually in sketch too)
#define TFT_BACKLIGHT_ON HIGH

#define LOAD_GLCD
#define LOAD_FONT2
#define LOAD_FONT4
#define LOAD_FONT6
#define LOAD_FONT7
#define LOAD_FONT8
#define LOAD_GFXFF

#define SMOOTH_FONT

#define SPI_FREQUENCY       40000000
#define SPI_READ_FREQUENCY  20000000
#define SPI_TOUCH_FREQUENCY  2500000
