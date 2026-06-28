"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.canonicalSourceUrl = canonicalSourceUrl;
exports.recipeDedupeKey = recipeDedupeKey;
exports.dedupeIndexEntries = dedupeIndexEntries;
exports.reconcileRecipeStore = reconcileRecipeStore;
exports.reconcileLibraryData = reconcileLibraryData;
exports.countDedupedRecipes = countDedupedRecipes;
const promises_1 = require("node:fs/promises");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
const TRACKING_PARAMS = [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "fbclid",
    "gclid",
    "mc_cid",
    "mc_eid",
];
function canonicalSourceUrl(sourceUrl) {
    const trimmed = sourceUrl.trim();
    if (!trimmed)
        return "";
    if (trimmed.startsWith("urn:"))
        return trimmed;
    try {
        const url = new URL(trimmed);
        url.hash = "";
        for (const param of TRACKING_PARAMS)
            url.searchParams.delete(param);
        url.hostname = url.hostname.toLowerCase();
        if (url.hostname.startsWith("www."))
            url.hostname = url.hostname.slice(4);
        if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
            url.pathname = url.pathname.slice(0, -1);
        }
        if (url.protocol === "http:")
            url.protocol = "https:";
        const query = url.searchParams.toString();
        url.search = query ? `?${query}` : "";
        return url.toString();
    }
    catch {
        return trimmed.toLowerCase();
    }
}
function normalizeTitle(title) {
    return title.trim().toLowerCase().replace(/\s+/g, " ");
}
function entryTimestamp(entry) {
    const value = new Date(entry.updated_at).getTime();
    return Number.isFinite(value) ? value : 0;
}
function pickNewerEntry(a, b) {
    return entryTimestamp(a) >= entryTimestamp(b) ? a : b;
}
function recipeDedupeKey(recipe) {
    const canonical = canonicalSourceUrl(recipe.source_url);
    if (canonical)
        return `url:${canonical}`;
    const title = normalizeTitle(recipe.title);
    const ingredients = (recipe.ingredients || [])
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean)
        .sort()
        .join("\n");
    if (title && ingredients)
        return `content:${title}\n${ingredients}`;
    if (title)
        return `title:${title}`;
    return `id:${recipe.id}`;
}
function dedupeIndexEntries(entries, recipesById) {
    const byId = new Map();
    for (const entry of entries) {
        if (!entry?.id)
            continue;
        const previous = byId.get(entry.id);
        byId.set(entry.id, previous ? pickNewerEntry(previous, entry) : entry);
    }
    const byKey = new Map();
    for (const entry of byId.values()) {
        const recipe = recipesById.get(entry.id) ?? entry;
        const key = recipeDedupeKey(recipe);
        const previous = byKey.get(key);
        byKey.set(key, previous ? pickNewerEntry(previous, entry) : entry);
    }
    const kept = [...byKey.values()].sort((a, b) => entryTimestamp(b) - entryTimestamp(a));
    const keptIds = new Set(kept.map((entry) => entry.id));
    const removedIds = new Set();
    const idRemap = new Map();
    for (const entry of byId.values()) {
        if (keptIds.has(entry.id))
            continue;
        removedIds.add(entry.id);
        const recipe = recipesById.get(entry.id) ?? entry;
        const replacement = byKey.get(recipeDedupeKey(recipe));
        if (replacement)
            idRemap.set(entry.id, replacement.id);
    }
    return { kept, removedIds, idRemap };
}
async function readJsonArray(filePath) {
    if (!(0, node_fs_1.existsSync)(filePath))
        return [];
    try {
        const raw = await (0, promises_1.readFile)(filePath, "utf8");
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    }
    catch {
        return [];
    }
}
async function writeJsonArray(filePath, entries) {
    await (0, promises_1.mkdir)(node_path_1.default.dirname(filePath), { recursive: true });
    await (0, promises_1.writeFile)(filePath, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
}
async function readRecipesFromDir(recipesDir) {
    if (!(0, node_fs_1.existsSync)(recipesDir))
        return [];
    const files = await (0, promises_1.readdir)(recipesDir);
    const recipes = [];
    for (const file of files) {
        if (!file.endsWith(".json"))
            continue;
        try {
            const raw = await (0, promises_1.readFile)(node_path_1.default.join(recipesDir, file), "utf8");
            const recipe = JSON.parse(raw);
            if (recipe?.id)
                recipes.push(recipe);
        }
        catch {
            // Skip invalid recipe files.
        }
    }
    return recipes;
}
function recipesById(recipes) {
    return new Map(recipes.map((recipe) => [recipe.id, recipe]));
}
function indexEntryFromRecipe(recipe) {
    return {
        id: recipe.id,
        title: recipe.title,
        source_url: recipe.source_url,
        created_at: recipe.created_at,
        updated_at: recipe.updated_at,
    };
}
async function removeRecipeFiles(recipesDir, imagesDir, recipeIds) {
    for (const id of recipeIds) {
        await (0, promises_1.rm)(node_path_1.default.join(recipesDir, `${id}.json`), { force: true });
        for (const ext of IMAGE_EXTENSIONS) {
            await (0, promises_1.rm)(node_path_1.default.join(imagesDir, `${id}${ext}`), { force: true });
        }
    }
}
async function readCategoryItems(itemsPath) {
    if (!(0, node_fs_1.existsSync)(itemsPath))
        return [];
    try {
        const raw = await (0, promises_1.readFile)(itemsPath, "utf8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed))
            return parsed;
        if (parsed && typeof parsed === "object" && Array.isArray(parsed.items)) {
            return parsed.items;
        }
    }
    catch {
        // Fall through to empty list.
    }
    return [];
}
async function remapCategoryItems(dataDir, idRemap, removedIds) {
    const itemsPath = node_path_1.default.join(dataDir, "category-items.json");
    const raw = await readCategoryItems(itemsPath);
    if (!raw.length && !(0, node_fs_1.existsSync)(itemsPath))
        return;
    const next = [];
    const seen = new Set();
    for (const item of raw) {
        if (!item?.recipe_id || !item?.category_id)
            continue;
        let recipeId = item.recipe_id;
        if (removedIds.has(recipeId)) {
            const replacement = idRemap.get(recipeId);
            if (!replacement)
                continue;
            recipeId = replacement;
        }
        const key = `${recipeId}:${item.category_id}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        next.push({ recipe_id: recipeId, category_id: item.category_id });
    }
    await (0, promises_1.writeFile)(itemsPath, `${JSON.stringify({ items: next }, null, 2)}\n`, "utf8");
}
async function reconcileRecipeStore(indexPath, recipesDir, imagesDir) {
    const recipes = await readRecipesFromDir(recipesDir);
    const recipeMap = recipesById(recipes);
    const result = dedupeIndexEntries(recipes.map(indexEntryFromRecipe), recipeMap);
    const keptIds = new Set(result.kept.map((entry) => entry.id));
    const orphanIds = new Set();
    for (const recipe of recipes) {
        if (!keptIds.has(recipe.id))
            orphanIds.add(recipe.id);
    }
    for (const id of result.removedIds)
        orphanIds.add(id);
    if (orphanIds.size > 0) {
        await removeRecipeFiles(recipesDir, imagesDir, orphanIds);
    }
    if (recipes.length > 0 || (0, node_fs_1.existsSync)(indexPath) || result.kept.length > 0) {
        await writeJsonArray(indexPath, result.kept);
    }
    return result;
}
async function reconcileLibraryData(dataDir) {
    const library = await reconcileRecipeStore(node_path_1.default.join(dataDir, "index.json"), node_path_1.default.join(dataDir, "recipes"), node_path_1.default.join(dataDir, "images"));
    await reconcileRecipeStore(node_path_1.default.join(dataDir, ".trash", "index.json"), node_path_1.default.join(dataDir, ".trash", "recipes"), node_path_1.default.join(dataDir, ".trash", "images"));
    await reconcileRecipeStore(node_path_1.default.join(dataDir, ".blocklist", "index.json"), node_path_1.default.join(dataDir, ".blocklist", "recipes"), node_path_1.default.join(dataDir, ".blocklist", "images"));
    await remapCategoryItems(dataDir, library.idRemap, library.removedIds);
    return library.removedIds.size;
}
function countDedupedRecipes(entries, recipesByIdMap) {
    return dedupeIndexEntries(entries, recipesByIdMap).kept.length;
}
