import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  clearAppBackup,
  exportAppData,
  getBackupStatus,
  importAppData,
} from "./backup-restore";
import {
  clearAppData,
  loadSettings,
  resetStoreCaches,
  rotateIngestToken,
  saveSettings,
  updateNote,
  DATA_ROOT,
} from "./store";

const APP_VERSION = "0.1.0";
const IS_LOCAL_DEV = process.env.__ENV_PREFIX___DEV === "1";
const PORT = Number(process.env.PORT ?? 3000);
const BACKUP_ROOT = process.env.__ENV_PREFIX___BACKUP_DIR ?? "/backup";
const BACKUP_HOST_PATH =
  process.env.__ENV_PREFIX___BACKUP_HOST_PATH ?? "__BACKUP_HOST_PATH__";
const ICON_PATH = path.join(__dirname, "icon.svg");
const THEME_KEY = "__APP_SLUG__-theme";
const DEV_BASE_URL = "http://localhost:__APP_PORT__";
const EXTENSION_REPO_URL =
  "https://github.com/wolverineks/umbrel_store/tree/master/__APP_ID__/chrome-extension";

type Page = "overview" | "setup";

const PAGE_ROUTES: Record<string, Page> = {
  "/": "overview",
  "/overview": "overview",
  "/setup": "setup",
};

function loadExtensionVersion(): string {
  const manifestPath = path.join(__dirname, "..", "chrome-extension", "manifest.json");
  if (!existsSync(manifestPath)) return "0.1.0";
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: string };
    return manifest.version?.trim() || "0.1.0";
  } catch {
    return "0.1.0";
  }
}

const EXTENSION_VERSION = loadExtensionVersion();

function resolvePage(pathname: string): Page | null {
  return PAGE_ROUTES[pathname] ?? null;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
      --danger-bg: #fef2f2;
      --danger-text: #b91c1c;
      --shadow: 0 10px 30px rgba(15, 23, 42, 0.08);
    }
    html[data-theme="dark"] {
      color-scheme: dark;
      --bg: #0f172a;
      --panel: #1e293b;
      --text: #f1f5f9;
      --muted: #94a3b8;
      --border: #334155;
      --accent: #60a5fa;
      --accent-soft: #1e3a5f;
      --danger-bg: #450a0a;
      --danger-text: #fca5a5;
      --shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    .app-shell { display: flex; min-height: 100vh; }
    .side-nav {
      width: 232px; flex-shrink: 0; background: var(--panel);
      border-right: 1px solid var(--border); position: sticky; top: 0;
      align-self: flex-start; height: 100vh; overflow-y: auto; z-index: 30;
    }
    .side-nav-inner {
      display: flex; flex-direction: column; min-height: 100%;
      padding: 1.5rem 1rem 1.25rem;
    }
    .brand { display: flex; gap: 0.75rem; align-items: center; margin-bottom: 1.5rem; padding: 0 0.5rem; }
    .brand img { width: 40px; height: 40px; border-radius: 10px; }
    .brand h1 { font-size: 1rem; margin: 0; line-height: 1.2; }
    .brand p { margin: 0.15rem 0 0; color: var(--muted); font-size: 0.8rem; }
    .side-nav-links { display: flex; flex-direction: column; gap: 0.2rem; flex: 1; }
    .side-nav-link {
      display: block; padding: 0.52rem 0.7rem; border-radius: 10px;
      color: var(--text); text-decoration: none; font-size: 0.9rem; font-weight: 500;
    }
    .side-nav-link:hover, .side-nav-link.active { background: var(--accent-soft); color: var(--accent); }
    .side-nav-link.active { font-weight: 600; }
    .sidebar-version { margin-top: auto; padding: 0.75rem 0.85rem 0; font-size: 0.7rem; color: var(--muted); opacity: 0.7; }
    .side-nav-backdrop {
      position: fixed; inset: 0; background: rgba(15, 23, 42, 0.35);
      z-index: 25; border: 0; padding: 0; margin: 0; cursor: pointer;
    }
    .side-nav-toggle {
      display: none; width: 2.5rem; height: 2.5rem; padding: 0; font-size: 1.15rem;
    }
    .app-main { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 100vh; }
    .app-header {
      position: sticky; top: 0; z-index: 20; display: flex; align-items: center;
      justify-content: space-between; gap: 1rem; padding: 0.8rem 1.5rem;
      background: color-mix(in srgb, var(--panel) 92%, transparent);
      border-bottom: 1px solid var(--border); backdrop-filter: blur(10px);
    }
    .app-header-start { display: flex; align-items: center; gap: 0.85rem; min-width: 0; }
    .app-header-end { display: flex; align-items: center; gap: 0.5rem; }
    .main-content { padding: 1.25rem 1.5rem 2rem; }
    .card {
      background: var(--panel); border: 1px solid var(--border); border-radius: 14px;
      padding: 1.25rem; box-shadow: var(--shadow);
    }
    .card + .card { margin-top: 1rem; }
    .muted { color: var(--muted); }
    .dev-banner {
      background: var(--accent-soft); color: var(--accent); padding: 0.55rem 0.75rem;
      border-radius: 8px; font-size: 0.88rem; margin-bottom: 1rem;
    }
    .setup-section-title { margin: 1.25rem 0 0.35rem; font-size: 0.95rem; color: var(--muted); }
    .token-box {
      display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center;
      background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 0.65rem 0.75rem;
    }
    .token-box code { word-break: break-all; flex: 1 1 12rem; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin-top: 0.75rem; }
    input, button, textarea, select {
      font: inherit; border: 1px solid var(--border); border-radius: 10px;
      padding: 0.55rem 0.75rem; background: var(--panel); color: var(--text);
    }
    button {
      background: var(--accent); color: #fff; border-color: var(--accent); cursor: pointer;
    }
    button.secondary { background: var(--panel); color: var(--text); border-color: var(--border); }
    button.danger { background: var(--danger-bg); color: var(--danger-text); border-color: #fecaca; }
    html[data-theme="dark"] button.danger { border-color: #7f1d1d; }
    textarea { width: 100%; min-height: 5rem; resize: vertical; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; }
    @media (max-width: 900px) {
      .side-nav {
        position: fixed; left: 0; top: 0; transform: translateX(-100%);
        transition: transform 0.2s ease; box-shadow: var(--shadow);
      }
      .side-nav.open { transform: translateX(0); }
      .side-nav-toggle { display: inline-flex; align-items: center; justify-content: center; }
      .main-content { padding: 1rem; }
      .app-header { padding: 0.75rem 1rem; }
    }
    @media (min-width: 901px) {
      .side-nav-backdrop { display: none !important; }
    }
  `;
}

function renderSideNav(active: Page): string {
  const items = [
    { page: "overview" as const, href: "/", label: "Overview" },
    { page: "setup" as const, href: "/setup", label: "Setup" },
  ];
  return items
    .map(
      (item) =>
        `<a class="side-nav-link${item.page === active ? " active" : ""}" href="${item.href}">${item.label}</a>`,
    )
    .join("\n          ");
}

function pageContent(page: Page): string {
  if (page === "overview") {
    return `
      <div class="grid">
        <div class="card"><h3 style="margin:0 0 0.35rem">Status</h3><p class="muted" style="margin:0">Template ready — replace this overview.</p></div>
        <div class="card"><h3 style="margin:0 0 0.35rem">Data</h3><p class="muted" style="margin:0"><code>${escapeHtml(DATA_ROOT)}</code></p></div>
      </div>`;
  }

  return `
      <div class="card">
        <h2 style="margin:0 0 0.5rem">Extension <span class="muted" style="font-size:0.9rem;font-weight:600">v${EXTENSION_VERSION}</span></h2>
        <p class="muted">Configure the companion Chrome extension (v${EXTENSION_VERSION}) with Production and Development Umbrel URLs and ingest tokens.</p>

        <h3 class="setup-section-title">Production</h3>
        <p class="muted" style="margin:0 0 0.5rem">Umbrel URL when this dashboard is open on your device.</p>
        <div class="token-box">
          <code id="prod-base-url">Loading…</code>
          <button type="button" class="secondary" id="copy-prod-url">Copy URL</button>
        </div>
        <p class="muted" style="margin:0.75rem 0 0.35rem">Ingest token (shared with Development unless you rotate separately).</p>
        <div class="token-box">
          <code id="token"></code>
          <button type="button" class="secondary" id="copy-token">Copy token</button>
          <button type="button" class="secondary" id="rotate-token">Rotate token</button>
        </div>

        <h3 class="setup-section-title">Development</h3>
        <p class="muted" style="margin:0 0 0.5rem">Local dev server — run <code>npm run dev:local</code> in <code>site/</code>.</p>
        <div class="token-box">
          <code id="dev-base-url">${escapeHtml(DEV_BASE_URL)}</code>
          <button type="button" class="secondary" id="copy-dev-url">Copy URL</button>
          <button type="button" class="secondary" id="copy-dev-both">Copy URL + token</button>
        </div>

        <h3 class="setup-section-title">Load unpacked</h3>
        <ol class="muted" style="margin:0;padding-left:1.2rem">
          <li>Chrome → Extensions → Developer mode → <strong>Load unpacked</strong></li>
          <li>Select <code>__APP_ID__/chrome-extension</code> from <a href="${EXTENSION_REPO_URL}" target="_blank" rel="noreferrer">the repo</a></li>
          <li>Set Production and Development in the popup, then <strong>Save settings</strong></li>
          <li>Extension v${EXTENSION_VERSION} · reload after code changes</li>
        </ol>
      </div>

      <div class="card">
        <h2 style="margin:0 0 0.5rem">App settings</h2>
        <label for="note">Note</label>
        <textarea id="note" placeholder="Optional note stored in settings.json"></textarea>
        <button type="button" id="save-note">Save note</button>
        <p class="muted" id="note-status" style="margin-top:0.75rem"></p>
      </div>

      <div class="card">
        <h2 style="margin:0 0 0.5rem">Backup &amp; restore</h2>
        <p class="muted">Copies live data to <code id="backup-host-path">${escapeHtml(BACKUP_HOST_PATH)}</code> on your Umbrel.</p>
        <div class="grid" style="margin-top:0.75rem">
          <div><h3 style="margin:0;font-size:0.95rem">Live data</h3><p class="muted" id="backup-live-summary">Loading…</p></div>
          <div><h3 style="margin:0;font-size:0.95rem">Backup folder</h3><p class="muted" id="backup-folder-summary">Loading…</p></div>
        </div>
        <p class="muted" id="backup-status" style="margin-top:0.75rem"></p>
        <div class="toolbar">
          <button type="button" id="backup-export-btn">Back up now</button>
          <button type="button" class="secondary" id="backup-import-btn">Restore from backup</button>
        </div>
        <h3 class="setup-section-title">Clear data</h3>
        <p class="muted">Remove live data files or the backup folder. Settings and ingest token are kept when clearing live data.</p>
        <div class="toolbar">
          <button type="button" class="danger secondary" id="clear-data-btn">Clear live data</button>
          <button type="button" class="danger secondary" id="clear-backup-btn">Clear backup folder</button>
        </div>
      </div>`;
}

function renderPage(page: Page): string {
  const devBanner = IS_LOCAL_DEV
    ? `<p class="dev-banner">Local dev · data <code>${escapeHtml(DATA_ROOT)}</code> · backup <code>${escapeHtml(BACKUP_ROOT)}</code></p>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#1d4ed8">
  <title>__APP_NAME__ · ${page === "overview" ? "Overview" : "Setup"}</title>
  <style>${pageStyles()}</style>
  <script>
    (function () {
      try {
        var saved = localStorage.getItem(${JSON.stringify(THEME_KEY)});
        var theme = saved === "dark" || saved === "light"
          ? saved
          : (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
        document.documentElement.dataset.theme = theme;
      } catch (e) {}
    })();
  </script>
</head>
<body>
  <div class="app-shell">
    <aside class="side-nav" id="side-nav" aria-label="Sections">
      <div class="side-nav-inner">
        <div class="brand">
          <img src="/icon.svg" alt="">
          <div>
            <h1>__APP_NAME__</h1>
            <p>__APP_TAGLINE__</p>
          </div>
        </div>
        <nav class="side-nav-links">${renderSideNav(page)}</nav>
        <p class="sidebar-version">App v${APP_VERSION}<br>Extension v${EXTENSION_VERSION}${IS_LOCAL_DEV ? "<br>dev mode" : ""}</p>
      </div>
    </aside>
    <button class="side-nav-backdrop" id="side-nav-backdrop" type="button" aria-label="Close menu" hidden></button>
    <div class="app-main">
      <header class="app-header">
        <div class="app-header-start">
          <button type="button" class="side-nav-toggle secondary" id="side-nav-toggle" aria-controls="side-nav" aria-expanded="false" aria-label="Open menu">☰</button>
          <strong>${page === "overview" ? "Overview" : "Setup"}</strong>
        </div>
        <div class="app-header-end">
          <button type="button" class="secondary" id="theme-toggle" aria-label="Toggle theme" title="Theme">☾</button>
          <button type="button" class="secondary" id="header-refresh">Refresh</button>
        </div>
      </header>
      <main class="main-content">
        ${devBanner}
        ${pageContent(page)}
      </main>
    </div>
  </div>
  <script>
    const APP_PAGE = ${JSON.stringify(page)};
    const THEME_KEY = ${JSON.stringify(THEME_KEY)};
    const DEV_BASE_URL = ${JSON.stringify(DEV_BASE_URL)};

    function on(id, event, handler) {
      const el = document.getElementById(id);
      if (el) el.addEventListener(event, handler);
    }

    function resolveTheme() {
      try {
        const saved = localStorage.getItem(THEME_KEY);
        if (saved === "light" || saved === "dark") return saved;
      } catch {}
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }

    function applyTheme(theme) {
      const next = theme === "dark" ? "dark" : "light";
      document.documentElement.dataset.theme = next;
      const button = document.getElementById("theme-toggle");
      if (button) {
        button.textContent = next === "dark" ? "☀" : "☾";
        button.title = next === "dark" ? "Light mode" : "Dark mode";
      }
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", next === "dark" ? "#0f172a" : "#1d4ed8");
    }

    function initTheme() {
      applyTheme(resolveTheme());
      on("theme-toggle", "click", () => {
        const next = (document.documentElement.dataset.theme || resolveTheme()) === "dark" ? "light" : "dark";
        try { localStorage.setItem(THEME_KEY, next); } catch {}
        applyTheme(next);
      });
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
      }
      toggle?.addEventListener("click", () => setNavOpen(!nav?.classList.contains("open")));
      backdrop?.addEventListener("click", () => setNavOpen(false));
      links.forEach((link) => link.addEventListener("click", () => setNavOpen(false)));
    }

    async function copyText(text) {
      await navigator.clipboard.writeText(text);
    }

    async function loadSetupState() {
      const res = await fetch("/api/settings");
      const payload = await res.json();
      const settings = payload.settings || {};
      const prodUrl = window.location.origin;
      const prodEl = document.getElementById("prod-base-url");
      const tokenEl = document.getElementById("token");
      const noteEl = document.getElementById("note");
      if (prodEl) prodEl.textContent = prodUrl;
      if (tokenEl) tokenEl.textContent = settings.ingest_token || "";
      if (noteEl) noteEl.value = settings.note || "";
    }

    async function refreshBackupStatus(message) {
      const statusEl = document.getElementById("backup-status");
      const liveSummary = document.getElementById("backup-live-summary");
      const folderSummary = document.getElementById("backup-folder-summary");
      const hostPathEl = document.getElementById("backup-host-path");
      const exportBtn = document.getElementById("backup-export-btn");
      const importBtn = document.getElementById("backup-import-btn");
      const clearDataBtn = document.getElementById("clear-data-btn");
      const clearBackupBtn = document.getElementById("clear-backup-btn");
      if (message && statusEl) statusEl.textContent = message;
      try {
        const response = await fetch("/api/backup/status");
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Could not load backup status.");
        if (hostPathEl) hostPathEl.textContent = payload.backup_host_path || "";
        if (liveSummary) liveSummary.textContent = payload.live_file_count + " file(s) in data/";
        if (folderSummary) {
          folderSummary.textContent = payload.backup_available
            ? payload.backup_file_count + " file(s) in backup"
            : "No backup yet.";
        }
        if (statusEl && !message) {
          statusEl.textContent = payload.backup_available
            ? "Backup ready. Last backup: " + (payload.backup_updated_at || "unknown") + "."
            : "No backup yet. Click Back up now.";
        }
        if (exportBtn) exportBtn.disabled = !payload.backup_writable;
        if (importBtn) importBtn.disabled = !payload.backup_available;
        if (clearDataBtn) clearDataBtn.disabled = !payload.live_file_count;
        if (clearBackupBtn) clearBackupBtn.disabled = !payload.backup_writable || !payload.backup_available;
      } catch (error) {
        if (statusEl) statusEl.textContent = error.message || "Backup status unavailable.";
      }
    }

    function bindSetupPage() {
      on("copy-prod-url", "click", async () => {
        await copyText(window.location.origin);
      });
      on("copy-dev-url", "click", async () => {
        await copyText(DEV_BASE_URL);
      });
      on("copy-dev-both", "click", async () => {
        const token = document.getElementById("token")?.textContent?.trim() || "";
        await copyText("Umbrel app URL: " + DEV_BASE_URL + "\\nIngest token: " + token);
      });
      on("copy-token", "click", async () => {
        const token = document.getElementById("token")?.textContent?.trim() || "";
        await copyText(token);
      });
      on("rotate-token", "click", async () => {
        if (!confirm("Rotate ingest token? Update the extension after rotating.")) return;
        const res = await fetch("/api/settings/rotate-token", { method: "POST" });
        const payload = await res.json();
        if (!res.ok) return alert(payload.error || "Rotate failed");
        await loadSetupState();
      });
      on("save-note", "click", async () => {
        const note = document.getElementById("note")?.value || "";
        const status = document.getElementById("note-status");
        const res = await fetch("/api/settings/note", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ note }),
        });
        const payload = await res.json();
        if (status) status.textContent = res.ok ? "Saved." : (payload.error || "Save failed");
      });
      on("backup-export-btn", "click", async () => {
        await refreshBackupStatus("Creating backup…");
        const res = await fetch("/api/backup/export", { method: "POST" });
        const payload = await res.json();
        if (!res.ok) return refreshBackupStatus(payload.error || "Backup failed");
        await refreshBackupStatus("Backup completed.");
      });
      on("backup-import-btn", "click", async () => {
        if (!confirm("Restore from backup? This replaces live data with the backup copy.")) return;
        await refreshBackupStatus("Restoring…");
        const res = await fetch("/api/backup/import", { method: "POST" });
        const payload = await res.json();
        if (!res.ok) return refreshBackupStatus(payload.error || "Restore failed");
        await refreshBackupStatus("Restore completed.");
        await loadSetupState();
      });
      on("clear-data-btn", "click", async () => {
        if (!confirm("Clear live data files? Settings and ingest token are kept.")) return;
        const res = await fetch("/api/data/clear", { method: "POST" });
        const payload = await res.json();
        await refreshBackupStatus(res.ok ? "Cleared " + payload.cleared_files + " item(s)." : (payload.error || "Clear failed"));
      });
      on("clear-backup-btn", "click", async () => {
        if (!confirm("Delete everything in the backup folder?")) return;
        const res = await fetch("/api/backup/clear", { method: "POST" });
        const payload = await res.json();
        await refreshBackupStatus(res.ok ? "Backup folder cleared." : (payload.error || "Clear failed"));
      });
    }

    on("header-refresh", "click", () => window.location.reload());

    initTheme();
    initSideNav();
    if (APP_PAGE === "setup") {
      loadSetupState();
      refreshBackupStatus();
      bindSetupPage();
    }
  </script>
</body>
</html>`;
}

function sendHtml(res: ServerResponse, statusCode: number, body: string): void {
  const buf = Buffer.from(body);
  res.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8", "Content-Length": buf.length });
  res.end(buf);
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function authorizeIngest(req: IncomingMessage): Promise<boolean> {
  const settings = await loadSettings();
  const headerToken = req.headers["x-ingest-token"];
  const token = typeof headerToken === "string" ? headerToken.trim() : "";
  return Boolean(token && token === settings.ingest_token);
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/icon.svg" && existsSync(ICON_PATH)) {
    const icon = readFileSync(ICON_PATH);
    res.writeHead(200, { "Content-Type": "image/svg+xml", "Content-Length": icon.length });
    res.end(icon);
    return;
  }

  if (req.method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      version: APP_VERSION,
      extension_version: EXTENSION_VERSION,
      dev: IS_LOCAL_DEV,
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/settings") {
    sendJson(res, 200, { settings: await loadSettings(), data_root: DATA_ROOT });
    return;
  }

  if (req.method === "POST" && pathname === "/api/settings/note") {
    try {
      const body = JSON.parse(await readBody(req)) as { note?: string };
      sendJson(res, 200, { settings: await updateNote(String(body.note ?? "")) });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/settings/rotate-token") {
    sendJson(res, 200, { settings: await rotateIngestToken() });
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

  if (req.method === "GET" && pathname === "/api/backup/status") {
    sendJson(res, 200, await getBackupStatus(DATA_ROOT, BACKUP_ROOT, BACKUP_HOST_PATH));
    return;
  }

  if (req.method === "POST" && pathname === "/api/backup/export") {
    try {
      sendJson(res, 200, await exportAppData(DATA_ROOT, BACKUP_ROOT, BACKUP_HOST_PATH));
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/backup/import") {
    try {
      const status = await importAppData(DATA_ROOT, BACKUP_ROOT, BACKUP_HOST_PATH);
      resetStoreCaches();
      sendJson(res, 200, status);
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/backup/clear") {
    try {
      sendJson(res, 200, await clearAppBackup(DATA_ROOT, BACKUP_ROOT, BACKUP_HOST_PATH));
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/data/clear") {
    try {
      sendJson(res, 200, await clearAppData());
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  const page = resolvePage(pathname);
  if (req.method === "GET" && page) {
    sendHtml(res, 200, renderPage(page));
    return;
  }

  sendHtml(
    res,
    404,
    `<!DOCTYPE html><html><body style="font-family:system-ui;padding:2rem"><h1>Not found</h1><p><a href="/">Home</a></p></body></html>`,
  );
}).listen(PORT, () => {
  console.log(`__APP_NAME__ v${APP_VERSION} on ${PORT}${IS_LOCAL_DEV ? " (dev)" : ""}`);
});