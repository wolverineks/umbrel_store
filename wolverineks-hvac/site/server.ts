import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  applyInfinityStatusMessage,
  CarrierApiClient,
  CarrierApiError,
  CarrierAuthError,
  CarrierRealtime,
  formatFahrenheit,
  toFahrenheit,
  zoneIdsMatch,
  type ActivityType,
  type CarrierSystem,
  type FanMode,
  type SystemMode,
} from "./carrier-api";

const APP_VERSION = "2.1.0";
const DATA_ROOT = process.env.HVAC_DATA_DIR ?? "/data";
const SETTINGS_PATH = path.join(DATA_ROOT, "settings.json");
const ICON_PATH = path.join(__dirname, "icon.svg");
const POLL_INTERVAL_MS = 30_000;
const STATUS_CACHE_MS = 15_000;

type Settings = {
  system_name: string;
  username: string;
  password: string;
  system_serial: string;
};

type PublicSettings = {
  system_name: string;
  username: string;
  system_serial: string;
  configured: boolean;
};

type ZoneView = {
  id: string;
  name: string;
  temperature: number | null;
  temperature_display: string | null;
  heat_setpoint_display: string | null;
  cool_setpoint_display: string | null;
  humidity: number | null;
  heat_setpoint: number | null;
  cool_setpoint: number | null;
  sensor_rt: number | null;
  fan: string | null;
  activity: string | null;
  conditioning: string | null;
  hold: boolean;
  hold_activity: string | null;
  hold_until: string | null;
  presets: string[];
};

type StatusSnapshot = {
  connected: boolean;
  configured: boolean;
  error: string | null;
  last_sync: string | null;
  identity_id: string | null;
  system: {
    serial: string;
    name: string;
    brand: string | null;
    model: string | null;
    firmware: string | null;
    mode: string;
    outdoor_temp: number | null;
    filter_remaining: number | null;
    disconnected: boolean;
    temperature_unit: "F" | "C";
    outdoor_temp_display: string | null;
  } | null;
  zones: ZoneView[];
  systems: Array<{ serial: string; name: string }>;
  last_live_update: string | null;
};

const DEFAULT_SETTINGS: Settings = {
  system_name: "Home HVAC",
  username: "",
  password: "",
  system_serial: "",
};

let cachedSystems: CarrierSystem[] = [];
let lastSyncAt: Date | null = null;
let lastLiveUpdateAt: Date | null = null;
let lastError: string | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let apiClient: CarrierApiClient | null = null;
let apiClientKey = "";
let realtime: CarrierRealtime | null = null;
let realtimeKey = "";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isConfigured(settings: Settings): boolean {
  return Boolean(settings.username.trim() && settings.password);
}

function publicSettings(settings: Settings): PublicSettings {
  return {
    system_name: settings.system_name,
    username: settings.username,
    system_serial: settings.system_serial,
    configured: isConfigured(settings),
  };
}

async function loadSettings(): Promise<Settings> {
  if (!existsSync(SETTINGS_PATH)) {
    return { ...DEFAULT_SETTINGS };
  }
  try {
    const raw = await readFile(SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      system_name: parsed.system_name?.trim() || DEFAULT_SETTINGS.system_name,
      username: parsed.username?.trim() ?? "",
      password: parsed.password ?? "",
      system_serial: parsed.system_serial?.trim() ?? "",
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function saveSettings(settings: Settings): Promise<void> {
  await mkdir(DATA_ROOT, { recursive: true });
  await writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2), { mode: 0o600 });
}

function getClient(settings: Settings): CarrierApiClient {
  const key = `${settings.username}\u0000${settings.password}`;
  if (!apiClient || apiClientKey !== key) {
    apiClient = new CarrierApiClient(settings.username, settings.password);
    apiClientKey = key;
  }
  return apiClient;
}

function resetCloudConnections(): void {
  realtime?.stop();
  realtime = null;
  realtimeKey = "";
  apiClient = null;
  apiClientKey = "";
}

function findStatusZone(system: CarrierSystem, zoneId: string): CarrierSystem["status"]["zones"][number] | undefined {
  return system.status.zones.find((zone) => zoneIdsMatch(zone.id, zoneId));
}

function findConfigZone(system: CarrierSystem, zoneId: string): CarrierSystem["config"]["zones"][number] | undefined {
  return system.config.zones.find((zone) => zoneIdsMatch(zone.id, zoneId));
}

function ensureRealtime(settings: Settings): void {
  if (!isConfigured(settings)) {
    resetCloudConnections();
    return;
  }
  const key = `${settings.username}\u0000${settings.password}`;
  if (realtime && realtimeKey === key) return;

  realtime?.stop();
  realtimeKey = key;
  const client = getClient(settings);
  realtime = new CarrierRealtime(
    () => client.getAccessToken(),
    (message) => {
      if (applyInfinityStatusMessage(cachedSystems, message)) {
        lastLiveUpdateAt = new Date();
      }
    },
  );
  realtime.start();
}

function selectSystem(settings: Settings, systems: CarrierSystem[]): CarrierSystem | null {
  if (!systems.length) return null;
  if (settings.system_serial) {
    const selected = systems.find((system) => system.profile.serial === settings.system_serial);
    if (selected) return selected;
  }
  return systems[0] ?? null;
}

function isZoneEnabled(configZone: CarrierSystem["config"]["zones"][number], statusZone?: CarrierSystem["status"]["zones"][number]): boolean {
  const enabled = statusZone?.enabled ?? configZone.enabled;
  return enabled === "on";
}

function mapZones(system: CarrierSystem): ZoneView[] {
  const cfgem = system.status.cfgem;
  const enabledStatusZones = system.status.zones.filter((zone) => zone.enabled === "on");
  const zonesToMap = enabledStatusZones.length
    ? enabledStatusZones.map((statusZone) => ({
        statusZone,
        configZone: findConfigZone(system, statusZone.id),
      }))
    : system.config.zones
        .filter((configZone) => isZoneEnabled(configZone, findStatusZone(system, configZone.id)))
        .map((configZone) => ({
          statusZone: findStatusZone(system, configZone.id),
          configZone,
        }));

  const zones: ZoneView[] = [];
  for (const { statusZone, configZone } of zonesToMap) {
    if (!statusZone && !configZone) continue;
    const zoneId = configZone?.id ?? statusZone?.id ?? "";
    const presets = (configZone?.activities ?? []).map((activity) => activity.type);
    if (!presets.includes("resume")) presets.push("resume");
    const indoorTemp = statusZone?.rt ?? null;
    zones.push({
      id: zoneId,
      name: configZone?.name ?? `Zone ${zoneId}`,
      temperature: toFahrenheit(indoorTemp, cfgem),
      temperature_display: formatFahrenheit(indoorTemp, cfgem),
      heat_setpoint_display: formatFahrenheit(statusZone?.htsp ?? null, cfgem),
      cool_setpoint_display: formatFahrenheit(statusZone?.clsp ?? null, cfgem),
      humidity: statusZone?.rh ?? null,
      heat_setpoint: toFahrenheit(statusZone?.htsp ?? null, cfgem),
      cool_setpoint: toFahrenheit(statusZone?.clsp ?? null, cfgem),
      sensor_rt: indoorTemp,
      fan: statusZone?.fan === "off" ? "auto" : (statusZone?.fan ?? null),
      activity: statusZone?.currentActivity ?? null,
      conditioning: statusZone?.zoneconditioning ?? "idle",
      hold: configZone?.hold === "on",
      hold_activity: configZone?.holdActivity ?? null,
      hold_until: configZone?.otmr ?? null,
      presets,
    });
  }
  return zones;
}

function buildSnapshot(settings: Settings): StatusSnapshot {
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
          outdoor_temp: toFahrenheit(system.status.oat, system.status.cfgem),
          filter_remaining: system.status.filtrlvl,
          disconnected: Boolean(system.status.isDisconnected),
          temperature_unit: "F",
          outdoor_temp_display: formatFahrenheit(system.status.oat, system.status.cfgem),
        }
      : null,
    zones: system ? mapZones(system) : [],
    systems: cachedSystems.map((item) => ({
      serial: item.profile.serial,
      name: item.profile.name,
    })),
    last_live_update: lastLiveUpdateAt?.toISOString() ?? null,
  };
}

async function refreshCloudData(settings: Settings, force = false): Promise<StatusSnapshot> {
  if (!isConfigured(settings)) {
    cachedSystems = [];
    lastError = null;
    lastSyncAt = null;
    return buildSnapshot(settings);
  }

  if (!force && lastSyncAt && Date.now() - lastSyncAt.getTime() < STATUS_CACHE_MS) {
    return buildSnapshot(settings);
  }

  try {
    const client = getClient(settings);
    cachedSystems = await client.loadSystems();
    lastSyncAt = new Date();
    lastError = null;
    ensureRealtime(settings);

    const selected = selectSystem(settings, cachedSystems);
    if (selected && !settings.system_serial) {
      settings.system_serial = selected.profile.serial;
      await saveSettings(settings);
    }
  } catch (error) {
    if (error instanceof CarrierAuthError) {
      lastError = error.message;
      cachedSystems = [];
    } else if (error instanceof CarrierApiError) {
      lastError = error.message;
    } else {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return buildSnapshot(settings);
}

function ensurePolling(settings: Settings): void {
  if (!isConfigured(settings)) {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    resetCloudConnections();
    return;
  }
  ensureRealtime(settings);
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    void refreshCloudData(settings, true);
  }, POLL_INTERVAL_MS);
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
  });
  res.end(body);
}

function sendText(res: ServerResponse, statusCode: number, contentType: string, body: string): void {
  const encoded = Buffer.from(body);
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": encoded.length,
  });
  res.end(encoded);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function pageStyles(): string {
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
      display: flex;
      flex-direction: column;
      background: var(--panel);
      border-right: 1px solid var(--border);
      padding: 1.5rem 1rem;
      position: sticky;
      top: 0;
      height: 100vh;
    }
    .sidebar nav { flex: 1; }
    .sidebar-version {
      margin-top: auto;
      padding: 0.75rem 0.85rem 0;
      font-size: 0.7rem;
      color: var(--muted);
      opacity: 0.65;
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
    .temp-label {
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--muted);
      margin-top: 0.25rem;
    }
    .temp-display {
      font-size: 2.5rem;
      font-weight: 700;
      line-height: 1;
      margin: 0.15rem 0 0.5rem;
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
    #zone-cards {
      grid-template-columns: minmax(0, 1fr);
    }
    .zone-control-card {
      overflow: hidden;
    }
    .zone-control-layout {
      display: grid;
      grid-template-columns: minmax(140px, 180px) 1fr;
      gap: 1.25rem;
      margin-top: 0.75rem;
      align-items: start;
    }
    .thermo-widget {
      position: relative;
      display: grid;
      grid-template-columns: 2rem 1fr;
      gap: 0.35rem;
      user-select: none;
      touch-action: none;
    }
    .thermo-scale {
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      height: 280px;
      font-size: 0.7rem;
      color: var(--muted);
      padding: 0.15rem 0;
    }
    .thermo-track {
      position: relative;
      height: 280px;
      border-radius: 999px;
      background: linear-gradient(to top, #fef3c7 0%, #e0f2fe 55%, #dbeafe 100%);
      border: 2px solid var(--border);
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.35);
    }
    html[data-theme="dark"] .thermo-track {
      background: linear-gradient(to top, #451a03 0%, #0c4a6e 55%, #1e3a5f 100%);
    }
    .thermo-band {
      position: absolute;
      left: 18%;
      right: 18%;
      border-radius: 999px;
      opacity: 0.45;
      pointer-events: none;
    }
    .thermo-band-heat {
      background: #f97316;
      bottom: 0;
    }
    .thermo-band-cool {
      background: #38bdf8;
      top: 0;
    }
    .thermo-indoor-marker {
      position: absolute;
      left: 8%;
      right: 8%;
      height: 3px;
      background: var(--text);
      border-radius: 999px;
      pointer-events: none;
      z-index: 2;
      opacity: 0.55;
    }
    .thermo-indoor-marker::after {
      content: "";
      position: absolute;
      right: -6px;
      top: 50%;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--text);
      transform: translateY(-50%);
    }
    .thermo-handle {
      position: absolute;
      left: 50%;
      transform: translate(-50%, 50%);
      z-index: 3;
      border: none;
      border-radius: 999px;
      padding: 0.35rem 0.55rem;
      min-width: 3.1rem;
      font-size: 0.8rem;
      font-weight: 700;
      cursor: grab;
      box-shadow: 0 6px 16px rgba(15, 23, 42, 0.18);
    }
    .thermo-handle:active { cursor: grabbing; }
    .thermo-handle-heat {
      background: #ea580c;
      color: #fff;
    }
    .thermo-handle-cool {
      background: #0284c7;
      color: #fff;
    }
    .zone-control-card.mode-heat .thermo-handle-cool,
    .zone-control-card.mode-heat .thermo-band-cool,
    .zone-control-card.mode-cool .thermo-handle-heat,
    .zone-control-card.mode-cool .thermo-band-heat {
      display: none;
    }
    .zone-side-panel {
      display: grid;
      gap: 1rem;
    }
    .fan-control {
      border: 1px solid var(--border);
      border-radius: 0.85rem;
      padding: 0.85rem 1rem;
      background: var(--bg);
    }
    .fan-label-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0.5rem;
      font-size: 0.9rem;
      font-weight: 600;
    }
    .fan-label-row span:last-child {
      color: var(--accent);
      font-size: 0.85rem;
    }
    .fan-control input[type="range"] {
      width: 100%;
      margin: 0.35rem 0 0.5rem;
      accent-color: var(--accent);
    }
    .fan-ticks {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 0.25rem;
      font-size: 0.72rem;
      color: var(--muted);
      text-align: center;
    }
    .preset-tiles {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(5.5rem, 1fr));
      gap: 0.5rem;
    }
    .preset-tile {
      background: var(--panel);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 0.75rem;
      padding: 0.55rem 0.45rem;
      font-size: 0.8rem;
      font-weight: 600;
      text-transform: capitalize;
    }
    .preset-tile:hover {
      border-color: var(--accent);
      color: var(--accent);
    }
    .preset-tile.active {
      background: var(--accent-soft);
      border-color: var(--accent);
      color: var(--accent);
    }
    .preset-tile:disabled {
      opacity: 0.55;
      cursor: wait;
    }
    .zone-readout {
      display: flex;
      gap: 1rem;
      flex-wrap: wrap;
      margin-bottom: 0.25rem;
    }
    .zone-readout .temp-display {
      font-size: 2rem;
      margin: 0;
    }
    @media (max-width: 900px) {
      .layout { grid-template-columns: 1fr; }
      .sidebar { position: static; height: auto; }
      .zone-control-layout { grid-template-columns: 1fr; }
    }
  `;
}

function renderPage(active: string, content: string): string {
  const nav = [
    { id: "dashboard", label: "Dashboard", href: "/" },
    { id: "setup", label: "Setup", href: "/setup" },
    { id: "settings", label: "Settings", href: "/settings" },
  ];
  const navHtml = nav
    .map(
      (item) =>
        `<a class="nav-link${item.id === active ? " active" : ""}" href="${item.href}">${escapeHtml(item.label)}</a>`,
    )
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
      <p class="sidebar-version">v${escapeHtml(APP_VERSION)}</p>
    </aside>
    <main class="main">${content}</main>
  </div>
</body>
</html>`;
}

function setupContent(settings: PublicSettings): string {
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
      <div class="stat-row"><span class="muted">Live update</span><span id="diag-live">—</span></div>
      <div class="stat-row"><span class="muted">Zone sensor</span><span id="diag-sensor">—</span></div>
      <p class="muted message" id="diag-error" style="margin-top:0.75rem"></p>
    </div>
    <script>
      async function refreshConnection() {
        const pill = document.getElementById("connection-pill");
        const diagCloud = document.getElementById("diag-cloud");
        const diagSystems = document.getElementById("diag-systems");
        const diagSync = document.getElementById("diag-sync");
        const diagLive = document.getElementById("diag-live");
        const diagSensor = document.getElementById("diag-sensor");
        const diagError = document.getElementById("diag-error");
        try {
          const res = await fetch("/api/status");
          const data = await res.json();
          diagSystems.textContent = String(data.systems?.length ?? 0);
          diagSync.textContent = data.last_sync ? new Date(data.last_sync).toLocaleString() : "Never";
          diagLive.textContent = data.last_live_update ? new Date(data.last_live_update).toLocaleString() : "Waiting…";
          const zone = data.zones?.[0];
          diagSensor.textContent = zone
            ? "rt " + (zone.sensor_rt ?? "—") + " → " + (zone.temperature_display ?? "—") + "°F · heat " + (zone.heat_setpoint_display ?? "—") + "°F"
            : "—";
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

function dashboardContent(): string {
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
      const THERMO_MIN = 60;
      const THERMO_MAX = 90;
      const THERMO_DEADBAND = 2;
      const FAN_LEVELS = ["auto", "low", "med", "high"];
      const FAN_LABELS = ["Auto", "Low", "Medium", "High"];

      function escapeHtml(value) {
        return String(value)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;");
      }

      function normalizeMode(mode) {
        if (!mode) return "auto";
        const m = String(mode).toLowerCase();
        if (m.includes("cool")) return "cool";
        if (m.includes("heat") || m === "emheat") return "heat";
        if (m === "fanonly" || m === "fan_only") return "fanonly";
        if (m === "off") return "off";
        return "auto";
      }

      function modeLabel(mode) {
        const normalized = normalizeMode(mode);
        if (normalized === "fanonly") return "Fan only";
        if (normalized === "auto") return "Auto";
        return normalized.charAt(0).toUpperCase() + normalized.slice(1);
      }

      function clampTemp(value) {
        return Math.max(THERMO_MIN, Math.min(THERMO_MAX, value));
      }

      function parseTemp(value, fallback) {
        const parsed = Number.parseInt(String(value), 10);
        return Number.isFinite(parsed) ? clampTemp(parsed) : fallback;
      }

      function tempToBottom(temp) {
        return ((clampTemp(temp) - THERMO_MIN) / (THERMO_MAX - THERMO_MIN)) * 100;
      }

      function bottomToTemp(bottom) {
        const ratio = Math.max(0, Math.min(100, bottom)) / 100;
        return clampTemp(Math.round(THERMO_MIN + ratio * (THERMO_MAX - THERMO_MIN)));
      }

      function fanToIndex(fan) {
        if (fan === "on") return 1;
        const index = FAN_LEVELS.indexOf(fan || "auto");
        return index >= 0 ? index : 0;
      }

      function presetLabel(preset) {
        if (preset === "resume") return "Resume";
        return preset.charAt(0).toUpperCase() + preset.slice(1);
      }

      function updateThermoWidget(widget) {
        const track = widget.querySelector(".thermo-track");
        const heatHandle = widget.querySelector(".thermo-handle-heat");
        const coolHandle = widget.querySelector(".thermo-handle-cool");
        const heatBand = widget.querySelector(".thermo-band-heat");
        const coolBand = widget.querySelector(".thermo-band-cool");
        const indoorMarker = widget.querySelector(".thermo-indoor-marker");
        const heat = parseTemp(heatHandle.dataset.value, 68);
        const cool = parseTemp(coolHandle.dataset.value, 74);
        const indoor = parseTemp(widget.dataset.indoor, heat);
        const heatBottom = tempToBottom(heat);
        const coolBottom = tempToBottom(cool);
        const indoorBottom = tempToBottom(indoor);

        heatHandle.dataset.value = String(heat);
        coolHandle.dataset.value = String(cool);
        heatHandle.textContent = heat + "°";
        coolHandle.textContent = cool + "°";
        heatHandle.style.bottom = heatBottom + "%";
        coolHandle.style.bottom = coolBottom + "%";
        indoorMarker.style.bottom = indoorBottom + "%";

        if (heatBand) {
          heatBand.style.height = heatBottom + "%";
        }
        if (coolBand) {
          coolBand.style.height = (100 - coolBottom) + "%";
        }
      }

      function nearestVisibleHandle(widget, temp) {
        const card = widget.closest(".zone-control-card");
        const mode = card.dataset.systemMode || "auto";
        if (mode === "heat") return widget.querySelector(".thermo-handle-heat");
        if (mode === "cool") return widget.querySelector(".thermo-handle-cool");
        const heatHandle = widget.querySelector(".thermo-handle-heat");
        const coolHandle = widget.querySelector(".thermo-handle-cool");
        const heat = parseTemp(heatHandle.dataset.value, 68);
        const cool = parseTemp(coolHandle.dataset.value, 74);
        return Math.abs(temp - heat) <= Math.abs(temp - cool) ? heatHandle : coolHandle;
      }

      function setHandleTemp(widget, handle, temp) {
        const heatHandle = widget.querySelector(".thermo-handle-heat");
        const coolHandle = widget.querySelector(".thermo-handle-cool");
        let next = clampTemp(temp);
        if (handle.classList.contains("thermo-handle-heat") && coolHandle.offsetParent !== null) {
          const cool = parseTemp(coolHandle.dataset.value, 74);
          next = Math.min(next, cool - THERMO_DEADBAND);
        }
        if (handle.classList.contains("thermo-handle-cool") && heatHandle.offsetParent !== null) {
          const heat = parseTemp(heatHandle.dataset.value, 68);
          next = Math.max(next, heat + THERMO_DEADBAND);
        }
        handle.dataset.value = String(next);
        updateThermoWidget(widget);
      }

      function tempFromPointer(track, clientY) {
        const rect = track.getBoundingClientRect();
        const ratio = 1 - Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
        return bottomToTemp(ratio * 100);
      }

      function initThermoWidget(widget) {
        if (widget.dataset.initialized === "true") return;
        widget.dataset.initialized = "true";
        const track = widget.querySelector(".thermo-track");
        const handles = widget.querySelectorAll(".thermo-handle");
        updateThermoWidget(widget);

        handles.forEach((handle) => {
          handle.addEventListener("pointerdown", (event) => {
            event.preventDefault();
            const card = widget.closest(".zone-control-card");
            card.dataset.dragging = "true";
            handle.setPointerCapture(event.pointerId);

            const onMove = (moveEvent) => {
              setHandleTemp(widget, handle, tempFromPointer(track, moveEvent.clientY));
            };

            const onEnd = async () => {
              card.dataset.dragging = "false";
              handle.removeEventListener("pointermove", onMove);
              handle.removeEventListener("pointerup", onEnd);
              handle.removeEventListener("pointercancel", onEnd);
              await applyZoneSetpoints(card);
            };

            handle.addEventListener("pointermove", onMove);
            handle.addEventListener("pointerup", onEnd);
            handle.addEventListener("pointercancel", onEnd);
          });
        });

        track.addEventListener("pointerdown", (event) => {
          if (event.target.closest(".thermo-handle")) return;
          const handle = nearestVisibleHandle(widget, tempFromPointer(track, event.clientY));
          if (!handle) return;
          setHandleTemp(widget, handle, tempFromPointer(track, event.clientY));
          const card = widget.closest(".zone-control-card");
          applyZoneSetpoints(card);
        });
      }

      async function postZoneUpdate(card, payload) {
        const zoneId = card.dataset.zoneId;
        const message = card.querySelector(".zone-message");
        message.className = "message";
        message.textContent = "Updating…";
        const res = await fetch("/api/zone/" + encodeURIComponent(zoneId), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        message.className = "message " + (res.ok ? "success" : "error");
        message.textContent = res.ok ? "Updated." : (data.error || "Update failed.");
        if (res.ok) {
          setTimeout(() => loadDashboard({ soft: true }), 600);
        }
        return res.ok;
      }

      async function applyZoneSetpoints(card) {
        const widget = card.querySelector(".thermo-widget");
        const heatHandle = widget.querySelector(".thermo-handle-heat");
        const coolHandle = widget.querySelector(".thermo-handle-cool");
        const payload = {};
        if (heatHandle.offsetParent !== null) {
          payload.heat_setpoint = heatHandle.dataset.value;
        }
        if (coolHandle.offsetParent !== null) {
          payload.cool_setpoint = coolHandle.dataset.value;
        }
        if (!Object.keys(payload).length) return false;
        return postZoneUpdate(card, payload);
      }

      function initFanSlider(card) {
        const slider = card.querySelector('[data-field="fan"]');
        const label = card.querySelector("[data-fan-label]");
        if (!slider || slider.dataset.initialized === "true") return;
        slider.dataset.initialized = "true";

        const syncLabel = () => {
          const index = Number.parseInt(slider.value, 10);
          label.textContent = FAN_LABELS[index] || "Auto";
        };

        slider.addEventListener("input", syncLabel);
        slider.addEventListener("change", async () => {
          const fan = FAN_LEVELS[Number.parseInt(slider.value, 10)] || "auto";
          await postZoneUpdate(card, { fan });
        });
        syncLabel();
      }

      function initPresetTiles(card) {
        card.querySelectorAll("[data-preset]").forEach((tile) => {
          if (tile.dataset.initialized === "true") return;
          tile.dataset.initialized = "true";
          tile.addEventListener("click", async () => {
            card.querySelectorAll("[data-preset]").forEach((item) => {
              item.disabled = true;
            });
            const ok = await postZoneUpdate(card, { preset: tile.dataset.preset });
            card.querySelectorAll("[data-preset]").forEach((item) => {
              item.disabled = false;
            });
            if (ok) {
              card.querySelectorAll("[data-preset]").forEach((item) => {
                item.classList.toggle("active", item.dataset.preset === tile.dataset.preset);
              });
            }
          });
        });
      }

      function initZoneCard(card) {
        initThermoWidget(card.querySelector(".thermo-widget"));
        initFanSlider(card);
        initPresetTiles(card);
      }

      function renderZoneCard(zone, systemMode) {
        const unitLabel = "°F";
        const normalizedMode = normalizeMode(systemMode);
        const temp = zone.temperature_display ?? (zone.temperature ?? "—");
        const humidity = zone.humidity ?? "—";
        const heat = parseTemp(zone.heat_setpoint_display ?? zone.heat_setpoint, 68);
        const cool = parseTemp(zone.cool_setpoint_display ?? zone.cool_setpoint, 74);
        const indoor = parseTemp(zone.temperature_display ?? zone.temperature, heat);
        const fanIndex = fanToIndex(zone.fan);
        const activePreset = (zone.hold ? zone.hold_activity : zone.activity) || "";
        const presetTiles = (zone.presets || []).map((preset) =>
          '<button type="button" class="preset-tile' + (preset === activePreset ? " active" : "") + '" data-preset="' + escapeHtml(preset) + '">' + escapeHtml(presetLabel(preset)) + "</button>"
        ).join("");
        const heatLabel = normalizedMode === "cool" ? "" : heat + unitLabel;
        const coolLabel = normalizedMode === "heat" ? "" : cool + unitLabel;
        const targetSummary = normalizedMode === "heat"
          ? "Heat " + heat + unitLabel
          : normalizedMode === "cool"
            ? "Cool " + cool + unitLabel
            : "Heat " + heat + unitLabel + " / Cool " + cool + unitLabel;

        return \`
          <div class="card zone-control-card mode-\${escapeHtml(normalizedMode)}" data-zone-id="\${escapeHtml(zone.id)}" data-system-mode="\${escapeHtml(normalizedMode)}">
            <h3>\${escapeHtml(zone.name)}</h3>
            <div class="zone-readout">
              <div>
                <div class="temp-label">Indoor</div>
                <div class="temp-display">\${temp}\${temp === "—" ? "" : unitLabel}</div>
              </div>
              <div>
                <div class="stat-row"><span class="muted">Humidity</span><span>\${humidity}%</span></div>
                <div class="stat-row"><span class="muted">Targets</span><span>\${targetSummary}</span></div>
                <div class="stat-row"><span class="muted">Activity</span><span>\${escapeHtml(zone.activity || "—")}</span></div>
                <div class="stat-row"><span class="muted">Conditioning</span><span>\${escapeHtml(zone.conditioning || "idle")}</span></div>
              </div>
            </div>
            <div class="zone-control-layout">
              <div
                class="thermo-widget"
                data-indoor="\${indoor}"
                data-heat="\${heat}"
                data-cool="\${cool}"
              >
                <div class="thermo-scale" aria-hidden="true">
                  <span>90°</span>
                  <span>80°</span>
                  <span>70°</span>
                  <span>60°</span>
                </div>
                <div class="thermo-track">
                  <div class="thermo-band thermo-band-heat"></div>
                  <div class="thermo-band thermo-band-cool"></div>
                  <div class="thermo-indoor-marker" title="Indoor \${indoor}\${unitLabel}"></div>
                  <button type="button" class="thermo-handle thermo-handle-heat" data-value="\${heat}" aria-label="Heat setpoint \${heatLabel}">\${heat}°</button>
                  <button type="button" class="thermo-handle thermo-handle-cool" data-value="\${cool}" aria-label="Cool setpoint \${coolLabel}">\${cool}°</button>
                </div>
              </div>
              <div class="zone-side-panel">
                <div class="fan-control">
                  <div class="fan-label-row">
                    <span>Fan</span>
                    <span data-fan-label>\${FAN_LABELS[fanIndex]}</span>
                  </div>
                  <input type="range" min="0" max="3" step="1" value="\${fanIndex}" data-field="fan" aria-label="Fan speed" />
                  <div class="fan-ticks">
                    <span>Auto</span>
                    <span>Low</span>
                    <span>Med</span>
                    <span>High</span>
                  </div>
                </div>
                <div>
                  <div class="temp-label">Preset</div>
                  <div class="preset-tiles">\${presetTiles}</div>
                </div>
                <div class="message zone-message"></div>
              </div>
            </div>
          </div>
        \`;
      }

      async function loadDashboard(options = {}) {
        const pill = document.getElementById("connection-pill");
        const systemCards = document.getElementById("system-cards");
        const zoneCards = document.getElementById("zone-cards");
        const zoneDragging = Boolean(zoneCards.querySelector('[data-dragging="true"]'));
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
          const unitLabel = "°F";
          const outdoor = data.system.outdoor_temp_display ?? data.system.outdoor_temp ?? "—";
          const filter = data.system.filter_remaining ?? "—";
          if (!options.soft) {
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
                <div class="temp-label">Outside</div>
                <div class="temp-display">\${outdoor}\${outdoor === "—" ? "" : unitLabel}</div>
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
          }
          if (!zoneDragging) {
            zoneCards.innerHTML = data.zones.map((zone) => renderZoneCard(zone, mode)).join("");
            zoneCards.querySelectorAll(".zone-control-card").forEach(initZoneCard);
          }
        } catch (error) {
          pill.className = "status-pill error";
          pill.textContent = "Error";
          if (!options.soft) {
            systemCards.innerHTML = '<div class="card"><p class="muted">' + escapeHtml(error) + '</p></div>';
            zoneCards.innerHTML = "";
          }
        }
      }
      loadDashboard();
      setInterval(() => loadDashboard(), 15000);
    </script>
  `;
}

function settingsContent(settings: PublicSettings): string {
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

function findConfigZoneById(system: CarrierSystem, zoneId: string) {
  return findConfigZone(system, zoneId);
}

function findManualActivity(system: CarrierSystem, zoneId: string) {
  const zone = findConfigZoneById(system, zoneId);
  return zone?.activities.find((activity) => activity.type === "manual");
}

async function handleApi(
  route: string,
  req: IncomingMessage,
  res: ServerResponse,
  settings: Settings,
): Promise<void> {
  if (route === "/api/status" && req.method === "GET") {
    const needsRefresh =
      !lastSyncAt ||
      Date.now() - lastSyncAt.getTime() > STATUS_CACHE_MS ||
      (!lastLiveUpdateAt && Date.now() - (lastSyncAt?.getTime() ?? 0) > 5_000);
    const snapshot = await refreshCloudData(settings, needsRefresh);
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
    resetCloudConnections();
    await saveSettings(cleared);
    cachedSystems = [];
    lastSyncAt = null;
    lastLiveUpdateAt = null;
    lastError = null;
    sendJson(res, 200, { settings: publicSettings(cleared) });
    return;
  }

  if (route === "/api/settings" && req.method === "PUT") {
    const body = JSON.parse((await readBody(req)).toString("utf8")) as Partial<Settings>;
    const username = body.username?.trim() ?? settings.username;
    const password = body.password?.trim() ? body.password : settings.password;
    if (!username || !password) {
      sendJson(res, 400, { error: "Username and password are required" });
      return;
    }

    const next: Settings = {
      system_name: body.system_name?.trim() || settings.system_name || DEFAULT_SETTINGS.system_name,
      username,
      password,
      system_serial: body.system_serial?.trim() ?? settings.system_serial,
    };

    try {
      const client = getClient(next);
      const validation = await client.validate();
      if (!validation.systemCount) {
        sendJson(res, 400, { error: "No HVAC systems found on this Carrier account" });
        return;
      }
      resetCloudConnections();
      await saveSettings(next);
      cachedSystems = [];
      lastSyncAt = null;
      lastLiveUpdateAt = null;
      await refreshCloudData(next, true);
      ensurePolling(next);
      sendJson(res, 200, { settings: publicSettings(next) });
    } catch (error) {
      const message =
        error instanceof CarrierAuthError
          ? error.message
          : error instanceof CarrierApiError
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
    const body = JSON.parse((await readBody(req)).toString("utf8")) as { mode?: string };
    const mode = body.mode?.trim().toLowerCase();
    const allowed: SystemMode[] = ["heat", "cool", "auto", "off", "fanonly"];
    if (!mode || !allowed.includes(mode as SystemMode)) {
      sendJson(res, 400, { error: "mode must be heat, cool, auto, off, or fanonly" });
      return;
    }
    const system = selectSystem(settings, cachedSystems);
    if (!system) {
      sendJson(res, 502, { error: "No system loaded" });
      return;
    }
    try {
      const client = getClient(settings);
      await client.setMode(system.profile.serial, mode as SystemMode);
      await refreshCloudData(settings, true);
      sendJson(res, 200, { ok: true });
    } catch (error) {
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
    const body = JSON.parse((await readBody(req)).toString("utf8")) as {
      heat_setpoint?: string | number;
      cool_setpoint?: string | number;
      fan?: string;
      preset?: string;
    };

    const system = selectSystem(settings, cachedSystems);
    if (!system) {
      sendJson(res, 502, { error: "No system loaded" });
      return;
    }

    const client = getClient(settings);
    const serial = system.profile.serial;
    const statusZone = findStatusZone(system, zoneId);

    try {
      if (body.preset) {
        const preset = body.preset.toLowerCase();
        if (preset === "resume" || preset === "schedule") {
          await client.resumeSchedule(serial, zoneId);
        } else if (["home", "away", "sleep", "wake", "manual", "vacation"].includes(preset)) {
          await client.setHold(serial, zoneId, preset as ActivityType, null);
        }
      }

      const heat = body.heat_setpoint !== undefined && body.heat_setpoint !== "" ? String(body.heat_setpoint) : null;
      const cool = body.cool_setpoint !== undefined && body.cool_setpoint !== "" ? String(body.cool_setpoint) : null;
      const fan = body.fan?.trim().toLowerCase();

      if (heat || cool || (fan && fan !== "auto")) {
        const manual = findManualActivity(system, zoneId);
        const heatSetpoint = heat ?? String(manual?.htsp ?? statusZone?.htsp ?? 68);
        const coolSetpoint = cool ?? String(manual?.clsp ?? statusZone?.clsp ?? 74);
        let fanMode: FanMode | undefined;
        if (fan === "auto" || fan === "on") {
          fanMode = "off";
        } else if (fan && ["low", "med", "high", "off"].includes(fan)) {
          fanMode = fan as FanMode;
        } else if (manual?.fan) {
          fanMode = manual.fan as FanMode;
        }

        await client.setManualActivity(serial, zoneId, heatSetpoint, coolSetpoint, fanMode);
        await client.setHold(serial, zoneId, "manual", null);
      } else if (fan === "auto" || fan === "low" || fan === "med" || fan === "high") {
        const configZone = findConfigZoneById(system, zoneId);
        const activityType = (configZone?.holdActivity || statusZone?.currentActivity || "home") as ActivityType;
        const fanMode: FanMode = fan === "auto" ? "off" : (fan as FanMode);
        await client.updateFan(serial, zoneId, activityType, fanMode);
      }

      await refreshCloudData(settings, true);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 502, {
        error: error instanceof Error ? error.message : "Zone update failed",
      });
    }
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
      const icon = await readFile(ICON_PATH);
      res.writeHead(200, { "Content-Type": "image/svg+xml", "Content-Length": icon.length });
      res.end(icon);
      return;
    } catch {
      sendText(res, 404, "text/plain; charset=utf-8", "not found");
      return;
    }
  }

  if (route.startsWith("/api/")) {
    try {
      await handleApi(route, req, res, settings);
    } catch (error) {
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
createServer((req, res) => {
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