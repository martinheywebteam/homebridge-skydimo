# homebridge-skydimo

HomeKit plugin for [Skydimo](https://skydimo.com/en) ambient monitor lights. Talks to the controller **directly over USB** using the Adalight protocol — fast, silent, reliable.

Add your Skydimo lights to the Home app, control them with Siri, include them in scenes and automations, and never touch the Skydimo desktop app again.

```
"Hey Siri, make the monitor lights purple"   ✨
"Hey Siri, dim monitor lights to 30%"        🔅
"Hey Siri, turn off monitor lights"          ⭘
```

### Where to buy the lights

- **Official site:** [skydimo.com](https://skydimo.com/en)
- **Temu (affordable alternative):** [share.temu.com/4uuaz6YYtKB](https://share.temu.com/4uuaz6YYtKB) — same hardware, tested with this plugin ✅

---

## Why this exists

Skydimo lights are a great affordable ambient-lighting product, but the controller is meant to be driven by Skydimo's own desktop app — no HomeKit, no Siri, no automations, no integration with the rest of your smart home.

This plugin fixes that by talking to the controller directly using the **Adalight protocol** (as documented in [Skydimo's own open-source OpenRGB fork](https://gitlab.com/skydimo-team/skydimo-open-rgb)).

---

## Features

- ✅ **On / Off** via HomeKit (with brightness = 0 while off)
- ✅ **Brightness** 0–100%
- ✅ **Full colour wheel** (any hue + saturation the Home app can pick)
- ✅ **Siri** — _"Hey Siri, make monitor lights blue"_
- ✅ **Scenes & automations** — sync with other lights, trigger at sunset, etc.
- ✅ **Runs silently in the background** — no app windows, no focus stealing, no colour-picker flashing
- ✅ **Cross-platform** — works wherever Node.js + `serialport` work (macOS, Linux, Windows, Raspberry Pi, etc.)
- ✅ **Auto-reconnect** — handles USB unplugs, port renaming, etc.

---

## How it works (the short version)

Skydimo LED controllers speak the **Adalight** protocol over USB serial (115200 baud, 8-N-1). Each frame is a tiny packet:

```
0x41 0x64 0x61 0x00  ← "Ada\0" magic header
0xHH 0xLL            ← LED count (big-endian)
R G B × LED count    ← colour bytes
```

We fill all LEDs with the same colour derived from the HomeKit state (`on`, `brightness`, `hue`, `saturation`) and send a new frame whenever HomeKit updates. A 250 ms keep-alive re-sends the frame so the controller doesn't time out.

Protocol reference: [Skydimo OpenRGB → SkydimoSerialController.cpp](https://gitlab.com/skydimo-team/skydimo-open-rgb/-/blob/master/Controllers/SkydimoController/SkydimoSerialController/SkydimoSerialController.cpp)

---

## ⚠️ Important: Skydimo app must NOT be running

The Skydimo USB controller only accepts one connection at a time. The plugin holds the port exclusively, so:

- **Quit the Skydimo desktop app** before starting Homebridge
- **Remove Skydimo from Login Items** so it doesn't auto-start
- If you need Skydimo's screen-sync feature again, quit Homebridge (or at least this plugin) first

Trade-off summary:

| You want... | Use... |
|---|---|
| HomeKit / Siri / scenes / automations | **This plugin** |
| Screen-sync / music-reactive / multi-mode effects | **Skydimo app** |
| Both simultaneously | Not possible — the controller only accepts one connection |

---

## Requirements

- A Skydimo (or Skydimo-compatible, Adalight-speaking) LED controller connected via USB
- **Node.js 18+** and **Homebridge 1.6+**
- The host computer must have USB access to the controller (any Mac / Linux / Windows / Raspberry Pi works)

---

## Installation

```bash
sudo npm install -g homebridge-skydimo
```

Then add to your Homebridge `config.json`:

```json
{
  "accessories": [
    {
      "accessory": "SkydimoLight",
      "name": "Monitor Lights"
    }
  ]
}
```

Quit the Skydimo desktop app, restart Homebridge, and **Monitor Lights** will appear in the Home app as a full-colour light bulb.

---

## Configuration

All fields are optional — sensible defaults are provided.

```json
{
  "accessory": "SkydimoLight",
  "name": "Monitor Lights",
  "portPath": "/dev/cu.usbserial-1120",
  "baudRate": 115200,
  "numLeds": 71,
  "keepAliveMs": 250
}
```

| Field | Default | Notes |
|---|---|---|
| `name` | `"Monitor Lights"` | Name shown in the Home app |
| `portPath` | _(auto-detect)_ | Absolute serial-port path. Auto-detected on macOS/Linux for common USB-serial chips (CH340, FTDI, CP210x). Set manually if auto-detect fails. |
| `baudRate` | `115200` | Standard for all Skydimo devices |
| `numLeds` | `71` | LED count for your specific strip. Defaults match SK0134. See [LED counts](#led-counts-by-model) below. |
| `keepAliveMs` | `250` | How often to re-send the current frame. Lower = less chance of controller timeout, higher = less USB traffic. |

### LED counts by model

Pull these from Skydimo's own config ([SKController.json](https://gitlab.com/skydimo-team/skydimo-open-rgb) or their desktop app):

| Model | LEDs |
|---|---|
| SK0121 | 51 |
| SK0124 | 54 |
| SK0127 | 65 |
| SK0132 | 77 |
| **SK0134** | **71** |
| SK0149 | 107 |
| SK0201 | 40 |
| SK0204 | 50 |
| SK0L34 | 112 |
| SK0410 | 290 |

If your model isn't listed, check the controller config in the Skydimo app or tweak `numLeds` until all LEDs respond.

---

## Finding your serial port (if auto-detect fails)

**macOS / Linux:**
```bash
ls /dev/cu.usbserial-*
# or
ls /dev/tty.usbserial-*
```

**Linux (typical):**
```bash
ls /dev/ttyUSB*
```

**Windows:**
Check Device Manager → Ports (COM & LPT). Use something like `"COM3"`.

Set the result as `portPath` in your config.

---

## Troubleshooting

### Lights don't respond / Homebridge logs "No USB serial port found"
- Make sure the Skydimo desktop app is fully quit (check menu bar too)
- Replug the USB cable
- Restart Homebridge
- On macOS, check `ls /dev/cu.usbserial-*` — if empty, the controller isn't detected by the OS

### Colours look wrong (orange shows as yellow, etc.)
Cheap RGB LEDs sometimes have uneven channel intensity. If you want correction, fork the repo and tweak `scaleBrightness`/`hsvToRgb` to scale the green channel down (e.g. `g * 0.7`).

### Only some LEDs light up
Your `numLeds` is probably wrong. Increase until all LEDs respond. Too high is fine — extra bytes are ignored.

### Lights flicker or freeze
Lower `keepAliveMs` to `150`. If that doesn't help, your USB cable or adapter might be flaky — try a different one.

### I want the Skydimo screen-sync feature back
Stop Homebridge (or disable just this plugin), then launch the Skydimo desktop app.

---

## Contributing

PRs very welcome. Ideas:

- Support multiple simultaneous Skydimo devices per host
- Expose colour-temperature slider (WW/CW mix)
- Per-LED addressing (for future effects/ambient modes)
- Screen-sync implementation in JS/Node so we don't need to choose between HomeKit and ambilight

---

## Credits

Protocol and LED-config data come from Skydimo's own open-source [OpenRGB fork](https://gitlab.com/skydimo-team/skydimo-open-rgb) (GPL-2.0) — huge thanks to the Skydimo team for open-sourcing it.

This plugin itself is independent community work, MIT-licensed. No affiliation with Skydimo or Homebridge.

---

## Licence

[MIT](LICENSE)
