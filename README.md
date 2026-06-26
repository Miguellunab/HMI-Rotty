# HMI Brazo SCARA

Desktop HMI for Arduino UNO + CNC Shield + A4988 + NEMA 17 SCARA arm control.

## Requirements

Install these before running the Tauri desktop app on Windows:

1. Node.js 24+
2. Rust via `rustup`: https://rustup.rs/
3. Visual Studio Build Tools with MSVC and Windows SDK: https://aka.ms/vs/17/release/vs_BuildTools.exe

If PowerShell says `program not found` for `cargo`, close and reopen PowerShell.
If it still fails, run this before `npm run tauri dev`:

```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
```

## Install

```powershell
npm install
```

## Run Frontend Build Check

```powershell
npm run build
```

## Run Desktop App

Connect the Arduino by USB, then run:

```powershell
npm run tauri dev
```

In the app:

1. Click `Actualizar`.
2. Select the Arduino serial port.
3. Click `Conectar`.
4. Check the console for `PING` / `STATUS` responses.
5. Use `ENABLE`.
6. Home axes with `HOME X`, `HOME Y`, `HOME Z`, or `HOME ALL`.
7. Move X/Y in degrees and Z in millimeters.

## Firmware Protocol

Baudrate: `115200`.

The app sends one command per line and expects one JSON object per response line.

Do not enable Arduino menu output. This HMI only parses JSON lines.

## Verification Done

```powershell
npm run build
npm audit --omit=dev
npx tauri info
```

`npm run build` passes.

`npm audit --omit=dev` reports 0 vulnerabilities.

`cargo check` passes after Cargo is available in `PATH`.
