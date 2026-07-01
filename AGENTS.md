# HMI Brazo SCARA - Agent Context

## Goal

Desktop HMI for a SCARA arm controlled by Arduino UNO + CNC Shield + A4988 + NEMA 17 motors.

No Arduino Cloud. The app talks directly to the Arduino over serial at `115200`.

## Stack

- Tauri v2
- React 19
- TypeScript
- Vite
- Rust backend using the `serialport` crate

## Firmware

Firmware lives in:

`codigo_arduino/Miguel_Brazo`

Read these first before changing protocol/UI behavior:

- `README_PROTOCOL.md`
- `Protocol.cpp`
- `Config.h`
- `Axis.h`

## Serial Protocol

Send one text command per line.

The Arduino replies with newline-delimited JSON only. Do not parse human menus.

Baudrate:

```txt
115200
```

Supported commands:

```txt
PING
STATUS
ENABLE
DISABLE
HOME X
HOME Y
HOME Z
HOME ALL
RELEASE X
RELEASE Y
RELEASE Z
MOVE X STEPS 1000
MOVE X DEG 50
MOVE Y DEG -30
MOVE Z MM 10
SPEED X 700
SPEED Y 700
SPEED Z 700
```

Important limits from firmware:

- `SPEED` accepts `100..5000` microseconds.
- X/Y use degrees.
- Z uses millimeters.
- X/Y/Z positive direction is the physical positive direction documented in `Config.h`.
- Movement commands return an `ok/cmd` JSON line and then a `status` JSON line.

Example status:

```json
{"ok":true,"type":"status","axes":{"X":{"homed":true,"steps":444,"unit":"deg","pos":49.950,"speed_us":700,"limit":false},"Y":{"homed":false,"steps":0,"unit":"deg","pos":0.000,"speed_us":700,"limit":false},"Z":{"homed":false,"steps":0,"unit":"mm","pos":0.000,"speed_us":700,"limit":false}}}
```

## App Behavior

- Backend lists ports, connects/disconnects, sends one command per line, and emits serial events.
- Frontend parses JSON responses and updates live status.
- Polling can be off, 500 ms, or 1 s.
- Do not poll while the UI is waiting for a command status.
- Console is optional/collapsible but useful for debugging.

## Release / Updater

Pushing code to GitHub does not update installed apps. After user-facing changes, publish a new Tauri updater release:

1. Bump the version in `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and `scripts/make-latest-json.ps1`.
2. Run `npm run build:app` to create signed updater artifacts.
3. Run `npm run release:json` to generate `latest.json`.
4. Commit and push the version/docs changes.
5. Create a GitHub release named `vX.Y.Z` and upload the NSIS installer `.exe`, its `.sig`, and `latest.json`.

The app checks `https://github.com/Miguellunab/HMI-Rotty/releases/latest/download/latest.json`; the download icon appears only when that file advertises a version newer than the installed one.
`latest.json` must be UTF-8 without BOM and its asset URL must match GitHub's published asset name; GitHub normalizes spaces to dots in release assets, otherwise the updater can fail with `404 Not Found`.

## Minimalism Rule

Keep this app boring and direct. No command DSL, no state machine library, no custom UI framework. The firmware protocol is small; plain TypeScript and Tauri commands are enough.
