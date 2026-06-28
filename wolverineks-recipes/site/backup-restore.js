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
async function countRecipesInDir(dataDir) {
    const indexPath = node_path_1.default.join(dataDir, "index.json");
    if (!(0, node_fs_1.existsSync)(indexPath))
        return 0;
    try {
        const raw = await (0, promises_1.readFile)(indexPath, "utf8");
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.length : 0;
    }
    catch {
        return 0;
    }
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
    return getBackupStatus(dataDir, backupDir);
}
