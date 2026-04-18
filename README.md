# homebridge-skydimo

HomeKit plugin for [Skydimo](https://skydimo.com/en) ambient monitor lights — adds **on/off, brightness, and full colour-wheel support** so you can control your Skydimo lights with Siri, the Home app, scenes, and HomeKit automations.

> ⚠️ **macOS only.** Because Skydimo is a USB-tethered peripheral with no public API, this plugin drives the Skydimo desktop app via macOS UI automation (AppleScript / `osascript`). The Skydimo app must be running on the same Mac as Homebridge.

### Where to buy the lights

- **Official site:** [skydimo.com](https://skydimo.com/en)
- **Temu (affordable alternative):** [share.temu.com/4uuaz6YYtKB](https://share.temu.com/4uuaz6YYtKB) — same hardware, tested with this plugin ✅

---

## 🖥️ Recommended setup: dedicated Mac home server

**This plugin is designed for a dedicated/headless Mac used as a home server**, not for your main work Mac.

Here's why that matters:

Every time HomeKit changes the colour, the plugin briefly activates Skydimo and flashes its colour picker window on screen (~2 seconds). On a dedicated server Mac running in clamshell mode (lid closed, tucked in a corner with an external monitor), this is completely invisible — it just works.

**But on your main work Mac**, this will interrupt whatever you're doing:
- The Skydimo app steals focus mid-typing
- The colour picker window pops up over your other apps
- Keystrokes get redirected to Skydimo for ~1 second

### My setup (the intended use case)

I run this on an old MacBook Pro that sits on a shelf as a 24/7 home server. It handles:
- Homebridge (running this plugin + others)
- Docker containers
- Media server
- File sharing

The Skydimo lights are physically connected to that server Mac via USB, and the colour picker popping up there has zero impact on my work Mac — I just talk to HomeKit/Siri and the lights change.

### If you don't have a spare Mac

You can still use this plugin on your main Mac, but expect the occasional picker flash. Alternatives if that bothers you:
- Use only HomeKit **scenes** with preset colours (bundle the colour change into a scene you trigger manually) — still some flashing but predictable timing
- Accept the trade-off and only change colours when you're not actively typing
- Wait for a future version that can talk to the lights directly over USB (contributions welcome — see [Contributing](#contributing))

---

## Why this exists

Skydimo monitor lights are a great, affordable ambient-lighting product — but they're **not a smart home device**. They connect to a specific computer over USB and are only controllable via Skydimo's desktop app. No HomeKit, no Siri, no automations, no scenes.

This plugin bridges that gap by scripting the Skydimo desktop app through macOS accessibility APIs, so HomeKit sees the lights as a normal colour bulb.

---

## Features

- ✅ **On / Off** via HomeKit (maps to Skydimo's _Turn on all / Turn off all_ buttons)
- ✅ **Brightness** 0–100% (drives the main brightness slider)
- ✅ **Full colour wheel** — any colour the Home app picker can produce
- ✅ **Siri support** — _"Hey Siri, set monitor lights to purple"_
- ✅ **Scenes & automations** — sync with other lights, sunset triggers, etc.

### What you get

| HomeKit capability | Works? |
|---|---|
| On / Off | ✅ |
| Brightness slider | ✅ |
| Colour wheel (hue + saturation) | ✅ |
| Colour temperature slider | ❌ (not exposed) |
| Adaptive Lighting | ❌ (Skydimo has no API for this) |

---

## Requirements

- **macOS** (tested on macOS Sequoia and Tahoe, Apple Silicon) — will not work on Linux or Raspberry Pi
- **Skydimo desktop app** installed and running, with your device connected and in **Single color** mode
- **Node.js 18+** and **Homebridge 1.6+**
- **Accessibility permission** granted to `osascript` (and whichever process runs Homebridge)

---

## Installation

### 1. Install the plugin

```bash
sudo npm install -g homebridge-skydimo
```

Or if you're running Homebridge without global installs:

```bash
cd ~/.homebridge
npm install homebridge-skydimo
```

### 2. Grant Accessibility permission

This plugin simulates real mouse clicks and keystrokes on your Mac, which requires explicit user permission.

Open **System Settings → Privacy & Security → Accessibility** and add:

- `/usr/bin/osascript`
- The Node.js binary that runs Homebridge (usually `/opt/homebrew/opt/node@20/bin/node` or similar — find it with `which node`)
- Your Terminal app (if you start Homebridge from a terminal)

Make sure each one is toggled **ON**.

> Without these permissions the plugin will fail with errors like _"osascript is not allowed assistive access"_.

### 3. Start Skydimo and configure it

- Open the Skydimo desktop app
- Connect your lights
- Set mode to **Single color** (required — the plugin drives the colour picker in this mode)
- Add Skydimo to **System Settings → General → Login Items** so it auto-starts

### 4. Add to your Homebridge config

Edit `~/.homebridge/config.json` and add the accessory:

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

Then restart Homebridge.

### 5. Add to HomeKit

Open the Home app on your iPhone/iPad/Mac. **Monitor Lights** should appear as a colour light bulb. You can rename it, move it to a room, and include it in scenes and automations.

---

## How it works (technical)

Skydimo provides no API, so every action is performed by scripting the app's UI:

| Action | Mechanism |
|---|---|
| On / Off | Click `Turn on all` / `Turn off all` button in the main window |
| Brightness | Set the value of the brightness slider directly |
| Colour | Open the colour picker, switch to **RGB Sliders** mode, type the target hex into the hex field, press Return, click OK |

### Why colour is the tricky bit

macOS's `NSColorPanel` (the native colour picker) **ignores programmatic value changes**. If you `set value of slider "Red" to 255` via AppleScript, the slider moves visually but the internal colour state doesn't update — so clicking OK re-applies the previous colour.

The only reliable path is to simulate **real user input events** (real mouse clicks and real keystrokes). The plugin:

1. Activates Skydimo so keystrokes land in the picker
2. Uses `click at {x, y}` to generate a real mouse event on the hex field
3. Follows with a rapid double-click at the same point to select-all the existing text
4. Sends the new 6-character hex via `keystroke`
5. Presses Return (`key code 36`) to commit
6. Clicks **OK** to apply the colour

Each colour change takes ~2 seconds. The Skydimo app window will briefly flash as the picker opens and closes — this is normal.

---

## Troubleshooting

### "Skydimo is not responding"
If the Skydimo app freezes, force-quit it (⌘+⌥+Esc), unplug and reconnect the USB cable, and reopen.

### Colours are wrong / look yellowish
Open the Skydimo app manually. Use **Pick color** and set an RGB value (e.g. `255, 0, 0` for pure red). If the physical light also looks wrong, the issue is the LED hardware, not this plugin — adjust the colour in the Home app accordingly.

If colours look right when you set them manually but wrong when set via HomeKit, check that Skydimo is in **Single color** mode (not Screen Sync / Music / Colorful).

### "osascript is not allowed assistive access"
Re-grant Accessibility permission to `osascript` and to the Node binary that runs Homebridge. See [Installation § 2](#2-grant-accessibility-permission).

### Colour picker flashes on screen every time
That's expected — the plugin opens the picker, updates values, and closes it on every colour change. Unfortunately it's unavoidable without a real Skydimo API.

### I have multiple Skydimo devices
Current version controls all devices together (like Skydimo's "Turn on all" button). Per-device control would require further work.

---

## Known limitations

- **Not a silent background process** — the Skydimo colour picker window briefly flashes on screen during colour changes
- **Skydimo must be the frontmost app** during colour changes (the plugin temporarily steals focus for ~1 second)
- **Single-computer only** — the Skydimo app needs to be running on the same Mac as Homebridge
- **Breaks if the Skydimo app UI changes** — if a future Skydimo update renames the `Turn on all` button or restructures the colour picker, the plugin will need updating

---

## Contributing

PRs and issues welcome. This plugin was reverse-engineered by poking at the Skydimo app's accessibility tree and figuring out what worked. If you find a better path — especially a way to bypass the colour-picker window entirely (direct USB protocol?) — please open an issue.

---

## License

MIT — see [LICENSE](LICENSE).

---

## Credits

- Built for personal use and released in case it helps someone else
- No affiliation with Skydimo or Homebridge
- Inspired by countless hours of reverse engineering the Skydimo UI 🎨

---

## Disclaimer

This plugin is a community project. "Skydimo" is a trademark of its respective owner. Use at your own risk — it works for me but may break at any time if Skydimo updates their app.
