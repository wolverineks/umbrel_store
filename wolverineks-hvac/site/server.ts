import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const APP_VERSION = "1.0.3";
const DATA_ROOT = process.env.HVAC_DATA_DIR ?? "/data";
const SETTINGS_PATH = path.join(DATA_ROOT, "settings.json");
const INFINITUDE_URLS = Array.from(
  new Set(
    [
      process.env.INFINITUDE_URL,
      "http://wolverineks-hvac_infinitude_1:3000",
      "http://infinitude:3000",
    ]
      .filter((value): value is string => Boolean(value?.trim()))
      .map((value) => value.replace(/\/$/, "")),
  ),
);
const PROXY_PORT = process.env.PROXY_PORT?.trim() || "4035";
const ICON_PATH = path.join(__dirname, "icon.svg");

type Settings = {
  umbrel_lan_ip: string;
  system_name: string;
};

type InfinitudeZone = {
  id?: number | number[];
  name?: string | string[];
  rt?: number | number[];
  rh?: number | number[];
  htsp?: number | number[];
  clsp?: number | number[];
  fan?: string | string[];
  hold?: string | string[];
  holdActivity?: string | string[];
  currentActivity?: string | string[];
  zoneconditioning?: string | string[];
  damperposition?: number | number[];
  otmr?: string | string[];
};

type InfinitudeStatus = {
  mode?: string | string[];
  oat?: number | number[];
  filtrhvac?: number | number[];
  filtrhvacremtime?: number | number[];
  zones?: Array<{ zone?: InfinitudeZone[] }>;
};

const DEFAULT_SETTINGS: Settings = {
  umbrel_lan_ip: "",
  system_name: "Home HVAC",
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function firstValue<T>(value: T | T[] | undefined): T | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

function asNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function asString(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value);
}

async function loadSettings(): Promise<Settings> {
  if (!existsSync(SETTINGS_PATH)) {
    return { ...DEFAULT_SETTINGS };
  }
  try {
    const raw = await readFile(SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      umbrel_lan_ip: parsed.umbrel_lan_ip?.trim() ?? "",
      system_name: parsed.system_name?.trim() || DEFAULT_SETTINGS.system_name,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function saveSettings(settings: Settings): Promise<void> {
  await mkdir(DATA_ROOT, { recursive: true });
  await writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

function normalizeInfinitudeStatus(payload: unknown): InfinitudeStatus | null {
  if (payload === null || payload === undefined) {
    return null;
  }
  if (typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.status) && record.status[0] && typeof record.status[0] === "object") {
    return record.status[0] as InfinitudeStatus;
  }
  if (record.zones || record.mode || record.oat) {
    return record as InfinitudeStatus;
  }
  return null;
}

async function infinitudeFetch(
  route: string,
  init?: RequestInit,
  timeoutMs = 10000,
): Promise<Response> {
  let lastError: Error | null = null;
  for (const baseUrl of INFINITUDE_URLS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${baseUrl}${route}`, { ...init, signal: controller.signal });
      clearTimeout(timer);
      return response;
    } catch (error) {
      clearTimeout(timer);
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError ?? new Error("No Infinitude backends configured");
}

async function checkInfinitudeAlive(): Promise<{ alive: boolean; error: string | null; backend: string | null }> {
  let lastError: string | null = null;
  for (const baseUrl of INFINITUDE_URLS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`${baseUrl}/Alive`, { signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok) {
        lastError = `${baseUrl} returned HTTP ${response.status}`;
        continue;
      }
      const text = (await response.text()).trim();
      if (text === "alive") {
        return { alive: true, error: null, backend: baseUrl };
      }
      lastError = `${baseUrl} returned unexpected health response`;
    } catch (error) {
      clearTimeout(timer);
      lastError = error instanceof Error ? `${baseUrl}: ${error.message}` : String(error);
    }
  }
  return { alive: false, error: lastError, backend: null };
}

function parseZones(status: InfinitudeStatus): Array<Record<string, unknown>> {
  const zones = status.zones?.[0]?.zone ?? [];
  return zones.map((zone, index) => ({
    id: asNumber(firstValue(zone.id)) ?? index + 1,
    name: asString(firstValue(zone.name)) || `Zone ${index + 1}`,
    temperature: asNumber(firstValue(zone.rt)),
    humidity: asNumber(firstValue(zone.rh)),
    heat_setpoint: asNumber(firstValue(zone.htsp)),
    cool_setpoint: asNumber(firstValue(zone.clsp)),
    fan: asString(firstValue(zone.fan)),
    hold: asString(firstValue(zone.hold)),
    hold_activity: asString(firstValue(zone.holdActivity)),
    activity: asString(firstValue(zone.currentActivity)),
    conditioning: asString(firstValue(zone.zoneconditioning)),
    damper: asNumber(firstValue(zone.damperposition)),
    hold_until: asString(firstValue(zone.otmr)),
  }));
}

function isConnected(status: InfinitudeStatus | null): boolean {
  if (!status) return false;
  const zones = status.zones?.[0]?.zone ?? [];
  return zones.length > 0 && zones.some((zone) => asNumber(firstValue(zone.rt)) !== null);
}

async function getInfinitudeTraffic(): Promise<{
  keys: string[];
  thermostat_seen: boolean;
  has_status: boolean;
  has_config: boolean;
}> {
  try {
    const response = await infinitudeFetch("/api/state_keys");
    if (!response.ok) {
      return { keys: [], thermostat_seen: false, has_status: false, has_config: false };
    }
    const keys = (await response.json()) as string[];
    const normalized = Array.isArray(keys) ? keys : [];
    const hasStatus = normalized.some((key) => key === "status.json" || key.startsWith("status"));
    const hasConfig = normalized.some((key) => key === "systems.xml" || key === "systems.json");
    return {
      keys: normalized,
      thermostat_seen: hasStatus || hasConfig,
      has_status: hasStatus,
      has_config: hasConfig,
    };
  } catch {
    return { keys: [], thermostat_seen: false, has_status: false, has_config: false };
  }
}

async function getInfinitudeStatus(): Promise<{
  proxy_online: boolean;
  connected: boolean;
  status: InfinitudeStatus | null;
  zones: Array<Record<string, unknown>>;
  error: string | null;
  backend: string | null;
  traffic: Awaited<ReturnType<typeof getInfinitudeTraffic>>;
}> {
  const health = await checkInfinitudeAlive();
  if (!health.alive) {
    return {
      proxy_online: false,
      connected: false,
      status: null,
      zones: [],
      error: health.error ?? "Infinitude proxy is not reachable",
      backend: null,
      traffic: { keys: [], thermostat_seen: false, has_status: false, has_config: false },
    };
  }

  const traffic = await getInfinitudeTraffic();

  try {
    const response = await infinitudeFetch("/api/status/");
    if (!response.ok) {
      return {
        proxy_online: true,
        connected: false,
        status: null,
        zones: [],
        error: `Infinitude returned HTTP ${response.status}`,
        backend: health.backend,
        traffic,
      };
    }
    const payload = await response.json();
    const status = normalizeInfinitudeStatus(payload);
    if (!status) {
      return {
        proxy_online: true,
        connected: false,
        status: null,
        zones: [],
        error: null,
        backend: health.backend,
        traffic,
      };
    }
    return {
      proxy_online: true,
      connected: isConnected(status),
      status,
      zones: parseZones(status),
      error: null,
      backend: health.backend,
      traffic,
    };
  } catch (error) {
    return {
      proxy_online: false,
      connected: false,
      status: null,
      zones: [],
      error: error instanceof Error ? error.message : String(error),
      backend: health.backend,
      traffic,
    };
  }
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
      --heat: #f97316;
      --cool: #38bdf8;
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
    input, select, button, textarea {
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
    .steps {
      display: grid;
      gap: 0.75rem;
      margin: 1rem 0;
    }
    .step {
      border: 1px solid var(--border);
      border-radius: 0.85rem;
      padding: 1rem;
      background: var(--panel);
    }
    .step strong { display: block; margin-bottom: 0.35rem; }
    .controls {
      display: grid;
      gap: 0.75rem;
      margin-top: 1rem;
    }
    .control-row {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
      align-items: end;
    }
    .control-row label { flex: 1 1 8rem; margin-bottom: 0; }
    .message {
      margin-top: 0.75rem;
      font-size: 0.9rem;
    }
    .message.error { color: var(--danger); }
    .message.success { color: var(--success); }
    @media (max-width: 900px) {
      .layout { grid-template-columns: 1fr; }
      .sidebar { position: static; height: auto; }
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
          <p>Local thermostat control</p>
        </div>
      </div>
      <nav>${navHtml}</nav>
    </aside>
    <main class="main">${content}</main>
  </div>
  <script>
    const themeKey = "hvac-theme";
    const savedTheme = localStorage.getItem(themeKey);
    if (savedTheme === "dark") document.documentElement.dataset.theme = "dark";
  </script>
</body>
</html>`;
}

function setupContent(settings: Settings): string {
  const proxyHost = settings.umbrel_lan_ip
    ? escapeHtml(settings.umbrel_lan_ip)
    : "your-umbrel-lan-ip";
  const proxyPort = escapeHtml(PROXY_PORT);
  const proxyTestUrl = settings.umbrel_lan_ip
    ? `http://${escapeHtml(settings.umbrel_lan_ip)}:${proxyPort}`
    : "";

  return `
    <div class="toolbar">
      <h2>Setup</h2>
      <span class="status-pill warning" id="connection-pill">Checking connection…</span>
    </div>
    <div class="card">
      <h3>No thermostat IP needed</h3>
      <p class="muted">
        Bryant/Carrier Infinity and Evolution thermostats connect <em>to</em> your Umbrel
        through an HTTP proxy. You only need your Umbrel's LAN address.
      </p>
      <form id="setup-form">
        <label>
          Umbrel LAN IP address
          <input id="umbrel_lan_ip" name="umbrel_lan_ip" value="${escapeHtml(settings.umbrel_lan_ip)}" placeholder="192.168.1.42" required />
        </label>
        <p class="muted">Find this in your router's DHCP client list or Umbrel network settings.</p>
        <button type="submit">Save LAN IP</button>
        <div class="message" id="setup-message"></div>
      </form>
    </div>
    <div class="card" style="margin-top:1rem">
      <h3>Configure thermostat proxy</h3>
      <p class="muted">On your thermostat touchscreen:</p>
      <div class="steps">
        <div class="step"><strong>1.</strong> Open <em>Menu → Settings → Wireless → Advanced</em> on the thermostat touchscreen</div>
        <div class="step"><strong>2.</strong> Set <em>Proxy Server</em> to <code>${proxyHost}</code> (IP only, no port suffix)</div>
        <div class="step"><strong>3.</strong> Set <em>Proxy Port</em> to <code>${proxyPort}</code> (or <code>4036</code> if your docs mention port 3000)</div>
        <div class="step"><strong>4.</strong> Save, then reboot the thermostat if data does not appear within 2 minutes</div>
      </div>
      ${proxyTestUrl ? `<p class="muted">From a phone on the same WiFi, open <a href="${proxyTestUrl}" target="_blank" rel="noopener">${proxyTestUrl}</a>. You should see the Infinitude page.</p>` : ""}
      <p class="muted">
        Umbrel and the thermostat must be on the same local network. Do not use a hostname here —
        use the numeric LAN IP.
      </p>
    </div>
    <div class="card" style="margin-top:1rem">
      <h3>If thermostat traffic stays at none</h3>
      <div class="steps">
        <div class="step"><strong>Check firmware.</strong> On the thermostat open <em>Menu → Settings → About</em> and note the version. Local proxy often stops working at firmware <strong>4.17+</strong> (MQTT cloud update).</div>
        <div class="step"><strong>Clear and re-save proxy.</strong> Blank out proxy server/port, save, reboot, then enter IP <code>${proxyHost}</code> and port <code>${proxyPort}</code> again.</div>
        <div class="step"><strong>Try alternate menus.</strong> Some models use <em>Settings → Network → Advanced</em> or <em>Dealer Settings → Wireless → Proxy</em> instead.</div>
        <div class="step"><strong>Confirm the phone app still works.</strong> If the Carrier/Bryant app is offline too, fix WiFi on the thermostat first.</div>
        <div class="step"><strong>Leave proxy port blank?</strong> Some installs default to port 80. We do not expose 80 on Umbrel, so the port field must be <code>${proxyPort}</code> or <code>4036</code>, not empty.</div>
      </div>
    </div>
    <div class="card" style="margin-top:1rem">
      <h3>Diagnostics</h3>
      <div class="stat-row"><span class="muted">Infinitude proxy</span><span id="diag-proxy">Checking…</span></div>
      <div class="stat-row"><span class="muted">Thermostat traffic</span><span id="diag-traffic">Checking…</span></div>
      <div class="stat-row"><span class="muted">Thermostat data</span><span id="diag-thermostat">Checking…</span></div>
      <div class="stat-row"><span class="muted">Backend</span><span id="diag-backend">—</span></div>
      <p class="muted message" id="diag-error" style="margin-top:0.75rem"></p>
    </div>
    <script>
      async function refreshConnection() {
        const pill = document.getElementById("connection-pill");
        const diagProxy = document.getElementById("diag-proxy");
        const diagTraffic = document.getElementById("diag-traffic");
        const diagThermostat = document.getElementById("diag-thermostat");
        const diagBackend = document.getElementById("diag-backend");
        const diagError = document.getElementById("diag-error");
        try {
          const res = await fetch("/api/status");
          const data = await res.json();
          diagBackend.textContent = data.backend || "—";
          if (data.connected) {
            pill.className = "status-pill success";
            pill.textContent = "Connected (" + data.zones.length + " zone" + (data.zones.length === 1 ? "" : "s") + ")";
            diagProxy.textContent = "Online";
            diagTraffic.textContent = "Seen by proxy";
            diagThermostat.textContent = "Receiving data";
            diagError.textContent = "";
          } else if (data.proxy_online) {
            pill.className = "status-pill warning";
            pill.textContent = "Proxy online — waiting for thermostat";
            diagProxy.textContent = "Online";
            if (data.traffic?.thermostat_seen) {
              diagTraffic.textContent = "Seen, waiting for status";
              diagThermostat.textContent = "Partial data only";
              diagError.textContent = "The thermostat has reached Umbrel, but full status is not available yet. Wait a few minutes or reboot the thermostat.";
            } else {
              diagTraffic.textContent = "None detected";
              diagThermostat.textContent = "No thermostat data yet";
              diagError.textContent = "Proxy is healthy. Set proxy server to your Umbrel IP, proxy port to ${proxyPort}, save on the thermostat, then wait 1–2 minutes.";
            }
          } else {
            pill.className = "status-pill error";
            pill.textContent = "Proxy offline";
            diagProxy.textContent = "Offline";
            diagThermostat.textContent = "Unavailable";
            diagError.textContent = data.error || "Infinitude container is not reachable from the app.";
          }
        } catch (error) {
          pill.className = "status-pill error";
          pill.textContent = "Cannot reach backend";
          diagProxy.textContent = "Unknown";
          diagThermostat.textContent = "Unknown";
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
            umbrel_lan_ip: form.umbrel_lan_ip.value.trim(),
            system_name: form.system_name?.value?.trim() || undefined,
          }),
        });
        const data = await res.json();
        message.className = "message " + (res.ok ? "success" : "error");
        message.textContent = res.ok ? "Saved." : (data.error || "Could not save settings.");
        if (res.ok) location.reload();
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
      function escapeHtml(value) {
        return String(value)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;");
      }

      function modeLabel(mode) {
        if (!mode) return "Unknown";
        return mode.charAt(0).toUpperCase() + mode.slice(1);
      }

      function renderZoneCard(zone) {
        const temp = zone.temperature ?? "—";
        const humidity = zone.humidity ?? "—";
        const heat = zone.heat_setpoint ?? "—";
        const cool = zone.cool_setpoint ?? "—";
        return \`
          <div class="card" data-zone-id="\${zone.id}">
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
                  <select data-field="preset">
                    <option value="home">Home</option>
                    <option value="away">Away</option>
                    <option value="sleep">Sleep</option>
                    <option value="wake">Wake</option>
                    <option value="hold">Hold manual</option>
                    <option value="schedule">Resume schedule</option>
                  </select>
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
        const zoneId = Number(card.dataset.zoneId);
        const message = card.querySelector(".zone-message");
        const heat = card.querySelector('[data-field="heat_setpoint"]').value;
        const cool = card.querySelector('[data-field="cool_setpoint"]').value;
        const fan = card.querySelector('[data-field="fan"]').value;
        const preset = card.querySelector('[data-field="preset"]').value;
        const res = await fetch("/api/zone/" + zoneId, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ heat_setpoint: heat, cool_setpoint: cool, fan, preset }),
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
          if (!data.connected) {
            if (data.proxy_online) {
              pill.className = "status-pill warning";
              pill.textContent = "Proxy online — waiting for thermostat";
            } else {
              pill.className = "status-pill error";
              pill.textContent = data.error ? "Proxy offline" : "Not connected";
            }
            const detail = data.proxy_online
              ? "The Infinitude proxy is running, but no thermostat data has arrived yet. Finish proxy setup on the <a href=\"/setup\">Setup page</a>."
              : (data.error
                ? "Infinitude proxy is offline: " + escapeHtml(data.error) + ". Check that the app restarted cleanly, then open <a href=\"/setup\">Setup</a>."
                : "Finish setup on the <a href=\"/setup\">Setup page</a> and configure your thermostat proxy.");
            systemCards.innerHTML = '<div class="card"><h3>Not connected yet</h3><p class="muted">' + detail + '</p></div>';
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

function settingsContent(settings: Settings): string {
  const proxyTarget = settings.umbrel_lan_ip
    ? `${escapeHtml(settings.umbrel_lan_ip)}:${escapeHtml(PROXY_PORT)}`
    : "(set LAN IP first)";

  return `
    <div class="toolbar"><h2>Settings</h2></div>
    <div class="card">
      <form id="settings-form">
        <label>
          System name
          <input id="system_name" name="system_name" value="${escapeHtml(settings.system_name)}" />
        </label>
        <label>
          Umbrel LAN IP address
          <input id="umbrel_lan_ip" name="umbrel_lan_ip" value="${escapeHtml(settings.umbrel_lan_ip)}" placeholder="192.168.1.42" />
        </label>
        <p class="muted">Thermostat proxy target: <strong>${proxyTarget}</strong></p>
        <p class="muted">Advanced schedules: <a href="http://${escapeHtml(settings.umbrel_lan_ip || "umbrel-local")}:${escapeHtml(PROXY_PORT)}" target="_blank" rel="noopener">Open Infinitude UI</a></p>
        <button type="submit">Save settings</button>
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
            umbrel_lan_ip: form.umbrel_lan_ip.value.trim(),
            system_name: form.system_name.value.trim(),
          }),
        });
        const data = await res.json();
        message.className = "message " + (res.ok ? "success" : "error");
        message.textContent = res.ok ? "Saved." : (data.error || "Could not save settings.");
        if (res.ok) setTimeout(() => location.reload(), 500);
      });
    </script>
  `;
}

async function handleApi(
  route: string,
  req: IncomingMessage,
  res: ServerResponse,
  settings: Settings,
): Promise<void> {
  if (route === "/api/status" && req.method === "GET") {
    const snapshot = await getInfinitudeStatus();
    const mode = asString(firstValue(snapshot.status?.mode));
    sendJson(res, 200, {
      connected: snapshot.connected,
      proxy_online: snapshot.proxy_online,
      error: snapshot.error,
      backend: snapshot.backend,
      settings,
      proxy_port: PROXY_PORT,
      infinitude_urls: INFINITUDE_URLS,
      system: {
        mode: mode.toLowerCase(),
        outdoor_temp: asNumber(firstValue(snapshot.status?.oat)),
        filter_remaining: asNumber(firstValue(snapshot.status?.filtrhvacremtime))
          ?? asNumber(firstValue(snapshot.status?.filtrhvac)),
      },
      zones: snapshot.zones,
      traffic: snapshot.traffic,
    });
    return;
  }

  if (route === "/api/settings" && req.method === "GET") {
    sendJson(res, 200, { settings, proxy_port: PROXY_PORT });
    return;
  }

  if (route === "/api/settings" && req.method === "PUT") {
    const body = JSON.parse((await readBody(req)).toString("utf8")) as Partial<Settings>;
    const next = {
      umbrel_lan_ip: body.umbrel_lan_ip?.trim() ?? settings.umbrel_lan_ip,
      system_name: body.system_name?.trim() || settings.system_name,
    };
    await saveSettings(next);
    sendJson(res, 200, { settings: next, proxy_port: PROXY_PORT });
    return;
  }

  if (route === "/api/mode" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)).toString("utf8")) as { mode?: string };
    const mode = body.mode?.trim().toLowerCase();
    if (!mode || !["heat", "cool", "auto", "off"].includes(mode)) {
      sendJson(res, 400, { error: "mode must be heat, cool, auto, or off" });
      return;
    }
    const params = new URLSearchParams({ mode });
    const response = await infinitudeFetch("/api/mode", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const payload = await response.json().catch(() => ({}));
    sendJson(res, response.ok ? 200 : 502, response.ok ? payload : { error: "Infinitude mode update failed", details: payload });
    return;
  }

  const zoneMatch = route.match(/^\/api\/zone\/(\d+)$/);
  if (zoneMatch && req.method === "POST") {
    const zoneId = zoneMatch[1];
    const body = JSON.parse((await readBody(req)).toString("utf8")) as {
      heat_setpoint?: string | number;
      cool_setpoint?: string | number;
      fan?: string;
      preset?: string;
    };

    if (body.preset) {
      const preset = body.preset.toLowerCase();
      const holdParams = new URLSearchParams();
      if (preset === "schedule") {
        holdParams.set("hold", "off");
        holdParams.set("activity", "home");
      } else if (preset === "hold") {
        holdParams.set("hold", "on");
        holdParams.set("activity", "manual");
        holdParams.set("until", "forever");
      } else if (["home", "away", "sleep", "wake"].includes(preset)) {
        holdParams.set("hold", "on");
        holdParams.set("activity", preset);
      }
      const holdResponse = await infinitudeFetch(`/api/${zoneId}/hold?${holdParams.toString()}`, { method: "GET" });
      if (!holdResponse.ok) {
        sendJson(res, 502, { error: "Preset update failed" });
        return;
      }
    }

    const activityParams = new URLSearchParams();
    if (body.heat_setpoint !== undefined && body.heat_setpoint !== "") {
      activityParams.set("htsp", String(body.heat_setpoint));
    }
    if (body.cool_setpoint !== undefined && body.cool_setpoint !== "") {
      activityParams.set("clsp", String(body.cool_setpoint));
    }
    if (body.fan) {
      activityParams.set("fan", body.fan);
    }
    if ([...activityParams.keys()].length > 0) {
      const activityResponse = await infinitudeFetch(
        `/api/${zoneId}/activity/manual?${activityParams.toString()}`,
        { method: "GET" },
      );
      if (!activityResponse.ok) {
        sendJson(res, 502, { error: "Zone update failed" });
        return;
      }
      const payload = await activityResponse.json().catch(() => ({}));
      sendJson(res, 200, payload);
      return;
    }

    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const route = url.pathname;
  const settings = await loadSettings();

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

  if (route === "/setup") {
    sendText(res, 200, "text/html; charset=utf-8", renderPage("setup", setupContent(settings)));
    return;
  }

  if (route === "/settings") {
    sendText(res, 200, "text/html; charset=utf-8", renderPage("settings", settingsContent(settings)));
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
});