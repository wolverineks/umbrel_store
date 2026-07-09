"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.NBU_GREEN_BUTTON_BASE = void 0;
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
exports.setPropertyObjectId = setPropertyObjectId;
exports.buildNbuExportUrl = buildNbuExportUrl;
exports.jsFetchSnippet = jsFetchSnippet;
exports.listProperties = listProperties;
exports.importParsed = importParsed;
exports.listImports = listImports;
exports.getStoredImportFile = getStoredImportFile;
exports.getUsageSummary = getUsageSummary;
exports.getOverview = getOverview;
exports.resolvePropertyId = resolvePropertyId;
exports.parseNbuUrlRange = parseNbuUrlRange;
exports.buildBulkProbeScript = buildBulkProbeScript;
exports.recordFetchProbes = recordFetchProbes;
exports.recordSyncFetchErrors = recordSyncFetchErrors;
exports.getMissingSources = getMissingSources;
const promises_1 = require("node:fs/promises");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = require("node:crypto");
const DATA_ROOT = process.env.NBU_DATA_DIR ?? "/data";
const UPLOADS_ROOT = node_path_1.default.join(DATA_ROOT, "uploads");
const SETTINGS_PATH = node_path_1.default.join(DATA_ROOT, "settings.json");
const IMPORTS_PATH = node_path_1.default.join(DATA_ROOT, "imports.json");
const READINGS_PATH = node_path_1.default.join(DATA_ROOT, "readings.json");
const SOURCE_ERRORS_PATH = node_path_1.default.join(DATA_ROOT, "source-errors.json");
exports.NBU_GREEN_BUTTON_BASE = "https://myinfo.nbutexas.com/CC/connect/users/home/indicators/ExportGreenButtonData.xml";
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
    sourceErrorsCache = null;
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
            property_object_ids: raw.property_object_ids && typeof raw.property_object_ids === "object"
                ? raw.property_object_ids
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
        property_object_ids: {},
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
            property_object_ids: {},
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
async function setPropertyObjectId(propertyId, objectId) {
    const settings = await loadSettings();
    const trimmed = objectId.trim();
    if (trimmed)
        settings.property_object_ids[propertyId] = trimmed;
    else
        delete settings.property_object_ids[propertyId];
    await saveSettings(settings);
    return settings;
}
function buildNbuExportUrl(start, end, objectId, utility) {
    const params = new URLSearchParams({
        StartDateTime: `${start}T00:00:00`,
        EndDateTime: `${addDaysToDateKey(end, 1)}T00:00:00`,
        ObjectId: objectId,
        Type: "Tier",
        utilType: utility === "water" ? "W" : "E",
        View: "usage",
    });
    return `${exports.NBU_GREEN_BUTTON_BASE}?${params.toString()}`;
}
function jsFetchSnippet(url, withCredentials = false) {
    const escaped = url.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    if (withCredentials) {
        return `fetch("${escaped}", { credentials: "include" }).then(async (r) => console.log(r.status, (await r.text()).slice(0, 300))).catch(console.error);`;
    }
    return `fetch("${escaped}").then(async (r) => console.log(r.status, (await r.text()).slice(0, 300))).catch(console.error);`;
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
function formatDateLabel(dateKey) {
    const [year, month, day] = dateKey.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
    return date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: CENTRAL_TZ,
    });
}
function formatRangeLabel(start, end) {
    if (start === end)
        return formatDateLabel(start);
    return `${formatDateLabel(start)} – ${formatDateLabel(end)}`;
}
function viewRangeKeys(days, date, filtered, granularity) {
    if (date)
        return { start: date, end: date };
    const todayKey = centralTodayKey();
    const yesterdayKey = addDaysToDateKey(todayKey, -1);
    if (days) {
        return { start: addDaysToDateKey(todayKey, -days), end: yesterdayKey };
    }
    if (!filtered.length)
        return null;
    if (granularity === "billing_period") {
        const starts = filtered.map((reading) => reading.period_start.slice(0, 10)).sort();
        return { start: starts[0], end: starts[starts.length - 1] };
    }
    const dates = filtered.map((reading) => centralLocalDateKey(reading.period_start)).sort();
    return { start: dates[0], end: dates[dates.length - 1] };
}
function iterateDateKeys(start, end) {
    const keys = [];
    let cursor = start;
    while (compareDateKeys(cursor, end) <= 0) {
        keys.push(cursor);
        cursor = addDaysToDateKey(cursor, 1);
    }
    return keys;
}
function missingDetail(label) {
    const index = label.indexOf("(");
    return index >= 0 ? label.slice(index) : "";
}
function mergeMissingPeriods(items) {
    if (!items.length)
        return [];
    const merged = [];
    let current = { ...items[0] };
    let currentDetail = missingDetail(items[0].label);
    for (let index = 1; index < items.length; index++) {
        const item = items[index];
        const detail = missingDetail(item.label);
        if (addDaysToDateKey(current.end, 1) === item.start && detail === currentDetail) {
            current.end = item.end;
            current.label = `${formatRangeLabel(current.start, current.end)} ${detail}`.trim();
            continue;
        }
        merged.push(current);
        current = { ...item };
        currentDetail = detail;
    }
    merged.push(current);
    return merged;
}
function attachNbuLinks(period, objectId, utility) {
    if (!objectId)
        return { nbu_url: null, nbu_fetch: null };
    const nbu_url = buildNbuExportUrl(period.start, period.end, objectId, utility);
    return { nbu_url, nbu_fetch: jsFetchSnippet(nbu_url, true) };
}
function withNbuLinks(periods, objectId, utility) {
    return periods.map((period) => ({
        ...period,
        ...attachNbuLinks(period, objectId, utility),
    }));
}
function buildUsageSources(filtered, imports, objectId, utility) {
    const importMap = new Map(imports.map((item) => [item.id, item]));
    const counts = new Map();
    const dateRanges = new Map();
    for (const reading of filtered) {
        counts.set(reading.import_id, (counts.get(reading.import_id) ?? 0) + 1);
        const dateKey = centralLocalDateKey(reading.period_start);
        const existing = dateRanges.get(reading.import_id);
        if (!existing) {
            dateRanges.set(reading.import_id, { start: dateKey, end: dateKey });
            continue;
        }
        if (compareDateKeys(dateKey, existing.start) < 0)
            existing.start = dateKey;
        if (compareDateKeys(dateKey, existing.end) > 0)
            existing.end = dateKey;
    }
    return [...counts.entries()]
        .map(([id, readings_in_view]) => {
        const record = importMap.get(id);
        const file_url = record?.stored_filename ? `/api/imports/${id}/file` : null;
        const file_view_url = record?.stored_filename ? `/api/imports/${id}/view` : null;
        const file_fetch = file_view_url ? jsFetchSnippet(file_view_url) : null;
        const range = dateRanges.get(id);
        const nbuLinks = range ? attachNbuLinks(range, objectId, utility) : { nbu_url: null, nbu_fetch: null };
        return {
            id,
            filename: record?.filename ?? "Unknown file",
            format: record?.format ?? "greenbutton_xml",
            imported_at: record?.imported_at ?? "",
            readings_in_view,
            file_url,
            file_view_url,
            file_fetch,
            ...nbuLinks,
        };
    })
        .sort((a, b) => b.readings_in_view - a.readings_in_view || a.filename.localeCompare(b.filename));
}
function buildUsageMissing(readings, propertyId, utility, granularity, days, date, objectId) {
    const effectiveGranularity = date ? "hour" : granularity;
    const filtered = filterReadings(readings, propertyId, utility, effectiveGranularity, days, date);
    const range = viewRangeKeys(days, date, filtered, effectiveGranularity);
    if (!range)
        return [];
    if (effectiveGranularity === "hour") {
        const hourReadings = filterReadings(readings, propertyId, utility, "hour", days, date);
        const hoursByDate = new Map();
        for (const reading of hourReadings) {
            const dateKey = centralLocalDateKey(reading.period_start);
            hoursByDate.set(dateKey, (hoursByDate.get(dateKey) ?? 0) + 1);
        }
        const items = iterateDateKeys(range.start, range.end).flatMap((dateKey) => {
            const hoursPresent = hoursByDate.get(dateKey) ?? 0;
            if (hoursPresent >= 24)
                return [];
            const rangeLabel = formatDateLabel(dateKey);
            if (hoursPresent === 0) {
                return [{ start: dateKey, end: dateKey, label: `${rangeLabel} (no hourly data)` }];
            }
            return [
                {
                    start: dateKey,
                    end: dateKey,
                    label: `${rangeLabel} (${hoursPresent}/24 hours)`,
                },
            ];
        });
        return withNbuLinks(mergeMissingPeriods(items), objectId, utility);
    }
    if (effectiveGranularity === "day") {
        const dayDates = new Set(filtered.map((reading) => centralLocalDateKey(reading.period_start)));
        const items = iterateDateKeys(range.start, range.end)
            .filter((dateKey) => !dayDates.has(dateKey))
            .map((dateKey) => ({
            start: dateKey,
            end: dateKey,
            label: `${formatDateLabel(dateKey)} (no daily data)`,
        }));
        return withNbuLinks(mergeMissingPeriods(items), objectId, utility);
    }
    const billing = [...filtered].sort((a, b) => a.period_start.localeCompare(b.period_start));
    if (!billing.length) {
        return withNbuLinks([
            {
                start: range.start,
                end: range.end,
                label: `${formatRangeLabel(range.start, range.end)} (no billing periods)`,
            },
        ], objectId, utility);
    }
    const missing = [];
    for (let index = 1; index < billing.length; index++) {
        const previous = billing[index - 1];
        const current = billing[index];
        const previousEnd = previous.period_end ?? previous.period_start;
        const gapDays = Math.round((new Date(current.period_start).getTime() - new Date(previousEnd).getTime()) / 86_400_000);
        if (gapDays > 45) {
            const gapStart = centralLocalDateKey(previousEnd);
            const gapEnd = centralLocalDateKey(current.period_start);
            missing.push({
                start: gapStart,
                end: gapEnd,
                label: `${formatRangeLabel(gapStart, gapEnd)} (gap between billing periods)`,
            });
        }
    }
    return withNbuLinks(missing, objectId, utility);
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
    const settings = await loadSettings();
    const objectId = propertyId ? settings.property_object_ids[propertyId] ?? null : null;
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
    const propertyImports = imports.filter((item) => matchesProperty(propertyId, item.account_id, item.usage_point));
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
        sources: buildUsageSources(filtered, propertyImports, objectId, utility),
        missing: buildUsageMissing(readings, propertyId, utility, granularity, days, date, objectId),
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
let sourceErrorsCache = null;
function propertyIdFromObjectId(settings, objectId) {
    for (const [propertyId, stored] of Object.entries(settings.property_object_ids)) {
        if (stored === objectId)
            return propertyId;
    }
    return null;
}
function parseNbuUrlRange(url) {
    try {
        const parsed = new URL(url);
        const startRaw = parsed.searchParams.get("StartDateTime");
        const endRaw = parsed.searchParams.get("EndDateTime");
        if (!startRaw || !endRaw)
            return null;
        const start = startRaw.slice(0, 10);
        const endExclusive = endRaw.slice(0, 10);
        return { start, end: addDaysToDateKey(endExclusive, -1) };
    }
    catch {
        return null;
    }
}
async function loadSourceErrors() {
    if (sourceErrorsCache)
        return sourceErrorsCache;
    await ensureDataRoot();
    if (!(0, node_fs_1.existsSync)(SOURCE_ERRORS_PATH)) {
        sourceErrorsCache = [];
        return sourceErrorsCache;
    }
    const parsed = JSON.parse(await (0, promises_1.readFile)(SOURCE_ERRORS_PATH, "utf8"));
    sourceErrorsCache = parsed.errors ?? [];
    return sourceErrorsCache;
}
async function saveSourceErrors(errors) {
    sourceErrorsCache = errors;
    await (0, promises_1.writeFile)(SOURCE_ERRORS_PATH, JSON.stringify({ errors }, null, 2));
}
function errorKey(propertyId, utility, start, end) {
    return [propertyId ?? "", utility, start, end].join("|");
}
function upsertSourceError(errors, entry) {
    const key = errorKey(entry.property_id, entry.utility, entry.start, entry.end);
    const filtered = errors.filter((item) => errorKey(item.property_id, item.utility, item.start, item.end) !== key);
    return [{ ...entry, recorded_at: new Date().toISOString() }, ...filtered].slice(0, 20_000);
}
function findSourceFetchError(errors, propertyId, utility, start, end) {
    const key = errorKey(propertyId, utility, start, end);
    return (errors.find((item) => errorKey(item.property_id, item.utility, item.start, item.end) === key) ??
        null);
}
function formatMissingGapLabel(gap, hoursPresent) {
    const range = gap.start === gap.end ? formatDateLabel(gap.start) : formatRangeLabel(gap.start, gap.end);
    const kind = gap.status === "missing" ? "Missing" : "Partial";
    if (gap.days === 1 && gap.status === "partial" && hoursPresent !== null) {
        return `${kind}: ${range} (${hoursPresent}/24 hours)`;
    }
    return `${kind}: ${range} (${gap.days} day${gap.days === 1 ? "" : "s"})`;
}
function buildBulkProbeScript(baseUrl, token, propertyId, utility, items) {
    const trimmedBase = baseUrl.replace(/\/$/, "");
    const payload = JSON.stringify({
        property_id: propertyId,
        utility,
        probes: items.map((item) => ({
            start: item.start,
            end: item.end,
            nbu_url: item.nbu_url,
        })),
    });
    return `(async () => {
  const baseUrl = ${JSON.stringify(trimmedBase)};
  const token = ${JSON.stringify(token)};
  const batch = ${payload};
  const results = [];
  for (const probe of batch.probes) {
    try {
      const response = await fetch(probe.nbu_url, { credentials: "include", cache: "no-store" });
      const text = await response.text();
      const preview = text.slice(0, 300);
      const valid = /xmlns="http:\\/\\/naesb.org\\/espi"/i.test(text) || /^Date\\/Time,/i.test(text.trim());
      results.push({
        start: probe.start,
        end: probe.end,
        nbu_url: probe.nbu_url,
        status: response.status,
        error: response.ok && valid ? null : (response.ok ? "empty or unsupported response" : "HTTP " + response.status),
        response_preview: preview,
      });
    } catch (error) {
      results.push({
        start: probe.start,
        end: probe.end,
        nbu_url: probe.nbu_url,
        status: null,
        error: error?.message || String(error),
        response_preview: null,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  const report = await fetch(baseUrl + "/api/missing-sources/probes", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Ingest-Token": token },
    body: JSON.stringify({ property_id: batch.property_id, utility: batch.utility, probes: results }),
  });
  const payload = await report.json().catch(() => ({}));
  console.log("Probe report:", report.status, payload);
  console.table(results.map((item) => ({ start: item.start, end: item.end, status: item.status, error: item.error })));
})();`;
}
async function recordFetchProbes(propertyId, utility, probes) {
    let errors = await loadSourceErrors();
    let recorded = 0;
    for (const probe of probes) {
        if (!probe.start || !probe.end)
            continue;
        const message = probe.error?.trim();
        if (!message)
            continue;
        errors = upsertSourceError(errors, {
            property_id: propertyId,
            utility,
            start: probe.start,
            end: probe.end,
            nbu_url: probe.nbu_url ?? null,
            status: probe.status ?? null,
            error: message,
            response_preview: probe.response_preview ?? null,
            source: "probe",
        });
        recorded += 1;
    }
    if (recorded)
        await saveSourceErrors(errors);
    return recorded;
}
async function recordSyncFetchErrors(input) {
    const settings = await loadSettings();
    const utility = input.utility === "water" ? "water" : "electric";
    const propertyId = input.property_id ??
        (input.object_id ? propertyIdFromObjectId(settings, input.object_id) : null) ??
        settings.selected_property_id;
    let errors = await loadSourceErrors();
    let recorded = 0;
    for (const item of input.errors) {
        const message = item.error?.trim();
        if (!message)
            continue;
        const range = item.url ? parseNbuUrlRange(item.url) : null;
        if (!range)
            continue;
        errors = upsertSourceError(errors, {
            property_id: propertyId,
            utility,
            start: range.start,
            end: range.end,
            nbu_url: item.url ?? null,
            status: item.status ?? null,
            error: message,
            response_preview: null,
            source: "sync",
        });
        recorded += 1;
    }
    if (recorded)
        await saveSourceErrors(errors);
    return recorded;
}
async function getMissingSources(propertyId, utility, baseUrl) {
    const settings = await loadSettings();
    const objectId = propertyId ? settings.property_object_ids[propertyId] ?? null : null;
    const coverage = await getCoverageSummary(propertyId, utility);
    const storedErrors = await loadSourceErrors();
    const daysByDate = new Map(coverage.days.map((day) => [day.date, day]));
    const probeLimit = 500;
    const items = coverage.gaps.map((gap) => {
        const hoursPresent = gap.days === 1 ? (daysByDate.get(gap.start)?.hours_present ?? null) : null;
        const nbuLinks = attachNbuLinks({ start: gap.start, end: gap.end }, objectId, utility);
        const matched = findSourceFetchError(storedErrors, propertyId, utility, gap.start, gap.end);
        return {
            start: gap.start,
            end: gap.end,
            days: gap.days,
            status: gap.status,
            label: formatMissingGapLabel(gap, hoursPresent),
            hours_present: hoursPresent,
            ...nbuLinks,
            fetch_status: matched?.status ?? null,
            fetch_error: matched?.error ?? null,
            fetch_preview: matched?.response_preview ?? null,
            fetch_probed_at: matched?.recorded_at ?? null,
            fetch_source: matched?.source ?? null,
        };
    });
    const probeCandidates = items
        .filter((item) => item.nbu_url)
        .slice(0, probeLimit)
        .map((item) => ({ start: item.start, end: item.end, nbu_url: item.nbu_url }));
    return {
        property_id: propertyId,
        utility,
        object_id: objectId,
        range_start: coverage.range_start,
        range_end: coverage.range_end,
        total: items.length,
        with_errors: items.filter((item) => item.fetch_error).length,
        items,
        probe_script: objectId && probeCandidates.length
            ? buildBulkProbeScript(baseUrl, settings.ingest_token, propertyId, utility, probeCandidates)
            : null,
    };
}
