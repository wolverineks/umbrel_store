import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

export type SyncConfig = {
  remoteUrl: string;
  syncToken: string;
};

export type SyncFileEntry = {
  path: string;
  size: number;
  modified: string;
};

export type SyncResult = {
  pulled: number;
  pushed: number;
  errors: string[];
};

type SyncContext = {
  dataRoot: string;
  safePath: (relativePath?: string) => { absPath: string; relPath: string };
  validateEntryName: (name: string) => string | null;
  sendJson: (res: ServerResponse, statusCode: number, payload: unknown) => void;
  sendBytes: (
    res: ServerResponse,
    statusCode: number,
    contentType: string,
    body: Buffer,
    downloadName?: string,
  ) => void;
  readBody: (req: IncomingMessage) => Promise<Buffer>;
  parseMultipartUpload: (
    contentType: string,
    body: Buffer,
  ) => { pathValue: string; fileName: string; fileData: Buffer };
};

const SYNC_DIR = ".sync";
let syncRunning = false;
let lastResult: SyncResult | null = null;
let lastRunAt: string | null = null;

function syncRoot(dataRoot: string): string {
  return path.join(dataRoot, SYNC_DIR);
}

function configFile(dataRoot: string): string {
  return path.join(syncRoot(dataRoot), "config.json");
}

function isExcluded(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\//, "");
  return normalized === ".trash" || normalized.startsWith(".trash/")
    || normalized === SYNC_DIR || normalized.startsWith(`${SYNC_DIR}/`);
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function token(config: SyncConfig): string {
  return (process.env.STORICH_SYNC_TOKEN ?? config.syncToken).trim();
}

function readToken(req: IncomingMessage): string {
  const header = req.headers["x-storich-sync-token"];
  if (typeof header === "string") return header.trim();
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return auth.slice(7).trim();
  }
  return "";
}

function authHeaders(config: SyncConfig): Record<string, string> {
  const value = token(config);
  return value ? { "X-Storich-Sync-Token": value } : {};
}

export async function readSyncConfig(dataRoot: string): Promise<SyncConfig> {
  await mkdir(syncRoot(dataRoot), { recursive: true });
  const filePath = configFile(dataRoot);
  if (!existsSync(filePath)) {
    const config = { remoteUrl: "", syncToken: randomBytes(24).toString("hex") };
    await writeSyncConfig(dataRoot, config);
    return config;
  }
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<SyncConfig>;
  return {
    remoteUrl: normalizeUrl(String(parsed.remoteUrl ?? "")),
    syncToken: String(parsed.syncToken ?? randomBytes(24).toString("hex")),
  };
}

export async function writeSyncConfig(dataRoot: string, config: SyncConfig): Promise<void> {
  await mkdir(syncRoot(dataRoot), { recursive: true });
  await writeFile(configFile(dataRoot), JSON.stringify({
    remoteUrl: normalizeUrl(config.remoteUrl),
    syncToken: config.syncToken.trim(),
  }, null, 2));
}

async function listFiles(dataRoot: string): Promise<SyncFileEntry[]> {
  const files: SyncFileEntry[] = [];

  async function walk(absDir: string, relDir: string): Promise<void> {
    for (const name of await readdir(absDir)) {
      if (name.startsWith(".")) continue;
      const relPath = relDir ? `${relDir}/${name}` : name;
      if (isExcluded(relPath)) continue;
      const absPath = path.join(absDir, name);
      const fileStat = await stat(absPath);
      if (fileStat.isDirectory()) {
        await walk(absPath, relPath);
        continue;
      }
      files.push({
        path: relPath,
        size: fileStat.size,
        modified: new Date(fileStat.mtimeMs).toISOString(),
      });
    }
  }

  await walk(dataRoot, "");
  return files;
}

async function ensureParent(ctx: SyncContext, relPath: string): Promise<void> {
  const parent = path.posix.dirname(relPath.replace(/\\/g, "/"));
  if (!parent || parent === ".") return;
  const { absPath } = ctx.safePath(parent);
  await mkdir(absPath, { recursive: true });
}

async function fetchRemoteFiles(config: SyncConfig): Promise<SyncFileEntry[]> {
  const base = normalizeUrl(config.remoteUrl);
  if (!base) throw new Error("remote URL is not configured");
  const response = await fetch(`${base}/api/sync/files`, { headers: authHeaders(config) });
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || "could not reach remote instance");
  }
  const payload = (await response.json()) as { files?: SyncFileEntry[] };
  return Array.isArray(payload.files) ? payload.files : [];
}

async function pullFile(ctx: SyncContext, config: SyncConfig, relPath: string): Promise<void> {
  const base = normalizeUrl(config.remoteUrl);
  const response = await fetch(
    `${base}/api/sync/file?path=${encodeURIComponent(relPath)}`,
    { headers: authHeaders(config) },
  );
  if (!response.ok) throw new Error(`could not pull ${relPath}`);
  await ensureParent(ctx, relPath);
  const { absPath } = ctx.safePath(relPath);
  await writeFile(absPath, Buffer.from(await response.arrayBuffer()));
}

async function pushFile(ctx: SyncContext, config: SyncConfig, relPath: string): Promise<void> {
  const { absPath } = ctx.safePath(relPath);
  const fileData = await readFile(absPath);
  const parent = path.posix.dirname(relPath.replace(/\\/g, "/"));
  const fileName = path.posix.basename(relPath);
  const boundary = `storich-${randomBytes(6).toString("hex")}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="path"\r\n\r\n${parent === "." ? "" : parent}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\n\r\n`),
    fileData,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const base = normalizeUrl(config.remoteUrl);
  const response = await fetch(`${base}/api/sync/file`, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      ...authHeaders(config),
    },
    body,
  });
  if (!response.ok) throw new Error(`could not push ${relPath}`);
}

function isRemoteNewer(local: SyncFileEntry, remote: SyncFileEntry): boolean {
  const localTime = new Date(local.modified).getTime();
  const remoteTime = new Date(remote.modified).getTime();
  if (remoteTime !== localTime) return remoteTime > localTime;
  return remote.size !== local.size;
}

function isLocalNewer(local: SyncFileEntry, remote: SyncFileEntry): boolean {
  const localTime = new Date(local.modified).getTime();
  const remoteTime = new Date(remote.modified).getTime();
  if (localTime !== remoteTime) return localTime > remoteTime;
  return local.size !== remote.size;
}

export async function runSync(ctx: SyncContext): Promise<SyncResult> {
  if (syncRunning) throw new Error("sync already running");
  syncRunning = true;
  lastRunAt = new Date().toISOString();
  const result: SyncResult = { pulled: 0, pushed: 0, errors: [] };

  try {
    const config = await readSyncConfig(ctx.dataRoot);
    if (!config.remoteUrl) throw new Error("remote URL is not configured");

    const localFiles = await listFiles(ctx.dataRoot);
    const remoteFiles = await fetchRemoteFiles(config);
    const localMap = new Map(localFiles.map((file) => [file.path, file]));
    const remoteMap = new Map(remoteFiles.map((file) => [file.path, file]));

    for (const [relPath, remote] of remoteMap) {
      const local = localMap.get(relPath);
      if (!local) {
        try {
          await pullFile(ctx, config, relPath);
          result.pulled += 1;
        } catch (error) {
          result.errors.push(error instanceof Error ? error.message : String(error));
        }
        continue;
      }
      if (local.size === remote.size && local.modified === remote.modified) continue;
      if (isRemoteNewer(local, remote)) {
        try {
          await pullFile(ctx, config, relPath);
          result.pulled += 1;
        } catch (error) {
          result.errors.push(error instanceof Error ? error.message : String(error));
        }
      }
    }

    for (const [relPath, local] of localMap) {
      const remote = remoteMap.get(relPath);
      if (!remote) {
        try {
          await pushFile(ctx, config, relPath);
          result.pushed += 1;
        } catch (error) {
          result.errors.push(error instanceof Error ? error.message : String(error));
        }
        continue;
      }
      if (local.size === remote.size && local.modified === remote.modified) continue;
      if (isLocalNewer(local, remote)) {
        try {
          await pushFile(ctx, config, relPath);
          result.pushed += 1;
        } catch (error) {
          result.errors.push(error instanceof Error ? error.message : String(error));
        }
      }
    }

    lastResult = result;
    return result;
  } finally {
    syncRunning = false;
  }
}

function verify(req: IncomingMessage, config: SyncConfig): boolean {
  const expected = token(config);
  return Boolean(expected) && readToken(req) === expected;
}

export async function handleSyncGet(
  ctx: SyncContext,
  req: IncomingMessage,
  res: ServerResponse,
  route: string,
  queryParam: (name: string) => string,
): Promise<boolean> {
  if (route === "/api/sync/config") {
    const config = await readSyncConfig(ctx.dataRoot);
    ctx.sendJson(res, 200, {
      remoteUrl: config.remoteUrl,
      syncToken: config.syncToken,
      envTokenConfigured: Boolean(process.env.STORICH_SYNC_TOKEN?.trim()),
      lastRunAt,
      lastResult,
      running: syncRunning,
    });
    return true;
  }

  if (route === "/api/sync/files") {
    const config = await readSyncConfig(ctx.dataRoot);
    if (!verify(req, config)) {
      ctx.sendJson(res, 401, { error: "invalid sync token" });
      return true;
    }
    ctx.sendJson(res, 200, { files: await listFiles(ctx.dataRoot) });
    return true;
  }

  if (route === "/api/sync/file") {
    const config = await readSyncConfig(ctx.dataRoot);
    if (!verify(req, config)) {
      ctx.sendJson(res, 401, { error: "invalid sync token" });
      return true;
    }
    try {
      const relPath = queryParam("path").trim();
      const { absPath } = ctx.safePath(relPath);
      const fileStat = await stat(absPath);
      if (!fileStat.isFile()) {
        ctx.sendJson(res, 404, { error: "file not found" });
        return true;
      }
      ctx.sendBytes(res, 200, "application/octet-stream", await readFile(absPath));
    } catch (error) {
      ctx.sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  return false;
}

export async function handleSyncPost(
  ctx: SyncContext,
  req: IncomingMessage,
  res: ServerResponse,
  route: string,
): Promise<boolean> {
  if (route === "/api/sync/config") {
    try {
      const body = await ctx.readBody(req);
      const payload = JSON.parse(body.toString("utf8") || "{}") as Partial<SyncConfig>;
      const config = await readSyncConfig(ctx.dataRoot);
      if (typeof payload.remoteUrl === "string") config.remoteUrl = normalizeUrl(payload.remoteUrl);
      if (typeof payload.syncToken === "string" && payload.syncToken.trim()) {
        config.syncToken = payload.syncToken.trim();
      }
      await writeSyncConfig(ctx.dataRoot, config);
      ctx.sendJson(res, 200, { ok: true });
    } catch (error) {
      ctx.sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (route === "/api/sync/run") {
    try {
      ctx.sendJson(res, 200, { result: await runSync(ctx) });
    } catch (error) {
      ctx.sendJson(res, 409, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (route === "/api/sync/file") {
    const config = await readSyncConfig(ctx.dataRoot);
    if (!verify(req, config)) {
      ctx.sendJson(res, 401, { error: "invalid sync token" });
      return true;
    }
    try {
      const contentType = req.headers["content-type"] ?? "";
      const body = await ctx.readBody(req);
      const { pathValue, fileName, fileData } = ctx.parseMultipartUpload(contentType, body);
      const filename = path.basename(fileName);
      if (ctx.validateEntryName(filename)) {
        ctx.sendJson(res, 400, { error: "invalid file name" });
        return true;
      }
      const { absPath: parentAbs } = ctx.safePath(pathValue);
      await mkdir(parentAbs, { recursive: true });
      await writeFile(path.join(parentAbs, filename), fileData);
      ctx.sendJson(res, 200, { ok: true });
    } catch (error) {
      ctx.sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  return false;
}