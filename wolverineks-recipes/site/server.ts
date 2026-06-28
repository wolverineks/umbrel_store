import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { exportRecipesData, getBackupStatus, importRecipesData } from "./backup-restore";
import { canonicalSourceUrl, dedupeIndexEntries, reconcileLibraryData } from "./library-dedupe";
import { fetchRecipePage, formatRecipeWithGrok } from "./recipe-import";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const APP_VERSION = "1.0.47";
const DEFAULT_EXTENSION_MODEL = "grok-4-1-fast";
const EXTENSION_MODELS = ["grok-4-1-fast", "grok-4-fast", "grok-4"] as const;
const SAMPLE_SOURCE_PREFIX = "urn:wolverineks-recipes:sample:";
const DATA_ROOT = process.env.RECIPES_DATA_DIR ?? "/data";
const BACKUP_ROOT = process.env.RECIPES_BACKUP_DIR ?? "/backup";
const BACKUP_HOST_PATH = process.env.RECIPES_BACKUP_HOST_PATH ?? "/home/umbrel/recipes-backup";
const RECIPES_DIR = path.join(DATA_ROOT, "recipes");
const IMAGES_DIR = path.join(DATA_ROOT, "images");
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif"] as const;
const IMAGE_MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};
const IMAGE_CONTENT_TYPES: Record<string, (typeof IMAGE_EXTENSIONS)[number]> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};
const INDEX_PATH = path.join(DATA_ROOT, "index.json");
const SETTINGS_PATH = path.join(DATA_ROOT, "settings.json");
const SETTINGS_BACKUP_PATH = path.join(DATA_ROOT, "settings.json.bak");
const CATEGORIES_PATH = path.join(DATA_ROOT, "categories.json");
const CATEGORY_ITEMS_PATH = path.join(DATA_ROOT, "category-items.json");
const TRASH_DIR = path.join(DATA_ROOT, ".trash");
const TRASH_RECIPES_DIR = path.join(TRASH_DIR, "recipes");
const TRASH_IMAGES_DIR = path.join(TRASH_DIR, "images");
const TRASH_INDEX_PATH = path.join(TRASH_DIR, "index.json");
const BLOCKLIST_DIR = path.join(DATA_ROOT, ".blocklist");
const BLOCKLIST_RECIPES_DIR = path.join(BLOCKLIST_DIR, "recipes");
const BLOCKLIST_IMAGES_DIR = path.join(BLOCKLIST_DIR, "images");
const BLOCKLIST_INDEX_PATH = path.join(BLOCKLIST_DIR, "index.json");
const ICON_PATH = path.join(__dirname, "icon.svg");
const SEED_IMAGES_DIR = path.join(__dirname, "seed-images");

type Recipe = {
  id: string;
  title: string;
  description: string | null;
  servings: string | null;
  prep_time: string | null;
  cook_time: string | null;
  total_time: string | null;
  ingredients: string[];
  instructions: string[];
  notes: string | null;
  source_url: string;
  created_at: string;
  updated_at: string;
};

type RecipeIndexEntry = {
  id: string;
  title: string;
  source_url: string;
  created_at: string;
  updated_at: string;
};

type Settings = {
  ingest_token: string;
  extension_api_key?: string | null;
  extension_model?: string | null;
};

type Category = {
  id: string;
  name: string;
};

type CategoryItem = {
  recipe_id: string;
  category_id: string;
};

type TrashIndexEntry = {
  id: string;
  title: string;
  source_url: string;
  created_at: string;
  updated_at: string;
  deleted_at: string;
  category_ids: string[];
};

type BlocklistIndexEntry = {
  id: string;
  title: string;
  source_url: string;
  created_at: string;
  updated_at: string;
  blocked_at: string;
  category_ids: string[];
};

class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

class BlockedRecipeError extends Error {
  sourceUrl: string;

  constructor(sourceUrl: string) {
    super(`Recipe URL is blocked: ${sourceUrl}`);
    this.name = "BlockedRecipeError";
    this.sourceUrl = sourceUrl;
  }
}

async function ensureDataDirs(): Promise<void> {
  await mkdir(RECIPES_DIR, { recursive: true });
  await mkdir(IMAGES_DIR, { recursive: true });
}

async function ensureTrashDirs(): Promise<void> {
  await mkdir(TRASH_RECIPES_DIR, { recursive: true });
  await mkdir(TRASH_IMAGES_DIR, { recursive: true });
}

function trashRecipePath(id: string): string {
  return path.join(TRASH_RECIPES_DIR, `${id}.json`);
}

function findTrashImagePath(id: string): string | null {
  for (const ext of IMAGE_EXTENSIONS) {
    const filePath = path.join(TRASH_IMAGES_DIR, `${id}${ext}`);
    if (existsSync(filePath)) return filePath;
  }
  return null;
}

function recipeHasTrashImage(id: string): boolean {
  return findTrashImagePath(id) !== null;
}

async function deleteTrashImage(id: string): Promise<void> {
  await Promise.all(
    IMAGE_EXTENSIONS.map((ext) => rm(path.join(TRASH_IMAGES_DIR, `${id}${ext}`), { force: true }))
  );
}

function imageFilePath(id: string, ext: string): string {
  return path.join(IMAGES_DIR, `${id}${ext}`);
}

function findRecipeImagePath(id: string): string | null {
  for (const ext of IMAGE_EXTENSIONS) {
    const filePath = imageFilePath(id, ext);
    if (existsSync(filePath)) return filePath;
  }
  return null;
}

function extensionFromImageUrl(imageUrl: string): (typeof IMAGE_EXTENSIONS)[number] | null {
  try {
    const pathname = new URL(imageUrl).pathname.toLowerCase();
    for (const ext of IMAGE_EXTENSIONS) {
      if (pathname.endsWith(ext)) return ext;
    }
  } catch {
    // ignore invalid URLs
  }
  return null;
}

async function deleteRecipeImage(id: string): Promise<void> {
  await Promise.all(
    IMAGE_EXTENSIONS.map((ext) => rm(imageFilePath(id, ext), { force: true }))
  );
}

async function saveRecipeImage(id: string, imageUrl: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(imageUrl);
  } catch {
    return false;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(imageUrl, {
      signal: controller.signal,
      headers: { "User-Agent": `wolverineks-recipes/${APP_VERSION}` },
    });
    if (!response.ok) return false;

    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() || "";
    const ext =
      IMAGE_CONTENT_TYPES[contentType] || extensionFromImageUrl(imageUrl) || null;
    if (!ext) return false;

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 100 || buffer.length > MAX_IMAGE_BYTES) return false;

    await deleteRecipeImage(id);
    await writeFile(imageFilePath(id, ext), buffer);
    return true;
  } catch (error) {
    console.error(`Failed to save image for recipe ${id}:`, error);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function recipeHasImage(id: string): boolean {
  return findRecipeImagePath(id) !== null;
}

function withImageFlag<T extends Recipe>(recipe: T): T & { has_image: boolean } {
  return { ...recipe, has_image: recipeHasImage(recipe.id) };
}

async function loadCategories(): Promise<Category[]> {
  const data = await readJsonFile<{ categories?: Category[] }>(CATEGORIES_PATH, { categories: [] });
  const categories = data.categories || [];
  return categories.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

async function saveCategories(categories: Category[]): Promise<void> {
  const sorted = [...categories].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );
  await writeJsonAtomic(CATEGORIES_PATH, { categories: sorted });
}

async function loadCategoryItems(): Promise<CategoryItem[]> {
  const data = await readJsonFile<{ items?: CategoryItem[] }>(CATEGORY_ITEMS_PATH, { items: [] });
  return data.items || [];
}

async function saveCategoryItems(items: CategoryItem[]): Promise<void> {
  await writeJsonAtomic(CATEGORY_ITEMS_PATH, { items });
}

function categoryIdsForRecipe(items: CategoryItem[], recipeId: string): string[] {
  return items.filter((item) => item.recipe_id === recipeId).map((item) => item.category_id);
}

function categoryNameTaken(categories: Category[], name: string, exceptId?: string): boolean {
  const lower = name.trim().toLowerCase();
  return categories.some((category) => category.id !== exceptId && category.name.toLowerCase() === lower);
}

async function createCategory(name: string): Promise<Category> {
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error("invalid name");
  const categories = await loadCategories();
  if (categoryNameTaken(categories, trimmedName)) throw new Error("category already exists");
  const category: Category = { id: randomUUID(), name: trimmedName };
  await saveCategories([...categories, category]);
  return category;
}

async function renameCategory(categoryId: string, name: string): Promise<Category> {
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error("invalid name");
  const categories = await loadCategories();
  const index = categories.findIndex((category) => category.id === categoryId);
  if (index < 0) throw new NotFoundError("category not found");
  if (categoryNameTaken(categories, trimmedName, categoryId)) throw new Error("category already exists");
  const category = { ...categories[index], name: trimmedName };
  categories[index] = category;
  await saveCategories(categories);
  return category;
}

async function deleteCategory(categoryId: string): Promise<void> {
  const categories = await loadCategories();
  const nextCategories = categories.filter((category) => category.id !== categoryId);
  if (nextCategories.length === categories.length) throw new NotFoundError("category not found");
  await saveCategories(nextCategories);
  const items = await loadCategoryItems();
  await saveCategoryItems(items.filter((item) => item.category_id !== categoryId));
}

async function assignCategoryRecipe(recipeId: string, categoryId: string): Promise<CategoryItem> {
  const recipe = await loadRecipe(recipeId);
  if (!recipe) throw new NotFoundError("recipe not found");
  const categories = await loadCategories();
  if (!categories.some((category) => category.id === categoryId)) {
    throw new NotFoundError("category not found");
  }
  const items = await loadCategoryItems();
  const existing = items.find(
    (item) => item.recipe_id === recipeId && item.category_id === categoryId
  );
  if (existing) return existing;
  const item: CategoryItem = { recipe_id: recipeId, category_id: categoryId };
  await saveCategoryItems([...items, item]);
  return item;
}

async function unassignCategoryRecipe(recipeId: string, categoryId: string): Promise<void> {
  const items = await loadCategoryItems();
  const next = items.filter(
    (item) => !(item.recipe_id === recipeId && item.category_id === categoryId)
  );
  if (next.length === items.length) throw new NotFoundError("category assignment not found");
  await saveCategoryItems(next);
}

async function removeRecipeCategoryItems(recipeId: string): Promise<void> {
  const items = await loadCategoryItems();
  const next = items.filter((item) => item.recipe_id !== recipeId);
  if (next.length !== items.length) await saveCategoryItems(next);
}

async function enrichRecipe(recipe: Recipe): Promise<Recipe & { has_image: boolean; category_ids: string[] }> {
  const items = await loadCategoryItems();
  return {
    ...withImageFlag(recipe),
    category_ids: categoryIdsForRecipe(items, recipe.id),
  };
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  if (!existsSync(filePath)) return fallback;
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}

async function readJsonFileSafe<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return await readJsonFile(filePath, fallback);
  } catch (error) {
    console.error(`Could not read ${filePath}:`, error);
    return fallback;
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, filePath);
}

function normalizeExtensionModel(value: unknown): string {
  const model = typeof value === "string" ? value.trim() : "";
  return (EXTENSION_MODELS as readonly string[]).includes(model) ? model : DEFAULT_EXTENSION_MODEL;
}

let cachedSettings: Settings | null = null;
let settingsInitPromise: Promise<Settings> | null = null;

function normalizeSettingsRecord(value: unknown): Settings | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<Settings>;
  const ingestToken = typeof record.ingest_token === "string" ? record.ingest_token.trim() : "";
  if (!ingestToken) return null;
  return {
    ingest_token: ingestToken,
    extension_api_key:
      typeof record.extension_api_key === "string"
        ? record.extension_api_key
        : record.extension_api_key ?? null,
    extension_model: normalizeExtensionModel(record.extension_model),
  };
}

function settingsFromEnv(): Partial<Settings> {
  const next: Partial<Settings> = {};
  const ingestToken = (process.env.RECIPES_INGEST_TOKEN ?? "").trim();
  const extensionApiKey = (process.env.RECIPES_EXTENSION_API_KEY ?? "").trim();
  const extensionModel = (process.env.RECIPES_EXTENSION_MODEL ?? "").trim();
  if (ingestToken) next.ingest_token = ingestToken;
  if (extensionApiKey) next.extension_api_key = extensionApiKey;
  if (extensionModel) next.extension_model = normalizeExtensionModel(extensionModel);
  return next;
}

async function hasExistingLibraryData(): Promise<boolean> {
  const index = await readJsonFileSafe<RecipeIndexEntry[]>(INDEX_PATH, []);
  if (index.length > 0) return true;
  if (!existsSync(RECIPES_DIR)) return false;
  const files = await readdir(RECIPES_DIR);
  return files.some((file) => file.endsWith(".json"));
}

async function readSettingsFromDisk(): Promise<Settings | null> {
  const candidates = [SETTINGS_PATH, SETTINGS_BACKUP_PATH];
  for (const filePath of candidates) {
    const parsed = normalizeSettingsRecord(await readJsonFileSafe(filePath, null));
    if (parsed) {
      if (filePath === SETTINGS_BACKUP_PATH) {
        console.warn("Recovered Recipes settings from backup file.");
        await persistSettings(parsed);
      }
      return parsed;
    }
  }
  return null;
}

async function persistSettings(
  settings: Settings,
  options: { skipBackup?: boolean } = {},
): Promise<Settings> {
  const normalized = normalizeSettingsRecord(settings);
  if (!normalized) {
    throw new Error("Refusing to persist invalid settings.");
  }
  await writeJsonAtomic(SETTINGS_PATH, normalized);
  if (!options.skipBackup) {
    await writeJsonAtomic(SETTINGS_BACKUP_PATH, normalized);
  }
  cachedSettings = normalized;
  return normalized;
}

function extensionApiKeyPreview(apiKey: string | null | undefined): string | null {
  const trimmed = (apiKey ?? "").trim();
  if (!trimmed) return null;
  if (trimmed.length <= 8) return "••••••••";
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

function extensionSettingsPayload(settings: Settings): {
  api_key_configured: boolean;
  api_key_preview: string | null;
  model: string;
} {
  const apiKey = (settings.extension_api_key ?? "").trim();
  return {
    api_key_configured: Boolean(apiKey),
    api_key_preview: extensionApiKeyPreview(apiKey),
    model: normalizeExtensionModel(settings.extension_model),
  };
}

function mergeSettingsWithEnv(settings: Settings, env: Partial<Settings>): Settings {
  return {
    ingest_token: env.ingest_token?.trim() || settings.ingest_token,
    extension_api_key:
      env.extension_api_key !== undefined && env.extension_api_key !== ""
        ? env.extension_api_key
        : settings.extension_api_key ?? null,
    extension_model: env.extension_model || settings.extension_model,
  };
}

function settingsChanged(before: Settings, after: Settings): boolean {
  return (
    before.ingest_token !== after.ingest_token ||
    before.extension_api_key !== after.extension_api_key ||
    before.extension_model !== after.extension_model
  );
}

async function initializeSettings(): Promise<Settings> {
  const env = settingsFromEnv();
  let settings = await readSettingsFromDisk();

  if (settings) {
    const merged = mergeSettingsWithEnv(settings, env);
    const normalized = normalizeSettingsRecord(merged);
    if (!normalized) {
      throw new Error("Invalid Recipes settings on disk.");
    }
    if (settingsChanged(settings, normalized)) {
      return persistSettings(normalized);
    }
    if (!existsSync(SETTINGS_BACKUP_PATH)) {
      await writeJsonAtomic(SETTINGS_BACKUP_PATH, normalized);
    }
    cachedSettings = normalized;
    return normalized;
  }

  const ingestToken = env.ingest_token?.trim();
  if (ingestToken) {
    return persistSettings({
      ingest_token: ingestToken,
      extension_api_key: env.extension_api_key ?? null,
      extension_model: env.extension_model ?? DEFAULT_EXTENSION_MODEL,
    });
  }

  if (await hasExistingLibraryData()) {
    console.error(
      "Recipes library data exists but settings.json is missing. " +
        "Generated a new ingest token; update extension Settings on each device.",
    );
  } else {
    console.log("Creating initial Recipes ingest token.");
  }

  return persistSettings({
    ingest_token: randomBytes(32).toString("hex"),
    extension_api_key: env.extension_api_key ?? null,
    extension_model: env.extension_model ?? DEFAULT_EXTENSION_MODEL,
  });
}

async function loadSettings(): Promise<Settings> {
  if (cachedSettings) return cachedSettings;
  if (!settingsInitPromise) {
    settingsInitPromise = initializeSettings();
  }
  return settingsInitPromise;
}

async function reloadSettingsFromDisk(): Promise<Settings> {
  cachedSettings = null;
  settingsInitPromise = null;
  return loadSettings();
}

async function saveExtensionSettings(input: {
  api_key?: string;
  model?: string;
  clear_api_key?: boolean;
}): Promise<Settings> {
  const settings = await loadSettings();
  const next: Settings = { ...settings };

  if (input.clear_api_key) {
    next.extension_api_key = null;
  } else if (typeof input.api_key === "string") {
    const trimmed = input.api_key.trim();
    if (trimmed) next.extension_api_key = trimmed;
  }

  if (typeof input.model === "string") {
    next.extension_model = normalizeExtensionModel(input.model);
  }

  return persistSettings(next);
}

async function loadIndex(): Promise<RecipeIndexEntry[]> {
  const entries = await readJsonFile<RecipeIndexEntry[]>(INDEX_PATH, []);
  const deduped = dedupeIndexEntries(entries, new Map());
  if (deduped.removedIds.size > 0) {
    await reconcileLibraryData(DATA_ROOT);
    return readJsonFile<RecipeIndexEntry[]>(INDEX_PATH, []);
  }
  return deduped.kept;
}

async function saveIndex(entries: RecipeIndexEntry[]): Promise<void> {
  const sorted = [...entries].sort(
    (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
  );
  await writeJsonAtomic(INDEX_PATH, sorted);
}

function recipePath(id: string): string {
  return path.join(RECIPES_DIR, `${id}.json`);
}

async function loadRecipe(id: string): Promise<Recipe | null> {
  const file = recipePath(id);
  if (!existsSync(file)) return null;
  return readJsonFile<Recipe | null>(file, null);
}

function normalizeIngestPayload(body: Record<string, unknown>): Omit<Recipe, "id" | "created_at" | "updated_at"> {
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : "Untitled Recipe";
  const sourceUrl = typeof body.source_url === "string" ? body.source_url.trim() : "";
  if (!sourceUrl) throw new Error("source_url is required");

  const asNullableString = (value: unknown): string | null =>
    typeof value === "string" && value.trim() ? value.trim() : null;

  const asStringArray = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    return value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
  };

  return {
    title,
    description: asNullableString(body.description),
    servings: asNullableString(body.servings),
    prep_time: asNullableString(body.prep_time),
    cook_time: asNullableString(body.cook_time),
    total_time: asNullableString(body.total_time),
    ingredients: asStringArray(body.ingredients),
    instructions: asStringArray(body.instructions),
    notes: asNullableString(body.notes),
    source_url: sourceUrl,
  };
}

async function upsertRecipe(payload: Record<string, unknown>): Promise<Recipe> {
  const imageUrl =
    typeof payload.image_url === "string" && payload.image_url.trim()
      ? payload.image_url.trim()
      : "";
  const normalized = normalizeIngestPayload(payload);
  if (await isSourceUrlBlocked(normalized.source_url)) {
    throw new BlockedRecipeError(normalized.source_url);
  }
  const now = new Date().toISOString();
  const index = await loadIndex();
  const incomingUrl = canonicalSourceUrl(normalized.source_url);
  const existing = index.find((entry) => canonicalSourceUrl(entry.source_url) === incomingUrl);

  if (existing) {
    const current = await loadRecipe(existing.id);
    const updated: Recipe = {
      id: existing.id,
      created_at: current?.created_at ?? now,
      updated_at: now,
      ...normalized,
    };
    await writeJsonAtomic(recipePath(updated.id), updated);
    if (imageUrl) await saveRecipeImage(updated.id, imageUrl);
    await saveIndex(
      index.map((entry) =>
        entry.id === updated.id
          ? {
              id: updated.id,
              title: updated.title,
              source_url: updated.source_url,
              created_at: updated.created_at,
              updated_at: updated.updated_at,
            }
          : entry
      )
    );
    return updated;
  }

  const recipe: Recipe = {
    id: randomUUID(),
    created_at: now,
    updated_at: now,
    ...normalized,
  };
  await writeJsonAtomic(recipePath(recipe.id), recipe);
  if (imageUrl) await saveRecipeImage(recipe.id, imageUrl);
  await saveIndex([
    ...index,
    {
      id: recipe.id,
      title: recipe.title,
      source_url: recipe.source_url,
      created_at: recipe.created_at,
      updated_at: recipe.updated_at,
    },
  ]);
  return recipe;
}

async function updateRecipeNotes(id: string, notes: string | null): Promise<Recipe> {
  const recipe = await loadRecipe(id);
  if (!recipe) throw new NotFoundError("recipe not found");
  const now = new Date().toISOString();
  const updated: Recipe = {
    ...recipe,
    notes: typeof notes === "string" && notes.trim() ? notes.trim() : null,
    updated_at: now,
  };
  await writeJsonAtomic(recipePath(id), updated);
  const index = await loadIndex();
  await saveIndex(
    index.map((entry) =>
      entry.id === id
        ? {
            id: updated.id,
            title: updated.title,
            source_url: updated.source_url,
            created_at: updated.created_at,
            updated_at: updated.updated_at,
          }
        : entry
    )
  );
  return updated;
}

async function loadTrashIndex(): Promise<TrashIndexEntry[]> {
  const entries = await readJsonFile<TrashIndexEntry[]>(TRASH_INDEX_PATH, []);
  return [...entries].sort(
    (a, b) => new Date(b.deleted_at).getTime() - new Date(a.deleted_at).getTime()
  );
}

async function saveTrashIndex(entries: TrashIndexEntry[]): Promise<void> {
  await ensureTrashDirs();
  await writeJsonAtomic(TRASH_INDEX_PATH, entries);
}

async function loadTrashRecipe(id: string): Promise<Recipe | null> {
  const file = trashRecipePath(id);
  if (!existsSync(file)) return null;
  return readJsonFile<Recipe | null>(file, null);
}

async function enrichTrashRecipe(
  recipe: Recipe,
  entry: TrashIndexEntry
): Promise<Recipe & { has_image: boolean; category_ids: string[]; deleted_at: string; in_trash: true }> {
  return {
    ...recipe,
    has_image: recipeHasTrashImage(recipe.id),
    category_ids: entry.category_ids,
    deleted_at: entry.deleted_at,
    in_trash: true,
  };
}

async function moveRecipeToTrash(id: string): Promise<boolean> {
  const recipe = await loadRecipe(id);
  if (!recipe) return false;

  await ensureTrashDirs();
  const categoryItems = await loadCategoryItems();
  const category_ids = categoryIdsForRecipe(categoryItems, id);

  await rename(recipePath(id), trashRecipePath(id));

  const imagePath = findRecipeImagePath(id);
  if (imagePath) {
    const ext = path.extname(imagePath);
    await rename(imagePath, path.join(TRASH_IMAGES_DIR, `${id}${ext}`));
  }

  const index = await loadIndex();
  await saveIndex(index.filter((entry) => entry.id !== id));
  await removeRecipeCategoryItems(id);

  const trashEntry: TrashIndexEntry = {
    id: recipe.id,
    title: recipe.title,
    source_url: recipe.source_url,
    created_at: recipe.created_at,
    updated_at: recipe.updated_at,
    deleted_at: new Date().toISOString(),
    category_ids,
  };
  const trashIndex = await loadTrashIndex();
  await saveTrashIndex([trashEntry, ...trashIndex.filter((entry) => entry.id !== id)]);
  return true;
}

async function restoreRecipeFromTrash(id: string): Promise<Recipe> {
  const trashIndex = await loadTrashIndex();
  const entry = trashIndex.find((item) => item.id === id);
  if (!entry) throw new NotFoundError("recipe not found in trash");

  const recipe = await loadTrashRecipe(id);
  if (!recipe) throw new NotFoundError("recipe not found in trash");
  if (await loadRecipe(id)) throw new Error("recipe already exists in library");

  await rename(trashRecipePath(id), recipePath(id));

  const trashImagePath = findTrashImagePath(id);
  if (trashImagePath) {
    const ext = path.extname(trashImagePath);
    await rename(trashImagePath, imageFilePath(id, ext));
  }

  const index = await loadIndex();
  await saveIndex([
    ...index,
    {
      id: recipe.id,
      title: recipe.title,
      source_url: recipe.source_url,
      created_at: recipe.created_at,
      updated_at: recipe.updated_at,
    },
  ]);

  for (const categoryId of entry.category_ids) {
    try {
      await assignCategoryRecipe(id, categoryId);
    } catch {
      // category may have been deleted since the recipe was trashed
    }
  }

  await saveTrashIndex(trashIndex.filter((item) => item.id !== id));
  return recipe;
}

async function permanentlyDeleteTrashRecipe(id: string): Promise<boolean> {
  const trashIndex = await loadTrashIndex();
  if (!trashIndex.some((entry) => entry.id === id)) return false;
  await rm(trashRecipePath(id), { force: true });
  await deleteTrashImage(id);
  await saveTrashIndex(trashIndex.filter((entry) => entry.id !== id));
  return true;
}

async function emptyTrash(): Promise<number> {
  const trashIndex = await loadTrashIndex();
  for (const entry of trashIndex) {
    await rm(trashRecipePath(entry.id), { force: true });
    await deleteTrashImage(entry.id);
  }
  await saveTrashIndex([]);
  return trashIndex.length;
}

async function ensureBlocklistDirs(): Promise<void> {
  await mkdir(BLOCKLIST_RECIPES_DIR, { recursive: true });
  await mkdir(BLOCKLIST_IMAGES_DIR, { recursive: true });
}

function blocklistRecipePath(id: string): string {
  return path.join(BLOCKLIST_RECIPES_DIR, `${id}.json`);
}

function findBlocklistImagePath(id: string): string | null {
  for (const ext of IMAGE_EXTENSIONS) {
    const filePath = path.join(BLOCKLIST_IMAGES_DIR, `${id}${ext}`);
    if (existsSync(filePath)) return filePath;
  }
  return null;
}

function recipeHasBlocklistImage(id: string): boolean {
  return findBlocklistImagePath(id) !== null;
}

async function deleteBlocklistImage(id: string): Promise<void> {
  await Promise.all(
    IMAGE_EXTENSIONS.map(async (ext) => {
      await rm(path.join(BLOCKLIST_IMAGES_DIR, `${id}${ext}`), { force: true });
    }),
  );
}

async function loadBlocklistIndex(): Promise<BlocklistIndexEntry[]> {
  const entries = await readJsonFile<BlocklistIndexEntry[]>(BLOCKLIST_INDEX_PATH, []);
  return [...entries].sort(
    (a, b) => new Date(b.blocked_at).getTime() - new Date(a.blocked_at).getTime(),
  );
}

async function saveBlocklistIndex(entries: BlocklistIndexEntry[]): Promise<void> {
  await ensureBlocklistDirs();
  await writeJsonAtomic(BLOCKLIST_INDEX_PATH, entries);
}

async function loadBlocklistRecipe(id: string): Promise<Recipe | null> {
  const file = blocklistRecipePath(id);
  if (!existsSync(file)) return null;
  return readJsonFile<Recipe | null>(file, null);
}

async function enrichBlocklistRecipe(
  recipe: Recipe,
  entry: BlocklistIndexEntry,
): Promise<Recipe & { has_image: boolean; category_ids: string[]; blocked_at: string; in_blocklist: true }> {
  return {
    ...recipe,
    has_image: recipeHasBlocklistImage(recipe.id),
    category_ids: entry.category_ids,
    blocked_at: entry.blocked_at,
    in_blocklist: true,
  };
}

function normalizeSourceUrl(sourceUrl: string): string {
  return sourceUrl.trim();
}

async function findBlocklistEntryByUrl(sourceUrl: string): Promise<BlocklistIndexEntry | null> {
  const normalized = normalizeSourceUrl(sourceUrl);
  if (!normalized) return null;
  const blocklist = await loadBlocklistIndex();
  return blocklist.find((entry) => entry.source_url === normalized) ?? null;
}

async function isSourceUrlBlocked(sourceUrl: string): Promise<boolean> {
  return (await findBlocklistEntryByUrl(sourceUrl)) !== null;
}

function blockedRecipeResponse(entry: BlocklistIndexEntry | null, sourceUrl: string): Record<string, unknown> {
  const title = entry?.title?.trim();
  return {
    blocked: true,
    error: title
      ? `“${title}” is on your blocklist. Unblock it in the Recipes app to save or print it again.`
      : "This recipe is on your blocklist. Unblock it in the Recipes app to save or print it again.",
    title: title || null,
    source_url: normalizeSourceUrl(sourceUrl),
  };
}

async function moveRecipeToBlocklist(id: string): Promise<boolean> {
  const recipe = await loadRecipe(id);
  if (!recipe) return false;

  await ensureBlocklistDirs();
  const categoryItems = await loadCategoryItems();
  const category_ids = categoryIdsForRecipe(categoryItems, id);

  await rename(recipePath(id), blocklistRecipePath(id));

  const imagePath = findRecipeImagePath(id);
  if (imagePath) {
    const ext = path.extname(imagePath);
    await rename(imagePath, path.join(BLOCKLIST_IMAGES_DIR, `${id}${ext}`));
  }

  const index = await loadIndex();
  await saveIndex(index.filter((entry) => entry.id !== id));
  await removeRecipeCategoryItems(id);

  const blocklistEntry: BlocklistIndexEntry = {
    id: recipe.id,
    title: recipe.title,
    source_url: recipe.source_url,
    created_at: recipe.created_at,
    updated_at: recipe.updated_at,
    blocked_at: new Date().toISOString(),
    category_ids,
  };
  const blocklistIndex = await loadBlocklistIndex();
  await saveBlocklistIndex([
    blocklistEntry,
    ...blocklistIndex.filter((entry) => entry.id !== id && entry.source_url !== recipe.source_url),
  ]);
  return true;
}

async function restoreRecipeFromBlocklist(id: string): Promise<Recipe> {
  const blocklistIndex = await loadBlocklistIndex();
  const entry = blocklistIndex.find((item) => item.id === id);
  if (!entry) throw new NotFoundError("recipe not found in blocklist");

  const recipe = await loadBlocklistRecipe(id);
  if (!recipe) throw new NotFoundError("recipe not found in blocklist");
  if (await loadRecipe(id)) throw new Error("recipe already exists in library");

  const index = await loadIndex();
  if (index.some((item) => item.source_url === recipe.source_url)) {
    throw new Error("a recipe with this source URL already exists in the library");
  }

  await rename(blocklistRecipePath(id), recipePath(id));

  const blocklistImagePath = findBlocklistImagePath(id);
  if (blocklistImagePath) {
    const ext = path.extname(blocklistImagePath);
    await rename(blocklistImagePath, imageFilePath(id, ext));
  }

  await saveIndex([
    ...index,
    {
      id: recipe.id,
      title: recipe.title,
      source_url: recipe.source_url,
      created_at: recipe.created_at,
      updated_at: recipe.updated_at,
    },
  ]);

  for (const categoryId of entry.category_ids) {
    try {
      await assignCategoryRecipe(id, categoryId);
    } catch {
      // category may have been deleted since the recipe was blocked
    }
  }

  await saveBlocklistIndex(blocklistIndex.filter((item) => item.id !== id));
  return recipe;
}

async function permanentlyDeleteBlocklistRecipe(id: string): Promise<boolean> {
  const blocklistIndex = await loadBlocklistIndex();
  if (!blocklistIndex.some((entry) => entry.id === id)) return false;
  await rm(blocklistRecipePath(id), { force: true });
  await deleteBlocklistImage(id);
  await saveBlocklistIndex(blocklistIndex.filter((entry) => entry.id !== id));
  return true;
}

async function emptyBlocklist(): Promise<number> {
  const blocklistIndex = await loadBlocklistIndex();
  for (const entry of blocklistIndex) {
    await rm(blocklistRecipePath(entry.id), { force: true });
    await deleteBlocklistImage(entry.id);
  }
  await saveBlocklistIndex([]);
  return blocklistIndex.length;
}

type DefaultRecipeSeed = Omit<Recipe, "created_at" | "updated_at"> & {
  image_file: string;
};

const DEFAULT_RECIPES: DefaultRecipeSeed[] = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    image_file: "chocolate-chip-cookies.jpg",
    title: "Chocolate Chip Cookies",
    description: "Classic chewy bakery-style cookies with crisp edges and soft centers.",
    servings: "24 cookies",
    prep_time: "15 min",
    cook_time: "12 min",
    total_time: "27 min",
    ingredients: [
      "2 1/4 cups all-purpose flour",
      "1 tsp baking soda",
      "1 tsp fine salt",
      "1 cup unsalted butter, softened",
      "3/4 cup granulated sugar",
      "3/4 cup packed brown sugar",
      "2 large eggs",
      "2 tsp vanilla extract",
      "2 cups semisweet chocolate chips",
    ],
    instructions: [
      "Heat oven to 375°F (190°C). Line baking sheets with parchment.",
      "Whisk flour, baking soda, and salt in a bowl.",
      "Beat butter and both sugars until light and fluffy, about 3 minutes.",
      "Beat in eggs one at a time, then vanilla.",
      "Mix in dry ingredients until just combined. Fold in chocolate chips.",
      "Scoop rounded tablespoons of dough 2 inches apart onto sheets.",
      "Bake 9–12 minutes until edges are golden and centers look slightly underdone.",
      "Cool on the sheet 5 minutes, then transfer to a rack.",
    ],
    notes: "For thicker cookies, chill the dough 30 minutes before baking.",
    source_url: `${SAMPLE_SOURCE_PREFIX}chocolate-chip-cookies`,
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    image_file: "spaghetti-aglio-e-olio.jpg",
    title: "Spaghetti Aglio e Olio",
    description: "A fast pantry pasta with garlic, olive oil, chili flakes, and parsley.",
    servings: "4 servings",
    prep_time: "10 min",
    cook_time: "15 min",
    total_time: "25 min",
    ingredients: [
      "12 oz spaghetti",
      "1/2 cup extra-virgin olive oil",
      "6 garlic cloves, thinly sliced",
      "1/2 tsp red pepper flakes",
      "1/2 cup chopped fresh parsley",
      "1 tsp fine salt",
      "Freshly ground black pepper",
      "Parmesan cheese, for serving",
    ],
    instructions: [
      "Cook spaghetti in well-salted boiling water until al dente. Reserve 1 cup pasta water, then drain.",
      "Warm olive oil in a large skillet over medium-low heat.",
      "Add garlic and cook gently until fragrant and pale gold, not brown, about 2 minutes.",
      "Stir in red pepper flakes, then add pasta with a splash of pasta water.",
      "Toss vigorously until glossy, adding more pasta water as needed.",
      "Remove from heat, add parsley, salt, and pepper. Serve with Parmesan.",
    ],
    notes: null,
    source_url: `${SAMPLE_SOURCE_PREFIX}spaghetti-aglio-e-olio`,
  },
  {
    id: "00000000-0000-4000-8000-000000000003",
    image_file: "sheet-pan-roast-chicken.jpg",
    title: "Sheet Pan Roast Chicken and Vegetables",
    description: "One-pan dinner with juicy chicken thighs and roasted seasonal vegetables.",
    servings: "4 servings",
    prep_time: "15 min",
    cook_time: "40 min",
    total_time: "55 min",
    ingredients: [
      "8 bone-in, skin-on chicken thighs",
      "2 tbsp olive oil",
      "1 lb baby potatoes, halved",
      "2 carrots, cut into chunks",
      "1 red onion, cut into wedges",
      "4 garlic cloves, smashed",
      "1 tsp dried thyme",
      "1 tsp paprika",
      "1 tsp fine salt",
      "1/2 tsp black pepper",
      "1 lemon, cut into wedges",
    ],
    instructions: [
      "Heat oven to 425°F (220°C).",
      "Toss potatoes, carrots, onion, and garlic with 1 tbsp oil, thyme, paprika, salt, and pepper on a large sheet pan.",
      "Nestle chicken thighs among vegetables. Rub with remaining oil and season lightly.",
      "Roast 35–40 minutes until chicken reaches 165°F (74°C) and skin is crisp.",
      "Rest 5 minutes. Squeeze lemon over the pan before serving.",
    ],
    notes: "Swap in broccoli, Brussels sprouts, or sweet potato based on what you have.",
    source_url: `${SAMPLE_SOURCE_PREFIX}sheet-pan-roast-chicken`,
  },
  {
    id: "00000000-0000-4000-8000-000000000004",
    image_file: "buttermilk-pancakes.jpg",
    title: "Fluffy Buttermilk Pancakes",
    description: "Light, tender pancakes perfect for weekend breakfasts.",
    servings: "8 pancakes",
    prep_time: "10 min",
    cook_time: "15 min",
    total_time: "25 min",
    ingredients: [
      "1 1/2 cups all-purpose flour",
      "2 tbsp granulated sugar",
      "2 tsp baking powder",
      "1/2 tsp baking soda",
      "1/2 tsp fine salt",
      "1 1/4 cups buttermilk",
      "1 large egg",
      "3 tbsp melted butter, plus more for the pan",
      "1 tsp vanilla extract",
      "Maple syrup and butter, for serving",
    ],
    instructions: [
      "Whisk flour, sugar, baking powder, baking soda, and salt in a bowl.",
      "Whisk buttermilk, egg, melted butter, and vanilla in another bowl.",
      "Pour wet ingredients into dry and stir until just combined; a few lumps are fine.",
      "Heat a lightly buttered skillet or griddle over medium heat.",
      "Pour 1/4 cup batter per pancake. Cook until bubbles form and edges look set, about 2 minutes.",
      "Flip and cook until golden on the second side, about 1 minute.",
      "Serve warm with butter and maple syrup.",
    ],
    notes: "Keep cooked pancakes warm in a 200°F oven while you finish the batch.",
    source_url: `${SAMPLE_SOURCE_PREFIX}buttermilk-pancakes`,
  },
];

async function copySeedImage(recipeId: string, filename: string): Promise<boolean> {
  const source = path.join(SEED_IMAGES_DIR, filename);
  if (!existsSync(source)) {
    console.warn(`Seed image not found: ${filename}`);
    return false;
  }
  const ext = path.extname(filename).toLowerCase();
  if (!IMAGE_EXTENSIONS.includes(ext as (typeof IMAGE_EXTENSIONS)[number])) return false;
  await mkdir(IMAGES_DIR, { recursive: true });
  await deleteRecipeImage(recipeId);
  await writeFile(imageFilePath(recipeId, ext), await readFile(source));
  return true;
}

async function seedDefaultRecipes(): Promise<void> {
  const index = await loadIndex();
  if (index.length > 0) return;

  const now = new Date().toISOString();
  const entries: RecipeIndexEntry[] = [];

  for (const seed of DEFAULT_RECIPES) {
    const { image_file: imageFile, ...recipeFields } = seed;
    const recipe: Recipe = {
      ...recipeFields,
      created_at: now,
      updated_at: now,
    };
    await writeJsonAtomic(recipePath(recipe.id), recipe);
    await copySeedImage(recipe.id, imageFile);
    entries.push({
      id: recipe.id,
      title: recipe.title,
      source_url: recipe.source_url,
      created_at: now,
      updated_at: now,
    });
  }

  await saveIndex(entries);
  console.log(`Seeded ${entries.length} sample recipes`);
}

async function seedDefaultRecipeImages(): Promise<void> {
  let copied = 0;
  for (const seed of DEFAULT_RECIPES) {
    if (recipeHasImage(seed.id)) continue;
    const recipe = await loadRecipe(seed.id);
    if (!recipe) continue;
    if (await copySeedImage(seed.id, seed.image_file)) copied += 1;
  }
  if (copied > 0) console.log(`Added images to ${copied} sample recipes`);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendText(res: ServerResponse, status: number, body: string, contentType = "text/plain; charset=utf-8"): void {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function getBearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7).trim() || null;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderPrintPage(recipe: Recipe, autoPrint: boolean): string {
  const metaItems = [
    recipe.servings ? `Servings: ${escapeHtml(recipe.servings)}` : "",
    recipe.prep_time ? `Prep: ${escapeHtml(recipe.prep_time)}` : "",
    recipe.cook_time ? `Cook: ${escapeHtml(recipe.cook_time)}` : "",
    recipe.total_time ? `Total: ${escapeHtml(recipe.total_time)}` : "",
  ]
    .filter(Boolean)
    .map((item) => `<li>${item}</li>`)
    .join("");

  const ingredients = (recipe.ingredients || [])
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");
  const instructions = (recipe.instructions || [])
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");

  const description = recipe.description
    ? `<p class="description">${escapeHtml(recipe.description)}</p>`
    : "";
  const notes = recipe.notes
    ? `<section class="notes"><h2>Notes</h2><p>${escapeHtml(recipe.notes)}</p></section>`
    : "";
  const source = recipe.source_url
    ? `<p>Source: ${escapeHtml(recipe.source_url)}</p>`
    : "";
  const printedOn = `Printed: ${new Date().toLocaleDateString("en-US")}`;
  const autoPrintScript = autoPrint
    ? `<script>window.addEventListener("load", () => setTimeout(() => window.print(), 250));</script>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(recipe.title)}</title>
  <style>
    @page { size: letter; margin: 0.75in; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Georgia, "Times New Roman", serif;
      color: #111827;
      background: #f3f4f6;
    }
    .toolbar {
      display: flex;
      gap: 8px;
      padding: 12px;
      background: #fff;
      border-bottom: 1px solid #e5e7eb;
      font-family: system-ui, sans-serif;
    }
    .toolbar button {
      border: 1px solid #d1d5db;
      border-radius: 8px;
      background: #fff;
      padding: 8px 12px;
      cursor: pointer;
      font-size: 13px;
    }
    .recipe-card {
      max-width: 8.5in;
      margin: 0 auto;
      padding: 0.5in 0.75in 0.75in;
      background: #fff;
    }
    .recipe-header {
      text-align: center;
      margin-bottom: 24px;
      border-bottom: 2px solid #e67e22;
      padding-bottom: 16px;
    }
    .recipe-header h1 {
      margin: 0 0 8px;
      font-size: 30px;
      line-height: 1.2;
    }
    .description {
      margin: 0 0 10px;
      font-size: 14px;
      color: #4b5563;
    }
    .meta {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 8px 16px;
      font-size: 13px;
      color: #374151;
    }
    .recipe-body {
      display: grid;
      grid-template-columns: 1fr 1.2fr;
      gap: 28px;
    }
    .column h2 {
      margin: 0 0 10px;
      font-size: 18px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: #e67e22;
    }
    .column ul, .column ol {
      margin: 0;
      font-size: 13px;
      line-height: 1.55;
    }
    .column ul { padding-left: 18px; }
    .column ol { padding-left: 20px; line-height: 1.65; }
    .column ol li + li { margin-top: 8px; }
    .notes {
      margin-top: 24px;
      padding-top: 12px;
      border-top: 1px solid #e5e7eb;
    }
    .notes h2 {
      margin: 0 0 8px;
      font-size: 16px;
      color: #e67e22;
    }
    .notes p {
      margin: 0;
      font-size: 13px;
      line-height: 1.5;
    }
    .recipe-footer {
      margin-top: 28px;
      padding-top: 10px;
      border-top: 1px solid #e5e7eb;
      font-size: 11px;
      color: #6b7280;
    }
    .recipe-footer p { margin: 0; }
    @media print {
      body { background: #fff; }
      .no-print { display: none !important; }
      .recipe-card { margin: 0; padding: 0; max-width: none; }
    }
    @media (max-width: 720px) {
      .recipe-body { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="toolbar no-print">
    <button type="button" onclick="window.print()">Print</button>
    <button type="button" onclick="window.close()">Close</button>
  </div>
  <article class="recipe-card">
    <header class="recipe-header">
      <h1>${escapeHtml(recipe.title)}</h1>
      ${description}
      ${metaItems ? `<ul class="meta">${metaItems}</ul>` : ""}
    </header>
    <section class="recipe-body">
      <div class="column">
        <h2>Ingredients</h2>
        <ul>${ingredients}</ul>
      </div>
      <div class="column">
        <h2>Instructions</h2>
        <ol>${instructions}</ol>
      </div>
    </section>
    ${notes}
    <footer class="recipe-footer">
      ${source}
      <p>${printedOn}</p>
    </footer>
  </article>
  ${autoPrintScript}
</body>
</html>`;
}

const RECIPES_PAGE_STYLES = `
:root {
  color-scheme: light;
  --bg: #faf7f2;
  --panel: #ffffff;
  --border: #e8dfd4;
  --text: #111827;
  --muted: #6b7280;
  --accent: #e67e22;
  --accent-soft: #fdebd0;
  --sidebar: #f5f0e8;
  --shadow-color: 17, 24, 39;
  --overlay: rgba(17, 24, 39, 0.45);
  --danger: #b91c1c;
  --danger-text: #991b1b;
  --danger-bg: #fef2f2;
  --danger-border: #fecaca;
  --blocklist: #92400e;
  --blocklist-bg: #fffbeb;
  --blocklist-border: #fde68a;
}
html[data-theme="dark"] {
  color-scheme: dark;
  --bg: #1a1410;
  --panel: #2a2118;
  --border: #3d3228;
  --text: #f5f0e8;
  --muted: #a89888;
  --accent: #f39c12;
  --accent-soft: #3d2814;
  --sidebar: #14100c;
  --shadow-color: 0, 0, 0;
  --overlay: rgba(0, 0, 0, 0.62);
  --danger: #f87171;
  --danger-text: #fecaca;
  --danger-bg: #450a0a;
  --danger-border: #7f1d1d;
  --blocklist: #fbbf24;
  --blocklist-bg: #422006;
  --blocklist-border: #78350f;
}
* { box-sizing: border-box; }
html, body {
  margin: 0;
  height: 100%;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: var(--bg);
  color: var(--text);
}
body {
  display: grid;
  grid-template-columns: 240px 1fr;
  min-height: 100vh;
}
aside {
  background: var(--sidebar);
  border-right: 1px solid var(--border);
  padding: 1.25rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  min-height: 0;
  overflow: hidden;
}
.brand {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  font-weight: 700;
  font-size: 1.1rem;
  padding: 0.25rem 0.5rem;
}
.brand-badge {
  width: 2rem;
  height: 2rem;
  border-radius: 0.65rem;
  display: grid;
  place-items: center;
  background: linear-gradient(135deg, #e67e22, #d35400);
  color: white;
  font-size: 0.95rem;
}
.nav { display: grid; gap: 0.35rem; }
.nav button {
  text-align: left;
  border: 0;
  background: transparent;
  padding: 0.7rem 0.75rem;
  border-radius: 0.65rem;
  font: inherit;
  color: var(--text);
  cursor: pointer;
}
.nav button.active,
.nav button:hover {
  background: var(--accent-soft);
  color: var(--accent);
}
.sidebar-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.sidebar-section {
  padding-top: 0.75rem;
  border-top: 1px solid var(--border);
}
.sidebar-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding-right: 0.75rem;
}
.sidebar-section-label {
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
  padding: 0 0.75rem 0.5rem;
}
.categories-add {
  border: 0;
  background: transparent;
  color: var(--accent);
  font: inherit;
  font-size: 1.1rem;
  line-height: 1;
  cursor: pointer;
  padding: 0.15rem 0.35rem;
  border-radius: 0.4rem;
}
.categories-add:hover { background: var(--accent-soft); }
.categories-list { display: grid; gap: 0.2rem; }
.categories-empty {
  padding: 0.35rem 0.75rem;
  color: var(--muted);
  font-size: 0.85rem;
}
.category-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  border: 0;
  background: transparent;
  padding: 0.55rem 0.75rem;
  border-radius: 0.65rem;
  font: inherit;
  color: var(--text);
  cursor: pointer;
  text-align: left;
  width: 100%;
  min-width: 0;
}
.category-item:hover,
.category-item.active,
.category-item.context-selected,
.category-item.drop-target {
  background: var(--accent-soft);
  color: var(--accent);
}
.category-icon { flex-shrink: 0; font-size: 0.95rem; line-height: 1; }
.category-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sidebar-footer-wrap {
  margin-top: auto;
  padding-top: 0.75rem;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}
.sidebar-footer {
  margin-top: auto;
  padding-top: 0.75rem;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}
.sidebar-footer-wrap .sidebar-footer {
  margin-top: 0;
  padding-top: 0;
  border-top: 0;
}
.sidebar-trash {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  border: 0;
  background: transparent;
  padding: 0.7rem 0.75rem;
  border-radius: 0.65rem;
  font: inherit;
  color: var(--text);
  cursor: pointer;
  text-align: left;
}
.sidebar-trash:hover,
.sidebar-trash.active {
  background: var(--danger-bg);
  color: var(--danger);
}
.topbar.toolbar-trash {
  display: none;
}
body.view-trash .topbar.toolbar-trash {
  display: flex;
}
.sidebar-trash.drop-target {
  color: var(--danger);
  background: var(--danger-bg);
  box-shadow: 0 0 0 2px var(--danger-border);
}
.sidebar-trash-icon {
  flex-shrink: 0;
  font-size: 0.95rem;
  line-height: 1;
}
.sidebar-blocklist {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  border: 0;
  background: transparent;
  padding: 0.7rem 0.75rem;
  border-radius: 0.65rem;
  font: inherit;
  color: var(--text);
  cursor: pointer;
  text-align: left;
  margin-bottom: 0.35rem;
}
.sidebar-blocklist:hover,
.sidebar-blocklist.active {
  background: var(--blocklist-bg);
  color: var(--blocklist);
}
.sidebar-blocklist.drop-target {
  color: var(--blocklist);
  background: var(--blocklist-bg);
  box-shadow: 0 0 0 2px var(--blocklist-border);
}
.sidebar-blocklist-icon {
  flex-shrink: 0;
  font-size: 0.95rem;
  line-height: 1;
}
.topbar.toolbar-blocklist {
  display: none;
}
body.view-blocklist .topbar.toolbar-blocklist {
  display: flex;
}
main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 100vh;
}
.sidebar-backdrop { display: none; }
.sidebar-toggle {
  display: none;
  flex-shrink: 0;
  border: 0;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  width: 2.25rem;
  height: 2.25rem;
  border-radius: 999px;
  font: inherit;
  font-size: 1.1rem;
  line-height: 1;
  place-items: center;
}
.sidebar-toggle:hover,
.theme-toggle:hover {
  background: var(--accent-soft);
  color: var(--accent);
}
.search-bar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1.25rem;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  z-index: 20;
}
.search {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex: 1;
  min-width: 0;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0.35rem 0.35rem 0.35rem 1rem;
  color: var(--muted);
}
.search-icon { flex-shrink: 0; line-height: 1; }
.search input {
  border: 0;
  background: transparent;
  flex: 1;
  min-width: 0;
  font: inherit;
  color: var(--text);
  padding: 0.3rem 0;
}
.search input:focus { outline: none; }
.utility-title {
  display: none;
  flex: 1;
  min-width: 0;
  margin: 0;
  font: inherit;
  font-size: 1.05rem;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
body.view-utility #search-bar { display: none; }
.theme-toggle {
  flex-shrink: 0;
  border: 0;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  width: 2.25rem;
  height: 2.25rem;
  border-radius: 999px;
  font: inherit;
  font-size: 1rem;
  line-height: 1;
  display: grid;
  place-items: center;
}
.topbar {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  flex-wrap: wrap;
  padding: 0.85rem 1.25rem;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
}
.toolbar { display: flex; gap: 0.5rem; flex-wrap: wrap; }
button.primary {
  border: 0;
  border-radius: 999px;
  background: var(--accent);
  color: white;
  padding: 0.65rem 1rem;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
button.secondary {
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--panel);
  color: var(--text);
  padding: 0.65rem 1rem;
  font: inherit;
  cursor: pointer;
}
button.danger-btn {
  border: 1px solid var(--danger-border);
  border-radius: 999px;
  background: var(--danger-bg);
  color: var(--danger);
  padding: 0.65rem 1rem;
  font: inherit;
  cursor: pointer;
}
.content {
  padding: 1.25rem;
  flex: 1;
  min-height: 0;
  overflow: auto;
}
body.view-utility .listing-header,
body.view-utility .listing-table,
body.view-utility #empty,
body.view-utility #blocklist-empty,
body.view-utility #trash-empty,
body.view-utility #no-results {
  display: none !important;
}
.listing-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 1rem;
}
.status { color: var(--muted); font-size: 0.95rem; }
.view-toggle {
  display: flex;
  gap: 0.2rem;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 0.65rem;
  padding: 0.2rem;
  flex-shrink: 0;
}
.view-toggle-btn {
  border: 0;
  background: transparent;
  color: var(--muted);
  width: 2rem;
  height: 2rem;
  border-radius: 0.45rem;
  font: inherit;
  font-size: 0.95rem;
  line-height: 1;
  cursor: pointer;
  display: grid;
  place-items: center;
}
.view-toggle-btn:hover { color: var(--text); background: var(--panel); }
.view-toggle-btn.active {
  background: var(--accent-soft);
  color: var(--accent);
}
.list-header {
  display: none;
  gap: 0.75rem;
  align-items: center;
  padding: 0.35rem 0.85rem;
  margin-bottom: 0.15rem;
  border-bottom: 1px solid var(--border);
}
.list-header.visible {
  display: grid;
}
.listing-table.list-active {
  --list-cols: 2.75rem minmax(12rem, 1fr) 5.5rem 5.5rem 4.5rem;
  display: grid;
  grid-template-columns: var(--list-cols);
  column-gap: 0.75rem;
  row-gap: 0.35rem;
  align-items: center;
}
.listing-table.list-active .list-header.visible {
  grid-column: 1 / -1;
  grid-template-columns: subgrid;
}
.listing-table.list-active #list.list-view {
  display: contents;
}
.listing-table.list-active #list.list-view .card {
  grid-column: 1 / -1;
  grid-template-columns: subgrid;
}
.list-header-spacer { min-width: 0; }
.list-header-cell {
  font-size: 0.72rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
  text-align: left;
  min-width: 0;
}
.list-header-cell.sortable {
  border: 0;
  background: transparent;
  font: inherit;
  cursor: pointer;
  padding: 0;
}
.list-header-cell.sortable:hover,
.list-header-cell.sortable.active { color: var(--accent); }
.list-header-cell.cell-actions,
.grid.list-view .cell-actions { text-align: right; }
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 0.85rem;
  align-items: stretch;
}
.grid:not(.list-view) .card.open {
  grid-column: 1 / -1;
  height: auto;
}
.grid:not(.list-view) .card {
  height: 100%;
}
.grid:not(.list-view) .card:not(.open) .card-actions {
  margin-top: auto;
}
.card {
  position: relative;
  min-width: 0;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 0.9rem;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
  cursor: pointer;
  transition: box-shadow 0.15s ease, transform 0.15s ease;
}
.card:hover:not(.open):not(.selected) {
  border-color: var(--accent);
  background: var(--accent-soft);
  box-shadow: 0 14px 32px rgba(var(--shadow-color), 0.16), 0 0 0 2px var(--accent-soft);
  transform: translateY(-2px);
}
.card.open {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}
.card.dragging {
  opacity: 0.45;
}
.card.selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}
.context-menu {
  position: fixed;
  z-index: 1200;
  min-width: 11rem;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  box-shadow: 0 16px 40px rgba(var(--shadow-color), 0.14);
  padding: 0.35rem;
  display: none;
}
.context-menu.open {
  display: grid;
}
.context-menu button {
  border: 0;
  background: transparent;
  text-align: left;
  padding: 0.65rem 0.75rem;
  border-radius: 0.5rem;
  font: inherit;
  color: var(--text);
  cursor: pointer;
}
.context-menu button:hover,
.context-menu button:focus {
  background: var(--accent-soft);
  color: var(--accent);
  outline: none;
}
.context-menu button.danger {
  color: var(--danger);
}
.context-menu button.danger:hover,
.context-menu button.danger:focus {
  background: var(--danger-bg);
  color: var(--danger-text);
}
.context-menu .menu-label {
  padding: 0.45rem 0.75rem 0.2rem;
  font-size: 0.75rem;
  color: var(--muted);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  max-width: 16rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.menu-submenu {
  position: relative;
}
.menu-submenu-trigger {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}
.menu-submenu-chevron {
  color: var(--muted);
  font-size: 0.9rem;
  line-height: 1;
}
.menu-submenu-panel {
  display: none;
  position: absolute;
  left: calc(100% + 0.2rem);
  top: 0;
  z-index: 1;
  min-width: 11rem;
  max-width: 16rem;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  box-shadow: 0 16px 40px rgba(var(--shadow-color), 0.14);
  padding: 0.35rem;
}
.menu-submenu.open .menu-submenu-panel,
.menu-submenu:hover .menu-submenu-panel,
.menu-submenu:focus-within .menu-submenu-panel {
  display: grid;
}
.menu-submenu-panel.flip-left {
  left: auto;
  right: calc(100% + 0.2rem);
}
.menu-submenu-empty {
  padding: 0.65rem 0.75rem;
  color: var(--muted);
  font-size: 0.85rem;
}
.card-categories,
.card .times {
  color: var(--muted);
  font-size: 0.75rem;
  line-height: 1.35;
  min-height: 1.35em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dialog-backdrop {
  position: fixed;
  inset: 0;
  background: var(--overlay);
  display: none;
  place-items: center;
  padding: 1rem;
  z-index: 1100;
}
.dialog-backdrop.open { display: grid; }
.dialog {
  width: min(100%, 24rem);
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 1rem;
  padding: 1.25rem;
  box-shadow: 0 24px 48px rgba(var(--shadow-color), 0.18);
}
.dialog h2 { margin: 0 0 0.35rem; font-size: 1.1rem; }
.dialog input {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 0.65rem;
  padding: 0.75rem 0.85rem;
  font: inherit;
  background: var(--panel);
  color: var(--text);
  margin: 0.75rem 0 1rem;
}
.dialog input:focus {
  outline: 2px solid var(--accent-soft);
  border-color: var(--accent);
}
.dialog-actions {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
  flex-wrap: wrap;
}
.recipe-image,
.recipe-image-placeholder {
  width: 100%;
  aspect-ratio: 16 / 10;
  border-radius: 0.65rem;
  display: block;
  margin: -0.15rem 0 0.15rem;
  flex-shrink: 0;
}
.recipe-image {
  object-fit: cover;
}
.recipe-image-placeholder {
  display: grid;
  place-items: center;
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--muted);
  font-size: 1.5rem;
}
.grid:not(.list-view) .card.open .recipe-image {
  max-height: 220px;
  aspect-ratio: auto;
}
.card .name {
  margin: 0;
  font-weight: 600;
  font-size: 1rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card .meta,
.card .times {
  color: var(--muted);
  font-size: 0.85rem;
  line-height: 1.4;
}
.card-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.list-only { display: none; }
.grid.list-view .card {
  display: grid;
  align-items: center;
  min-height: auto;
  padding: 0.6rem 0.85rem;
  gap: 0.75rem;
  border-radius: 0.65rem;
  flex-direction: unset;
}
.grid.list-view .card:hover:not(.open):not(.selected) { transform: none; }
.grid.list-view .grid-only { display: none !important; }
.grid.list-view .list-only { display: block; }
.grid.list-view .cell-thumb {
  width: 2.25rem;
  height: 2.25rem;
  border-radius: 0.45rem;
  overflow: hidden;
  background: var(--bg);
  border: 1px solid var(--border);
  display: grid;
  place-items: center;
  color: var(--muted);
  font-size: 0.85rem;
}
.grid.list-view .cell-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.grid.list-view .card .name {
  min-width: 0;
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.grid.list-view .cell-servings,
.grid.list-view .cell-total {
  color: var(--muted);
  font-size: 0.85rem;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.grid.list-view .cell-actions {
  display: flex;
  justify-content: flex-end;
}
.grid.list-view .cell-actions .print-btn {
  padding: 0.4rem 0.7rem;
  font-size: 0.8rem;
}
.grid.list-view .card .detail {
  grid-column: 1 / -1;
}
.grid.list-view .card-actions.grid-only { display: none; }
.detail {
  display: none;
  margin-top: 0.35rem;
  padding-top: 0.85rem;
  border-top: 1px solid var(--border);
  font-size: 0.92rem;
  line-height: 1.55;
}
.card.open .detail { display: block; }
.columns {
  display: grid;
  grid-template-columns: 1fr 1.2fr;
  gap: 1rem;
  margin-top: 0.75rem;
}
.detail .recipe-meta {
  margin: 0 0 0.75rem;
  color: var(--muted);
  font-size: 0.9rem;
  line-height: 1.5;
}
.detail h3 {
  margin: 0 0 0.5rem;
  font-size: 0.78rem;
  color: var(--accent);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.detail ul, .detail ol { margin: 0; padding-left: 1.2rem; }
.recipe-notes {
  margin-top: 1rem;
}
.recipe-notes h3 {
  margin: 0 0 0.5rem;
}
.recipe-notes-input {
  width: 100%;
  min-height: 5rem;
  resize: vertical;
  border: 1px solid var(--border);
  border-radius: 0.65rem;
  padding: 0.75rem 0.85rem;
  font: inherit;
  background: var(--panel);
  color: var(--text);
  line-height: 1.5;
}
.recipe-notes-input:focus {
  outline: 2px solid var(--accent-soft);
  border-color: var(--accent);
}
.recipe-notes-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.5rem;
}
.recipe-notes-status {
  font-size: 0.8rem;
  color: var(--muted);
}
.recipe-notes-status.saved {
  color: var(--accent);
}
.recipe-notes-readonly {
  margin: 0;
  white-space: pre-wrap;
}
.panel {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 1rem;
  padding: 1.25rem;
  margin-bottom: 1rem;
  box-shadow: 0 10px 24px rgba(var(--shadow-color), 0.06);
}
.panel h2 { margin: 0 0 0.5rem; font-size: 1.2rem; }
.panel p { margin: 0; color: var(--muted); line-height: 1.5; }
.panel-lead { margin-bottom: 0.25rem; }
.setup-grid {
  display: grid;
  gap: 0.25rem 1.25rem;
  margin-top: 1rem;
}
@media (min-width: 720px) {
  .setup-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .setup-field-wide { grid-column: 1 / -1; }
}
.token {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 0.65rem;
}
code {
  background: var(--bg);
  border: 1px solid var(--border);
  padding: 0.55rem 0.75rem;
  border-radius: 0.65rem;
  word-break: break-all;
  font-size: 0.8rem;
}
.empty {
  padding: 2rem;
  border: 1px dashed var(--border);
  border-radius: 1rem;
  background: var(--panel);
  color: var(--muted);
  text-align: center;
}
.setup-steps {
  margin: 1rem 0 0;
  padding-left: 1.25rem;
  line-height: 1.6;
  font-size: 0.92rem;
}
.setup-steps li + li { margin-top: 0.65rem; }
.setup-field { margin-top: 1rem; }
.collapsible-chevron {
  flex-shrink: 0;
  color: var(--muted);
  font-size: 0.85rem;
  line-height: 1;
  transition: transform 0.15s ease;
}
.collapsible-header {
  display: none;
}
.panel-title-desktop {
  margin: 0 0 0.5rem;
}
.setup-field label {
  display: block;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--muted);
  margin-bottom: 0.4rem;
}
.setup-input {
  width: 100%;
  max-width: 32rem;
  padding: 0.65rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.65rem;
  background: var(--bg);
  font: inherit;
  font-size: 0.92rem;
}
.setup-field-status {
  margin-top: 0.35rem;
  font-size: 0.85rem;
  color: var(--muted);
}
.setup-field-status.ok { color: #047857; }
.setup-field-status.error { color: #b91c1c; }
.setup-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-top: 1rem;
}
.import-actions {
  flex-direction: column;
  align-items: flex-start;
}
.import-actions button {
  width: 100%;
  max-width: 18rem;
}
@media (max-width: 800px) {
  .import-actions {
    align-items: center;
    width: 100%;
  }
}
a { color: var(--accent); }
.hidden { display: none; }
.app-version {
  position: fixed;
  right: 0.85rem;
  bottom: 0.45rem;
  font-size: 0.68rem;
  color: var(--muted);
  opacity: 0.45;
  pointer-events: none;
  user-select: none;
}
@media (max-width: 800px) {
  body { grid-template-columns: 1fr; }
  body.sidebar-open { overflow: hidden; }
  .sidebar-toggle { display: grid; }
  body.view-utility #search-bar { display: flex; }
  body.view-utility #search-bar .search { display: none; }
  body.view-utility .utility-title { display: block; }
  .collapsible-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    width: 100%;
    border: 0;
    background: transparent;
    padding: 0.7rem 0.75rem;
    border-radius: 0.65rem;
    font: inherit;
    font-weight: 600;
    color: var(--text);
    cursor: pointer;
    text-align: left;
  }
  .collapsible-header:hover {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .panel-collapsible .collapsible-header {
    background: var(--bg);
    border: 1px solid var(--border);
    margin-top: 0.65rem;
  }
  .panel-collapsible:first-of-type .collapsible-header {
    margin-top: 0;
  }
  .collapsible-section:not(.is-open) .collapsible-body {
    display: none;
  }
  .collapsible-section.is-open .collapsible-chevron {
    transform: rotate(180deg);
  }

  .panel-title-desktop {
    display: none;
  }
  body.view-device #backup-panel .panel-title-desktop {
    display: block;
  }
  .sidebar-backdrop {
    position: fixed;
    inset: 0;
    background: var(--overlay);
    z-index: 1050;
  }
  body.sidebar-open .sidebar-backdrop { display: block; }
  aside {
    position: fixed;
    left: 0;
    top: 0;
    bottom: 0;
    width: min(280px, 85vw);
    z-index: 1060;
    transform: translateX(-100%);
    transition: transform 0.2s ease;
  }
  body.sidebar-open aside { transform: translateX(0); }
}
@media (max-width: 720px) {
  .columns { grid-template-columns: 1fr; }
}
@supports not (grid-template-columns: subgrid) {
  .listing-table.list-active .list-header.visible,
  .listing-table.list-active #list.list-view .card {
    grid-template-columns: var(--list-cols);
  }
}
`;

const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="theme-color" content="#e67e22" />
  <link rel="icon" href="/icon.svg" type="image/svg+xml" />
  <title>Recipes</title>
  <style>${RECIPES_PAGE_STYLES}</style>
  <script>
    (function () {
      try {
        var saved = localStorage.getItem("recipes-theme");
        var theme = saved === "light" || saved === "dark"
          ? saved
          : (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
        document.documentElement.dataset.theme = theme;
      } catch (e) {}
    })();
  </script>
</head>
<body>
  <div id="sidebar-backdrop" class="sidebar-backdrop" aria-hidden="true"></div>
  <aside id="app-sidebar">
    <div class="brand">
      <div class="brand-badge">R</div>
      <span>Recipes</span>
    </div>
    <nav class="nav">
      <button id="nav-library" class="active" type="button">Library</button>
      <button id="nav-import" type="button">Save URL</button>
      <button id="nav-refresh" type="button">Refresh</button>
      <button id="nav-device" type="button">Setup</button>
    </nav>
    <div class="sidebar-scroll">
      <div class="sidebar-section categories-section">
        <div class="sidebar-section-header">
          <div class="sidebar-section-label">Categories</div>
          <button id="add-category" class="categories-add" type="button" title="New category" aria-label="New category">+</button>
        </div>
        <div id="categories-list" class="categories-list"></div>
      </div>
    </div>
    <div class="sidebar-footer">
      <button id="nav-blocklist" class="sidebar-blocklist" type="button" title="View blocklist — drag bad recipes here">
        <span class="sidebar-blocklist-icon" aria-hidden="true">⛔</span>
        <span>Blocklist</span>
      </button>
      <button id="nav-trash" class="sidebar-trash" type="button" title="View trash — drag recipes here to delete">
        <span class="sidebar-trash-icon" aria-hidden="true">🗑</span>
        <span>Trash</span>
      </button>
    </div>
  </aside>
  <main>
    <div id="search-bar" class="search-bar">
      <button id="sidebar-toggle" class="sidebar-toggle" type="button" aria-label="Open menu">☰</button>
      <label class="search">
        <span class="search-icon" aria-hidden="true">⌕</span>
        <input
          id="search-input"
          type="search"
          placeholder="Search by name, ingredients, servings, prep time, cook time, or total time…"
          autocomplete="off"
          spellcheck="false"
        />
      </label>
      <h1 id="utility-title" class="utility-title"></h1>
      <button id="theme-toggle" class="theme-toggle" type="button" aria-label="Switch to dark mode" title="Dark mode">☾</button>
    </div>
    <div class="content">
      <div class="topbar toolbar-blocklist">
        <div class="toolbar">
          <button id="empty-blocklist" class="danger-btn" type="button">Clear blocklist</button>
        </div>
      </div>
      <div class="topbar toolbar-trash">
        <div class="toolbar">
          <button id="empty-trash" class="danger-btn" type="button">Empty trash</button>
        </div>
      </div>
      <section id="import-panel" class="panel hidden">
    <h2 class="panel-title-desktop">Save from URL</h2>
    <p class="panel-lead">Paste a recipe page link. Grok formats it the same way as the Chrome extension.</p>
    <div class="setup-field">
      <label for="import-url">Recipe page URL</label>
      <input
        id="import-url"
        class="setup-input"
        type="url"
        inputmode="url"
        autocomplete="off"
        spellcheck="false"
        placeholder="https://example.com/recipe"
      />
    </div>
    <p id="import-status" class="setup-field-status">Save an xAI API key under Setup before importing.</p>
    <div class="setup-actions import-actions">
      <button id="import-save-later" class="secondary" type="button">Save for later</button>
      <button id="import-save-print" class="primary" type="button">Save &amp; print</button>
      <button id="close-import-btn" class="secondary" type="button">Close</button>
    </div>
      </section>
      <section id="device-panel" class="panel hidden">
    <h2 class="panel-title-desktop">Setup</h2>
    <p class="panel-lead">Connect the Recipes Chrome extension on a new computer or browser profile.</p>
    <ol class="setup-steps">
      <li>
        Install the extension from
        <a href="https://github.com/wolverineks/recipe-printer-extension" target="_blank" rel="noreferrer">GitHub</a>
        (Chrome → Extensions → Developer mode → Load unpacked).
      </li>
      <li>
        Get an <a href="https://console.x.ai/team/default/api-keys" target="_blank" rel="noreferrer">xAI API key</a>
        and save it below so every extension device can use it.
      </li>
      <li>Copy the Umbrel URL and ingest token into extension Settings on each device.</li>
      <li>Click Save in the extension, allow Chrome network access, then Test Umbrel connection.</li>
      <li>Open any recipe page and click <strong>Format, Save &amp; Print</strong>.</li>
    </ol>
    <div class="setup-grid">
      <div class="setup-field">
        <label>Umbrel Recipes URL (include port :4020)</label>
        <div class="token">
          <code id="base-url">Loading…</code>
          <button id="copy-url-btn" class="secondary" type="button">Copy URL</button>
        </div>
      </div>
      <div class="setup-field">
        <label for="extension-api-key">xAI API key (shared by all devices)</label>
        <input
          id="extension-api-key"
          class="setup-input"
          type="password"
          autocomplete="off"
          spellcheck="false"
          placeholder="xai-…"
        />
        <p id="extension-api-key-status" class="setup-field-status">Loading extension settings…</p>
      </div>
      <div class="setup-field">
        <label for="extension-model">Grok model</label>
        <select id="extension-model" class="setup-input">
          <option value="grok-4-1-fast">grok-4-1-fast (recommended)</option>
          <option value="grok-4-fast">grok-4-fast</option>
          <option value="grok-4">grok-4 (higher quality, slower)</option>
        </select>
      </div>
      <div class="setup-field setup-field-wide">
        <label>Ingest token (same for all devices)</label>
        <p class="setup-field-status">
          Persists across app updates in <code>/data/settings.json</code>. Only regenerate if the token
          was compromised.
        </p>
        <div class="token">
          <code id="token-value">Loading…</code>
          <button id="copy-token-btn" class="secondary" type="button">Copy token</button>
        </div>
      </div>
    </div>
    <div class="setup-actions">
      <button id="save-extension-settings-btn" class="primary" type="button">Save extension settings</button>
      <button id="copy-setup-btn" class="secondary" type="button">Copy all for extension</button>
      <button id="regenerate-token-btn" class="danger-btn" type="button">Regenerate token</button>
      <button id="close-device-btn" class="secondary" type="button">Close</button>
    </div>
      </section>
      <section id="backup-panel" class="panel hidden">
    <h2 class="panel-title-desktop">Backup &amp; restore</h2>
    <p class="panel-lead">
      Copy your library to <code id="backup-host-path">/home/umbrel/recipes-backup</code> on your Umbrel.
      This folder is outside the app install directory and survives uninstall. SSH scripts in
      <code>wolverineks-recipes/scripts/</code> use the same location.
    </p>
    <div class="setup-grid">
      <div class="setup-field">
        <label>Live library</label>
        <p id="backup-library-summary" class="setup-field-status">Loading…</p>
      </div>
      <div class="setup-field">
        <label>Backup folder</label>
        <p id="backup-folder-summary" class="setup-field-status">Loading…</p>
      </div>
    </div>
    <p id="backup-status" class="setup-field-status"></p>
    <div class="setup-actions">
      <button id="backup-export-btn" class="primary" type="button">Back up now</button>
      <button id="backup-import-btn" class="secondary" type="button">Restore from backup</button>
    </div>
      </section>
      <div class="listing-header">
        <div id="recipe-status" class="status"></div>
        <div class="view-toggle" role="group" aria-label="Layout view">
          <button id="view-grid" class="view-toggle-btn active" type="button" title="Grid view" aria-label="Grid view" aria-pressed="true">▦</button>
          <button id="view-list" class="view-toggle-btn" type="button" title="List view" aria-label="List view" aria-pressed="false">≡</button>
        </div>
      </div>
      <div id="listing-table" class="listing-table">
        <div id="list-header" class="list-header" role="row" hidden></div>
        <div id="list" class="grid"></div>
      </div>
      <div id="empty" class="empty hidden">No recipes saved yet. Click Setup to set up the Chrome extension.</div>
      <div id="blocklist-empty" class="empty hidden">Blocklist is empty. Block recipes that did not work out — they will not be saved from the extension again.</div>
      <div id="trash-empty" class="empty hidden">Trash is empty.</div>
      <div id="no-results" class="empty hidden">No recipes match your search.</div>
    </div>
  </main>
  <div id="category-dialog" class="dialog-backdrop" aria-hidden="true">
    <div class="dialog" role="dialog" aria-labelledby="category-dialog-title">
      <h2 id="category-dialog-title">New category</h2>
      <input id="category-name-input" type="text" placeholder="Category name" autocomplete="off" maxlength="80" />
      <div class="dialog-actions">
        <button id="category-cancel" class="secondary" type="button">Cancel</button>
        <button id="category-submit" class="primary" type="button">Save</button>
      </div>
    </div>
  </div>
  <div id="context-menu" class="context-menu" role="menu" aria-hidden="true"></div>
  <div class="app-version" aria-hidden="true">v${APP_VERSION}</div>
  <script>
    const listEl = document.getElementById("list");
    const emptyEl = document.getElementById("empty");
    const blocklistEmptyEl = document.getElementById("blocklist-empty");
    const trashEmptyEl = document.getElementById("trash-empty");
    const noResultsEl = document.getElementById("no-results");
    const searchInput = document.getElementById("search-input");
    const devicePanel = document.getElementById("device-panel");
    const backupPanel = document.getElementById("backup-panel");
    const importPanel = document.getElementById("import-panel");
    const recipeStatus = document.getElementById("recipe-status");
    const navLibrary = document.getElementById("nav-library");
    const navImport = document.getElementById("nav-import");
    const navBlocklist = document.getElementById("nav-blocklist");
    const navTrash = document.getElementById("nav-trash");
    const navDevice = document.getElementById("nav-device");
    const searchBar = document.getElementById("search-bar");
    const utilityTitle = document.getElementById("utility-title");
    const LIBRARY_SEARCH_PLACEHOLDER = "Search by name, ingredients, servings, prep time, cook time, or total time…";
    let activeView = "library";
    const tokenValue = document.getElementById("token-value");
    const baseUrlEl = document.getElementById("base-url");
    let ingestToken = "";
    const DRAG_MIME = "application/x-recipes-entry";
    let allRecipes = [];
    let loadRecipesGeneration = 0;
    let categories = [];
    let activeCategoryIds = new Set();
    let dragRecipe = null;
    let categoryDialogMode = "create";
    let categoryDialogTargetId = null;
    let layoutView = "grid";
    let sortBy = "name";
    let sortDir = "desc";
    let longPressTimer = null;
    const menuState = { recipe: null, card: null, category: null, categoryButton: null, longPress: false };

    function escapeHtml(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
    }

    function formatDate(value) {
      try { return new Date(value).toLocaleString(); } catch { return value; }
    }

    function formatTimes(recipe) {
      return [
        recipe.prep_time ? "Prep " + recipe.prep_time : "",
        recipe.cook_time ? "Cook " + recipe.cook_time : "",
        recipe.total_time ? "Total " + recipe.total_time : "",
      ].filter(Boolean).join(" · ");
    }

    function formatServings(recipe) {
      return (recipe.servings || "").trim();
    }

    function formatRecipeMeta(recipe) {
      const parts = [];
      const servings = formatServings(recipe);
      if (servings) parts.push("Servings: " + servings);
      const times = formatTimes(recipe);
      if (times) parts.push(times);
      return parts.join(" · ");
    }

    function categoryLabelText(recipe) {
      const ids = new Set(recipe.category_ids || []);
      return categories
        .filter((category) => ids.has(category.id))
        .map((category) => category.name)
        .join(", ");
    }

    function loadCategorySelection() {
      try {
        const saved = localStorage.getItem("recipes-category-filter");
        if (!saved) return;
        const ids = JSON.parse(saved);
        if (Array.isArray(ids)) activeCategoryIds = new Set(ids.filter(Boolean));
      } catch {}
    }

    function saveCategorySelection() {
      try {
        localStorage.setItem("recipes-category-filter", JSON.stringify([...activeCategoryIds]));
      } catch {}
    }

    function toggleCategorySelection(categoryId) {
      if (activeCategoryIds.has(categoryId)) {
        activeCategoryIds.delete(categoryId);
      } else {
        activeCategoryIds.add(categoryId);
      }
      saveCategorySelection();
    }

    function clearCategorySelection() {
      activeCategoryIds.clear();
      saveCategorySelection();
    }

    function recipesMatchingCategories(recipes) {
      if (!activeCategoryIds.size) return recipes;
      return recipes.filter((recipe) => {
        const ids = recipe.category_ids || [];
        for (const categoryId of activeCategoryIds) {
          if (ids.includes(categoryId)) return true;
        }
        return false;
      });
    }

    function categoryScopeLabel() {
      if (!activeCategoryIds.size) return "";
      const names = categories
        .filter((category) => activeCategoryIds.has(category.id))
        .map((category) => category.name);
      if (names.length === 1) return ' in "' + names[0] + '"';
      if (names.length === 2) return ' in "' + names[0] + '", "' + names[1] + '"';
      return " in " + names.length + " categories";
    }

    function isInternalDrag(event) {
      return Array.from(event.dataTransfer?.types || []).includes(DRAG_MIME);
    }

    function clearDropTargets() {
      document.querySelectorAll(".drop-target").forEach((node) => {
        node.classList.remove("drop-target");
      });
    }

    function readDragRecipe(dataTransfer) {
      try {
        return JSON.parse(dataTransfer.getData(DRAG_MIME));
      } catch {
        return null;
      }
    }

    function dragRecipePayload(recipe) {
      return JSON.stringify({ id: recipe.id, title: recipe.title });
    }

    function canAssignCategory(recipe, categoryId) {
      return recipe?.id && categoryId && !(recipe.category_ids || []).includes(categoryId);
    }

    async function assignCategory(recipeId, categoryId) {
      const response = await fetch("/api/categories/assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipe_id: recipeId, categoryId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not add to category");
      await loadRecipes();
    }

    async function moveRecipeToTrashById(recipe, confirmMove = true) {
      if (!recipe?.id) return;
      if (confirmMove && !confirm('Move "' + recipe.title + '" to trash?')) return;
      const response = await fetch("/api/recipes/" + encodeURIComponent(recipe.id), { method: "DELETE" });
      if (!response.ok) {
        alert("Failed to move recipe to trash.");
        return;
      }
      await loadRecipes();
    }

    async function blockRecipeById(recipe, confirmBlock = true) {
      if (!recipe?.id) return;
      if (
        confirmBlock &&
        !confirm(
          'Block "' +
            recipe.title +
            '"? It will leave your library and the extension will not save this URL again.',
        )
      ) {
        return;
      }
      const response = await fetch("/api/recipes/" + encodeURIComponent(recipe.id) + "/block", {
        method: "POST",
      });
      const data = await response.json();
      if (!response.ok) {
        alert(data.error || "Failed to block recipe.");
        return;
      }
      await loadRecipes();
    }

    async function unblockRecipeById(recipe) {
      if (!recipe?.id) return;
      const response = await fetch("/api/blocklist/unblock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: recipe.id }),
      });
      const data = await response.json();
      if (!response.ok) {
        alert(data.error || "Failed to unblock recipe.");
        return;
      }
      await loadRecipes();
    }

    async function removeFromBlocklistById(recipe) {
      if (!recipe?.id) return;
      if (
        !confirm(
          'Remove "' + recipe.title + '" from the blocklist? This URL can be saved from the extension again.',
        )
      ) {
        return;
      }
      const response = await fetch("/api/blocklist/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: recipe.id }),
      });
      const data = await response.json();
      if (!response.ok) {
        alert(data.error || "Failed to remove recipe from blocklist.");
        return;
      }
      await loadRecipes();
    }

    async function emptyBlocklistBin() {
      if (!confirm("Clear blocklist? Blocked URLs can be saved from the extension again.")) return;
      const response = await fetch("/api/blocklist/empty", { method: "POST" });
      const data = await response.json();
      if (!response.ok) {
        alert(data.error || "Failed to clear blocklist.");
        return;
      }
      await loadRecipes();
    }

    async function restoreRecipeById(recipe) {
      if (!recipe?.id) return;
      const response = await fetch("/api/trash/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: recipe.id }),
      });
      const data = await response.json();
      if (!response.ok) {
        alert(data.error || "Failed to restore recipe.");
        return;
      }
      await loadRecipes();
    }

    async function deleteForeverById(recipe) {
      if (!recipe?.id) return;
      if (!confirm('Permanently delete "' + recipe.title + '"?')) return;
      const response = await fetch("/api/trash/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: recipe.id }),
      });
      const data = await response.json();
      if (!response.ok) {
        alert(data.error || "Failed to delete recipe.");
        return;
      }
      await loadRecipes();
    }

    async function emptyTrashBin() {
      if (!confirm("Empty trash? This permanently deletes all trashed recipes.")) return;
      const response = await fetch("/api/trash/empty", { method: "POST" });
      const data = await response.json();
      if (!response.ok) {
        alert(data.error || "Failed to empty trash.");
        return;
      }
      await loadRecipes();
    }

    async function deleteDraggedRecipe(recipe) {
      await moveRecipeToTrashById(recipe, false);
    }

    async function saveRecipeNotes(recipeId, notes) {
      const response = await fetch("/api/recipes/" + encodeURIComponent(recipeId) + "/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save notes");
      const index = allRecipes.findIndex((item) => item.id === recipeId);
      if (index >= 0) allRecipes[index] = { ...allRecipes[index], ...data.recipe };
      return data.recipe;
    }

    async function unassignCategory(recipeId, categoryId) {
      const response = await fetch("/api/categories/unassign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipe_id: recipeId, categoryId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not remove from category");
      await loadRecipes();
    }

    function clearContextSelection() {
      document.querySelectorAll(".card.selected").forEach((node) => {
        node.classList.remove("selected");
      });
    }

    function clearCategoryContextSelection() {
      document.querySelectorAll(".category-item.context-selected").forEach((node) => {
        node.classList.remove("context-selected");
      });
    }

    function closeContextMenu() {
      const menu = document.getElementById("context-menu");
      menu.classList.remove("open");
      menu.setAttribute("aria-hidden", "true");
      menuState.recipe = null;
      menuState.card = null;
      menuState.category = null;
      menuState.categoryButton = null;
      clearContextSelection();
      clearCategoryContextSelection();
    }

    function categoryAssignmentActions(recipe) {
      const assigned = new Set(recipe.category_ids || []);
      const actions = [];
      for (const category of categories) {
        if (assigned.has(category.id)) {
          actions.push({
            id: "unassign-category:" + category.id,
            label: "Remove from " + category.name,
          });
        } else {
          actions.push({
            id: "assign-category:" + category.id,
            label: "Add to " + category.name,
          });
        }
      }
      return actions;
    }

    function withCategorySubmenu(actions, recipe) {
      const categoryActions = categoryAssignmentActions(recipe);
      const insertBefore = actions.findIndex((action) => action.id === "block" || action.id === "trash");
      const insertAt = insertBefore === -1 ? actions.length : insertBefore;
      const submenu = { id: "categories-submenu", label: "Categories", submenu: categoryActions };
      return [...actions.slice(0, insertAt), submenu, ...actions.slice(insertAt)];
    }

    function recipeContextMenuActions(recipe) {
      if (activeView === "blocklist") {
        const actions = [
          { id: "print", label: "Print" },
          { id: "unblock", label: "Unblock and restore" },
          { id: "remove-block", label: "Remove from blocklist", danger: true },
        ];
        if (recipe.source_url) {
          actions.splice(1, 0, { id: "open-source", label: "Open source" });
        }
        return actions;
      }
      if (activeView === "trash") {
        const actions = [
          { id: "print", label: "Print" },
          { id: "restore", label: "Restore" },
          { id: "delete-forever", label: "Delete forever", danger: true },
        ];
        if (recipe.source_url) {
          actions.splice(1, 0, { id: "open-source", label: "Open source" });
        }
        return actions;
      }
      const actions = [{ id: "print", label: "Print" }];
      if (recipe.source_url) {
        actions.push({ id: "open-source", label: "Open source" });
      }
      for (const categoryId of activeCategoryIds) {
        const categoryName = categories.find((category) => category.id === categoryId)?.name || "category";
        actions.push({ id: "unassign-current:" + categoryId, label: "Remove from " + categoryName });
      }
      actions.push({ id: "block", label: "Block recipe", danger: true });
      actions.push({ id: "trash", label: "Move to trash", danger: true });
      return withCategorySubmenu(actions, recipe);
    }

    function renderMenuAction(action) {
      if (action.submenu) {
        const items = (action.submenu || []).filter((item) => !item.hidden);
        const panel = items.length
          ? items
            .map((item) =>
              '<button type="button" data-action="' + item.id + '" class="' + (item.danger ? "danger" : "") + '">' + escapeHtml(item.label) + "</button>"
            )
            .join("")
          : '<div class="menu-submenu-empty">No categories yet</div>';
        return (
          '<div class="menu-submenu">' +
          '<button type="button" class="menu-submenu-trigger" aria-haspopup="true" aria-expanded="false">' +
          "<span>" + escapeHtml(action.label) + "</span>" +
          '<span class="menu-submenu-chevron" aria-hidden="true">›</span>' +
          "</button>" +
          '<div class="menu-submenu-panel" role="menu">' + panel + "</div>" +
          "</div>"
        );
      }
      return (
        '<button type="button" data-action="' + action.id + '" class="' + (action.danger ? "danger" : "") + '">' +
        escapeHtml(action.label) +
        "</button>"
      );
    }

    function positionContextSubmenus() {
      document.querySelectorAll("#context-menu .menu-submenu-panel").forEach((panel) => {
        panel.classList.remove("flip-left");
        const submenu = panel.closest(".menu-submenu");
        if (!submenu) return;
        submenu.classList.add("open");
        const rect = panel.getBoundingClientRect();
        submenu.classList.remove("open");
        if (rect.right > window.innerWidth - 8) {
          panel.classList.add("flip-left");
        }
      });
    }

    function openContextMenu(actions, label, x, y, options = {}) {
      const menu = document.getElementById("context-menu");
      const visibleActions = actions.filter((action) => !action.hidden);
      if (!visibleActions.length) return;

      menu.innerHTML =
        '<div class="menu-label">' + escapeHtml(label) + "</div>" +
        visibleActions.map((action) => renderMenuAction(action)).join("");
      menu.classList.add("open");
      menu.setAttribute("aria-hidden", "false");
      const rect = menu.getBoundingClientRect();
      const left = Math.min(x, window.innerWidth - rect.width - 8);
      const top = Math.min(y, window.innerHeight - rect.height - 8);
      menu.style.left = Math.max(8, left) + "px";
      menu.style.top = Math.max(8, top) + "px";
      positionContextSubmenus();

      menu.querySelectorAll(".menu-submenu-trigger").forEach((trigger) => {
        trigger.addEventListener("click", (event) => {
          event.stopPropagation();
          const submenu = trigger.closest(".menu-submenu");
          if (!submenu) return;
          const open = submenu.classList.contains("open");
          menu.querySelectorAll(".menu-submenu.open").forEach((node) => node.classList.remove("open"));
          if (!open) submenu.classList.add("open");
        });
      });

      if (options.onOpen) options.onOpen();
    }

    function categoryContextMenuActions(category) {
      return [
        { id: "rename-category", label: "Rename" },
        { id: "delete-category", label: "Delete category", danger: true },
      ];
    }

    function openCategoryContextMenu(category, x, y, button) {
      closeContextMenu();
      menuState.category = category;
      menuState.categoryButton = button;
      if (button) button.classList.add("context-selected");
      openContextMenu(categoryContextMenuActions(category), category.name, x, y);
    }

    function openRecipeContextMenu(recipe, x, y, card) {
      closeContextMenu();
      menuState.recipe = recipe;
      menuState.card = card;
      clearContextSelection();
      if (card) card.classList.add("selected");

      const actions = recipeContextMenuActions(recipe);
      openContextMenu(actions, recipe.title, x, y, {
        onOpen() {
          if (card) card.classList.add("selected");
        },
      });
    }

    async function deleteCategoryById(category) {
      if (!category?.id) return;
      const name = category.name || "category";
      if (!confirm('Delete category "' + name + '"? Recipes stay in your library.')) return;
      const response = await fetch("/api/categories/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: category.id }),
      });
      if (!response.ok) {
        alert("Failed to delete category.");
        return;
      }
      activeCategoryIds.delete(category.id);
      saveCategorySelection();
      await loadRecipes();
    }

    async function runCategoryMenuAction(action, category) {
      if (action === "rename-category") {
        openCategoryDialog("rename", category);
        return;
      }
      if (action === "delete-category") {
        await deleteCategoryById(category);
      }
    }

    async function runRecipeMenuAction(action, recipe, card) {
      if (action === "print") {
        window.open("/recipes/" + encodeURIComponent(recipe.id) + "/print?auto=1", "_blank", "noopener");
        return;
      }
      if (action === "open-source") {
        if (recipe.source_url) window.open(recipe.source_url, "_blank", "noopener");
        return;
      }
      if (action.startsWith("assign-category:")) {
        await assignCategory(recipe.id, action.slice("assign-category:".length));
        return;
      }
      if (action.startsWith("unassign-category:")) {
        await unassignCategory(recipe.id, action.slice("unassign-category:".length));
        return;
      }
      if (action.startsWith("unassign-current:")) {
        await unassignCategory(recipe.id, action.slice("unassign-current:".length));
        return;
      }
      if (action === "block") {
        await blockRecipeById(recipe);
        return;
      }
      if (action === "trash") {
        await moveRecipeToTrashById(recipe);
        return;
      }
      if (action === "unblock") {
        await unblockRecipeById(recipe);
        return;
      }
      if (action === "remove-block") {
        await removeFromBlocklistById(recipe);
        return;
      }
      if (action === "restore") {
        await restoreRecipeById(recipe);
        return;
      }
      if (action === "delete-forever") {
        await deleteForeverById(recipe);
      }
    }

    function bindBlocklistDropTarget(element) {
      if (element.dataset.dropBound === "true") return;
      element.dataset.dropBound = "true";

      element.addEventListener("dragover", (event) => {
        if (activeView !== "library" || !isInternalDrag(event)) return;
        const recipe = dragRecipe;
        if (!recipe?.id) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        element.classList.add("drop-target");
      });

      element.addEventListener("dragleave", (event) => {
        if (!element.contains(event.relatedTarget)) {
          element.classList.remove("drop-target");
        }
      });

      element.addEventListener("drop", async (event) => {
        if (activeView !== "library" || !isInternalDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        clearDropTargets();
        const recipe = readDragRecipe(event.dataTransfer) || dragRecipe;
        if (!recipe?.id) return;
        try {
          await blockRecipeById(recipe, false);
        } catch (error) {
          alert(error.message || "Could not block recipe.");
        }
      });
    }

    function bindTrashDropTarget(element) {
      if (element.dataset.dropBound === "true") return;
      element.dataset.dropBound = "true";

      element.addEventListener("dragover", (event) => {
        if (activeView !== "library" || !isInternalDrag(event)) return;
        const recipe = dragRecipe;
        if (!recipe?.id) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        element.classList.add("drop-target");
      });

      element.addEventListener("dragleave", (event) => {
        if (!element.contains(event.relatedTarget)) {
          element.classList.remove("drop-target");
        }
      });

      element.addEventListener("drop", async (event) => {
        if (activeView !== "library" || !isInternalDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        clearDropTargets();
        const recipe = readDragRecipe(event.dataTransfer) || dragRecipe;
        if (!recipe?.id) return;
        try {
          await deleteDraggedRecipe(recipe);
        } catch (error) {
          alert(error.message || "Could not move recipe to trash.");
        }
      });
    }

    function bindCategoryDropTarget(button) {
      if (button.dataset.dropBound === "true") return;
      button.dataset.dropBound = "true";
      const categoryId = button.dataset.id;

      button.addEventListener("dragover", (event) => {
        if (activeView !== "library" || !isInternalDrag(event)) return;
        const recipe = dragRecipe;
        if (!recipe || !canAssignCategory(recipe, categoryId)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        button.classList.add("drop-target");
      });

      button.addEventListener("dragleave", (event) => {
        if (!button.contains(event.relatedTarget)) {
          button.classList.remove("drop-target");
        }
      });

      button.addEventListener("drop", async (event) => {
        if (activeView !== "library" || !isInternalDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        clearDropTargets();
        const recipe = readDragRecipe(event.dataTransfer) || dragRecipe;
        if (!recipe || !canAssignCategory(recipe, categoryId)) return;
        try {
          await assignCategory(recipe.id, categoryId);
        } catch (error) {
          alert(error.message || "Could not add to category.");
        }
      });
    }

    function bindRecipeCardDrag(card, recipe) {
      if (activeView === "trash" || activeView === "blocklist") return;
      card.setAttribute("draggable", "true");
      card.addEventListener("dragstart", (event) => {
        dragRecipe = recipe;
        event.dataTransfer.setData(DRAG_MIME, dragRecipePayload(recipe));
        event.dataTransfer.effectAllowed = "move";
        card.classList.add("dragging");
      });
      card.addEventListener("dragend", () => {
        card.classList.remove("dragging");
        dragRecipe = null;
        clearDropTargets();
      });
    }

    function renderCategoriesSidebar() {
      const root = document.getElementById("categories-list");
      if (!root) return;
      if (!categories.length) {
        root.innerHTML = '<div class="categories-empty">Create categories, then drag recipes onto them</div>';
        return;
      }
      root.innerHTML = categories.map((category) => {
        const active = activeCategoryIds.has(category.id);
        return \`
          <button
            type="button"
            class="category-item\${active ? " active" : ""}"
            data-id="\${escapeHtml(category.id)}"
            data-name="\${escapeHtml(category.name)}"
          >
            <span class="category-icon" aria-hidden="true">🏷</span>
            <span class="category-name">\${escapeHtml(category.name)}</span>
          </button>\`;
      }).join("");

      root.querySelectorAll(".category-item").forEach((button) => {
        button.addEventListener("click", () => {
          if (menuState.longPress) {
            menuState.longPress = false;
            return;
          }
          toggleCategorySelection(button.dataset.id);
          activeView = "library";
          hideUtilityPanels();
          setActiveNav("library");
          renderCategoriesSidebar();
          renderRecipes();
          closeSidebar();
        });
        button.addEventListener("dblclick", (event) => {
          event.preventDefault();
          openCategoryDialog("rename", {
            id: button.dataset.id,
            name: button.dataset.name,
          });
        });
        button.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          openCategoryContextMenu(
            { id: button.dataset.id, name: button.dataset.name },
            event.clientX,
            event.clientY,
            button
          );
        });
        button.addEventListener("touchstart", (event) => {
          if (event.touches.length !== 1) return;
          const touch = event.touches[0];
          clearTimeout(longPressTimer);
          longPressTimer = window.setTimeout(() => {
            menuState.longPress = true;
            openCategoryContextMenu(
              { id: button.dataset.id, name: button.dataset.name },
              touch.clientX,
              touch.clientY,
              button
            );
          }, 500);
        }, { passive: true });
        button.addEventListener("touchend", () => clearTimeout(longPressTimer));
        button.addEventListener("touchmove", () => clearTimeout(longPressTimer));
        button.addEventListener("touchcancel", () => clearTimeout(longPressTimer));
        bindCategoryDropTarget(button);
      });
    }

    async function refreshCategories() {
      const response = await fetch("/api/categories");
      const data = await response.json();
      categories = data.categories || [];
      const validIds = new Set(categories.map((category) => category.id));
      for (const id of [...activeCategoryIds]) {
        if (!validIds.has(id)) activeCategoryIds.delete(id);
      }
      saveCategorySelection();
      renderCategoriesSidebar();
    }

    function openCategoryDialog(mode, category) {
      categoryDialogMode = mode;
      categoryDialogTargetId = category?.id || null;
      const dialog = document.getElementById("category-dialog");
      const title = document.getElementById("category-dialog-title");
      const input = document.getElementById("category-name-input");
      title.textContent = mode === "rename" ? "Rename category" : "New category";
      input.value = category?.name || "";
      dialog.classList.add("open");
      dialog.setAttribute("aria-hidden", "false");
      input.focus();
      input.select();
    }

    function closeCategoryDialog() {
      const dialog = document.getElementById("category-dialog");
      dialog.classList.remove("open");
      dialog.setAttribute("aria-hidden", "true");
      categoryDialogTargetId = null;
    }

    async function submitCategoryDialog() {
      const input = document.getElementById("category-name-input");
      const name = (input.value || "").trim();
      if (!name) return;
      const endpoint = categoryDialogMode === "rename" ? "/api/categories/rename" : "/api/categories/create";
      const body = categoryDialogMode === "rename"
        ? { id: categoryDialogTargetId, name }
        : { name };
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) {
        alert(data.error || "Could not save category.");
        return;
      }
      closeCategoryDialog();
      await loadRecipes();
    }

    function loadLayoutAndSort() {
      try {
        const savedView = localStorage.getItem("recipes-layout-view");
        if (savedView === "grid" || savedView === "list") layoutView = savedView;
        const savedSort = localStorage.getItem("recipes-sort");
        if (savedSort) {
          const parsed = JSON.parse(savedSort);
          const validSort = new Set(["name", "servings", "total"]);
          if (parsed.by && validSort.has(parsed.by)) sortBy = parsed.by;
          if (parsed.dir === "asc" || parsed.dir === "desc") sortDir = parsed.dir;
        }
      } catch {}
    }

    function saveLayoutView() {
      try { localStorage.setItem("recipes-layout-view", layoutView); } catch {}
    }

    function saveSort() {
      try { localStorage.setItem("recipes-sort", JSON.stringify({ by: sortBy, dir: sortDir })); } catch {}
    }

    function defaultSortDir(column) {
      if (column === "name" || column === "servings") return "asc";
      return "desc";
    }

    function sortHeaderIndicator(column) {
      if (sortBy !== column) return "";
      return sortDir === "asc" ? " ↑" : " ↓";
    }

    function sortValue(recipe, column) {
      if (column === "name") return (recipe.title || "").toLowerCase();
      if (column === "servings") return formatServings(recipe).toLowerCase();
      if (column === "total") return (recipe.total_time || "").toLowerCase();
      return "";
    }

    function sortRecipes(recipes) {
      const dir = sortDir === "asc" ? 1 : -1;
      return [...recipes].sort((a, b) => {
        const av = sortValue(a, sortBy);
        const bv = sortValue(b, sortBy);
        if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
        return String(av).localeCompare(String(bv)) * dir;
      });
    }

    function listHeaderColumns() {
      return [
        { id: "name", label: "Name", sortable: true, className: "cell-name" },
        { id: "servings", label: "Servings", sortable: true, className: "cell-servings" },
        { id: "total", label: "Total", sortable: true, className: "cell-total" },
        { id: "", label: "", sortable: false, className: "cell-actions" },
      ];
    }

    function renderListHeader() {
      const header = document.getElementById("list-header");
      if (!header) return;
      if (layoutView !== "list") {
        header.hidden = true;
        header.classList.remove("visible");
        header.innerHTML = "";
        return;
      }
      header.hidden = false;
      header.classList.add("visible");
      header.innerHTML =
        '<div class="list-header-spacer" aria-hidden="true"></div>' +
        listHeaderColumns()
          .map((column) => {
            if (!column.sortable) {
              return '<div class="list-header-cell ' + column.className + '"></div>';
            }
            const active = sortBy === column.id ? " active" : "";
            const indicator = sortHeaderIndicator(column.id);
            return '<button type="button" class="list-header-cell sortable ' + column.className + active + '" data-list-sort="' + column.id + '">' + escapeHtml(column.label) + indicator + '</button>';
          })
          .join("");
    }

    function bindListHeader() {
      const header = document.getElementById("list-header");
      if (!header || header.dataset.bound === "true") return;
      header.dataset.bound = "true";
      header.addEventListener("click", (event) => {
        const button = event.target.closest("[data-list-sort]");
        if (!button) return;
        const next = button.getAttribute("data-list-sort");
        if (!next) return;
        if (sortBy === next) {
          sortDir = sortDir === "asc" ? "desc" : "asc";
        } else {
          sortBy = next;
          sortDir = defaultSortDir(next);
        }
        saveSort();
        renderListHeader();
        renderRecipes();
      });
    }

    function applyLayoutView() {
      listEl.classList.toggle("list-view", layoutView === "list");
      document.getElementById("listing-table")?.classList.toggle("list-active", layoutView === "list");
      const gridButton = document.getElementById("view-grid");
      const listButton = document.getElementById("view-list");
      gridButton?.classList.toggle("active", layoutView === "grid");
      listButton?.classList.toggle("active", layoutView === "list");
      gridButton?.setAttribute("aria-pressed", layoutView === "grid" ? "true" : "false");
      listButton?.setAttribute("aria-pressed", layoutView === "list" ? "true" : "false");
      renderListHeader();
    }

    function setLayoutView(next) {
      if (next !== "grid" && next !== "list") return;
      if (layoutView === next) return;
      layoutView = next;
      saveLayoutView();
      applyLayoutView();
      renderRecipes();
    }

    function closeOpenCards(except) {
      listEl.querySelectorAll(".card.open").forEach((node) => {
        if (node !== except) node.classList.remove("open");
      });
    }

    function toggleRecipeCard(card) {
      const willOpen = !card.classList.contains("open");
      closeOpenCards(card);
      card.classList.toggle("open", willOpen);
    }

    function openRecipeCard(card) {
      closeOpenCards(card);
      card.classList.add("open");
    }

    function renderRecipeCard(recipe) {
      const card = document.createElement("article");
      card.className = "card";
      const imageApiBase =
        activeView === "trash" ? "/api/trash/" : activeView === "blocklist" ? "/api/blocklist/" : "/api/recipes/";
      const imageUrl = recipe.has_image
        ? imageApiBase + encodeURIComponent(recipe.id) + "/image"
        : "";
      const inTrash = activeView === "trash";
      const inBlocklist = activeView === "blocklist";
      const inArchive = inTrash || inBlocklist;
      const dateLabel = inTrash ? "Deleted" : inBlocklist ? "Blocked" : "Saved";
      const dateValue = inTrash
        ? formatDate(recipe.deleted_at)
        : inBlocklist
          ? formatDate(recipe.blocked_at)
          : formatDate(recipe.updated_at || recipe.created_at);
      const imageMarkup = imageUrl
        ? '<img class="recipe-image grid-only" src="' + imageUrl + '" alt="" loading="lazy" />'
        : '<div class="recipe-image-placeholder grid-only" aria-hidden="true">🍽</div>';
      const thumbMarkup = imageUrl
        ? '<div class="cell-thumb list-only"><img src="' + imageUrl + '" alt="" loading="lazy" /></div>'
        : '<div class="cell-thumb list-only" aria-hidden="true">🍽</div>';
      const times = formatTimes(recipe);
      const servingsText = formatServings(recipe) || "—";
      const recipeMeta = formatRecipeMeta(recipe);
      const categoryText = categoryLabelText(recipe);
      const totalText = recipe.total_time || "—";
      const notesSection = inArchive
        ? (recipe.notes
          ? '<section class="recipe-notes"><h3>Notes</h3><p class="recipe-notes-readonly">' + escapeHtml(recipe.notes) + '</p></section>'
          : "")
        : \`
          <section class="recipe-notes">
            <h3>Notes</h3>
            <textarea class="recipe-notes-input" rows="4" placeholder="Add your own notes…">\${escapeHtml(recipe.notes || "")}</textarea>
            <div class="recipe-notes-actions">
              <button class="secondary save-notes-btn" data-id="\${escapeHtml(recipe.id)}" type="button">Save notes</button>
              <span class="recipe-notes-status" aria-live="polite"></span>
            </div>
          </section>
        \`;
      card.innerHTML = \`
        \${thumbMarkup}
        \${imageMarkup}
        <h2 class="name">\${escapeHtml(recipe.title)}</h2>
        <div class="meta grid-only">\${escapeHtml(dateLabel)} \${escapeHtml(dateValue)} · <a href="\${escapeHtml(recipe.source_url)}" target="_blank" rel="noreferrer">Source</a></div>
        <div class="card-categories grid-only">\${escapeHtml(categoryText || "—")}</div>
        <div class="times grid-only">\${escapeHtml(recipeMeta || "—")}</div>
        <div class="cell-servings list-only">\${escapeHtml(servingsText)}</div>
        <div class="cell-total list-only">\${escapeHtml(totalText)}</div>
        <div class="card-actions grid-only">
          <button class="secondary print-btn" data-id="\${escapeHtml(recipe.id)}" type="button">Print</button>
          \${inTrash
            ? '<button class="secondary restore-btn" data-id="' + escapeHtml(recipe.id) + '" type="button">Restore</button>'
            : inBlocklist
              ? '<button class="secondary restore-btn" data-id="' + escapeHtml(recipe.id) + '" type="button">Unblock</button>'
              : ""}
        </div>
        <div class="cell-actions list-only">
          <button class="secondary print-btn" data-id="\${escapeHtml(recipe.id)}" type="button">Print</button>
          \${inTrash
            ? '<button class="secondary restore-btn" data-id="' + escapeHtml(recipe.id) + '" type="button">Restore</button>'
            : inBlocklist
              ? '<button class="secondary restore-btn" data-id="' + escapeHtml(recipe.id) + '" type="button">Unblock</button>'
              : ""}
        </div>
        <div class="detail">
          \${recipe.description ? '<p>' + escapeHtml(recipe.description) + '</p>' : ''}
          \${recipeMeta ? '<p class="recipe-meta">' + escapeHtml(recipeMeta) + '</p>' : ''}
          <div class="columns">
            <div>
              <h3>Ingredients</h3>
              <ul>\${(recipe.ingredients || []).map((item) => '<li>' + escapeHtml(item) + '</li>').join("")}</ul>
            </div>
            <div>
              <h3>Instructions</h3>
              <ol>\${(recipe.instructions || []).map((item) => '<li>' + escapeHtml(item) + '</li>').join("")}</ol>
            </div>
          </div>
          \${notesSection}
        </div>
      \`;
      card.addEventListener("click", (event) => {
        if (menuState.longPress) {
          menuState.longPress = false;
          return;
        }
        if (event.target.closest("a, button, textarea")) return;
        toggleRecipeCard(card);
      });
      card.querySelectorAll(".print-btn").forEach((button) => {
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          const id = event.currentTarget.getAttribute("data-id");
          window.open("/recipes/" + encodeURIComponent(id) + "/print?auto=1", "_blank", "noopener");
        });
      });
      card.querySelectorAll(".restore-btn").forEach((button) => {
        button.addEventListener("click", async (event) => {
          event.stopPropagation();
          if (activeView === "blocklist") await unblockRecipeById(recipe);
          else await restoreRecipeById(recipe);
        });
      });
      const notesInput = card.querySelector(".recipe-notes-input");
      if (notesInput) {
        notesInput.addEventListener("click", (event) => event.stopPropagation());
        notesInput.addEventListener("keydown", (event) => event.stopPropagation());
      }
      card.querySelectorAll(".save-notes-btn").forEach((button) => {
        button.addEventListener("click", async (event) => {
          event.stopPropagation();
          const textarea = card.querySelector(".recipe-notes-input");
          const status = card.querySelector(".recipe-notes-status");
          if (!textarea) return;
          const notes = textarea.value;
          button.disabled = true;
          if (status) {
            status.textContent = "Saving…";
            status.classList.remove("saved");
          }
          try {
            await saveRecipeNotes(recipe.id, notes);
            if (status) {
              status.textContent = "Saved";
              status.classList.add("saved");
              window.setTimeout(() => {
                if (status.textContent === "Saved") status.textContent = "";
                status.classList.remove("saved");
              }, 2000);
            }
          } catch (error) {
            if (status) status.textContent = "";
            alert(error.message || "Could not save notes.");
          } finally {
            button.disabled = false;
          }
        });
      });
      card.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        openRecipeContextMenu(recipe, event.clientX, event.clientY, card);
      });
      card.addEventListener("touchstart", (event) => {
        if (event.touches.length !== 1) return;
        const touch = event.touches[0];
        clearTimeout(longPressTimer);
        longPressTimer = window.setTimeout(() => {
          menuState.longPress = true;
          openRecipeContextMenu(recipe, touch.clientX, touch.clientY, card);
        }, 500);
      }, { passive: true });
      card.addEventListener("touchend", () => clearTimeout(longPressTimer));
      card.addEventListener("touchmove", () => clearTimeout(longPressTimer));
      card.addEventListener("touchcancel", () => clearTimeout(longPressTimer));
      bindRecipeCardDrag(card, recipe);
      return card;
    }

    function recipeSearchText(recipe) {
      return [
        recipe.title,
        ...(recipe.ingredients || []),
        recipe.notes,
        recipe.servings,
        recipe.prep_time,
        recipe.cook_time,
        recipe.total_time,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
    }

    function matchesSearch(recipe, query) {
      const needle = query.trim().toLowerCase();
      if (!needle) return true;
      return recipeSearchText(recipe).includes(needle);
    }

    function recipesForView() {
      let recipes = allRecipes;
      if (activeView === "library" && activeCategoryIds.size) {
        recipes = recipesMatchingCategories(recipes);
      }
      const query = searchInput.value || "";
      return recipes.filter((recipe) => matchesSearch(recipe, query));
    }

    function renderRecipes() {
      const scoped = activeView === "library" && activeCategoryIds.size
        ? recipesMatchingCategories(allRecipes)
        : allRecipes;
      const filtered = recipesForView();
      listEl.replaceChildren();
      const inTrash = activeView === "trash";
      const inBlocklist = activeView === "blocklist";
      emptyEl.classList.toggle("hidden", inTrash || inBlocklist || allRecipes.length > 0);
      blocklistEmptyEl.classList.toggle("hidden", !inBlocklist || allRecipes.length > 0);
      trashEmptyEl.classList.toggle("hidden", !inTrash || allRecipes.length > 0);
      noResultsEl.classList.toggle("hidden", filtered.length > 0 || allRecipes.length === 0);
      listEl.classList.toggle("hidden", filtered.length === 0);

      if (allRecipes.length === 0) {
        recipeStatus.textContent = "";
      } else if (inBlocklist) {
        const query = (searchInput.value || "").trim();
        if (query) {
          recipeStatus.textContent = filtered.length + " of " + allRecipes.length + " recipes blocked";
        } else {
          recipeStatus.textContent =
            allRecipes.length + (allRecipes.length === 1 ? " recipe" : " recipes") + " blocked";
        }
      } else if (inTrash) {
        const query = (searchInput.value || "").trim();
        if (query) {
          recipeStatus.textContent = filtered.length + " of " + allRecipes.length + " recipes in trash";
        } else {
          recipeStatus.textContent = allRecipes.length + (allRecipes.length === 1 ? " recipe" : " recipes") + " in trash";
        }
      } else {
        const scopeLabel = categoryScopeLabel();
        const query = (searchInput.value || "").trim();
        if (query) {
          recipeStatus.textContent = filtered.length + " of " + scoped.length + " recipes" + scopeLabel;
        } else {
          recipeStatus.textContent = scoped.length + (scoped.length === 1 ? " recipe" : " recipes") + scopeLabel;
        }
      }

      for (const recipe of sortRecipes(filtered)) {
        listEl.appendChild(renderRecipeCard(recipe));
      }
      renderListHeader();
    }

    function applySearch() {
      renderRecipes();
    }

    function recipeListKey(recipe) {
      const sourceUrl = String(recipe.source_url || "").trim();
      if (sourceUrl && !sourceUrl.startsWith("urn:")) {
        try {
          const url = new URL(sourceUrl);
          url.hash = "";
          url.hostname = url.hostname.toLowerCase().replace(/^www\\./, "");
          if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
            url.pathname = url.pathname.slice(0, -1);
          }
          if (url.protocol === "http:") url.protocol = "https:";
          return "url:" + url.toString();
        } catch {
          return "url:" + sourceUrl.toLowerCase();
        }
      }
      if (sourceUrl) return "url:" + sourceUrl;
      const title = String(recipe.title || "").trim().toLowerCase().replace(/\\s+/g, " ");
      const ingredients = (recipe.ingredients || [])
        .map((item) => String(item || "").trim().toLowerCase())
        .filter(Boolean)
        .sort()
        .join("\\n");
      if (title && ingredients) return "content:" + title + "\\n" + ingredients;
      if (title) return "title:" + title;
      return "id:" + recipe.id;
    }

    async function loadRecipes() {
      const generation = ++loadRecipesGeneration;
      if (activeView === "library") await refreshCategories();
      if (generation !== loadRecipesGeneration) return;

      const listEndpoint =
        activeView === "trash" ? "/api/trash" : activeView === "blocklist" ? "/api/blocklist" : "/api/recipes";
      const detailPrefix =
        activeView === "trash" ? "/api/trash/" : activeView === "blocklist" ? "/api/blocklist/" : "/api/recipes/";
      const response = await fetch(listEndpoint);
      if (generation !== loadRecipesGeneration) return;
      const payload = await response.json();
      const summaries = payload.recipes || [];
      const seenKeys = new Set();
      const seenIds = new Set();
      const nextRecipes = [];
      for (const summary of summaries) {
        if (generation !== loadRecipesGeneration) return;
        if (!summary?.id || seenIds.has(summary.id)) continue;
        seenIds.add(summary.id);
        const detailResponse = await fetch(detailPrefix + encodeURIComponent(summary.id));
        if (generation !== loadRecipesGeneration) return;
        const recipe = await detailResponse.json();
        if (!recipe?.id) continue;
        const key = recipeListKey(recipe);
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        nextRecipes.push(recipe);
      }
      if (generation !== loadRecipesGeneration) return;
      allRecipes = nextRecipes;
      renderRecipes();
    }

    function extensionUrl() {
      if (window.location.port) return window.location.origin;
      const host = window.location.hostname || "YOUR-UMBREL-IP";
      return window.location.protocol + "//" + host + ":4020";
    }

    function renderExtensionSettingsStatus(payload) {
      const statusEl = document.getElementById("extension-api-key-status");
      if (!statusEl) return;
      if (payload?.api_key_configured) {
        statusEl.textContent = "Saved on Umbrel (" + (payload.api_key_preview || "configured") + "). Leave blank to keep the current key.";
        statusEl.className = "setup-field-status ok";
        return;
      }
      statusEl.textContent = "No API key saved yet. Paste one above and click Save extension settings.";
      statusEl.className = "setup-field-status";
    }

    async function loadDeviceSetup() {
      const [tokenResponse, extensionResponse] = await Promise.all([
        fetch("/api/settings/token"),
        fetch("/api/settings/extension"),
      ]);
      const tokenPayload = await tokenResponse.json();
      const extensionPayload = await extensionResponse.json();
      ingestToken = tokenPayload.ingest_token || "";
      tokenValue.textContent = ingestToken;
      baseUrlEl.textContent = extensionUrl();
      const modelSelect = document.getElementById("extension-model");
      if (modelSelect) modelSelect.value = extensionPayload.model || "grok-4-1-fast";
      renderExtensionSettingsStatus(extensionPayload);
      await refreshBackupStatus();
    }

    async function saveExtensionSettings() {
      const apiKeyInput = document.getElementById("extension-api-key");
      const modelSelect = document.getElementById("extension-model");
      const statusEl = document.getElementById("extension-api-key-status");
      const response = await fetch("/api/settings/extension", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: apiKeyInput?.value || "",
          model: modelSelect?.value || "grok-4-1-fast",
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        if (statusEl) {
          statusEl.textContent = payload.error || "Could not save extension settings.";
          statusEl.className = "setup-field-status error";
        }
        return;
      }
      if (apiKeyInput) apiKeyInput.value = "";
      renderExtensionSettingsStatus(payload);
    }

    function setupClipboardText() {
      return [
        "Recipe Printer extension setup",
        "",
        "Umbrel Recipes URL:",
        baseUrlEl.textContent || "",
        "",
        "Ingest token:",
        ingestToken || tokenValue.textContent || "",
      ].join("\\n");
    }

    async function copyTextToClipboard(text) {
      const value = String(text || "");
      if (!value) throw new Error("Nothing to copy");
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(value);
          return;
        } catch {
          // Fall back for HTTP or denied permission.
        }
      }
      const textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      textarea.setSelectionRange(0, value.length);
      let copied = false;
      try {
        copied = document.execCommand("copy");
      } finally {
        textarea.remove();
      }
      if (!copied) throw new Error("Could not copy to clipboard");
    }

    function showCopyFeedback(button, message = "Copied!") {
      if (!button) return;
      const original = button.textContent;
      button.textContent = message;
      button.disabled = true;
      window.setTimeout(() => {
        button.textContent = original;
        button.disabled = false;
      }, 1500);
    }

    function hideUtilityPanels() {
      devicePanel.classList.add("hidden");
      backupPanel.classList.add("hidden");
      importPanel.classList.add("hidden");
    }

    function isMobileLayout() {
      return window.matchMedia("(max-width: 800px)").matches;
    }

    function expandPanelSections(panel) {
      if (!panel || !isMobileLayout()) return;
      panel.querySelectorAll("[data-collapsible]").forEach((section) => {
        section.classList.add("is-open");
        const header = section.querySelector(".collapsible-header");
        if (header) header.setAttribute("aria-expanded", "true");
      });
    }

    function bindCollapsibleSections() {
      document.querySelectorAll("[data-collapsible]").forEach((section) => {
        const header = section.querySelector(".collapsible-header");
        if (!header) return;
        header.addEventListener("click", (event) => {
          if (!isMobileLayout()) return;
          if (event.target.closest(".categories-add")) return;
          const open = section.classList.toggle("is-open");
          header.setAttribute("aria-expanded", open ? "true" : "false");
        });
      });
      document.getElementById("add-category")?.addEventListener("click", (event) => {
        event.stopPropagation();
      });
    }

    function formatBackupTimestamp(value) {
      if (!value) return "never";
      try {
        return new Date(value).toLocaleString();
      } catch {
        return value;
      }
    }

    async function refreshBackupStatus(message) {
      const librarySummary = document.getElementById("backup-library-summary");
      const folderSummary = document.getElementById("backup-folder-summary");
      const hostPathEl = document.getElementById("backup-host-path");
      const statusEl = document.getElementById("backup-status");
      const exportBtn = document.getElementById("backup-export-btn");
      const importBtn = document.getElementById("backup-import-btn");
      try {
        const response = await fetch("/api/backup/status");
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Could not load backup status.");

        const hostPath = payload.backup_host_path || "/home/umbrel/recipes-backup";
        if (hostPathEl) hostPathEl.textContent = hostPath;

        if (librarySummary) {
          librarySummary.textContent =
            payload.library_recipe_count + " recipe(s) in the live library.";
          librarySummary.className = "setup-field-status ok";
        }
        if (folderSummary) {
          if (!payload.backup_writable) {
            folderSummary.textContent =
              "Backup folder is not writable: " +
              hostPath +
              (payload.backup_writable_error ? " (" + payload.backup_writable_error + ")." : ".") +
              " Restart the Recipes app after updating.";
            folderSummary.className = "setup-field-status error";
          } else if (!payload.backup_available) {
            folderSummary.textContent =
              "No backup yet at " + hostPath + ". Click Back up now to create one.";
            folderSummary.className = "setup-field-status";
          } else {
            folderSummary.textContent =
              payload.backup_recipe_count +
              " recipe(s) backed up at " +
              hostPath +
              ". Last backup: " +
              formatBackupTimestamp(payload.backup_updated_at) +
              ".";
            folderSummary.className = "setup-field-status ok";
          }
        }
        if (exportBtn) exportBtn.disabled = !payload.backup_writable;
        if (importBtn) importBtn.disabled = !payload.backup_available;
        if (statusEl) {
          statusEl.textContent = message || "";
          statusEl.className = message ? "setup-field-status ok" : "setup-field-status";
        }
      } catch (error) {
        if (librarySummary) {
          librarySummary.textContent = error.message || "Could not load backup status.";
          librarySummary.className = "setup-field-status error";
        }
        if (folderSummary) folderSummary.textContent = "";
        if (statusEl) statusEl.textContent = "";
        if (exportBtn) exportBtn.disabled = true;
        if (importBtn) importBtn.disabled = true;
      }
    }

    async function runBackupExport() {
      const exportBtn = document.getElementById("backup-export-btn");
      const importBtn = document.getElementById("backup-import-btn");
      if (exportBtn) exportBtn.disabled = true;
      if (importBtn) importBtn.disabled = true;
      await refreshBackupStatus("Creating backup…");
      try {
        const response = await fetch("/api/backup/export", { method: "POST" });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Backup failed.");
        await refreshBackupStatus("Backup completed.");
      } catch (error) {
        const statusEl = document.getElementById("backup-status");
        if (statusEl) {
          statusEl.textContent = error.message || "Backup failed.";
          statusEl.className = "setup-field-status error";
        }
        await refreshBackupStatus();
      }
    }

    async function runBackupImport() {
      if (
        !confirm(
          "Restore from backup? This replaces the live library with the backed-up copy, including settings, trash, and blocklist.",
        )
      ) {
        return;
      }
      const exportBtn = document.getElementById("backup-export-btn");
      const importBtn = document.getElementById("backup-import-btn");
      if (exportBtn) exportBtn.disabled = true;
      if (importBtn) importBtn.disabled = true;
      await refreshBackupStatus("Restoring from backup…");
      try {
        const response = await fetch("/api/backup/import", { method: "POST" });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Restore failed.");
        await refreshBackupStatus("Restore completed.");
        await showLibrary();
      } catch (error) {
        const statusEl = document.getElementById("backup-status");
        if (statusEl) {
          statusEl.textContent = error.message || "Restore failed.";
          statusEl.className = "setup-field-status error";
        }
        await refreshBackupStatus();
      }
    }

    async function refreshImportStatus() {
      const statusEl = document.getElementById("import-status");
      const saveLaterBtn = document.getElementById("import-save-later");
      const savePrintBtn = document.getElementById("import-save-print");
      try {
        const response = await fetch("/api/settings/extension");
        const payload = await response.json();
        const ready = Boolean(payload.api_key_configured);
        if (saveLaterBtn) saveLaterBtn.disabled = !ready;
        if (savePrintBtn) savePrintBtn.disabled = !ready;
        if (!statusEl) return;
        if (ready) {
          statusEl.textContent = "Ready to import.";
          statusEl.className = "setup-field-status ok";
        } else {
          statusEl.textContent = "Save an xAI API key under Setup before importing.";
          statusEl.className = "setup-field-status";
        }
      } catch (error) {
        if (statusEl) {
          statusEl.textContent = error.message || "Could not load import settings.";
          statusEl.className = "setup-field-status error";
        }
        if (saveLaterBtn) saveLaterBtn.disabled = true;
        if (savePrintBtn) savePrintBtn.disabled = true;
      }
    }

    async function importFromUrl(shouldPrint) {
      const urlInput = document.getElementById("import-url");
      const statusEl = document.getElementById("import-status");
      const saveLaterBtn = document.getElementById("import-save-later");
      const savePrintBtn = document.getElementById("import-save-print");
      const sourceUrl = (urlInput?.value || "").trim();
      if (!sourceUrl) {
        if (statusEl) {
          statusEl.textContent = "Enter a recipe page URL.";
          statusEl.className = "setup-field-status error";
        }
        return;
      }

      if (saveLaterBtn) saveLaterBtn.disabled = true;
      if (savePrintBtn) savePrintBtn.disabled = true;
      if (statusEl) {
        statusEl.textContent = "Fetching page and formatting with Grok…";
        statusEl.className = "setup-field-status";
      }

      try {
        const response = await fetch("/api/import-from-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source_url: sourceUrl }),
        });
        const payload = await response.json();
        if (!response.ok) {
          if (statusEl) {
            statusEl.textContent = payload.error || "Import failed.";
            statusEl.className = "setup-field-status error";
          }
          return;
        }

        if (urlInput) urlInput.value = "";
        if (statusEl) {
          statusEl.textContent = shouldPrint
            ? "Saved to your library. Opening print preview…"
            : "Saved to your library.";
          statusEl.className = "setup-field-status ok";
        }

        await showLibrary();

        if (shouldPrint && payload.id) {
          window.open("/recipes/" + encodeURIComponent(payload.id) + "/print?auto=1", "_blank", "noopener");
        }
      } catch (error) {
        if (statusEl) {
          statusEl.textContent = error.message || "Import failed.";
          statusEl.className = "setup-field-status error";
        }
      } finally {
        await refreshImportStatus();
      }
    }

    function setActiveNav(view) {
      navLibrary.classList.toggle("active", view === "library");
      navImport.classList.toggle("active", view === "import");
      navBlocklist.classList.toggle("active", view === "blocklist");
      navTrash.classList.toggle("active", view === "trash");
      navDevice.classList.toggle("active", view === "device");
      document.body.classList.toggle("view-blocklist", view === "blocklist");
      document.body.classList.toggle("view-trash", view === "trash");
      document.body.classList.toggle("view-device", view === "device");
      const utilityView = view === "device" || view === "import";
      document.body.classList.toggle("view-utility", utilityView);
      if (utilityTitle) {
        utilityTitle.textContent =
          view === "device" ? "Setup" : view === "import" ? "Save from URL" : "";
      }
      searchInput.placeholder =
        view === "blocklist" ? "Search in Blocklist" : view === "trash" ? "Search in Trash" : LIBRARY_SEARCH_PLACEHOLDER;
      if (view !== "blocklist") blocklistEmptyEl.classList.add("hidden");
      if (view !== "trash") trashEmptyEl.classList.add("hidden");
    }

    async function showLibrary() {
      hideUtilityPanels();
      clearCategorySelection();
      activeView = "library";
      setActiveNav("library");
      closeContextMenu();
      closeSidebar();
      renderCategoriesSidebar();
      await loadRecipes();
    }

    function showBlocklist() {
      hideUtilityPanels();
      clearCategorySelection();
      activeView = "blocklist";
      setActiveNav("blocklist");
      closeContextMenu();
      closeSidebar();
      loadRecipes();
    }

    function showTrash() {
      hideUtilityPanels();
      clearCategorySelection();
      activeView = "trash";
      setActiveNav("trash");
      closeContextMenu();
      closeSidebar();
      loadRecipes();
    }

    function closeSidebar() {
      document.body.classList.remove("sidebar-open");
      document.getElementById("sidebar-toggle")?.setAttribute("aria-expanded", "false");
    }

    function openSidebar() {
      document.body.classList.add("sidebar-open");
      document.getElementById("sidebar-toggle")?.setAttribute("aria-expanded", "true");
    }

    function closeDevicePanel() {
      devicePanel.classList.add("hidden");
      backupPanel.classList.add("hidden");
      if (!activeCategoryIds.size && activeView !== "trash" && activeView !== "blocklist") setActiveNav("library");
    }

    function openImportPanel() {
      hideUtilityPanels();
      importPanel.classList.remove("hidden");
      setActiveNav("import");
      refreshImportStatus();
      closeSidebar();
      importPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    function closeImportPanel() {
      importPanel.classList.add("hidden");
      if (!activeCategoryIds.size && activeView !== "trash" && activeView !== "blocklist") {
        setActiveNav("library");
      }
    }

    function openDevicePanel() {
      hideUtilityPanels();
      devicePanel.classList.remove("hidden");
      backupPanel.classList.remove("hidden");
      setActiveNav("device");
      loadDeviceSetup();
      closeSidebar();
      devicePanel.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    function resolveTheme() {
      try {
        const saved = localStorage.getItem("recipes-theme");
        if (saved === "light" || saved === "dark") return saved;
      } catch {}
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }

    function applyTheme(theme) {
      const next = theme === "dark" ? "dark" : "light";
      document.documentElement.dataset.theme = next;
      const button = document.getElementById("theme-toggle");
      if (button) {
        button.textContent = next === "dark" ? "☀" : "☾";
        button.setAttribute("aria-label", next === "dark" ? "Switch to light mode" : "Switch to dark mode");
        button.title = next === "dark" ? "Light mode" : "Dark mode";
      }
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", next === "dark" ? "#1a1410" : "#e67e22");
    }

    function toggleTheme() {
      const current = document.documentElement.dataset.theme || resolveTheme();
      const next = current === "dark" ? "light" : "dark";
      try { localStorage.setItem("recipes-theme", next); } catch {}
      applyTheme(next);
    }

    document.getElementById("context-menu").addEventListener("click", async (event) => {
      if (event.target.closest(".menu-submenu-trigger")) return;
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      const action = button.dataset.action;
      if (menuState.category) {
        const category = menuState.category;
        closeContextMenu();
        try {
          await runCategoryMenuAction(action, category);
        } catch (error) {
          alert(error.message || "Could not complete action.");
        }
        return;
      }
      if (!menuState.recipe) return;
      const recipe = menuState.recipe;
      const card = menuState.card;
      closeContextMenu();
      try {
        await runRecipeMenuAction(action, recipe, card);
      } catch (error) {
        alert(error.message || "Could not complete action.");
      }
    });
    document.addEventListener("click", (event) => {
      if (!event.target.closest("#context-menu")) closeContextMenu();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeCategoryDialog();
        closeContextMenu();
      }
    });

    searchInput.addEventListener("input", applySearch);
    document.getElementById("nav-refresh").addEventListener("click", async () => {
      closeSidebar();
      await loadRecipes();
    });
    document.getElementById("nav-device").addEventListener("click", openDevicePanel);
    document.getElementById("nav-import").addEventListener("click", openImportPanel);
    document.getElementById("nav-library").addEventListener("click", showLibrary);
    document.getElementById("backup-export-btn").addEventListener("click", () => {
      runBackupExport().catch((error) => alert(error.message || "Backup failed."));
    });
    document.getElementById("backup-import-btn").addEventListener("click", () => {
      runBackupImport().catch((error) => alert(error.message || "Restore failed."));
    });
    document.getElementById("import-save-later").addEventListener("click", () => {
      importFromUrl(false).catch((error) => alert(error.message || "Import failed."));
    });
    document.getElementById("import-save-print").addEventListener("click", () => {
      importFromUrl(true).catch((error) => alert(error.message || "Import failed."));
    });
    document.getElementById("close-import-btn").addEventListener("click", closeImportPanel);
    navBlocklist.addEventListener("click", showBlocklist);
    navTrash.addEventListener("click", showTrash);
    document.getElementById("empty-blocklist").addEventListener("click", emptyBlocklistBin);
    document.getElementById("empty-trash").addEventListener("click", emptyTrashBin);
    document.getElementById("add-category").addEventListener("click", () => openCategoryDialog("create"));
    document.getElementById("category-cancel").addEventListener("click", closeCategoryDialog);
    document.getElementById("category-submit").addEventListener("click", submitCategoryDialog);
    document.getElementById("category-name-input").addEventListener("keydown", (event) => {
      if (event.key === "Enter") submitCategoryDialog();
      if (event.key === "Escape") closeCategoryDialog();
    });
    document.getElementById("category-dialog").addEventListener("click", (event) => {
      if (event.target.id === "category-dialog") closeCategoryDialog();
    });
    document.getElementById("close-device-btn").addEventListener("click", closeDevicePanel);
    document.getElementById("sidebar-toggle").addEventListener("click", () => {
      if (document.body.classList.contains("sidebar-open")) closeSidebar();
      else openSidebar();
    });
    document.getElementById("sidebar-backdrop").addEventListener("click", closeSidebar);
    document.getElementById("theme-toggle").addEventListener("click", toggleTheme);
    applyTheme(resolveTheme());
    loadLayoutAndSort();
    loadCategorySelection();
    bindListHeader();
    bindBlocklistDropTarget(document.getElementById("nav-blocklist"));
    bindTrashDropTarget(document.getElementById("nav-trash"));
    applyLayoutView();
    document.getElementById("view-grid").addEventListener("click", () => setLayoutView("grid"));
    document.getElementById("view-list").addEventListener("click", () => setLayoutView("list"));
    document.getElementById("copy-url-btn").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      try {
        await copyTextToClipboard(baseUrlEl.textContent || "");
        showCopyFeedback(button);
      } catch (error) {
        alert(error.message || "Could not copy URL.");
      }
    });
    document.getElementById("copy-token-btn").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      try {
        await copyTextToClipboard(ingestToken || tokenValue.textContent || "");
        showCopyFeedback(button);
      } catch (error) {
        alert(error.message || "Could not copy token.");
      }
    });
    document.getElementById("copy-setup-btn").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      try {
        await copyTextToClipboard(setupClipboardText());
        showCopyFeedback(button, "Copied all!");
      } catch (error) {
        alert(error.message || "Could not copy setup details.");
      }
    });
    document.getElementById("save-extension-settings-btn").addEventListener("click", () => {
      saveExtensionSettings().catch((error) => alert(error.message || "Could not save extension settings."));
    });
    document.getElementById("regenerate-token-btn").addEventListener("click", async () => {
      if (!confirm("Regenerate token? You will need to update every device using the extension.")) return;
      const response = await fetch("/api/settings/regenerate-token", { method: "POST" });
      const payload = await response.json();
      ingestToken = payload.ingest_token || "";
      tokenValue.textContent = ingestToken;
    });

    bindCollapsibleSections();
    setActiveNav("library");
    loadRecipes();
  </script>
</body>
</html>`;

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const route = url.pathname.replace(/\/+$/, "") || "/";
  const settings = await loadSettings();

  if (req.method === "GET" && route === "/icon.svg" && existsSync(ICON_PATH)) {
    const icon = await readFile(ICON_PATH);
    res.writeHead(200, { "Content-Type": "image/svg+xml" });
    res.end(icon);
    return;
  }

  if (req.method === "GET" && route === "/") {
    sendText(res, 200, HTML_PAGE, "text/html; charset=utf-8");
    return;
  }

  const printMatch = route.match(/^\/recipes\/([^/]+)\/print$/);
  if (printMatch && req.method === "GET") {
    const id = decodeURIComponent(printMatch[1]);
    const recipe = (await loadRecipe(id)) ?? (await loadTrashRecipe(id));
    if (!recipe) {
      sendText(res, 404, "Recipe not found", "text/plain; charset=utf-8");
      return;
    }
    const autoPrint = url.searchParams.get("auto") === "1";
    sendText(res, 200, renderPrintPage(recipe, autoPrint), "text/html; charset=utf-8");
    return;
  }

  if ((route === "/api/ping" || route === "/api/ingest") && req.method === "GET") {
    const token = getBearerToken(req);
    if (!token || token !== settings.ingest_token) {
      sendJson(res, 401, { error: "Invalid ingest token" });
      return;
    }
    sendJson(res, 200, { ok: true, app: "wolverineks-recipes", version: APP_VERSION });
    return;
  }

  if (route === "/api/ingest" && req.method === "POST") {
    const token = getBearerToken(req);
    if (!token || token !== settings.ingest_token) {
      sendJson(res, 401, { error: "Invalid ingest token" });
      return;
    }
    try {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      const recipe = await upsertRecipe(body);
      sendJson(res, 200, { ok: true, id: recipe.id, recipe, updated: true });
    } catch (error) {
      if (error instanceof BlockedRecipeError) {
        const entry = await findBlocklistEntryByUrl(error.sourceUrl);
        sendJson(res, 403, blockedRecipeResponse(entry, error.sourceUrl));
        return;
      }
      const message = error instanceof Error ? error.message : "Invalid recipe payload";
      sendJson(res, 400, { error: message });
    }
    return;
  }

  if (route === "/api/import-from-url" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req)) as { source_url?: string };
      const sourceUrl = typeof body.source_url === "string" ? body.source_url.trim() : "";
      if (!sourceUrl) {
        sendJson(res, 400, { error: "source_url is required." });
        return;
      }

      if (await isSourceUrlBlocked(sourceUrl)) {
        const entry = await findBlocklistEntryByUrl(sourceUrl);
        sendJson(res, 403, blockedRecipeResponse(entry, sourceUrl));
        return;
      }

      const apiKey = (settings.extension_api_key ?? "").trim();
      if (!apiKey) {
        sendJson(res, 400, {
          error: "No xAI API key saved. Add one under Setup before importing from a URL.",
        });
        return;
      }

      const extracted = await fetchRecipePage(sourceUrl);
      const formatted = await formatRecipeWithGrok(
        extracted,
        apiKey,
        normalizeExtensionModel(settings.extension_model),
      );
      if (extracted.image_url) {
        formatted.image_url = extracted.image_url;
      }
      const recipe = await upsertRecipe(formatted);
      sendJson(res, 200, { ok: true, id: recipe.id, recipe });
    } catch (error) {
      if (error instanceof BlockedRecipeError) {
        const entry = await findBlocklistEntryByUrl(error.sourceUrl);
        sendJson(res, 403, blockedRecipeResponse(entry, error.sourceUrl));
        return;
      }
      const message = error instanceof Error ? error.message : "Import failed";
      sendJson(res, 400, { error: message });
    }
    return;
  }

  if (route === "/api/backup/status" && req.method === "GET") {
    try {
      const status = await getBackupStatus(DATA_ROOT, BACKUP_ROOT);
      sendJson(res, 200, { ...status, backup_host_path: BACKUP_HOST_PATH });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not read backup status";
      sendJson(res, 500, { error: message });
    }
    return;
  }

  if (route === "/api/backup/export" && req.method === "POST") {
    try {
      const status = await exportRecipesData(DATA_ROOT, BACKUP_ROOT);
      sendJson(res, 200, { ok: true, ...status, backup_host_path: BACKUP_HOST_PATH });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Backup failed";
      sendJson(res, 400, { error: message });
    }
    return;
  }

  if (route === "/api/backup/import" && req.method === "POST") {
    try {
      const status = await importRecipesData(DATA_ROOT, BACKUP_ROOT);
      await reloadSettingsFromDisk();
      sendJson(res, 200, { ok: true, ...status, backup_host_path: BACKUP_HOST_PATH });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Restore failed";
      sendJson(res, 400, { error: message });
    }
    return;
  }

  if (route === "/api/blocklist/check" && req.method === "POST") {
    const token = getBearerToken(req);
    if (!token || token !== settings.ingest_token) {
      sendJson(res, 401, { error: "Invalid ingest token" });
      return;
    }
    try {
      const body = JSON.parse(await readBody(req)) as { source_url?: string };
      const sourceUrl = normalizeSourceUrl(String(body.source_url ?? ""));
      if (!sourceUrl) {
        sendJson(res, 400, { error: "source_url is required" });
        return;
      }
      const entry = await findBlocklistEntryByUrl(sourceUrl);
      if (entry) {
        sendJson(res, 200, blockedRecipeResponse(entry, sourceUrl));
        return;
      }
      sendJson(res, 200, { blocked: false });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid request" });
    }
    return;
  }

  if (route === "/api/recipes" && req.method === "GET") {
    const index = await loadIndex();
    sendJson(res, 200, { recipes: index });
    return;
  }

  const notesMatch = route.match(/^\/api\/recipes\/([^/]+)\/notes$/);
  if (notesMatch && req.method === "POST") {
    try {
      const id = decodeURIComponent(notesMatch[1]);
      const body = JSON.parse(await readBody(req)) as { notes?: unknown };
      const notes = typeof body.notes === "string" ? body.notes : null;
      const recipe = await updateRecipeNotes(id, notes);
      sendJson(res, 200, { ok: true, recipe: await enrichRecipe(recipe) });
    } catch (error) {
      if (error instanceof NotFoundError) {
        sendJson(res, 404, { error: error.message });
      } else {
        sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid request" });
      }
    }
    return;
  }

  const imageMatch = route.match(/^\/api\/recipes\/([^/]+)\/image$/);
  if (imageMatch && req.method === "GET") {
    const id = decodeURIComponent(imageMatch[1]);
    const imagePath = findRecipeImagePath(id);
    if (!imagePath) {
      sendJson(res, 404, { error: "Image not found" });
      return;
    }
    const ext = path.extname(imagePath).toLowerCase();
    const contentType = IMAGE_MIME_TYPES[ext] || "application/octet-stream";
    const image = await readFile(imagePath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": image.length,
      "Cache-Control": "public, max-age=86400",
    });
    res.end(image);
    return;
  }

  if (route.startsWith("/api/recipes/") && req.method === "GET") {
    const id = decodeURIComponent(route.slice("/api/recipes/".length));
    const recipe = await loadRecipe(id);
    if (!recipe) {
      sendJson(res, 404, { error: "Recipe not found" });
      return;
    }
    sendJson(res, 200, await enrichRecipe(recipe));
    return;
  }

  const blockRecipeMatch = route.match(/^\/api\/recipes\/([^/]+)\/block$/);
  if (blockRecipeMatch && req.method === "POST") {
    const id = decodeURIComponent(blockRecipeMatch[1]);
    const moved = await moveRecipeToBlocklist(id);
    if (!moved) {
      sendJson(res, 404, { error: "Recipe not found" });
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (route.startsWith("/api/recipes/") && req.method === "DELETE") {
    const id = decodeURIComponent(route.slice("/api/recipes/".length));
    const moved = await moveRecipeToTrash(id);
    if (!moved) {
      sendJson(res, 404, { error: "Recipe not found" });
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (route === "/api/blocklist" && req.method === "GET") {
    sendJson(res, 200, { recipes: await loadBlocklistIndex() });
    return;
  }

  const blocklistImageMatch = route.match(/^\/api\/blocklist\/([^/]+)\/image$/);
  if (blocklistImageMatch && req.method === "GET") {
    const id = decodeURIComponent(blocklistImageMatch[1]);
    const imagePath = findBlocklistImagePath(id);
    if (!imagePath) {
      sendJson(res, 404, { error: "Image not found" });
      return;
    }
    const ext = path.extname(imagePath).toLowerCase();
    const contentType = IMAGE_MIME_TYPES[ext] || "application/octet-stream";
    const image = await readFile(imagePath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": image.length,
      "Cache-Control": "public, max-age=86400",
    });
    res.end(image);
    return;
  }

  const blocklistRecipeMatch = route.match(/^\/api\/blocklist\/([^/]+)$/);
  if (blocklistRecipeMatch && req.method === "GET") {
    const id = decodeURIComponent(blocklistRecipeMatch[1]);
    const blocklistIndex = await loadBlocklistIndex();
    const entry = blocklistIndex.find((item) => item.id === id);
    if (!entry) {
      sendJson(res, 404, { error: "Recipe not found in blocklist" });
      return;
    }
    const recipe = await loadBlocklistRecipe(id);
    if (!recipe) {
      sendJson(res, 404, { error: "Recipe not found in blocklist" });
      return;
    }
    sendJson(res, 200, await enrichBlocklistRecipe(recipe, entry));
    return;
  }

  if (route === "/api/blocklist/unblock" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req)) as { id?: string };
      const id = (body.id ?? "").trim();
      if (!id) {
        sendJson(res, 400, { error: "id is required" });
        return;
      }
      const recipe = await restoreRecipeFromBlocklist(id);
      sendJson(res, 200, { ok: true, recipe });
    } catch (error) {
      if (error instanceof NotFoundError) {
        sendJson(res, 404, { error: error.message });
      } else {
        sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid request" });
      }
    }
    return;
  }

  if (route === "/api/blocklist/delete" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req)) as { id?: string };
      const id = (body.id ?? "").trim();
      if (!id) {
        sendJson(res, 400, { error: "id is required" });
        return;
      }
      const deleted = await permanentlyDeleteBlocklistRecipe(id);
      if (!deleted) {
        sendJson(res, 404, { error: "Recipe not found in blocklist" });
        return;
      }
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid request" });
    }
    return;
  }

  if (route === "/api/blocklist/empty" && req.method === "POST") {
    const count = await emptyBlocklist();
    sendJson(res, 200, { ok: true, count });
    return;
  }

  if (route === "/api/trash" && req.method === "GET") {
    sendJson(res, 200, { recipes: await loadTrashIndex() });
    return;
  }

  const trashImageMatch = route.match(/^\/api\/trash\/([^/]+)\/image$/);
  if (trashImageMatch && req.method === "GET") {
    const id = decodeURIComponent(trashImageMatch[1]);
    const imagePath = findTrashImagePath(id);
    if (!imagePath) {
      sendJson(res, 404, { error: "Image not found" });
      return;
    }
    const ext = path.extname(imagePath).toLowerCase();
    const contentType = IMAGE_MIME_TYPES[ext] || "application/octet-stream";
    const image = await readFile(imagePath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": image.length,
      "Cache-Control": "public, max-age=86400",
    });
    res.end(image);
    return;
  }

  const trashRecipeMatch = route.match(/^\/api\/trash\/([^/]+)$/);
  if (trashRecipeMatch && req.method === "GET") {
    const id = decodeURIComponent(trashRecipeMatch[1]);
    const trashIndex = await loadTrashIndex();
    const entry = trashIndex.find((item) => item.id === id);
    if (!entry) {
      sendJson(res, 404, { error: "Recipe not found in trash" });
      return;
    }
    const recipe = await loadTrashRecipe(id);
    if (!recipe) {
      sendJson(res, 404, { error: "Recipe not found in trash" });
      return;
    }
    sendJson(res, 200, await enrichTrashRecipe(recipe, entry));
    return;
  }

  if (route === "/api/trash/restore" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req)) as { id?: string };
      const id = (body.id ?? "").trim();
      if (!id) {
        sendJson(res, 400, { error: "id is required" });
        return;
      }
      const recipe = await restoreRecipeFromTrash(id);
      sendJson(res, 200, { ok: true, recipe });
    } catch (error) {
      if (error instanceof NotFoundError) {
        sendJson(res, 404, { error: error.message });
      } else {
        sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid request" });
      }
    }
    return;
  }

  if (route === "/api/trash/delete" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req)) as { id?: string };
      const id = (body.id ?? "").trim();
      if (!id) {
        sendJson(res, 400, { error: "id is required" });
        return;
      }
      const deleted = await permanentlyDeleteTrashRecipe(id);
      if (!deleted) {
        sendJson(res, 404, { error: "Recipe not found in trash" });
        return;
      }
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid request" });
    }
    return;
  }

  if (route === "/api/trash/empty" && req.method === "POST") {
    const count = await emptyTrash();
    sendJson(res, 200, { ok: true, count });
    return;
  }

  if (route === "/api/settings/token" && req.method === "GET") {
    sendJson(res, 200, { ingest_token: settings.ingest_token });
    return;
  }

  if (route === "/api/settings/extension" && req.method === "GET") {
    sendJson(res, 200, extensionSettingsPayload(settings));
    return;
  }

  if (route === "/api/settings/extension" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req)) as {
        api_key?: string;
        model?: string;
        clear_api_key?: boolean;
      };
      const hasApiKeyField = typeof body.api_key === "string" && body.api_key.trim();
      const hasModelField = typeof body.model === "string";
      if (!hasApiKeyField && !hasModelField && !body.clear_api_key) {
        sendJson(res, 400, { error: "Provide an API key, model, or clear_api_key." });
        return;
      }
      const next = await saveExtensionSettings(body);
      sendJson(res, 200, extensionSettingsPayload(next));
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid request" });
    }
    return;
  }

  if (route === "/api/settings/extension-config" && req.method === "GET") {
    const token = getBearerToken(req);
    if (!token || token !== settings.ingest_token) {
      sendJson(res, 401, { error: "Invalid ingest token" });
      return;
    }
    const apiKey = (settings.extension_api_key ?? "").trim();
    if (!apiKey) {
      sendJson(res, 404, {
        error: "Extension API key is not configured in the Recipes app.",
      });
      return;
    }
    sendJson(res, 200, {
      api_key: apiKey,
      model: normalizeExtensionModel(settings.extension_model),
    });
    return;
  }

  if (route === "/api/settings/regenerate-token" && req.method === "POST") {
    const current = await loadSettings();
    const next: Settings = {
      ...current,
      ingest_token: randomBytes(32).toString("hex"),
    };
    const saved = await persistSettings(next);
    sendJson(res, 200, { ingest_token: saved.ingest_token });
    return;
  }

  if (route === "/api/categories" && req.method === "GET") {
    sendJson(res, 200, { categories: await loadCategories() });
    return;
  }

  if (route === "/api/categories/create" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req)) as { name?: string };
      const name = (body.name ?? "").trim();
      if (!name) {
        sendJson(res, 400, { error: "name is required" });
        return;
      }
      const category = await createCategory(name);
      sendJson(res, 201, { category });
    } catch (error) {
      if (error instanceof Error && error.message === "category already exists") {
        sendJson(res, 409, { error: error.message });
      } else if (error instanceof Error && error.message === "invalid name") {
        sendJson(res, 400, { error: error.message });
      } else {
        sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid request" });
      }
    }
    return;
  }

  if (route === "/api/categories/rename" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req)) as { id?: string; name?: string };
      const id = (body.id ?? "").trim();
      const name = (body.name ?? "").trim();
      if (!id) {
        sendJson(res, 400, { error: "id is required" });
        return;
      }
      if (!name) {
        sendJson(res, 400, { error: "name is required" });
        return;
      }
      const category = await renameCategory(id, name);
      sendJson(res, 200, { category });
    } catch (error) {
      if (error instanceof NotFoundError) {
        sendJson(res, 404, { error: "category not found" });
      } else if (error instanceof Error && error.message === "category already exists") {
        sendJson(res, 409, { error: error.message });
      } else if (error instanceof Error && error.message === "invalid name") {
        sendJson(res, 400, { error: error.message });
      } else {
        sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid request" });
      }
    }
    return;
  }

  if (route === "/api/categories/delete" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req)) as { id?: string };
      const id = (body.id ?? "").trim();
      if (!id) {
        sendJson(res, 400, { error: "id is required" });
        return;
      }
      await deleteCategory(id);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      if (error instanceof NotFoundError) {
        sendJson(res, 404, { error: "category not found" });
      } else {
        sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid request" });
      }
    }
    return;
  }

  if (route === "/api/categories/assign" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req)) as { recipe_id?: string; categoryId?: string };
      const recipeId = (body.recipe_id ?? "").trim();
      const categoryId = (body.categoryId ?? "").trim();
      if (!recipeId) {
        sendJson(res, 400, { error: "recipe_id is required" });
        return;
      }
      if (!categoryId) {
        sendJson(res, 400, { error: "categoryId is required" });
        return;
      }
      const item = await assignCategoryRecipe(recipeId, categoryId);
      sendJson(res, 200, { item });
    } catch (error) {
      if (error instanceof NotFoundError) {
        sendJson(res, 404, { error: error.message });
      } else {
        sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid request" });
      }
    }
    return;
  }

  if (route === "/api/categories/unassign" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req)) as { recipe_id?: string; categoryId?: string };
      const recipeId = (body.recipe_id ?? "").trim();
      const categoryId = (body.categoryId ?? "").trim();
      if (!recipeId) {
        sendJson(res, 400, { error: "recipe_id is required" });
        return;
      }
      if (!categoryId) {
        sendJson(res, 400, { error: "categoryId is required" });
        return;
      }
      await unassignCategoryRecipe(recipeId, categoryId);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      if (error instanceof NotFoundError) {
        sendJson(res, 404, { error: error.message });
      } else {
        sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid request" });
      }
    }
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

async function main(): Promise<void> {
  await ensureDataDirs();
  await loadSettings();
  const removed = await reconcileLibraryData(DATA_ROOT);
  if (removed > 0) console.log(`Reconciled library index and removed ${removed} duplicate recipe(s).`);
  await seedDefaultRecipes();
  await seedDefaultRecipeImages();
  const server = createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      console.error(error);
      sendJson(res, 500, { error: "Internal server error" });
    });
  });
  const port = Number(process.env.PORT ?? 3000);
  server.listen(port, "0.0.0.0", () => {
    console.log(`wolverineks-recipes v${APP_VERSION} listening on ${port}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});