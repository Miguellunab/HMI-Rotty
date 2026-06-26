#pragma once

#include <Arduino.h>
#include "Config.h"
#include "Axis.h"

void hardwareInit(Axis axes[], uint8_t axisCount);

void enableDrivers();
void disableDrivers();
bool driversAreEnabled();

bool limitPressed(const Axis& axis);
bool limitReleased(const Axis& axis);
