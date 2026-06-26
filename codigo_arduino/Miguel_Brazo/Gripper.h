#pragma once

#include <Arduino.h>

void gripperInit();

void gripperWriteAngle(int userAngle);
void gripperOpen();
void gripperClose();

bool gripperIsReady();
int gripperCurrentUserAngle();
int gripperCurrentPhysicalAngle();
const char* gripperStateName();
