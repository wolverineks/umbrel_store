import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { exportNbuData, getBackupStatus, importNbuData } from "./backup-restore";
import { parseNbuExport, type Granularity, type Utility } from "./parsers";
import {
  getOverview,
  getUsageSummary,
  importParsed,
  listProperties,
  loadSettings,
  resetStoreCaches,
  resolvePropertyId,
  rotateIngestToken,
  setPropertyLabel,
  setSelectedProperty,
} from "./store";

const APP_VERSION = "1.2.1";
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
      const record = await importParsed(parsed);
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
        results.push(await importParsed(parsed));
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
    const parsed = parseNbuExport(filename, body.toString("utf8"));
    const record = await importParsed(parsed);
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
    input[type="text"] {
      font: inherit;
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 0.55rem 0.8rem;
      background: var(--panel);
      color: var(--text);
    }
    select, button, input[type="file"] {
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
    .drop-zone {
      margin-top: 0.8rem;
      border: 2px dashed var(--border);
      border-radius: 14px;
      padding: 1.5rem 1rem;
      text-align: center;
      color: var(--muted);
      background: var(--bg);
      transition: border-color 0.15s ease, background 0.15s ease;
      cursor: pointer;
    }
    .drop-zone strong {
      display: block;
      color: var(--text);
      margin-bottom: 0.25rem;
    }
    .drop-zone.dragover {
      border-color: var(--accent);
      background: var(--accent-soft);
      color: var(--accent);
    }
    .drop-zone input[type="file"] {
      display: none;
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
      </div>
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
        <button id="refresh" class="secondary">Refresh</button>
      </div>
      <div class="chart-shell">
        <svg class="chart" id="chart" viewBox="0 0 1000 300" preserveAspectRatio="none"></svg>
        <div class="chart-tooltip" id="chart-tooltip" hidden></div>
      </div>
      <div class="empty" id="chart-empty" hidden>No readings for this view yet. Import NBU exports below.</div>
    </div>

    <div class="grid">
      <div class="card">
        <h2>Import files</h2>
        <p class="muted">Upload Green Button XML, hourly CSV, or reading history CSV from Customer Connect.</p>
        <label class="drop-zone" id="drop-zone" for="upload">
          <input type="file" id="upload" multiple accept=".xml,.csv,text/xml,text/csv">
          <strong>Drop NBU exports here</strong>
          or click to browse
        </label>
        <p class="muted" id="upload-status" style="margin-top:0.8rem"></p>
      </div>
      <div class="card">
        <h2>Chrome extension</h2>
        <p class="muted">Configure the companion extension with your Umbrel URL and ingest token.</p>
        <div class="token-box" style="margin-top:0.8rem">
          <code id="token"></code>
          <button id="rotate-token" class="secondary">Rotate token</button>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:1rem">
      <h2>Recent imports</h2>
      <div class="imports" id="imports"></div>
    </div>

    <div class="card" style="margin-top:1rem">
      <h2>Backup &amp; restore</h2>
      <p class="muted">
        Copy all usage data, settings, and property names to
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
    const state = { overview: null, usage: null };

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
      const o = state.overview;
      if (!select || !o) return;

      if (!o.properties.length) {
        select.innerHTML = '<option value="">No properties yet</option>';
        if (labelInput) labelInput.value = "";
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
      if (o.selected_property) {
        document.getElementById("address").textContent = o.selected_property.label;
      }
    }

    function fmtDate(iso) {
      return new Date(iso).toLocaleString();
    }

    function chartSpansYears(points) {
      if (!points?.length) return false;
      const years = new Set(points.map((point) => new Date(point.period_start).getFullYear()));
      return years.size > 1;
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
      const granularity = document.getElementById("granularity").value;
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
      const importsEl = document.getElementById("imports");
      if (!o.imports.length) {
        importsEl.innerHTML = '<div class="empty">No imports yet.</div>';
        return;
      }
      importsEl.innerHTML = o.imports.map(item => \`
        <div class="import-row">
          <div>
            <span class="pill \${item.utility}">\${item.utility}</span>
            \${item.filename}
            <div class="muted">\${item.format} · \${item.reading_count} readings</div>
          </div>
          <div class="muted">\${fmtDate(item.imported_at)}</div>
        </div>
      \`).join("");
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

      const tickIndexes = new Set(
        [0, Math.floor(usage.points.length / 2), usage.points.length - 1]
          .concat(yearMarkers.map((marker) => marker.index))
      );
      const labels = [...tickIndexes]
        .sort((a, b) => a - b)
        .map((index) => {
          const point = usage.points[index];
          const x = pad.left + index * step;
          const year = new Date(point.period_start).getFullYear();
          const isYearStart = yearMarkers.some((marker) => marker.index === index);
          const label = isYearStart
            ? fmtShortDate(point.period_start, true)
            : fmtShortDate(point.period_start, showYears);
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

    async function loadOverview() {
      const params = propertyParams();
      const res = await fetch("/api/overview?" + params.toString());
      state.overview = await res.json();
      renderStats();
    }

    async function loadUsage() {
      const utility = document.getElementById("utility").value;
      const granularity = document.getElementById("granularity").value;
      const days = document.getElementById("range").value;
      const params = propertyParams();
      params.set("utility", utility);
      params.set("granularity", granularity);
      if (days) params.set("days", days);
      const res = await fetch("/api/usage?" + params.toString());
      state.usage = await res.json();
      renderChart();
    }

    async function savePropertySelection(propertyId) {
      await fetch("/api/settings/property", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ property_id: propertyId }),
      });
    }

    async function uploadFiles(fileList) {
      const status = document.getElementById("upload-status");
      const token = state.overview?.settings?.ingest_token;
      if (!token) {
        status.textContent = "Missing ingest token.";
        return;
      }
      const form = new FormData();
      for (const file of fileList) form.append("files", file, file.name);
      status.textContent = "Uploading...";
      const res = await fetch("/api/ingest", {
        method: "POST",
        headers: { "X-Ingest-Token": token },
        body: form,
      });
      const payload = await res.json();
      if (!res.ok) {
        status.textContent = payload.error || "Upload failed";
        return;
      }
      status.textContent = "Imported " + (payload.imports?.length || 1) + " file(s).";
      await loadOverview();
      await loadUsage();
    }

    document.getElementById("property").addEventListener("change", async (event) => {
      const propertyId = event.target.value;
      const property = state.overview?.properties.find((item) => item.id === propertyId);
      const labelInput = document.getElementById("property-label");
      if (labelInput && property) {
        labelInput.value = state.overview.settings.property_labels[property.id] ?? property.label ?? "";
      }
      await savePropertySelection(propertyId);
      await loadOverview();
      await loadUsage();
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
    document.getElementById("utility").addEventListener("change", loadUsage);
    document.getElementById("granularity").addEventListener("change", loadUsage);
    document.getElementById("range").addEventListener("change", loadUsage);
    document.getElementById("refresh").addEventListener("click", async () => {
      await loadOverview();
      await loadUsage();
    });
    function acceptedUploadFiles(fileList) {
      return [...fileList].filter((file) => /\.(xml|csv)$/i.test(file.name));
    }

    function bindDropZone() {
      const dropZone = document.getElementById("drop-zone");
      const input = document.getElementById("upload");
      if (!dropZone || !input) return;

      const setDragState = (active) => {
        dropZone.classList.toggle("dragover", active);
      };

      ["dragenter", "dragover"].forEach((eventName) => {
        dropZone.addEventListener(eventName, (event) => {
          event.preventDefault();
          event.stopPropagation();
          setDragState(true);
        });
      });

      ["dragleave", "drop"].forEach((eventName) => {
        dropZone.addEventListener(eventName, (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (eventName === "dragleave" && dropZone.contains(event.relatedTarget)) return;
          setDragState(false);
        });
      });

      dropZone.addEventListener("drop", async (event) => {
        const files = acceptedUploadFiles(event.dataTransfer?.files ?? []);
        if (!files.length) {
          const status = document.getElementById("upload-status");
          if (status) status.textContent = "Drop XML or CSV files only.";
          return;
        }
        await uploadFiles(files);
        input.value = "";
      });

      input.addEventListener("change", async (event) => {
        const target = event.target;
        if (!target.files?.length) return;
        const files = acceptedUploadFiles(target.files);
        if (!files.length) {
          const status = document.getElementById("upload-status");
          if (status) status.textContent = "Choose XML or CSV files only.";
          target.value = "";
          return;
        }
        await uploadFiles(files);
        target.value = "";
      });
    }

    bindDropZone();
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
        await loadUsage();
        await refreshBackupStatus("Restore completed.");
      } catch (error) {
        const statusEl = document.getElementById("backup-status");
        if (statusEl) statusEl.textContent = error.message || "Restore failed.";
        await refreshBackupStatus();
      }
    });

    loadOverview().then(loadUsage).then(() => refreshBackupStatus());
  </script>
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
      const days = parseDays(url.searchParams.get("days"));
      sendJson(res, 200, await getUsageSummary(propertyId, utility, granularity, days));
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