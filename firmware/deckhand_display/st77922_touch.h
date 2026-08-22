/*
 * Minimal driver for the capacitive touch controller integrated into the
 * ST77922 display IC (I2C, 16-bit register addressing, addr 0x55).
 *
 * Register map and report format derived from Espressif's driver for the
 * sibling part: esp-iot-solution/components/display/lcd_touch/esp_lcd_touch_st77926
 */
#pragma once
#include <Arduino.h>

#define ST77922_TOUCH_ADDR          0x55
#define ST77922_MAX_POINTS          10

struct ST77922Point { uint16_t x, y; uint8_t strength; };

/* Shared legacy-I2C helpers (see st77922_touch.cpp for why not Wire). */
bool st77922_i2c_bus_init(int sda, int scl, uint32_t hz = 400000);
bool st77922_i2c_probe(uint8_t addr);

struct TouchInfo {
    bool     present    = false;   // chip answered on the bus
    uint8_t  chip_id    = 0;       // expect 0x83 or 0x84
    uint8_t  fw_version = 0;
    uint8_t  fw_rev[4]  = {0};
    uint16_t x_res      = 0;
    uint16_t y_res      = 0;
    uint8_t  max_points = 0;
    bool     checksum   = false;   // report carries a checksum byte
};

class ST77922Touch {
public:
    // Pulses the reset line, then reads the identity/config registers.
    bool begin(int sda, int scl, int rst_pin, int int_pin, uint32_t hz = 400000);

    const TouchInfo& info() const { return _info; }

    // Reads a touch report. Returns the number of valid points (0..max),
    // or -1 on an I2C/checksum error. `pts` must hold at least max_points.
    int read(ST77922Point *pts, uint8_t max);

    // Raw level of the INT line (true = asserted, i.e. driven low).
    bool intAsserted() const;

    const char* lastError() const { return _err; }

private:
    bool readReg(uint16_t reg, uint8_t *buf, size_t len);

    TouchInfo _info;
    int  _int_pin = -1;
    const char *_err = "";
};
