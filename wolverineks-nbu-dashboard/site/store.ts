import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Granularity, ParseResult, ParsedReading, Utility } from "./parsers";

const DATA_ROOT = process.env.NBU_DATA_DIR ?? "/data";
const SETTINGS_PATH = path.join(DATA_ROOT, "settings.json");
const IMPORTS_PATH = path.join(DATA_ROOT, "imports.json");
const READINGS_PATH = path.join(DATA_ROOT, "readings.json");

export type Settings = {
  ingest_token: string;
  account_id: string | null;
  usage_point: string | null;
  address: string | null;
};

export type ImportRecord = {
  id: string;
  filename: string;
  format: ParseResult["format"];
  utility: Utility;
  imported_at: string;
  account_id: string | null;
  usage_point: string | null;
  reading_count: number;
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
};

export type UsageSummary = {
  utility: Utility;
  granularity: Granularity;
  unit: "kWh" | "gal";
  total: number;
  average: number;
  peak: UsagePoint | null;
  points: UsagePoint[];
  last_import_at: string | null;
};

let settingsCache: Settings | null = null;
let importsCache: ImportRecord[] | null = null;
let readingsCache: StoredReading[] | null = null;

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
      account_id: null,
      usage_point: null,
      address: null,
    };
    await saveSettings(settingsCache);
    return settingsCache;
  }
  const raw = await readFile(SETTINGS_PATH, "utf8");
  settingsCache = JSON.parse(raw) as Settings;
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

async function loadImports(): Promise<ImportRecord[]> {
  if (importsCache) return importsCache;
  await ensureDataRoot();
  if (!existsSync(IMPORTS_PATH)) {
    importsCache = [];
    return importsCache;
  }
  importsCache = JSON.parse(await readFile(IMPORTS_PATH, "utf8")) as ImportRecord[];
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
  ].join("|");
}

export async function importParsed(result: ParseResult): Promise<ImportRecord> {
  const settings = await loadSettings();
  const imports = await loadImports();
  const readings = await loadReadings();

  if (result.account_id && !settings.account_id) settings.account_id = result.account_id;
  if (result.usage_point && !settings.usage_point) settings.usage_point = result.usage_point;
  if (result.address && !settings.address) settings.address = result.address;
  await saveSettings(settings);

  const importId = randomBytes(8).toString("hex");
  const importRecord: ImportRecord = {
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
    if (existingKeys.has(key)) continue;
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

export async function listImports(limit = 20): Promise<ImportRecord[]> {
  const imports = await loadImports();
  return imports.slice(0, limit);
}

function filterReadings(
  readings: StoredReading[],
  utility: Utility,
  granularity: Granularity,
  days: number | null,
): StoredReading[] {
  const cutoff = days ? Date.now() - days * 86_400_000 : null;
  return readings
    .filter((r) => r.utility === utility && r.granularity === granularity)
    .filter((r) => !cutoff || new Date(r.period_start).getTime() >= cutoff)
    .sort((a, b) => a.period_start.localeCompare(b.period_start));
}

export async function getUsageSummary(
  utility: Utility,
  granularity: Granularity,
  days: number | null,
): Promise<UsageSummary> {
  const readings = await loadReadings();
  const imports = await loadImports();
  const filtered = filterReadings(readings, utility, granularity, days);
  const points: UsagePoint[] = filtered.map((r) => ({
    period_start: r.period_start,
    value: Math.round(r.value * 1000) / 1000,
  }));
  const total = points.reduce((sum, p) => sum + p.value, 0);
  const peak = points.reduce<UsagePoint | null>((best, point) => {
    if (!best || point.value > best.value) return point;
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

export async function getOverview(): Promise<{
  settings: Settings;
  imports: ImportRecord[];
  electric_hours: number;
  electric_days: number;
  electric_billing_periods: number;
  water_hours: number;
  water_days: number;
  water_billing_periods: number;
}> {
  const settings = await loadSettings();
  const imports = await loadImports();
  const readings = await loadReadings();
  const count = (utility: Utility, granularity: Granularity) =>
    readings.filter((r) => r.utility === utility && r.granularity === granularity).length;

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