import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { clearNbuBackup, exportNbuData, getBackupStatus, importNbuData } from "./backup-restore";
import { parseNbuExport, type Granularity, type Utility } from "./parsers";
import {
  clearUsageData,
  getCoverageSummary,
  getMissingSources,
  getOverview,
  getStoredImportFile,
  getUsageSummary,
  importParsed,
  listImports,
  listProperties,
  loadSettings,
  parseDateParam,
  recordFetchProbes,
  recordSyncFetchErrors,
  resetStoreCaches,
  resolvePropertyId,
  rotateIngestToken,
  setPropertyLabel,
  setPropertyObjectId,
  setSelectedProperty,

} from "./store";

const APP_VERSION = "1.22.1";
const IS_LOCAL_DEV = process.env.NBU_DEV === "1";
const EXTENSION_REPO_URL =
  "https://github.com/wolverineks/umbrel_store/tree/master/wolverineks-nbu-dashboard/chrome-extension";
const EXTENSION_FOLDER = "wolverineks-nbu-dashboard/chrome-extension";

function loadExtensionVersion(): string {
  const manifestPath = path.join(__dirname, "..", "chrome-extension", "manifest.json");
  if (!existsSync(manifestPath)) return "2.13.0";
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: string };
    return manifest.version?.trim() || "2.13.0";
  } catch {
    return "2.13.0";
  }
}

const EXTENSION_VERSION = loadExtensionVersion();

type DashboardPage =
  | "overview"
  | "sources"
  | "setup";

const DASHBOARD_PAGE_ROUTES: Record<string, DashboardPage> = {
  "/": "overview",
  "/overview": "overview",
  "/sources": "sources",
  "/setup": "setup",
  "/extension": "setup",
  "/backup": "setup",
};

const DASHBOARD_PAGE_TITLES: Record<DashboardPage, string> = {
  overview: "Overview",
  sources: "Sources",
  setup: "Setup",
};

function resolveDashboardPage(pathname: string): DashboardPage | null {
  return DASHBOARD_PAGE_ROUTES[pathname] ?? null;
}

function renderSideNav(active: DashboardPage): string {
  const items: Array<{ page: DashboardPage; href: string; label: string }> = [
    { page: "overview", href: "/", label: "Overview" },
    { page: "sources", href: "/sources", label: "Sources" },
    { page: "setup", href: "/setup", label: "Setup" },
  ];
  return items
    .map(
      (item) =>
        `<a class="side-nav-link${item.page === active ? " active" : ""}" href="${item.href}">${item.label}</a>`,
    )
    .join("\n          ");
}

function headerUtilitySelect(page: DashboardPage): string {
  if (page === "setup") return "";
  return `
          <label class="header-utility-label muted" for="utility">Utility</label>
          <select id="utility" class="header-utility-select" aria-label="Select utility">
            <option value="electric">Electric</option>
            <option value="water">Water</option>
          </select>`;
}

function usageChartSection(): string {
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
          <button id="chart-fullscreen" class="secondary chart-fullscreen-btn" type="button" title="Expand chart to full screen">Expand</button>
          <input id="range-end" type="hidden">
        </div>
        <p class="day-view-label" id="day-view-label" hidden></p>
        <p class="chart-fullscreen-title" id="chart-fullscreen-title" hidden></p>
        <div class="chart-shell">
          <canvas class="chart" id="chart" aria-label="Usage chart" role="img"></canvas>
        </div>
        <div class="empty" id="chart-empty" hidden>No readings for this view yet. Sync from Customer Connect using the Chrome extension.</div>
        <p class="chart-missing-legend muted" id="chart-missing-legend" hidden>Red bars mark hours with no data.</p>
        <div class="chart-sources" id="chart-sources" hidden></div>
      </div>`;
}

function coverageSection(): string {
  return `
      <div class="card" style="margin-top:1rem">
        <h2>Data coverage</h2>
        <p class="muted">Hourly record completeness from first import through yesterday. Click a segment to view that day in the chart above.</p>
        <div id="coverage-content">
          <p class="muted">Loading coverage…</p>
        </div>
      </div>`;
}

function dashboardPageContent(page: DashboardPage): string {
  switch (page) {
    case "overview":
      return `<div class="grid stats-grid" id="stats"></div>${usageChartSection()}${coverageSection()}`;
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
      <div class="setup-page">
        <div class="card setup-card">
          <h2>Chrome extension</h2>
          <p class="muted setup-lead">Copy your URL and token into the extension popup, then sync from Customer Connect.</p>
          <div class="setup-copy-block">
            <label for="extension-base-url">App URL</label>
            <div class="setup-copy-row">
              <code id="extension-base-url">Loading…</code>
              <button id="copy-base-url" class="secondary" type="button">Copy</button>
            </div>
          </div>
          <div class="setup-copy-block">
            <label for="token">Ingest token</label>
            <div class="setup-copy-row">
              <code id="token"></code>
              <button id="copy-token" class="secondary" type="button">Copy</button>
            </div>
            <div class="setup-copy-actions">
              <button id="rotate-token" class="secondary" type="button">Rotate token</button>
            </div>
          </div>
          <details class="collapse-panel setup-more">
            <summary>Install &amp; sync steps</summary>
            <div class="collapse-body">
              <ol class="setup-steps">
                <li>
                  Get the extension from
                  <a href="${EXTENSION_REPO_URL}" target="_blank" rel="noreferrer">GitHub</a>
                  (<code>${EXTENSION_FOLDER}</code>). Chrome → Extensions → Developer mode → Load unpacked.
                </li>
                <li>In the popup, pick Production or Development, paste URL and token, then Save settings.</li>
                <li>On a Customer Connect consumption report, use <strong>Sync last 30 days</strong> or <strong>Sync full history</strong>.</li>
              </ol>
              <p class="muted setup-version-note">Extension v${EXTENSION_VERSION}${IS_LOCAL_DEV ? " · local dev active" : ""}</p>
            </div>
          </details>
        </div>
        <div class="card setup-card">
          <h2>NBU Object ID</h2>
          <p class="muted setup-lead">For the account selected in the header. Powers NBU verify on Sources.</p>
          <div class="setup-object-id-row">
            <input id="property-object-id" type="text" placeholder="NBU Object ID" title="Customer Connect ObjectId for hourly CSV export URLs">
            <button id="save-object-id" class="secondary">Save</button>
          </div>
          <p class="object-id-hint setup-hint" id="object-id-hint" hidden>
            Set the Object ID to enable NBU verify on the Sources page.
          </p>
        </div>
        <div class="card setup-card">
          <h2>Backup</h2>
          <p class="muted setup-lead">Copies usage data and settings to <code id="backup-host-path">${BACKUP_HOST_PATH}</code>.</p>
          <div class="setup-status-grid">
            <div class="setup-status-item">
              <span class="setup-status-label">Live</span>
              <span class="setup-status-value" id="backup-live-summary">Loading…</span>
            </div>
            <div class="setup-status-item">
              <span class="setup-status-label">Backup</span>
              <span class="setup-status-value" id="backup-folder-summary">Loading…</span>
            </div>
          </div>
          <details class="collapse-panel setup-object-ids-panel" id="backup-object-ids-panel" hidden>
            <summary>Object IDs</summary>
            <div class="collapse-body backup-object-ids muted" id="backup-object-ids"></div>
          </details>
          <p class="muted setup-hint" id="backup-status"></p>
          <div class="setup-action-stack">
            <button id="backup-export-btn">Back up now</button>
            <button id="backup-import-btn" class="secondary">Restore from backup</button>
          </div>
          <details class="collapse-panel setup-danger-zone">
            <summary>Clear data</summary>
            <div class="collapse-body">
              <p class="muted setup-hint">
                Clear live records keeps your token, Object IDs, and property settings so you can resync.
              </p>
              <div class="setup-action-stack">
                <button id="clear-records-btn" class="danger secondary">Clear live records</button>
                <button id="clear-backup-btn" class="danger secondary">Clear backup folder</button>
              </div>
            </div>
          </details>
        </div>
      </div>`;
  }
}
const PORT = Number(process.env.PORT ?? 3000);
const DATA_ROOT = process.env.NBU_DATA_DIR ?? "/data";
const BACKUP_ROOT = process.env.NBU_BACKUP_DIR ?? "/backup";
const BACKUP_HOST_PATH = process.env.NBU_BACKUP_HOST_PATH ?? "/home/umbrel/nbu-backup";
const ICON_PATH = path.join(__dirname, "icon.svg");
const CHARTJS_PATH = path.join(__dirname, "vendor", "chart.umd.js");

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
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

function sendText(res: ServerResponse, statusCode: number, contentType: string, body: string): void {
  const encoded = Buffer.from(body);
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": encoded.length,
  });
  res.end(encoded);
}

function sendFile(
  res: ServerResponse,
  statusCode: number,
  contentType: string,
  body: Buffer,
  filename: string,
): void {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": body.length,
    "Content-Disposition": `inline; filename="${filename.replace(/"/g, "")}"`,
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseUtility(value: string | null): Utility {
  return value === "water" ? "water" : "electric";
}

function parseGranularity(value: string | null): Granularity {
  if (value === "day") return value;
  return "hour";
}

function parseDays(value: string | null): number | null {
  if (!value) return null;
  const days = Number(value);
  return Number.isFinite(days) && days > 0 ? days : null;
}

async function authorizeIngest(req: IncomingMessage): Promise<boolean> {
  const settings = await loadSettings();
  const headerToken = req.headers["x-ingest-token"];
  const auth = req.headers.authorization;
  const bearer = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const token = (typeof headerToken === "string" ? headerToken : null) ?? bearer;
  return Boolean(token && token === settings.ingest_token);
}

type MultipartPart = { filename: string | null; content: string };

function parseMultipart(body: Buffer, boundary: string): MultipartPart[] {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: MultipartPart[] = [];
  let offset = 0;

  while (offset < body.length) {
    const start = body.indexOf(delimiter, offset);
    if (start < 0) break;
    const lineEnd = body.indexOf("\r\n", start);
    if (lineEnd < 0) break;
    const next = body.indexOf(delimiter, lineEnd + 2);
    if (next < 0) break;
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

async function handleIngest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!(await authorizeIngest(req))) {
    sendJson(res, 401, { error: "invalid ingest token" });
    return;
  }

  const body = await readBody(req);
  const contentType = req.headers["content-type"] ?? "";

  try {
    if (contentType.includes("application/json")) {
      const payload = JSON.parse(body.toString("utf8")) as {
        filename?: string;
        content?: string;
        address?: string | null;
      };
      if (!payload.filename || !payload.content) {
        sendJson(res, 400, { error: "filename and content are required" });
        return;
      }
      const parsed = parseNbuExport(payload.filename, payload.content);
      const record = await importParsed(parsed, payload.content, {
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
        if (!part.filename) continue;
        const parsed = parseNbuExport(part.filename, part.content);
        results.push(await importParsed(parsed, part.content));
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
    const parsed = parseNbuExport(filename, rawContent);
    const record = await importParsed(parsed, rawContent, {
      address: typeof addressHeader === "string" ? addressHeader : null,
    });
    sendJson(res, 200, { ok: true, import: record, parsed_readings: parsed.readings.length });
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
  }
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
    .stats-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
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
    button.danger {
      color: #b91c1c;
      border-color: #fecaca;
      background: #fef2f2;
    }
    button.danger:disabled {
      opacity: 0.55;
      cursor: not-allowed;
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
    .chart-wrap.loading {
      opacity: 0.6;
      pointer-events: none;
    }
    body.chart-fullscreen-active {
      overflow: hidden;
    }
    .chart-wrap.is-fullscreen {
      position: fixed;
      inset: 0;
      z-index: 1200;
      margin: 0;
      border-radius: 0;
      border: 0;
      width: 100%;
      max-width: none;
      height: 100dvh;
      display: flex;
      flex-direction: column;
      padding:
        max(0.75rem, env(safe-area-inset-top, 0px))
        max(0.85rem, env(safe-area-inset-right, 0px))
        max(0.85rem, env(safe-area-inset-bottom, 0px))
        max(0.85rem, env(safe-area-inset-left, 0px));
    }
    .chart-wrap.is-fullscreen .chart-sources {
      display: none;
    }
    .chart-wrap.is-fullscreen .chart-shell {
      position: relative;
      flex: 1;
      min-height: 0;
      height: auto;
      display: flex;
      align-items: stretch;
    }
    .chart-wrap.is-fullscreen .chart {
      width: 100% !important;
      height: 100% !important;
      max-height: none;
      aspect-ratio: unset;
      min-height: 0;
    }
    .chart-fullscreen-title {
      display: none;
      margin: 0 0 0.5rem;
      font-size: 1.05rem;
      font-weight: 600;
      color: var(--text);
    }
    .chart-wrap.is-fullscreen .chart-fullscreen-title {
      display: block;
    }
    .chart-wrap.is-fullscreen .day-view-label {
      display: none;
    }
    .chart-fullscreen-btn {
      font-weight: 600;
    }
    .chart-shell {
      position: relative;
      width: 100%;
      height: min(42vh, 420px);
      min-height: 220px;
    }
    .chart-shell[data-drillable="1"] {
      cursor: pointer;
    }
    .chart {
      width: 100% !important;
      height: 100% !important;
      display: block;
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
    .setup-page {
      display: grid;
      gap: 1rem;
    }
    .setup-card h2 {
      margin: 0 0 0.35rem;
      font-size: 1.05rem;
    }
    .setup-lead {
      margin: 0 0 1rem;
      font-size: 0.9rem;
      line-height: 1.45;
    }
    .setup-hint {
      margin: 0.75rem 0 0;
      font-size: 0.84rem;
      line-height: 1.45;
    }
    .setup-copy-block + .setup-copy-block {
      margin-top: 1rem;
    }
    .setup-copy-block label {
      display: block;
      font-size: 0.82rem;
      font-weight: 600;
      margin-bottom: 0.35rem;
    }
    .setup-copy-row {
      display: flex;
      gap: 0.5rem;
      align-items: stretch;
    }
    .setup-copy-row code {
      flex: 1;
      min-width: 0;
      display: block;
      padding: 0.65rem 0.75rem;
      font-size: 0.82rem;
      line-height: 1.35;
    }
    .setup-copy-row button {
      flex-shrink: 0;
      white-space: nowrap;
    }
    .setup-copy-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin-top: 0.5rem;
    }
    .setup-object-id-row {
      display: flex;
      gap: 0.5rem;
      align-items: stretch;
    }
    .setup-object-id-row input {
      flex: 1;
      min-width: 0;
    }
    .setup-status-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0.75rem;
    }
    .setup-status-item {
      background: var(--accent-soft);
      border-radius: 12px;
      padding: 0.75rem 0.85rem;
      min-width: 0;
    }
    .setup-status-label {
      display: block;
      font-size: 0.72rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--muted);
      margin-bottom: 0.25rem;
    }
    .setup-status-value {
      display: block;
      font-size: 0.84rem;
      line-height: 1.4;
      color: var(--muted);
      word-break: break-word;
    }
    .setup-action-stack {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin-top: 0.75rem;
    }
    .setup-more,
    .setup-danger-zone,
    .setup-object-ids-panel {
      margin-top: 1rem;
      padding-top: 0.85rem;
      border-top: 1px solid var(--border);
    }
    .setup-more > summary,
    .setup-danger-zone > summary,
    .setup-object-ids-panel > summary {
      font-size: 0.9rem;
      font-weight: 600;
      color: var(--text);
    }
    .setup-steps {
      margin: 0;
      padding-left: 1.15rem;
      line-height: 1.5;
      font-size: 0.88rem;
    }
    .setup-steps li + li { margin-top: 0.5rem; }
    .setup-version-note {
      margin: 0.65rem 0 0;
      font-size: 0.82rem;
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
    @media (max-width: 640px) {
      .setup-copy-row,
      .setup-copy-actions,
      .setup-object-id-row,
      .setup-action-stack {
        flex-direction: column;
      }
      .setup-copy-row button,
      .setup-copy-actions button,
      .setup-object-id-row button,
      .setup-action-stack button {
        width: 100%;
      }
      .setup-status-value {
        font-size: 0.8rem;
      }
      .stats-grid .card {
        padding: 0.85rem 0.7rem;
      }
      .stats-grid .card h3 {
        font-size: 0.8rem;
      }
      .stats-grid .metric {
        font-size: 1.5rem;
      }
      .stats-grid .metric small {
        font-size: 0.78rem;
      }
      .chart-wrap:not(.is-fullscreen) {
        padding: 0.75rem 0.85rem 1rem;
      }
      .chart-wrap:not(.is-fullscreen) .chart-shell {
        height: min(38vh, 300px);
        min-height: 200px;
      }
      .toolbar {
        gap: 0.5rem;
      }
      .chart-nav button {
        min-width: 0;
        padding-left: 0.5rem;
        padding-right: 0.5rem;
      }
      .chart-fullscreen-btn {
        padding: 0.6rem 0.9rem;
      }
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

function dashboardPage(page: DashboardPage): string {
  const pageTitle = DASHBOARD_PAGE_TITLES[page];
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NBU Utilities · ${pageTitle}</title>
  <style>${pageStyles()}</style>
  ${page === "overview" ? '<script src="/vendor/chart.umd.js"></script>' : ""}
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
        ? { month: "short", day: "numeric", year: "numeric", timeZone: "America/Chicago" }
        : { month: "short", day: "numeric", timeZone: "America/Chicago" };
      return new Date(iso).toLocaleDateString(undefined, opts);
    }

    function fmtAxisDay(iso, withYear = false) {
      return fmtShortDate(iso, withYear);
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

    function chartPointGranularity(usage) {
      return usage.point_granularity || usage.granularity;
    }

    let usageChart = null;

    function destroyUsageChart() {
      if (usageChart) {
        usageChart.destroy();
        usageChart = null;
      }
    }

    function drillIntoChartPoint(point) {
      if (!point || !state.usage) return;
      if (chartPointGranularity(state.usage) !== "day" || state.usage.date) return;
      const dayInput = document.getElementById("day");
      if (!dayInput) return;
      clearRangeEnd();
      dayInput.value = centralLocalDateKey(point.period_start);
      syncDayControls();
      loadUsage();
    }

    function scheduleChartSources() {
      const run = window.requestIdleCallback
        ? (cb) => window.requestIdleCallback(cb, { timeout: 1200 })
        : (cb) => window.setTimeout(cb, 16);
      run(() => renderChartSources());
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

    function chartIsFullscreen() {
      return document.querySelector(".chart-wrap")?.classList.contains("is-fullscreen") ?? false;
    }

    function chartLayoutMode() {
      if (chartIsFullscreen()) return "fullscreen";
      if (window.innerWidth < 640) return "narrow";
      return "normal";
    }

    function chartFullscreenTitle(usage) {
      if (!usage) return "";
      const utility = usage.utility === "water" ? "Water" : "Electric";
      const gran = chartPointGranularity(usage);
      if (usage.date) {
        return utility + " · hourly · " + fmtDayHeading(usage.date);
      }
      if (usage.range_start && usage.range_end) {
        const start = fmtShortDate(usage.range_start + "T12:00:00Z", true);
        const end = fmtShortDate(usage.range_end + "T12:00:00Z", true);
        return utility + " · " + gran + " · " + start + " – " + end;
      }
      return utility + " · " + gran + " usage";
    }

    function setChartFullscreen(on) {
      const wrap = document.querySelector(".chart-wrap");
      const btn = document.getElementById("chart-fullscreen");
      if (!wrap) return;
      wrap.classList.toggle("is-fullscreen", on);
      document.body.classList.toggle("chart-fullscreen-active", on);
      if (btn) {
        btn.textContent = on ? "Exit" : "Expand";
        btn.title = on ? "Exit full screen" : "Expand chart to full screen";
      }
      renderChart();
    }

    function buildChartAxisLabels(usage, showYears) {
      // Single-day drill-down: hours on the bottom axis.
      if (usage.date) {
        return usage.points.map((point) => fmtHourLabel(point.period_start));
      }

      // Daily view: one day label per bar.
      if (chartPointGranularity(usage) === "day") {
        return usage.points.map((point) => fmtAxisDay(point.period_start, showYears));
      }

      // Multi-day hourly: show a day label at the start of each day only.
      let lastDayKey = null;
      return usage.points.map((point) => {
        const dayKey = centralLocalDateKey(point.period_start);
        if (dayKey !== lastDayKey) {
          lastDayKey = dayKey;
          return fmtAxisDay(point.period_start, showYears);
        }
        return "";
      });
    }

    function renderChart() {
      const usage = state.usage;
      const canvas = document.getElementById("chart");
      const empty = document.getElementById("chart-empty");
      const missingLegend = document.getElementById("chart-missing-legend");
      if (!canvas) return;

      if (!usage || !usage.points.length) {
        destroyUsageChart();
        if (missingLegend) missingLegend.hidden = true;
        if (empty) empty.hidden = false;
        renderChartSources();
        return;
      }

      if (typeof Chart === "undefined") {
        if (empty) {
          empty.hidden = false;
          empty.textContent = "Chart.js failed to load.";
        }
        return;
      }

      const hasMissing = usage.points.some((point) => point.missing);
      if (empty) empty.hidden = true;
      if (missingLegend) missingLegend.hidden = !hasMissing;

      const mode = chartLayoutMode();
      const fullscreenTitle = document.getElementById("chart-fullscreen-title");
      if (fullscreenTitle) {
        const title = chartFullscreenTitle(usage);
        fullscreenTitle.textContent = title;
        fullscreenTitle.hidden = mode !== "fullscreen" || !title;
      }

      const shell = document.querySelector(".chart-shell");
      const drillable = chartPointGranularity(usage) === "day" && !usage.date;
      if (shell) shell.dataset.drillable = drillable ? "1" : "0";

      const showYears = chartSpansYears(usage.points);
      const color = usage.utility === "water" ? "#0ea5e9" : "#f59e0b";
      const missingColor = "#991b1b";
      const dataValues = usage.points
        .filter((point) => !point.missing)
        .map((point) => Number(point.value) || 0);
      const max = Math.max(...dataValues, 0.001);
      const labels = buildChartAxisLabels(usage, showYears);
      const values = usage.points.map((point) =>
        point.missing ? max : Number(point.value) || 0,
      );
      const backgroundColors = usage.points.map((point) =>
        point.missing ? missingColor : color,
      );
      const borderColors = usage.points.map((point) =>
        point.missing ? "#7f1d1d" : color,
      );
      const fontSize = mode === "fullscreen" ? 14 : mode === "narrow" ? 11 : 12;
      const dayCount = new Set(
        usage.points.map((point) => centralLocalDateKey(point.period_start)),
      ).size;
      const tickMax = usage.date
        ? mode === "narrow"
          ? 4
          : 6
        : mode === "narrow"
          ? Math.min(4, Math.max(2, dayCount))
          : Math.min(mode === "fullscreen" ? 14 : 10, Math.max(3, dayCount));

      const chartConfig = {
        type: "bar",
        data: {
          labels,
          datasets: [
            {
              label: usage.utility === "water" ? "Water" : "Electric",
              data: values,
              backgroundColor: backgroundColors,
              borderColor: borderColors,
              borderWidth: 0,
              borderRadius: 2,
              borderSkipped: false,
              maxBarThickness: mode === "fullscreen" ? 28 : 18,
              categoryPercentage: 0.9,
              barPercentage: 0.92,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: { duration: mode === "fullscreen" ? 200 : 250 },
          interaction: {
            mode: "index",
            intersect: false,
          },
          onHover: (event, elements) => {
            const target = event.native?.target;
            if (!target) return;
            target.style.cursor =
              elements.length && drillable ? "pointer" : elements.length ? "crosshair" : "default";
          },
          onClick: (_event, elements) => {
            if (!elements.length || !drillable) return;
            const index = elements[0].index;
            drillIntoChartPoint(usage.points[index]);
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: "rgba(15, 23, 42, 0.92)",
              titleColor: "#f8fafc",
              bodyColor: "#e2e8f0",
              borderColor: "#334155",
              borderWidth: 1,
              padding: mode === "fullscreen" ? 12 : 10,
              titleFont: { size: fontSize, weight: "600" },
              bodyFont: { size: fontSize },
              displayColors: false,
              callbacks: {
                title: (items) => {
                  const index = items[0]?.dataIndex;
                  const point = usage.points[index];
                  if (!point) return "";
                  return fmtTooltipLabel(point.period_start, chartPointGranularity(usage));
                },
                label: (item) => {
                  const point = usage.points[item.dataIndex];
                  if (!point) return "";
                  if (point.missing) {
                    return chartPointGranularity(usage) === "hour"
                      ? "Missing hour"
                      : "Missing day";
                  }
                  return Number(point.value).toFixed(2) + " " + usage.unit;
                },
              },
            },
          },
          scales: {
            x: {
              grid: { display: false },
              ticks: {
                color: "#64748b",
                font: { size: fontSize },
                maxRotation: 0,
                autoSkip: true,
                autoSkipPadding: 8,
                maxTicksLimit: tickMax,
                // Prefer day labels; hide empty multi-day hourly slots.
                callback: function (value) {
                  const label = this.getLabelForValue(value);
                  return label ? label : null;
                },
              },
              border: { color: "#e2e8f0" },
            },
            y: {
              beginAtZero: true,
              suggestedMax: max * 1.05,
              grid: { color: "rgba(148, 163, 184, 0.25)" },
              ticks: {
                color: "#64748b",
                font: { size: fontSize },
                callback: (value) => {
                  const num = Number(value);
                  if (!Number.isFinite(num)) return value;
                  return num >= 10 ? num.toFixed(0) : num.toFixed(1);
                },
              },
              title: {
                display: true,
                text: usage.unit,
                color: "#64748b",
                font: { size: fontSize },
              },
              border: { display: false },
            },
          },
        },
      };

      destroyUsageChart();
      usageChart = new Chart(canvas.getContext("2d"), chartConfig);
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
          await Promise.all([loadUsage(), loadCoverage()]);
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
          await Promise.all([loadUsage(), loadCoverage()]);
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
      const chartWrap = document.querySelector(".chart-wrap");
      if (chartWrap) chartWrap.classList.add("loading");
      try {
        const res = await fetch("/api/usage?" + params.toString());
        state.usage = await res.json();
        renderChart();
        scheduleChartSources();
      } finally {
        if (chartWrap) chartWrap.classList.remove("loading");
      }
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
    on("chart-fullscreen", "click", () => setChartFullscreen(!chartIsFullscreen()));
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && chartIsFullscreen()) setChartFullscreen(false);
    });
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
      const panel = document.getElementById("backup-object-ids-panel");
      if (!el) return;
      const liveItems = payload.live_object_ids ?? [];
      const backupItems = payload.backup_object_ids ?? [];
      const backupCount = payload.backup_object_id_count ?? 0;
      const liveCount = payload.live_object_id_count ?? 0;
      if (!liveItems.length && !backupItems.length) {
        el.innerHTML = "";
        if (panel) panel.hidden = true;
        return;
      }
      if (panel) {
        panel.hidden = false;
        const summary = panel.querySelector("summary");
        if (summary) {
          summary.textContent = "Object IDs (" + liveCount + " live" +
            (payload.backup_available ? ", " + backupCount + " in backup" : "") + ")";
        }
      }
      let html = "<ul>" + formatObjectIdList(liveItems) + "</ul>";
      if (payload.backup_available && backupCount !== liveCount && backupItems.length) {
        html += '<p class="muted" style="margin:0.5rem 0 0.25rem;font-size:0.82rem">In backup folder</p><ul>' +
          formatObjectIdList(backupItems) + "</ul>";
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
      const clearRecordsBtn = document.getElementById("clear-records-btn");
      const clearBackupBtn = document.getElementById("clear-backup-btn");
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
        if (clearRecordsBtn) {
          clearRecordsBtn.disabled = !(payload.live_reading_count || payload.live_import_count);
        }
        if (clearBackupBtn) {
          clearBackupBtn.disabled = !payload.backup_writable || !payload.backup_available;
        }
      } catch (error) {
        if (liveSummary) liveSummary.textContent = "Unavailable";
        if (folderSummary) folderSummary.textContent = "Unavailable";
        const objectIdsEl = document.getElementById("backup-object-ids");
        const objectIdsPanel = document.getElementById("backup-object-ids-panel");
        if (objectIdsEl) objectIdsEl.innerHTML = "";
        if (objectIdsPanel) objectIdsPanel.hidden = true;
        if (statusEl) statusEl.textContent = error.message || "Could not load backup status.";
        if (exportBtn) exportBtn.disabled = true;
        if (importBtn) importBtn.disabled = true;
        if (clearRecordsBtn) clearRecordsBtn.disabled = true;
        if (clearBackupBtn) clearBackupBtn.disabled = true;
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

    on("clear-records-btn", "click", async () => {
      if (
        !confirm(
          "Clear all live usage records, imports, and uploaded files? Your ingest token, Object IDs, and property settings will be kept. You can resync from the extension.",
        )
      ) {
        return;
      }
      const clearRecordsBtn = document.getElementById("clear-records-btn");
      const clearBackupBtn = document.getElementById("clear-backup-btn");
      if (clearRecordsBtn) clearRecordsBtn.disabled = true;
      if (clearBackupBtn) clearBackupBtn.disabled = true;
      await refreshBackupStatus("Clearing live records…");
      try {
        const response = await fetch("/api/data/clear", { method: "POST" });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Clear failed.");
        await refreshBackupStatus(
          "Cleared " +
            payload.cleared_reading_count +
            " readings and " +
            payload.cleared_import_count +
            " imports.",
        );
        window.location.href = "/";
      } catch (error) {
        const statusEl = document.getElementById("backup-status");
        if (statusEl) statusEl.textContent = error.message || "Clear failed.";
        await refreshBackupStatus();
      }
    });

    on("clear-backup-btn", "click", async () => {
      const hostPath =
        document.getElementById("backup-host-path")?.textContent?.trim() || "/home/umbrel/nbu-backup";
      if (
        !confirm(
          "Delete everything in the backup folder at " + hostPath + "? This cannot be undone.",
        )
      ) {
        return;
      }
      const clearRecordsBtn = document.getElementById("clear-records-btn");
      const clearBackupBtn = document.getElementById("clear-backup-btn");
      if (clearRecordsBtn) clearRecordsBtn.disabled = true;
      if (clearBackupBtn) clearBackupBtn.disabled = true;
      await refreshBackupStatus("Clearing backup folder…");
      try {
        const response = await fetch("/api/backup/clear", { method: "POST" });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Clear backup failed.");
        await refreshBackupStatus("Backup folder cleared.");
      } catch (error) {
        const statusEl = document.getElementById("backup-status");
        if (statusEl) statusEl.textContent = error.message || "Clear backup failed.";
        await refreshBackupStatus();
      }
    });

    let chartResizeTimer = null;
    let chartLastMode = chartLayoutMode();
    window.addEventListener("resize", () => {
      if (APP_PAGE !== "overview" || !state.usage?.points?.length) return;
      const mode = chartLayoutMode();
      if (mode === chartLastMode) return;
      chartLastMode = mode;
      clearTimeout(chartResizeTimer);
      chartResizeTimer = setTimeout(() => renderChart(), 150);
    });

    initSideNav();
    void initPage();
  </script>
</body>
</html>`;
}

function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function importViewPage(
  importId: string,
  filename: string,
  format: string,
  content: string,
): string {
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const pathname = url.pathname;

  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  try {
    if (req.method === "GET" && pathname === "/icon.svg") {
      const icon = await readFile(ICON_PATH);
      res.writeHead(200, { "Content-Type": "image/svg+xml" });
      res.end(icon);
      return;
    }

    if (req.method === "GET" && pathname === "/vendor/chart.umd.js") {
      const chartJs = await readFile(CHARTJS_PATH);
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "public, max-age=604800",
      });
      res.end(chartJs);
      return;
    }

    if (req.method === "GET" && pathname === "/api/properties") {
      sendJson(res, 200, { properties: await listProperties() });
      return;
    }

    if (req.method === "GET" && pathname === "/api/overview") {
      const settings = await loadSettings();
      const properties = await listProperties();
      const propertyId = resolvePropertyId(
        url.searchParams.get("property"),
        settings,
        properties,
      );
      sendJson(res, 200, await getOverview(propertyId));
      return;
    }

    if (req.method === "GET" && pathname === "/api/imports") {
      const settings = await loadSettings();
      const properties = await listProperties();
      const propertyId = resolvePropertyId(
        url.searchParams.get("property"),
        settings,
        properties,
      );
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 500) || 500, 1), 5000);
      const offset = Math.max(Number(url.searchParams.get("offset") ?? 0) || 0, 0);
      const result = await listImports(propertyId, limit, offset);
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
      const imports = await listImports(null, 5000, 0);
      const record = imports.imports.find((item) => item.id === importViewMatch[1]);
      const stored = await getStoredImportFile(importViewMatch[1]);
      if (!stored || !record) {
        sendJson(res, 404, { error: "file not found" });
        return;
      }
      sendText(
        res,
        200,
        "text/html; charset=utf-8",
        importViewPage(importViewMatch[1], stored.filename, record.format, stored.content.toString("utf8")),
      );
      return;
    }

    const importFileMatch = pathname.match(/^\/api\/imports\/([a-f0-9]+)\/file$/);
    if (req.method === "GET" && importFileMatch) {
      const stored = await getStoredImportFile(importFileMatch[1]);
      if (!stored) {
        sendJson(res, 404, { error: "file not found" });
        return;
      }
      sendFile(res, 200, stored.contentType, stored.content, stored.filename);
      return;
    }

    if (req.method === "GET" && pathname === "/api/coverage") {
      const settings = await loadSettings();
      const properties = await listProperties();
      const propertyId = resolvePropertyId(
        url.searchParams.get("property"),
        settings,
        properties,
      );
      const utility = parseUtility(url.searchParams.get("utility"));
      sendJson(res, 200, await getCoverageSummary(propertyId, utility));
      return;
    }

    if (req.method === "GET" && pathname === "/api/missing-sources") {
      const settings = await loadSettings();
      const properties = await listProperties();
      const propertyId = resolvePropertyId(
        url.searchParams.get("property"),
        settings,
        properties,
      );
      const utility = parseUtility(url.searchParams.get("utility"));
      const baseUrl = `http://${req.headers.host ?? "localhost"}`;
      sendJson(res, 200, await getMissingSources(propertyId, utility, baseUrl));
      return;
    }

    if (req.method === "POST" && pathname === "/api/missing-sources/probes") {
      if (!(await authorizeIngest(req))) {
        sendJson(res, 401, { error: "invalid ingest token" });
        return;
      }
      const body = JSON.parse((await readBody(req)).toString("utf8")) as {
        property_id?: string | null;
        utility?: Utility;
        probes?: Array<{
          start: string;
          end: string;
          nbu_url?: string | null;
          status?: number | null;
          error?: string | null;
          response_preview?: string | null;
        }>;
      };
      const recorded = await recordFetchProbes(
        body.property_id ?? null,
        parseUtility(body.utility ?? null),
        body.probes ?? [],
      );
      sendJson(res, 200, { ok: true, recorded });
      return;
    }

    if (req.method === "POST" && pathname === "/api/sync-errors") {
      if (!(await authorizeIngest(req))) {
        sendJson(res, 401, { error: "invalid ingest token" });
        return;
      }
      const body = JSON.parse((await readBody(req)).toString("utf8")) as {
        utility?: Utility;
        object_id?: string;
        property_id?: string | null;
        errors?: Array<{
          label?: string;
          url?: string;
          error?: string;
          status?: number | null;
        }>;
      };
      const recorded = await recordSyncFetchErrors({
        utility: body.utility,
        object_id: body.object_id,
        property_id: body.property_id ?? null,
        errors: body.errors ?? [],
      });
      sendJson(res, 200, { ok: true, recorded });
      return;
    }

    if (req.method === "GET" && pathname === "/api/usage") {
      const settings = await loadSettings();
      const properties = await listProperties();
      const propertyId = resolvePropertyId(
        url.searchParams.get("property"),
        settings,
        properties,
      );
      const utility = parseUtility(url.searchParams.get("utility"));
      const granularity = parseGranularity(url.searchParams.get("granularity"));
      const date = parseDateParam(url.searchParams.get("date"));
      const days = date ? null : parseDays(url.searchParams.get("days"));
      const endDate = date || !days ? null : parseDateParam(url.searchParams.get("end"));
      const started = performance.now();
      const summary = await getUsageSummary(propertyId, utility, granularity, days, date, endDate);
      const elapsed = performance.now() - started;
      if (elapsed >= 750) {
        console.warn(
          `[nbu] slow /api/usage ${Math.round(elapsed)}ms property=${propertyId ?? "all"} days=${days ?? "n/a"} granularity=${granularity} points=${summary.points.length}`,
        );
      }
      sendJson(res, 200, summary);
      return;
    }

    if (req.method === "GET" && pathname === "/api/settings") {
      const settings = await loadSettings();
      sendJson(res, 200, { settings });
      return;
    }

    if (req.method === "POST" && pathname === "/api/settings/rotate-token") {
      const settings = await rotateIngestToken();
      sendJson(res, 200, { settings });
      return;
    }

    if (req.method === "POST" && pathname === "/api/settings/property") {
      const body = JSON.parse((await readBody(req)).toString("utf8")) as { property_id?: string };
      const settings = await setSelectedProperty(body.property_id ?? null);
      sendJson(res, 200, { settings });
      return;
    }

    if (req.method === "POST" && pathname === "/api/settings/property-label") {
      const body = JSON.parse((await readBody(req)).toString("utf8")) as {
        property_id?: string;
        label?: string;
      };
      if (!body.property_id) {
        sendJson(res, 400, { error: "property_id is required" });
        return;
      }
      const settings = await setPropertyLabel(body.property_id, body.label ?? "");
      sendJson(res, 200, { settings });
      return;
    }

    if (req.method === "POST" && pathname === "/api/settings/property-object-id") {
      const body = JSON.parse((await readBody(req)).toString("utf8")) as {
        property_id?: string;
        object_id?: string;
      };
      if (!body.property_id) {
        sendJson(res, 400, { error: "property_id is required" });
        return;
      }
      const settings = await setPropertyObjectId(body.property_id, body.object_id ?? "");
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
      sendJson(res, 200, await getBackupStatus(DATA_ROOT, BACKUP_ROOT, BACKUP_HOST_PATH));
      return;
    }

    if (req.method === "POST" && pathname === "/api/backup/export") {
      try {
        const status = await exportNbuData(DATA_ROOT, BACKUP_ROOT, BACKUP_HOST_PATH);
        sendJson(res, 200, status);
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (req.method === "POST" && pathname === "/api/backup/import") {
      try {
        const status = await importNbuData(DATA_ROOT, BACKUP_ROOT, BACKUP_HOST_PATH);
        resetStoreCaches();
        sendJson(res, 200, status);
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (req.method === "POST" && pathname === "/api/backup/clear") {
      try {
        const status = await clearNbuBackup(DATA_ROOT, BACKUP_ROOT, BACKUP_HOST_PATH);
        sendJson(res, 200, status);
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (req.method === "POST" && pathname === "/api/data/clear") {
      try {
        const result = await clearUsageData();
        sendJson(res, 200, result);
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (
      req.method === "GET" &&
      (pathname === "/usage" ||
        pathname === "/coverage" ||
        pathname === "/missing-sources" ||
        pathname === "/uploads" ||
        pathname === "/upload-history")
    ) {
      const target =
        pathname === "/missing-sources" || pathname === "/uploads" || pathname === "/upload-history"
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
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, () => {
  console.log(`NBU dashboard listening on :${PORT}`);
});