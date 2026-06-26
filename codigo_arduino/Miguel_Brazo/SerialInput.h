#pragma once

#include <Arduino.h>

bool serialReadLine(char* output, uint8_t outputSize);

void trimInPlace(char* text);
bool equalsIgnoreCase(const char* a, const char* b);
bool startsWithIgnoreCase(const char* text, const char* prefix);
