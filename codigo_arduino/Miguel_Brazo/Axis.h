#pragma once

#include <Arduino.h>

enum AxisId {
  AXIS_X = 0,
  AXIS_Y = 1,
  AXIS_Z = 2,
  AXIS_WRIST = 3,
  AXIS_A = AXIS_WRIST,   // Alias para compatibilidad con versiones anteriores.
  AXIS_COUNT = 4
};

enum AxisUnit {
  UNIT_DEGREES,
  UNIT_MM
};

struct Axis {
  AxisId id;
  const char* name;

  uint8_t stepPin;
  uint8_t dirPin;
  uint8_t limitPin;
  bool hasLimit;

  bool positiveDir;
  bool homeDir;

  unsigned int moveSpeedSps;
  unsigned int homingSpeedSps;
  unsigned int backoffSpeedSps;

  long maxHomingSteps;
  long maxReleaseSteps;
  long maxManualSteps;

  long homingBackoffSteps;
  long safetyBackoffSteps;

  long position;
  bool homed;

  AxisUnit unit;
  float stepsPerUnit;
};
