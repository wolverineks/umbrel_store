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
const APP_VERSION = "1.0.12";
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
const CATEGORIES_PATH = node_path_1.default.join(DATA_ROOT, "categories.json");
const CATEGORY_ITEMS_PATH = node_path_1.default.join(DATA_ROOT, "category-items.json");
const ICON_PATH = node_path_1.default.join(__dirname, "icon.svg");
const SEED_IMAGES_DIR = node_path_1.default.join(__dirname, "seed-images");
class NotFoundError extends Error {
    constructor(message) {
        super(message);
        this.name = "NotFoundError";
    }
}
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
async function loadCategories() {
    const data = await readJsonFile(CATEGORIES_PATH, { categories: [] });
    const categories = data.categories || [];
    return categories.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}
async function saveCategories(categories) {
    const sorted = [...categories].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    await writeJsonAtomic(CATEGORIES_PATH, { categories: sorted });
}
async function loadCategoryItems() {
    const data = await readJsonFile(CATEGORY_ITEMS_PATH, { items: [] });
    return data.items || [];
}
async function saveCategoryItems(items) {
    await writeJsonAtomic(CATEGORY_ITEMS_PATH, { items });
}
function categoryIdsForRecipe(items, recipeId) {
    return items.filter((item) => item.recipe_id === recipeId).map((item) => item.category_id);
}
function categoryNameTaken(categories, name, exceptId) {
    const lower = name.trim().toLowerCase();
    return categories.some((category) => category.id !== exceptId && category.name.toLowerCase() === lower);
}
async function createCategory(name) {
    const trimmedName = name.trim();
    if (!trimmedName)
        throw new Error("invalid name");
    const categories = await loadCategories();
    if (categoryNameTaken(categories, trimmedName))
        throw new Error("category already exists");
    const category = { id: (0, node_crypto_1.randomUUID)(), name: trimmedName };
    await saveCategories([...categories, category]);
    return category;
}
async function renameCategory(categoryId, name) {
    const trimmedName = name.trim();
    if (!trimmedName)
        throw new Error("invalid name");
    const categories = await loadCategories();
    const index = categories.findIndex((category) => category.id === categoryId);
    if (index < 0)
        throw new NotFoundError("category not found");
    if (categoryNameTaken(categories, trimmedName, categoryId))
        throw new Error("category already exists");
    const category = { ...categories[index], name: trimmedName };
    categories[index] = category;
    await saveCategories(categories);
    return category;
}
async function deleteCategory(categoryId) {
    const categories = await loadCategories();
    const nextCategories = categories.filter((category) => category.id !== categoryId);
    if (nextCategories.length === categories.length)
        throw new NotFoundError("category not found");
    await saveCategories(nextCategories);
    const items = await loadCategoryItems();
    await saveCategoryItems(items.filter((item) => item.category_id !== categoryId));
}
async function assignCategoryRecipe(recipeId, categoryId) {
    const recipe = await loadRecipe(recipeId);
    if (!recipe)
        throw new NotFoundError("recipe not found");
    const categories = await loadCategories();
    if (!categories.some((category) => category.id === categoryId)) {
        throw new NotFoundError("category not found");
    }
    const items = await loadCategoryItems();
    const existing = items.find((item) => item.recipe_id === recipeId && item.category_id === categoryId);
    if (existing)
        return existing;
    const item = { recipe_id: recipeId, category_id: categoryId };
    await saveCategoryItems([...items, item]);
    return item;
}
async function unassignCategoryRecipe(recipeId, categoryId) {
    const items = await loadCategoryItems();
    const next = items.filter((item) => !(item.recipe_id === recipeId && item.category_id === categoryId));
    if (next.length === items.length)
        throw new NotFoundError("category assignment not found");
    await saveCategoryItems(next);
}
async function removeRecipeCategoryItems(recipeId) {
    const items = await loadCategoryItems();
    const next = items.filter((item) => item.recipe_id !== recipeId);
    if (next.length !== items.length)
        await saveCategoryItems(next);
}
async function enrichRecipe(recipe) {
    const items = await loadCategoryItems();
    return {
        ...withImageFlag(recipe),
        category_ids: categoryIdsForRecipe(items, recipe.id),
    };
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
    await removeRecipeCategoryItems(id);
    return true;
}
const DEFAULT_RECIPES = [
    {
        id: "00000000-0000-4000-8000-000000000001",
        image_file: "chocolate-chip-cookies.jpg",
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
        image_file: "spaghetti-aglio-e-olio.jpg",
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
        image_file: "sheet-pan-roast-chicken.jpg",
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
        image_file: "buttermilk-pancakes.jpg",
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
async function copySeedImage(recipeId, filename) {
    const source = node_path_1.default.join(SEED_IMAGES_DIR, filename);
    if (!(0, node_fs_1.existsSync)(source)) {
        console.warn(`Seed image not found: ${filename}`);
        return false;
    }
    const ext = node_path_1.default.extname(filename).toLowerCase();
    if (!IMAGE_EXTENSIONS.includes(ext))
        return false;
    await (0, promises_1.mkdir)(IMAGES_DIR, { recursive: true });
    await deleteRecipeImage(recipeId);
    await (0, promises_1.writeFile)(imageFilePath(recipeId, ext), await (0, promises_1.readFile)(source));
    return true;
}
async function seedDefaultRecipes() {
    const index = await loadIndex();
    if (index.length > 0)
        return;
    const now = new Date().toISOString();
    const entries = [];
    for (const seed of DEFAULT_RECIPES) {
        const { image_file: imageFile, ...recipeFields } = seed;
        const recipe = {
            ...recipeFields,
            created_at: now,
            updated_at: now,
        };
        await writeJsonAtomic(recipePath(recipe.id), recipe);
        await copySeedImage(recipe.id, imageFile);
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
async function seedDefaultRecipeImages() {
    let copied = 0;
    for (const seed of DEFAULT_RECIPES) {
        if (recipeHasImage(seed.id))
            continue;
        const recipe = await loadRecipe(seed.id);
        if (!recipe)
            continue;
        if (await copySeedImage(seed.id, seed.image_file))
            copied += 1;
    }
    if (copied > 0)
        console.log(`Added images to ${copied} sample recipes`);
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
      border-bottom: 2px solid #2563eb;
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
      color: #2563eb;
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
      color: #2563eb;
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
const RECIPES_PAGE_STYLES = `
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
  --shadow-color: 15, 23, 42;
  --overlay: rgba(15, 23, 42, 0.45);
  --danger: #b91c1c;
  --danger-text: #991b1b;
  --danger-bg: #fef2f2;
  --danger-border: #fecaca;
}
html[data-theme="dark"] {
  color-scheme: dark;
  --bg: #0f172a;
  --panel: #1e293b;
  --border: #334155;
  --text: #f1f5f9;
  --muted: #94a3b8;
  --accent: #60a5fa;
  --accent-soft: #1e3a5f;
  --sidebar: #111827;
  --shadow-color: 0, 0, 0;
  --overlay: rgba(0, 0, 0, 0.62);
  --danger: #f87171;
  --danger-text: #fecaca;
  --danger-bg: #450a0a;
  --danger-border: #7f1d1d;
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
  min-height: 0;
  overflow: hidden;
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
.nav { display: grid; gap: 0.35rem; }
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
.sidebar-note {
  margin: 0;
  padding: 0.25rem 0.75rem;
  font-size: 0.8rem;
  color: var(--muted);
  line-height: 1.45;
}
.sidebar-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.sidebar-section {
  padding-top: 0.75rem;
  border-top: 1px solid var(--border);
}
.sidebar-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding-right: 0.75rem;
}
.sidebar-section-label {
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
  padding: 0 0.75rem 0.5rem;
}
.categories-add {
  border: 0;
  background: transparent;
  color: var(--accent);
  font: inherit;
  font-size: 1.1rem;
  line-height: 1;
  cursor: pointer;
  padding: 0.15rem 0.35rem;
  border-radius: 0.4rem;
}
.categories-add:hover { background: var(--accent-soft); }
.categories-list { display: grid; gap: 0.2rem; }
.categories-empty {
  padding: 0.35rem 0.75rem;
  color: var(--muted);
  font-size: 0.85rem;
}
.category-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  border: 0;
  background: transparent;
  padding: 0.55rem 0.75rem;
  border-radius: 0.65rem;
  font: inherit;
  color: var(--text);
  cursor: pointer;
  text-align: left;
  width: 100%;
  min-width: 0;
}
.category-item:hover,
.category-item.active,
.category-item.drop-target {
  background: var(--accent-soft);
  color: var(--accent);
}
.category-icon { flex-shrink: 0; font-size: 0.95rem; line-height: 1; }
.category-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sidebar-footer {
  margin-top: auto;
  padding-top: 0.75rem;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}
main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 100vh;
}
.sidebar-backdrop { display: none; }
.sidebar-toggle {
  display: none;
  flex-shrink: 0;
  border: 0;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  width: 2.25rem;
  height: 2.25rem;
  border-radius: 999px;
  font: inherit;
  font-size: 1.1rem;
  line-height: 1;
  place-items: center;
}
.sidebar-toggle:hover,
.theme-toggle:hover {
  background: var(--accent-soft);
  color: var(--accent);
}
.search-bar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1.25rem;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  z-index: 20;
}
.search {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex: 1;
  min-width: 0;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0.35rem 0.35rem 0.35rem 1rem;
  color: var(--muted);
}
.search-icon { flex-shrink: 0; line-height: 1; }
.search input {
  border: 0;
  background: transparent;
  flex: 1;
  min-width: 0;
  font: inherit;
  color: var(--text);
  padding: 0.3rem 0;
}
.search input:focus { outline: none; }
.theme-toggle {
  flex-shrink: 0;
  border: 0;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  width: 2.25rem;
  height: 2.25rem;
  border-radius: 999px;
  font: inherit;
  font-size: 1rem;
  line-height: 1;
  display: grid;
  place-items: center;
}
.topbar {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  flex-wrap: wrap;
  padding: 0.85rem 1.25rem;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
}
.toolbar { display: flex; gap: 0.5rem; flex-wrap: wrap; }
button.primary {
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
button.danger-btn {
  border: 1px solid var(--danger-border);
  border-radius: 999px;
  background: var(--danger-bg);
  color: var(--danger);
  padding: 0.65rem 1rem;
  font: inherit;
  cursor: pointer;
}
.content {
  padding: 1.25rem;
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.listing-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 1rem;
}
.status { color: var(--muted); font-size: 0.95rem; }
.view-toggle {
  display: flex;
  gap: 0.2rem;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 0.65rem;
  padding: 0.2rem;
  flex-shrink: 0;
}
.view-toggle-btn {
  border: 0;
  background: transparent;
  color: var(--muted);
  width: 2rem;
  height: 2rem;
  border-radius: 0.45rem;
  font: inherit;
  font-size: 0.95rem;
  line-height: 1;
  cursor: pointer;
  display: grid;
  place-items: center;
}
.view-toggle-btn:hover { color: var(--text); background: var(--panel); }
.view-toggle-btn.active {
  background: var(--accent-soft);
  color: var(--accent);
}
.list-header {
  display: none;
  gap: 0.75rem;
  align-items: center;
  padding: 0.35rem 0.85rem;
  margin-bottom: 0.15rem;
  border-bottom: 1px solid var(--border);
}
.list-header.visible {
  display: grid;
  grid-template-columns: 2.75rem minmax(11rem, 1.4fr) 8.5rem 5.5rem minmax(6rem, 0.9fr) 4.5rem;
}
.list-header-spacer { min-width: 0; }
.list-header-cell {
  font-size: 0.72rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
  text-align: left;
  min-width: 0;
}
.list-header-cell.sortable {
  border: 0;
  background: transparent;
  font: inherit;
  cursor: pointer;
  padding: 0;
}
.list-header-cell.sortable:hover,
.list-header-cell.sortable.active { color: var(--accent); }
.list-header-cell.cell-saved,
.grid.list-view .cell-saved { text-align: right; }
.list-header-cell.cell-actions,
.grid.list-view .cell-actions { text-align: right; }
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 0.85rem;
}
.card {
  position: relative;
  min-width: 0;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 0.9rem;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
  cursor: pointer;
  transition: box-shadow 0.15s ease, transform 0.15s ease;
}
.card:hover {
  box-shadow: 0 10px 24px rgba(var(--shadow-color), 0.08);
  transform: translateY(-1px);
}
.card.open {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}
.card.dragging {
  opacity: 0.45;
}
.card-categories {
  color: var(--muted);
  font-size: 0.75rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dialog-backdrop {
  position: fixed;
  inset: 0;
  background: var(--overlay);
  display: none;
  place-items: center;
  padding: 1rem;
  z-index: 1100;
}
.dialog-backdrop.open { display: grid; }
.dialog {
  width: min(100%, 24rem);
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 1rem;
  padding: 1.25rem;
  box-shadow: 0 24px 48px rgba(var(--shadow-color), 0.18);
}
.dialog h2 { margin: 0 0 0.35rem; font-size: 1.1rem; }
.dialog input {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 0.65rem;
  padding: 0.75rem 0.85rem;
  font: inherit;
  background: var(--panel);
  color: var(--text);
  margin: 0.75rem 0 1rem;
}
.dialog input:focus {
  outline: 2px solid var(--accent-soft);
  border-color: var(--accent);
}
.dialog-actions {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
  flex-wrap: wrap;
}
.recipe-image {
  width: 100%;
  aspect-ratio: 16 / 10;
  object-fit: cover;
  border-radius: 0.65rem;
  display: block;
  margin: -0.15rem 0 0.15rem;
}
.card .name {
  margin: 0;
  font-weight: 600;
  font-size: 1rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card .meta,
.card .times {
  color: var(--muted);
  font-size: 0.85rem;
  line-height: 1.4;
}
.card-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.list-only { display: none; }
.grid.list-view {
  --list-cols: 2.75rem minmax(11rem, 1.4fr) 8.5rem 5.5rem minmax(6rem, 0.9fr) 4.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.grid.list-view .card {
  display: grid;
  grid-template-columns: var(--list-cols);
  align-items: center;
  min-height: auto;
  padding: 0.6rem 0.85rem;
  gap: 0.75rem;
  border-radius: 0.65rem;
  flex-direction: unset;
}
.grid.list-view .card:hover { transform: none; }
.grid.list-view .grid-only { display: none !important; }
.grid.list-view .list-only { display: block; }
.grid.list-view .cell-thumb {
  width: 2.25rem;
  height: 2.25rem;
  border-radius: 0.45rem;
  overflow: hidden;
  background: var(--bg);
  border: 1px solid var(--border);
  display: grid;
  place-items: center;
  color: var(--muted);
  font-size: 0.85rem;
}
.grid.list-view .cell-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.grid.list-view .card .name {
  min-width: 0;
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.grid.list-view .cell-saved,
.grid.list-view .cell-total,
.grid.list-view .cell-categories {
  color: var(--muted);
  font-size: 0.85rem;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.grid.list-view .cell-actions {
  display: flex;
  justify-content: flex-end;
}
.grid.list-view .cell-actions .print-btn {
  padding: 0.4rem 0.7rem;
  font-size: 0.8rem;
}
.grid.list-view .card .detail {
  grid-column: 1 / -1;
}
.grid.list-view .card-actions.grid-only { display: none; }
.detail {
  display: none;
  margin-top: 0.35rem;
  padding-top: 0.85rem;
  border-top: 1px solid var(--border);
  font-size: 0.92rem;
  line-height: 1.55;
}
.card.open .detail { display: block; }
.columns {
  display: grid;
  grid-template-columns: 1fr 1.2fr;
  gap: 1rem;
  margin-top: 0.75rem;
}
.detail h3 {
  margin: 0 0 0.5rem;
  font-size: 0.78rem;
  color: var(--accent);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.detail ul, .detail ol { margin: 0; padding-left: 1.2rem; }
.panel {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 1rem;
  padding: 1.25rem;
  margin-bottom: 1rem;
  box-shadow: 0 10px 24px rgba(var(--shadow-color), 0.06);
}
.panel h2 { margin: 0 0 0.5rem; font-size: 1.2rem; }
.panel p { margin: 0; color: var(--muted); line-height: 1.5; }
.token {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 0.65rem;
}
code {
  background: var(--bg);
  border: 1px solid var(--border);
  padding: 0.55rem 0.75rem;
  border-radius: 0.65rem;
  word-break: break-all;
  font-size: 0.8rem;
}
.empty {
  padding: 2rem;
  border: 1px dashed var(--border);
  border-radius: 1rem;
  background: var(--panel);
  color: var(--muted);
  text-align: center;
}
.setup-steps {
  margin: 1rem 0 0;
  padding-left: 1.25rem;
  line-height: 1.6;
  font-size: 0.92rem;
}
.setup-steps li + li { margin-top: 0.65rem; }
.setup-field { margin-top: 1rem; }
.setup-field label {
  display: block;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--muted);
  margin-bottom: 0.4rem;
}
.setup-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-top: 1rem;
}
a { color: var(--accent); }
.hidden { display: none; }
.app-version {
  position: fixed;
  right: 0.85rem;
  bottom: 0.45rem;
  font-size: 0.68rem;
  color: var(--muted);
  opacity: 0.45;
  pointer-events: none;
  user-select: none;
}
@media (max-width: 800px) {
  body { grid-template-columns: 1fr; }
  body.sidebar-open { overflow: hidden; }
  .sidebar-toggle { display: grid; }
  .sidebar-backdrop {
    position: fixed;
    inset: 0;
    background: var(--overlay);
    z-index: 1050;
  }
  body.sidebar-open .sidebar-backdrop { display: block; }
  aside {
    position: fixed;
    left: 0;
    top: 0;
    bottom: 0;
    width: min(280px, 85vw);
    z-index: 1060;
    transform: translateX(-100%);
    transition: transform 0.2s ease;
  }
  body.sidebar-open aside { transform: translateX(0); }
}
@media (max-width: 720px) {
  .columns { grid-template-columns: 1fr; }
}
`;
const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="theme-color" content="#2563eb" />
  <link rel="icon" href="/icon.svg" type="image/svg+xml" />
  <title>Recipes</title>
  <style>${RECIPES_PAGE_STYLES}</style>
  <script>
    (function () {
      try {
        var saved = localStorage.getItem("recipes-theme");
        var theme = saved === "light" || saved === "dark"
          ? saved
          : (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
        document.documentElement.dataset.theme = theme;
      } catch (e) {}
    })();
  </script>
</head>
<body>
  <div id="sidebar-backdrop" class="sidebar-backdrop" aria-hidden="true"></div>
  <aside id="app-sidebar">
    <div class="brand">
      <div class="brand-badge">R</div>
      <span>Recipes</span>
    </div>
    <nav class="nav">
      <button id="nav-library" class="active" type="button">Library</button>
      <button id="nav-refresh" type="button">Refresh</button>
      <button id="nav-device" type="button">Add device</button>
    </nav>
    <div class="sidebar-scroll">
      <div class="sidebar-section categories-section">
        <div class="sidebar-section-header">
          <div class="sidebar-section-label">Categories</div>
          <button id="add-category" class="categories-add" type="button" title="New category" aria-label="New category">+</button>
        </div>
        <div id="categories-list" class="categories-list"></div>
      </div>
    </div>
    <div class="sidebar-footer">
      <p class="sidebar-note">Saved from the Recipe Printer Chrome extension.</p>
    </div>
  </aside>
  <main>
    <div class="search-bar">
      <button id="sidebar-toggle" class="sidebar-toggle" type="button" aria-label="Open menu">☰</button>
      <label class="search">
        <span class="search-icon" aria-hidden="true">⌕</span>
        <input
          id="search-input"
          type="search"
          placeholder="Search by name, ingredients, prep time, cook time, or total time…"
          autocomplete="off"
          spellcheck="false"
        />
      </label>
      <button id="theme-toggle" class="theme-toggle" type="button" aria-label="Switch to dark mode" title="Dark mode">☾</button>
    </div>
    <div class="content">
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
        <button id="copy-url-btn" class="secondary" type="button">Copy URL</button>
      </div>
    </div>
    <div class="setup-field">
      <label>Ingest token (same for all devices)</label>
      <div class="token">
        <code id="token-value">Loading…</code>
        <button id="copy-token-btn" class="secondary" type="button">Copy token</button>
      </div>
    </div>
    <div class="setup-actions">
      <button id="copy-setup-btn" class="secondary" type="button">Copy all for extension</button>
      <button id="regenerate-token-btn" class="danger-btn" type="button">Regenerate token</button>
      <button id="close-device-btn" class="secondary" type="button">Close</button>
    </div>
      </section>
      <div class="listing-header">
        <div id="recipe-status" class="status"></div>
        <div class="view-toggle" role="group" aria-label="Layout view">
          <button id="view-grid" class="view-toggle-btn active" type="button" title="Grid view" aria-label="Grid view" aria-pressed="true">▦</button>
          <button id="view-list" class="view-toggle-btn" type="button" title="List view" aria-label="List view" aria-pressed="false">≡</button>
        </div>
      </div>
      <div id="list-header" class="list-header" role="row" hidden></div>
      <div id="list" class="grid"></div>
      <div id="empty" class="empty hidden">No recipes saved yet. Click “Add new device” to set up the Chrome extension.</div>
      <div id="no-results" class="empty hidden">No recipes match your search.</div>
    </div>
  </main>
  <div id="category-dialog" class="dialog-backdrop" aria-hidden="true">
    <div class="dialog" role="dialog" aria-labelledby="category-dialog-title">
      <h2 id="category-dialog-title">New category</h2>
      <input id="category-name-input" type="text" placeholder="Category name" autocomplete="off" maxlength="80" />
      <div class="dialog-actions">
        <button id="category-cancel" class="secondary" type="button">Cancel</button>
        <button id="category-submit" class="primary" type="button">Save</button>
      </div>
    </div>
  </div>
  <div class="app-version" aria-hidden="true">v${APP_VERSION}</div>
  <script>
    const listEl = document.getElementById("list");
    const emptyEl = document.getElementById("empty");
    const noResultsEl = document.getElementById("no-results");
    const searchInput = document.getElementById("search-input");
    const devicePanel = document.getElementById("device-panel");
    const recipeStatus = document.getElementById("recipe-status");
    const navLibrary = document.getElementById("nav-library");
    const navDevice = document.getElementById("nav-device");
    const tokenValue = document.getElementById("token-value");
    const baseUrlEl = document.getElementById("base-url");
    const DRAG_MIME = "application/x-recipes-entry";
    let allRecipes = [];
    let categories = [];
    let activeCategoryId = null;
    let dragRecipe = null;
    let categoryDialogMode = "create";
    let categoryDialogTargetId = null;
    let layoutView = "grid";
    let sortBy = "saved";
    let sortDir = "desc";

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

    function formatTimes(recipe) {
      return [
        recipe.prep_time ? "Prep " + recipe.prep_time : "",
        recipe.cook_time ? "Cook " + recipe.cook_time : "",
        recipe.total_time ? "Total " + recipe.total_time : "",
      ].filter(Boolean).join(" · ");
    }

    function categoryLabelText(recipe) {
      const ids = new Set(recipe.category_ids || []);
      return categories
        .filter((category) => ids.has(category.id))
        .map((category) => category.name)
        .join(", ");
    }

    function isInternalDrag(event) {
      return Array.from(event.dataTransfer?.types || []).includes(DRAG_MIME);
    }

    function clearDropTargets() {
      document.querySelectorAll(".drop-target").forEach((node) => {
        node.classList.remove("drop-target");
      });
    }

    function readDragRecipe(dataTransfer) {
      try {
        return JSON.parse(dataTransfer.getData(DRAG_MIME));
      } catch {
        return null;
      }
    }

    function dragRecipePayload(recipe) {
      return JSON.stringify({ id: recipe.id, title: recipe.title });
    }

    function canAssignCategory(recipe, categoryId) {
      return recipe?.id && categoryId && !(recipe.category_ids || []).includes(categoryId);
    }

    async function assignCategory(recipeId, categoryId) {
      const response = await fetch("/api/categories/assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipe_id: recipeId, categoryId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not add to category");
      await loadRecipes();
    }

    function bindCategoryDropTarget(button) {
      if (button.dataset.dropBound === "true") return;
      button.dataset.dropBound = "true";
      const categoryId = button.dataset.id;

      button.addEventListener("dragover", (event) => {
        if (!isInternalDrag(event)) return;
        const recipe = dragRecipe;
        if (!recipe || !canAssignCategory(recipe, categoryId)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        button.classList.add("drop-target");
      });

      button.addEventListener("dragleave", (event) => {
        if (!button.contains(event.relatedTarget)) {
          button.classList.remove("drop-target");
        }
      });

      button.addEventListener("drop", async (event) => {
        if (!isInternalDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        clearDropTargets();
        const recipe = readDragRecipe(event.dataTransfer) || dragRecipe;
        if (!recipe || !canAssignCategory(recipe, categoryId)) return;
        try {
          await assignCategory(recipe.id, categoryId);
        } catch (error) {
          alert(error.message || "Could not add to category.");
        }
      });
    }

    function bindRecipeCardDrag(card, recipe) {
      card.setAttribute("draggable", "true");
      card.addEventListener("dragstart", (event) => {
        dragRecipe = recipe;
        event.dataTransfer.setData(DRAG_MIME, dragRecipePayload(recipe));
        event.dataTransfer.effectAllowed = "move";
        card.classList.add("dragging");
      });
      card.addEventListener("dragend", () => {
        card.classList.remove("dragging");
        dragRecipe = null;
        clearDropTargets();
      });
    }

    function renderCategoriesSidebar() {
      const root = document.getElementById("categories-list");
      if (!root) return;
      if (!categories.length) {
        root.innerHTML = '<div class="categories-empty">Create categories, then drag recipes onto them</div>';
        return;
      }
      root.innerHTML = categories.map((category) => {
        const active = activeCategoryId === category.id;
        return \`
          <button
            type="button"
            class="category-item\${active ? " active" : ""}"
            data-id="\${escapeHtml(category.id)}"
            data-name="\${escapeHtml(category.name)}"
          >
            <span class="category-icon" aria-hidden="true">🏷</span>
            <span class="category-name">\${escapeHtml(category.name)}</span>
          </button>\`;
      }).join("");

      root.querySelectorAll(".category-item").forEach((button) => {
        button.addEventListener("click", () => {
          activeCategoryId = button.dataset.id;
          devicePanel.classList.add("hidden");
          setActiveNav("library");
          renderCategoriesSidebar();
          renderRecipes(allRecipes);
          closeSidebar();
        });
        button.addEventListener("dblclick", (event) => {
          event.preventDefault();
          openCategoryDialog("rename", {
            id: button.dataset.id,
            name: button.dataset.name,
          });
        });
        button.addEventListener("contextmenu", async (event) => {
          event.preventDefault();
          const name = button.dataset.name || "category";
          if (!confirm('Delete category "' + name + '"? Recipes stay in your library.')) return;
          const response = await fetch("/api/categories/delete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: button.dataset.id }),
          });
          if (!response.ok) {
            alert("Failed to delete category.");
            return;
          }
          if (activeCategoryId === button.dataset.id) activeCategoryId = null;
          await loadRecipes();
        });
        bindCategoryDropTarget(button);
      });
    }

    async function refreshCategories() {
      const response = await fetch("/api/categories");
      const data = await response.json();
      categories = data.categories || [];
      renderCategoriesSidebar();
    }

    function openCategoryDialog(mode, category) {
      categoryDialogMode = mode;
      categoryDialogTargetId = category?.id || null;
      const dialog = document.getElementById("category-dialog");
      const title = document.getElementById("category-dialog-title");
      const input = document.getElementById("category-name-input");
      title.textContent = mode === "rename" ? "Rename category" : "New category";
      input.value = category?.name || "";
      dialog.classList.add("open");
      dialog.setAttribute("aria-hidden", "false");
      input.focus();
      input.select();
    }

    function closeCategoryDialog() {
      const dialog = document.getElementById("category-dialog");
      dialog.classList.remove("open");
      dialog.setAttribute("aria-hidden", "true");
      categoryDialogTargetId = null;
    }

    async function submitCategoryDialog() {
      const input = document.getElementById("category-name-input");
      const name = (input.value || "").trim();
      if (!name) return;
      const endpoint = categoryDialogMode === "rename" ? "/api/categories/rename" : "/api/categories/create";
      const body = categoryDialogMode === "rename"
        ? { id: categoryDialogTargetId, name }
        : { name };
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) {
        alert(data.error || "Could not save category.");
        return;
      }
      closeCategoryDialog();
      await loadRecipes();
    }

    function loadLayoutAndSort() {
      try {
        const savedView = localStorage.getItem("recipes-layout-view");
        if (savedView === "grid" || savedView === "list") layoutView = savedView;
        const savedSort = localStorage.getItem("recipes-sort");
        if (savedSort) {
          const parsed = JSON.parse(savedSort);
          if (parsed.by) sortBy = parsed.by;
          if (parsed.dir === "asc" || parsed.dir === "desc") sortDir = parsed.dir;
        }
      } catch {}
    }

    function saveLayoutView() {
      try { localStorage.setItem("recipes-layout-view", layoutView); } catch {}
    }

    function saveSort() {
      try { localStorage.setItem("recipes-sort", JSON.stringify({ by: sortBy, dir: sortDir })); } catch {}
    }

    function defaultSortDir(column) {
      if (column === "name") return "asc";
      return "desc";
    }

    function sortHeaderIndicator(column) {
      if (sortBy !== column) return "";
      return sortDir === "asc" ? " ↑" : " ↓";
    }

    function sortValue(recipe, column) {
      if (column === "name") return (recipe.title || "").toLowerCase();
      if (column === "saved") return new Date(recipe.updated_at || recipe.created_at).getTime() || 0;
      if (column === "total") return (recipe.total_time || "").toLowerCase();
      if (column === "categories") return categoryLabelText(recipe).toLowerCase();
      return "";
    }

    function sortRecipes(recipes) {
      const dir = sortDir === "asc" ? 1 : -1;
      return [...recipes].sort((a, b) => {
        const av = sortValue(a, sortBy);
        const bv = sortValue(b, sortBy);
        if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
        return String(av).localeCompare(String(bv)) * dir;
      });
    }

    function listHeaderColumns() {
      return [
        { id: "name", label: "Name", sortable: true, className: "cell-name" },
        { id: "saved", label: "Saved", sortable: true, className: "cell-saved" },
        { id: "total", label: "Total", sortable: true, className: "cell-total" },
        { id: "categories", label: "Categories", sortable: true, className: "cell-categories" },
        { id: "", label: "", sortable: false, className: "cell-actions" },
      ];
    }

    function renderListHeader() {
      const header = document.getElementById("list-header");
      if (!header) return;
      if (layoutView !== "list") {
        header.hidden = true;
        header.classList.remove("visible");
        header.innerHTML = "";
        return;
      }
      header.hidden = false;
      header.classList.add("visible");
      header.innerHTML =
        '<div class="list-header-spacer" aria-hidden="true"></div>' +
        listHeaderColumns()
          .map((column) => {
            if (!column.sortable) {
              return '<div class="list-header-cell ' + column.className + '"></div>';
            }
            const active = sortBy === column.id ? " active" : "";
            const indicator = sortHeaderIndicator(column.id);
            return '<button type="button" class="list-header-cell sortable ' + column.className + active + '" data-list-sort="' + column.id + '">' + escapeHtml(column.label) + indicator + '</button>';
          })
          .join("");
    }

    function bindListHeader() {
      const header = document.getElementById("list-header");
      if (!header || header.dataset.bound === "true") return;
      header.dataset.bound = "true";
      header.addEventListener("click", (event) => {
        const button = event.target.closest("[data-list-sort]");
        if (!button) return;
        const next = button.getAttribute("data-list-sort");
        if (!next) return;
        if (sortBy === next) {
          sortDir = sortDir === "asc" ? "desc" : "asc";
        } else {
          sortBy = next;
          sortDir = defaultSortDir(next);
        }
        saveSort();
        renderListHeader();
        renderRecipes();
      });
    }

    function applyLayoutView() {
      listEl.classList.toggle("list-view", layoutView === "list");
      const gridButton = document.getElementById("view-grid");
      const listButton = document.getElementById("view-list");
      gridButton?.classList.toggle("active", layoutView === "grid");
      listButton?.classList.toggle("active", layoutView === "list");
      gridButton?.setAttribute("aria-pressed", layoutView === "grid" ? "true" : "false");
      listButton?.setAttribute("aria-pressed", layoutView === "list" ? "true" : "false");
      renderListHeader();
    }

    function setLayoutView(next) {
      if (next !== "grid" && next !== "list") return;
      if (layoutView === next) return;
      layoutView = next;
      saveLayoutView();
      applyLayoutView();
      renderRecipes();
    }

    function renderRecipeCard(recipe) {
      const card = document.createElement("article");
      card.className = "card";
      const imageUrl = recipe.has_image
        ? "/api/recipes/" + encodeURIComponent(recipe.id) + "/image"
        : "";
      const imageMarkup = imageUrl
        ? '<img class="recipe-image grid-only" src="' + imageUrl + '" alt="" loading="lazy" />'
        : "";
      const thumbMarkup = imageUrl
        ? '<div class="cell-thumb list-only"><img src="' + imageUrl + '" alt="" loading="lazy" /></div>'
        : '<div class="cell-thumb list-only" aria-hidden="true">🍽</div>';
      const times = formatTimes(recipe);
      const categoryText = categoryLabelText(recipe);
      const savedText = formatDate(recipe.updated_at || recipe.created_at);
      const totalText = recipe.total_time || "—";
      card.innerHTML = \`
        \${thumbMarkup}
        \${imageMarkup}
        <h2 class="name">\${escapeHtml(recipe.title)}</h2>
        <div class="meta grid-only">Saved \${escapeHtml(savedText)} · <a href="\${escapeHtml(recipe.source_url)}" target="_blank" rel="noreferrer">Source</a></div>
        \${categoryText ? '<div class="card-categories grid-only">' + escapeHtml(categoryText) + '</div>' : ''}
        \${times ? '<div class="times grid-only">' + escapeHtml(times) + '</div>' : ''}
        <div class="cell-saved list-only">\${escapeHtml(savedText)}</div>
        <div class="cell-total list-only">\${escapeHtml(totalText)}</div>
        <div class="cell-categories list-only">\${escapeHtml(categoryText || "—")}</div>
        <div class="card-actions grid-only">
          <button class="secondary print-btn" data-id="\${escapeHtml(recipe.id)}" type="button">Print</button>
        </div>
        <div class="cell-actions list-only">
          <button class="secondary print-btn" data-id="\${escapeHtml(recipe.id)}" type="button">Print</button>
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
          <button class="danger-btn delete-btn" data-id="\${escapeHtml(recipe.id)}" type="button">Delete</button>
        </div>
      \`;
      card.addEventListener("click", (event) => {
        if (event.target.closest("a, button")) return;
        card.classList.toggle("open");
      });
      card.querySelectorAll(".print-btn").forEach((button) => {
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          const id = event.currentTarget.getAttribute("data-id");
          window.open("/recipes/" + encodeURIComponent(id) + "/print?auto=1", "_blank", "noopener");
        });
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
      bindRecipeCardDrag(card, recipe);
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

    function recipesForView() {
      let recipes = allRecipes;
      if (activeCategoryId) {
        recipes = recipes.filter((recipe) => (recipe.category_ids || []).includes(activeCategoryId));
      }
      const query = searchInput.value || "";
      return recipes.filter((recipe) => matchesSearch(recipe, query));
    }

    function renderRecipes() {
      const scoped = activeCategoryId
        ? allRecipes.filter((recipe) => (recipe.category_ids || []).includes(activeCategoryId))
        : allRecipes;
      const filtered = recipesForView();
      listEl.replaceChildren();
      emptyEl.classList.toggle("hidden", allRecipes.length > 0);
      noResultsEl.classList.toggle("hidden", filtered.length > 0 || allRecipes.length === 0);
      listEl.classList.toggle("hidden", filtered.length === 0);

      if (allRecipes.length === 0) {
        recipeStatus.textContent = "";
      } else {
        const categoryName = categories.find((category) => category.id === activeCategoryId)?.name;
        const scopeLabel = categoryName ? ' in "' + categoryName + '"' : "";
        const query = (searchInput.value || "").trim();
        if (query) {
          recipeStatus.textContent = filtered.length + " of " + scoped.length + " recipes" + scopeLabel;
        } else {
          recipeStatus.textContent = scoped.length + (scoped.length === 1 ? " recipe" : " recipes") + scopeLabel;
        }
      }

      for (const recipe of sortRecipes(filtered)) {
        listEl.appendChild(renderRecipeCard(recipe));
      }
      renderListHeader();
    }

    function applySearch() {
      renderRecipes();
    }

    async function loadRecipes() {
      await refreshCategories();
      const response = await fetch("/api/recipes");
      const payload = await response.json();
      const summaries = payload.recipes || [];
      allRecipes = [];
      for (const summary of summaries) {
        const detailResponse = await fetch("/api/recipes/" + encodeURIComponent(summary.id));
        const recipe = await detailResponse.json();
        allRecipes.push(recipe);
      }
      renderRecipes();
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

    function setActiveNav(view) {
      navLibrary.classList.toggle("active", view === "library");
      navDevice.classList.toggle("active", view === "device");
    }

    function showLibrary() {
      devicePanel.classList.add("hidden");
      activeCategoryId = null;
      setActiveNav("library");
      renderCategoriesSidebar();
      renderRecipes();
    }

    function closeSidebar() {
      document.body.classList.remove("sidebar-open");
      document.getElementById("sidebar-toggle")?.setAttribute("aria-expanded", "false");
    }

    function openSidebar() {
      document.body.classList.add("sidebar-open");
      document.getElementById("sidebar-toggle")?.setAttribute("aria-expanded", "true");
    }

    function closeDevicePanel() {
      devicePanel.classList.add("hidden");
      if (!activeCategoryId) setActiveNav("library");
    }

    function openDevicePanel() {
      devicePanel.classList.remove("hidden");
      setActiveNav("device");
      loadDeviceSetup();
      closeSidebar();
      devicePanel.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    function resolveTheme() {
      try {
        const saved = localStorage.getItem("recipes-theme");
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
        button.setAttribute("aria-label", next === "dark" ? "Switch to light mode" : "Switch to dark mode");
        button.title = next === "dark" ? "Light mode" : "Dark mode";
      }
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", next === "dark" ? "#0f172a" : "#2563eb");
    }

    function toggleTheme() {
      const current = document.documentElement.dataset.theme || resolveTheme();
      const next = current === "dark" ? "light" : "dark";
      try { localStorage.setItem("recipes-theme", next); } catch {}
      applyTheme(next);
    }

    searchInput.addEventListener("input", applySearch);
    document.getElementById("nav-refresh").addEventListener("click", async () => {
      closeSidebar();
      await loadRecipes();
    });
    document.getElementById("nav-device").addEventListener("click", openDevicePanel);
    document.getElementById("nav-library").addEventListener("click", showLibrary);
    document.getElementById("add-category").addEventListener("click", () => openCategoryDialog("create"));
    document.getElementById("category-cancel").addEventListener("click", closeCategoryDialog);
    document.getElementById("category-submit").addEventListener("click", submitCategoryDialog);
    document.getElementById("category-name-input").addEventListener("keydown", (event) => {
      if (event.key === "Enter") submitCategoryDialog();
      if (event.key === "Escape") closeCategoryDialog();
    });
    document.getElementById("category-dialog").addEventListener("click", (event) => {
      if (event.target.id === "category-dialog") closeCategoryDialog();
    });
    document.getElementById("close-device-btn").addEventListener("click", closeDevicePanel);
    document.getElementById("sidebar-toggle").addEventListener("click", () => {
      if (document.body.classList.contains("sidebar-open")) closeSidebar();
      else openSidebar();
    });
    document.getElementById("sidebar-backdrop").addEventListener("click", closeSidebar);
    document.getElementById("theme-toggle").addEventListener("click", toggleTheme);
    applyTheme(resolveTheme());
    loadLayoutAndSort();
    bindListHeader();
    applyLayoutView();
    document.getElementById("view-grid").addEventListener("click", () => setLayoutView("grid"));
    document.getElementById("view-list").addEventListener("click", () => setLayoutView("list"));
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
        sendJson(res, 200, await enrichRecipe(recipe));
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
    if (route === "/api/categories" && req.method === "GET") {
        sendJson(res, 200, { categories: await loadCategories() });
        return;
    }
    if (route === "/api/categories/create" && req.method === "POST") {
        try {
            const body = JSON.parse(await readBody(req));
            const name = (body.name ?? "").trim();
            if (!name) {
                sendJson(res, 400, { error: "name is required" });
                return;
            }
            const category = await createCategory(name);
            sendJson(res, 201, { category });
        }
        catch (error) {
            if (error instanceof Error && error.message === "category already exists") {
                sendJson(res, 409, { error: error.message });
            }
            else if (error instanceof Error && error.message === "invalid name") {
                sendJson(res, 400, { error: error.message });
            }
            else {
                sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid request" });
            }
        }
        return;
    }
    if (route === "/api/categories/rename" && req.method === "POST") {
        try {
            const body = JSON.parse(await readBody(req));
            const id = (body.id ?? "").trim();
            const name = (body.name ?? "").trim();
            if (!id) {
                sendJson(res, 400, { error: "id is required" });
                return;
            }
            if (!name) {
                sendJson(res, 400, { error: "name is required" });
                return;
            }
            const category = await renameCategory(id, name);
            sendJson(res, 200, { category });
        }
        catch (error) {
            if (error instanceof NotFoundError) {
                sendJson(res, 404, { error: "category not found" });
            }
            else if (error instanceof Error && error.message === "category already exists") {
                sendJson(res, 409, { error: error.message });
            }
            else if (error instanceof Error && error.message === "invalid name") {
                sendJson(res, 400, { error: error.message });
            }
            else {
                sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid request" });
            }
        }
        return;
    }
    if (route === "/api/categories/delete" && req.method === "POST") {
        try {
            const body = JSON.parse(await readBody(req));
            const id = (body.id ?? "").trim();
            if (!id) {
                sendJson(res, 400, { error: "id is required" });
                return;
            }
            await deleteCategory(id);
            sendJson(res, 200, { ok: true });
        }
        catch (error) {
            if (error instanceof NotFoundError) {
                sendJson(res, 404, { error: "category not found" });
            }
            else {
                sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid request" });
            }
        }
        return;
    }
    if (route === "/api/categories/assign" && req.method === "POST") {
        try {
            const body = JSON.parse(await readBody(req));
            const recipeId = (body.recipe_id ?? "").trim();
            const categoryId = (body.categoryId ?? "").trim();
            if (!recipeId) {
                sendJson(res, 400, { error: "recipe_id is required" });
                return;
            }
            if (!categoryId) {
                sendJson(res, 400, { error: "categoryId is required" });
                return;
            }
            const item = await assignCategoryRecipe(recipeId, categoryId);
            sendJson(res, 200, { item });
        }
        catch (error) {
            if (error instanceof NotFoundError) {
                sendJson(res, 404, { error: error.message });
            }
            else {
                sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid request" });
            }
        }
        return;
    }
    if (route === "/api/categories/unassign" && req.method === "POST") {
        try {
            const body = JSON.parse(await readBody(req));
            const recipeId = (body.recipe_id ?? "").trim();
            const categoryId = (body.categoryId ?? "").trim();
            if (!recipeId) {
                sendJson(res, 400, { error: "recipe_id is required" });
                return;
            }
            if (!categoryId) {
                sendJson(res, 400, { error: "categoryId is required" });
                return;
            }
            await unassignCategoryRecipe(recipeId, categoryId);
            sendJson(res, 200, { ok: true });
        }
        catch (error) {
            if (error instanceof NotFoundError) {
                sendJson(res, 404, { error: error.message });
            }
            else {
                sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid request" });
            }
        }
        return;
    }
    sendJson(res, 404, { error: "Not found" });
}
async function main() {
    await ensureDataDirs();
    await loadSettings();
    await seedDefaultRecipes();
    await seedDefaultRecipeImages();
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
