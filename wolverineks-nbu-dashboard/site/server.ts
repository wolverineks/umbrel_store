import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { exportNbuData, getBackupStatus, importNbuData } from "./backup-restore";
import { parseNbuExport, type Granularity, type Utility } from "./parsers";
import {
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

const APP_VERSION = "1.8.1";
const PORT = Number(process.env.PORT ?? 3000);
const DATA_ROOT = process.env.NBU_DATA_DIR ?? "/data";
const BACKUP_ROOT = process.env.NBU_BACKUP_DIR ?? "/backup";
const BACKUP_HOST_PATH = process.env.NBU_BACKUP_HOST_PATH ?? "/home/umbrel/nbu-backup";
const ICON_PATH = path.join(__dirname, "icon.svg");

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
  if (value === "day" || value === "billing_period") return value;
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
      const payload = JSON.parse(body.toString("utf8")) as { filename?: string; content?: string };
      if (!payload.filename || !payload.content) {
        sendJson(res, 400, { error: "filename and content are required" });
        return;
      }
      const parsed = parseNbuExport(payload.filename, payload.content);
      const record = await importParsed(parsed, payload.content);
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
    const filename = typeof filenameHeader === "string" ? filenameHeader : "upload.xml";
    const rawContent = body.toString("utf8");
    const parsed = parseNbuExport(filename, rawContent);
    const record = await importParsed(parsed, rawContent);
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
    .layout {
      width: 100%;
      min-height: 100vh;
      padding: 1.25rem 1.5rem 2rem;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      margin-bottom: 1.5rem;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 0.9rem;
    }
    .brand img { width: 44px; height: 44px; border-radius: 12px; }
    h1 { margin: 0; font-size: 1.5rem; }
    .subtitle { margin: 0.2rem 0 0; color: var(--muted); font-size: 0.95rem; }
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
    .property-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 0.75rem;
      align-items: center;
      margin-bottom: 1rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid var(--border);
    }
    .property-bar input[type="text"] {
      min-width: 220px;
      flex: 1 1 220px;
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
    .chart-sources h3 {
      margin: 0 0 0.45rem;
      font-size: 0.82rem;
      color: var(--muted);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.03em;
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
    .empty {
      text-align: center;
      color: var(--muted);
      padding: 2rem 1rem;
    }
  `;
}

function dashboardPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NBU Utilities</title>
  <style>${pageStyles()}</style>
</head>
<body>
  <div class="layout">
    <header>
      <div class="brand">
        <img src="/icon.svg" alt="">
        <div>
          <h1>NBU Utilities</h1>
          <p class="subtitle" id="address">New Braunfels Utilities usage dashboard</p>
        </div>
      </div>
      <div class="muted">v${APP_VERSION}</div>
    </header>

    <div class="grid" id="stats"></div>

    <div class="chart-wrap">
      <div class="property-bar">
        <select id="property"></select>
        <input id="property-label" type="text" placeholder="House name">
        <button id="save-label" class="secondary">Save name</button>
        <input id="property-object-id" type="text" placeholder="NBU Object ID" title="Customer Connect ObjectId for Green Button export URLs">
        <button id="save-object-id" class="secondary">Save Object ID</button>
      </div>
      <p class="object-id-hint" id="object-id-hint" hidden>
        Set the NBU Object ID to generate per-gap NBU verify snippets (run in Customer Connect console).
      </p>
      <div class="toolbar">
        <select id="utility">
          <option value="electric">Electric</option>
          <option value="water">Water</option>
        </select>
        <select id="granularity">
          <option value="hour">Hourly</option>
          <option value="day">Daily</option>
          <option value="billing_period">Billing periods</option>
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
        <button id="refresh" class="secondary">Refresh</button>
      </div>
      <p class="day-view-label" id="day-view-label" hidden></p>
      <div class="chart-shell">
        <svg class="chart" id="chart" viewBox="0 0 1000 300" preserveAspectRatio="none"></svg>
        <div class="chart-tooltip" id="chart-tooltip" hidden></div>
      </div>
      <div class="empty" id="chart-empty" hidden>No readings for this view yet. Sync from Customer Connect using the Chrome extension.</div>
      <div class="chart-sources" id="chart-sources" hidden></div>
    </div>

    <div class="card" style="margin-top:1rem">
      <h2>Data coverage</h2>
      <p class="muted">Hourly record completeness from first import through yesterday. Click a segment to inspect that day.</p>
      <div id="coverage-content">
        <p class="muted">Loading coverage…</p>
      </div>
    </div>

    <div class="card" style="margin-top:1rem" id="missing-sources-card">
      <div class="missing-sources-header">
        <div>
          <h2 style="margin:0">Missing sources</h2>
          <p class="muted" style="margin:0.35rem 0 0">Each gap includes a console snippet to fetch NBU servers and check whether the data is missing there too. Run snippets on the Customer Connect site (logged in, DevTools console).</p>
        </div>
        <div class="toolbar" style="margin:0">
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
      <h2>Chrome extension</h2>
      <p class="muted">Configure the companion extension with your Umbrel URL and ingest token.</p>
      <div class="token-box" style="margin-top:0.8rem">
        <code id="token"></code>
        <button id="copy-token" class="secondary">Copy token</button>
        <button id="rotate-token" class="secondary">Rotate token</button>
      </div>
    </div>

    <div class="card" style="margin-top:1rem">
      <div class="import-history-header">
        <h2 style="margin:0">Upload history</h2>
        <span class="muted" id="import-count"></span>
      </div>
      <div class="imports import-history" id="imports"></div>
    </div>

    <div class="card" style="margin-top:1rem">
      <h2>Backup &amp; restore</h2>
      <p class="muted">
        Copy all usage data, upload files, settings, and property names to
        <code id="backup-host-path">${BACKUP_HOST_PATH}</code> on your Umbrel.
      </p>
      <div class="grid" style="margin-top:0.8rem">
        <div>
          <h3>Live data</h3>
          <p class="muted" id="backup-live-summary">Loading…</p>
        </div>
        <div>
          <h3>Backup folder</h3>
          <p class="muted" id="backup-folder-summary">Loading…</p>
        </div>
      </div>
      <p class="muted" id="backup-status" style="margin-top:0.8rem"></p>
      <div class="toolbar" style="margin-top:0.8rem; margin-bottom:0">
        <button id="backup-export-btn">Back up now</button>
        <button id="backup-import-btn" class="secondary">Restore from backup</button>
      </div>
    </div>
  </div>
  <script>
    const state = {
      overview: null,
      usage: null,
      imports: null,
      coverage: null,
      missingSources: null,
      clipboardScripts: { verifyAll: null, probe: null },
    };

    function selectedPropertyId() {
      return document.getElementById("property").value || null;
    }

    function propertyParams() {
      const params = new URLSearchParams();
      const propertyId = selectedPropertyId();
      if (propertyId) params.set("property", propertyId);
      return params;
    }

    function renderPropertySelector() {
      const select = document.getElementById("property");
      const labelInput = document.getElementById("property-label");
      const objectIdInput = document.getElementById("property-object-id");
      const objectIdHint = document.getElementById("object-id-hint");
      const o = state.overview;
      if (!select || !o) return;

      if (!o.properties.length) {
        select.innerHTML = '<option value="">No properties yet</option>';
        if (labelInput) labelInput.value = "";
        if (objectIdInput) objectIdInput.value = "";
        if (objectIdHint) objectIdHint.hidden = true;
        return;
      }

      const selectedId = o.selected_property?.id ?? o.properties[0].id;
      select.innerHTML = o.properties.map((property) =>
        \`<option value="\${property.id}">\${property.label}</option>\`
      ).join("");
      select.value = selectedId;
      if (labelInput && o.selected_property) {
        labelInput.value = o.settings.property_labels[o.selected_property.id] ?? o.selected_property.label ?? "";
      }
      if (objectIdInput && o.selected_property) {
        objectIdInput.value = o.settings.property_object_ids?.[o.selected_property.id] ?? "";
      }
      if (objectIdHint) {
        const hasObjectId = Boolean(o.settings.property_object_ids?.[selectedId]);
        objectIdHint.hidden = hasObjectId;
      }
      if (o.selected_property) {
        document.getElementById("address").textContent = o.selected_property.label;
      }
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

    function renderLinkRow(label, url, fetchSnippet, copyKind, copyIndex, copyLabel) {
      if (!url) return "";
      const buttonLabel = copyLabel || "Copy snippet";
      let html = '<li><span class="muted">' + label + ':</span> ';
      html += '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener">' + escapeHtml(url) + '</a>';
      if (fetchSnippet) {
        html += ' <button type="button" class="secondary copy-snippet" data-kind="' + copyKind +
          '" data-index="' + copyIndex + '">' + buttonLabel + '</button>';
        html += '<code class="source-snippet">' + escapeHtml(fetchSnippet) + '</code>';
      }
      html += '</li>';
      return html;
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
        } else {
          dayLabel.hidden = true;
          dayLabel.textContent = "";
        }
      }
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
      if (granularity === "billing_period") {
        return date.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
      }
      return date.toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    }

    function fmtTooltipHtml(point, unit, granularity) {
      const value = Number(point.value).toFixed(2);
      return \`\${fmtTooltipLabel(point.period_start, granularity)}<br><strong>\${value} \${unit}</strong>\`;
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
      if (!o) return;
      renderPropertySelector();
      document.getElementById("token").textContent = o.settings.ingest_token;
      el.innerHTML = [
        ["Electric hours", o.electric_hours, "stored"],
        ["Electric days", o.electric_days, "stored"],
        ["Billing periods", o.electric_billing_periods, "stored"],
        ["Water hours", o.water_hours, "stored"],
      ].map(([label, value, suffix]) => \`
        <div class="card">
          <h3>\${label}</h3>
          <div class="metric">\${value} <small>\${suffix}</small></div>
        </div>
      \`).join("");
      const countEl = document.getElementById("import-count");
      if (countEl) {
        const total = state.imports?.total ?? o.import_count ?? 0;
        countEl.textContent = total ? total + " upload" + (total === 1 ? "" : "s") : "";
      }
      renderImports();
    }

    function renderImports() {
      const importsEl = document.getElementById("imports");
      const items = state.imports?.imports ?? [];
      if (!importsEl) return;
      if (!items.length) {
        importsEl.innerHTML = '<div class="empty">No uploads yet.</div>';
        return;
      }
      importsEl.innerHTML = items.map((item) => {
        const viewUrl = item.file_view_url ?? (item.stored_filename ? "/api/imports/" + item.id + "/view" : null);
        const fileLink = viewUrl
          ? \`<a href="\${viewUrl}" target="_blank" rel="noopener">\${item.filename}</a>\`
          : item.filename;
        return \`
          <div class="import-row">
            <div>
              <span class="pill \${item.utility}">\${item.utility}</span>
              \${fileLink}
              <div class="muted">\${item.format} · \${item.reading_count} readings</div>
            </div>
            <div class="muted">\${fmtDate(item.imported_at)}</div>
          </div>
        \`;
      }).join("");
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
        ? sources.map((source, index) => {
            const meta = source.readings_in_view + " readings · " + source.format;
            const viewUrl = source.file_view_url ?? source.file_url;
            const name = viewUrl
              ? '<a href="' + escapeHtml(viewUrl) + '" target="_blank" rel="noopener">' + escapeHtml(source.filename) + '</a>'
              : escapeHtml(source.filename);
            let html = '<li>' + name + '<div class="muted">' + meta + '</div>';
            html += '<ul class="source-detail">';
            if (viewUrl) {
              html += renderLinkRow("View", viewUrl, source.file_fetch, "source-file", index);
            }
            if (source.nbu_url) {
              html += renderLinkRow("NBU export", source.nbu_url, source.nbu_fetch, "source-nbu", index);
            }
            html += '</ul></li>';
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
              html += '<ul class="source-detail">' +
                renderLinkRow("Verify on NBU", gap.nbu_url, gap.nbu_fetch, "missing-nbu", index, "Copy verify snippet") + '</ul>';
            }
            html += '</li>';
            return html;
          }).join("") + (missing.length > 12
            ? '<li class="muted">…and ' + (missing.length - 12) + ' more · <a href="#missing-sources-card">View all ' + missing.length + '</a></li>'
            : "")
        : '<li class="none">No gaps in this view.</li>';

      el.innerHTML =
        '<div class="chart-sources-grid">' +
          '<div><h3>Source files (' + sources.length + ')</h3><ul>' + sourceItems + '</ul></div>' +
          '<div><h3>Missing (' + missing.length + ')</h3><ul>' + missingItems + '</ul></div>' +
        '</div>';
      el.hidden = false;

      el.querySelectorAll("button[data-date]").forEach((button) => {
        button.addEventListener("click", () => openCoverageDay(button.dataset.date));
      });
      el.querySelectorAll(".copy-snippet").forEach((button) => {
        const kind = button.dataset.kind;
        const index = Number(button.dataset.index);
        let text = null;
        if (kind === "source-file") text = usage.sources[index]?.file_fetch ?? null;
        else if (kind === "source-nbu") text = usage.sources[index]?.nbu_fetch ?? null;
        else if (kind === "missing-nbu") text = usage.missing[index]?.nbu_fetch ?? null;
        button.addEventListener("click", () => copySnippet(button, text));
      });
    }

    function renderChart() {
      const usage = state.usage;
      const svg = document.getElementById("chart");
      const tooltip = document.getElementById("chart-tooltip");
      const empty = document.getElementById("chart-empty");
      if (!usage || !usage.points.length) {
        svg.innerHTML = "";
        if (tooltip) tooltip.hidden = true;
        empty.hidden = false;
        renderChartSources();
        return;
      }
      empty.hidden = true;
      const width = 1000;
      const height = 300;
      const pad = { top: 20, right: 16, bottom: 52, left: 48 };
      const innerW = width - pad.left - pad.right;
      const innerH = height - pad.top - pad.bottom;
      const values = usage.points.map((p) => p.value);
      const max = Math.max(...values, 0.001);
      const step = innerW / values.length;
      const barW = Math.max(2, step - 2);
      const showYears = chartSpansYears(usage.points);
      const color = usage.utility === "water" ? "#0ea5e9" : "#f59e0b";

      const bars = usage.points.map((point, index) => {
        const h = (point.value / max) * innerH;
        const x = pad.left + index * step;
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
      if (!dayInput || !granularity) return;
      dayInput.value = dateKey;
      granularity.value = "hour";
      syncDayControls();
      loadUsage();
      document.querySelector(".chart-wrap")?.scrollIntoView({ behavior: "smooth", block: "start" });
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
      const utility = document.getElementById("utility").value;
      const params = propertyParams();
      params.set("utility", utility);
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
          linksHtml = '<span class="muted">Set Object ID for verify snippet</span>';
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
      const utility = document.getElementById("utility").value;
      const params = propertyParams();
      params.set("utility", utility);
      const res = await fetch("/api/missing-sources?" + params.toString());
      state.missingSources = await res.json();
      renderMissingSources();
    }

    async function loadOverview() {
      const params = propertyParams();
      const res = await fetch("/api/overview?" + params.toString());
      state.overview = await res.json();
      renderStats();
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
      const utility = document.getElementById("utility").value;
      const granularity = document.getElementById("granularity").value;
      const days = document.getElementById("range").value;
      const day = document.getElementById("day").value;
      const params = propertyParams();
      params.set("utility", utility);
      params.set("granularity", granularity);
      if (day) params.set("date", day);
      else if (days) params.set("days", days);
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

    document.getElementById("property").addEventListener("change", async (event) => {
      const propertyId = event.target.value;
      const property = state.overview?.properties.find((item) => item.id === propertyId);
      const labelInput = document.getElementById("property-label");
      const objectIdInput = document.getElementById("property-object-id");
      if (labelInput && property) {
        labelInput.value = state.overview.settings.property_labels[property.id] ?? property.label ?? "";
      }
      if (objectIdInput && property) {
        objectIdInput.value = state.overview.settings.property_object_ids?.[property.id] ?? "";
      }
      const objectIdHint = document.getElementById("object-id-hint");
      if (objectIdHint) {
        objectIdHint.hidden = Boolean(state.overview.settings.property_object_ids?.[propertyId]);
      }
      await savePropertySelection(propertyId);
      await loadOverview();
      await loadImports();
      await loadUsage();
      await loadCoverage();
      await loadMissingSources();
    });
    document.getElementById("save-label").addEventListener("click", async () => {
      const propertyId = selectedPropertyId();
      const label = document.getElementById("property-label").value;
      if (!propertyId) return;
      const res = await fetch("/api/settings/property-label", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ property_id: propertyId, label }),
      });
      const payload = await res.json();
      if (payload.settings) {
        state.overview.settings = payload.settings;
        await loadOverview();
      }
    });
    document.getElementById("save-object-id").addEventListener("click", async () => {
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
        await loadUsage();
        await loadMissingSources();
      }
    });
    document.getElementById("utility").addEventListener("change", async () => {
      await loadUsage();
      await loadCoverage();
      await loadMissingSources();
    });
    document.getElementById("granularity").addEventListener("change", loadUsage);
    document.getElementById("range").addEventListener("change", loadUsage);
    document.getElementById("day").addEventListener("change", loadUsage);
    document.getElementById("clear-day").addEventListener("click", () => {
      const dayInput = document.getElementById("day");
      if (!dayInput) return;
      dayInput.value = "";
      syncDayControls();
      loadUsage();
    });
    document.getElementById("refresh").addEventListener("click", async () => {
      await loadOverview();
      await loadImports();
      await loadUsage();
      await loadCoverage();
      await loadMissingSources();
    });
    document.getElementById("refresh-missing-sources").addEventListener("click", loadMissingSources);
    document.getElementById("copy-verify-all-script").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const script = state.clipboardScripts.verifyAll;
      if (!script) return;
      await copySnippet(button, script);
    });
    document.getElementById("copy-probe-script").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const script = state.clipboardScripts.probe;
      if (!script) return;
      await copySnippet(button, script);
    });
    document.getElementById("copy-token").addEventListener("click", async () => {
      const token = state.overview?.settings?.ingest_token;
      const button = document.getElementById("copy-token");
      if (!token || !button) return;
      await copySnippet(button, token);
    });
    document.getElementById("rotate-token").addEventListener("click", async () => {
      const res = await fetch("/api/settings/rotate-token", { method: "POST" });
      const payload = await res.json();
      if (payload.settings) {
        state.overview.settings = payload.settings;
        renderStats();
      }
    });

    function formatBackupTimestamp(iso) {
      if (!iso) return "never";
      return new Date(iso).toLocaleString();
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
            payload.live_reading_count + " readings · " + payload.live_import_count + " imports";
        }
        if (folderSummary) {
          if (!payload.backup_available) {
            folderSummary.textContent = "No backup yet.";
          } else {
            folderSummary.textContent =
              payload.backup_reading_count + " readings · " + payload.backup_import_count + " imports";
          }
        }
        if (statusEl) {
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
              " readings. Last backup: " +
              formatBackupTimestamp(payload.backup_updated_at) +
              ".";
          }
        }
        if (exportBtn) exportBtn.disabled = !payload.backup_writable;
        if (importBtn) importBtn.disabled = !payload.backup_available;
      } catch (error) {
        if (liveSummary) liveSummary.textContent = "Unavailable";
        if (folderSummary) folderSummary.textContent = "Unavailable";
        if (statusEl) statusEl.textContent = error.message || "Could not load backup status.";
        if (exportBtn) exportBtn.disabled = true;
        if (importBtn) importBtn.disabled = true;
      }
    }

    document.getElementById("backup-export-btn").addEventListener("click", async () => {
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

    document.getElementById("backup-import-btn").addEventListener("click", async () => {
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
        await loadOverview();
        await loadImports();
        await loadUsage();
        await loadCoverage();
        await loadMissingSources();
        await refreshBackupStatus("Restore completed.");
      } catch (error) {
        const statusEl = document.getElementById("backup-status");
        if (statusEl) statusEl.textContent = error.message || "Restore failed.";
        await refreshBackupStatus();
      }
    });

    loadOverview()
      .then(loadImports)
      .then(loadUsage)
      .then(loadCoverage)
      .then(loadMissingSources)
      .then(() => refreshBackupStatus());
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
      sendJson(res, 200, await getUsageSummary(propertyId, utility, granularity, days, date));
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

    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      sendText(res, 200, "text/html; charset=utf-8", dashboardPage());
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