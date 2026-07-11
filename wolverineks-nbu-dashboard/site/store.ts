import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  centralHourSlotIso,
  type Granularity,
  type ParseResult,
  type ParsedReading,
  type Utility,
} from "./parsers";

const DATA_ROOT = process.env.NBU_DATA_DIR ?? "/data";
const UPLOADS_ROOT = path.join(DATA_ROOT, "uploads");
const SETTINGS_PATH = path.join(DATA_ROOT, "settings.json");
const IMPORTS_PATH = path.join(DATA_ROOT, "imports.json");
const READINGS_PATH = path.join(DATA_ROOT, "readings.json");
const SOURCE_ERRORS_PATH = path.join(DATA_ROOT, "source-errors.json");
const SYNC_QUEUE_PATH = path.join(DATA_ROOT, "sync-view-queue.json");

export type Settings = {
  ingest_token: string;
  selected_property_id: string | null;
  property_labels: Record<string, string>;
  property_object_ids: Record<string, string>;
};

export const NBU_HOURLY_CSV_BASE =
  "https://myinfo.nbutexas.com/CC/connect/users/home/indicators/ExportExcelReadData.xml";

export type Property = {
  id: string;
  account_id: string | null;
  usage_point: string | null;
  address: string | null;
  label: string;
};

export type ImportRecord = {
  id: string;
  filename: string;
  stored_filename: string | null;
  format: ParseResult["format"];
  utility: Utility;
  imported_at: string;
  account_id: string | null;
  usage_point: string | null;
  property_id: string | null;
  reading_count: number;
};

export type StoredImportFile = {
  content: Buffer;
  filename: string;
  contentType: string;
};

type ReadingsFile = {
  readings: StoredReading[];
};

export type StoredReading = ParsedReading & {
  import_id: string;
};

export type UsagePoint = {
  period_start: string;
  value: number;
  missing?: boolean;
};

export type UsageSourceFile = {
  id: string;
  filename: string;
  format: ImportRecord["format"];
  imported_at: string;
  readings_in_view: number;
  file_url: string | null;
  file_view_url: string | null;
  file_fetch: string | null;
  nbu_url: string | null;
  nbu_fetch: string | null;
};

export type UsageMissingPeriod = {
  start: string;
  end: string;
  label: string;
  nbu_url: string | null;
  nbu_fetch: string | null;
};

export type NbuVerdict = "NBU_HAS_DATA" | "NBU_MISSING" | "NBU_ERROR" | "NBU_FETCH_FAILED";

export type SourceFetchError = {
  property_id: string | null;
  utility: Utility;
  start: string;
  end: string;
  nbu_url: string | null;
  status: number | null;
  verdict: NbuVerdict | null;
  error: string | null;
  response_preview: string | null;
  source: "sync" | "probe";
  recorded_at: string;
};

export type MissingSource = {
  start: string;
  end: string;
  days: number;
  status: "missing" | "partial";
  label: string;
  hours_present: number | null;
  nbu_url: string | null;
  nbu_fetch: string | null;
  nbu_verdict: NbuVerdict | null;
  nbu_detail: string | null;
  fetch_status: number | null;
  fetch_error: string | null;
  fetch_preview: string | null;
  fetch_probed_at: string | null;
  fetch_source: SourceFetchError["source"] | null;
};

export type SyncViewQueue = {
  property_id: string | null;
  utility: Utility;
  start: string;
  end: string;
  label: string;
  queued_at: string;
};

export type MissingSourcesSummary = {
  property_id: string | null;
  utility: Utility;
  object_id: string | null;
  range_start: string | null;
  range_end: string | null;
  total: number;
  checked_on_nbu: number;
  confirmed_missing_on_nbu: number;
  has_data_on_nbu: number;
  with_errors: number;
  items: MissingSource[];
  verify_all_script: string | null;
  probe_script: string | null;
};

export type EnergyReportHour = {
  hour: number;
  label: string;
  value: number | null;
  missing: boolean;
};

export type EnergyReportPeak = {
  hour: number;
  label: string;
  value: number;
};

export type EnergyReportDay = {
  date: string;
  label: string;
  total: number;
  average: number;
  peak: EnergyReportPeak | null;
  low: EnergyReportPeak | null;
  hours: EnergyReportHour[];
  hours_present: number;
  hours_missing: number;
};

export type EnergyReportComparison = {
  highest_day: { date: string; label: string; total: number } | null;
  lowest_day: { date: string; label: string; total: number } | null;
  avg_daily: number;
};

export type EnergyReport = {
  unit: "kWh" | "gal";
  range_label: string;
  days: EnergyReportDay[];
  comparison: EnergyReportComparison | null;
  cost_note: string;
  detail_mode: "hourly" | "daily";
};

export type UsageSummary = {
  property_id: string | null;
  utility: Utility;
  granularity: Granularity;
  date: string | null;
  unit: "kWh" | "gal";
  total: number;
  average: number;
  peak: UsagePoint | null;
  points: UsagePoint[];
  sources: UsageSourceFile[];
  missing: UsageMissingPeriod[];
  last_import_at: string | null;
  report: EnergyReport | null;
};

const CENTRAL_TZ = "America/Chicago";

export function centralLocalDateKey(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: CENTRAL_TZ }).format(new Date(iso));
}

export type CoverageDayStatus = "complete" | "partial" | "missing";

export type CoverageDay = {
  date: string;
  hours_present: number;
  hours_expected: number;
  status: CoverageDayStatus;
};

export type CoverageGap = {
  start: string;
  end: string;
  days: number;
  status: "missing" | "partial";
};

export type CoverageSummary = {
  property_id: string | null;
  utility: Utility;
  range_start: string | null;
  range_end: string | null;
  total_days: number;
  complete_days: number;
  partial_days: number;
  missing_days: number;
  coverage_pct: number;
  days: CoverageDay[];
  gaps: CoverageGap[];
};

export function centralTodayKey(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: CENTRAL_TZ }).format(new Date());
}

export function addDaysToDateKey(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(next);
}

function compareDateKeys(a: string, b: string): number {
  return a.localeCompare(b);
}

function dayStatus(dateKey: string, hoursPresent: number, todayKey: string): CoverageDayStatus {
  if (dateKey === todayKey) {
    return hoursPresent >= 24 ? "complete" : "partial";
  }
  if (hoursPresent >= 24) return "complete";
  if (hoursPresent > 0) return "partial";
  return "missing";
}

function buildCoverageGaps(days: CoverageDay[]): CoverageGap[] {
  const gaps: CoverageGap[] = [];
  let current: CoverageGap | null = null;

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

    if (current) gaps.push(current);
    current = { start: day.date, end: day.date, days: 1, status: gapStatus };
  }

  if (current) gaps.push(current);
  return gaps;
}

export async function getCoverageSummary(
  propertyId: string | null,
  utility: Utility,
): Promise<CoverageSummary> {
  const readings = await loadReadings();
  const hourReadings = readings.filter(
    (r) =>
      matchesProperty(propertyId, r.account_id, r.usage_point) &&
      r.utility === utility &&
      r.granularity === "hour" &&
      !legacyTouReading(r),
  );

  const empty: CoverageSummary = {
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

  if (!hourReadings.length) return empty;

  const hoursByDate = new Map<string, number>();
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

  const days: CoverageDay[] = [];
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

  if (
    compareDateKeys(todayKey, rangeStart) >= 0 &&
    compareDateKeys(todayKey, rangeEnd) > 0 &&
    (hoursByDate.get(todayKey) ?? 0) > 0
  ) {
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

export function parseDateParam(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return value;
}

let settingsCache: Settings | null = null;
let importsCache: ImportRecord[] | null = null;
let readingsCache: StoredReading[] | null = null;

let syncQueueCache: SyncViewQueue | null | undefined;

export function resetStoreCaches(): void {
  settingsCache = null;
  importsCache = null;
  readingsCache = null;
  sourceErrorsCache = null;
  syncQueueCache = undefined;
}

export function buildPropertyId(accountId: string | null, usagePoint: string | null): string | null {
  if (accountId && usagePoint) return `${accountId}-${usagePoint}`;
  if (accountId) return accountId;
  return null;
}

function normalizeSettings(raw: Record<string, unknown>): Settings {
  if ("selected_property_id" in raw) {
    return {
      ingest_token: String(raw.ingest_token ?? newToken()),
      selected_property_id:
        typeof raw.selected_property_id === "string" ? raw.selected_property_id : null,
      property_labels:
        raw.property_labels && typeof raw.property_labels === "object"
          ? (raw.property_labels as Record<string, string>)
          : {},
      property_object_ids:
        raw.property_object_ids && typeof raw.property_object_ids === "object"
          ? (raw.property_object_ids as Record<string, string>)
          : {},
    };
  }

  const accountId = typeof raw.account_id === "string" ? raw.account_id : null;
  const usagePoint = typeof raw.usage_point === "string" ? raw.usage_point : null;
  const address = typeof raw.address === "string" ? raw.address : null;
  const propertyId = buildPropertyId(accountId, usagePoint);
  const property_labels: Record<string, string> = {};
  if (propertyId && address) property_labels[propertyId] = address;

  return {
    ingest_token: String(raw.ingest_token ?? newToken()),
    selected_property_id: propertyId,
    property_labels,
    property_object_ids: {},
  };
}

async function ensureDataRoot(): Promise<void> {
  if (!existsSync(DATA_ROOT)) {
    await mkdir(DATA_ROOT, { recursive: true });
  }
}

function newToken(): string {
  return randomBytes(24).toString("hex");
}

export async function loadSettings(): Promise<Settings> {
  if (settingsCache) return settingsCache;
  await ensureDataRoot();
  if (!existsSync(SETTINGS_PATH)) {
    settingsCache = {
      ingest_token: newToken(),
      selected_property_id: null,
      property_labels: {},
      property_object_ids: {},
    };
    await saveSettings(settingsCache);
    return settingsCache;
  }
  const raw = JSON.parse(await readFile(SETTINGS_PATH, "utf8")) as Record<string, unknown>;
  settingsCache = normalizeSettings(raw);
  if (!settingsCache.ingest_token) {
    settingsCache.ingest_token = newToken();
    await saveSettings(settingsCache);
  }
  return settingsCache;
}

export async function saveSettings(settings: Settings): Promise<void> {
  await ensureDataRoot();
  settingsCache = settings;
  await writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

export async function rotateIngestToken(): Promise<Settings> {
  const settings = await loadSettings();
  settings.ingest_token = newToken();
  await saveSettings(settings);
  return settings;
}

export async function setSelectedProperty(propertyId: string | null): Promise<Settings> {
  const settings = await loadSettings();
  settings.selected_property_id = propertyId;
  await saveSettings(settings);
  return settings;
}

export async function setPropertyLabel(propertyId: string, label: string): Promise<Settings> {
  const settings = await loadSettings();
  const trimmed = label.trim();
  if (trimmed) settings.property_labels[propertyId] = trimmed;
  else delete settings.property_labels[propertyId];
  await saveSettings(settings);
  return settings;
}

export async function setPropertyObjectId(propertyId: string, objectId: string): Promise<Settings> {
  const settings = await loadSettings();
  const trimmed = objectId.trim();
  if (trimmed) settings.property_object_ids[propertyId] = trimmed;
  else delete settings.property_object_ids[propertyId];
  await saveSettings(settings);
  return settings;
}

export function buildNbuExportUrl(
  start: string,
  end: string,
  objectId: string,
  utility: Utility,
): string {
  const params = new URLSearchParams({
    StartDateTime: `${start}T00:00:00`,
    EndDateTime: `${addDaysToDateKey(end, 1)}T00:00:00`,
    ObjectId: objectId,
    Type: "all",
    utilType: utility === "water" ? "W" : "E",
    View: "usage",
  });
  return `${NBU_HOURLY_CSV_BASE}?${params.toString()}`;
}

export function jsFetchSnippet(url: string, withCredentials = false): string {
  const escaped = url.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  if (withCredentials) {
    return `fetch("${escaped}", { credentials: "include" }).then(async (r) => console.log(r.status, (await r.text()).slice(0, 300))).catch(console.error);`;
  }
  return `fetch("${escaped}").then(async (r) => console.log(r.status, (await r.text()).slice(0, 300))).catch(console.error);`;
}

export function nbuVerifyLogicJs(): string {
  return `function analyzeNbuResponse(status, text) {
  const trimmed = text.trim();
  const hasCsv = /^Date\\/Time,/im.test(trimmed) || /^Meter #,/im.test(trimmed);
  const csvRows = hasCsv ? Math.max(0, trimmed.split(/\\n/).length - 1) : 0;
  if (!status || status < 200 || status >= 300) {
    return { verdict: "NBU_ERROR", detail: status ? "HTTP " + status : "fetch failed", hasData: false };
  }
  if (hasCsv && csvRows > 0) {
    return { verdict: "NBU_HAS_DATA", detail: csvRows + " CSV row(s)", hasData: true };
  }
  if (hasCsv) {
    return { verdict: "NBU_MISSING", detail: "CSV returned with no data rows", hasData: false };
  }
  return { verdict: "NBU_MISSING", detail: "empty or unsupported response", hasData: false };
}`;
}

export function nbuVerifyFetchSnippet(url: string, start: string, end: string): string {
  const escaped = url.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const periodLabel = start === end ? start : `${start} – ${end}`;
  return `${nbuVerifyLogicJs()}
fetch("${escaped}", { credentials: "include", cache: "no-store" }).then(async (r) => {
  const text = await r.text();
  const result = analyzeNbuResponse(r.status, text);
  console.log("[NBU verify ${periodLabel}]", result.verdict + " —", result.detail, { status: r.status, preview: text.slice(0, 200) });
  return { start: ${JSON.stringify(start)}, end: ${JSON.stringify(end)}, ...result, status: r.status };
}).catch((e) => {
  console.error("[NBU verify ${periodLabel}]", "NBU_FETCH_FAILED —", e);
  return { start: ${JSON.stringify(start)}, end: ${JSON.stringify(end)}, verdict: "NBU_FETCH_FAILED", detail: String(e), hasData: false };
});`;
}

function propertyLabel(
  propertyId: string,
  address: string | null,
  settings: Settings,
  accountId: string | null,
  usagePoint: string | null,
): string {
  const custom = settings.property_labels[propertyId]?.trim();
  if (custom) return custom;
  if (address) return address.replace(/\s+/g, " ").trim();
  if (accountId && usagePoint) return `Account ${accountId}-${usagePoint}`;
  if (accountId) return `Account ${accountId}`;
  return "Unknown property";
}

async function loadImports(): Promise<ImportRecord[]> {
  if (importsCache) return importsCache;
  await ensureDataRoot();
  if (!existsSync(IMPORTS_PATH)) {
    importsCache = [];
    return importsCache;
  }
  const raw = JSON.parse(await readFile(IMPORTS_PATH, "utf8")) as ImportRecord[];
  importsCache = raw.map((item) => ({
    ...item,
    stored_filename: item.stored_filename ?? null,
    property_id: item.property_id ?? buildPropertyId(item.account_id, item.usage_point),
  }));
  return importsCache;
}

async function saveImports(imports: ImportRecord[]): Promise<void> {
  importsCache = imports;
  await writeFile(IMPORTS_PATH, JSON.stringify(imports, null, 2));
}

async function loadReadings(): Promise<StoredReading[]> {
  if (readingsCache) return readingsCache;
  await ensureDataRoot();
  if (!existsSync(READINGS_PATH)) {
    readingsCache = [];
    return readingsCache;
  }
  const parsed = JSON.parse(await readFile(READINGS_PATH, "utf8")) as ReadingsFile;
  readingsCache = parsed.readings ?? [];
  return readingsCache;
}

async function saveReadings(readings: StoredReading[]): Promise<void> {
  readingsCache = readings;
  await writeFile(READINGS_PATH, JSON.stringify({ readings }, null, 2));
}

function readingKey(reading: ParsedReading): string {
  return [
    reading.utility,
    reading.granularity,
    reading.period_start,
    reading.meter_id ?? "",
    reading.account_id ?? "",
    reading.usage_point ?? "",
  ].join("|");
}

function legacyTouReading(reading: StoredReading): boolean {
  return Boolean((reading as StoredReading & { tou_tier?: string | null }).tou_tier);
}

function excludeTouReadings(readings: StoredReading[]): StoredReading[] {
  return readings.filter((reading) => !legacyTouReading(reading));
}

function readingPropertyId(reading: ParsedReading): string | null {
  return buildPropertyId(reading.account_id, reading.usage_point);
}

function matchesProperty(
  propertyId: string | null,
  accountId: string | null,
  usagePoint: string | null,
): boolean {
  if (!propertyId) return true;
  return buildPropertyId(accountId, usagePoint) === propertyId;
}

export async function listProperties(): Promise<Property[]> {
  const settings = await loadSettings();
  const readings = await loadReadings();
  const imports = await loadImports();
  const map = new Map<string, Property>();

  const upsert = (
    accountId: string | null,
    usagePoint: string | null,
    address: string | null,
  ): void => {
    const id = buildPropertyId(accountId, usagePoint);
    if (!id) return;
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
    if (address && !existing.address) existing.address = address;
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

function sanitizeFilename(filename: string): string {
  const base = path.basename(filename).replace(/[^\w.\-() ]+/g, "_").trim();
  return base || "upload.dat";
}

function contentTypeForFilename(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".xml")) return "application/xml; charset=utf-8";
  if (lower.endsWith(".csv")) return "text/csv; charset=utf-8";
  return "application/octet-stream";
}

async function saveUploadedFile(
  importId: string,
  filename: string,
  rawContent: string,
): Promise<string> {
  const storedFilename = sanitizeFilename(filename);
  const importDir = path.join(UPLOADS_ROOT, importId);
  await mkdir(importDir, { recursive: true });
  await writeFile(path.join(importDir, storedFilename), rawContent, "utf8");
  return storedFilename;
}

export async function importParsed(result: ParseResult, rawContent: string): Promise<ImportRecord> {
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

  const importId = randomBytes(8).toString("hex");
  const storedFilename = await saveUploadedFile(importId, result.filename, rawContent);
  const importRecord: ImportRecord = {
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
    if (existingKeys.has(key)) continue;
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

export async function listImports(
  propertyId: string | null = null,
  limit = 500,
  offset = 0,
): Promise<{ imports: ImportRecord[]; total: number }> {
  const imports = await loadImports();
  const filtered = imports.filter((item) =>
    matchesProperty(propertyId, item.account_id, item.usage_point),
  );
  return {
    imports: filtered.slice(offset, offset + limit),
    total: filtered.length,
  };
}

export async function getStoredImportFile(importId: string): Promise<StoredImportFile | null> {
  const imports = await loadImports();
  const record = imports.find((item) => item.id === importId);
  if (!record?.stored_filename) return null;

  const filePath = path.join(UPLOADS_ROOT, importId, record.stored_filename);
  if (!existsSync(filePath)) return null;

  const content = await readFile(filePath);
  return {
    content,
    filename: record.filename,
    contentType: contentTypeForFilename(record.filename),
  };
}

function formatDateLabel(dateKey: string): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: CENTRAL_TZ,
  });
}

function formatRangeLabel(start: string, end: string): string {
  if (start === end) return formatDateLabel(start);
  return `${formatDateLabel(start)} – ${formatDateLabel(end)}`;
}

function viewRangeKeys(
  days: number | null,
  date: string | null,
  filtered: StoredReading[],
  granularity: Granularity,
): { start: string; end: string } | null {
  if (date) return { start: date, end: date };

  const todayKey = centralTodayKey();
  const yesterdayKey = addDaysToDateKey(todayKey, -1);
  if (days) {
    return { start: addDaysToDateKey(todayKey, -days), end: yesterdayKey };
  }

  if (!filtered.length) return null;
  if (granularity === "billing_period") {
    const starts = filtered.map((reading) => reading.period_start.slice(0, 10)).sort();
    return { start: starts[0], end: starts[starts.length - 1] };
  }

  const dates = filtered.map((reading) => centralLocalDateKey(reading.period_start)).sort();
  return { start: dates[0], end: dates[dates.length - 1] };
}

function iterateDateKeys(start: string, end: string): string[] {
  const keys: string[] = [];
  let cursor = start;
  while (compareDateKeys(cursor, end) <= 0) {
    keys.push(cursor);
    cursor = addDaysToDateKey(cursor, 1);
  }
  return keys;
}

function missingDetail(label: string): string {
  const index = label.indexOf("(");
  return index >= 0 ? label.slice(index) : "";
}

function mergeMissingPeriods(
  items: Array<{ start: string; end: string; label: string }>,
): Array<{ start: string; end: string; label: string }> {
  if (!items.length) return [];

  const merged: Array<{ start: string; end: string; label: string }> = [];
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

function attachNbuLinks(
  period: { start: string; end: string },
  objectId: string | null,
  utility: Utility,
  verify = false,
): { nbu_url: string | null; nbu_fetch: string | null } {
  if (!objectId) return { nbu_url: null, nbu_fetch: null };
  const nbu_url = buildNbuExportUrl(period.start, period.end, objectId, utility);
  const nbu_fetch = verify
    ? nbuVerifyFetchSnippet(nbu_url, period.start, period.end)
    : jsFetchSnippet(nbu_url, true);
  return { nbu_url, nbu_fetch };
}

function withNbuLinks(
  periods: Array<{ start: string; end: string; label: string }>,
  objectId: string | null,
  utility: Utility,
): UsageMissingPeriod[] {
  return periods.map((period) => ({
    ...period,
    ...attachNbuLinks(period, objectId, utility, true),
  }));
}

function buildUsageSources(
  filtered: StoredReading[],
  imports: ImportRecord[],
  objectId: string | null,
  utility: Utility,
): UsageSourceFile[] {
  const importMap = new Map(imports.map((item) => [item.id, item]));
  const counts = new Map<string, number>();
  const dateRanges = new Map<string, { start: string; end: string }>();

  for (const reading of filtered) {
    counts.set(reading.import_id, (counts.get(reading.import_id) ?? 0) + 1);
    const dateKey = centralLocalDateKey(reading.period_start);
    const existing = dateRanges.get(reading.import_id);
    if (!existing) {
      dateRanges.set(reading.import_id, { start: dateKey, end: dateKey });
      continue;
    }
    if (compareDateKeys(dateKey, existing.start) < 0) existing.start = dateKey;
    if (compareDateKeys(dateKey, existing.end) > 0) existing.end = dateKey;
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
        format: record?.format ?? "hourly_csv",
        imported_at: record?.imported_at ?? "",
        readings_in_view,
        file_url,
        file_view_url,
        file_fetch,
        ...nbuLinks,
      };
    })
    .sort(
      (a, b) =>
        b.readings_in_view - a.readings_in_view || a.filename.localeCompare(b.filename),
    );
}

function buildUsageMissing(
  readings: StoredReading[],
  propertyId: string | null,
  utility: Utility,
  granularity: Granularity,
  days: number | null,
  date: string | null,
  objectId: string | null,
): UsageMissingPeriod[] {
  const effectiveGranularity = date ? "hour" : granularity;
  const filtered = excludeTouReadings(
    filterReadings(readings, propertyId, utility, effectiveGranularity, days, date),
  );
  const range = viewRangeKeys(days, date, filtered, effectiveGranularity);
  if (!range) return [];

  if (effectiveGranularity === "hour") {
    const hourReadings = excludeTouReadings(
      filterReadings(readings, propertyId, utility, "hour", days, date),
    );
    const hoursByDate = new Map<string, number>();
    for (const reading of hourReadings) {
      const dateKey = centralLocalDateKey(reading.period_start);
      hoursByDate.set(dateKey, (hoursByDate.get(dateKey) ?? 0) + 1);
    }

    const items = iterateDateKeys(range.start, range.end).flatMap((dateKey) => {
      const hoursPresent = hoursByDate.get(dateKey) ?? 0;
      if (hoursPresent >= 24) return [];
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
    return withNbuLinks(
      [
        {
          start: range.start,
          end: range.end,
          label: `${formatRangeLabel(range.start, range.end)} (no billing periods)`,
        },
      ],
      objectId,
      utility,
    );
  }

  const missing: Array<{ start: string; end: string; label: string }> = [];
  for (let index = 1; index < billing.length; index++) {
    const previous = billing[index - 1];
    const current = billing[index];
    const previousEnd = previous.period_end ?? previous.period_start;
    const gapDays = Math.round(
      (new Date(current.period_start).getTime() - new Date(previousEnd).getTime()) / 86_400_000,
    );
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

function centralLocalHour(iso: string): number {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: CENTRAL_TZ,
      hour: "2-digit",
      hour12: false,
    }).format(new Date(iso)),
  );
}

function isFutureHourSlot(dateKey: string, hour: number, todayKey: string): boolean {
  if (compareDateKeys(dateKey, todayKey) > 0) return true;
  if (dateKey !== todayKey) return false;
  return hour > centralLocalHour(new Date().toISOString());
}

function formatCompactHour(hour: number): string {
  if (hour === 0) return "12a";
  if (hour < 12) return `${hour}a`;
  if (hour === 12) return "12p";
  return `${hour - 12}p`;
}

function formatDayHeading(dateKey: string): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: CENTRAL_TZ,
  });
}

function roundUsage(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function findPeakLow(hours: EnergyReportHour[]): {
  peak: EnergyReportPeak | null;
  low: EnergyReportPeak | null;
} {
  const present = hours.filter((item) => !item.missing && item.value !== null) as Array<
    EnergyReportHour & { value: number }
  >;
  if (!present.length) return { peak: null, low: null };

  let peak = present[0];
  let low = present[0];
  for (const item of present) {
    if (item.value > peak.value) peak = item;
    if (item.value < low.value) low = item;
  }

  return {
    peak: { hour: peak.hour, label: peak.label, value: roundUsage(peak.value) },
    low: { hour: low.hour, label: low.label, value: roundUsage(low.value) },
  };
}

function buildEnergyReportDay(
  dateKey: string,
  valuesBySlot: Map<string, number>,
  todayKey: string,
): EnergyReportDay {
  const hours: EnergyReportHour[] = [];
  let total = 0;
  let hoursPresent = 0;
  let hoursMissing = 0;

  for (let hour = 0; hour < 24; hour++) {
    if (isFutureHourSlot(dateKey, hour, todayKey)) continue;
    const value = valuesBySlot.get(`${dateKey}:${hour}`);
    const missing = value === undefined;
    if (!missing) {
      total += value;
      hoursPresent += 1;
    } else {
      hoursMissing += 1;
    }
    hours.push({
      hour: hour + 1,
      label: formatCompactHour(hour),
      value: missing ? null : roundUsage(value),
      missing,
    });
  }

  const { peak, low } = findPeakLow(hours);
  const average = hoursPresent ? roundUsage(total / hoursPresent) : 0;

  return {
    date: dateKey,
    label: formatDayHeading(dateKey),
    total: roundUsage(total),
    average,
    peak,
    low,
    hours,
    hours_present: hoursPresent,
    hours_missing: hoursMissing,
  };
}

function buildEnergyReportComparison(days: EnergyReportDay[]): EnergyReportComparison | null {
  if (days.length < 2) return null;

  let highest = days[0];
  let lowest = days[0];
  let sum = 0;
  for (const day of days) {
    if (day.total > highest.total) highest = day;
    if (day.total < lowest.total) lowest = day;
    sum += day.total;
  }

  return {
    highest_day: { date: highest.date, label: highest.label, total: highest.total },
    lowest_day: { date: lowest.date, label: lowest.label, total: lowest.total },
    avg_daily: roundUsage(sum / days.length),
  };
}

function buildEnergyReport(
  readings: StoredReading[],
  propertyId: string | null,
  utility: Utility,
  granularity: Granularity,
  days: number | null,
  date: string | null,
): EnergyReport | null {
  const unit: "kWh" | "gal" = utility === "water" ? "gal" : "kWh";
  const costNote =
    utility === "electric"
      ? "Estimated cost: — (add your electric rates in Settings to enable)"
      : "Estimated cost: — (water rates not configured)";

  if (granularity === "billing_period") return null;

  if (granularity === "day") {
    const dayReadings = filterReadings(
      excludeTouReadings(readings),
      propertyId,
      utility,
      "day",
      days,
      date,
    );
    const range = viewRangeKeys(days, date, dayReadings, "day");
    if (!range) return null;

    const totalsByDate = new Map<string, number>();
    for (const reading of dayReadings) {
      const dateKey = centralLocalDateKey(reading.period_start);
      totalsByDate.set(dateKey, roundUsage(reading.value));
    }

    const reportDays: EnergyReportDay[] = iterateDateKeys(range.start, range.end)
      .filter((dateKey) => totalsByDate.has(dateKey))
      .map((dateKey) => {
        const total = totalsByDate.get(dateKey) ?? 0;
        return {
          date: dateKey,
          label: formatDayHeading(dateKey),
          total,
          average: total,
          peak: null,
          low: null,
          hours: [],
          hours_present: 0,
          hours_missing: 0,
        };
      });

    if (!reportDays.length) return null;

    return {
      unit,
      range_label: formatRangeLabel(range.start, range.end),
      days: reportDays,
      comparison: buildEnergyReportComparison(reportDays),
      cost_note: costNote,
      detail_mode: "daily",
    };
  }

  const hourReadings = filterReadings(
    excludeTouReadings(readings),
    propertyId,
    utility,
    "hour",
    days,
    date,
  );
  const range = viewRangeKeys(days, date, hourReadings, "hour");
  if (!range) return null;

  const todayKey = centralTodayKey();
  const valuesBySlot = new Map<string, number>();
  for (const reading of hourReadings) {
    const dateKey = centralLocalDateKey(reading.period_start);
    const hour = centralLocalHour(reading.period_start);
    valuesBySlot.set(`${dateKey}:${hour}`, reading.value);
  }

  const reportDays: EnergyReportDay[] = [];
  for (const dateKey of iterateDateKeys(range.start, range.end)) {
    const day = buildEnergyReportDay(dateKey, valuesBySlot, todayKey);
    if (day.hours_present > 0) reportDays.push(day);
  }

  if (!reportDays.length) return null;

  return {
    unit,
    range_label: formatRangeLabel(range.start, range.end),
    days: reportDays,
    comparison: buildEnergyReportComparison(reportDays),
    cost_note: costNote,
    detail_mode: "hourly",
  };
}

function hourSlotKey(reading: StoredReading): string {
  const dateKey = centralLocalDateKey(reading.period_start);
  const hour = centralLocalHour(reading.period_start);
  return `${dateKey}:${hour}`;
}

function buildHourlyChartPoints(
  hourReadings: StoredReading[],
  range: { start: string; end: string },
): UsagePoint[] {
  const todayKey = centralTodayKey();
  const valuesBySlot = new Map<string, number>();
  for (const reading of hourReadings) {
    valuesBySlot.set(hourSlotKey(reading), reading.value);
  }

  const points: UsagePoint[] = [];
  for (const dateKey of iterateDateKeys(range.start, range.end)) {
    for (let hour = 0; hour < 24; hour++) {
      if (isFutureHourSlot(dateKey, hour, todayKey)) continue;
      const slotKey = `${dateKey}:${hour}`;
      const value = valuesBySlot.get(slotKey);
      const period_start = centralHourSlotIso(dateKey, hour);
      if (value !== undefined) {
        points.push({
          period_start,
          value: roundUsage(value),
          missing: false,
        });
      } else {
        points.push({ period_start, value: 0, missing: true });
      }
    }
  }
  return points;
}

function filterReadings(
  readings: StoredReading[],
  propertyId: string | null,
  utility: Utility,
  granularity: Granularity,
  days: number | null,
  date: string | null,
): StoredReading[] {
  const cutoff = date || !days ? null : Date.now() - days * 86_400_000;
  return readings
    .filter((r) => matchesProperty(propertyId, r.account_id, r.usage_point))
    .filter((r) => r.utility === utility)
    .filter((r) => {
      if (date) return r.granularity === "hour" && centralLocalDateKey(r.period_start) === date;
      return r.granularity === granularity;
    })
    .filter((r) => !cutoff || new Date(r.period_start).getTime() >= cutoff)
    .sort((a, b) => a.period_start.localeCompare(b.period_start));
}

export async function getUsageSummary(
  propertyId: string | null,
  utility: Utility,
  granularity: Granularity,
  days: number | null,
  date: string | null = null,
): Promise<UsageSummary> {
  const settings = await loadSettings();
  const objectId = propertyId ? settings.property_object_ids[propertyId] ?? null : null;
  const readings = await loadReadings();
  const imports = await loadImports();
  const effectiveGranularity = date ? "hour" : granularity;
  const scopedReadings = excludeTouReadings(readings);
  const filtered = filterReadings(scopedReadings, propertyId, utility, granularity, days, date);
  const hourReadings =
    effectiveGranularity === "hour"
      ? filterReadings(scopedReadings, propertyId, utility, "hour", days, date)
      : [];
  let points: UsagePoint[];
  if (effectiveGranularity === "hour") {
    const range = viewRangeKeys(days, date, hourReadings, "hour");
    points = range ? buildHourlyChartPoints(hourReadings, range) : [];
  } else {
    points = filtered.map((r) => ({
      period_start: r.period_start,
      value: Math.round(r.value * 1000) / 1000,
    }));
  }
  const dataPoints = points.filter((point) => !point.missing);
  const total = dataPoints.reduce((sum, p) => sum + p.value, 0);
  const peak = dataPoints.reduce<UsagePoint | null>((best, point) => {
    if (!best || point.value > best.value) return point;
    return best;
  }, null);
  const unit =
    filtered[0]?.unit ?? hourReadings[0]?.unit ?? (utility === "water" ? "gal" : "kWh");
  const utilityImports = imports.filter(
    (item) =>
      matchesProperty(propertyId, item.account_id, item.usage_point) && item.utility === utility,
  );

  const propertyImports = imports.filter((item) =>
    matchesProperty(propertyId, item.account_id, item.usage_point),
  );
  const sourceReadings = filterReadings(
    scopedReadings,
    propertyId,
    utility,
    effectiveGranularity,
    days,
    date,
  );

  return {
    property_id: propertyId,
    utility,
    granularity: date ? "hour" : granularity,
    date,
    unit,
    total: Math.round(total * 1000) / 1000,
    average: dataPoints.length ? Math.round((total / dataPoints.length) * 1000) / 1000 : 0,
    peak,
    points,
    sources: buildUsageSources(sourceReadings, propertyImports, objectId, utility),
    missing: buildUsageMissing(readings, propertyId, utility, granularity, days, date, objectId),
    last_import_at: utilityImports[0]?.imported_at ?? null,
    report: buildEnergyReport(
      readings,
      propertyId,
      utility,
      effectiveGranularity,
      days,
      date,
    ),
  };
}

export async function getOverview(propertyId: string | null = null): Promise<{
  settings: Settings;
  properties: Property[];
  selected_property: Property | null;
  import_count: number;
  electric_hours: number;
  electric_days: number;
  electric_billing_periods: number;
  water_hours: number;
  water_days: number;
  water_billing_periods: number;
}> {
  const settings = await loadSettings();
  const properties = await listProperties();
  const effectivePropertyId = propertyId ?? settings.selected_property_id;
  const selected_property = properties.find((item) => item.id === effectivePropertyId) ?? null;
  const readings = await loadReadings();
  const scoped = readings.filter((r) =>
    matchesProperty(effectivePropertyId, r.account_id, r.usage_point),
  );
  const count = (utility: Utility, granularity: Granularity) =>
    scoped.filter((r) => r.utility === utility && r.granularity === granularity).length;

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

export async function getSyncViewQueue(): Promise<SyncViewQueue | null> {
  if (syncQueueCache !== undefined) return syncQueueCache;
  await ensureDataRoot();
  if (!existsSync(SYNC_QUEUE_PATH)) {
    syncQueueCache = null;
    return syncQueueCache;
  }
  syncQueueCache = JSON.parse(await readFile(SYNC_QUEUE_PATH, "utf8")) as SyncViewQueue;
  return syncQueueCache;
}

export async function setSyncViewQueue(
  propertyId: string | null,
  utility: Utility,
  start: string,
  end: string,
  label: string,
): Promise<SyncViewQueue> {
  const queue: SyncViewQueue = {
    property_id: propertyId,
    utility,
    start,
    end,
    label,
    queued_at: new Date().toISOString(),
  };
  await ensureDataRoot();
  syncQueueCache = queue;
  await writeFile(SYNC_QUEUE_PATH, JSON.stringify(queue, null, 2));
  return queue;
}

export function resolvePropertyId(
  requested: string | null,
  settings: Settings,
  properties: Property[],
): string | null {
  if (requested) return requested;
  if (settings.selected_property_id) return settings.selected_property_id;
  return properties[0]?.id ?? null;
}

type SourceErrorsFile = {
  errors: SourceFetchError[];
};

let sourceErrorsCache: SourceFetchError[] | null = null;

function propertyIdFromObjectId(settings: Settings, objectId: string): string | null {
  for (const [propertyId, stored] of Object.entries(settings.property_object_ids)) {
    if (stored === objectId) return propertyId;
  }
  return null;
}

export function parseNbuUrlRange(url: string): { start: string; end: string } | null {
  try {
    const parsed = new URL(url);
    const startRaw = parsed.searchParams.get("StartDateTime");
    const endRaw = parsed.searchParams.get("EndDateTime");
    if (!startRaw || !endRaw) return null;
    const start = startRaw.slice(0, 10);
    const endExclusive = endRaw.slice(0, 10);
    return { start, end: addDaysToDateKey(endExclusive, -1) };
  } catch {
    return null;
  }
}

async function loadSourceErrors(): Promise<SourceFetchError[]> {
  if (sourceErrorsCache) return sourceErrorsCache;
  await ensureDataRoot();
  if (!existsSync(SOURCE_ERRORS_PATH)) {
    sourceErrorsCache = [];
    return sourceErrorsCache;
  }
  const parsed = JSON.parse(await readFile(SOURCE_ERRORS_PATH, "utf8")) as SourceErrorsFile;
  sourceErrorsCache = parsed.errors ?? [];
  return sourceErrorsCache;
}

async function saveSourceErrors(errors: SourceFetchError[]): Promise<void> {
  sourceErrorsCache = errors;
  await writeFile(SOURCE_ERRORS_PATH, JSON.stringify({ errors }, null, 2));
}

function errorKey(
  propertyId: string | null,
  utility: Utility,
  start: string,
  end: string,
): string {
  return [propertyId ?? "", utility, start, end].join("|");
}

function upsertSourceError(
  errors: SourceFetchError[],
  entry: Omit<SourceFetchError, "recorded_at">,
): SourceFetchError[] {
  const key = errorKey(entry.property_id, entry.utility, entry.start, entry.end);
  const filtered = errors.filter(
    (item) => errorKey(item.property_id, item.utility, item.start, item.end) !== key,
  );
  return [{ ...entry, recorded_at: new Date().toISOString() }, ...filtered].slice(0, 20_000);
}

function findSourceFetchError(
  errors: SourceFetchError[],
  propertyId: string | null,
  utility: Utility,
  start: string,
  end: string,
): SourceFetchError | null {
  const key = errorKey(propertyId, utility, start, end);
  return (
    errors.find((item) => errorKey(item.property_id, item.utility, item.start, item.end) === key) ??
    null
  );
}

function formatMissingGapLabel(gap: CoverageGap, hoursPresent: number | null): string {
  const range =
    gap.start === gap.end ? formatDateLabel(gap.start) : formatRangeLabel(gap.start, gap.end);
  const kind = gap.status === "missing" ? "Missing" : "Partial";
  if (gap.days === 1 && gap.status === "partial" && hoursPresent !== null) {
    return `${kind}: ${range} (${hoursPresent}/24 hours)`;
  }
  return `${kind}: ${range} (${gap.days} day${gap.days === 1 ? "" : "s"})`;
}

function buildNbuVerifyRunnerScript(
  items: Array<{ start: string; end: string; nbu_url: string }>,
  footer: string,
): string {
  return `(async () => {
  ${nbuVerifyLogicJs()}
  const probes = ${JSON.stringify(items)};
  const results = [];
  for (const probe of probes) {
    try {
      const response = await fetch(probe.nbu_url, { credentials: "include", cache: "no-store" });
      const text = await response.text();
      const result = analyzeNbuResponse(response.status, text);
      results.push({
        start: probe.start,
        end: probe.end,
        nbu_url: probe.nbu_url,
        status: response.status,
        verdict: result.verdict,
        detail: result.detail,
        error: result.verdict === "NBU_HAS_DATA" ? null : result.detail,
        response_preview: text.slice(0, 300),
        hasData: result.hasData,
      });
      console.log("[NBU verify]", probe.start, probe.end, result.verdict, result.detail);
    } catch (error) {
      results.push({
        start: probe.start,
        end: probe.end,
        nbu_url: probe.nbu_url,
        status: null,
        verdict: "NBU_FETCH_FAILED",
        detail: error?.message || String(error),
        error: error?.message || String(error),
        response_preview: null,
        hasData: false,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  console.table(results.map((item) => ({
    start: item.start,
    end: item.end,
    verdict: item.verdict,
    detail: item.detail,
    status: item.status,
  })));
  const confirmedMissing = results.filter((item) => item.verdict === "NBU_MISSING").length;
  const nbuErrors = results.filter((item) => item.verdict === "NBU_ERROR" || item.verdict === "NBU_FETCH_FAILED").length;
  const onNbuOnly = results.filter((item) => item.verdict === "NBU_HAS_DATA").length;
  console.log("Summary:", confirmedMissing, "confirmed missing on NBU ·", nbuErrors, "NBU errors ·", onNbuOnly, "have data on NBU (local sync gap)");
  ${footer}
  return results;
})();`;
}

export function buildNbuVerifyAllScript(
  items: Array<{ start: string; end: string; nbu_url: string }>,
): string {
  return buildNbuVerifyRunnerScript(items, "");
}

export function buildBulkProbeScript(
  baseUrl: string,
  token: string,
  propertyId: string | null,
  utility: Utility,
  items: Array<{ start: string; end: string; nbu_url: string }>,
): string {
  const trimmedBase = baseUrl.replace(/\/$/, "");
  const footer = `const report = await fetch(${JSON.stringify(trimmedBase + "/api/missing-sources/probes")}, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Ingest-Token": ${JSON.stringify(token)} },
    body: JSON.stringify({
      property_id: ${JSON.stringify(propertyId)},
      utility: ${JSON.stringify(utility)},
      probes: results.map((item) => ({
        start: item.start,
        end: item.end,
        nbu_url: item.nbu_url,
        status: item.status,
        verdict: item.verdict,
        detail: item.detail,
        error: item.error,
        response_preview: item.response_preview,
      })),
    }),
  });
  const payload = await report.json().catch(() => ({}));
  console.log("Saved probe results to dashboard:", report.status, payload);`;
  return buildNbuVerifyRunnerScript(items, footer);
}

function syncErrorVerdict(message: string, status: number | null): NbuVerdict {
  if (status && status >= 400) return "NBU_ERROR";
  if (/empty|unsupported|no readings/i.test(message)) return "NBU_MISSING";
  return "NBU_ERROR";
}

export async function recordFetchProbes(
  propertyId: string | null,
  utility: Utility,
  probes: Array<{
    start: string;
    end: string;
    nbu_url?: string | null;
    status?: number | null;
    verdict?: NbuVerdict | null;
    detail?: string | null;
    error?: string | null;
    response_preview?: string | null;
  }>,
): Promise<number> {
  let errors = await loadSourceErrors();
  let recorded = 0;

  for (const probe of probes) {
    if (!probe.start || !probe.end) continue;
    const verdict =
      probe.verdict ??
      (probe.error?.trim() ? ("NBU_ERROR" as NbuVerdict) : ("NBU_HAS_DATA" as NbuVerdict));
    const detail = probe.detail?.trim() || probe.error?.trim() || verdict;
    errors = upsertSourceError(errors, {
      property_id: propertyId,
      utility,
      start: probe.start,
      end: probe.end,
      nbu_url: probe.nbu_url ?? null,
      status: probe.status ?? null,
      verdict,
      error: verdict === "NBU_HAS_DATA" ? detail : detail,
      response_preview: probe.response_preview ?? null,
      source: "probe",
    });
    recorded += 1;
  }

  if (recorded) await saveSourceErrors(errors);
  return recorded;
}

export async function recordSyncFetchErrors(input: {
  utility?: Utility;
  object_id?: string;
  property_id?: string | null;
  errors: Array<{
    label?: string;
    url?: string;
    error?: string;
    status?: number | null;
  }>;
}): Promise<number> {
  const settings = await loadSettings();
  const utility = input.utility === "water" ? "water" : "electric";
  const propertyId =
    input.property_id ??
    (input.object_id ? propertyIdFromObjectId(settings, input.object_id) : null) ??
    settings.selected_property_id;

  let errors = await loadSourceErrors();
  let recorded = 0;

  for (const item of input.errors) {
    const message = item.error?.trim();
    if (!message) continue;
    const range = item.url ? parseNbuUrlRange(item.url) : null;
    if (!range) continue;

    errors = upsertSourceError(errors, {
      property_id: propertyId,
      utility,
      start: range.start,
      end: range.end,
      nbu_url: item.url ?? null,
      status: item.status ?? null,
      verdict: syncErrorVerdict(message, item.status ?? null),
      error: message,
      response_preview: null,
      source: "sync",
    });
    recorded += 1;
  }

  if (recorded) await saveSourceErrors(errors);
  return recorded;
}

export async function getMissingSources(
  propertyId: string | null,
  utility: Utility,
  baseUrl: string,
): Promise<MissingSourcesSummary> {
  const settings = await loadSettings();
  const objectId = propertyId ? settings.property_object_ids[propertyId] ?? null : null;
  const coverage = await getCoverageSummary(propertyId, utility);
  const storedErrors = await loadSourceErrors();
  const daysByDate = new Map(coverage.days.map((day) => [day.date, day]));
  const probeLimit = 500;

  const items: MissingSource[] = coverage.gaps.map((gap) => {
    const hoursPresent =
      gap.days === 1 ? (daysByDate.get(gap.start)?.hours_present ?? null) : null;
    const nbuLinks = attachNbuLinks({ start: gap.start, end: gap.end }, objectId, utility, true);
    const matched = findSourceFetchError(storedErrors, propertyId, utility, gap.start, gap.end);

    return {
      start: gap.start,
      end: gap.end,
      days: gap.days,
      status: gap.status,
      label: formatMissingGapLabel(gap, hoursPresent),
      hours_present: hoursPresent,
      ...nbuLinks,
      nbu_verdict:
        matched?.verdict ??
        (matched?.error ? syncErrorVerdict(matched.error, matched.status ?? null) : null),
      nbu_detail: matched?.error ?? null,
      fetch_status: matched?.status ?? null,
      fetch_error:
        matched?.verdict && matched.verdict !== "NBU_HAS_DATA" ? matched.error : null,
      fetch_preview: matched?.response_preview ?? null,
      fetch_probed_at: matched?.recorded_at ?? null,
      fetch_source: matched?.source ?? null,
    };
  });

  const probeCandidates = items
    .filter((item) => item.nbu_url)
    .slice(0, probeLimit)
    .map((item) => ({ start: item.start, end: item.end, nbu_url: item.nbu_url as string }));

  return {
    property_id: propertyId,
    utility,
    object_id: objectId,
    range_start: coverage.range_start,
    range_end: coverage.range_end,
    total: items.length,
    checked_on_nbu: items.filter((item) => item.nbu_verdict).length,
    confirmed_missing_on_nbu: items.filter(
      (item) => item.nbu_verdict === "NBU_MISSING",
    ).length,
    has_data_on_nbu: items.filter((item) => item.nbu_verdict === "NBU_HAS_DATA").length,
    with_errors: items.filter(
      (item) => item.nbu_verdict === "NBU_ERROR" || item.nbu_verdict === "NBU_FETCH_FAILED",
    ).length,
    items,
    verify_all_script:
      objectId && probeCandidates.length ? buildNbuVerifyAllScript(probeCandidates) : null,
    probe_script:
      objectId && probeCandidates.length
        ? buildBulkProbeScript(baseUrl, settings.ingest_token, propertyId, utility, probeCandidates)
        : null,
  };
}