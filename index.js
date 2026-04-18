/**
 * homebridge-skydimo (v2) — direct USB serial
 *
 * Talks to Skydimo LED controllers directly over USB using the Adalight
 * protocol (as documented in Skydimo's own OpenRGB source:
 * https://gitlab.com/skydimo-team/skydimo-open-rgb).
 *
 * Because the controller holds the serial port exclusively, the Skydimo
 * desktop app must NOT be running while this plugin is active. In exchange
 * you get silent, instant HomeKit control with no UI automation — at the
 * cost of the app's screen-sync feature.
 *
 * Adalight frame:
 *   0x41 0x64 0x61 0x00  (ASCII "Ada\0" — magic header)
 *   0xHH 0xLL            (LED count, big-endian)
 *   [R G B] × LED count  (colour bytes per LED)
 *
 * At 115200 baud, one frame for 71 LEDs = ~21 ms transmit time.
 */

const { SerialPort } = require("serialport");

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Convert HomeKit HSV (0-360, 0-100, 0-100) to RGB 0-255. */
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

/** Scale an RGB triplet by brightness 0-100. */
function scaleBrightness([r, g, b], brightness) {
  const f = Math.max(0, Math.min(100, brightness)) / 100;
  return [Math.round(r * f), Math.round(g * f), Math.round(b * f)];
}

// ──────────────────────────────────────────────────────────────────────────
// Plugin entry
// ──────────────────────────────────────────────────────────────────────────

module.exports = (api) => {
  api.registerAccessory("SkydimoLight", SkydimoLight);
};

class SkydimoLight {
  constructor(log, config, api) {
    this.log = log;
    this.name = config.name || "Monitor Lights";

    // User-configurable options
    this.portPath = config.portPath || null; // auto-detect if not set
    this.baudRate = config.baudRate || 115200;
    this.numLeds = config.numLeds || 71;     // SK0134 default; override in config for other models
    this.keepAliveMs = config.keepAliveMs || 250;

    // HomeKit state
    this.on = false;
    this.brightness = 80;
    this.hue = 24;
    this.saturation = 90;

    // Serial & write state
    this.port = null;
    this.portReady = false;
    this.keepAliveTimer = null;
    this.colorTimer = null;

    // Register HomeKit characteristics
    const { Service, Characteristic } = api.hap;

    this.lightService = new Service.Lightbulb(this.name);

    this.lightService
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.on)
      .onSet((v) => {
        this.on = !!v;
        this.pushState();
      });

    this.lightService
      .getCharacteristic(Characteristic.Brightness)
      .onGet(() => this.brightness)
      .onSet((v) => {
        this.brightness = v;
        this.pushState();
      });

    this.lightService
      .getCharacteristic(Characteristic.Hue)
      .onGet(() => this.hue)
      .onSet((v) => {
        this.hue = v;
        this.debouncedPush();
      });

    this.lightService
      .getCharacteristic(Characteristic.Saturation)
      .onGet(() => this.saturation)
      .onSet((v) => {
        this.saturation = v;
        this.debouncedPush();
      });

    this.infoService = new Service.AccessoryInformation()
      .setCharacteristic(Characteristic.Manufacturer, "Skydimo")
      .setCharacteristic(Characteristic.Model, "LED Strip (Adalight direct)")
      .setCharacteristic(Characteristic.SerialNumber, "SKYDIMO-DIRECT");

    // Start connecting asynchronously — don't block accessory registration
    this.connect();
  }

  // ────────────────────────────────────────────────────────────────────────
  // Port discovery & lifecycle
  // ────────────────────────────────────────────────────────────────────────

  async findPort() {
    if (this.portPath) return this.portPath;
    try {
      const ports = await SerialPort.list();
      const match = (p) =>
        /usbserial|wchusbserial/i.test(p.path) ||
        /Silicon Labs|FTDI|QinHeng|CH340/i.test(
          `${p.manufacturer || ""} ${p.vendorId || ""}`
        );
      const candidate =
        ports.find((p) => match(p) && /^\/dev\/cu\./.test(p.path)) ||
        ports.find(match);
      if (candidate) {
        // On macOS, serialport often only lists /dev/tty.* — but /dev/cu.*
        // is the preferred path. Swap if the cu.* sibling exists.
        let resolved = candidate.path;
        if (/^\/dev\/tty\./.test(resolved)) {
          const fs = require("fs");
          const cuPath = resolved.replace("/dev/tty.", "/dev/cu.");
          try {
            if (fs.existsSync(cuPath)) resolved = cuPath;
          } catch (e) {
            /* ignore */
          }
        }
        this.log(`Auto-detected serial port: ${resolved}`);
        return resolved;
      }
    } catch (e) {
      this.log.error("Port enumeration failed:", e.message);
    }
    return null;
  }

  async connect() {
    const path = await this.findPort();
    if (!path) {
      this.log.warn(
        "No USB serial port found. Plug in the Skydimo controller and make sure the Skydimo desktop app is NOT running. Retrying in 10s..."
      );
      setTimeout(() => this.connect(), 10000);
      return;
    }

    try {
      this.port = new SerialPort({
        path,
        baudRate: this.baudRate,
        autoOpen: true,
      });

      this.port.on("open", () => {
        this.portReady = true;
        this.log(`Connected to Skydimo controller at ${path}`);
        this.startKeepAlive();
        // Push current state immediately so lights match HomeKit on startup
        this.pushState();
      });

      this.port.on("error", (err) => {
        this.log.error("Serial error:", err.message);
      });

      this.port.on("close", () => {
        this.portReady = false;
        this.stopKeepAlive();
        this.log.warn("Serial port closed. Reconnecting in 5s...");
        setTimeout(() => this.connect(), 5000);
      });
    } catch (e) {
      this.log.error("Failed to open serial port:", e.message);
      this.portReady = false;
      setTimeout(() => this.connect(), 10000);
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Frame building & sending
  // ────────────────────────────────────────────────────────────────────────

  /** Build an Adalight frame filling all LEDs with a single RGB colour. */
  buildFrame([r, g, b]) {
    const count = this.numLeds;
    const frame = Buffer.alloc(6 + count * 3);
    // "Ada\0" magic
    frame[0] = 0x41;
    frame[1] = 0x64;
    frame[2] = 0x61;
    frame[3] = 0x00;
    // LED count (big-endian)
    frame[4] = (count >> 8) & 0xff;
    frame[5] = count & 0xff;
    // RGB payload
    for (let i = 0; i < count; i++) {
      const off = 6 + i * 3;
      frame[off] = r;
      frame[off + 1] = g;
      frame[off + 2] = b;
    }
    return frame;
  }

  currentColourRgb() {
    if (!this.on) return [0, 0, 0];
    const raw = hsvToRgb(this.hue, this.saturation, 100);
    return scaleBrightness(raw, this.brightness);
  }

  pushState() {
    if (!this.portReady || !this.port) return;
    const rgb = this.currentColourRgb();
    try {
      this.port.write(this.buildFrame(rgb));
    } catch (e) {
      this.log.error("Write failed:", e.message);
    }
  }

  /** Home app sends Hue and Saturation as separate events — coalesce. */
  debouncedPush() {
    if (this.colorTimer) clearTimeout(this.colorTimer);
    this.colorTimer = setTimeout(() => this.pushState(), 50);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Keep-alive: re-send every 250 ms so controller doesn't timeout
  // ────────────────────────────────────────────────────────────────────────

  startKeepAlive() {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      this.pushState();
    }, this.keepAliveMs);
  }

  stopKeepAlive() {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Homebridge boilerplate
  // ────────────────────────────────────────────────────────────────────────

  getServices() {
    return [this.infoService, this.lightService];
  }
}
