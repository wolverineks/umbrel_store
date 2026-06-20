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

const APP_VERSION = "2.3.3";
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
  fan_speed: string | null;
  fan_display: string | null;
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
  systems: Array<{ serial: string; name: string; model: string | null }>;
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
    return systems.find((system) => system.profile.serial === settings.system_serial) ?? null;
  }
  return systems[0] ?? null;
}

function isZoneEnabled(configZone: CarrierSystem["config"]["zones"][number], statusZone?: CarrierSystem["status"]["zones"][number]): boolean {
  const enabled = statusZone?.enabled ?? configZone.enabled;
  return enabled === "on";
}

function normalizeFanMode(fan: string | null | undefined): string | null {
  if (!fan) return null;
  const value = fan.toLowerCase();
  if (value === "off") return "auto";
  return value;
}

function formatFanSettingLabel(fan: string | null | undefined): string | null {
  const normalized = normalizeFanMode(fan);
  if (!normalized) return null;
  if (normalized === "auto") return "Auto";
  if (normalized === "on") return "On";
  if (normalized === "low") return "Low";
  if (normalized === "med") return "Medium";
  if (normalized === "high") return "High";
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function formatFanSpeedLabel(speed: string | null | undefined): string | null {
  if (!speed || speed === "off") return "Off";
  if (speed === "on") return "Low";
  if (speed === "low") return "Low";
  if (speed === "med") return "Medium";
  if (speed === "high") return "High";
  return speed.charAt(0).toUpperCase() + speed.slice(1);
}

function formatBlowerLiveDisplay(
  idu: CarrierSystem["status"]["idu"],
  fanSpeed: string | null,
): string | null {
  const rpm = idu?.blwrpm;
  const cfm = idu?.cfm;
  if (rpm != null && rpm > 0) {
    return `${Math.round(rpm)} RPM`;
  }
  if (cfm != null && cfm > 0) {
    return `${Math.round(cfm)} CFM`;
  }
  return formatFanSpeedLabel(fanSpeed);
}

function resolveFanSetting(
  statusZone: CarrierSystem["status"]["zones"][number] | undefined,
  configZone: CarrierSystem["config"]["zones"][number] | undefined,
): string {
  const activityType =
    statusZone?.currentActivity ?? configZone?.holdActivity ?? configZone?.activities[0]?.type ?? null;
  if (!activityType || !configZone) return "auto";

  const activity = configZone.activities.find((item) => item.type === activityType);
  return normalizeFanMode(activity?.fan) ?? "auto";
}

function resolveFanSpeed(
  statusZone: CarrierSystem["status"]["zones"][number] | undefined,
): string | null {
  if (!statusZone?.fan) return "off";
  const value = statusZone.fan.toLowerCase();
  if (value === "on") return "low";
  if (["off", "low", "med", "high"].includes(value)) return value;
  return value;
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
    const fan = resolveFanSetting(statusZone, configZone);
    const fanSpeed = resolveFanSpeed(statusZone);
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
      fan,
      fan_speed: fanSpeed,
      fan_display: formatBlowerLiveDisplay(system.status.idu, fanSpeed),
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
      model: item.profile.model,
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
    .mobile-header,
    .sidebar-backdrop {
      display: none;
    }
    .menu-toggle {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid var(--border);
      background: var(--panel);
      border-radius: 0.65rem;
      padding: 0.45rem 0.55rem;
      cursor: pointer;
      color: var(--text);
    }
    .menu-toggle .icon {
      width: 1.25rem;
      height: 1.25rem;
    }
    .mobile-header-title {
      font-size: 0.95rem;
      font-weight: 700;
    }
    .toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
      margin-bottom: 1.25rem;
      flex-wrap: wrap;
    }
    .toolbar h2 { margin: 0; font-size: 1.5rem; }
    .toolbar-meta {
      font-size: 0.88rem;
      color: var(--muted);
      margin: 0.2rem 0 0;
    }
    .toolbar-meta strong { color: var(--text); }
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
      grid-template-columns: minmax(200px, 240px) 1fr;
      gap: 1.25rem;
      margin-top: 0.75rem;
      align-items: start;
    }
    .thermo-widget {
      position: relative;
      display: grid;
      grid-template-columns: 3.25rem 1fr;
      gap: 0.5rem;
      user-select: none;
      touch-action: none;
    }
    .thermo-scale {
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      height: 260px;
      margin-top: 0;
      padding: 0;
    }
    .thermo-tick {
      display: flex;
      align-items: center;
      gap: 0.35rem;
      font-size: 0.68rem;
      color: var(--muted);
      font-variant-numeric: tabular-nums;
    }
    .thermo-tick-mark {
      display: block;
      width: 0.55rem;
      height: 1px;
      background: var(--muted);
      opacity: 0.7;
    }
    .thermo-tick-major .thermo-tick-mark {
      width: 0.85rem;
      height: 2px;
      opacity: 1;
    }
    .thermo-tick-major .thermo-tick-label {
      font-weight: 700;
      color: var(--text);
    }
    .thermo-body {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 0 3.25rem;
    }
    .thermo-tube {
      position: relative;
      width: 34px;
      height: 260px;
      margin-bottom: -12px;
      z-index: 2;
    }
    .thermo-glass {
      position: absolute;
      inset: 0;
      border-radius: 17px 17px 6px 6px;
      background: linear-gradient(90deg, #f8fafc 0%, #e8f0f8 35%, #f1f5f9 65%, #f8fafc 100%);
      border: 2px solid #94a3b8;
      box-shadow:
        inset 3px 0 10px rgba(255, 255, 255, 0.95),
        inset -3px 0 6px rgba(15, 23, 42, 0.06),
        0 4px 14px rgba(15, 23, 42, 0.08);
      overflow: hidden;
    }
    html[data-theme="dark"] .thermo-glass {
      background: linear-gradient(90deg, #1e293b 0%, #334155 50%, #1e293b 100%);
      border-color: #64748b;
      box-shadow:
        inset 3px 0 10px rgba(255, 255, 255, 0.08),
        inset -3px 0 6px rgba(0, 0, 0, 0.25),
        0 4px 14px rgba(0, 0, 0, 0.35);
    }
    .thermo-shine {
      position: absolute;
      top: 8%;
      left: 18%;
      width: 28%;
      height: 72%;
      border-radius: 999px;
      background: linear-gradient(to bottom, rgba(255,255,255,0.75), rgba(255,255,255,0.05));
      pointer-events: none;
      z-index: 4;
    }
    html[data-theme="dark"] .thermo-shine {
      background: linear-gradient(to bottom, rgba(255,255,255,0.18), rgba(255,255,255,0));
    }
    .thermo-zone {
      position: absolute;
      left: 12%;
      right: 12%;
      pointer-events: none;
      z-index: 1;
      opacity: 0.22;
    }
    .thermo-zone-heat {
      bottom: 0;
      background: linear-gradient(to top, #ef4444, transparent);
      border-radius: 0 0 8px 8px;
    }
    .thermo-zone-cool {
      top: 0;
      background: linear-gradient(to bottom, #3b82f6, transparent);
      border-radius: 8px 8px 0 0;
    }
    .thermo-fill {
      position: absolute;
      bottom: 0;
      left: 22%;
      right: 22%;
      background: linear-gradient(to top, #991b1b 0%, #dc2626 45%, #ef4444 100%);
      border-radius: 0 0 6px 6px;
      z-index: 2;
      box-shadow: inset 0 2px 4px rgba(255, 255, 255, 0.2);
      pointer-events: none;
      transition: height 0.25s ease;
    }
    .thermo-fill-cap {
      position: absolute;
      top: -3px;
      left: -15%;
      right: -15%;
      height: 6px;
      border-radius: 999px;
      background: #ef4444;
      z-index: 3;
    }
    .thermo-inner-ticks {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 3;
      opacity: 0.35;
    }
    .thermo-inner-tick {
      position: absolute;
      left: 15%;
      right: 15%;
      height: 1px;
      background: #64748b;
    }
    .thermo-bulb {
      width: 58px;
      height: 58px;
      border-radius: 50%;
      background: radial-gradient(circle at 32% 28%, #fca5a5 0%, #dc2626 42%, #991b1b 100%);
      border: 2px solid #b91c1c;
      box-shadow:
        inset -4px -6px 10px rgba(0, 0, 0, 0.2),
        inset 3px 3px 8px rgba(255, 255, 255, 0.25),
        0 6px 16px rgba(220, 38, 38, 0.28);
      z-index: 1;
    }
    html[data-theme="dark"] .thermo-bulb {
      background: radial-gradient(circle at 32% 28%, #f87171 0%, #b91c1c 45%, #7f1d1d 100%);
      border-color: #991b1b;
    }
    .thermo-handle {
      position: absolute;
      display: flex;
      align-items: center;
      gap: 0;
      z-index: 5;
      border: none;
      padding: 0;
      background: transparent;
      cursor: grab;
      box-shadow: none;
      transform: translateY(50%);
    }
    .thermo-handle:active { cursor: grabbing; }
    .thermo-handle-heat {
      right: calc(100% + 10px);
      flex-direction: row-reverse;
      color: #b91c1c;
    }
    .thermo-handle-cool {
      left: calc(100% + 10px);
      color: #1d4ed8;
    }
    .thermo-flag-stem {
      display: block;
      width: 12px;
      height: 2px;
      background: currentColor;
    }
    .thermo-flag-label {
      padding: 0.22rem 0.5rem;
      border-radius: 4px;
      font-size: 0.74rem;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
      color: #fff;
      min-width: 2.55rem;
      text-align: center;
      border: 1px solid rgba(0, 0, 0, 0.12);
      box-shadow: 0 2px 6px rgba(15, 23, 42, 0.15);
    }
    .thermo-handle-heat .thermo-flag-label {
      background: linear-gradient(180deg, #ef4444, #b91c1c);
    }
    .thermo-handle-cool .thermo-flag-label {
      background: linear-gradient(180deg, #3b82f6, #1d4ed8);
    }
    .zone-control-card.mode-heat .thermo-handle-cool,
    .zone-control-card.mode-heat .thermo-zone-cool,
    .zone-control-card.mode-cool .thermo-handle-heat,
    .zone-control-card.mode-cool .thermo-zone-heat {
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
    .fan-ticks span.active {
      color: var(--accent);
      font-weight: 700;
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
    .zone-hero {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 1rem;
      flex-wrap: wrap;
      margin-bottom: 1rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid var(--border);
    }
    .zone-hero-temp {
      text-align: right;
    }
    .zone-hero-temp .temp-display {
      font-size: 3.25rem;
      margin: 0;
      line-height: 1;
    }
    .temp-unit {
      font-size: 1.35rem;
      font-weight: 600;
      color: var(--muted);
      margin-left: 0.1rem;
    }
    .temp-caption {
      display: block;
      font-size: 0.8rem;
      color: var(--muted);
      margin-top: 0.2rem;
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      margin-top: 0.45rem;
      padding: 0.35rem 0.7rem;
      border-radius: 999px;
      font-size: 0.82rem;
      font-weight: 600;
    }
    .status-badge .icon { width: 1rem; height: 1rem; }
    .status-heating { background: #ffedd5; color: #c2410c; }
    .status-cooling { background: #e0f2fe; color: #0369a1; }
    .status-idle { background: var(--bg); color: var(--muted); border: 1px solid var(--border); }
    .status-fan { background: #ede9fe; color: #6d28d9; }
    html[data-theme="dark"] .status-heating { background: #431407; color: #fdba74; }
    html[data-theme="dark"] .status-cooling { background: #0c4a6e; color: #7dd3fc; }
    html[data-theme="dark"] .status-fan { background: #2e1065; color: #c4b5fd; }
    .stat-chips {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 0.65rem;
      margin-bottom: 1rem;
    }
    .stat-chip {
      border: 1px solid var(--border);
      border-radius: 0.85rem;
      padding: 0.7rem 0.75rem;
      background: var(--bg);
      display: grid;
      gap: 0.2rem;
    }
    .stat-chip .icon {
      width: 1.1rem;
      height: 1.1rem;
      color: var(--accent);
    }
    .chip-label {
      font-size: 0.72rem;
      color: var(--muted);
      text-transform: none;
      letter-spacing: 0;
    }
    .chip-value {
      font-size: 0.95rem;
      font-weight: 700;
    }
    .mini-bar,
    .filter-bar-track {
      height: 5px;
      border-radius: 999px;
      background: var(--border);
      overflow: hidden;
      margin-top: 0.25rem;
    }
    .mini-bar > span,
    .filter-bar-fill {
      display: block;
      height: 100%;
      border-radius: 999px;
      background: linear-gradient(90deg, var(--accent), #38bdf8);
    }
    .fan-bars {
      display: flex;
      gap: 0.2rem;
      align-items: flex-end;
      height: 1.1rem;
      margin-top: 0.15rem;
    }
    .fan-bar {
      flex: 1;
      border-radius: 2px;
      background: var(--border);
      height: 35%;
    }
    .fan-bar:nth-child(2) { height: 55%; }
    .fan-bar:nth-child(3) { height: 75%; }
    .fan-bar:nth-child(4) { height: 100%; }
    .fan-bar.active { background: var(--accent); }
    .fan-bar.auto.active { opacity: 0.45; }
    .section-title {
      display: flex;
      align-items: center;
      gap: 0.45rem;
      font-size: 0.82rem;
      font-weight: 700;
      color: var(--muted);
      margin-bottom: 0.55rem;
      text-transform: none;
      letter-spacing: 0;
    }
    .section-title .icon { width: 1rem; height: 1rem; }
    .mode-tiles {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0.55rem;
      margin-top: 0.75rem;
    }
    .mode-tile {
      display: grid;
      justify-items: center;
      gap: 0.3rem;
      padding: 0.85rem 0.55rem;
      border-radius: 0.85rem;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--text);
      font-weight: 600;
      font-size: 0.88rem;
    }
    .mode-tile .icon { width: 1.45rem; height: 1.45rem; }
    .mode-tile small {
      font-size: 0.68rem;
      font-weight: 500;
      color: var(--muted);
    }
    .mode-tile.active {
      border-color: var(--accent);
      background: var(--accent-soft);
      color: var(--accent);
      box-shadow: inset 0 0 0 1px var(--accent);
    }
    .mode-tile.mode-tile-heat.active { border-color: #ea580c; background: #ffedd5; color: #c2410c; }
    .mode-tile.mode-tile-cool.active { border-color: #0284c7; background: #e0f2fe; color: #0369a1; }
    html[data-theme="dark"] .mode-tile.mode-tile-heat.active { background: #431407; color: #fdba74; }
    html[data-theme="dark"] .mode-tile.mode-tile-cool.active { background: #0c4a6e; color: #7dd3fc; }
    .weather-card {
      display: grid;
      gap: 0.35rem;
    }
    .weather-row {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    .weather-icon-wrap {
      width: 3rem;
      height: 3rem;
      border-radius: 0.85rem;
      display: grid;
      place-items: center;
      background: var(--bg);
      border: 1px solid var(--border);
      color: #f59e0b;
    }
    .weather-icon-wrap .icon { width: 1.6rem; height: 1.6rem; }
    .filter-life {
      margin-top: 0.65rem;
      padding-top: 0.65rem;
      border-top: 1px solid var(--border);
    }
    .filter-life-row {
      display: flex;
      justify-content: space-between;
      font-size: 0.82rem;
      margin-bottom: 0.35rem;
    }
    .preset-tile {
      display: grid;
      justify-items: center;
      gap: 0.25rem;
      padding: 0.65rem 0.4rem;
    }
    .preset-tile .icon { width: 1.2rem; height: 1.2rem; }
    .thermo-legend {
      display: flex;
      justify-content: space-between;
      font-size: 0.68rem;
      color: var(--muted);
      margin-top: 0.5rem;
      padding: 0 3.25rem;
    }
    .thermo-legend span:nth-child(2) {
      color: #dc2626;
      font-weight: 600;
    }
    .icon {
      display: inline-block;
      vertical-align: middle;
      flex-shrink: 0;
    }
    @media (max-width: 900px) {
      .layout {
        grid-template-columns: 1fr;
        grid-template-rows: auto 1fr;
      }
      .mobile-header {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.85rem 1rem;
        background: var(--panel);
        border-bottom: 1px solid var(--border);
        position: sticky;
        top: 0;
        z-index: 30;
        grid-column: 1;
        grid-row: 1;
      }
      .sidebar-backdrop {
        display: block;
        position: fixed;
        inset: 0;
        background: rgba(15, 23, 42, 0.45);
        z-index: 35;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.2s ease;
      }
      html[data-theme="dark"] .sidebar-backdrop {
        background: rgba(0, 0, 0, 0.55);
      }
      .sidebar-backdrop.open {
        opacity: 1;
        pointer-events: auto;
      }
      .sidebar {
        position: fixed;
        top: 0;
        left: 0;
        bottom: 0;
        width: min(280px, 86vw);
        height: 100vh;
        z-index: 40;
        transform: translateX(-105%);
        transition: transform 0.22s ease;
        box-shadow: var(--shadow);
      }
      .sidebar.open {
        transform: translateX(0);
      }
      .main {
        padding: 1rem;
        grid-column: 1;
        grid-row: 2;
      }
      .zone-control-layout { grid-template-columns: 1fr; }
      .stat-chips { grid-template-columns: 1fr; }
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
    <header class="mobile-header">
      <button type="button" class="menu-toggle" id="menu-toggle" aria-label="Open menu" aria-expanded="false" aria-controls="sidebar">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h16"/>
        </svg>
      </button>
      <span class="mobile-header-title">Bryant/Carrier HVAC</span>
    </header>
    <div class="sidebar-backdrop" id="sidebar-backdrop" hidden></div>
    <aside class="sidebar" id="sidebar">
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
  <script>
    (function () {
      const toggle = document.getElementById("menu-toggle");
      const sidebar = document.getElementById("sidebar");
      const backdrop = document.getElementById("sidebar-backdrop");
      if (!toggle || !sidebar || !backdrop) return;

      const mq = window.matchMedia("(max-width: 900px)");

      function setOpen(open) {
        sidebar.classList.toggle("open", open);
        backdrop.classList.toggle("open", open);
        backdrop.hidden = !open;
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
        toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
        document.body.style.overflow = open && mq.matches ? "hidden" : "";
      }

      function closeSidebar() {
        setOpen(false);
      }

      toggle.addEventListener("click", () => {
        setOpen(!sidebar.classList.contains("open"));
      });
      backdrop.addEventListener("click", closeSidebar);
      sidebar.querySelectorAll(".nav-link").forEach((link) => {
        link.addEventListener("click", closeSidebar);
      });
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") closeSidebar();
      });
      mq.addEventListener("change", () => {
        if (!mq.matches) closeSidebar();
      });
    })();
  </script>
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
      <div>
        <h2>Your home</h2>
        <p class="toolbar-meta" id="active-system-label">Loading system…</p>
      </div>
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
      const ICONS = {
        flame: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3c2 4 5 5.5 5 9a5 5 0 1 1-10 0c0-3.5 3-5 5-9z"/></svg>',
        snow: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M4 7l16 10M4 17L20 7M2 12h20"/></svg>',
        auto: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/><circle cx="12" cy="12" r="4"/></svg>',
        power: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v10"/><path d="M6.3 6.3a9 9 0 1 0 11.4 0"/></svg>',
        fan: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="2"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l3 3M16 16l3 3M19 5l-3 3M8 16l-3 3"/></svg>',
        droplet: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3c4 6 7 8.5 7 12a7 7 0 1 1-14 0c0-3.5 3-6 7-12z"/></svg>',
        calendar: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 11h18"/></svg>',
        sun: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2"/></svg>',
        home: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1z"/></svg>',
        away: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20V6l8-3 8 3v14"/><path d="M9 20v-6h6v6"/></svg>',
        sleep: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 14A8 8 0 0 0 11 6.5"/><path d="M3 14h9v7H3z"/></svg>',
        wake: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v3M5 7l2 2M19 7l-2 2"/><path d="M5 17a7 7 0 0 1 14 0"/></svg>',
        manual: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 21v-7l12-12 7 7-12 12z"/></svg>',
        vacation: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 20h18"/><path d="M7 20V10l5-4 5 4v10"/><path d="M9 14h6"/></svg>',
        resume: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 6h12M8 12h12M8 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/></svg>',
        filter: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 5h16l-6 7v6l-4 2v-8z"/></svg>',
        thermostat: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3a4 4 0 0 0-4 4v9a4 4 0 0 0 8 0V7a4 4 0 0 0-4-4z"/><circle cx="12" cy="15" r="1.5" fill="currentColor"/></svg>',
        pause: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M10 9v6M14 9v6"/></svg>',
      };

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

      function fanSpeedToIndex(speed) {
        if (!speed || speed === "off") return 0;
        if (speed === "on") return 1;
        const index = FAN_LEVELS.indexOf(speed);
        return index >= 0 ? index : 0;
      }

      function fanBarsIndex(zone) {
        return fanSpeedToIndex(zone.fan_speed);
      }

      function fanSettingLabel(zone) {
        const index = fanToIndex(zone.fan);
        return FAN_LABELS[index] || "Auto";
      }

      function fanValuesMatch(a, b) {
        return fanToIndex(a || "auto") === fanToIndex(b || "auto");
      }

      function fanPendingValue(card) {
        return card.dataset.fanPending || null;
      }

      function setFanPending(card, fan) {
        card.dataset.fanPending = fan || "auto";
      }

      function clearFanPending(card) {
        delete card.dataset.fanPending;
      }

      function applyFanSettingUi(card, fan) {
        const fanIndex = fanToIndex(fan);
        const label = card.querySelector("[data-fan-label]");
        const slider = card.querySelector('[data-field="fan"]');
        if (label) label.textContent = FAN_LABELS[fanIndex] || "Auto";
        if (slider) slider.value = String(fanIndex);
        card.querySelectorAll(".fan-control .fan-ticks span").forEach((tick, index) => {
          tick.classList.toggle("active", index === fanIndex);
        });
      }

      function fanDisplayText(zone) {
        return zone.fan_display || "—";
      }

      function scheduleLabel(activity) {
        if (!activity) return "—";
        const labels = {
          manual: "Hold",
          home: "Home",
          away: "Away",
          sleep: "Sleep",
          wake: "Wake up",
          vacation: "Away long-term",
        };
        return labels[activity] || activity.charAt(0).toUpperCase() + activity.slice(1);
      }

      function conditioningInfo(conditioning) {
        const value = String(conditioning || "idle").toLowerCase();
        if (value.includes("heat")) {
          return { label: value.includes("prep") || value.includes("pending") ? "Getting ready to heat" : "Heating now", className: "status-heating", icon: ICONS.flame };
        }
        if (value.includes("cool")) {
          return { label: value.includes("prep") || value.includes("pending") ? "Getting ready to cool" : "Cooling now", className: "status-cooling", icon: ICONS.snow };
        }
        if (value.includes("fan")) {
          return { label: "Fan running", className: "status-fan", icon: ICONS.fan };
        }
        if (value === "idle" || value === "off") {
          return { label: "Standing by", className: "status-idle", icon: ICONS.pause };
        }
        return {
          label: value.replaceAll("_", " ").replace(/^\\w/, (c) => c.toUpperCase()),
          className: "status-idle",
          icon: ICONS.pause,
        };
      }

      function presetIcon(preset) {
        return ICONS[preset] || ICONS.home;
      }

      function presetLabel(preset) {
        if (preset === "resume") return "Back to schedule";
        return scheduleLabel(preset);
      }

      function syncFanBars(card, zone) {
        const barsIndex = fanBarsIndex(zone);
        card.querySelectorAll(".stat-chip .fan-bar").forEach((bar, index) => {
          const lit = barsIndex > 0 && index < (barsIndex === 1 ? 1 : barsIndex === 2 ? 2 : 4);
          bar.classList.toggle("active", lit);
          bar.classList.toggle("auto", false);
        });
      }

      function syncFanTile(card, zone) {
        const readout = card.querySelector("[data-fan-readout]");
        if (readout) readout.textContent = fanDisplayText(zone);
        syncFanBars(card, zone);
      }

      function syncFanSetting(card, zone) {
        const pending = fanPendingValue(card);
        if (pending) {
          if (fanValuesMatch(zone.fan, pending)) {
            clearFanPending(card);
          } else {
            return;
          }
        }
        const slider = card.querySelector('[data-field="fan"]');
        if (slider && document.activeElement === slider) return;
        applyFanSettingUi(card, zone.fan || "auto");
      }

      function syncFanControl(card, zone) {
        syncFanTile(card, zone);
        syncFanSetting(card, zone);
      }

      function syncZoneReadout(card, zone) {
        const status = conditioningInfo(zone.conditioning);
        const badge = card.querySelector("[data-status-badge]");
        if (badge) {
          badge.className = "status-badge " + status.className;
          badge.innerHTML = status.icon + " " + escapeHtml(status.label);
        }
        const schedule = card.querySelector("[data-schedule-readout]");
        if (schedule) schedule.textContent = scheduleLabel(zone.hold ? zone.hold_activity : zone.activity);
        const humidityBar = card.querySelector("[data-humidity-bar]");
        const humidityValue = card.querySelector("[data-humidity-value]");
        const humidity = Number(zone.humidity);
        if (humidityValue) {
          humidityValue.textContent = Number.isFinite(humidity) ? humidity + "%" : "—";
        }
        if (humidityBar) {
          humidityBar.style.width = Number.isFinite(humidity) ? Math.max(0, Math.min(100, humidity)) + "%" : "0%";
        }
        const widget = card.querySelector(".thermo-widget");
        if (widget) {
          const indoor = parseTemp(zone.temperature_display ?? zone.temperature, parseTemp(widget.dataset.indoor, 68));
          widget.dataset.indoor = String(indoor);
          updateThermoWidget(widget);
        }
        syncFanControl(card, zone);
      }

      function updateZoneCardsFromData(zones) {
        const zoneCards = document.getElementById("zone-cards");
        for (const zone of zones) {
          const card = zoneCards.querySelector('.zone-control-card[data-zone-id="' + CSS.escape(zone.id) + '"]');
          if (!card || card.dataset.dragging === "true") continue;
          syncZoneReadout(card, zone);
        }
      }

      function renderThermoScale() {
        return [90, 80, 70, 60].map((temp) =>
          '<div class="thermo-tick thermo-tick-major"><span class="thermo-tick-label">' + temp + '</span><span class="thermo-tick-mark"></span></div>'
        ).join("");
      }

      function renderThermoInnerTicks() {
        return [60, 70, 80, 90].map((temp) =>
          '<span class="thermo-inner-tick" style="bottom:' + tempToBottom(temp) + '%"></span>'
        ).join("");
      }

      function updateThermoWidget(widget) {
        const heatHandle = widget.querySelector(".thermo-handle-heat");
        const coolHandle = widget.querySelector(".thermo-handle-cool");
        const fill = widget.querySelector(".thermo-fill");
        const zoneHeat = widget.querySelector(".thermo-zone-heat");
        const zoneCool = widget.querySelector(".thermo-zone-cool");
        const heat = parseTemp(heatHandle.dataset.value, 68);
        const cool = parseTemp(coolHandle.dataset.value, 74);
        const indoor = parseTemp(widget.dataset.indoor, heat);
        const heatBottom = tempToBottom(heat);
        const coolBottom = tempToBottom(cool);
        const indoorBottom = tempToBottom(indoor);

        heatHandle.dataset.value = String(heat);
        coolHandle.dataset.value = String(cool);
        const heatLabel = heatHandle.querySelector(".thermo-flag-label");
        const coolLabel = coolHandle.querySelector(".thermo-flag-label");
        if (heatLabel) heatLabel.textContent = heat + "°";
        if (coolLabel) coolLabel.textContent = cool + "°";
        heatHandle.style.bottom = heatBottom + "%";
        coolHandle.style.bottom = coolBottom + "%";
        if (fill) fill.style.height = indoorBottom + "%";
        if (zoneHeat) zoneHeat.style.height = heatBottom + "%";
        if (zoneCool) zoneCool.style.height = (100 - coolBottom) + "%";
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
        const track = widget.querySelector(".thermo-tube");
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
        } else if ("fan" in payload) {
          clearFanPending(card);
          loadDashboard({ soft: true });
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
        if (!slider || slider.dataset.initialized === "true") return;
        slider.dataset.initialized = "true";

        const fanFromSlider = () => FAN_LEVELS[Number.parseInt(slider.value, 10)] || "auto";

        const syncLabel = () => {
          applyFanSettingUi(card, fanFromSlider());
        };

        const markFanPending = () => {
          setFanPending(card, fanFromSlider());
          syncLabel();
        };

        slider.addEventListener("pointerdown", markFanPending);
        slider.addEventListener("input", markFanPending);
        slider.addEventListener("change", async () => {
          const fan = fanFromSlider();
          setFanPending(card, fan);
          syncLabel();
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

      function renderFanBars(zone) {
        const barsIndex = fanBarsIndex(zone);
        return [0, 1, 2, 3].map((index) => {
          const lit = barsIndex > 0 && index < (barsIndex === 1 ? 1 : barsIndex === 2 ? 2 : 4);
          const classes = "fan-bar" + (lit ? " active" : "");
          return '<span class="' + classes + '"></span>';
        }).join("");
      }

      function renderZoneCard(zone, systemMode) {
        const normalizedMode = normalizeMode(systemMode);
        const temp = zone.temperature_display ?? (zone.temperature ?? "—");
        const humidity = zone.humidity ?? "—";
        const heat = parseTemp(zone.heat_setpoint_display ?? zone.heat_setpoint, 68);
        const cool = parseTemp(zone.cool_setpoint_display ?? zone.cool_setpoint, 74);
        const indoor = parseTemp(zone.temperature_display ?? zone.temperature, heat);
        const fanIndex = fanToIndex(zone.fan);
        const fanText = fanDisplayText(zone);
        const fanSettingText = fanSettingLabel(zone);
        const activePreset = (zone.hold ? zone.hold_activity : zone.activity) || "";
        const status = conditioningInfo(zone.conditioning);
        const scheduleText = scheduleLabel(zone.hold ? zone.hold_activity : zone.activity);
        const humidityWidth = Number.isFinite(Number(zone.humidity)) ? Math.max(0, Math.min(100, Number(zone.humidity))) : 0;
        const presetTiles = (zone.presets || []).map((preset) =>
          '<button type="button" class="preset-tile' + (preset === activePreset ? " active" : "") + '" data-preset="' + escapeHtml(preset) + '">' + presetIcon(preset) + '<span>' + escapeHtml(presetLabel(preset)) + "</span></button>"
        ).join("");

        return \`
          <div class="card zone-control-card mode-\${escapeHtml(normalizedMode)}" data-zone-id="\${escapeHtml(zone.id)}" data-system-mode="\${escapeHtml(normalizedMode)}">
            <div class="zone-hero">
              <div>
                <h3>\${escapeHtml(zone.name)}</h3>
                <div class="status-badge \${status.className}" data-status-badge>\${status.icon} \${escapeHtml(status.label)}</div>
              </div>
              <div class="zone-hero-temp">
                <div>
                  <span class="temp-display">\${temp}</span><span class="temp-unit">\${temp === "—" ? "" : "°F"}</span>
                </div>
                <span class="temp-caption">Inside right now</span>
              </div>
            </div>
            <div class="stat-chips">
              <div class="stat-chip">
                \${ICONS.droplet}
                <span class="chip-label">Humidity</span>
                <span class="chip-value" data-humidity-value>\${humidity}\${humidity === "—" ? "" : "%"}</span>
                <div class="mini-bar"><span data-humidity-bar style="width:\${humidityWidth}%"></span></div>
              </div>
              <div class="stat-chip">
                \${ICONS.fan}
                <span class="chip-label">Blower</span>
                <span class="chip-value" data-fan-readout>\${escapeHtml(fanText)}</span>
                <div class="fan-bars">\${renderFanBars(zone)}</div>
              </div>
              <div class="stat-chip">
                \${ICONS.calendar}
                <span class="chip-label">Schedule</span>
                <span class="chip-value" data-schedule-readout>\${escapeHtml(scheduleText)}</span>
              </div>
            </div>
            <div class="zone-control-layout">
              <div>
                <div class="section-title">\${ICONS.thermostat} Slide the flags to adjust</div>
                <div
                  class="thermo-widget"
                  data-indoor="\${indoor}"
                  data-heat="\${heat}"
                  data-cool="\${cool}"
                >
                  <div class="thermo-scale" aria-hidden="true">\${renderThermoScale()}</div>
                  <div class="thermo-body">
                    <div class="thermo-tube">
                      <div class="thermo-glass">
                        <div class="thermo-zone thermo-zone-heat"></div>
                        <div class="thermo-zone thermo-zone-cool"></div>
                        <div class="thermo-fill" title="Inside now: \${indoor}°F"><span class="thermo-fill-cap"></span></div>
                        <div class="thermo-inner-ticks">\${renderThermoInnerTicks()}</div>
                        <div class="thermo-shine"></div>
                      </div>
                      <button type="button" class="thermo-handle thermo-handle-heat" data-value="\${heat}" aria-label="Heat to \${heat} degrees"><span class="thermo-flag-stem"></span><span class="thermo-flag-label">\${heat}°</span></button>
                      <button type="button" class="thermo-handle thermo-handle-cool" data-value="\${cool}" aria-label="Cool to \${cool} degrees"><span class="thermo-flag-stem"></span><span class="thermo-flag-label">\${cool}°</span></button>
                    </div>
                    <div class="thermo-bulb" aria-hidden="true"></div>
                  </div>
                </div>
                <div class="thermo-legend"><span>Heat</span><span>Red = inside now</span><span>Cool</span></div>
              </div>
              <div class="zone-side-panel">
                <div class="fan-control">
                  <div class="section-title">\${ICONS.fan} Blower speed <span data-fan-label style="margin-left:auto;color:var(--accent)">\${escapeHtml(fanSettingText)}</span></div>
                  <input type="range" min="0" max="3" step="1" value="\${fanIndex}" data-field="fan" aria-label="Blower speed" />
                  <div class="fan-ticks">
                    <span class="\${fanIndex === 0 ? "active" : ""}">Auto</span>
                    <span class="\${fanIndex === 1 ? "active" : ""}">Low</span>
                    <span class="\${fanIndex === 2 ? "active" : ""}">Med</span>
                    <span class="\${fanIndex === 3 ? "active" : ""}">High</span>
                  </div>
                </div>
                <div>
                  <div class="section-title">\${ICONS.home} Quick settings</div>
                  <div class="preset-tiles">\${presetTiles}</div>
                </div>
                <div class="message zone-message"></div>
              </div>
            </div>
          </div>
        \`;
      }

      function renderModeTiles(currentMode) {
        const active = normalizeMode(currentMode);
        const modes = [
          { id: "heat", label: "Heat", hint: "Warm up", icon: ICONS.flame },
          { id: "cool", label: "Cool", hint: "Cool down", icon: ICONS.snow },
          { id: "auto", label: "Auto", hint: "Picks for you", icon: ICONS.auto },
          { id: "off", label: "Off", hint: "Paused", icon: ICONS.power },
        ];
        return modes.map((mode) =>
          '<button type="button" class="mode-tile mode-tile-' + mode.id + (active === mode.id ? " active" : "") + '" data-mode="' + mode.id + '">' +
            mode.icon + "<span>" + mode.label + '</span><small>' + mode.hint + "</small></button>"
        ).join("");
      }

      function updateActiveSystemLabel(data) {
        const label = document.getElementById("active-system-label");
        if (!label) return;
        if (!data.system) {
          label.textContent = "";
          return;
        }
        const match = (data.systems || []).find((item) => item.serial === data.system.serial);
        const carrierName = match?.name || data.system.name;
        const model = match?.model || data.system.model;
        label.innerHTML = "Controlling <strong>" + escapeHtml(carrierName) + "</strong>" +
          (model ? " · " + escapeHtml(model) : "") +
          " · <span class=\\"muted\\">" + escapeHtml(data.system.serial) + "</span>";
      }

      async function loadDashboard(options = {}) {
        const pill = document.getElementById("connection-pill");
        const systemCards = document.getElementById("system-cards");
        const zoneCards = document.getElementById("zone-cards");
        const zoneDragging = Boolean(zoneCards.querySelector('[data-dragging="true"]'));
        const zoneFanPending = Boolean(zoneCards.querySelector("[data-fan-pending]"));
        try {
          const res = await fetch("/api/status");
          const data = await res.json();
          updateActiveSystemLabel(data);
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
            const filterWidth = Number.isFinite(Number(filter)) ? Math.max(0, Math.min(100, Number(filter))) : 0;
            systemCards.innerHTML = \`
              <div class="card">
                <h3>What should it do?</h3>
                <p class="muted" style="margin:0.35rem 0 0;font-size:0.88rem">Now: <strong>\${escapeHtml(modeLabel(mode))}</strong></p>
                <div class="mode-tiles">\${renderModeTiles(mode)}</div>
                <div class="message" id="mode-message"></div>
              </div>
              <div class="card weather-card">
                <div class="weather-row">
                  <div class="weather-icon-wrap">\${ICONS.sun}</div>
                  <div>
                    <div class="temp-label">Outside</div>
                    <div class="temp-display" style="font-size:2rem;margin:0">\${outdoor}\${outdoor === "—" ? "" : unitLabel}</div>
                  </div>
                </div>
                <div class="filter-life">
                  <div class="filter-life-row">
                    <span>\${ICONS.filter} Air filter</span>
                    <span>\${filter === "—" ? "—" : filter + "% left"}</span>
                  </div>
                  <div class="filter-bar-track"><span class="filter-bar-fill" style="width:\${filterWidth}%"></span></div>
                </div>
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
                message.textContent = modeRes.ok ? "Updated." : (modeData.error || "Could not change mode.");
                if (modeRes.ok) loadDashboard();
              });
            });
          }
          if (!zoneDragging) {
            if (options.soft && zoneCards.querySelector(".zone-control-card")) {
              updateZoneCardsFromData(data.zones);
            } else if (!zoneFanPending) {
              zoneCards.innerHTML = data.zones.map((zone) => renderZoneCard(zone, mode)).join("");
              zoneCards.querySelectorAll(".zone-control-card").forEach(initZoneCard);
            }
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
          Thermostat to control
          <select id="system_serial" name="system_serial">
            <option value="">Loading systems…</option>
          </select>
        </label>
        <p class="muted" style="margin:-0.35rem 0 0.85rem;font-size:0.85rem">
          Pick which Carrier/Bryant system this app connects to. Names come from your Carrier account.
        </p>
        <label>
          Dashboard label
          <input id="system_name" name="system_name" value="${escapeHtml(settings.system_name)}" />
        </label>
        <p class="muted" style="margin:-0.35rem 0 0.85rem;font-size:0.85rem">
          Optional nickname shown on the dashboard only. It does not change which thermostat is controlled.
        </p>
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
      const savedSystemSerial = ${JSON.stringify(settings.system_serial)};

      function escapeHtml(value) {
        return String(value)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;");
      }

      async function loadSystemPicker() {
        const select = document.getElementById("system_serial");
        try {
          const res = await fetch("/api/status");
          const data = await res.json();
          const systems = data.systems || [];
          if (!systems.length) {
            select.innerHTML = '<option value="">No systems found on this account</option>';
            return;
          }
          select.innerHTML = systems.map((system) => {
            const label = system.name + " · " + system.serial + (system.model ? " · " + system.model : "");
            const selected = system.serial === savedSystemSerial ? " selected" : "";
            return '<option value="' + escapeHtml(system.serial) + '"' + selected + ">" + escapeHtml(label) + "</option>";
          }).join("");
        } catch (error) {
          select.innerHTML = '<option value="">Could not load systems</option>';
        }
      }

      loadSystemPicker();

      document.getElementById("settings-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const message = document.getElementById("settings-message");
        const form = event.target;
        const res = await fetch("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            system_name: form.system_name.value.trim(),
            system_serial: form.system_serial.value.trim(),
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
      const systems = await client.loadSystems();
      if (next.system_serial && !systems.some((system) => system.profile.serial === next.system_serial)) {
        sendJson(res, 400, { error: "Selected thermostat was not found on your Carrier account" });
        return;
      }
      resetCloudConnections();
      await saveSettings(next);
      cachedSystems = systems;
      lastSyncAt = new Date();
      lastLiveUpdateAt = null;
      lastError = null;
      ensureRealtime(next);
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