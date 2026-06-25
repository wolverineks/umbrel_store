"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLastError = getLastError;
exports.isMutexBusy = isMutexBusy;
exports.withRobot = withRobot;
exports.discoverRobots = discoverRobots;
exports.fetchCredentialsFromCloud = fetchCredentialsFromCloud;
exports.testConnection = testConnection;
exports.getRobotStatus = getRobotStatus;
exports.runRobotAction = runRobotAction;
exports.getRobotSchedule = getRobotSchedule;
exports.getRobotPreferences = getRobotPreferences;
exports.checkMqttReachable = checkMqttReachable;
exports.buildDiagnostics = buildDiagnostics;
const node_child_process_1 = require("node:child_process");
const node_net_1 = require("node:net");
const node_util_1 = require("node:util");
const dorita980_1 = __importDefault(require("dorita980"));
const execFileAsync = (0, node_util_1.promisify)(node_child_process_1.execFile);
const CONNECT_TIMEOUT_MS = 30_000;
const MQTT_PORT = 8883;
let mutexBusy = false;
const mutexQueue = [];
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
function isConfigured(settings) {
    return Boolean(settings.robot_ip.trim() && settings.blid.trim() && settings.password.trim());
}
function waitForConnect(robot) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error("Timed out connecting to the robot over local MQTT"));
        }, CONNECT_TIMEOUT_MS);
        const onConnect = () => {
            clearTimeout(timeout);
            robot.removeListener("error", onError);
            resolve();
        };
        const onError = (error) => {
            clearTimeout(timeout);
            robot.removeListener("connect", onConnect);
            reject(error);
        };
        robot.once("connect", onConnect);
        robot.once("error", onError);
    });
}
async function endRobot(robot) {
    try {
        await robot.end();
    }
    catch {
        // ignore disconnect errors
    }
}
async function withRobot(settings, fn) {
    if (!isConfigured(settings)) {
        throw new Error("Robot is not configured yet");
    }
    await acquireMutex();
    const robot = new dorita980_1.default.Local(settings.blid.trim(), settings.password.trim(), settings.robot_ip.trim(), settings.firmware_version.trim() || "3");
    try {
        await waitForConnect(robot);
        const result = await fn(robot);
        setLastError(null);
        return result;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setLastError(message);
        throw error;
    }
    finally {
        await endRobot(robot);
        releaseMutex();
    }
}
function discoverRobots() {
    return new Promise((resolve, reject) => {
        dorita980_1.default.discovery((error, robots) => {
            if (error) {
                reject(error);
                return;
            }
            const list = Array.isArray(robots) ? robots : robots ? [robots] : [];
            resolve(list.map((robot) => ({
                ip: String(robot.ip ?? ""),
                robotname: String(robot.robotname ?? "Roomba"),
                hostname: String(robot.hostname ?? ""),
                sw: String(robot.sw ?? ""),
                sku: String(robot.sku ?? ""),
                blid: robot.hostname?.replace(/^Roomba-/, ""),
            })));
        });
    });
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
        const state = await withRobot(settings, async (robot) => {
            return robot.getRobotState(["batPct", "cleanMissionStatus", "bin", "lastCommand", "sku", "softwareVer"]);
        });
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
async function buildDiagnostics(settings, settingsFileExists) {
    const reachability = settings.robot_ip
        ? await checkMqttReachable(settings.robot_ip)
        : { reachable: false, latencyMs: null };
    let doritaVersion = null;
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        doritaVersion = require("dorita980/package.json").version;
    }
    catch {
        doritaVersion = null;
    }
    return {
        configured: isConfigured(settings),
        robot_ip: settings.robot_ip,
        robot_name: settings.robot_name,
        firmware_version: settings.firmware_version,
        connection_mode: settings.connection_mode,
        live_poll_seconds: settings.live_poll_seconds,
        mqtt_reachable: reachability.reachable,
        mqtt_latency_ms: reachability.latencyMs,
        mutex_busy: mutexBusy,
        last_error: lastError,
        dorita980_version: doritaVersion,
        settings_file_exists: settingsFileExists,
        coexistence_note: "This app connects briefly over local MQTT, then disconnects so the official iRobot app can keep using iRobot cloud.",
    };
}
