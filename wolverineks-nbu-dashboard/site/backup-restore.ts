import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const MANIFEST_FILE = "backup-manifest.json";
const SKIP_NAMES = new Set([".gitkeep"]);

export type BackupObjectId = {
  property_id: string;
  label: string;
  object_id: string;
};

export type BackupManifest = {
  exported_at: string;
  source: string;
  reading_count: number;
  import_count: number;
  object_id_count: number;
};

export type BackupStatus = {
  data_dir: string;
  backup_dir: string;
  backup_host_path: string;
  backup_available: boolean;
  backup_writable: boolean;
  backup_writable_error: string | null;
  live_reading_count: number;
  live_import_count: number;
  live_object_id_count: number;
  live_object_ids: BackupObjectId[];
  backup_reading_count: number;
  backup_import_count: number;
  backup_object_id_count: number;
  backup_object_ids: BackupObjectId[];
  backup_updated_at: string | null;
};

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  if (!existsSync(filePath)) return fallback;
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function countReadings(dataDir: string): Promise<number> {
  const parsed = await readJsonFile<{ readings?: unknown[] }>(
    path.join(dataDir, "readings.json"),
    { readings: [] },
  );
  return Array.isArray(parsed.readings) ? parsed.readings.length : 0;
}

async function countImports(dataDir: string): Promise<number> {
  const parsed = await readJsonFile<unknown[]>(path.join(dataDir, "imports.json"), []);
  return Array.isArray(parsed) ? parsed.length : 0;
}

type SettingsSnapshot = {
  property_object_ids?: Record<string, string>;
  property_labels?: Record<string, string>;
};

async function readObjectIds(dataDir: string): Promise<BackupObjectId[]> {
  const settings = await readJsonFile<SettingsSnapshot>(path.join(dataDir, "settings.json"), {});
  const objectIds = settings.property_object_ids ?? {};
  const labels = settings.property_labels ?? {};
  return Object.entries(objectIds)
    .map(([property_id, object_id]) => ({
      property_id,
      label: labels[property_id]?.trim() || property_id,
      object_id: String(object_id).trim(),
    }))
    .filter((item) => item.object_id)
    .sort((a, b) => a.label.localeCompare(b.label));
}

async function isWritableDir(dir: string): Promise<{ ok: boolean; error: string | null }> {
  try {
    await mkdir(dir, { recursive: true });
    const probe = path.join(dir, `.write-test-${process.pid}`);
    await writeFile(probe, "ok", "utf8");
    await rm(probe, { force: true });
    return { ok: true, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "not writable";
    return { ok: false, error: message };
  }
}

async function readManifest(backupDir: string): Promise<BackupManifest | null> {
  const manifestPath = path.join(backupDir, MANIFEST_FILE);
  if (!existsSync(manifestPath)) return null;
  try {
    const raw = await readFile(manifestPath, "utf8");
    return JSON.parse(raw) as BackupManifest;
  } catch {
    return null;
  }
}

async function clearDirectory(dir: string): Promise<void> {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
    return;
  }
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_NAMES.has(entry.name)) continue;
    await rm(path.join(dir, entry.name), { recursive: true, force: true });
  }
}

async function syncDirectory(source: string, destination: string): Promise<void> {
  if (!existsSync(source)) {
    throw new Error(`Source directory does not exist: ${source}`);
  }

  await mkdir(destination, { recursive: true });
  const sourceEntries = await readdir(source, { withFileTypes: true });
  const sourceNames = new Set(
    sourceEntries.map((entry) => entry.name).filter((name) => !SKIP_NAMES.has(name)),
  );

  if (existsSync(destination)) {
    const destEntries = await readdir(destination, { withFileTypes: true });
    for (const entry of destEntries) {
      const name = String(entry.name);
      if (SKIP_NAMES.has(name) || sourceNames.has(name)) continue;
      await rm(path.join(destination, name), { recursive: true, force: true });
    }
  }

  for (const entry of sourceEntries) {
    if (SKIP_NAMES.has(entry.name)) continue;
    const srcPath = path.join(source, entry.name);
    const destPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await syncDirectory(srcPath, destPath);
      continue;
    }
    if (entry.isFile()) {
      await copyFile(srcPath, destPath);
    }
  }
}

function looksLikeNbuBackup(backupDir: string): boolean {
  return (
    existsSync(path.join(backupDir, "readings.json")) ||
    existsSync(path.join(backupDir, "settings.json"))
  );
}

export async function getBackupStatus(
  dataDir: string,
  backupDir: string,
  backupHostPath: string,
): Promise<BackupStatus> {
  const backupAvailable = existsSync(backupDir) && looksLikeNbuBackup(backupDir);
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

export async function exportNbuData(
  dataDir: string,
  backupDir: string,
  backupHostPath: string,
): Promise<BackupStatus> {
  const writable = await isWritableDir(backupDir);
  if (!writable.ok) {
    throw new Error(
      `Backup directory is not writable: ${backupDir}${writable.error ? ` (${writable.error})` : ""}`,
    );
  }

  await syncDirectory(dataDir, backupDir);

  const liveObjectIds = await readObjectIds(dataDir);
  const manifest: BackupManifest = {
    exported_at: new Date().toISOString(),
    source: dataDir,
    reading_count: await countReadings(dataDir),
    import_count: await countImports(dataDir),
    object_id_count: liveObjectIds.length,
  };
  await writeFile(path.join(backupDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return getBackupStatus(dataDir, backupDir, backupHostPath);
}

export async function importNbuData(
  dataDir: string,
  backupDir: string,
  backupHostPath: string,
): Promise<BackupStatus> {
  if (!existsSync(backupDir) || !looksLikeNbuBackup(backupDir)) {
    throw new Error("No backup found. Run Back up now first.");
  }

  await clearDirectory(dataDir);
  await syncDirectory(backupDir, dataDir);
  await rm(path.join(dataDir, MANIFEST_FILE), { force: true });
  return getBackupStatus(dataDir, backupDir, backupHostPath);
}