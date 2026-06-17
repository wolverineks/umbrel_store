"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_http_1 = require("node:http");
const node_crypto_1 = require("node:crypto");
const promises_1 = require("node:fs/promises");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const APP_VERSION = "1.0.1";
const DATA_ROOT = process.env.RECIPES_DATA_DIR ?? "/data";
const RECIPES_DIR = node_path_1.default.join(DATA_ROOT, "recipes");
const INDEX_PATH = node_path_1.default.join(DATA_ROOT, "index.json");
const SETTINGS_PATH = node_path_1.default.join(DATA_ROOT, "settings.json");
const ICON_PATH = node_path_1.default.join(__dirname, "icon.svg");
async function ensureDataDirs() {
    await (0, promises_1.mkdir)(RECIPES_DIR, { recursive: true });
}
async function readJsonFile(filePath, fallback) {
    if (!(0, node_fs_1.existsSync)(filePath))
        return fallback;
    const raw = await (0, promises_1.readFile)(filePath, "utf8");
    return JSON.parse(raw);
}
async function writeJsonAtomic(filePath, value) {
    const tmp = `${filePath}.${(0, node_crypto_1.randomUUID)()}.tmp`;
    await (0, promises_1.writeFile)(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await (0, promises_1.rename)(tmp, filePath);
}
async function loadSettings() {
    const existing = await readJsonFile(SETTINGS_PATH, null);
    if (existing?.ingest_token)
        return existing;
    const settings = { ingest_token: (0, node_crypto_1.randomBytes)(32).toString("hex") };
    await writeJsonAtomic(SETTINGS_PATH, settings);
    return settings;
}
async function loadIndex() {
    return readJsonFile(INDEX_PATH, []);
}
async function saveIndex(entries) {
    const sorted = [...entries].sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
    await writeJsonAtomic(INDEX_PATH, sorted);
}
function recipePath(id) {
    return node_path_1.default.join(RECIPES_DIR, `${id}.json`);
}
async function loadRecipe(id) {
    const file = recipePath(id);
    if (!(0, node_fs_1.existsSync)(file))
        return null;
    return readJsonFile(file, null);
}
function normalizeIngestPayload(body) {
    const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : "Untitled Recipe";
    const sourceUrl = typeof body.source_url === "string" ? body.source_url.trim() : "";
    if (!sourceUrl)
        throw new Error("source_url is required");
    const asNullableString = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
    const asStringArray = (value) => {
        if (!Array.isArray(value))
            return [];
        return value
            .map((item) => (typeof item === "string" ? item.trim() : ""))
            .filter(Boolean);
    };
    return {
        title,
        description: asNullableString(body.description),
        servings: asNullableString(body.servings),
        prep_time: asNullableString(body.prep_time),
        cook_time: asNullableString(body.cook_time),
        total_time: asNullableString(body.total_time),
        ingredients: asStringArray(body.ingredients),
        instructions: asStringArray(body.instructions),
        notes: asNullableString(body.notes),
        source_url: sourceUrl,
    };
}
async function upsertRecipe(payload) {
    const normalized = normalizeIngestPayload(payload);
    const now = new Date().toISOString();
    const index = await loadIndex();
    const existing = index.find((entry) => entry.source_url === normalized.source_url);
    if (existing) {
        const current = await loadRecipe(existing.id);
        const updated = {
            id: existing.id,
            created_at: current?.created_at ?? now,
            updated_at: now,
            ...normalized,
        };
        await writeJsonAtomic(recipePath(updated.id), updated);
        await saveIndex(index.map((entry) => entry.id === updated.id
            ? {
                id: updated.id,
                title: updated.title,
                source_url: updated.source_url,
                created_at: updated.created_at,
                updated_at: updated.updated_at,
            }
            : entry));
        return updated;
    }
    const recipe = {
        id: (0, node_crypto_1.randomUUID)(),
        created_at: now,
        updated_at: now,
        ...normalized,
    };
    await writeJsonAtomic(recipePath(recipe.id), recipe);
    await saveIndex([
        ...index,
        {
            id: recipe.id,
            title: recipe.title,
            source_url: recipe.source_url,
            created_at: recipe.created_at,
            updated_at: recipe.updated_at,
        },
    ]);
    return recipe;
}
async function deleteRecipe(id) {
    const index = await loadIndex();
    const next = index.filter((entry) => entry.id !== id);
    if (next.length === index.length)
        return false;
    await saveIndex(next);
    await (0, promises_1.rm)(recipePath(id), { force: true });
    return true;
}
function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(payload),
    });
    res.end(payload);
}
function sendText(res, status, body, contentType = "text/plain; charset=utf-8") {
    res.writeHead(status, {
        "Content-Type": contentType,
        "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
}
async function readBody(req) {
    const chunks = [];
    for await (const chunk of req)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
}
function getBearerToken(req) {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer "))
        return null;
    return header.slice(7).trim() || null;
}
function escapeHtml(value) {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}
const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Recipes</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Georgia, "Times New Roman", serif;
      color: #111827;
      background: #faf7f2;
    }
    header, main, .panel {
      max-width: 960px;
      margin: 0 auto;
      padding: 24px;
    }
    header {
      border-bottom: 2px solid #e67e22;
      background: #fff;
    }
    h1 { margin: 0 0 6px; font-size: 32px; }
    .sub { margin: 0; color: #6b7280; font-family: system-ui, sans-serif; font-size: 14px; }
    .toolbar {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 16px;
    }
    button, .btn {
      border: 1px solid #d1d5db;
      border-radius: 8px;
      background: #fff;
      padding: 8px 12px;
      cursor: pointer;
      font-family: system-ui, sans-serif;
      font-size: 13px;
    }
    .primary {
      background: #e67e22;
      border-color: #e67e22;
      color: #fff;
    }
    .grid {
      display: grid;
      gap: 14px;
      margin-top: 20px;
    }
    .card {
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      padding: 16px;
      cursor: pointer;
    }
    .card h2 {
      margin: 0 0 6px;
      font-size: 22px;
    }
    .meta {
      font-family: system-ui, sans-serif;
      font-size: 12px;
      color: #6b7280;
    }
    .detail {
      display: none;
      margin-top: 14px;
      padding-top: 14px;
      border-top: 1px solid #e5e7eb;
    }
    .card.open .detail { display: block; }
    .columns {
      display: grid;
      grid-template-columns: 1fr 1.2fr;
      gap: 20px;
      margin-top: 12px;
    }
    h3 {
      margin: 0 0 8px;
      font-size: 16px;
      color: #e67e22;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    ul, ol { margin: 0; padding-left: 20px; line-height: 1.55; font-size: 14px; }
    .panel {
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      margin-top: 20px;
      font-family: system-ui, sans-serif;
    }
    .token {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
      margin-top: 10px;
    }
    code {
      background: #f3f4f6;
      padding: 8px 10px;
      border-radius: 8px;
      word-break: break-all;
      font-size: 12px;
    }
    .empty {
      color: #6b7280;
      font-family: system-ui, sans-serif;
      padding: 24px 0;
    }
    .danger { color: #b91c1c; border-color: #fecaca; }
    @media (max-width: 720px) {
      .columns { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Recipes</h1>
    <p class="sub">Saved from the Recipe Printer Chrome extension.</p>
    <div class="toolbar">
      <button id="refresh-btn" type="button">Refresh</button>
      <button id="settings-btn" type="button">Extension Settings</button>
    </div>
  </header>
  <main>
    <div id="list" class="grid"></div>
    <div id="empty" class="empty hidden">No recipes saved yet. Use the Chrome extension to add one.</div>
  </main>
  <section id="settings-panel" class="panel">
    <h2>Chrome Extension Setup</h2>
    <p>Use this ingest token in the Recipe Printer extension options.</p>
    <div class="token">
      <code id="token-value">Loading…</code>
      <button id="copy-token-btn" type="button">Copy token</button>
      <button id="regenerate-token-btn" type="button" class="danger">Regenerate</button>
    </div>
    <p class="meta" style="margin-top:12px;">Umbrel URL for the extension: <code id="base-url"></code></p>
  </section>
  <script>
    const listEl = document.getElementById("list");
    const emptyEl = document.getElementById("empty");
    const settingsPanel = document.getElementById("settings-panel");
    const tokenValue = document.getElementById("token-value");
    const baseUrlEl = document.getElementById("base-url");

    function escapeHtml(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
    }

    function formatDate(value) {
      try { return new Date(value).toLocaleString(); } catch { return value; }
    }

    function renderRecipeCard(recipe) {
      const card = document.createElement("article");
      card.className = "card";
      card.innerHTML = \`
        <h2>\${escapeHtml(recipe.title)}</h2>
        <div class="meta">Saved \${formatDate(recipe.updated_at || recipe.created_at)} · <a href="\${escapeHtml(recipe.source_url)}" target="_blank" rel="noreferrer">Source</a></div>
        <div class="detail">
          \${recipe.description ? '<p>' + escapeHtml(recipe.description) + '</p>' : ''}
          <div class="columns">
            <div>
              <h3>Ingredients</h3>
              <ul>\${(recipe.ingredients || []).map((item) => '<li>' + escapeHtml(item) + '</li>').join("")}</ul>
            </div>
            <div>
              <h3>Instructions</h3>
              <ol>\${(recipe.instructions || []).map((item) => '<li>' + escapeHtml(item) + '</li>').join("")}</ol>
            </div>
          </div>
          \${recipe.notes ? '<p><strong>Notes:</strong> ' + escapeHtml(recipe.notes) + '</p>' : ''}
          <button class="danger delete-btn" data-id="\${escapeHtml(recipe.id)}" type="button">Delete</button>
        </div>
      \`;
      card.addEventListener("click", (event) => {
        if (event.target.closest("a, button")) return;
        card.classList.toggle("open");
      });
      card.querySelector(".delete-btn")?.addEventListener("click", async (event) => {
        event.stopPropagation();
        if (!confirm("Delete this recipe?")) return;
        const id = event.currentTarget.getAttribute("data-id");
        const response = await fetch("/api/recipes/" + encodeURIComponent(id), { method: "DELETE" });
        if (!response.ok) {
          alert("Failed to delete recipe.");
          return;
        }
        await loadRecipes();
      });
      return card;
    }

    async function loadRecipes() {
      const response = await fetch("/api/recipes");
      const payload = await response.json();
      listEl.replaceChildren();
      const recipes = payload.recipes || [];
      emptyEl.classList.toggle("hidden", recipes.length > 0);
      for (const summary of recipes) {
        const detailResponse = await fetch("/api/recipes/" + encodeURIComponent(summary.id));
        const recipe = await detailResponse.json();
        listEl.appendChild(renderRecipeCard(recipe));
      }
    }

    async function loadToken() {
      const response = await fetch("/api/settings/token");
      const payload = await response.json();
      tokenValue.textContent = payload.ingest_token || "";
      baseUrlEl.textContent = window.location.origin;
    }

    document.getElementById("refresh-btn").addEventListener("click", loadRecipes);
    document.getElementById("settings-btn").addEventListener("click", () => {
      settingsPanel.scrollIntoView({ behavior: "smooth", block: "start" });
      loadToken();
    });
    document.getElementById("copy-token-btn").addEventListener("click", async () => {
      await navigator.clipboard.writeText(tokenValue.textContent || "");
    });
    document.getElementById("regenerate-token-btn").addEventListener("click", async () => {
      if (!confirm("Regenerate token? Update the Chrome extension with the new token.")) return;
      const response = await fetch("/api/settings/regenerate-token", { method: "POST" });
      const payload = await response.json();
      tokenValue.textContent = payload.ingest_token || "";
    });

    loadRecipes();
    loadToken();
  </script>
</body>
</html>`;
async function handleRequest(req, res) {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const route = url.pathname.replace(/\/+$/, "") || "/";
    const settings = await loadSettings();
    if (req.method === "GET" && route === "/icon.svg" && (0, node_fs_1.existsSync)(ICON_PATH)) {
        const icon = await (0, promises_1.readFile)(ICON_PATH);
        res.writeHead(200, { "Content-Type": "image/svg+xml" });
        res.end(icon);
        return;
    }
    if (req.method === "GET" && route === "/") {
        sendText(res, 200, HTML_PAGE, "text/html; charset=utf-8");
        return;
    }
    if (route === "/api/ping" && req.method === "GET") {
        const token = getBearerToken(req);
        if (!token || token !== settings.ingest_token) {
            sendJson(res, 401, { error: "Invalid ingest token" });
            return;
        }
        sendJson(res, 200, { ok: true, app: "wolverineks-recipes", version: APP_VERSION });
        return;
    }
    if (route === "/api/ingest" && req.method === "POST") {
        const token = getBearerToken(req);
        if (!token || token !== settings.ingest_token) {
            sendJson(res, 401, { error: "Invalid ingest token" });
            return;
        }
        try {
            const body = JSON.parse(await readBody(req));
            const recipe = await upsertRecipe(body);
            sendJson(res, 200, { ok: true, id: recipe.id, recipe, updated: true });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Invalid recipe payload";
            sendJson(res, 400, { error: message });
        }
        return;
    }
    if (route === "/api/recipes" && req.method === "GET") {
        const index = await loadIndex();
        sendJson(res, 200, { recipes: index });
        return;
    }
    if (route.startsWith("/api/recipes/") && req.method === "GET") {
        const id = decodeURIComponent(route.slice("/api/recipes/".length));
        const recipe = await loadRecipe(id);
        if (!recipe) {
            sendJson(res, 404, { error: "Recipe not found" });
            return;
        }
        sendJson(res, 200, recipe);
        return;
    }
    if (route.startsWith("/api/recipes/") && req.method === "DELETE") {
        const id = decodeURIComponent(route.slice("/api/recipes/".length));
        const deleted = await deleteRecipe(id);
        if (!deleted) {
            sendJson(res, 404, { error: "Recipe not found" });
            return;
        }
        sendJson(res, 200, { ok: true });
        return;
    }
    if (route === "/api/settings/token" && req.method === "GET") {
        sendJson(res, 200, { ingest_token: settings.ingest_token });
        return;
    }
    if (route === "/api/settings/regenerate-token" && req.method === "POST") {
        const next = { ingest_token: (0, node_crypto_1.randomBytes)(32).toString("hex") };
        await writeJsonAtomic(SETTINGS_PATH, next);
        sendJson(res, 200, next);
        return;
    }
    sendJson(res, 404, { error: "Not found" });
}
async function main() {
    await ensureDataDirs();
    await loadSettings();
    const server = (0, node_http_1.createServer)((req, res) => {
        handleRequest(req, res).catch((error) => {
            console.error(error);
            sendJson(res, 500, { error: "Internal server error" });
        });
    });
    const port = Number(process.env.PORT ?? 3000);
    server.listen(port, "0.0.0.0", () => {
        console.log(`wolverineks-recipes v${APP_VERSION} listening on ${port}`);
    });
}
main().catch((error) => {
    console.error(error);
    process.exit(1);
});
