"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.warmupCleanablesCache = warmupCleanablesCache;
exports.formatPhaseLabel = formatPhaseLabel;
exports.formatJobLabel = formatJobLabel;
exports.formatCycleLabel = formatCycleLabel;
exports.formatMissionStatus = formatMissionStatus;
exports.readCleanEstimateSeconds = readCleanEstimateSeconds;
exports.formatCleanEstimateLabel = formatCleanEstimateLabel;
exports.buildCloudRegionIndex = buildCloudRegionIndex;
exports.formatMissionJobLabel = formatMissionJobLabel;
exports.formatMissionTimeRemaining = formatMissionTimeRemaining;
exports.getLastError = getLastError;
exports.isMutexBusy = isMutexBusy;
exports.isDiscoveryBusy = isDiscoveryBusy;
exports.withRobot = withRobot;
exports.discoverRobots = discoverRobots;
exports.getRobotMaintenance = getRobotMaintenance;
exports.parseFavoritesFromPmaps = parseFavoritesFromPmaps;
exports.parseRoomsFromCloudPmaps = parseRoomsFromCloudPmaps;
exports.fetchCredentialsFromCloud = fetchCredentialsFromCloud;
exports.testConnection = testConnection;
exports.getRobotStatus = getRobotStatus;
exports.runRobotFavorite = runRobotFavorite;
exports.runRobotAction = runRobotAction;
exports.getRobotPreferences = getRobotPreferences;
exports.checkMqttReachable = checkMqttReachable;
exports.buildRoombaDiagnostics = buildRoombaDiagnostics;
exports.buildIrobotDiagnostics = buildIrobotDiagnostics;
exports.getDorita980Version = getDorita980Version;
exports.getIrobotDiscoveryUrl = getIrobotDiscoveryUrl;
exports.exploreIrobotDiscovery = exploreIrobotDiscovery;
exports.exploreIrobotGigyaLogin = exploreIrobotGigyaLogin;
exports.exploreIrobotCloudLogin = exploreIrobotCloudLogin;
exports.exploreIrobotSignedGet = exploreIrobotSignedGet;
exports.exploreRoomba = exploreRoomba;
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = require("node:crypto");
const node_dgram_1 = require("node:dgram");
const promises_1 = require("node:fs/promises");
const node_net_1 = require("node:net");
const node_path_1 = __importDefault(require("node:path"));
const node_util_1 = require("node:util");
const dorita980_1 = __importDefault(require("dorita980"));
const custom_favorites_js_1 = require("./custom-favorites.js");
const execFileAsync = (0, node_util_1.promisify)(node_child_process_1.execFile);
const CONNECT_TIMEOUT_MS = 15_000;
const ROBOT_READ_TIMEOUT_MS = 10_000;
const ROBOT_PMAPS_TIMEOUT_MS = 15_000;
const ROBOT_DASHBOARD_TIMEOUT_MS = 10_000;
const ROBOT_MAINTENANCE_TIMEOUT_MS = 12_000;
const CLOUD_API_TIMEOUT_MS = 12_000;
const ROBOT_OPERATION_TIMEOUT_MS = 45_000;
const ROBOT_DISCONNECT_TIMEOUT_MS = 4_000;
const MQTT_PORT = 8883;
const DISCOVERY_PORT = 5678;
const DISCOVERY_MESSAGE = Buffer.from("irobotmcs");
const DISCOVERY_TIMEOUT_MS = 4_000;
const SUBNET_SCAN_TIMEOUT_MS = 10_000;
const DATA_ROOT = process.env.ROOMBA_DATA_DIR ?? "/data";
const SPACES_CACHE_PATH = node_path_1.default.join(DATA_ROOT, "spaces-cache.json");
const FAVORITES_CACHE_PATH = node_path_1.default.join(DATA_ROOT, "favorites-cache.json");
const CLOUD_FETCH_RETRIES = 3;
const spacesCache = new Map();
const favoritesCache = new Map();
let cleanablesDiskCacheLoaded = false;
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function isRetryableCloudError(message) {
    const lower = message.toLowerCase();
    return (lower.includes("fetch failed") ||
        lower.includes("enotfound") ||
        lower.includes("econnreset") ||
        lower.includes("timeout") ||
        lower.includes("etimedout") ||
        lower.includes("socket hang up"));
}
function mergeCleanables(existing, incoming) {
    const merged = [];
    const seen = new Set();
    for (const item of [...existing, ...incoming]) {
        const key = `${item.id}:${item.name}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        merged.push(item);
    }
    return merged;
}
function isSpaceItem(item) {
    return item.source === "cloud" || item.id.startsWith("room:") || item.id.startsWith("zone:");
}
async function readCleanablesDiskCache(pathname) {
    try {
        const raw = await (0, promises_1.readFile)(pathname, "utf8");
        const parsed = JSON.parse(raw);
        const disk = {};
        for (const [blid, entry] of Object.entries(parsed)) {
            const items = Array.isArray(entry?.items)
                ? entry.items
                : Array.isArray(entry?.favorites)
                    ? entry.favorites
                    : [];
            if (items.length) {
                disk[blid] = { items, updated_at: entry.updated_at ?? new Date(0).toISOString() };
            }
        }
        return disk;
    }
    catch {
        return {};
    }
}
async function warmupCleanablesCache() {
    await ensureCleanablesDiskCacheLoaded();
}
async function ensureCleanablesDiskCacheLoaded() {
    if (cleanablesDiskCacheLoaded)
        return;
    cleanablesDiskCacheLoaded = true;
    const spacesDisk = await readCleanablesDiskCache(SPACES_CACHE_PATH);
    for (const [blid, entry] of Object.entries(spacesDisk)) {
        spacesCache.set(blid, entry.items);
    }
    const favoritesDisk = await readCleanablesDiskCache(FAVORITES_CACHE_PATH);
    for (const [blid, entry] of Object.entries(favoritesDisk)) {
        const spaces = entry.items.filter(isSpaceItem);
        const saved = entry.items.filter((item) => !isSpaceItem(item));
        if (!spacesCache.has(blid) && spaces.length)
            spacesCache.set(blid, spaces);
        if (saved.length)
            favoritesCache.set(blid, saved);
    }
}
async function persistCleanablesCache(pathname, memory, blid, items) {
    if (!items.length)
        return;
    memory.set(blid, items);
    try {
        await (0, promises_1.mkdir)(DATA_ROOT, { recursive: true });
        const disk = await readCleanablesDiskCache(pathname);
        disk[blid] = { items, updated_at: new Date().toISOString() };
        await (0, promises_1.writeFile)(pathname, JSON.stringify(disk, null, 2));
    }
    catch {
        // Ignore cache write failures.
    }
}
async function persistSpacesCache(blid, spaces) {
    await persistCleanablesCache(SPACES_CACHE_PATH, spacesCache, blid, spaces);
}
async function persistFavoritesCache(blid, favorites) {
    await persistCleanablesCache(FAVORITES_CACHE_PATH, favoritesCache, blid, favorites);
}
function getCachedSpaces(blid) {
    return spacesCache.get(blid) ?? [];
}
function getCachedFavorites(blid) {
    return favoritesCache.get(blid) ?? [];
}
function applyCachedCleanables(base, blid, reason) {
    const cachedSpaces = getCachedSpaces(blid);
    if (cachedSpaces.length) {
        base.spaces = cachedSpaces;
        base.spaces_error = reason;
    }
    const cachedFavorites = getCachedFavorites(blid);
    if (cachedFavorites.length) {
        base.favorites = cachedFavorites;
        base.favorites_error = reason;
    }
    if (base.spaces.length) {
        base.favorites = (0, custom_favorites_js_1.appendCustomFavorites)(base.favorites, base.spaces);
        if (base.favorites.length) {
            base.favorites_error = reason;
        }
    }
}
function collectSavedFavorites(localPmaps, cloudPmaps) {
    return mergeCleanables(parseFavoritesFromPmaps(localPmaps), parseFavoritesFromPmaps(cloudPmaps));
}
const PHASE_LABELS = {
    "": "Idle",
    charge: "Charging on dock",
    run: "Cleaning",
    resume: "Resuming clean",
    pause: "Paused",
    stop: "Stopped",
    dock: "Docking",
    hmUsrDock: "Heading to dock",
    hmPostMsn: "Heading home after mission",
    hmMidMsn: "Heading home to recharge",
    recharge: "Recharging",
    stuck: "Stuck",
    evac: "Emptying bin",
    new: "Starting mission",
    completed: "Mission complete",
    cancelled: "Cancelled",
    chargingerror: "Base unplugged",
};
const CYCLE_LABELS = {
    clean: "Whole-home clean",
    spot: "Spot clean",
    quick: "Quick clean",
    mop: "Mop",
    train: "Mapping run",
    manual: "Manual clean",
};
const JOB_WHEN_IDLE = {
    "": "Idle",
    charge: "Ready on dock",
    run: "Cleaning",
    resume: "Cleaning",
    pause: "Paused",
    stop: "Stopped",
    dock: "Docking",
    hmUsrDock: "Returning to dock",
    hmPostMsn: "Finishing — heading home",
    hmMidMsn: "Recharging mid-mission",
    recharge: "Recharging on dock",
    evac: "Emptying bin",
    stuck: "Needs attention",
    new: "Starting up",
    completed: "Mission finished",
    cancelled: "Cancelled",
    chargingerror: "Dock issue",
};
function formatPhaseLabel(phase) {
    const key = (phase ?? "").trim();
    if (!key)
        return PHASE_LABELS[""];
    return PHASE_LABELS[key] ?? key.replace(/([a-z])([A-Z])/g, "$1 $2");
}
function formatJobLabel(phase, cycle) {
    const cycleKey = (cycle ?? "").trim() || "none";
    const phaseKey = (phase ?? "").trim();
    if (cycleKey !== "none") {
        const base = CYCLE_LABELS[cycleKey] ?? cycleKey.charAt(0).toUpperCase() + cycleKey.slice(1).replace(/([a-z])([A-Z])/g, "$1 $2");
        if (phaseKey === "pause")
            return `${base} — paused`;
        if (phaseKey === "stop")
            return `${base} — stopped`;
        if (phaseKey === "stuck")
            return `${base} — stuck`;
        if (["hmPostMsn", "hmMidMsn", "hmUsrDock", "dock"].includes(phaseKey)) {
            return `${base} — heading home`;
        }
        if (phaseKey === "evac")
            return `${base} — emptying bin`;
        if (phaseKey === "recharge")
            return `${base} — recharging`;
        return base;
    }
    return JOB_WHEN_IDLE[phaseKey] ?? JOB_WHEN_IDLE[""];
}
/** @deprecated Use formatJobLabel(phase, cycle) for dashboard job text. */
function formatCycleLabel(cycle) {
    return formatJobLabel(null, cycle);
}
function formatMissionStatus(phase, cycle, jobLabel) {
    const resolvedJobLabel = jobLabel ?? formatJobLabel(phase, cycle);
    const phaseLabel = formatPhaseLabel(phase);
    const cycleKey = (cycle ?? "").trim() || "none";
    if (cycleKey === "none")
        return `${resolvedJobLabel} — ${phaseLabel}`;
    return `${resolvedJobLabel} — ${phaseLabel}`;
}
function cloudRegionKey(type, regionId) {
    return `${type.trim() || "rid"}:${regionId}`;
}
function parseCmdStr(cmdStr) {
    try {
        return JSON.parse(cmdStr.replace(/'/g, '"'));
    }
    catch {
        return null;
    }
}
function normalizeMissionCommandRegions(regions) {
    if (!Array.isArray(regions))
        return [];
    return regions
        .map((item) => asRecord(item))
        .filter((item) => item !== null)
        .map((item) => {
        const params = asRecord(item.params);
        return {
            region_id: String(item.region_id ?? item.id ?? "").trim(),
            region_name: String(item.region_name ?? item.name ?? "").trim(),
            region_type: String(item.region_type ?? "").trim(),
            type: String(item.type ?? "rid").trim() || "rid",
            two_pass: params?.twoPass === true,
        };
    })
        .filter((item) => item.region_id);
}
function missionCommandFromRecord(record) {
    if (!record)
        return null;
    const regions = normalizeMissionCommandRegions(record.regions);
    if (!regions.length)
        return null;
    return {
        ordered: Boolean(record.ordered === 1 || record.ordered === true),
        regions,
    };
}
function missionCommandFromSchedule(cleanSchedule2) {
    if (!Array.isArray(cleanSchedule2))
        return null;
    for (const item of cleanSchedule2) {
        const entry = asRecord(item);
        if (!entry || entry.enabled === false || typeof entry.cmdStr !== "string")
            continue;
        const parsed = parseCmdStr(entry.cmdStr);
        const command = missionCommandFromRecord(parsed);
        if (command)
            return command;
    }
    return null;
}
function resolveActiveMissionCommand(mission, lastCommand, cleanSchedule2) {
    const cycle = String(mission.cycle ?? "");
    const phase = String(mission.phase ?? "");
    if (cycle === "none" && !["run", "resume", "spot", "pause"].includes(phase)) {
        return null;
    }
    const fromLast = missionCommandFromRecord(lastCommand);
    if (fromLast)
        return fromLast;
    if (String(mission.initiator ?? "") === "schedule" || String(lastCommand.command ?? "") === "start") {
        return missionCommandFromSchedule(cleanSchedule2);
    }
    return null;
}
function readCleanEstimateSeconds(timeEstimates) {
    if (!Array.isArray(timeEstimates))
        return null;
    let fallback = null;
    for (const estimateValue of timeEstimates) {
        const estimate = asRecord(estimateValue);
        if (estimate?.unit !== "seconds" || typeof estimate.estimate !== "number")
            continue;
        const params = asRecord(estimate.params);
        if (params?.twoPass === false) {
            return estimate.estimate;
        }
        if (fallback === null) {
            fallback = estimate.estimate;
        }
    }
    return fallback;
}
function formatCleanEstimateLabel(totalSeconds) {
    const seconds = Math.max(0, Math.round(totalSeconds));
    if (seconds < 60)
        return "<1 min";
    const minutes = Math.ceil(seconds / 60);
    if (minutes < 60)
        return `~${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    return remainder ? `~${hours}h ${remainder}m` : `~${hours}h`;
}
function buildCloudRegionIndex(pmaps) {
    const index = new Map();
    if (!Array.isArray(pmaps))
        return index;
    for (const item of pmaps) {
        const entry = asRecord(item);
        if (!entry)
            continue;
        const details = asRecord(entry.active_pmapv_details);
        const regions = Array.isArray(details?.regions) ? details.regions : [];
        for (const regionValue of regions) {
            const region = asRecord(regionValue);
            if (!region)
                continue;
            const regionId = String(region.id ?? region.region_id ?? "").trim();
            const key = cloudRegionKey("rid", regionId);
            if (!regionId || index.has(key))
                continue;
            index.set(key, {
                name: String(region.name ?? region.region_name ?? "").trim() || `Room ${regionId}`,
                estimate_seconds: readCleanEstimateSeconds(region.time_estimates),
            });
        }
        const zones = Array.isArray(details?.zones) ? details.zones : [];
        for (const zoneValue of zones) {
            const zone = asRecord(zoneValue);
            if (!zone)
                continue;
            const zoneId = String(zone.id ?? zone.region_id ?? "").trim();
            const key = cloudRegionKey("zid", zoneId);
            if (!zoneId || index.has(key))
                continue;
            index.set(key, {
                name: String(zone.name ?? zone.zone_name ?? "").trim() || `Area ${zoneId}`,
                estimate_seconds: readCleanEstimateSeconds(zone.time_estimates),
            });
        }
    }
    return index;
}
function applyPhaseJobSuffix(base, phase) {
    const phaseKey = (phase ?? "").trim();
    if (phaseKey === "pause")
        return `${base} — paused`;
    if (phaseKey === "stop")
        return `${base} — stopped`;
    if (phaseKey === "stuck")
        return `${base} — stuck`;
    if (["hmPostMsn", "hmMidMsn", "hmUsrDock", "dock"].includes(phaseKey)) {
        return `${base} — heading home`;
    }
    if (phaseKey === "evac")
        return `${base} — emptying bin`;
    if (phaseKey === "recharge")
        return `${base} — recharging`;
    return base;
}
function formatMissionJobLabel(phase, cycle, command, regionIndex) {
    if (!command?.regions.length) {
        return formatJobLabel(phase, cycle);
    }
    const names = command.regions.map((region) => {
        if (region.region_name)
            return region.region_name;
        return regionIndex.get(cloudRegionKey(region.type, region.region_id))?.name ?? `Room ${region.region_id}`;
    });
    let base;
    if (names.length === 1) {
        base = `Vacuuming: ${names[0]}`;
    }
    else if (command.ordered) {
        base = `Vacuuming: ${names[0]}`;
    }
    else {
        base = `Vacuuming: ${names.join(", ")}`;
    }
    return applyPhaseJobSuffix(base, phase);
}
function formatDurationLabel(totalSeconds) {
    const seconds = Math.max(0, Math.round(totalSeconds));
    if (seconds < 60)
        return "<1 min left";
    const minutes = Math.ceil(seconds / 60);
    if (minutes < 60)
        return `${minutes} min left`;
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    return remainder ? `${hours}h ${remainder}m left` : `${hours}h left`;
}
function formatMissionTimeRemaining(mission, command, regionIndex) {
    const expireM = mission.expireM;
    if (typeof expireM === "number" && expireM > 0) {
        return formatDurationLabel(expireM * 60);
    }
    const now = Math.floor(Date.now() / 1000);
    const expireTm = mission.expireTm;
    if (typeof expireTm === "number" && expireTm > now) {
        return formatDurationLabel(expireTm - now);
    }
    if (!command?.regions.length)
        return null;
    const elapsed = typeof mission.mssnStrtTm === "number" && mission.mssnStrtTm > 0
        ? Math.max(0, now - mission.mssnStrtTm)
        : null;
    if (elapsed === null)
        return null;
    const estimates = command.regions.map((region) => {
        const fromIndex = regionIndex.get(cloudRegionKey(region.type, region.region_id))?.estimate_seconds;
        return fromIndex ?? null;
    });
    if (estimates.every((value) => value === null))
        return null;
    let remaining = 0;
    if (command.ordered && command.regions.length > 1) {
        let consumed = elapsed;
        let foundCurrent = false;
        for (let index = 0; index < command.regions.length; index += 1) {
            const estimate = estimates[index] ?? 0;
            if (!foundCurrent) {
                if (consumed >= estimate) {
                    consumed -= estimate;
                    continue;
                }
                remaining += estimate - consumed;
                foundCurrent = true;
                continue;
            }
            remaining += estimate;
        }
    }
    else {
        remaining = estimates.reduce((sum, value) => sum + (value ?? 0), 0) - elapsed;
    }
    if (remaining <= 0)
        return null;
    return formatDurationLabel(remaining);
}
const IROBOT_DISCOVERY_URL = process.env.IROBOT_DISCOVERY_URL ??
    `https://disc-prod.iot.irobotapi.com/v1/discover/endpoints?country_code=${process.env.IROBOT_COUNTRY_CODE ?? "US"}`;
const IROBOT_APP_ID = "ANDROID-C7FB240E-DF34-42D7-AE4E-A8C17079A294";
const HTTP_PROBE_TIMEOUT_MS = 10_000;
let mutexBusy = false;
const mutexQueue = [];
let discoveryBusy = false;
const discoveryQueue = [];
let lastError = null;
function setLastError(message) {
    lastError = message;
}
function getLastError() {
    return lastError;
}
function isMutexBusy() {
    return mutexBusy;
}
function isDiscoveryBusy() {
    return discoveryBusy;
}
async function acquireMutex() {
    if (!mutexBusy) {
        mutexBusy = true;
        return;
    }
    await new Promise((resolve) => {
        mutexQueue.push(resolve);
    });
}
function releaseMutex() {
    const next = mutexQueue.shift();
    if (next) {
        next();
        return;
    }
    mutexBusy = false;
}
async function acquireDiscoveryMutex() {
    if (!discoveryBusy) {
        discoveryBusy = true;
        return;
    }
    await new Promise((resolve) => {
        discoveryQueue.push(resolve);
    });
}
function releaseDiscoveryMutex() {
    const next = discoveryQueue.shift();
    if (next) {
        next();
        return;
    }
    discoveryBusy = false;
}
function isRoombaDiscoveryHost(hostname) {
    const prefix = hostname.split("-")[0];
    return prefix === "Roomba" || prefix === "iRobot";
}
function parseDiscoveryRobot(parsed) {
    const hostname = String(parsed.hostname ?? "");
    const ip = String(parsed.ip ?? "");
    if (!hostname || !ip || !isRoombaDiscoveryHost(hostname)) {
        return null;
    }
    return {
        ip,
        robotname: String(parsed.robotname ?? "Roomba"),
        hostname,
        sw: String(parsed.sw ?? ""),
        sku: String(parsed.sku ?? ""),
        blid: hostname.replace(/^(Roomba|iRobot)-/, ""),
    };
}
function isConfigured(settings) {
    return Boolean(settings.robot_ip.trim() && settings.blid.trim() && settings.password.trim());
}
function isValidIpv4(value) {
    const parts = value.trim().split(".");
    if (parts.length !== 4)
        return false;
    return parts.every((part) => {
        const octet = Number(part);
        return Number.isInteger(octet) && octet >= 0 && octet <= 255;
    });
}
function localProtocolVersion(firmwareVersion) {
    return firmwareVersion.trim() === "1" ? 1 : 2;
}
function createRobotClient(settings) {
    return new dorita980_1.default.Local(settings.blid.trim(), settings.password.trim(), settings.robot_ip.trim(), localProtocolVersion(settings.firmware_version), {
        connectTimeout: CONNECT_TIMEOUT_MS,
        reconnectPeriod: 0,
    });
}
function mqttBusyHint() {
    return " Close the iRobot mobile app and wait a few seconds, then try again.";
}
function withTimeout(promise, timeoutMs, label) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
        promise
            .then((value) => {
            clearTimeout(timer);
            resolve(value);
        })
            .catch((error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}
function isRobotConnected(robot) {
    return Boolean(robot.connected);
}
function waitForConnect(robot) {
    if (isRobotConnected(robot)) {
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeout);
            robot.removeListener("connect", onConnect);
            robot.removeListener("error", onError);
            if (error)
                reject(error);
            else
                resolve();
        };
        const timeout = setTimeout(() => {
            void endRobot(robot);
            finish(new Error(`Timed out connecting to the robot over local MQTT.${mqttBusyHint()}`));
        }, CONNECT_TIMEOUT_MS);
        const onConnect = () => finish();
        const onError = (error) => finish(error);
        robot.once("connect", onConnect);
        robot.once("error", onError);
    });
}
async function endRobot(robot) {
    await withTimeout(new Promise((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled)
                return;
            settled = true;
            resolve();
        };
        try {
            robot.end(true, finish);
        }
        catch {
            finish();
            return;
        }
        setTimeout(finish, ROBOT_DISCONNECT_TIMEOUT_MS);
    }), ROBOT_DISCONNECT_TIMEOUT_MS + 1_000, "Robot disconnect").catch(() => { });
}
async function withRobot(settings, fn) {
    if (!isConfigured(settings)) {
        throw new Error("Robot is not configured yet");
    }
    await acquireMutex();
    try {
        const result = await withTimeout(withRobotSession(settings, fn), ROBOT_OPERATION_TIMEOUT_MS, "Robot operation");
        setLastError(null);
        return result;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setLastError(message);
        throw error;
    }
    finally {
        releaseMutex();
    }
}
async function withRobotSession(settings, fn) {
    const robot = createRobotClient(settings);
    try {
        await waitForConnect(robot);
        return await fn(robot);
    }
    finally {
        await endRobot(robot);
    }
}
function normalizeSubnetPrefix(value) {
    return value.replace(/\/24$/i, "").replace(/\.\d+$/, "").trim();
}
function getScanSubnets(robotIpHint = "") {
    const fromEnv = (process.env.ROOMBA_SCAN_SUBNETS ?? "")
        .split(",")
        .map((value) => normalizeSubnetPrefix(value.trim()))
        .filter(Boolean);
    if (fromEnv.length)
        return fromEnv;
    const hint = robotIpHint.trim() || process.env.ROOMBA_IP?.trim() || "";
    if (hint) {
        const parts = hint.split(".");
        if (parts.length === 4)
            return [`${parts[0]}.${parts[1]}.${parts[2]}`];
    }
    return [];
}
function collectDiscoveryResponses(durationMs, targetIps) {
    return new Promise((resolve, reject) => {
        const robots = [];
        const seenIps = new Set();
        const server = (0, node_dgram_1.createSocket)({ type: "udp4", reuseAddr: true });
        let settled = false;
        const finish = (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeout);
            server.removeAllListeners();
            try {
                server.close();
            }
            catch {
                // ignore close errors
            }
            if (error)
                reject(error);
            else
                resolve(robots);
        };
        const timeout = setTimeout(() => finish(), durationMs);
        server.on("error", (error) => finish(error));
        server.on("message", (message) => {
            try {
                const parsed = JSON.parse(message.toString());
                const robot = parseDiscoveryRobot(parsed);
                if (!robot || seenIps.has(robot.ip))
                    return;
                seenIps.add(robot.ip);
                robots.push(robot);
            }
            catch {
                // ignore malformed discovery payloads
            }
        });
        server.bind(DISCOVERY_PORT, () => {
            for (const ip of targetIps) {
                if (ip === "255.255.255.255") {
                    server.setBroadcast(true);
                }
                server.send(DISCOVERY_MESSAGE, DISCOVERY_PORT, ip, () => { });
            }
        });
    });
}
async function discoverRobots(robotIpHint = "") {
    await acquireDiscoveryMutex();
    try {
        const hint = robotIpHint.trim();
        if (isValidIpv4(hint)) {
            const direct = await collectDiscoveryResponses(3_000, [hint]);
            if (direct.length > 0) {
                setLastError(null);
                return direct;
            }
        }
        const broadcast = await collectDiscoveryResponses(DISCOVERY_TIMEOUT_MS, ["255.255.255.255"]);
        if (broadcast.length > 0) {
            setLastError(null);
            return broadcast;
        }
        const subnets = getScanSubnets(robotIpHint);
        for (const prefix of subnets) {
            const targetIps = Array.from({ length: 254 }, (_, index) => `${prefix}.${index + 1}`);
            const scanned = await collectDiscoveryResponses(6_000, targetIps);
            if (scanned.length > 0) {
                setLastError(null);
                return scanned;
            }
        }
        setLastError(null);
        return [];
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setLastError(message);
        throw error;
    }
    finally {
        releaseDiscoveryMutex();
    }
}
const DASHBOARD_EXTRA_FIELDS = ["pmaps", "softwareVer", "sku", "lastCommand", "cleanSchedule2"];
async function readRobotState(robot) {
    return withTimeout(robot.getRobotState(["batPct", "cleanMissionStatus", "bin"]), ROBOT_READ_TIMEOUT_MS, "Robot status");
}
async function readDashboardExtras(robot) {
    return readOptionalRobotValue("Robot maps and mission", ROBOT_DASHBOARD_TIMEOUT_MS, () => robot.getRobotState([...DASHBOARD_EXTRA_FIELDS]));
}
const MAINTENANCE_STATE_FIELDS = [
    "bbrun",
    "bbmssn",
    "bbchg",
    "batInfo",
    "runtimeStats",
    "bin",
    "batPct",
];
const MAINTENANCE_INTERVALS = [
    { id: "filter", name: "Filter", detail: "Replace the high-efficiency filter", hours: 166 },
    { id: "edge_brush", name: "Edge-sweeping brush", detail: "Clean or replace the side brush", hours: 166 },
    { id: "rollers", name: "Multi-surface brushes", detail: "Clean the rubber brush rollers", hours: 416 },
];
function readNumberField(record, key) {
    if (!record)
        return null;
    const value = record[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function formatRuntimeHours(hours) {
    const wholeHours = Math.floor(hours);
    const minutes = Math.round((hours - wholeHours) * 60);
    if (wholeHours <= 0)
        return `${minutes} min`;
    if (minutes <= 0)
        return `${wholeHours} hr`;
    return `${wholeHours} hr ${minutes} min`;
}
function maintenanceStatus(percentUsed) {
    if (percentUsed >= 100)
        return { status: "replace", status_label: "Replace now" };
    if (percentUsed >= 80)
        return { status: "due_soon", status_label: "Due soon" };
    return { status: "ok", status_label: "OK" };
}
function buildMaintenanceItems(runtimeHours) {
    return MAINTENANCE_INTERVALS.map((item) => {
        const percentUsed = Math.min(100, Math.round((runtimeHours / item.hours) * 100));
        const { status, status_label } = maintenanceStatus(percentUsed);
        return {
            id: item.id,
            name: item.name,
            detail: item.detail,
            hours_used: Math.round(runtimeHours),
            hours_recommended: item.hours,
            percent_used: percentUsed,
            status,
            status_label,
        };
    });
}
async function readMaintenanceState(robot) {
    return withTimeout(robot.getRobotState([...MAINTENANCE_STATE_FIELDS]), ROBOT_MAINTENANCE_TIMEOUT_MS, "Robot maintenance");
}
async function getRobotMaintenance(settings) {
    const base = {
        connected: false,
        configured: isConfigured(settings),
        error: null,
        last_sync: new Date().toISOString(),
        runtime_hours: null,
        runtime_label: null,
        area_sqft: null,
        missions_total: null,
        missions_completed: null,
        missions_canceled: null,
        stuck_events: null,
        charge_cycles: null,
        bin_full: null,
        bin_present: null,
        battery_percent: null,
        items: [],
    };
    if (!base.configured) {
        base.error = "Robot is not configured yet";
        return base;
    }
    try {
        const state = await withRobot(settings, async (robot) => readMaintenanceState(robot));
        const bbrun = asRecord(state.bbrun);
        const bbmssn = asRecord(state.bbmssn);
        const bbchg = asRecord(state.bbchg);
        const batInfo = asRecord(state.batInfo);
        const runtimeStats = asRecord(state.runtimeStats);
        const bin = asRecord(state.bin);
        const runHours = readNumberField(bbrun, "hr");
        const runMinutes = readNumberField(bbrun, "min");
        const runtimeHours = runHours === null && runMinutes === null
            ? null
            : (runHours ?? 0) + (runMinutes ?? 0) / 60;
        base.connected = true;
        base.runtime_hours = runtimeHours;
        base.runtime_label = runtimeHours === null ? null : formatRuntimeHours(runtimeHours);
        base.area_sqft =
            readNumberField(runtimeStats, "sqft") ??
                readNumberField(bbrun, "sqft");
        base.missions_total = readNumberField(bbmssn, "nMssn");
        base.missions_completed = readNumberField(bbmssn, "nMssnOk");
        base.missions_canceled = readNumberField(bbmssn, "nMssnC");
        base.stuck_events = readNumberField(bbrun, "nStuck");
        base.charge_cycles = readNumberField(bbchg, "nChgOk") ?? readNumberField(batInfo, "cCount");
        base.bin_full = typeof bin?.full === "boolean" ? bin.full : null;
        base.bin_present = typeof bin?.present === "boolean" ? bin.present : null;
        base.battery_percent = typeof state.batPct === "number" ? state.batPct : null;
        base.items = runtimeHours === null ? [] : buildMaintenanceItems(runtimeHours);
        if (base.bin_full) {
            base.items.unshift({
                id: "bin",
                name: "Dust bin",
                detail: "Empty the bin and wipe the bin sensors",
                hours_used: 0,
                hours_recommended: 0,
                percent_used: 100,
                status: "replace",
                status_label: "Empty now",
            });
        }
        return base;
    }
    catch (error) {
        base.error = error instanceof Error ? error.message : String(error);
        return base;
    }
}
const COMMAND_SETTLE_MS = 2_500;
async function readMissionSnapshot(robot) {
    const state = await readRobotState(robot);
    return {
        mission: (state.cleanMissionStatus ?? {}),
        bin: (state.bin ?? {}),
        batPct: typeof state.batPct === "number" ? state.batPct : null,
    };
}
function missionIsActive(mission) {
    const phase = String(mission.phase ?? "");
    const cycle = String(mission.cycle ?? "");
    if (cycle !== "none")
        return true;
    return ["run", "resume", "spot"].includes(phase);
}
function formatMissionState(mission) {
    const phase = typeof mission.phase === "string" ? mission.phase : null;
    const cycle = typeof mission.cycle === "string" ? mission.cycle : null;
    return {
        phase,
        cycle,
        phase_label: formatPhaseLabel(phase),
        cycle_label: formatJobLabel(phase, cycle),
        status_label: formatMissionStatus(phase, cycle),
    };
}
function buildMissionFailureMessage(mission, bin, batPct, actionLabel) {
    const phase = typeof mission.phase === "string" ? mission.phase : null;
    const cycle = typeof mission.cycle === "string" ? mission.cycle : null;
    const status = formatMissionStatus(phase, cycle);
    const hints = [];
    if (bin.full === true)
        hints.push("bin is full");
    if (batPct !== null && batPct < 15)
        hints.push("battery is low");
    if (typeof mission.error === "number" && mission.error > 0)
        hints.push(`robot error code ${mission.error}`);
    if (typeof mission.notReady === "number" && mission.notReady > 0) {
        hints.push(`robot not ready (code ${mission.notReady})`);
    }
    const hintText = hints.length ? ` ${hints.join(", ")}.` : "";
    return `${actionLabel} was sent, but the robot did not start (${status}).${hintText} Close the iRobot app and try again.`;
}
async function waitForMissionChange(robot, previous, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let latest = previous;
    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const snapshot = await readMissionSnapshot(robot);
        latest = snapshot.mission;
        if (missionIsActive(latest))
            return latest;
        if (String(latest.phase ?? "") !== String(previous.phase ?? ""))
            return latest;
        if (String(latest.cycle ?? "") !== String(previous.cycle ?? ""))
            return latest;
    }
    return latest;
}
async function sendStartClean(robot) {
    const before = await readMissionSnapshot(robot);
    if (missionIsActive(before.mission)) {
        return { ok: true, ...formatMissionState(before.mission) };
    }
    const phase = String(before.mission.phase ?? "");
    if (phase === "pause") {
        await robot.resume();
    }
    else {
        await robot.start();
    }
    await new Promise((resolve) => setTimeout(resolve, COMMAND_SETTLE_MS));
    const after = await waitForMissionChange(robot, before.mission, 8_000);
    if (!missionIsActive(after)) {
        throw new Error(buildMissionFailureMessage(after, before.bin, before.batPct, "Start clean"));
    }
    return { ok: true, ...formatMissionState(after) };
}
async function sendDock(robot) {
    const before = await readMissionSnapshot(robot);
    const phase = String(before.mission.phase ?? "");
    if (["run", "resume", "spot"].includes(phase) || String(before.mission.cycle ?? "") !== "none") {
        await robot.pause();
        await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    await robot.dock();
    await new Promise((resolve) => setTimeout(resolve, COMMAND_SETTLE_MS));
    const after = await readMissionSnapshot(robot);
    return { ok: true, ...formatMissionState(after.mission) };
}
function asRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    return value;
}
function favoriteDisplayName(favorite, index) {
    const name = favorite.name ?? favorite.favorite_name ?? favorite.label ?? favorite.display_name;
    if (typeof name === "string" && name.trim())
        return name.trim();
    return `Favorite ${index + 1}`;
}
function favoriteIdentifier(favorite, index) {
    const id = favorite.favorite_id ?? favorite.id ?? favorite.fav_id;
    if (typeof id === "string" || typeof id === "number")
        return String(id);
    return String(index);
}
function normalizeFavoriteRegions(regions) {
    if (!Array.isArray(regions))
        return [];
    return regions
        .map((region) => asRecord(region))
        .filter((region) => region !== null)
        .map((region) => ({
        region_id: String(region.region_id ?? region.id ?? ""),
        region_name: String(region.region_name ?? region.name ?? ""),
        region_type: String(region.region_type ?? "rid"),
        type: String(region.type ?? "rid"),
    }))
        .filter((region) => region.region_id);
}
function summarizeRegions(regions) {
    if (!regions.length)
        return "";
    const labels = regions.map((region) => region.region_name || region.region_id);
    return labels.join(", ");
}
function collectFavoriteLists(entry) {
    const lists = [];
    const activeDetails = asRecord(entry.active_pmapv_details);
    const activePmapv = activeDetails ? asRecord(activeDetails.active_pmapv) : null;
    const sources = [
        entry,
        activeDetails,
        activePmapv,
        asRecord(entry.active_pmapv),
        asRecord(entry.pmapv),
        asRecord(entry.user_pmapv),
    ].filter((source) => source !== null);
    for (const source of sources) {
        for (const key of ["smart_clean_favs", "smartCleanFavs", "favorites", "favs", "saved_favorites"]) {
            const list = source[key];
            if (Array.isArray(list))
                lists.push(list);
        }
    }
    return lists;
}
function extractFavoritesFromPmapEntry(entry, fallbackPmapId = "") {
    const pmapId = String(entry.pmap_id ?? fallbackPmapId ?? "").trim();
    const activeDetails = asRecord(entry.active_pmapv_details);
    const activePmapv = activeDetails ? asRecord(activeDetails.active_pmapv) : null;
    const defaultPmapVersion = String(entry.user_pmapv_id ?? entry.active_pmapv_id ?? activePmapv?.user_pmapv_id ?? "").trim();
    const favoriteLists = collectFavoriteLists(entry);
    for (const list of favoriteLists) {
        if (!Array.isArray(list))
            continue;
        return list
            .map((item, index) => {
            const favorite = asRecord(item);
            if (!favorite)
                return null;
            const regions = normalizeFavoriteRegions(favorite.regions);
            const userPmapvId = String(favorite.user_pmapv_id ?? defaultPmapVersion ?? "").trim();
            const ordered = Boolean(favorite.ordered ?? favorite.order ?? false);
            const runnable = Boolean(pmapId && regions.length);
            return {
                id: favoriteIdentifier(favorite, index),
                name: favoriteDisplayName(favorite, index),
                pmap_id: pmapId || null,
                user_pmapv_id: userPmapvId || null,
                ordered,
                region_count: regions.length,
                regions_summary: summarizeRegions(regions) || (regions.length ? `${regions.length} room(s)` : "Whole home"),
                runnable,
            };
        })
            .filter((favorite) => favorite !== null);
    }
    return [];
}
function deepFindFavoriteLists(value, depth = 0) {
    if (depth > 6 || value == null)
        return [];
    const lists = [];
    if (Array.isArray(value)) {
        for (const item of value) {
            lists.push(...deepFindFavoriteLists(item, depth + 1));
        }
        return lists;
    }
    const record = asRecord(value);
    if (!record)
        return lists;
    for (const key of ["smart_clean_favs", "smartCleanFavs", "favorites", "favs", "saved_favorites"]) {
        const list = record[key];
        if (Array.isArray(list) && list.length)
            lists.push(list);
    }
    for (const child of Object.values(record)) {
        lists.push(...deepFindFavoriteLists(child, depth + 1));
    }
    return lists;
}
function parseFavoritesFromPmaps(pmaps) {
    const favorites = [];
    const seen = new Set();
    const addFavorites = (items) => {
        for (const favorite of items) {
            const key = `${favorite.id}:${favorite.name}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            favorites.push({ ...favorite, source: favorite.source ?? "local" });
        }
    };
    if (Array.isArray(pmaps)) {
        for (const item of pmaps) {
            const entry = asRecord(item);
            if (!entry)
                continue;
            addFavorites(extractFavoritesFromPmapEntry(entry));
        }
        if (!favorites.length) {
            for (const list of deepFindFavoriteLists(pmaps)) {
                if (!Array.isArray(list))
                    continue;
                addFavorites(extractFavoritesFromPmapEntry({
                    smart_clean_favs: list,
                }));
            }
        }
        return favorites;
    }
    const root = asRecord(pmaps);
    if (!root)
        return favorites;
    if (collectFavoriteLists(root).length) {
        addFavorites(extractFavoritesFromPmapEntry(root));
        return favorites;
    }
    for (const [pmapId, value] of Object.entries(root)) {
        const entry = asRecord(value);
        if (!entry)
            continue;
        addFavorites(extractFavoritesFromPmapEntry(entry, pmapId));
    }
    if (!favorites.length) {
        for (const list of deepFindFavoriteLists(root)) {
            if (!Array.isArray(list))
                continue;
            addFavorites(extractFavoritesFromPmapEntry({
                smart_clean_favs: list,
            }));
        }
    }
    return favorites;
}
function parseRoomsFromCloudPmaps(pmaps) {
    if (!Array.isArray(pmaps))
        return [];
    const spaces = [];
    for (const item of pmaps) {
        const entry = asRecord(item);
        if (!entry)
            continue;
        const pmapId = String(entry.pmap_id ?? "").trim();
        const userPmapvId = String(entry.user_pmapv_id ?? entry.active_pmapv_id ?? "").trim();
        const details = asRecord(entry.active_pmapv_details);
        if (!pmapId || !userPmapvId || !details)
            continue;
        const regions = Array.isArray(details.regions) ? details.regions : [];
        for (const regionValue of regions) {
            const region = asRecord(regionValue);
            if (!region)
                continue;
            const regionId = String(region.id ?? region.region_id ?? "").trim();
            const regionName = String(region.name ?? region.region_name ?? "").trim() || `Room ${regionId}`;
            const regionType = String(region.region_type ?? "room").trim();
            if (!regionId)
                continue;
            const estimateSeconds = readCleanEstimateSeconds(region.time_estimates);
            const commandRegions = [
                {
                    region_id: regionId,
                    region_name: regionName,
                    region_type: regionType,
                    type: "rid",
                },
            ];
            spaces.push({
                id: `room:${pmapId}:${regionId}`,
                name: regionName,
                pmap_id: pmapId,
                user_pmapv_id: userPmapvId,
                ordered: false,
                region_count: 1,
                regions_summary: regionName,
                runnable: true,
                source: "cloud",
                space_kind: "room",
                clean_estimate_seconds: estimateSeconds,
                clean_estimate_label: estimateSeconds === null ? null : formatCleanEstimateLabel(estimateSeconds),
                command_regions: commandRegions,
            });
        }
        const zones = Array.isArray(details.zones) ? details.zones : [];
        for (const zoneValue of zones) {
            const zone = asRecord(zoneValue);
            if (!zone)
                continue;
            const zoneId = String(zone.id ?? zone.region_id ?? "").trim();
            const zoneName = String(zone.name ?? zone.zone_name ?? "").trim() || `Area ${zoneId}`;
            const zoneType = String(zone.zone_type ?? "other").trim();
            if (!zoneId)
                continue;
            const estimateSeconds = readCleanEstimateSeconds(zone.time_estimates);
            const commandRegions = [
                {
                    region_id: zoneId,
                    region_name: zoneName,
                    region_type: zoneType,
                    type: "zid",
                },
            ];
            spaces.push({
                id: `zone:${pmapId}:${zoneId}`,
                name: zoneName,
                pmap_id: pmapId,
                user_pmapv_id: userPmapvId,
                ordered: false,
                region_count: 1,
                regions_summary: zoneName,
                runnable: true,
                source: "cloud",
                space_kind: "zone",
                clean_estimate_seconds: estimateSeconds,
                clean_estimate_label: estimateSeconds === null ? null : formatCleanEstimateLabel(estimateSeconds),
                command_regions: commandRegions,
            });
        }
    }
    return spaces;
}
function hasCloudAccount(settings) {
    return Boolean(settings.irobot_username.trim() && settings.irobot_password.trim());
}
function buildFavoriteCommand(favorite, regions) {
    return {
        ordered: favorite.ordered ? 1 : 0,
        pmap_id: favorite.pmap_id,
        user_pmapv_id: favorite.user_pmapv_id,
        regions: regions.map((region) => ({
            region_id: region.region_id,
            region_name: region.region_name,
            region_type: region.region_type,
            type: region.type,
        })),
    };
}
async function fetchCloudCleanablesSafe(settings) {
    if (!hasCloudAccount(settings))
        return [];
    try {
        const result = await fetchCloudPmapsResult(settings);
        if (!result.ok || !result.pmaps.length)
            return [];
        const spaces = parseRoomsFromCloudPmaps(result.pmaps);
        if (spaces.length) {
            await persistSpacesCache(settings.blid.trim(), spaces);
        }
        return spaces;
    }
    catch {
        return [];
    }
}
async function resolveFavoriteCommand(settings, favoriteId) {
    await ensureCleanablesDiskCacheLoaded();
    const blid = settings.blid.trim();
    if (favoriteId.startsWith("custom:")) {
        let customFavorite = (0, custom_favorites_js_1.getCustomFavoriteById)(favoriteId, getCachedSpaces(blid));
        if (!customFavorite?.command_regions?.length) {
            const cloudSpaces = await fetchCloudCleanablesSafe(settings);
            customFavorite = (0, custom_favorites_js_1.getCustomFavoriteById)(favoriteId, cloudSpaces);
        }
        if (!customFavorite?.command_regions?.length) {
            throw new Error("Custom favorite is not available — refresh spaces first");
        }
        return buildFavoriteCommand(customFavorite, customFavorite.command_regions);
    }
    if (favoriteId.startsWith("room:") || favoriteId.startsWith("zone:")) {
        const cachedSpace = getCachedSpaces(blid).find((entry) => entry.id === favoriteId);
        if (cachedSpace?.command_regions?.length) {
            return buildFavoriteCommand(cachedSpace, cachedSpace.command_regions);
        }
        const cloudSpaces = await fetchCloudCleanablesSafe(settings);
        const space = cloudSpaces.find((entry) => entry.id === favoriteId);
        if (space?.command_regions?.length) {
            return buildFavoriteCommand(space, space.command_regions);
        }
        throw new Error("Space not found — refresh spaces first");
    }
    return null;
}
async function readFavoriteCommandFromRobot(robot, favoriteId) {
    let favorite;
    let regions = [];
    const snapshot = await withTimeout(robot.getRobotState(["pmaps"]), ROBOT_PMAPS_TIMEOUT_MS, "Robot favorites");
    const favorites = parseFavoritesFromPmaps(snapshot.pmaps);
    favorite = favorites.find((entry) => entry.id === favoriteId);
    if (!favorite?.runnable || !favorite.pmap_id) {
        throw new Error("Favorite not found on the robot");
    }
    const pmapState = asRecord(snapshot.pmaps);
    const pmapLists = Array.isArray(snapshot.pmaps)
        ? snapshot.pmaps.map((item) => asRecord(item)).filter((item) => item !== null)
        : pmapState
            ? [pmapState]
            : [];
    for (const entry of pmapLists) {
        if (String(entry.pmap_id ?? "") !== favorite.pmap_id)
            continue;
        for (const list of collectFavoriteLists(entry)) {
            if (!Array.isArray(list))
                continue;
            for (const [index, item] of list.entries()) {
                const record = asRecord(item);
                if (!record || favoriteIdentifier(record, index) !== favorite.id)
                    continue;
                regions = normalizeFavoriteRegions(record.regions);
                break;
            }
            if (regions.length)
                break;
        }
        if (regions.length)
            break;
    }
    if (!favorite.runnable) {
        throw new Error("Favorite not found on the robot");
    }
    if (!regions.length) {
        throw new Error("Favorite has no rooms configured");
    }
    if (!favorite.pmap_id) {
        throw new Error("Favorite is missing map information");
    }
    return buildFavoriteCommand(favorite, regions);
}
async function sendRoomClean(robot, command, actionLabel) {
    const before = await readMissionSnapshot(robot);
    if (missionIsActive(before.mission)) {
        throw new Error("Robot is already cleaning. Pause or stop the current job first.");
    }
    await robot.cleanRoom(command);
    await new Promise((resolve) => setTimeout(resolve, COMMAND_SETTLE_MS));
    const after = await waitForMissionChange(robot, before.mission, 8_000);
    if (!missionIsActive(after)) {
        throw new Error(buildMissionFailureMessage(after, before.bin, before.batPct, actionLabel));
    }
}
async function readOptionalRobotValue(label, timeoutMs, read) {
    try {
        return await withTimeout(read(), timeoutMs, label);
    }
    catch {
        return null;
    }
}
async function fetchCredentialsFromCloud(username, password) {
    const cliPath = require.resolve("dorita980/bin/getPasswordCloud.js");
    const { stdout, stderr } = await execFileAsync(cliPath, [username.trim(), password], {
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
        env: process.env,
    });
    const output = `${stdout}\n${stderr}`;
    const blocks = output.split(/Robot "/).slice(1);
    if (!blocks.length) {
        throw new Error("No robots were found on this iRobot account");
    }
    const robots = blocks.map((block) => {
        const nameMatch = block.match(/^([^"]+)"/);
        const skuMatch = block.match(/sku:\s*([^\s)]+)/i);
        const softwareMatch = block.match(/SoftwareVer:\s*([^)]+)\)/i);
        const blidMatch = block.match(/BLID=>\s*(\S+)/i);
        const passwordMatch = block.match(/Password=>\s*(\S+)/i);
        const blid = blidMatch?.[1]?.trim() ?? "";
        const robotPassword = passwordMatch?.[1]?.trim() ?? "";
        if (!blid || !robotPassword) {
            throw new Error("Could not parse robot credentials from iRobot cloud response");
        }
        const software = softwareMatch?.[1]?.trim() ?? "";
        const firmwareVersion = software.startsWith("v3") ? "3" : software.startsWith("v2") ? "2" : "3";
        return {
            robot_ip: "",
            blid,
            password: robotPassword,
            robot_name: nameMatch?.[1]?.trim() || "Roomba",
            firmware_version: firmwareVersion,
            connection_mode: "on_demand",
            live_poll_seconds: 0,
            irobot_username: "",
            irobot_password: "",
            sku: skuMatch?.[1]?.trim() ?? "",
            software_version: software,
        };
    });
    return { robots };
}
async function testConnection(settings) {
    return getRobotStatus(settings);
}
async function getRobotStatus(settings) {
    const base = {
        connected: false,
        configured: isConfigured(settings),
        error: null,
        robot_name: settings.robot_name,
        robot_ip: settings.robot_ip,
        firmware_version: settings.firmware_version,
        battery_percent: null,
        phase: null,
        cycle: null,
        phase_label: null,
        cycle_label: null,
        status_label: null,
        time_remaining_label: null,
        mission_active: false,
        bin_full: null,
        bin_present: null,
        docked: null,
        sqft: null,
        mission_minutes: null,
        last_command: null,
        software_version: null,
        sku: null,
        spaces: [],
        spaces_error: null,
        favorites: [],
        favorites_error: null,
        last_sync: new Date().toISOString(),
    };
    if (!base.configured) {
        base.error = "Robot is not configured yet";
        return base;
    }
    const blid = settings.blid.trim();
    await ensureCleanablesDiskCacheLoaded();
    const cloudTask = hasCloudAccount(settings) ? fetchCloudPmapsResult(settings) : null;
    const cloudFavoritesTask = hasCloudAccount(settings) ? fetchCloudSavedFavoritesResult(settings) : null;
    try {
        const [snapshot, cloudResult, cloudFavoritesResult] = await Promise.all([
            withRobot(settings, async (robot) => {
                const state = await readRobotState(robot);
                const extras = await readDashboardExtras(robot);
                return { state, extras };
            }),
            cloudTask ?? Promise.resolve({ ok: true, pmaps: [], error: null }),
            cloudFavoritesTask ??
                Promise.resolve({ ok: true, favorites: [], error: null }),
        ]);
        const state = snapshot.state;
        const extras = snapshot.extras ?? {};
        const mission = (state.cleanMissionStatus ?? {});
        const bin = (state.bin ?? {});
        const lastCommand = (extras.lastCommand ?? {});
        base.connected = true;
        base.battery_percent = typeof state.batPct === "number" ? state.batPct : null;
        base.phase = typeof mission.phase === "string" ? mission.phase : null;
        base.cycle = typeof mission.cycle === "string" ? mission.cycle : null;
        base.phase_label = formatPhaseLabel(base.phase);
        const missionCommand = resolveActiveMissionCommand(mission, lastCommand, extras.cleanSchedule2);
        const regionIndex = buildCloudRegionIndex(cloudResult.pmaps);
        base.bin_full = typeof bin.full === "boolean" ? bin.full : null;
        base.bin_present = typeof bin.present === "boolean" ? bin.present : null;
        base.docked = base.phase === "charge" || base.phase === "dock";
        base.sqft = typeof mission.sqft === "number" ? mission.sqft : null;
        base.mission_minutes = typeof mission.mssnM === "number" ? mission.mssnM : null;
        base.last_command = typeof lastCommand.command === "string" ? lastCommand.command : null;
        base.software_version =
            typeof extras.softwareVer === "string"
                ? extras.softwareVer
                : typeof state.softwareVer === "string"
                    ? state.softwareVer
                    : null;
        base.sku =
            typeof extras.sku === "string" ? extras.sku : typeof state.sku === "string" ? state.sku : null;
        const localPmaps = snapshot.extras && typeof extras.pmaps !== "undefined" ? extras.pmaps : null;
        base.favorites = collectSavedFavorites(localPmaps, cloudResult.pmaps);
        if (cloudFavoritesResult.ok && cloudFavoritesResult.favorites.length) {
            base.favorites = mergeCleanables(base.favorites, cloudFavoritesResult.favorites);
        }
        const cloudSpaces = parseRoomsFromCloudPmaps(cloudResult.pmaps);
        if (cloudSpaces.length) {
            base.spaces = cloudSpaces;
            base.spaces_error = null;
        }
        if (base.spaces.length) {
            await persistSpacesCache(blid, base.spaces);
        }
        else {
            const cachedSpaces = getCachedSpaces(blid);
            if (cachedSpaces.length) {
                base.spaces = cachedSpaces;
                base.spaces_error = cloudResult.error
                    ? `Could not refresh spaces from iRobot cloud (${cloudResult.error}) — showing saved spaces.`
                    : "Showing saved spaces — iRobot cloud did not return an updated list.";
            }
        }
        if (base.favorites.length) {
            await persistFavoritesCache(blid, base.favorites);
        }
        else {
            const cachedFavorites = getCachedFavorites(blid);
            if (cachedFavorites.length) {
                base.favorites = cachedFavorites;
                base.favorites_error = cloudFavoritesResult.error
                    ? `Could not refresh favorites (${cloudFavoritesResult.error}) — showing saved favorites.`
                    : "Showing saved favorites — iRobot did not return an updated list.";
            }
        }
        base.mission_active = missionIsActive(mission);
        base.cycle_label = formatMissionJobLabel(base.phase, base.cycle, missionCommand, regionIndex);
        base.time_remaining_label = formatMissionTimeRemaining(mission, missionCommand, regionIndex);
        base.status_label = formatMissionStatus(base.phase, base.cycle, base.cycle_label);
        if (!base.spaces.length) {
            if (cloudResult.error) {
                base.spaces_error = `Could not load spaces from iRobot cloud: ${cloudResult.error}`;
            }
            else if (!hasCloudAccount(settings)) {
                base.spaces_error = "Add your iRobot account in Settings to load Smart Map spaces from iRobot cloud.";
            }
            else {
                base.spaces_error = "No Smart Map spaces found for this robot.";
            }
        }
        base.favorites = (0, custom_favorites_js_1.appendCustomFavorites)(base.favorites, base.spaces);
        if (!base.favorites.length) {
            if (cloudFavoritesResult.error) {
                base.favorites_error =
                    "Saved favorites are not available from iRobot cloud on this account. Custom favorites appear when Smart Map spaces are loaded.";
            }
            else {
                base.favorites_error =
                    "No favorites found. Custom favorites appear when Smart Map spaces are loaded.";
            }
        }
        return base;
    }
    catch (error) {
        base.error = error instanceof Error ? error.message : String(error);
        applyCachedCleanables(base, blid, `${base.error} — showing last saved list.`);
        return base;
    }
}
async function runRobotFavorite(settings, favoriteId) {
    const trimmedId = favoriteId.trim();
    if (!trimmedId) {
        throw new Error("favorite_id is required");
    }
    const resolvedCommand = await resolveFavoriteCommand(settings, trimmedId);
    await withRobot(settings, async (robot) => {
        const command = resolvedCommand ?? (await readFavoriteCommandFromRobot(robot, trimmedId));
        await sendRoomClean(robot, command, "Favorite");
    });
    return { ok: true };
}
async function runRobotAction(settings, action) {
    return withRobot(settings, async (robot) => {
        switch (action) {
            case "clean":
                return sendStartClean(robot);
            case "pause":
                await robot.pause();
                break;
            case "resume":
                await robot.resume();
                break;
            case "stop":
                await robot.stop();
                break;
            case "dock":
                return sendDock(robot);
        }
        await new Promise((resolve) => setTimeout(resolve, COMMAND_SETTLE_MS));
        const snapshot = await readMissionSnapshot(robot);
        return { ok: true, ...formatMissionState(snapshot.mission) };
    });
}
async function getRobotPreferences(settings) {
    return withRobot(settings, async (robot) => robot.getPreferences());
}
function checkMqttReachable(host, timeoutMs = 5_000) {
    const trimmed = host.trim();
    if (!trimmed) {
        return Promise.resolve({ reachable: false, latencyMs: null });
    }
    const started = Date.now();
    return new Promise((resolve) => {
        const socket = (0, node_net_1.createConnection)({ host: trimmed, port: MQTT_PORT, timeout: timeoutMs });
        const finish = (reachable) => {
            socket.destroy();
            resolve({
                reachable,
                latencyMs: reachable ? Date.now() - started : null,
            });
        };
        socket.once("connect", () => finish(true));
        socket.once("timeout", () => finish(false));
        socket.once("error", () => finish(false));
    });
}
function cloudStatusLabel(cloud) {
    if (cloud === null || cloud === undefined)
        return "Unknown";
    if (cloud === 0)
        return "Disconnected";
    if (cloud === 4)
        return "Connected";
    return `Code ${cloud}`;
}
async function probeHttpGet(url, timeoutMs = HTTP_PROBE_TIMEOUT_MS) {
    const started = Date.now();
    try {
        const response = await fetch(url, {
            signal: AbortSignal.timeout(timeoutMs),
            headers: { Connection: "close" },
        });
        return {
            ok: response.ok,
            status: response.status,
            latency_ms: Date.now() - started,
            error: null,
        };
    }
    catch (error) {
        return {
            ok: false,
            status: null,
            latency_ms: Date.now() - started,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
function signAwsRequest(key, message) {
    return (0, node_crypto_1.createHmac)("sha256", key).update(message).digest();
}
function getAwsSignatureKey(secretKey, dateStamp, region, service) {
    const kDate = signAwsRequest(Buffer.from(`AWS4${secretKey}`), dateStamp);
    const kRegion = signAwsRequest(kDate, region);
    const kService = signAwsRequest(kRegion, service);
    return signAwsRequest(kService, "aws4_request");
}
async function awsSignedGet(host, uri, query, credentials, region) {
    const method = "GET";
    const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const dateStamp = amzDate.slice(0, 8);
    const canonicalHeaders = `host:${host}\n` + `x-amz-date:${amzDate}\n` + `x-amz-security-token:${credentials.SessionToken}\n`;
    const signedHeaders = "host;x-amz-date;x-amz-security-token";
    const payloadHash = (0, node_crypto_1.createHash)("sha256").update("").digest("hex");
    const canonicalRequest = [method, uri, query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const algorithm = "AWS4-HMAC-SHA256";
    const credentialScope = `${dateStamp}/${region}/execute-api/aws4_request`;
    const stringToSign = [
        algorithm,
        amzDate,
        credentialScope,
        (0, node_crypto_1.createHash)("sha256").update(canonicalRequest).digest("hex"),
    ].join("\n");
    const signingKey = getAwsSignatureKey(credentials.SecretKey, dateStamp, region, "execute-api");
    const signature = (0, node_crypto_1.createHmac)("sha256", signingKey).update(stringToSign).digest("hex");
    const authorization = `${algorithm} Credential=${credentials.AccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const url = `https://${host}${uri}${query ? `?${query}` : ""}`;
    return fetch(url, {
        signal: AbortSignal.timeout(CLOUD_API_TIMEOUT_MS),
        headers: {
            Authorization: authorization,
            "x-amz-date": amzDate,
            "x-amz-security-token": credentials.SessionToken,
            Connection: "close",
        },
    });
}
async function discoverIrobotEndpoints() {
    const response = await fetch(IROBOT_DISCOVERY_URL, {
        signal: AbortSignal.timeout(HTTP_PROBE_TIMEOUT_MS),
        headers: { Connection: "close" },
    });
    if (!response.ok) {
        throw new Error(`iRobot discovery endpoint returned HTTP ${response.status}`);
    }
    const body = (await response.json());
    const gigya = (body.gigya ?? {});
    const deployments = (body.deployments ?? {});
    const apiKey = String(process.env.GIGYA_API_KEY ?? gigya.api_key ?? "");
    const datacenter = String(gigya.datacenter_domain ?? "");
    const gigyaBase = process.env.GIGYA_BASE ?? (datacenter ? `https://accounts.${datacenter}` : "https://accounts.us1.gigya.com");
    const deploymentKeys = Object.keys(deployments).sort().reverse();
    const primaryDeployment = deploymentKeys.map((key) => deployments[key]).find((deployment) => deployment && typeof deployment === "object") ??
        null;
    let httpBase = process.env.IROBOT_HTTP_BASE ?? "";
    if (!httpBase) {
        for (const key of deploymentKeys) {
            const candidate = deployments[key]?.httpBase;
            if (typeof candidate === "string" && candidate.trim()) {
                httpBase = candidate;
                break;
            }
        }
    }
    if (!httpBase) {
        httpBase = typeof body.httpBase === "string" ? body.httpBase : "https://unauth2.prod.iot.irobotapi.com";
    }
    const httpBaseAuth = process.env.IROBOT_HTTP_BASE_AUTH ??
        (typeof primaryDeployment?.httpBaseAuth === "string" ? primaryDeployment.httpBaseAuth : httpBase);
    const awsRegion = process.env.IROBOT_AWS_REGION ??
        (typeof primaryDeployment?.awsRegion === "string" ? primaryDeployment.awsRegion : "us-east-1");
    const iotHost = new URL(httpBaseAuth).host;
    if (!apiKey) {
        throw new Error("No Gigya API key in iRobot discovery response");
    }
    return { apiKey, gigyaBase, httpBase, httpBaseAuth, awsRegion, iotHost };
}
async function loginIrobotCloud(username, password) {
    const endpoints = await discoverIrobotEndpoints();
    const gigyaForm = new URLSearchParams({
        apiKey: endpoints.apiKey,
        targetenv: "mobile",
        loginID: username.trim(),
        password: password.trim(),
        format: "json",
        targetEnv: "mobile",
    });
    const gigyaResponse = await fetch(`${endpoints.gigyaBase}/accounts.login`, {
        method: "POST",
        body: gigyaForm,
        signal: AbortSignal.timeout(HTTP_PROBE_TIMEOUT_MS),
        headers: { Connection: "close" },
    });
    const gigyaBody = (await gigyaResponse.json());
    if (!gigyaResponse.ok || Number(gigyaBody.statusCode) !== 200 || Number(gigyaBody.errorCode) !== 0) {
        throw new Error("iRobot account login failed — check username and password");
    }
    const uid = String(gigyaBody.UID ?? "");
    const signature = String(gigyaBody.UIDSignature ?? "");
    const timestamp = String(gigyaBody.signatureTimestamp ?? "");
    if (!uid || !signature || !timestamp) {
        throw new Error("iRobot account login returned incomplete Gigya credentials");
    }
    const irobotResponse = await fetch(`${endpoints.httpBase}/v2/login`, {
        method: "POST",
        signal: AbortSignal.timeout(HTTP_PROBE_TIMEOUT_MS),
        headers: {
            Connection: "close",
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            app_id: IROBOT_APP_ID,
            assume_robot_ownership: 0,
            gigya: {
                signature,
                timestamp,
                uid,
            },
        }),
    });
    const irobotBody = (await irobotResponse.json());
    const credentials = irobotBody.credentials;
    if (!irobotResponse.ok || !irobotBody.robots || !credentials?.AccessKeyId || !credentials.SecretKey || !credentials.SessionToken) {
        throw new Error("iRobot cloud login failed — no robots returned");
    }
    return { endpoints, credentials, robots: irobotBody.robots };
}
async function fetchCloudPmaps(settings) {
    const result = await fetchCloudPmapsResult(settings);
    if (!result.ok) {
        throw new Error(result.error);
    }
    return result.pmaps;
}
async function fetchCloudPmapsOnce(settings) {
    const blid = settings.blid.trim();
    if (!blid || !hasCloudAccount(settings)) {
        return { ok: true, pmaps: [], error: null };
    }
    try {
        const login = await loginIrobotCloud(settings.irobot_username, settings.irobot_password);
        const response = await awsSignedGet(login.endpoints.iotHost, `/v1/${blid}/pmaps`, "activeDetails=2", login.credentials, login.endpoints.awsRegion);
        if (!response.ok) {
            return {
                ok: false,
                pmaps: [],
                error: `iRobot cloud pmap request failed (HTTP ${response.status})`,
            };
        }
        const body = (await response.json());
        return { ok: true, pmaps: Array.isArray(body) ? body : [], error: null };
    }
    catch (error) {
        return {
            ok: false,
            pmaps: [],
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
async function fetchCloudPmapsResult(settings) {
    let lastError = "iRobot cloud request failed";
    for (let attempt = 0; attempt < CLOUD_FETCH_RETRIES; attempt++) {
        const result = await fetchCloudPmapsOnce(settings);
        if (result.ok)
            return result;
        lastError = result.error;
        if (!isRetryableCloudError(result.error) || attempt === CLOUD_FETCH_RETRIES - 1) {
            break;
        }
        await sleep(750 * (attempt + 1));
    }
    return { ok: false, pmaps: [], error: lastError };
}
async function fetchCloudSavedFavoritesOnce(settings) {
    const blid = settings.blid.trim();
    if (!blid || !hasCloudAccount(settings)) {
        return { ok: true, favorites: [], error: null };
    }
    try {
        const login = await loginIrobotCloud(settings.irobot_username, settings.irobot_password);
        for (const uri of [`/v1/${blid}/smartcleanfavorites`, `/v1/${blid}/favorites`]) {
            const response = await awsSignedGet(login.endpoints.iotHost, uri, "", login.credentials, login.endpoints.awsRegion);
            if (!response.ok)
                continue;
            const body = (await response.json());
            const favorites = parseFavoritesFromPmaps(body);
            if (favorites.length) {
                return { ok: true, favorites, error: null };
            }
        }
        return { ok: true, favorites: [], error: null };
    }
    catch (error) {
        return {
            ok: false,
            favorites: [],
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
async function fetchCloudSavedFavoritesResult(settings) {
    let lastError = "iRobot cloud favorites request failed";
    for (let attempt = 0; attempt < CLOUD_FETCH_RETRIES; attempt++) {
        const result = await fetchCloudSavedFavoritesOnce(settings);
        if (result.ok)
            return result;
        lastError = result.error;
        if (!isRetryableCloudError(result.error) || attempt === CLOUD_FETCH_RETRIES - 1) {
            break;
        }
        await sleep(750 * (attempt + 1));
    }
    return { ok: false, favorites: [], error: lastError };
}
async function fetchCloudCleanables(settings) {
    const pmaps = await fetchCloudPmaps(settings);
    return parseRoomsFromCloudPmaps(pmaps);
}
function mapCloudRobots(robots, savedBlid, savedPassword) {
    return Object.entries(robots).map(([blid, robot]) => ({
        blid,
        name: String(robot.name ?? "Roomba"),
        sku: String(robot.sku ?? ""),
        software_version: String(robot.softwareVer ?? ""),
        password_matches_saved: savedBlid && savedPassword && blid === savedBlid
            ? robot.password === savedPassword
            : null,
    }));
}
async function fetchRoombaDeviceDiagnostics(settings) {
    const base = {
        connected: false,
        battery_percent: null,
        phase: null,
        cycle: null,
        phase_label: null,
        cycle_label: null,
        status_label: null,
        bin_full: null,
        bin_present: null,
        software_version: null,
        sku: null,
        last_sync: new Date().toISOString(),
        wireless: null,
        cloud_env: null,
        error: null,
    };
    try {
        const snapshot = await withRobot(settings, async (robot) => {
            const state = await readRobotState(robot);
            const wireless = await readOptionalRobotValue("Wireless status", 5_000, () => robot.getWirelessStatus());
            const cloudConfig = await readOptionalRobotValue("Cloud config", 5_000, () => robot.getCloudConfig());
            return { state, wireless, cloudConfig };
        });
        const state = snapshot.state;
        const mission = (state.cleanMissionStatus ?? {});
        const bin = (state.bin ?? {});
        const wireless = (snapshot.wireless ?? {});
        const wifistat = (wireless.wifistat ?? wireless);
        const wlcfg = (wireless.wlcfg ?? {});
        const cloudConfig = (snapshot.cloudConfig ?? {});
        const cloud = typeof wifistat.cloud === "number" ? wifistat.cloud : null;
        base.connected = true;
        base.battery_percent = typeof state.batPct === "number" ? state.batPct : null;
        base.phase = typeof mission.phase === "string" ? mission.phase : null;
        base.cycle = typeof mission.cycle === "string" ? mission.cycle : null;
        base.phase_label = formatPhaseLabel(base.phase);
        base.cycle_label = formatJobLabel(base.phase, base.cycle);
        base.status_label = formatMissionStatus(base.phase, base.cycle);
        base.bin_full = typeof bin.full === "boolean" ? bin.full : null;
        base.bin_present = typeof bin.present === "boolean" ? bin.present : null;
        base.software_version = typeof state.softwareVer === "string" ? state.softwareVer : null;
        base.sku = typeof state.sku === "string" ? state.sku : null;
        base.wireless = {
            wifi: typeof wifistat.wifi === "number" ? wifistat.wifi : null,
            cloud,
            cloud_status: cloudStatusLabel(cloud),
            ssid: typeof wlcfg.ssid === "string" ? wlcfg.ssid : null,
        };
        base.cloud_env =
            typeof cloudConfig.cloudEnv === "string"
                ? cloudConfig.cloudEnv
                : typeof state.cloudEnv === "string"
                    ? state.cloudEnv
                    : null;
        return base;
    }
    catch (error) {
        base.error = error instanceof Error ? error.message : String(error);
        return base;
    }
}
async function buildRoombaDiagnostics(settings) {
    const configured = isConfigured(settings);
    const host = settings.robot_ip.trim();
    const errors = [];
    let device = null;
    if (configured) {
        device = await fetchRoombaDeviceDiagnostics(settings);
        if (device.error) {
            errors.push(device.error);
        }
    }
    else {
        errors.push("Robot is not configured yet");
    }
    // Probe TCP only after MQTT — a raw socket to :8883 blocks the robot's single local MQTT slot.
    const reachability = device?.connected || !host
        ? { reachable: device?.connected ?? false, latencyMs: null }
        : await checkMqttReachable(host);
    if (host && !device?.connected && !reachability.reachable) {
        errors.push(`MQTT port ${MQTT_PORT} is not reachable at ${host}`);
    }
    return {
        configured,
        host,
        name: settings.robot_name,
        firmware_protocol: settings.firmware_version,
        mqtt: {
            host,
            port: MQTT_PORT,
            reachable: device?.connected || reachability.reachable,
            latency_ms: reachability.latencyMs,
        },
        device,
        errors,
    };
}
async function buildIrobotDiagnostics(settings) {
    const username = settings.irobot_username.trim();
    const password = settings.irobot_password.trim();
    const accountConfigured = Boolean(username && password);
    const errors = [];
    const discoveryProbe = await probeHttpGet(IROBOT_DISCOVERY_URL);
    if (!discoveryProbe.ok) {
        errors.push(discoveryProbe.error ??
            `iRobot discovery endpoint unreachable (HTTP ${discoveryProbe.status ?? "error"})`);
    }
    let endpoints = null;
    try {
        if (discoveryProbe.ok) {
            endpoints = await discoverIrobotEndpoints();
        }
    }
    catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
    }
    const result = {
        account_configured: accountConfigured,
        username_preview: username ? `${username.slice(0, 3)}…${username.slice(-4)}` : null,
        endpoints: {
            discovery_url: IROBOT_DISCOVERY_URL,
            discovery_reachable: discoveryProbe.ok,
            discovery_latency_ms: discoveryProbe.latency_ms,
            discovery_status: discoveryProbe.status,
            gigya_base: endpoints?.gigyaBase ?? null,
            http_base: endpoints?.httpBase ?? null,
        },
        account: {
            authenticated: false,
            robot_count: null,
        },
        matched_robot: null,
        robots: [],
        errors,
    };
    if (!accountConfigured) {
        errors.push("Add optional iRobot account credentials in Settings to load cloud robot registry");
        return result;
    }
    try {
        const login = await loginIrobotCloud(username, password);
        result.endpoints.gigya_base = login.endpoints.gigyaBase;
        result.endpoints.http_base = login.endpoints.httpBase;
        result.account.authenticated = true;
        result.robots = mapCloudRobots(login.robots, settings.blid.trim(), settings.password.trim());
        result.account.robot_count = result.robots.length;
        result.matched_robot = result.robots.find((robot) => robot.blid === settings.blid.trim()) ?? null;
        if (settings.blid.trim() && !result.matched_robot) {
            errors.push("Configured BLID was not found on this iRobot cloud account");
        }
    }
    catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
    }
    return result;
}
function getDorita980Version() {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require("dorita980/package.json").version;
    }
    catch {
        return null;
    }
}
function redactSecret(value, visible = 6) {
    if (!value)
        return value;
    if (value.length <= visible)
        return "…";
    return `${value.slice(0, visible)}…`;
}
async function parseExploreResponseBody(response) {
    const text = await response.text();
    if (!text)
        return null;
    try {
        return JSON.parse(text);
    }
    catch {
        return text;
    }
}
function redactGigyaLoginBody(body) {
    const redacted = { ...body };
    if (typeof redacted.UIDSignature === "string") {
        redacted.UIDSignature = redactSecret(redacted.UIDSignature, 10);
    }
    if (typeof redacted.sessionInfo === "object" && redacted.sessionInfo) {
        const sessionInfo = { ...redacted.sessionInfo };
        if (typeof sessionInfo.cookieValue === "string") {
            sessionInfo.cookieValue = "[redacted]";
        }
        redacted.sessionInfo = sessionInfo;
    }
    return redacted;
}
function redactCloudLoginBody(body) {
    const redacted = structuredClone(body);
    const credentials = redacted.credentials;
    if (credentials && typeof credentials === "object") {
        const creds = { ...credentials };
        creds.SecretKey = "[redacted]";
        if (typeof creds.SessionToken === "string") {
            creds.SessionToken = redactSecret(creds.SessionToken, 12);
        }
        redacted.credentials = creds;
    }
    const robots = redacted.robots;
    if (robots && typeof robots === "object") {
        const nextRobots = {};
        for (const [blid, robot] of Object.entries(robots)) {
            nextRobots[blid] = {
                ...robot,
                password: robot.password ? "[redacted]" : robot.password,
            };
        }
        redacted.robots = nextRobots;
    }
    return redacted;
}
function resolveExploreCredentials(settings, username, password) {
    const resolvedUsername = username?.trim() || settings.irobot_username.trim();
    const resolvedPassword = password?.trim() || settings.irobot_password.trim();
    if (!resolvedUsername || !resolvedPassword) {
        throw new Error("iRobot account username and password are required in the request body or Settings");
    }
    return { username: resolvedUsername, password: resolvedPassword };
}
function roombaExternalMeta(settings, notes) {
    return {
        method: "MQTT",
        protocol: "MQTT/TLS (dorita980)",
        url: `mqtts://${settings.robot_ip.trim()}:${MQTT_PORT}`,
        notes,
    };
}
function getIrobotDiscoveryUrl() {
    return IROBOT_DISCOVERY_URL;
}
async function exploreIrobotDiscovery() {
    const response = await fetch(IROBOT_DISCOVERY_URL, {
        signal: AbortSignal.timeout(HTTP_PROBE_TIMEOUT_MS),
        headers: { Connection: "close" },
    });
    const body = await parseExploreResponseBody(response);
    return {
        external: {
            method: "GET",
            protocol: "HTTPS",
            url: IROBOT_DISCOVERY_URL,
            notes: "Resolves Gigya, AWS, and iRobot HTTP hosts for the account region.",
        },
        http_status: response.status,
        ok: response.ok,
        body,
    };
}
async function exploreIrobotGigyaLogin(settings, username, password) {
    const credentials = resolveExploreCredentials(settings, username, password);
    const endpoints = await discoverIrobotEndpoints();
    const gigyaForm = new URLSearchParams({
        apiKey: endpoints.apiKey,
        targetenv: "mobile",
        loginID: credentials.username,
        password: credentials.password,
        format: "json",
        targetEnv: "mobile",
    });
    const response = await fetch(`${endpoints.gigyaBase}/accounts.login`, {
        method: "POST",
        body: gigyaForm,
        signal: AbortSignal.timeout(HTTP_PROBE_TIMEOUT_MS),
        headers: { Connection: "close" },
    });
    const body = await parseExploreResponseBody(response);
    return {
        external: {
            method: "POST",
            protocol: "HTTPS (Gigya)",
            url: `${endpoints.gigyaBase}/accounts.login`,
            notes: "Form body: apiKey, loginID, password, targetEnv=mobile.",
        },
        http_status: response.status,
        ok: response.ok && typeof body === "object" && body !== null && Number(body.errorCode) === 0,
        body: typeof body === "object" && body !== null ? redactGigyaLoginBody(body) : body,
    };
}
async function exploreIrobotCloudLogin(settings, username, password) {
    const credentials = resolveExploreCredentials(settings, username, password);
    const login = await loginIrobotCloud(credentials.username, credentials.password);
    const redactedLogin = redactCloudLoginBody({
        credentials: login.credentials,
        robots: login.robots,
    });
    return {
        external: {
            method: "POST",
            protocol: "HTTPS (iRobot cloud)",
            url: `${login.endpoints.httpBase}/v2/login`,
            notes: `JSON body includes app_id and Gigya uid/signature/timestamp. IoT host: ${login.endpoints.iotHost}`,
        },
        http_status: 200,
        ok: true,
        body: {
            endpoints: {
                gigya_base: login.endpoints.gigyaBase,
                http_base: login.endpoints.httpBase,
                iot_host: login.endpoints.iotHost,
                aws_region: login.endpoints.awsRegion,
            },
            credentials: redactedLogin.credentials,
            robots: redactedLogin.robots,
        },
    };
}
async function exploreIrobotSignedGet(settings, uri, query = "", username, password) {
    const credentials = resolveExploreCredentials(settings, username, password);
    const blid = settings.blid.trim();
    if (!blid) {
        throw new Error("Robot BLID must be configured in Settings");
    }
    const resolvedUri = uri.includes("{blid}") ? uri.replace("{blid}", blid) : uri;
    const login = await loginIrobotCloud(credentials.username, credentials.password);
    const response = await awsSignedGet(login.endpoints.iotHost, resolvedUri, query, login.credentials, login.endpoints.awsRegion);
    const body = await parseExploreResponseBody(response);
    const externalUrl = `https://${login.endpoints.iotHost}${resolvedUri}${query ? `?${query}` : ""}`;
    return {
        external: {
            method: "GET",
            protocol: "HTTPS (AWS SigV4)",
            url: externalUrl,
            notes: "Requires x-amz-date, x-amz-security-token, and Authorization headers from /v2/login credentials.",
        },
        http_status: response.status,
        ok: response.ok,
        body,
    };
}
async function exploreRoomba(settings, operation, payload = {}) {
    if (!isConfigured(settings)) {
        throw new Error("Robot is not configured yet");
    }
    return withRobot(settings, async (robot) => {
        switch (operation) {
            case "get-state": {
                const fields = payload.fields && payload.fields.length
                    ? payload.fields
                    : ["batPct", "cleanMissionStatus", "bin", "pmaps", "softwareVer", "sku", "lastCommand"];
                const body = await robot.getRobotState(fields);
                return {
                    external: roombaExternalMeta(settings, `dorita980.getRobotState(${JSON.stringify(fields)})`),
                    http_status: null,
                    ok: true,
                    body,
                };
            }
            case "preferences": {
                const body = await robot.getPreferences();
                return {
                    external: roombaExternalMeta(settings, "dorita980.getPreferences()"),
                    http_status: null,
                    ok: true,
                    body,
                };
            }
            case "wireless-status": {
                const body = await robot.getWirelessStatus();
                return {
                    external: roombaExternalMeta(settings, "dorita980.getWirelessStatus()"),
                    http_status: null,
                    ok: true,
                    body,
                };
            }
            case "cloud-config": {
                const body = await robot.getCloudConfig();
                return {
                    external: roombaExternalMeta(settings, "dorita980.getCloudConfig()"),
                    http_status: null,
                    ok: true,
                    body,
                };
            }
            case "start": {
                const result = await sendStartClean(robot);
                return {
                    external: roombaExternalMeta(settings, "dorita980.start() or resume()"),
                    http_status: null,
                    ok: true,
                    body: result,
                };
            }
            case "pause": {
                await robot.pause();
                const snapshot = await readMissionSnapshot(robot);
                return {
                    external: roombaExternalMeta(settings, "dorita980.pause()"),
                    http_status: null,
                    ok: true,
                    body: formatMissionState(snapshot.mission),
                };
            }
            case "resume": {
                await robot.resume();
                const snapshot = await readMissionSnapshot(robot);
                return {
                    external: roombaExternalMeta(settings, "dorita980.resume()"),
                    http_status: null,
                    ok: true,
                    body: formatMissionState(snapshot.mission),
                };
            }
            case "stop": {
                await robot.stop();
                const snapshot = await readMissionSnapshot(robot);
                return {
                    external: roombaExternalMeta(settings, "dorita980.stop()"),
                    http_status: null,
                    ok: true,
                    body: formatMissionState(snapshot.mission),
                };
            }
            case "dock": {
                const result = await sendDock(robot);
                return {
                    external: roombaExternalMeta(settings, "dorita980.dock()"),
                    http_status: null,
                    ok: true,
                    body: result,
                };
            }
            case "clean-room": {
                if (!payload.command || typeof payload.command !== "object") {
                    throw new Error("command object is required for clean-room");
                }
                await robot.cleanRoom(payload.command);
                const snapshot = await readMissionSnapshot(robot);
                return {
                    external: roombaExternalMeta(settings, "dorita980.cleanRoom(command)"),
                    http_status: null,
                    ok: true,
                    body: formatMissionState(snapshot.mission),
                };
            }
            default:
                throw new Error(`Unknown Roomba explore operation: ${String(operation)}`);
        }
    });
}
