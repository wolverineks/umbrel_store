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
const APP_VERSION = "1.0.7";
const SAMPLE_SOURCE_PREFIX = "urn:wolverineks-recipes:sample:";
const DATA_ROOT = process.env.RECIPES_DATA_DIR ?? "/data";
const RECIPES_DIR = node_path_1.default.join(DATA_ROOT, "recipes");
const IMAGES_DIR = node_path_1.default.join(DATA_ROOT, "images");
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
const IMAGE_MIME_TYPES = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
};
const IMAGE_CONTENT_TYPES = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
};
const INDEX_PATH = node_path_1.default.join(DATA_ROOT, "index.json");
const SETTINGS_PATH = node_path_1.default.join(DATA_ROOT, "settings.json");
const ICON_PATH = node_path_1.default.join(__dirname, "icon.svg");
async function ensureDataDirs() {
    await (0, promises_1.mkdir)(RECIPES_DIR, { recursive: true });
    await (0, promises_1.mkdir)(IMAGES_DIR, { recursive: true });
}
function imageFilePath(id, ext) {
    return node_path_1.default.join(IMAGES_DIR, `${id}${ext}`);
}
function findRecipeImagePath(id) {
    for (const ext of IMAGE_EXTENSIONS) {
        const filePath = imageFilePath(id, ext);
        if ((0, node_fs_1.existsSync)(filePath))
            return filePath;
    }
    return null;
}
function extensionFromImageUrl(imageUrl) {
    try {
        const pathname = new URL(imageUrl).pathname.toLowerCase();
        for (const ext of IMAGE_EXTENSIONS) {
            if (pathname.endsWith(ext))
                return ext;
        }
    }
    catch {
        // ignore invalid URLs
    }
    return null;
}
async function deleteRecipeImage(id) {
    await Promise.all(IMAGE_EXTENSIONS.map((ext) => (0, promises_1.rm)(imageFilePath(id, ext), { force: true })));
}
async function saveRecipeImage(id, imageUrl) {
    let parsed;
    try {
        parsed = new URL(imageUrl);
    }
    catch {
        return false;
    }
    if (!["http:", "https:"].includes(parsed.protocol))
        return false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
        const response = await fetch(imageUrl, {
            signal: controller.signal,
            headers: { "User-Agent": `wolverineks-recipes/${APP_VERSION}` },
        });
        if (!response.ok)
            return false;
        const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() || "";
        const ext = IMAGE_CONTENT_TYPES[contentType] || extensionFromImageUrl(imageUrl) || null;
        if (!ext)
            return false;
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length < 100 || buffer.length > MAX_IMAGE_BYTES)
            return false;
        await deleteRecipeImage(id);
        await (0, promises_1.writeFile)(imageFilePath(id, ext), buffer);
        return true;
    }
    catch (error) {
        console.error(`Failed to save image for recipe ${id}:`, error);
        return false;
    }
    finally {
        clearTimeout(timeout);
    }
}
function recipeHasImage(id) {
    return findRecipeImagePath(id) !== null;
}
function withImageFlag(recipe) {
    return { ...recipe, has_image: recipeHasImage(recipe.id) };
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
    const imageUrl = typeof payload.image_url === "string" && payload.image_url.trim()
        ? payload.image_url.trim()
        : "";
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
        if (imageUrl)
            await saveRecipeImage(updated.id, imageUrl);
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
    if (imageUrl)
        await saveRecipeImage(recipe.id, imageUrl);
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
    await deleteRecipeImage(id);
    return true;
}
const DEFAULT_RECIPES = [
    {
        id: "00000000-0000-4000-8000-000000000001",
        title: "Chocolate Chip Cookies",
        description: "Classic chewy bakery-style cookies with crisp edges and soft centers.",
        servings: "24 cookies",
        prep_time: "15 min",
        cook_time: "12 min",
        total_time: "27 min",
        ingredients: [
            "2 1/4 cups all-purpose flour",
            "1 tsp baking soda",
            "1 tsp fine salt",
            "1 cup unsalted butter, softened",
            "3/4 cup granulated sugar",
            "3/4 cup packed brown sugar",
            "2 large eggs",
            "2 tsp vanilla extract",
            "2 cups semisweet chocolate chips",
        ],
        instructions: [
            "Heat oven to 375°F (190°C). Line baking sheets with parchment.",
            "Whisk flour, baking soda, and salt in a bowl.",
            "Beat butter and both sugars until light and fluffy, about 3 minutes.",
            "Beat in eggs one at a time, then vanilla.",
            "Mix in dry ingredients until just combined. Fold in chocolate chips.",
            "Scoop rounded tablespoons of dough 2 inches apart onto sheets.",
            "Bake 9–12 minutes until edges are golden and centers look slightly underdone.",
            "Cool on the sheet 5 minutes, then transfer to a rack.",
        ],
        notes: "For thicker cookies, chill the dough 30 minutes before baking.",
        source_url: `${SAMPLE_SOURCE_PREFIX}chocolate-chip-cookies`,
    },
    {
        id: "00000000-0000-4000-8000-000000000002",
        title: "Spaghetti Aglio e Olio",
        description: "A fast pantry pasta with garlic, olive oil, chili flakes, and parsley.",
        servings: "4 servings",
        prep_time: "10 min",
        cook_time: "15 min",
        total_time: "25 min",
        ingredients: [
            "12 oz spaghetti",
            "1/2 cup extra-virgin olive oil",
            "6 garlic cloves, thinly sliced",
            "1/2 tsp red pepper flakes",
            "1/2 cup chopped fresh parsley",
            "1 tsp fine salt",
            "Freshly ground black pepper",
            "Parmesan cheese, for serving",
        ],
        instructions: [
            "Cook spaghetti in well-salted boiling water until al dente. Reserve 1 cup pasta water, then drain.",
            "Warm olive oil in a large skillet over medium-low heat.",
            "Add garlic and cook gently until fragrant and pale gold, not brown, about 2 minutes.",
            "Stir in red pepper flakes, then add pasta with a splash of pasta water.",
            "Toss vigorously until glossy, adding more pasta water as needed.",
            "Remove from heat, add parsley, salt, and pepper. Serve with Parmesan.",
        ],
        notes: null,
        source_url: `${SAMPLE_SOURCE_PREFIX}spaghetti-aglio-e-olio`,
    },
    {
        id: "00000000-0000-4000-8000-000000000003",
        title: "Sheet Pan Roast Chicken and Vegetables",
        description: "One-pan dinner with juicy chicken thighs and roasted seasonal vegetables.",
        servings: "4 servings",
        prep_time: "15 min",
        cook_time: "40 min",
        total_time: "55 min",
        ingredients: [
            "8 bone-in, skin-on chicken thighs",
            "2 tbsp olive oil",
            "1 lb baby potatoes, halved",
            "2 carrots, cut into chunks",
            "1 red onion, cut into wedges",
            "4 garlic cloves, smashed",
            "1 tsp dried thyme",
            "1 tsp paprika",
            "1 tsp fine salt",
            "1/2 tsp black pepper",
            "1 lemon, cut into wedges",
        ],
        instructions: [
            "Heat oven to 425°F (220°C).",
            "Toss potatoes, carrots, onion, and garlic with 1 tbsp oil, thyme, paprika, salt, and pepper on a large sheet pan.",
            "Nestle chicken thighs among vegetables. Rub with remaining oil and season lightly.",
            "Roast 35–40 minutes until chicken reaches 165°F (74°C) and skin is crisp.",
            "Rest 5 minutes. Squeeze lemon over the pan before serving.",
        ],
        notes: "Swap in broccoli, Brussels sprouts, or sweet potato based on what you have.",
        source_url: `${SAMPLE_SOURCE_PREFIX}sheet-pan-roast-chicken`,
    },
    {
        id: "00000000-0000-4000-8000-000000000004",
        title: "Fluffy Buttermilk Pancakes",
        description: "Light, tender pancakes perfect for weekend breakfasts.",
        servings: "8 pancakes",
        prep_time: "10 min",
        cook_time: "15 min",
        total_time: "25 min",
        ingredients: [
            "1 1/2 cups all-purpose flour",
            "2 tbsp granulated sugar",
            "2 tsp baking powder",
            "1/2 tsp baking soda",
            "1/2 tsp fine salt",
            "1 1/4 cups buttermilk",
            "1 large egg",
            "3 tbsp melted butter, plus more for the pan",
            "1 tsp vanilla extract",
            "Maple syrup and butter, for serving",
        ],
        instructions: [
            "Whisk flour, sugar, baking powder, baking soda, and salt in a bowl.",
            "Whisk buttermilk, egg, melted butter, and vanilla in another bowl.",
            "Pour wet ingredients into dry and stir until just combined; a few lumps are fine.",
            "Heat a lightly buttered skillet or griddle over medium heat.",
            "Pour 1/4 cup batter per pancake. Cook until bubbles form and edges look set, about 2 minutes.",
            "Flip and cook until golden on the second side, about 1 minute.",
            "Serve warm with butter and maple syrup.",
        ],
        notes: "Keep cooked pancakes warm in a 200°F oven while you finish the batch.",
        source_url: `${SAMPLE_SOURCE_PREFIX}buttermilk-pancakes`,
    },
];
async function seedDefaultRecipes() {
    const index = await loadIndex();
    if (index.length > 0)
        return;
    const now = new Date().toISOString();
    const entries = [];
    for (const seed of DEFAULT_RECIPES) {
        const recipe = {
            ...seed,
            created_at: now,
            updated_at: now,
        };
        await writeJsonAtomic(recipePath(recipe.id), recipe);
        entries.push({
            id: recipe.id,
            title: recipe.title,
            source_url: recipe.source_url,
            created_at: now,
            updated_at: now,
        });
    }
    await saveIndex(entries);
    console.log(`Seeded ${entries.length} sample recipes`);
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
function renderPrintPage(recipe, autoPrint) {
    const metaItems = [
        recipe.servings ? `Servings: ${escapeHtml(recipe.servings)}` : "",
        recipe.prep_time ? `Prep: ${escapeHtml(recipe.prep_time)}` : "",
        recipe.cook_time ? `Cook: ${escapeHtml(recipe.cook_time)}` : "",
        recipe.total_time ? `Total: ${escapeHtml(recipe.total_time)}` : "",
    ]
        .filter(Boolean)
        .map((item) => `<li>${item}</li>`)
        .join("");
    const ingredients = (recipe.ingredients || [])
        .map((item) => `<li>${escapeHtml(item)}</li>`)
        .join("");
    const instructions = (recipe.instructions || [])
        .map((item) => `<li>${escapeHtml(item)}</li>`)
        .join("");
    const description = recipe.description
        ? `<p class="description">${escapeHtml(recipe.description)}</p>`
        : "";
    const notes = recipe.notes
        ? `<section class="notes"><h2>Notes</h2><p>${escapeHtml(recipe.notes)}</p></section>`
        : "";
    const source = recipe.source_url
        ? `<p>Source: ${escapeHtml(recipe.source_url)}</p>`
        : "";
    const printedOn = `Printed: ${new Date().toLocaleDateString("en-US")}`;
    const autoPrintScript = autoPrint
        ? `<script>window.addEventListener("load", () => setTimeout(() => window.print(), 250));</script>`
        : "";
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(recipe.title)}</title>
  <style>
    @page { size: letter; margin: 0.75in; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Georgia, "Times New Roman", serif;
      color: #111827;
      background: #f3f4f6;
    }
    .toolbar {
      display: flex;
      gap: 8px;
      padding: 12px;
      background: #fff;
      border-bottom: 1px solid #e5e7eb;
      font-family: system-ui, sans-serif;
    }
    .toolbar button {
      border: 1px solid #d1d5db;
      border-radius: 8px;
      background: #fff;
      padding: 8px 12px;
      cursor: pointer;
      font-size: 13px;
    }
    .recipe-card {
      max-width: 8.5in;
      margin: 0 auto;
      padding: 0.5in 0.75in 0.75in;
      background: #fff;
    }
    .recipe-header {
      text-align: center;
      margin-bottom: 24px;
      border-bottom: 2px solid #e67e22;
      padding-bottom: 16px;
    }
    .recipe-header h1 {
      margin: 0 0 8px;
      font-size: 30px;
      line-height: 1.2;
    }
    .description {
      margin: 0 0 10px;
      font-size: 14px;
      color: #4b5563;
    }
    .meta {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 8px 16px;
      font-size: 13px;
      color: #374151;
    }
    .recipe-body {
      display: grid;
      grid-template-columns: 1fr 1.2fr;
      gap: 28px;
    }
    .column h2 {
      margin: 0 0 10px;
      font-size: 18px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: #e67e22;
    }
    .column ul, .column ol {
      margin: 0;
      font-size: 13px;
      line-height: 1.55;
    }
    .column ul { padding-left: 18px; }
    .column ol { padding-left: 20px; line-height: 1.65; }
    .column ol li + li { margin-top: 8px; }
    .notes {
      margin-top: 24px;
      padding-top: 12px;
      border-top: 1px solid #e5e7eb;
    }
    .notes h2 {
      margin: 0 0 8px;
      font-size: 16px;
      color: #e67e22;
    }
    .notes p {
      margin: 0;
      font-size: 13px;
      line-height: 1.5;
    }
    .recipe-footer {
      margin-top: 28px;
      padding-top: 10px;
      border-top: 1px solid #e5e7eb;
      font-size: 11px;
      color: #6b7280;
    }
    .recipe-footer p { margin: 0; }
    @media print {
      body { background: #fff; }
      .no-print { display: none !important; }
      .recipe-card { margin: 0; padding: 0; max-width: none; }
    }
    @media (max-width: 720px) {
      .recipe-body { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="toolbar no-print">
    <button type="button" onclick="window.print()">Print</button>
    <button type="button" onclick="window.close()">Close</button>
  </div>
  <article class="recipe-card">
    <header class="recipe-header">
      <h1>${escapeHtml(recipe.title)}</h1>
      ${description}
      ${metaItems ? `<ul class="meta">${metaItems}</ul>` : ""}
    </header>
    <section class="recipe-body">
      <div class="column">
        <h2>Ingredients</h2>
        <ul>${ingredients}</ul>
      </div>
      <div class="column">
        <h2>Instructions</h2>
        <ol>${instructions}</ol>
      </div>
    </section>
    ${notes}
    <footer class="recipe-footer">
      ${source}
      <p>${printedOn}</p>
    </footer>
  </article>
  ${autoPrintScript}
</body>
</html>`;
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
    .search-wrap {
      margin-top: 16px;
    }
    #search-input {
      width: 100%;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      padding: 10px 12px;
      font-family: system-ui, sans-serif;
      font-size: 14px;
      background: #fff;
    }
    #search-input:focus {
      outline: 2px solid #e67e22;
      outline-offset: 1px;
      border-color: #e67e22;
    }
    .toolbar {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 12px;
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
    .recipe-image {
      width: 100%;
      max-height: 220px;
      object-fit: cover;
      border-radius: 8px;
      margin-bottom: 12px;
      display: block;
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
    .card-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 12px;
    }
    .hidden { display: none; }
    .setup-steps {
      margin: 16px 0 0;
      padding-left: 20px;
      line-height: 1.6;
      font-size: 14px;
    }
    .setup-steps li + li { margin-top: 10px; }
    .setup-field {
      margin-top: 14px;
    }
    .setup-field label {
      display: block;
      font-size: 12px;
      font-weight: 600;
      color: #374151;
      margin-bottom: 6px;
    }
    .setup-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 16px;
    }
    a { color: #e67e22; }
    @media (max-width: 720px) {
      .columns { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Recipes</h1>
    <p class="sub">Saved from the Recipe Printer Chrome extension.</p>
    <div class="search-wrap">
      <input
        id="search-input"
        type="search"
        placeholder="Search by name, ingredients, prep time, cook time, or total time…"
        autocomplete="off"
        spellcheck="false"
      />
    </div>
    <div class="toolbar">
      <button id="refresh-btn" type="button">Refresh</button>
      <button id="add-device-btn" type="button" class="primary">Add new device</button>
    </div>
  </header>
  <main>
    <div id="list" class="grid"></div>
    <div id="empty" class="empty hidden">No recipes saved yet. Click “Add new device” to set up the Chrome extension.</div>
    <div id="no-results" class="empty hidden">No recipes match your search.</div>
  </main>
  <section id="device-panel" class="panel hidden">
    <h2>Add new device</h2>
    <p>Set up the Recipe Printer Chrome extension on a new computer or browser profile.</p>
    <ol class="setup-steps">
      <li>
        Install the extension from
        <a href="https://github.com/wolverineks/recipe-printer-extension" target="_blank" rel="noreferrer">GitHub</a>
        (Chrome → Extensions → Developer mode → Load unpacked).
      </li>
      <li>
        Get an <a href="https://console.x.ai/team/default/api-keys" target="_blank" rel="noreferrer">xAI API key</a>
        and paste it in the extension Settings on <strong>this device</strong> (each browser needs its own key entry).
      </li>
      <li>Copy the Umbrel URL and ingest token below into extension Settings on this device.</li>
      <li>Click Save in the extension, allow Chrome network access, then Test Umbrel connection.</li>
      <li>Open any recipe page and click <strong>Format, Save &amp; Print</strong>.</li>
    </ol>
    <div class="setup-field">
      <label>Umbrel Recipes URL (include port :4020)</label>
      <div class="token">
        <code id="base-url">Loading…</code>
        <button id="copy-url-btn" type="button">Copy URL</button>
      </div>
    </div>
    <div class="setup-field">
      <label>Ingest token (same for all devices)</label>
      <div class="token">
        <code id="token-value">Loading…</code>
        <button id="copy-token-btn" type="button">Copy token</button>
      </div>
    </div>
    <div class="setup-actions">
      <button id="copy-setup-btn" type="button">Copy all for extension</button>
      <button id="regenerate-token-btn" type="button" class="danger">Regenerate token</button>
      <button id="close-device-btn" type="button">Close</button>
    </div>
  </section>
  <script>
    const listEl = document.getElementById("list");
    const emptyEl = document.getElementById("empty");
    const noResultsEl = document.getElementById("no-results");
    const searchInput = document.getElementById("search-input");
    const devicePanel = document.getElementById("device-panel");
    const tokenValue = document.getElementById("token-value");
    const baseUrlEl = document.getElementById("base-url");
    let allRecipes = [];

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
      const imageMarkup = recipe.has_image
        ? '<img class="recipe-image" src="/api/recipes/' + encodeURIComponent(recipe.id) + '/image" alt="" loading="lazy" />'
        : "";
      card.innerHTML = \`
        \${imageMarkup}
        <h2>\${escapeHtml(recipe.title)}</h2>
        <div class="meta">Saved \${formatDate(recipe.updated_at || recipe.created_at)} · <a href="\${escapeHtml(recipe.source_url)}" target="_blank" rel="noreferrer">Source</a></div>
        <div class="card-actions">
          <button class="print-btn" data-id="\${escapeHtml(recipe.id)}" type="button">Print</button>
        </div>
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
      card.querySelector(".print-btn")?.addEventListener("click", (event) => {
        event.stopPropagation();
        const id = event.currentTarget.getAttribute("data-id");
        window.open("/recipes/" + encodeURIComponent(id) + "/print?auto=1", "_blank", "noopener");
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

    function recipeSearchText(recipe) {
      return [
        recipe.title,
        ...(recipe.ingredients || []),
        recipe.prep_time,
        recipe.cook_time,
        recipe.total_time,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
    }

    function matchesSearch(recipe, query) {
      const needle = query.trim().toLowerCase();
      if (!needle) return true;
      return recipeSearchText(recipe).includes(needle);
    }

    function renderRecipes(recipes) {
      const query = searchInput.value || "";
      const filtered = recipes.filter((recipe) => matchesSearch(recipe, query));
      listEl.replaceChildren();
      emptyEl.classList.toggle("hidden", recipes.length > 0);
      noResultsEl.classList.toggle("hidden", filtered.length > 0 || recipes.length === 0);
      for (const recipe of filtered) {
        listEl.appendChild(renderRecipeCard(recipe));
      }
    }

    function applySearch() {
      renderRecipes(allRecipes);
    }

    async function loadRecipes() {
      const response = await fetch("/api/recipes");
      const payload = await response.json();
      const summaries = payload.recipes || [];
      allRecipes = [];
      for (const summary of summaries) {
        const detailResponse = await fetch("/api/recipes/" + encodeURIComponent(summary.id));
        const recipe = await detailResponse.json();
        allRecipes.push(recipe);
      }
      renderRecipes(allRecipes);
    }

    function extensionUrl() {
      if (window.location.port) return window.location.origin;
      const host = window.location.hostname || "YOUR-UMBREL-IP";
      return window.location.protocol + "//" + host + ":4020";
    }

    async function loadDeviceSetup() {
      const response = await fetch("/api/settings/token");
      const payload = await response.json();
      tokenValue.textContent = payload.ingest_token || "";
      baseUrlEl.textContent = extensionUrl();
    }

    function setupClipboardText() {
      return [
        "Recipe Printer extension setup",
        "",
        "Umbrel Recipes URL:",
        baseUrlEl.textContent || "",
        "",
        "Ingest token:",
        tokenValue.textContent || "",
      ].join("\\n");
    }

    function openDevicePanel() {
      devicePanel.classList.remove("hidden");
      loadDeviceSetup();
      devicePanel.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    searchInput.addEventListener("input", applySearch);
    document.getElementById("refresh-btn").addEventListener("click", loadRecipes);
    document.getElementById("add-device-btn").addEventListener("click", openDevicePanel);
    document.getElementById("close-device-btn").addEventListener("click", () => {
      devicePanel.classList.add("hidden");
    });
    document.getElementById("copy-url-btn").addEventListener("click", async () => {
      await navigator.clipboard.writeText(baseUrlEl.textContent || "");
    });
    document.getElementById("copy-token-btn").addEventListener("click", async () => {
      await navigator.clipboard.writeText(tokenValue.textContent || "");
    });
    document.getElementById("copy-setup-btn").addEventListener("click", async () => {
      await navigator.clipboard.writeText(setupClipboardText());
    });
    document.getElementById("regenerate-token-btn").addEventListener("click", async () => {
      if (!confirm("Regenerate token? You will need to update every device using the extension.")) return;
      const response = await fetch("/api/settings/regenerate-token", { method: "POST" });
      const payload = await response.json();
      tokenValue.textContent = payload.ingest_token || "";
    });

    loadRecipes();
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
    const printMatch = route.match(/^\/recipes\/([^/]+)\/print$/);
    if (printMatch && req.method === "GET") {
        const id = decodeURIComponent(printMatch[1]);
        const recipe = await loadRecipe(id);
        if (!recipe) {
            sendText(res, 404, "Recipe not found", "text/plain; charset=utf-8");
            return;
        }
        const autoPrint = url.searchParams.get("auto") === "1";
        sendText(res, 200, renderPrintPage(recipe, autoPrint), "text/html; charset=utf-8");
        return;
    }
    if ((route === "/api/ping" || route === "/api/ingest") && req.method === "GET") {
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
    const imageMatch = route.match(/^\/api\/recipes\/([^/]+)\/image$/);
    if (imageMatch && req.method === "GET") {
        const id = decodeURIComponent(imageMatch[1]);
        const imagePath = findRecipeImagePath(id);
        if (!imagePath) {
            sendJson(res, 404, { error: "Image not found" });
            return;
        }
        const ext = node_path_1.default.extname(imagePath).toLowerCase();
        const contentType = IMAGE_MIME_TYPES[ext] || "application/octet-stream";
        const image = await (0, promises_1.readFile)(imagePath);
        res.writeHead(200, {
            "Content-Type": contentType,
            "Content-Length": image.length,
            "Cache-Control": "public, max-age=86400",
        });
        res.end(image);
        return;
    }
    if (route.startsWith("/api/recipes/") && req.method === "GET") {
        const id = decodeURIComponent(route.slice("/api/recipes/".length));
        const recipe = await loadRecipe(id);
        if (!recipe) {
            sendJson(res, 404, { error: "Recipe not found" });
            return;
        }
        sendJson(res, 200, withImageFlag(recipe));
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
    await seedDefaultRecipes();
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
