import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const APP_VERSION = "1.0.32";
const DATA_ROOT = process.env.STORICH_DATA_DIR ?? "/data";
const ICON_PATH = path.join(__dirname, "icon.svg");
const PWA_ICONS: Record<string, { file: string; type: string }> = {
  "/apple-touch-icon.png": { file: "apple-touch-icon.png", type: "image/png" },
  "/icon-192.png": { file: "icon-192.png", type: "image/png" },
  "/icon-512.png": { file: "icon-512.png", type: "image/png" },
};
const TRASH_DIR = path.join(DATA_ROOT, ".trash");
const TRASH_ITEMS_DIR = path.join(TRASH_DIR, "items");
const TRASH_INDEX_PATH = path.join(TRASH_DIR, "index.json");
const IMPORTANT_INDEX_PATH = path.join(DATA_ROOT, ".important.json");
const LEGACY_STARS_INDEX_PATH = path.join(DATA_ROOT, ".stars.json");
const PINNED_INDEX_PATH = path.join(DATA_ROOT, ".pinned.json");
const CATEGORIES_INDEX_PATH = path.join(DATA_ROOT, ".categories.json");
const CATEGORY_ITEMS_INDEX_PATH = path.join(DATA_ROOT, ".category-items.json");

type FileEntry = {
  name: string;
  path: string;
  type: "folder" | "file";
  size: number | null;
  modified: string;
};

type TrashItem = {
  id: string;
  name: string;
  originalPath: string;
  type: "folder" | "file";
  deletedAt: string;
  storageName: string;
};

type DirectoryListing = {
  path: string;
  entries: FileEntry[];
};

type TrashListing = {
  entries: Array<
    FileEntry & {
      id: string;
      originalPath: string;
      deletedAt: string;
    }
  >;
};

type ImportantItem = {
  path: string;
  markedAt: string;
};

type ImportantEntry = FileEntry & {
  important: true;
  markedAt: string;
};

type ImportantListing = {
  entries: ImportantEntry[];
  importantPaths: string[];
};

type PinnedItem = {
  path: string;
  pinnedAt: string;
};

type PinnedEntry = FileEntry & {
  pinned: true;
  pinnedAt: string;
};

type PinnedListing = {
  entries: PinnedEntry[];
  pinnedPaths: string[];
};

type Category = {
  id: string;
  name: string;
  createdAt: string;
};

type CategoryItem = {
  path: string;
  categoryId: string;
  addedAt: string;
};

type CategoryListing = {
  categories: Category[];
};

type CategoryItemEntry = FileEntry & {
  categoryId: string;
  addedAt: string;
  categoryIds: string[];
};

type CategoryItemsListing = {
  category: Category;
  entries: CategoryItemEntry[];
  categoryIds: string[];
};

async function ensureDataRoot(): Promise<void> {
  if (existsSync(DATA_ROOT)) {
    return;
  }
  try {
    await mkdir(DATA_ROOT, { recursive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot access data directory ${DATA_ROOT}: ${message}`);
  }
}

function validateEntryName(name: string): string | null {
  if (!name || name === "." || name === "..") {
    return "invalid name";
  }
  if (name.includes("/") || name.includes("\\")) {
    return "invalid name";
  }
  if (name.includes("\0") || /[\u0000-\u001f\u007f]/.test(name)) {
    return "invalid name";
  }
  return null;
}

function safePath(relativePath = ""): { absPath: string; relPath: string } {
  const normalized = relativePath.trim().replace(/\\/g, "/").replace(/^\//, "");
  const root = path.resolve(DATA_ROOT);
  const absPath = path.resolve(root, normalized);
  if (absPath !== root && !absPath.startsWith(root + path.sep)) {
    throw new Error("invalid path");
  }
  return { absPath, relPath: normalized };
}

async function fileEntry(absPath: string, relPath: string): Promise<FileEntry> {
  const fileStat = await stat(absPath);
  const isDir = fileStat.isDirectory();
  return {
    name: path.basename(absPath),
    path: relPath.replace(/\\/g, "/"),
    type: isDir ? "folder" : "file",
    size: isDir ? null : fileStat.size,
    modified: new Date(fileStat.mtimeMs).toISOString(),
  };
}

async function listDirectory(relativePath = ""): Promise<DirectoryListing> {
  const { absPath, relPath } = safePath(relativePath);
  const fileStat = await stat(absPath);
  if (!fileStat.isDirectory()) {
    throw new FileNotFoundError("folder not found");
  }

  const names = await readdir(absPath);
  const entries: FileEntry[] = [];
  for (const name of names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))) {
    if (name.startsWith(".")) {
      continue;
    }
    const childRel = relPath ? `${relPath}/${name}` : name;
    entries.push(await fileEntry(path.join(absPath, name), childRel));
  }

  entries.sort((a, b) => {
    const aIsFolder = a.type === "folder" ? 0 : 1;
    const bIsFolder = b.type === "folder" ? 0 : 1;
    if (aIsFolder !== bIsFolder) {
      return aIsFolder - bIsFolder;
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  return { path: relPath, entries };
}

function parseMarkedItems(raw: string): Array<{ path: string; markedAt: string }> {
  const parsed = JSON.parse(raw) as { items?: Array<{ path: string; markedAt?: string; starredAt?: string }> };
  if (!Array.isArray(parsed.items)) {
    return [];
  }
  return parsed.items.map((item) => ({
    path: item.path,
    markedAt: item.markedAt || item.starredAt || new Date().toISOString(),
  }));
}

function remapMarkedPaths<T extends { path: string }>(items: T[], oldPath: string, newPath: string): T[] {
  const oldNorm = oldPath.replace(/\\/g, "/");
  const newNorm = newPath.replace(/\\/g, "/");
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    let nextPath = item.path;
    if (nextPath === oldNorm) {
      nextPath = newNorm;
    } else if (nextPath.startsWith(`${oldNorm}/`)) {
      nextPath = newNorm + nextPath.slice(oldNorm.length);
    }
    if (seen.has(nextPath)) {
      continue;
    }
    seen.add(nextPath);
    result.push(nextPath === item.path ? item : { ...item, path: nextPath });
  }
  return result;
}

async function readImportantIndex(): Promise<ImportantItem[]> {
  if (existsSync(IMPORTANT_INDEX_PATH)) {
    try {
      const raw = await readFile(IMPORTANT_INDEX_PATH, "utf8");
      return parseMarkedItems(raw);
    } catch {
      return [];
    }
  }
  if (existsSync(LEGACY_STARS_INDEX_PATH)) {
    try {
      const raw = await readFile(LEGACY_STARS_INDEX_PATH, "utf8");
      const items = parseMarkedItems(raw);
      await writeImportantIndex(items);
      return items;
    } catch {
      return [];
    }
  }
  return [];
}

async function writeImportantIndex(items: ImportantItem[]): Promise<void> {
  await writeFile(IMPORTANT_INDEX_PATH, JSON.stringify({ items }, null, 2));
}

async function readPinnedIndex(): Promise<PinnedItem[]> {
  if (!existsSync(PINNED_INDEX_PATH)) {
    return [];
  }
  try {
    const raw = await readFile(PINNED_INDEX_PATH, "utf8");
    const parsed = JSON.parse(raw) as { items?: PinnedItem[] };
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

async function writePinnedIndex(items: PinnedItem[]): Promise<void> {
  await writeFile(PINNED_INDEX_PATH, JSON.stringify({ items }, null, 2));
}

async function updateImportantPaths(oldPath: string, newPath: string): Promise<void> {
  const items = await readImportantIndex();
  const updated = remapMarkedPaths(items, oldPath, newPath);
  if (updated.length !== items.length || updated.some((item, index) => item.path !== items[index]?.path)) {
    await writeImportantIndex(updated);
  }
}

async function updatePinnedPaths(oldPath: string, newPath: string): Promise<void> {
  const items = await readPinnedIndex();
  const updated = remapMarkedPaths(items, oldPath, newPath);
  if (updated.length !== items.length || updated.some((item, index) => item.path !== items[index]?.path)) {
    await writePinnedIndex(updated);
  }
}

async function removeImportantForPath(relPath: string): Promise<void> {
  const normalized = relPath.replace(/\\/g, "/");
  const items = await readImportantIndex();
  const next = items.filter((item) => item.path !== normalized && !item.path.startsWith(`${normalized}/`));
  if (next.length !== items.length) {
    await writeImportantIndex(next);
  }
}

async function removePinnedForPath(relPath: string): Promise<void> {
  const normalized = relPath.replace(/\\/g, "/");
  const items = await readPinnedIndex();
  const next = items.filter((item) => item.path !== normalized && !item.path.startsWith(`${normalized}/`));
  if (next.length !== items.length) {
    await writePinnedIndex(next);
  }
}

async function markImportantEntry(relPath: string): Promise<ImportantItem> {
  const { relPath: normalized } = safePath(relPath);
  if (isProtectedPath(normalized)) {
    throw new Error("invalid path");
  }
  const { absPath } = safePath(normalized);
  await stat(absPath);

  const items = await readImportantIndex();
  const existing = items.find((item) => item.path === normalized);
  if (existing) {
    return existing;
  }

  const item: ImportantItem = {
    path: normalized,
    markedAt: new Date().toISOString(),
  };
  items.unshift(item);
  await writeImportantIndex(items);
  return item;
}

async function unmarkImportantEntry(relPath: string): Promise<void> {
  const { relPath: normalized } = safePath(relPath);
  const items = await readImportantIndex();
  const next = items.filter((item) => item.path !== normalized);
  if (next.length === items.length) {
    throw new FileNotFoundError("important marker not found");
  }
  await writeImportantIndex(next);
}

async function pinEntry(relPath: string): Promise<PinnedItem> {
  const { relPath: normalized } = safePath(relPath);
  if (isProtectedPath(normalized)) {
    throw new Error("invalid path");
  }
  const { absPath } = safePath(normalized);
  await stat(absPath);

  const items = await readPinnedIndex();
  const existing = items.find((item) => item.path === normalized);
  if (existing) {
    return existing;
  }

  const item: PinnedItem = {
    path: normalized,
    pinnedAt: new Date().toISOString(),
  };
  items.unshift(item);
  await writePinnedIndex(items);
  return item;
}

async function unpinEntry(relPath: string): Promise<void> {
  const { relPath: normalized } = safePath(relPath);
  const items = await readPinnedIndex();
  const next = items.filter((item) => item.path !== normalized);
  if (next.length === items.length) {
    throw new FileNotFoundError("pin not found");
  }
  await writePinnedIndex(next);
}

async function listDirectoryWithMarkers(
  relativePath = "",
): Promise<
  DirectoryListing & {
    entries: Array<FileEntry & { important: boolean; pinned: boolean; categoryIds: string[] }>;
    importantPaths: string[];
    pinnedPaths: string[];
    categories: Category[];
  }
> {
  const listing = await listDirectory(relativePath);
  const importantItems = await readImportantIndex();
  const pinnedItems = await readPinnedIndex();
  const categoryItems = await readCategoryItemsIndex();
  const categories = (await readCategoriesIndex()).sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
  const important = new Set(importantItems.map((item) => item.path));
  const pinned = new Set(pinnedItems.map((item) => item.path));
  return {
    ...listing,
    entries: listing.entries.map((entry) => ({
      ...entry,
      important: important.has(entry.path),
      pinned: pinned.has(entry.path),
      categoryIds: categoryIdsForPath(categoryItems, entry.path),
    })),
    importantPaths: importantItems.map((item) => item.path),
    pinnedPaths: pinnedItems.map((item) => item.path),
    categories,
  };
}

async function listImportant(): Promise<ImportantListing> {
  const items = await readImportantIndex();
  const entries: ImportantEntry[] = [];
  const stale: string[] = [];

  for (const item of items) {
    try {
      const { absPath } = safePath(item.path);
      if (!existsSync(absPath)) {
        stale.push(item.path);
        continue;
      }
      const entry = await fileEntry(absPath, item.path);
      entries.push({
        ...entry,
        important: true,
        markedAt: item.markedAt,
      });
    } catch {
      stale.push(item.path);
    }
  }

  if (stale.length) {
    const next = items.filter((item) => !stale.includes(item.path));
    await writeImportantIndex(next);
  }

  entries.sort((a, b) => new Date(b.markedAt).getTime() - new Date(a.markedAt).getTime());
  return { entries, importantPaths: entries.map((entry) => entry.path) };
}

async function listPinned(): Promise<PinnedListing> {
  const items = await readPinnedIndex();
  const entries: PinnedEntry[] = [];
  const stale: string[] = [];

  for (const item of items) {
    try {
      const { absPath } = safePath(item.path);
      if (!existsSync(absPath)) {
        stale.push(item.path);
        continue;
      }
      const entry = await fileEntry(absPath, item.path);
      entries.push({
        ...entry,
        pinned: true,
        pinnedAt: item.pinnedAt,
      });
    } catch {
      stale.push(item.path);
    }
  }

  if (stale.length) {
    const next = items.filter((item) => !stale.includes(item.path));
    await writePinnedIndex(next);
  }

  entries.sort((a, b) => new Date(b.pinnedAt).getTime() - new Date(a.pinnedAt).getTime());
  return { entries, pinnedPaths: entries.map((entry) => entry.path) };
}

async function readCategoriesIndex(): Promise<Category[]> {
  if (!existsSync(CATEGORIES_INDEX_PATH)) {
    return [];
  }
  try {
    const raw = await readFile(CATEGORIES_INDEX_PATH, "utf8");
    const parsed = JSON.parse(raw) as { categories?: Category[] };
    return Array.isArray(parsed.categories) ? parsed.categories : [];
  } catch {
    return [];
  }
}

async function writeCategoriesIndex(categories: Category[]): Promise<void> {
  await writeFile(CATEGORIES_INDEX_PATH, JSON.stringify({ categories }, null, 2));
}

async function readCategoryItemsIndex(): Promise<CategoryItem[]> {
  if (!existsSync(CATEGORY_ITEMS_INDEX_PATH)) {
    return [];
  }
  try {
    const raw = await readFile(CATEGORY_ITEMS_INDEX_PATH, "utf8");
    const parsed = JSON.parse(raw) as { items?: CategoryItem[] };
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

async function writeCategoryItemsIndex(items: CategoryItem[]): Promise<void> {
  await writeFile(CATEGORY_ITEMS_INDEX_PATH, JSON.stringify({ items }, null, 2));
}

function categoryNameTaken(categories: Category[], name: string, exceptId?: string): boolean {
  const lower = name.trim().toLowerCase();
  return categories.some((category) => category.id !== exceptId && category.name.toLowerCase() === lower);
}

function categoryIdsForPath(items: CategoryItem[], relPath: string): string[] {
  const normalized = relPath.replace(/\\/g, "/");
  const ids = items.filter((item) => item.path === normalized).map((item) => item.categoryId);
  return [...new Set(ids)];
}

async function listCategories(): Promise<CategoryListing> {
  const categories = await readCategoriesIndex();
  categories.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return { categories };
}

async function createCategory(name: string): Promise<Category> {
  const trimmedName = name.trim();
  const nameError = validateEntryName(trimmedName);
  if (nameError) {
    throw new Error("invalid name");
  }
  const categories = await readCategoriesIndex();
  if (categoryNameTaken(categories, trimmedName)) {
    throw new Error("category already exists");
  }
  const category: Category = {
    id: createTrashId(),
    name: trimmedName,
    createdAt: new Date().toISOString(),
  };
  categories.push(category);
  categories.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  await writeCategoriesIndex(categories);
  return category;
}

async function renameCategory(categoryId: string, name: string): Promise<Category> {
  const trimmedName = name.trim();
  const nameError = validateEntryName(trimmedName);
  if (nameError) {
    throw new Error("invalid name");
  }
  const categories = await readCategoriesIndex();
  const index = categories.findIndex((category) => category.id === categoryId);
  if (index === -1) {
    throw new FileNotFoundError("category not found");
  }
  if (categoryNameTaken(categories, trimmedName, categoryId)) {
    throw new Error("category already exists");
  }
  const category = { ...categories[index], name: trimmedName };
  categories[index] = category;
  categories.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  await writeCategoriesIndex(categories);
  return category;
}

async function deleteCategory(categoryId: string): Promise<void> {
  const categories = await readCategoriesIndex();
  const nextCategories = categories.filter((category) => category.id !== categoryId);
  if (nextCategories.length === categories.length) {
    throw new FileNotFoundError("category not found");
  }
  await writeCategoriesIndex(nextCategories);
  const items = await readCategoryItemsIndex();
  const nextItems = items.filter((item) => item.categoryId !== categoryId);
  if (nextItems.length !== items.length) {
    await writeCategoryItemsIndex(nextItems);
  }
}

async function assignCategoryEntry(relPath: string, categoryId: string): Promise<CategoryItem> {
  const { relPath: normalized } = safePath(relPath);
  if (isProtectedPath(normalized)) {
    throw new Error("invalid path");
  }
  const { absPath } = safePath(normalized);
  await stat(absPath);

  const categories = await readCategoriesIndex();
  if (!categories.some((category) => category.id === categoryId)) {
    throw new FileNotFoundError("category not found");
  }

  const items = await readCategoryItemsIndex();
  const existing = items.find((item) => item.path === normalized && item.categoryId === categoryId);
  if (existing) {
    return existing;
  }

  const item: CategoryItem = {
    path: normalized,
    categoryId,
    addedAt: new Date().toISOString(),
  };
  items.unshift(item);
  await writeCategoryItemsIndex(items);
  return item;
}

async function unassignCategoryEntry(relPath: string, categoryId: string): Promise<void> {
  const { relPath: normalized } = safePath(relPath);
  const items = await readCategoryItemsIndex();
  const next = items.filter((item) => !(item.path === normalized && item.categoryId === categoryId));
  if (next.length === items.length) {
    throw new FileNotFoundError("category assignment not found");
  }
  await writeCategoryItemsIndex(next);
}

async function updateCategoryItemPaths(oldPath: string, newPath: string): Promise<void> {
  const items = await readCategoryItemsIndex();
  const updated = remapMarkedPaths(items, oldPath, newPath);
  if (updated.length !== items.length || updated.some((item, index) => item.path !== items[index]?.path)) {
    await writeCategoryItemsIndex(updated);
  }
}

async function removeCategoryItemsForPath(relPath: string): Promise<void> {
  const normalized = relPath.replace(/\\/g, "/");
  const items = await readCategoryItemsIndex();
  const next = items.filter((item) => item.path !== normalized && !item.path.startsWith(`${normalized}/`));
  if (next.length !== items.length) {
    await writeCategoryItemsIndex(next);
  }
}

async function listCategoryItems(categoryId: string): Promise<CategoryItemsListing> {
  const categories = await readCategoriesIndex();
  const category = categories.find((entry) => entry.id === categoryId);
  if (!category) {
    throw new FileNotFoundError("category not found");
  }

  const allItems = await readCategoryItemsIndex();
  const categoryItems = allItems.filter((item) => item.categoryId === categoryId);
  const entries: CategoryItemEntry[] = [];
  const stale: string[] = [];

  for (const item of categoryItems) {
    try {
      const { absPath } = safePath(item.path);
      if (!existsSync(absPath)) {
        stale.push(item.path);
        continue;
      }
      const entry = await fileEntry(absPath, item.path);
      entries.push({
        ...entry,
        categoryId: item.categoryId,
        addedAt: item.addedAt,
        categoryIds: categoryIdsForPath(allItems, item.path),
      });
    } catch {
      stale.push(item.path);
    }
  }

  if (stale.length) {
    const next = allItems.filter((item) => !(item.categoryId === categoryId && stale.includes(item.path)));
    await writeCategoryItemsIndex(next);
  }

  entries.sort((a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime());
  return {
    category,
    entries,
    categoryIds: [categoryId],
  };
}

async function ensureTrashDir(): Promise<void> {
  await mkdir(TRASH_ITEMS_DIR, { recursive: true });
}

async function readTrashIndex(): Promise<TrashItem[]> {
  await ensureTrashDir();
  if (!existsSync(TRASH_INDEX_PATH)) {
    return [];
  }
  try {
    const raw = await readFile(TRASH_INDEX_PATH, "utf8");
    const parsed = JSON.parse(raw) as { items?: TrashItem[] };
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

async function writeTrashIndex(items: TrashItem[]): Promise<void> {
  await ensureTrashDir();
  await writeFile(TRASH_INDEX_PATH, JSON.stringify({ items }, null, 2));
}

function trashStorageName(id: string, name: string): string {
  const safeName = name.replace(/[^\w.\-()+@ ]+/g, "_") || "item";
  return `${id}__${safeName}`;
}

function createTrashId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

async function uniqueSiblingPath(relPath: string, tag: string): Promise<string> {
  const { absPath } = safePath(relPath);
  if (!existsSync(absPath)) {
    return relPath;
  }

  const dir = path.posix.dirname(relPath.replace(/\\/g, "/"));
  const base = path.posix.basename(relPath);
  const ext = path.posix.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;

  for (let index = 1; index < 1000; index += 1) {
    const candidateName = `${stem} (${tag} ${index})${ext}`;
    const candidate = dir && dir !== "." ? `${dir}/${candidateName}` : candidateName;
    const { absPath: candidateAbs } = safePath(candidate);
    if (!existsSync(candidateAbs)) {
      return candidate;
    }
  }

  throw new Error("could not find a free name");
}

async function uniqueRestorePath(relPath: string): Promise<string> {
  return uniqueSiblingPath(relPath, "restored");
}

async function renameEntry(sourcePath: string, newName: string): Promise<FileEntry> {
  const trimmedName = newName.trim();
  const nameError = validateEntryName(trimmedName);
  if (nameError) {
    throw new Error("invalid name");
  }

  const { relPath: sourceRel } = safePath(sourcePath);
  if (isProtectedPath(sourceRel)) {
    throw new Error("invalid path");
  }

  const parent = path.posix.dirname(sourceRel.replace(/\\/g, "/"));
  const normalizedParent = parent === "." ? "" : parent;
  const targetRel = normalizedParent ? `${normalizedParent}/${trimmedName}` : trimmedName;

  const { absPath: sourceAbs } = safePath(sourceRel);
  await stat(sourceAbs);

  if (sourceRel === targetRel) {
    return fileEntry(sourceAbs, sourceRel);
  }

  const { absPath: targetAbs } = safePath(targetRel);
  if (existsSync(targetAbs)) {
    throw new Error("name already exists");
  }

  await mkdir(path.dirname(targetAbs), { recursive: true });
  await rename(sourceAbs, targetAbs);
  await updateImportantPaths(sourceRel, targetRel);
  await updatePinnedPaths(sourceRel, targetRel);
  await updateCategoryItemPaths(sourceRel, targetRel);
  return fileEntry(targetAbs, targetRel);
}

async function moveEntry(sourcePath: string, destinationFolder: string): Promise<FileEntry> {
  const { relPath: sourceRel } = safePath(sourcePath);
  if (isProtectedPath(sourceRel)) {
    throw new Error("invalid path");
  }

  const destFolder = destinationFolder.trim().replace(/\\/g, "/").replace(/^\//, "");
  if (destFolder && isProtectedPath(destFolder)) {
    throw new Error("invalid path");
  }

  if (sourceRel === destFolder) {
    throw new Error("cannot move into itself");
  }
  if (destFolder && (destFolder === sourceRel || destFolder.startsWith(`${sourceRel}/`))) {
    throw new Error("cannot move folder into itself");
  }

  const currentParent = path.posix.dirname(sourceRel.replace(/\\/g, "/"));
  const normalizedParent = currentParent === "." ? "" : currentParent;
  if (normalizedParent === destFolder) {
    throw new Error("item is already in this folder");
  }

  const name = path.basename(sourceRel);
  let targetRel = destFolder ? `${destFolder}/${name}` : name;
  targetRel = await uniqueSiblingPath(targetRel, "moved");

  const { absPath: sourceAbs } = safePath(sourceRel);
  const { absPath: targetAbs } = safePath(targetRel);
  await mkdir(path.dirname(targetAbs), { recursive: true });
  await rename(sourceAbs, targetAbs);
  await updateImportantPaths(sourceRel, targetRel);
  await updatePinnedPaths(sourceRel, targetRel);
  await updateCategoryItemPaths(sourceRel, targetRel);
  return fileEntry(targetAbs, targetRel);
}

function isProtectedPath(relPath: string): boolean {
  const normalized = relPath.trim().replace(/\\/g, "/").replace(/^\//, "");
  if (!normalized) {
    return true;
  }
  return normalized === ".trash" || normalized.startsWith(".trash/");
}

async function moveToTrash(relPath: string): Promise<TrashItem> {
  if (isProtectedPath(relPath)) {
    throw new Error("invalid path");
  }
  const { absPath, relPath: normalized } = safePath(relPath);
  const fileStat = await stat(absPath);
  const isDir = fileStat.isDirectory();
  const name = path.basename(absPath);
  const id = createTrashId();
  const storageName = trashStorageName(id, name);
  const trashAbs = path.join(TRASH_ITEMS_DIR, storageName);

  await ensureTrashDir();
  await rename(absPath, trashAbs);

  const item: TrashItem = {
    id,
    name,
    originalPath: normalized.replace(/\\/g, "/"),
    type: isDir ? "folder" : "file",
    deletedAt: new Date().toISOString(),
    storageName,
  };

  const items = await readTrashIndex();
  items.unshift(item);
  await writeTrashIndex(items);
  await removeImportantForPath(normalized.replace(/\\/g, "/"));
  await removePinnedForPath(normalized.replace(/\\/g, "/"));
  await removeCategoryItemsForPath(normalized.replace(/\\/g, "/"));
  return item;
}

async function listTrash(): Promise<TrashListing> {
  const items = await readTrashIndex();
  const entries: TrashListing["entries"] = [];

  for (const item of items) {
    const absPath = path.join(TRASH_ITEMS_DIR, item.storageName);
    if (!existsSync(absPath)) {
      continue;
    }
    const entry = await fileEntry(absPath, item.id);
    entries.push({
      ...entry,
      name: item.name,
      id: item.id,
      originalPath: item.originalPath,
      deletedAt: item.deletedAt,
    });
  }

  return { entries };
}

async function restoreFromTrash(id: string): Promise<FileEntry> {
  const items = await readTrashIndex();
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) {
    throw new FileNotFoundError("trash item not found");
  }

  const item = items[index];
  const trashAbs = path.join(TRASH_ITEMS_DIR, item.storageName);
  if (!existsSync(trashAbs)) {
    throw new FileNotFoundError("trash item not found");
  }

  const restorePath = await uniqueRestorePath(item.originalPath);
  const { absPath: restoreAbs } = safePath(restorePath);
  await mkdir(path.dirname(restoreAbs), { recursive: true });
  await rename(trashAbs, restoreAbs);

  items.splice(index, 1);
  await writeTrashIndex(items);
  return fileEntry(restoreAbs, restorePath);
}

async function deleteTrashItem(id: string): Promise<void> {
  const items = await readTrashIndex();
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) {
    throw new FileNotFoundError("trash item not found");
  }

  const item = items[index];
  const trashAbs = path.join(TRASH_ITEMS_DIR, item.storageName);
  if (existsSync(trashAbs)) {
    const fileStat = await stat(trashAbs);
    if (fileStat.isDirectory()) {
      await rm(trashAbs, { recursive: true, force: true });
    } else {
      await rm(trashAbs, { force: true });
    }
  }

  items.splice(index, 1);
  await writeTrashIndex(items);
}

async function emptyTrash(): Promise<number> {
  const items = await readTrashIndex();
  for (const item of items) {
    const trashAbs = path.join(TRASH_ITEMS_DIR, item.storageName);
    if (existsSync(trashAbs)) {
      await rm(trashAbs, { recursive: true, force: true });
    }
  }
  await writeTrashIndex([]);
  return items.length;
}

class FileNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileNotFoundError";
  }
}

const PAGE_STYLES = `
:root {
  color-scheme: light;
  --bg: #f8fafc;
  --panel: #ffffff;
  --border: #e2e8f0;
  --text: #0f172a;
  --muted: #64748b;
  --accent: #2563eb;
  --accent-soft: #dbeafe;
  --sidebar: #f1f5f9;
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
  background: linear-gradient(135deg, #2563eb, #7c3aed);
  color: white;
  font-size: 0.95rem;
}
.nav {
  display: grid;
  gap: 0.35rem;
}
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
main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 100vh;
}
.mobile-nav {
  display: none;
}
.search-bar {
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
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0.35rem 0.35rem 0.35rem 1rem;
  color: var(--muted);
}
.search-icon {
  flex-shrink: 0;
  line-height: 1;
}
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
.search-options {
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
.search-options:hover,
.search-options.active {
  background: var(--accent-soft);
  color: var(--accent);
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
.search-option-field {
  display: grid;
  gap: 0.4rem;
  margin-top: 0.75rem;
}
.search-option-field span {
  font-size: 0.85rem;
  color: var(--muted);
  font-weight: 600;
}
.file-filter {
  border: 1px solid var(--border);
  border-radius: 0.65rem;
  padding: 0.65rem 0.85rem;
  font: inherit;
  background: var(--panel);
  color: var(--text);
  cursor: pointer;
  width: 100%;
}
.file-filter:focus {
  outline: 2px solid var(--accent-soft);
  border-color: var(--accent);
}
.toolbar {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
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
#upload-input { display: none; }
.content {
  position: relative;
  padding: 1.25rem;
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.drop-overlay {
  position: absolute;
  inset: 0.75rem;
  display: none;
  place-items: center;
  background: rgba(37, 99, 235, 0.08);
  border: 2px dashed var(--accent);
  border-radius: 1rem;
  pointer-events: none;
  z-index: 5;
}
.content.drop-active .drop-overlay {
  display: grid;
}
.drop-overlay-inner {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 0.9rem;
  padding: 1.25rem 1.5rem;
  text-align: center;
  box-shadow: 0 16px 40px rgba(15, 23, 42, 0.12);
  max-width: 20rem;
}
.drop-overlay-icon {
  font-size: 2rem;
  margin-bottom: 0.5rem;
}
.breadcrumbs {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  align-items: center;
  margin-bottom: 1rem;
  color: var(--muted);
  font-size: 0.95rem;
}
.breadcrumbs button {
  border: 0;
  background: transparent;
  color: var(--accent);
  cursor: pointer;
  font: inherit;
  padding: 0;
  border-radius: 0.35rem;
  max-width: 12rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.breadcrumbs button.crumb.selected,
.breadcrumbs button.crumb.drop-target {
  background: var(--accent-soft);
  border-radius: 0.35rem;
  padding: 0.1rem 0.35rem;
}
.status {
  margin-bottom: 1rem;
  color: var(--muted);
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 0.85rem;
}
.card {
  position: relative;
  min-width: 0;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 0.9rem;
  padding: 1rem;
  min-height: 8.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
  cursor: pointer;
  transition: box-shadow 0.15s ease, transform 0.15s ease;
}
.card:hover {
  box-shadow: 0 10px 24px rgba(15, 23, 42, 0.08);
  transform: translateY(-1px);
}
.card .icon {
  font-size: 1.8rem;
  line-height: 1;
}
.file-icon-badge {
  width: 2.75rem;
  height: 2.75rem;
  border-radius: 0.65rem;
  display: grid;
  place-items: center;
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  flex-shrink: 0;
}
.file-icon-badge.type-folder {
  font-size: 1.45rem;
  background: #dbeafe;
}
.file-icon-badge.type-image { background: #fce7f3; color: #9d174d; }
.file-icon-badge.type-video { background: #ede9fe; color: #5b21b6; }
.file-icon-badge.type-audio { background: #ffedd5; color: #c2410c; }
.file-icon-badge.type-document { background: #dbeafe; color: #1d4ed8; }
.file-icon-badge.type-spreadsheet { background: #dcfce7; color: #166534; }
.file-icon-badge.type-presentation { background: #ffedd5; color: #c2410c; }
.file-icon-badge.type-archive { background: #f3f4f6; color: #374151; }
.file-icon-badge.type-code { background: #e0e7ff; color: #3730a3; }
.file-icon-badge.type-file { background: #f1f5f9; color: #475569; }
.card .name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.card .meta {
  color: var(--muted);
  font-size: 0.85rem;
  margin-top: auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.empty {
  padding: 2rem;
  border: 1px dashed var(--border);
  border-radius: 1rem;
  background: var(--panel);
  color: var(--muted);
  text-align: center;
}
.error {
  color: #b91c1c;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 0.75rem;
  padding: 0.85rem 1rem;
  margin-bottom: 1rem;
}
.context-menu {
  position: fixed;
  z-index: 1000;
  min-width: 11rem;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  box-shadow: 0 16px 40px rgba(15, 23, 42, 0.14);
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
  color: #b91c1c;
}
.context-menu button.danger:hover,
.context-menu button.danger:focus {
  background: #fef2f2;
  color: #991b1b;
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
  box-shadow: 0 16px 40px rgba(15, 23, 42, 0.14);
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
.card.selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}
.card.dragging {
  opacity: 0.45;
}
.card.drop-target,
.breadcrumbs button.crumb.drop-target,
.sidebar-trash.drop-target {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
  background: var(--accent-soft);
}
.sidebar-trash.drop-target {
  color: #b91c1c;
  background: #fef2f2;
}
.sidebar-footer {
  margin-top: auto;
  padding-top: 0.75rem;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
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
  background: #fef2f2;
  color: #b91c1c;
}
.sidebar-trash-icon {
  flex-shrink: 0;
  font-size: 0.95rem;
  line-height: 1;
}
.mobile-trash {
  display: none;
  padding: 0.5rem 1rem 0.75rem;
  background: var(--sidebar);
  border-bottom: 1px solid var(--border);
}
.toolbar-trash {
  display: none;
}
body:not(.view-trash) .topbar {
  display: none;
}
body.view-trash .toolbar-trash {
  display: flex;
}
.card-important {
  position: absolute;
  top: 0.55rem;
  right: 0.55rem;
  color: #ca8a04;
  font-size: 0.95rem;
  line-height: 1;
  pointer-events: none;
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
.pinned-section {
  margin-top: 0.5rem;
}
.sidebar-section-toggle {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  border: 0;
  background: transparent;
  padding: 0 0.75rem 0.5rem;
  font: inherit;
  color: var(--muted);
  cursor: pointer;
  width: 100%;
  text-align: left;
}
.sidebar-section-toggle:hover {
  color: var(--text);
}
.sidebar-section-label {
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.sidebar-section-chevron {
  font-size: 0.7rem;
  line-height: 1;
  transition: transform 0.15s ease;
}
.sidebar-section.collapsed .sidebar-section-chevron {
  transform: rotate(-90deg);
}
.sidebar-section.collapsed .sidebar-section-body {
  display: none;
}
.sidebar-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding-right: 0.75rem;
}
.sidebar-section-header .sidebar-section-toggle {
  flex: 1;
  min-width: 0;
  width: auto;
}
.pinned-list {
  display: grid;
  gap: 0.2rem;
}
.pinned-item {
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
.pinned-item:hover,
.pinned-item.active {
  background: var(--accent-soft);
  color: var(--accent);
}
.pinned-icon {
  flex-shrink: 0;
  font-size: 0.95rem;
  line-height: 1;
}
.pinned-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pinned-item.selected {
  background: var(--accent-soft);
  color: var(--accent);
}
.pinned-empty,
.categories-empty {
  padding: 0.35rem 0.75rem;
  color: var(--muted);
  font-size: 0.85rem;
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
.categories-add:hover {
  background: var(--accent-soft);
}
.categories-list {
  display: grid;
  gap: 0.2rem;
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
.category-item.selected {
  background: var(--accent-soft);
  color: var(--accent);
}
.category-icon {
  flex-shrink: 0;
  font-size: 0.95rem;
  line-height: 1;
}
.category-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card-categories {
  margin-top: 0.2rem;
  color: var(--muted);
  font-size: 0.75rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mobile-pinned,
.mobile-categories {
  display: none;
  width: 100%;
  padding: 0.5rem 1rem 0.75rem;
  background: var(--sidebar);
  border-bottom: 1px solid var(--border);
}
.mobile-pinned .sidebar-section-toggle,
.mobile-categories .sidebar-section-toggle {
  padding-left: 0.25rem;
}
.dialog-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: none;
  place-items: center;
  padding: 1rem;
  z-index: 1100;
}
.dialog-backdrop.open {
  display: grid;
}
.dialog {
  width: min(100%, 24rem);
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 1rem;
  padding: 1.25rem;
  box-shadow: 0 24px 48px rgba(15, 23, 42, 0.18);
}
.dialog h2 {
  margin: 0 0 0.35rem;
  font-size: 1.1rem;
}
.dialog p {
  margin: 0 0 1rem;
  color: var(--muted);
  font-size: 0.95rem;
}
.dialog p strong {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
}
.dialog input {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 0.65rem;
  padding: 0.75rem 0.85rem;
  font: inherit;
  margin-bottom: 1rem;
}
.dialog input:focus {
  outline: 2px solid var(--accent-soft);
  border-color: var(--accent);
}
.rename-field {
  display: flex;
  align-items: stretch;
  gap: 0;
  margin-bottom: 1rem;
}
.rename-field input {
  flex: 1;
  min-width: 0;
  width: auto;
  margin-bottom: 0;
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
}
.rename-field input:only-child {
  border-radius: 0.65rem;
}
.rename-extension {
  display: inline-flex;
  align-items: center;
  padding: 0 0.75rem;
  border: 1px solid var(--border);
  border-left: 0;
  border-radius: 0 0.65rem 0.65rem 0;
  background: var(--bg);
  color: var(--muted);
  font-weight: 600;
  white-space: nowrap;
}
.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}
.preview-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.88);
  display: none;
  place-items: center;
  padding: 1.5rem;
  z-index: 1200;
}
.preview-backdrop.open {
  display: grid;
}
.preview-panel {
  width: min(100%, 56rem);
  max-height: 100%;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  color: white;
}
.preview-header h2 {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.preview-header button {
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  color: white;
  padding: 0.45rem 0.85rem;
  font: inherit;
  cursor: pointer;
}
.preview-header button:hover {
  background: rgba(255, 255, 255, 0.16);
}
.preview-image-wrap {
  display: grid;
  place-items: center;
  overflow: auto;
  border-radius: 0.75rem;
  background: rgba(255, 255, 255, 0.04);
  min-height: 12rem;
  max-height: calc(100vh - 8rem);
  touch-action: pan-y pinch-zoom;
}
.preview-image-wrap img {
  max-width: 100%;
  max-height: calc(100vh - 8rem);
  object-fit: contain;
}
.preview-stage {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 0.75rem;
  align-items: center;
}
.preview-nav {
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  color: white;
  width: 2.75rem;
  height: 2.75rem;
  font-size: 1.6rem;
  line-height: 1;
  cursor: pointer;
  display: grid;
  place-items: center;
  padding: 0;
}
.preview-nav:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.16);
}
.preview-nav:disabled {
  opacity: 0.35;
  cursor: default;
}
.preview-counter {
  text-align: center;
  color: rgba(255, 255, 255, 0.75);
  font-size: 0.9rem;
}
@media (max-width: 800px) {
  body { grid-template-columns: 1fr; }
  aside { display: none; }
  .mobile-nav {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 1rem;
    background: var(--sidebar);
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
  }
  .mobile-brand {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-weight: 700;
    margin-right: auto;
  }
  .mobile-nav button {
    border: 0;
    background: transparent;
    padding: 0.55rem 0.75rem;
    border-radius: 0.65rem;
    font: inherit;
    color: var(--text);
    cursor: pointer;
  }
  .mobile-nav button.active,
  .mobile-nav button:hover {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .sidebar-scroll {
    display: none;
  }
  .mobile-pinned,
  .mobile-categories,
  .mobile-trash {
    display: block;
  }
}
.app-version {
  position: fixed;
  right: 0.85rem;
  bottom: 0.45rem;
  font-size: 0.68rem;
  color: var(--muted);
  opacity: 0.45;
  pointer-events: none;
  user-select: none;
  z-index: 1;
}
@media (display-mode: standalone) {
  body {
    padding-top: env(safe-area-inset-top);
    padding-bottom: env(safe-area-inset-bottom);
  }
  .app-version {
    bottom: calc(0.45rem + env(safe-area-inset-bottom));
  }
}
`;

const SERVICE_WORKER = `
self.addEventListener("install", (event) => {
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
`;

const PAGE_SCRIPT = `
const state = { path: "", query: "", view: "drive", fileFilter: "all", categoryId: "", listing: null, importantPaths: new Set(), pinnedPaths: new Set(), pinnedItems: [], categories: [] };
const menuState = { entry: null, longPress: false, source: "card" };
const DRAG_MIME = "application/x-storich-entry";
const previewState = { images: [], index: 0 };
const previewTouch = { startX: 0, startY: 0, active: false };
let longPressTimer = null;
let dragEntry = null;
let renameEntry = null;
let categoryDialogMode = "create";
let categoryDialogId = null;
let listingRequestId = 0;
const sidebarSections = { pinned: false, categories: false };

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function encodeDataValue(value) {
  return encodeURIComponent(String(value || ""));
}

function decodeDataValue(value) {
  const raw = String(value || "");
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function formatSize(size) {
  if (size === null || size === undefined) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number(size);
  for (let i = 0; i < units.length; i += 1) {
    if (value < 1024 || i === units.length - 1) {
      return \`\${i === 0 ? value : value.toFixed(1)} \${units[i]}\`;
    }
    value /= 1024;
  }
  return \`\${size} B\`;
}

function formatDate(value) {
  return new Date(value).toLocaleString();
}

function loadSidebarSectionState() {
  try {
    const raw = localStorage.getItem("storich-sidebar-sections");
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (typeof saved.pinned === "boolean") sidebarSections.pinned = saved.pinned;
    if (typeof saved.categories === "boolean") sidebarSections.categories = saved.categories;
  } catch {
    // ignore saved state errors
  }
}

function saveSidebarSectionState() {
  try {
    localStorage.setItem("storich-sidebar-sections", JSON.stringify(sidebarSections));
  } catch {
    // ignore saved state errors
  }
}

function applySidebarSectionState() {
  for (const section of ["pinned", "categories"]) {
    const collapsed = sidebarSections[section];
    document.querySelectorAll(\`[data-section="\${section}"]\`).forEach((root) => {
      root.classList.toggle("collapsed", collapsed);
      const toggle = root.querySelector(".sidebar-section-toggle");
      if (toggle) toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    });
  }
}

function bindSidebarSectionToggles() {
  document.querySelectorAll(".sidebar-section-toggle").forEach((button) => {
    button.addEventListener("click", () => {
      const root = button.closest("[data-section]");
      if (!root) return;
      const section = root.dataset.section;
      if (!section || !(section in sidebarSections)) return;
      sidebarSections[section] = !sidebarSections[section];
      saveSidebarSectionState();
      applySidebarSectionState();
    });
  });
}

function fileFilterLabel(value = state.fileFilter) {
  const select = document.getElementById("file-filter");
  if (!select) return "All types";
  const option = Array.from(select.options).find((item) => item.value === value);
  return option?.textContent || "All types";
}

function updateSearchOptionsButton() {
  const button = document.getElementById("search-options");
  if (!button) return;
  button.classList.toggle("active", state.fileFilter !== "all");
}

function openSearchOptionsDialog() {
  const dialog = document.getElementById("search-options-dialog");
  dialog.classList.add("open");
  dialog.setAttribute("aria-hidden", "false");
}

function closeSearchOptionsDialog() {
  const dialog = document.getElementById("search-options-dialog");
  dialog.classList.remove("open");
  dialog.setAttribute("aria-hidden", "true");
}

function setActiveNav() {
  document.getElementById("nav-drive").classList.toggle("active", state.view === "drive");
  document.getElementById("nav-important").classList.toggle("active", state.view === "important");
  document.getElementById("nav-trash")?.classList.toggle("active", state.view === "trash");
  document.getElementById("mobile-nav-drive")?.classList.toggle("active", state.view === "drive");
  document.getElementById("mobile-nav-important")?.classList.toggle("active", state.view === "important");
  document.getElementById("mobile-nav-trash")?.classList.toggle("active", state.view === "trash");
  document.body.classList.toggle("view-trash", state.view === "trash");
  document.body.classList.toggle("view-important", state.view === "important");
  document.body.classList.toggle("view-category", state.view === "category");
  document.getElementById("search").placeholder =
    state.view === "trash"
      ? "Search in Trash"
      : state.view === "important"
        ? "Search in Important"
        : state.view === "category"
          ? "Search in category"
          : "Search in My Drive";
  renderPinnedSidebar();
  renderCategoriesSidebar();
  updateSearchOptionsButton();
}

function setView(view) {
  state.view = view;
  state.path = "";
  state.categoryId = "";
  state.query = "";
  state.fileFilter = "all";
  state.listing = null;
  document.getElementById("search").value = "";
  document.getElementById("file-filter").value = "all";
  closeContextMenu();
  dropDepth = 0;
  setDropActive(false);
  setActiveNav();
  refreshListing();
}

function normalizePath(path) {
  let normalized = String(path || "");
  while (normalized.indexOf("\\\\") !== -1) {
    normalized = normalized.split("\\\\").join("/");
  }
  while (normalized.charAt(0) === "/") {
    normalized = normalized.slice(1);
  }
  while (normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function parentPath(path) {
  const normalized = normalizePath(path);
  if (!normalized) return "";
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "" : normalized.slice(0, index);
}

function isPathInsideTree(currentPath, deletedPath) {
  const current = normalizePath(currentPath);
  const deleted = normalizePath(deletedPath);
  if (!deleted) return false;
  if (current === deleted) return true;
  return current.startsWith(deleted + "/");
}

function navigateAfterDelete(deletedPath) {
  if (!isPathInsideTree(state.path, deletedPath)) return;
  state.path = parentPath(deletedPath);
  state.query = "";
  document.getElementById("search").value = "";
}

function navigateAfterRename(oldPath, newPath) {
  const oldNorm = normalizePath(oldPath);
  const newNorm = normalizePath(newPath);
  const current = normalizePath(state.path);
  if (!oldNorm || !newNorm) return;
  if (current === oldNorm) {
    state.path = newNorm;
    return;
  }
  if (current.startsWith(oldNorm + "/")) {
    state.path = newNorm + current.slice(oldNorm.length);
  }
}

function setPath(path) {
  if (state.view !== "drive") return;
  navigateToDrivePath(path);
}

function navigateToDrivePath(path) {
  const targetPath = normalizePath(path);
  const switchingView = state.view !== "drive";
  if (!switchingView && normalizePath(state.path) === targetPath) {
    return;
  }
  state.view = "drive";
  state.path = targetPath;
  state.query = "";
  document.getElementById("search").value = "";
  if (switchingView) {
    state.fileFilter = "all";
    state.listing = null;
    document.getElementById("file-filter").value = "all";
  }
  closeContextMenu();
  dropDepth = 0;
  setDropActive(false);
  setActiveNav();
  refreshListing();
}

function openPinnedEntry(entry) {
  navigateToDrivePath(pinnedTargetPath(entry));
}

function setCategoryView(categoryId) {
  const normalizedId = String(categoryId || "");
  if (state.view === "category" && state.categoryId === normalizedId) {
    return;
  }
  state.view = "category";
  state.categoryId = normalizedId;
  state.path = "";
  state.query = "";
  state.listing = null;
  document.getElementById("search").value = "";
  closeContextMenu();
  dropDepth = 0;
  setDropActive(false);
  setActiveNav();
  refreshListing();
}

function categoryById(categoryId) {
  return (state.categories || []).find((category) => category.id === categoryId) || null;
}

function breadcrumbEntry(button) {
  return {
    id: "",
    path: decodeDataValue(button.dataset.path),
    name: decodeDataValue(button.dataset.name),
    type: "folder",
    originalPath: "",
  };
}

function renderBreadcrumbs(path) {
  const root = document.getElementById("breadcrumbs");
  if (state.view === "trash") {
    root.innerHTML = '<span>Trash</span>';
    return;
  }
  if (state.view === "important") {
    root.innerHTML = '<span>Important</span>';
    return;
  }
  if (state.view === "category") {
    const category = categoryById(state.categoryId);
    root.innerHTML = \`<span>\${escapeHtml(category?.name || "Category")}</span>\`;
    return;
  }
  const parts = path ? path.split("/") : [];
  let html = \`<button type="button" class="crumb" data-path="" data-name="My Drive">My Drive</button>\`;
  let current = "";
  for (const part of parts) {
    current = current ? \`\${current}/\${part}\` : part;
    html += \` <span>/</span> <button type="button" class="crumb" data-path="\${encodeDataValue(current)}" data-name="\${encodeDataValue(part)}">\${escapeHtml(part)}</button>\`;
  }
  root.innerHTML = html;
  root.querySelectorAll(".crumb").forEach(bindBreadcrumb);
}

function fileExtension(name) {
  const index = String(name || "").lastIndexOf(".");
  if (index <= 0) return "";
  return String(name).slice(index + 1).toLowerCase();
}

function fileTypeCategory(entry) {
  if (entry.type === "folder") return "folder";
  const ext = fileExtension(entry.name);
  const image = ["jpg", "jpeg", "png", "gif", "webp", "svg", "heic", "heif", "bmp", "ico", "avif", "tif", "tiff"];
  const video = ["mp4", "mov", "avi", "mkv", "webm", "m4v", "wmv", "mpeg", "mpg"];
  const audio = ["mp3", "wav", "flac", "aac", "ogg", "m4a", "opus", "wma"];
  const document = ["pdf", "doc", "docx", "txt", "md", "rtf", "odt", "pages"];
  const spreadsheet = ["xls", "xlsx", "csv", "ods", "numbers"];
  const presentation = ["ppt", "pptx", "odp", "key"];
  const archive = ["zip", "tar", "gz", "tgz", "bz2", "xz", "rar", "7z"];
  const code = ["js", "ts", "jsx", "tsx", "py", "json", "html", "htm", "css", "xml", "yaml", "yml", "sh", "rs", "go", "java", "c", "cpp", "h", "rb", "php", "sql"];
  if (image.includes(ext)) return "image";
  if (video.includes(ext)) return "video";
  if (audio.includes(ext)) return "audio";
  if (document.includes(ext)) return "document";
  if (spreadsheet.includes(ext)) return "spreadsheet";
  if (presentation.includes(ext)) return "presentation";
  if (archive.includes(ext)) return "archive";
  if (code.includes(ext)) return "code";
  return "file";
}

function fileTypeInfo(entry) {
  if (entry.type === "folder") {
    return { category: "folder", label: "Folder", badge: "📁" };
  }
  const ext = fileExtension(entry.name);
  const category = fileTypeCategory(entry);
  const known = {
    pdf: "PDF",
    doc: "DOC",
    docx: "DOC",
    txt: "TXT",
    md: "MD",
    xls: "XLS",
    xlsx: "XLS",
    csv: "CSV",
    ppt: "PPT",
    pptx: "PPT",
    zip: "ZIP",
    rar: "RAR",
    "7z": "7Z",
    mp3: "MP3",
    wav: "WAV",
    flac: "FLAC",
    mp4: "MP4",
    mov: "MOV",
    mkv: "MKV",
    jpg: "JPG",
    jpeg: "JPG",
    png: "PNG",
    gif: "GIF",
    webp: "WEBP",
    svg: "SVG",
    js: "JS",
    ts: "TS",
    json: "JSON",
    html: "HTML",
    css: "CSS",
    py: "PY",
  };
  const badge = known[ext] || (ext ? ext.slice(0, 4).toUpperCase() : "FILE");
  return { category, label: badge, badge };
}

function renderFileIcon(entry) {
  const info = fileTypeInfo(entry);
  return \`<div class="icon file-icon-badge type-\${info.category}" title="\${escapeHtml(info.label)}">\${info.category === "folder" ? info.badge : escapeHtml(info.badge)}</div>\`;
}

function filteredEntries(entries) {
  const query = state.query.trim().toLowerCase();
  const filter = state.fileFilter || "all";
  return entries.filter((entry) => {
    const category = fileTypeCategory(entry);
    if (filter === "folder") {
      if (entry.type !== "folder") return false;
    } else if (filter !== "all") {
      if (entry.type === "folder") return true;
      if (category !== filter) return false;
    }
    if (!query) return true;
    const haystack = [
      entry.name,
      entry.path,
      entry.originalPath || "",
      fileTypeInfo(entry).label,
    ].join(" ").toLowerCase();
    return haystack.includes(query);
  });
}

function entryFromCard(card) {
  const categoryIds = decodeDataValue(card.dataset.categoryIds);
  return {
    id: decodeDataValue(card.dataset.id),
    path: decodeDataValue(card.dataset.path),
    name: decodeDataValue(card.dataset.name),
    type: card.dataset.type || "file",
    originalPath: decodeDataValue(card.dataset.originalPath),
    important: card.dataset.important === "true",
    pinned: card.dataset.pinned === "true",
    categoryIds: categoryIds ? categoryIds.split(",").filter(Boolean) : [],
  };
}

function categoryLabels(categoryIds) {
  const ids = categoryIds || [];
  return ids
    .map((id) => categoryById(id)?.name)
    .filter(Boolean);
}

function clearContextSelection() {
  document.querySelectorAll(".card.selected, .crumb.selected, .pinned-item.selected, .category-item.selected").forEach((node) => {
    node.classList.remove("selected");
  });
}

function closeContextMenu() {
  const menu = document.getElementById("context-menu");
  menu.classList.remove("open");
  menuState.entry = null;
  menuState.source = "card";
  clearContextSelection();
}

function isImportantEntry(entry) {
  return !!entry.important || state.importantPaths.has(entry.path);
}

function isPinnedEntry(entry) {
  return !!entry.pinned || state.pinnedPaths.has(entry.path);
}

function pinnedTargetPath(entry) {
  return entry.type === "folder" ? entry.path : parentPath(entry.path);
}

function entryFromPinned(button) {
  const path = decodeDataValue(button.dataset.path);
  const existing = (state.pinnedItems || []).find((item) => item.path === path);
  if (existing) return existing;
  return {
    path,
    name: decodeDataValue(button.dataset.name),
    type: button.dataset.type || "file",
    pinned: true,
  };
}

function renameStem(name, type) {
  if (type === "folder") return String(name || "");
  const value = String(name || "");
  const index = value.lastIndexOf(".");
  if (index <= 0) return value;
  return value.slice(0, index);
}

function renameExtension(name, type) {
  if (type === "folder") return "";
  const value = String(name || "");
  const index = value.lastIndexOf(".");
  if (index <= 0) return "";
  return value.slice(index);
}

function renderPinnedList(root) {
  const items = state.pinnedItems || [];
  if (!items.length) {
    root.innerHTML = '<div class="pinned-empty">Pin items for quick access</div>';
    return;
  }
  const currentPath = normalizePath(state.path);
  root.innerHTML = items.map((entry) => {
    const targetPath = pinnedTargetPath(entry);
    const active = state.view === "drive" && currentPath === normalizePath(targetPath);
    const icon = entry.type === "folder" ? "📁" : "📄";
    return \`
      <button
        type="button"
        class="pinned-item\${active ? " active" : ""}"
        data-path="\${encodeDataValue(entry.path)}"
        data-name="\${encodeDataValue(entry.name)}"
        data-type="\${entry.type}"
      >
        <span class="pinned-icon">\${icon}</span>
        <span class="pinned-name">\${escapeHtml(entry.name)}</span>
      </button>\`;
  }).join("");
  root.querySelectorAll(".pinned-item").forEach((button) => {
    button.addEventListener("click", () => {
      if (menuState.longPress) {
        menuState.longPress = false;
        return;
      }
      openPinnedEntry(entryFromPinned(button));
    });

    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openContextMenu(entryFromPinned(button), event.clientX, event.clientY, button, "pinned");
    });

    button.addEventListener("touchstart", (event) => {
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      const entry = entryFromPinned(button);
      clearTimeout(longPressTimer);
      longPressTimer = window.setTimeout(() => {
        menuState.longPress = true;
        openContextMenu(entry, touch.clientX, touch.clientY, button, "pinned");
      }, 500);
    }, { passive: true });

    button.addEventListener("touchend", () => clearTimeout(longPressTimer));
    button.addEventListener("touchmove", () => clearTimeout(longPressTimer));
    button.addEventListener("touchcancel", () => clearTimeout(longPressTimer));
  });
}

function renderPinnedSidebar() {
  for (const id of ["pinned-list", "mobile-pinned-list"]) {
    const root = document.getElementById(id);
    if (root) renderPinnedList(root);
  }
}

async function refreshPinnedSidebar() {
  try {
    const response = await fetch("/api/pinned");
    const data = await response.json();
    if (!response.ok) return;
    state.pinnedItems = data.entries || [];
    state.pinnedPaths = new Set(data.pinnedPaths || state.pinnedItems.map((entry) => entry.path));
    renderPinnedSidebar();
  } catch {
    // ignore sidebar refresh errors
  }
}

function entryFromCategory(button) {
  return {
    id: decodeDataValue(button.dataset.id),
    path: "",
    name: decodeDataValue(button.dataset.name),
    type: "category",
  };
}

function renderCategoriesList(root) {
  const categories = state.categories || [];
  if (!categories.length) {
    root.innerHTML = '<div class="categories-empty">Create categories to organize files</div>';
    return;
  }
  root.innerHTML = categories.map((category) => {
    const active = state.view === "category" && state.categoryId === category.id;
    return \`
      <button
        type="button"
        class="category-item\${active ? " active" : ""}"
        data-id="\${encodeDataValue(category.id)}"
        data-name="\${encodeDataValue(category.name)}"
      >
        <span class="category-icon">🏷</span>
        <span class="category-name">\${escapeHtml(category.name)}</span>
      </button>\`;
  }).join("");

  root.querySelectorAll(".category-item").forEach((button) => {
    button.addEventListener("click", () => {
      if (menuState.longPress) {
        menuState.longPress = false;
        return;
      }
      setCategoryView(decodeDataValue(button.dataset.id));
    });

    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openContextMenu(entryFromCategory(button), event.clientX, event.clientY, button, "category");
    });

    button.addEventListener("touchstart", (event) => {
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      const entry = entryFromCategory(button);
      clearTimeout(longPressTimer);
      longPressTimer = window.setTimeout(() => {
        menuState.longPress = true;
        openContextMenu(entry, touch.clientX, touch.clientY, button, "category");
      }, 500);
    }, { passive: true });

    button.addEventListener("touchend", () => clearTimeout(longPressTimer));
    button.addEventListener("touchmove", () => clearTimeout(longPressTimer));
    button.addEventListener("touchcancel", () => clearTimeout(longPressTimer));
  });
}

function renderCategoriesSidebar() {
  for (const id of ["categories-list", "mobile-categories-list"]) {
    const root = document.getElementById(id);
    if (root) renderCategoriesList(root);
  }
}

async function refreshCategoriesSidebar() {
  try {
    const response = await fetch("/api/categories");
    const data = await response.json();
    if (!response.ok) return;
    state.categories = data.categories || [];
    renderCategoriesSidebar();
  } catch {
    // ignore sidebar refresh errors
  }
}

function categoryAssignmentActions(entry) {
  const assigned = new Set(entry.categoryIds || []);
  const actions = [];
  for (const category of state.categories || []) {
    if (assigned.has(category.id)) {
      actions.push({
        id: \`unassign-category:\${category.id}\`,
        label: \`Remove from \${category.name}\`,
      });
    } else {
      actions.push({
        id: \`assign-category:\${category.id}\`,
        label: \`Add to \${category.name}\`,
      });
    }
  }
  return actions;
}

function withCategorySubmenu(actions, entry) {
  const categoryActions = categoryAssignmentActions(entry);
  if (!categoryActions.length) return actions;
  const shareIndex = actions.findIndex((action) => action.id === "share");
  const insertAt = shareIndex === -1 ? actions.length : shareIndex;
  const submenu = { id: "categories-submenu", label: "Categories", submenu: categoryActions };
  return [...actions.slice(0, insertAt), submenu, ...actions.slice(insertAt)];
}

function renderMenuAction(action) {
  if (action.submenu) {
    const items = (action.submenu || []).filter((item) => !item.hidden);
    if (!items.length) return "";
    const panel = items
      .map((item) =>
        \`<button type="button" data-action="\${item.id}" class="\${item.danger ? "danger" : ""}">\${escapeHtml(item.label)}</button>\`
      )
      .join("");
    return \`
      <div class="menu-submenu">
        <button type="button" class="menu-submenu-trigger" aria-haspopup="true" aria-expanded="false">
          <span>\${escapeHtml(action.label)}</span>
          <span class="menu-submenu-chevron" aria-hidden="true">›</span>
        </button>
        <div class="menu-submenu-panel" role="menu">\${panel}</div>
      </div>\`;
  }
  return \`<button type="button" data-action="\${action.id}" class="\${action.danger ? "danger" : ""}">\${escapeHtml(action.label)}</button>\`;
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

function currentFolderEntry() {
  const folderPath = normalizePath(state.path);
  if (!folderPath) {
    return { id: "", path: "", name: "My Drive", type: "folder" };
  }
  const slash = folderPath.lastIndexOf("/");
  const name = slash === -1 ? folderPath : folderPath.slice(slash + 1);
  return { id: "", path: folderPath, name, type: "folder" };
}

function isFolderBackgroundTarget(target) {
  if (!target?.closest?.("#content")) return false;
  if (target.closest(".card")) return false;
  if (target.closest(".crumb")) return false;
  if (target.closest(".pinned-item")) return false;
  if (target.closest("#context-menu")) return false;
  if (target.closest("#drop-overlay")) return false;
  if (target.closest(".search-bar")) return false;
  if (target.closest(".topbar")) return false;
  if (target.closest("button, a, input, select, label, textarea")) return false;
  return true;
}

function contextMenuActions(entry, source) {
  if (source === "folder") {
    if (state.view === "trash") {
      return [{ id: "empty-trash", label: "Empty trash", danger: true }];
    }
    if (state.view !== "drive") return [];
    return [
      { id: "new-folder", label: "New folder" },
      { id: "upload", label: "Upload files" },
      { id: "rename", label: "Rename folder", hidden: !entry.path },
      {
        id: isImportantEntry(entry) ? "unmark-important" : "mark-important",
        label: isImportantEntry(entry) ? "Remove from important" : "Mark as important",
        hidden: !entry.path,
      },
      {
        id: isPinnedEntry(entry) ? "unpin" : "pin",
        label: isPinnedEntry(entry) ? "Unpin from sidebar" : "Pin to sidebar",
        hidden: !entry.path,
      },
      { id: "share", label: "Share folder" },
      { id: "delete", label: "Move to trash", danger: true, hidden: !entry.path },
    ];
  }
  if (source === "category") {
    return [
      { id: "open", label: "Open" },
      { id: "rename-category", label: "Rename" },
      { id: "delete-category", label: "Delete", danger: true },
    ];
  }
  if (source === "pinned") {
    return [
      { id: "open", label: entry.type === "folder" ? "Open" : "Show in Drive" },
      { id: "unpin", label: "Unpin from sidebar" },
    ];
  }
  if (source === "breadcrumb") {
    return [
      { id: "open", label: "Open" },
      { id: "rename", label: "Rename", hidden: !entry.path },
      { id: isImportantEntry(entry) ? "unmark-important" : "mark-important", label: isImportantEntry(entry) ? "Remove from important" : "Mark as important", hidden: !entry.path },
      { id: isPinnedEntry(entry) ? "unpin" : "pin", label: isPinnedEntry(entry) ? "Unpin from sidebar" : "Pin to sidebar", hidden: !entry.path },
      { id: "share", label: "Share" },
      { id: "delete", label: "Move to trash", danger: true, hidden: !entry.path },
    ];
  }
  if (state.view === "category") {
    const isImage = entry.type === "file" && fileTypeCategory(entry) === "image";
    return withCategorySubmenu([
      { id: "open", label: entry.type === "folder" ? "Open" : "Show in Drive" },
      { id: "preview", label: "Preview", hidden: !isImage },
      { id: "open-new-tab", label: "Open in new tab", hidden: entry.type === "folder" },
      { id: "share", label: "Share" },
    ], entry);
  }
  if (state.view === "important") {
    const isImage = entry.type === "file" && fileTypeCategory(entry) === "image";
    return withCategorySubmenu([
      { id: "open", label: entry.type === "folder" ? "Open" : "Show in Drive" },
      { id: "preview", label: "Preview", hidden: !isImage },
      { id: "open-new-tab", label: "Open in new tab", hidden: entry.type === "folder" },
      { id: "unmark-important", label: "Remove from important" },
      { id: "share", label: "Share" },
    ], entry);
  }
  if (state.view === "trash") {
    const isImage = entry.type === "file" && fileTypeCategory(entry) === "image";
    return [
      { id: "restore", label: "Restore" },
      { id: "preview", label: "Preview", hidden: !isImage },
      { id: "open-new-tab", label: "Open in new tab", hidden: entry.type === "folder" },
      { id: "download", label: "Download", hidden: entry.type === "folder" },
      { id: "share", label: "Share", hidden: entry.type === "folder" },
      { id: "delete-forever", label: "Delete forever", danger: true },
    ];
  }
  const isImage = entry.type === "file" && fileTypeCategory(entry) === "image";
  return withCategorySubmenu([
    { id: "open", label: entry.type === "folder" ? "Open" : "Download" },
    { id: "preview", label: "Preview", hidden: !isImage },
    { id: "open-new-tab", label: "Open in new tab", hidden: entry.type === "folder" },
    { id: "rename", label: "Rename" },
    { id: isImportantEntry(entry) ? "unmark-important" : "mark-important", label: isImportantEntry(entry) ? "Remove from important" : "Mark as important" },
    { id: isPinnedEntry(entry) ? "unpin" : "pin", label: isPinnedEntry(entry) ? "Unpin from sidebar" : "Pin to sidebar" },
    { id: "share", label: "Share" },
    { id: "delete", label: "Move to trash", danger: true },
  ], entry);
}

function openContextMenu(entry, x, y, highlight, source = "card") {
  const menu = document.getElementById("context-menu");
  menuState.entry = entry;
  menuState.source = source;
  clearContextSelection();
  if (highlight) highlight.classList.add("selected");

  const actions = contextMenuActions(entry, source);
  const visibleActions = actions.filter((action) => !action.hidden);
  if (!visibleActions.length) return;

  menu.innerHTML =
    \`<div class="menu-label">\${escapeHtml(entry.name)}</div>\` +
    actions
      .filter((action) => !action.hidden)
      .map((action) => renderMenuAction(action))
      .join("");

  menu.classList.add("open");
  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  menu.style.left = \`\${Math.max(8, left)}px\`;
  menu.style.top = \`\${Math.max(8, top)}px\`;
  positionContextSubmenus();

  menu.querySelectorAll(".menu-submenu-trigger").forEach((trigger) => {
    trigger.addEventListener("click", (event) => {
      event.stopPropagation();
      const submenu = trigger.closest(".menu-submenu");
      if (!submenu) return;
      const open = submenu.classList.contains("open");
      menu.querySelectorAll(".menu-submenu.open").forEach((node) => node.classList.remove("open"));
      if (!open) submenu.classList.add("open");
      trigger.setAttribute("aria-expanded", submenu.classList.contains("open") ? "true" : "false");
    });
  });
}

function shareLink(entry) {
  const origin = window.location.origin;
  if (state.view === "trash") {
    return \`\${origin}/api/trash/download?id=\${encodeURIComponent(entry.id)}\`;
  }
  if (entry.type === "folder") {
    return \`\${origin}/?open=\${encodeURIComponent(entry.path)}\`;
  }
  return \`\${origin}/api/download?path=\${encodeURIComponent(entry.path)}\`;
}

async function copyShareLink(entry) {
  const url = shareLink(entry);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(url);
    return;
  }
  const input = document.createElement("textarea");
  input.value = url;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.left = "-9999px";
  document.body.appendChild(input);
  input.select();
  document.execCommand("copy");
  input.remove();
}

function fileViewUrl(entry) {
  if (state.view === "trash") {
    return \`/api/trash/view?id=\${encodeURIComponent(entry.id)}\`;
  }
  return \`/api/view?path=\${encodeURIComponent(entry.path)}\`;
}

function isImageEntry(entry) {
  return entry.type === "file" && fileTypeCategory(entry) === "image";
}

function openEntryInNewTab(entry) {
  window.open(fileViewUrl(entry), "_blank", "noopener,noreferrer");
}

function previewEntryKey(entry) {
  return state.view === "trash" ? entry.id : entry.path;
}

function folderImageEntries() {
  const entries = state.listing?.entries || [];
  return entries.filter((item) => isImageEntry(item));
}

function showPreviewImage() {
  const entry = previewState.images[previewState.index];
  if (!entry) return;
  const dialog = document.getElementById("preview-dialog");
  const image = document.getElementById("preview-image");
  const prev = document.getElementById("preview-prev");
  const next = document.getElementById("preview-next");
  const counter = document.getElementById("preview-counter");
  const total = previewState.images.length;
  const canStep = total > 1;
  document.getElementById("preview-title").textContent = entry.name;
  image.src = fileViewUrl(entry);
  image.alt = entry.name;
  prev.disabled = !canStep;
  next.disabled = !canStep;
  counter.textContent = canStep ? \`\${previewState.index + 1} / \${total}\` : "";
  dialog.classList.add("open");
  dialog.setAttribute("aria-hidden", "false");
}

function stepPreview(delta) {
  const total = previewState.images.length;
  if (total <= 1) return;
  previewState.index = (previewState.index + delta + total) % total;
  showPreviewImage();
}

function closePreviewDialog() {
  const dialog = document.getElementById("preview-dialog");
  const image = document.getElementById("preview-image");
  dialog.classList.remove("open");
  dialog.setAttribute("aria-hidden", "true");
  image.removeAttribute("src");
  document.getElementById("preview-counter").textContent = "";
  previewState.images = [];
  previewState.index = 0;
}

function openPreviewDialog(entry) {
  if (!isImageEntry(entry)) return;
  const images = folderImageEntries();
  if (!images.length) return;
  const key = previewEntryKey(entry);
  let index = images.findIndex((item) => previewEntryKey(item) === key);
  if (index === -1) index = 0;
  previewState.images = images;
  previewState.index = index;
  showPreviewImage();
}

async function downloadEntry(entry) {
  const url = state.view === "trash"
    ? \`/api/trash/download?id=\${encodeURIComponent(entry.id)}\`
    : \`/api/download?path=\${encodeURIComponent(entry.path)}\`;
  const response = await fetch(url);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Could not download file");
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = entry.name;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}

function openFromImportant(entry) {
  navigateToDrivePath(pinnedTargetPath(entry));
}

async function setImportant(entry, important) {
  const response = await fetch(important ? "/api/unmark-important" : "/api/mark-important", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: entry.path }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Could not update important items");
  }
  refreshListing();
}

async function setPinned(entry, pinned) {
  const response = await fetch(pinned ? "/api/unpin" : "/api/pin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: entry.path }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Could not update pinned items");
  }
  await refreshPinnedSidebar();
  refreshListing();
}

async function assignCategory(entry, categoryId) {
  const response = await fetch("/api/categories/assign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: entry.path, categoryId }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Could not add to category");
  }
  refreshListing();
}

async function unassignCategory(entry, categoryId) {
  const response = await fetch("/api/categories/unassign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: entry.path, categoryId }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Could not remove from category");
  }
  refreshListing();
}

async function runMenuAction(action, entry, source = "card") {
  if (action === "new-folder") {
    openNewFolderDialog();
    return;
  }
  if (action === "upload") {
    document.getElementById("upload-input").click();
    return;
  }
  if (action === "empty-trash") {
    await emptyTrash();
    return;
  }
  if (action === "rename-category") {
    openCategoryDialog("rename", entry);
    return;
  }
  if (action === "delete-category") {
    if (!window.confirm(\`Delete category "\${entry.name}"? Files will stay in My Drive.\`)) return;
    const response = await fetch("/api/categories/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: entry.id }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Could not delete category");
    }
    if (state.view === "category" && state.categoryId === entry.id) {
      setView("drive");
      return;
    }
    await refreshCategoriesSidebar();
    refreshListing();
    return;
  }
  if (action.startsWith("assign-category:")) {
    await assignCategory(entry, action.slice("assign-category:".length));
    return;
  }
  if (action.startsWith("unassign-category:")) {
    await unassignCategory(entry, action.slice("unassign-category:".length));
    return;
  }
  if (action === "open") {
    if (source === "category") {
      setCategoryView(entry.id);
      return;
    }
    if (source === "pinned" || state.view === "important" || state.view === "category") {
      openFromImportant(entry);
      return;
    }
    if (entry.type === "folder") {
      setPath(entry.path);
      return;
    }
    await downloadEntry(entry);
    return;
  }
  if (action === "download") {
    await downloadEntry(entry);
    return;
  }
  if (action === "open-new-tab") {
    openEntryInNewTab(entry);
    return;
  }
  if (action === "preview") {
    openPreviewDialog(entry);
    return;
  }
  if (action === "share") {
    await copyShareLink(entry);
    document.getElementById("status").textContent = "Link copied to clipboard";
    return;
  }
  if (action === "rename") {
    openRenameDialog(entry);
    return;
  }
  if (action === "mark-important") {
    await setImportant(entry, false);
    return;
  }
  if (action === "unmark-important") {
    await setImportant(entry, true);
    return;
  }
  if (action === "pin") {
    await setPinned(entry, false);
    return;
  }
  if (action === "unpin") {
    await setPinned(entry, true);
    return;
  }
  if (action === "delete") {
    if (!window.confirm(\`Move "\${entry.name}" to trash?\`)) return;
    const response = await fetch("/api/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: entry.path }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not move to trash");
    navigateAfterDelete(entry.path);
    refreshListing();
    return;
  }
  if (action === "restore") {
    const response = await fetch("/api/trash/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: entry.id }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not restore item");
    refreshListing();
    return;
  }
  if (action === "delete-forever") {
    if (!window.confirm(\`Permanently delete "\${entry.name}"?\`)) return;
    const response = await fetch("/api/trash/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: entry.id }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not delete item");
    refreshListing();
  }
}

function isInternalDrag(event) {
  return Array.from(event.dataTransfer?.types || []).includes(DRAG_MIME);
}

function clearDropTargets() {
  document.querySelectorAll(".drop-target").forEach((node) => {
    node.classList.remove("drop-target");
  });
}

function readDragEntry(dataTransfer) {
  try {
    return JSON.parse(dataTransfer.getData(DRAG_MIME));
  } catch {
    return null;
  }
}

function dragPayload(entry) {
  return JSON.stringify({ path: entry.path, type: entry.type, name: entry.name });
}

function canDropOnFolder(entry, destinationPath) {
  const dest = normalizePath(destinationPath);
  const source = normalizePath(entry.path);
  if (!source) return false;
  if (parentPath(source) === dest) return false;
  if (entry.type === "folder" && (dest === source || dest.startsWith(source + "/"))) {
    return false;
  }
  return true;
}

async function moveEntryToFolder(entry, destinationPath) {
  const response = await fetch("/api/move", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: entry.path, destination: destinationPath }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Could not move item");
  if (isPathInsideTree(state.path, entry.path)) {
    navigateAfterDelete(entry.path);
  }
  refreshListing();
}

async function trashDraggedEntry(entry) {
  const response = await fetch("/api/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: entry.path }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Could not move to trash");
  navigateAfterDelete(entry.path);
  refreshListing();
}

function bindFolderDropTarget(element, getDestinationPath) {
  element.addEventListener("dragover", (event) => {
    if (!isInternalDrag(event) || state.view !== "drive") return;
    const entry = dragEntry;
    if (!entry) return;
    const destination = getDestinationPath();
    if (!canDropOnFolder(entry, destination)) return;
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
    if (!isInternalDrag(event) || state.view !== "drive") return;
    event.preventDefault();
    event.stopPropagation();
    clearDropTargets();
    const entry = readDragEntry(event.dataTransfer) || dragEntry;
    if (!entry) return;
    const destination = getDestinationPath();
    if (!canDropOnFolder(entry, destination)) return;
    try {
      await moveEntryToFolder(entry, destination);
    } catch (error) {
      showError(String(error));
    }
  });
}

function bindTrashDropTarget(trashNav) {
  trashNav.addEventListener("dragover", (event) => {
    if (!isInternalDrag(event) || state.view !== "drive") return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    trashNav.classList.add("drop-target");
  });
  trashNav.addEventListener("dragleave", (event) => {
    if (!trashNav.contains(event.relatedTarget)) {
      trashNav.classList.remove("drop-target");
    }
  });
  trashNav.addEventListener("drop", async (event) => {
    if (!isInternalDrag(event) || state.view !== "drive") return;
    event.preventDefault();
    event.stopPropagation();
    clearDropTargets();
    const entry = readDragEntry(event.dataTransfer) || dragEntry;
    if (!entry) return;
    try {
      await trashDraggedEntry(entry);
    } catch (error) {
      showError(String(error));
    }
  });
}

function bindTrashDrop() {
  const trashNav = document.getElementById("nav-trash");
  const mobileTrashNav = document.getElementById("mobile-nav-trash");
  if (trashNav) bindTrashDropTarget(trashNav);
  if (mobileTrashNav) bindTrashDropTarget(mobileTrashNav);
}

function bindCard(card) {
  if (state.view === "drive") {
    card.setAttribute("draggable", "true");
    card.addEventListener("dragstart", (event) => {
      const entry = entryFromCard(card);
      dragEntry = entry;
      event.dataTransfer.setData(DRAG_MIME, dragPayload(entry));
      event.dataTransfer.effectAllowed = "move";
      card.classList.add("dragging");
    });
    card.addEventListener("dragend", () => {
      card.classList.remove("dragging");
      dragEntry = null;
      clearDropTargets();
    });
    if (card.dataset.type === "folder") {
      bindFolderDropTarget(card, () => entryFromCard(card).path);
    }
  } else {
    card.removeAttribute("draggable");
  }

  card.addEventListener("click", async () => {
    if (menuState.longPress) {
      menuState.longPress = false;
      return;
    }
    const entry = entryFromCard(card);
    if (state.view === "trash") return;
    if (state.view === "important" || state.view === "category") {
      if (entry.type === "folder") {
        openFromImportant(entry);
        return;
      }
      await downloadEntry(entry);
      return;
    }
    if (entry.type === "folder") {
      setPath(entry.path);
      return;
    }
    try {
      await downloadEntry(entry);
    } catch (error) {
      showError(String(error));
    }
  });

  card.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openContextMenu(entryFromCard(card), event.clientX, event.clientY, card);
  });

  card.addEventListener("touchstart", (event) => {
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    const entry = entryFromCard(card);
    clearTimeout(longPressTimer);
    longPressTimer = window.setTimeout(() => {
      menuState.longPress = true;
      openContextMenu(entry, touch.clientX, touch.clientY, card);
    }, 500);
  }, { passive: true });

  card.addEventListener("touchend", () => clearTimeout(longPressTimer));
  card.addEventListener("touchmove", () => clearTimeout(longPressTimer));
  card.addEventListener("touchcancel", () => clearTimeout(longPressTimer));
}

function bindBreadcrumb(button) {
  if (state.view === "drive") {
    bindFolderDropTarget(button, () => decodeDataValue(button.dataset.path));
  }

  button.addEventListener("click", () => {
    if (menuState.longPress) {
      menuState.longPress = false;
      return;
    }
    setPath(decodeDataValue(button.dataset.path));
  });

  button.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openContextMenu(
      breadcrumbEntry(button),
      event.clientX,
      event.clientY,
      button,
      "breadcrumb",
    );
  });

  button.addEventListener("touchstart", (event) => {
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    const entry = breadcrumbEntry(button);
    clearTimeout(longPressTimer);
    longPressTimer = window.setTimeout(() => {
      menuState.longPress = true;
      openContextMenu(entry, touch.clientX, touch.clientY, button, "breadcrumb");
    }, 500);
  }, { passive: true });

  button.addEventListener("touchend", () => clearTimeout(longPressTimer));
  button.addEventListener("touchmove", () => clearTimeout(longPressTimer));
  button.addEventListener("touchcancel", () => clearTimeout(longPressTimer));
}

function renderEntries() {
  const container = document.getElementById("files");
  const data = state.listing || { path: state.path, entries: [] };
  const allEntries = data.entries || [];
  const entries = filteredEntries(allEntries);
  const locationLabel = state.view === "trash"
    ? "Trash"
    : state.view === "important"
      ? "Important"
      : state.view === "category"
        ? (categoryById(state.categoryId)?.name || "Category")
        : (data.path ? data.path : "My Drive");
  const filterLabel = state.fileFilter !== "all" ? \` · \${fileFilterLabel()}\` : "";
  document.getElementById("status").textContent = \`\${entries.length} item(s) in \${locationLabel}\${filterLabel}\`;

  if (!entries.length) {
    if (allEntries.length && (state.query || state.fileFilter !== "all")) {
      container.innerHTML = '<div class="empty">No items match your search or filter.</div>';
      return;
    }
    container.innerHTML = state.view === "trash"
      ? '<div class="empty">Trash is empty.</div>'
      : state.view === "important"
        ? '<div class="empty">No important items yet. Mark files and folders from My Drive.</div>'
        : state.view === "category"
          ? '<div class="empty">No items in this category yet. Add files from My Drive.</div>'
          : '<div class="empty">This folder is empty. Upload a file or create a folder to get started.</div>';
    return;
  }

  container.innerHTML = entries.map((entry) => {
    const icon = renderFileIcon(entry);
    const meta = state.view === "trash"
      ? \`Deleted \${formatDate(entry.deletedAt)} · was \${escapeHtml(entry.originalPath || "/")}\`
      : state.view === "important" || state.view === "category"
        ? (entry.type === "folder"
          ? \`Folder · \${escapeHtml(entry.path || "/")}\`
          : \`\${formatSize(entry.size)} · \${escapeHtml(entry.path || "/")}\`)
        : (entry.type === "folder"
          ? \`Folder · \${formatDate(entry.modified)}\`
          : \`\${formatSize(entry.size)} · \${formatDate(entry.modified)}\`);
    const importantBadge = entry.important ? '<div class="card-important" aria-label="Important">★</div>' : "";
    const labels = categoryLabels(entry.categoryIds);
    const categoryLine = labels.length && state.view === "drive"
      ? \`<div class="card-categories">\${escapeHtml(labels.join(", "))}</div>\`
      : "";
    return \`
      <article
        class="card"
        data-id="\${encodeDataValue(entry.id || "")}"
        data-path="\${encodeDataValue(entry.path)}"
        data-name="\${encodeDataValue(entry.name)}"
        data-type="\${entry.type}"
        data-original-path="\${encodeDataValue(entry.originalPath || "")}"
        data-important="\${entry.important ? "true" : "false"}"
        data-pinned="\${entry.pinned ? "true" : "false"}"
        data-category-ids="\${encodeDataValue((entry.categoryIds || []).join(","))}"
      >
        \${importantBadge}
        <div class="icon">\${icon}</div>
        <div class="name">\${escapeHtml(entry.name)}</div>
        <div class="meta">\${meta}</div>
        \${categoryLine}
      </article>\`;
  }).join("");

  container.querySelectorAll(".card").forEach(bindCard);
}

function showError(message) {
  const errorBox = document.getElementById("error");
  errorBox.textContent = message;
  errorBox.hidden = false;
}

async function refreshListing() {
  const requestId = ++listingRequestId;
  const errorBox = document.getElementById("error");
  errorBox.textContent = "";
  errorBox.hidden = true;
  try {
    const response = state.view === "trash"
      ? await fetch("/api/trash")
      : state.view === "important"
        ? await fetch("/api/important")
        : state.view === "category"
          ? await fetch(\`/api/categories/items?category=\${encodeURIComponent(state.categoryId)}\`)
          : await fetch(\`/api/files?path=\${encodeURIComponent(state.path)}\`);
    const data = await response.json();
    if (requestId !== listingRequestId) return;
    if (!response.ok) {
      if (state.view === "drive" && response.status === 404) {
        const previousPath = state.path;
        state.path = parentPath(state.path);
        if (state.path !== previousPath) {
          return refreshListing();
        }
      }
      if (state.view === "category" && response.status === 404) {
        setView("drive");
        return;
      }
      throw new Error(data.error || "Could not load files");
    }
    state.listing = data;
    if (data.categories) {
      state.categories = data.categories;
      renderCategoriesSidebar();
    }
    state.importantPaths = new Set(data.importantPaths || (data.entries || []).filter((entry) => entry.important).map((entry) => entry.path));
    state.pinnedPaths = new Set(data.pinnedPaths || (data.entries || []).filter((entry) => entry.pinned).map((entry) => entry.path));
    renderBreadcrumbs(state.view === "drive" ? (data.path || "") : "");
    renderEntries();
    if (state.view === "drive") {
      refreshPinnedSidebar();
      refreshCategoriesSidebar();
    }
  } catch (error) {
    if (requestId !== listingRequestId) return;
    showError(String(error));
    renderBreadcrumbs(state.view === "drive" ? state.path : "");
    document.getElementById("files").innerHTML = "";
  }
}

function closeNewFolderDialog() {
  const dialog = document.getElementById("new-folder-dialog");
  dialog.classList.remove("open");
  dialog.setAttribute("aria-hidden", "true");
  document.getElementById("new-folder-name").value = "";
}

function openNewFolderDialog() {
  if (state.view !== "drive") {
    setView("drive");
  }
  const dialog = document.getElementById("new-folder-dialog");
  const input = document.getElementById("new-folder-name");
  const location = state.path ? state.path : "My Drive";
  document.getElementById("new-folder-location").textContent = location;
  dialog.classList.add("open");
  dialog.setAttribute("aria-hidden", "false");
  input.value = "";
  input.focus();
}

async function submitNewFolder() {
  const input = document.getElementById("new-folder-name");
  const name = input.value.trim();
  if (!name) {
    input.focus();
    return;
  }
  const response = await fetch("/api/mkdir", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: state.path, name }),
  });
  const data = await response.json();
  if (!response.ok) {
    showError(data.error || "Could not create folder");
    return;
  }
  closeNewFolderDialog();
  refreshListing();
}

function closeRenameDialog() {
  const dialog = document.getElementById("rename-dialog");
  dialog.classList.remove("open");
  dialog.setAttribute("aria-hidden", "true");
  document.getElementById("rename-input").value = "";
  document.getElementById("rename-extension").textContent = "";
  document.getElementById("rename-extension").hidden = true;
  renameEntry = null;
}

function openRenameDialog(entry) {
  if (state.view !== "drive" || !entry?.path) return;
  renameEntry = entry;
  const dialog = document.getElementById("rename-dialog");
  const input = document.getElementById("rename-input");
  const extension = document.getElementById("rename-extension");
  const stem = renameStem(entry.name, entry.type);
  const suffix = renameExtension(entry.name, entry.type);
  document.getElementById("rename-current-name").textContent = entry.name;
  dialog.classList.add("open");
  dialog.setAttribute("aria-hidden", "false");
  input.value = stem;
  extension.textContent = suffix;
  extension.hidden = !suffix;
  input.focus();
  input.select();
}

async function submitRename() {
  const input = document.getElementById("rename-input");
  const stem = input.value.trim();
  if (!stem || !renameEntry) {
    input.focus();
    return;
  }
  const suffix = renameExtension(renameEntry.name, renameEntry.type);
  const name = suffix ? \`\${stem}\${suffix}\` : stem;
  if (name === renameEntry.name) {
    closeRenameDialog();
    return;
  }
  const oldPath = renameEntry.path;
  const response = await fetch("/api/rename", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: oldPath, name }),
  });
  const data = await response.json();
  if (!response.ok) {
    showError(data.error || "Could not rename item");
    return;
  }
  navigateAfterRename(oldPath, data.entry.path);
  closeRenameDialog();
  refreshListing();
}

function closeCategoryDialog() {
  const dialog = document.getElementById("category-dialog");
  dialog.classList.remove("open");
  dialog.setAttribute("aria-hidden", "true");
  document.getElementById("category-name-input").value = "";
  categoryDialogMode = "create";
  categoryDialogId = null;
}

function openCategoryDialog(mode = "create", entry = null) {
  categoryDialogMode = mode;
  categoryDialogId = entry?.id || null;
  const dialog = document.getElementById("category-dialog");
  const input = document.getElementById("category-name-input");
  const title = document.getElementById("category-dialog-title");
  const submit = document.getElementById("category-submit");
  title.textContent = mode === "rename" ? "Rename category" : "New category";
  submit.textContent = mode === "rename" ? "Rename" : "Create";
  input.value = mode === "rename" ? (entry?.name || "") : "";
  dialog.classList.add("open");
  dialog.setAttribute("aria-hidden", "false");
  input.focus();
  if (mode === "rename") input.select();
}

async function submitCategoryDialog() {
  const input = document.getElementById("category-name-input");
  const name = input.value.trim();
  if (!name) {
    input.focus();
    return;
  }
  const endpoint = categoryDialogMode === "rename" ? "/api/categories/rename" : "/api/categories/create";
  const body = categoryDialogMode === "rename"
    ? { id: categoryDialogId, name }
    : { name };
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    showError(data.error || "Could not save category");
    return;
  }
  const wasCategoryView = state.view === "category";
  closeCategoryDialog();
  await refreshCategoriesSidebar();
  if (wasCategoryView) {
    refreshListing();
  }
}

async function uploadFiles(fileList) {
  const files = Array.from(fileList || []).filter((file) => file && file.name);
  if (!files.length) return;
  const status = document.getElementById("status");
  const previousStatus = status.textContent;
  status.textContent = \`Uploading \${files.length} file(s)...\`;
  for (const file of files) {
    const form = new FormData();
    form.append("path", state.path);
    form.append("file", file);
    const response = await fetch("/api/upload", { method: "POST", body: form });
    const data = await response.json();
    if (!response.ok) {
      showError(data.error || \`Could not upload \${file.name}\`);
      status.textContent = previousStatus;
      return;
    }
  }
  refreshListing();
}

let dropDepth = 0;

function isFileDrag(event) {
  if (isInternalDrag(event)) return false;
  return Array.from(event.dataTransfer?.types || []).includes("Files");
}

function setDropActive(active) {
  const content = document.getElementById("content");
  const overlay = document.getElementById("drop-overlay");
  content.classList.toggle("drop-active", active);
  overlay.setAttribute("aria-hidden", active ? "false" : "true");
  if (active) {
    document.getElementById("drop-location").textContent = state.path || "My Drive";
  }
}

function collectDroppedFiles(dataTransfer) {
  const files = [];
  const items = dataTransfer.items;
  if (items && items.length) {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  if (!files.length && dataTransfer.files?.length) {
    for (const file of dataTransfer.files) files.push(file);
  }
  return files;
}

function bindFolderBackgroundMenu() {
  const content = document.getElementById("content");

  function openFolderBackgroundMenu(x, y) {
    if (state.view !== "drive" && state.view !== "trash") return;
    const entry = currentFolderEntry();
    const actions = contextMenuActions(entry, "folder").filter((action) => !action.hidden);
    if (!actions.length) return;
    openContextMenu(entry, x, y, null, "folder");
  }

  content.addEventListener("contextmenu", (event) => {
    if (!isFolderBackgroundTarget(event.target)) return;
    event.preventDefault();
    openFolderBackgroundMenu(event.clientX, event.clientY);
  });

  content.addEventListener("touchstart", (event) => {
    if (!isFolderBackgroundTarget(event.target)) return;
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    clearTimeout(longPressTimer);
    longPressTimer = window.setTimeout(() => {
      menuState.longPress = true;
      openFolderBackgroundMenu(touch.clientX, touch.clientY);
    }, 500);
  }, { passive: true });

  content.addEventListener("touchend", () => clearTimeout(longPressTimer));
  content.addEventListener("touchmove", () => clearTimeout(longPressTimer));
  content.addEventListener("touchcancel", () => clearTimeout(longPressTimer));
}

function bindFileDrop() {
  const content = document.getElementById("content");

  window.addEventListener("dragover", (event) => {
    if (isFileDrag(event)) event.preventDefault();
  });
  window.addEventListener("drop", (event) => {
    if (!event.target.closest("#content") && isFileDrag(event)) {
      event.preventDefault();
    }
  });

  content.addEventListener("dragenter", (event) => {
    if (state.view !== "drive" || !isFileDrag(event)) return;
    event.preventDefault();
    dropDepth += 1;
    setDropActive(true);
  });

  content.addEventListener("dragover", (event) => {
    if (state.view !== "drive" || !isFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  });

  content.addEventListener("dragleave", (event) => {
    if (state.view !== "drive") return;
    if (!content.contains(event.relatedTarget)) {
      dropDepth = 0;
      setDropActive(false);
      return;
    }
    dropDepth = Math.max(0, dropDepth - 1);
    if (dropDepth === 0) setDropActive(false);
  });

  content.addEventListener("drop", async (event) => {
    if (state.view !== "drive" || !isFileDrag(event)) return;
    event.preventDefault();
    dropDepth = 0;
    setDropActive(false);
    const files = collectDroppedFiles(event.dataTransfer);
    if (!files.length) return;
    try {
      await uploadFiles(files);
    } catch (error) {
      showError(String(error));
    }
  });
}

async function emptyTrash() {
  if (!window.confirm("Permanently delete everything in Trash?")) return;
  const response = await fetch("/api/trash/empty", { method: "POST" });
  const data = await response.json();
  if (!response.ok) {
    showError(data.error || "Could not empty trash");
    return;
  }
  refreshListing();
}

document.getElementById("search").addEventListener("input", (event) => {
  state.query = event.target.value;
  renderEntries();
});
document.getElementById("search-options").addEventListener("click", openSearchOptionsDialog);
document.getElementById("search-options-close").addEventListener("click", closeSearchOptionsDialog);
document.getElementById("search-options-dialog").addEventListener("click", (event) => {
  if (event.target.id === "search-options-dialog") closeSearchOptionsDialog();
});
document.getElementById("file-filter").addEventListener("change", (event) => {
  state.fileFilter = event.target.value;
  updateSearchOptionsButton();
  renderEntries();
});
document.getElementById("add-category").addEventListener("click", () => openCategoryDialog("create"));
document.getElementById("mobile-add-category")?.addEventListener("click", () => openCategoryDialog("create"));
document.getElementById("category-cancel").addEventListener("click", closeCategoryDialog);
document.getElementById("category-submit").addEventListener("click", submitCategoryDialog);
document.getElementById("category-name-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter") submitCategoryDialog();
  if (event.key === "Escape") closeCategoryDialog();
});
document.getElementById("category-dialog").addEventListener("click", (event) => {
  if (event.target.id === "category-dialog") closeCategoryDialog();
});
document.getElementById("new-folder-cancel").addEventListener("click", closeNewFolderDialog);
document.getElementById("new-folder-create").addEventListener("click", submitNewFolder);
document.getElementById("new-folder-name").addEventListener("keydown", (event) => {
  if (event.key === "Enter") submitNewFolder();
  if (event.key === "Escape") closeNewFolderDialog();
});
document.getElementById("new-folder-dialog").addEventListener("click", (event) => {
  if (event.target.id === "new-folder-dialog") closeNewFolderDialog();
});
document.getElementById("rename-cancel").addEventListener("click", closeRenameDialog);
document.getElementById("rename-submit").addEventListener("click", submitRename);
document.getElementById("rename-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter") submitRename();
  if (event.key === "Escape") closeRenameDialog();
});
document.getElementById("rename-dialog").addEventListener("click", (event) => {
  if (event.target.id === "rename-dialog") closeRenameDialog();
});
document.getElementById("upload-input").addEventListener("change", (event) => {
  uploadFiles(event.target.files);
  event.target.value = "";
});
document.getElementById("nav-drive").addEventListener("click", () => setView("drive"));
document.getElementById("nav-important").addEventListener("click", () => setView("important"));
document.getElementById("nav-trash").addEventListener("click", () => setView("trash"));
document.getElementById("mobile-nav-drive")?.addEventListener("click", () => setView("drive"));
document.getElementById("mobile-nav-important")?.addEventListener("click", () => setView("important"));
document.getElementById("mobile-nav-trash")?.addEventListener("click", () => setView("trash"));
document.getElementById("empty-trash").addEventListener("click", emptyTrash);
document.getElementById("context-menu").addEventListener("click", async (event) => {
  if (event.target.closest(".menu-submenu-trigger")) return;
  const button = event.target.closest("button[data-action]");
  if (!button || !menuState.entry) return;
  const action = button.dataset.action;
  const entry = menuState.entry;
  const source = menuState.source;
  closeContextMenu();
  try {
    await runMenuAction(action, entry, source);
  } catch (error) {
    showError(String(error));
  }
});
document.addEventListener("click", (event) => {
  if (!event.target.closest("#context-menu")) closeContextMenu();
});
document.addEventListener("keydown", (event) => {
  const previewOpen = document.getElementById("preview-dialog").classList.contains("open");
  if (previewOpen && event.key === "ArrowLeft") {
    event.preventDefault();
    stepPreview(-1);
    return;
  }
  if (previewOpen && event.key === "ArrowRight") {
    event.preventDefault();
    stepPreview(1);
    return;
  }
  if (event.key === "Escape") {
    closePreviewDialog();
    closeRenameDialog();
    closeNewFolderDialog();
    closeCategoryDialog();
    closeSearchOptionsDialog();
    closeContextMenu();
  }
});
function bindPreviewSwipe() {
  const surface = document.getElementById("preview-image-wrap");
  surface.addEventListener("touchstart", (event) => {
    if (event.touches.length !== 1) return;
    previewTouch.startX = event.touches[0].clientX;
    previewTouch.startY = event.touches[0].clientY;
    previewTouch.active = true;
  }, { passive: true });

  surface.addEventListener("touchmove", (event) => {
    if (!previewTouch.active || event.touches.length !== 1) return;
    const dx = event.touches[0].clientX - previewTouch.startX;
    const dy = event.touches[0].clientY - previewTouch.startY;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 10) {
      event.preventDefault();
    }
  }, { passive: false });

  surface.addEventListener("touchend", (event) => {
    if (!previewTouch.active) return;
    previewTouch.active = false;
    const touch = event.changedTouches[0];
    if (!touch) return;
    const dx = touch.clientX - previewTouch.startX;
    const dy = touch.clientY - previewTouch.startY;
    const threshold = 48;
    if (Math.abs(dx) < threshold || Math.abs(dx) < Math.abs(dy)) return;
    if (dx < 0) stepPreview(1);
    else stepPreview(-1);
  }, { passive: true });

  surface.addEventListener("touchcancel", () => {
    previewTouch.active = false;
  }, { passive: true });
}

document.getElementById("preview-close").addEventListener("click", closePreviewDialog);
document.getElementById("preview-prev").addEventListener("click", () => stepPreview(-1));
document.getElementById("preview-next").addEventListener("click", () => stepPreview(1));
document.getElementById("preview-dialog").addEventListener("click", (event) => {
  if (event.target.id === "preview-dialog") closePreviewDialog();
});
bindPreviewSwipe();
document.addEventListener("contextmenu", (event) => {
  if (event.target.closest(".card")) return;
  if (event.target.closest(".crumb")) return;
  if (event.target.closest(".pinned-item")) return;
  if (event.target.closest(".category-item")) return;
  if (isFolderBackgroundTarget(event.target)) return;
  closeContextMenu();
});

function applyShareLinkFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const openPath = params.get("open");
  if (openPath === null) return false;
  navigateToDrivePath(openPath);
  params.delete("open");
  const nextSearch = params.toString();
  const nextUrl = \`\${window.location.pathname}\${nextSearch ? \`?\${nextSearch}\` : ""}\`;
  window.history.replaceState({}, "", nextUrl);
  return true;
}

bindFileDrop();
bindFolderBackgroundMenu();
bindTrashDrop();
loadSidebarSectionState();
bindSidebarSectionToggles();
applySidebarSectionState();
setActiveNav();
renderBreadcrumbs(state.path);
refreshPinnedSidebar();
refreshCategoriesSidebar();
if (!applyShareLinkFromUrl()) {
  refreshListing();
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
`;

function renderManifest(): string {
  return JSON.stringify({
    name: "Storich",
    short_name: "Storich",
    description: "Self-hosted cloud storage for your files",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#f8fafc",
    theme_color: "#2563EB",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  });
}

function renderPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <meta name="theme-color" content="#2563EB">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <meta name="apple-mobile-web-app-title" content="Storich">
  <meta name="description" content="Self-hosted cloud storage for your files">
  <link rel="icon" href="/icon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="manifest" href="/manifest.webmanifest">
  <title>Storich</title>
  <style>${PAGE_STYLES}</style>
</head>
<body>
  <aside>
    <div class="brand">
      <div class="brand-badge">S</div>
      <span>Storich</span>
    </div>
    <nav class="nav">
      <button id="nav-drive" class="active" type="button">My Drive</button>
      <button id="nav-important" type="button">Important</button>
    </nav>
    <div class="sidebar-scroll">
      <div class="sidebar-section pinned-section" data-section="pinned">
        <button type="button" class="sidebar-section-toggle" aria-expanded="true" aria-controls="pinned-list">
          <span class="sidebar-section-chevron" aria-hidden="true">▾</span>
          <span class="sidebar-section-label">Pinned</span>
        </button>
        <div id="pinned-list" class="pinned-list sidebar-section-body"></div>
      </div>
      <div class="sidebar-section categories-section" data-section="categories">
        <div class="sidebar-section-header">
          <button type="button" class="sidebar-section-toggle" aria-expanded="true" aria-controls="categories-list">
            <span class="sidebar-section-chevron" aria-hidden="true">▾</span>
            <span class="sidebar-section-label">Categories</span>
          </button>
          <button id="add-category" class="categories-add" type="button" title="New category" aria-label="New category">+</button>
        </div>
        <div id="categories-list" class="categories-list sidebar-section-body"></div>
      </div>
    </div>
    <div class="sidebar-footer">
      <button id="nav-trash" class="sidebar-trash" type="button">
        <span class="sidebar-trash-icon" aria-hidden="true">🗑</span>
        <span>Trash</span>
      </button>
    </div>
  </aside>
  <main>
    <div class="search-bar">
      <label class="search">
        <span class="search-icon" aria-hidden="true">⌕</span>
        <input id="search" type="search" placeholder="Search in My Drive">
        <button id="search-options" class="search-options" type="button" aria-label="Search options" title="Search options">⚙</button>
      </label>
    </div>
    <nav id="mobile-nav" class="mobile-nav" aria-label="Main navigation">
      <div class="mobile-brand">
        <div class="brand-badge">S</div>
        <span>Storich</span>
      </div>
      <button id="mobile-nav-drive" class="active" type="button">My Drive</button>
      <button id="mobile-nav-important" type="button">Important</button>
    </nav>
    <div class="mobile-pinned sidebar-section pinned-section" data-section="pinned">
      <button type="button" class="sidebar-section-toggle" aria-expanded="true" aria-controls="mobile-pinned-list">
        <span class="sidebar-section-chevron" aria-hidden="true">▾</span>
        <span class="sidebar-section-label">Pinned</span>
      </button>
      <div id="mobile-pinned-list" class="pinned-list sidebar-section-body"></div>
    </div>
    <div class="mobile-categories sidebar-section categories-section" data-section="categories">
      <div class="sidebar-section-header">
        <button type="button" class="sidebar-section-toggle" aria-expanded="true" aria-controls="mobile-categories-list">
          <span class="sidebar-section-chevron" aria-hidden="true">▾</span>
          <span class="sidebar-section-label">Categories</span>
        </button>
        <button id="mobile-add-category" class="categories-add" type="button" title="New category" aria-label="New category">+</button>
      </div>
      <div id="mobile-categories-list" class="categories-list sidebar-section-body"></div>
    </div>
    <div class="mobile-trash">
      <button id="mobile-nav-trash" class="sidebar-trash" type="button">
        <span class="sidebar-trash-icon" aria-hidden="true">🗑</span>
        <span>Trash</span>
      </button>
    </div>
    <div class="topbar">
      <div class="toolbar toolbar-trash">
        <button id="empty-trash" class="secondary" type="button">Empty trash</button>
      </div>
    </div>
    <input id="upload-input" type="file" multiple hidden>
    <div id="content" class="content">
      <div id="error" class="error" hidden></div>
      <div id="breadcrumbs" class="breadcrumbs"></div>
      <div id="status" class="status"></div>
      <div id="files" class="grid"></div>
      <div id="drop-overlay" class="drop-overlay" aria-hidden="true">
        <div class="drop-overlay-inner">
          <div class="drop-overlay-icon">⬆</div>
          <div>Drop files to upload to <strong id="drop-location">My Drive</strong></div>
        </div>
      </div>
    </div>
  </main>
  <div id="context-menu" class="context-menu" role="menu" aria-hidden="true"></div>
  <div id="search-options-dialog" class="dialog-backdrop" aria-hidden="true">
    <div class="dialog" role="dialog" aria-labelledby="search-options-title">
      <h2 id="search-options-title">Search options</h2>
      <label class="search-option-field">
        <span>File type</span>
        <select id="file-filter" class="file-filter" aria-label="Filter by file type">
          <option value="all">All types</option>
          <option value="folder">Folders</option>
          <option value="image">Images</option>
          <option value="video">Videos</option>
          <option value="audio">Audio</option>
          <option value="document">Documents</option>
          <option value="spreadsheet">Spreadsheets</option>
          <option value="presentation">Presentations</option>
          <option value="archive">Archives</option>
          <option value="code">Code</option>
          <option value="file">Other files</option>
        </select>
      </label>
      <div class="dialog-actions">
        <button id="search-options-close" class="primary" type="button">Done</button>
      </div>
    </div>
  </div>
  <div id="new-folder-dialog" class="dialog-backdrop" aria-hidden="true">
    <div class="dialog" role="dialog" aria-labelledby="new-folder-title">
      <h2 id="new-folder-title">New folder</h2>
      <p>Create in <span id="new-folder-location">My Drive</span></p>
      <input id="new-folder-name" type="text" placeholder="Folder name" autocomplete="off" maxlength="255">
      <div class="dialog-actions">
        <button id="new-folder-cancel" class="secondary" type="button">Cancel</button>
        <button id="new-folder-create" class="primary" type="button">Create</button>
      </div>
    </div>
  </div>
  <div id="category-dialog" class="dialog-backdrop" aria-hidden="true">
    <div class="dialog" role="dialog" aria-labelledby="category-dialog-title">
      <h2 id="category-dialog-title">New category</h2>
      <input id="category-name-input" type="text" placeholder="Category name" autocomplete="off" maxlength="255">
      <div class="dialog-actions">
        <button id="category-cancel" class="secondary" type="button">Cancel</button>
        <button id="category-submit" class="primary" type="button">Create</button>
      </div>
    </div>
  </div>
  <div id="rename-dialog" class="dialog-backdrop" aria-hidden="true">
    <div class="dialog" role="dialog" aria-labelledby="rename-title">
      <h2 id="rename-title">Rename</h2>
      <p>Rename <strong id="rename-current-name"></strong></p>
      <div class="rename-field">
        <input id="rename-input" type="text" placeholder="New name" autocomplete="off" maxlength="255">
        <span id="rename-extension" class="rename-extension" hidden></span>
      </div>
      <div class="dialog-actions">
        <button id="rename-cancel" class="secondary" type="button">Cancel</button>
        <button id="rename-submit" class="primary" type="button">Rename</button>
      </div>
    </div>
  </div>
  <div id="preview-dialog" class="preview-backdrop" aria-hidden="true">
    <div class="preview-panel" role="dialog" aria-labelledby="preview-title">
      <div class="preview-header">
        <h2 id="preview-title">Preview</h2>
        <button id="preview-close" type="button">Close</button>
      </div>
      <div class="preview-stage">
        <button id="preview-prev" class="preview-nav" type="button" aria-label="Previous image">‹</button>
        <div id="preview-image-wrap" class="preview-image-wrap">
          <img id="preview-image" alt="">
        </div>
        <button id="preview-next" class="preview-nav" type="button" aria-label="Next image">›</button>
      </div>
      <div id="preview-counter" class="preview-counter"></div>
    </div>
  </div>
  <div class="app-version" aria-hidden="true">v${APP_VERSION}</div>
  <script>${PAGE_SCRIPT}</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderErrorPage(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Storich</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font-family: system-ui, sans-serif;
      background: #f8fafc;
      color: #0f172a;
      padding: 1.5rem;
    }
    main {
      max-width: 36rem;
      background: white;
      border: 1px solid #e2e8f0;
      border-radius: 1rem;
      padding: 1.5rem;
    }
    h1 { margin-top: 0; }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      background: #fef2f2;
      color: #b91c1c;
      padding: 1rem;
      border-radius: 0.75rem;
    }
  </style>
</head>
<body>
  <main>
    <h1>Storich could not start</h1>
    <pre>${escapeHtml(message)}</pre>
  </main>
</body>
</html>`;
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
  });
  res.end(body);
}

function sendBytes(
  res: ServerResponse,
  statusCode: number,
  contentType: string,
  body: Buffer,
  downloadName?: string,
): void {
  const headers: Record<string, string | number> = {
    "Content-Type": contentType,
    "Content-Length": body.length,
  };
  if (downloadName) {
    const asciiFallback = downloadName.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
    const encoded = encodeURIComponent(downloadName);
    headers["Content-Disposition"] =
      `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
  }
  res.writeHead(statusCode, headers);
  res.end(body);
}

const MIME_TYPES: Record<string, string> = {
  ".txt": "text/plain",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
};

function guessMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

function splitBuffer(buffer: Buffer, delimiter: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  let index = buffer.indexOf(delimiter, start);
  while (index !== -1) {
    if (index > start) {
      parts.push(buffer.subarray(start, index));
    }
    start = index + delimiter.length;
    index = buffer.indexOf(delimiter, start);
  }
  if (start < buffer.length) {
    parts.push(buffer.subarray(start));
  }
  return parts;
}

function parseMultipartUpload(
  contentType: string,
  body: Buffer,
): { pathValue: string; fileName: string; fileData: Buffer } {
  if (!contentType.startsWith("multipart/form-data")) {
    throw new Error("expected multipart form data");
  }

  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/);
  if (!match) {
    throw new Error("missing multipart boundary");
  }

  const boundary = Buffer.from(`--${match[1] ?? match[2]}`);
  let pathValue = "";
  let fileName: string | null = null;
  let fileData = Buffer.alloc(0);

  for (const part of splitBuffer(body, boundary)) {
    if (!part.includes(Buffer.from("Content-Disposition"))) {
      continue;
    }
    const separator = part.indexOf(Buffer.from("\r\n\r\n"));
    if (separator === -1) {
      continue;
    }
    const headerBlock = part.subarray(0, separator).toString("utf8");
    let content = part.subarray(separator + 4);
    if (content.length >= 2 && content.subarray(-2).equals(Buffer.from("\r\n"))) {
      content = content.subarray(0, -2);
    }
    if (headerBlock.includes('name="path"')) {
      pathValue = content.toString("utf8");
    } else if (headerBlock.includes('name="file"')) {
      const filenameMatch = headerBlock.match(/filename="([^"]*)"/);
      if (filenameMatch) {
        fileName = filenameMatch[1];
      }
      fileData = Buffer.from(content);
    }
  }

  if (!fileName) {
    throw new Error("file is required");
  }
  return { pathValue, fileName, fileData };
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function queryParam(url: URL, name: string): string {
  return url.searchParams.get(name) ?? "";
}

async function handleGet(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const route = url.pathname;

  if (route === "/health" || route === "/healthz") {
    sendBytes(res, 200, "text/plain; charset=utf-8", Buffer.from("ok"));
    return;
  }

  await ensureDataRoot();

  if (route === "/api/important") {
    try {
      const payload = await listImportant();
      sendJson(res, 200, payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { error: message });
    }
    return;
  }

  if (route === "/api/pinned") {
    try {
      const payload = await listPinned();
      sendJson(res, 200, payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { error: message });
    }
    return;
  }

  if (route === "/api/categories") {
    try {
      const payload = await listCategories();
      sendJson(res, 200, payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { error: message });
    }
    return;
  }

  if (route === "/api/categories/items") {
    try {
      const categoryId = queryParam(url, "category").trim();
      if (!categoryId) {
        sendJson(res, 400, { error: "category is required" });
        return;
      }
      const payload = await listCategoryItems(categoryId);
      sendJson(res, 200, payload);
    } catch (error) {
      if (error instanceof FileNotFoundError) {
        sendJson(res, 404, { error: "category not found" });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 500, { error: message });
      }
    }
    return;
  }

  if (route === "/api/files") {
    try {
      const payload = await listDirectoryWithMarkers(queryParam(url, "path"));
      sendJson(res, 200, payload);
    } catch (error) {
      if (error instanceof FileNotFoundError) {
        sendJson(res, 404, { error: "folder not found" });
      } else if (error instanceof Error && error.message === "invalid path") {
        sendJson(res, 400, { error: error.message });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 500, { error: message });
      }
    }
    return;
  }

  if (route === "/api/view") {
    try {
      const { absPath } = safePath(queryParam(url, "path"));
      const fileStat = await stat(absPath);
      if (!fileStat.isFile()) {
        sendJson(res, 404, { error: "file not found" });
        return;
      }
      const data = await readFile(absPath);
      sendBytes(res, 200, guessMimeType(absPath), data);
    } catch (error) {
      if (error instanceof Error && error.message === "invalid path") {
        sendJson(res, 400, { error: error.message });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 500, { error: message });
      }
    }
    return;
  }

  if (route === "/api/download") {
    try {
      const { absPath } = safePath(queryParam(url, "path"));
      const fileStat = await stat(absPath);
      if (!fileStat.isFile()) {
        sendJson(res, 404, { error: "file not found" });
        return;
      }
      const data = await readFile(absPath);
      sendBytes(res, 200, "application/octet-stream", data, path.basename(absPath));
    } catch (error) {
      if (error instanceof Error && error.message === "invalid path") {
        sendJson(res, 400, { error: error.message });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 500, { error: message });
      }
    }
    return;
  }

  if (route === "/api/trash") {
    try {
      const payload = await listTrash();
      sendJson(res, 200, payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { error: message });
    }
    return;
  }

  if (route === "/api/trash/view") {
    try {
      const id = queryParam(url, "id");
      const items = await readTrashIndex();
      const item = items.find((entry) => entry.id === id);
      if (!item) {
        sendJson(res, 404, { error: "trash item not found" });
        return;
      }
      const absPath = path.join(TRASH_ITEMS_DIR, item.storageName);
      const fileStat = await stat(absPath);
      if (!fileStat.isFile()) {
        sendJson(res, 404, { error: "file not found" });
        return;
      }
      const data = await readFile(absPath);
      sendBytes(res, 200, guessMimeType(item.name), data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { error: message });
    }
    return;
  }

  if (route === "/api/trash/download") {
    try {
      const id = queryParam(url, "id");
      const items = await readTrashIndex();
      const item = items.find((entry) => entry.id === id);
      if (!item) {
        sendJson(res, 404, { error: "trash item not found" });
        return;
      }
      const absPath = path.join(TRASH_ITEMS_DIR, item.storageName);
      const fileStat = await stat(absPath);
      if (!fileStat.isFile()) {
        sendJson(res, 404, { error: "file not found" });
        return;
      }
      const data = await readFile(absPath);
      sendBytes(res, 200, "application/octet-stream", data, item.name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { error: message });
    }
    return;
  }

  if (route === "/manifest.webmanifest") {
    sendBytes(res, 200, "application/manifest+json", Buffer.from(renderManifest()));
    return;
  }

  if (route === "/sw.js") {
    sendBytes(res, 200, "application/javascript; charset=utf-8", Buffer.from(SERVICE_WORKER));
    return;
  }

  const pwaIcon = PWA_ICONS[route];
  if (pwaIcon) {
    try {
      const icon = await readFile(path.join(__dirname, pwaIcon.file));
      sendBytes(res, 200, pwaIcon.type, icon);
    } catch {
      sendJson(res, 404, { error: "icon not found" });
    }
    return;
  }

  if (route === "/icon.svg" || route === "/favicon.ico") {
    try {
      const icon = await readFile(ICON_PATH);
      sendBytes(res, 200, "image/svg+xml", icon);
    } catch {
      sendJson(res, 404, { error: "icon not found" });
    }
    return;
  }

  if (route === "/") {
    sendBytes(res, 200, "text/html; charset=utf-8", Buffer.from(renderPage()));
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

async function handlePost(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const route = url.pathname;
  await ensureDataRoot();

  if (route === "/api/mkdir") {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body.toString("utf8") || "{}") as { path?: string; name?: string };
      const parent = payload.path ?? "";
      const name = (payload.name ?? "").trim();
      const nameError = validateEntryName(name);
      if (nameError) {
        sendJson(res, 400, { error: "invalid folder name" });
        return;
      }
      const { absPath: parentAbs, relPath: parentRel } = safePath(parent);
      const targetAbs = path.join(parentAbs, name);
      const targetRel = parentRel ? `${parentRel}/${name}` : name;
      await mkdir(parentAbs, { recursive: true });
      await mkdir(targetAbs, { recursive: false });
      sendJson(res, 201, { entry: await fileEntry(targetAbs, targetRel) });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
        sendJson(res, 409, { error: "folder already exists" });
      } else if (error instanceof Error && error.message === "invalid path") {
        sendJson(res, 400, { error: error.message });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 500, { error: message });
      }
    }
    return;
  }

  if (route === "/api/upload") {
    try {
      const contentType = req.headers["content-type"] ?? "";
      const body = await readBody(req);
      const { pathValue, fileName, fileData } = parseMultipartUpload(contentType, body);
      const filename = path.basename(fileName);
      const fileNameError = validateEntryName(filename);
      if (fileNameError) {
        sendJson(res, 400, { error: "invalid file name" });
        return;
      }
      const { absPath: parentAbs, relPath: parentRel } = safePath(pathValue);
      const targetAbs = path.join(parentAbs, filename);
      const targetRel = parentRel ? `${parentRel}/${filename}` : filename;
      await writeFile(targetAbs, fileData);
      sendJson(res, 201, { entry: await fileEntry(targetAbs, targetRel) });
    } catch (error) {
      if (error instanceof Error && (error.message === "invalid path" || error.message.includes("multipart"))) {
        sendJson(res, 400, { error: error.message });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 500, { error: message });
      }
    }
    return;
  }

  if (route === "/api/mark-important") {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body.toString("utf8") || "{}") as { path?: string };
      const relPath = (payload.path ?? "").trim();
      if (!relPath) {
        sendJson(res, 400, { error: "path is required" });
        return;
      }
      const item = await markImportantEntry(relPath);
      sendJson(res, 200, { item });
    } catch (error) {
      if (error instanceof FileNotFoundError) {
        sendJson(res, 404, { error: "item not found" });
      } else if (error instanceof Error && error.message === "invalid path") {
        sendJson(res, 400, { error: error.message });
      } else if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        sendJson(res, 404, { error: "item not found" });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 400, { error: message });
      }
    }
    return;
  }

  if (route === "/api/unmark-important") {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body.toString("utf8") || "{}") as { path?: string };
      const relPath = (payload.path ?? "").trim();
      if (!relPath) {
        sendJson(res, 400, { error: "path is required" });
        return;
      }
      await unmarkImportantEntry(relPath);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      if (error instanceof FileNotFoundError) {
        sendJson(res, 404, { error: "important marker not found" });
      } else if (error instanceof Error && error.message === "invalid path") {
        sendJson(res, 400, { error: error.message });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 400, { error: message });
      }
    }
    return;
  }

  if (route === "/api/pin") {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body.toString("utf8") || "{}") as { path?: string };
      const relPath = (payload.path ?? "").trim();
      if (!relPath) {
        sendJson(res, 400, { error: "path is required" });
        return;
      }
      const item = await pinEntry(relPath);
      sendJson(res, 200, { item });
    } catch (error) {
      if (error instanceof FileNotFoundError) {
        sendJson(res, 404, { error: "item not found" });
      } else if (error instanceof Error && error.message === "invalid path") {
        sendJson(res, 400, { error: error.message });
      } else if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        sendJson(res, 404, { error: "item not found" });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 400, { error: message });
      }
    }
    return;
  }

  if (route === "/api/unpin") {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body.toString("utf8") || "{}") as { path?: string };
      const relPath = (payload.path ?? "").trim();
      if (!relPath) {
        sendJson(res, 400, { error: "path is required" });
        return;
      }
      await unpinEntry(relPath);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      if (error instanceof FileNotFoundError) {
        sendJson(res, 404, { error: "pin not found" });
      } else if (error instanceof Error && error.message === "invalid path") {
        sendJson(res, 400, { error: error.message });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 400, { error: message });
      }
    }
    return;
  }

  if (route === "/api/categories/create") {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body.toString("utf8") || "{}") as { name?: string };
      const name = (payload.name ?? "").trim();
      if (!name) {
        sendJson(res, 400, { error: "name is required" });
        return;
      }
      const category = await createCategory(name);
      sendJson(res, 201, { category });
    } catch (error) {
      if (error instanceof Error && error.message === "invalid name") {
        sendJson(res, 400, { error: error.message });
      } else if (error instanceof Error && error.message === "category already exists") {
        sendJson(res, 409, { error: error.message });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 400, { error: message });
      }
    }
    return;
  }

  if (route === "/api/categories/rename") {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body.toString("utf8") || "{}") as { id?: string; name?: string };
      const id = (payload.id ?? "").trim();
      const name = (payload.name ?? "").trim();
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
      if (error instanceof FileNotFoundError) {
        sendJson(res, 404, { error: "category not found" });
      } else if (error instanceof Error && error.message === "invalid name") {
        sendJson(res, 400, { error: error.message });
      } else if (error instanceof Error && error.message === "category already exists") {
        sendJson(res, 409, { error: error.message });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 400, { error: message });
      }
    }
    return;
  }

  if (route === "/api/categories/delete") {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body.toString("utf8") || "{}") as { id?: string };
      const id = (payload.id ?? "").trim();
      if (!id) {
        sendJson(res, 400, { error: "id is required" });
        return;
      }
      await deleteCategory(id);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      if (error instanceof FileNotFoundError) {
        sendJson(res, 404, { error: "category not found" });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 400, { error: message });
      }
    }
    return;
  }

  if (route === "/api/categories/assign") {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body.toString("utf8") || "{}") as { path?: string; categoryId?: string };
      const relPath = (payload.path ?? "").trim();
      const categoryId = (payload.categoryId ?? "").trim();
      if (!relPath) {
        sendJson(res, 400, { error: "path is required" });
        return;
      }
      if (!categoryId) {
        sendJson(res, 400, { error: "categoryId is required" });
        return;
      }
      const item = await assignCategoryEntry(relPath, categoryId);
      sendJson(res, 200, { item });
    } catch (error) {
      if (error instanceof FileNotFoundError) {
        sendJson(res, 404, { error: "item or category not found" });
      } else if (error instanceof Error && error.message === "invalid path") {
        sendJson(res, 400, { error: error.message });
      } else if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        sendJson(res, 404, { error: "item not found" });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 400, { error: message });
      }
    }
    return;
  }

  if (route === "/api/categories/unassign") {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body.toString("utf8") || "{}") as { path?: string; categoryId?: string };
      const relPath = (payload.path ?? "").trim();
      const categoryId = (payload.categoryId ?? "").trim();
      if (!relPath) {
        sendJson(res, 400, { error: "path is required" });
        return;
      }
      if (!categoryId) {
        sendJson(res, 400, { error: "categoryId is required" });
        return;
      }
      await unassignCategoryEntry(relPath, categoryId);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      if (error instanceof FileNotFoundError) {
        sendJson(res, 404, { error: "category assignment not found" });
      } else if (error instanceof Error && error.message === "invalid path") {
        sendJson(res, 400, { error: error.message });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 400, { error: message });
      }
    }
    return;
  }

  if (route === "/api/rename") {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body.toString("utf8") || "{}") as { path?: string; name?: string };
      const relPath = (payload.path ?? "").trim();
      const name = (payload.name ?? "").trim();
      if (!relPath) {
        sendJson(res, 400, { error: "path is required" });
        return;
      }
      if (!name) {
        sendJson(res, 400, { error: "name is required" });
        return;
      }
      const entry = await renameEntry(relPath, name);
      sendJson(res, 200, { entry });
    } catch (error) {
      if (error instanceof FileNotFoundError) {
        sendJson(res, 404, { error: "item not found" });
      } else if (error instanceof Error && error.message === "invalid path") {
        sendJson(res, 400, { error: error.message });
      } else if (error instanceof Error && error.message === "invalid name") {
        sendJson(res, 400, { error: error.message });
      } else if (error instanceof Error && error.message === "name already exists") {
        sendJson(res, 409, { error: error.message });
      } else if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        sendJson(res, 404, { error: "item not found" });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 400, { error: message });
      }
    }
    return;
  }

  if (route === "/api/move") {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body.toString("utf8") || "{}") as { path?: string; destination?: string };
      const relPath = (payload.path ?? "").trim();
      const destination = (payload.destination ?? "").trim();
      if (!relPath) {
        sendJson(res, 400, { error: "path is required" });
        return;
      }
      const entry = await moveEntry(relPath, destination);
      sendJson(res, 200, { entry });
    } catch (error) {
      if (error instanceof FileNotFoundError) {
        sendJson(res, 404, { error: "item not found" });
      } else if (error instanceof Error && error.message === "invalid path") {
        sendJson(res, 400, { error: error.message });
      } else if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        sendJson(res, 404, { error: "item not found" });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 400, { error: message });
      }
    }
    return;
  }

  if (route === "/api/delete") {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body.toString("utf8") || "{}") as { path?: string };
      const relPath = (payload.path ?? "").trim();
      if (!relPath) {
        sendJson(res, 400, { error: "path is required" });
        return;
      }
      const item = await moveToTrash(relPath);
      sendJson(res, 200, { item });
    } catch (error) {
      if (error instanceof FileNotFoundError) {
        sendJson(res, 404, { error: "item not found" });
      } else if (error instanceof Error && error.message === "invalid path") {
        sendJson(res, 400, { error: error.message });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 500, { error: message });
      }
    }
    return;
  }

  if (route === "/api/trash/restore") {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body.toString("utf8") || "{}") as { id?: string };
      const id = (payload.id ?? "").trim();
      if (!id) {
        sendJson(res, 400, { error: "id is required" });
        return;
      }
      const entry = await restoreFromTrash(id);
      sendJson(res, 200, { entry });
    } catch (error) {
      if (error instanceof FileNotFoundError) {
        sendJson(res, 404, { error: "trash item not found" });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 500, { error: message });
      }
    }
    return;
  }

  if (route === "/api/trash/delete") {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body.toString("utf8") || "{}") as { id?: string };
      const id = (payload.id ?? "").trim();
      if (!id) {
        sendJson(res, 400, { error: "id is required" });
        return;
      }
      await deleteTrashItem(id);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      if (error instanceof FileNotFoundError) {
        sendJson(res, 404, { error: "trash item not found" });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 500, { error: message });
      }
    }
    return;
  }

  if (route === "/api/trash/empty") {
    try {
      const count = await emptyTrash();
      sendJson(res, 200, { count });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { error: message });
    }
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  try {
    if (req.method === "GET") {
      await handleGet(req, res, url);
      return;
    }

    if (req.method === "POST") {
      await handlePost(req, res, url);
      return;
    }

    sendJson(res, 405, { error: "method not allowed" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (req.method === "GET" && url.pathname === "/") {
      sendBytes(res, 503, "text/html; charset=utf-8", Buffer.from(renderErrorPage(message)));
    } else {
      sendJson(res, 500, { error: message });
    }
  }
});

const port = Number(process.env.PORT ?? "3000");

ensureDataRoot().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`storich: data directory unavailable: ${message}`);
});

console.log(`storich: listening on 0.0.0.0:${port}`);
server.listen(port, "0.0.0.0");