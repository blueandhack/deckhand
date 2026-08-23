/*
 * ST77922 initialisation sequence for the LCDwiki ES3C35P 320x480 panel.
 *
 * Recovered from the vendor's own working firmware (lv_demo_widgets.bin) by
 * locating the esp_panel_lcd_vendor_init_cmd_t table in its DROM segment.
 * ESP32_Display_Panel's built-in ST77922 default sequence targets a 532x300
 * panel (it sets CASET 0..0x213 / RASET 0..0x12B), which leaves this 320x480
 * glass alive on the bus but never displaying. This table sets
 * CASET 0..0x13F (320) and RASET 0..0x1DF (480).
 *
 * Entries whose data was all zeros lived in .bss and are reconstructed as zeros.
 *
 * ONE ENTRY IS DELIBERATELY NOT WHAT THE VENDOR BINARY HELD. COLMOD (0x3A) is
 * 0x55 here, 16bpp RGB565; the recovered table had 0x01, which is not a pixel
 * format on any ST77xx part - 0x55/0x66/0x77 are the 16/18/24-bit values. It
 * matters because this table is applied AFTER esp_panel has already configured
 * RGB565 from ESP_PANEL_BOARD_LCD_COLOR_BITS, so a wrong value here STOMPS a
 * correct one, and the symptom was a UI whose colours were wrong in a way no
 * byte-order change could fix.
 * 0x21 (INVON) IS CORRECT AND MUST STAY. This panel is natively inverted, so
 * inversion ON is what makes it display normally - proved by turning it off:
 * with INVOFF and the byte order already right, every colour came back as its
 * exact complement (WHITE black, GREEN purple, BLUE yellow), and INVON restored
 * it. Do not "fix" this to 0x20; it was tried, on hardware, and it is wrong.
 * That experiment is the reason this paragraph exists rather than a bare value.
 *
 * The colour fault here was COLMOD alone, and it was hard to see precisely
 * BECAUSE INVON is required: a wrong pixel format and a correct inversion
 * together produce a screen that is merely "wrong", which invites blaming the
 * inversion. WHITE rendering as BLACK is the one observation that separates them,
 * since no byte order or channel permutation can produce it - only inversion can,
 * and if inversion is supposed to be on then seeing it means something else is
 * cancelling it.
 * The other half of the fix is not in this file: BOARD_PANEL_SWAP_BYTES 1 in
 * board_es3c35p.h, because the panel reads our little-endian framebuffer
 * high-byte-first. COLMOD, byte order and inversion are three independent axes
 * and two were wrong; SWAP and INV exist as runtime commands so the next person
 * can separate them in seconds instead of one reflash per guess.
 *
 * The general point, for the next person tempted to defer to this table: it was
 * reverse-engineered out of a binary and some of it was reconstructed from .bss.
 * Where it disagrees with the datasheet about a register whose meaning is
 * standard, check it on the glass. Two entries have now turned out wrong (the
 * CASET/RASET geometry above, and COLMOD) and one that LOOKS wrong is right.
 */
#pragma once

#define ES3C35P_ST77922_INIT_CMD()                                          \
    {                                                                       \
        {0xF1, (uint8_t []){0x00}, 1, 0},                                                               \
        {0x60, (uint8_t []){0x00, 0x00, 0x00}, 3, 0},                                                   \
        {0x65, (uint8_t []){0x80}, 1, 0},                                                               \
        {0x79, (uint8_t []){0x06}, 1, 0},                                                               \
        {0x7B, (uint8_t []){0x00, 0x08, 0x08}, 3, 0},                                                   \
        {0x80, (uint8_t []){0x55, 0x62, 0x2F, 0x17, 0xF0, 0x52, 0x70, 0xD2, 0x52, 0x62, 0xEA}, 11, 0},  \
        {0x81, (uint8_t []){0x26, 0x52, 0x72, 0x27}, 4, 0},                                             \
        {0x84, (uint8_t []){0x92, 0x25}, 2, 0},                                                         \
        {0x87, (uint8_t []){0x10, 0x10, 0x58, 0x00, 0x02, 0x3A}, 6, 0},                                 \
        {0x88, (uint8_t []){0x00, 0x00, 0x2C, 0x10, 0x04, 0x00, 0x00, 0x00, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x06}, 15, 0},\
        {0x89, (uint8_t []){0x00, 0x00, 0x00}, 3, 0},                                                   \
        {0x8A, (uint8_t []){0x13, 0x00, 0x2C, 0x00, 0x00, 0x2C, 0x10, 0x10, 0x00, 0x3E, 0x19}, 11, 0},  \
        {0x8B, (uint8_t []){0x15, 0xB1, 0xB1, 0x44, 0x96, 0x2C, 0x10, 0x97, 0x8E}, 9, 0},               \
        {0x8C, (uint8_t []){0x1D, 0xB1, 0xB1, 0x44, 0x96, 0x2C, 0x10, 0x50, 0x0F, 0x01, 0xC5, 0x12, 0x09}, 13, 0},\
        {0x8D, (uint8_t []){0x0C}, 1, 0},                                                               \
        {0x8E, (uint8_t []){0x33, 0x01, 0x0C, 0x13, 0x01, 0x01}, 6, 0},                                 \
        {0xB3, (uint8_t []){0x00, 0x30}, 2, 0},                                                         \
        {0xF1, (uint8_t []){0x00}, 1, 0},                                                               \
        {0x71, (uint8_t []){0xC0}, 1, 0},                                                               \
        {0x66, (uint8_t []){0x02, 0x3F}, 2, 0},                                                         \
        {0xBE, (uint8_t []){0x24, 0x00, 0x9D}, 3, 0},                                                   \
        {0x70, (uint8_t []){0x01, 0xA0, 0x11, 0x40, 0xE0, 0x00, 0x11, 0x69, 0x11, 0x00, 0x00, 0x1A}, 12, 0},\
        {0x90, (uint8_t []){0x04, 0x04, 0x55, 0x74, 0x00, 0x40, 0x43, 0x27, 0x27}, 9, 0},               \
        {0x91, (uint8_t []){0x04, 0x04, 0x55, 0x75, 0x00, 0x40, 0x42, 0x27, 0x27}, 9, 0},               \
        {0x92, (uint8_t []){0x04, 0x44, 0x55, 0xC0, 0x06, 0x00, 0x07, 0x05, 0x90, 0x27}, 10, 0},        \
        {0x93, (uint8_t []){0x04, 0x43, 0x11, 0x00, 0x00, 0x00, 0x00, 0x05, 0x90, 0x27}, 10, 0},        \
        {0x94, (uint8_t []){0x00, 0x00, 0x00, 0x00, 0x00, 0x00}, 6, 0},                                 \
        {0x95, (uint8_t []){0x96, 0x16, 0x00, 0x00, 0xFF}, 5, 0},                                       \
        {0x96, (uint8_t []){0x44, 0x53, 0x03, 0x12, 0x23, 0x24, 0x06, 0x05, 0x94, 0x27, 0x00, 0x44}, 12, 0},\
        {0x97, (uint8_t []){0x44, 0x53, 0x47, 0x56, 0x20, 0x20, 0x02, 0x01, 0x94, 0x27, 0x00, 0x44}, 12, 0},\
        {0xBA, (uint8_t []){0x55, 0x94, 0x2D, 0x94, 0x27}, 5, 0},                                       \
        {0x9A, (uint8_t []){0x40, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00}, 7, 0},                           \
        {0x9B, (uint8_t []){0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00}, 7, 0},                           \
        {0x9C, (uint8_t []){0x5C, 0x12, 0x00, 0x00, 0x10, 0x12, 0x00, 0x00, 0x10, 0x02, 0x00, 0x00, 0x00}, 13, 0},\
        {0x9D, (uint8_t []){0x8A, 0x51, 0x00, 0x00, 0x00, 0x80, 0x1E, 0x01}, 8, 0},                     \
        {0x9E, (uint8_t []){0x51, 0x00, 0x00, 0x00, 0x80, 0x1E, 0x01}, 7, 0},                           \
        {0xB4, (uint8_t []){0x1D, 0x1C, 0x1E, 0x0B, 0x14, 0x02, 0x13, 0x09, 0x1E, 0x00, 0x1E, 0x10}, 12, 0},\
        {0xB5, (uint8_t []){0x1D, 0x1C, 0x1E, 0x0A, 0x15, 0x03, 0x11, 0x08, 0x1E, 0x01, 0x1E, 0x12}, 12, 0},\
        {0xB6, (uint8_t []){0x77, 0x77, 0x00, 0x0A, 0xFF, 0x0A, 0xFF}, 7, 0},                           \
        {0x86, (uint8_t []){0xCD, 0x04, 0xB1, 0x02, 0x58, 0x12, 0x58, 0x0C, 0x13, 0x01, 0xA5, 0x00, 0xA5, 0xA5}, 14, 0},\
        {0xB7, (uint8_t []){0x07, 0x0A, 0x0E, 0x06, 0x05, 0x03, 0x2B, 0x03, 0x03, 0x42, 0x07, 0x10, 0x10, 0x2E, 0x3F, 0x0D}, 16, 0},\
        {0xB8, (uint8_t []){0x07, 0x0A, 0x0D, 0x05, 0x05, 0x02, 0x2B, 0x02, 0x03, 0x42, 0x06, 0x10, 0x0F, 0x2E, 0x3F, 0x0D}, 16, 0},\
        {0xB9, (uint8_t []){0x23, 0x23}, 2, 0},                                                         \
        {0xBF, (uint8_t []){0x10, 0x14, 0x14, 0x0B, 0x0B, 0x0B}, 6, 0},                                 \
        {0xF2, (uint8_t []){0x00}, 1, 0},                                                               \
        {0x73, (uint8_t []){0x04, 0xDA, 0x12, 0x54, 0x47}, 5, 0},                                       \
        {0x77, (uint8_t []){0x6B, 0x5B, 0xFD, 0xC3, 0xC5}, 5, 0},                                       \
        {0x7A, (uint8_t []){0x15, 0x27}, 2, 0},                                                         \
        {0x7B, (uint8_t []){0x04, 0x57}, 2, 0},                                                         \
        {0x7E, (uint8_t []){0x01, 0x0E}, 2, 0},                                                         \
        {0xBF, (uint8_t []){0x36}, 1, 0},                                                               \
        {0xE3, (uint8_t []){0x40, 0x40}, 2, 0},                                                         \
        {0xF0, (uint8_t []){0x00}, 1, 0},                                                               \
        {0xD0, (uint8_t []){0x00}, 1, 0},                                                               \
        {0x2A, (uint8_t []){0x00, 0x00, 0x01, 0x3F}, 4, 0},                                             \
        {0x2B, (uint8_t []){0x00, 0x00, 0x01, 0xDF}, 4, 0},                                             \
        {0x21, (uint8_t []){0x00}, 0, 0},  /* INVON - REQUIRED, see header */          \
        {0x11, (uint8_t []){0x00}, 0, 120},                                                             \
        {0x29, (uint8_t []){0x00}, 0, 0},                                                               \
        {0x2C, (uint8_t []){0x00}, 0, 0},                                                               \
        {0x3A, (uint8_t []){0x55}, 1, 0},  /* COLMOD 16bpp RGB565 - see header */      \
        {0x36, (uint8_t []){0x00}, 1, 0},                                                               \
        {0x35, (uint8_t []){0x01}, 1, 20},                                                              \
    }
