#pragma once

#include <Arduino.h>
#include "Axis.h"

void protocolInit(Axis axes[], uint8_t axisCount);
void protocolTick(Axis axes[], uint8_t axisCount);
