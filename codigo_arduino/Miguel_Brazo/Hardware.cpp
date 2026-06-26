#include "Hardware.h"

static bool driversEnabled = false;

void hardwareInit(Axis axes[], uint8_t axisCount) {
  pinMode(EN_PIN, OUTPUT);

  for (uint8_t i = 0; i < axisCount; i++) {
    pinMode(axes[i].stepPin, OUTPUT);
    pinMode(axes[i].dirPin, OUTPUT);

    if (axes[i].hasLimit) {
      pinMode(axes[i].limitPin, INPUT_PULLUP);
    } else {
      axes[i].position = 0;
      axes[i].homed = true;
    }

    digitalWrite(axes[i].stepPin, LOW);
    digitalWrite(axes[i].dirPin, axes[i].positiveDir);
  }

  disableDrivers();
}

void enableDrivers() {
  digitalWrite(EN_PIN, LOW);   // LOW habilita A4988
  driversEnabled = true;
}

void disableDrivers() {
  digitalWrite(EN_PIN, HIGH);  // HIGH deshabilita A4988
  driversEnabled = false;
}

bool driversAreEnabled() {
  return driversEnabled;
}

bool limitPressed(const Axis& axis) {
  if (!axis.hasLimit) return false;
  return digitalRead(axis.limitPin) == LIMIT_ACTIVE_STATE;
}

bool limitReleased(const Axis& axis) {
  return !limitPressed(axis);
}
