import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  buildDiagnostics,
  discoverRobots,
  fetchCredentialsFromCloud,
  getRobotPreferences,
  getRobotSchedule,
  getRobotStatus,
  runRobotAction,
  testConnection,
  type ConnectionMode,
  type RobotSettings,
} from "./roomba-client";

const APP_VERSION = "1.0.0";
const IS_LOCAL_DEV = process.env.ROOMBA_DEV === "1";
const DATA_ROOT = process.env.ROOMBA_DATA_DIR ?? "/data";
const SETTINGS_PATH = path.join(DATA_ROOT, "settings.json");
const ICON_PATH = path.join(__dirname, "icon.svg");
const PORT = Number(process.env.PORT ?? 3000);

type PublicSettings = {
  robot_ip: string;
  robot_name: string;
  firmware_version: string;
  connection_mode: ConnectionMode;
  live_poll_seconds: number;
  configured: boolean;
  blid_preview: string | null;
};

const DEFAULT_SETTINGS: RobotSettings = {
  robot_ip: process.env.ROOMBA_IP?.trim() || "",
  blid: "",
  password: "",
  robot_name: "Roomba",
  firmware_version: "3",
  connection_mode: "on_demand",
  live_poll_seconds: 0,
};

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

async function ensureDataDir(): Promise<void> {
  await mkdir(DATA_ROOT, { recursive: true });
}

function isConfigured(settings: RobotSettings): boolean {
  return Boolean(settings.robot_ip.trim() && settings.blid.trim() && settings.password.trim());
}

function publicSettings(settings: RobotSettings): PublicSettings {
  return {
    robot_ip: settings.robot_ip,
    robot_name: settings.robot_name,
    firmware_version: settings.firmware_version,
    connection_mode: settings.connection_mode,
    live_poll_seconds: settings.live_poll_seconds,
    configured: isConfigured(settings),
    blid_preview: settings.blid ? `${settings.blid.slice(0, 4)}…${settings.blid.slice(-4)}` : null,
  };
}

async function loadSettings(): Promise<RobotSettings> {
  if (!existsSync(SETTINGS_PATH)) {
    return { ...DEFAULT_SETTINGS };
  }
  try {
    const raw = await readFile(SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<RobotSettings>;
    return {
      robot_ip: parsed.robot_ip?.trim() || DEFAULT_SETTINGS.robot_ip,
      blid: parsed.blid?.trim() || "",
      password: parsed.password?.trim() || "",
      robot_name: parsed.robot_name?.trim() || DEFAULT_SETTINGS.robot_name,
      firmware_version: parsed.firmware_version?.trim() || DEFAULT_SETTINGS.firmware_version,
      connection_mode: parsed.connection_mode === "live" ? "live" : "on_demand",
      live_poll_seconds:
        typeof parsed.live_poll_seconds === "number" && parsed.live_poll_seconds >= 0
          ? parsed.live_poll_seconds
          : 0,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function saveSettings(settings: RobotSettings): Promise<void> {
  await ensureDataDir();
  await writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2));
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

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const raw = await readBody(req);
  if (!raw.length) return {} as T;
  return JSON.parse(raw.toString("utf8")) as T;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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
      --accent: #0284c7;
      --accent-soft: #e0f2fe;
      --success: #16a34a;
      --danger: #dc2626;
      --shadow: 0 10px 30px rgba(15, 23, 42, 0.08);
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
      grid-template-columns: 220px 1fr;
      min-height: 100vh;
    }
    .sidebar {
      background: #0f172a;
      color: #e2e8f0;
      padding: 24px 18px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 28px;
    }
    .brand img { width: 36px; height: 36px; border-radius: 10px; }
    .brand strong { display: block; font-size: 15px; }
    .brand span { color: #94a3b8; font-size: 12px; }
    .nav a {
      display: block;
      color: #cbd5e1;
      text-decoration: none;
      padding: 10px 12px;
      border-radius: 10px;
      margin-bottom: 6px;
    }
    .nav a.active, .nav a:hover { background: rgba(56, 189, 248, 0.15); color: #fff; }
    .content { padding: 28px; }
    .panel {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 16px;
      box-shadow: var(--shadow);
      padding: 22px;
      margin-bottom: 18px;
    }
    h1, h2 { margin: 0 0 12px; }
    h1 { font-size: 28px; }
    h2 { font-size: 18px; }
    p, .muted { color: var(--muted); line-height: 1.5; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 14px;
    }
    .stat {
      background: var(--accent-soft);
      border-radius: 14px;
      padding: 16px;
    }
    .stat .label { color: var(--muted); font-size: 13px; }
    .stat .value { font-size: 24px; font-weight: 700; margin-top: 6px; }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 16px; }
    button, .button {
      border: 0;
      border-radius: 10px;
      padding: 10px 14px;
      font-weight: 600;
      cursor: pointer;
      background: var(--accent);
      color: #fff;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    button.secondary, .button.secondary {
      background: #e2e8f0;
      color: #0f172a;
    }
    button.danger { background: var(--danger); }
    label { display: block; font-size: 13px; color: var(--muted); margin-bottom: 6px; }
    input, select {
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px 12px;
      margin-bottom: 14px;
      font: inherit;
      background: #fff;
    }
    .notice {
      background: #eff6ff;
      border: 1px solid #bfdbfe;
      color: #1e3a8a;
      border-radius: 12px;
      padding: 14px 16px;
      margin-bottom: 16px;
    }
    .error {
      background: #fef2f2;
      border: 1px solid #fecaca;
      color: #991b1b;
      border-radius: 12px;
      padding: 14px 16px;
      margin-top: 12px;
      display: none;
    }
    .success {
      background: #f0fdf4;
      border: 1px solid #bbf7d0;
      color: #166534;
      border-radius: 12px;
      padding: 14px 16px;
      margin-top: 12px;
      display: none;
    }
    table { width: 100%; border-collapse: collapse; }
    th, td {
      text-align: left;
      padding: 10px 8px;
      border-bottom: 1px solid var(--border);
      font-size: 14px;
    }
    @media (max-width: 900px) {
      .layout { grid-template-columns: 1fr; }
      .sidebar { padding-bottom: 10px; }
      .nav { display: flex; flex-wrap: wrap; gap: 6px; }
      .nav a { margin: 0; }
    }
  `;
}

function layout(page: string, title: string, body: string): string {
  const nav = [
    ["dashboard", "Dashboard", "/"],
    ["setup", "Setup", "/setup"],
    ["schedule", "Schedule", "/schedule"],
    ["settings", "Settings", "/settings"],
    ["diagnostics", "Diagnostics", "/diagnostics"],
  ]
    .map(
      ([id, label, href]) =>
        `<a href="${href}" class="${page === id ? "active" : ""}">${label}</a>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} · Roomba</title>
  <style>${pageStyles()}</style>
</head>
<body>
  <div class="layout">
    <aside class="sidebar">
      <div class="brand">
        <img src="/icon.svg" alt="" />
        <div>
          <strong>Roomba Local</strong>
          <span>v${APP_VERSION}</span>
        </div>
      </div>
      <nav class="nav">${nav}</nav>
    </aside>
    <main class="content">
      <h1>${escapeHtml(title)}</h1>
      ${body}
    </main>
  </div>
</body>
</html>`;
}

function dashboardPage(): string {
  return layout(
    "dashboard",
    "Dashboard",
    `
    <div class="notice">
      This app uses short local MQTT connections so your official iRobot app can keep working through iRobot cloud.
      Close the iRobot app on your phone only while running setup or if a command fails with a connection error.
    </div>
    <div class="panel">
      <div class="grid" id="stats">
        <div class="stat"><div class="label">Battery</div><div class="value" id="battery">—</div></div>
        <div class="stat"><div class="label">Phase</div><div class="value" id="phase">—</div></div>
        <div class="stat"><div class="label">Cycle</div><div class="value" id="cycle">—</div></div>
        <div class="stat"><div class="label">Bin</div><div class="value" id="bin">—</div></div>
      </div>
      <p class="muted" id="meta">Loading status…</p>
      <div class="actions">
        <button type="button" id="refresh">Refresh status</button>
        <button type="button" data-action="clean">Start clean</button>
        <button type="button" class="secondary" data-action="pause">Pause</button>
        <button type="button" class="secondary" data-action="resume">Resume</button>
        <button type="button" class="secondary" data-action="stop">Stop</button>
        <button type="button" class="danger" data-action="dock">Dock</button>
      </div>
      <div class="error" id="error"></div>
      <div class="success" id="success"></div>
    </div>
    <script>
      const errorEl = document.getElementById("error");
      const successEl = document.getElementById("success");
      function showError(message) {
        errorEl.style.display = message ? "block" : "none";
        errorEl.textContent = message || "";
        if (message) successEl.style.display = "none";
      }
      function showSuccess(message) {
        successEl.style.display = message ? "block" : "none";
        successEl.textContent = message || "";
        if (message) errorEl.style.display = "none";
      }
      async function loadStatus() {
        const response = await fetch("/api/status");
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Failed to load status");
        document.getElementById("battery").textContent =
          data.battery_percent == null ? "—" : data.battery_percent + "%";
        document.getElementById("phase").textContent = data.phase || "—";
        document.getElementById("cycle").textContent = data.cycle || "—";
        const bin =
          data.bin_full == null ? "—" : data.bin_full ? "Full" : data.bin_present === false ? "Missing" : "OK";
        document.getElementById("bin").textContent = bin;
        document.getElementById("meta").textContent = data.connected
          ? (data.robot_name || "Roomba") + " · " + (data.software_version || "unknown firmware") + " · synced " + new Date(data.last_sync).toLocaleString()
          : data.error || "Robot not connected";
        if (!data.connected && data.error) showError(data.error);
      }
      async function runAction(action) {
        showError("");
        showSuccess("");
        const response = await fetch("/api/action/" + action, { method: "POST" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Action failed");
        showSuccess(action.charAt(0).toUpperCase() + action.slice(1) + " sent.");
        await loadStatus();
      }
      document.getElementById("refresh").addEventListener("click", () => {
        loadStatus().catch((error) => showError(error.message));
      });
      document.querySelectorAll("[data-action]").forEach((button) => {
        button.addEventListener("click", () => {
          runAction(button.getAttribute("data-action")).catch((error) => showError(error.message));
        });
      });
      loadStatus().catch((error) => showError(error.message));
    </script>
    `,
  );
}

function setupPage(): string {
  return layout(
    "setup",
    "Setup",
    `
    <div class="notice">
      Close the iRobot mobile app on your phone before discovering or fetching credentials.
      The robot only allows one local MQTT connection at a time.
    </div>
    <div class="panel">
      <h2>1. Discover robot on LAN</h2>
      <p class="muted">UDP discovery finds Roombas on your local network. You can also enter the IP manually below.</p>
      <button type="button" id="discover">Discover robots</button>
      <pre id="discover-results" class="muted" style="white-space:pre-wrap"></pre>
    </div>
    <div class="panel">
      <h2>2. Fetch credentials from iRobot cloud</h2>
      <p class="muted">One-time login. Your iRobot account password is not saved — only the robot BLID and MQTT password are stored locally.</p>
      <label for="irobot-user">iRobot account email</label>
      <input id="irobot-user" type="email" autocomplete="username" />
      <label for="irobot-pass">iRobot account password</label>
      <input id="irobot-pass" type="password" autocomplete="current-password" />
      <button type="button" id="fetch-credentials">Fetch credentials</button>
    </div>
    <div class="panel">
      <h2>3. Save robot settings</h2>
      <label for="robot-name">Robot name</label>
      <input id="robot-name" value="Roomba" />
      <label for="robot-ip">Robot IP</label>
      <input id="robot-ip" placeholder="192.168.1.100" />
      <label for="robot-blid">BLID</label>
      <input id="robot-blid" />
      <label for="robot-password">Robot MQTT password</label>
      <input id="robot-password" />
      <label for="firmware-version">Firmware protocol</label>
      <select id="firmware-version">
        <option value="3" selected>v3 (J7, i7, s9, most current models)</option>
        <option value="2">v2 (older 900 series)</option>
      </select>
      <div class="actions">
        <button type="button" id="test-connection">Test connection</button>
        <button type="button" id="save-setup">Save settings</button>
      </div>
      <div class="error" id="error"></div>
      <div class="success" id="success"></div>
    </div>
    <script>
      const errorEl = document.getElementById("error");
      const successEl = document.getElementById("success");
      function showError(message) {
        errorEl.style.display = message ? "block" : "none";
        errorEl.textContent = message || "";
        if (message) successEl.style.display = "none";
      }
      function showSuccess(message) {
        successEl.style.display = message ? "block" : "none";
        successEl.textContent = message || "";
        if (message) errorEl.style.display = "none";
      }
      document.getElementById("discover").addEventListener("click", () => {
        showError("");
        fetch("/api/setup/discover", { method: "POST" })
          .then((response) => response.json().then((data) => ({ response, data })))
          .then(({ response, data }) => {
            if (!response.ok) throw new Error(data.error || "Discovery failed");
            document.getElementById("discover-results").textContent = JSON.stringify(data.robots, null, 2);
            if (data.robots?.[0]) {
              document.getElementById("robot-ip").value = data.robots[0].ip || "";
              document.getElementById("robot-name").value = data.robots[0].robotname || "Roomba";
              if (data.robots[0].blid) document.getElementById("robot-blid").value = data.robots[0].blid;
            }
          })
          .catch((error) => showError(error.message));
      });
      document.getElementById("fetch-credentials").addEventListener("click", () => {
        showError("");
        fetch("/api/setup/fetch-credentials", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: document.getElementById("irobot-user").value,
            password: document.getElementById("irobot-pass").value,
          }),
        })
          .then((response) => response.json().then((data) => ({ response, data })))
          .then(({ response, data }) => {
            if (!response.ok) throw new Error(data.error || "Credential fetch failed");
            const robot = data.robots?.[0];
            if (!robot) throw new Error("No robots returned");
            document.getElementById("robot-name").value = robot.robot_name || "Roomba";
            document.getElementById("robot-blid").value = robot.blid || "";
            document.getElementById("robot-password").value = robot.password || "";
            document.getElementById("firmware-version").value = robot.firmware_version || "3";
            showSuccess("Credentials fetched for " + (robot.robot_name || "robot") + ". Add the robot IP if needed, then test and save.");
          })
          .catch((error) => showError(error.message));
      });
      async function currentPayload() {
        return {
          robot_name: document.getElementById("robot-name").value,
          robot_ip: document.getElementById("robot-ip").value,
          blid: document.getElementById("robot-blid").value,
          password: document.getElementById("robot-password").value,
          firmware_version: document.getElementById("firmware-version").value,
          connection_mode: "on_demand",
          live_poll_seconds: 0,
        };
      }
      document.getElementById("test-connection").addEventListener("click", () => {
        showError("");
        currentPayload()
          .then((payload) =>
            fetch("/api/setup/test", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            }),
          )
          .then((response) => response.json().then((data) => ({ response, data })))
          .then(({ response, data }) => {
            if (!response.ok) throw new Error(data.error || "Connection test failed");
            showSuccess("Connected to " + (data.robot_name || "robot") + " with " + (data.battery_percent ?? "?") + "% battery.");
          })
          .catch((error) => showError(error.message));
      });
      document.getElementById("save-setup").addEventListener("click", () => {
        showError("");
        currentPayload()
          .then((payload) =>
            fetch("/api/settings", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            }),
          )
          .then((response) => response.json().then((data) => ({ response, data })))
          .then(({ response, data }) => {
            if (!response.ok) throw new Error(data.error || "Save failed");
            showSuccess("Settings saved. Open the dashboard to control your Roomba.");
          })
          .catch((error) => showError(error.message));
      });
    </script>
    `,
  );
}

function schedulePage(): string {
  return layout(
    "schedule",
    "Schedule",
    `
    <div class="panel">
      <p class="muted">Read-only view from the robot. Edit schedules in the official iRobot app if you want them synced through iRobot cloud.</p>
      <button type="button" id="refresh-schedule">Refresh schedule</button>
      <div id="schedule-table"></div>
      <div class="error" id="error"></div>
    </div>
    <script>
      const days = ${JSON.stringify(DAY_NAMES)};
      const errorEl = document.getElementById("error");
      function showError(message) {
        errorEl.style.display = message ? "block" : "none";
        errorEl.textContent = message || "";
      }
      async function loadSchedule() {
        const response = await fetch("/api/schedule");
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Failed to load schedule");
        const week = data.schedule || {};
        const cycles = Array.isArray(week.cycle) ? week.cycle : [];
        const hours = Array.isArray(week.h) ? week.h : [];
        const minutes = Array.isArray(week.m) ? week.m : [];
        let rows = "";
        for (let i = 0; i < 7; i += 1) {
          const cycle = cycles[i] || "none";
          const time =
            cycle === "none" ? "—" : String(hours[i] ?? 0).padStart(2, "0") + ":" + String(minutes[i] ?? 0).padStart(2, "0");
          rows += "<tr><td>" + days[i] + "</td><td>" + cycle + "</td><td>" + time + "</td></tr>";
        }
        document.getElementById("schedule-table").innerHTML =
          "<table><thead><tr><th>Day</th><th>Cycle</th><th>Time</th></tr></thead><tbody>" + rows + "</tbody></table>";
      }
      document.getElementById("refresh-schedule").addEventListener("click", () => {
        loadSchedule().catch((error) => showError(error.message));
      });
      loadSchedule().catch((error) => showError(error.message));
    </script>
    `,
  );
}

function settingsPage(): string {
  return layout(
    "settings",
    "Settings",
    `
    <div class="panel">
      <div id="settings-form"></div>
      <div class="actions">
        <button type="button" id="save-settings">Save settings</button>
      </div>
      <div class="error" id="error"></div>
      <div class="success" id="success"></div>
    </div>
    <script>
      const errorEl = document.getElementById("error");
      const successEl = document.getElementById("success");
      function showError(message) {
        errorEl.style.display = message ? "block" : "none";
        errorEl.textContent = message || "";
        if (message) successEl.style.display = "none";
      }
      function showSuccess(message) {
        successEl.style.display = message ? "block" : "none";
        successEl.textContent = message || "";
        if (message) errorEl.style.display = "none";
      }
      async function loadSettings() {
        const response = await fetch("/api/settings");
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Failed to load settings");
        const settings = data.settings;
        document.getElementById("settings-form").innerHTML = \`
          <label>Robot name</label><input id="robot-name" value="\${settings.robot_name || "Roomba"}" />
          <label>Robot IP</label><input id="robot-ip" value="\${settings.robot_ip || ""}" />
          <label>BLID preview</label><input value="\${settings.blid_preview || "not saved"}" disabled />
          <label>Firmware protocol</label>
          <select id="firmware-version">
            <option value="3" \${settings.firmware_version === "3" ? "selected" : ""}>v3</option>
            <option value="2" \${settings.firmware_version === "2" ? "selected" : ""}>v2</option>
          </select>
          <label>Connection mode</label>
          <select id="connection-mode">
            <option value="on_demand" \${settings.connection_mode === "on_demand" ? "selected" : ""}>On demand (recommended)</option>
            <option value="live" \${settings.connection_mode === "live" ? "selected" : ""}>Live (blocks app local access)</option>
          </select>
          <label>Auto-refresh seconds (0 = manual only)</label>
          <input id="live-poll-seconds" type="number" min="0" step="1" value="\${settings.live_poll_seconds || 0}" />
          <label>Robot MQTT password (leave blank to keep saved password)</label>
          <input id="robot-password" type="password" placeholder="unchanged" />
        \`;
      }
      document.getElementById("save-settings").addEventListener("click", async () => {
        showError("");
        const payload = {
          robot_name: document.getElementById("robot-name").value,
          robot_ip: document.getElementById("robot-ip").value,
          firmware_version: document.getElementById("firmware-version").value,
          connection_mode: document.getElementById("connection-mode").value,
          live_poll_seconds: Number(document.getElementById("live-poll-seconds").value || 0),
        };
        const password = document.getElementById("robot-password").value;
        if (password) payload.password = password;
        const response = await fetch("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Save failed");
        showSuccess("Settings saved.");
        await loadSettings();
      });
      loadSettings().catch((error) => showError(error.message));
    </script>
    `,
  );
}

function diagnosticsPage(): string {
  return layout(
    "diagnostics",
    "Diagnostics",
    `
    <div class="panel">
      <button type="button" id="refresh-diagnostics">Refresh diagnostics</button>
      <pre id="diagnostics" class="muted" style="white-space:pre-wrap; margin-top:16px"></pre>
      <div class="error" id="error"></div>
    </div>
    <script>
      const errorEl = document.getElementById("error");
      function showError(message) {
        errorEl.style.display = message ? "block" : "none";
        errorEl.textContent = message || "";
      }
      async function loadDiagnostics() {
        const response = await fetch("/api/diagnostics");
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Failed to load diagnostics");
        document.getElementById("diagnostics").textContent = JSON.stringify(data, null, 2);
      }
      document.getElementById("refresh-diagnostics").addEventListener("click", () => {
        loadDiagnostics().catch((error) => showError(error.message));
      });
      loadDiagnostics().catch((error) => showError(error.message));
    </script>
    `,
  );
}

function mergeSettings(current: RobotSettings, patch: Partial<RobotSettings>): RobotSettings {
  return {
    robot_ip: patch.robot_ip?.trim() ?? current.robot_ip,
    blid: patch.blid?.trim() ?? current.blid,
    password: patch.password?.trim() ? patch.password.trim() : current.password,
    robot_name: patch.robot_name?.trim() || current.robot_name || "Roomba",
    firmware_version: patch.firmware_version?.trim() || current.firmware_version || "3",
    connection_mode: patch.connection_mode === "live" ? "live" : patch.connection_mode === "on_demand" ? "on_demand" : current.connection_mode,
    live_poll_seconds:
      typeof patch.live_poll_seconds === "number" && patch.live_poll_seconds >= 0
        ? patch.live_poll_seconds
        : current.live_poll_seconds,
  };
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const pathname = url.pathname;
  const method = req.method ?? "GET";

  if (method === "GET" && pathname === "/icon.svg") {
    try {
      const icon = await readFile(ICON_PATH);
      res.writeHead(200, { "Content-Type": "image/svg+xml", "Content-Length": icon.length });
      res.end(icon);
      return;
    } catch {
      sendText(res, 404, "text/plain", "Not found");
      return;
    }
  }

  if (method === "GET" && (pathname === "/" || pathname === "/dashboard")) {
    sendText(res, 200, "text/html; charset=utf-8", dashboardPage());
    return;
  }
  if (method === "GET" && pathname === "/setup") {
    sendText(res, 200, "text/html; charset=utf-8", setupPage());
    return;
  }
  if (method === "GET" && pathname === "/schedule") {
    sendText(res, 200, "text/html; charset=utf-8", schedulePage());
    return;
  }
  if (method === "GET" && pathname === "/settings") {
    sendText(res, 200, "text/html; charset=utf-8", settingsPage());
    return;
  }
  if (method === "GET" && pathname === "/diagnostics") {
    sendText(res, 200, "text/html; charset=utf-8", diagnosticsPage());
    return;
  }

  const settings = await loadSettings();

  if (method === "GET" && pathname === "/api/status") {
    sendJson(res, 200, await getRobotStatus(settings));
    return;
  }

  if (method === "GET" && pathname === "/api/schedule") {
    try {
      const schedule = await getRobotSchedule(settings);
      sendJson(res, 200, { schedule });
    } catch (error) {
      sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (method === "GET" && pathname === "/api/preferences") {
    try {
      const preferences = await getRobotPreferences(settings);
      sendJson(res, 200, { preferences });
    } catch (error) {
      sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (method === "GET" && pathname === "/api/settings") {
    sendJson(res, 200, { settings: publicSettings(settings) });
    return;
  }

  if (method === "PUT" && pathname === "/api/settings") {
    try {
      const patch = await readJson<Partial<RobotSettings>>(req);
      const next = mergeSettings(settings, patch);
      if (!isConfigured(next)) {
        sendJson(res, 400, { error: "robot_ip, blid, and password are required" });
        return;
      }
      await saveSettings(next);
      sendJson(res, 200, { settings: publicSettings(next) });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (method === "POST" && pathname === "/api/setup/discover") {
    try {
      const robots = await discoverRobots();
      sendJson(res, 200, { robots });
    } catch (error) {
      sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (method === "POST" && pathname === "/api/setup/fetch-credentials") {
    try {
      const body = await readJson<{ username?: string; password?: string }>(req);
      if (!body.username?.trim() || !body.password?.trim()) {
        sendJson(res, 400, { error: "username and password are required" });
        return;
      }
      const result = await fetchCredentialsFromCloud(body.username, body.password);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (method === "POST" && pathname === "/api/setup/test") {
    try {
      const body = await readJson<Partial<RobotSettings>>(req);
      const candidate = mergeSettings(settings, body);
      if (!isConfigured(candidate)) {
        sendJson(res, 400, { error: "robot_ip, blid, and password are required" });
        return;
      }
      const status = await testConnection(candidate);
      if (!status.connected) {
        sendJson(res, 502, { error: status.error || "Connection test failed" });
        return;
      }
      sendJson(res, 200, status);
    } catch (error) {
      sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (method === "GET" && pathname === "/api/diagnostics") {
    const diagnostics = await buildDiagnostics(settings, existsSync(SETTINGS_PATH));
    sendJson(res, 200, diagnostics);
    return;
  }

  if (method === "POST" && pathname.startsWith("/api/action/")) {
    const action = pathname.replace("/api/action/", "") as "clean" | "pause" | "resume" | "stop" | "dock";
    if (!["clean", "pause", "resume", "stop", "dock"].includes(action)) {
      sendJson(res, 404, { error: "Unknown action" });
      return;
    }
    try {
      await runRobotAction(settings, action);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

async function main(): Promise<void> {
  await ensureDataDir();
  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((error) => {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Roomba app listening on ${PORT}${IS_LOCAL_DEV ? " (dev)" : ""}`);
  });
}

void main();