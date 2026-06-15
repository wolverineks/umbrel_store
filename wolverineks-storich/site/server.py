#!/usr/bin/env python3
import cgi
import html
import json
import mimetypes
import os
import shutil
import urllib.parse
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn


DATA_ROOT = os.environ.get("STORICH_DATA_DIR", "/data")


def ensure_data_root():
    os.makedirs(DATA_ROOT, exist_ok=True)


def safe_path(relative_path=""):
    relative_path = relative_path.strip().replace("\\", "/").lstrip("/")
    root = os.path.realpath(DATA_ROOT)
    target = os.path.realpath(os.path.join(root, relative_path))
    if target != root and not target.startswith(root + os.sep):
        raise ValueError("invalid path")
    return target, relative_path


def file_entry(abs_path, relative_path):
    stat = os.stat(abs_path)
    is_dir = os.path.isdir(abs_path)
    return {
        "name": os.path.basename(abs_path),
        "path": relative_path.replace("\\", "/"),
        "type": "folder" if is_dir else "file",
        "size": stat.st_size if not is_dir else None,
        "modified": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
    }


def list_directory(relative_path=""):
    abs_path, rel = safe_path(relative_path)
    if not os.path.isdir(abs_path):
        raise FileNotFoundError("folder not found")

    entries = []
    for name in sorted(os.listdir(abs_path), key=str.lower):
        if name.startswith("."):
            continue
        child_rel = f"{rel}/{name}" if rel else name
        entries.append(file_entry(os.path.join(abs_path, name), child_rel))
    entries.sort(key=lambda item: (item["type"] != "folder", item["name"].lower()))
    return {"path": rel, "entries": entries}


def human_size(size):
    if size is None:
        return "—"
    units = ["B", "KB", "MB", "GB", "TB"]
    value = float(size)
    for unit in units:
        if value < 1024 or unit == units[-1]:
            if unit == "B":
                return f"{int(value)} {unit}"
            return f"{value:.1f} {unit}"
        value /= 1024
    return f"{size} B"


PAGE_STYLES = """
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
"""


PAGE_SCRIPT = """
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
      return `${i === 0 ? value : value.toFixed(1)} ${units[i]}`;
    }
    value /= 1024;
  }
  return `${size} B`;
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
  let html = `<button type="button" data-path="">My Drive</button>`;
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    html += ` <span>/</span> <button type="button" data-path="${escapeHtml(current)}">${escapeHtml(part)}</button>`;
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
    `${entries.length} item(s) in ${data.path ? data.path : "My Drive"}`;

  if (!entries.length) {
    container.innerHTML = `<div class="empty">This folder is empty. Upload a file or create a folder to get started.</div>`;
    return;
  }

  container.innerHTML = entries.map((entry) => {
    const icon = entry.type === "folder" ? "📁" : "📄";
    const meta = entry.type === "folder"
      ? `Folder · ${formatDate(entry.modified)}`
      : `${formatSize(entry.size)} · ${formatDate(entry.modified)}`;
    return `
      <article class="card" data-path="${escapeHtml(entry.path)}" data-type="${entry.type}">
        <div class="icon">${icon}</div>
        <div class="name">${escapeHtml(entry.name)}</div>
        <div class="meta">${meta}</div>
      </article>`;
  }).join("");

  container.querySelectorAll(".card").forEach((card) => {
    card.addEventListener("click", () => {
      if (card.dataset.type === "folder") {
        setPath(card.dataset.path);
      } else {
        window.location.href = `/api/download?path=${encodeURIComponent(card.dataset.path)}`;
      }
    });
  });
}

async function loadFiles() {
  const errorBox = document.getElementById("error");
  errorBox.textContent = "";
  errorBox.hidden = true;
  try {
    const response = await fetch(`/api/files?path=${encodeURIComponent(state.path)}`);
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
      errorBox.textContent = data.error || `Could not upload ${file.name}`;
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
"""


def render_page():
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Storich</title>
  <style>{PAGE_STYLES}</style>
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
  <script>{PAGE_SCRIPT}</script>
</body>
</html>"""


def send_json(handler, status_code, payload):
    body = json.dumps(payload).encode()
    handler.send_response(status_code)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    try:
        handler.wfile.write(body)
    except (BrokenPipeError, ConnectionResetError):
        return


def send_bytes(handler, status_code, content_type, body, download_name=None):
    handler.send_response(status_code)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Content-Length", str(len(body)))
    if download_name:
        handler.send_header(
            "Content-Disposition",
            f'attachment; filename="{download_name}"',
        )
    handler.end_headers()
    try:
        handler.wfile.write(body)
    except (BrokenPipeError, ConnectionResetError):
        return


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        ensure_data_root()
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        if path in ("/health", "/healthz"):
            send_bytes(self, 200, "text/plain; charset=utf-8", b"ok")
            return

        if path == "/api/files":
            try:
                rel = query.get("path", [""])[0]
                payload = list_directory(rel)
                send_json(self, 200, payload)
            except FileNotFoundError:
                send_json(self, 404, {"error": "folder not found"})
            except ValueError as exc:
                send_json(self, 400, {"error": str(exc)})
            except OSError as exc:
                send_json(self, 500, {"error": str(exc)})
            return

        if path == "/api/download":
            try:
                rel = query.get("path", [""])[0]
                abs_path, _ = safe_path(rel)
                if not os.path.isfile(abs_path):
                    send_json(self, 404, {"error": "file not found"})
                    return
                with open(abs_path, "rb") as handle:
                    data = handle.read()
                content_type = mimetypes.guess_type(abs_path)[0] or "application/octet-stream"
                send_bytes(self, 200, content_type, data, download_name=os.path.basename(abs_path))
            except ValueError as exc:
                send_json(self, 400, {"error": str(exc)})
            except OSError as exc:
                send_json(self, 500, {"error": str(exc)})
            return

        if path == "/":
            page = render_page().encode()
            send_bytes(self, 200, "text/html; charset=utf-8", page)
            return

        send_json(self, 404, {"error": "not found"})

    def do_POST(self):
        ensure_data_root()
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/api/mkdir":
            try:
                length = int(self.headers.get("Content-Length", "0"))
                payload = json.loads(self.rfile.read(length) or b"{}")
                parent = payload.get("path", "")
                name = payload.get("name", "").strip()
                if not name or "/" in name or name in (".", ".."):
                    send_json(self, 400, {"error": "invalid folder name"})
                    return
                parent_abs, parent_rel = safe_path(parent)
                target_abs = os.path.join(parent_abs, name)
                target_rel = f"{parent_rel}/{name}" if parent_rel else name
                os.makedirs(target_abs, exist_ok=False)
                send_json(self, 201, {"entry": file_entry(target_abs, target_rel)})
            except FileExistsError:
                send_json(self, 409, {"error": "folder already exists"})
            except ValueError as exc:
                send_json(self, 400, {"error": str(exc)})
            except OSError as exc:
                send_json(self, 500, {"error": str(exc)})
            return

        if path == "/api/upload":
            try:
                form = cgi.FieldStorage(
                    fp=self.rfile,
                    headers=self.headers,
                    environ={
                        "REQUEST_METHOD": "POST",
                        "CONTENT_TYPE": self.headers.get("Content-Type", ""),
                    },
                )
                parent = form.getfirst("path", "")
                upload = form["file"] if "file" in form else None
                if upload is None or not getattr(upload, "filename", None):
                    send_json(self, 400, {"error": "file is required"})
                    return
                filename = os.path.basename(upload.filename)
                if not filename or filename in (".", ".."):
                    send_json(self, 400, {"error": "invalid file name"})
                    return
                parent_abs, parent_rel = safe_path(parent)
                target_abs = os.path.join(parent_abs, filename)
                target_rel = f"{parent_rel}/{filename}" if parent_rel else filename
                with open(target_abs, "wb") as handle:
                    shutil.copyfileobj(upload.file, handle)
                send_json(self, 201, {"entry": file_entry(target_abs, target_rel)})
            except ValueError as exc:
                send_json(self, 400, {"error": str(exc)})
            except OSError as exc:
                send_json(self, 500, {"error": str(exc)})
            return

        send_json(self, 404, {"error": "not found"})

    def log_message(self, format, *args):
        return


class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


if __name__ == "__main__":
    ensure_data_root()
    port = int(os.environ.get("PORT", "3000"))
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()