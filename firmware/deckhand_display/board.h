// Which board this build targets. Selected from the COMPILE TARGET, never a
// hand-edited switch: the toolchain defines CONFIG_IDF_TARGET_ESP32S3 for the
// S3, so `arduino-cli compile --fqbn esp32:esp32:esp32s3,...` picks board 2 and
// plain esp32 picks board 1. A manual switch is a binary that looks right and
// is wrong when someone forgets to flip it.
#pragma once
#if defined(CONFIG_IDF_TARGET_ESP32S3)
  #include "board_es3c35p.h"
#else
  #include "board_e32r28t.h"
#endif
