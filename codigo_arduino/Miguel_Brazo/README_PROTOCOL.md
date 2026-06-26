# Miguel_Brazo - Firmware protocolo serial para HMI

Firmware para Arduino UNO + CNC Shield + A4988 + motores NEMA 17 + servo de pinza.

Esta version **no usa menu serial humano**. Esta pensada para una HMI/app de escritorio hecha con herramientas web como Tauri, Electron, React, Vue o Svelte.

La app debe enviar comandos de texto por serial y leer respuestas JSON por linea.

---

## Configuracion serial

- Baudrate: `115200`
- Formato: un comando por linea, terminado en `\n`
- Respuesta: JSON por linea
- No se deben parsear menus ni textos humanos

---

## Ejes disponibles

| Eje HMI | Alias aceptados | Unidad principal | Descripcion |
|---|---|---|---|
| X | X | DEG | Base / articulacion X |
| Y | Y | DEG | Articulacion Y |
| Z | Z | MM | Eje vertical |
| W | W, A, WRIST, MUNECA | DEG | Muneca / cuarto motor |

Nota: `A` se mantiene como alias porque la CNC Shield usa el slot A para la muneca.

---

## Velocidad

La velocidad ahora se maneja en **pasos por segundo**.

Esto reemplaza el sistema anterior de microsegundos, donde un numero menor significaba mas velocidad.

Valores equivalentes usados como base:

| Valor anterior | Nuevo valor aproximado |
|---|---|
| 700 us | 714 pasos/s |
| 600 us | 833 pasos/s |
| 900 us | 556 pasos/s |

Ejemplo:

```txt
SPEED X 700
```

significa que X se movera a 700 pasos por segundo.

Rango aceptado por defecto:

```txt
50 a 3000 pasos/s
```

---

## Comandos generales

### PING

Verifica comunicacion.

```txt
PING
```

Respuesta:

```json
{"ok":true,"type":"pong"}
```

---

### HELP

Lista comandos soportados.

```txt
HELP
```

---

### STATUS

Solicita estado completo del sistema.

```txt
STATUS
```

Respuesta ejemplo:

```json
{"ok":true,"type":"status","axes":{"X":{"homed":true,"steps":0,"unit":"deg","pos":0.000,"speed_sps":714,"limit_configured":true,"limit":false},"Y":{"homed":true,"steps":0,"unit":"deg","pos":0.000,"speed_sps":714,"limit_configured":true,"limit":false},"Z":{"homed":true,"steps":0,"unit":"mm","pos":0.000,"speed_sps":714,"limit_configured":true,"limit":false},"W":{"homed":true,"steps":0,"unit":"deg","pos":0.000,"speed_sps":556,"limit_configured":true,"limit":false}},"gripper":{"ready":true,"state":"open","user_angle":80,"physical_angle":170,"open_user_angle":80,"close_user_angle":-90},"drivers_enabled":true}
```

Campos importantes para la HMI:

- `axes.X.pos`: posicion X en grados
- `axes.Y.pos`: posicion Y en grados
- `axes.Z.pos`: posicion Z en mm
- `axes.W.pos`: posicion de muneca en grados
- `homed`: indica si se realizo homing
- `limit`: indica si el final de carrera esta activo
- `speed_sps`: velocidad en pasos por segundo
- `gripper.state`: `open`, `close` o `custom`

---

## Drivers

### ENABLE

Habilita los drivers A4988.

```txt
ENABLE
```

### DISABLE

Deshabilita los drivers A4988.

```txt
DISABLE
```

---

## Homing

### Homing por eje

```txt
HOME X
HOME Y
HOME Z
HOME W
```

Tambien se aceptan:

```txt
HOME A
HOME WRIST
```

### Homing general

```txt
HOME ALL
```

Hace homing de X, Y, Z y W.

---

## Liberar final de carrera

Sirve para retirar un eje del final de carrera con backoff de seguridad.

```txt
RELEASE X
RELEASE Y
RELEASE Z
RELEASE W
```

Tambien se aceptan:

```txt
RELEASE A
RELEASE WRIST
```

---

## Movimiento por eje

### Movimiento por pasos

```txt
MOVE X STEPS 1000
MOVE Y STEPS -500
MOVE Z STEPS 800
MOVE W STEPS 300
```

### Movimiento por grados

X, Y y W usan grados:

```txt
MOVE X DEG 50
MOVE Y DEG -30
MOVE W DEG 90
```

### Movimiento por milimetros

Z usa milimetros:

```txt
MOVE Z MM 10
MOVE Z MM -5
```

---

## Movimiento simultaneo XYZ

Movimiento coordinado basico solo para X/Y/Z en pasos:

```txt
MOVE XYZ STEPS 100 0 -50
```

La muneca W no participa en este movimiento simultaneo.

---

## Cambiar velocidad

La velocidad se define por eje en pasos por segundo:

```txt
SPEED X 700
SPEED Y 700
SPEED Z 500
SPEED W 400
```

Despues de cambiar velocidad, el firmware responde con `STATUS` actualizado.

---

## Pinza / Gripper

La pinza tiene dos estados principales para botones de la HMI:

| Boton HMI | Comando serial | Angulo usuario |
|---|---|---|
| Open | `GRIPPER OPEN` o `OPEN` | `80` grados |
| Close | `GRIPPER CLOSE` o `CLOSE` | `-90` grados |

### Abrir pinza

```txt
GRIPPER OPEN
OPEN
```

### Cerrar pinza

```txt
GRIPPER CLOSE
CLOSE
```

### Estado de pinza

```txt
GRIPPER STATUS
```

### Angulo manual opcional

```txt
GRIPPER ANGLE 0
GRIPPER ANGLE 45
GRIPPER ANGLE -45
```

Rango permitido:

```txt
-90 a 90
```

---

## Recomendacion para la app HMI

La app debe tener:

1. Selector de puerto serial.
2. Boton conectar/desconectar.
3. Botones `ENABLE` y `DISABLE`.
4. Botones `HOME X`, `HOME Y`, `HOME Z`, `HOME W`, `HOME ALL`.
5. Tarjetas de estado para X, Y, Z, W.
6. Controles de movimiento:
   - X/Y/W en grados.
   - Z en milimetros.
   - Opcion avanzada por pasos.
7. Slider/campo de velocidad por eje en pasos/s.
8. Botones de pinza:
   - `GRIPPER OPEN`
   - `GRIPPER CLOSE`
9. Polling de `STATUS` cada 500 ms o 1 s cuando no haya movimiento largo activo.
10. Consola serial opcional para debug.

---

## Flujo recomendado al conectar

```txt
PING
STATUS
ENABLE
```

Luego permitir controles de movimiento y homing.

---

## Flujo de prueba manual

```txt
PING
STATUS
ENABLE
GRIPPER OPEN
GRIPPER CLOSE
OPEN
CLOSE
MOVE X DEG 10
MOVE Y DEG 10
MOVE Z MM 2
MOVE W DEG 10
STATUS
```

---

## Notas importantes para Codex

- No usar el viejo `Menu.cpp`; este firmware trabaja con `Protocol.cpp`.
- No enviar comandos como `move`, `x`, `deg` separados; ahora todo es un comando completo por linea.
- Todas las respuestas validas son JSON por linea.
- Despues de comandos que cambian estado, normalmente llegan dos lineas:
  1. `{"ok":true,"cmd":"..."}`
  2. `{"ok":true,"type":"status",...}`
- Si llega `ok:false`, mostrar el error en la HMI.
- La HMI debe parsear `type:"status"` para actualizar tarjetas y posiciones.
