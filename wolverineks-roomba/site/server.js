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
const APP_VERSION = "1.2.25";
const API_TIMEOUT_MS = 45_000;
const IS_LOCAL_DEV = process.env.ROOMBA_DEV === "1";
const DATA_ROOT = process.env.ROOMBA_DATA_DIR ?? "/data";
const SETTINGS_PATH = node_path_1.default.join(DATA_ROOT, "settings.json");
const ICON_PATH = node_path_1.default.join(__dirname, "icon.svg");
const LUCIDE_PATH = node_path_1.default.join(__dirname, "node_modules/lucide/dist/umd/lucide.min.js");
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
    .stat.stat-active {
      background: #ecfdf5;
      border: 1px solid #bbf7d0;
    }
    .stat.stat-active .label {
      color: #166534;
    }
    .stat.stat-active .value {
      color: #15803d;
    }
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
    button:disabled, .button:disabled {
      opacity: 0.65;
      cursor: wait;
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
    .favorite-list {
      margin-top: 12px;
    }
    .favorite-list.muted {
      font-size: 14px;
    }
    .favorite-tiles {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
      gap: 12px;
    }
    button.favorite-tile {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      justify-content: flex-end;
      min-height: 120px;
      width: 100%;
      padding: 12px;
      border: 1px solid #bae6fd;
      border-radius: 14px;
      background: var(--accent-soft);
      color: var(--text);
      text-align: center;
      box-shadow: none;
      gap: 8px;
    }
    button.favorite-tile:hover:not(:disabled) {
      background: #bae6fd;
      border-color: var(--accent);
      box-shadow: 0 4px 14px rgba(2, 132, 199, 0.16);
      color: var(--text);
    }
    button.favorite-tile:active:not(:disabled) {
      background: #7dd3fc;
      border-color: var(--accent-active);
      color: var(--text);
    }
    button.favorite-tile:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    button.favorite-tile.favorite-tile-zone {
      border-color: #fcd34d;
      background: #fffbeb;
    }
    button.favorite-tile.favorite-tile-zone:hover:not(:disabled) {
      background: #fef3c7;
      border-color: #f59e0b;
      box-shadow: 0 4px 14px rgba(245, 158, 11, 0.16);
    }
    button.favorite-tile.favorite-tile-zone:active:not(:disabled) {
      background: #fde68a;
      border-color: #d97706;
    }
    .favorite-tile-zone .favorite-tile-icon .icon-badge {
      background: linear-gradient(180deg, rgba(245, 158, 11, 0.24) 0%, rgba(245, 158, 11, 0.1) 100%);
      color: #b45309;
    }
    .favorite-tile-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      flex: 1;
      width: 100%;
      min-height: 56px;
      color: var(--accent);
    }
    .favorite-tile-icon .icon-badge {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 52px;
      height: 52px;
      border-radius: 16px;
      background: linear-gradient(180deg, rgba(2, 132, 199, 0.2) 0%, rgba(2, 132, 199, 0.08) 100%);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.65);
      color: #0369a1;
    }
    .favorite-tile-icon svg {
      width: 26px;
      height: 26px;
      display: block;
    }
    .favorite-tile-name {
      font-size: 13px;
      font-weight: 700;
      line-height: 1.25;
      word-break: break-word;
      width: 100%;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      margin-top: auto;
    }
    .favorite-tile-estimate {
      font-size: 11px;
      font-weight: 600;
      line-height: 1.2;
      color: var(--muted);
      margin-top: 3px;
      width: 100%;
    }
    .favorite-tile-zone .favorite-tile-estimate {
      color: #b45309;
      opacity: 0.9;
    }
    .maintenance-badge {
      display: inline-block;
      border-radius: 999px;
      padding: 4px 10px;
      font-size: 12px;
      font-weight: 600;
    }
    .maintenance-badge.ok {
      background: #dcfce7;
      color: #166534;
    }
    .maintenance-badge.due_soon {
      background: #fef3c7;
      color: #92400e;
    }
    .maintenance-badge.replace {
      background: #fee2e2;
      color: #991b1b;
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
    .api-explorer-grid {
      display: grid;
      gap: 18px;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    }
    .api-explorer-card h3 {
      margin: 0 0 4px;
      font-size: 18px;
    }
    .api-explorer-card .card-hint {
      margin: 0 0 14px;
      font-size: 13px;
    }
    .api-endpoint-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .api-workspace-panel {
      margin-top: 18px;
    }
    .api-workspace-panel h2 {
      margin-top: 0;
      font-size: 18px;
    }
    .api-endpoint-item {
      width: 100%;
      display: flex;
      align-items: flex-start;
      gap: 8px;
      text-align: left;
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px 12px;
      background: #fff;
      color: var(--text);
      font: inherit;
      cursor: pointer;
      box-shadow: none;
    }
    .api-endpoint-item:hover {
      background: var(--accent-soft);
      border-color: #bae6fd;
      box-shadow: none;
    }
    .api-endpoint-item.active {
      background: var(--accent-soft);
      border-color: var(--accent);
      box-shadow: inset 0 0 0 1px rgba(2, 132, 199, 0.12);
    }
    .api-endpoint-item .api-endpoint-path {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      line-height: 1.35;
      word-break: break-all;
    }
    .api-workspace {
      min-width: 0;
    }
    .api-request-header {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      margin-bottom: 8px;
    }
    .api-request-header code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 14px;
      background: #f1f5f9;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 6px 10px;
    }
    .api-method {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 52px;
      border-radius: 8px;
      padding: 5px 8px;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: #fff;
    }
    .api-method.get { background: #16a34a; }
    .api-method.post { background: #0284c7; }
    .api-method.put { background: #d97706; }
    .api-body-textarea {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 13px;
      line-height: 1.45;
      min-height: 160px;
      resize: vertical;
    }
    .api-response-meta {
      margin-top: 14px;
      font-size: 13px;
      color: var(--muted);
      min-height: 18px;
    }
    .api-response {
      margin: 8px 0 0;
      padding: 14px 16px;
      border-radius: 12px;
      background: #0f172a;
      color: #e2e8f0;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      line-height: 1.5;
      overflow: auto;
      max-height: 520px;
      white-space: pre-wrap;
      word-break: break-word;
      border: 1px solid #1e293b;
    }
    .api-response.ok { border-color: #166534; }
    .api-response.error { border-color: #991b1b; }
    .api-external {
      margin: 0 0 10px;
      font-size: 12px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      word-break: break-all;
    }
    .api-endpoint-item .api-endpoint-subpath {
      display: block;
      margin-top: 4px;
      font-size: 11px;
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      line-height: 1.35;
      word-break: break-all;
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
const API_EXPLORER_SECTIONS = [
    {
        id: "app",
        title: "App",
        hint: "HTTP API served by this Umbrel app on your LAN.",
    },
    {
        id: "roomba",
        title: "Roomba",
        hint: "Proxied local MQTT via dorita980 and LAN discovery to your robot.",
    },
    {
        id: "irobot",
        title: "iRobot",
        hint: "Proxied HTTPS to iRobot cloud with Gigya login and AWS SigV4 signing.",
    },
];
function apiExplorerCardsHtml() {
    return API_EXPLORER_SECTIONS.map((section) => `<div class="panel diagnostics-card api-explorer-card">` +
        `<h3>${escapeHtml(section.title)}</h3>` +
        `<p class="muted card-hint">${escapeHtml(section.hint)}</p>` +
        `<div class="api-endpoint-list" id="api-endpoints-${section.id}"></div>` +
        `</div>`).join("");
}
const API_ENDPOINTS = [
    {
        id: "status",
        section: "app",
        method: "GET",
        path: "/api/status",
        summary: "Live robot status, Smart Map spaces, and saved favorites.",
    },
    {
        id: "maintenance",
        section: "app",
        method: "GET",
        path: "/api/maintenance",
        summary: "Maintenance counters and replacement reminders.",
    },
    {
        id: "preferences",
        section: "app",
        method: "GET",
        path: "/api/preferences",
        summary: "Robot preferences from local MQTT.",
    },
    {
        id: "diagnostics",
        section: "app",
        method: "GET",
        path: "/api/diagnostics",
        summary: "Combined app, Roomba, and iRobot cloud diagnostics snapshot.",
    },
    {
        id: "settings-get",
        section: "app",
        method: "GET",
        path: "/api/settings",
        summary: "Saved app settings with secrets redacted.",
    },
    {
        id: "settings-put",
        section: "app",
        method: "PUT",
        path: "/api/settings",
        summary: "Update robot connection settings and polling options.",
        body: JSON.stringify({
            robot_ip: "192.168.1.100",
            blid: "your-blid",
            password: "your-local-mqtt-password",
            robot_name: "Roomba",
            firmware_version: "3",
            connection_mode: "on_demand",
            live_poll_seconds: 30,
        }, null, 2),
        warning: "Sends credentials to the server. Use only on your local network.",
    },
    {
        id: "discover",
        section: "app",
        method: "POST",
        path: "/api/setup/discover",
        summary: "Scan the LAN for Roomba robots. Optional robot_ip hint narrows the search.",
        body: JSON.stringify({ robot_ip: "192.168.1.100" }, null, 2),
    },
    {
        id: "fetch-credentials",
        section: "app",
        method: "POST",
        path: "/api/setup/fetch-credentials",
        summary: "Log in to iRobot cloud and fetch robot BLID/password for setup.",
        body: JSON.stringify({ username: "you@example.com", password: "your-password" }, null, 2),
        warning: "Sends your iRobot account password to this app. Credentials are stored locally in settings.",
    },
    {
        id: "test",
        section: "app",
        method: "POST",
        path: "/api/setup/test",
        summary: "Test a robot connection without saving settings.",
        body: JSON.stringify({
            robot_ip: "192.168.1.100",
            blid: "your-blid",
            password: "your-local-mqtt-password",
            firmware_version: "3",
        }, null, 2),
    },
    {
        id: "action-clean",
        section: "app",
        method: "POST",
        path: "/api/action/clean",
        summary: "Start a cleaning job.",
        warning: "Requires a brief exclusive local MQTT connection. Close the iRobot app if the request fails.",
    },
    {
        id: "action-pause",
        section: "app",
        method: "POST",
        path: "/api/action/pause",
        summary: "Pause the current job.",
        warning: "Requires a brief exclusive local MQTT connection. Close the iRobot app if the request fails.",
    },
    {
        id: "action-resume",
        section: "app",
        method: "POST",
        path: "/api/action/resume",
        summary: "Resume a paused job.",
        warning: "Requires a brief exclusive local MQTT connection. Close the iRobot app if the request fails.",
    },
    {
        id: "action-stop",
        section: "app",
        method: "POST",
        path: "/api/action/stop",
        summary: "Stop the current job.",
        warning: "Requires a brief exclusive local MQTT connection. Close the iRobot app if the request fails.",
    },
    {
        id: "action-dock",
        section: "app",
        method: "POST",
        path: "/api/action/dock",
        summary: "Send the robot back to the dock.",
        warning: "Requires a brief exclusive local MQTT connection. Close the iRobot app if the request fails.",
    },
    {
        id: "action-favorite",
        section: "app",
        method: "POST",
        path: "/api/action/favorite",
        summary: "Run a saved favorite or Smart Map space by id.",
        body: JSON.stringify({ favorite_id: "room:pmap-id:region-id" }, null, 2),
        warning: "Requires a brief exclusive local MQTT connection. Close the iRobot app if the request fails.",
    },
    {
        id: "irobot-discovery",
        section: "irobot",
        method: "GET",
        path: "/api/explore/irobot/discovery",
        external: `GET ${(0, roomba_client_1.getIrobotDiscoveryUrl)()}`,
        summary: "Discover regional Gigya, AWS, and iRobot HTTP endpoints.",
    },
    {
        id: "irobot-gigya-login",
        section: "irobot",
        method: "POST",
        path: "/api/explore/irobot/gigya-login",
        external: "POST {gigya_base}/accounts.login",
        summary: "Gigya account login step before iRobot /v2/login. Uses Settings credentials unless overridden in the body.",
        body: JSON.stringify({ username: "you@example.com", password: "your-password" }, null, 2),
        warning: "Sends your iRobot account password. Credentials are redacted in the response.",
    },
    {
        id: "irobot-cloud-login",
        section: "irobot",
        method: "POST",
        path: "/api/explore/irobot/cloud-login",
        external: "POST {http_base}/v2/login",
        summary: "Full iRobot cloud login. Returns AWS session credentials and robots on the account (secrets redacted).",
        body: JSON.stringify({ username: "you@example.com", password: "your-password" }, null, 2),
        warning: "Sends your iRobot account password. AWS and robot secrets are redacted in the response.",
    },
    {
        id: "irobot-pmaps",
        section: "irobot",
        method: "GET",
        path: "/api/explore/irobot/pmaps?activeDetails=2",
        external: "GET https://{iot_host}/v1/{blid}/pmaps?activeDetails=2",
        summary: "AWS SigV4 GET for Smart Map pmaps, including room names and saved favorite metadata.",
        warning: "Uses your iRobot account from Settings. Requires configured BLID.",
    },
    {
        id: "irobot-smartcleanfavorites",
        section: "irobot",
        method: "GET",
        path: "/api/explore/irobot/smartcleanfavorites",
        external: "GET https://{iot_host}/v1/{blid}/smartcleanfavorites",
        summary: "AWS SigV4 GET for saved Smart Clean favorites. Often returns HTTP 403 on consumer accounts.",
        warning: "Uses your iRobot account from Settings. Requires configured BLID.",
    },
    {
        id: "irobot-favorites",
        section: "irobot",
        method: "GET",
        path: "/api/explore/irobot/favorites",
        external: "GET https://{iot_host}/v1/{blid}/favorites",
        summary: "AWS SigV4 GET for legacy favorites endpoint. Often returns HTTP 403 on consumer accounts.",
        warning: "Uses your iRobot account from Settings. Requires configured BLID.",
    },
    {
        id: "roomba-lan-discovery",
        section: "roomba",
        method: "POST",
        path: "/api/setup/discover",
        external: "UDP broadcast irobotmcs → port 5678",
        summary: "LAN discovery packet the app sends to find robots. Proxied here because browsers cannot send UDP.",
        body: JSON.stringify({ robot_ip: "192.168.1.100" }, null, 2),
    },
    {
        id: "roomba-mqtt-tcp",
        section: "roomba",
        method: "GET",
        path: "",
        external: "TCP mqtts://{robot_ip}:8883",
        summary: "Local MQTT/TLS port used by dorita980. Not HTTP — use the Roomba · MQTT proxy endpoints below to read or command the robot.",
        referenceOnly: true,
    },
    {
        id: "roomba-get-state",
        section: "roomba",
        method: "POST",
        path: "/api/explore/roomba/get-state",
        external: "MQTT dorita980.getRobotState(fields)",
        summary: "Read robot state fields over local MQTT.",
        body: JSON.stringify({ fields: ["batPct", "cleanMissionStatus", "bin", "pmaps", "softwareVer", "sku", "lastCommand"] }, null, 2),
        warning: "Brief exclusive MQTT connection. Close the iRobot app if the request fails.",
    },
    {
        id: "roomba-preferences",
        section: "roomba",
        method: "POST",
        path: "/api/explore/roomba/preferences",
        external: "MQTT dorita980.getPreferences()",
        summary: "Read robot preferences over local MQTT.",
        warning: "Brief exclusive MQTT connection. Close the iRobot app if the request fails.",
    },
    {
        id: "roomba-wireless",
        section: "roomba",
        method: "POST",
        path: "/api/explore/roomba/wireless-status",
        external: "MQTT dorita980.getWirelessStatus()",
        summary: "Read Wi-Fi and cloud link status from the robot.",
        warning: "Brief exclusive MQTT connection. Close the iRobot app if the request fails.",
    },
    {
        id: "roomba-cloud-config",
        section: "roomba",
        method: "POST",
        path: "/api/explore/roomba/cloud-config",
        external: "MQTT dorita980.getCloudConfig()",
        summary: "Read the robot's cloud configuration over local MQTT.",
        warning: "Brief exclusive MQTT connection. Close the iRobot app if the request fails.",
    },
    {
        id: "roomba-start",
        section: "roomba",
        method: "POST",
        path: "/api/explore/roomba/start",
        external: "MQTT dorita980.start() / resume()",
        summary: "Start or resume a cleaning mission.",
        warning: "Sends a robot command over MQTT. Close the iRobot app first.",
    },
    {
        id: "roomba-pause",
        section: "roomba",
        method: "POST",
        path: "/api/explore/roomba/pause",
        external: "MQTT dorita980.pause()",
        summary: "Pause the active mission.",
        warning: "Sends a robot command over MQTT. Close the iRobot app first.",
    },
    {
        id: "roomba-resume",
        section: "roomba",
        method: "POST",
        path: "/api/explore/roomba/resume",
        external: "MQTT dorita980.resume()",
        summary: "Resume a paused mission.",
        warning: "Sends a robot command over MQTT. Close the iRobot app first.",
    },
    {
        id: "roomba-stop",
        section: "roomba",
        method: "POST",
        path: "/api/explore/roomba/stop",
        external: "MQTT dorita980.stop()",
        summary: "Stop the active mission.",
        warning: "Sends a robot command over MQTT. Close the iRobot app first.",
    },
    {
        id: "roomba-dock",
        section: "roomba",
        method: "POST",
        path: "/api/explore/roomba/dock",
        external: "MQTT dorita980.dock()",
        summary: "Send the robot to the dock.",
        warning: "Sends a robot command over MQTT. Close the iRobot app first.",
    },
    {
        id: "roomba-clean-room",
        section: "roomba",
        method: "POST",
        path: "/api/explore/roomba/clean-room",
        external: "MQTT dorita980.cleanRoom(command)",
        summary: "Start a room or favorite clean with a raw command payload.",
        body: JSON.stringify({
            command: "start",
            pmap_id: "your-pmap-id",
            regions: [{ region_id: "1", type: "rid" }],
            ordered: 0,
        }, null, 2),
        warning: "Sends a robot command over MQTT. Close the iRobot app first.",
    },
];
function layout(page, title, body) {
    const nav = [
        ["dashboard", "Dashboard", "/"],
        ["setup", "Setup", "/setup"],
        ["maintenance", "Maintenance", "/maintenance"],
        ["settings", "Settings", "/settings"],
        ["diagnostics", "Diagnostics", "/diagnostics"],
        ["api", "API Explorer", "/api-explorer"],
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
        <div class="stat"><div class="label">Status</div><div class="value" id="phase">—</div></div>
        <div class="stat"><div class="label">Job</div><div class="value" id="cycle">—</div></div>
        <div class="stat" id="time-remaining-stat"><div class="label">Time left</div><div class="value" id="time-remaining">—</div></div>
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
    <div class="panel">
      <h2>Favorites</h2>
      <p class="muted">Custom routines plus saved favorites from the iRobot app when available.</p>
      <div id="favorites-list" class="favorite-list muted">Loading favorites…</div>
    </div>
    <div class="panel">
      <h2>Spaces</h2>
      <p class="muted">Smart Map rooms and custom clean areas from iRobot cloud. Custom areas appear as amber tiles.</p>
      <div id="spaces-list" class="favorite-list muted">Loading spaces…</div>
    </div>
    <script src="/lucide.min.js"></script>
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
      function lucideTileIcon(name) {
        return '<span class="icon-badge"><i data-lucide="' + name + '" aria-hidden="true"></i></span>';
      }
      const tileIcons = {
        kitchen: lucideTileIcon("cooking-pot"),
        bathroom: lucideTileIcon("toilet"),
        bedroom: lucideTileIcon("bed-double"),
        living: lucideTileIcon("sofa"),
        dining: lucideTileIcon("utensils-crossed"),
        laundry: lucideTileIcon("washing-machine"),
        hallway: lucideTileIcon("move-horizontal"),
        door: lucideTileIcon("door-closed"),
        office: lucideTileIcon("lamp-desk"),
        garage: lucideTileIcon("warehouse"),
        kids: lucideTileIcon("baby"),
        routine: lucideTileIcon("star"),
        multi: lucideTileIcon("layers"),
        room: lucideTileIcon("home"),
        zone: lucideTileIcon("square-dashed"),
      };
      function isCustomZone(item) {
        return item.space_kind === "zone" || String(item.id).startsWith("zone:") ||
          (item.command_regions && item.command_regions[0] && item.command_regions[0].type === "zid");
      }
      function isSpaceTile(item) {
        return item.source === "cloud" || String(item.id).startsWith("room:") || String(item.id).startsWith("zone:");
      }
      function spaceTileIcon(item) {
        if (isCustomZone(item)) {
          const name = String(item.name || "").toLowerCase();
          if (name.includes("bed")) return tileIcons.bedroom;
          if (name.includes("entry") || name.includes("door")) return tileIcons.door;
          return tileIcons.zone;
        }
        const regionType = String((item.command_regions && item.command_regions[0] && item.command_regions[0].region_type) || "").toLowerCase();
        const name = String(item.name || "").toLowerCase();
        const byType = {
          kitchen: tileIcons.kitchen,
          dining_room: tileIcons.dining,
          laundry_room: tileIcons.laundry,
          hallway: tileIcons.hallway,
          entryway: tileIcons.door,
          foyer: tileIcons.door,
          bathroom: tileIcons.bathroom,
          primary_bathroom: tileIcons.bathroom,
          bedroom: tileIcons.bedroom,
          kids_room: tileIcons.kids,
          living_room: tileIcons.living,
          family_room: tileIcons.living,
          office: tileIcons.office,
          garage: tileIcons.garage,
        };
        if (byType[regionType]) return byType[regionType];
        if (name.includes("kitchen")) return tileIcons.kitchen;
        if (name.includes("dining")) return tileIcons.dining;
        if (name.includes("laundry")) return tileIcons.laundry;
        if (name.includes("hall")) return tileIcons.hallway;
        if (name.includes("door") || name.includes("entry") || name.includes("foyer")) return tileIcons.door;
        if (name.includes("bath")) return tileIcons.bathroom;
        if (name.includes("bed")) return tileIcons.bedroom;
        if (name.includes("living") || name.includes("family")) return tileIcons.living;
        if (name.includes("office") || name.includes("study")) return tileIcons.office;
        if (name.includes("garage")) return tileIcons.garage;
        if (name.includes("kid") || name.includes("nursery")) return tileIcons.kids;
        return tileIcons.room;
      }
      function savedFavoriteTileIcon(item) {
        if (item.region_count > 1) return tileIcons.multi;
        return tileIcons.routine;
      }
      function renderCleanableTiles(listEl, items, errorMessage, emptyMessage) {
        if (!items.length) {
          listEl.className = "favorite-list muted";
          listEl.textContent = errorMessage || emptyMessage;
          return;
        }
        listEl.className = "favorite-list";
        listEl.innerHTML =
          '<div class="favorite-tiles">' +
          items
            .map((item) => {
              const disabled = item.runnable ? "" : " disabled";
              const icon = isSpaceTile(item) ? spaceTileIcon(item) : savedFavoriteTileIcon(item);
              const zoneClass = isSpaceTile(item) && isCustomZone(item) ? " favorite-tile-zone" : "";
              const estimateLabel = item.clean_estimate_label
                ? '<span class="favorite-tile-estimate">' + item.clean_estimate_label + "</span>"
                : "";
              return (
                '<button type="button" class="favorite-tile' + zoneClass + '" data-favorite-id="' + item.id + '"' + disabled + ">" +
                '<span class="favorite-tile-icon">' + icon + "</span>" +
                '<span class="favorite-tile-name">' + item.name + "</span>" +
                estimateLabel +
                "</button>"
              );
            })
            .join("") +
          "</div>";
        listEl.querySelectorAll("[data-favorite-id]").forEach((button) => {
          button.addEventListener("click", () => {
            runFavorite(button.getAttribute("data-favorite-id")).catch((error) => showError(error.message));
          });
        });
        if (window.lucide && typeof window.lucide.createIcons === "function") {
          window.lucide.createIcons({ root: listEl, attrs: { "stroke-width": 1.75 } });
        }
      }
      function renderFavorites(data) {
        const favorites = Array.isArray(data.favorites) ? data.favorites : [];
        renderCleanableTiles(
          document.getElementById("favorites-list"),
          favorites,
          data.favorites_error,
          data.connected
            ? "No favorites available. Custom favorites need Smart Map spaces loaded."
            : "Connect to the robot to load favorites.",
        );
      }
      function sortSpaces(spaces) {
        return [...spaces].sort((a, b) => {
          const aZone = isCustomZone(a);
          const bZone = isCustomZone(b);
          if (aZone !== bZone) return aZone ? 1 : -1;
          return String(a.name || "").localeCompare(String(b.name || ""));
        });
      }
      function renderSpaces(data) {
        const spaces = sortSpaces(Array.isArray(data.spaces) ? data.spaces : []);
        renderCleanableTiles(
          document.getElementById("spaces-list"),
          spaces,
          data.spaces_error,
          data.connected
            ? "No spaces found. Finish your Smart Map in the iRobot app, then refresh."
            : "Connect to the robot to load spaces.",
        );
      }
      let statusLoaded = false;
      let lastGoodStatus = null;
      let statusPollTimer = null;
      const MISSION_POLL_MS = 10000;
      function scheduleStatusPoll(data) {
        if (statusPollTimer) {
          clearInterval(statusPollTimer);
          statusPollTimer = null;
        }
        if (!data.mission_active) return;
        statusPollTimer = setInterval(() => {
          loadStatus().catch(() => {});
        }, MISSION_POLL_MS);
      }
      function setStatusRefreshing(refreshing) {
        const refreshButton = document.getElementById("refresh");
        refreshButton.disabled = refreshing;
        refreshButton.textContent = refreshing ? "Refreshing…" : "Refresh status";
      }
      function formatStatusMeta(data, stale) {
        const name = data.robot_name || "Roomba";
        const firmware = data.software_version || "unknown firmware";
        const synced = "synced " + new Date(data.last_sync).toLocaleString();
        return stale ? name + " · " + firmware + " · " + synced + " (showing last good data)" : name + " · " + firmware + " · " + synced;
      }
      function mergeStatusResponse(data) {
        if (!lastGoodStatus || !statusLoaded) return data;
        if (data.connected) {
          const merged = { ...data };
          if (!merged.spaces?.length && lastGoodStatus.spaces?.length) {
            merged.spaces = lastGoodStatus.spaces;
          }
          if (!merged.favorites?.length && lastGoodStatus.favorites?.length) {
            merged.favorites = lastGoodStatus.favorites;
          }
          return merged;
        }
        return lastGoodStatus;
      }
      function renderStatus(data, options) {
        const stale = Boolean(options && options.stale);
        document.getElementById("battery").textContent =
          data.battery_percent == null ? "—" : data.battery_percent + "%";
        document.getElementById("phase").textContent = data.status_label || data.phase_label || data.phase || "—";
        document.getElementById("cycle").textContent = data.cycle_label || data.cycle || "—";
        const timeRemainingStat = document.getElementById("time-remaining-stat");
        const timeRemainingEl = document.getElementById("time-remaining");
        if (data.mission_active) {
          timeRemainingStat.classList.add("stat-active");
          timeRemainingEl.textContent = data.time_remaining_label || "—";
        } else {
          timeRemainingStat.classList.remove("stat-active");
          timeRemainingEl.textContent = "—";
        }
        const bin =
          data.bin_full == null ? "—" : data.bin_full ? "Full" : data.bin_present === false ? "Missing" : "OK";
        document.getElementById("bin").textContent = bin;
        renderFavorites(data);
        renderSpaces(data);
        if (!stale && data.connected) {
          showError("");
          document.getElementById("meta").textContent = formatStatusMeta(data, false);
        } else if (stale) {
          document.getElementById("meta").textContent = formatStatusMeta(data, true);
        } else {
          const message = data.error || "Robot not connected";
          document.getElementById("meta").textContent = message;
          showError(message);
        }
        scheduleStatusPoll(data);
        statusLoaded = true;
      }
      async function loadStatus() {
        const isInitial = !statusLoaded;
        if (isInitial) {
          document.getElementById("meta").textContent = "Loading status…";
          document.getElementById("favorites-list").textContent = "Loading favorites…";
          document.getElementById("spaces-list").textContent = "Loading spaces…";
        }
        setStatusRefreshing(true);
        try {
          const response = await fetch("/api/status", { signal: AbortSignal.timeout(${API_TIMEOUT_MS}) });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "Failed to load status");
          if (data.connected) {
            const merged = mergeStatusResponse(data);
            const staleMessage =
              (!data.spaces?.length && merged.spaces?.length && data.spaces_error) ||
              (!data.favorites?.length && merged.favorites?.length && data.favorites_error) ||
              "";
            if (staleMessage) showError(staleMessage);
            lastGoodStatus = merged;
            renderStatus(merged);
            return;
          }
          if (lastGoodStatus && statusLoaded) {
            showError(data.error || "Robot not connected");
            renderStatus(lastGoodStatus, { stale: true });
            return;
          }
          renderStatus(data);
        } finally {
          setStatusRefreshing(false);
        }
      }
      function actionSuccessMessage(action, data) {
        const job = data.cycle_label || data.status_label || data.phase_label || "updated";
        if (action === "clean") {
          const cycle = data.cycle || "none";
          const phase = data.phase || "";
          return cycle !== "none" || phase === "run" || phase === "resume"
            ? "Cleaning started — " + job + "."
            : "Clean command sent — " + job + ".";
        }
        if (action === "dock") return "Dock command sent — " + job + ".";
        return action.charAt(0).toUpperCase() + action.slice(1) + " sent — " + job + ".";
      }
      async function runAction(action) {
        showError("");
        showSuccess("");
        const response = await fetch("/api/action/" + action, { method: "POST" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Action failed");
        showSuccess(actionSuccessMessage(action, data));
        await loadStatus();
      }
      async function runFavorite(favoriteId) {
        showError("");
        showSuccess("");
        const response = await fetch("/api/action/favorite", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ favorite_id: favoriteId }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Favorite failed");
        showSuccess("Favorite started.");
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
      <p class="muted">Enter your robot IP first for the best results on Umbrel, then click Discover. Discovery probes that IP directly, then scans its subnet if needed.</p>
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
          signal: AbortSignal.timeout(${API_TIMEOUT_MS}),
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
              signal: AbortSignal.timeout(${API_TIMEOUT_MS}),
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
function maintenancePage() {
    return layout("maintenance", "Maintenance", `
    <div class="panel">
      <p class="muted">Runtime and wear estimates from the robot. Reset part counters in the iRobot app after replacing filters or brushes.</p>
      <button type="button" id="refresh-maintenance">Refresh maintenance</button>
      <div class="grid" id="maintenance-stats" style="margin-top:16px">
        <div class="stat"><div class="label">Cleaning runtime</div><div class="value" id="runtime">—</div></div>
        <div class="stat"><div class="label">Area cleaned</div><div class="value" id="area">—</div></div>
        <div class="stat"><div class="label">Missions</div><div class="value" id="missions">—</div></div>
        <div class="stat"><div class="label">Charge cycles</div><div class="value" id="charges">—</div></div>
      </div>
      <p class="muted" id="maintenance-meta">Loading maintenance…</p>
      <div id="maintenance-table"></div>
      <div class="error" id="error"></div>
    </div>
    <script>
      const errorEl = document.getElementById("error");
      function showError(message) {
        errorEl.style.display = message ? "block" : "none";
        errorEl.textContent = message || "";
      }
      function formatNumber(value, suffix) {
        if (value == null) return "—";
        return String(value) + suffix;
      }
      function renderMaintenanceTable(items) {
        const rows = (items || []).map((item) =>
          "<tr><td><strong>" + item.name + "</strong><br><span class=\\"muted\\">" + item.detail + "</span></td>" +
          "<td>" + item.hours_used + " / " + item.hours_recommended + " hr</td>" +
          "<td>" + item.percent_used + "%</td>" +
          '<td><span class="maintenance-badge ' + item.status + '">' + item.status_label + "</span></td></tr>"
        ).join("");
        document.getElementById("maintenance-table").innerHTML =
          "<table><thead><tr><th>Part</th><th>Hours</th><th>Wear</th><th>Status</th></tr></thead><tbody>" +
          (rows || "<tr><td colspan=\\"4\\" class=\\"muted\\">No maintenance data yet.</td></tr>") +
          "</tbody></table>";
      }
      let maintenanceLoaded = false;
      let lastGoodMaintenance = null;
      function setMaintenanceRefreshing(refreshing) {
        const refreshButton = document.getElementById("refresh-maintenance");
        refreshButton.disabled = refreshing;
        refreshButton.textContent = refreshing ? "Refreshing…" : "Refresh maintenance";
      }
      function formatMaintenanceMeta(data, stale) {
        const bin =
          data.bin_full == null ? "Unknown" : data.bin_full ? "Full" : data.bin_present === false ? "Missing" : "OK";
        const battery = data.battery_percent == null ? "—" : data.battery_percent + "%";
        const stuck = data.stuck_events == null ? "—" : String(data.stuck_events);
        const synced = "synced " + new Date(data.last_sync).toLocaleString();
        const suffix = stale ? " (showing last good data)" : "";
        return "Bin " + bin + " · Battery " + battery + " · Stuck events " + stuck + " · " + synced + suffix;
      }
      function renderMaintenance(data, options) {
        const stale = Boolean(options && options.stale);
        document.getElementById("runtime").textContent = data.runtime_label || "—";
        document.getElementById("area").textContent =
          data.area_sqft == null ? "—" : data.area_sqft.toLocaleString() + " sq ft";
        const missions =
          data.missions_completed == null && data.missions_total == null
            ? "—"
            : (data.missions_completed ?? 0) + " / " + (data.missions_total ?? "—") + " done";
        document.getElementById("missions").textContent = missions;
        document.getElementById("charges").textContent = formatNumber(data.charge_cycles, "");
        document.getElementById("maintenance-meta").textContent = formatMaintenanceMeta(data, stale);
        renderMaintenanceTable(data.items);
        maintenanceLoaded = true;
      }
      async function loadMaintenance() {
        const isInitial = !maintenanceLoaded;
        if (isInitial) {
          document.getElementById("maintenance-meta").textContent = "Loading maintenance…";
        }
        setMaintenanceRefreshing(true);
        try {
          const response = await fetch("/api/maintenance", { signal: AbortSignal.timeout(${API_TIMEOUT_MS}) });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "Failed to load maintenance");
          if (data.connected) {
            lastGoodMaintenance = data;
            showError("");
            renderMaintenance(data);
            return;
          }
          if (lastGoodMaintenance && maintenanceLoaded) {
            showError(data.error || "Robot not connected");
            renderMaintenance(lastGoodMaintenance, { stale: true });
            return;
          }
          throw new Error(data.error || "Robot not connected");
        } finally {
          setMaintenanceRefreshing(false);
        }
      }
      document.getElementById("refresh-maintenance").addEventListener("click", () => {
        loadMaintenance().catch((error) => showError(error.message));
      });
      loadMaintenance().catch((error) => showError(error.message));
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
          row("Status", formatValue(device.status_label || device.phase)),
          row("Job", formatValue(device.cycle_label || device.cycle)),
          row("Raw phase", formatValue(device.phase)),
          row("Raw cycle", formatValue(device.cycle)),
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
      let diagnosticsLoaded = false;
      let lastDiagnosticsHtml = "";
      function setDiagnosticsRefreshing(refreshing) {
        const refreshButton = document.getElementById("refresh-diagnostics");
        refreshButton.disabled = refreshing;
        refreshButton.textContent = refreshing ? "Refreshing…" : "Refresh diagnostics";
      }
      async function loadDiagnostics() {
        const isInitial = !diagnosticsLoaded;
        if (isInitial) {
          document.getElementById("diagnostics-content").innerHTML = '<p class="muted">Loading diagnostics…</p>';
        }
        setDiagnosticsRefreshing(true);
        try {
          const response = await fetch("/api/diagnostics", { signal: AbortSignal.timeout(${API_TIMEOUT_MS}) });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "Failed to load diagnostics");
          lastDiagnosticsHtml = renderDiagnostics(data);
          document.getElementById("diagnostics-content").innerHTML = lastDiagnosticsHtml;
          diagnosticsLoaded = true;
          showError("");
        } catch (error) {
          if (diagnosticsLoaded && lastDiagnosticsHtml) {
            showError(error.message);
            return;
          }
          throw error;
        } finally {
          setDiagnosticsRefreshing(false);
        }
      }
      document.getElementById("refresh-diagnostics").addEventListener("click", () => {
        loadDiagnostics().catch((error) => showError(error.message));
      });
      loadDiagnostics().catch((error) => showError(error.message));
    </script>
    `);
}
function apiExplorerPage() {
    const endpointsJson = JSON.stringify(API_ENDPOINTS);
    const sectionsJson = JSON.stringify(API_EXPLORER_SECTIONS);
    return layout("api", "API Explorer", `
    <p class="muted">Pick an endpoint from App, Roomba, or iRobot below, then send it from the request panel. External targets are shown on each entry; requests run through this server because browsers cannot speak AWS SigV4 or MQTT directly.</p>
    <div class="api-explorer-grid">
      ${apiExplorerCardsHtml()}
    </div>
    <div class="panel api-workspace-panel">
      <h2>Request</h2>
      <div class="api-request-header">
        <span class="api-method get" id="api-method">GET</span>
        <code id="api-path">/api/status</code>
      </div>
      <p class="api-external muted" id="api-external" hidden></p>
      <p class="muted" id="api-description">Select an endpoint to inspect it.</p>
      <div class="notice" id="api-warning" hidden></div>
      <label for="api-body" id="api-body-label" hidden>Request body (JSON)</label>
      <textarea id="api-body" class="api-body-textarea" hidden spellcheck="false"></textarea>
      <div class="actions">
        <button type="button" id="api-send">Send request</button>
        <button type="button" class="secondary" id="api-copy-curl">Copy as curl</button>
      </div>
      <div class="api-response-meta" id="api-response-meta"></div>
      <pre class="api-response muted" id="api-response">Select an endpoint and click Send request.</pre>
      <div class="error" id="error"></div>
    </div>
    <script>
      const endpoints = ${endpointsJson};
      const sections = ${sectionsJson};
      const errorEl = document.getElementById("error");
      const methodEl = document.getElementById("api-method");
      const pathEl = document.getElementById("api-path");
      const descriptionEl = document.getElementById("api-description");
      const warningEl = document.getElementById("api-warning");
      const bodyLabelEl = document.getElementById("api-body-label");
      const bodyEl = document.getElementById("api-body");
      const externalEl = document.getElementById("api-external");
      const responseMetaEl = document.getElementById("api-response-meta");
      const responseEl = document.getElementById("api-response");
      const sendButton = document.getElementById("api-send");
      const copyCurlButton = document.getElementById("api-copy-curl");
      let selectedEndpoint = endpoints.find((endpoint) => endpoint.section === "app") || endpoints[0] || null;

      function showError(message) {
        errorEl.style.display = message ? "block" : "none";
        errorEl.textContent = message || "";
      }

      function methodClass(method) {
        return method.toLowerCase();
      }

      function renderEndpointButton(endpoint) {
        const active = selectedEndpoint && selectedEndpoint.id === endpoint.id ? " active" : "";
        const subpath = endpoint.external
          ? '<span class="api-endpoint-subpath">' + endpoint.external + "</span>"
          : "";
        const proxyPath = endpoint.path || "(reference only)";
        return (
          '<button type="button" class="api-endpoint-item' + active + '" data-endpoint-id="' + endpoint.id + '">' +
          '<span class="api-method ' + methodClass(endpoint.method) + '">' + endpoint.method + "</span>" +
          '<span class="api-endpoint-path">' + proxyPath + subpath + "</span>" +
          "</button>"
        );
      }

      function renderEndpointList() {
        for (const section of sections) {
          const listEl = document.getElementById("api-endpoints-" + section.id);
          if (!listEl) continue;
          listEl.innerHTML = endpoints
            .filter((endpoint) => endpoint.section === section.id)
            .map((endpoint) => renderEndpointButton(endpoint))
            .join("");
        }
        document.querySelectorAll("[data-endpoint-id]").forEach((button) => {
          button.addEventListener("click", () => {
            const endpoint = endpoints.find((item) => item.id === button.getAttribute("data-endpoint-id"));
            if (endpoint) selectEndpoint(endpoint);
          });
        });
      }

      function selectEndpoint(endpoint) {
        selectedEndpoint = endpoint;
        methodEl.textContent = endpoint.method;
        methodEl.className = "api-method " + methodClass(endpoint.method);
        pathEl.textContent = endpoint.path || "(reference only)";
        if (endpoint.external) {
          externalEl.hidden = false;
          externalEl.textContent = "External: " + endpoint.external;
        } else {
          externalEl.hidden = true;
          externalEl.textContent = "";
        }
        descriptionEl.textContent = endpoint.summary;
        sendButton.disabled = Boolean(endpoint.referenceOnly);
        copyCurlButton.disabled = Boolean(endpoint.referenceOnly);
        if (endpoint.referenceOnly) {
          responseEl.textContent = "Reference only. This protocol cannot be sent from the browser or this HTTP proxy.";
          responseEl.className = "api-response muted";
        }
        if (endpoint.warning) {
          warningEl.hidden = false;
          warningEl.textContent = endpoint.warning;
        } else {
          warningEl.hidden = true;
          warningEl.textContent = "";
        }
        if (endpoint.body) {
          bodyLabelEl.hidden = false;
          bodyEl.hidden = false;
          bodyEl.value = endpoint.body;
        } else {
          bodyLabelEl.hidden = true;
          bodyEl.hidden = true;
          bodyEl.value = "";
        }
        if (!endpoint.referenceOnly) {
          responseMetaEl.textContent = "";
          responseEl.textContent = "Ready. Click Send request.";
          responseEl.className = "api-response muted";
        } else {
          responseMetaEl.textContent = "";
        }
        showError("");
        renderEndpointList();
      }

      function formatResponseBody(text) {
        try {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === "object" && parsed.external && Object.prototype.hasOwnProperty.call(parsed, "body")) {
            return JSON.stringify(parsed, null, 2);
          }
          return JSON.stringify(parsed, null, 2);
        } catch {
          return text;
        }
      }

      function buildCurl(endpoint, bodyValue) {
        const origin = window.location.origin;
        if (!endpoint.path) return endpoint.external || "";
        let command = 'curl -sS -X ' + endpoint.method + ' "' + origin + endpoint.path + '" -H "Content-Type: application/json"';
        if (endpoint.method !== "GET" && bodyValue) {
          command += " -d " + JSON.stringify(bodyValue);
        }
        if (endpoint.external) {
          command += "  # proxied external: " + endpoint.external;
        }
        return command;
      }

      function formatExploreMeta(parsed) {
        if (!parsed || typeof parsed !== "object" || !parsed.external) return "";
        const external = parsed.external;
        const bits = [];
        if (external.method && external.url) bits.push(external.method + " " + external.url);
        if (external.protocol) bits.push(external.protocol);
        if (typeof parsed.http_status === "number") bits.push("remote HTTP " + parsed.http_status);
        else if (parsed.http_status === null && external.protocol) bits.push("non-HTTP transport");
        if (typeof parsed.ok === "boolean") bits.push(parsed.ok ? "remote ok" : "remote failed");
        return bits.join(" · ");
      }

      async function sendRequest() {
        if (!selectedEndpoint || selectedEndpoint.referenceOnly) return;
        showError("");
        sendButton.disabled = true;
        sendButton.textContent = "Sending…";
        responseMetaEl.textContent = "";
        responseEl.textContent = "Waiting for response…";
        responseEl.className = "api-response muted";
        const started = performance.now();
        try {
          let body;
          if (selectedEndpoint.method !== "GET") {
            const rawBody = bodyEl.hidden ? "" : bodyEl.value.trim();
            if (rawBody) {
              try {
                body = JSON.stringify(JSON.parse(rawBody));
              } catch {
                throw new Error("Request body must be valid JSON.");
              }
            }
          }
          const response = await fetch(selectedEndpoint.path, {
            method: selectedEndpoint.method,
            headers: body ? { "Content-Type": "application/json" } : undefined,
            body,
            signal: AbortSignal.timeout(${API_TIMEOUT_MS}),
          });
          const text = await response.text();
          const elapsed = Math.round(performance.now() - started);
          let exploreMeta = "";
          try {
            exploreMeta = formatExploreMeta(JSON.parse(text));
          } catch {
            exploreMeta = "";
          }
          responseMetaEl.textContent = (exploreMeta ? exploreMeta + " · " : "") + "proxy HTTP " + response.status + " · " + elapsed + " ms";
          responseEl.textContent = formatResponseBody(text || "(empty response)");
          responseEl.className = response.ok ? "api-response ok" : "api-response error";
        } catch (error) {
          const elapsed = Math.round(performance.now() - started);
          responseMetaEl.textContent = "Request failed · " + elapsed + " ms";
          responseEl.textContent = error instanceof Error ? error.message : String(error);
          responseEl.className = "api-response error";
        } finally {
          sendButton.disabled = false;
          sendButton.textContent = "Send request";
        }
      }

      document.getElementById("api-send").addEventListener("click", () => {
        sendRequest().catch((error) => showError(error.message));
      });
      document.getElementById("api-copy-curl").addEventListener("click", async () => {
        if (!selectedEndpoint) return;
        const bodyValue = bodyEl.hidden ? selectedEndpoint.body : bodyEl.value.trim() || selectedEndpoint.body;
        const curl = buildCurl(selectedEndpoint, bodyValue);
        try {
          await navigator.clipboard.writeText(curl);
          responseMetaEl.textContent = "Copied curl command to clipboard.";
        } catch {
          showError("Could not copy to clipboard.");
        }
      });

      if (selectedEndpoint) selectEndpoint(selectedEndpoint);
      else renderEndpointList();
    </script>
    `);
}
const ROOMBA_EXPLORE_OPERATIONS = new Set([
    "get-state",
    "preferences",
    "wireless-status",
    "cloud-config",
    "start",
    "pause",
    "resume",
    "stop",
    "dock",
    "clean-room",
]);
async function handleExploreRequest(req, res, pathname, method, settings) {
    if (!pathname.startsWith("/api/explore/")) {
        return false;
    }
    try {
        let result;
        if (method === "GET" && pathname === "/api/explore/irobot/discovery") {
            result = await (0, roomba_client_1.exploreIrobotDiscovery)();
        }
        else if (method === "POST" && pathname === "/api/explore/irobot/gigya-login") {
            const body = await readJson(req);
            result = await (0, roomba_client_1.exploreIrobotGigyaLogin)(settings, body.username, body.password);
        }
        else if (method === "POST" && pathname === "/api/explore/irobot/cloud-login") {
            const body = await readJson(req);
            result = await (0, roomba_client_1.exploreIrobotCloudLogin)(settings, body.username, body.password);
        }
        else if (method === "GET" && pathname === "/api/explore/irobot/pmaps") {
            const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
            result = await (0, roomba_client_1.exploreIrobotSignedGet)(settings, `/v1/${settings.blid.trim()}/pmaps`, url.searchParams.toString());
        }
        else if (method === "GET" && pathname === "/api/explore/irobot/smartcleanfavorites") {
            result = await (0, roomba_client_1.exploreIrobotSignedGet)(settings, `/v1/${settings.blid.trim()}/smartcleanfavorites`);
        }
        else if (method === "GET" && pathname === "/api/explore/irobot/favorites") {
            result = await (0, roomba_client_1.exploreIrobotSignedGet)(settings, `/v1/${settings.blid.trim()}/favorites`);
        }
        else if (method === "POST" && pathname.startsWith("/api/explore/roomba/")) {
            const operation = pathname.replace("/api/explore/roomba/", "");
            if (!ROOMBA_EXPLORE_OPERATIONS.has(operation)) {
                sendJson(res, 404, { error: "Unknown Roomba explore operation" });
                return true;
            }
            const body = await readJson(req);
            result = await (0, roomba_client_1.exploreRoomba)(settings, operation, body);
        }
        else {
            sendJson(res, 404, { error: "Unknown explore endpoint" });
            return true;
        }
        sendJson(res, 200, result);
        return true;
    }
    catch (error) {
        sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
        return true;
    }
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
    if (method === "GET" && pathname === "/lucide.min.js") {
        try {
            const script = await (0, promises_1.readFile)(LUCIDE_PATH);
            res.writeHead(200, {
                "Content-Type": "application/javascript; charset=utf-8",
                "Content-Length": script.length,
                "Cache-Control": "public, max-age=86400",
            });
            res.end(script);
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
    if (method === "GET" && pathname === "/maintenance") {
        sendText(res, 200, "text/html; charset=utf-8", maintenancePage());
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
    if (method === "GET" && pathname === "/api-explorer") {
        sendText(res, 200, "text/html; charset=utf-8", apiExplorerPage());
        return;
    }
    const settings = await loadSettings();
    if (await handleExploreRequest(req, res, pathname, method, settings)) {
        return;
    }
    if (method === "GET" && pathname === "/api/status") {
        sendJson(res, 200, await (0, roomba_client_1.getRobotStatus)(settings));
        return;
    }
    if (method === "GET" && pathname === "/api/maintenance") {
        sendJson(res, 200, await (0, roomba_client_1.getRobotMaintenance)(settings));
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
            const next = mergeSettings(settings, {
                irobot_username: body.username.trim(),
                irobot_password: body.password.trim(),
            });
            await saveSettings(next);
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
    if (method === "POST" && pathname === "/api/action/favorite") {
        try {
            const body = await readJson(req);
            await (0, roomba_client_1.runRobotFavorite)(settings, body.favorite_id ?? "");
            sendJson(res, 200, { ok: true });
        }
        catch (error) {
            sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
    }
    if (method === "POST" && pathname.startsWith("/api/action/")) {
        const action = pathname.replace("/api/action/", "");
        if (!["clean", "pause", "resume", "stop", "dock"].includes(action)) {
            sendJson(res, 404, { error: "Unknown action" });
            return;
        }
        try {
            const result = await (0, roomba_client_1.runRobotAction)(settings, action);
            sendJson(res, 200, result);
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
