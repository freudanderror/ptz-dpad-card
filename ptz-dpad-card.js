/*
 * PTZ D-Pad Card for Home Assistant
 * Round pan/tilt control pad (up / right / down / left + optional center).
 * Works with button / script / input_button / switch entities (Tapo Control,
 * Reolink, AiDot, ...) or ONVIF (onvif.ptz). Auto-detects PTZ entities from
 * the camera's device.
 */
const CARD_VERSION = "1.0.1";

const DIRS = ["up", "right", "down", "left"];
const ANGLE = { up: -90, right: 0, down: 90, left: 180 };

// Word patterns matched against entity_id, translation_key and friendly name
// (English + German, word boundaries = start/end/_/space/-)
const B = "(?:^|[_\\s.-])";
const E = "(?:$|[_\\s.-])";
const PATTERNS = {
  up: new RegExp(`${B}(up|hoch|oben|aufwarts|aufwärts|nach_oben)${E}`, "i"),
  down: new RegExp(`${B}(down|runter|unten|abwarts|abwärts|nach_unten)${E}`, "i"),
  left: new RegExp(`${B}(left|links|nach_links)${E}`, "i"),
  right: new RegExp(`${B}(right|rechts|nach_rechts)${E}`, "i"),
  stop: new RegExp(`${B}(stop|stopp|anhalten)${E}`, "i"),
  center: new RegExp(`(calibrat|kalibr|home_position|go_home|ptz_home|${B}home${E}|${B}mitte${E})`, "i"),
};
// Extra hint words: only entities that also look like PTZ count for stop/home
const PTZ_HINT = /(move|ptz|pan|tilt|beweg|schwenk|neig|dreh|calibrat|kalibr)/i;
const PRESSABLE = ["button", "input_button", "script"];
// Common camera entity suffixes stripped to find the base name (camera.flur_hd_stream -> flur)
const CAM_SUFFIX = /_(hd|sd)(_stream)?$|_(main|sub|mainstream|substream|stream|live|kamera|camera|cam|fluent|clear|high|low)$/i;

const ONVIF_MAP = {
  up: { tilt: "UP" },
  down: { tilt: "DOWN" },
  left: { pan: "LEFT" },
  right: { pan: "RIGHT" },
};

const fireEvent = (node, type, detail = {}) => {
  node.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
};

const pt = (r, deg) => {
  const a = (deg * Math.PI) / 180;
  return [(100 + r * Math.cos(a)).toFixed(2), (100 + r * Math.sin(a)).toFixed(2)];
};

const wedgePath = (deg, r1, r2) => {
  const [x1, y1] = pt(r2, deg - 45);
  const [x2, y2] = pt(r2, deg + 45);
  const [x3, y3] = pt(r1, deg + 45);
  const [x4, y4] = pt(r1, deg - 45);
  return `M${x1} ${y1} A${r2} ${r2} 0 0 1 ${x2} ${y2} L${x3} ${y3} A${r1} ${r1} 0 0 0 ${x4} ${y4} Z`;
};

class PtzDpadCard extends HTMLElement {
  static getConfigElement() {
    return document.createElement("ptz-dpad-card-editor");
  }

  static getStubConfig(hass) {
    const cam = Object.keys(hass?.states || {}).find((e) => e.startsWith("camera."));
    return { camera: cam || "" };
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._timer = null;
    this._active = null;
    this._resolvedKey = null;
    this._resolved = {};
  }

  setConfig(config) {
    if (!config) throw new Error("Ungültige Konfiguration");
    const hasManual = DIRS.some((d) => config[d]);
    if (!config.camera && !hasManual) {
      throw new Error("Bitte 'camera' oder mindestens eine Richtung (up/down/left/right) angeben");
    }
    this._config = {
      repeat_interval: 0,
      size: 220,
      ...config,
    };
    this._resolvedKey = null;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._resolve();
    this._updateAvailability();
  }

  getCardSize() {
    return 4;
  }

  getGridOptions() {
    return { columns: 6, rows: 4, min_columns: 3, min_rows: 3 };
  }

  disconnectedCallback() {
    this._clearTimer();
  }

  /* ---------- entity resolution ---------- */

  _resolve() {
    if (!this._hass || !this._config) return;
    const key = `${this._config.camera}|${Object.keys(this._hass.entities || {}).length}`;
    if (key === this._resolvedKey) return;
    this._resolvedKey = key;

    const res = {};
    const cfg = this._config;
    const auto = this._autoDetect();

    for (const d of [...DIRS, "stop", "center"]) {
      if (cfg[d] !== undefined && cfg[d] !== "" && cfg[d] !== null) res[d] = cfg[d];
      else if (auto[d]) res[d] = auto[d];
    }
    this._resolved = res;
    this._mode = cfg.mode || (auto.__onvif && !DIRS.some((d) => typeof res[d] === "string") ? "onvif" : "entity");
  }

  _autoDetect() {
    const out = {};
    const cam = this._config.camera;
    const reg = this._hass.entities || {};
    if (!cam) return out;

    const camEntry = reg[cam] || {};
    if (camEntry.platform === "onvif") out.__onvif = true;

    const pressable = Object.values(reg).filter((e) => PRESSABLE.includes(e.entity_id.split(".")[0]));

    // Base name of the camera, e.g. camera.flur_hd_stream -> "flur"
    let base = cam.split(".")[1];
    for (let i = 0; i < 3; i++) base = base.replace(CAM_SUFFIX, "");

    // Candidate pools, tried in this order:
    // 1) same device  2) same area + same integration  3) entity_id starts with camera base name
    const pools = [];
    if (camEntry.device_id) pools.push(pressable.filter((e) => e.device_id === camEntry.device_id));
    if (base) pools.push(pressable.filter((e) => e.entity_id.split(".")[1].startsWith(base + "_")));
    const dev = camEntry.device_id && this._hass.devices?.[camEntry.device_id];
    const area = camEntry.area_id || dev?.area_id;
    if (area) {
      pools.push(
        pressable.filter((e) => {
          const a = e.area_id || this._hass.devices?.[e.device_id]?.area_id;
          return a === area;
        })
      );
    }

    const texts = (e) => {
      const st = this._hass.states[e.entity_id];
      return [e.entity_id.split(".")[1], e.translation_key || "", st?.attributes?.friendly_name || "", e.name || ""];
    };

    for (const pool of pools) {
      if (!pool.length) continue;
      const found = {};
      for (const [dir, re] of Object.entries(PATTERNS)) {
        const needsHint = dir === "stop" || dir === "center";
        // prefer entities that also look like PTZ (move/ptz/pan/tilt ...)
        const matches = pool.filter((e) => texts(e).some((t) => re.test(t)));
        const hinted = matches.filter((e) => texts(e).some((t) => PTZ_HINT.test(t)));
        const hit = hinted[0] || (needsHint && dir === "stop" ? null : matches[0]);
        if (hit) found[dir] = hit.entity_id;
      }
      // a pool counts only if it delivered at least two directions
      if (DIRS.filter((d) => found[d]).length >= 2) {
        Object.assign(out, found);
        break;
      }
    }

    if (this._config.debug) {
      // eslint-disable-next-line no-console
      console.info("[ptz-dpad-card] Auto-Erkennung für", cam, "→", out, "Basisname:", base);
    }
    return out;
  }

  /* ---------- actions ---------- */

  _execute(target, dir) {
    if (!this._hass) return;

    if (this._mode === "onvif" && DIRS.includes(dir) && !target) {
      this._hass.callService(
        "onvif",
        "ptz",
        {
          ...ONVIF_MAP[dir],
          move_mode: "ContinuousMove",
          continuous_duration: this._config.onvif_duration ?? 0.4,
          speed: this._config.onvif_speed ?? 0.5,
        },
        { entity_id: this._config.camera }
      );
      return;
    }
    if (!target) return;

    if (typeof target === "string") return this._pressEntity(target);

    if (target.entity && !target.action && !target.perform_action && !target.service) {
      return this._pressEntity(target.entity);
    }

    const svc = target.perform_action || target.service;
    if (svc) {
      const [domain, service] = svc.split(".");
      this._hass.callService(domain, service, { ...(target.data || target.service_data || {}) }, target.target);
    }
  }

  _pressEntity(entityId) {
    const domain = entityId.split(".")[0];
    const map = {
      button: ["button", "press"],
      input_button: ["input_button", "press"],
      script: ["script", "turn_on"],
      scene: ["scene", "turn_on"],
      switch: ["switch", "toggle"],
      input_boolean: ["input_boolean", "toggle"],
      automation: ["automation", "trigger"],
    };
    const [d, s] = map[domain] || ["homeassistant", "turn_on"];
    this._hass.callService(d, s, {}, { entity_id: entityId });
  }

  _start(dir) {
    const target = this._resolved[dir];
    const usable = target || (this._mode === "onvif" && DIRS.includes(dir));
    if (!usable) return;

    this._active = dir;
    this.shadowRoot.querySelector(`[data-dir="${dir}"]`)?.classList.add("pressed");
    fireEvent(this, "haptic", "light");
    this._execute(target, dir);

    const iv = Number(this._config.repeat_interval) || 0;
    if (iv > 0 && dir !== "center") {
      this._clearTimer();
      this._timer = setInterval(() => this._execute(target, dir), iv);
    }
  }

  _end() {
    if (!this._active) return;
    const dir = this._active;
    this._active = null;
    this._clearTimer();
    this.shadowRoot.querySelector(`[data-dir="${dir}"]`)?.classList.remove("pressed");
    if (dir !== "center" && this._resolved.stop && this._config.stop_on_release !== false) {
      this._execute(this._resolved.stop, "stop");
    }
  }

  _clearTimer() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  _updateAvailability() {
    if (!this.shadowRoot || !this._hass) return;
    for (const d of [...DIRS, "center"]) {
      const el = this.shadowRoot.querySelector(`[data-dir="${d}"]`);
      if (!el) continue;
      const t = this._resolved[d];
      let ok = !!t || (this._mode === "onvif" && DIRS.includes(d));
      const id = typeof t === "string" ? t : t?.entity;
      if (id) {
        const st = this._hass.states[id];
        ok = !!st && st.state !== "unavailable";
      }
      el.classList.toggle("disabled", !ok);
      el.setAttribute("aria-disabled", String(!ok));
    }
    const nameEl = this.shadowRoot.querySelector(".name");
    if (nameEl && !this._config.name && this._config.camera) {
      const st = this._hass.states[this._config.camera];
      nameEl.textContent = this._config.show_name === false ? "" : st?.attributes?.friendly_name || "";
    }
  }

  /* ---------- render ---------- */

  _render() {
    const c = this._config;
    const arrow = c.arrow_color || "var(--ptz-arrow-color, #3a86de)";
    const ring = c.ring_color || "var(--ptz-ring-color, var(--divider-color, #3c3c3e))";
    const center = c.center_color || "var(--ptz-center-color, var(--primary-text-color, #f5f5f5))";
    const name = c.show_name === false ? "" : c.name || "";

    const wedges = DIRS.map((d) => {
      const a = ANGLE[d];
      const [tx, ty] = [100 + 75, 100];
      const tri = `${tx},${ty} ${100 + 62},${100 - 9} ${100 + 62},${100 + 9}`;
      return `
        <g class="btn" data-dir="${d}" role="button" tabindex="0" aria-label="${d}">
          <path class="hit" d="${wedgePath(a, 34, 93)}"></path>
          <polygon class="arrow" points="${tri}" transform="rotate(${a} 100 100)"></polygon>
        </g>`;
    }).join("");

    const ticks = [45, 135, 225, 315]
      .map((a) => {
        const [x1, y1] = pt(52, a);
        const [x2, y2] = pt(72, a);
        return `<line class="tick" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"></line>`;
      })
      .join("");

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        ha-card { padding: 16px; display: flex; flex-direction: column; align-items: center; gap: 8px; height: 100%; box-sizing: border-box; justify-content: center; }
        .name { font-size: 1rem; color: var(--primary-text-color); opacity: .85; min-height: 0; }
        .name:empty { display: none; }
        svg { width: 100%; max-width: ${Number(c.size) || 220}px; aspect-ratio: 1; touch-action: none; user-select: none; -webkit-user-select: none; -webkit-tap-highlight-color: transparent; overflow: visible; }
        .ring { fill: none; stroke: ${ring}; stroke-width: 2.2; }
        .tick { stroke: ${ring}; stroke-width: 1.4; stroke-linecap: round; }
        .hit { fill: ${arrow}; fill-opacity: 0; transition: fill-opacity .12s; }
        .arrow { fill: ${arrow}; stroke: ${arrow}; stroke-width: 3.5; stroke-linejoin: round; transition: opacity .12s; }
        .btn { cursor: pointer; outline: none; }
        .btn:hover .hit { fill-opacity: .06; }
        .btn:focus-visible .hit { fill-opacity: .1; }
        .btn.pressed .hit { fill-opacity: .16; }
        .btn.disabled { cursor: default; pointer-events: none; }
        .btn.disabled .arrow { opacity: .25; }
        .center-ring { fill: none; stroke: ${center}; stroke-width: 7; transition: stroke-width .1s; }
        .center .hit-c { fill: ${arrow}; fill-opacity: 0; transition: fill-opacity .12s; }
        .center.pressed .hit-c { fill-opacity: .16; }
        .center.pressed .center-ring { stroke-width: 9; }
        .center.disabled { pointer-events: none; cursor: default; }
      </style>
      <ha-card>
        <div class="name">${name}</div>
        <svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
          <circle class="ring" cx="100" cy="100" r="96"></circle>
          ${ticks}
          ${wedges}
          <g class="btn center" data-dir="center" role="button" tabindex="0" aria-label="center">
            <circle class="hit-c" cx="100" cy="100" r="32"></circle>
            <circle class="center-ring" cx="100" cy="100" r="25"></circle>
          </g>
        </svg>
      </ha-card>`;

    this.shadowRoot.querySelectorAll(".btn").forEach((el) => {
      const dir = el.dataset.dir;
      el.addEventListener("pointerdown", (ev) => {
        ev.preventDefault();
        try { el.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
        this._start(dir);
      });
      ["pointerup", "pointercancel", "lostpointercapture"].forEach((t) => el.addEventListener(t, () => this._end()));
      el.addEventListener("keydown", (ev) => {
        if ((ev.key === "Enter" || ev.key === " ") && !ev.repeat) {
          ev.preventDefault();
          this._start(dir);
        }
      });
      el.addEventListener("keyup", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") this._end();
      });
      el.addEventListener("contextmenu", (ev) => ev.preventDefault());
    });

    this._updateAvailability();
  }
}

/* ---------- visual editor ---------- */

const PTZ_DOMAINS = ["button", "input_button", "script", "switch", "scene", "input_boolean", "automation"];

const SCHEMA = [
  { name: "camera", selector: { entity: { domain: "camera" } } },
  {
    type: "grid",
    name: "",
    schema: [
      { name: "name", selector: { text: {} } },
      { name: "show_name", selector: { boolean: {} } },
    ],
  },
  {
    type: "expandable",
    title: "Richtungen (leer = automatisch erkennen)",
    flatten: true,
    schema: [
      { name: "up", selector: { entity: { domain: PTZ_DOMAINS } } },
      { name: "down", selector: { entity: { domain: PTZ_DOMAINS } } },
      { name: "left", selector: { entity: { domain: PTZ_DOMAINS } } },
      { name: "right", selector: { entity: { domain: PTZ_DOMAINS } } },
      { name: "center", selector: { entity: { domain: PTZ_DOMAINS } } },
      { name: "stop", selector: { entity: { domain: PTZ_DOMAINS } } },
    ],
  },
  {
    type: "expandable",
    title: "Verhalten & Aussehen",
    flatten: true,
    schema: [
      { name: "repeat_interval", selector: { number: { min: 0, max: 3000, step: 50, mode: "box", unit_of_measurement: "ms" } } },
      { name: "size", selector: { number: { min: 120, max: 500, step: 10, mode: "box", unit_of_measurement: "px" } } },
      { name: "arrow_color", selector: { text: {} } },
      { name: "ring_color", selector: { text: {} } },
      { name: "center_color", selector: { text: {} } },
    ],
  },
];

const LABELS = {
  camera: "Kamera (für Auto-Erkennung)",
  name: "Name",
  show_name: "Name anzeigen",
  up: "Hoch",
  down: "Runter",
  left: "Links",
  right: "Rechts",
  center: "Mitte (z. B. Kalibrieren)",
  stop: "Stopp beim Loslassen",
  repeat_interval: "Wiederholen beim Halten (0 = aus)",
  size: "Maximale Größe",
  arrow_color: "Pfeilfarbe (z. B. #3a86de)",
  ring_color: "Ringfarbe",
  center_color: "Farbe Mittelring",
};

class PtzDpadCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = { show_name: true, ...config };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._form) this._form.hass = hass;
  }

  _render() {
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (s) => LABELS[s.name] || s.name;
      this._form.addEventListener("value-changed", (ev) => {
        const cfg = { ...ev.detail.value };
        Object.keys(cfg).forEach((k) => (cfg[k] === "" || cfg[k] === undefined) && delete cfg[k]);
        this._config = cfg;
        fireEvent(this, "config-changed", { config: cfg });
      });
      this.appendChild(this._form);
    }
    this._form.schema = SCHEMA;
    this._form.data = this._config;
    if (this._hass) this._form.hass = this._hass;
  }
}

customElements.define("ptz-dpad-card", PtzDpadCard);
customElements.define("ptz-dpad-card-editor", PtzDpadCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "ptz-dpad-card",
  name: "PTZ D-Pad Card",
  description: "Runde Kamera-Steuerung (hoch/runter/links/rechts) für Tapo, Reolink, ONVIF & Co.",
  preview: true,
  documentationURL: "https://github.com/freudanderror/ptz-dpad-card",
});

console.info(`%c PTZ-DPAD-CARD %c v${CARD_VERSION} `, "color:#fff;background:#3a86de;font-weight:700", "color:#3a86de");
