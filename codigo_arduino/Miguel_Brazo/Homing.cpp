#include "Homing.h"
#include "Hardware.h"
#include "Motion.h"

static void addBackoffPositionStep(Axis& axis, bool direction) {
  if (!axis.homed) return;

  if (direction == axis.positiveDir) {
    axis.position++;
  } else {
    axis.position--;
  }
}

bool releaseAndBackoffAxis(Axis& axis, long extraSteps) {
  if (!axis.hasLimit) {
    return true;
  }

  bool awayDirection = !axis.homeDir;

  digitalWrite(axis.dirPin, awayDirection);

  long releaseCount = 0;

  while (limitPressed(axis) && releaseCount < axis.maxReleaseSteps) {
    singleStep(axis, axis.backoffSpeedSps);
    addBackoffPositionStep(axis, awayDirection);
    releaseCount++;
  }

  if (limitPressed(axis)) {
    return false;
  }

  for (long i = 0; i < extraSteps; i++) {
    singleStep(axis, axis.backoffSpeedSps);
    addBackoffPositionStep(axis, awayDirection);
  }

  return true;
}

bool homeAxis(Axis& axis) {
  if (!axis.hasLimit) {
    axis.homed = true;
    return true;
  }

  axis.homed = false;

  if (limitPressed(axis)) {
    if (!releaseAndBackoffAxis(axis, axis.homingBackoffSteps)) {
      return false;
    }
  }

  digitalWrite(axis.dirPin, axis.homeDir);

  long homingCount = 0;

  while (limitReleased(axis) && homingCount < axis.maxHomingSteps) {
    singleStep(axis, axis.homingSpeedSps);
    homingCount++;
  }

  if (!limitPressed(axis)) {
    return false;
  }

  delay(100);

  // Cero mecanico en el punto de final, luego backoff a zona segura.
  axis.position = 0;
  axis.homed = true;

  if (!releaseAndBackoffAxis(axis, axis.homingBackoffSteps)) {
    axis.homed = false;
    return false;
  }

  // Para HMI: la posicion segura despues del backoff queda como cero operativo.
  axis.position = 0;

  return true;
}

bool homeAllAxes(Axis axes[], uint8_t axisCount) {
  bool allOk = true;

  for (uint8_t i = 0; i < axisCount; i++) {
    if (!homeAxis(axes[i])) {
      allOk = false;
    }
  }

  return allOk;
}
