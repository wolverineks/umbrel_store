"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_http_1 = require("node:http");
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_path_1 = __importDefault(require("node:path"));
const backup_restore_1 = require("./backup-restore");
const parsers_1 = require("./parsers");
const store_1 = require("./store");
const APP_VERSION = "1.19.0";
const IS_LOCAL_DEV = process.env.NBU_DEV === "1";
const EXTENSION_REPO_URL = "https://github.com/wolverineks/umbrel_store/tree/master/wolverineks-nbu-dashboard/chrome-extension";
const EXTENSION_FOLDER = "wolverineks-nbu-dashboard/chrome-extension";
function loadExtensionVersion() {
    const manifestPath = node_path_1.default.join(__dirname, "..", "chrome-extension", "manifest.json");
    if (!(0, node_fs_1.existsSync)(manifestPath))
        return "2.13.0";
    try {
        const manifest = JSON.parse((0, node_fs_1.readFileSync)(manifestPath, "utf8"));
        return manifest.version?.trim() || "2.13.0";
    }
    catch {
        return "2.13.0";
    }
}
const EXTENSION_VERSION = loadExtensionVersion();
const DASHBOARD_PAGE_ROUTES = {
    "/": "overview",
    "/overview": "overview",
    "/sources": "sources",
    "/setup": "setup",
    "/extension": "setup",
    "/backup": "setup",
};
const DASHBOARD_PAGE_TITLES = {
    overview: "Overview",
    sources: "Sources",
    setup: "Setup",
};
function resolveDashboardPage(pathname) {
    return DASHBOARD_PAGE_ROUTES[pathname] ?? null;
}
function renderSideNav(active) {
    const items = [
        { page: "overview", href: "/", label: "Overview" },
        { page: "sources", href: "/sources", label: "Sources" },
        { page: "setup", href: "/setup", label: "Setup" },
    ];
    return items
        .map((item) => `<a class="side-nav-link${item.page === active ? " active" : ""}" href="${item.href}">${item.label}</a>`)
        .join("\n          ");
}
function headerUtilitySelect(page) {
    if (page === "setup")
        return "";
    return `
          <label class="header-utility-label muted" for="utility">Utility</label>
          <select id="utility" class="header-utility-select" aria-label="Select utility">
            <option value="electric">Electric</option>
            <option value="water">Water</option>
          </select>`;
}
function usageChartSection() {
    return `
      <div class="chart-wrap" style="margin-top:1rem">
        <div class="toolbar">
          <select id="granularity">
            <option value="hour">Hourly</option>
            <option value="day">Daily</option>
          </select>
          <select id="range">
            <option value="7">Last 7 days</option>
            <option value="30" selected>Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="365">Last year</option>
            <option value="">All data</option>
          </select>
          <input id="day" type="date" title="View hourly usage for a specific day">
          <button id="clear-day" class="secondary" hidden>Clear day</button>
          <div class="chart-nav">
            <button id="chart-prev" class="secondary" type="button" title="Previous period">← Prev</button>
            <button id="chart-next" class="secondary" type="button" title="Next period">Next →</button>
          </div>
          <button id="refresh" class="secondary">Refresh</button>
          <input id="range-end" type="hidden">
        </div>
        <p class="day-view-label" id="day-view-label" hidden></p>
        <div class="chart-shell">
          <svg class="chart" id="chart" viewBox="0 0 1000 300" preserveAspectRatio="none"></svg>
          <div class="chart-tooltip" id="chart-tooltip" hidden></div>
        </div>
        <div class="empty" id="chart-empty" hidden>No readings for this view yet. Sync from Customer Connect using the Chrome extension.</div>
        <p class="chart-missing-legend muted" id="chart-missing-legend" hidden>Red bars mark hours with no data.</p>
        <div class="chart-sources" id="chart-sources" hidden></div>
      </div>`;
}
function coverageSection() {
    return `
      <div class="card" style="margin-top:1rem">
        <h2>Data coverage</h2>
        <p class="muted">Hourly record completeness from first import through yesterday. Click a segment to view that day in the chart above.</p>
        <div id="coverage-content">
          <p class="muted">Loading coverage…</p>
        </div>
      </div>`;
}
function dashboardPageContent(page) {
    switch (page) {
        case "overview":
            return `<div class="grid" id="stats"></div>${usageChartSection()}${coverageSection()}`;
        case "sources":
            return `
      <div class="card" id="missing-sources-card">
        <div class="missing-sources-header">
          <div>
            <h2 style="margin:0">Missing sources</h2>
            <p class="muted" style="margin:0.35rem 0 0">Each gap includes a console snippet to fetch NBU servers and check whether the data is missing there too. Run snippets on the Customer Connect site (logged in, DevTools console).</p>
          </div>
          <div class="toolbar collapse-card-actions" style="margin:0">
            <button id="copy-verify-all-script" class="secondary" hidden>Copy verify-all script</button>
            <button id="copy-probe-script" class="secondary" hidden>Verify all + save</button>
            <button id="refresh-missing-sources" class="secondary">Refresh</button>
          </div>
        </div>
        <p class="muted" id="missing-sources-summary">Loading…</p>
        <div id="missing-sources-content">
          <p class="muted">Loading missing sources…</p>
        </div>
      </div>
      <div class="card" style="margin-top:1rem">
        <div class="import-history-header">
          <h2 style="margin:0">Upload history</h2>
          <span class="muted" id="import-count"></span>
        </div>
        <div class="imports import-history" id="imports"></div>
      </div>`;
        case "setup":
            return `
      <div class="card">
        <h2>NBU Utilities extension</h2>
        <p class="muted">Configure the Chrome extension with your Umbrel URL and ingest token, then sync from Customer Connect.</p>
        <h3 class="setup-section-title">Connect</h3>
        <div class="setup-field">
          <label for="extension-base-url">Umbrel app URL</label>
          <p class="muted setup-field-note">Copy from your browser address bar when this dashboard is open (include port, e.g. <code>:4060</code>).</p>
          <div class="token-box">
            <code id="extension-base-url">Loading…</code>
            <button id="copy-base-url" class="secondary" type="button">Copy URL</button>
          </div>
        </div>
        <div class="setup-field">
          <label for="token">Ingest token</label>
          <p class="muted setup-field-note">Saved in <code>settings.json</code>. Rotate only if the token was compromised.</p>
          <div class="token-box">
            <code id="token"></code>
            <button id="copy-token" class="secondary" type="button">Copy token</button>
            <button id="copy-extension-settings" class="secondary" type="button">Copy both</button>
            <button id="rotate-token" class="secondary" type="button">Rotate token</button>
          </div>
        </div>
        <h3 class="setup-section-title">Development</h3>
        <p class="muted">Load the extension unpacked while working on sync or upload changes.</p>
        <ol class="setup-steps">
          <li>
            Get the extension from
            <a href="${EXTENSION_REPO_URL}" target="_blank" rel="noreferrer">GitHub</a>
            (<code>${EXTENSION_FOLDER}</code> in <code>umbrel_store</code>).
          </li>
          <li>Chrome → Extensions → enable <strong>Developer mode</strong> → <strong>Load unpacked</strong> → select that folder.</li>
          <li>Paste the Umbrel URL and ingest token into the extension popup, then click <strong>Save settings</strong>.</li>
          <li>
            Open a Customer Connect consumption report. Use the floating sync panel for
            <strong>Sync last 30 days</strong> or <strong>Sync full history</strong>.
          </li>
          <li>After editing extension files, click <strong>Reload</strong> on <code>chrome://extensions</code>.</li>
        </ol>
        <p class="muted setup-dev-meta">
          Extension v${EXTENSION_VERSION} · Dashboard local dev:
          <code>npm run dev:local</code> in <code>site/</code> (port 4060) or
          <code>docker compose -f docker-compose.dev.yml up</code>
          ${IS_LOCAL_DEV ? " · <strong>Local dev mode is active</strong>" : ""}
        </p>
      </div>
      <div class="card" style="margin-top:1rem">
        <h2>Backup &amp; restore</h2>
        <p class="muted">
          Copies usage data, uploads, ingest token, property names, and NBU Object IDs to
          <code id="backup-host-path">${BACKUP_HOST_PATH}</code> on your Umbrel. Restore brings all of that back.
        </p>
        <h3 style="margin:1rem 0 0.35rem;font-size:0.95rem;color:var(--muted)">NBU Object ID</h3>
        <p class="muted" style="margin:0 0 0.75rem">Per account (selected in the header). Saved in <code>settings.json</code> and included in backup/restore.</p>
        <div class="toolbar" style="margin-bottom:0">
          <input id="property-object-id" type="text" placeholder="NBU Object ID" title="Customer Connect ObjectId for hourly CSV export URLs" style="min-width:280px;flex:1">
          <button id="save-object-id" class="secondary">Save Object ID</button>
        </div>
        <p class="object-id-hint" id="object-id-hint" hidden style="margin:0.75rem 0 0">
          Set the Object ID to generate per-gap NBU verify snippets on the Sources page.
        </p>
        <div class="grid" style="margin-top:1rem">
          <div>
            <h3>Live data</h3>
            <p class="muted" id="backup-live-summary">Loading…</p>
          </div>
          <div>
            <h3>Backup folder</h3>
            <p class="muted" id="backup-folder-summary">Loading…</p>
          </div>
        </div>
        <div id="backup-object-ids" class="backup-object-ids muted" style="margin-top:0.75rem"></div>
        <p class="muted" id="backup-status" style="margin-top:0.8rem"></p>
        <div class="toolbar" style="margin-top:0.8rem; margin-bottom:0">
          <button id="backup-export-btn">Back up now</button>
          <button id="backup-import-btn" class="secondary">Restore from backup</button>
        </div>
      </div>`;
    }
}
const PORT = Number(process.env.PORT ?? 3000);
const DATA_ROOT = process.env.NBU_DATA_DIR ?? "/data";
const BACKUP_ROOT = process.env.NBU_BACKUP_DIR ?? "/backup";
const BACKUP_HOST_PATH = process.env.NBU_BACKUP_HOST_PATH ?? "/home/umbrel/nbu-backup";
const ICON_PATH = node_path_1.default.join(__dirname, "icon.svg");
function sendJson(res, statusCode, payload) {
    const body = Buffer.from(JSON.stringify(payload));
    res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": body.length,
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Filename, X-Ingest-Token",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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
function sendFile(res, statusCode, contentType, body, filename) {
    res.writeHead(statusCode, {
        "Content-Type": contentType,
        "Content-Length": body.length,
        "Content-Disposition": `inline; filename="${filename.replace(/"/g, "")}"`,
    });
    res.end(body);
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}
function parseUtility(value) {
    return value === "water" ? "water" : "electric";
}
function parseGranularity(value) {
    if (value === "day")
        return value;
    return "hour";
}
function parseDays(value) {
    if (!value)
        return null;
    const days = Number(value);
    return Number.isFinite(days) && days > 0 ? days : null;
}
async function authorizeIngest(req) {
    const settings = await (0, store_1.loadSettings)();
    const headerToken = req.headers["x-ingest-token"];
    const auth = req.headers.authorization;
    const bearer = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : null;
    const token = (typeof headerToken === "string" ? headerToken : null) ?? bearer;
    return Boolean(token && token === settings.ingest_token);
}
function parseMultipart(body, boundary) {
    const delimiter = Buffer.from(`--${boundary}`);
    const parts = [];
    let offset = 0;
    while (offset < body.length) {
        const start = body.indexOf(delimiter, offset);
        if (start < 0)
            break;
        const lineEnd = body.indexOf("\r\n", start);
        if (lineEnd < 0)
            break;
        const next = body.indexOf(delimiter, lineEnd + 2);
        if (next < 0)
            break;
        const chunk = body.subarray(lineEnd + 2, next - 2);
        const headerEnd = chunk.indexOf("\r\n\r\n");
        if (headerEnd < 0) {
            offset = next + delimiter.length;
            continue;
        }
        const headers = chunk.subarray(0, headerEnd).toString("utf8");
        const content = chunk.subarray(headerEnd + 4);
        const filenameMatch = headers.match(/filename="([^"]+)"/i);
        parts.push({
            filename: filenameMatch?.[1] ?? null,
            content: content.toString("utf8"),
        });
        offset = next + delimiter.length;
    }
    return parts;
}
async function handleIngest(req, res) {
    if (!(await authorizeIngest(req))) {
        sendJson(res, 401, { error: "invalid ingest token" });
        return;
    }
    const body = await readBody(req);
    const contentType = req.headers["content-type"] ?? "";
    try {
        if (contentType.includes("application/json")) {
            const payload = JSON.parse(body.toString("utf8"));
            if (!payload.filename || !payload.content) {
                sendJson(res, 400, { error: "filename and content are required" });
                return;
            }
            const parsed = (0, parsers_1.parseNbuExport)(payload.filename, payload.content);
            const record = await (0, store_1.importParsed)(parsed, payload.content, {
                address: payload.address ?? null,
            });
            sendJson(res, 200, { ok: true, import: record, parsed_readings: parsed.readings.length });
            return;
        }
        if (contentType.includes("multipart/form-data")) {
            const boundaryMatch = contentType.match(/boundary=(.+)$/i);
            if (!boundaryMatch) {
                sendJson(res, 400, { error: "missing multipart boundary" });
                return;
            }
            const parts = parseMultipart(body, boundaryMatch[1].trim());
            const results = [];
            for (const part of parts) {
                if (!part.filename)
                    continue;
                const parsed = (0, parsers_1.parseNbuExport)(part.filename, part.content);
                results.push(await (0, store_1.importParsed)(parsed, part.content));
            }
            if (!results.length) {
                sendJson(res, 400, { error: "no files found in upload" });
                return;
            }
            sendJson(res, 200, { ok: true, imports: results });
            return;
        }
        const filenameHeader = req.headers["x-filename"];
        const addressHeader = req.headers["x-property-address"];
        const filename = typeof filenameHeader === "string" ? filenameHeader : "upload.csv";
        const rawContent = body.toString("utf8");
        const parsed = (0, parsers_1.parseNbuExport)(filename, rawContent);
        const record = await (0, store_1.importParsed)(parsed, rawContent, {
            address: typeof addressHeader === "string" ? addressHeader : null,
        });
        sendJson(res, 200, { ok: true, import: record, parsed_readings: parsed.readings.length });
    }
    catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
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
      --accent: #1d4ed8;
      --accent-soft: #dbeafe;
      --electric: #f59e0b;
      --water: #0ea5e9;
      --success: #16a34a;
      --shadow: 0 10px 30px rgba(15, 23, 42, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    .app-shell {
      display: flex;
      min-height: 100vh;
    }
    .side-nav {
      width: 232px;
      flex-shrink: 0;
      background: var(--panel);
      border-right: 1px solid var(--border);
      position: sticky;
      top: 0;
      align-self: flex-start;
      height: 100vh;
      overflow-y: auto;
      z-index: 30;
    }
    .side-nav-inner {
      display: flex;
      flex-direction: column;
      min-height: 100%;
      padding: 1.5rem 1rem 1.25rem;
    }
    .brand {
      display: flex;
      gap: 0.75rem;
      align-items: center;
      margin-bottom: 1.5rem;
      padding: 0 0.5rem;
    }
    .brand img {
      width: 40px;
      height: 40px;
      border-radius: 10px;
      flex-shrink: 0;
    }
    .brand h1 {
      font-size: 1rem;
      margin: 0;
      line-height: 1.2;
    }
    .brand p {
      margin: 0.15rem 0 0;
      color: var(--muted);
      font-size: 0.8rem;
      line-height: 1.35;
    }
    .side-nav-links {
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
      flex: 1;
    }
    .sidebar-version {
      margin-top: auto;
      padding: 0.75rem 0.85rem 0;
      font-size: 0.7rem;
      color: var(--muted);
      opacity: 0.65;
    }
    .side-nav-link {
      display: block;
      padding: 0.52rem 0.7rem;
      border-radius: 10px;
      color: var(--text);
      text-decoration: none;
      font-size: 0.9rem;
      font-weight: 500;
      line-height: 1.25;
    }
    .side-nav-link:hover {
      background: var(--accent-soft);
      color: var(--accent);
    }
    .side-nav-link.active {
      background: var(--accent-soft);
      color: var(--accent);
      font-weight: 600;
    }
    .side-nav-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(15, 23, 42, 0.35);
      z-index: 25;
      border: 0;
      padding: 0;
      margin: 0;
      cursor: pointer;
    }
    .side-nav-toggle {
      display: none;
      align-items: center;
      justify-content: center;
      width: 2.5rem;
      height: 2.5rem;
      padding: 0;
      flex-shrink: 0;
      font-size: 1.15rem;
      line-height: 1;
    }
    .app-main {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      min-height: 100vh;
    }
    .app-header {
      position: sticky;
      top: 0;
      z-index: 20;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      padding: 0.8rem 1.5rem;
      background: rgba(255, 255, 255, 0.92);
      border-bottom: 1px solid var(--border);
      backdrop-filter: blur(10px);
    }
    .app-header-start {
      display: flex;
      align-items: center;
      gap: 0.85rem;
      min-width: 0;
      flex: 0 1 auto;
    }
    .app-header-copy {
      min-width: 0;
      flex: 0 1 auto;
    }
    .header-account-label {
      font-size: 0.78rem;
      font-weight: 600;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .account-selector {
      appearance: none;
      -webkit-appearance: none;
      border: 1px solid transparent;
      border-radius: 0.5rem;
      background: transparent;
      color: inherit;
      font: inherit;
      padding: 0.1rem 1.4rem 0.1rem 0;
      margin: 0;
      width: auto;
      max-width: min(14rem, 42vw);
      cursor: pointer;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2364748b' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 0 center;
      background-size: 0.9rem;
    }
    .account-selector:hover:not(:disabled) {
      border-color: var(--border);
      background-color: var(--panel);
    }
    .account-selector:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .account-selector:disabled {
      cursor: default;
      opacity: 0.85;
      background-image: none;
      padding-right: 0;
    }
    .header-account-select {
      font-size: 1.05rem;
      font-weight: 700;
      min-width: 4.5rem;
    }
    .app-header-end {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      flex-shrink: 0;
    }
    .header-utility-label {
      font-size: 0.78rem;
      font-weight: 600;
      white-space: nowrap;
    }
    .header-utility-select {
      font-size: 0.88rem;
      font-weight: 600;
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      background: var(--panel);
      color: var(--text);
      padding: 0.35rem 0.55rem;
    }


    .header-refresh {
      padding: 0.45rem 0.75rem;
      font-size: 0.85rem;
    }
    .main-content {
      flex: 1;
      min-width: 0;
      padding: 1.25rem 1.5rem 2rem;
    }
    .section-anchor { scroll-margin-top: 5.5rem; }
    .backup-object-ids ul {
      margin: 0.35rem 0 0;
      padding-left: 1.1rem;
      font-size: 0.84rem;
    }
    .backup-object-ids li { margin: 0.2rem 0; }
    .backup-object-ids code {
      font-size: 0.8rem;
      background: var(--accent-soft);
      padding: 0.1rem 0.35rem;
      border-radius: 4px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 1rem;
      margin-bottom: 1.5rem;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 1rem 1.1rem;
      box-shadow: var(--shadow);
    }
    .card h2, .card h3 { margin: 0 0 0.4rem; font-size: 0.95rem; color: var(--muted); font-weight: 600; }
    .metric { font-size: 1.8rem; font-weight: 700; }
    .metric small { font-size: 0.95rem; color: var(--muted); font-weight: 500; }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 0.75rem;
      align-items: center;
      margin-bottom: 1rem;
    }

    input[type="text"], input[type="date"] {
      font: inherit;
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 0.55rem 0.8rem;
      background: var(--panel);
      color: var(--text);
    }
    input[type="date"]:disabled, select:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
    .day-view-label {
      margin: 0 0 0.75rem;
      font-size: 0.92rem;
      color: var(--muted);
    }
    .day-view-label strong {
      color: var(--text);
    }
    .chart-nav {
      display: inline-flex;
      gap: 0.35rem;
      align-items: center;
    }
    .chart-nav button {
      min-width: 4.5rem;
      padding-left: 0.65rem;
      padding-right: 0.65rem;
    }
    .chart-nav button:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }

    .coverage-summary {
      font-size: 0.92rem;
      color: var(--muted);
      margin-bottom: 0.75rem;
    }
    .coverage-legend {
      display: flex;
      gap: 1rem;
      flex-wrap: wrap;
      font-size: 0.8rem;
      margin-bottom: 0.75rem;
      color: var(--muted);
    }
    .coverage-legend span {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
    }
    .coverage-swatch {
      width: 12px;
      height: 12px;
      border-radius: 3px;
      display: inline-block;
    }
    .coverage-swatch.complete { background: #16a34a; }
    .coverage-swatch.partial { background: #f59e0b; }
    .coverage-swatch.missing { background: #e2e8f0; }
    .coverage-timeline-wrap {
      overflow-x: auto;
      padding-bottom: 0.35rem;
    }
    .coverage-timeline {
      display: flex;
      align-items: stretch;
      height: 28px;
      min-width: min-content;
    }
    .coverage-segment {
      width: 4px;
      min-width: 4px;
      height: 100%;
      cursor: pointer;
      flex-shrink: 0;
      border: 0;
      padding: 0;
    }
    .coverage-segment.complete { background: #16a34a; }
    .coverage-segment.partial { background: #f59e0b; }
    .coverage-segment.missing { background: #e2e8f0; }
    .coverage-segment:hover { opacity: 0.75; }
    .coverage-gaps {
      margin: 0.75rem 0 0;
      padding-left: 1.1rem;
      font-size: 0.88rem;
      color: var(--muted);
    }
    .coverage-tooltip {
      position: absolute;
      pointer-events: none;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 0.45rem 0.65rem;
      font-size: 0.82rem;
      box-shadow: var(--shadow);
      z-index: 2;
      white-space: nowrap;
    }
    select, button {
      font: inherit;
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 0.55rem 0.8rem;
      background: var(--panel);
      color: var(--text);
    }
    button {
      background: var(--accent);
      color: white;
      border-color: var(--accent);
      cursor: pointer;
    }
    button.secondary {
      background: var(--panel);
      color: var(--text);
      border-color: var(--border);
    }
    .chart-wrap {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 1rem 1.25rem 1.25rem;
      box-shadow: var(--shadow);
      margin-bottom: 1.5rem;
      width: 100%;
    }
    .chart-shell {
      position: relative;
    }
    .chart {
      width: 100%;
      height: min(42vh, 420px);
      min-height: 280px;
      display: block;
    }
    .chart-tooltip {
      position: absolute;
      pointer-events: none;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 0.55rem 0.75rem;
      font-size: 0.85rem;
      line-height: 1.35;
      box-shadow: var(--shadow);
      z-index: 2;
      transform: translate(-50%, calc(-100% - 10px));
      white-space: nowrap;
    }
    .chart-tooltip strong {
      color: var(--text);
      font-size: 0.95rem;
    }
    .chart-bar {
      cursor: crosshair;
    }
    .chart-bar-missing {
      cursor: help;
    }
    .chart-missing-legend {
      margin: 0.5rem 0 0;
      font-size: 0.82rem;
    }
    .imports {
      display: grid;
      gap: 0.6rem;
    }
    .import-row {
      display: flex;
      justify-content: space-between;
      gap: 1rem;
      padding: 0.75rem 0;
      border-bottom: 1px solid var(--border);
      font-size: 0.92rem;
    }
    .import-row:last-child { border-bottom: 0; }
    .import-row a {
      color: var(--accent);
      text-decoration: none;
      font-weight: 500;
    }
    .import-row a:hover { text-decoration: underline; }
    .import-history {
      max-height: 28rem;
      overflow-y: auto;
    }
    .import-history-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
      margin-bottom: 0.75rem;
    }
    .muted { color: var(--muted); }
    .setup-section-title {
      margin: 1.25rem 0 0.35rem;
      font-size: 0.95rem;
      color: var(--muted);
      font-weight: 600;
    }
    .setup-section-title:first-of-type {
      margin-top: 0.85rem;
    }
    .setup-field { margin-top: 1rem; }
    .setup-field label {
      display: block;
      font-size: 0.82rem;
      font-weight: 600;
      color: var(--text);
      margin-bottom: 0.25rem;
    }
    .setup-field-note {
      margin: 0 0 0.5rem;
      font-size: 0.84rem;
    }
    .setup-steps {
      margin: 0.75rem 0 0;
      padding-left: 1.25rem;
      line-height: 1.6;
      font-size: 0.92rem;
    }
    .setup-steps li + li { margin-top: 0.65rem; }
    .setup-dev-meta {
      margin: 0.85rem 0 0;
      font-size: 0.84rem;
      line-height: 1.55;
    }
    .token-box {
      display: flex;
      gap: 0.5rem;
      align-items: center;
      flex-wrap: wrap;
    }
    code {
      background: var(--accent-soft);
      padding: 0.35rem 0.55rem;
      border-radius: 8px;
      font-size: 0.85rem;
      word-break: break-all;
    }
    .pill {
      display: inline-block;
      padding: 0.15rem 0.5rem;
      border-radius: 999px;
      font-size: 0.75rem;
      font-weight: 600;
      background: var(--accent-soft);
      color: var(--accent);
    }
    .pill.electric { background: #fef3c7; color: #b45309; }
    .pill.water { background: #e0f2fe; color: #0369a1; }
    .chart-sources {
      margin-top: 0.9rem;
      padding-top: 0.9rem;
      border-top: 1px solid var(--border);
      font-size: 0.88rem;
    }
    .collapse-panel {
      border: none;
    }
    .collapse-panel > summary {
      list-style: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 0.4rem;
      user-select: none;
    }
    .collapse-panel > summary::-webkit-details-marker { display: none; }
    .collapse-panel > summary::before {
      content: "▸";
      color: var(--muted);
      font-size: 0.75rem;
      line-height: 1;
      flex: 0 0 auto;
    }
    .collapse-panel[open] > summary::before { content: "▾"; }
    .collapse-panel > .collapse-body {
      margin-top: 0.55rem;
    }
    .collapse-card-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 1rem;
      flex-wrap: wrap;
    }
    .collapse-card-header .collapse-panel { flex: 1 1 280px; }
    .collapse-card-actions { margin: 0; flex: 0 0 auto; }
    .collapse-title {
      font-size: 1.25rem;
      font-weight: 700;
      color: var(--text);
    }
    .collapse-meta {
      font-size: 0.85rem;
      font-weight: 400;
    }
    .chart-sources h3,
    .chart-sources .collapse-panel > summary {
      margin: 0;
      font-size: 0.82rem;
      color: var(--muted);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .chart-sources .collapse-panel[open] > summary {
      margin-bottom: 0.45rem;
    }
    .chart-sources-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 1rem;
    }
    .chart-sources ul {
      margin: 0;
      padding-left: 1.1rem;
    }
    .chart-sources li {
      margin: 0.3rem 0;
      word-break: break-word;
    }
    .chart-sources a {
      color: var(--accent);
      text-decoration: none;
      font-weight: 500;
    }
    .chart-sources a:hover { text-decoration: underline; }
    .chart-sources .none { color: var(--muted); list-style: none; padding-left: 0; }
    .source-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.35rem 0.65rem;
      margin-top: 0.3rem;
      font-size: 0.82rem;
    }
    .source-actions a {
      color: var(--accent);
      text-decoration: none;
      font-weight: 500;
    }
    .source-actions a:hover { text-decoration: underline; }
    .source-detail {
      margin-top: 0.35rem;
      padding-left: 0;
      list-style: none;
      font-size: 0.8rem;
    }
    .source-detail li {
      margin: 0.2rem 0;
    }
    .source-snippet {
      display: block;
      margin: 0.2rem 0 0.35rem;
      padding: 0.35rem 0.5rem;
      background: var(--accent-soft);
      border-radius: 6px;
      font-size: 0.72rem;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .copy-snippet {
      font-size: 0.72rem;
      padding: 0.15rem 0.4rem;
      margin-left: 0.25rem;
      vertical-align: middle;
    }
    .object-id-hint {
      font-size: 0.82rem;
      color: var(--muted);
      margin: 0 0 0.75rem;
    }
    .missing-sources-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
      flex-wrap: wrap;
      margin-bottom: 0.75rem;
    }
    .missing-sources-list {
      max-height: 28rem;
      overflow-y: auto;
      border: 1px solid var(--border);
      border-radius: 12px;
    }
    .missing-source-row {
      display: grid;
      grid-template-columns: minmax(180px, 1.4fr) minmax(120px, 1fr) minmax(180px, 1.2fr);
      gap: 0.75rem;
      padding: 0.7rem 0.85rem;
      border-bottom: 1px solid var(--border);
      font-size: 0.84rem;
      align-items: start;
    }
    .missing-source-row:last-child { border-bottom: 0; }
    .missing-source-row.has-error { background: #fef2f2; }
    .fetch-error {
      color: #b91c1c;
      font-weight: 600;
      word-break: break-word;
    }
    .fetch-ok {
      color: var(--success);
      font-weight: 600;
    }
    .fetch-unknown {
      color: var(--muted);
    }
    .fetch-confirmed {
      color: #475569;
      font-weight: 600;
    }
    .fetch-on-nbu {
      color: #b45309;
      font-weight: 600;
    }
    .missing-source-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.35rem;
      margin-top: 0.25rem;
    }
    .missing-source-actions button {
      font-size: 0.72rem;
      padding: 0.15rem 0.4rem;
    }
    @media (max-width: 860px) {
      .missing-source-row {
        grid-template-columns: 1fr;
      }
    }
    @media (max-width: 960px) {
      .side-nav {
        position: fixed;
        left: 0;
        top: 0;
        transform: translateX(-100%);
        transition: transform 0.2s ease;
        box-shadow: var(--shadow);
      }
      .side-nav.open { transform: translateX(0); }
      .side-nav-toggle { display: inline-flex; }
      .app-header { padding: 0.75rem 1rem; }
      .header-account-label,
      .header-utility-label { display: none; }
      .header-account-select { font-size: 0.95rem; }
      .main-content { padding: 1rem 1rem 1.75rem; }
    }
    @media (min-width: 961px) {
      .side-nav-backdrop { display: none !important; }
    }
    .empty {
      text-align: center;
      color: var(--muted);
      padding: 2rem 1rem;
    }
  `;
}
function dashboardPage(page) {
    const pageTitle = DASHBOARD_PAGE_TITLES[page];
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NBU Utilities · ${pageTitle}</title>
  <style>${pageStyles()}</style>
</head>
<body>
  <div class="app-shell">
    <aside class="side-nav" id="side-nav" aria-label="Dashboard sections">
      <div class="side-nav-inner">
        <div class="brand">
          <img src="/icon.svg" alt="">
          <div>
            <h1>NBU Utilities</h1>
            <p>New Braunfels Utilities usage dashboard</p>
          </div>
        </div>
        <nav class="side-nav-links">
          ${renderSideNav(page)}
        </nav>
        <p class="sidebar-version">v${APP_VERSION}</p>
      </div>
    </aside>
    <button class="side-nav-backdrop" id="side-nav-backdrop" type="button" aria-label="Close menu" hidden></button>
    <div class="app-main">
      <header class="app-header">
        <div class="app-header-start">
          <button type="button" class="side-nav-toggle secondary" id="side-nav-toggle" aria-controls="side-nav" aria-expanded="false" aria-label="Open menu">☰</button>
          <label class="header-account-label muted" for="account">Account</label>
          <div class="app-header-copy">
            <select id="account" class="header-account-select account-selector" data-account-select aria-label="Select account">
              <option value="">Loading accounts…</option>
            </select>
          </div>
        </div>
        <div class="app-header-end">
          ${headerUtilitySelect(page)}
          <button type="button" class="secondary header-refresh" id="header-refresh">Refresh</button>
        </div>
      </header>
      <main class="main-content" id="main-content">
        ${dashboardPageContent(page)}
      </main>
    </div>
  </div>
  <script>
    const APP_PAGE = ${JSON.stringify(page)};
    const state = {
      overview: null,
      usage: null,
      imports: null,
      coverage: null,
      missingSources: null,
      clipboardScripts: { verifyAll: null, probe: null },
    };

    function on(id, event, handler) {
      const el = document.getElementById(id);
      if (el) el.addEventListener(event, handler);
    }

    function accountProperties(accountId) {
      return (state.overview?.properties ?? []).filter((property) => property.account_id === accountId);
    }

    function selectedAccountId() {
      return document.getElementById("account")?.value || null;
    }

    function selectedPropertyId() {
      const accountId = selectedAccountId();
      if (!accountId) return state.overview?.selected_property?.id ?? null;
      const properties = accountProperties(accountId);
      if (!properties.length) return null;
      const selectedId = state.overview?.selected_property?.id;
      if (selectedId && properties.some((property) => property.id === selectedId)) {
        return selectedId;
      }
      return properties[0].id;
    }

    function propertyForAccount(accountId) {
      const properties = accountProperties(accountId);
      if (!properties.length) return null;
      const selectedId = state.overview?.selected_property?.id;
      if (selectedId && properties.some((property) => property.id === selectedId)) {
        return properties.find((property) => property.id === selectedId) ?? properties[0];
      }
      return properties[0];
    }

    function uniqueAccountIds(properties) {
      const seen = new Set();
      const accounts = [];
      for (const property of properties) {
        if (!property.account_id || seen.has(property.account_id)) continue;
        seen.add(property.account_id);
        accounts.push(property.account_id);
      }
      return accounts.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    }

    function selectedUtility() {
      return document.getElementById("utility")?.value || "electric";
    }

    function propertyParams() {
      const params = new URLSearchParams();
      const propertyId = selectedPropertyId();
      if (propertyId) params.set("property", propertyId);
      return params;
    }

    function renderAccountSelector() {
      const selects = document.querySelectorAll("[data-account-select]");
      const objectIdInput = document.getElementById("property-object-id");
      const objectIdHint = document.getElementById("object-id-hint");
      const o = state.overview;
      if (!selects.length || !o) return;

      const accounts = uniqueAccountIds(o.properties);
      if (!accounts.length) {
        selects.forEach((select) => {
          select.innerHTML = '<option value="">No accounts yet</option>';
          select.disabled = true;
        });
        if (objectIdInput) objectIdInput.value = "";
        if (objectIdHint) objectIdHint.hidden = true;
        return;
      }

      const selectedProperty =
        o.selected_property ??
        propertyForAccount(accounts[0]) ??
        o.properties[0];
      const selectedAccount = selectedProperty?.account_id ?? accounts[0];
      const optionsHtml = accounts.map(
        (accountId) => \`<option value="\${accountId}">\${escapeHtml(accountId)}</option>\`,
      ).join("");
      selects.forEach((select) => {
        select.innerHTML = optionsHtml;
        select.value = selectedAccount;
        select.disabled = false;
      });
      const activeProperty = propertyForAccount(selectedAccount) ?? selectedProperty;
      if (objectIdInput && activeProperty) {
        objectIdInput.value = o.settings.property_object_ids?.[activeProperty.id] ?? "";
      }
      if (objectIdHint && activeProperty) {
        const hasObjectId = Boolean(o.settings.property_object_ids?.[activeProperty.id]);
        objectIdHint.hidden = hasObjectId;
      }
    }

    function syncAccountSelectFromPropertyParam() {
      const propertyParam = new URLSearchParams(window.location.search).get("property");
      if (!propertyParam || !state.overview) return;
      const property = state.overview.properties.find((item) => item.id === propertyParam);
      if (!property?.account_id) return;
      document.querySelectorAll("[data-account-select]").forEach((select) => {
        select.value = property.account_id;
      });
    }

    function escapeHtml(text) {
      return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    async function copyText(text) {
      if (!text) throw new Error("nothing to copy");
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(text);
          return;
        } catch {
          // Fall back for HTTP Umbrel URLs and restrictive browsers.
        }
      }
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.left = "-9999px";
      area.style.top = "0";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.focus();
      area.select();
      area.setSelectionRange(0, text.length);
      const ok = document.execCommand("copy");
      document.body.removeChild(area);
      if (!ok) throw new Error("copy failed");
    }

    async function copySnippet(button, text) {
      if (!button || !text) return;
      const original = button.textContent;
      try {
        await copyText(text);
        button.textContent = "Copied!";
      } catch {
        button.textContent = "Copy failed";
      }
      setTimeout(() => {
        button.textContent = original;
      }, 1500);
    }

    function renderLinkRow(label, url) {
      if (!url) return "";
      return '<li><span class="muted">' + label + ':</span> ' +
        '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener">' + escapeHtml(url) + '</a></li>';
    }

    function sourceFileUrls(item) {
      const viewUrl =
        item.file_view_url ?? (item.stored_filename ? "/api/imports/" + item.id + "/view" : null);
      const fileUrl =
        item.file_url ?? (item.stored_filename ? "/api/imports/" + item.id + "/file" : null);
      return { viewUrl, fileUrl };
    }

    function sourceFilenameLink(item) {
      const { viewUrl } = sourceFileUrls(item);
      if (viewUrl) {
        return (
          '<a href="' + escapeHtml(viewUrl) + '" target="_blank" rel="noopener">' +
            escapeHtml(item.filename) +
          "</a>"
        );
      }
      return escapeHtml(item.filename);
    }

    function renderSourceFileActions(item) {
      const { viewUrl, fileUrl } = sourceFileUrls(item);
      if (!viewUrl && !fileUrl) return "";
      const links = [];
      if (viewUrl) {
        links.push(
          '<a href="' + escapeHtml(viewUrl) + '" target="_blank" rel="noopener">View</a>',
        );
      }
      if (fileUrl) {
        links.push(
          '<a href="' + escapeHtml(fileUrl) + '" target="_blank" rel="noopener">Download</a>',
        );
      }
      return '<div class="source-actions">' + links.join("") + "</div>";
    }

    function fmtNbuVerdict(item) {
      if (!item?.nbu_verdict) return null;
      if (item.nbu_verdict === "NBU_MISSING") {
        return { className: "fetch-confirmed", text: "Also missing on NBU", detail: item.nbu_detail };
      }
      if (item.nbu_verdict === "NBU_HAS_DATA") {
        return { className: "fetch-on-nbu", text: "Data exists on NBU (sync gap)", detail: item.nbu_detail };
      }
      return { className: "fetch-error", text: item.nbu_verdict === "NBU_FETCH_FAILED" ? "NBU fetch failed" : "NBU server error", detail: item.nbu_detail || item.fetch_error };
    }

    function fmtDate(iso) {
      return new Date(iso).toLocaleString();
    }

    function chartSpansYears(points) {
      if (!points?.length) return false;
      const years = new Set(points.map((point) => new Date(point.period_start).getFullYear()));
      return years.size > 1;
    }

    function centralLocalDateKey(iso) {
      return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date(iso));
    }

    function centralTodayKey() {
      return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
    }

    function addDaysToDateKey(dateKey, days) {
      const [year, month, day] = dateKey.split("-").map(Number);
      const next = new Date(Date.UTC(year, month - 1, day + days));
      return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(next);
    }

    function fmtHourLabel(iso) {
      return new Date(iso).toLocaleTimeString(undefined, {
        timeZone: "America/Chicago",
        hour: "numeric",
      });
    }

    function fmtDayHeading(dateKey) {
      const [year, month, day] = dateKey.split("-").map(Number);
      const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
      return date.toLocaleDateString(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
        timeZone: "America/Chicago",
      });
    }

    function compareDateKeys(a, b) {
      return a.localeCompare(b);
    }

    function chartYesterdayKey() {
      return addDaysToDateKey(centralTodayKey(), -1);
    }

    function chartNavState() {
      const dayInput = document.getElementById("day");
      const rangeSelect = document.getElementById("range");
      const rangeEndInput = document.getElementById("range-end");
      const yesterday = chartYesterdayKey();

      if (dayInput?.value) {
        return {
          mode: "day",
          canPrev: true,
          canNext: compareDateKeys(dayInput.value, yesterday) < 0,
        };
      }

      const days = Number(rangeSelect?.value);
      if (!days) {
        return { mode: "all", canPrev: false, canNext: false };
      }

      const end = rangeEndInput?.value || yesterday;
      return {
        mode: "range",
        canPrev: true,
        canNext: compareDateKeys(end, yesterday) < 0,
      };
    }

    function updateChartNavButtons() {
      const prev = document.getElementById("chart-prev");
      const next = document.getElementById("chart-next");
      const state = chartNavState();
      if (prev) prev.disabled = !state.canPrev;
      if (next) next.disabled = !state.canNext;
    }

    function clearRangeEnd() {
      const rangeEndInput = document.getElementById("range-end");
      if (rangeEndInput) rangeEndInput.value = "";
    }

    function navigateChart(direction) {
      const dayInput = document.getElementById("day");
      const rangeSelect = document.getElementById("range");
      const rangeEndInput = document.getElementById("range-end");
      const yesterday = chartYesterdayKey();
      const delta = direction === "prev" ? -1 : 1;

      if (dayInput?.value) {
        const nextDay = addDaysToDateKey(dayInput.value, delta);
        if (direction === "next" && compareDateKeys(nextDay, yesterday) > 0) return;
        dayInput.value = nextDay;
        syncDayControls();
        void loadUsage();
        return;
      }

      const days = Number(rangeSelect?.value);
      if (!days) return;

      const currentEnd = rangeEndInput?.value || yesterday;
      if (direction === "prev") {
        if (rangeEndInput) rangeEndInput.value = addDaysToDateKey(currentEnd, -days);
      } else {
        const newEnd = addDaysToDateKey(currentEnd, days);
        if (compareDateKeys(newEnd, yesterday) >= 0) {
          clearRangeEnd();
        } else if (rangeEndInput) {
          rangeEndInput.value = newEnd;
        }
      }
      void loadUsage();
    }

    function syncDayControls() {
      const dayInput = document.getElementById("day");
      const rangeSelect = document.getElementById("range");
      const clearBtn = document.getElementById("clear-day");
      const dayLabel = document.getElementById("day-view-label");
      const hasDay = Boolean(dayInput?.value);
      if (rangeSelect) rangeSelect.disabled = hasDay;
      if (clearBtn) clearBtn.hidden = !hasDay;
      if (dayLabel) {
        if (hasDay) {
          dayLabel.innerHTML = "Showing hourly usage for <strong>" + fmtDayHeading(dayInput.value) + "</strong>";
          dayLabel.hidden = false;
        } else if (state.usage?.range_start && state.usage?.range_end && Number(rangeSelect?.value)) {
          const startLabel = fmtShortDate(state.usage.range_start + "T12:00:00Z", true);
          const endLabel = fmtShortDate(state.usage.range_end + "T12:00:00Z", true);
          dayLabel.innerHTML = "Showing <strong>" + startLabel + " – " + endLabel + "</strong>";
          dayLabel.hidden = false;
        } else {
          dayLabel.hidden = true;
          dayLabel.textContent = "";
        }
      }
      updateChartNavButtons();
    }

    function fmtShortDate(iso, withYear = false) {
      const opts = withYear
        ? { month: "short", day: "numeric", year: "numeric" }
        : { month: "short", day: "numeric" };
      return new Date(iso).toLocaleDateString(undefined, opts);
    }

    function fmtTooltipLabel(iso, granularity) {
      const date = new Date(iso);
      if (granularity === "hour") {
        return date.toLocaleString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
          year: "numeric",
          hour: "numeric",
          minute: "2-digit",
        });
      }
      return date.toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    }

    function fmtTooltipHtml(point, unit, granularity) {
      const label = fmtTooltipLabel(point.period_start, granularity);
      if (point.missing) {
        return \`\${label}<br><strong>Missing hour</strong>\`;
      }
      const value = Number(point.value).toFixed(2);
      return \`\${label}<br><strong>\${value} \${unit}</strong>\`;
    }

    function positionChartTooltip(event, tooltip) {
      const shell = document.querySelector(".chart-shell");
      if (!shell) return;
      const rect = shell.getBoundingClientRect();
      tooltip.style.left = (event.clientX - rect.left) + "px";
      tooltip.style.top = (event.clientY - rect.top) + "px";
    }

    function bindChartHover(usage) {
      const tooltip = document.getElementById("chart-tooltip");
      const granularity = usage.granularity;
      const bars = document.querySelectorAll(".chart-bar");
      bars.forEach((bar) => {
        bar.addEventListener("mouseenter", (event) => {
          const index = Number(bar.dataset.index);
          const point = usage.points[index];
          if (!point) return;
          tooltip.innerHTML = fmtTooltipHtml(point, usage.unit, granularity);
          tooltip.hidden = false;
          positionChartTooltip(event, tooltip);
        });
        bar.addEventListener("mousemove", (event) => positionChartTooltip(event, tooltip));
        bar.addEventListener("mouseleave", () => {
          tooltip.hidden = true;
        });
        if (granularity === "day" && !usage.date) {
          bar.style.cursor = "pointer";
          bar.addEventListener("click", () => {
            const index = Number(bar.dataset.index);
            const point = usage.points[index];
            if (!point) return;
            const dayInput = document.getElementById("day");
            if (!dayInput) return;
            clearRangeEnd();
            dayInput.value = centralLocalDateKey(point.period_start);
            syncDayControls();
            loadUsage();
          });
        }
      });
    }

    function renderStats() {
      const el = document.getElementById("stats");
      const o = state.overview;
      if (!el || !o) return;
      const utility = selectedUtility();
      const stats =
        utility === "water"
          ? [
              ["Water hours", o.water_hours, "stored"],
              ["Water days", o.water_days, "stored"],
            ]
          : [
              ["Electric hours", o.electric_hours, "stored"],
              ["Electric days", o.electric_days, "stored"],
            ];
      el.innerHTML = stats.map(([label, value, suffix]) => \`
        <div class="card">
          <h3>\${label}</h3>
          <div class="metric">\${value} <small>\${suffix}</small></div>
        </div>
      \`).join("");
    }

    function extensionBaseUrl() {
      return window.location.origin;
    }

    function extensionSettingsText() {
      const token = state.overview?.settings?.ingest_token;
      if (!token) return "";
      return "Umbrel app URL: " + extensionBaseUrl() + "\\nIngest token: " + token;
    }

    function renderExtensionSetup() {
      const tokenEl = document.getElementById("token");
      const baseUrlEl = document.getElementById("extension-base-url");
      if (!state.overview) return;
      if (tokenEl) tokenEl.textContent = state.overview.settings.ingest_token;
      if (baseUrlEl) baseUrlEl.textContent = extensionBaseUrl();
    }

    function renderImports() {
      const importsEl = document.getElementById("imports");
      const items = (state.imports?.imports ?? []).filter(
        (item) => item.format !== "tou_csv" && item.format !== "history_csv",
      );
      if (!importsEl) return;
      if (!items.length) {
        importsEl.innerHTML = '<div class="empty">No uploads yet.</div>';
        return;
      }
      importsEl.innerHTML = items.map((item) => \`
          <div class="import-row">
            <div>
              <span class="pill \${item.utility}">\${item.utility}</span>
              \${sourceFilenameLink(item)}
              <div class="muted">\${item.format} · \${item.reading_count} readings</div>
              \${renderSourceFileActions(item)}
            </div>
            <div class="muted">\${fmtDate(item.imported_at)}</div>
          </div>
        \`).join("");
    }

    function renderChartSources() {
      const el = document.getElementById("chart-sources");
      const usage = state.usage;
      if (!el || !usage) return;

      const sources = usage.sources ?? [];
      const missing = usage.missing ?? [];

      if (!sources.length && !missing.length) {
        el.hidden = true;
        el.innerHTML = "";
        return;
      }

      const sourceItems = sources.length
        ? sources.map((source) => {
            const formatLabel =
              source.format === "hourly_csv" ? "Hourly CSV" : source.format;
            const meta = source.readings_in_view + " readings · " + formatLabel;
            let html = '<li>' + sourceFilenameLink(source) + '<div class="muted">' + meta + "</div>";
            html += renderSourceFileActions(source);
            if (source.nbu_url) {
              html +=
                '<ul class="source-detail"><li><a href="' + escapeHtml(source.nbu_url) +
                '" target="_blank" rel="noopener">NBU CSV</a></li></ul>';
            }
            html += "</li>";
            return html;
          }).join("")
        : '<li class="none">No source files for this view.</li>';

      const missingItems = missing.length
        ? missing.slice(0, 12).map((gap, index) => {
            const clickable = usage.granularity === "hour" && gap.start === gap.end;
            let labelHtml = escapeHtml(gap.label);
            if (clickable) {
              labelHtml = '<button type="button" data-date="' + gap.start + '" style="width:auto;height:auto;padding:0;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer;text-decoration:underline;color:var(--accent)">' + escapeHtml(gap.label) + '</button>';
            }
            let html = '<li>' + labelHtml;
            if (gap.nbu_url) {
              html += '<ul class="source-detail">' + renderLinkRow("Verify on NBU", gap.nbu_url) + '</ul>';
            }
            html += '</li>';
            return html;
          }).join("") + (missing.length > 12
            ? '<li class="muted">…and ' + (missing.length - 12) + ' more · <a href="/sources">View all ' + missing.length + '</a></li>'
            : "")
        : '<li class="none">No gaps in this view.</li>';

      el.innerHTML =
        '<div class="chart-sources-grid">' +
          '<details class="collapse-panel chart-source-panel">' +
            '<summary>Source files (' + sources.length + ')</summary>' +
            '<div class="collapse-body"><ul>' + sourceItems + '</ul></div>' +
          '</details>' +
          '<details class="collapse-panel chart-source-panel">' +
            '<summary>Missing (' + missing.length + ')</summary>' +
            '<div class="collapse-body"><ul>' + missingItems + '</ul></div>' +
          '</details>' +
        '</div>';
      el.hidden = false;

      el.querySelectorAll("button[data-date]").forEach((button) => {
        button.addEventListener("click", () => openCoverageDay(button.dataset.date));
      });
    }

    function renderChart() {
      const usage = state.usage;
      const svg = document.getElementById("chart");
      const tooltip = document.getElementById("chart-tooltip");
      const empty = document.getElementById("chart-empty");
      const missingLegend = document.getElementById("chart-missing-legend");
      if (!usage || !usage.points.length) {
        svg.innerHTML = "";
        if (tooltip) tooltip.hidden = true;
        if (missingLegend) missingLegend.hidden = true;
        empty.hidden = false;
        renderChartSources();
        return;
      }
      const hasMissing = usage.points.some((point) => point.missing);
      empty.hidden = true;
      if (missingLegend) missingLegend.hidden = !hasMissing;
      const width = 1000;
      const height = 300;
      const pad = { top: 20, right: 16, bottom: 52, left: 48 };
      const innerW = width - pad.left - pad.right;
      const innerH = height - pad.top - pad.bottom;
      const dataValues = usage.points.filter((point) => !point.missing).map((point) => point.value);
      const max = Math.max(...dataValues, 0.001);
      const step = innerW / usage.points.length;
      const barW = Math.max(2, step - 2);
      const showYears = chartSpansYears(usage.points);
      const color = usage.utility === "water" ? "#0ea5e9" : "#f59e0b";

      const bars = usage.points.map((point, index) => {
        const x = pad.left + index * step;
        if (point.missing) {
          return \`<rect class="chart-bar chart-bar-missing" data-index="\${index}" x="\${x}" y="\${pad.top}" width="\${barW}" height="\${innerH}" rx="2" fill="#991b1b" opacity="0.82"></rect>\`;
        }
        const h = (point.value / max) * innerH;
        const y = pad.top + innerH - h;
        return \`<rect class="chart-bar" data-index="\${index}" x="\${x}" y="\${y}" width="\${barW}" height="\${h}" rx="2" fill="\${color}" opacity="0.9"></rect>\`;
      }).join("");

      let lastYear = null;
      const yearMarkers = [];
      usage.points.forEach((point, index) => {
        const year = new Date(point.period_start).getFullYear();
        if (year !== lastYear) {
          yearMarkers.push({ year, index });
          lastYear = year;
        }
      });

      const yearLines = yearMarkers.map(({ year, index }) => {
        const x = pad.left + index * step;
        return \`
          <line x1="\${x}" y1="\${pad.top}" x2="\${x}" y2="\${pad.top + innerH}" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="4 4"></line>
          <text x="\${x + 4}" y="\${height - 8}" fill="#475569" font-size="12" font-weight="700">\${year}</text>
        \`;
      }).join("");

      let tickIndexes;
      let labelForIndex;
      if (usage.date) {
        tickIndexes = new Set(
          [0, 6, 12, 18, usage.points.length - 1].filter((index) => index < usage.points.length)
        );
        labelForIndex = (index) => fmtHourLabel(usage.points[index].period_start);
      } else {
        tickIndexes = new Set(
          [0, Math.floor(usage.points.length / 2), usage.points.length - 1]
            .concat(yearMarkers.map((marker) => marker.index))
        );
        labelForIndex = (index) => {
          const point = usage.points[index];
          const isYearStart = yearMarkers.some((marker) => marker.index === index);
          return isYearStart
            ? fmtShortDate(point.period_start, true)
            : fmtShortDate(point.period_start, showYears);
        };
      }
      const labels = [...tickIndexes]
        .sort((a, b) => a - b)
        .map((index) => {
          const x = pad.left + index * step;
          const label = labelForIndex(index);
          return \`<text x="\${x}" y="\${height - 28}" fill="#64748b" font-size="11">\${label}</text>\`;
        }).join("");

      svg.innerHTML = \`
        <line x1="\${pad.left}" y1="\${pad.top + innerH}" x2="\${width - pad.right}" y2="\${pad.top + innerH}" stroke="#e2e8f0"></line>
        <text x="12" y="\${pad.top + 12}" fill="#64748b" font-size="12">\${max.toFixed(1)} \${usage.unit}</text>
        \${yearLines}
        \${bars}
        \${labels}
      \`;
      bindChartHover(usage);
    }

    function fmtCoverageDate(dateKey) {
      const [year, month, day] = dateKey.split("-").map(Number);
      const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
      return date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "America/Chicago",
      });
    }

    function fmtCoverageRange(start, end) {
      if (!start || !end) return "";
      if (start === end) return fmtCoverageDate(start);
      return fmtCoverageDate(start) + " – " + fmtCoverageDate(end);
    }

    function fmtGapLabel(gap, daysByDate) {
      const range = gap.start === gap.end
        ? fmtCoverageDate(gap.start)
        : fmtCoverageDate(gap.start) + "–" + fmtCoverageDate(gap.end);
      const label = gap.status === "missing" ? "Missing" : "Partial";
      if (gap.days === 1 && gap.status === "partial") {
        const day = daysByDate.get(gap.start);
        const hours = day?.hours_present ?? 0;
        return label + ": " + range + " (" + hours + "/24 hours)";
      }
      return label + ": " + range + " (" + gap.days + " day" + (gap.days === 1 ? "" : "s") + ")";
    }

    function openCoverageDay(dateKey) {
      const dayInput = document.getElementById("day");
      const granularity = document.getElementById("granularity");
      if (dayInput && granularity) {
        clearRangeEnd();
        dayInput.value = dateKey;
        granularity.value = "hour";
        syncDayControls();
        void loadUsage();
        document.querySelector(".chart-wrap")?.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      const params = new URLSearchParams();
      const propertyId = selectedPropertyId();
      const utility = selectedUtility();
      if (propertyId) params.set("property", propertyId);
      if (utility) params.set("utility", utility);
      params.set("date", dateKey);
      window.location.href = "/?" + params.toString();
    }

    function initSideNav() {
      const nav = document.getElementById("side-nav");
      const toggle = document.getElementById("side-nav-toggle");
      const backdrop = document.getElementById("side-nav-backdrop");
      const links = [...document.querySelectorAll(".side-nav-link")];

      function setNavOpen(open) {
        nav?.classList.toggle("open", open);
        if (backdrop) backdrop.hidden = !open;
        toggle?.setAttribute("aria-expanded", String(open));
        toggle?.setAttribute("aria-label", open ? "Close menu" : "Open menu");
      }

      toggle?.addEventListener("click", () => setNavOpen(!nav?.classList.contains("open")));
      backdrop?.addEventListener("click", () => setNavOpen(false));
      links.forEach((link) => link.addEventListener("click", () => setNavOpen(false)));
    }

    function applyUsageQueryParams() {
      const params = new URLSearchParams(window.location.search);
      const dayInput = document.getElementById("day");
      const granularity = document.getElementById("granularity");
      const utility = document.getElementById("utility");
      const day = params.get("date");
      const utilityParam = params.get("utility");
      if (utility && utilityParam) utility.value = utilityParam;
      if (day && dayInput && granularity) {
        dayInput.value = day;
        granularity.value = "hour";
        syncDayControls();
      }
    }

    async function reloadCurrentPage() {
      await loadOverview();
      switch (APP_PAGE) {
        case "overview":
          renderStats();
          await loadUsage();
          await loadCoverage();
          break;
        case "sources":
          await loadMissingSources();
          await loadImports();
          break;
        case "setup":
          renderExtensionSetup();
          await refreshBackupStatus();
          break;
      }
    }

    async function refreshDashboard() {
      await reloadCurrentPage();
    }

    async function initPage() {
      await loadOverview();
      switch (APP_PAGE) {
        case "overview":
          applyUsageQueryParams();
          renderStats();
          await loadUsage();
          await loadCoverage();
          break;
        case "sources":
          await loadMissingSources();
          await loadImports();
          break;
        case "setup":
          renderExtensionSetup();
          await refreshBackupStatus();
          break;
      }
    }

    function renderCoverage() {
      const el = document.getElementById("coverage-content");
      const coverage = state.coverage;
      if (!el) return;

      if (!coverage || !coverage.days?.length) {
        el.innerHTML = '<div class="empty">No hourly records yet. Run a Chrome extension sync on the Consumption Report page.</div>';
        return;
      }

      const summary = coverage.coverage_pct + "% coverage · " +
        coverage.complete_days + " complete · " +
        coverage.partial_days + " partial · " +
        coverage.missing_days + " missing";

      const daysByDate = new Map(coverage.days.map((day) => [day.date, day]));
      const segments = coverage.days.map((day) =>
        '<button type="button" class="coverage-segment ' + day.status + '" data-date="' + day.date + '" title="' +
        fmtCoverageDate(day.date) + " · " + day.hours_present + "/24 hours" + '"></button>'
      ).join("");

      const gaps = coverage.gaps.slice(0, 8);
      const gapHtml = gaps.length
        ? '<ul class="coverage-gaps">' + gaps.map((gap) => "<li>" + fmtGapLabel(gap, daysByDate) + "</li>").join("") +
          (coverage.gaps.length > 8 ? "<li>…and " + (coverage.gaps.length - 8) + " more</li>" : "") + "</ul>"
        : '<p class="muted" style="margin:0.75rem 0 0">No gaps detected in this range.</p>';

      el.innerHTML =
        '<p class="coverage-summary"><strong>' + summary + '</strong> · ' + fmtCoverageRange(coverage.range_start, coverage.range_end) + '</p>' +
        '<div class="coverage-legend">' +
          '<span><i class="coverage-swatch complete"></i>Complete (24h)</span>' +
          '<span><i class="coverage-swatch partial"></i>Partial</span>' +
          '<span><i class="coverage-swatch missing"></i>Missing</span>' +
        '</div>' +
        '<div class="coverage-timeline-wrap"><div class="coverage-timeline" id="coverage-timeline">' + segments + '</div></div>' +
        gapHtml;

      document.querySelectorAll(".coverage-segment").forEach((segment) => {
        segment.addEventListener("click", () => openCoverageDay(segment.dataset.date));
      });
    }

    async function loadCoverage() {
      const params = propertyParams();
      params.set("utility", selectedUtility());
      const res = await fetch("/api/coverage?" + params.toString());
      state.coverage = await res.json();
      renderCoverage();
    }

    function renderMissingSources() {
      const summaryEl = document.getElementById("missing-sources-summary");
      const contentEl = document.getElementById("missing-sources-content");
      const probeBtn = document.getElementById("copy-probe-script");
      const verifyAllBtn = document.getElementById("copy-verify-all-script");
      const data = state.missingSources;
      if (!summaryEl || !contentEl) return;

      if (!data?.items?.length) {
        summaryEl.textContent = data?.object_id
          ? "No missing hourly gaps in the current range."
          : "No missing gaps yet, or set the NBU Object ID to generate verify snippets.";
        contentEl.innerHTML = '<div class="empty">No missing sources to list.</div>';
        if (probeBtn) probeBtn.hidden = true;
        if (verifyAllBtn) verifyAllBtn.hidden = true;
        return;
      }

      const summaryParts = [data.total + " gap" + (data.total === 1 ? "" : "s")];
      if (data.checked_on_nbu) summaryParts.push(data.checked_on_nbu + " checked on NBU");
      if (data.confirmed_missing_on_nbu) summaryParts.push(data.confirmed_missing_on_nbu + " confirmed missing on NBU");
      if (data.has_data_on_nbu) summaryParts.push(data.has_data_on_nbu + " on NBU only (sync gap)");
      if (data.with_errors) summaryParts.push(data.with_errors + " NBU errors");
      if (data.range_start && data.range_end) summaryParts.push(fmtCoverageRange(data.range_start, data.range_end));
      summaryEl.textContent = summaryParts.join(" · ");

      state.clipboardScripts.verifyAll = data.verify_all_script || null;
      state.clipboardScripts.probe = data.probe_script || null;
      if (verifyAllBtn) verifyAllBtn.hidden = !state.clipboardScripts.verifyAll;
      if (probeBtn) probeBtn.hidden = !state.clipboardScripts.probe;

      const rows = data.items.map((item, index) => {
        const verdict = fmtNbuVerdict(item);
        const rowClass = "missing-source-row" + (verdict?.className === "fetch-error" ? " has-error" : "");
        let fetchHtml = '<span class="fetch-unknown">Not checked on NBU</span>';
        if (verdict) {
          fetchHtml = '<span class="' + verdict.className + '">' + escapeHtml(verdict.text) + '</span>';
          if (verdict.detail) fetchHtml += '<div class="muted">' + escapeHtml(verdict.detail) + '</div>';
          if (item.fetch_status !== null && item.fetch_status !== undefined) {
            fetchHtml += '<div class="muted">HTTP ' + item.fetch_status + '</div>';
          }
          if (item.fetch_preview) {
            fetchHtml += '<code class="source-snippet">' + escapeHtml(item.fetch_preview) + '</code>';
          }
          if (item.fetch_probed_at) {
            fetchHtml += '<div class="muted">' + escapeHtml(item.fetch_source || "probe") +
              " · " + fmtDate(item.fetch_probed_at) + '</div>';
          }
        }

        let linksHtml = "";
        if (item.nbu_url) {
          linksHtml += '<div class="missing-source-actions">';
          linksHtml += '<a href="' + escapeHtml(item.nbu_url) + '" target="_blank" rel="noopener">NBU URL</a>';
          if (item.nbu_fetch) {
            linksHtml += '<button type="button" class="secondary copy-snippet" data-kind="missing-list-nbu" data-index="' + index + '">Copy verify snippet</button>';
          }
          if (item.start === item.end) {
            linksHtml += '<button type="button" class="secondary" data-date="' + item.start + '">View day</button>';
          }
          linksHtml += '</div>';
          if (item.nbu_fetch) {
            linksHtml += '<code class="source-snippet">' + escapeHtml(item.nbu_fetch) + '</code>';
          }
        } else {
          linksHtml = '<span class="muted"><a href="/setup">Set Object ID on Setup</a> for verify snippet</span>';
        }

        return '<div class="' + rowClass + '">' +
          '<div><strong>' + escapeHtml(item.label) + '</strong><div class="muted">' + escapeHtml(item.start) +
          (item.end !== item.start ? " – " + escapeHtml(item.end) : "") + '</div></div>' +
          '<div>' + fetchHtml + '</div>' +
          '<div>' + linksHtml + '</div>' +
        '</div>';
      }).join("");

      contentEl.innerHTML = '<div class="missing-sources-list">' + rows + '</div>';

      contentEl.querySelectorAll(".copy-snippet").forEach((button) => {
        const index = Number(button.dataset.index);
        const text = data.items[index]?.nbu_fetch ?? null;
        button.addEventListener("click", () => copySnippet(button, text));
      });
      contentEl.querySelectorAll("button[data-date]").forEach((button) => {
        button.addEventListener("click", () => openCoverageDay(button.dataset.date));
      });
    }

    async function loadMissingSources() {
      const params = propertyParams();
      params.set("utility", selectedUtility());
      const res = await fetch("/api/missing-sources?" + params.toString());
      state.missingSources = await res.json();
      renderMissingSources();
    }

    async function loadOverview() {
      const params = propertyParams();
      const res = await fetch("/api/overview?" + params.toString());
      state.overview = await res.json();
      renderAccountSelector();
      syncAccountSelectFromPropertyParam();
      if (APP_PAGE === "overview") renderStats();
      if (APP_PAGE === "setup") renderExtensionSetup();
    }

    async function loadImports() {
      const params = propertyParams();
      params.set("limit", "1000");
      const res = await fetch("/api/imports?" + params.toString());
      state.imports = await res.json();
      renderImports();
      const countEl = document.getElementById("import-count");
      if (countEl && state.imports?.total) {
        const total = state.imports.total;
        countEl.textContent = total + " upload" + (total === 1 ? "" : "s");
      }
    }

    async function loadUsage() {
      const granularityEl = document.getElementById("granularity");
      const rangeEl = document.getElementById("range");
      if (!granularityEl || !rangeEl) return;
      const granularity = granularityEl.value;
      const days = rangeEl.value;
      const day = document.getElementById("day")?.value || "";
      const rangeEnd = document.getElementById("range-end")?.value || "";
      const params = propertyParams();
      params.set("utility", selectedUtility());
      params.set("granularity", granularity);
      if (day) params.set("date", day);
      else if (days) {
        params.set("days", days);
        if (rangeEnd) params.set("end", rangeEnd);
      }
      syncDayControls();
      const res = await fetch("/api/usage?" + params.toString());
      state.usage = await res.json();
      renderChart();
      renderChartSources();
    }

    async function savePropertySelection(propertyId) {
      await fetch("/api/settings/property", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ property_id: propertyId }),
      });
    }

    on("account", "change", async (event) => {
      const accountId = event.target.value;
      const property = propertyForAccount(accountId);
      if (!property) return;
      const objectIdInput = document.getElementById("property-object-id");
      if (objectIdInput) {
        objectIdInput.value = state.overview.settings.property_object_ids?.[property.id] ?? "";
      }
      const objectIdHint = document.getElementById("object-id-hint");
      if (objectIdHint) {
        objectIdHint.hidden = Boolean(state.overview.settings.property_object_ids?.[property.id]);
      }
      await savePropertySelection(property.id);
      await reloadCurrentPage();
    });
    on("save-object-id", "click", async () => {
      const propertyId = selectedPropertyId();
      const objectId = document.getElementById("property-object-id").value;
      if (!propertyId) return;
      const res = await fetch("/api/settings/property-object-id", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ property_id: propertyId, object_id: objectId }),
      });
      const payload = await res.json();
      if (payload.settings) {
        state.overview.settings = payload.settings;
        const objectIdHint = document.getElementById("object-id-hint");
        if (objectIdHint) objectIdHint.hidden = Boolean(objectId.trim());
        if (APP_PAGE === "overview") await loadUsage();
        if (APP_PAGE === "sources") await loadMissingSources();
        if (APP_PAGE === "setup") await refreshBackupStatus();
      }
    });
    on("utility", "change", async () => {
      if (APP_PAGE === "overview") {
        renderStats();
        await loadUsage();
      }
      if (APP_PAGE === "overview") await loadCoverage();
      if (APP_PAGE === "sources") await loadMissingSources();
    });
    on("granularity", "change", () => {
      clearRangeEnd();
      loadUsage();
    });
    on("range", "change", () => {
      clearRangeEnd();
      loadUsage();
    });
    on("day", "change", () => {
      clearRangeEnd();
      loadUsage();
    });
    on("clear-day", "click", () => {
      const dayInput = document.getElementById("day");
      if (!dayInput) return;
      dayInput.value = "";
      clearRangeEnd();
      syncDayControls();
      loadUsage();
    });
    on("chart-prev", "click", () => navigateChart("prev"));
    on("chart-next", "click", () => navigateChart("next"));
    on("refresh", "click", () => {
      void refreshDashboard();
    });
    on("header-refresh", "click", () => {
      void refreshDashboard();
    });
    on("refresh-missing-sources", "click", loadMissingSources);
    on("copy-verify-all-script", "click", async (event) => {
      const button = event.currentTarget;
      const script = state.clipboardScripts.verifyAll;
      if (!script) return;
      await copySnippet(button, script);
    });
    on("copy-probe-script", "click", async (event) => {
      const button = event.currentTarget;
      const script = state.clipboardScripts.probe;
      if (!script) return;
      await copySnippet(button, script);
    });
    on("copy-base-url", "click", async (event) => {
      const button = event.currentTarget;
      await copySnippet(button, extensionBaseUrl());
    });
    on("copy-token", "click", async (event) => {
      const token = state.overview?.settings?.ingest_token;
      const button = event.currentTarget;
      if (!token) return;
      await copySnippet(button, token);
    });
    on("copy-extension-settings", "click", async (event) => {
      const button = event.currentTarget;
      const text = extensionSettingsText();
      if (!text) return;
      await copySnippet(button, text);
    });
    on("rotate-token", "click", async () => {
      const res = await fetch("/api/settings/rotate-token", { method: "POST" });
      const payload = await res.json();
      if (payload.settings) {
        state.overview.settings = payload.settings;
        renderExtensionSetup();
      }
    });

    function formatBackupTimestamp(iso) {
      if (!iso) return "never";
      return new Date(iso).toLocaleString();
    }

    function formatObjectIdList(items) {
      if (!items?.length) return "<li>None saved</li>";
      return items.map((item) =>
        "<li>" + escapeHtml(item.label) + ": <code>" + escapeHtml(item.object_id) + "</code></li>"
      ).join("");
    }

    function renderBackupObjectIds(payload) {
      const el = document.getElementById("backup-object-ids");
      if (!el) return;
      const liveCount = payload.live_object_id_count ?? 0;
      const backupCount = payload.backup_object_id_count ?? 0;
      let html = "<strong>Object IDs in backup</strong> · live: " + liveCount +
        (payload.backup_available ? " · backup: " + backupCount : "");
      html += "<ul>" + formatObjectIdList(payload.live_object_ids) + "</ul>";
      if (payload.backup_available && backupCount !== liveCount) {
        html += '<div style="margin-top:0.5rem"><strong>Object IDs in backup folder</strong><ul>' +
          formatObjectIdList(payload.backup_object_ids) + "</ul></div>";
      }
      el.innerHTML = html;
    }

    async function refreshBackupStatus(message) {
      const liveSummary = document.getElementById("backup-live-summary");
      const folderSummary = document.getElementById("backup-folder-summary");
      const hostPathEl = document.getElementById("backup-host-path");
      const statusEl = document.getElementById("backup-status");
      const exportBtn = document.getElementById("backup-export-btn");
      const importBtn = document.getElementById("backup-import-btn");
      if (message && statusEl) statusEl.textContent = message;
      try {
        const response = await fetch("/api/backup/status");
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Could not load backup status.");
        const hostPath = payload.backup_host_path || "/home/umbrel/nbu-backup";
        if (hostPathEl) hostPathEl.textContent = hostPath;
        if (liveSummary) {
          liveSummary.textContent =
            payload.live_reading_count + " readings · " + payload.live_import_count + " imports · " +
            (payload.live_object_id_count ?? 0) + " Object ID" + ((payload.live_object_id_count ?? 0) === 1 ? "" : "s");
        }
        if (folderSummary) {
          if (!payload.backup_available) {
            folderSummary.textContent = "No backup yet.";
          } else {
            folderSummary.textContent =
              payload.backup_reading_count + " readings · " + payload.backup_import_count + " imports · " +
              (payload.backup_object_id_count ?? 0) + " Object ID" + ((payload.backup_object_id_count ?? 0) === 1 ? "" : "s");
          }
        }
        renderBackupObjectIds(payload);
        if (statusEl && !message) {
          if (!payload.backup_writable) {
            statusEl.textContent =
              "Backup folder is not writable" +
              (payload.backup_writable_error ? " (" + payload.backup_writable_error + ")." : ".");
          } else if (!payload.backup_available) {
            statusEl.textContent = "No backup yet at " + hostPath + ". Click Back up now to create one.";
          } else {
            statusEl.textContent =
              "Backup ready with " +
              payload.backup_reading_count +
              " readings and " +
              (payload.backup_object_id_count ?? 0) +
              " Object ID" + ((payload.backup_object_id_count ?? 0) === 1 ? "" : "s") +
              ". Last backup: " +
              formatBackupTimestamp(payload.backup_updated_at) +
              ".";
          }
        }
        if (exportBtn) exportBtn.disabled = !payload.backup_writable;
        if (importBtn) importBtn.disabled = !payload.backup_available;
      } catch (error) {
        if (liveSummary) liveSummary.textContent = "Unavailable";
        if (folderSummary) folderSummary.textContent = "Unavailable";
        const objectIdsEl = document.getElementById("backup-object-ids");
        if (objectIdsEl) objectIdsEl.textContent = "";
        if (statusEl) statusEl.textContent = error.message || "Could not load backup status.";
        if (exportBtn) exportBtn.disabled = true;
        if (importBtn) importBtn.disabled = true;
      }
    }

    on("backup-export-btn", "click", async () => {
      const exportBtn = document.getElementById("backup-export-btn");
      const importBtn = document.getElementById("backup-import-btn");
      if (exportBtn) exportBtn.disabled = true;
      if (importBtn) importBtn.disabled = true;
      await refreshBackupStatus("Creating backup…");
      try {
        const response = await fetch("/api/backup/export", { method: "POST" });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Backup failed.");
        await refreshBackupStatus("Backup completed.");
      } catch (error) {
        const statusEl = document.getElementById("backup-status");
        if (statusEl) statusEl.textContent = error.message || "Backup failed.";
        await refreshBackupStatus();
      }
    });

    on("backup-import-btn", "click", async () => {
      if (!confirm("Restore from backup? This replaces all live usage data and settings with the backed-up copy.")) {
        return;
      }
      const exportBtn = document.getElementById("backup-export-btn");
      const importBtn = document.getElementById("backup-import-btn");
      if (exportBtn) exportBtn.disabled = true;
      if (importBtn) importBtn.disabled = true;
      await refreshBackupStatus("Restoring from backup…");
      try {
        const response = await fetch("/api/backup/import", { method: "POST" });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Restore failed.");
        await refreshBackupStatus("Restore completed.");
        window.location.href = "/";
      } catch (error) {
        const statusEl = document.getElementById("backup-status");
        if (statusEl) statusEl.textContent = error.message || "Restore failed.";
        await refreshBackupStatus();
      }
    });

    initSideNav();
    void initPage();
  </script>
</body>
</html>`;
}
function escapeHtmlText(text) {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
function importViewPage(importId, filename, format, content) {
    const escaped = escapeHtmlText(content);
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtmlText(filename)}</title>
  <style>
    body { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #0f172a; color: #e2e8f0; }
    header { padding: 1rem 1.25rem; background: #1e293b; border-bottom: 1px solid #334155; }
    header a { color: #93c5fd; text-decoration: none; }
    header a:hover { text-decoration: underline; }
    h1 { margin: 0.35rem 0 0; font-size: 1rem; font-weight: 600; word-break: break-all; }
    .meta { margin: 0.25rem 0 0; font-size: 0.85rem; color: #94a3b8; }
    pre { margin: 0; padding: 1rem 1.25rem 2rem; white-space: pre-wrap; word-break: break-word; font-size: 0.82rem; line-height: 1.45; }
  </style>
</head>
<body>
  <header>
    <a href="/">← Dashboard</a>
    <h1>${escapeHtmlText(filename)}</h1>
    <p class="meta">${escapeHtmlText(format)} · <a href="/api/imports/${importId}/file">Raw file</a></p>
  </header>
  <pre>${escaped}</pre>
</body>
</html>`;
}
const server = (0, node_http_1.createServer)(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;
    if (req.method === "OPTIONS") {
        sendJson(res, 204, {});
        return;
    }
    try {
        if (req.method === "GET" && pathname === "/icon.svg") {
            const icon = await (0, promises_1.readFile)(ICON_PATH);
            res.writeHead(200, { "Content-Type": "image/svg+xml" });
            res.end(icon);
            return;
        }
        if (req.method === "GET" && pathname === "/api/properties") {
            sendJson(res, 200, { properties: await (0, store_1.listProperties)() });
            return;
        }
        if (req.method === "GET" && pathname === "/api/overview") {
            const settings = await (0, store_1.loadSettings)();
            const properties = await (0, store_1.listProperties)();
            const propertyId = (0, store_1.resolvePropertyId)(url.searchParams.get("property"), settings, properties);
            sendJson(res, 200, await (0, store_1.getOverview)(propertyId));
            return;
        }
        if (req.method === "GET" && pathname === "/api/imports") {
            const settings = await (0, store_1.loadSettings)();
            const properties = await (0, store_1.listProperties)();
            const propertyId = (0, store_1.resolvePropertyId)(url.searchParams.get("property"), settings, properties);
            const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 500) || 500, 1), 5000);
            const offset = Math.max(Number(url.searchParams.get("offset") ?? 0) || 0, 0);
            const result = await (0, store_1.listImports)(propertyId, limit, offset);
            sendJson(res, 200, {
                ...result,
                imports: result.imports.map((item) => ({
                    ...item,
                    file_url: item.stored_filename ? `/api/imports/${item.id}/file` : null,
                    file_view_url: item.stored_filename ? `/api/imports/${item.id}/view` : null,
                })),
            });
            return;
        }
        const importViewMatch = pathname.match(/^\/api\/imports\/([a-f0-9]+)\/view$/);
        if (req.method === "GET" && importViewMatch) {
            const imports = await (0, store_1.listImports)(null, 5000, 0);
            const record = imports.imports.find((item) => item.id === importViewMatch[1]);
            const stored = await (0, store_1.getStoredImportFile)(importViewMatch[1]);
            if (!stored || !record) {
                sendJson(res, 404, { error: "file not found" });
                return;
            }
            sendText(res, 200, "text/html; charset=utf-8", importViewPage(importViewMatch[1], stored.filename, record.format, stored.content.toString("utf8")));
            return;
        }
        const importFileMatch = pathname.match(/^\/api\/imports\/([a-f0-9]+)\/file$/);
        if (req.method === "GET" && importFileMatch) {
            const stored = await (0, store_1.getStoredImportFile)(importFileMatch[1]);
            if (!stored) {
                sendJson(res, 404, { error: "file not found" });
                return;
            }
            sendFile(res, 200, stored.contentType, stored.content, stored.filename);
            return;
        }
        if (req.method === "GET" && pathname === "/api/coverage") {
            const settings = await (0, store_1.loadSettings)();
            const properties = await (0, store_1.listProperties)();
            const propertyId = (0, store_1.resolvePropertyId)(url.searchParams.get("property"), settings, properties);
            const utility = parseUtility(url.searchParams.get("utility"));
            sendJson(res, 200, await (0, store_1.getCoverageSummary)(propertyId, utility));
            return;
        }
        if (req.method === "GET" && pathname === "/api/missing-sources") {
            const settings = await (0, store_1.loadSettings)();
            const properties = await (0, store_1.listProperties)();
            const propertyId = (0, store_1.resolvePropertyId)(url.searchParams.get("property"), settings, properties);
            const utility = parseUtility(url.searchParams.get("utility"));
            const baseUrl = `http://${req.headers.host ?? "localhost"}`;
            sendJson(res, 200, await (0, store_1.getMissingSources)(propertyId, utility, baseUrl));
            return;
        }
        if (req.method === "POST" && pathname === "/api/missing-sources/probes") {
            if (!(await authorizeIngest(req))) {
                sendJson(res, 401, { error: "invalid ingest token" });
                return;
            }
            const body = JSON.parse((await readBody(req)).toString("utf8"));
            const recorded = await (0, store_1.recordFetchProbes)(body.property_id ?? null, parseUtility(body.utility ?? null), body.probes ?? []);
            sendJson(res, 200, { ok: true, recorded });
            return;
        }
        if (req.method === "POST" && pathname === "/api/sync-errors") {
            if (!(await authorizeIngest(req))) {
                sendJson(res, 401, { error: "invalid ingest token" });
                return;
            }
            const body = JSON.parse((await readBody(req)).toString("utf8"));
            const recorded = await (0, store_1.recordSyncFetchErrors)({
                utility: body.utility,
                object_id: body.object_id,
                property_id: body.property_id ?? null,
                errors: body.errors ?? [],
            });
            sendJson(res, 200, { ok: true, recorded });
            return;
        }
        if (req.method === "GET" && pathname === "/api/usage") {
            const settings = await (0, store_1.loadSettings)();
            const properties = await (0, store_1.listProperties)();
            const propertyId = (0, store_1.resolvePropertyId)(url.searchParams.get("property"), settings, properties);
            const utility = parseUtility(url.searchParams.get("utility"));
            const granularity = parseGranularity(url.searchParams.get("granularity"));
            const date = (0, store_1.parseDateParam)(url.searchParams.get("date"));
            const days = date ? null : parseDays(url.searchParams.get("days"));
            const endDate = date || !days ? null : (0, store_1.parseDateParam)(url.searchParams.get("end"));
            sendJson(res, 200, await (0, store_1.getUsageSummary)(propertyId, utility, granularity, days, date, endDate));
            return;
        }
        if (req.method === "GET" && pathname === "/api/settings") {
            const settings = await (0, store_1.loadSettings)();
            sendJson(res, 200, { settings });
            return;
        }
        if (req.method === "POST" && pathname === "/api/settings/rotate-token") {
            const settings = await (0, store_1.rotateIngestToken)();
            sendJson(res, 200, { settings });
            return;
        }
        if (req.method === "POST" && pathname === "/api/settings/property") {
            const body = JSON.parse((await readBody(req)).toString("utf8"));
            const settings = await (0, store_1.setSelectedProperty)(body.property_id ?? null);
            sendJson(res, 200, { settings });
            return;
        }
        if (req.method === "POST" && pathname === "/api/settings/property-label") {
            const body = JSON.parse((await readBody(req)).toString("utf8"));
            if (!body.property_id) {
                sendJson(res, 400, { error: "property_id is required" });
                return;
            }
            const settings = await (0, store_1.setPropertyLabel)(body.property_id, body.label ?? "");
            sendJson(res, 200, { settings });
            return;
        }
        if (req.method === "POST" && pathname === "/api/settings/property-object-id") {
            const body = JSON.parse((await readBody(req)).toString("utf8"));
            if (!body.property_id) {
                sendJson(res, 400, { error: "property_id is required" });
                return;
            }
            const settings = await (0, store_1.setPropertyObjectId)(body.property_id, body.object_id ?? "");
            sendJson(res, 200, { settings });
            return;
        }
        if (req.method === "GET" && pathname === "/api/ingest/ping") {
            if (!(await authorizeIngest(req))) {
                sendJson(res, 401, { error: "invalid ingest token" });
                return;
            }
            sendJson(res, 200, { ok: true });
            return;
        }
        if (req.method === "POST" && pathname === "/api/ingest") {
            await handleIngest(req, res);
            return;
        }
        if (req.method === "GET" && pathname === "/api/backup/status") {
            sendJson(res, 200, await (0, backup_restore_1.getBackupStatus)(DATA_ROOT, BACKUP_ROOT, BACKUP_HOST_PATH));
            return;
        }
        if (req.method === "POST" && pathname === "/api/backup/export") {
            try {
                const status = await (0, backup_restore_1.exportNbuData)(DATA_ROOT, BACKUP_ROOT, BACKUP_HOST_PATH);
                sendJson(res, 200, status);
            }
            catch (error) {
                sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
            }
            return;
        }
        if (req.method === "POST" && pathname === "/api/backup/import") {
            try {
                const status = await (0, backup_restore_1.importNbuData)(DATA_ROOT, BACKUP_ROOT, BACKUP_HOST_PATH);
                (0, store_1.resetStoreCaches)();
                sendJson(res, 200, status);
            }
            catch (error) {
                sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
            }
            return;
        }
        if (req.method === "GET" &&
            (pathname === "/usage" ||
                pathname === "/coverage" ||
                pathname === "/missing-sources" ||
                pathname === "/uploads" ||
                pathname === "/upload-history")) {
            const target = pathname === "/missing-sources" || pathname === "/uploads" || pathname === "/upload-history"
                ? "/sources" + (url.search || "")
                : "/" + (url.search || "");
            res.writeHead(302, { Location: target });
            res.end();
            return;
        }
        const dashboardPageId = resolveDashboardPage(pathname);
        if (req.method === "GET" && dashboardPageId) {
            sendText(res, 200, "text/html; charset=utf-8", dashboardPage(dashboardPageId));
            return;
        }
        if (req.method === "GET" && pathname === "/index.html") {
            res.writeHead(302, { Location: "/" });
            res.end();
            return;
        }
        sendJson(res, 404, { error: "not found" });
    }
    catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
});
server.listen(PORT, () => {
    console.log(`NBU dashboard listening on :${PORT}`);
});
