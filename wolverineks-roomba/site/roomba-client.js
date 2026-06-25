"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLastError = getLastError;
exports.isMutexBusy = isMutexBusy;
exports.isDiscoveryBusy = isDiscoveryBusy;
exports.withRobot = withRobot;
exports.discoverRobots = discoverRobots;
exports.fetchCredentialsFromCloud = fetchCredentialsFromCloud;
exports.testConnection = testConnection;
exports.getRobotStatus = getRobotStatus;
exports.runRobotAction = runRobotAction;
exports.getRobotSchedule = getRobotSchedule;
exports.getRobotPreferences = getRobotPreferences;
exports.checkMqttReachable = checkMqttReachable;
exports.buildRoombaDiagnostics = buildRoombaDiagnostics;
exports.buildIrobotDiagnostics = buildIrobotDiagnostics;
exports.getDorita980Version = getDorita980Version;
const node_child_process_1 = require("node:child_process");
const node_dgram_1 = require("node:dgram");
const node_net_1 = require("node:net");
const node_util_1 = require("node:util");
const dorita980_1 = __importDefault(require("dorita980"));
const execFileAsync = (0, node_util_1.promisify)(node_child_process_1.execFile);
const CONNECT_TIMEOUT_MS = 15_000;
const ROBOT_READ_TIMEOUT_MS = 10_000;
const ROBOT_OPERATION_TIMEOUT_MS = 25_000;
const ROBOT_DISCONNECT_TIMEOUT_MS = 4_000;
const MQTT_PORT = 8883;
const DISCOVERY_PORT = 5678;
const DISCOVERY_MESSAGE = Buffer.from("irobotmcs");
const DISCOVERY_TIMEOUT_MS = 4_000;
const SUBNET_SCAN_TIMEOUT_MS = 10_000;
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
            robot.removeListener("close", onClose);
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
        const onClose = () => {
            if (!isRobotConnected(robot)) {
                finish(new Error(`Local MQTT connection closed before the robot responded.${mqttBusyHint()}`));
            }
        };
        robot.once("connect", onConnect);
        robot.once("error", onError);
        robot.once("close", onClose);
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
async function readRobotState(robot) {
    return withTimeout(robot.getRobotState(["batPct", "cleanMissionStatus", "bin"]), ROBOT_READ_TIMEOUT_MS, "Robot status");
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
        bin_full: null,
        bin_present: null,
        docked: null,
        sqft: null,
        mission_minutes: null,
        last_command: null,
        software_version: null,
        sku: null,
        last_sync: new Date().toISOString(),
    };
    if (!base.configured) {
        base.error = "Robot is not configured yet";
        return base;
    }
    try {
        const state = await withRobot(settings, async (robot) => readRobotState(robot));
        const mission = (state.cleanMissionStatus ?? {});
        const bin = (state.bin ?? {});
        const lastCommand = (state.lastCommand ?? {});
        base.connected = true;
        base.battery_percent = typeof state.batPct === "number" ? state.batPct : null;
        base.phase = typeof mission.phase === "string" ? mission.phase : null;
        base.cycle = typeof mission.cycle === "string" ? mission.cycle : null;
        base.bin_full = typeof bin.full === "boolean" ? bin.full : null;
        base.bin_present = typeof bin.present === "boolean" ? bin.present : null;
        base.docked = base.phase === "charge" || base.phase === "dock";
        base.sqft = typeof mission.sqft === "number" ? mission.sqft : null;
        base.mission_minutes = typeof mission.mssnM === "number" ? mission.mssnM : null;
        base.last_command = typeof lastCommand.command === "string" ? lastCommand.command : null;
        base.software_version = typeof state.softwareVer === "string" ? state.softwareVer : null;
        base.sku = typeof state.sku === "string" ? state.sku : null;
        return base;
    }
    catch (error) {
        base.error = error instanceof Error ? error.message : String(error);
        return base;
    }
}
async function runRobotAction(settings, action) {
    await withRobot(settings, async (robot) => {
        switch (action) {
            case "clean":
                await robot.clean();
                break;
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
                await robot.dock();
                break;
        }
    });
    return { ok: true };
}
async function getRobotSchedule(settings) {
    return withRobot(settings, async (robot) => robot.getWeek());
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
    let httpBase = process.env.IROBOT_HTTP_BASE ?? "";
    if (!httpBase) {
        const deploymentKeys = Object.keys(deployments).sort().reverse();
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
    if (!apiKey) {
        throw new Error("No Gigya API key in iRobot discovery response");
    }
    return { apiKey, gigyaBase, httpBase };
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
    if (!irobotResponse.ok || !irobotBody.robots) {
        throw new Error("iRobot cloud login failed — no robots returned");
    }
    return { endpoints, robots: irobotBody.robots };
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
