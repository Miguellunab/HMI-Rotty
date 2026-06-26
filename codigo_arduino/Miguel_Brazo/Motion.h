#pragma once

#include <Arduino.h>
#include "Axis.h"

void singleStep(const Axis& axis, unsigned int speedSps);

long absLong(long value);
long clampSteps(long value, long limit);
long unitsToSteps(const Axis& axis, float units);
float stepsToUnits(const Axis& axis, long steps);
unsigned int clampSpeedSps(unsigned int speedSps);
unsigned int speedSpsToDelayUs(unsigned int speedSps);

bool moveAxisSafe(Axis& axis, long steps);
bool moveAxisSafe(Axis& axis, long steps, unsigned int speedSps);

bool moveXYZSimultaneousSafe(Axis axes[], long stepsX, long stepsY, long stepsZ);
