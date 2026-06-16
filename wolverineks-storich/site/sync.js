"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.readSyncConfig = readSyncConfig;
exports.writeSyncConfig = writeSyncConfig;
exports.runSync = runSync;
exports.handleSyncGet = handleSyncGet;
exports.handleSyncPost = handleSyncPost;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_path_1 = __importDefault(require("node:path"));
const SYNC_DIR = ".sync";
let syncRunning = false;
let lastResult = null;
let lastRunAt = null;
function syncRoot(dataRoot) {
    return node_path_1.default.join(dataRoot, SYNC_DIR);
}
function configFile(dataRoot) {
    return node_path_1.default.join(syncRoot(dataRoot), "config.json");
}
function isExcluded(relPath) {
    const normalized = relPath.replace(/\\/g, "/").replace(/^\//, "");
    return normalized === ".trash" || normalized.startsWith(".trash/")
        || normalized === SYNC_DIR || normalized.startsWith(`${SYNC_DIR}/`);
}
function normalizeUrl(url) {
    return url.trim().replace(/\/+$/, "");
}
function token(config) {
    return (process.env.STORICH_SYNC_TOKEN ?? config.syncToken).trim();
}
function readToken(req) {
    const header = req.headers["x-storich-sync-token"];
    if (typeof header === "string")
        return header.trim();
    const auth = req.headers.authorization;
    if (typeof auth === "string" && auth.startsWith("Bearer ")) {
        return auth.slice(7).trim();
    }
    return "";
}
function authHeaders(config) {
    const value = token(config);
    return value ? { "X-Storich-Sync-Token": value } : {};
}
async function readSyncConfig(dataRoot) {
    await (0, promises_1.mkdir)(syncRoot(dataRoot), { recursive: true });
    const filePath = configFile(dataRoot);
    if (!(0, node_fs_1.existsSync)(filePath)) {
        const config = { remoteUrl: "", syncToken: (0, node_crypto_1.randomBytes)(24).toString("hex") };
        await writeSyncConfig(dataRoot, config);
        return config;
    }
    const parsed = JSON.parse(await (0, promises_1.readFile)(filePath, "utf8"));
    return {
        remoteUrl: normalizeUrl(String(parsed.remoteUrl ?? "")),
        syncToken: String(parsed.syncToken ?? (0, node_crypto_1.randomBytes)(24).toString("hex")),
    };
}
async function writeSyncConfig(dataRoot, config) {
    await (0, promises_1.mkdir)(syncRoot(dataRoot), { recursive: true });
    await (0, promises_1.writeFile)(configFile(dataRoot), JSON.stringify({
        remoteUrl: normalizeUrl(config.remoteUrl),
        syncToken: config.syncToken.trim(),
    }, null, 2));
}
async function listFiles(dataRoot) {
    const files = [];
    async function walk(absDir, relDir) {
        for (const name of await (0, promises_1.readdir)(absDir)) {
            if (name.startsWith("."))
                continue;
            const relPath = relDir ? `${relDir}/${name}` : name;
            if (isExcluded(relPath))
                continue;
            const absPath = node_path_1.default.join(absDir, name);
            const fileStat = await (0, promises_1.stat)(absPath);
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
async function ensureParent(ctx, relPath) {
    const parent = node_path_1.default.posix.dirname(relPath.replace(/\\/g, "/"));
    if (!parent || parent === ".")
        return;
    const { absPath } = ctx.safePath(parent);
    await (0, promises_1.mkdir)(absPath, { recursive: true });
}
async function fetchRemoteFiles(config) {
    const base = normalizeUrl(config.remoteUrl);
    if (!base)
        throw new Error("remote URL is not configured");
    const response = await fetch(`${base}/api/sync/files`, { headers: authHeaders(config) });
    if (!response.ok) {
        const data = (await response.json().catch(() => ({})));
        throw new Error(data.error || "could not reach remote instance");
    }
    const payload = (await response.json());
    return Array.isArray(payload.files) ? payload.files : [];
}
async function pullFile(ctx, config, relPath) {
    const base = normalizeUrl(config.remoteUrl);
    const response = await fetch(`${base}/api/sync/file?path=${encodeURIComponent(relPath)}`, { headers: authHeaders(config) });
    if (!response.ok)
        throw new Error(`could not pull ${relPath}`);
    await ensureParent(ctx, relPath);
    const { absPath } = ctx.safePath(relPath);
    await (0, promises_1.writeFile)(absPath, Buffer.from(await response.arrayBuffer()));
}
async function pushFile(ctx, config, relPath) {
    const { absPath } = ctx.safePath(relPath);
    const fileData = await (0, promises_1.readFile)(absPath);
    const parent = node_path_1.default.posix.dirname(relPath.replace(/\\/g, "/"));
    const fileName = node_path_1.default.posix.basename(relPath);
    const boundary = `storich-${(0, node_crypto_1.randomBytes)(6).toString("hex")}`;
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
    if (!response.ok)
        throw new Error(`could not push ${relPath}`);
}
function isRemoteNewer(local, remote) {
    const localTime = new Date(local.modified).getTime();
    const remoteTime = new Date(remote.modified).getTime();
    if (remoteTime !== localTime)
        return remoteTime > localTime;
    return remote.size !== local.size;
}
function isLocalNewer(local, remote) {
    const localTime = new Date(local.modified).getTime();
    const remoteTime = new Date(remote.modified).getTime();
    if (localTime !== remoteTime)
        return localTime > remoteTime;
    return local.size !== remote.size;
}
async function runSync(ctx) {
    if (syncRunning)
        throw new Error("sync already running");
    syncRunning = true;
    lastRunAt = new Date().toISOString();
    const result = { pulled: 0, pushed: 0, errors: [] };
    try {
        const config = await readSyncConfig(ctx.dataRoot);
        if (!config.remoteUrl)
            throw new Error("remote URL is not configured");
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
                }
                catch (error) {
                    result.errors.push(error instanceof Error ? error.message : String(error));
                }
                continue;
            }
            if (local.size === remote.size && local.modified === remote.modified)
                continue;
            if (isRemoteNewer(local, remote)) {
                try {
                    await pullFile(ctx, config, relPath);
                    result.pulled += 1;
                }
                catch (error) {
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
                }
                catch (error) {
                    result.errors.push(error instanceof Error ? error.message : String(error));
                }
                continue;
            }
            if (local.size === remote.size && local.modified === remote.modified)
                continue;
            if (isLocalNewer(local, remote)) {
                try {
                    await pushFile(ctx, config, relPath);
                    result.pushed += 1;
                }
                catch (error) {
                    result.errors.push(error instanceof Error ? error.message : String(error));
                }
            }
        }
        lastResult = result;
        return result;
    }
    finally {
        syncRunning = false;
    }
}
function verify(req, config) {
    const expected = token(config);
    return Boolean(expected) && readToken(req) === expected;
}
async function handleSyncGet(ctx, req, res, route, queryParam) {
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
            const fileStat = await (0, promises_1.stat)(absPath);
            if (!fileStat.isFile()) {
                ctx.sendJson(res, 404, { error: "file not found" });
                return true;
            }
            ctx.sendBytes(res, 200, "application/octet-stream", await (0, promises_1.readFile)(absPath));
        }
        catch (error) {
            ctx.sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
        return true;
    }
    return false;
}
async function handleSyncPost(ctx, req, res, route) {
    if (route === "/api/sync/config") {
        try {
            const body = await ctx.readBody(req);
            const payload = JSON.parse(body.toString("utf8") || "{}");
            const config = await readSyncConfig(ctx.dataRoot);
            if (typeof payload.remoteUrl === "string")
                config.remoteUrl = normalizeUrl(payload.remoteUrl);
            if (typeof payload.syncToken === "string" && payload.syncToken.trim()) {
                config.syncToken = payload.syncToken.trim();
            }
            await writeSyncConfig(ctx.dataRoot, config);
            ctx.sendJson(res, 200, { ok: true });
        }
        catch (error) {
            ctx.sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
        return true;
    }
    if (route === "/api/sync/run") {
        try {
            ctx.sendJson(res, 200, { result: await runSync(ctx) });
        }
        catch (error) {
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
            const filename = node_path_1.default.basename(fileName);
            if (ctx.validateEntryName(filename)) {
                ctx.sendJson(res, 400, { error: "invalid file name" });
                return true;
            }
            const { absPath: parentAbs } = ctx.safePath(pathValue);
            await (0, promises_1.mkdir)(parentAbs, { recursive: true });
            await (0, promises_1.writeFile)(node_path_1.default.join(parentAbs, filename), fileData);
            ctx.sendJson(res, 200, { ok: true });
        }
        catch (error) {
            ctx.sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
        return true;
    }
    return false;
}
