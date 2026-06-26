#pragma once

#include <Arduino.h>

// ======================================================
// SERIAL / PROTOCOLO
// ======================================================

const uint32_t SERIAL_BAUDRATE = 115200;
const uint8_t SERIAL_COMMAND_BUFFER_SIZE = 96;

#define FIRMWARE_NAME "Miguel_Brazo"
#define FIRMWARE_VERSION "0.3-wrist-gripper-protocol"

// ======================================================
// PINES CNC SHIELD
// Arduino UNO + CNC Shield + A4988
// ======================================================

const uint8_t EN_PIN = 8;

const uint8_t X_STEP_PIN = 2;
const uint8_t X_DIR_PIN = 5;
const uint8_t X_LIMIT_PIN = 9;

const uint8_t Y_STEP_PIN = 3;
const uint8_t Y_DIR_PIN = 6;
const uint8_t Y_LIMIT_PIN = 10;

const uint8_t Z_STEP_PIN = 4;
const uint8_t Z_DIR_PIN = 7;
const uint8_t Z_LIMIT_PIN = 11;

// Slot A de la CNC Shield usado como muneca / wrist.
// En CNC Shield V3 normalmente A_STEP = D12 y A_DIR = D13.
const uint8_t WRIST_STEP_PIN = 12;
const uint8_t WRIST_DIR_PIN = 13;

// Final de carrera de muneca.
// En este proyecto se usa A3 / CoolEn como entrada INPUT_PULLUP.
const uint8_t WRIST_LIMIT_PIN = A3;
const bool WRIST_HAS_LIMIT = true;

// ======================================================
// LOGICA DE FINALES
// Final NC + INPUT_PULLUP esperado:
// Liberado   -> LOW
// Presionado -> HIGH
// ======================================================

const int LIMIT_ACTIVE_STATE = HIGH;

// ======================================================
// DIRECCIONES LOGICAS
// X positivo = horario
// Y positivo = horario
// Z positivo = arriba
// W positivo = giro positivo de la muneca
// ======================================================

const bool X_POSITIVE_DIR = HIGH;
const bool Y_POSITIVE_DIR = LOW;
const bool Z_POSITIVE_DIR = HIGH;
const bool WRIST_POSITIVE_DIR = HIGH;

const bool X_HOME_DIR = X_POSITIVE_DIR;
const bool Y_HOME_DIR = Y_POSITIVE_DIR;
const bool Z_HOME_DIR = Z_POSITIVE_DIR;
const bool WRIST_HOME_DIR = WRIST_POSITIVE_DIR;

// ======================================================
// VELOCIDADES EN PASOS/SEGUNDO
//
// Antes se usaban delays en microsegundos:
// 700 us ~= 714 pasos/s
// 600 us ~= 833 pasos/s
// 900 us ~= 556 pasos/s
//
// Ahora la HMI y el protocolo usan valores intuitivos:
// mayor numero = mayor velocidad.
// ======================================================

const unsigned int DEFAULT_HOMING_SPEED_SPS = 714;
const unsigned int DEFAULT_MOVE_SPEED_SPS = 714;
const unsigned int DEFAULT_BACKOFF_SPEED_SPS = 714;

const unsigned int Z_UP_SPEED_SPS = 833;
const unsigned int Z_DOWN_SPEED_SPS = 714;

const unsigned int WRIST_MOVE_SPEED_SPS = 556;
const unsigned int WRIST_HOMING_SPEED_SPS = 556;
const unsigned int WRIST_BACKOFF_SPEED_SPS = 556;

const unsigned int MIN_SPEED_SPS = 50;
const unsigned int MAX_SPEED_SPS = 3000;

// ======================================================
// LIMITES DE SEGURIDAD
// ======================================================

const long HOMING_BACKOFF_STEPS = 160;
const long SAFETY_BACKOFF_STEPS = 120;

const long MAX_HOMING_STEPS = 30000;
const long MAX_RELEASE_STEPS = 6000;
const long MAX_MANUAL_STEPS = 15000;

const long WRIST_MAX_MANUAL_STEPS = 6000;
const long WRIST_HOMING_BACKOFF_STEPS = 160;

// ======================================================
// SERVO DE PINZA / GRIPPER
//
// Pinza con dos estados:
// OPEN  -> usuario +80 grados
// CLOSE -> usuario -90 grados
//
// Sistema de cero central:
// angulo fisico del servo = 90 + anguloUsuario
// ======================================================

const uint8_t GRIPPER_SERVO_PIN = A0;
const int GRIPPER_SERVO_MIN_US = 600;
const int GRIPPER_SERVO_MAX_US = 2500;

const int GRIPPER_CENTER_ANGLE = 90;
const int GRIPPER_OPEN_USER_ANGLE = 80;
const int GRIPPER_CLOSE_USER_ANGLE = -90;
const int GRIPPER_START_USER_ANGLE = GRIPPER_OPEN_USER_ANGLE;

// ======================================================
// CONVERSION A UNIDADES FISICAS
// Ajustar segun microstepping, reducciones, poleas,
// engranajes o tornillo real.
// ======================================================

const float X_STEPS_PER_DEGREE = 8.8889f;
const float Y_STEPS_PER_DEGREE = 8.8889f;
const float Z_STEPS_PER_MM = 400.0f;
const float WRIST_STEPS_PER_DEGREE = 10.0f;
