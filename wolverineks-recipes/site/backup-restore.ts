import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  canonicalSourceUrl,
  dedupeIndexEntries,
  type IndexEntry,
  reconcileLibraryData,
} from "./library-dedupe";

const MANIFEST_FILE = "backup-manifest.json";
const SKIP_NAMES = new Set([".gitkeep"]);

export type BackupManifest = {
  exported_at: string;
  source: string;
};

export type BackupStatus = {
  data_dir: string;
  backup_dir: string;
  backup_available: boolean;
  backup_writable: boolean;
  backup_writable_error?: string | null;
  library_recipe_count: number;
  backup_recipe_count: number;
  backup_updated_at: string | null;
};

async function readJsonArray<T>(filePath: string): Promise<T[]> {
  if (!existsSync(filePath)) return [];
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

async function countRecipesInDir(dataDir: string): Promise<number> {
  const indexPath = path.join(dataDir, "index.json");
  const entries = await readJsonArray<IndexEntry>(indexPath);
  return dedupeIndexEntries(entries, new Map()).kept.length;
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
  const sourceNames = new Set(sourceEntries.map((entry) => entry.name).filter((name) => !SKIP_NAMES.has(name)));

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

function looksLikeRecipesBackup(backupDir: string): boolean {
  return existsSync(path.join(backupDir, "index.json")) || existsSync(path.join(backupDir, "recipes"));
}

export async function getBackupStatus(dataDir: string, backupDir: string): Promise<BackupStatus> {
  const backupAvailable = existsSync(backupDir) && looksLikeRecipesBackup(backupDir);
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

export async function exportRecipesData(dataDir: string, backupDir: string): Promise<BackupStatus> {
  const writable = await isWritableDir(backupDir);
  if (!writable.ok) {
    throw new Error(
      `Backup directory is not writable: ${backupDir}${writable.error ? ` (${writable.error})` : ""}. Restart the Recipes app after updating.`,
    );
  }

  await reconcileLibraryData(dataDir);
  await syncDirectory(dataDir, backupDir);

  const manifest: BackupManifest = {
    exported_at: new Date().toISOString(),
    source: dataDir,
  };
  await writeFile(path.join(backupDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return getBackupStatus(dataDir, backupDir);
}

export async function importRecipesData(dataDir: string, backupDir: string): Promise<BackupStatus> {
  if (!existsSync(backupDir) || !looksLikeRecipesBackup(backupDir)) {
    throw new Error("No backup found. Run Back up now first.");
  }

  await clearDirectory(dataDir);
  await syncDirectory(backupDir, dataDir);
  await reconcileLibraryData(dataDir);
  await rm(path.join(dataDir, MANIFEST_FILE), { force: true });
  return getBackupStatus(dataDir, backupDir);
}

export { canonicalSourceUrl };