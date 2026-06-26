#include "Protocol.h"

#include "Config.h"
#include "Hardware.h"
#include "Motion.h"
#include "Homing.h"
#include "Gripper.h"
#include "SerialInput.h"

#include <ctype.h>
#include <stdlib.h>
#include <string.h>

static char commandBuffer[SERIAL_COMMAND_BUFFER_SIZE];

static bool isWristToken(const char* token) {
  return equalsIgnoreCase(token, "W") ||
         equalsIgnoreCase(token, "A") ||
         equalsIgnoreCase(token, "WRIST") ||
         equalsIgnoreCase(token, "MUNECA");
}

static Axis* findAxis(Axis axes[], uint8_t axisCount, const char* token) {
  if (token == nullptr) return nullptr;

  if (isWristToken(token)) {
    return &axes[AXIS_WRIST];
  }

  for (uint8_t i = 0; i < axisCount; i++) {
    if (equalsIgnoreCase(token, axes[i].name)) {
      return &axes[i];
    }
  }

  return nullptr;
}

static const char* unitName(const Axis& axis) {
  if (axis.unit == UNIT_DEGREES) return "deg";
  return "mm";
}

static bool parseLongValue(const char* text, long& value) {
  if (text == nullptr) return false;

  char* endPtr = nullptr;
  long result = strtol(text, &endPtr, 10);

  if (text == endPtr) return false;
  if (*endPtr != '\0') return false;

  value = result;
  return true;
}

static bool parseFloatValue(const char* text, float& value) {
  if (text == nullptr) return false;

  char* endPtr = nullptr;
  float result = strtod(text, &endPtr);

  if (text == endPtr) return false;
  if (*endPtr != '\0') return false;

  value = result;
  return true;
}

static uint8_t tokenize(char* text, char* tokens[], uint8_t maxTokens) {
  uint8_t count = 0;

  char* token = strtok(text, " \t");

  while (token != nullptr && count < maxTokens) {
    tokens[count++] = token;
    token = strtok(nullptr, " \t");
  }

  return count;
}

static void printOk(const char* cmd) {
  Serial.print(F("{\"ok\":true,\"cmd\":\""));
  Serial.print(cmd);
  Serial.println(F("\"}"));
}

static void printErr(const char* cmd, const char* err) {
  Serial.print(F("{\"ok\":false,\"cmd\":\""));
  Serial.print(cmd);
  Serial.print(F("\",\"err\":\""));
  Serial.print(err);
  Serial.println(F("\"}"));
}

static void printAxisJson(const Axis& axis) {
  Serial.print(F("\""));
  Serial.print(axis.name);
  Serial.print(F("\":{"));

  Serial.print(F("\"homed\":"));
  Serial.print(axis.homed ? F("true") : F("false"));

  Serial.print(F(",\"steps\":"));
  Serial.print(axis.position);

  Serial.print(F(",\"unit\":\""));
  Serial.print(unitName(axis));
  Serial.print(F("\""));

  Serial.print(F(",\"pos\":"));
  Serial.print(stepsToUnits(axis, axis.position), 3);

  Serial.print(F(",\"speed_sps\":"));
  Serial.print(axis.moveSpeedSps);

  Serial.print(F(",\"limit_configured\":"));
  Serial.print(axis.hasLimit ? F("true") : F("false"));

  Serial.print(F(",\"limit\":"));
  Serial.print(limitPressed(axis) ? F("true") : F("false"));

  Serial.print(F("}"));
}

static void printGripperJson() {
  Serial.print(F("\"gripper\":{"));
  Serial.print(F("\"ready\":"));
  Serial.print(gripperIsReady() ? F("true") : F("false"));
  Serial.print(F(",\"state\":\""));
  Serial.print(gripperStateName());
  Serial.print(F("\""));
  Serial.print(F(",\"user_angle\":"));
  Serial.print(gripperCurrentUserAngle());
  Serial.print(F(",\"physical_angle\":"));
  Serial.print(gripperCurrentPhysicalAngle());
  Serial.print(F(",\"open_user_angle\":"));
  Serial.print(GRIPPER_OPEN_USER_ANGLE);
  Serial.print(F(",\"close_user_angle\":"));
  Serial.print(GRIPPER_CLOSE_USER_ANGLE);
  Serial.print(F("}"));
}

static void printStatus(Axis axes[], uint8_t axisCount) {
  Serial.print(F("{\"ok\":true,\"type\":\"status\",\"axes\":{"));

  for (uint8_t i = 0; i < axisCount; i++) {
    if (i > 0) Serial.print(F(","));
    printAxisJson(axes[i]);
  }

  Serial.print(F("},"));
  printGripperJson();
  Serial.print(F(",\"drivers_enabled\":"));
  Serial.print(driversAreEnabled() ? F("true") : F("false"));
  Serial.println(F("}"));
}

static void printHello(Axis axes[], uint8_t axisCount) {
  Serial.print(F("{\"ok\":true,\"type\":\"hello\",\"fw\":\""));
  Serial.print(FIRMWARE_NAME);
  Serial.print(F("\",\"version\":\""));
  Serial.print(FIRMWARE_VERSION);
  Serial.print(F("\",\"baud\":"));
  Serial.print(SERIAL_BAUDRATE);
  Serial.println(F("}"));

  printStatus(axes, axisCount);
}

static void printHelp() {
  Serial.println(F("{\"ok\":true,\"type\":\"help\",\"commands\":[\"PING\",\"HELP\",\"STATUS\",\"ENABLE\",\"DISABLE\",\"HOME X|Y|Z|W|WRIST|ALL\",\"RELEASE X|Y|Z|W|WRIST\",\"MOVE X|Y|W DEG n\",\"MOVE Z MM n\",\"MOVE axis STEPS n\",\"MOVE XYZ STEPS x y z\",\"SPEED axis steps_per_second\",\"GRIPPER OPEN\",\"GRIPPER CLOSE\",\"OPEN\",\"CLOSE\",\"GRIPPER ANGLE n\"]}"));
}

static void handleHome(Axis axes[], uint8_t axisCount, char* tokens[], uint8_t count) {
  if (count != 2) {
    printErr("HOME", "USAGE_HOME_AXIS_OR_ALL");
    return;
  }

  bool ok = false;

  if (equalsIgnoreCase(tokens[1], "ALL")) {
    ok = homeAllAxes(axes, axisCount);
  } else {
    Axis* axis = findAxis(axes, axisCount, tokens[1]);

    if (axis == nullptr) {
      printErr("HOME", "INVALID_AXIS");
      return;
    }

    ok = homeAxis(*axis);
  }

  if (!ok) {
    printErr("HOME", "HOMING_FAILED");
    printStatus(axes, axisCount);
    return;
  }

  printOk("HOME");
  printStatus(axes, axisCount);
}

static void handleRelease(Axis axes[], uint8_t axisCount, char* tokens[], uint8_t count) {
  if (count != 2) {
    printErr("RELEASE", "USAGE_RELEASE_AXIS");
    return;
  }

  Axis* axis = findAxis(axes, axisCount, tokens[1]);

  if (axis == nullptr) {
    printErr("RELEASE", "INVALID_AXIS");
    return;
  }

  bool ok = releaseAndBackoffAxis(*axis, axis->safetyBackoffSteps);

  if (!ok) {
    printErr("RELEASE", "RELEASE_FAILED");
    printStatus(axes, axisCount);
    return;
  }

  printOk("RELEASE");
  printStatus(axes, axisCount);
}

static void handleMoveXYZ(Axis axes[], char* tokens[], uint8_t count) {
  if (count != 6 || !equalsIgnoreCase(tokens[2], "STEPS")) {
    printErr("MOVE", "USAGE_MOVE_XYZ_STEPS_X_Y_Z");
    return;
  }

  long x = 0;
  long y = 0;
  long z = 0;

  if (!parseLongValue(tokens[3], x) || !parseLongValue(tokens[4], y) || !parseLongValue(tokens[5], z)) {
    printErr("MOVE", "INVALID_XYZ_STEPS");
    return;
  }

  bool ok = moveXYZSimultaneousSafe(axes, x, y, z);

  if (!ok) {
    printErr("MOVE", "MOVE_XYZ_FAILED_OR_LIMIT_HIT");
    printStatus(axes, AXIS_COUNT);
    return;
  }

  printOk("MOVE_XYZ");
  printStatus(axes, AXIS_COUNT);
}

static void handleMove(Axis axes[], uint8_t axisCount, char* tokens[], uint8_t count) {
  if (count >= 2 && equalsIgnoreCase(tokens[1], "XYZ")) {
    handleMoveXYZ(axes, tokens, count);
    return;
  }

  if (count != 4) {
    printErr("MOVE", "USAGE_MOVE_AXIS_UNIT_VALUE");
    return;
  }

  Axis* axis = findAxis(axes, axisCount, tokens[1]);

  if (axis == nullptr) {
    printErr("MOVE", "INVALID_AXIS");
    return;
  }

  long steps = 0;

  if (equalsIgnoreCase(tokens[2], "STEPS")) {
    if (!parseLongValue(tokens[3], steps)) {
      printErr("MOVE", "INVALID_STEPS_VALUE");
      return;
    }
  } else {
    float units = 0.0f;

    if (!parseFloatValue(tokens[3], units)) {
      printErr("MOVE", "INVALID_UNIT_VALUE");
      return;
    }

    if (axis->unit == UNIT_DEGREES && equalsIgnoreCase(tokens[2], "DEG")) {
      steps = unitsToSteps(*axis, units);
    } else if (axis->unit == UNIT_MM && equalsIgnoreCase(tokens[2], "MM")) {
      steps = unitsToSteps(*axis, units);
    } else {
      printErr("MOVE", "INVALID_UNIT_FOR_AXIS");
      return;
    }
  }

  bool ok = moveAxisSafe(*axis, steps);

  if (!ok) {
    printErr("MOVE", "MOVE_FAILED_OR_LIMIT_HIT");
    printStatus(axes, axisCount);
    return;
  }

  printOk("MOVE");
  printStatus(axes, axisCount);
}

static void handleSpeed(Axis axes[], uint8_t axisCount, char* tokens[], uint8_t count) {
  if (count != 3) {
    printErr("SPEED", "USAGE_SPEED_AXIS_STEPS_PER_SECOND");
    return;
  }

  Axis* axis = findAxis(axes, axisCount, tokens[1]);

  if (axis == nullptr) {
    printErr("SPEED", "INVALID_AXIS");
    return;
  }

  long speed = 0;

  if (!parseLongValue(tokens[2], speed)) {
    printErr("SPEED", "INVALID_SPEED_VALUE");
    return;
  }

  if (speed < MIN_SPEED_SPS || speed > MAX_SPEED_SPS) {
    printErr("SPEED", "SPEED_OUT_OF_RANGE");
    return;
  }

  axis->moveSpeedSps = (unsigned int)speed;

  printOk("SPEED");
  printStatus(axes, axisCount);
}

static void handleGripper(Axis axes[], uint8_t axisCount, char* tokens[], uint8_t count) {
  if (count < 2) {
    printErr("GRIPPER", "USAGE_GRIPPER_OPEN_CLOSE_ANGLE_STATUS");
    return;
  }

  if (equalsIgnoreCase(tokens[1], "OPEN")) {
    gripperOpen();
    printOk("GRIPPER_OPEN");
    printStatus(axes, axisCount);
    return;
  }

  if (equalsIgnoreCase(tokens[1], "CLOSE")) {
    gripperClose();
    printOk("GRIPPER_CLOSE");
    printStatus(axes, axisCount);
    return;
  }

  if (equalsIgnoreCase(tokens[1], "STATUS")) {
    printStatus(axes, axisCount);
    return;
  }

  if (equalsIgnoreCase(tokens[1], "ANGLE")) {
    if (count != 3) {
      printErr("GRIPPER", "USAGE_GRIPPER_ANGLE_VALUE");
      return;
    }

    long angle = 0;
    if (!parseLongValue(tokens[2], angle)) {
      printErr("GRIPPER", "INVALID_ANGLE_VALUE");
      return;
    }

    if (angle < -90 || angle > 90) {
      printErr("GRIPPER", "ANGLE_OUT_OF_RANGE");
      return;
    }

    gripperWriteAngle((int)angle);
    printOk("GRIPPER_ANGLE");
    printStatus(axes, axisCount);
    return;
  }

  printErr("GRIPPER", "INVALID_GRIPPER_COMMAND");
}

void protocolInit(Axis axes[], uint8_t axisCount) {
  printHello(axes, axisCount);
}

void protocolTick(Axis axes[], uint8_t axisCount) {
  if (!serialReadLine(commandBuffer, SERIAL_COMMAND_BUFFER_SIZE)) {
    return;
  }

  if (commandBuffer[0] == '\0') {
    return;
  }

  char workBuffer[SERIAL_COMMAND_BUFFER_SIZE];

  strncpy(workBuffer, commandBuffer, SERIAL_COMMAND_BUFFER_SIZE - 1);
  workBuffer[SERIAL_COMMAND_BUFFER_SIZE - 1] = '\0';

  char* tokens[8];
  uint8_t count = tokenize(workBuffer, tokens, 8);

  if (count == 0) {
    return;
  }

  if (equalsIgnoreCase(tokens[0], "PING")) {
    Serial.println(F("{\"ok\":true,\"type\":\"pong\"}"));
    return;
  }

  if (equalsIgnoreCase(tokens[0], "HELP")) {
    printHelp();
    return;
  }

  if (equalsIgnoreCase(tokens[0], "STATUS")) {
    printStatus(axes, axisCount);
    return;
  }

  if (equalsIgnoreCase(tokens[0], "ENABLE")) {
    enableDrivers();
    printOk("ENABLE");
    printStatus(axes, axisCount);
    return;
  }

  if (equalsIgnoreCase(tokens[0], "DISABLE")) {
    disableDrivers();
    printOk("DISABLE");
    printStatus(axes, axisCount);
    return;
  }

  if (equalsIgnoreCase(tokens[0], "HOME")) {
    handleHome(axes, axisCount, tokens, count);
    return;
  }

  if (equalsIgnoreCase(tokens[0], "RELEASE")) {
    handleRelease(axes, axisCount, tokens, count);
    return;
  }

  if (equalsIgnoreCase(tokens[0], "MOVE")) {
    handleMove(axes, axisCount, tokens, count);
    return;
  }

  if (equalsIgnoreCase(tokens[0], "SPEED")) {
    handleSpeed(axes, axisCount, tokens, count);
    return;
  }



  if (equalsIgnoreCase(tokens[0], "OPEN")) {
    gripperOpen();
    printOk("GRIPPER_OPEN");
    printStatus(axes, axisCount);
    return;
  }

  if (equalsIgnoreCase(tokens[0], "CLOSE")) {
    gripperClose();
    printOk("GRIPPER_CLOSE");
    printStatus(axes, axisCount);
    return;
  }

  if (equalsIgnoreCase(tokens[0], "GRIPPER") || equalsIgnoreCase(tokens[0], "PINZA")) {
    handleGripper(axes, axisCount, tokens, count);
    return;
  }

  printErr("UNKNOWN", "UNKNOWN_COMMAND");
}
