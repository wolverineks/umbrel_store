"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_http_1 = require("node:http");
const promises_1 = require("node:fs/promises");
const node_path_1 = __importDefault(require("node:path"));
const parsers_1 = require("./parsers");
const store_1 = require("./store");
const APP_VERSION = "1.0.0";
const PORT = Number(process.env.PORT ?? 3000);
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
    if (value === "day" || value === "billing_period")
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
            const record = await (0, store_1.importParsed)(parsed);
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
                results.push(await (0, store_1.importParsed)(parsed));
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
        const parsed = (0, parsers_1.parseNbuExport)(filename, body.toString("utf8"));
        const record = await (0, store_1.importParsed)(parsed);
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
    .layout {
      max-width: 1180px;
      margin: 0 auto;
      padding: 1.5rem;
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
      padding: 1rem;
      box-shadow: var(--shadow);
      margin-bottom: 1.5rem;
    }
    .chart {
      width: 100%;
      height: 280px;
      display: block;
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
function dashboardPage() {
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
      <svg class="chart" id="chart" viewBox="0 0 1000 280" preserveAspectRatio="none"></svg>
      <div class="empty" id="chart-empty" hidden>No readings for this view yet. Import NBU exports below.</div>
    </div>

    <div class="grid">
      <div class="card">
        <h2>Import files</h2>
        <p class="muted">Upload Green Button XML, hourly CSV, or reading history CSV from Customer Connect.</p>
        <div style="margin-top:0.8rem">
          <input type="file" id="upload" multiple accept=".xml,.csv,text/xml,text/csv">
        </div>
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
  </div>
  <script>
    const state = { overview: null, usage: null };

    function fmtDate(iso) {
      return new Date(iso).toLocaleString();
    }

    function fmtShortDate(iso) {
      return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    }

    function renderStats() {
      const el = document.getElementById("stats");
      const o = state.overview;
      if (!o) return;
      if (o.settings.address) {
        document.getElementById("address").textContent = o.settings.address;
      }
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
      const empty = document.getElementById("chart-empty");
      if (!usage || !usage.points.length) {
        svg.innerHTML = "";
        empty.hidden = false;
        return;
      }
      empty.hidden = true;
      const width = 1000;
      const height = 280;
      const pad = { top: 20, right: 16, bottom: 36, left: 48 };
      const innerW = width - pad.left - pad.right;
      const innerH = height - pad.top - pad.bottom;
      const values = usage.points.map(p => p.value);
      const max = Math.max(...values, 0.001);
      const barW = Math.max(2, innerW / values.length - 2);
      const bars = usage.points.map((point, index) => {
        const h = (point.value / max) * innerH;
        const x = pad.left + index * (innerW / values.length);
        const y = pad.top + innerH - h;
        const color = usage.utility === "water" ? "#0ea5e9" : "#f59e0b";
        return \`<rect x="\${x}" y="\${y}" width="\${barW}" height="\${h}" rx="2" fill="\${color}" opacity="0.9"><title>\${fmtShortDate(point.period_start)}: \${point.value} \${usage.unit}</title></rect>\`;
      }).join("");
      const labels = [usage.points[0], usage.points[Math.floor(usage.points.length / 2)], usage.points[usage.points.length - 1]]
        .filter(Boolean)
        .map((point, idx, arr) => {
          const index = usage.points.indexOf(point);
          const x = pad.left + index * (innerW / values.length);
          return \`<text x="\${x}" y="\${height - 10}" fill="#64748b" font-size="12">\${fmtShortDate(point.period_start)}</text>\`;
        }).join("");
      svg.innerHTML = \`
        <line x1="\${pad.left}" y1="\${pad.top + innerH}" x2="\${width - pad.right}" y2="\${pad.top + innerH}" stroke="#e2e8f0"/>
        <text x="12" y="\${pad.top + 12}" fill="#64748b" font-size="12">\${max.toFixed(1)} \${usage.unit}</text>
        \${bars}
        \${labels}
      \`;
    }

    async function loadOverview() {
      const res = await fetch("/api/overview");
      state.overview = await res.json();
      renderStats();
    }

    async function loadUsage() {
      const utility = document.getElementById("utility").value;
      const granularity = document.getElementById("granularity").value;
      const days = document.getElementById("range").value;
      const params = new URLSearchParams({ utility, granularity });
      if (days) params.set("days", days);
      const res = await fetch("/api/usage?" + params.toString());
      state.usage = await res.json();
      renderChart();
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

    document.getElementById("utility").addEventListener("change", loadUsage);
    document.getElementById("granularity").addEventListener("change", loadUsage);
    document.getElementById("range").addEventListener("change", loadUsage);
    document.getElementById("refresh").addEventListener("click", async () => {
      await loadOverview();
      await loadUsage();
    });
    document.getElementById("upload").addEventListener("change", async (event) => {
      const input = event.target;
      if (!input.files?.length) return;
      await uploadFiles(input.files);
      input.value = "";
    });
    document.getElementById("rotate-token").addEventListener("click", async () => {
      const res = await fetch("/api/settings/rotate-token", { method: "POST" });
      const payload = await res.json();
      if (payload.settings) {
        state.overview.settings = payload.settings;
        renderStats();
      }
    });

    loadOverview().then(loadUsage);
  </script>
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
        if (req.method === "GET" && pathname === "/api/overview") {
            sendJson(res, 200, await (0, store_1.getOverview)());
            return;
        }
        if (req.method === "GET" && pathname === "/api/usage") {
            const utility = parseUtility(url.searchParams.get("utility"));
            const granularity = parseGranularity(url.searchParams.get("granularity"));
            const days = parseDays(url.searchParams.get("days"));
            sendJson(res, 200, await (0, store_1.getUsageSummary)(utility, granularity, days));
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
        if (req.method === "POST" && pathname === "/api/ingest") {
            await handleIngest(req, res);
            return;
        }
        if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
            sendText(res, 200, "text/html; charset=utf-8", dashboardPage());
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
