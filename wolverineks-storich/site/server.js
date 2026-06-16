"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_http_1 = require("node:http");
const promises_1 = require("node:fs/promises");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const DATA_ROOT = process.env.STORICH_DATA_DIR ?? "/data";
async function ensureDataRoot() {
    if ((0, node_fs_1.existsSync)(DATA_ROOT)) {
        return;
    }
    try {
        await (0, promises_1.mkdir)(DATA_ROOT, { recursive: true });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`cannot access data directory ${DATA_ROOT}: ${message}`);
    }
}
function safePath(relativePath = "") {
    const normalized = relativePath.trim().replace(/\\/g, "/").replace(/^\//, "");
    const root = node_path_1.default.resolve(DATA_ROOT);
    const absPath = node_path_1.default.resolve(root, normalized);
    if (absPath !== root && !absPath.startsWith(root + node_path_1.default.sep)) {
        throw new Error("invalid path");
    }
    return { absPath, relPath: normalized };
}
async function fileEntry(absPath, relPath) {
    const fileStat = await (0, promises_1.stat)(absPath);
    const isDir = fileStat.isDirectory();
    return {
        name: node_path_1.default.basename(absPath),
        path: relPath.replace(/\\/g, "/"),
        type: isDir ? "folder" : "file",
        size: isDir ? null : fileStat.size,
        modified: new Date(fileStat.mtimeMs).toISOString(),
    };
}
async function listDirectory(relativePath = "") {
    const { absPath, relPath } = safePath(relativePath);
    const fileStat = await (0, promises_1.stat)(absPath);
    if (!fileStat.isDirectory()) {
        throw new FileNotFoundError("folder not found");
    }
    const names = await (0, promises_1.readdir)(absPath);
    const entries = [];
    for (const name of names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))) {
        if (name.startsWith(".")) {
            continue;
        }
        const childRel = relPath ? `${relPath}/${name}` : name;
        entries.push(await fileEntry(node_path_1.default.join(absPath, name), childRel));
    }
    entries.sort((a, b) => {
        const aIsFolder = a.type === "folder" ? 0 : 1;
        const bIsFolder = b.type === "folder" ? 0 : 1;
        if (aIsFolder !== bIsFolder) {
            return aIsFolder - bIsFolder;
        }
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
    return { path: relPath, entries };
}
class FileNotFoundError extends Error {
    constructor(message) {
        super(message);
        this.name = "FileNotFoundError";
    }
}
const PAGE_STYLES = `
:root {
  color-scheme: light;
  --bg: #f8fafc;
  --panel: #ffffff;
  --border: #e2e8f0;
  --text: #0f172a;
  --muted: #64748b;
  --accent: #2563eb;
  --accent-soft: #dbeafe;
  --sidebar: #f1f5f9;
}
* { box-sizing: border-box; }
html, body {
  margin: 0;
  height: 100%;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: var(--bg);
  color: var(--text);
}
body {
  display: grid;
  grid-template-columns: 240px 1fr;
  min-height: 100vh;
}
aside {
  background: var(--sidebar);
  border-right: 1px solid var(--border);
  padding: 1.25rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.brand {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  font-weight: 700;
  font-size: 1.1rem;
  padding: 0.25rem 0.5rem;
}
.brand-badge {
  width: 2rem;
  height: 2rem;
  border-radius: 0.65rem;
  display: grid;
  place-items: center;
  background: linear-gradient(135deg, #2563eb, #7c3aed);
  color: white;
  font-size: 0.95rem;
}
.nav {
  display: grid;
  gap: 0.35rem;
}
.nav button {
  text-align: left;
  border: 0;
  background: transparent;
  padding: 0.7rem 0.75rem;
  border-radius: 0.65rem;
  font: inherit;
  color: var(--text);
  cursor: pointer;
}
.nav button.active,
.nav button:hover {
  background: var(--accent-soft);
  color: var(--accent);
}
main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 100vh;
}
.topbar {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  padding: 1rem 1.25rem;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
}
.search {
  flex: 1;
  max-width: 36rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0.65rem 1rem;
  color: var(--muted);
}
.search input {
  border: 0;
  background: transparent;
  width: 100%;
  font: inherit;
  color: var(--text);
}
.search input:focus { outline: none; }
.toolbar {
  display: flex;
  gap: 0.5rem;
}
button.primary,
label.upload-btn {
  border: 0;
  border-radius: 999px;
  background: var(--accent);
  color: white;
  padding: 0.65rem 1rem;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
button.secondary {
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--panel);
  color: var(--text);
  padding: 0.65rem 1rem;
  font: inherit;
  cursor: pointer;
}
label.upload-btn input { display: none; }
.content {
  padding: 1.25rem;
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.breadcrumbs {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  align-items: center;
  margin-bottom: 1rem;
  color: var(--muted);
  font-size: 0.95rem;
}
.breadcrumbs button {
  border: 0;
  background: transparent;
  color: var(--accent);
  cursor: pointer;
  font: inherit;
  padding: 0;
}
.status {
  margin-bottom: 1rem;
  color: var(--muted);
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 0.85rem;
}
.card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 0.9rem;
  padding: 1rem;
  min-height: 8.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
  cursor: pointer;
  transition: box-shadow 0.15s ease, transform 0.15s ease;
}
.card:hover {
  box-shadow: 0 10px 24px rgba(15, 23, 42, 0.08);
  transform: translateY(-1px);
}
.card .icon {
  font-size: 1.8rem;
}
.card .name {
  font-weight: 600;
  word-break: break-word;
}
.card .meta {
  color: var(--muted);
  font-size: 0.85rem;
  margin-top: auto;
}
.empty {
  padding: 2rem;
  border: 1px dashed var(--border);
  border-radius: 1rem;
  background: var(--panel);
  color: var(--muted);
  text-align: center;
}
.error {
  color: #b91c1c;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 0.75rem;
  padding: 0.85rem 1rem;
  margin-bottom: 1rem;
}
@media (max-width: 800px) {
  body { grid-template-columns: 1fr; }
  aside { display: none; }
}
`;
const PAGE_SCRIPT = `
const state = { path: "", query: "" };

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatSize(size) {
  if (size === null || size === undefined) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number(size);
  for (let i = 0; i < units.length; i += 1) {
    if (value < 1024 || i === units.length - 1) {
      return \`\${i === 0 ? value : value.toFixed(1)} \${units[i]}\`;
    }
    value /= 1024;
  }
  return \`\${size} B\`;
}

function formatDate(value) {
  return new Date(value).toLocaleString();
}

function setPath(path) {
  state.path = path || "";
  state.query = "";
  document.getElementById("search").value = "";
  loadFiles();
}

function renderBreadcrumbs(path) {
  const root = document.getElementById("breadcrumbs");
  const parts = path ? path.split("/") : [];
  let html = \`<button type="button" data-path="">My Drive</button>\`;
  let current = "";
  for (const part of parts) {
    current = current ? \`\${current}/\${part}\` : part;
    html += \` <span>/</span> <button type="button" data-path="\${escapeHtml(current)}">\${escapeHtml(part)}</button>\`;
  }
  root.innerHTML = html;
  root.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => setPath(button.dataset.path || ""));
  });
}

function filteredEntries(entries) {
  const query = state.query.trim().toLowerCase();
  if (!query) return entries;
  return entries.filter((entry) => entry.name.toLowerCase().includes(query));
}

function renderEntries(data) {
  const container = document.getElementById("files");
  const entries = filteredEntries(data.entries || []);
  document.getElementById("status").textContent =
    \`\${entries.length} item(s) in \${data.path ? data.path : "My Drive"}\`;

  if (!entries.length) {
    container.innerHTML = \`<div class="empty">This folder is empty. Upload a file or create a folder to get started.</div>\`;
    return;
  }

  container.innerHTML = entries.map((entry) => {
    const icon = entry.type === "folder" ? "📁" : "📄";
    const meta = entry.type === "folder"
      ? \`Folder · \${formatDate(entry.modified)}\`
      : \`\${formatSize(entry.size)} · \${formatDate(entry.modified)}\`;
    return \`
      <article class="card" data-path="\${escapeHtml(entry.path)}" data-type="\${entry.type}">
        <div class="icon">\${icon}</div>
        <div class="name">\${escapeHtml(entry.name)}</div>
        <div class="meta">\${meta}</div>
      </article>\`;
  }).join("");

  container.querySelectorAll(".card").forEach((card) => {
    card.addEventListener("click", () => {
      if (card.dataset.type === "folder") {
        setPath(card.dataset.path);
      } else {
        window.location.href = \`/api/download?path=\${encodeURIComponent(card.dataset.path)}\`;
      }
    });
  });
}

async function loadFiles() {
  const errorBox = document.getElementById("error");
  errorBox.textContent = "";
  errorBox.hidden = true;
  try {
    const response = await fetch(\`/api/files?path=\${encodeURIComponent(state.path)}\`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load files");
    renderBreadcrumbs(data.path || "");
    renderEntries(data);
  } catch (error) {
    errorBox.textContent = String(error);
    errorBox.hidden = false;
    document.getElementById("files").innerHTML = "";
  }
}

async function createFolder() {
  const name = window.prompt("Folder name");
  if (!name) return;
  const response = await fetch("/api/mkdir", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: state.path, name }),
  });
  const data = await response.json();
  if (!response.ok) {
    const errorBox = document.getElementById("error");
    errorBox.textContent = data.error || "Could not create folder";
    errorBox.hidden = false;
    return;
  }
  loadFiles();
}

async function uploadFiles(fileList) {
  for (const file of fileList) {
    const form = new FormData();
    form.append("path", state.path);
    form.append("file", file);
    const response = await fetch("/api/upload", { method: "POST", body: form });
    const data = await response.json();
    if (!response.ok) {
      const errorBox = document.getElementById("error");
      errorBox.textContent = data.error || \`Could not upload \${file.name}\`;
      errorBox.hidden = false;
      return;
    }
  }
  loadFiles();
}

document.getElementById("search").addEventListener("input", (event) => {
  state.query = event.target.value;
  loadFiles();
});
document.getElementById("new-folder").addEventListener("click", createFolder);
document.getElementById("upload-input").addEventListener("change", (event) => {
  uploadFiles(event.target.files);
  event.target.value = "";
});
document.getElementById("nav-drive").addEventListener("click", () => setPath(""));

loadFiles();
`;
function renderPage() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Storich</title>
  <style>${PAGE_STYLES}</style>
</head>
<body>
  <aside>
    <div class="brand">
      <div class="brand-badge">S</div>
      <span>Storich</span>
    </div>
    <nav class="nav">
      <button id="nav-drive" class="active" type="button">My Drive</button>
      <button type="button" disabled>Recent</button>
      <button type="button" disabled>Trash</button>
    </nav>
  </aside>
  <main>
    <div class="topbar">
      <label class="search">
        <span>⌕</span>
        <input id="search" type="search" placeholder="Search in My Drive">
      </label>
      <div class="toolbar">
        <button id="new-folder" class="secondary" type="button">New folder</button>
        <label class="upload-btn">
          Upload
          <input id="upload-input" type="file" multiple>
        </label>
      </div>
    </div>
    <div class="content">
      <div id="error" class="error" hidden></div>
      <div id="breadcrumbs" class="breadcrumbs"></div>
      <div id="status" class="status"></div>
      <div id="files" class="grid"></div>
    </div>
  </main>
  <script>${PAGE_SCRIPT}</script>
</body>
</html>`;
}
function escapeHtml(value) {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}
function renderErrorPage(message) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Storich</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font-family: system-ui, sans-serif;
      background: #f8fafc;
      color: #0f172a;
      padding: 1.5rem;
    }
    main {
      max-width: 36rem;
      background: white;
      border: 1px solid #e2e8f0;
      border-radius: 1rem;
      padding: 1.5rem;
    }
    h1 { margin-top: 0; }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      background: #fef2f2;
      color: #b91c1c;
      padding: 1rem;
      border-radius: 0.75rem;
    }
  </style>
</head>
<body>
  <main>
    <h1>Storich could not start</h1>
    <pre>${escapeHtml(message)}</pre>
  </main>
</body>
</html>`;
}
function sendJson(res, statusCode, payload) {
    const body = Buffer.from(JSON.stringify(payload));
    res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": body.length,
    });
    res.end(body);
}
function sendBytes(res, statusCode, contentType, body, downloadName) {
    const headers = {
        "Content-Type": contentType,
        "Content-Length": body.length,
    };
    if (downloadName) {
        headers["Content-Disposition"] = `attachment; filename="${downloadName}"`;
    }
    res.writeHead(statusCode, headers);
    res.end(body);
}
const MIME_TYPES = {
    ".txt": "text/plain",
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
    ".mp4": "video/mp4",
    ".mp3": "audio/mpeg",
};
function guessMimeType(filePath) {
    const ext = node_path_1.default.extname(filePath).toLowerCase();
    return MIME_TYPES[ext] ?? "application/octet-stream";
}
function splitBuffer(buffer, delimiter) {
    const parts = [];
    let start = 0;
    let index = buffer.indexOf(delimiter, start);
    while (index !== -1) {
        if (index > start) {
            parts.push(buffer.subarray(start, index));
        }
        start = index + delimiter.length;
        index = buffer.indexOf(delimiter, start);
    }
    if (start < buffer.length) {
        parts.push(buffer.subarray(start));
    }
    return parts;
}
function parseMultipartUpload(contentType, body) {
    if (!contentType.startsWith("multipart/form-data")) {
        throw new Error("expected multipart form data");
    }
    const match = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/);
    if (!match) {
        throw new Error("missing multipart boundary");
    }
    const boundary = Buffer.from(`--${match[1] ?? match[2]}`);
    let pathValue = "";
    let fileName = null;
    let fileData = Buffer.alloc(0);
    for (const part of splitBuffer(body, boundary)) {
        if (!part.includes(Buffer.from("Content-Disposition"))) {
            continue;
        }
        const separator = part.indexOf(Buffer.from("\r\n\r\n"));
        if (separator === -1) {
            continue;
        }
        const headerBlock = part.subarray(0, separator).toString("utf8");
        let content = part.subarray(separator + 4);
        if (content.length >= 2 && content.subarray(-2).equals(Buffer.from("\r\n"))) {
            content = content.subarray(0, -2);
        }
        if (headerBlock.includes('name="path"')) {
            pathValue = content.toString("utf8");
        }
        else if (headerBlock.includes('name="file"')) {
            const filenameMatch = headerBlock.match(/filename="([^"]*)"/);
            if (filenameMatch) {
                fileName = filenameMatch[1];
            }
            fileData = Buffer.from(content);
        }
    }
    if (!fileName) {
        throw new Error("file is required");
    }
    return { pathValue, fileName, fileData };
}
async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}
function queryParam(url, name) {
    return url.searchParams.get(name) ?? "";
}
async function handleGet(req, res, url) {
    const route = url.pathname;
    if (route === "/health" || route === "/healthz") {
        sendBytes(res, 200, "text/plain; charset=utf-8", Buffer.from("ok"));
        return;
    }
    await ensureDataRoot();
    if (route === "/api/files") {
        try {
            const payload = await listDirectory(queryParam(url, "path"));
            sendJson(res, 200, payload);
        }
        catch (error) {
            if (error instanceof FileNotFoundError) {
                sendJson(res, 404, { error: "folder not found" });
            }
            else if (error instanceof Error && error.message === "invalid path") {
                sendJson(res, 400, { error: error.message });
            }
            else {
                const message = error instanceof Error ? error.message : String(error);
                sendJson(res, 500, { error: message });
            }
        }
        return;
    }
    if (route === "/api/download") {
        try {
            const { absPath } = safePath(queryParam(url, "path"));
            const fileStat = await (0, promises_1.stat)(absPath);
            if (!fileStat.isFile()) {
                sendJson(res, 404, { error: "file not found" });
                return;
            }
            const data = await (0, promises_1.readFile)(absPath);
            sendBytes(res, 200, guessMimeType(absPath), data, node_path_1.default.basename(absPath));
        }
        catch (error) {
            if (error instanceof Error && error.message === "invalid path") {
                sendJson(res, 400, { error: error.message });
            }
            else {
                const message = error instanceof Error ? error.message : String(error);
                sendJson(res, 500, { error: message });
            }
        }
        return;
    }
    if (route === "/") {
        sendBytes(res, 200, "text/html; charset=utf-8", Buffer.from(renderPage()));
        return;
    }
    sendJson(res, 404, { error: "not found" });
}
async function handlePost(req, res, url) {
    const route = url.pathname;
    await ensureDataRoot();
    if (route === "/api/mkdir") {
        try {
            const body = await readBody(req);
            const payload = JSON.parse(body.toString("utf8") || "{}");
            const parent = payload.path ?? "";
            const name = (payload.name ?? "").trim();
            if (!name || name.includes("/") || name === "." || name === "..") {
                sendJson(res, 400, { error: "invalid folder name" });
                return;
            }
            const { absPath: parentAbs, relPath: parentRel } = safePath(parent);
            const targetAbs = node_path_1.default.join(parentAbs, name);
            const targetRel = parentRel ? `${parentRel}/${name}` : name;
            await (0, promises_1.mkdir)(targetAbs, { recursive: false });
            sendJson(res, 201, { entry: await fileEntry(targetAbs, targetRel) });
        }
        catch (error) {
            if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
                sendJson(res, 409, { error: "folder already exists" });
            }
            else if (error instanceof Error && error.message === "invalid path") {
                sendJson(res, 400, { error: error.message });
            }
            else {
                const message = error instanceof Error ? error.message : String(error);
                sendJson(res, 500, { error: message });
            }
        }
        return;
    }
    if (route === "/api/upload") {
        try {
            const contentType = req.headers["content-type"] ?? "";
            const body = await readBody(req);
            const { pathValue, fileName, fileData } = parseMultipartUpload(contentType, body);
            const filename = node_path_1.default.basename(fileName);
            if (!filename || filename === "." || filename === "..") {
                sendJson(res, 400, { error: "invalid file name" });
                return;
            }
            const { absPath: parentAbs, relPath: parentRel } = safePath(pathValue);
            const targetAbs = node_path_1.default.join(parentAbs, filename);
            const targetRel = parentRel ? `${parentRel}/${filename}` : filename;
            await (0, promises_1.writeFile)(targetAbs, fileData);
            sendJson(res, 201, { entry: await fileEntry(targetAbs, targetRel) });
        }
        catch (error) {
            if (error instanceof Error && (error.message === "invalid path" || error.message.includes("multipart"))) {
                sendJson(res, 400, { error: error.message });
            }
            else {
                const message = error instanceof Error ? error.message : String(error);
                sendJson(res, 500, { error: message });
            }
        }
        return;
    }
    sendJson(res, 404, { error: "not found" });
}
const server = (0, node_http_1.createServer)(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
        if (req.method === "GET") {
            await handleGet(req, res, url);
            return;
        }
        if (req.method === "POST") {
            await handlePost(req, res, url);
            return;
        }
        sendJson(res, 405, { error: "method not allowed" });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (req.method === "GET" && url.pathname === "/") {
            sendBytes(res, 503, "text/html; charset=utf-8", Buffer.from(renderErrorPage(message)));
        }
        else {
            sendJson(res, 500, { error: message });
        }
    }
});
const port = Number(process.env.PORT ?? "3000");
ensureDataRoot().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`storich: data directory unavailable: ${message}`);
});
console.log(`storich: listening on 0.0.0.0:${port}`);
server.listen(port, "0.0.0.0");
