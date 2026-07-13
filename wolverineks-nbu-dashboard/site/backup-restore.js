"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBackupStatus = getBackupStatus;
exports.exportNbuData = exportNbuData;
exports.importNbuData = importNbuData;
exports.clearNbuBackup = clearNbuBackup;
const promises_1 = require("node:fs/promises");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const MANIFEST_FILE = "backup-manifest.json";
const SKIP_NAMES = new Set([".gitkeep"]);
async function readJsonFile(filePath, fallback) {
    if (!(0, node_fs_1.existsSync)(filePath))
        return fallback;
    try {
        const raw = await (0, promises_1.readFile)(filePath, "utf8");
        return JSON.parse(raw);
    }
    catch {
        return fallback;
    }
}
async function countReadings(dataDir) {
    const parsed = await readJsonFile(node_path_1.default.join(dataDir, "readings.json"), { readings: [] });
    return Array.isArray(parsed.readings) ? parsed.readings.length : 0;
}
async function countImports(dataDir) {
    const parsed = await readJsonFile(node_path_1.default.join(dataDir, "imports.json"), []);
    return Array.isArray(parsed) ? parsed.length : 0;
}
async function readObjectIds(dataDir) {
    const settings = await readJsonFile(node_path_1.default.join(dataDir, "settings.json"), {});
    const objectIds = settings.property_object_ids ?? {};
    const addresses = settings.property_addresses ?? {};
    const labels = settings.property_labels ?? {};
    return Object.entries(objectIds)
        .map(([property_id, object_id]) => ({
        property_id,
        label: addresses[property_id]?.trim() || labels[property_id]?.trim() || property_id,
        object_id: String(object_id).trim(),
    }))
        .filter((item) => item.object_id)
        .sort((a, b) => a.label.localeCompare(b.label));
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
async function clearDirectory(dir) {
    if (!(0, node_fs_1.existsSync)(dir)) {
        await (0, promises_1.mkdir)(dir, { recursive: true });
        return;
    }
    const entries = await (0, promises_1.readdir)(dir, { withFileTypes: true });
    for (const entry of entries) {
        if (SKIP_NAMES.has(entry.name))
            continue;
        await (0, promises_1.rm)(node_path_1.default.join(dir, entry.name), { recursive: true, force: true });
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
function looksLikeNbuBackup(backupDir) {
    return ((0, node_fs_1.existsSync)(node_path_1.default.join(backupDir, "readings.json")) ||
        (0, node_fs_1.existsSync)(node_path_1.default.join(backupDir, "settings.json")));
}
async function getBackupStatus(dataDir, backupDir, backupHostPath) {
    const backupAvailable = (0, node_fs_1.existsSync)(backupDir) && looksLikeNbuBackup(backupDir);
    const manifest = backupAvailable ? await readManifest(backupDir) : null;
    const writable = await isWritableDir(backupDir);
    const liveObjectIds = await readObjectIds(dataDir);
    const backupObjectIds = backupAvailable ? await readObjectIds(backupDir) : [];
    return {
        data_dir: dataDir,
        backup_dir: backupDir,
        backup_host_path: backupHostPath,
        backup_available: backupAvailable,
        backup_writable: writable.ok,
        backup_writable_error: writable.error,
        live_reading_count: await countReadings(dataDir),
        live_import_count: await countImports(dataDir),
        live_object_id_count: liveObjectIds.length,
        live_object_ids: liveObjectIds,
        backup_reading_count: backupAvailable ? await countReadings(backupDir) : 0,
        backup_import_count: backupAvailable ? await countImports(backupDir) : 0,
        backup_object_id_count: backupObjectIds.length,
        backup_object_ids: backupObjectIds,
        backup_updated_at: manifest?.exported_at ?? null,
    };
}
async function exportNbuData(dataDir, backupDir, backupHostPath) {
    const writable = await isWritableDir(backupDir);
    if (!writable.ok) {
        throw new Error(`Backup directory is not writable: ${backupDir}${writable.error ? ` (${writable.error})` : ""}`);
    }
    await syncDirectory(dataDir, backupDir);
    const liveObjectIds = await readObjectIds(dataDir);
    const manifest = {
        exported_at: new Date().toISOString(),
        source: dataDir,
        reading_count: await countReadings(dataDir),
        import_count: await countImports(dataDir),
        object_id_count: liveObjectIds.length,
    };
    await (0, promises_1.writeFile)(node_path_1.default.join(backupDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return getBackupStatus(dataDir, backupDir, backupHostPath);
}
async function importNbuData(dataDir, backupDir, backupHostPath) {
    if (!(0, node_fs_1.existsSync)(backupDir) || !looksLikeNbuBackup(backupDir)) {
        throw new Error("No backup found. Run Back up now first.");
    }
    await clearDirectory(dataDir);
    await syncDirectory(backupDir, dataDir);
    await (0, promises_1.rm)(node_path_1.default.join(dataDir, MANIFEST_FILE), { force: true });
    return getBackupStatus(dataDir, backupDir, backupHostPath);
}
async function clearNbuBackup(dataDir, backupDir, backupHostPath) {
    const writable = await isWritableDir(backupDir);
    if (!writable.ok) {
        throw new Error(`Backup directory is not writable: ${backupDir}${writable.error ? ` (${writable.error})` : ""}`);
    }
    await clearDirectory(backupDir);
    return getBackupStatus(dataDir, backupDir, backupHostPath);
}
