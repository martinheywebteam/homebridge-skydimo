/**
 * homebridge-skydimo
 * HomeKit plugin for Skydimo ambient monitor lights (macOS only).
 *
 * Because the Skydimo desktop app has no public API, this plugin drives it
 * via macOS UI automation (AppleScript / osascript). The Skydimo app must be
 * running on the same Mac as Homebridge.
 */

const { exec } = require("child_process");

/** Run an AppleScript snippet via osascript. */
function run(script) {
  return new Promise((resolve, reject) => {
    exec(`osascript -e ${JSON.stringify(script)}`, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim()));
      resolve(stdout.trim());
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Convert HomeKit HSV (hue 0-360, sat 0-100, val 0-100) to RGB 0-255. */
function hsvToRgb(h, s, v) {
  s = s / 100;
  v = v / 100;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r, g, b;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

/** Convert RGB 0-255 to uppercase 6-char hex. */
function rgbToHex(r, g, b) {
  return ((r << 16) | (g << 8) | b)
    .toString(16)
    .toUpperCase()
    .padStart(6, "0");
}

module.exports = (api) => {
  api.registerAccessory("SkydimoLight", SkydimoLight);
};

class SkydimoLight {
  constructor(log, config, api) {
    this.log = log;
    this.name = config.name || "Monitor Lights";

    // Cached state (HomeKit will poll these via onGet)
    this.on = true;
    this.brightness = 90;
    this.hue = 24;
    this.saturation = 90;

    // Internal debounce / mutex
    this.colorTimer = null;
    this.busy = false;
    this.pending = false;
    this.rgbSlidersReady = false;

    const { Service, Characteristic } = api.hap;

    this.lightService = new Service.Lightbulb(this.name);

    this.lightService
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.on)
      .onSet(async (v) => {
        this.on = v;
        try {
          await this.setPower(v);
        } catch (e) {
          this.log.error("Power:", e.message);
        }
      });

    this.lightService
      .getCharacteristic(Characteristic.Brightness)
      .onGet(() => this.brightness)
      .onSet(async (v) => {
        this.brightness = v;
        try {
          await this.setBrightness(v);
        } catch (e) {
          this.log.error("Brightness:", e.message);
        }
      });

    this.lightService
      .getCharacteristic(Characteristic.Hue)
      .onGet(() => this.hue)
      .onSet((v) => {
        this.hue = v;
        this.scheduleColorUpdate();
      });

    this.lightService
      .getCharacteristic(Characteristic.Saturation)
      .onGet(() => this.saturation)
      .onSet((v) => {
        this.saturation = v;
        this.scheduleColorUpdate();
      });

    this.infoService = new Service.AccessoryInformation()
      .setCharacteristic(Characteristic.Manufacturer, "Skydimo")
      .setCharacteristic(Characteristic.Model, "Ambient Light (Hex)")
      .setCharacteristic(Characteristic.SerialNumber, "SKYDIMO-001");
  }

  /** Home app sends Hue and Saturation as separate events — debounce so we
   *  apply the combined colour once both have settled. */
  scheduleColorUpdate() {
    if (this.colorTimer) clearTimeout(this.colorTimer);
    this.colorTimer = setTimeout(() => this.runColorUpdate(), 400);
  }

  async runColorUpdate() {
    if (this.busy) {
      this.pending = true;
      return;
    }
    this.busy = true;
    try {
      await this.applyColor();
    } catch (e) {
      this.log.error("Color:", e.message);
    } finally {
      this.busy = false;
      if (this.pending) {
        this.pending = false;
        this.runColorUpdate();
      }
    }
  }

  async ensureSkydimoRunning() {
    try {
      const running = await run(
        'tell application "System Events" to return (exists process "Skydimo")'
      );
      if (running !== "true") {
        await run('tell application "SkyDimo" to activate');
        await sleep(1500);
      }
    } catch (e) {
      /* ignore — will surface at next op */
    }
  }

  async colorsWindowExists() {
    try {
      const out = await run(
        'tell application "System Events" to tell process "Skydimo" to return (exists window "Colors")'
      );
      return out === "true";
    } catch {
      return false;
    }
  }

  async setPower(on) {
    await this.ensureSkydimoRunning();
    const btn = on ? "Turn on all" : "Turn off all";
    await run(
      `tell application "System Events" to tell process "Skydimo" to click button "${btn}" of window "Skydimo"`
    );
    this.log(`Power: ${on ? "ON" : "OFF"}`);
  }

  async setBrightness(level) {
    await this.ensureSkydimoRunning();
    await run(
      `tell application "System Events" to tell process "Skydimo" to tell group 1 of window "Skydimo" to set value of slider 1 to ${level}`
    );
    this.log(`Brightness: ${level}%`);
  }

  /** Make sure the macOS colour picker is open and set to RGB Sliders mode,
   *  where the hex text field is accessible. */
  async ensurePickerAndRgbMode() {
    if (!(await this.colorsWindowExists())) {
      await run(
        'tell application "System Events" to tell process "Skydimo" to click button "Pick color" of group 1 of window "Skydimo"'
      );
      for (let i = 0; i < 30; i++) {
        await sleep(100);
        if (await this.colorsWindowExists()) break;
      }
      this.rgbSlidersReady = false;
    }

    if (!this.rgbSlidersReady) {
      try {
        // Switch to "Color Sliders" tab (2nd toolbar button)
        await run(
          'tell application "System Events" to tell process "Skydimo" to tell window "Colors" to click button 2 of toolbar 1'
        );
        await sleep(250);
        // Open the slider-mode dropdown and pick RGB Sliders
        await run(
          'tell application "System Events" to tell process "Skydimo" to tell splitter group 1 of window "Colors" to click pop up button 1'
        );
        await sleep(300);
        await run(
          'tell application "System Events" to tell process "Skydimo" to tell splitter group 1 of window "Colors" to click menu item "RGB Sliders" of menu 1 of pop up button 1'
        );
        await sleep(250);
        this.rgbSlidersReady = true;
      } catch (e) {
        // Already on RGB Sliders or structure differs — proceed anyway
        this.rgbSlidersReady = true;
      }
    }
  }

  /** Read absolute screen coordinates of the hex-input text field. */
  async getHexFieldCenter() {
    const posStr = await run(
      'tell application "System Events" to tell process "Skydimo" to tell splitter group 1 of window "Colors" to return position of text field 4'
    );
    const sizeStr = await run(
      'tell application "System Events" to tell process "Skydimo" to tell splitter group 1 of window "Colors" to return size of text field 4'
    );
    const [x, y] = posStr.split(",").map((s) => parseInt(s.trim(), 10));
    const [w, h] = sizeStr.split(",").map((s) => parseInt(s.trim(), 10));
    return { x: x + Math.floor(w / 2), y: y + Math.floor(h / 2) };
  }

  /** Core colour-set routine.
   *
   *  NSColorPanel ignores programmatic value changes (`set value of slider to N`)
   *  — they don't fire the colour-changed event, so clicking OK re-applies the
   *  previous colour. The only reliable path is simulated real input events:
   *
   *    1. Activate Skydimo so keystrokes hit the picker
   *    2. Real mouse-click the hex field (focus)
   *    3. Second click + third click immediately after (selects all text)
   *    4. Keystroke the new 6-char hex value
   *    5. Return key to commit
   *    6. Click OK to apply and close the picker
   */
  async applyColor() {
    await this.ensureSkydimoRunning();
    const [r, g, b] = hsvToRgb(this.hue, this.saturation, 100);
    const hex = rgbToHex(r, g, b);
    this.log(
      `Color HSV(${Math.round(this.hue)}, ${Math.round(this.saturation)}) -> #${hex}`
    );

    await this.ensurePickerAndRgbMode();
    const { x, y } = await this.getHexFieldCenter();

    await run('tell application "SkyDimo" to activate');
    await sleep(450);

    // Single click to focus the field
    await run(`tell application "System Events" to click at {${x}, ${y}}`);
    await sleep(350);
    // Double-click to select all existing text
    await run(`tell application "System Events" to click at {${x}, ${y}}`);
    await run(`tell application "System Events" to click at {${x}, ${y}}`);
    await sleep(300);

    await run(`tell application "System Events" to keystroke "${hex}"`);
    await sleep(200);

    // Return (key code 36) commits the hex field
    await run('tell application "System Events" to key code 36');
    await sleep(400);

    try {
      await run(
        'tell application "System Events" to click button "OK" of window "Colors" of process "Skydimo"'
      );
    } catch (e) {
      /* picker already closed */
    }
  }

  getServices() {
    return [this.infoService, this.lightService];
  }
}
