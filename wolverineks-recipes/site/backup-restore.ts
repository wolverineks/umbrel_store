import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const MANIFEST_FILE = "backup-manifest.json";
const SKIP_NAMES = new Set([".gitkeep"]);
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif"];

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

type IndexEntry = {
  id: string;
  title: string;
  source_url: string;
  created_at: string;
  updated_at: string;
};

type CategoryItem = {
  recipe_id: string;
  category_id: string;
};

function normalizeSourceUrl(sourceUrl: string): string {
  return sourceUrl.trim();
}

function entryTimestamp(entry: IndexEntry): number {
  const value = new Date(entry.updated_at).getTime();
  return Number.isFinite(value) ? value : 0;
}

function pickNewerEntry(a: IndexEntry, b: IndexEntry): IndexEntry {
  return entryTimestamp(a) >= entryTimestamp(b) ? a : b;
}

function dedupeIndexEntries(entries: IndexEntry[]): {
  kept: IndexEntry[];
  removedIds: Set<string>;
  idRemap: Map<string, string>;
} {
  const byId = new Map<string, IndexEntry>();
  for (const entry of entries) {
    if (!entry?.id) continue;
    const previous = byId.get(entry.id);
    byId.set(entry.id, previous ? pickNewerEntry(previous, entry) : entry);
  }

  const bySource = new Map<string, IndexEntry>();
  for (const entry of byId.values()) {
    const key = normalizeSourceUrl(entry.source_url) || `id:${entry.id}`;
    const previous = bySource.get(key);
    bySource.set(key, previous ? pickNewerEntry(previous, entry) : entry);
  }

  const kept = [...bySource.values()].sort((a, b) => entryTimestamp(b) - entryTimestamp(a));
  const keptIds = new Set(kept.map((entry) => entry.id));
  const removedIds = new Set<string>();
  const idRemap = new Map<string, string>();

  for (const entry of byId.values()) {
    if (keptIds.has(entry.id)) continue;
    removedIds.add(entry.id);
    const key = normalizeSourceUrl(entry.source_url) || `id:${entry.id}`;
    const replacement = bySource.get(key);
    if (replacement) idRemap.set(entry.id, replacement.id);
  }

  return { kept, removedIds, idRemap };
}

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

async function writeJsonArray(filePath: string, entries: unknown[]): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
}

async function removeRecipeFiles(recipesDir: string, imagesDir: string, recipeIds: Set<string>): Promise<void> {
  for (const id of recipeIds) {
    await rm(path.join(recipesDir, `${id}.json`), { force: true });
    for (const ext of IMAGE_EXTENSIONS) {
      await rm(path.join(imagesDir, `${id}${ext}`), { force: true });
    }
  }
}

async function pruneRecipeFiles(recipesDir: string, imagesDir: string, keptIds: Set<string>): Promise<void> {
  if (!existsSync(recipesDir)) return;
  const files = await readdir(recipesDir);
  const orphanIds = new Set<string>();
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const id = file.slice(0, -".json".length);
    if (!keptIds.has(id)) orphanIds.add(id);
  }
  await removeRecipeFiles(recipesDir, imagesDir, orphanIds);
}

async function readCategoryItems(itemsPath: string): Promise<CategoryItem[]> {
  if (!existsSync(itemsPath)) return [];
  try {
    const raw = await readFile(itemsPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed as CategoryItem[];
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as { items?: unknown }).items)) {
      return (parsed as { items: CategoryItem[] }).items;
    }
  } catch {
    // Fall through to empty list.
  }
  return [];
}

async function remapCategoryItems(dataDir: string, idRemap: Map<string, string>, removedIds: Set<string>): Promise<void> {
  const itemsPath = path.join(dataDir, "category-items.json");
  const raw = await readCategoryItems(itemsPath);
  if (!raw.length && !existsSync(itemsPath)) return;

  const next: CategoryItem[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item?.recipe_id || !item?.category_id) continue;
    let recipeId = item.recipe_id;
    if (removedIds.has(recipeId)) {
      const replacement = idRemap.get(recipeId);
      if (!replacement) continue;
      recipeId = replacement;
    }
    const key = `${recipeId}:${item.category_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    next.push({ recipe_id: recipeId, category_id: item.category_id });
  }

  await writeFile(itemsPath, `${JSON.stringify({ items: next }, null, 2)}\n`, "utf8");
}

async function dedupeRecipeStore(
  indexPath: string,
  recipesDir: string,
  imagesDir: string,
): Promise<ReturnType<typeof dedupeIndexEntries>> {
  const entries = await readJsonArray<IndexEntry>(indexPath);
  const result = dedupeIndexEntries(entries);
  if (result.removedIds.size > 0) {
    await removeRecipeFiles(recipesDir, imagesDir, result.removedIds);
  }
  const keptIds = new Set(result.kept.map((entry) => entry.id));
  await pruneRecipeFiles(recipesDir, imagesDir, keptIds);
  if (entries.length > 0 || existsSync(indexPath)) {
    await writeJsonArray(indexPath, result.kept);
  }
  return result;
}

async function dedupeRestoredLibrary(dataDir: string): Promise<void> {
  const library = await dedupeRecipeStore(
    path.join(dataDir, "index.json"),
    path.join(dataDir, "recipes"),
    path.join(dataDir, "images"),
  );

  await dedupeRecipeStore(
    path.join(dataDir, ".trash", "index.json"),
    path.join(dataDir, ".trash", "recipes"),
    path.join(dataDir, ".trash", "images"),
  );

  await dedupeRecipeStore(
    path.join(dataDir, ".blocklist", "index.json"),
    path.join(dataDir, ".blocklist", "recipes"),
    path.join(dataDir, ".blocklist", "images"),
  );

  await remapCategoryItems(dataDir, library.idRemap, library.removedIds);
  await rm(path.join(dataDir, MANIFEST_FILE), { force: true });
}

async function countRecipesInDir(dataDir: string): Promise<number> {
  const indexPath = path.join(dataDir, "index.json");
  const entries = await readJsonArray<IndexEntry>(indexPath);
  return dedupeIndexEntries(entries).kept.length;
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

  await syncDirectory(backupDir, dataDir);
  await dedupeRestoredLibrary(dataDir);
  return getBackupStatus(dataDir, backupDir);
}