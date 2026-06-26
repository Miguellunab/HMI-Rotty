#include "Config.h"
#include "Axis.h"
#include "Hardware.h"
#include "Motion.h"
#include "Homing.h"
#include "Gripper.h"
#include "Protocol.h"

Axis axes[AXIS_COUNT] = {
  {
    AXIS_X,
    "X",
    X_STEP_PIN,
    X_DIR_PIN,
    X_LIMIT_PIN,
    true,
    X_POSITIVE_DIR,
    X_HOME_DIR,
    DEFAULT_MOVE_SPEED_SPS,
    DEFAULT_HOMING_SPEED_SPS,
    DEFAULT_BACKOFF_SPEED_SPS,
    MAX_HOMING_STEPS,
    MAX_RELEASE_STEPS,
    MAX_MANUAL_STEPS,
    HOMING_BACKOFF_STEPS,
    SAFETY_BACKOFF_STEPS,
    0,
    false,
    UNIT_DEGREES,
    X_STEPS_PER_DEGREE
  },

  {
    AXIS_Y,
    "Y",
    Y_STEP_PIN,
    Y_DIR_PIN,
    Y_LIMIT_PIN,
    true,
    Y_POSITIVE_DIR,
    Y_HOME_DIR,
    DEFAULT_MOVE_SPEED_SPS,
    DEFAULT_HOMING_SPEED_SPS,
    DEFAULT_BACKOFF_SPEED_SPS,
    MAX_HOMING_STEPS,
    MAX_RELEASE_STEPS,
    MAX_MANUAL_STEPS,
    HOMING_BACKOFF_STEPS,
    SAFETY_BACKOFF_STEPS,
    0,
    false,
    UNIT_DEGREES,
    Y_STEPS_PER_DEGREE
  },

  {
    AXIS_Z,
    "Z",
    Z_STEP_PIN,
    Z_DIR_PIN,
    Z_LIMIT_PIN,
    true,
    Z_POSITIVE_DIR,
    Z_HOME_DIR,
    DEFAULT_MOVE_SPEED_SPS,
    DEFAULT_HOMING_SPEED_SPS,
    DEFAULT_BACKOFF_SPEED_SPS,
    MAX_HOMING_STEPS,
    MAX_RELEASE_STEPS,
    MAX_MANUAL_STEPS,
    HOMING_BACKOFF_STEPS,
    SAFETY_BACKOFF_STEPS,
    0,
    false,
    UNIT_MM,
    Z_STEPS_PER_MM
  },

  {
    AXIS_WRIST,
    "W",
    WRIST_STEP_PIN,
    WRIST_DIR_PIN,
    WRIST_LIMIT_PIN,
    WRIST_HAS_LIMIT,
    WRIST_POSITIVE_DIR,
    WRIST_HOME_DIR,
    WRIST_MOVE_SPEED_SPS,
    WRIST_HOMING_SPEED_SPS,
    WRIST_BACKOFF_SPEED_SPS,
    MAX_HOMING_STEPS,
    MAX_RELEASE_STEPS,
    WRIST_MAX_MANUAL_STEPS,
    WRIST_HOMING_BACKOFF_STEPS,
    SAFETY_BACKOFF_STEPS,
    0,
    false,
    UNIT_DEGREES,
    WRIST_STEPS_PER_DEGREE
  }
};

void setup() {
  Serial.begin(SERIAL_BAUDRATE);

  hardwareInit(axes, AXIS_COUNT);
  enableDrivers();
  gripperInit();

  protocolInit(axes, AXIS_COUNT);
}

void loop() {
  protocolTick(axes, AXIS_COUNT);
}
