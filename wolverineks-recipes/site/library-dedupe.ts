import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
const TRACKING_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
];

export type IndexEntry = {
  id: string;
  title: string;
  source_url: string;
  created_at: string;
  updated_at: string;
};

type RecipeRecord = IndexEntry & {
  ingredients?: string[];
};

type CategoryItem = {
  recipe_id: string;
  category_id: string;
};

type DedupeResult = {
  kept: IndexEntry[];
  removedIds: Set<string>;
  idRemap: Map<string, string>;
};

export function canonicalSourceUrl(sourceUrl: string): string {
  const trimmed = sourceUrl.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("urn:")) return trimmed;

  try {
    const url = new URL(trimmed);
    url.hash = "";
    for (const param of TRACKING_PARAMS) url.searchParams.delete(param);
    url.hostname = url.hostname.toLowerCase();
    if (url.hostname.startsWith("www.")) url.hostname = url.hostname.slice(4);
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.slice(0, -1);
    }
    if (url.protocol === "http:") url.protocol = "https:";
    const query = url.searchParams.toString();
    url.search = query ? `?${query}` : "";
    return url.toString();
  } catch {
    return trimmed.toLowerCase();
  }
}

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

function entryTimestamp(entry: IndexEntry): number {
  const value = new Date(entry.updated_at).getTime();
  return Number.isFinite(value) ? value : 0;
}

function pickNewerEntry(a: IndexEntry, b: IndexEntry): IndexEntry {
  return entryTimestamp(a) >= entryTimestamp(b) ? a : b;
}

export function recipeDedupeKey(recipe: Pick<RecipeRecord, "id" | "title" | "source_url" | "ingredients">): string {
  const canonical = canonicalSourceUrl(recipe.source_url);
  if (canonical) return `url:${canonical}`;

  const title = normalizeTitle(recipe.title);
  const ingredients = (recipe.ingredients || [])
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join("\n");
  if (title && ingredients) return `content:${title}\n${ingredients}`;
  if (title) return `title:${title}`;
  return `id:${recipe.id}`;
}

export function dedupeIndexEntries(entries: IndexEntry[], recipesById: Map<string, RecipeRecord>): DedupeResult {
  const byId = new Map<string, IndexEntry>();
  for (const entry of entries) {
    if (!entry?.id) continue;
    const previous = byId.get(entry.id);
    byId.set(entry.id, previous ? pickNewerEntry(previous, entry) : entry);
  }

  const byKey = new Map<string, IndexEntry>();
  for (const entry of byId.values()) {
    const recipe = recipesById.get(entry.id) ?? entry;
    const key = recipeDedupeKey(recipe);
    const previous = byKey.get(key);
    byKey.set(key, previous ? pickNewerEntry(previous, entry) : entry);
  }

  const kept = [...byKey.values()].sort((a, b) => entryTimestamp(b) - entryTimestamp(a));
  const keptIds = new Set(kept.map((entry) => entry.id));
  const removedIds = new Set<string>();
  const idRemap = new Map<string, string>();

  for (const entry of byId.values()) {
    if (keptIds.has(entry.id)) continue;
    removedIds.add(entry.id);
    const recipe = recipesById.get(entry.id) ?? entry;
    const replacement = byKey.get(recipeDedupeKey(recipe));
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
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
}

async function readRecipesFromDir(recipesDir: string): Promise<RecipeRecord[]> {
  if (!existsSync(recipesDir)) return [];
  const files = await readdir(recipesDir);
  const recipes: RecipeRecord[] = [];

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = await readFile(path.join(recipesDir, file), "utf8");
      const recipe = JSON.parse(raw) as RecipeRecord;
      if (recipe?.id) recipes.push(recipe);
    } catch {
      // Skip invalid recipe files.
    }
  }

  return recipes;
}

function recipesById(recipes: RecipeRecord[]): Map<string, RecipeRecord> {
  return new Map(recipes.map((recipe) => [recipe.id, recipe]));
}

function indexEntryFromRecipe(recipe: RecipeRecord): IndexEntry {
  return {
    id: recipe.id,
    title: recipe.title,
    source_url: recipe.source_url,
    created_at: recipe.created_at,
    updated_at: recipe.updated_at,
  };
}

async function removeRecipeFiles(recipesDir: string, imagesDir: string, recipeIds: Set<string>): Promise<void> {
  for (const id of recipeIds) {
    await rm(path.join(recipesDir, `${id}.json`), { force: true });
    for (const ext of IMAGE_EXTENSIONS) {
      await rm(path.join(imagesDir, `${id}${ext}`), { force: true });
    }
  }
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

export async function reconcileRecipeStore(
  indexPath: string,
  recipesDir: string,
  imagesDir: string,
): Promise<DedupeResult> {
  const recipes = await readRecipesFromDir(recipesDir);
  const recipeMap = recipesById(recipes);
  const result = dedupeIndexEntries(recipes.map(indexEntryFromRecipe), recipeMap);

  const keptIds = new Set(result.kept.map((entry) => entry.id));
  const orphanIds = new Set<string>();
  for (const recipe of recipes) {
    if (!keptIds.has(recipe.id)) orphanIds.add(recipe.id);
  }
  for (const id of result.removedIds) orphanIds.add(id);

  if (orphanIds.size > 0) {
    await removeRecipeFiles(recipesDir, imagesDir, orphanIds);
  }

  if (recipes.length > 0 || existsSync(indexPath) || result.kept.length > 0) {
    await writeJsonArray(indexPath, result.kept);
  }

  return result;
}

export async function reconcileLibraryData(dataDir: string): Promise<number> {
  const library = await reconcileRecipeStore(
    path.join(dataDir, "index.json"),
    path.join(dataDir, "recipes"),
    path.join(dataDir, "images"),
  );

  await reconcileRecipeStore(
    path.join(dataDir, ".trash", "index.json"),
    path.join(dataDir, ".trash", "recipes"),
    path.join(dataDir, ".trash", "images"),
  );

  await reconcileRecipeStore(
    path.join(dataDir, ".blocklist", "index.json"),
    path.join(dataDir, ".blocklist", "recipes"),
    path.join(dataDir, ".blocklist", "images"),
  );

  await remapCategoryItems(dataDir, library.idRemap, library.removedIds);
  return library.removedIds.size;
}

export function countDedupedRecipes(entries: IndexEntry[], recipesByIdMap: Map<string, RecipeRecord>): number {
  return dedupeIndexEntries(entries, recipesByIdMap).kept.length;
}