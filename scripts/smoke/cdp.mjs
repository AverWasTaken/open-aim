// Tiny CDP client (Node 24 built-in WebSocket + fetch, no deps).
// Attaches to the app's page target, sends commands with per-call timeouts, and
// collects console/log/exception errors tagged with the current step name.
import fs from "node:fs";
import { sleep } from "./lib.mjs";

export class Cdp {
  constructor({ cdpPort, aimPort, log = () => {} }) {
    this.cdpPort = cdpPort;
    this.aimPort = aimPort;
    this.log = log;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map(); // method -> Set(fn)
    this.errors = []; // {step, kind, level, text, url, t}
    this.step = "boot";
    this.crashed = false;
    this.closed = false;
    this.onScripts = []; // sources for Page.addScriptToEvaluateOnNewDocument (re-added on reattach)
  }

  // Page target that belongs to OUR app: url on our AIM port.
  async findTarget(timeoutMs) {
    const t0 = Date.now();
    const want = `http://localhost:${this.aimPort}/`;
    let last = "";
    while (Date.now() - t0 < timeoutMs) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${this.cdpPort}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
        const pages = list.filter((t) => t.type === "page");
        const ours = pages.find((t) => t.url.startsWith(want) || t.url.startsWith(`http://127.0.0.1:${this.aimPort}/`));
        if (ours) return ours;
        last = pages.map((p) => p.url).join(", ");
      } catch (e) {
        last = String(e.message || e);
      }
      await sleep(500);
    }
    throw new Error(`no page target on CDP ${this.cdpPort} with url ${want}* within ${Math.round(timeoutMs / 1000)} s (saw: ${last || "nothing"})`);
  }

  async attach(timeoutMs = 120000) {
    const target = await this.findTarget(timeoutMs);
    this.targetId = target.id;
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error("CDP websocket open timed out")), 15000);
      ws.onopen = () => (clearTimeout(to), res());
      ws.onerror = (e) => (clearTimeout(to), rej(new Error("CDP websocket error " + (e.message || ""))));
    });
    this.ws = ws;
    this.closed = false;
    ws.onmessage = (ev) => this.#onMessage(ev.data);
    ws.onclose = () => {
      this.closed = true;
      for (const [, p] of this.pending) p.reject(new Error("CDP websocket closed"));
      this.pending.clear();
    };
    for (const m of ["Runtime.enable", "Log.enable", "Page.enable", "Inspector.enable"]) await this.send(m, {}, 15000);
    // A hidden window under xvfb (no window manager) never has focus; a player's window does.
    // Emulate focus so document.hasFocus() is true like on a real desktop (it does not pause
    // or resume anything by itself: driving map 10).
    await this.send("Emulation.setFocusEmulationEnabled", { enabled: true }, 15000).catch((e) => this.log(`focus emulation unavailable: ${e.message}`));
    for (const src of this.onScripts) await this.send("Page.addScriptToEvaluateOnNewDocument", { source: src }, 15000);
    return target;
  }

  // Reconnect only if the websocket closed (plan S5).
  async ensureAttached() {
    if (this.crashed) throw new Error("renderer crashed");
    if (!this.closed && this.ws) return;
    this.log("CDP websocket closed; reattaching via /json/list");
    await this.attach(30000);
  }

  async addOnNewDocument(source) {
    this.onScripts.push(source);
    await this.send("Page.addScriptToEvaluateOnNewDocument", { source }, 15000);
  }

  #onMessage(data) {
    const m = JSON.parse(data);
    if (m.id && this.pending.has(m.id)) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`));
      else p.resolve(m.result);
      return;
    }
    const t = Date.now();
    switch (m.method) {
      case "Runtime.exceptionThrown": {
        const d = m.params.exceptionDetails;
        this.errors.push({ step: this.step, kind: "exception", level: "error", text: (d.exception?.description || d.text || "").slice(0, 600), url: d.url || "", t });
        break;
      }
      case "Runtime.consoleAPICalled": {
        const type = m.params.type;
        if (type === "error" || type === "warning" || type === "assert") {
          const text = m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 600);
          const url = m.params.stackTrace?.callFrames?.[0]?.url || "";
          this.errors.push({ step: this.step, kind: "console", level: type === "warning" ? "warning" : "error", text, url, t });
        }
        break;
      }
      case "Log.entryAdded": {
        const e = m.params.entry;
        if (e.level === "error" || e.level === "warning") this.errors.push({ step: this.step, kind: "log", level: e.level, text: (e.text || "").slice(0, 600), url: e.url || "", source: e.source, t });
        break;
      }
      case "Inspector.targetCrashed":
        this.crashed = true;
        this.errors.push({ step: this.step, kind: "exception", level: "error", text: "renderer crashed (Inspector.targetCrashed)", url: "", t });
        break;
      case "Inspector.detached":
        this.log("Inspector.detached: " + m.params.reason);
        if (/crash/i.test(m.params.reason || "")) this.crashed = true;
        break;
    }
    const hs = this.handlers.get(m.method);
    if (hs) for (const h of hs) {
      try {
        h(m.params);
      } catch {}
    }
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method).add(fn);
    return () => this.handlers.get(method).delete(fn);
  }

  send(method, params = {}, timeoutMs = 30000) {
    if (this.crashed) return Promise.reject(new Error("renderer crashed"));
    if (!this.ws || this.closed) return Promise.reject(new Error("CDP not connected"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  // Evaluate an expression in the page; returns the value (JSON). Throws on page exceptions.
  async evaluate(expression, { timeout = 30000 } = {}) {
    await this.ensureAttached();
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout }, timeout + 5000);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error("page evaluate threw: " + (d.exception?.description || d.text || "?").split("\n")[0].slice(0, 300));
    }
    return r.result?.value;
  }

  async click(x, y) {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  // Shoot without moving the CDP mouse (moves turn the camera while locked).
  // Viewport centre (1280x720 headless; refreshed by updateCenter in case the window was resized).
  cx = 640;
  cy = 360;
  async updateCenter() {
    const c = await this.evaluate("[innerWidth, innerHeight]").catch(() => null);
    if (c && c[0] > 0) {
      this.cx = Math.round(c[0] / 2);
      this.cy = Math.round(c[1] / 2);
    }
    return [this.cx, this.cy];
  }

  async press(x = this.cx, y = this.cy) {
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await sleep(40);
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  async moveTo(x = this.cx, y = this.cy) {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  }

  static KEYS = {
    Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
    Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
    Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
    t: { key: "t", code: "KeyT", windowsVirtualKeyCode: 84, text: "t" },
    r: { key: "r", code: "KeyR", windowsVirtualKeyCode: 82, text: "r" },
    w: { key: "w", code: "KeyW", windowsVirtualKeyCode: 87, text: "w" },
  };

  async key(name) {
    const k = Cdp.KEYS[name];
    if (!k) throw new Error("unknown key " + name);
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode, nativeVirtualKeyCode: k.windowsVirtualKeyCode };
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
    if (k.text) await this.send("Input.dispatchKeyEvent", { type: "char", ...base, text: k.text, unmodifiedText: k.text });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  // Hold / release a key separately (edge:blur holds W through an alt-tab).
  async keyDown(name) {
    const k = Cdp.KEYS[name];
    if (!k) throw new Error("unknown key " + name);
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode, nativeVirtualKeyCode: k.windowsVirtualKeyCode };
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
    if (k.text) await this.send("Input.dispatchKeyEvent", { type: "char", ...base, text: k.text, unmodifiedText: k.text });
  }

  async keyUp(name) {
    const k = Cdp.KEYS[name];
    if (!k) throw new Error("unknown key " + name);
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode, nativeVirtualKeyCode: k.windowsVirtualKeyCode });
  }

  async screenshot(file) {
    const r = await this.send("Page.captureScreenshot", { format: "png" }, 30000);
    fs.writeFileSync(file, Buffer.from(r.data, "base64"));
    return file;
  }

  close() {
    try {
      this.ws?.close();
    } catch {}
  }
}
