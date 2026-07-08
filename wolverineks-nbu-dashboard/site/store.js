"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.centralLocalDateKey = centralLocalDateKey;
exports.centralTodayKey = centralTodayKey;
exports.addDaysToDateKey = addDaysToDateKey;
exports.getCoverageSummary = getCoverageSummary;
exports.parseDateParam = parseDateParam;
exports.resetStoreCaches = resetStoreCaches;
exports.buildPropertyId = buildPropertyId;
exports.loadSettings = loadSettings;
exports.saveSettings = saveSettings;
exports.rotateIngestToken = rotateIngestToken;
exports.setSelectedProperty = setSelectedProperty;
exports.setPropertyLabel = setPropertyLabel;
exports.listProperties = listProperties;
exports.importParsed = importParsed;
exports.listImports = listImports;
exports.getStoredImportFile = getStoredImportFile;
exports.getUsageSummary = getUsageSummary;
exports.getOverview = getOverview;
exports.resolvePropertyId = resolvePropertyId;
const promises_1 = require("node:fs/promises");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = require("node:crypto");
const DATA_ROOT = process.env.NBU_DATA_DIR ?? "/data";
const UPLOADS_ROOT = node_path_1.default.join(DATA_ROOT, "uploads");
const SETTINGS_PATH = node_path_1.default.join(DATA_ROOT, "settings.json");
const IMPORTS_PATH = node_path_1.default.join(DATA_ROOT, "imports.json");
const READINGS_PATH = node_path_1.default.join(DATA_ROOT, "readings.json");
const CENTRAL_TZ = "America/Chicago";
function centralLocalDateKey(iso) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: CENTRAL_TZ }).format(new Date(iso));
}
function centralTodayKey() {
    return new Intl.DateTimeFormat("en-CA", { timeZone: CENTRAL_TZ }).format(new Date());
}
function addDaysToDateKey(dateKey, days) {
    const [year, month, day] = dateKey.split("-").map(Number);
    const next = new Date(Date.UTC(year, month - 1, day + days));
    return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(next);
}
function compareDateKeys(a, b) {
    return a.localeCompare(b);
}
function dayStatus(dateKey, hoursPresent, todayKey) {
    if (dateKey === todayKey) {
        return hoursPresent >= 24 ? "complete" : "partial";
    }
    if (hoursPresent >= 24)
        return "complete";
    if (hoursPresent > 0)
        return "partial";
    return "missing";
}
function buildCoverageGaps(days) {
    const gaps = [];
    let current = null;
    for (const day of days) {
        if (day.status === "complete") {
            if (current) {
                gaps.push(current);
                current = null;
            }
            continue;
        }
        const gapStatus = day.status === "missing" ? "missing" : "partial";
        if (current && current.status === gapStatus && addDaysToDateKey(current.end, 1) === day.date) {
            current.end = day.date;
            current.days += 1;
            continue;
        }
        if (current)
            gaps.push(current);
        current = { start: day.date, end: day.date, days: 1, status: gapStatus };
    }
    if (current)
        gaps.push(current);
    return gaps;
}
async function getCoverageSummary(propertyId, utility) {
    const readings = await loadReadings();
    const hourReadings = readings.filter((r) => matchesProperty(propertyId, r.account_id, r.usage_point) &&
        r.utility === utility &&
        r.granularity === "hour");
    const empty = {
        property_id: propertyId,
        utility,
        range_start: null,
        range_end: null,
        total_days: 0,
        complete_days: 0,
        partial_days: 0,
        missing_days: 0,
        coverage_pct: 0,
        days: [],
        gaps: [],
    };
    if (!hourReadings.length)
        return empty;
    const hoursByDate = new Map();
    for (const reading of hourReadings) {
        const dateKey = centralLocalDateKey(reading.period_start);
        hoursByDate.set(dateKey, (hoursByDate.get(dateKey) ?? 0) + 1);
    }
    const sortedDates = [...hoursByDate.keys()].sort();
    const rangeStart = sortedDates[0];
    const todayKey = centralTodayKey();
    const yesterdayKey = addDaysToDateKey(todayKey, -1);
    let rangeEnd = yesterdayKey;
    if (compareDateKeys(rangeStart, rangeEnd) > 0) {
        rangeEnd = rangeStart;
    }
    const days = [];
    let cursor = rangeStart;
    while (compareDateKeys(cursor, rangeEnd) <= 0) {
        const hoursPresent = hoursByDate.get(cursor) ?? 0;
        days.push({
            date: cursor,
            hours_present: hoursPresent,
            hours_expected: 24,
            status: dayStatus(cursor, hoursPresent, todayKey),
        });
        cursor = addDaysToDateKey(cursor, 1);
    }
    if (compareDateKeys(todayKey, rangeStart) >= 0 &&
        compareDateKeys(todayKey, rangeEnd) > 0 &&
        (hoursByDate.get(todayKey) ?? 0) > 0) {
        const hoursPresent = hoursByDate.get(todayKey) ?? 0;
        days.push({
            date: todayKey,
            hours_present: hoursPresent,
            hours_expected: 24,
            status: dayStatus(todayKey, hoursPresent, todayKey),
        });
        rangeEnd = todayKey;
    }
    const complete_days = days.filter((day) => day.status === "complete").length;
    const partial_days = days.filter((day) => day.status === "partial").length;
    const missing_days = days.filter((day) => day.status === "missing").length;
    const total_days = days.length;
    return {
        property_id: propertyId,
        utility,
        range_start: rangeStart,
        range_end: rangeEnd,
        total_days,
        complete_days,
        partial_days,
        missing_days,
        coverage_pct: total_days ? Math.round((complete_days / total_days) * 1000) / 10 : 0,
        days,
        gaps: buildCoverageGaps(days),
    };
}
function parseDateParam(value) {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value))
        return null;
    const [year, month, day] = value.split("-").map(Number);
    const probe = new Date(Date.UTC(year, month - 1, day));
    if (probe.getUTCFullYear() !== year ||
        probe.getUTCMonth() !== month - 1 ||
        probe.getUTCDate() !== day) {
        return null;
    }
    return value;
}
let settingsCache = null;
let importsCache = null;
let readingsCache = null;
function resetStoreCaches() {
    settingsCache = null;
    importsCache = null;
    readingsCache = null;
}
function buildPropertyId(accountId, usagePoint) {
    if (accountId && usagePoint)
        return `${accountId}-${usagePoint}`;
    if (accountId)
        return accountId;
    return null;
}
function normalizeSettings(raw) {
    if ("selected_property_id" in raw) {
        return {
            ingest_token: String(raw.ingest_token ?? newToken()),
            selected_property_id: typeof raw.selected_property_id === "string" ? raw.selected_property_id : null,
            property_labels: raw.property_labels && typeof raw.property_labels === "object"
                ? raw.property_labels
                : {},
        };
    }
    const accountId = typeof raw.account_id === "string" ? raw.account_id : null;
    const usagePoint = typeof raw.usage_point === "string" ? raw.usage_point : null;
    const address = typeof raw.address === "string" ? raw.address : null;
    const propertyId = buildPropertyId(accountId, usagePoint);
    const property_labels = {};
    if (propertyId && address)
        property_labels[propertyId] = address;
    return {
        ingest_token: String(raw.ingest_token ?? newToken()),
        selected_property_id: propertyId,
        property_labels,
    };
}
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
            selected_property_id: null,
            property_labels: {},
        };
        await saveSettings(settingsCache);
        return settingsCache;
    }
    const raw = JSON.parse(await (0, promises_1.readFile)(SETTINGS_PATH, "utf8"));
    settingsCache = normalizeSettings(raw);
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
async function setSelectedProperty(propertyId) {
    const settings = await loadSettings();
    settings.selected_property_id = propertyId;
    await saveSettings(settings);
    return settings;
}
async function setPropertyLabel(propertyId, label) {
    const settings = await loadSettings();
    const trimmed = label.trim();
    if (trimmed)
        settings.property_labels[propertyId] = trimmed;
    else
        delete settings.property_labels[propertyId];
    await saveSettings(settings);
    return settings;
}
function propertyLabel(propertyId, address, settings, accountId, usagePoint) {
    const custom = settings.property_labels[propertyId]?.trim();
    if (custom)
        return custom;
    if (address)
        return address.replace(/\s+/g, " ").trim();
    if (accountId && usagePoint)
        return `Account ${accountId}-${usagePoint}`;
    if (accountId)
        return `Account ${accountId}`;
    return "Unknown property";
}
async function loadImports() {
    if (importsCache)
        return importsCache;
    await ensureDataRoot();
    if (!(0, node_fs_1.existsSync)(IMPORTS_PATH)) {
        importsCache = [];
        return importsCache;
    }
    const raw = JSON.parse(await (0, promises_1.readFile)(IMPORTS_PATH, "utf8"));
    importsCache = raw.map((item) => ({
        ...item,
        stored_filename: item.stored_filename ?? null,
        property_id: item.property_id ?? buildPropertyId(item.account_id, item.usage_point),
    }));
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
        reading.usage_point ?? "",
    ].join("|");
}
function readingPropertyId(reading) {
    return buildPropertyId(reading.account_id, reading.usage_point);
}
function matchesProperty(propertyId, accountId, usagePoint) {
    if (!propertyId)
        return true;
    return buildPropertyId(accountId, usagePoint) === propertyId;
}
async function listProperties() {
    const settings = await loadSettings();
    const readings = await loadReadings();
    const imports = await loadImports();
    const map = new Map();
    const upsert = (accountId, usagePoint, address) => {
        const id = buildPropertyId(accountId, usagePoint);
        if (!id)
            return;
        const existing = map.get(id);
        if (!existing) {
            map.set(id, {
                id,
                account_id: accountId,
                usage_point: usagePoint,
                address,
                label: propertyLabel(id, address, settings, accountId, usagePoint),
            });
            return;
        }
        if (address && !existing.address)
            existing.address = address;
        existing.label = propertyLabel(id, existing.address, settings, accountId, usagePoint);
    };
    for (const reading of readings) {
        upsert(reading.account_id, reading.usage_point, reading.address);
    }
    for (const item of imports) {
        upsert(item.account_id, item.usage_point, null);
    }
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
}
function sanitizeFilename(filename) {
    const base = node_path_1.default.basename(filename).replace(/[^\w.\-() ]+/g, "_").trim();
    return base || "upload.dat";
}
function contentTypeForFilename(filename) {
    const lower = filename.toLowerCase();
    if (lower.endsWith(".xml"))
        return "application/xml; charset=utf-8";
    if (lower.endsWith(".csv"))
        return "text/csv; charset=utf-8";
    return "application/octet-stream";
}
async function saveUploadedFile(importId, filename, rawContent) {
    const storedFilename = sanitizeFilename(filename);
    const importDir = node_path_1.default.join(UPLOADS_ROOT, importId);
    await (0, promises_1.mkdir)(importDir, { recursive: true });
    await (0, promises_1.writeFile)(node_path_1.default.join(importDir, storedFilename), rawContent, "utf8");
    return storedFilename;
}
async function importParsed(result, rawContent) {
    const settings = await loadSettings();
    const imports = await loadImports();
    const readings = await loadReadings();
    const propertyId = buildPropertyId(result.account_id, result.usage_point);
    if (propertyId && result.address && !settings.property_labels[propertyId]) {
        settings.property_labels[propertyId] = result.address.replace(/\s+/g, " ").trim();
    }
    if (!settings.selected_property_id && propertyId) {
        settings.selected_property_id = propertyId;
    }
    await saveSettings(settings);
    const importId = (0, node_crypto_1.randomBytes)(8).toString("hex");
    const storedFilename = await saveUploadedFile(importId, result.filename, rawContent);
    const importRecord = {
        id: importId,
        filename: result.filename,
        stored_filename: storedFilename,
        format: result.format,
        utility: result.utility,
        imported_at: new Date().toISOString(),
        account_id: result.account_id,
        usage_point: result.usage_point,
        property_id: propertyId,
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
    await saveImports(imports);
    await saveReadings(readings);
    return importRecord;
}
async function listImports(propertyId = null, limit = 500, offset = 0) {
    const imports = await loadImports();
    const filtered = imports.filter((item) => matchesProperty(propertyId, item.account_id, item.usage_point));
    return {
        imports: filtered.slice(offset, offset + limit),
        total: filtered.length,
    };
}
async function getStoredImportFile(importId) {
    const imports = await loadImports();
    const record = imports.find((item) => item.id === importId);
    if (!record?.stored_filename)
        return null;
    const filePath = node_path_1.default.join(UPLOADS_ROOT, importId, record.stored_filename);
    if (!(0, node_fs_1.existsSync)(filePath))
        return null;
    const content = await (0, promises_1.readFile)(filePath);
    return {
        content,
        filename: record.filename,
        contentType: contentTypeForFilename(record.filename),
    };
}
function filterReadings(readings, propertyId, utility, granularity, days, date) {
    const cutoff = date || !days ? null : Date.now() - days * 86_400_000;
    return readings
        .filter((r) => matchesProperty(propertyId, r.account_id, r.usage_point))
        .filter((r) => r.utility === utility)
        .filter((r) => {
        if (date)
            return r.granularity === "hour" && centralLocalDateKey(r.period_start) === date;
        return r.granularity === granularity;
    })
        .filter((r) => !cutoff || new Date(r.period_start).getTime() >= cutoff)
        .sort((a, b) => a.period_start.localeCompare(b.period_start));
}
async function getUsageSummary(propertyId, utility, granularity, days, date = null) {
    const readings = await loadReadings();
    const imports = await loadImports();
    const filtered = filterReadings(readings, propertyId, utility, granularity, days, date);
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
    const utilityImports = imports.filter((item) => matchesProperty(propertyId, item.account_id, item.usage_point) && item.utility === utility);
    return {
        property_id: propertyId,
        utility,
        granularity: date ? "hour" : granularity,
        date,
        unit,
        total: Math.round(total * 1000) / 1000,
        average: points.length ? Math.round((total / points.length) * 1000) / 1000 : 0,
        peak,
        points,
        last_import_at: utilityImports[0]?.imported_at ?? null,
    };
}
async function getOverview(propertyId = null) {
    const settings = await loadSettings();
    const properties = await listProperties();
    const effectivePropertyId = propertyId ?? settings.selected_property_id;
    const selected_property = properties.find((item) => item.id === effectivePropertyId) ?? null;
    const readings = await loadReadings();
    const scoped = readings.filter((r) => matchesProperty(effectivePropertyId, r.account_id, r.usage_point));
    const count = (utility, granularity) => scoped.filter((r) => r.utility === utility && r.granularity === granularity).length;
    const { total: import_count } = await listImports(effectivePropertyId);
    return {
        settings,
        properties,
        selected_property,
        import_count,
        electric_hours: count("electric", "hour"),
        electric_days: count("electric", "day"),
        electric_billing_periods: count("electric", "billing_period"),
        water_hours: count("water", "hour"),
        water_days: count("water", "day"),
        water_billing_periods: count("water", "billing_period"),
    };
}
function resolvePropertyId(requested, settings, properties) {
    if (requested)
        return requested;
    if (settings.selected_property_id)
        return settings.selected_property_id;
    return properties[0]?.id ?? null;
}
