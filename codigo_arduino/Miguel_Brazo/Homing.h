#pragma once

#include <Arduino.h>
#include "Axis.h"

bool releaseAndBackoffAxis(Axis& axis, long extraSteps);

bool homeAxis(Axis& axis);
bool homeAllAxes(Axis axes[], uint8_t axisCount);
