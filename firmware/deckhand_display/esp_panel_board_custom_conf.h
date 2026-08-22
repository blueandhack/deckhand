/*
 * ESP32_Display_Panel custom board configuration for the LCDwiki ES3C35P.
 *
 * NOTE: the board that shipped with this unit had firmware built WITHOUT this
 * file, so esp_panel_board.cpp:init() aborted with "No default board
 * configuration detected" and the panel/backlight were never driven -- which is
 * why the screen appeared dead. This file is what makes the display come up.
 *
 * Touch is deliberately left disabled here: on the ST77922 the touch controller
 * is integrated into the display IC itself (I2C 0x55) and this library has no
 * ST77922 touch driver, so it is handled by st77922_touch.cpp instead.
 */
#pragma once

#define ESP_PANEL_BOARD_DEFAULT_USE_CUSTOM      (1)
#define ESP_PANEL_BOARD_NAME                    "LCDwiki:ES3C35P"

#define ESP_PANEL_BOARD_WIDTH                   (320)
#define ESP_PANEL_BOARD_HEIGHT                  (480)

/* ------------------------------- LCD -------------------------------------- */
#define ESP_PANEL_BOARD_USE_LCD                 (1)
#define ESP_PANEL_BOARD_LCD_CONTROLLER          ST77922
#define ESP_PANEL_BOARD_LCD_BUS_TYPE            (ESP_PANEL_BUS_TYPE_QSPI)
#define ESP_PANEL_BOARD_LCD_BUS_SKIP_INIT_HOST  (0)

#define ESP_PANEL_BOARD_LCD_QSPI_HOST_ID        (1)
#define ESP_PANEL_BOARD_LCD_QSPI_IO_SCK         (12)
#define ESP_PANEL_BOARD_LCD_QSPI_IO_DATA0       (11)
#define ESP_PANEL_BOARD_LCD_QSPI_IO_DATA1       (13)
#define ESP_PANEL_BOARD_LCD_QSPI_IO_DATA2       (14)
#define ESP_PANEL_BOARD_LCD_QSPI_IO_DATA3       (9)
#define ESP_PANEL_BOARD_LCD_QSPI_IO_CS          (10)
#define ESP_PANEL_BOARD_LCD_QSPI_MODE           (0)
#define ESP_PANEL_BOARD_LCD_QSPI_CLK_HZ         (40 * 1000 * 1000)
#define ESP_PANEL_BOARD_LCD_QSPI_CMD_BITS       (32)
#define ESP_PANEL_BOARD_LCD_QSPI_PARAM_BITS     (8)

#define ESP_PANEL_BOARD_LCD_FLAGS_ENABLE_IO_MULTIPLEX   (0)
#define ESP_PANEL_BOARD_LCD_FLAGS_MIRROR_BY_CMD         (1)

/*
 * Vendor init sequence, recovered from the working factory firmware. Without
 * this the driver falls back to its built-in ST77922 default, which is written
 * for a 532x300 panel and leaves this 320x480 glass dark even though the bus
 * works and the controller answers reads.
 */
#include "st77922_init_cmds.h"
#define ESP_PANEL_BOARD_LCD_VENDOR_INIT_CMD  ES3C35P_ST77922_INIT_CMD

#define ESP_PANEL_BOARD_LCD_COLOR_BITS          (ESP_PANEL_LCD_COLOR_BITS_RGB565)
#define ESP_PANEL_BOARD_LCD_COLOR_BGR_ORDER     (0)
#define ESP_PANEL_BOARD_LCD_COLOR_INEVRT_BIT    (0)

#define ESP_PANEL_BOARD_LCD_SWAP_XY             (0)
#define ESP_PANEL_BOARD_LCD_MIRROR_X            (0)
#define ESP_PANEL_BOARD_LCD_MIRROR_Y            (0)
#define ESP_PANEL_BOARD_LCD_GAP_X               (0)
#define ESP_PANEL_BOARD_LCD_GAP_Y               (0)

/* Panel reset is wired to the module EN net, not a GPIO. */
#define ESP_PANEL_BOARD_LCD_RST_IO              (-1)
#define ESP_PANEL_BOARD_LCD_RST_LEVEL           (0)

/* ------------------------------ Touch ------------------------------------- */
#define ESP_PANEL_BOARD_USE_TOUCH               (0)

/* ---------------------------- Backlight ----------------------------------- */
#define ESP_PANEL_BOARD_USE_BACKLIGHT           (1)
#define ESP_PANEL_BOARD_BACKLIGHT_TYPE          (ESP_PANEL_BACKLIGHT_TYPE_PWM_LEDC)
#define ESP_PANEL_BOARD_BACKLIGHT_IO            (41)
#define ESP_PANEL_BOARD_BACKLIGHT_ON_LEVEL      (1)
#define ESP_PANEL_BOARD_BACKLIGHT_PWM_FREQ_HZ           (5000)
#define ESP_PANEL_BOARD_BACKLIGHT_PWM_DUTY_RESOLUTION   (10)
#define ESP_PANEL_BOARD_BACKLIGHT_IDLE_OFF      (0)

/* ---------------------------- IO expander --------------------------------- */
#define ESP_PANEL_BOARD_USE_EXPANDER            (0)

/* ---------------------------- File version -------------------------------- */
#define ESP_PANEL_BOARD_CUSTOM_FILE_VERSION_MAJOR 1
#define ESP_PANEL_BOARD_CUSTOM_FILE_VERSION_MINOR 2
#define ESP_PANEL_BOARD_CUSTOM_FILE_VERSION_PATCH 0
