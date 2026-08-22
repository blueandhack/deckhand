// Copied VERBATIM from /Users/yujia/projects/demo/ES3C35P_Selftest, with one
// addition: the board-2-only guard immediately below. Everything from
// `#include "st77922_touch.h"` down is byte-for-byte the demo's file.
//
// WHY THE GUARD. Arduino compiles every .cpp in the sketch folder as its own
// translation unit regardless of what any .ino includes, so without it board
// 1's build compiles this file too - and the ONLY reference that matters is
// i2c_driver_install(), which drags legacy driver/i2c.c (and its global
// constructor) into a binary that has no I2C at all. Board 1's build is held
// byte-identical on purpose, so this file must contribute exactly nothing to
// it rather than "nothing that runs".
//
// Deliberately CONFIG_IDF_TARGET_ESP32S3 out of "sdkconfig.h", NOT
// BOARD_TOUCH_NEEDS_CAL out of "board.h" - the same reasoning panel_shim.cpp
// spells out at length: this is a standalone translation unit, board.h's
// board-1 branch needs CRAB_H already defined, and CONFIG_IDF_TARGET_ESP32S3
// is defined in a header rather than passed as a bare -D, so it must be
// included explicitly or the #if silently takes the board-1 branch on BOTH
// boards.
#include "sdkconfig.h"

#if !defined(CONFIG_IDF_TARGET_ESP32S3)
// Board 1 (plain ESP32, resistive XPT2046 on its own SPI bus): nothing in
// this file applies. See touch_hal.ino for the entry point both boards share.
#else

#include "st77922_touch.h"

/*
 * NOTE: this uses the LEGACY ESP-IDF I2C driver (driver/i2c.h) rather than
 * Arduino's Wire. ESP32_Display_Panel/esp-lib-utils link the legacy driver, and
 * legacy driver/i2c.c carries a global constructor (check_i2c_driver_conflict)
 * that calls abort() at startup if the new i2c_master driver is ALSO linked.
 * Wire in core 3.x uses the new driver, so including it here boot-loops the
 * board before main() runs. Staying on the legacy API keeps a single driver.
 */
#include "driver/i2c.h"

#define I2C_PORT            I2C_NUM_0
#define I2C_TIMEOUT_TICKS   pdMS_TO_TICKS(100)

// Register addresses (16-bit)
#define REG_FW_VERSION      0x0000
#define REG_X_RES_HIGH      0x0005
#define REG_MAX_TOUCHES     0x0009
#define REG_FW_REVISION_3   0x000C
#define REG_TOUCH_INFO      0x0010
#define REG_MISC_INFO       0x00F0
#define REG_CHIP_ID         0x00F4

#define HEADER_BYTES        4
#define BYTES_PER_POINT     7
#define CHECKSUM_BYTES      1
#define VALID_BIT           0x80
#define COORD_HIGH_MASK     0x3F
#define MISC_CHECKSUM_FLAG  0x10
#define CHECKSUM_INIT       0x5A

bool st77922_i2c_bus_init(int sda, int scl, uint32_t hz)
{
    // The legacy driver logs "i2c driver install error" and returns ESP_FAIL
    // (not ESP_ERR_INVALID_STATE) when the port is already installed, so track
    // it ourselves instead of trying to interpret the return code.
    static bool s_installed = false;
    if (s_installed) return true;

    i2c_config_t conf = {};
    conf.mode             = I2C_MODE_MASTER;
    conf.sda_io_num       = sda;
    conf.scl_io_num       = scl;
    conf.sda_pullup_en    = GPIO_PULLUP_ENABLE;
    conf.scl_pullup_en    = GPIO_PULLUP_ENABLE;
    conf.master.clk_speed = hz;

    if (i2c_param_config(I2C_PORT, &conf) != ESP_OK) return false;
    esp_err_t e = i2c_driver_install(I2C_PORT, I2C_MODE_MASTER, 0, 0, 0);
    if (e != ESP_OK && e != ESP_ERR_INVALID_STATE) return false;
    s_installed = true;
    return true;
}

bool st77922_i2c_probe(uint8_t addr)
{
    i2c_cmd_handle_t cmd = i2c_cmd_link_create();
    i2c_master_start(cmd);
    i2c_master_write_byte(cmd, (addr << 1) | I2C_MASTER_WRITE, true);
    i2c_master_stop(cmd);
    esp_err_t e = i2c_master_cmd_begin(I2C_PORT, cmd, pdMS_TO_TICKS(40));
    i2c_cmd_link_delete(cmd);
    return e == ESP_OK;
}

bool ST77922Touch::readReg(uint16_t reg, uint8_t *buf, size_t len)
{
    uint8_t addr_buf[2] = { (uint8_t)(reg >> 8), (uint8_t)(reg & 0xFF) };
    esp_err_t e = i2c_master_write_read_device(I2C_PORT, ST77922_TOUCH_ADDR,
                                              addr_buf, sizeof(addr_buf),
                                              buf, len, I2C_TIMEOUT_TICKS);
    if (e != ESP_OK) {
        _err = (e == ESP_ERR_TIMEOUT) ? "I2C timeout" : "I2C NACK/error";
        return false;
    }
    return true;
}

bool ST77922Touch::begin(int sda, int scl, int rst_pin, int int_pin, uint32_t hz)
{
    _int_pin = int_pin;

    if (rst_pin >= 0) {
        pinMode(rst_pin, OUTPUT);
        digitalWrite(rst_pin, LOW);      // reset is active low
        delay(2);
        digitalWrite(rst_pin, HIGH);
        delay(120);                      // let the touch firmware boot
    }
    if (int_pin >= 0) pinMode(int_pin, INPUT_PULLUP);

    if (!st77922_i2c_bus_init(sda, scl, hz)) { _err = "I2C bus init failed"; return false; }

    uint8_t res[4] = {0}, misc = 0;
    if (!readReg(REG_CHIP_ID, &_info.chip_id, 1)) return false;
    _info.present = true;

    readReg(REG_FW_VERSION,    &_info.fw_version, 1);
    readReg(REG_FW_REVISION_3, _info.fw_rev, 4);
    readReg(REG_X_RES_HIGH,    res, 4);
    readReg(REG_MAX_TOUCHES,   &_info.max_points, 1);
    readReg(REG_MISC_INFO,     &misc, 1);

    _info.x_res    = ((uint16_t)(res[0] & COORD_HIGH_MASK) << 8) | res[1];
    _info.y_res    = ((uint16_t)(res[2] & COORD_HIGH_MASK) << 8) | res[3];
    _info.checksum = (misc & MISC_CHECKSUM_FLAG) != 0;

    if (_info.max_points == 0 || _info.max_points > ST77922_MAX_POINTS) {
        _info.max_points = ST77922_MAX_POINTS;
    }
    return true;
}

int ST77922Touch::read(ST77922Point *pts, uint8_t max)
{
    uint8_t n_slots = _info.max_points;
    uint8_t buf[HEADER_BYTES + ST77922_MAX_POINTS * BYTES_PER_POINT + CHECKSUM_BYTES] = {0};
    size_t  len = HEADER_BYTES + n_slots * BYTES_PER_POINT + CHECKSUM_BYTES;

    if (!readReg(REG_TOUCH_INFO, buf, len)) return -1;

    if (buf[0] & 0x80) {          // firmware is asking to be reset
        _err = "touch FW requested reset";
        return 0;
    }

    if (_info.checksum) {
        uint8_t sum = CHECKSUM_INIT;
        for (int i = 0; i < HEADER_BYTES; i++) sum += buf[i];
        if (buf[0] & 0x08) {      // point payload included in the checksum
            for (size_t i = HEADER_BYTES; i < HEADER_BYTES + n_slots * BYTES_PER_POINT; i++) sum += buf[i];
        }
        if (sum != buf[len - 1]) {
            _err = "touch report checksum mismatch";
            return -1;
        }
    }

    int found = 0;
    const uint8_t *p = buf + HEADER_BYTES;
    for (int i = 0; i < n_slots && found < max; i++, p += BYTES_PER_POINT) {
        if (!(p[0] & VALID_BIT)) continue;
        pts[found].x        = ((uint16_t)(p[0] & COORD_HIGH_MASK) << 8) | p[1];
        pts[found].y        = ((uint16_t)(p[2] & COORD_HIGH_MASK) << 8) | p[3];
        pts[found].strength = p[4];
        found++;
    }
    return found;
}

bool ST77922Touch::intAsserted() const
{
    if (_int_pin < 0) return false;
    return digitalRead(_int_pin) == LOW;
}

#endif  // CONFIG_IDF_TARGET_ESP32S3
