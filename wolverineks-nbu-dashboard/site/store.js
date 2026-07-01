"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadSettings = loadSettings;
exports.saveSettings = saveSettings;
exports.rotateIngestToken = rotateIngestToken;
exports.importParsed = importParsed;
exports.listImports = listImports;
exports.getUsageSummary = getUsageSummary;
exports.getOverview = getOverview;
const promises_1 = require("node:fs/promises");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = require("node:crypto");
const DATA_ROOT = process.env.NBU_DATA_DIR ?? "/data";
const SETTINGS_PATH = node_path_1.default.join(DATA_ROOT, "settings.json");
const IMPORTS_PATH = node_path_1.default.join(DATA_ROOT, "imports.json");
const READINGS_PATH = node_path_1.default.join(DATA_ROOT, "readings.json");
let settingsCache = null;
let importsCache = null;
let readingsCache = null;
async function ensureDataRoot() {
    if (!(0, node_fs_1.existsSync)(DATA_ROOT)) {
        await (0, promises_1.mkdir)(DATA_ROOT, { recursive: true });
    }
}
function newToken() {
    return (0, node_crypto_1.randomBytes)(24).toString("hex");
}
async function loadSettings() {
    if (settingsCache)
        return settingsCache;
    await ensureDataRoot();
    if (!(0, node_fs_1.existsSync)(SETTINGS_PATH)) {
        settingsCache = {
            ingest_token: newToken(),
            account_id: null,
            usage_point: null,
            address: null,
        };
        await saveSettings(settingsCache);
        return settingsCache;
    }
    const raw = await (0, promises_1.readFile)(SETTINGS_PATH, "utf8");
    settingsCache = JSON.parse(raw);
    if (!settingsCache.ingest_token) {
        settingsCache.ingest_token = newToken();
        await saveSettings(settingsCache);
    }
    return settingsCache;
}
async function saveSettings(settings) {
    await ensureDataRoot();
    settingsCache = settings;
    await (0, promises_1.writeFile)(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}
async function rotateIngestToken() {
    const settings = await loadSettings();
    settings.ingest_token = newToken();
    await saveSettings(settings);
    return settings;
}
async function loadImports() {
    if (importsCache)
        return importsCache;
    await ensureDataRoot();
    if (!(0, node_fs_1.existsSync)(IMPORTS_PATH)) {
        importsCache = [];
        return importsCache;
    }
    importsCache = JSON.parse(await (0, promises_1.readFile)(IMPORTS_PATH, "utf8"));
    return importsCache;
}
async function saveImports(imports) {
    importsCache = imports;
    await (0, promises_1.writeFile)(IMPORTS_PATH, JSON.stringify(imports, null, 2));
}
async function loadReadings() {
    if (readingsCache)
        return readingsCache;
    await ensureDataRoot();
    if (!(0, node_fs_1.existsSync)(READINGS_PATH)) {
        readingsCache = [];
        return readingsCache;
    }
    const parsed = JSON.parse(await (0, promises_1.readFile)(READINGS_PATH, "utf8"));
    readingsCache = parsed.readings ?? [];
    return readingsCache;
}
async function saveReadings(readings) {
    readingsCache = readings;
    await (0, promises_1.writeFile)(READINGS_PATH, JSON.stringify({ readings }, null, 2));
}
function readingKey(reading) {
    return [
        reading.utility,
        reading.granularity,
        reading.period_start,
        reading.meter_id ?? "",
        reading.account_id ?? "",
    ].join("|");
}
async function importParsed(result) {
    const settings = await loadSettings();
    const imports = await loadImports();
    const readings = await loadReadings();
    if (result.account_id && !settings.account_id)
        settings.account_id = result.account_id;
    if (result.usage_point && !settings.usage_point)
        settings.usage_point = result.usage_point;
    if (result.address && !settings.address)
        settings.address = result.address;
    await saveSettings(settings);
    const importId = (0, node_crypto_1.randomBytes)(8).toString("hex");
    const importRecord = {
        id: importId,
        filename: result.filename,
        format: result.format,
        utility: result.utility,
        imported_at: new Date().toISOString(),
        account_id: result.account_id,
        usage_point: result.usage_point,
        reading_count: result.readings.length,
    };
    const existingKeys = new Set(readings.map(readingKey));
    let inserted = 0;
    for (const reading of result.readings) {
        const key = readingKey(reading);
        if (existingKeys.has(key))
            continue;
        readings.push({ ...reading, import_id: importId });
        existingKeys.add(key);
        inserted++;
    }
    importRecord.reading_count = inserted;
    imports.unshift(importRecord);
    await saveImports(imports.slice(0, 200));
    await saveReadings(readings);
    return importRecord;
}
async function listImports(limit = 20) {
    const imports = await loadImports();
    return imports.slice(0, limit);
}
function filterReadings(readings, utility, granularity, days) {
    const cutoff = days ? Date.now() - days * 86_400_000 : null;
    return readings
        .filter((r) => r.utility === utility && r.granularity === granularity)
        .filter((r) => !cutoff || new Date(r.period_start).getTime() >= cutoff)
        .sort((a, b) => a.period_start.localeCompare(b.period_start));
}
async function getUsageSummary(utility, granularity, days) {
    const readings = await loadReadings();
    const imports = await loadImports();
    const filtered = filterReadings(readings, utility, granularity, days);
    const points = filtered.map((r) => ({
        period_start: r.period_start,
        value: Math.round(r.value * 1000) / 1000,
    }));
    const total = points.reduce((sum, p) => sum + p.value, 0);
    const peak = points.reduce((best, point) => {
        if (!best || point.value > best.value)
            return point;
        return best;
    }, null);
    const unit = filtered[0]?.unit ?? (utility === "water" ? "gal" : "kWh");
    const utilityImports = imports.filter((item) => item.utility === utility);
    return {
        utility,
        granularity,
        unit,
        total: Math.round(total * 1000) / 1000,
        average: points.length ? Math.round((total / points.length) * 1000) / 1000 : 0,
        peak,
        points,
        last_import_at: utilityImports[0]?.imported_at ?? null,
    };
}
async function getOverview() {
    const settings = await loadSettings();
    const imports = await loadImports();
    const readings = await loadReadings();
    const count = (utility, granularity) => readings.filter((r) => r.utility === utility && r.granularity === granularity).length;
    return {
        settings,
        imports: imports.slice(0, 10),
        electric_hours: count("electric", "hour"),
        electric_days: count("electric", "day"),
        electric_billing_periods: count("electric", "billing_period"),
        water_hours: count("water", "hour"),
        water_days: count("water", "day"),
        water_billing_periods: count("water", "billing_period"),
    };
}
