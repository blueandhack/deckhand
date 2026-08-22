// Board 2: LCDwiki 3.5" ESP32-S3 Display (ES3C35P / ES3C35P-NS), ST77922
// panel over QSPI, 320x480. Pins copied verbatim from
// /Users/yujia/projects/demo/ES3C35P_Selftest/board_pins.h (LCDWIKI pin
// allocation table for this exact board).
//
// LAYOUT CONSTANTS ARE DELIBERATELY ABSENT. A later task derives them from
// the real panel geometry; a set of guessed numbers sitting in this header
// would look finished, whereas the resulting compile error does not - and a
// compile error is the correct, honest state for this board right now.
#pragma once

#define BOARD_NAME "ES3C35P"
#define BOARD_W 320
#define BOARD_H 480

#define BOARD_USES_TFT_ESPI  0
#define BOARD_BLE_NIMBLE     1
#define BOARD_HAS_MIC        0   // I2S codec exists; the mic PATH is a later spec
#define BOARD_HAS_BEEPER     0   // same - LEDC square wave does not port to I2S
#define BOARD_HAS_SD         1
#define BOARD_HAS_RGBLED     1
#define BOARD_TOUCH_NEEDS_CAL 0  // capacitive, factory-aligned

// ---- LCD: ST77922, 320x480, QSPI. Panel reset is tied to chip EN (no GPIO). --
#define PIN_LCD_CS        10
#define PIN_LCD_SCK       12
#define PIN_LCD_D0        11
#define PIN_LCD_D1        13
#define PIN_LCD_D2        14
#define PIN_LCD_D3         9
#define PIN_LCD_RST       -1
#define PIN_BACKLIGHT     41    // high = backlight on

// ---- Touch: integrated into the ST77922, I2C addr 0x55, shared I2C bus ------
#define PIN_I2C_SDA       38
#define PIN_I2C_SCL       39
#define PIN_TOUCH_RST     48    // active low
#define PIN_TOUCH_INT     47    // active low on touch event

// ---- microSD, SDMMC 4-bit ---------------------------------------------------
#define PIN_SD_CLK         5
#define PIN_SD_CMD         4
#define PIN_SD_D0          6
#define PIN_SD_D1          7
#define PIN_SD_D2          2
#define PIN_SD_D3          3

// ---- Audio: I2S codec + amplifier ------------------------------------------
#define PIN_AMP_EN         1
#define PIN_I2S_MCLK      17
#define PIN_I2S_BCLK      18
#define PIN_I2S_DOUT      15
#define PIN_I2S_LRCK      21
#define PIN_I2S_DIN       16

// ---- Misc ------------------------------------------------------------------
#define PIN_RGB_LED       40    // addressable (WS2812-style) RGB LED
#define PIN_BOOT_BTN       0    // active low
#define PIN_BAT_ADC        8    // battery voltage divider
#define PIN_EXP_IO_A      45
#define PIN_EXP_IO_B      46
