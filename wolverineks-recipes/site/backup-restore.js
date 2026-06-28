"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBackupStatus = getBackupStatus;
exports.exportRecipesData = exportRecipesData;
exports.importRecipesData = importRecipesData;
const promises_1 = require("node:fs/promises");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const MANIFEST_FILE = "backup-manifest.json";
const SKIP_NAMES = new Set([".gitkeep"]);
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
function normalizeSourceUrl(sourceUrl) {
    return sourceUrl.trim();
}
function entryTimestamp(entry) {
    const value = new Date(entry.updated_at).getTime();
    return Number.isFinite(value) ? value : 0;
}
function pickNewerEntry(a, b) {
    return entryTimestamp(a) >= entryTimestamp(b) ? a : b;
}
function dedupeIndexEntries(entries) {
    const byId = new Map();
    for (const entry of entries) {
        if (!entry?.id)
            continue;
        const previous = byId.get(entry.id);
        byId.set(entry.id, previous ? pickNewerEntry(previous, entry) : entry);
    }
    const bySource = new Map();
    for (const entry of byId.values()) {
        const key = normalizeSourceUrl(entry.source_url) || `id:${entry.id}`;
        const previous = bySource.get(key);
        bySource.set(key, previous ? pickNewerEntry(previous, entry) : entry);
    }
    const kept = [...bySource.values()].sort((a, b) => entryTimestamp(b) - entryTimestamp(a));
    const keptIds = new Set(kept.map((entry) => entry.id));
    const removedIds = new Set();
    const idRemap = new Map();
    for (const entry of byId.values()) {
        if (keptIds.has(entry.id))
            continue;
        removedIds.add(entry.id);
        const key = normalizeSourceUrl(entry.source_url) || `id:${entry.id}`;
        const replacement = bySource.get(key);
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
    await (0, promises_1.writeFile)(filePath, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
}
async function removeRecipeFiles(recipesDir, imagesDir, recipeIds) {
    for (const id of recipeIds) {
        await (0, promises_1.rm)(node_path_1.default.join(recipesDir, `${id}.json`), { force: true });
        for (const ext of IMAGE_EXTENSIONS) {
            await (0, promises_1.rm)(node_path_1.default.join(imagesDir, `${id}${ext}`), { force: true });
        }
    }
}
async function pruneRecipeFiles(recipesDir, imagesDir, keptIds) {
    if (!(0, node_fs_1.existsSync)(recipesDir))
        return;
    const files = await (0, promises_1.readdir)(recipesDir);
    const orphanIds = new Set();
    for (const file of files) {
        if (!file.endsWith(".json"))
            continue;
        const id = file.slice(0, -".json".length);
        if (!keptIds.has(id))
            orphanIds.add(id);
    }
    await removeRecipeFiles(recipesDir, imagesDir, orphanIds);
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
async function dedupeRecipeStore(indexPath, recipesDir, imagesDir) {
    const entries = await readJsonArray(indexPath);
    const result = dedupeIndexEntries(entries);
    if (result.removedIds.size > 0) {
        await removeRecipeFiles(recipesDir, imagesDir, result.removedIds);
    }
    const keptIds = new Set(result.kept.map((entry) => entry.id));
    await pruneRecipeFiles(recipesDir, imagesDir, keptIds);
    if (entries.length > 0 || (0, node_fs_1.existsSync)(indexPath)) {
        await writeJsonArray(indexPath, result.kept);
    }
    return result;
}
async function dedupeRestoredLibrary(dataDir) {
    const library = await dedupeRecipeStore(node_path_1.default.join(dataDir, "index.json"), node_path_1.default.join(dataDir, "recipes"), node_path_1.default.join(dataDir, "images"));
    await dedupeRecipeStore(node_path_1.default.join(dataDir, ".trash", "index.json"), node_path_1.default.join(dataDir, ".trash", "recipes"), node_path_1.default.join(dataDir, ".trash", "images"));
    await dedupeRecipeStore(node_path_1.default.join(dataDir, ".blocklist", "index.json"), node_path_1.default.join(dataDir, ".blocklist", "recipes"), node_path_1.default.join(dataDir, ".blocklist", "images"));
    await remapCategoryItems(dataDir, library.idRemap, library.removedIds);
    await (0, promises_1.rm)(node_path_1.default.join(dataDir, MANIFEST_FILE), { force: true });
}
async function countRecipesInDir(dataDir) {
    const indexPath = node_path_1.default.join(dataDir, "index.json");
    const entries = await readJsonArray(indexPath);
    return dedupeIndexEntries(entries).kept.length;
}
async function isWritableDir(dir) {
    try {
        await (0, promises_1.mkdir)(dir, { recursive: true });
        const probe = node_path_1.default.join(dir, `.write-test-${process.pid}`);
        await (0, promises_1.writeFile)(probe, "ok", "utf8");
        await (0, promises_1.rm)(probe, { force: true });
        return { ok: true, error: null };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "not writable";
        return { ok: false, error: message };
    }
}
async function readManifest(backupDir) {
    const manifestPath = node_path_1.default.join(backupDir, MANIFEST_FILE);
    if (!(0, node_fs_1.existsSync)(manifestPath))
        return null;
    try {
        const raw = await (0, promises_1.readFile)(manifestPath, "utf8");
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
async function syncDirectory(source, destination) {
    if (!(0, node_fs_1.existsSync)(source)) {
        throw new Error(`Source directory does not exist: ${source}`);
    }
    await (0, promises_1.mkdir)(destination, { recursive: true });
    const sourceEntries = await (0, promises_1.readdir)(source, { withFileTypes: true });
    const sourceNames = new Set(sourceEntries.map((entry) => entry.name).filter((name) => !SKIP_NAMES.has(name)));
    if ((0, node_fs_1.existsSync)(destination)) {
        const destEntries = await (0, promises_1.readdir)(destination, { withFileTypes: true });
        for (const entry of destEntries) {
            const name = String(entry.name);
            if (SKIP_NAMES.has(name) || sourceNames.has(name))
                continue;
            await (0, promises_1.rm)(node_path_1.default.join(destination, name), { recursive: true, force: true });
        }
    }
    for (const entry of sourceEntries) {
        if (SKIP_NAMES.has(entry.name))
            continue;
        const srcPath = node_path_1.default.join(source, entry.name);
        const destPath = node_path_1.default.join(destination, entry.name);
        if (entry.isDirectory()) {
            await syncDirectory(srcPath, destPath);
            continue;
        }
        if (entry.isFile()) {
            await (0, promises_1.copyFile)(srcPath, destPath);
        }
    }
}
function looksLikeRecipesBackup(backupDir) {
    return (0, node_fs_1.existsSync)(node_path_1.default.join(backupDir, "index.json")) || (0, node_fs_1.existsSync)(node_path_1.default.join(backupDir, "recipes"));
}
async function getBackupStatus(dataDir, backupDir) {
    const backupAvailable = (0, node_fs_1.existsSync)(backupDir) && looksLikeRecipesBackup(backupDir);
    const manifest = backupAvailable ? await readManifest(backupDir) : null;
    const writable = await isWritableDir(backupDir);
    return {
        data_dir: dataDir,
        backup_dir: backupDir,
        backup_available: backupAvailable,
        backup_writable: writable.ok,
        backup_writable_error: writable.error,
        library_recipe_count: await countRecipesInDir(dataDir),
        backup_recipe_count: backupAvailable ? await countRecipesInDir(backupDir) : 0,
        backup_updated_at: manifest?.exported_at ?? null,
    };
}
async function exportRecipesData(dataDir, backupDir) {
    const writable = await isWritableDir(backupDir);
    if (!writable.ok) {
        throw new Error(`Backup directory is not writable: ${backupDir}${writable.error ? ` (${writable.error})` : ""}. Restart the Recipes app after updating.`);
    }
    await syncDirectory(dataDir, backupDir);
    const manifest = {
        exported_at: new Date().toISOString(),
        source: dataDir,
    };
    await (0, promises_1.writeFile)(node_path_1.default.join(backupDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return getBackupStatus(dataDir, backupDir);
}
async function importRecipesData(dataDir, backupDir) {
    if (!(0, node_fs_1.existsSync)(backupDir) || !looksLikeRecipesBackup(backupDir)) {
        throw new Error("No backup found. Run Back up now first.");
    }
    await syncDirectory(backupDir, dataDir);
    await dedupeRestoredLibrary(dataDir);
    return getBackupStatus(dataDir, backupDir);
}
