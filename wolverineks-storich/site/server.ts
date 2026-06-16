import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const DATA_ROOT = process.env.STORICH_DATA_DIR ?? "/data";
const TRASH_DIR = path.join(DATA_ROOT, ".trash");
const TRASH_ITEMS_DIR = path.join(TRASH_DIR, "items");
const TRASH_INDEX_PATH = path.join(TRASH_DIR, "index.json");

type FileEntry = {
  name: string;
  path: string;
  type: "folder" | "file";
  size: number | null;
  modified: string;
};

type TrashItem = {
  id: string;
  name: string;
  originalPath: string;
  type: "folder" | "file";
  deletedAt: string;
  storageName: string;
};

type DirectoryListing = {
  path: string;
  entries: FileEntry[];
};

type TrashListing = {
  entries: Array<
    FileEntry & {
      id: string;
      originalPath: string;
      deletedAt: string;
    }
  >;
};

async function ensureDataRoot(): Promise<void> {
  if (existsSync(DATA_ROOT)) {
    return;
  }
  try {
    await mkdir(DATA_ROOT, { recursive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot access data directory ${DATA_ROOT}: ${message}`);
  }
}

function safePath(relativePath = ""): { absPath: string; relPath: string } {
  const normalized = relativePath.trim().replace(/\\/g, "/").replace(/^\//, "");
  const root = path.resolve(DATA_ROOT);
  const absPath = path.resolve(root, normalized);
  if (absPath !== root && !absPath.startsWith(root + path.sep)) {
    throw new Error("invalid path");
  }
  return { absPath, relPath: normalized };
}

async function fileEntry(absPath: string, relPath: string): Promise<FileEntry> {
  const fileStat = await stat(absPath);
  const isDir = fileStat.isDirectory();
  return {
    name: path.basename(absPath),
    path: relPath.replace(/\\/g, "/"),
    type: isDir ? "folder" : "file",
    size: isDir ? null : fileStat.size,
    modified: new Date(fileStat.mtimeMs).toISOString(),
  };
}

async function listDirectory(relativePath = ""): Promise<DirectoryListing> {
  const { absPath, relPath } = safePath(relativePath);
  const fileStat = await stat(absPath);
  if (!fileStat.isDirectory()) {
    throw new FileNotFoundError("folder not found");
  }

  const names = await readdir(absPath);
  const entries: FileEntry[] = [];
  for (const name of names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))) {
    if (name.startsWith(".")) {
      continue;
    }
    const childRel = relPath ? `${relPath}/${name}` : name;
    entries.push(await fileEntry(path.join(absPath, name), childRel));
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

async function ensureTrashDir(): Promise<void> {
  await mkdir(TRASH_ITEMS_DIR, { recursive: true });
}

async function readTrashIndex(): Promise<TrashItem[]> {
  await ensureTrashDir();
  if (!existsSync(TRASH_INDEX_PATH)) {
    return [];
  }
  try {
    const raw = await readFile(TRASH_INDEX_PATH, "utf8");
    const parsed = JSON.parse(raw) as { items?: TrashItem[] };
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

async function writeTrashIndex(items: TrashItem[]): Promise<void> {
  await ensureTrashDir();
  await writeFile(TRASH_INDEX_PATH, JSON.stringify({ items }, null, 2));
}

function trashStorageName(id: string, name: string): string {
  const safeName = name.replace(/[^\w.\-()+@ ]+/g, "_") || "item";
  return `${id}__${safeName}`;
}

function createTrashId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

async function uniqueRestorePath(relPath: string): Promise<string> {
  const { absPath } = safePath(relPath);
  if (!existsSync(absPath)) {
    return relPath;
  }

  const dir = path.posix.dirname(relPath.replace(/\\/g, "/"));
  const base = path.posix.basename(relPath);
  const ext = path.posix.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;

  for (let index = 1; index < 1000; index += 1) {
    const candidateName = `${stem} (restored ${index})${ext}`;
    const candidate = dir && dir !== "." ? `${dir}/${candidateName}` : candidateName;
    const { absPath: candidateAbs } = safePath(candidate);
    if (!existsSync(candidateAbs)) {
      return candidate;
    }
  }

  throw new Error("could not find a free name to restore item");
}

function isProtectedPath(relPath: string): boolean {
  const normalized = relPath.trim().replace(/\\/g, "/").replace(/^\//, "");
  if (!normalized) {
    return true;
  }
  return normalized === ".trash" || normalized.startsWith(".trash/");
}

async function moveToTrash(relPath: string): Promise<TrashItem> {
  if (isProtectedPath(relPath)) {
    throw new Error("invalid path");
  }
  const { absPath, relPath: normalized } = safePath(relPath);
  const fileStat = await stat(absPath);
  const isDir = fileStat.isDirectory();
  const name = path.basename(absPath);
  const id = createTrashId();
  const storageName = trashStorageName(id, name);
  const trashAbs = path.join(TRASH_ITEMS_DIR, storageName);

  await ensureTrashDir();
  await rename(absPath, trashAbs);

  const item: TrashItem = {
    id,
    name,
    originalPath: normalized.replace(/\\/g, "/"),
    type: isDir ? "folder" : "file",
    deletedAt: new Date().toISOString(),
    storageName,
  };

  const items = await readTrashIndex();
  items.unshift(item);
  await writeTrashIndex(items);
  return item;
}

async function listTrash(): Promise<TrashListing> {
  const items = await readTrashIndex();
  const entries: TrashListing["entries"] = [];

  for (const item of items) {
    const absPath = path.join(TRASH_ITEMS_DIR, item.storageName);
    if (!existsSync(absPath)) {
      continue;
    }
    const entry = await fileEntry(absPath, item.id);
    entries.push({
      ...entry,
      name: item.name,
      id: item.id,
      originalPath: item.originalPath,
      deletedAt: item.deletedAt,
    });
  }

  return { entries };
}

async function restoreFromTrash(id: string): Promise<FileEntry> {
  const items = await readTrashIndex();
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) {
    throw new FileNotFoundError("trash item not found");
  }

  const item = items[index];
  const trashAbs = path.join(TRASH_ITEMS_DIR, item.storageName);
  if (!existsSync(trashAbs)) {
    throw new FileNotFoundError("trash item not found");
  }

  const restorePath = await uniqueRestorePath(item.originalPath);
  const { absPath: restoreAbs } = safePath(restorePath);
  await mkdir(path.dirname(restoreAbs), { recursive: true });
  await rename(trashAbs, restoreAbs);

  items.splice(index, 1);
  await writeTrashIndex(items);
  return fileEntry(restoreAbs, restorePath);
}

async function deleteTrashItem(id: string): Promise<void> {
  const items = await readTrashIndex();
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) {
    throw new FileNotFoundError("trash item not found");
  }

  const item = items[index];
  const trashAbs = path.join(TRASH_ITEMS_DIR, item.storageName);
  if (existsSync(trashAbs)) {
    const fileStat = await stat(trashAbs);
    if (fileStat.isDirectory()) {
      await rm(trashAbs, { recursive: true, force: true });
    } else {
      await rm(trashAbs, { force: true });
    }
  }

  items.splice(index, 1);
  await writeTrashIndex(items);
}

async function emptyTrash(): Promise<number> {
  const items = await readTrashIndex();
  for (const item of items) {
    const trashAbs = path.join(TRASH_ITEMS_DIR, item.storageName);
    if (existsSync(trashAbs)) {
      await rm(trashAbs, { recursive: true, force: true });
    }
  }
  await writeTrashIndex([]);
  return items.length;
}

class FileNotFoundError extends Error {
  constructor(message: string) {
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
  border-radius: 0.35rem;
}
.breadcrumbs button.crumb.selected {
  background: var(--accent-soft);
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
.context-menu {
  position: fixed;
  z-index: 1000;
  min-width: 11rem;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  box-shadow: 0 16px 40px rgba(15, 23, 42, 0.14);
  padding: 0.35rem;
  display: none;
}
.context-menu.open {
  display: grid;
}
.context-menu button {
  border: 0;
  background: transparent;
  text-align: left;
  padding: 0.65rem 0.75rem;
  border-radius: 0.5rem;
  font: inherit;
  color: var(--text);
  cursor: pointer;
}
.context-menu button:hover,
.context-menu button:focus {
  background: var(--accent-soft);
  color: var(--accent);
  outline: none;
}
.context-menu button.danger {
  color: #b91c1c;
}
.context-menu button.danger:hover,
.context-menu button.danger:focus {
  background: #fef2f2;
  color: #991b1b;
}
.context-menu .menu-label {
  padding: 0.45rem 0.75rem 0.2rem;
  font-size: 0.75rem;
  color: var(--muted);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.card.selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}
.toolbar-trash {
  display: none;
}
body.view-trash .toolbar-drive {
  display: none;
}
body.view-trash .toolbar-trash {
  display: flex;
}
@media (max-width: 800px) {
  body { grid-template-columns: 1fr; }
  aside { display: none; }
}
`;

const PAGE_SCRIPT = `
const state = { path: "", query: "", view: "drive" };
const menuState = { entry: null, longPress: false };
let longPressTimer = null;

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

function setActiveNav() {
  document.getElementById("nav-drive").classList.toggle("active", state.view === "drive");
  document.getElementById("nav-trash").classList.toggle("active", state.view === "trash");
  document.body.classList.toggle("view-trash", state.view === "trash");
  document.getElementById("search").placeholder =
    state.view === "trash" ? "Search in Trash" : "Search in My Drive";
}

function setView(view) {
  state.view = view;
  state.path = "";
  state.query = "";
  document.getElementById("search").value = "";
  closeContextMenu();
  setActiveNav();
  refreshListing();
}

function setPath(path) {
  if (state.view !== "drive") return;
  state.path = path || "";
  state.query = "";
  document.getElementById("search").value = "";
  closeContextMenu();
  refreshListing();
}

function breadcrumbEntry(button) {
  return {
    id: "",
    path: button.dataset.path || "",
    name: button.dataset.name || "",
    type: "folder",
    originalPath: "",
  };
}

function renderBreadcrumbs(path) {
  const root = document.getElementById("breadcrumbs");
  if (state.view === "trash") {
    root.innerHTML = '<span>Trash</span>';
    return;
  }
  const parts = path ? path.split("/") : [];
  let html = \`<button type="button" class="crumb" data-path="" data-name="My Drive">My Drive</button>\`;
  let current = "";
  for (const part of parts) {
    current = current ? \`\${current}/\${part}\` : part;
    html += \` <span>/</span> <button type="button" class="crumb" data-path="\${escapeHtml(current)}" data-name="\${escapeHtml(part)}">\${escapeHtml(part)}</button>\`;
  }
  root.innerHTML = html;
  root.querySelectorAll(".crumb").forEach(bindBreadcrumb);
}

function filteredEntries(entries) {
  const query = state.query.trim().toLowerCase();
  if (!query) return entries;
  return entries.filter((entry) => {
    const haystack = [
      entry.name,
      entry.path,
      entry.originalPath || "",
    ].join(" ").toLowerCase();
    return haystack.includes(query);
  });
}

function entryFromCard(card) {
  return {
    id: card.dataset.id || "",
    path: card.dataset.path || "",
    name: card.dataset.name || "",
    type: card.dataset.type || "file",
    originalPath: card.dataset.originalPath || "",
  };
}

function clearContextSelection() {
  document.querySelectorAll(".card.selected, .crumb.selected").forEach((node) => {
    node.classList.remove("selected");
  });
}

function closeContextMenu() {
  const menu = document.getElementById("context-menu");
  menu.classList.remove("open");
  menuState.entry = null;
  clearContextSelection();
}

function contextMenuActions(entry, source) {
  if (source === "breadcrumb") {
    return [
      { id: "open", label: "Open" },
      { id: "share", label: "Share" },
      { id: "delete", label: "Move to trash", danger: true, hidden: !entry.path },
    ];
  }
  if (state.view === "trash") {
    return [
      { id: "restore", label: "Restore" },
      { id: "download", label: "Download", hidden: entry.type === "folder" },
      { id: "share", label: "Share", hidden: entry.type === "folder" },
      { id: "delete-forever", label: "Delete forever", danger: true },
    ];
  }
  return [
    { id: "open", label: entry.type === "folder" ? "Open" : "Download" },
    { id: "share", label: "Share" },
    { id: "delete", label: "Move to trash", danger: true },
  ];
}

function openContextMenu(entry, x, y, highlight, source = "card") {
  const menu = document.getElementById("context-menu");
  menuState.entry = entry;
  clearContextSelection();
  if (highlight) highlight.classList.add("selected");

  const actions = contextMenuActions(entry, source);

  menu.innerHTML =
    \`<div class="menu-label">\${escapeHtml(entry.name)}</div>\` +
    actions
      .filter((action) => !action.hidden)
      .map((action) =>
        \`<button type="button" data-action="\${action.id}" class="\${action.danger ? "danger" : ""}">\${escapeHtml(action.label)}</button>\`
      )
      .join("");

  menu.classList.add("open");
  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  menu.style.left = \`\${Math.max(8, left)}px\`;
  menu.style.top = \`\${Math.max(8, top)}px\`;
}

function shareLink(entry) {
  const origin = window.location.origin;
  if (state.view === "trash") {
    return \`\${origin}/api/trash/download?id=\${encodeURIComponent(entry.id)}\`;
  }
  if (entry.type === "folder") {
    return \`\${origin}/?open=\${encodeURIComponent(entry.path)}\`;
  }
  return \`\${origin}/api/download?path=\${encodeURIComponent(entry.path)}\`;
}

async function copyShareLink(entry) {
  const url = shareLink(entry);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(url);
    return;
  }
  const input = document.createElement("textarea");
  input.value = url;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.left = "-9999px";
  document.body.appendChild(input);
  input.select();
  document.execCommand("copy");
  input.remove();
}

async function downloadEntry(entry) {
  const url = state.view === "trash"
    ? \`/api/trash/download?id=\${encodeURIComponent(entry.id)}\`
    : \`/api/download?path=\${encodeURIComponent(entry.path)}\`;
  const response = await fetch(url);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Could not download file");
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = entry.name;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}

async function runMenuAction(action, entry) {
  if (action === "open") {
    if (entry.type === "folder") {
      setPath(entry.path);
      return;
    }
    await downloadEntry(entry);
    return;
  }
  if (action === "download") {
    await downloadEntry(entry);
    return;
  }
  if (action === "share") {
    await copyShareLink(entry);
    document.getElementById("status").textContent = "Link copied to clipboard";
    return;
  }
  if (action === "delete") {
    if (!window.confirm(\`Move "\${entry.name}" to trash?\`)) return;
    const response = await fetch("/api/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: entry.path }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not move to trash");
    refreshListing();
    return;
  }
  if (action === "restore") {
    const response = await fetch("/api/trash/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: entry.id }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not restore item");
    refreshListing();
    return;
  }
  if (action === "delete-forever") {
    if (!window.confirm(\`Permanently delete "\${entry.name}"?\`)) return;
    const response = await fetch("/api/trash/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: entry.id }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not delete item");
    refreshListing();
  }
}

function bindCard(card) {
  card.addEventListener("click", async () => {
    if (menuState.longPress) {
      menuState.longPress = false;
      return;
    }
    const entry = entryFromCard(card);
    if (state.view === "trash") return;
    if (entry.type === "folder") {
      setPath(entry.path);
      return;
    }
    try {
      await downloadEntry(entry);
    } catch (error) {
      showError(String(error));
    }
  });

  card.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openContextMenu(entryFromCard(card), event.clientX, event.clientY, card);
  });

  card.addEventListener("touchstart", (event) => {
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    const entry = entryFromCard(card);
    clearTimeout(longPressTimer);
    longPressTimer = window.setTimeout(() => {
      menuState.longPress = true;
      openContextMenu(entry, touch.clientX, touch.clientY, card);
    }, 500);
  }, { passive: true });

  card.addEventListener("touchend", () => clearTimeout(longPressTimer));
  card.addEventListener("touchmove", () => clearTimeout(longPressTimer));
  card.addEventListener("touchcancel", () => clearTimeout(longPressTimer));
}

function bindBreadcrumb(button) {
  button.addEventListener("click", () => {
    if (menuState.longPress) {
      menuState.longPress = false;
      return;
    }
    setPath(button.dataset.path || "");
  });

  button.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openContextMenu(
      breadcrumbEntry(button),
      event.clientX,
      event.clientY,
      button,
      "breadcrumb",
    );
  });

  button.addEventListener("touchstart", (event) => {
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    const entry = breadcrumbEntry(button);
    clearTimeout(longPressTimer);
    longPressTimer = window.setTimeout(() => {
      menuState.longPress = true;
      openContextMenu(entry, touch.clientX, touch.clientY, button, "breadcrumb");
    }, 500);
  }, { passive: true });

  button.addEventListener("touchend", () => clearTimeout(longPressTimer));
  button.addEventListener("touchmove", () => clearTimeout(longPressTimer));
  button.addEventListener("touchcancel", () => clearTimeout(longPressTimer));
}

function renderEntries(data) {
  const container = document.getElementById("files");
  const entries = filteredEntries(data.entries || []);
  const locationLabel = state.view === "trash"
    ? "Trash"
    : (data.path ? data.path : "My Drive");
  document.getElementById("status").textContent = \`\${entries.length} item(s) in \${locationLabel}\`;

  if (!entries.length) {
    container.innerHTML = state.view === "trash"
      ? '<div class="empty">Trash is empty.</div>'
      : '<div class="empty">This folder is empty. Upload a file or create a folder to get started.</div>';
    return;
  }

  container.innerHTML = entries.map((entry) => {
    const icon = entry.type === "folder" ? "📁" : "📄";
    const meta = state.view === "trash"
      ? \`Deleted \${formatDate(entry.deletedAt)} · was \${escapeHtml(entry.originalPath || "/")}\`
      : (entry.type === "folder"
        ? \`Folder · \${formatDate(entry.modified)}\`
        : \`\${formatSize(entry.size)} · \${formatDate(entry.modified)}\`);
    return \`
      <article
        class="card"
        data-id="\${escapeHtml(entry.id || "")}"
        data-path="\${escapeHtml(entry.path)}"
        data-name="\${escapeHtml(entry.name)}"
        data-type="\${entry.type}"
        data-original-path="\${escapeHtml(entry.originalPath || "")}"
      >
        <div class="icon">\${icon}</div>
        <div class="name">\${escapeHtml(entry.name)}</div>
        <div class="meta">\${meta}</div>
      </article>\`;
  }).join("");

  container.querySelectorAll(".card").forEach(bindCard);
}

function showError(message) {
  const errorBox = document.getElementById("error");
  errorBox.textContent = message;
  errorBox.hidden = false;
}

async function refreshListing() {
  const errorBox = document.getElementById("error");
  errorBox.textContent = "";
  errorBox.hidden = true;
  try {
    const response = state.view === "trash"
      ? await fetch("/api/trash")
      : await fetch(\`/api/files?path=\${encodeURIComponent(state.path)}\`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load files");
    renderBreadcrumbs(state.view === "trash" ? "" : (data.path || ""));
    renderEntries(data);
  } catch (error) {
    showError(String(error));
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
    showError(data.error || "Could not create folder");
    return;
  }
  refreshListing();
}

async function uploadFiles(fileList) {
  for (const file of fileList) {
    const form = new FormData();
    form.append("path", state.path);
    form.append("file", file);
    const response = await fetch("/api/upload", { method: "POST", body: form });
    const data = await response.json();
    if (!response.ok) {
      showError(data.error || \`Could not upload \${file.name}\`);
      return;
    }
  }
  refreshListing();
}

async function emptyTrash() {
  if (!window.confirm("Permanently delete everything in Trash?")) return;
  const response = await fetch("/api/trash/empty", { method: "POST" });
  const data = await response.json();
  if (!response.ok) {
    showError(data.error || "Could not empty trash");
    return;
  }
  refreshListing();
}

document.getElementById("search").addEventListener("input", (event) => {
  state.query = event.target.value;
  refreshListing();
});
document.getElementById("new-folder").addEventListener("click", createFolder);
document.getElementById("upload-input").addEventListener("change", (event) => {
  uploadFiles(event.target.files);
  event.target.value = "";
});
document.getElementById("nav-drive").addEventListener("click", () => setView("drive"));
document.getElementById("nav-trash").addEventListener("click", () => setView("trash"));
document.getElementById("empty-trash").addEventListener("click", emptyTrash);
document.getElementById("context-menu").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button || !menuState.entry) return;
  const action = button.dataset.action;
  const entry = menuState.entry;
  closeContextMenu();
  try {
    await runMenuAction(action, entry);
  } catch (error) {
    showError(String(error));
  }
});
document.addEventListener("click", (event) => {
  if (!event.target.closest("#context-menu")) closeContextMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeContextMenu();
});
document.addEventListener("contextmenu", (event) => {
  if (!event.target.closest(".card") && !event.target.closest(".crumb")) closeContextMenu();
});

function applyShareLinkFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const openPath = params.get("open");
  if (openPath === null) return false;
  setView("drive");
  setPath(openPath);
  params.delete("open");
  const nextSearch = params.toString();
  const nextUrl = \`\${window.location.pathname}\${nextSearch ? \`?\${nextSearch}\` : ""}\`;
  window.history.replaceState({}, "", nextUrl);
  return true;
}

setActiveNav();
if (!applyShareLinkFromUrl()) {
  refreshListing();
}
`;

function renderPage(): string {
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
      <button id="nav-trash" type="button">Trash</button>
    </nav>
  </aside>
  <main>
    <div class="topbar">
      <label class="search">
        <span>⌕</span>
        <input id="search" type="search" placeholder="Search in My Drive">
      </label>
      <div class="toolbar toolbar-drive">
        <button id="new-folder" class="secondary" type="button">New folder</button>
        <label class="upload-btn">
          Upload
          <input id="upload-input" type="file" multiple>
        </label>
      </div>
      <div class="toolbar toolbar-trash">
        <button id="empty-trash" class="secondary" type="button">Empty trash</button>
      </div>
    </div>
    <div class="content">
      <div id="error" class="error" hidden></div>
      <div id="breadcrumbs" class="breadcrumbs"></div>
      <div id="status" class="status"></div>
      <div id="files" class="grid"></div>
    </div>
  </main>
  <div id="context-menu" class="context-menu" role="menu" aria-hidden="true"></div>
  <script>${PAGE_SCRIPT}</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderErrorPage(message: string): string {
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

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
  });
  res.end(body);
}

function sendBytes(
  res: ServerResponse,
  statusCode: number,
  contentType: string,
  body: Buffer,
  downloadName?: string,
): void {
  const headers: Record<string, string | number> = {
    "Content-Type": contentType,
    "Content-Length": body.length,
  };
  if (downloadName) {
    headers["Content-Disposition"] = `attachment; filename="${downloadName}"`;
  }
  res.writeHead(statusCode, headers);
  res.end(body);
}

const MIME_TYPES: Record<string, string> = {
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

function guessMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

function splitBuffer(buffer: Buffer, delimiter: Buffer): Buffer[] {
  const parts: Buffer[] = [];
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

function parseMultipartUpload(
  contentType: string,
  body: Buffer,
): { pathValue: string; fileName: string; fileData: Buffer } {
  if (!contentType.startsWith("multipart/form-data")) {
    throw new Error("expected multipart form data");
  }

  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/);
  if (!match) {
    throw new Error("missing multipart boundary");
  }

  const boundary = Buffer.from(`--${match[1] ?? match[2]}`);
  let pathValue = "";
  let fileName: string | null = null;
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
    } else if (headerBlock.includes('name="file"')) {
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

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function queryParam(url: URL, name: string): string {
  return url.searchParams.get(name) ?? "";
}

async function handleGet(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
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
    } catch (error) {
      if (error instanceof FileNotFoundError) {
        sendJson(res, 404, { error: "folder not found" });
      } else if (error instanceof Error && error.message === "invalid path") {
        sendJson(res, 400, { error: error.message });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 500, { error: message });
      }
    }
    return;
  }

  if (route === "/api/download") {
    try {
      const { absPath } = safePath(queryParam(url, "path"));
      const fileStat = await stat(absPath);
      if (!fileStat.isFile()) {
        sendJson(res, 404, { error: "file not found" });
        return;
      }
      const data = await readFile(absPath);
      sendBytes(res, 200, "application/octet-stream", data, path.basename(absPath));
    } catch (error) {
      if (error instanceof Error && error.message === "invalid path") {
        sendJson(res, 400, { error: error.message });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 500, { error: message });
      }
    }
    return;
  }

  if (route === "/api/trash") {
    try {
      const payload = await listTrash();
      sendJson(res, 200, payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { error: message });
    }
    return;
  }

  if (route === "/api/trash/download") {
    try {
      const id = queryParam(url, "id");
      const items = await readTrashIndex();
      const item = items.find((entry) => entry.id === id);
      if (!item) {
        sendJson(res, 404, { error: "trash item not found" });
        return;
      }
      const absPath = path.join(TRASH_ITEMS_DIR, item.storageName);
      const fileStat = await stat(absPath);
      if (!fileStat.isFile()) {
        sendJson(res, 404, { error: "file not found" });
        return;
      }
      const data = await readFile(absPath);
      sendBytes(res, 200, "application/octet-stream", data, item.name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { error: message });
    }
    return;
  }

  if (route === "/") {
    sendBytes(res, 200, "text/html; charset=utf-8", Buffer.from(renderPage()));
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

async function handlePost(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const route = url.pathname;
  await ensureDataRoot();

  if (route === "/api/mkdir") {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body.toString("utf8") || "{}") as { path?: string; name?: string };
      const parent = payload.path ?? "";
      const name = (payload.name ?? "").trim();
      if (!name || name.includes("/") || name === "." || name === "..") {
        sendJson(res, 400, { error: "invalid folder name" });
        return;
      }
      const { absPath: parentAbs, relPath: parentRel } = safePath(parent);
      const targetAbs = path.join(parentAbs, name);
      const targetRel = parentRel ? `${parentRel}/${name}` : name;
      await mkdir(targetAbs, { recursive: false });
      sendJson(res, 201, { entry: await fileEntry(targetAbs, targetRel) });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
        sendJson(res, 409, { error: "folder already exists" });
      } else if (error instanceof Error && error.message === "invalid path") {
        sendJson(res, 400, { error: error.message });
      } else {
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
      const filename = path.basename(fileName);
      if (!filename || filename === "." || filename === "..") {
        sendJson(res, 400, { error: "invalid file name" });
        return;
      }
      const { absPath: parentAbs, relPath: parentRel } = safePath(pathValue);
      const targetAbs = path.join(parentAbs, filename);
      const targetRel = parentRel ? `${parentRel}/${filename}` : filename;
      await writeFile(targetAbs, fileData);
      sendJson(res, 201, { entry: await fileEntry(targetAbs, targetRel) });
    } catch (error) {
      if (error instanceof Error && (error.message === "invalid path" || error.message.includes("multipart"))) {
        sendJson(res, 400, { error: error.message });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 500, { error: message });
      }
    }
    return;
  }

  if (route === "/api/delete") {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body.toString("utf8") || "{}") as { path?: string };
      const relPath = (payload.path ?? "").trim();
      if (!relPath) {
        sendJson(res, 400, { error: "path is required" });
        return;
      }
      const item = await moveToTrash(relPath);
      sendJson(res, 200, { item });
    } catch (error) {
      if (error instanceof FileNotFoundError) {
        sendJson(res, 404, { error: "item not found" });
      } else if (error instanceof Error && error.message === "invalid path") {
        sendJson(res, 400, { error: error.message });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 500, { error: message });
      }
    }
    return;
  }

  if (route === "/api/trash/restore") {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body.toString("utf8") || "{}") as { id?: string };
      const id = (payload.id ?? "").trim();
      if (!id) {
        sendJson(res, 400, { error: "id is required" });
        return;
      }
      const entry = await restoreFromTrash(id);
      sendJson(res, 200, { entry });
    } catch (error) {
      if (error instanceof FileNotFoundError) {
        sendJson(res, 404, { error: "trash item not found" });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 500, { error: message });
      }
    }
    return;
  }

  if (route === "/api/trash/delete") {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body.toString("utf8") || "{}") as { id?: string };
      const id = (payload.id ?? "").trim();
      if (!id) {
        sendJson(res, 400, { error: "id is required" });
        return;
      }
      await deleteTrashItem(id);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      if (error instanceof FileNotFoundError) {
        sendJson(res, 404, { error: "trash item not found" });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 500, { error: message });
      }
    }
    return;
  }

  if (route === "/api/trash/empty") {
    try {
      const count = await emptyTrash();
      sendJson(res, 200, { count });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { error: message });
    }
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

const server = createServer(async (req, res) => {
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (req.method === "GET" && url.pathname === "/") {
      sendBytes(res, 503, "text/html; charset=utf-8", Buffer.from(renderErrorPage(message)));
    } else {
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