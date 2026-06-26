#include "Motion.h"
#include "Config.h"
#include "Hardware.h"

unsigned int clampSpeedSps(unsigned int speedSps) {
  if (speedSps < MIN_SPEED_SPS) return MIN_SPEED_SPS;
  if (speedSps > MAX_SPEED_SPS) return MAX_SPEED_SPS;
  return speedSps;
}

unsigned int speedSpsToDelayUs(unsigned int speedSps) {
  speedSps = clampSpeedSps(speedSps);

  // Cada paso usa dos delays: STEP HIGH y STEP LOW.
  // delayUs = 1 segundo / (2 * pasosPorSegundo)
  unsigned long delayUs = 500000UL / speedSps;

  if (delayUs < 2UL) delayUs = 2UL;
  if (delayUs > 20000UL) delayUs = 20000UL;

  return (unsigned int)delayUs;
}

void singleStep(const Axis& axis, unsigned int speedSps) {
  unsigned int delayUs = speedSpsToDelayUs(speedSps);

  digitalWrite(axis.stepPin, HIGH);
  delayMicroseconds(delayUs);
  digitalWrite(axis.stepPin, LOW);
  delayMicroseconds(delayUs);
}

long absLong(long value) {
  if (value < 0) return -value;
  return value;
}

long clampSteps(long value, long limit) {
  if (value > limit) return limit;
  if (value < -limit) return -limit;
  return value;
}

long unitsToSteps(const Axis& axis, float units) {
  float rawSteps = units * axis.stepsPerUnit;

  if (rawSteps >= 0.0f) {
    return (long)(rawSteps + 0.5f);
  }

  return (long)(rawSteps - 0.5f);
}

float stepsToUnits(const Axis& axis, long steps) {
  if (axis.stepsPerUnit == 0.0f) return 0.0f;
  return ((float)steps) / axis.stepsPerUnit;
}

static void addPositionStep(Axis& axis, bool direction) {
  if (!axis.homed) return;

  if (direction == axis.positiveDir) {
    axis.position++;
  } else {
    axis.position--;
  }
}

static unsigned int selectedMoveSpeed(const Axis& axis, bool moveDirection) {
  if (axis.id == AXIS_Z) {
    bool goingUp = (moveDirection == axis.positiveDir);
    return goingUp ? Z_UP_SPEED_SPS : Z_DOWN_SPEED_SPS;
  }

  return axis.moveSpeedSps;
}

bool moveAxisSafe(Axis& axis, long steps) {
  return moveAxisSafe(axis, steps, axis.moveSpeedSps);
}

bool moveAxisSafe(Axis& axis, long steps, unsigned int speedSps) {
  steps = clampSteps(steps, axis.maxManualSteps);

  if (steps == 0) {
    return true;
  }

  bool moveDirection = (steps > 0) ? axis.positiveDir : !axis.positiveDir;
  bool movingTowardLimit = (moveDirection == axis.homeDir);
  long totalSteps = absLong(steps);

  unsigned int selectedSpeed = speedSps;

  if (axis.id == AXIS_Z && speedSps == axis.moveSpeedSps) {
    selectedSpeed = selectedMoveSpeed(axis, moveDirection);
  }

  selectedSpeed = clampSpeedSps(selectedSpeed);

  digitalWrite(axis.dirPin, moveDirection);

  if (movingTowardLimit && limitPressed(axis)) {
    return false;
  }

  for (long i = 0; i < totalSteps; i++) {
    if (movingTowardLimit && limitPressed(axis)) {
      return false;
    }

    singleStep(axis, selectedSpeed);
    addPositionStep(axis, moveDirection);

    if (movingTowardLimit && limitPressed(axis)) {
      return false;
    }
  }

  return true;
}

bool moveXYZSimultaneousSafe(Axis axes[], long stepsX, long stepsY, long stepsZ) {
  Axis& x = axes[AXIS_X];
  Axis& y = axes[AXIS_Y];
  Axis& z = axes[AXIS_Z];

  stepsX = clampSteps(stepsX, x.maxManualSteps);
  stepsY = clampSteps(stepsY, y.maxManualSteps);
  stepsZ = clampSteps(stepsZ, z.maxManualSteps);

  long absX = absLong(stepsX);
  long absY = absLong(stepsY);
  long absZ = absLong(stepsZ);

  if (absX == 0 && absY == 0 && absZ == 0) {
    return true;
  }

  bool dirX = (stepsX > 0) ? x.positiveDir : !x.positiveDir;
  bool dirY = (stepsY > 0) ? y.positiveDir : !y.positiveDir;
  bool dirZ = (stepsZ > 0) ? z.positiveDir : !z.positiveDir;

  bool xTowardLimit = (dirX == x.homeDir);
  bool yTowardLimit = (dirY == y.homeDir);
  bool zTowardLimit = (dirZ == z.homeDir);

  bool xEnabled = absX > 0;
  bool yEnabled = absY > 0;
  bool zEnabled = absZ > 0;

  if (xEnabled) digitalWrite(x.dirPin, dirX);
  if (yEnabled) digitalWrite(y.dirPin, dirY);
  if (zEnabled) digitalWrite(z.dirPin, dirZ);

  long maxSteps = max(absX, max(absY, absZ));

  long accX = 0;
  long accY = 0;
  long accZ = 0;

  unsigned int speedSps = clampSpeedSps(DEFAULT_MOVE_SPEED_SPS);
  unsigned int delayUs = speedSpsToDelayUs(speedSps);

  for (long i = 0; i < maxSteps; i++) {
    bool stepXNow = false;
    bool stepYNow = false;
    bool stepZNow = false;

    accX += absX;
    accY += absY;
    accZ += absZ;

    if (accX >= maxSteps) {
      accX -= maxSteps;
      stepXNow = xEnabled;
    }

    if (accY >= maxSteps) {
      accY -= maxSteps;
      stepYNow = yEnabled;
    }

    if (accZ >= maxSteps) {
      accZ -= maxSteps;
      stepZNow = zEnabled;
    }

    if (stepXNow && xTowardLimit && limitPressed(x)) return false;
    if (stepYNow && yTowardLimit && limitPressed(y)) return false;
    if (stepZNow && zTowardLimit && limitPressed(z)) return false;

    if (stepXNow) digitalWrite(x.stepPin, HIGH);
    if (stepYNow) digitalWrite(y.stepPin, HIGH);
    if (stepZNow) digitalWrite(z.stepPin, HIGH);

    delayMicroseconds(delayUs);

    if (stepXNow) digitalWrite(x.stepPin, LOW);
    if (stepYNow) digitalWrite(y.stepPin, LOW);
    if (stepZNow) digitalWrite(z.stepPin, LOW);

    delayMicroseconds(delayUs);

    if (stepXNow) addPositionStep(x, dirX);
    if (stepYNow) addPositionStep(y, dirY);
    if (stepZNow) addPositionStep(z, dirZ);

    if (xEnabled && xTowardLimit && limitPressed(x)) return false;
    if (yEnabled && yTowardLimit && limitPressed(y)) return false;
    if (zEnabled && zTowardLimit && limitPressed(z)) return false;
  }

  return true;
}
