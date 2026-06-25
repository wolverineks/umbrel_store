"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_http_1 = require("node:http");
const promises_1 = require("node:fs/promises");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const roomba_client_1 = require("./roomba-client");
const APP_VERSION = "1.1.2";
const IS_LOCAL_DEV = process.env.ROOMBA_DEV === "1";
const DATA_ROOT = process.env.ROOMBA_DATA_DIR ?? "/data";
const SETTINGS_PATH = node_path_1.default.join(DATA_ROOT, "settings.json");
const ICON_PATH = node_path_1.default.join(__dirname, "icon.svg");
const PORT = Number(process.env.PORT ?? 3000);
const DEFAULT_SETTINGS = {
    robot_ip: process.env.ROOMBA_IP?.trim() || "",
    blid: "",
    password: "",
    robot_name: "Roomba",
    firmware_version: "3",
    connection_mode: "on_demand",
    live_poll_seconds: 0,
    irobot_username: "",
    irobot_password: "",
};
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
async function ensureDataDir() {
    await (0, promises_1.mkdir)(DATA_ROOT, { recursive: true });
}
function isConfigured(settings) {
    return Boolean(settings.robot_ip.trim() && settings.blid.trim() && settings.password.trim());
}
function publicSettings(settings) {
    return {
        robot_ip: settings.robot_ip,
        robot_name: settings.robot_name,
        firmware_version: settings.firmware_version,
        connection_mode: settings.connection_mode,
        live_poll_seconds: settings.live_poll_seconds,
        configured: isConfigured(settings),
        blid_preview: settings.blid ? `${settings.blid.slice(0, 4)}…${settings.blid.slice(-4)}` : null,
        irobot_username: settings.irobot_username,
        cloud_account_configured: Boolean(settings.irobot_username.trim() && settings.irobot_password.trim()),
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
            robot_ip: parsed.robot_ip?.trim() || DEFAULT_SETTINGS.robot_ip,
            blid: parsed.blid?.trim() || "",
            password: parsed.password?.trim() || "",
            robot_name: parsed.robot_name?.trim() || DEFAULT_SETTINGS.robot_name,
            firmware_version: parsed.firmware_version?.trim() || DEFAULT_SETTINGS.firmware_version,
            connection_mode: parsed.connection_mode === "live" ? "live" : "on_demand",
            live_poll_seconds: typeof parsed.live_poll_seconds === "number" && parsed.live_poll_seconds >= 0
                ? parsed.live_poll_seconds
                : 0,
            irobot_username: parsed.irobot_username?.trim() || "",
            irobot_password: parsed.irobot_password?.trim() || "",
        };
    }
    catch {
        return { ...DEFAULT_SETTINGS };
    }
}
async function saveSettings(settings) {
    await ensureDataDir();
    await (0, promises_1.writeFile)(SETTINGS_PATH, JSON.stringify(settings, null, 2));
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
async function readJson(req) {
    const raw = await readBody(req);
    if (!raw.length)
        return {};
    return JSON.parse(raw.toString("utf8"));
}
function escapeHtml(value) {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
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
      --accent: #0284c7;
      --accent-hover: #0369a1;
      --accent-active: #075985;
      --accent-soft: #e0f2fe;
      --success: #16a34a;
      --danger: #dc2626;
      --danger-hover: #b91c1c;
      --danger-active: #991b1b;
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
      display: flex;
      flex-direction: column;
      min-height: 100vh;
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
      transition: background-color 0.15s ease, color 0.15s ease, transform 0.1s ease;
    }
    .nav a:hover { background: rgba(56, 189, 248, 0.15); color: #fff; }
    .nav a.active { background: rgba(56, 189, 248, 0.22); color: #fff; }
    .nav a:active { background: rgba(56, 189, 248, 0.3); transform: scale(0.98); }
    .nav a:focus-visible {
      outline: 2px solid #38bdf8;
      outline-offset: 2px;
    }
    .nav { flex: 1; }
    .sidebar-version {
      margin-top: auto;
      padding-top: 18px;
      color: #64748b;
      font-size: 12px;
    }
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
      border-radius: 10px;
      padding: 8px 10px;
      cursor: pointer;
      color: var(--text);
      transition: background-color 0.15s ease, border-color 0.15s ease, transform 0.1s ease, box-shadow 0.15s ease;
      -webkit-tap-highlight-color: transparent;
    }
    .menu-toggle:hover {
      background: var(--accent-soft);
      border-color: #bae6fd;
    }
    .menu-toggle:active {
      background: #bae6fd;
      transform: scale(0.96);
    }
    .menu-toggle:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .menu-toggle .icon {
      width: 20px;
      height: 20px;
    }
    .mobile-header-title {
      flex: 1;
      min-width: 0;
      font-size: 16px;
      font-weight: 700;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .content { padding: 28px; }
    .content > h1 { margin-top: 0; }
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
      transition: background-color 0.15s ease, transform 0.1s ease, box-shadow 0.15s ease, opacity 0.15s ease;
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation;
    }
    button:hover:not(:disabled), .button:hover {
      background: var(--accent-hover);
      box-shadow: 0 2px 8px rgba(2, 132, 199, 0.28);
    }
    button:active:not(:disabled), .button:active {
      background: var(--accent-active);
      transform: scale(0.97);
      box-shadow: none;
    }
    button:focus-visible, .button:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    button.secondary, .button.secondary {
      background: #e2e8f0;
      color: #0f172a;
    }
    button.secondary:hover:not(:disabled), .button.secondary:hover {
      background: #cbd5e1;
      box-shadow: 0 2px 8px rgba(15, 23, 42, 0.08);
    }
    button.secondary:active:not(:disabled), .button.secondary:active {
      background: #94a3b8;
      color: #0f172a;
      transform: scale(0.97);
      box-shadow: none;
    }
    button.danger { background: var(--danger); }
    button.danger:hover:not(:disabled) {
      background: var(--danger-hover);
      box-shadow: 0 2px 8px rgba(220, 38, 38, 0.28);
    }
    button.danger:active:not(:disabled) {
      background: var(--danger-active);
      transform: scale(0.97);
      box-shadow: none;
    }
    button:disabled, .button:disabled {
      opacity: 0.55;
      cursor: not-allowed;
      transform: none;
      box-shadow: none;
    }
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
    .diagnostics-grid {
      display: grid;
      gap: 18px;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      margin-top: 16px;
    }
    .diagnostics-card h3 {
      margin: 0 0 4px;
      font-size: 18px;
    }
    .diagnostics-card .card-hint {
      margin: 0 0 14px;
      font-size: 13px;
    }
    .diagnostics-section h4 {
      margin: 16px 0 8px;
      font-size: 13px;
      font-weight: 700;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .diagnostics-section:first-of-type h4 { margin-top: 0; }
    .stat-row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 8px 0;
      border-bottom: 1px solid var(--border);
      font-size: 14px;
    }
    .stat-row:last-child { border-bottom: 0; }
    .stat-row span:last-child {
      text-align: right;
      word-break: break-word;
      max-width: 58%;
    }
    .diag-ok { color: var(--success); font-weight: 600; }
    .diag-bad { color: var(--danger); font-weight: 600; }
    .diag-errors {
      margin-top: 12px;
      padding: 12px 14px;
      border-radius: 10px;
      background: #fef2f2;
      border: 1px solid #fecaca;
      color: #991b1b;
      font-size: 13px;
    }
    .test-result {
      display: none;
      margin-top: 12px;
      padding: 12px 14px;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 600;
    }
    .test-result.pending {
      display: block;
      background: #eff6ff;
      border: 1px solid #bfdbfe;
      color: #1e3a8a;
    }
    .test-result.success {
      display: block;
      background: #f0fdf4;
      border: 1px solid #bbf7d0;
      color: #166534;
    }
    .test-result.error {
      display: block;
      background: #fef2f2;
      border: 1px solid #fecaca;
      color: #991b1b;
    }
    @media (max-width: 900px) {
      .layout {
        grid-template-columns: 1fr;
        grid-template-rows: auto 1fr;
      }
      .mobile-header {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 14px 16px;
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
      .nav {
        display: block;
        flex: 1;
      }
      .nav a {
        margin-bottom: 6px;
      }
      .content {
        padding: 18px 16px;
        grid-column: 1;
        grid-row: 2;
      }
      .content > h1 {
        display: none;
      }
    }
  `;
}
function layout(page, title, body) {
    const nav = [
        ["dashboard", "Dashboard", "/"],
        ["setup", "Setup", "/setup"],
        ["schedule", "Schedule", "/schedule"],
        ["settings", "Settings", "/settings"],
        ["diagnostics", "Diagnostics", "/diagnostics"],
    ]
        .map(([id, label, href]) => `<a href="${href}" class="nav-link ${page === id ? "active" : ""}">${label}</a>`)
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
    <header class="mobile-header">
      <button type="button" class="menu-toggle" id="menu-toggle" aria-label="Open menu" aria-expanded="false" aria-controls="sidebar">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h16"/>
        </svg>
      </button>
      <div class="mobile-header-title">${escapeHtml(title)}</div>
    </header>
    <div class="sidebar-backdrop" id="sidebar-backdrop" hidden></div>
    <aside class="sidebar" id="sidebar">
      <div class="brand">
        <img src="/icon.svg" alt="" />
        <div>
          <strong>Roomba Local</strong>
        </div>
      </div>
      <nav class="nav">${nav}</nav>
      <div class="sidebar-version">v${APP_VERSION}</div>
    </aside>
    <main class="content">
      <h1>${escapeHtml(title)}</h1>
      ${body}
    </main>
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
function dashboardPage() {
    return layout("dashboard", "Dashboard", `
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
        document.getElementById("meta").textContent = "Loading status…";
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
        if (data.connected) {
          showError("");
          document.getElementById("meta").textContent =
            (data.robot_name || "Roomba") + " · " + (data.software_version || "unknown firmware") + " · synced " + new Date(data.last_sync).toLocaleString();
        } else {
          const message = data.error || "Robot not connected";
          document.getElementById("meta").textContent = message;
          showError(message);
        }
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
    `);
}
function setupPage() {
    return layout("setup", "Setup", `
    <div class="notice">
      Close the iRobot mobile app on your phone before discovering or fetching credentials.
      The robot only allows one local MQTT connection at a time.
    </div>
    <div class="panel">
      <h2>1. Discover robot on LAN</h2>
      <p class="muted">UDP discovery finds Roombas on your local network. On Umbrel this may take up to 10 seconds and scans common subnets. You can also enter the IP manually below.</p>
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
      <div id="test-result" class="test-result" role="status" aria-live="polite"></div>
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
      function setTestResult(state, message) {
        const testResultEl = document.getElementById("test-result");
        if (!state) {
          testResultEl.className = "test-result";
          testResultEl.textContent = "";
          showError("");
          showSuccess("");
          return;
        }
        testResultEl.className = "test-result " + state;
        testResultEl.textContent = message || "";
        if (state === "success") {
          showSuccess(message);
        } else if (state === "error") {
          showError(message);
        }
      }
      document.getElementById("discover").addEventListener("click", () => {
        const discoverButton = document.getElementById("discover");
        setTestResult("");
        showError("");
        discoverButton.disabled = true;
        discoverButton.textContent = "Discovering…";
        fetch("/api/setup/discover", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ robot_ip: document.getElementById("robot-ip").value }),
        })
          .then((response) => response.json().then((data) => ({ response, data })))
          .then(({ response, data }) => {
            if (!response.ok) throw new Error(data.error || "Discovery failed");
            document.getElementById("discover-results").textContent = JSON.stringify(data.robots, null, 2);
            if (!data.robots?.length) {
              showError("No robots found. Enter your Roomba IP manually, or set ROOMBA_SCAN_SUBNETS on Umbrel.");
            } else {
              showSuccess("Found " + data.robots.length + " robot(s).");
            }
            if (data.robots?.[0]) {
              document.getElementById("robot-ip").value = data.robots[0].ip || "";
              document.getElementById("robot-name").value = data.robots[0].robotname || "Roomba";
              if (data.robots[0].blid) document.getElementById("robot-blid").value = data.robots[0].blid;
            }
          })
          .catch((error) => showError(error.message))
          .finally(() => {
            discoverButton.disabled = false;
            discoverButton.textContent = "Discover robots";
          });
      });
      document.getElementById("fetch-credentials").addEventListener("click", () => {
        setTestResult("");
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
        const payload = {
          robot_name: document.getElementById("robot-name").value,
          robot_ip: document.getElementById("robot-ip").value,
          blid: document.getElementById("robot-blid").value,
          password: document.getElementById("robot-password").value,
          firmware_version: document.getElementById("firmware-version").value,
          connection_mode: "on_demand",
          live_poll_seconds: 0,
          irobot_username: document.getElementById("irobot-user").value,
        };
        const irobotPassword = document.getElementById("irobot-pass").value;
        if (irobotPassword) payload.irobot_password = irobotPassword;
        return payload;
      }
      document.getElementById("test-connection").addEventListener("click", () => {
        const testButton = document.getElementById("test-connection");
        setTestResult("pending", "Testing connection to the robot…");
        testButton.disabled = true;
        testButton.textContent = "Testing…";
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
            if (!data.connected) throw new Error(data.error || "Robot did not connect");
            setTestResult(
              "success",
              "Connection successful — " +
                (data.robot_name || "Roomba") +
                " responded with " +
                (data.battery_percent ?? "?") +
                "% battery.",
            );
          })
          .catch((error) => setTestResult("error", error.message || "Connection test failed"))
          .finally(() => {
            testButton.disabled = false;
            testButton.textContent = "Test connection";
          });
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
    `);
}
function schedulePage() {
    return layout("schedule", "Schedule", `
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
    `);
}
function settingsPage() {
    return layout("settings", "Settings", `
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
          <h2 style="margin-top:18px">iRobot cloud (optional)</h2>
          <p class="muted" style="margin-top:0">Used for the iRobot section on Diagnostics. Same account as the iRobot mobile app.</p>
          <label>iRobot account email</label>
          <input id="irobot-username" type="email" autocomplete="username" value="\${settings.irobot_username || ""}" />
          <label>iRobot account password (leave blank to keep saved password)</label>
          <input id="irobot-password" type="password" autocomplete="current-password" placeholder="\${settings.cloud_account_configured ? "unchanged" : ""}" />
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
          irobot_username: document.getElementById("irobot-username").value,
        };
        const password = document.getElementById("robot-password").value;
        if (password) payload.password = password;
        const irobotPassword = document.getElementById("irobot-password").value;
        if (irobotPassword) payload.irobot_password = irobotPassword;
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
    `);
}
function buildAppDiagnostics(settings) {
    return {
        version: APP_VERSION,
        dev_mode: IS_LOCAL_DEV,
        configured: isConfigured(settings),
        settings: publicSettings(settings),
        runtime: {
            node_version: process.version,
            platform: process.platform,
            arch: process.arch,
            uptime_seconds: Math.round(process.uptime()),
            port: PORT,
            node_env: process.env.NODE_ENV ?? "development",
            data_root: DATA_ROOT,
            settings_file_exists: (0, node_fs_1.existsSync)(SETTINGS_PATH),
        },
        library: {
            dorita980_version: (0, roomba_client_1.getDorita980Version)(),
        },
        connection: {
            mqtt_mutex_busy: (0, roomba_client_1.isMutexBusy)(),
            discovery_busy: (0, roomba_client_1.isDiscoveryBusy)(),
            last_error: (0, roomba_client_1.getLastError)(),
            coexistence_note: "This app connects briefly over local MQTT, then disconnects so the official iRobot app can keep using iRobot cloud.",
        },
    };
}
async function buildDiagnosticsSnapshot(settings) {
    const [roomba, irobot] = await Promise.all([
        (0, roomba_client_1.buildRoombaDiagnostics)(settings),
        (0, roomba_client_1.buildIrobotDiagnostics)(settings),
    ]);
    return {
        generated_at: new Date().toISOString(),
        app: buildAppDiagnostics(settings),
        roomba,
        irobot,
    };
}
function diagnosticsPage() {
    return layout("diagnostics", "Diagnostics", `
    <div class="panel">
      <button type="button" class="secondary" id="refresh-diagnostics">Refresh diagnostics</button>
      <div id="diagnostics-content">
        <p class="muted">Loading diagnostics…</p>
      </div>
      <div class="error" id="error"></div>
    </div>
    <script>
      const errorEl = document.getElementById("error");
      function showError(message) {
        errorEl.style.display = message ? "block" : "none";
        errorEl.textContent = message || "";
      }
      function escapeHtml(value) {
        return String(value)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;");
      }
      function formatValue(value) {
        if (value === null || value === undefined || value === "") return "—";
        return escapeHtml(String(value));
      }
      function formatBool(value, trueLabel, falseLabel) {
        return value
          ? '<span class="diag-ok">' + escapeHtml(trueLabel) + "</span>"
          : '<span class="diag-bad">' + escapeHtml(falseLabel) + "</span>";
      }
      function row(label, valueHtml) {
        return '<div class="stat-row"><span class="muted">' + escapeHtml(label) + '</span><span>' + valueHtml + "</span></div>";
      }
      function section(title, rowsHtml) {
        if (!rowsHtml) return "";
        return '<div class="diagnostics-section"><h4>' + escapeHtml(title) + "</h4>" + rowsHtml + "</div>";
      }
      function card(title, hint, bodyHtml) {
        return '<div class="panel diagnostics-card"><h3>' + escapeHtml(title) + '</h3><p class="muted card-hint">' + escapeHtml(hint) + '</p>' + bodyHtml + "</div>";
      }
      function renderApp(app) {
        const settings = app.settings || {};
        const runtime = app.runtime || {};
        const library = app.library || {};
        const connection = app.connection || {};
        const settingsRows = [
          row("Configured", formatBool(app.configured, "Yes", "No")),
          row("Robot name", formatValue(settings.robot_name)),
          row("Robot IP", formatValue(settings.robot_ip)),
          row("BLID", formatValue(settings.blid_preview)),
          row("Firmware protocol", formatValue(settings.firmware_version)),
          row("Connection mode", formatValue(settings.connection_mode)),
          row("Auto-refresh (s)", formatValue(settings.live_poll_seconds)),
          row("Cloud account", formatBool(settings.cloud_account_configured, "Configured", "Not configured")),
        ].join("");
        const runtimeRows = [
          row("App version", formatValue(app.version)),
          row("Dev mode", formatBool(app.dev_mode, "On", "Off")),
          row("Node.js", formatValue(runtime.node_version)),
          row("Platform", formatValue(runtime.platform + " / " + runtime.arch)),
          row("Uptime", formatValue(runtime.uptime_seconds + "s")),
          row("Port", formatValue(runtime.port)),
          row("NODE_ENV", formatValue(runtime.node_env)),
          row("Data root", formatValue(runtime.data_root)),
          row("Settings file", formatBool(runtime.settings_file_exists, "Present", "Missing")),
        ].join("");
        const libraryRows = row("dorita980", formatValue(library.dorita980_version));
        const connectionRows = [
          row("MQTT mutex busy", formatBool(!connection.mqtt_mutex_busy, "Idle", "Busy")),
          row("Discovery busy", formatBool(!connection.discovery_busy, "Idle", "Busy")),
          row("Last error", formatValue(connection.last_error)),
        ].join("");
        return card(
          "App",
          "Umbrel runtime, saved settings, and local control library.",
          section("Settings", settingsRows) +
          section("Runtime", runtimeRows) +
          section("Library", libraryRows) +
          section("Connection state", connectionRows) +
          (connection.coexistence_note ? '<p class="muted" style="margin-top:12px;font-size:13px">' + escapeHtml(connection.coexistence_note) + "</p>" : "")
        );
      }
      function renderRoomba(roomba) {
        const mqtt = roomba.mqtt || {};
        const device = roomba.device || {};
        const wireless = device.wireless || {};
        const identityRows = [
          row("Configured", formatBool(roomba.configured, "Yes", "No")),
          row("Name", formatValue(roomba.name)),
          row("Host", formatValue(roomba.host)),
          row("Firmware protocol", formatValue(roomba.firmware_protocol)),
        ].join("");
        const mqttRows = [
          row("MQTT host", formatValue(mqtt.host)),
          row("MQTT port", formatValue(mqtt.port)),
          row("TCP reachable", formatBool(mqtt.reachable, "Yes", "No")),
          row("TCP latency", mqtt.latency_ms == null ? "—" : formatValue(mqtt.latency_ms + " ms")),
        ].join("");
        const deviceRows = [
          row("Connected", formatBool(device.connected, "Yes", "No")),
          row("Battery", device.battery_percent == null ? "—" : formatValue(device.battery_percent + "%")),
          row("Phase", formatValue(device.phase)),
          row("Cycle", formatValue(device.cycle)),
          row("Bin", device.bin_full == null ? "—" : formatValue(device.bin_full ? "Full" : "OK")),
          row("Software", formatValue(device.software_version)),
          row("SKU", formatValue(device.sku)),
          row("Cloud env", formatValue(device.cloud_env)),
          row("Wi-Fi status", wireless.wifi == null ? "—" : formatValue(wireless.wifi)),
          row("Cloud link (device)", formatValue(wireless.cloud_status)),
          row("SSID", formatValue(wireless.ssid)),
          row("Last sync", device.last_sync ? formatValue(new Date(device.last_sync).toLocaleString()) : "—"),
          row("Device error", formatValue(device.error)),
        ].join("");
        const errors = Array.isArray(roomba.errors) ? roomba.errors.filter(Boolean) : [];
        const errorsHtml = errors.length
          ? '<div class="diag-errors"><strong>Issues</strong><br>' + errors.map(escapeHtml).join("<br>") + "</div>"
          : "";
        return card(
          "Roomba",
          "Live state fetched from the robot over local MQTT on your LAN.",
          section("Identity", identityRows) +
          section("MQTT", mqttRows) +
          section("Device", deviceRows) +
          errorsHtml
        );
      }
      function renderIrobot(irobot) {
        const endpoints = irobot.endpoints || {};
        const account = irobot.account || {};
        const matched = irobot.matched_robot || null;
        const endpointRows = [
          row("Discovery URL", formatValue(endpoints.discovery_url)),
          row("Discovery reachable", formatBool(endpoints.discovery_reachable, "Yes", "No")),
          row("Discovery latency", endpoints.discovery_latency_ms == null ? "—" : formatValue(endpoints.discovery_latency_ms + " ms")),
          row("Discovery HTTP", formatValue(endpoints.discovery_status)),
          row("Gigya base", formatValue(endpoints.gigya_base)),
          row("iRobot HTTP base", formatValue(endpoints.http_base)),
        ].join("");
        const accountRows = [
          row("Account configured", formatBool(irobot.account_configured, "Yes", "No")),
          row("Username", formatValue(irobot.username_preview)),
          row("Authenticated", formatBool(account.authenticated, "Yes", "No")),
          row("Robots on account", formatValue(account.robot_count)),
        ].join("");
        const matchedRows = matched
          ? [
              row("Name", formatValue(matched.name)),
              row("BLID", formatValue(matched.blid)),
              row("SKU", formatValue(matched.sku)),
              row("Software", formatValue(matched.software_version)),
              row("MQTT password matches", matched.password_matches_saved == null ? "—" : formatBool(matched.password_matches_saved, "Yes", "No")),
            ].join("")
          : row("Matched robot", "—");
        const robotRows = (irobot.robots || []).map((robot) =>
          row(
            robot.name || "Roomba",
            formatValue((robot.software_version || "unknown") + " · " + robot.blid)
          )
        ).join("");
        const errors = Array.isArray(irobot.errors) ? irobot.errors.filter(Boolean) : [];
        const errorsHtml = errors.length
          ? '<div class="diag-errors"><strong>Issues</strong><br>' + errors.map(escapeHtml).join("<br>") + "</div>"
          : "";
        return card(
          "iRobot",
          "Cloud endpoint reachability and robot registry from iRobot servers.",
          section("Endpoints", endpointRows) +
          section("Account", accountRows) +
          section("Matched robot", matchedRows) +
          section("Cloud robots", robotRows || row("Robots", "—")) +
          errorsHtml
        );
      }
      function renderDiagnostics(data) {
        return '<div class="diagnostics-grid">' + renderApp(data.app) + renderRoomba(data.roomba) + renderIrobot(data.irobot) + "</div>" +
          '<p class="muted" style="margin-top:12px;font-size:13px">Generated ' + escapeHtml(new Date(data.generated_at).toLocaleString()) + "</p>";
      }
      async function loadDiagnostics() {
        const response = await fetch("/api/diagnostics");
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Failed to load diagnostics");
        document.getElementById("diagnostics-content").innerHTML = renderDiagnostics(data);
      }
      document.getElementById("refresh-diagnostics").addEventListener("click", () => {
        loadDiagnostics().catch((error) => showError(error.message));
      });
      loadDiagnostics().catch((error) => showError(error.message));
    </script>
    `);
}
function mergeSettings(current, patch) {
    return {
        robot_ip: patch.robot_ip?.trim() ?? current.robot_ip,
        blid: patch.blid?.trim() ?? current.blid,
        password: patch.password?.trim() ? patch.password.trim() : current.password,
        robot_name: patch.robot_name?.trim() || current.robot_name || "Roomba",
        firmware_version: patch.firmware_version?.trim() || current.firmware_version || "3",
        connection_mode: patch.connection_mode === "live" ? "live" : patch.connection_mode === "on_demand" ? "on_demand" : current.connection_mode,
        live_poll_seconds: typeof patch.live_poll_seconds === "number" && patch.live_poll_seconds >= 0
            ? patch.live_poll_seconds
            : current.live_poll_seconds,
        irobot_username: patch.irobot_username?.trim() ?? current.irobot_username,
        irobot_password: patch.irobot_password?.trim()
            ? patch.irobot_password.trim()
            : current.irobot_password,
    };
}
async function handleRequest(req, res) {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;
    const method = req.method ?? "GET";
    if (method === "GET" && pathname === "/icon.svg") {
        try {
            const icon = await (0, promises_1.readFile)(ICON_PATH);
            res.writeHead(200, { "Content-Type": "image/svg+xml", "Content-Length": icon.length });
            res.end(icon);
            return;
        }
        catch {
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
        sendJson(res, 200, await (0, roomba_client_1.getRobotStatus)(settings));
        return;
    }
    if (method === "GET" && pathname === "/api/schedule") {
        try {
            const schedule = await (0, roomba_client_1.getRobotSchedule)(settings);
            sendJson(res, 200, { schedule });
        }
        catch (error) {
            sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
    }
    if (method === "GET" && pathname === "/api/preferences") {
        try {
            const preferences = await (0, roomba_client_1.getRobotPreferences)(settings);
            sendJson(res, 200, { preferences });
        }
        catch (error) {
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
            const patch = await readJson(req);
            const next = mergeSettings(settings, patch);
            if (!isConfigured(next)) {
                sendJson(res, 400, { error: "robot_ip, blid, and password are required" });
                return;
            }
            await saveSettings(next);
            sendJson(res, 200, { settings: publicSettings(next) });
        }
        catch (error) {
            sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
    }
    if (method === "POST" && pathname === "/api/setup/discover") {
        try {
            let robotIpHint = settings.robot_ip;
            try {
                const body = await readJson(req);
                if (body.robot_ip?.trim())
                    robotIpHint = body.robot_ip.trim();
            }
            catch {
                // ignore empty or invalid discover request bodies
            }
            const robots = await (0, roomba_client_1.discoverRobots)(robotIpHint);
            sendJson(res, 200, { robots, method: robots.length ? "found" : "none" });
        }
        catch (error) {
            sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
    }
    if (method === "POST" && pathname === "/api/setup/fetch-credentials") {
        try {
            const body = await readJson(req);
            if (!body.username?.trim() || !body.password?.trim()) {
                sendJson(res, 400, { error: "username and password are required" });
                return;
            }
            const result = await (0, roomba_client_1.fetchCredentialsFromCloud)(body.username, body.password);
            sendJson(res, 200, result);
        }
        catch (error) {
            sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
    }
    if (method === "POST" && pathname === "/api/setup/test") {
        try {
            const body = await readJson(req);
            const candidate = mergeSettings(settings, body);
            if (!isConfigured(candidate)) {
                sendJson(res, 400, { error: "robot_ip, blid, and password are required" });
                return;
            }
            const status = await (0, roomba_client_1.testConnection)(candidate);
            if (!status.connected) {
                sendJson(res, 502, { error: status.error || "Connection test failed" });
                return;
            }
            sendJson(res, 200, status);
        }
        catch (error) {
            sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
    }
    if (method === "GET" && pathname === "/api/diagnostics") {
        sendJson(res, 200, await buildDiagnosticsSnapshot(settings));
        return;
    }
    if (method === "POST" && pathname.startsWith("/api/action/")) {
        const action = pathname.replace("/api/action/", "");
        if (!["clean", "pause", "resume", "stop", "dock"].includes(action)) {
            sendJson(res, 404, { error: "Unknown action" });
            return;
        }
        try {
            await (0, roomba_client_1.runRobotAction)(settings, action);
            sendJson(res, 200, { ok: true });
        }
        catch (error) {
            sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
    }
    sendJson(res, 404, { error: "Not found" });
}
async function main() {
    await ensureDataDir();
    const server = (0, node_http_1.createServer)((req, res) => {
        void handleRequest(req, res).catch((error) => {
            sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        });
    });
    server.listen(PORT, "0.0.0.0", () => {
        console.log(`Roomba app listening on ${PORT}${IS_LOCAL_DEV ? " (dev)" : ""}`);
    });
}
void main();
