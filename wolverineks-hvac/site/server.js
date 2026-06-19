"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_http_1 = require("node:http");
const promises_1 = require("node:fs/promises");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const carrier_api_1 = require("./carrier-api");
const APP_VERSION = "2.0.1";
const DATA_ROOT = process.env.HVAC_DATA_DIR ?? "/data";
const SETTINGS_PATH = node_path_1.default.join(DATA_ROOT, "settings.json");
const ICON_PATH = node_path_1.default.join(__dirname, "icon.svg");
const POLL_INTERVAL_MS = 30_000;
const DEFAULT_SETTINGS = {
    system_name: "Home HVAC",
    username: "",
    password: "",
    system_serial: "",
};
let cachedSystems = [];
let lastSyncAt = null;
let lastError = null;
let pollTimer = null;
function escapeHtml(value) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
function isConfigured(settings) {
    return Boolean(settings.username.trim() && settings.password);
}
function publicSettings(settings) {
    return {
        system_name: settings.system_name,
        username: settings.username,
        system_serial: settings.system_serial,
        configured: isConfigured(settings),
    };
}
async function loadSettings() {
    if (!(0, node_fs_1.existsSync)(SETTINGS_PATH)) {
        return { ...DEFAULT_SETTINGS };
    }
    try {
        const raw = await (0, promises_1.readFile)(SETTINGS_PATH, "utf8");
        const parsed = JSON.parse(raw);
        return {
            system_name: parsed.system_name?.trim() || DEFAULT_SETTINGS.system_name,
            username: parsed.username?.trim() ?? "",
            password: parsed.password ?? "",
            system_serial: parsed.system_serial?.trim() ?? "",
        };
    }
    catch {
        return { ...DEFAULT_SETTINGS };
    }
}
async function saveSettings(settings) {
    await (0, promises_1.mkdir)(DATA_ROOT, { recursive: true });
    await (0, promises_1.writeFile)(SETTINGS_PATH, JSON.stringify(settings, null, 2), { mode: 0o600 });
}
function createClient(settings) {
    return new carrier_api_1.CarrierApiClient(settings.username, settings.password);
}
function selectSystem(settings, systems) {
    if (!systems.length)
        return null;
    if (settings.system_serial) {
        const selected = systems.find((system) => system.profile.serial === settings.system_serial);
        if (selected)
            return selected;
    }
    return systems[0] ?? null;
}
function isZoneEnabled(configZone, statusZone) {
    const enabled = statusZone?.enabled ?? configZone.enabled;
    return enabled === "on";
}
function mapZones(system) {
    return system.config.zones.filter((configZone) => {
        const statusZone = system.status.zones.find((zone) => zone.id === configZone.id);
        return isZoneEnabled(configZone, statusZone);
    }).map((configZone) => {
        const statusZone = system.status.zones.find((zone) => zone.id === configZone.id);
        const presets = configZone.activities.map((activity) => activity.type);
        if (!presets.includes("resume"))
            presets.push("resume");
        return {
            id: configZone.id,
            name: configZone.name,
            temperature: statusZone?.rt ?? null,
            humidity: statusZone?.rh ?? null,
            heat_setpoint: statusZone?.htsp ?? null,
            cool_setpoint: statusZone?.clsp ?? null,
            fan: statusZone?.fan === "off" ? "auto" : (statusZone?.fan ?? null),
            activity: statusZone?.currentActivity ?? null,
            conditioning: statusZone?.zoneconditioning ?? "idle",
            hold: configZone.hold === "on",
            hold_activity: configZone.holdActivity,
            hold_until: configZone.otmr,
            presets,
        };
    });
}
function buildSnapshot(settings) {
    const system = selectSystem(settings, cachedSystems);
    return {
        connected: Boolean(system && !system.status.isDisconnected),
        configured: isConfigured(settings),
        error: lastError,
        last_sync: lastSyncAt?.toISOString() ?? null,
        identity_id: null,
        system: system
            ? {
                serial: system.profile.serial,
                name: settings.system_name || system.profile.name,
                brand: system.profile.brand,
                model: system.profile.model,
                firmware: system.profile.firmware,
                mode: (system.status.mode ?? system.config.mode ?? "auto").toLowerCase(),
                outdoor_temp: system.status.oat,
                filter_remaining: system.status.filtrlvl,
                disconnected: Boolean(system.status.isDisconnected),
            }
            : null,
        zones: system ? mapZones(system) : [],
        systems: cachedSystems.map((item) => ({
            serial: item.profile.serial,
            name: item.profile.name,
        })),
    };
}
async function refreshCloudData(settings, force = false) {
    if (!isConfigured(settings)) {
        cachedSystems = [];
        lastError = null;
        lastSyncAt = null;
        return buildSnapshot(settings);
    }
    if (!force && lastSyncAt && Date.now() - lastSyncAt.getTime() < POLL_INTERVAL_MS - 2000) {
        return buildSnapshot(settings);
    }
    try {
        const client = createClient(settings);
        cachedSystems = await client.loadSystems();
        lastSyncAt = new Date();
        lastError = null;
        const selected = selectSystem(settings, cachedSystems);
        if (selected && !settings.system_serial) {
            settings.system_serial = selected.profile.serial;
            await saveSettings(settings);
        }
    }
    catch (error) {
        if (error instanceof carrier_api_1.CarrierAuthError) {
            lastError = error.message;
            cachedSystems = [];
        }
        else if (error instanceof carrier_api_1.CarrierApiError) {
            lastError = error.message;
        }
        else {
            lastError = error instanceof Error ? error.message : String(error);
        }
    }
    return buildSnapshot(settings);
}
function ensurePolling(settings) {
    if (!isConfigured(settings)) {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
        return;
    }
    if (pollTimer)
        return;
    pollTimer = setInterval(() => {
        void refreshCloudData(settings, true);
    }, POLL_INTERVAL_MS);
}
function sendJson(res, statusCode, payload) {
    const body = Buffer.from(JSON.stringify(payload));
    res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": body.length,
    });
    res.end(body);
}
function sendText(res, statusCode, contentType, body) {
    const encoded = Buffer.from(body);
    res.writeHead(statusCode, {
        "Content-Type": contentType,
        "Content-Length": encoded.length,
    });
    res.end(encoded);
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}
function pageStyles() {
    return `
    :root {
      color-scheme: light;
      --bg: #f8fafc;
      --panel: #ffffff;
      --text: #0f172a;
      --muted: #64748b;
      --border: #e2e8f0;
      --accent: #0f766e;
      --accent-soft: #ccfbf1;
      --success: #16a34a;
      --danger: #dc2626;
      --shadow: 0 10px 30px rgba(15, 23, 42, 0.08);
    }
    html[data-theme="dark"] {
      color-scheme: dark;
      --bg: #0b1220;
      --panel: #111827;
      --text: #e5e7eb;
      --muted: #94a3b8;
      --border: #1f2937;
      --accent: #2dd4bf;
      --accent-soft: #134e4a;
      --shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    .layout {
      display: grid;
      grid-template-columns: 240px 1fr;
      min-height: 100vh;
    }
    .sidebar {
      background: var(--panel);
      border-right: 1px solid var(--border);
      padding: 1.5rem 1rem;
      position: sticky;
      top: 0;
      height: 100vh;
    }
    .brand {
      display: flex;
      gap: 0.75rem;
      align-items: center;
      margin-bottom: 1.5rem;
      padding: 0 0.5rem;
    }
    .brand img { width: 40px; height: 40px; border-radius: 10px; }
    .brand h1 { font-size: 1rem; margin: 0; }
    .brand p { margin: 0.15rem 0 0; color: var(--muted); font-size: 0.8rem; }
    .nav-link {
      display: block;
      padding: 0.7rem 0.85rem;
      border-radius: 0.75rem;
      color: var(--text);
      text-decoration: none;
      margin-bottom: 0.25rem;
    }
    .nav-link:hover, .nav-link.active {
      background: var(--accent-soft);
      color: var(--accent);
    }
    .main { padding: 1.5rem; }
    .toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
      margin-bottom: 1.25rem;
      flex-wrap: wrap;
    }
    .toolbar h2 { margin: 0; font-size: 1.5rem; }
    .grid {
      display: grid;
      gap: 1rem;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 1rem;
      padding: 1.25rem;
      box-shadow: var(--shadow);
    }
    .card h3 { margin: 0 0 0.5rem; font-size: 1rem; }
    .muted { color: var(--muted); }
    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.35rem 0.7rem;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent);
      font-size: 0.85rem;
      font-weight: 600;
    }
    .status-pill.success { background: #ecfdf5; color: #047857; }
    .status-pill.warning { background: #fffbeb; color: #b45309; }
    .status-pill.error { background: #fef2f2; color: #b91c1c; }
    html[data-theme="dark"] .status-pill.success { background: #052e16; color: #86efac; }
    html[data-theme="dark"] .status-pill.warning { background: #451a03; color: #fcd34d; }
    html[data-theme="dark"] .status-pill.error { background: #450a0a; color: #fca5a5; }
    .temp-display {
      font-size: 2.5rem;
      font-weight: 700;
      line-height: 1;
      margin: 0.5rem 0;
    }
    .stat-row {
      display: flex;
      justify-content: space-between;
      gap: 0.75rem;
      margin-top: 0.5rem;
      font-size: 0.9rem;
    }
    label {
      display: grid;
      gap: 0.35rem;
      font-size: 0.9rem;
      margin-bottom: 0.85rem;
    }
    input, select, button {
      font: inherit;
      border: 1px solid var(--border);
      border-radius: 0.65rem;
      padding: 0.65rem 0.75rem;
      background: var(--panel);
      color: var(--text);
    }
    button {
      cursor: pointer;
      background: var(--accent);
      color: white;
      border-color: var(--accent);
      font-weight: 600;
    }
    button.secondary {
      background: transparent;
      color: var(--text);
      border-color: var(--border);
    }
    .steps { display: grid; gap: 0.75rem; margin: 1rem 0; }
    .step {
      border: 1px solid var(--border);
      border-radius: 0.85rem;
      padding: 1rem;
      background: var(--panel);
    }
    .step strong { display: block; margin-bottom: 0.35rem; }
    .controls { display: grid; gap: 0.75rem; margin-top: 1rem; }
    .control-row {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
      align-items: end;
    }
    .control-row label { flex: 1 1 8rem; margin-bottom: 0; }
    .message { margin-top: 0.75rem; font-size: 0.9rem; }
    .message.error { color: var(--danger); }
    .message.success { color: var(--success); }
    @media (max-width: 900px) {
      .layout { grid-template-columns: 1fr; }
      .sidebar { position: static; height: auto; }
    }
  `;
}
function renderPage(active, content) {
    const nav = [
        { id: "dashboard", label: "Dashboard", href: "/" },
        { id: "setup", label: "Setup", href: "/setup" },
        { id: "settings", label: "Settings", href: "/settings" },
    ];
    const navHtml = nav
        .map((item) => `<a class="nav-link${item.id === active ? " active" : ""}" href="${item.href}">${escapeHtml(item.label)}</a>`)
        .join("");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Bryant/Carrier HVAC</title>
  <style>${pageStyles()}</style>
</head>
<body>
  <div class="layout">
    <aside class="sidebar">
      <div class="brand">
        <img src="/icon.svg" alt="" />
        <div>
          <h1>Bryant/Carrier HVAC</h1>
          <p>Cloud thermostat control</p>
        </div>
      </div>
      <nav>${navHtml}</nav>
    </aside>
    <main class="main">${content}</main>
  </div>
</body>
</html>`;
}
function setupContent(settings) {
    return `
    <div class="toolbar">
      <h2>Setup</h2>
      <span class="status-pill warning" id="connection-pill">Checking…</span>
    </div>
    <div class="card">
      <h3>Sign in with your Bryant/Carrier account</h3>
      <p class="muted">
        Use the same email and password as the Bryant or Carrier mobile app.
        Your Umbrel needs internet access to reach Carrier's cloud API.
      </p>
      <form id="setup-form">
        <label>
          Email / username
          <input id="username" name="username" value="${escapeHtml(settings.username)}" autocomplete="username" required />
        </label>
        <label>
          Password
          <input id="password" name="password" type="password" autocomplete="current-password" ${settings.configured ? "" : "required"} placeholder="${settings.configured ? "Leave blank to keep saved password" : ""}" />
        </label>
        <button type="submit">Save &amp; connect</button>
        <div class="message" id="setup-message"></div>
      </form>
    </div>
    <div class="card" style="margin-top:1rem">
      <h3>How it works</h3>
      <div class="steps">
        <div class="step"><strong>No thermostat IP needed.</strong> This app talks to Carrier's cloud, the same way the official mobile app does.</div>
        <div class="step"><strong>Works with newer Connex firmware.</strong> Local proxy setups often fail on Series B Connex software (firmware 4.17+).</div>
        <div class="step"><strong>Internet required.</strong> Umbrel must reach Carrier's servers. Your thermostat still uses WiFi as usual.</div>
      </div>
    </div>
    <div class="card" style="margin-top:1rem">
      <h3>Diagnostics</h3>
      <div class="stat-row"><span class="muted">Cloud connection</span><span id="diag-cloud">Checking…</span></div>
      <div class="stat-row"><span class="muted">Systems found</span><span id="diag-systems">—</span></div>
      <div class="stat-row"><span class="muted">Last sync</span><span id="diag-sync">—</span></div>
      <p class="muted message" id="diag-error" style="margin-top:0.75rem"></p>
    </div>
    <script>
      async function refreshConnection() {
        const pill = document.getElementById("connection-pill");
        const diagCloud = document.getElementById("diag-cloud");
        const diagSystems = document.getElementById("diag-systems");
        const diagSync = document.getElementById("diag-sync");
        const diagError = document.getElementById("diag-error");
        try {
          const res = await fetch("/api/status");
          const data = await res.json();
          diagSystems.textContent = String(data.systems?.length ?? 0);
          diagSync.textContent = data.last_sync ? new Date(data.last_sync).toLocaleString() : "Never";
          if (data.connected) {
            pill.className = "status-pill success";
            const zoneCount = data.zones?.length ?? 0;
            pill.textContent = zoneCount === 1 ? "Connected" : "Connected (" + zoneCount + " zones)";
            diagCloud.textContent = "Online";
            diagError.textContent = "";
          } else if (data.configured) {
            pill.className = "status-pill warning";
            pill.textContent = data.error ? "Connection issue" : "Waiting for data";
            diagCloud.textContent = data.error ? "Error" : "Syncing";
            diagError.textContent = data.error || "Credentials saved. Waiting for thermostat data from Carrier cloud.";
          } else {
            pill.className = "status-pill warning";
            pill.textContent = "Not configured";
            diagCloud.textContent = "Not signed in";
            diagError.textContent = "Enter your Bryant/Carrier account credentials above.";
          }
        } catch (error) {
          pill.className = "status-pill error";
          pill.textContent = "Cannot reach app";
          diagError.textContent = String(error);
        }
      }
      document.getElementById("setup-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const message = document.getElementById("setup-message");
        const form = event.target;
        const res = await fetch("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: form.username.value.trim(),
            password: form.password.value,
          }),
        });
        const data = await res.json();
        message.className = "message " + (res.ok ? "success" : "error");
        message.textContent = res.ok ? "Connected. Redirecting…" : (data.error || "Could not save credentials.");
        if (res.ok) window.location.href = "/";
      });
      refreshConnection();
      setInterval(refreshConnection, 5000);
    </script>
  `;
}
function dashboardContent() {
    return `
    <div class="toolbar">
      <h2>Dashboard</h2>
      <span class="status-pill warning" id="connection-pill">Loading…</span>
    </div>
    <div class="grid" id="system-cards">
      <div class="card"><p class="muted">Loading system status…</p></div>
    </div>
    <div id="zone-cards" class="grid" style="margin-top:1rem"></div>
    <script>
      function escapeHtml(value) {
        return String(value)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;");
      }

      function modeLabel(mode) {
        if (!mode) return "Unknown";
        if (mode === "fanonly") return "Fan only";
        if (mode === "auto") return "Auto";
        return mode.charAt(0).toUpperCase() + mode.slice(1);
      }

      function renderZoneCard(zone) {
        const temp = zone.temperature ?? "—";
        const humidity = zone.humidity ?? "—";
        const heat = zone.heat_setpoint ?? "—";
        const cool = zone.cool_setpoint ?? "—";
        const presetOptions = (zone.presets || []).map((preset) =>
          '<option value="' + escapeHtml(preset) + '">' + escapeHtml(preset === "resume" ? "Resume schedule" : preset) + '</option>'
        ).join("");
        return \`
          <div class="card" data-zone-id="\${escapeHtml(zone.id)}">
            <h3>\${escapeHtml(zone.name)}</h3>
            <div class="temp-display">\${temp}°</div>
            <div class="stat-row"><span class="muted">Humidity</span><span>\${humidity}%</span></div>
            <div class="stat-row"><span class="muted">Heat / Cool</span><span>\${heat}° / \${cool}°</span></div>
            <div class="stat-row"><span class="muted">Activity</span><span>\${escapeHtml(zone.activity || "—")}</span></div>
            <div class="stat-row"><span class="muted">Conditioning</span><span>\${escapeHtml(zone.conditioning || "idle")}</span></div>
            <div class="controls">
              <div class="control-row">
                <label>Heat setpoint
                  <input type="number" step="1" min="50" max="90" data-field="heat_setpoint" value="\${heat === "—" ? "" : heat}" />
                </label>
                <label>Cool setpoint
                  <input type="number" step="1" min="50" max="90" data-field="cool_setpoint" value="\${cool === "—" ? "" : cool}" />
                </label>
              </div>
              <div class="control-row">
                <label>Fan
                  <select data-field="fan">
                    <option value="auto" \${zone.fan === "auto" ? "selected" : ""}>Auto</option>
                    <option value="on" \${zone.fan === "on" ? "selected" : ""}>On</option>
                    <option value="low" \${zone.fan === "low" ? "selected" : ""}>Low</option>
                    <option value="med" \${zone.fan === "med" ? "selected" : ""}>Medium</option>
                    <option value="high" \${zone.fan === "high" ? "selected" : ""}>High</option>
                  </select>
                </label>
                <label>Preset
                  <select data-field="preset">\${presetOptions}</select>
                </label>
              </div>
              <div class="control-row">
                <button type="button" data-action="apply-zone">Apply zone changes</button>
              </div>
              <div class="message zone-message"></div>
            </div>
          </div>
        \`;
      }

      async function applyZoneChanges(card) {
        const zoneId = card.dataset.zoneId;
        const message = card.querySelector(".zone-message");
        const res = await fetch("/api/zone/" + encodeURIComponent(zoneId), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            heat_setpoint: card.querySelector('[data-field="heat_setpoint"]').value,
            cool_setpoint: card.querySelector('[data-field="cool_setpoint"]').value,
            fan: card.querySelector('[data-field="fan"]').value,
            preset: card.querySelector('[data-field="preset"]').value,
          }),
        });
        const data = await res.json();
        message.className = "message " + (res.ok ? "success" : "error");
        message.textContent = res.ok ? "Updated." : (data.error || "Update failed.");
        if (res.ok) loadDashboard();
      }

      async function loadDashboard() {
        const pill = document.getElementById("connection-pill");
        const systemCards = document.getElementById("system-cards");
        const zoneCards = document.getElementById("zone-cards");
        try {
          const res = await fetch("/api/status");
          const data = await res.json();
          if (!data.configured) {
            pill.className = "status-pill warning";
            pill.textContent = "Setup required";
            systemCards.innerHTML = '<div class="card"><h3>Sign in required</h3><p class="muted">Connect your Bryant/Carrier account on the <a href="/setup">Setup page</a>.</p></div>';
            zoneCards.innerHTML = "";
            return;
          }
          if (!data.connected) {
            pill.className = "status-pill warning";
            pill.textContent = data.error ? "Connection issue" : "Syncing";
            systemCards.innerHTML = '<div class="card"><h3>Not connected yet</h3><p class="muted">' + escapeHtml(data.error || "Waiting for data from Carrier cloud. Check your internet connection.") + '</p></div>';
            zoneCards.innerHTML = "";
            return;
          }
          pill.className = "status-pill success";
          pill.textContent = "Connected";
          const mode = data.system.mode || "auto";
          const outdoor = data.system.outdoor_temp ?? "—";
          const filter = data.system.filter_remaining ?? "—";
          systemCards.innerHTML = \`
            <div class="card">
              <h3>System mode</h3>
              <div class="temp-display" style="font-size:1.5rem">\${escapeHtml(modeLabel(mode))}</div>
              <div class="control-row" style="margin-top:1rem">
                <button type="button" data-mode="heat">Heat</button>
                <button type="button" data-mode="cool">Cool</button>
                <button type="button" data-mode="auto">Auto</button>
                <button type="button" class="secondary" data-mode="off">Off</button>
              </div>
              <div class="message" id="mode-message"></div>
            </div>
            <div class="card">
              <h3>Outdoor</h3>
              <div class="temp-display">\${outdoor}°</div>
              <div class="stat-row"><span class="muted">Filter remaining</span><span>\${filter}%</span></div>
              <div class="stat-row"><span class="muted">Firmware</span><span>\${escapeHtml(data.system.firmware || "—")}</span></div>
            </div>
          \`;
          systemCards.querySelectorAll("[data-mode]").forEach((button) => {
            button.addEventListener("click", async () => {
              const message = document.getElementById("mode-message");
              const modeRes = await fetch("/api/mode", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ mode: button.dataset.mode }),
              });
              const modeData = await modeRes.json();
              message.className = "message " + (modeRes.ok ? "success" : "error");
              message.textContent = modeRes.ok ? "Mode updated." : (modeData.error || "Mode update failed.");
              if (modeRes.ok) loadDashboard();
            });
          });
          zoneCards.innerHTML = data.zones.map(renderZoneCard).join("");
          zoneCards.querySelectorAll("[data-action='apply-zone']").forEach((button) => {
            button.addEventListener("click", () => applyZoneChanges(button.closest(".card")));
          });
        } catch (error) {
          pill.className = "status-pill error";
          pill.textContent = "Error";
          systemCards.innerHTML = '<div class="card"><p class="muted">' + escapeHtml(error) + '</p></div>';
          zoneCards.innerHTML = "";
        }
      }
      loadDashboard();
      setInterval(loadDashboard, 30000);
    </script>
  `;
}
function settingsContent(settings) {
    return `
    <div class="toolbar"><h2>Settings</h2></div>
    <div class="card">
      <form id="settings-form">
        <label>
          System name
          <input id="system_name" name="system_name" value="${escapeHtml(settings.system_name)}" />
        </label>
        <label>
          Bryant/Carrier username
          <input id="username" name="username" value="${escapeHtml(settings.username)}" autocomplete="username" />
        </label>
        <label>
          Password
          <input id="password" name="password" type="password" autocomplete="current-password" placeholder="Leave blank to keep saved password" />
        </label>
        <button type="submit">Save settings</button>
        <button type="button" class="secondary" id="clear-credentials" style="margin-left:0.5rem">Sign out</button>
        <div class="message" id="settings-message"></div>
      </form>
    </div>
    <script>
      document.getElementById("settings-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const message = document.getElementById("settings-message");
        const form = event.target;
        const res = await fetch("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            system_name: form.system_name.value.trim(),
            username: form.username.value.trim(),
            password: form.password.value,
          }),
        });
        const data = await res.json();
        message.className = "message " + (res.ok ? "success" : "error");
        message.textContent = res.ok ? "Saved." : (data.error || "Could not save settings.");
        if (res.ok) setTimeout(() => location.reload(), 500);
      });
      document.getElementById("clear-credentials").addEventListener("click", async () => {
        const message = document.getElementById("settings-message");
        const res = await fetch("/api/settings", {
          method: "DELETE",
        });
        const data = await res.json();
        message.className = "message " + (res.ok ? "success" : "error");
        message.textContent = res.ok ? "Signed out." : (data.error || "Could not clear credentials.");
        if (res.ok) window.location.href = "/setup";
      });
    </script>
  `;
}
function findConfigZone(system, zoneId) {
    return system.config.zones.find((zone) => zone.id === zoneId);
}
function findManualActivity(system, zoneId) {
    const zone = findConfigZone(system, zoneId);
    return zone?.activities.find((activity) => activity.type === "manual");
}
async function handleApi(route, req, res, settings) {
    if (route === "/api/status" && req.method === "GET") {
        const snapshot = await refreshCloudData(settings);
        sendJson(res, 200, {
            ...snapshot,
            settings: publicSettings(settings),
        });
        return;
    }
    if (route === "/api/settings" && req.method === "GET") {
        sendJson(res, 200, { settings: publicSettings(settings) });
        return;
    }
    if (route === "/api/settings" && req.method === "DELETE") {
        const cleared = { ...DEFAULT_SETTINGS, system_name: settings.system_name };
        await saveSettings(cleared);
        cachedSystems = [];
        lastSyncAt = null;
        lastError = null;
        sendJson(res, 200, { settings: publicSettings(cleared) });
        return;
    }
    if (route === "/api/settings" && req.method === "PUT") {
        const body = JSON.parse((await readBody(req)).toString("utf8"));
        const username = body.username?.trim() ?? settings.username;
        const password = body.password?.trim() ? body.password : settings.password;
        if (!username || !password) {
            sendJson(res, 400, { error: "Username and password are required" });
            return;
        }
        const next = {
            system_name: body.system_name?.trim() || settings.system_name || DEFAULT_SETTINGS.system_name,
            username,
            password,
            system_serial: body.system_serial?.trim() ?? settings.system_serial,
        };
        try {
            const client = createClient(next);
            const validation = await client.validate();
            if (!validation.systemCount) {
                sendJson(res, 400, { error: "No HVAC systems found on this Carrier account" });
                return;
            }
            await saveSettings(next);
            cachedSystems = [];
            lastSyncAt = null;
            await refreshCloudData(next, true);
            ensurePolling(next);
            sendJson(res, 200, { settings: publicSettings(next) });
        }
        catch (error) {
            const message = error instanceof carrier_api_1.CarrierAuthError
                ? error.message
                : error instanceof carrier_api_1.CarrierApiError
                    ? error.message
                    : error instanceof Error
                        ? error.message
                        : "Could not validate credentials";
            sendJson(res, 400, { error: message });
        }
        return;
    }
    if (route === "/api/mode" && req.method === "POST") {
        if (!isConfigured(settings)) {
            sendJson(res, 400, { error: "Account not configured" });
            return;
        }
        const body = JSON.parse((await readBody(req)).toString("utf8"));
        const mode = body.mode?.trim().toLowerCase();
        const allowed = ["heat", "cool", "auto", "off", "fanonly"];
        if (!mode || !allowed.includes(mode)) {
            sendJson(res, 400, { error: "mode must be heat, cool, auto, off, or fanonly" });
            return;
        }
        const system = selectSystem(settings, cachedSystems);
        if (!system) {
            sendJson(res, 502, { error: "No system loaded" });
            return;
        }
        try {
            const client = createClient(settings);
            await client.setMode(system.profile.serial, mode);
            await refreshCloudData(settings, true);
            sendJson(res, 200, { ok: true });
        }
        catch (error) {
            sendJson(res, 502, {
                error: error instanceof Error ? error.message : "Mode update failed",
            });
        }
        return;
    }
    const zoneMatch = route.match(/^\/api\/zone\/([^/]+)$/);
    if (zoneMatch && req.method === "POST") {
        if (!isConfigured(settings)) {
            sendJson(res, 400, { error: "Account not configured" });
            return;
        }
        const zoneId = decodeURIComponent(zoneMatch[1]);
        const body = JSON.parse((await readBody(req)).toString("utf8"));
        const system = selectSystem(settings, cachedSystems);
        if (!system) {
            sendJson(res, 502, { error: "No system loaded" });
            return;
        }
        const client = createClient(settings);
        const serial = system.profile.serial;
        try {
            if (body.preset) {
                const preset = body.preset.toLowerCase();
                if (preset === "resume" || preset === "schedule") {
                    await client.resumeSchedule(serial, zoneId);
                }
                else if (["home", "away", "sleep", "wake", "manual", "vacation"].includes(preset)) {
                    await client.setHold(serial, zoneId, preset, null);
                }
            }
            const heat = body.heat_setpoint !== undefined && body.heat_setpoint !== "" ? String(body.heat_setpoint) : null;
            const cool = body.cool_setpoint !== undefined && body.cool_setpoint !== "" ? String(body.cool_setpoint) : null;
            const fan = body.fan?.trim().toLowerCase();
            if (heat || cool || (fan && fan !== "auto")) {
                const manual = findManualActivity(system, zoneId);
                const heatSetpoint = heat ?? String(manual?.htsp ?? system.status.zones.find((z) => z.id === zoneId)?.htsp ?? 68);
                const coolSetpoint = cool ?? String(manual?.clsp ?? system.status.zones.find((z) => z.id === zoneId)?.clsp ?? 74);
                let fanMode;
                if (fan === "auto" || fan === "on") {
                    fanMode = "off";
                }
                else if (fan && ["low", "med", "high", "off"].includes(fan)) {
                    fanMode = fan;
                }
                else if (manual?.fan) {
                    fanMode = manual.fan;
                }
                await client.setManualActivity(serial, zoneId, heatSetpoint, coolSetpoint, fanMode);
                await client.setHold(serial, zoneId, "manual", null);
            }
            else if (fan === "auto" || fan === "low" || fan === "med" || fan === "high") {
                const configZone = findConfigZone(system, zoneId);
                const activityType = (configZone?.holdActivity || system.status.zones.find((z) => z.id === zoneId)?.currentActivity || "home");
                const fanMode = fan === "auto" ? "off" : fan;
                await client.updateFan(serial, zoneId, activityType, fanMode);
            }
            await refreshCloudData(settings, true);
            sendJson(res, 200, { ok: true });
        }
        catch (error) {
            sendJson(res, 502, {
                error: error instanceof Error ? error.message : "Zone update failed",
            });
        }
        return;
    }
    sendJson(res, 404, { error: "Not found" });
}
async function handleRequest(req, res) {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const route = url.pathname;
    const settings = await loadSettings();
    ensurePolling(settings);
    if (route === "/health" || route === "/healthz") {
        sendText(res, 200, "text/plain; charset=utf-8", "ok");
        return;
    }
    if (route === "/icon.svg") {
        try {
            const icon = await (0, promises_1.readFile)(ICON_PATH);
            res.writeHead(200, { "Content-Type": "image/svg+xml", "Content-Length": icon.length });
            res.end(icon);
            return;
        }
        catch {
            sendText(res, 404, "text/plain; charset=utf-8", "not found");
            return;
        }
    }
    if (route.startsWith("/api/")) {
        try {
            await handleApi(route, req, res, settings);
        }
        catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
    }
    const publicView = publicSettings(settings);
    if (route === "/setup") {
        sendText(res, 200, "text/html; charset=utf-8", renderPage("setup", setupContent(publicView)));
        return;
    }
    if (route === "/settings") {
        sendText(res, 200, "text/html; charset=utf-8", renderPage("settings", settingsContent(publicView)));
        return;
    }
    sendText(res, 200, "text/html; charset=utf-8", renderPage("dashboard", dashboardContent()));
}
const port = Number(process.env.PORT ?? 3000);
(0, node_http_1.createServer)((req, res) => {
    handleRequest(req, res).catch((error) => {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
}).listen(port, "0.0.0.0", () => {
    console.log(`Bryant/Carrier HVAC v${APP_VERSION} listening on :${port}`);
    void loadSettings().then((settings) => {
        ensurePolling(settings);
        if (isConfigured(settings)) {
            void refreshCloudData(settings, true);
        }
    });
});
