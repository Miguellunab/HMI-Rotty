#include "SerialInput.h"
#include "Config.h"

#include <ctype.h>
#include <string.h>

bool serialReadLine(char* output, uint8_t outputSize) {
  static char buffer[SERIAL_COMMAND_BUFFER_SIZE];
  static uint8_t pos = 0;

  while (Serial.available() > 0) {
    char c = Serial.read();

    if (c == '\r' || c == '\n') {
      if (pos == 0) {
        continue;
      }

      buffer[pos] = '\0';

      strncpy(output, buffer, outputSize - 1);
      output[outputSize - 1] = '\0';

      pos = 0;
      trimInPlace(output);

      return true;
    }

    if (c == 8 || c == 127) {
      if (pos > 0) {
        pos--;
      }
      continue;
    }

    if (pos < SERIAL_COMMAND_BUFFER_SIZE - 1) {
      buffer[pos++] = c;
    }
  }

  return false;
}

void trimInPlace(char* text) {
  if (text == nullptr) return;

  uint8_t start = 0;
  while (text[start] && isspace((unsigned char)text[start])) {
    start++;
  }

  if (start > 0) {
    uint8_t i = 0;
    while (text[start]) {
      text[i++] = text[start++];
    }
    text[i] = '\0';
  }

  int end = strlen(text) - 1;
  while (end >= 0 && isspace((unsigned char)text[end])) {
    text[end] = '\0';
    end--;
  }
}

bool equalsIgnoreCase(const char* a, const char* b) {
  if (a == nullptr || b == nullptr) return false;

  while (*a && *b) {
    if (tolower((unsigned char)*a) != tolower((unsigned char)*b)) {
      return false;
    }
    a++;
    b++;
  }

  return *a == '\0' && *b == '\0';
}

bool startsWithIgnoreCase(const char* text, const char* prefix) {
  if (text == nullptr || prefix == nullptr) return false;

  while (*prefix) {
    if (*text == '\0') return false;

    if (tolower((unsigned char)*text) != tolower((unsigned char)*prefix)) {
      return false;
    }

    text++;
    prefix++;
  }

  return true;
}
