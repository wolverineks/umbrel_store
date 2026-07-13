import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export const DATA_ROOT = process.env.__ENV_PREFIX___DATA_DIR ?? "/data";
const SETTINGS_PATH = path.join(DATA_ROOT, "settings.json");
const KEEP_ON_CLEAR = new Set(["settings.json", ".gitkeep"]);

export type Settings = {
  note: string;
  ingest_token: string;
};

let settingsCache: Settings | null = null;

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
    settingsCache = { note: "", ingest_token: newToken() };
    await saveSettings(settingsCache);
    return settingsCache;
  }
  const raw = JSON.parse(await readFile(SETTINGS_PATH, "utf8")) as Partial<Settings>;
  settingsCache = {
    note: String(raw.note ?? ""),
    ingest_token: String(raw.ingest_token ?? newToken()),
  };
  if (!raw.ingest_token) {
    await saveSettings(settingsCache);
  }
  return settingsCache;
}

export async function saveSettings(settings: Settings): Promise<void> {
  settingsCache = settings;
  await ensureDataRoot();
  await writeFile(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

export async function rotateIngestToken(): Promise<Settings> {
  const settings = await loadSettings();
  settings.ingest_token = newToken();
  await saveSettings(settings);
  return settings;
}

export async function updateNote(note: string): Promise<Settings> {
  const settings = await loadSettings();
  settings.note = note.trim();
  await saveSettings(settings);
  return settings;
}

export type ClearDataResult = { cleared_files: number };

export async function clearAppData(): Promise<ClearDataResult> {
  await ensureDataRoot();
  const entries = await readdir(DATA_ROOT, { withFileTypes: true });
  let cleared_files = 0;
  for (const entry of entries) {
    if (KEEP_ON_CLEAR.has(entry.name)) continue;
    await rm(path.join(DATA_ROOT, entry.name), { recursive: true, force: true });
    cleared_files += 1;
  }
  return { cleared_files };
}

export function resetStoreCaches(): void {
  settingsCache = null;
}