#include "Gripper.h"
#include "Config.h"
#include <Servo.h>

static Servo gripperServo;
static int currentGripperUserAngle = GRIPPER_START_USER_ANGLE;
static int currentGripperPhysicalAngle = GRIPPER_CENTER_ANGLE + GRIPPER_START_USER_ANGLE;
static bool gripperReady = false;
static const char* currentGripperState = "unknown";

static int clampUserAngle(int userAngle) {
  if (userAngle < -90) return -90;
  if (userAngle > 90) return 90;
  return userAngle;
}

static int clampPhysicalAngle(int physicalAngle) {
  if (physicalAngle < 0) return 0;
  if (physicalAngle > 180) return 180;
  return physicalAngle;
}

static int userAngleToPhysicalAngle(int userAngle) {
  return clampPhysicalAngle(GRIPPER_CENTER_ANGLE + userAngle);
}

void gripperInit() {
  gripperServo.attach(GRIPPER_SERVO_PIN, GRIPPER_SERVO_MIN_US, GRIPPER_SERVO_MAX_US);
  gripperReady = true;
  gripperOpen();
}

void gripperWriteAngle(int userAngle) {
  userAngle = clampUserAngle(userAngle);

  if (!gripperReady) {
    gripperServo.attach(GRIPPER_SERVO_PIN, GRIPPER_SERVO_MIN_US, GRIPPER_SERVO_MAX_US);
    gripperReady = true;
  }

  currentGripperUserAngle = userAngle;
  currentGripperPhysicalAngle = userAngleToPhysicalAngle(currentGripperUserAngle);
  gripperServo.write(currentGripperPhysicalAngle);

  if (currentGripperUserAngle == GRIPPER_OPEN_USER_ANGLE) {
    currentGripperState = "open";
  } else if (currentGripperUserAngle == GRIPPER_CLOSE_USER_ANGLE) {
    currentGripperState = "close";
  } else {
    currentGripperState = "custom";
  }
}

void gripperOpen() {
  gripperWriteAngle(GRIPPER_OPEN_USER_ANGLE);
  currentGripperState = "open";
}

void gripperClose() {
  gripperWriteAngle(GRIPPER_CLOSE_USER_ANGLE);
  currentGripperState = "close";
}

bool gripperIsReady() {
  return gripperReady;
}

int gripperCurrentUserAngle() {
  return currentGripperUserAngle;
}

int gripperCurrentPhysicalAngle() {
  return currentGripperPhysicalAngle;
}

const char* gripperStateName() {
  return currentGripperState;
}
