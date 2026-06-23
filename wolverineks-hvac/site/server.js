"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_http_1 = require("node:http");
const promises_1 = require("node:fs/promises");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const carrier_api_1 = require("./carrier-api");
const APP_VERSION = "2.4.5";
const REFRESH_ICON_SVG = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>';
const IS_LOCAL_DEV = process.env.HVAC_DEV === "1";
const DATA_ROOT = process.env.HVAC_DATA_DIR ?? "/data";
const SETTINGS_PATH = node_path_1.default.join(DATA_ROOT, "settings.json");
const MAINTENANCE_PATH = node_path_1.default.join(DATA_ROOT, "maintenance.json");
const ICON_PATH = node_path_1.default.join(__dirname, "icon.svg");
const POLL_INTERVAL_MS = IS_LOCAL_DEV ? 10_000 : 30_000;
const STATUS_CACHE_MS = IS_LOCAL_DEV ? 3_000 : 15_000;
const SCHEDULE_DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ACTIVITY_DISPLAY_ORDER = ["home", "wake", "sleep", "away", "vacation", "manual"];
const CONDENSATE_INTERVAL_DAYS = 30;
const DEFAULT_SETTINGS = {
    system_name: "Home HVAC",
    username: "",
    password: "",
    system_serial: "",
};
let cachedSystems = [];
let cachedExplorerBundle = null;
let lastExplorerFetchAt = null;
let lastSyncAt = null;
let lastLiveUpdateAt = null;
let lastError = null;
let pollTimer = null;
let apiClient = null;
let apiClientKey = "";
let realtime = null;
let realtimeKey = "";
const OPERATION_HISTORY_MAX = 10;
const TRANSITION_WINDOW_MS = 60_000;
const OPERATION_SAMPLE_MIN_MS = 2_000;
const operationHistoryByZone = new Map();
function escapeHtml(value) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
function isConfigured(settings) {
    return Boolean(settings.username.trim() && settings.password);
}
function publicSettings(settings) {
    return {
        system_name: settings.system_name,
        username: settings.username,
        system_serial: settings.system_serial,
        configured: isConfigured(settings),
    };
}
async function loadSettings() {
    if (!(0, node_fs_1.existsSync)(SETTINGS_PATH)) {
        return { ...DEFAULT_SETTINGS };
    }
    try {
        const raw = await (0, promises_1.readFile)(SETTINGS_PATH, "utf8");
        const parsed = JSON.parse(raw);
        return {
            system_name: parsed.system_name?.trim() || DEFAULT_SETTINGS.system_name,
            username: parsed.username?.trim() ?? "",
            password: parsed.password ?? "",
            system_serial: parsed.system_serial?.trim() ?? "",
        };
    }
    catch {
        return { ...DEFAULT_SETTINGS };
    }
}
async function saveSettings(settings) {
    await (0, promises_1.mkdir)(DATA_ROOT, { recursive: true });
    await (0, promises_1.writeFile)(SETTINGS_PATH, JSON.stringify(settings, null, 2), { mode: 0o600 });
}
async function loadMaintenanceStore() {
    if (!(0, node_fs_1.existsSync)(MAINTENANCE_PATH)) {
        return { systems: {} };
    }
    try {
        const raw = await (0, promises_1.readFile)(MAINTENANCE_PATH, "utf8");
        const parsed = JSON.parse(raw);
        return {
            systems: parsed.systems && typeof parsed.systems === "object" ? parsed.systems : {},
        };
    }
    catch {
        return { systems: {} };
    }
}
async function saveMaintenanceStore(store) {
    await (0, promises_1.mkdir)(DATA_ROOT, { recursive: true });
    await (0, promises_1.writeFile)(MAINTENANCE_PATH, JSON.stringify(store, null, 2), { mode: 0o600 });
}
function buildCondensateView(serial, store) {
    const record = store.systems[serial];
    const lastClearedAt = record?.condensate_cleared_at ?? null;
    if (!lastClearedAt) {
        return {
            interval_days: CONDENSATE_INTERVAL_DAYS,
            last_cleared_at: null,
            next_due_at: null,
            days_remaining: null,
            days_overdue: 0,
            status: "unknown",
        };
    }
    const lastCleared = new Date(lastClearedAt);
    if (Number.isNaN(lastCleared.getTime())) {
        return {
            interval_days: CONDENSATE_INTERVAL_DAYS,
            last_cleared_at: null,
            next_due_at: null,
            days_remaining: null,
            days_overdue: 0,
            status: "unknown",
        };
    }
    const nextDue = new Date(lastCleared.getTime() + CONDENSATE_INTERVAL_DAYS * 86_400_000);
    const daysRemaining = Math.ceil((nextDue.getTime() - Date.now()) / 86_400_000);
    if (daysRemaining <= 0) {
        return {
            interval_days: CONDENSATE_INTERVAL_DAYS,
            last_cleared_at: lastClearedAt,
            next_due_at: nextDue.toISOString(),
            days_remaining: 0,
            days_overdue: Math.abs(daysRemaining),
            status: "overdue",
        };
    }
    return {
        interval_days: CONDENSATE_INTERVAL_DAYS,
        last_cleared_at: lastClearedAt,
        next_due_at: nextDue.toISOString(),
        days_remaining: daysRemaining,
        days_overdue: 0,
        status: daysRemaining <= 7 ? "due_soon" : "ok",
    };
}
async function buildMaintenanceSnapshot(settings) {
    const system = selectSystem(settings, cachedSystems);
    const store = await loadMaintenanceStore();
    const serial = system?.profile.serial ?? settings.system_serial;
    return {
        configured: isConfigured(settings),
        connected: Boolean(system && !system.status.isDisconnected),
        error: lastError,
        last_sync: lastSyncAt?.toISOString() ?? null,
        system: system
            ? {
                serial: system.profile.serial,
                name: settings.system_name || system.profile.name,
                brand: system.profile.brand,
                model: system.profile.model,
                firmware: system.profile.firmware,
                mode: (system.status.mode ?? system.config.mode ?? "auto").toLowerCase(),
                outdoor_temp: (0, carrier_api_1.toFahrenheit)(system.status.oat, system.status.cfgem),
                filter_remaining: system.status.filtrlvl,
                filter_type: system.config.filterType,
                filter_interval: system.config.filterInterval,
                disconnected: Boolean(system.status.isDisconnected),
                temperature_unit: "F",
                outdoor_temp_display: (0, carrier_api_1.formatFahrenheit)(system.status.oat, system.status.cfgem),
            }
            : null,
        condensate: serial ? buildCondensateView(serial, store) : buildCondensateView("", { systems: {} }),
    };
}
function getClient(settings) {
    const key = `${settings.username}\u0000${settings.password}`;
    if (!apiClient || apiClientKey !== key) {
        apiClient = new carrier_api_1.CarrierApiClient(settings.username, settings.password);
        apiClientKey = key;
    }
    return apiClient;
}
function resetCloudConnections() {
    realtime?.stop();
    realtime = null;
    realtimeKey = "";
    apiClient = null;
    apiClientKey = "";
}
function findStatusZone(system, zoneId) {
    return system.status.zones.find((zone) => (0, carrier_api_1.zoneIdsMatch)(zone.id, zoneId));
}
function findConfigZone(system, zoneId) {
    return system.config.zones.find((zone) => (0, carrier_api_1.zoneIdsMatch)(zone.id, zoneId));
}
function ensureRealtime(settings) {
    if (!isConfigured(settings)) {
        resetCloudConnections();
        return;
    }
    const key = `${settings.username}\u0000${settings.password}`;
    if (realtime && realtimeKey === key)
        return;
    realtime?.stop();
    realtimeKey = key;
    const client = getClient(settings);
    realtime = new carrier_api_1.CarrierRealtime(() => client.getAccessToken(), (message) => {
        if ((0, carrier_api_1.applyInfinityStatusMessage)(cachedSystems, message)) {
            lastLiveUpdateAt = new Date();
            const liveSystem = selectSystem(settings, cachedSystems);
            if (liveSystem) {
                for (const statusZone of liveSystem.status.zones) {
                    if (statusZone.enabled !== "on")
                        continue;
                    recordOperationSample(statusZone.id, liveSystem, statusZone.zoneconditioning ?? "idle");
                }
            }
        }
    });
    realtime.start();
}
function selectSystem(settings, systems) {
    if (!systems.length)
        return null;
    if (settings.system_serial) {
        return systems.find((system) => system.profile.serial === settings.system_serial) ?? null;
    }
    return systems[0] ?? null;
}
function isZoneEnabled(configZone, statusZone) {
    const enabled = statusZone?.enabled ?? configZone.enabled;
    return enabled === "on";
}
function normalizeFanMode(fan) {
    if (!fan)
        return null;
    const value = fan.toLowerCase();
    if (value === "off")
        return "auto";
    return value;
}
function formatCarrierSetpoint(value, fallback) {
    const parsed = Number(value);
    const resolved = Number.isFinite(parsed) ? parsed : fallback;
    return resolved.toFixed(1);
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function zoneFanRuntimeMatches(zone, expectedFan) {
    const normalized = normalizeFanMode(expectedFan) ?? expectedFan;
    if (normalized === "auto") {
        return zone.fan_speed === "off" || zone.fan_speed == null;
    }
    if (normalized === "low") {
        return zone.fan_speed === "low" || zone.fan_speed === "on";
    }
    return zone.fan_speed === normalized;
}
function zoneFanReady(zone, expectedFan, beforeFan) {
    const normalized = normalizeFanMode(expectedFan) ?? expectedFan;
    if (zone.fan !== normalized)
        return false;
    if (beforeFan !== normalized)
        return true;
    return zoneFanRuntimeMatches(zone, expectedFan);
}
async function waitForCloudZoneFan(settings, zoneId, expectedFan, beforeFan) {
    await sleep(2000);
    for (let attempt = 0; attempt < 5; attempt++) {
        if (attempt > 0)
            await sleep(1500);
        await refreshCloudData(settings, true);
        const zone = buildSnapshot(settings).zones.find((item) => (0, carrier_api_1.zoneIdsMatch)(item.id, zoneId)) ?? null;
        if (zone && zoneFanReady(zone, expectedFan, beforeFan))
            return zone;
    }
    return null;
}
function setpointDisplayMatches(display, expected) {
    if (expected === null || expected === undefined || expected === "")
        return true;
    const parsedExpected = Number.parseInt(String(expected), 10);
    const parsedDisplay = Number.parseInt(String(display ?? ""), 10);
    if (!Number.isFinite(parsedExpected))
        return true;
    return Number.isFinite(parsedDisplay) && parsedDisplay === parsedExpected;
}
function zoneSetpointsReady(zone, expectedHeat, expectedCool) {
    const heatOk = setpointDisplayMatches(zone.heat_setpoint_display ?? zone.heat_setpoint, expectedHeat);
    const coolOk = setpointDisplayMatches(zone.cool_setpoint_display ?? zone.cool_setpoint, expectedCool);
    return heatOk && coolOk;
}
async function waitForCloudZoneSetpoints(settings, zoneId, expectedHeat, expectedCool) {
    await sleep(2000);
    for (let attempt = 0; attempt < 5; attempt++) {
        if (attempt > 0)
            await sleep(1500);
        await refreshCloudData(settings, true);
        const zone = buildSnapshot(settings).zones.find((item) => (0, carrier_api_1.zoneIdsMatch)(item.id, zoneId)) ?? null;
        if (zone && zoneSetpointsReady(zone, expectedHeat, expectedCool))
            return zone;
    }
    return null;
}
function formatFanSettingLabel(fan) {
    const normalized = normalizeFanMode(fan);
    if (!normalized)
        return null;
    if (normalized === "auto")
        return "Auto";
    if (normalized === "on")
        return "On";
    if (normalized === "low")
        return "Low";
    if (normalized === "med")
        return "Medium";
    if (normalized === "high")
        return "High";
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}
function formatFanSpeedLabel(speed) {
    if (!speed || speed === "off")
        return "Off";
    if (speed === "on")
        return "Low";
    if (speed === "low")
        return "Low";
    if (speed === "med")
        return "Medium";
    if (speed === "high")
        return "High";
    return speed.charAt(0).toUpperCase() + speed.slice(1);
}
function parseCompressorStage(opstat, conditioning, systemMode) {
    const value = String(opstat || "").toLowerCase();
    if (value.includes("defrost")) {
        return { stage: 0, heatCool: "heat", defrost: true };
    }
    const stageMatch = value.match(/stage\s*(\d+)/i);
    let stage = stageMatch ? Number.parseInt(stageMatch[1], 10) : 0;
    if (!Number.isFinite(stage) || stage < 0)
        stage = 0;
    stage = Math.min(5, stage);
    let heatCool = null;
    if (value.includes("heat"))
        heatCool = "heat";
    else if (value.includes("cool"))
        heatCool = "cool";
    const cond = conditioning.toLowerCase();
    if (!heatCool && cond.includes("heat"))
        heatCool = "heat";
    else if (!heatCool && cond.includes("cool"))
        heatCool = "cool";
    else if (!heatCool && stage > 0) {
        const mode = systemMode.toLowerCase();
        if (mode === "heat" || mode === "emheat")
            heatCool = "heat";
        else if (mode === "cool")
            heatCool = "cool";
    }
    if (stage === 0 && (value.includes("heat") || value.includes("cool"))) {
        return {
            stage: 1,
            heatCool: value.includes("heat") ? "heat" : "cool",
            defrost: false,
        };
    }
    return { stage, heatCool, defrost: false };
}
function conditioningCategory(conditioning) {
    const value = String(conditioning || "idle").toLowerCase();
    if (value.includes("prep") || value.includes("pending")) {
        if (value.includes("heat"))
            return "prep_heat";
        if (value.includes("cool"))
            return "prep_cool";
        return "prep";
    }
    if (value.includes("heat"))
        return "heat";
    if (value.includes("cool"))
        return "cool";
    if (value.includes("fan"))
        return "fan";
    if (value === "idle" || value === "off")
        return "idle";
    return value;
}
function pushOperationSample(zoneId, sample) {
    const history = operationHistoryByZone.get(zoneId) ?? [];
    const last = history[history.length - 1];
    if (last &&
        sample.at - last.at < OPERATION_SAMPLE_MIN_MS &&
        last.conditioning === sample.conditioning &&
        last.stage === sample.stage &&
        last.blwrpm === sample.blwrpm &&
        last.oduOpstat === sample.oduOpstat) {
        return;
    }
    history.push(sample);
    if (history.length > OPERATION_HISTORY_MAX)
        history.shift();
    operationHistoryByZone.set(zoneId, history);
}
function recordOperationSample(zoneId, system, conditioning) {
    const systemMode = system.status.mode ?? system.config.mode ?? "auto";
    const parsed = parseCompressorStage(system.status.odu?.opstat, conditioning, systemMode);
    const sample = {
        at: Date.now(),
        conditioning,
        oduOpstat: system.status.odu?.opstat ?? null,
        blwrpm: system.status.idu?.blwrpm ?? null,
        stage: parsed.stage,
        heatCool: parsed.heatCool,
    };
    pushOperationSample(zoneId, sample);
    return sample;
}
function recentOperationSamples(zoneId) {
    const cutoff = Date.now() - TRANSITION_WINDOW_MS;
    return (operationHistoryByZone.get(zoneId) ?? []).filter((sample) => sample.at >= cutoff);
}
function hasRecentOperationChange(history, current) {
    if (history.length < 2)
        return false;
    const prior = history.slice(0, -1);
    return prior.some((sample) => {
        if (sample.conditioning !== current.conditioning)
            return true;
        if ((sample.stage === 0) !== (current.stage === 0))
            return true;
        if (sample.heatCool !== current.heatCool)
            return true;
        const priorRpm = sample.blwrpm ?? 0;
        const currentRpm = current.blwrpm ?? 0;
        return Math.abs(currentRpm - priorRpm) >= 350;
    });
}
function isEnteringConditioning(history, category) {
    if (!category.startsWith("prep") && category !== "heat" && category !== "cool")
        return false;
    const prior = history.slice(0, -1);
    return prior.some((sample) => conditioningCategory(sample.conditioning) === "idle");
}
function isLeavingConditioning(history, category) {
    if (category !== "idle")
        return false;
    const prior = history.slice(0, -1);
    return prior.some((sample) => {
        const priorCategory = conditioningCategory(sample.conditioning);
        return priorCategory === "heat" || priorCategory === "cool" || priorCategory.startsWith("prep");
    });
}
function transitionDirection(history, current) {
    if (history.length < 2)
        return "steady";
    const oldest = history[0];
    const currentRpm = current.blwrpm ?? 0;
    const oldestRpm = oldest.blwrpm ?? 0;
    if (current.stage > oldest.stage || currentRpm > oldestRpm + 250)
        return "up";
    if (current.stage < oldest.stage || (oldestRpm > 350 && currentRpm < oldestRpm - 250))
        return "down";
    return "steady";
}
function formatBlowerTelemetry(value, unit) {
    if (value == null || !Number.isFinite(Number(value)))
        return "Off";
    const rounded = Math.round(Number(value));
    if (rounded <= 0)
        return "Off";
    return `${rounded} ${unit}`;
}
function blowerTelemetryActive(idu) {
    const rpm = idu?.blwrpm ?? 0;
    const cfm = idu?.cfm ?? 0;
    return rpm > 80 || cfm > 50;
}
function buildBlowerMetrics(idu, fanSetting, fanSpeed) {
    const rpm = formatBlowerTelemetry(idu?.blwrpm, "RPM");
    const cfm = formatBlowerTelemetry(idu?.cfm, "CFM");
    const setting = formatFanSettingLabel(fanSetting) ?? formatFanSpeedLabel(fanSpeed);
    return {
        rpm,
        cfm,
        setting,
        combined: `${rpm} · ${cfm}`,
    };
}
function formatBlowerDetail(idu) {
    const rpm = formatBlowerTelemetry(idu?.blwrpm, "RPM");
    const cfm = formatBlowerTelemetry(idu?.cfm, "CFM");
    return `${rpm} · ${cfm}`;
}
function isBlowerCirculating(idu) {
    return blowerTelemetryActive(idu);
}
function presentZoneOperation(system, conditioning, zoneId, fanSetting, fanSpeed) {
    const conditioningValue = String(conditioning || "idle");
    const category = conditioningCategory(conditioningValue);
    const systemMode = (system.status.mode ?? system.config.mode ?? "auto").toLowerCase();
    const current = recordOperationSample(zoneId, system, conditioningValue);
    const history = recentOperationSamples(zoneId);
    const parsed = parseCompressorStage(system.status.odu?.opstat, conditioningValue, systemMode);
    const blowerDetail = formatBlowerDetail(system.status.idu);
    const rpm = system.status.idu?.blwrpm ?? 0;
    const fanOnlyMode = systemMode === "fanonly" || systemMode === "fan_only";
    const contradictoryIdle = category === "idle" && (parsed.stage > 0 || rpm > 300);
    const explicitPrep = category.startsWith("prep");
    const recentChange = hasRecentOperationChange(history, current);
    const transition = explicitPrep ||
        (contradictoryIdle && recentChange) ||
        (recentChange && (isEnteringConditioning(history, category) || isLeavingConditioning(history, category)));
    let kind = "idle";
    let summary = "Standing by";
    let className = "status-idle";
    let stage = parsed.stage;
    const detailParts = [];
    if (parsed.defrost) {
        kind = "defrost";
        summary = "Defrosting";
        className = "status-heating";
    }
    else if (transition) {
        kind = "transition";
        className = "status-transition";
        if (category === "prep_heat")
            summary = "Getting ready to heat";
        else if (category === "prep_cool")
            summary = "Getting ready to cool";
        else if (category === "prep")
            summary = "Getting ready";
        else {
            const direction = transitionDirection(history, current);
            summary = direction === "down" ? "Winding down" : "Starting up";
        }
    }
    else if (category === "heat" || (contradictoryIdle && parsed.heatCool === "heat")) {
        kind = "heating";
        summary = "Heating";
        className = "status-heating";
        stage = Math.max(stage, 1);
    }
    else if (category === "cool" || (contradictoryIdle && parsed.heatCool === "cool")) {
        kind = "cooling";
        summary = "Cooling";
        className = "status-cooling";
        stage = Math.max(stage, 1);
    }
    else if (category === "fan" || fanOnlyMode) {
        kind = "fan";
        summary = "Fan running";
        className = "status-fan";
    }
    else if (isBlowerCirculating(system.status.idu)) {
        kind = "circulating";
        summary = "Circulating air";
        className = "status-fan";
    }
    else {
        kind = "idle";
        summary = "Standing by";
        className = "status-idle";
    }
    if (kind === "heating" || kind === "cooling") {
        if (stage > 0)
            detailParts.push(`Stage ${stage}`);
        if (blowerDetail)
            detailParts.push(blowerDetail);
    }
    else if (kind === "circulating" || kind === "fan") {
        if (blowerDetail)
            detailParts.push(blowerDetail);
    }
    else if (kind === "defrost") {
        if (blowerDetail)
            detailParts.push(blowerDetail);
    }
    else if (kind === "transition" && blowerDetail) {
        detailParts.push(blowerDetail);
    }
    else if (kind === "idle") {
        const modeLabel = fanOnlyMode ? "Fan only" : systemMode === "auto" ? "Auto" : systemMode.charAt(0).toUpperCase() + systemMode.slice(1);
        detailParts.push(modeLabel);
        if (blowerDetail)
            detailParts.push(blowerDetail);
    }
    return {
        summary,
        className,
        detail: detailParts.length ? detailParts.join(" · ") : null,
        kind,
        stage,
        transition,
    };
}
function formatBlowerLiveDisplay(idu, fanSetting, fanSpeed) {
    return buildBlowerMetrics(idu, fanSetting, fanSpeed).combined;
}
function resolveFanSetting(statusZone, configZone) {
    if (!configZone)
        return "auto";
    const onHold = configZone.hold === "on" || statusZone?.hold === "on";
    const heldActivity = configZone.holdActivity ?? (onHold ? statusZone?.currentActivity : null);
    const activityType = onHold && heldActivity
        ? heldActivity
        : statusZone?.currentActivity ?? configZone.activities[0]?.type ?? null;
    if (!activityType)
        return "auto";
    const activity = configZone.activities.find((item) => item.type === activityType);
    return normalizeFanMode(activity?.fan) ?? "auto";
}
function resolveZoneSetpoints(statusZone, configZone) {
    let heat = statusZone?.htsp ?? null;
    let cool = statusZone?.clsp ?? null;
    const onHold = configZone?.hold === "on" || statusZone?.hold === "on";
    const heldActivity = configZone?.holdActivity ?? (onHold ? statusZone?.currentActivity : null);
    if (onHold && heldActivity && configZone) {
        const activity = configZone.activities.find((item) => item.type === heldActivity);
        if (activity) {
            heat = activity.htsp;
            cool = activity.clsp;
        }
    }
    return { heat, cool };
}
function resolveFanSpeed(statusZone) {
    if (!statusZone?.fan)
        return "off";
    const value = statusZone.fan.toLowerCase();
    if (value === "on")
        return "low";
    if (["off", "low", "med", "high"].includes(value))
        return value;
    return value;
}
function mapZones(system) {
    const cfgem = system.status.cfgem;
    const enabledStatusZones = system.status.zones.filter((zone) => zone.enabled === "on");
    const zonesToMap = enabledStatusZones.length
        ? enabledStatusZones.map((statusZone) => ({
            statusZone,
            configZone: findConfigZone(system, statusZone.id),
        }))
        : system.config.zones
            .filter((configZone) => isZoneEnabled(configZone, findStatusZone(system, configZone.id)))
            .map((configZone) => ({
            statusZone: findStatusZone(system, configZone.id),
            configZone,
        }));
    const zones = [];
    for (const { statusZone, configZone } of zonesToMap) {
        if (!statusZone && !configZone)
            continue;
        const zoneId = configZone?.id ?? statusZone?.id ?? "";
        const presets = (configZone?.activities ?? []).map((activity) => activity.type);
        if (!presets.includes("resume"))
            presets.push("resume");
        const indoorTemp = statusZone?.rt ?? null;
        const fan = resolveFanSetting(statusZone, configZone);
        const fanSpeed = resolveFanSpeed(statusZone);
        const setpoints = resolveZoneSetpoints(statusZone, configZone);
        const onHold = configZone?.hold === "on" || statusZone?.hold === "on";
        const conditioning = statusZone?.zoneconditioning ?? "idle";
        const blowerMetrics = buildBlowerMetrics(system.status.idu, fan, fanSpeed);
        const operation = presentZoneOperation(system, conditioning, zoneId, fan, fanSpeed);
        zones.push({
            id: zoneId,
            name: configZone?.name ?? `Zone ${zoneId}`,
            temperature: (0, carrier_api_1.toFahrenheit)(indoorTemp, cfgem),
            temperature_display: (0, carrier_api_1.formatFahrenheit)(indoorTemp, cfgem),
            heat_setpoint_display: (0, carrier_api_1.formatFahrenheit)(setpoints.heat, cfgem),
            cool_setpoint_display: (0, carrier_api_1.formatFahrenheit)(setpoints.cool, cfgem),
            humidity: statusZone?.rh ?? null,
            heat_setpoint: (0, carrier_api_1.toFahrenheit)(setpoints.heat, cfgem),
            cool_setpoint: (0, carrier_api_1.toFahrenheit)(setpoints.cool, cfgem),
            sensor_rt: indoorTemp,
            fan,
            fan_speed: fanSpeed,
            fan_display: blowerMetrics.combined,
            fan_rpm_display: blowerMetrics.rpm,
            fan_cfm_display: blowerMetrics.cfm,
            fan_setting_display: blowerMetrics.setting,
            activity: onHold
                ? (configZone?.holdActivity ?? statusZone?.currentActivity ?? null)
                : (statusZone?.currentActivity ?? null),
            conditioning,
            hold: onHold,
            hold_activity: configZone?.holdActivity ?? (onHold ? statusZone?.currentActivity ?? null : null),
            hold_until: configZone?.otmr ?? null,
            presets,
            operation_summary: operation.summary,
            operation_class: operation.className,
            operation_detail: operation.detail,
            operation_kind: operation.kind,
            operation_stage: operation.stage,
            operation_transition: operation.transition,
        });
    }
    return zones;
}
function formatActivityLabel(activity) {
    if (!activity)
        return "—";
    const labels = {
        manual: "Hold",
        home: "Home",
        away: "Away",
        sleep: "Sleep",
        wake: "Wake up",
        vacation: "Away long-term",
    };
    return labels[activity] ?? activity.charAt(0).toUpperCase() + activity.slice(1);
}
function parseTimeMinutes(time) {
    const [hours, minutes] = time.split(":").map((part) => Number.parseInt(part, 10));
    if (!Number.isFinite(hours) || !Number.isFinite(minutes))
        return 0;
    return hours * 60 + minutes;
}
function mapScheduleZones(system) {
    const cfgem = system.status.cfgem;
    const zones = [];
    for (const configZone of system.config.zones) {
        const statusZone = findStatusZone(system, configZone.id);
        if (!isZoneEnabled(configZone, statusZone))
            continue;
        const activityByType = new Map(configZone.activities.map((activity) => [activity.type, activity]));
        const programDays = configZone.program?.days ?? [];
        const days = [];
        for (let dayId = 0; dayId < 7; dayId += 1) {
            const programDay = programDays.find((day) => day.id === dayId) ??
                programDays.find((day) => day.periods.some((period) => period.dayId === dayId));
            const periods = (programDay?.periods ?? [])
                .filter((period) => period.enabled && period.dayId === dayId)
                .sort((left, right) => parseTimeMinutes(left.time) - parseTimeMinutes(right.time))
                .map((period) => {
                const activity = activityByType.get(period.activity);
                return {
                    time: period.time,
                    time_minutes: parseTimeMinutes(period.time),
                    activity: period.activity,
                    activity_label: formatActivityLabel(period.activity),
                    heat_setpoint_display: (0, carrier_api_1.formatFahrenheit)(activity?.htsp ?? null, cfgem),
                    cool_setpoint_display: (0, carrier_api_1.formatFahrenheit)(activity?.clsp ?? null, cfgem),
                    fan: activity?.fan ?? null,
                };
            });
            days.push({
                day_id: dayId,
                day_name: SCHEDULE_DAY_NAMES[dayId] ?? `Day ${dayId}`,
                periods,
            });
        }
        const currentActivity = statusZone?.currentActivity ?? null;
        zones.push({
            id: configZone.id,
            name: configZone.name,
            hold: configZone.hold === "on",
            hold_activity: configZone.holdActivity,
            current_activity: currentActivity,
            current_activity_label: formatActivityLabel(configZone.hold === "on" ? configZone.holdActivity : currentActivity),
            days,
        });
    }
    return zones;
}
function mapActivityZones(system) {
    const cfgem = system.status.cfgem;
    const zones = [];
    for (const configZone of system.config.zones) {
        const statusZone = findStatusZone(system, configZone.id);
        if (!isZoneEnabled(configZone, statusZone))
            continue;
        const onHold = configZone.hold === "on" || statusZone?.hold === "on";
        const heldActivity = configZone.holdActivity ?? (onHold ? statusZone?.currentActivity ?? null : null);
        const currentActivity = statusZone?.currentActivity ?? null;
        const activityByType = new Map(configZone.activities.map((activity) => [activity.type, activity]));
        const activities = [];
        for (const type of ACTIVITY_DISPLAY_ORDER) {
            const activity = activityByType.get(type);
            if (!activity)
                continue;
            activities.push({
                type,
                label: formatActivityLabel(type),
                heat_setpoint_display: (0, carrier_api_1.formatFahrenheit)(activity.htsp, cfgem),
                cool_setpoint_display: (0, carrier_api_1.formatFahrenheit)(activity.clsp, cfgem),
                heat_setpoint: (0, carrier_api_1.toFahrenheit)(activity.htsp, cfgem),
                cool_setpoint: (0, carrier_api_1.toFahrenheit)(activity.clsp, cfgem),
                fan: normalizeFanMode(activity.fan),
                fan_label: formatFanSettingLabel(activity.fan),
                is_current: onHold ? type === heldActivity : type === currentActivity,
                is_held: onHold && type === heldActivity,
            });
        }
        for (const activity of configZone.activities) {
            if (ACTIVITY_DISPLAY_ORDER.includes(activity.type))
                continue;
            activities.push({
                type: activity.type,
                label: formatActivityLabel(activity.type),
                heat_setpoint_display: (0, carrier_api_1.formatFahrenheit)(activity.htsp, cfgem),
                cool_setpoint_display: (0, carrier_api_1.formatFahrenheit)(activity.clsp, cfgem),
                heat_setpoint: (0, carrier_api_1.toFahrenheit)(activity.htsp, cfgem),
                cool_setpoint: (0, carrier_api_1.toFahrenheit)(activity.clsp, cfgem),
                fan: normalizeFanMode(activity.fan),
                fan_label: formatFanSettingLabel(activity.fan),
                is_current: onHold ? activity.type === heldActivity : activity.type === currentActivity,
                is_held: onHold && activity.type === heldActivity,
            });
        }
        zones.push({
            id: configZone.id,
            name: configZone.name,
            hold: onHold,
            current_activity: onHold ? heldActivity : currentActivity,
            current_activity_label: formatActivityLabel(onHold ? heldActivity : currentActivity),
            activities,
        });
    }
    return zones;
}
function buildActivitiesSnapshot(settings) {
    const system = selectSystem(settings, cachedSystems);
    return {
        connected: Boolean(system && !system.status.isDisconnected),
        configured: isConfigured(settings),
        error: lastError,
        last_sync: lastSyncAt?.toISOString() ?? null,
        system: system
            ? {
                serial: system.profile.serial,
                name: settings.system_name || system.profile.name,
                brand: system.profile.brand,
                model: system.profile.model,
                firmware: system.profile.firmware,
                mode: (system.status.mode ?? system.config.mode ?? "auto").toLowerCase(),
                outdoor_temp: (0, carrier_api_1.toFahrenheit)(system.status.oat, system.status.cfgem),
                filter_remaining: system.status.filtrlvl,
                filter_type: system.config.filterType,
                filter_interval: system.config.filterInterval,
                disconnected: Boolean(system.status.isDisconnected),
                temperature_unit: "F",
                outdoor_temp_display: (0, carrier_api_1.formatFahrenheit)(system.status.oat, system.status.cfgem),
            }
            : null,
        zones: system ? mapActivityZones(system) : [],
    };
}
function buildScheduleSnapshot(settings) {
    const system = selectSystem(settings, cachedSystems);
    return {
        connected: Boolean(system && !system.status.isDisconnected),
        configured: isConfigured(settings),
        error: lastError,
        last_sync: lastSyncAt?.toISOString() ?? null,
        system: system
            ? {
                serial: system.profile.serial,
                name: settings.system_name || system.profile.name,
                brand: system.profile.brand,
                model: system.profile.model,
                firmware: system.profile.firmware,
                mode: (system.status.mode ?? system.config.mode ?? "auto").toLowerCase(),
                outdoor_temp: (0, carrier_api_1.toFahrenheit)(system.status.oat, system.status.cfgem),
                filter_remaining: system.status.filtrlvl,
                filter_type: system.config.filterType,
                filter_interval: system.config.filterInterval,
                disconnected: Boolean(system.status.isDisconnected),
                temperature_unit: "F",
                outdoor_temp_display: (0, carrier_api_1.formatFahrenheit)(system.status.oat, system.status.cfgem),
            }
            : null,
        zones: system ? mapScheduleZones(system) : [],
    };
}
function buildSnapshot(settings) {
    const system = selectSystem(settings, cachedSystems);
    return {
        connected: Boolean(system && !system.status.isDisconnected),
        configured: isConfigured(settings),
        error: lastError,
        last_sync: lastSyncAt?.toISOString() ?? null,
        identity_id: null,
        system: system
            ? {
                serial: system.profile.serial,
                name: settings.system_name || system.profile.name,
                brand: system.profile.brand,
                model: system.profile.model,
                firmware: system.profile.firmware,
                mode: (system.status.mode ?? system.config.mode ?? "auto").toLowerCase(),
                outdoor_temp: (0, carrier_api_1.toFahrenheit)(system.status.oat, system.status.cfgem),
                filter_remaining: system.status.filtrlvl,
                filter_type: system.config.filterType,
                filter_interval: system.config.filterInterval,
                disconnected: Boolean(system.status.isDisconnected),
                temperature_unit: "F",
                outdoor_temp_display: (0, carrier_api_1.formatFahrenheit)(system.status.oat, system.status.cfgem),
            }
            : null,
        zones: system ? mapZones(system) : [],
        systems: cachedSystems.map((item) => ({
            serial: item.profile.serial,
            name: item.profile.name,
            model: item.profile.model,
        })),
        last_live_update: lastLiveUpdateAt?.toISOString() ?? null,
    };
}
async function refreshCloudData(settings, force = false) {
    if (!isConfigured(settings)) {
        cachedSystems = [];
        lastError = null;
        lastSyncAt = null;
        return buildSnapshot(settings);
    }
    if (!force && lastSyncAt && Date.now() - lastSyncAt.getTime() < STATUS_CACHE_MS) {
        return buildSnapshot(settings);
    }
    try {
        const client = getClient(settings);
        cachedSystems = await client.loadSystems();
        lastSyncAt = new Date();
        lastError = null;
        ensureRealtime(settings);
        const selected = selectSystem(settings, cachedSystems);
        if (selected && !settings.system_serial) {
            settings.system_serial = selected.profile.serial;
            await saveSettings(settings);
        }
    }
    catch (error) {
        if (error instanceof carrier_api_1.CarrierAuthError) {
            lastError = error.message;
            cachedSystems = [];
        }
        else if (error instanceof carrier_api_1.CarrierApiError) {
            lastError = error.message;
        }
        else {
            lastError = error instanceof Error ? error.message : String(error);
        }
    }
    return buildSnapshot(settings);
}
async function refreshExplorerData(settings, force = false) {
    if (!isConfigured(settings)) {
        cachedExplorerBundle = null;
        lastExplorerFetchAt = null;
        return null;
    }
    if (!force && cachedExplorerBundle && lastExplorerFetchAt && Date.now() - lastExplorerFetchAt.getTime() < STATUS_CACHE_MS) {
        return cachedExplorerBundle;
    }
    try {
        const client = getClient(settings);
        cachedExplorerBundle = await client.loadExplorerBundle();
        lastExplorerFetchAt = new Date();
        return cachedExplorerBundle;
    }
    catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        return cachedExplorerBundle;
    }
}
const API_CATALOG = {
    app_rest: [
        {
            method: "GET",
            path: "/api/status",
            query: "?refresh=1 forces Carrier cloud sync",
            description: "Dashboard snapshot: connection state, selected system, zone summaries, system list.",
        },
        {
            method: "GET",
            path: "/api/schedule",
            query: "?refresh=1 forces Carrier cloud sync",
            description: "Weekly zone schedules with activity setpoints for the selected system.",
        },
        {
            method: "GET",
            path: "/api/activities",
            query: "?refresh=1 forces Carrier cloud sync",
            description: "Zone activity presets with heat, cool, and fan settings for view and edit.",
        },
        {
            method: "GET",
            path: "/api/maintenance",
            query: "?refresh=1 forces Carrier cloud sync",
            description: "Maintenance snapshot: air filter life plus local condensate line tracking.",
        },
        {
            method: "POST",
            path: "/api/maintenance/condensate",
            body: '{ "cleared_at": "optional ISO timestamp, defaults to now" }',
            description: "Log condensate line clearing and restart the 30-day maintenance timer.",
        },
        {
            method: "GET",
            path: "/api/explorer",
            query: "?refresh=1 forces full Carrier GraphQL fetch",
            description: "Full Carrier cloud payloads (user, all systems, energy) plus this API catalog.",
        },
        {
            method: "GET",
            path: "/api/settings",
            description: "Public app settings (no password).",
        },
        {
            method: "PUT",
            path: "/api/settings",
            description: "Save credentials, validate account, select system serial.",
        },
        {
            method: "DELETE",
            path: "/api/settings",
            description: "Clear saved credentials.",
        },
        {
            method: "POST",
            path: "/api/mode",
            body: '{ "mode": "heat|cool|auto|off|fanonly" }',
            description: "Set system operating mode on the selected thermostat.",
        },
        {
            method: "POST",
            path: "/api/zone/:zoneId",
            body: '{ "heat_setpoint", "cool_setpoint", "fan", "preset", "activity_type" }',
            description: "Update zone setpoints, fan, schedule preset, or saved activity settings on the selected system.",
        },
        {
            method: "GET",
            path: "/health",
            description: "Plain-text liveness probe.",
        },
    ],
    carrier_graphql_queries: [
        { name: "assistedLogin", used: true, description: "OAuth login via username/password." },
        { name: "getUser", used: true, description: "Account profile, locations, devices." },
        { name: "getInfinitySystems", used: true, description: "All systems: profile, status, config, schedules." },
        { name: "getInfinityEnergy", used: true, description: "Per-system energy config and usage periods." },
        { name: "infinityConfig", used: false, description: "Single-system config query (available in schema)." },
        { name: "infinityStatus", used: false, description: "Single-system status query (available in schema)." },
        { name: "infinityDealer", used: false, description: "Dealer information." },
        { name: "infinityNotifications", used: false, description: "System notifications." },
    ],
    carrier_graphql_mutations: [
        { name: "updateInfinityConfig", used: true, description: "System mode, humidity, vent, vacation, and other whole-house config." },
        { name: "updateInfinityZoneActivity", used: true, description: "Per-activity setpoints and fan for a zone." },
        { name: "updateInfinityZoneConfig", used: true, description: "Zone hold, hold activity, timed hold (otmr)." },
        { name: "updateInfinityProgramDay", used: false, description: "Edit weekly schedule day/periods." },
        { name: "updateInfinityWholeHouseActivity", used: false, description: "Whole-house activity changes." },
        { name: "updateInfinityZoneStatus", used: false, description: "Direct zone status overrides." },
        { name: "updateInfinityProfile", used: false, description: "Rename system profile fields." },
        { name: "updateInfinityTime", used: false, description: "Thermostat clock/time settings." },
        { name: "updateInfinityNotificationPrefs", used: false, description: "Notification preferences." },
    ],
    carrier_websocket: [
        { messageType: "InfinityStatus", used: true, description: "Live status updates (zones, oat, idu, odu, humid, vent, etc.)." },
        { messageType: "InfinityConfig", used: false, description: "Live config/schedule/activity updates." },
    ],
    carrier_endpoints: [
        { url: "https://dataservice.infinity.iot.carrier.com/graphql-no-auth", description: "Unauthenticated GraphQL (login)." },
        { url: "https://dataservice.infinity.iot.carrier.com/graphql", description: "Authenticated GraphQL queries and mutations." },
        { url: "https://sso.carrier.com/oauth2/default/v1/token", description: "OAuth token refresh." },
        { url: "wss://realtime.infinity.iot.carrier.com/", description: "Realtime InfinityStatus / InfinityConfig stream." },
    ],
};
function ensurePolling(settings) {
    if (!isConfigured(settings)) {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
        resetCloudConnections();
        return;
    }
    ensureRealtime(settings);
    if (pollTimer)
        return;
    pollTimer = setInterval(() => {
        void refreshCloudData(settings, true);
    }, POLL_INTERVAL_MS);
}
function sendJson(res, statusCode, payload) {
    const body = Buffer.from(JSON.stringify(payload));
    res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": body.length,
    });
    res.end(body);
}
function sendText(res, statusCode, contentType, body) {
    const encoded = Buffer.from(body);
    res.writeHead(statusCode, {
        "Content-Type": contentType,
        "Content-Length": encoded.length,
    });
    res.end(encoded);
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}
function pageStyles() {
    return `
    :root {
      color-scheme: light;
      --bg: #f8fafc;
      --panel: #ffffff;
      --text: #0f172a;
      --muted: #64748b;
      --border: #e2e8f0;
      --accent: #0f766e;
      --accent-soft: #ccfbf1;
      --success: #16a34a;
      --danger: #dc2626;
      --shadow: 0 10px 30px rgba(15, 23, 42, 0.08);
    }
    html[data-theme="dark"] {
      color-scheme: dark;
      --bg: #0b1220;
      --panel: #111827;
      --text: #e5e7eb;
      --muted: #94a3b8;
      --border: #1f2937;
      --accent: #2dd4bf;
      --accent-soft: #134e4a;
      --shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    .layout {
      display: grid;
      grid-template-columns: 240px 1fr;
      min-height: 100vh;
    }
    .sidebar {
      display: flex;
      flex-direction: column;
      background: var(--panel);
      border-right: 1px solid var(--border);
      padding: 1.5rem 1rem;
      position: sticky;
      top: 0;
      height: 100vh;
    }
    .sidebar nav { flex: 1; }
    .sidebar-version {
      margin-top: auto;
      padding: 0.75rem 0.85rem 0;
      font-size: 0.7rem;
      color: var(--muted);
      opacity: 0.65;
    }
    .brand {
      display: flex;
      gap: 0.75rem;
      align-items: center;
      margin-bottom: 1.5rem;
      padding: 0 0.5rem;
    }
    .brand img { width: 40px; height: 40px; border-radius: 10px; }
    .brand h1 { font-size: 1rem; margin: 0; }
    .brand p { margin: 0.15rem 0 0; color: var(--muted); font-size: 0.8rem; }
    .nav-section {
      margin: 1rem 0 0.35rem;
      padding: 0 0.85rem;
      font-size: 0.68rem;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .nav-section:first-child {
      margin-top: 0.15rem;
    }
    .nav-link {
      display: block;
      padding: 0.7rem 0.85rem;
      border-radius: 0.75rem;
      color: var(--text);
      text-decoration: none;
      margin-bottom: 0.25rem;
    }
    .nav-link:hover, .nav-link.active {
      background: var(--accent-soft);
      color: var(--accent);
    }
    .main { padding: 1.5rem; }
    .mobile-header,
    .sidebar-backdrop {
      display: none;
    }
    .menu-toggle {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid var(--border);
      background: var(--panel);
      border-radius: 0.65rem;
      padding: 0.45rem 0.55rem;
      cursor: pointer;
      color: var(--text);
    }
    .menu-toggle .icon {
      width: 1.25rem;
      height: 1.25rem;
    }
    .mobile-header-copy {
      flex: 1;
      min-width: 0;
      display: grid;
      gap: 0.1rem;
    }
    .mobile-header-title {
      font-size: 0.95rem;
      font-weight: 700;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .system-selector {
      appearance: none;
      -webkit-appearance: none;
      border: 1px solid transparent;
      border-radius: 0.5rem;
      background: transparent;
      color: inherit;
      font: inherit;
      padding: 0.1rem 1.4rem 0.1rem 0;
      margin: 0;
      max-width: 100%;
      cursor: pointer;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2364748b' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 0 center;
      background-size: 0.9rem;
    }
    .system-selector:hover:not(:disabled) {
      border-color: var(--border);
      background-color: var(--panel);
    }
    .system-selector:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .system-selector:disabled {
      cursor: default;
      opacity: 0.85;
      background-image: none;
      padding-right: 0;
    }
    .mobile-header-title.system-selector {
      font-size: 0.95rem;
      font-weight: 700;
    }
    .toolbar-meta.system-selector {
      font-size: 0.88rem;
      color: var(--text);
      font-weight: 600;
    }
    .status-pill-compact {
      font-size: 0.72rem;
      padding: 0.28rem 0.55rem;
      flex-shrink: 0;
    }
    .toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
      margin-bottom: 1.25rem;
      flex-wrap: wrap;
    }
    .toolbar h2 { margin: 0; font-size: 1.5rem; }
    .toolbar-meta {
      font-size: 0.88rem;
      color: var(--muted);
      margin: 0.2rem 0 0;
    }
    .toolbar-meta strong { color: var(--text); }
    .grid {
      display: grid;
      gap: 1rem;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 1rem;
      padding: 1.25rem;
      box-shadow: var(--shadow);
    }
    .card h3 { margin: 0 0 0.5rem; font-size: 1rem; }
    .muted { color: var(--muted); }
    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.35rem 0.7rem;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent);
      font-size: 0.85rem;
      font-weight: 600;
    }
    .status-pill.success { background: #ecfdf5; color: #047857; }
    .status-pill.warning { background: #fffbeb; color: #b45309; }
    .status-pill.error { background: #fef2f2; color: #b91c1c; }
    html[data-theme="dark"] .status-pill.success { background: #052e16; color: #86efac; }
    html[data-theme="dark"] .status-pill.warning { background: #451a03; color: #fcd34d; }
    html[data-theme="dark"] .status-pill.error { background: #450a0a; color: #fca5a5; }
    .temp-label {
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--muted);
      margin-top: 0.25rem;
    }
    .temp-display {
      font-size: 2.5rem;
      font-weight: 700;
      line-height: 1;
      margin: 0.15rem 0 0.5rem;
    }
    .stat-row {
      display: flex;
      justify-content: space-between;
      gap: 0.75rem;
      margin-top: 0.5rem;
      font-size: 0.9rem;
    }
    label {
      display: grid;
      gap: 0.35rem;
      font-size: 0.9rem;
      margin-bottom: 0.85rem;
    }
    input, select, button {
      font: inherit;
      border: 1px solid var(--border);
      border-radius: 0.65rem;
      padding: 0.65rem 0.75rem;
      background: var(--panel);
      color: var(--text);
    }
    button {
      cursor: pointer;
      background: var(--accent);
      color: white;
      border-color: var(--accent);
      font-weight: 600;
    }
    button.secondary {
      background: transparent;
      color: var(--text);
      border-color: var(--border);
    }
    button:disabled {
      cursor: wait;
      opacity: 0.72;
    }
    button.busy {
      opacity: 0.85;
    }
    button.success-flash {
      background: var(--success) !important;
      border-color: var(--success) !important;
      color: #fff !important;
      opacity: 1;
    }
    button.error-flash {
      background: var(--danger) !important;
      border-color: var(--danger) !important;
      color: #fff !important;
      opacity: 1;
    }
    .steps { display: grid; gap: 0.75rem; margin: 1rem 0; }
    .step {
      border: 1px solid var(--border);
      border-radius: 0.85rem;
      padding: 1rem;
      background: var(--panel);
    }
    .step strong { display: block; margin-bottom: 0.35rem; }
    .controls { display: grid; gap: 0.75rem; margin-top: 1rem; }
    .control-row {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
      align-items: end;
    }
    .control-row label { flex: 1 1 8rem; margin-bottom: 0; }
    .message { margin-top: 0.75rem; font-size: 0.9rem; }
    .message.error { color: var(--danger); }
    .message.success { color: var(--success); }
    #zone-cards {
      grid-template-columns: minmax(0, 1fr);
    }
    #zone-cards.single-zone {
      margin-top: 0;
    }
    .zone-control-card {
      overflow: hidden;
    }
    .zone-control-card.single-zone .zone-name {
      display: none;
    }
    .zone-control-layout {
      display: grid;
      grid-template-columns: minmax(200px, 240px) 1fr;
      gap: 1.25rem;
      margin-top: 0.75rem;
      align-items: start;
    }
    .thermo-widget {
      position: relative;
      display: grid;
      grid-template-columns: 3.25rem 1fr;
      gap: 0.5rem;
      user-select: none;
      touch-action: none;
    }
    .thermo-scale {
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      height: 260px;
      margin-top: 0;
      padding: 0;
    }
    .thermo-tick {
      display: flex;
      align-items: center;
      gap: 0.35rem;
      font-size: 0.68rem;
      color: var(--muted);
      font-variant-numeric: tabular-nums;
    }
    .thermo-tick-mark {
      display: block;
      width: 0.55rem;
      height: 1px;
      background: var(--muted);
      opacity: 0.7;
    }
    .thermo-tick-major .thermo-tick-mark {
      width: 0.85rem;
      height: 2px;
      opacity: 1;
    }
    .thermo-tick-major .thermo-tick-label {
      font-weight: 700;
      color: var(--text);
    }
    .thermo-body {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 0 3.25rem;
    }
    .thermo-tube {
      position: relative;
      width: 34px;
      height: 260px;
      margin-bottom: -12px;
      z-index: 2;
    }
    .thermo-glass {
      position: absolute;
      inset: 0;
      border-radius: 17px 17px 6px 6px;
      background: linear-gradient(90deg, #f8fafc 0%, #e8f0f8 35%, #f1f5f9 65%, #f8fafc 100%);
      border: 2px solid #94a3b8;
      box-shadow:
        inset 3px 0 10px rgba(255, 255, 255, 0.95),
        inset -3px 0 6px rgba(15, 23, 42, 0.06),
        0 4px 14px rgba(15, 23, 42, 0.08);
      overflow: hidden;
    }
    html[data-theme="dark"] .thermo-glass {
      background: linear-gradient(90deg, #1e293b 0%, #334155 50%, #1e293b 100%);
      border-color: #64748b;
      box-shadow:
        inset 3px 0 10px rgba(255, 255, 255, 0.08),
        inset -3px 0 6px rgba(0, 0, 0, 0.25),
        0 4px 14px rgba(0, 0, 0, 0.35);
    }
    .thermo-shine {
      position: absolute;
      top: 8%;
      left: 18%;
      width: 28%;
      height: 72%;
      border-radius: 999px;
      background: linear-gradient(to bottom, rgba(255,255,255,0.75), rgba(255,255,255,0.05));
      pointer-events: none;
      z-index: 4;
    }
    html[data-theme="dark"] .thermo-shine {
      background: linear-gradient(to bottom, rgba(255,255,255,0.18), rgba(255,255,255,0));
    }
    .thermo-zone {
      position: absolute;
      left: 12%;
      right: 12%;
      pointer-events: none;
      z-index: 1;
      opacity: 0.22;
    }
    .thermo-zone-heat {
      bottom: 0;
      background: linear-gradient(to top, #ef4444, transparent);
      border-radius: 0 0 8px 8px;
    }
    .thermo-zone-cool {
      top: 0;
      background: linear-gradient(to bottom, #3b82f6, transparent);
      border-radius: 8px 8px 0 0;
    }
    .thermo-fill {
      position: absolute;
      bottom: 0;
      left: 22%;
      right: 22%;
      background: linear-gradient(to top, #991b1b 0%, #dc2626 45%, #ef4444 100%);
      border-radius: 0 0 6px 6px;
      z-index: 2;
      box-shadow: inset 0 2px 4px rgba(255, 255, 255, 0.2);
      pointer-events: none;
      transition: height 0.25s ease;
    }
    .thermo-fill-cap {
      position: absolute;
      top: -3px;
      left: -15%;
      right: -15%;
      height: 6px;
      border-radius: 999px;
      background: #ef4444;
      z-index: 3;
    }
    .thermo-inner-ticks {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 3;
      opacity: 0.35;
    }
    .thermo-inner-tick {
      position: absolute;
      left: 15%;
      right: 15%;
      height: 1px;
      background: #64748b;
    }
    .thermo-bulb {
      width: 58px;
      height: 58px;
      border-radius: 50%;
      background: radial-gradient(circle at 32% 28%, #fca5a5 0%, #dc2626 42%, #991b1b 100%);
      border: 2px solid #b91c1c;
      box-shadow:
        inset -4px -6px 10px rgba(0, 0, 0, 0.2),
        inset 3px 3px 8px rgba(255, 255, 255, 0.25),
        0 6px 16px rgba(220, 38, 38, 0.28);
      z-index: 1;
    }
    html[data-theme="dark"] .thermo-bulb {
      background: radial-gradient(circle at 32% 28%, #f87171 0%, #b91c1c 45%, #7f1d1d 100%);
      border-color: #991b1b;
    }
    .thermo-handle {
      position: absolute;
      display: flex;
      align-items: center;
      gap: 0;
      z-index: 5;
      border: none;
      padding: 0;
      background: transparent;
      cursor: grab;
      box-shadow: none;
      transform: translateY(50%);
    }
    .thermo-handle:active { cursor: grabbing; }
    .thermo-handle-heat {
      right: calc(100% + 10px);
      flex-direction: row-reverse;
      color: #b91c1c;
    }
    .thermo-handle-cool {
      left: calc(100% + 10px);
      color: #1d4ed8;
    }
    .thermo-flag-stem {
      display: block;
      width: 12px;
      height: 2px;
      background: currentColor;
    }
    .thermo-flag-label {
      padding: 0.22rem 0.5rem;
      border-radius: 4px;
      font-size: 0.74rem;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
      color: #fff;
      min-width: 2.55rem;
      text-align: center;
      border: 1px solid rgba(0, 0, 0, 0.12);
      box-shadow: 0 2px 6px rgba(15, 23, 42, 0.15);
    }
    .thermo-handle-heat .thermo-flag-label {
      background: linear-gradient(180deg, #ef4444, #b91c1c);
    }
    .thermo-handle-cool .thermo-flag-label {
      background: linear-gradient(180deg, #3b82f6, #1d4ed8);
    }
    .zone-control-card.mode-heat .thermo-handle-cool,
    .zone-control-card.mode-heat .thermo-zone-cool,
    .zone-control-card.mode-cool .thermo-handle-heat,
    .zone-control-card.mode-cool .thermo-zone-heat {
      display: none;
    }
    .zone-side-panel {
      display: grid;
      gap: 1rem;
    }
    .fan-control {
      border: 1px solid var(--border);
      border-radius: 0.85rem;
      padding: 0.85rem 1rem;
      background: var(--bg);
    }
    .fan-label-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0.5rem;
      font-size: 0.9rem;
      font-weight: 600;
    }
    .fan-label-row span:last-child {
      color: var(--accent);
      font-size: 0.85rem;
    }
    .fan-control input[type="range"] {
      width: 100%;
      margin: 0.35rem 0 0.5rem;
      accent-color: var(--accent);
    }
    .fan-ticks {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 0.25rem;
      font-size: 0.72rem;
      color: var(--muted);
      text-align: center;
    }
    .fan-ticks span.active {
      color: var(--accent);
      font-weight: 700;
    }
    .preset-tiles {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(5.5rem, 1fr));
      gap: 0.5rem;
    }
    .preset-tile {
      background: var(--panel);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 0.75rem;
      padding: 0.55rem 0.45rem;
      font-size: 0.8rem;
      font-weight: 600;
      text-transform: capitalize;
    }
    .preset-tile:hover {
      border-color: var(--accent);
      color: var(--accent);
    }
    .preset-tile:disabled {
      opacity: 0.55;
      cursor: wait;
    }
    .zone-hero {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 1rem;
      flex-wrap: wrap;
      margin-bottom: 1rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid var(--border);
    }
    .zone-hero-temp {
      text-align: right;
    }
    .zone-hero-temp .temp-display {
      font-size: 3.25rem;
      margin: 0;
      line-height: 1;
    }
    .temp-unit {
      font-size: 1.35rem;
      font-weight: 600;
      color: var(--muted);
      margin-left: 0.1rem;
    }
    .temp-caption {
      display: block;
      font-size: 0.8rem;
      color: var(--muted);
      margin-top: 0.2rem;
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      margin-top: 0.45rem;
      padding: 0.35rem 0.7rem;
      border-radius: 999px;
      font-size: 0.82rem;
      font-weight: 600;
    }
    .status-badge .icon { width: 1rem; height: 1rem; }
    .status-icon-staged {
      display: inline-flex;
      align-items: flex-end;
      gap: 0.15rem;
      vertical-align: middle;
    }
    .status-icon-staged > .icon { width: 1rem; height: 1rem; flex-shrink: 0; }
    .stage-bars {
      display: inline-flex;
      flex-direction: column-reverse;
      gap: 1px;
      height: 1rem;
      justify-content: flex-end;
    }
    .stage-bar {
      width: 0.28rem;
      border-radius: 1px;
      background: currentColor;
      opacity: 0.2;
    }
    .stage-bar:nth-child(1) { height: 0.2rem; }
    .stage-bar:nth-child(2) { height: 0.35rem; }
    .stage-bar:nth-child(3) { height: 0.5rem; }
    .stage-bar:nth-child(4) { height: 0.65rem; }
    .stage-bar:nth-child(5) { height: 0.8rem; }
    .stage-bar.active { opacity: 1; }
    .status-heating { background: #ffedd5; color: #c2410c; }
    .status-cooling { background: #e0f2fe; color: #0369a1; }
    .status-idle { background: var(--bg); color: var(--muted); border: 1px solid var(--border); }
    .status-fan { background: #ede9fe; color: #6d28d9; }
    .status-transition { background: #f5f5f4; color: #57534e; border: 1px solid var(--border); }
    html[data-theme="dark"] .status-heating { background: #431407; color: #fdba74; }
    html[data-theme="dark"] .status-cooling { background: #0c4a6e; color: #7dd3fc; }
    html[data-theme="dark"] .status-fan { background: #2e1065; color: #c4b5fd; }
    html[data-theme="dark"] .status-transition { background: #292524; color: #d6d3d1; }
    .stat-chips {
      display: grid;
      gap: 0.5rem;
      margin-bottom: 1rem;
    }
    .stat-chips-compact-row {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      align-items: stretch;
    }
    .stat-chip-compact {
      flex: 1 1 6rem;
      min-width: 5.75rem;
      max-width: 8rem;
      padding: 0.45rem 0.5rem;
      gap: 0.15rem;
      border-radius: 0.7rem;
    }
    .stat-chip-compact .icon {
      width: 0.85rem;
      height: 0.85rem;
    }
    .stat-chip-compact .chip-label {
      font-size: 0.62rem;
    }
    .stat-chip-compact .chip-value {
      font-size: 0.8rem;
      line-height: 1.2;
    }
    .stat-chip-compact .humidity-chip-body {
      gap: 0.35rem;
    }
    .stat-chip-compact .humidity-bar-track {
      width: 0.4rem;
      height: 1.65rem;
    }
    .schedule-chip-compact .chip-value,
    .blower-chip-compact .chip-value {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .circulation-grid {
      display: grid;
      gap: 1rem;
    }
    .circulation-zone-card h3 {
      margin: 0 0 0.75rem;
      font-size: 1rem;
    }
    .circulation-zone-card.single-zone h3 {
      display: none;
    }
    .circulation-panel {
      display: grid;
      grid-template-columns: minmax(5rem, auto) 1fr;
      gap: 0.75rem;
      align-items: center;
    }
    .blower-indicator {
      display: grid;
      gap: 0.2rem;
      min-width: 0;
    }
    .blower-readout {
      display: grid;
      gap: 0.1rem;
      min-width: 0;
    }
    .blower-metric {
      display: flex;
      align-items: baseline;
      gap: 0.35rem;
      font-size: 0.88rem;
      font-weight: 700;
      line-height: 1.35;
      white-space: nowrap;
    }
    .blower-metric-label {
      flex: 0 0 3.25rem;
      font-size: 0.65rem;
      font-weight: 600;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .fan-control-label {
      display: block;
      font-size: 0.72rem;
      font-weight: 700;
      color: var(--accent);
      margin-bottom: 0.2rem;
      text-align: center;
    }

    .stat-chip {
      border: 1px solid var(--border);
      border-radius: 0.85rem;
      padding: 0.7rem 0.75rem;
      background: var(--bg);
      display: grid;
      gap: 0.2rem;
    }
    .chip-header {
      display: flex;
      align-items: center;
      gap: 0.35rem;
    }
    .chip-header .chip-label {
      flex: 1;
      min-width: 0;
    }
    .stat-chip .icon {
      width: 1.1rem;
      height: 1.1rem;
      color: var(--accent);
      flex-shrink: 0;
    }
    a.stat-chip-link {
      text-decoration: none;
      color: inherit;
      cursor: pointer;
      transition: border-color 0.15s ease, background 0.15s ease;
    }
    a.stat-chip-link:hover {
      border-color: var(--accent);
      background: var(--accent-soft);
    }
    a.stat-chip-link:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .tile-refresh {
      margin-left: auto;
      border: none;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
      padding: 0.15rem;
      border-radius: 0.35rem;
      display: grid;
      place-items: center;
      flex-shrink: 0;
    }
    .tile-refresh .icon {
      width: 0.95rem;
      height: 0.95rem;
    }
    .tile-refresh:hover:not(:disabled) {
      color: var(--accent);
      background: var(--accent-soft);
    }
    .tile-refresh:disabled {
      opacity: 0.55;
      cursor: wait;
    }
    .tile-refresh.spinning .icon {
      animation: tile-refresh-spin 0.8s linear infinite;
    }
    @keyframes tile-refresh-spin {
      to { transform: rotate(360deg); }
    }
    .section-title .tile-refresh {
      margin-left: auto;
    }
    .dashboard-toolbar-actions {
      display: flex;
      align-items: center;
      gap: 0.65rem;
      margin-left: auto;
      flex-shrink: 0;
    }
    .dashboard-refresh {
      margin-left: 0;
    }

    .card-header-row,
    .tile-header-row,
    .status-row {
      display: flex;
      align-items: center;
      gap: 0.35rem;
    }
    .card-header-row h3 {
      margin: 0;
      flex: 1;
      min-width: 0;
    }
    .tile-header-row {
      justify-content: space-between;
    }
    .status-row {
      flex-wrap: wrap;
      gap: 0.45rem;
    }
    .status-row .status-badge {
      flex: 1;
      min-width: 0;
    }
    .status-copy {
      display: grid;
      gap: 0.25rem;
      flex: 1;
      min-width: 0;
    }
    .status-detail {
      margin: 0;
      font-size: 0.78rem;
      color: var(--muted);
      line-height: 1.35;
    }
    .system-activity-readout {
      margin: 0.35rem 0 0;
      font-size: 0.82rem;
      line-height: 1.35;
    }
    .filter-life-row .tile-refresh {
      margin-left: 0.35rem;
    }
    .chip-label {
      font-size: 0.72rem;
      color: var(--muted);
      text-transform: none;
      letter-spacing: 0;
    }
    .chip-value {
      font-size: 0.95rem;
      font-weight: 700;
    }
    .humidity-chip-body {
      display: flex;
      align-items: center;
      gap: 0.65rem;
    }
    .humidity-indicator {
      flex-shrink: 0;
    }
    .humidity-bar-track {
      width: 0.55rem;
      height: 2.75rem;
      border-radius: 999px;
      background: var(--border);
      overflow: hidden;
      display: flex;
      flex-direction: column;
      justify-content: flex-end;
    }
    .humidity-bar-fill {
      display: block;
      width: 100%;
      border-radius: 999px;
      background: linear-gradient(180deg, #7dd3fc, #0284c7);
      min-height: 0;
      transition: height 0.35s ease;
    }
    html[data-theme="dark"] .humidity-bar-fill {
      background: linear-gradient(180deg, #38bdf8, #0369a1);
    }
    .mini-bar,
    .filter-bar-track {
      height: 5px;
      border-radius: 999px;
      background: var(--border);
      overflow: hidden;
      margin-top: 0.25rem;
    }
    .mini-bar > span,
    .filter-bar-fill {
      display: block;
      height: 100%;
      border-radius: 999px;
      background: linear-gradient(90deg, var(--accent), #38bdf8);
    }
    .fan-bars {
      display: flex;
      gap: 0.2rem;
      align-items: flex-end;
      height: 1.1rem;
      margin-top: 0.15rem;
    }
    .fan-bar {
      flex: 1;
      border-radius: 2px;
      background: var(--border);
      height: 35%;
    }
    .fan-bar:nth-child(2) { height: 55%; }
    .fan-bar:nth-child(3) { height: 75%; }
    .fan-bar:nth-child(4) { height: 100%; }
    .fan-bar.active { background: var(--accent); }
    .fan-bar.auto.active { opacity: 0.45; }
    .section-title {
      display: flex;
      align-items: center;
      gap: 0.45rem;
      font-size: 0.82rem;
      font-weight: 700;
      color: var(--muted);
      margin-bottom: 0.55rem;
      text-transform: none;
      letter-spacing: 0;
    }
    .section-title .icon { width: 1rem; height: 1rem; }
    .mode-page-grid {
      display: grid;
      gap: 1rem;
      max-width: 36rem;
    }
    .mode-control-card {
      padding: 1rem 1.1rem;
    }
    .mode-control-card h3 {
      font-size: 0.95rem;
    }
    .mode-readout {
      margin: 0.2rem 0 0;
      font-size: 0.8rem;
    }
    .mode-tiles {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 0.4rem;
      margin-top: 0.55rem;
    }
    .mode-tile {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.3rem;
      padding: 0.45rem 0.35rem;
      border-radius: 0.65rem;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--text);
      font-weight: 600;
      font-size: 0.76rem;
      min-width: 0;
    }
    .mode-tile .icon {
      width: 1rem;
      height: 1rem;
      flex-shrink: 0;
    }
    .mode-tile span {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .mode-tile.active {
      border-color: var(--accent);
      background: var(--accent-soft);
      color: var(--accent);
      box-shadow: inset 0 0 0 1px var(--accent);
    }
    .mode-tile.mode-tile-heat.active { border-color: #ea580c; background: #ffedd5; color: #c2410c; }
    .mode-tile.mode-tile-cool.active { border-color: #0284c7; background: #e0f2fe; color: #0369a1; }
    html[data-theme="dark"] .mode-tile.mode-tile-heat.active { background: #431407; color: #fdba74; }
    html[data-theme="dark"] .mode-tile.mode-tile-cool.active { background: #0c4a6e; color: #7dd3fc; }
    .weather-grid {
      display: grid;
      gap: 1rem;
      max-width: 36rem;
    }
    .weather-hero-card .weather-row {
      display: flex;
      align-items: center;
      gap: 1rem;
    }
    .weather-icon-wrap {
      width: 4rem;
      height: 4rem;
      border-radius: 1rem;
      display: grid;
      place-items: center;
      background: var(--bg);
      border: 1px solid var(--border);
      color: #f59e0b;
      flex-shrink: 0;
    }
    .weather-icon-wrap .icon { width: 2rem; height: 2rem; }
    .weather-hero-card .temp-display {
      font-size: 3.5rem;
      margin: 0;
      line-height: 1;
    }
    .weather-caption {
      display: block;
      margin-top: 0.25rem;
      font-size: 0.88rem;
      color: var(--muted);
    }
    .maintenance-grid {
      display: grid;
      gap: 1rem;
      max-width: 36rem;
    }
    .maintenance-item-header {
      display: flex;
      align-items: center;
      gap: 0.45rem;
      margin-bottom: 0.65rem;
    }
    .maintenance-item-header .icon {
      width: 1.2rem;
      height: 1.2rem;
      color: var(--accent);
      flex-shrink: 0;
    }
    .maintenance-item-header h3 {
      margin: 0;
      flex: 1;
      min-width: 0;
      font-size: 1rem;
    }
    .maintenance-value {
      font-size: 2rem;
      font-weight: 700;
      line-height: 1.1;
      margin-bottom: 0.35rem;
    }
    .maintenance-value.low {
      color: #b45309;
    }
    .maintenance-value.critical {
      color: var(--danger);
    }
    .maintenance-detail {
      margin: 0.5rem 0 0;
      font-size: 0.88rem;
      color: var(--muted);
    }
    .maintenance-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.55rem;
      margin-top: 0.85rem;
    }
    .maintenance-actions button.secondary {
      font-size: 0.85rem;
      padding: 0.55rem 0.8rem;
    }
    .filter-life-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 0.82rem;
      margin-bottom: 0.35rem;
    }
    .preset-tile {
      display: grid;
      justify-items: center;
      gap: 0.25rem;
      padding: 0.65rem 0.4rem;
    }
    .preset-tile .icon { width: 1.2rem; height: 1.2rem; }
    .thermo-legend {
      display: flex;
      justify-content: space-between;
      font-size: 0.68rem;
      color: var(--muted);
      margin-top: 0.5rem;
      padding: 0 3.25rem;
    }
    .thermo-legend span:nth-child(2) {
      color: #dc2626;
      font-weight: 600;
    }
    .icon {
      display: inline-block;
      vertical-align: middle;
      flex-shrink: 0;
    }
    @media (max-width: 900px) {
      .layout {
        grid-template-columns: 1fr;
        grid-template-rows: auto 1fr;
      }
      .mobile-header {
        display: flex;
        align-items: center;
        gap: 0.65rem;
        padding: 0.85rem 1rem;
        background: var(--panel);
        border-bottom: 1px solid var(--border);
        position: sticky;
        top: 0;
        z-index: 30;
        grid-column: 1;
        grid-row: 1;
      }
      .dashboard-toolbar {
        display: none;
      }
      .toolbar .tile-refresh,
      .dashboard-toolbar-actions .tile-refresh {
        display: none;
      }
      .mode-tiles {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .toolbar-connection-pill {
        display: none;
      }
      .sidebar-backdrop {
        display: block;
        position: fixed;
        inset: 0;
        background: rgba(15, 23, 42, 0.45);
        z-index: 35;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.2s ease;
      }
      html[data-theme="dark"] .sidebar-backdrop {
        background: rgba(0, 0, 0, 0.55);
      }
      .sidebar-backdrop.open {
        opacity: 1;
        pointer-events: auto;
      }
      .sidebar {
        position: fixed;
        top: 0;
        left: 0;
        bottom: 0;
        width: min(280px, 86vw);
        height: 100vh;
        z-index: 40;
        transform: translateX(-105%);
        transition: transform 0.22s ease;
        box-shadow: var(--shadow);
      }
      .sidebar.open {
        transform: translateX(0);
      }
      .main {
        padding: 1rem;
        grid-column: 1;
        grid-row: 2;
      }
      .zone-control-layout { grid-template-columns: 1fr; }
      .circulation-panel { grid-template-columns: 1fr; }
    }
    .api-toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 0.65rem;
      align-items: center;
      margin-bottom: 1rem;
    }
    .api-toolbar .muted { flex: 1; min-width: 12rem; }
    .api-section { margin-top: 1.25rem; }
    .api-section h2 {
      font-size: 1.05rem;
      margin: 0 0 0.75rem;
    }
    .api-section h3 {
      font-size: 0.92rem;
      margin: 1rem 0 0.5rem;
      color: var(--muted);
    }
    .api-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.82rem;
    }
    .api-table th,
    .api-table td {
      border: 1px solid var(--border);
      padding: 0.55rem 0.65rem;
      text-align: left;
      vertical-align: top;
    }
    .api-table th {
      background: var(--bg);
      color: var(--muted);
      font-weight: 700;
    }
    .api-method {
      display: inline-block;
      min-width: 3.2rem;
      font-weight: 700;
      font-size: 0.72rem;
      letter-spacing: 0.03em;
    }
    .api-used-yes { color: var(--success); font-weight: 700; }
    .api-used-no { color: var(--muted); }
    .json-panel {
      margin-top: 0.5rem;
    }
    .json-panel summary {
      cursor: pointer;
      font-weight: 600;
      font-size: 0.88rem;
      padding: 0.45rem 0;
    }
    .json-panel pre {
      margin: 0.35rem 0 0;
      padding: 0.85rem;
      border-radius: 0.75rem;
      border: 1px solid var(--border);
      background: var(--bg);
      overflow: auto;
      max-height: 28rem;
      font-size: 0.72rem;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .json-panel.error pre {
      border-color: #fecaca;
      color: var(--danger);
    }
    .dev-banner {
      position: sticky;
      top: 0;
      z-index: 30;
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem 1rem;
      align-items: center;
      justify-content: space-between;
      padding: 0.55rem 1rem;
      background: #fef3c7;
      color: #92400e;
      border-bottom: 1px solid #fcd34d;
      font-size: 0.82rem;
      font-weight: 600;
    }
    html[data-theme="dark"] .dev-banner {
      background: #422006;
      color: #fcd34d;
      border-bottom-color: #854d0e;
    }
    .dev-banner code {
      font-size: 0.78rem;
      font-weight: 500;
    }
    .schedule-grid {
      display: grid;
      gap: 1rem;
    }
    .schedule-zone-card h3 {
      margin: 0;
      font-size: 1.05rem;
    }
    .schedule-zone-card.single-zone h3 {
      display: none;
    }
    .schedule-zone-card.single-zone .schedule-zone-meta {
      margin-top: 0;
    }
    .schedule-zone-meta {
      margin: 0.35rem 0 0.85rem;
      font-size: 0.88rem;
      color: var(--muted);
    }
    .schedule-zone-meta strong {
      color: var(--text);
    }
    .schedule-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.84rem;
    }
    .schedule-table th,
    .schedule-table td {
      border-bottom: 1px solid var(--border);
      padding: 0.7rem 0.55rem;
      text-align: left;
      vertical-align: top;
    }
    .schedule-table th {
      color: var(--muted);
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      font-weight: 700;
    }
    .schedule-table tr.today td {
      background: var(--accent-soft);
    }
    .schedule-table tr.today td:first-child {
      font-weight: 700;
      color: var(--accent);
    }
    .schedule-day-name {
      white-space: nowrap;
      width: 6.5rem;
    }
    .schedule-periods {
      display: flex;
      flex-wrap: wrap;
      gap: 0.45rem;
    }
    .schedule-period-pill {
      display: inline-flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.35rem;
      padding: 0.4rem 0.6rem;
      border-radius: 0.65rem;
      border: 1px solid var(--border);
      background: var(--bg);
      line-height: 1.3;
    }
    .schedule-period-pill.current {
      border-color: var(--accent);
      box-shadow: 0 0 0 1px var(--accent);
    }
    .schedule-period-time {
      font-weight: 700;
      font-variant-numeric: tabular-nums;
    }
    .schedule-period-activity {
      font-weight: 600;
    }
    .schedule-period-setpoints {
      color: var(--muted);
      font-size: 0.78rem;
    }
    .schedule-period-pill.activity-home .schedule-period-activity { color: #0f766e; }
    .schedule-period-pill.activity-away .schedule-period-activity { color: #64748b; }
    .schedule-period-pill.activity-sleep .schedule-period-activity { color: #6d28d9; }
    .schedule-period-pill.activity-wake .schedule-period-activity { color: #c2410c; }
    .schedule-period-pill.activity-manual .schedule-period-activity { color: #0369a1; }
    .schedule-period-pill.activity-vacation .schedule-period-activity { color: #b45309; }
    html[data-theme="dark"] .schedule-period-pill.activity-home .schedule-period-activity { color: #2dd4bf; }
    html[data-theme="dark"] .schedule-period-pill.activity-away .schedule-period-activity { color: #94a3b8; }
    html[data-theme="dark"] .schedule-period-pill.activity-sleep .schedule-period-activity { color: #c4b5fd; }
    html[data-theme="dark"] .schedule-period-pill.activity-wake .schedule-period-activity { color: #fdba74; }
    .activities-grid {
      display: grid;
      gap: 1rem;
    }
    .activities-zone-card h3 {
      margin: 0 0 0.35rem;
      font-size: 1rem;
    }
    .activities-zone-card.single-zone h3 {
      display: none;
    }
    .activities-zone-meta {
      margin: 0 0 0.85rem;
      font-size: 0.88rem;
      color: var(--muted);
    }
    .activities-zone-meta strong {
      color: var(--text);
    }
    .activities-zone-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.55rem;
      margin-bottom: 0.85rem;
    }
    .activity-cards {
      display: grid;
      gap: 0.75rem;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    }
    .activity-card {
      border: 1px solid var(--border);
      border-radius: 0.85rem;
      padding: 0.9rem 1rem;
      background: var(--bg);
      display: grid;
      gap: 0.65rem;
    }
    .activity-card.current {
      border-color: var(--accent);
      box-shadow: 0 0 0 1px var(--accent);
    }
    .activity-card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
    }
    .activity-card-header h4 {
      margin: 0;
      font-size: 0.95rem;
    }
    .activity-badges {
      display: flex;
      flex-wrap: wrap;
      gap: 0.3rem;
      justify-content: flex-end;
    }
    .activity-badge {
      font-size: 0.68rem;
      font-weight: 700;
      padding: 0.18rem 0.45rem;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent);
    }
    .activity-badge.hold {
      background: #ffedd5;
      color: #c2410c;
    }
    html[data-theme="dark"] .activity-badge.hold {
      background: #431407;
      color: #fdba74;
    }
    .activity-readout {
      display: grid;
      gap: 0.2rem;
      font-size: 0.82rem;
      color: var(--muted);
    }
    .activity-readout strong {
      color: var(--text);
      font-weight: 700;
    }
    .activity-form {
      display: grid;
      gap: 0.55rem;
    }
    .activity-form-row {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 0.45rem;
    }
    .activity-form label {
      display: grid;
      gap: 0.2rem;
      font-size: 0.72rem;
      color: var(--muted);
    }
    .activity-form input,
    .activity-form select {
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 0.55rem;
      padding: 0.45rem 0.5rem;
      background: var(--panel);
      color: var(--text);
      font: inherit;
      font-size: 0.85rem;
    }
    .activity-form-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.45rem;
    }
    .activity-form-actions button {
      flex: 1;
      min-width: 6.5rem;
    }
    .activity-card .message {
      margin: 0;
      font-size: 0.78rem;
    }
    html[data-theme="dark"] .schedule-period-pill.activity-manual .schedule-period-activity { color: #7dd3fc; }
    html[data-theme="dark"] .schedule-period-pill.activity-vacation .schedule-period-activity { color: #fcd34d; }
    .schedule-empty {
      color: var(--muted);
      font-size: 0.88rem;
    }

  `;
}
function devBannerHtml() {
    if (!IS_LOCAL_DEV)
        return "";
    const port = process.env.PORT ?? "3000";
    return ('<div class="dev-banner">' +
        "<span>Local dev mode — changes to <code>server.ts</code> reload automatically</span>" +
        "<span>Data: <code>" +
        escapeHtml(DATA_ROOT) +
        "</code> · <code>http://localhost:" +
        escapeHtml(String(port)) +
        "</code></span>" +
        "</div>");
}
function renderPage(active, content) {
    const navSections = [
        {
            label: "Control",
            items: [
                { id: "dashboard", label: "Dashboard", href: "/" },
                { id: "mode", label: "Mode", href: "/mode" },
                { id: "schedule", label: "Schedule", href: "/schedule" },
                { id: "activities", label: "Activities", href: "/activities" },
                { id: "circulation", label: "Circulation", href: "/circulation" },
            ],
        },
        {
            label: "System",
            items: [
                { id: "weather", label: "Weather", href: "/weather" },
                { id: "maintenance", label: "Maintenance", href: "/maintenance" },
            ],
        },
        {
            label: "App",
            items: [
                { id: "api", label: "API Explorer", href: "/api" },
                { id: "setup", label: "Setup", href: "/setup" },
                { id: "settings", label: "Settings", href: "/settings" },
            ],
        },
    ];
    const navHtml = navSections
        .map((section) => {
        const links = section.items
            .map((item) => `<a class="nav-link${item.id === active ? " active" : ""}" href="${item.href}">${escapeHtml(item.label)}</a>`)
            .join("");
        return `<p class="nav-section">${escapeHtml(section.label)}</p>${links}`;
    })
        .join("");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Bryant/Carrier HVAC</title>
  <style>${pageStyles()}</style>
</head>
<body>
  ${devBannerHtml()}
  <div class="layout">
    <header class="mobile-header">
      <button type="button" class="menu-toggle" id="menu-toggle" aria-label="Open menu" aria-expanded="false" aria-controls="sidebar">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h16"/>
        </svg>
      </button>
      <div class="mobile-header-copy">
        <select class="mobile-header-title system-selector" id="mobile-header-system" data-system-select aria-label="Select HVAC system">
          <option value="">Bryant/Carrier HVAC</option>
        </select>
      </div>
      <button type="button" class="tile-refresh header-refresh" id="header-refresh" aria-label="Refresh page">${REFRESH_ICON_SVG}</button>
      <span class="status-pill status-pill-compact warning" id="mobile-connection-pill">Loading…</span>
    </header>
    <div class="sidebar-backdrop" id="sidebar-backdrop" hidden></div>
    <aside class="sidebar" id="sidebar">
      <div class="brand">
        <img src="/icon.svg" alt="" />
        <div>
          <h1>Bryant/Carrier HVAC</h1>
          <p>Cloud thermostat control</p>
        </div>
      </div>
      <nav>${navHtml}</nav>
      <p class="sidebar-version">v${escapeHtml(APP_VERSION)}</p>
    </aside>
    <main class="main">${content}</main>
  </div>
  <script>
    window.hvacSetButtonPending = function(button, label) {
      if (!button || button.dataset.busy === "true") return false;
      if (!button.dataset.originalLabel) button.dataset.originalLabel = button.textContent;
      button.dataset.busy = "true";
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      button.classList.remove("success-flash", "error-flash");
      button.classList.add("busy");
      button.textContent = label;
      return true;
    };
    window.hvacSetButtonSuccess = function(button, label) {
      if (!button) return;
      button.classList.remove("busy", "error-flash");
      button.classList.add("success-flash");
      button.textContent = label;
    };
    window.hvacSetButtonError = function(button, label) {
      if (!button) return;
      button.disabled = false;
      button.dataset.busy = "false";
      button.removeAttribute("aria-busy");
      button.classList.remove("busy", "success-flash");
      button.classList.add("error-flash");
      button.textContent = label;
      window.setTimeout(function() {
        window.hvacResetButton(button);
      }, 1600);
    };
    window.hvacResetButton = function(button) {
      if (!button) return;
      button.disabled = false;
      button.dataset.busy = "false";
      button.removeAttribute("aria-busy");
      button.classList.remove("busy", "success-flash", "error-flash");
      if (button.dataset.originalLabel) {
        button.textContent = button.dataset.originalLabel;
      }
    };
    window.hvacRefreshButton = function(toolbarId) {
      if (window.matchMedia("(min-width: 901px)").matches) {
        return document.getElementById(toolbarId) || document.getElementById("header-refresh");
      }
      return document.getElementById("header-refresh");
    };
    document.getElementById("header-refresh")?.addEventListener("click", () => {
      window.dispatchEvent(new CustomEvent("hvac:refresh"));
    });
    (function () {
      const toggle = document.getElementById("menu-toggle");
      const sidebar = document.getElementById("sidebar");
      const backdrop = document.getElementById("sidebar-backdrop");
      if (!toggle || !sidebar || !backdrop) return;

      const mq = window.matchMedia("(max-width: 900px)");

      function setOpen(open) {
        sidebar.classList.toggle("open", open);
        backdrop.classList.toggle("open", open);
        backdrop.hidden = !open;
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
        toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
        document.body.style.overflow = open && mq.matches ? "hidden" : "";
      }

      function closeSidebar() {
        setOpen(false);
      }

      toggle.addEventListener("click", () => {
        setOpen(!sidebar.classList.contains("open"));
      });
      backdrop.addEventListener("click", closeSidebar);
      sidebar.querySelectorAll(".nav-link").forEach((link) => {
        link.addEventListener("click", closeSidebar);
      });
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") closeSidebar();
      });
      mq.addEventListener("change", () => {
        if (!mq.matches) closeSidebar();
      });
    })();
    window.hvacSystemSelectSyncing = false;
    window.hvacSystemSwitchInFlight = false;
    window.hvacPopulateSystemSelect = function (select, data) {
      if (!select) return;
      const systems = data?.systems || [];
      const activeSerial = data?.system?.serial || data?.settings?.system_serial || "";
      const settingsName = data?.settings?.system_name || "Bryant/Carrier HVAC";
      const fallbackName = data?.system?.name || settingsName;
      window.hvacSystemSelectSyncing = true;
      select.replaceChildren();
      if (!data?.configured) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = settingsName;
        select.appendChild(option);
        select.value = "";
        select.disabled = true;
        window.hvacSystemSelectSyncing = false;
        return;
      }
      if (!systems.length) {
        const option = document.createElement("option");
        option.value = activeSerial;
        option.textContent = fallbackName;
        select.appendChild(option);
        select.value = activeSerial;
        select.disabled = true;
        window.hvacSystemSelectSyncing = false;
        return;
      }
      systems.forEach((item) => {
        const option = document.createElement("option");
        option.value = item.serial;
        option.textContent = item.name || item.serial;
        select.appendChild(option);
      });
      const selectedSerial = systems.some((item) => item.serial === activeSerial)
        ? activeSerial
        : systems[0].serial;
      select.value = selectedSerial;
      select.disabled = systems.length <= 1 || window.hvacSystemSwitchInFlight;
      window.hvacSystemSelectSyncing = false;
    };
    window.hvacSyncSystemSelectors = function (data) {
      document.querySelectorAll("[data-system-select]").forEach((select) => {
        window.hvacPopulateSystemSelect(select, data);
      });
    };
    window.hvacSwitchSystem = async function (serial) {
      if (!serial || window.hvacSystemSwitchInFlight) return;
      window.hvacSystemSwitchInFlight = true;
      document.querySelectorAll("[data-system-select]").forEach((select) => {
        select.disabled = true;
      });
      const pill = document.getElementById("mobile-connection-pill");
      try {
        const res = await fetch("/api/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ system_serial: serial }),
        });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || "Could not switch system");
        window.location.reload();
      } catch (error) {
        window.hvacSystemSwitchInFlight = false;
        if (pill) {
          pill.className = "status-pill status-pill-compact error";
          pill.textContent = String(error);
        }
        try {
          const statusRes = await fetch("/api/status");
          const data = await statusRes.json();
          window.hvacSyncSystemSelectors(data);
        } catch (refreshError) {
          document.querySelectorAll("[data-system-select]").forEach((select) => {
            select.disabled = false;
          });
        }
      }
    };
    window.hvacUpdateMobileHeader = function (data) {
      const pill = document.getElementById("mobile-connection-pill");
      window.hvacSyncSystemSelectors(data);
      if (!pill) return;
      if (!data?.configured) {
        pill.className = "status-pill status-pill-compact warning";
        pill.textContent = "Setup required";
        return;
      }
      if (!data.system || !data.connected) {
        pill.className = "status-pill status-pill-compact warning";
        pill.textContent = data?.error ? "Connection issue" : "Syncing";
        return;
      }
      pill.className = "status-pill status-pill-compact success";
      pill.textContent = "Connected";
    };
    document.addEventListener("change", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLSelectElement) || !target.matches("[data-system-select]")) return;
      if (window.hvacSystemSelectSyncing || window.hvacSystemSwitchInFlight) return;
      const serial = target.value;
      if (!serial) return;
      document.querySelectorAll("[data-system-select]").forEach((select) => {
        if (select !== target) select.value = serial;
      });
      window.hvacSwitchSystem(serial);
    });
    (function () {
      async function refreshMobileHeader() {
        try {
          const res = await fetch("/api/status");
          const data = await res.json();
          window.hvacUpdateMobileHeader(data);
        } catch (error) {
          const systemEl = document.getElementById("mobile-header-system");
          const pill = document.getElementById("mobile-connection-pill");
          if (systemEl && "value" in systemEl) systemEl.value = "";
          if (pill) {
            pill.className = "status-pill status-pill-compact error";
            pill.textContent = String(error);
          }
        }
      }
      refreshMobileHeader();
      setInterval(refreshMobileHeader, 15000);
    })();
  </script>
</body>
</html>`;
}
function setupContent(settings) {
    return `
    <div class="toolbar">
      <h2>Setup</h2>
      <div class="dashboard-toolbar-actions">
        <button type="button" class="tile-refresh" id="setup-refresh" aria-label="Refresh connection status">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
        </button>
        <span class="status-pill toolbar-connection-pill warning" id="connection-pill">Checking…</span>
      </div>
    </div>
    <div class="card">
      <h3>Sign in with your Bryant/Carrier account</h3>
      <p class="muted">
        Use the same email and password as the Bryant or Carrier mobile app.
        Your Umbrel needs internet access to reach Carrier's cloud API.
      </p>
      <form id="setup-form">
        <label>
          Email / username
          <input id="username" name="username" value="${escapeHtml(settings.username)}" autocomplete="username" required />
        </label>
        <label>
          Password
          <input id="password" name="password" type="password" autocomplete="current-password" ${settings.configured ? "" : "required"} placeholder="${settings.configured ? "Leave blank to keep saved password" : ""}" />
        </label>
        <button type="submit">Save &amp; connect</button>
        <div class="message" id="setup-message"></div>
      </form>
    </div>
    <div class="card" style="margin-top:1rem">
      <h3>How it works</h3>
      <div class="steps">
        <div class="step"><strong>No thermostat IP needed.</strong> This app talks to Carrier's cloud, the same way the official mobile app does.</div>
        <div class="step"><strong>Works with newer Connex firmware.</strong> Local proxy setups often fail on Series B Connex software (firmware 4.17+).</div>
        <div class="step"><strong>Internet required.</strong> Umbrel must reach Carrier's servers. Your thermostat still uses WiFi as usual.</div>
      </div>
    </div>
    <div class="card" style="margin-top:1rem">
      <h3>Diagnostics</h3>
      <div class="stat-row"><span class="muted">Cloud connection</span><span id="diag-cloud">Checking…</span></div>
      <div class="stat-row"><span class="muted">Systems found</span><span id="diag-systems">—</span></div>
      <div class="stat-row"><span class="muted">Last sync</span><span id="diag-sync">—</span></div>
      <div class="stat-row"><span class="muted">Live update</span><span id="diag-live">—</span></div>
      <div class="stat-row"><span class="muted">Zone sensor</span><span id="diag-sensor">—</span></div>
      <p class="muted message" id="diag-error" style="margin-top:0.75rem"></p>
    </div>
    <script>
      async function refreshConnection(force) {
        const pill = document.getElementById("connection-pill");
        const diagCloud = document.getElementById("diag-cloud");
        const diagSystems = document.getElementById("diag-systems");
        const diagSync = document.getElementById("diag-sync");
        const diagLive = document.getElementById("diag-live");
        const diagSensor = document.getElementById("diag-sensor");
        const diagError = document.getElementById("diag-error");
        try {
          const res = await fetch("/api/status" + (force ? "?refresh=1" : ""));
          const data = await res.json();
          diagSystems.textContent = String(data.systems?.length ?? 0);
          diagSync.textContent = data.last_sync ? new Date(data.last_sync).toLocaleString() : "Never";
          diagLive.textContent = data.last_live_update ? new Date(data.last_live_update).toLocaleString() : "Waiting…";
          const zone = data.zones?.[0];
          diagSensor.textContent = zone
            ? "rt " + (zone.sensor_rt ?? "—") + " → " + (zone.temperature_display ?? "—") + "°F · heat " + (zone.heat_setpoint_display ?? "—") + "°F"
            : "—";
          if (data.connected) {
            pill.className = "status-pill success";
            const zoneCount = data.zones?.length ?? 0;
            pill.textContent = zoneCount === 1 ? "Connected" : "Connected (" + zoneCount + " zones)";
            diagCloud.textContent = "Online";
            diagError.textContent = "";
          } else if (data.configured) {
            pill.className = "status-pill warning";
            pill.textContent = data.error ? "Connection issue" : "Waiting for data";
            diagCloud.textContent = data.error ? "Error" : "Syncing";
            diagError.textContent = data.error || "Credentials saved. Waiting for thermostat data from Carrier cloud.";
          } else {
            pill.className = "status-pill warning";
            pill.textContent = "Not configured";
            diagCloud.textContent = "Not signed in";
            diagError.textContent = "Enter your Bryant/Carrier account credentials above.";
          }
        } catch (error) {
          pill.className = "status-pill error";
          pill.textContent = "Cannot reach app";
          diagError.textContent = String(error);
        }
      }
      document.getElementById("setup-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const message = document.getElementById("setup-message");
        const form = event.target;
        const button = form.querySelector('button[type="submit"]');
        if (!hvacSetButtonPending(button, "Connecting…")) return;
        message.className = "message";
        message.textContent = "Checking credentials with Carrier…";
        try {
          const res = await fetch("/api/settings", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              username: form.username.value.trim(),
              password: form.password.value,
            }),
          });
          const data = await res.json();
          if (res.ok) {
            hvacSetButtonSuccess(button, "Connected!");
            message.className = "message success";
            message.textContent = "Connected. Redirecting…";
            window.setTimeout(() => { window.location.href = "/"; }, 700);
            return;
          }
          hvacSetButtonError(button, "Try again");
          message.className = "message error";
          message.textContent = data.error || "Could not save credentials.";
        } catch (error) {
          hvacSetButtonError(button, "Try again");
          message.className = "message error";
          message.textContent = String(error);
        }
      });
      async function refreshSetupPage() {
        const button = window.hvacRefreshButton("setup-refresh");
        if (!button) return;
        button.disabled = true;
        button.classList.add("spinning");
        try {
          await refreshConnection(true);
        } finally {
          button.disabled = false;
          button.classList.remove("spinning");
        }
      }
      document.getElementById("setup-refresh")?.addEventListener("click", () => refreshSetupPage());
      window.addEventListener("hvac:refresh", () => refreshSetupPage());
      refreshConnection(false);
      setInterval(() => refreshConnection(false), 5000);
    </script>
  `;
}
function dashboardContent() {
    return `
    <div class="toolbar dashboard-toolbar">
      <select class="toolbar-meta system-selector" id="active-system-select" data-system-select aria-label="Select HVAC system">
        <option value="">Loading system…</option>
      </select>
      <div class="dashboard-toolbar-actions">
        <button type="button" class="tile-refresh dashboard-refresh" id="dashboard-refresh" aria-label="Refresh dashboard">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
        </button>
        <span class="status-pill warning" id="connection-pill">Loading…</span>
      </div>
    </div>
    <div id="zone-cards" class="grid">
      <div class="card"><p class="muted">Loading zones…</p></div>
    </div>
    <script>
      const THERMO_MIN = 60;
      const THERMO_MAX = 90;
      const THERMO_DEADBAND = 2;
      const DASHBOARD_MUTATION_QUIET_MS = 12_000;
      let dashboardQuietUntil = 0;
      let dashboardFetchInFlight = false;

      function markDashboardMutation(quietMs = DASHBOARD_MUTATION_QUIET_MS) {
        dashboardQuietUntil = Date.now() + quietMs;
      }

      function rememberZoneMutation(card, zone, expected = {}) {
        if (!card) return;
        card.dataset.mutationPending = "true";
        if (zone) {
          card.dataset.lastHold = String(Boolean(zone.hold));
          if (zone.fan) card.dataset.lastFan = zone.fan;
        }
        if (expected.hold != null) card.dataset.lastHold = String(Boolean(expected.hold));
        if (expected.heat != null) card.dataset.lastHeat = String(expected.heat);
        else if (zone?.heat_setpoint_display) card.dataset.lastHeat = zone.heat_setpoint_display;
        if (expected.cool != null) card.dataset.lastCool = String(expected.cool);
        else if (zone?.cool_setpoint_display) card.dataset.lastCool = zone.cool_setpoint_display;
        if (expected.fan) card.dataset.lastFan = expected.fan;
        window.setTimeout(() => {
          delete card.dataset.mutationPending;
          delete card.dataset.lastHold;
          delete card.dataset.lastHeat;
          delete card.dataset.lastCool;
          delete card.dataset.lastFan;
        }, DASHBOARD_MUTATION_QUIET_MS);
      }

      function setpointDisplayMatches(display, expected) {
        if (expected == null || expected === "") return true;
        return String(parseTemp(display, NaN)) === String(parseTemp(expected, NaN));
      }

      function zoneSnapshotAcceptable(card, zone) {
        if (card.dataset.mutationPending !== "true") return true;
        if (card.dataset.lastHold === "true" && !zone.hold) return false;
        if (card.dataset.lastHeat && zone.heat_setpoint_display && zone.heat_setpoint_display !== card.dataset.lastHeat) {
          return false;
        }
        if (card.dataset.lastCool && zone.cool_setpoint_display && zone.cool_setpoint_display !== card.dataset.lastCool) {
          return false;
        }
        if (card.dataset.lastFan && (!zone.fan || zone.fan !== card.dataset.lastFan)) {
          return false;
        }
        delete card.dataset.mutationPending;
        delete card.dataset.lastHold;
        delete card.dataset.lastHeat;
        delete card.dataset.lastCool;
        delete card.dataset.lastFan;
        return true;
      }
      const FAN_LEVELS = ["auto", "low", "med", "high"];
      const FAN_LABELS = ["Auto", "Low", "Medium", "High"];
      const ICONS = {
        flame: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3c2 4 5 5.5 5 9a5 5 0 1 1-10 0c0-3.5 3-5 5-9z"/></svg>',
        snow: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M4 7l16 10M4 17L20 7M2 12h20"/></svg>',
        auto: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/><circle cx="12" cy="12" r="4"/></svg>',
        power: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v10"/><path d="M6.3 6.3a9 9 0 1 0 11.4 0"/></svg>',
        fan: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="2"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l3 3M16 16l3 3M19 5l-3 3M8 16l-3 3"/></svg>',
        droplet: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3c4 6 7 8.5 7 12a7 7 0 1 1-14 0c0-3.5 3-6 7-12z"/></svg>',
        calendar: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 11h18"/></svg>',
        sun: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2"/></svg>',
        home: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1z"/></svg>',
        away: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20V6l8-3 8 3v14"/><path d="M9 20v-6h6v6"/></svg>',
        sleep: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 14A8 8 0 0 0 11 6.5"/><path d="M3 14h9v7H3z"/></svg>',
        wake: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v3M5 7l2 2M19 7l-2 2"/><path d="M5 17a7 7 0 0 1 14 0"/></svg>',
        manual: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 21v-7l12-12 7 7-12 12z"/></svg>',
        vacation: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 20h18"/><path d="M7 20V10l5-4 5 4v10"/><path d="M9 14h6"/></svg>',
        resume: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 6h12M8 12h12M8 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/></svg>',
        filter: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 5h16l-6 7v6l-4 2v-8z"/></svg>',
        thermostat: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3a4 4 0 0 0-4 4v9a4 4 0 0 0 8 0V7a4 4 0 0 0-4-4z"/><circle cx="12" cy="15" r="1.5" fill="currentColor"/></svg>',
        pause: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M10 9v6M14 9v6"/></svg>',
        activity: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.5" fill="currentColor" stroke="none"/></svg>',
        refresh: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>',
      };

      function escapeHtml(value) {
        return String(value)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;");
      }

      function normalizeMode(mode) {
        if (!mode) return "auto";
        const m = String(mode).toLowerCase();
        if (m.includes("cool")) return "cool";
        if (m.includes("heat") || m === "emheat") return "heat";
        if (m === "fanonly" || m === "fan_only") return "fanonly";
        if (m === "off") return "off";
        return "auto";
      }

      function clampTemp(value) {
        return Math.max(THERMO_MIN, Math.min(THERMO_MAX, value));
      }

      function parseTemp(value, fallback) {
        const parsed = Number.parseInt(String(value), 10);
        return Number.isFinite(parsed) ? clampTemp(parsed) : fallback;
      }

      function tempToBottom(temp) {
        return ((clampTemp(temp) - THERMO_MIN) / (THERMO_MAX - THERMO_MIN)) * 100;
      }

      function bottomToTemp(bottom) {
        const ratio = Math.max(0, Math.min(100, bottom)) / 100;
        return clampTemp(Math.round(THERMO_MIN + ratio * (THERMO_MAX - THERMO_MIN)));
      }

      function fanToIndex(fan) {
        if (fan === "on") return 1;
        const index = FAN_LEVELS.indexOf(fan || "auto");
        return index >= 0 ? index : 0;
      }

      function fanSettingLabel(zone) {
        const index = fanToIndex(zone.fan);
        return FAN_LABELS[index] || "Auto";
      }

      function scheduleLabel(activity) {
        if (!activity) return "—";
        const labels = {
          manual: "Hold",
          home: "Home",
          away: "Away",
          sleep: "Sleep",
          wake: "Wake up",
          vacation: "Away long-term",
        };
        return labels[activity] || activity.charAt(0).toUpperCase() + activity.slice(1);
      }

      function chipActivityLabel(zone) {
        const activity = zone.hold ? (zone.hold_activity || zone.activity) : zone.activity;
        if (!activity) return "—";
        const labels = {
          manual: "Manual",
          home: "Home",
          away: "Away",
          sleep: "Sleep",
          wake: "Wake up",
          vacation: "Away long-term",
        };
        return labels[activity] || activity.charAt(0).toUpperCase() + activity.slice(1);
      }

      function renderStageBars(stage) {
        const level = Math.max(0, Math.min(5, Number(stage) || 0));
        return [1, 2, 3, 4, 5].map((index) => {
          return '<span class="stage-bar' + (index <= level ? " active" : "") + '"></span>';
        }).join("");
      }

      function stagedHeatIcon(stage) {
        const level = Math.max(1, Math.min(5, Number(stage) || 1));
        return '<span class="status-icon-staged" title="Stage ' + level + '">' + ICONS.flame + '<span class="stage-bars" aria-hidden="true">' + renderStageBars(level) + "</span></span>";
      }

      function stagedCoolIcon(stage) {
        const level = Math.max(1, Math.min(5, Number(stage) || 1));
        return '<span class="status-icon-staged" title="Stage ' + level + '">' + ICONS.snow + '<span class="stage-bars" aria-hidden="true">' + renderStageBars(level) + "</span></span>";
      }

      function operationIcon(zone) {
        const kind = zone.operation_kind || "idle";
        const stage = zone.operation_stage || 0;
        if (kind === "heating" || kind === "defrost") return stagedHeatIcon(stage || 1);
        if (kind === "cooling") return stagedCoolIcon(stage || 1);
        if (kind === "transition") return ICONS.activity;
        if (kind === "fan" || kind === "circulating") return ICONS.fan;
        return ICONS.pause;
      }

      function conditioningInfo(conditioning) {
        const value = String(conditioning || "idle").toLowerCase();
        if (value.includes("heat")) {
          return { label: value.includes("prep") || value.includes("pending") ? "Getting ready to heat" : "Heating", className: "status-heating", icon: stagedHeatIcon(1) };
        }
        if (value.includes("cool")) {
          return { label: value.includes("prep") || value.includes("pending") ? "Getting ready to cool" : "Cooling", className: "status-cooling", icon: stagedCoolIcon(1) };
        }
        if (value.includes("fan")) {
          return { label: "Fan running", className: "status-fan", icon: ICONS.fan };
        }
        if (value === "idle" || value === "off") {
          return { label: "Standing by", className: "status-idle", icon: ICONS.pause };
        }
        return {
          label: value.replaceAll("_", " ").replace(/^\\w/, (c) => c.toUpperCase()),
          className: "status-idle",
          icon: ICONS.pause,
        };
      }

      function presetIcon(preset) {
        return ICONS[preset] || ICONS.home;
      }

      function presetLabel(preset) {
        if (preset === "resume") return "Back to schedule";
        return scheduleLabel(preset);
      }

      function syncBlowerCompactTile(card, zone) {
        const setting = card.querySelector("[data-blower-setting-value]");
        if (setting) setting.textContent = fanSettingLabel(zone);
      }

      function syncHumidityTile(card, zone) {
        const humidityBar = card.querySelector("[data-humidity-bar]");
        const humidityValue = card.querySelector("[data-humidity-value]");
        const humidity = Number(zone.humidity);
        if (humidityValue) {
          humidityValue.textContent = Number.isFinite(humidity) ? humidity + "%" : "—";
        }
        if (humidityBar) {
          humidityBar.style.height = Number.isFinite(humidity) ? Math.max(0, Math.min(100, humidity)) + "%" : "0%";
        }
      }

      function syncThermoTile(card, zone) {
        const temp = zone.temperature_display ?? zone.temperature ?? "—";
        const display = card.querySelector(".zone-hero-temp .temp-display");
        const unit = card.querySelector(".zone-hero-temp .temp-unit");
        if (display) display.textContent = temp;
        if (unit) unit.textContent = temp === "—" ? "" : "°F";
        const widget = card.querySelector(".thermo-widget");
        if (widget && card.dataset.dragging !== "true") {
          const heatHandle = widget.querySelector(".thermo-handle-heat");
          const coolHandle = widget.querySelector(".thermo-handle-cool");
          const heat = parseTemp(zone.heat_setpoint_display ?? zone.heat_setpoint, 68);
          const cool = parseTemp(zone.cool_setpoint_display ?? zone.cool_setpoint, 74);
          const pending = card.dataset.mutationPending === "true";
          if (heatHandle && (!pending || setpointDisplayMatches(zone.heat_setpoint_display ?? zone.heat_setpoint, card.dataset.lastHeat))) {
            heatHandle.dataset.value = String(heat);
          }
          if (coolHandle && (!pending || setpointDisplayMatches(zone.cool_setpoint_display ?? zone.cool_setpoint, card.dataset.lastCool))) {
            coolHandle.dataset.value = String(cool);
          }
          const indoor = parseTemp(zone.temperature_display ?? zone.temperature, parseTemp(widget.dataset.indoor, 68));
          widget.dataset.indoor = String(indoor);
          updateThermoWidget(widget);
        }
      }

      function syncScheduleTile(card, zone) {
        const schedule = card.querySelector("[data-schedule-readout]");
        const label = card.querySelector("[data-schedule-label]");
        if (schedule) schedule.textContent = chipActivityLabel(zone);
        if (label) label.textContent = zone.hold ? "Hold" : "Schedule";
      }

      function syncStatusTile(card, zone) {
        const fallback = conditioningInfo(zone.conditioning);
        const summary = zone.operation_summary || fallback.label;
        const className = zone.operation_class || fallback.className;
        const badge = card.querySelector("[data-status-badge]");
        const detail = card.querySelector("[data-status-detail]");
        if (badge) {
          badge.className = "status-badge " + className;
          badge.innerHTML = operationIcon(zone) + " " + escapeHtml(summary);
        }
        if (detail) {
          const text = zone.operation_detail || "";
          detail.textContent = text;
          detail.hidden = !text;
        }
      }

      async function fetchFreshStatus() {
        const res = await fetch("/api/status?refresh=1");
        return res.json();
      }

      function syncZoneCardShell(card, zone, systemMode, singleZone) {
        const normalizedMode = normalizeMode(systemMode || "auto");
        card.dataset.systemMode = normalizedMode;
        card.className = "card zone-control-card" + (singleZone ? " single-zone" : "") + " mode-" + normalizedMode;
        const name = card.querySelector(".zone-name");
        if (name) name.textContent = zone.name;
      }

      function syncZoneReadout(card, zone) {
        syncStatusTile(card, zone);
        syncScheduleTile(card, zone);
        syncHumidityTile(card, zone);
        syncThermoTile(card, zone);
        syncBlowerCompactTile(card, zone);
      }

      function applyDashboardSnapshot(data, options = {}) {
        const preserveLayout = options.preserveLayout === true;
        const pill = document.getElementById("connection-pill");
        const zoneCards = document.getElementById("zone-cards");
        const zoneDragging = Boolean(zoneCards?.querySelector('[data-dragging="true"]'));

        updateActiveSystemLabel(data);
        if (window.hvacUpdateMobileHeader) window.hvacUpdateMobileHeader(data);

        if (!data.configured) {
          if (pill) {
            pill.className = "status-pill warning";
            pill.textContent = "Setup required";
          }
          if (!preserveLayout && zoneCards) {
            zoneCards.innerHTML = '<div class="card"><h3>Sign in required</h3><p class="muted">Connect your Bryant/Carrier account on the <a href="/setup">Setup page</a>.</p></div>';
          }
          return;
        }

        if (!data.connected) {
          if (pill) {
            pill.className = "status-pill warning";
            pill.textContent = data.error ? "Connection issue" : "Syncing";
          }
          if (!preserveLayout && zoneCards) {
            zoneCards.innerHTML = '<div class="card"><h3>Not connected yet</h3><p class="muted">' + escapeHtml(data.error || "Waiting for data from Carrier cloud. Check your internet connection.") + '</p></div>';
          }
          return;
        }

        if (pill) {
          pill.className = "status-pill success";
          pill.textContent = "Connected";
        }

        const mode = data.system?.mode || "auto";

        if (!zoneDragging && zoneCards && Array.isArray(data.zones) && data.zones.length) {
          const singleZone = data.zones.length === 1;
          zoneCards.classList.toggle("single-zone", singleZone);
          for (const zone of data.zones) {
            const card = zoneCards.querySelector('.zone-control-card[data-zone-id="' + CSS.escape(zone.id) + '"]');
            if (!card || card.dataset.dragging === "true") continue;
            if (!zoneSnapshotAcceptable(card, zone)) continue;
            syncZoneCardShell(card, zone, mode, singleZone);
            syncZoneReadout(card, zone);
          }
        }
      }

      async function refreshDashboard(button) {
        button.disabled = true;
        button.classList.add("spinning");
        try {
          const data = await fetchFreshStatus();
          applyDashboardSnapshot(data, { preserveLayout: true });
        } finally {
          button.disabled = false;
          button.classList.remove("spinning");
        }
      }

      function initDashboardRefreshButton() {
        const button = document.getElementById("dashboard-refresh");
        if (!button || button.dataset.initialized === "true") return;
        button.dataset.initialized = "true";
        button.addEventListener("click", async () => {
          await refreshDashboard(button);
        });
      }

      window.addEventListener("hvac:refresh", async () => {
        const button = window.hvacRefreshButton("dashboard-refresh");
        if (button) await refreshDashboard(button);
      });

      function renderThermoScale() {
        return [90, 80, 70, 60].map((temp) =>
          '<div class="thermo-tick thermo-tick-major"><span class="thermo-tick-label">' + temp + '</span><span class="thermo-tick-mark"></span></div>'
        ).join("");
      }

      function renderThermoInnerTicks() {
        return [60, 70, 80, 90].map((temp) =>
          '<span class="thermo-inner-tick" style="bottom:' + tempToBottom(temp) + '%"></span>'
        ).join("");
      }

      function updateThermoWidget(widget) {
        const heatHandle = widget.querySelector(".thermo-handle-heat");
        const coolHandle = widget.querySelector(".thermo-handle-cool");
        const fill = widget.querySelector(".thermo-fill");
        const zoneHeat = widget.querySelector(".thermo-zone-heat");
        const zoneCool = widget.querySelector(".thermo-zone-cool");
        const heat = parseTemp(heatHandle.dataset.value, 68);
        const cool = parseTemp(coolHandle.dataset.value, 74);
        const indoor = parseTemp(widget.dataset.indoor, heat);
        const heatBottom = tempToBottom(heat);
        const coolBottom = tempToBottom(cool);
        const indoorBottom = tempToBottom(indoor);

        heatHandle.dataset.value = String(heat);
        coolHandle.dataset.value = String(cool);
        const heatLabel = heatHandle.querySelector(".thermo-flag-label");
        const coolLabel = coolHandle.querySelector(".thermo-flag-label");
        if (heatLabel) heatLabel.textContent = heat + "°";
        if (coolLabel) coolLabel.textContent = cool + "°";
        heatHandle.style.bottom = heatBottom + "%";
        coolHandle.style.bottom = coolBottom + "%";
        if (fill) fill.style.height = indoorBottom + "%";
        if (zoneHeat) zoneHeat.style.height = heatBottom + "%";
        if (zoneCool) zoneCool.style.height = (100 - coolBottom) + "%";
      }

      function nearestVisibleHandle(widget, temp) {
        const card = widget.closest(".zone-control-card");
        const mode = card.dataset.systemMode || "auto";
        if (mode === "heat") return widget.querySelector(".thermo-handle-heat");
        if (mode === "cool") return widget.querySelector(".thermo-handle-cool");
        const heatHandle = widget.querySelector(".thermo-handle-heat");
        const coolHandle = widget.querySelector(".thermo-handle-cool");
        const heat = parseTemp(heatHandle.dataset.value, 68);
        const cool = parseTemp(coolHandle.dataset.value, 74);
        return Math.abs(temp - heat) <= Math.abs(temp - cool) ? heatHandle : coolHandle;
      }

      function setHandleTemp(widget, handle, temp) {
        const heatHandle = widget.querySelector(".thermo-handle-heat");
        const coolHandle = widget.querySelector(".thermo-handle-cool");
        let next = clampTemp(temp);
        if (handle.classList.contains("thermo-handle-heat") && coolHandle.offsetParent !== null) {
          const cool = parseTemp(coolHandle.dataset.value, 74);
          next = Math.min(next, cool - THERMO_DEADBAND);
        }
        if (handle.classList.contains("thermo-handle-cool") && heatHandle.offsetParent !== null) {
          const heat = parseTemp(heatHandle.dataset.value, 68);
          next = Math.max(next, heat + THERMO_DEADBAND);
        }
        handle.dataset.value = String(next);
        updateThermoWidget(widget);
      }

      function tempFromPointer(track, clientY) {
        const rect = track.getBoundingClientRect();
        const ratio = 1 - Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
        return bottomToTemp(ratio * 100);
      }

      function initThermoWidget(widget) {
        if (widget.dataset.initialized === "true") return;
        widget.dataset.initialized = "true";
        const track = widget.querySelector(".thermo-tube");
        const handles = widget.querySelectorAll(".thermo-handle");
        updateThermoWidget(widget);

        handles.forEach((handle) => {
          handle.addEventListener("pointerdown", (event) => {
            event.preventDefault();
            const card = widget.closest(".zone-control-card");
            card.dataset.dragging = "true";
            handle.setPointerCapture(event.pointerId);

            const onMove = (moveEvent) => {
              setHandleTemp(widget, handle, tempFromPointer(track, moveEvent.clientY));
            };

            const onEnd = async () => {
              card.dataset.dragging = "false";
              handle.removeEventListener("pointermove", onMove);
              handle.removeEventListener("pointerup", onEnd);
              handle.removeEventListener("pointercancel", onEnd);
              await applyZoneSetpoints(card);
            };

            handle.addEventListener("pointermove", onMove);
            handle.addEventListener("pointerup", onEnd);
            handle.addEventListener("pointercancel", onEnd);
          });
        });

        track.addEventListener("pointerdown", (event) => {
          if (event.target.closest(".thermo-handle")) return;
          const handle = nearestVisibleHandle(widget, tempFromPointer(track, event.clientY));
          if (!handle) return;
          const card = widget.closest(".zone-control-card");
          setHandleTemp(widget, handle, tempFromPointer(track, event.clientY));
          void applyZoneSetpoints(card);
        });
      }

      function clearSetpointMutation(card) {
        delete card.dataset.mutationPending;
        delete card.dataset.lastHold;
        delete card.dataset.lastHeat;
        delete card.dataset.lastCool;
      }

      async function postZoneUpdate(card, payload) {
        const zoneId = card.dataset.zoneId;
        const message = card.querySelector(".zone-message");
        const isSetpointMutation =
          payload.heat_setpoint !== undefined || payload.cool_setpoint !== undefined;
        if (isSetpointMutation) {
          rememberZoneMutation(card, null, {
            hold: true,
            heat: payload.heat_setpoint,
            cool: payload.cool_setpoint,
          });
        }
        if (message) {
          message.className = "message";
          message.textContent = "Updating…";
        }
        markDashboardMutation();
        let ok = false;
        try {
          const res = await fetch("/api/zone/" + encodeURIComponent(zoneId), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          const data = await res.json();
          ok = res.ok;
          if (message) {
            message.className = "message " + (res.ok ? "success" : "error");
            message.textContent = res.ok ? "Updated." : (data.error || "Update failed.");
          }
          if (res.ok) {
            if (data.zone) {
              const zone = data.zone;
              if (isSetpointMutation) {
                rememberZoneMutation(card, zone, {
                  hold: true,
                  heat: payload.heat_setpoint,
                  cool: payload.cool_setpoint,
                });
              } else {
                rememberZoneMutation(card, zone);
              }
              const zoneCards = document.getElementById("zone-cards");
              const systemMode = card.dataset.systemMode || "auto";
              const singleZone = zoneCards?.classList.contains("single-zone") ?? false;
              syncZoneCardShell(card, zone, systemMode, singleZone);
              syncZoneReadout(card, zone);
            }
            window.setTimeout(() => loadDashboard({ soft: true, refresh: true }), 1500);
          } else if (isSetpointMutation) {
            clearSetpointMutation(card);
          }
        } catch (error) {
          if (message) {
            message.className = "message error";
            message.textContent = String(error);
          }
          if (isSetpointMutation) {
            clearSetpointMutation(card);
          }
        }
        return ok;
      }

      async function applyZoneSetpoints(card) {
        const widget = card.querySelector(".thermo-widget");
        if (!widget) return false;
        const heatHandle = widget.querySelector(".thermo-handle-heat");
        const coolHandle = widget.querySelector(".thermo-handle-cool");
        if (!heatHandle || !coolHandle) return false;
        return postZoneUpdate(card, {
          heat_setpoint: heatHandle.dataset.value,
          cool_setpoint: coolHandle.dataset.value,
        });
      }

      function initZoneCard(card) {
        initThermoWidget(card.querySelector(".thermo-widget"));
      }

      function renderZoneCard(zone, systemMode, singleZone) {
        const normalizedMode = normalizeMode(systemMode);
        const temp = zone.temperature_display ?? (zone.temperature ?? "—");
        const humidity = zone.humidity ?? "—";
        const heat = parseTemp(zone.heat_setpoint_display ?? zone.heat_setpoint, 68);
        const cool = parseTemp(zone.cool_setpoint_display ?? zone.cool_setpoint, 74);
        const indoor = parseTemp(zone.temperature_display ?? zone.temperature, heat);
        const fanIndex = fanToIndex(zone.fan);
        const status = {
          label: zone.operation_summary || conditioningInfo(zone.conditioning).label,
          className: zone.operation_class || conditioningInfo(zone.conditioning).className,
          icon: operationIcon(zone),
        };
        const scheduleText = chipActivityLabel(zone);
        const scheduleChipLabel = zone.hold ? "Hold" : "Schedule";
        const humidityWidth = Number.isFinite(Number(zone.humidity)) ? Math.max(0, Math.min(100, Number(zone.humidity))) : 0;
        return \`
          <div class="card zone-control-card\${singleZone ? " single-zone" : ""} mode-\${escapeHtml(normalizedMode)}" data-zone-id="\${escapeHtml(zone.id)}" data-system-mode="\${escapeHtml(normalizedMode)}">
            <div class="zone-hero">
              <div>
                <h3 class="zone-name">\${escapeHtml(zone.name)}</h3>
                <div class="status-row">
                  <div class="status-copy">
                    <div class="status-badge \${status.className}" data-status-badge>\${status.icon} \${escapeHtml(status.label)}</div>
                    <p class="status-detail" data-status-detail\${zone.operation_detail ? "" : ' hidden'}>\${escapeHtml(zone.operation_detail || "")}</p>
                  </div>
                </div>
              </div>
              <div class="zone-hero-temp">
                <div>
                  <span class="temp-display">\${temp}</span><span class="temp-unit">\${temp === "—" ? "" : "°F"}</span>
                </div>

              </div>
            </div>
            <div class="stat-chips">
              <div class="stat-chips-compact-row">
                <div class="stat-chip stat-chip-compact humidity-chip">
                  <div class="chip-header">
                    \${ICONS.droplet}
                    <span class="chip-label">Humidity</span>
                  </div>
                  <div class="humidity-chip-body">
                    <div class="humidity-indicator" aria-hidden="true">
                      <div class="humidity-bar-track">
                        <span class="humidity-bar-fill" data-humidity-bar style="height:\${humidityWidth}%"></span>
                      </div>
                    </div>
                    <span class="chip-value" data-humidity-value>\${humidity}\${humidity === "—" ? "" : "%"}</span>
                  </div>
                </div>
                <a class="stat-chip stat-chip-compact stat-chip-link schedule-chip-compact" href="/schedule">
                  <div class="chip-header">
                    \${ICONS.calendar}
                    <span class="chip-label" data-schedule-label>\${escapeHtml(scheduleChipLabel)}</span>
                  </div>
                  <span class="chip-value" data-schedule-readout>\${escapeHtml(scheduleText)}</span>
                </a>
                <a class="stat-chip stat-chip-compact stat-chip-link blower-chip-compact" href="/circulation">
                  <div class="chip-header">
                    \${ICONS.fan}
                    <span class="chip-label">Blower</span>
                  </div>
                  <span class="chip-value" data-blower-setting-value>\${escapeHtml(FAN_LABELS[fanIndex] || "Auto")}</span>
                </a>
              </div>
            </div>
            <div class="zone-control-layout">
              <div>
                <div class="section-title">\${ICONS.thermostat} Slide the flags to adjust</div>
                <div
                  class="thermo-widget"
                  data-indoor="\${indoor}"
                  data-heat="\${heat}"
                  data-cool="\${cool}"
                >
                  <div class="thermo-scale" aria-hidden="true">\${renderThermoScale()}</div>
                  <div class="thermo-body">
                    <div class="thermo-tube">
                      <div class="thermo-glass">
                        <div class="thermo-zone thermo-zone-heat"></div>
                        <div class="thermo-zone thermo-zone-cool"></div>
                        <div class="thermo-fill" title="Inside now: \${indoor}°F"><span class="thermo-fill-cap"></span></div>
                        <div class="thermo-inner-ticks">\${renderThermoInnerTicks()}</div>
                        <div class="thermo-shine"></div>
                      </div>
                      <button type="button" class="thermo-handle thermo-handle-heat" data-value="\${heat}" aria-label="Heat to \${heat} degrees"><span class="thermo-flag-stem"></span><span class="thermo-flag-label">\${heat}°</span></button>
                      <button type="button" class="thermo-handle thermo-handle-cool" data-value="\${cool}" aria-label="Cool to \${cool} degrees"><span class="thermo-flag-stem"></span><span class="thermo-flag-label">\${cool}°</span></button>
                    </div>
                    <div class="thermo-bulb" aria-hidden="true"></div>
                  </div>
                </div>
                <div class="thermo-legend"><span>Heat</span><span>Red = inside now</span><span>Cool</span></div>
              </div>
              <div class="zone-side-panel">
                <div class="message zone-message"></div>
              </div>
            </div>
          </div>
        \`;
      }

      function updateActiveSystemLabel(data) {
        if (window.hvacSyncSystemSelectors) window.hvacSyncSystemSelectors(data);
      }

      async function loadDashboard(options = {}) {
        if (dashboardFetchInFlight && options.auto) return;
        const pill = document.getElementById("connection-pill");
        const zoneCards = document.getElementById("zone-cards");
        const zoneDragging = Boolean(zoneCards.querySelector('[data-dragging="true"]'));
        const recentlyMutated = Date.now() < dashboardQuietUntil;
        const forceRefresh = Boolean(options.refresh || recentlyMutated);
        dashboardFetchInFlight = true;
        try {
          const res = await fetch("/api/status" + (forceRefresh ? "?refresh=1" : ""));
          const data = await res.json();
          if (!data.configured || !data.connected) {
            applyDashboardSnapshot(data);
            return;
          }
          const mode = data.system.mode || "auto";
          if (!zoneDragging) {
            const singleZone = data.zones.length === 1;
            const zoneCount = data.zones.length;
            const existingCards = zoneCards.querySelectorAll(".zone-control-card").length;
            const singleZoneMismatch = singleZone !== zoneCards.classList.contains("single-zone");
            zoneCards.classList.toggle("single-zone", singleZone);
            const hasZoneCards = Boolean(zoneCards.querySelector(".zone-control-card"));
            if (hasZoneCards && existingCards === zoneCount && !singleZoneMismatch) {
              applyDashboardSnapshot(data, { preserveLayout: true });
            } else {
              zoneCards.innerHTML = data.zones.map((zone) => renderZoneCard(zone, mode, singleZone)).join("");
              zoneCards.querySelectorAll(".zone-control-card").forEach(initZoneCard);
              applyDashboardSnapshot(data, { preserveLayout: true });
            }
          } else {
            applyDashboardSnapshot(data, { preserveLayout: true });
          }
        } catch (error) {
          if (pill) {
            pill.className = "status-pill error";
            pill.textContent = "Error";
          }
          if (!options.soft && zoneCards) {
            zoneCards.innerHTML = '<div class="card"><p class="muted">' + escapeHtml(error) + '</p></div>';
          }
        } finally {
          dashboardFetchInFlight = false;
        }
      }
      initDashboardRefreshButton();
      loadDashboard();
      setInterval(() => loadDashboard({ soft: true, auto: true }), 15000);
    </script>
  `;
}
function modeContent() {
    return `
    <div class="toolbar">
      <h2>Mode</h2>
      <button type="button" class="tile-refresh" id="mode-refresh" aria-label="Refresh mode">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
      </button>
    </div>
    <div id="mode-content" class="mode-page-grid">
      <div class="card"><p class="muted">Loading system mode…</p></div>
    </div>
    <script>
      const MODE_ICONS = {
        flame: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3c2 4 5 5.5 5 9a5 5 0 1 1-10 0c0-3.5 3-5 5-9z"/></svg>',
        snow: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M4 7l16 10M4 17L20 7M2 12h20"/></svg>',
        auto: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/><circle cx="12" cy="12" r="4"/></svg>',
        power: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v10"/><path d="M6.3 6.3a9 9 0 1 0 11.4 0"/></svg>',
      };

      function escapeHtml(value) {
        return String(value)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;");
      }

      function normalizeMode(mode) {
        if (!mode) return "auto";
        const m = String(mode).toLowerCase();
        if (m.includes("cool")) return "cool";
        if (m.includes("heat") || m === "emheat") return "heat";
        if (m === "fanonly" || m === "fan_only") return "fanonly";
        if (m === "off") return "off";
        return "auto";
      }

      function modeLabel(mode) {
        const normalized = normalizeMode(mode);
        if (normalized === "fanonly") return "Fan only";
        if (normalized === "auto") return "Auto";
        return normalized.charAt(0).toUpperCase() + normalized.slice(1);
      }

      function renderModeTiles(currentMode) {
        const active = normalizeMode(currentMode);
        const modes = [
          { id: "heat", label: "Heat", hint: "Warm up", icon: MODE_ICONS.flame },
          { id: "cool", label: "Cool", hint: "Cool down", icon: MODE_ICONS.snow },
          { id: "auto", label: "Auto", hint: "Picks for you", icon: MODE_ICONS.auto },
          { id: "off", label: "Off", hint: "Paused", icon: MODE_ICONS.power },
        ];
        return modes.map((mode) =>
          '<button type="button" class="mode-tile mode-tile-' + mode.id + (active === mode.id ? " active" : "") + '" data-mode="' + mode.id + '" title="' + escapeHtml(mode.hint) + '">' +
            mode.icon + "<span>" + mode.label + "</span></button>"
        ).join("");
      }

      function syncModeTile(mode) {
        const normalized = normalizeMode(mode || "auto");
        const readout = document.querySelector("[data-mode-readout]");
        if (readout) {
          readout.innerHTML = "Now: <strong>" + escapeHtml(modeLabel(mode)) + "</strong>";
        }
        document.querySelectorAll("[data-mode]").forEach((button) => {
          const active = normalizeMode(button.dataset.mode) === normalized;
          button.className = "mode-tile mode-tile-" + button.dataset.mode + (active ? " active" : "");
        });
      }

      function syncSystemActivity(zones) {
        const readout = document.querySelector("[data-system-activity]");
        if (!readout || !Array.isArray(zones) || !zones.length) return;
        const zone = zones[0];
        const text = zone.operation_detail || zone.operation_summary || "";
        readout.textContent = text;
        readout.hidden = !text;
      }

      function renderModeCard(mode) {
        return (
          '<div class="card mode-control-card">' +
          '<div class="card-header-row"><h3>What should it do?</h3></div>' +
          '<p class="muted mode-readout" data-mode-readout>Now: <strong>' + escapeHtml(modeLabel(mode)) + '</strong></p>' +
          '<p class="muted system-activity-readout" data-system-activity hidden></p>' +
          '<div class="mode-tiles">' + renderModeTiles(mode) + '</div>' +
          '<div class="message" id="mode-message"></div>' +
          "</div>"
        );
      }

      function bindModeButtons() {
        document.querySelectorAll("[data-mode]").forEach((button) => {
          if (button.dataset.initialized === "true") return;
          button.dataset.initialized = "true";
          button.addEventListener("click", async () => {
            const message = document.getElementById("mode-message");
            const modeRes = await fetch("/api/mode", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ mode: button.dataset.mode }),
            });
            const modeData = await modeRes.json();
            if (message) {
              message.className = "message " + (modeRes.ok ? "success" : "error");
              message.textContent = modeRes.ok ? "Updated." : (modeData.error || "Could not change mode.");
            }
            if (modeRes.ok) {
              await loadMode({ soft: true, refresh: true });
            }
          });
        });
      }

      async function loadMode(options = {}) {
        const root = document.getElementById("mode-content");
        const button = options.refresh ? window.hvacRefreshButton("mode-refresh") : null;
        if (!root) return;
        if (button) {
          button.disabled = true;
          button.classList.add("spinning");
        }
        try {
          const res = await fetch("/api/status" + (options.refresh ? "?refresh=1" : ""));
          const data = await res.json();
          if (window.hvacUpdateMobileHeader) window.hvacUpdateMobileHeader(data);

          if (!data.configured) {
            root.innerHTML = '<div class="card"><h3>Sign in required</h3><p class="muted">Connect your Bryant/Carrier account on the <a href="/setup">Setup page</a>.</p></div>';
            return;
          }

          if (!data.connected || !data.system) {
            root.innerHTML = '<div class="card"><h3>Not connected yet</h3><p class="muted">' + escapeHtml(data.error || "Waiting for data from Carrier cloud.") + "</p></div>";
            return;
          }

          const mode = data.system.mode || "auto";
          if (!options.soft || !root.querySelector("[data-mode]")) {
            root.innerHTML = renderModeCard(mode);
            bindModeButtons();
          }
          syncModeTile(mode);
          syncSystemActivity(data.zones);
        } catch (error) {
          root.innerHTML = '<div class="card"><p class="muted">' + escapeHtml(error) + "</p></div>";
        } finally {
          if (button) {
            button.disabled = false;
            button.classList.remove("spinning");
          }
        }
      }

      document.getElementById("mode-refresh")?.addEventListener("click", () => loadMode({ refresh: true }));
      window.addEventListener("hvac:refresh", () => loadMode({ refresh: true }));
      loadMode();
      setInterval(() => loadMode({ soft: true }), 15000);
    </script>
  `;
}
function weatherContent() {
    return `
    <div class="toolbar">
      <h2>Weather</h2>
      <button type="button" class="tile-refresh" id="weather-refresh" aria-label="Refresh weather">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
      </button>
    </div>
    <div id="weather-content" class="weather-grid">
      <div class="card"><p class="muted">Loading outdoor temperature…</p></div>
    </div>
    <script>
      const SUN_ICON = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2"/></svg>';

      function escapeHtml(value) {
        return String(value)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;");
      }

      function renderOutdoorCard(system) {
        const outdoor = system.outdoor_temp_display ?? system.outdoor_temp ?? "—";
        const hasTemp = outdoor !== "—";
        return (
          '<div class="card weather-hero-card" id="outdoor-card">' +
          '<div class="maintenance-item-header">' +
          SUN_ICON +
          "<h3>Outside temperature</h3>" +
          "</div>" +
          '<div class="weather-row">' +
          '<div class="weather-icon-wrap" aria-hidden="true">' +
          SUN_ICON +
          "</div>" +
          "<div>" +
          '<div class="temp-display" data-outdoor-value>' +
          escapeHtml(String(outdoor)) +
          (hasTemp ? '<span class="temp-unit">°F</span>' : "") +
          "</div>" +
          '<span class="weather-caption">From your thermostat outdoor sensor</span>' +
          "</div>" +
          "</div>" +
          "</div>"
        );
      }

      function renderWeather(data) {
        const root = document.getElementById("weather-content");
        if (!root) return;

        if (!data.configured) {
          root.innerHTML = '<div class="card"><p class="muted">No credentials saved yet. Open <a href="/setup">Setup</a> to connect.</p></div>';
          return;
        }

        if (data.error && !data.system) {
          root.innerHTML = '<div class="card"><p class="message error">' + escapeHtml(data.error) + "</p></div>";
          return;
        }

        if (!data.system) {
          root.innerHTML = '<div class="card"><p class="muted">No system selected.</p></div>';
          return;
        }

        root.innerHTML = renderOutdoorCard(data.system);
      }

      async function loadWeather(force) {
        const button = force ? window.hvacRefreshButton("weather-refresh") : null;
        if (button) {
          button.disabled = true;
          button.classList.add("spinning");
        }
        try {
          const suffix = force ? "?refresh=1" : "";
          const res = await fetch("/api/status" + suffix);
          const data = await res.json();
          renderWeather(data);
        } catch (error) {
          const root = document.getElementById("weather-content");
          if (root) {
            root.innerHTML = '<div class="card"><p class="message error">' + escapeHtml(String(error)) + "</p></div>";
          }
        } finally {
          if (button) {
            button.disabled = false;
            button.classList.remove("spinning");
          }
        }
      }

      document.getElementById("weather-refresh")?.addEventListener("click", () => loadWeather(true));
      window.addEventListener("hvac:refresh", () => loadWeather(true));
      loadWeather(false);
      setInterval(() => loadWeather(false), 60000);
    </script>
  `;
}
function maintenanceContent() {
    return `
    <div class="toolbar">
      <h2>Maintenance</h2>
      <button type="button" class="tile-refresh" id="maintenance-refresh" aria-label="Refresh maintenance">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
      </button>
    </div>
    <div id="maintenance-content" class="maintenance-grid">
      <div class="card"><p class="muted">Loading maintenance data…</p></div>
    </div>
    <script>
      const FILTER_ICON = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 5h16l-6 7v6l-4 2v-8z"/></svg>';
      const CONDENSATE_ICON = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3c4 6 7 8.5 7 12a7 7 0 1 1-14 0c0-3.5 3-6 7-12z"/></svg>';

      function escapeHtml(value) {
        return String(value)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;");
      }

      function filterLifeClass(remaining) {
        const value = Number(remaining);
        if (!Number.isFinite(value)) return "";
        if (value <= 10) return " critical";
        if (value <= 25) return " low";
        return "";
      }

      function filterStatusHint(remaining) {
        const value = Number(remaining);
        if (!Number.isFinite(value)) return "Filter life is reported by your thermostat.";
        if (value <= 10) return "Replace the filter soon.";
        if (value <= 25) return "Plan a filter replacement.";
        return "Filter life looks good.";
      }

      function renderFilterCard(system) {
        const remaining = system.filter_remaining;
        const hasLife = Number.isFinite(Number(remaining));
        const width = hasLife ? Math.max(0, Math.min(100, Number(remaining))) : 0;
        const valueText = hasLife ? remaining + "% left" : "—";
        const filterType = system.filter_type ? escapeHtml(system.filter_type) : "Air filter";
        const interval = Number(system.filter_interval);
        const intervalText = Number.isFinite(interval) && interval > 0
          ? "Replacement interval: " + interval + " days"
          : "";

        return (
          '<div class="card" id="filter-card">' +
          '<div class="maintenance-item-header">' +
          FILTER_ICON +
          "<h3>" + filterType + "</h3>" +
          "</div>" +
          '<div class="maintenance-value' + filterLifeClass(remaining) + '" data-filter-value>' +
          escapeHtml(valueText) +
          "</div>" +
          '<div class="filter-bar-track"><span class="filter-bar-fill" data-filter-bar style="width:' + width + '%"></span></div>' +
          '<p class="maintenance-detail" data-filter-hint>' + escapeHtml(filterStatusHint(remaining)) + "</p>" +
          (intervalText ? '<p class="maintenance-detail">' + escapeHtml(intervalText) + "</p>" : "") +
          "</div>"
        );
      }

      function formatDateLabel(value) {
        if (!value) return "";
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return "";
        return date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
      }

      function condensateLifeClass(condensate) {
        if (!condensate) return "";
        if (condensate.status === "overdue" || condensate.status === "unknown") return " critical";
        if (condensate.status === "due_soon") return " low";
        return "";
      }

      function condensateBarWidth(condensate) {
        if (!condensate || condensate.status === "unknown") return 0;
        const interval = Number(condensate.interval_days) || 30;
        const remaining = Number(condensate.days_remaining);
        if (!Number.isFinite(remaining)) return 0;
        return Math.max(0, Math.min(100, (remaining / interval) * 100));
      }

      function condensateValueText(condensate) {
        if (!condensate || condensate.status === "unknown") return "Due now";
        if (condensate.status === "overdue") {
          const overdue = Number(condensate.days_overdue) || 0;
          return overdue + " day" + (overdue === 1 ? "" : "s") + " overdue";
        }
        const remaining = Number(condensate.days_remaining);
        return remaining + " day" + (remaining === 1 ? "" : "s") + " left";
      }

      function condensateStatusHint(condensate) {
        if (!condensate || condensate.status === "unknown") {
          return "Clear the condensate line, then mark it cleared to start the 30-day timer.";
        }
        if (condensate.status === "overdue") return "Clear the condensate drain line.";
        if (condensate.status === "due_soon") return "Plan to clear the condensate line soon.";
        const nextDue = formatDateLabel(condensate.next_due_at);
        return nextDue ? "Next due " + nextDue + "." : "On schedule.";
      }

      function renderCondensateCard(condensate) {
        const width = condensateBarWidth(condensate);
        const lastCleared = formatDateLabel(condensate?.last_cleared_at);
        const lastClearedText = lastCleared ? "Last cleared " + lastCleared + "." : "";

        return (
          '<div class="card" id="condensate-card">' +
          '<div class="maintenance-item-header">' +
          CONDENSATE_ICON +
          "<h3>Clear condensate line</h3>" +
          "</div>" +
          '<div class="maintenance-value' + condensateLifeClass(condensate) + '" data-condensate-value>' +
          escapeHtml(condensateValueText(condensate)) +
          "</div>" +
          '<div class="filter-bar-track"><span class="filter-bar-fill" data-condensate-bar style="width:' + width + '%"></span></div>' +
          '<p class="maintenance-detail" data-condensate-hint>' + escapeHtml(condensateStatusHint(condensate)) + "</p>" +
          '<p class="maintenance-detail">Every ' + escapeHtml(String(condensate?.interval_days || 30)) + " days." +
          (lastClearedText ? " " + escapeHtml(lastClearedText) : "") +
          "</p>" +
          '<div class="maintenance-actions">' +
          '<button type="button" class="secondary" data-condensate-clear>Mark cleared today</button>' +
          "</div>" +
          '<div class="message" data-condensate-message></div>' +
          "</div>"
        );
      }

      function bindCondensateActions(onUpdated) {
        const button = document.querySelector("[data-condensate-clear]");
        const message = document.querySelector("[data-condensate-message]");
        if (!button || button.dataset.initialized === "true") return;
        button.dataset.initialized = "true";
        button.addEventListener("click", async () => {
          button.disabled = true;
          if (message) {
            message.className = "message";
            message.textContent = "";
          }
          try {
            const res = await fetch("/api/maintenance/condensate", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{}",
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Could not save condensate maintenance.");
            if (message) {
              message.className = "message success";
              message.textContent = "Logged. Next reminder in 30 days.";
            }
            await onUpdated();
          } catch (error) {
            if (message) {
              message.className = "message error";
              message.textContent = String(error);
            }
          } finally {
            button.disabled = false;
          }
        });
      }

      function renderMaintenance(data) {
        const root = document.getElementById("maintenance-content");
        if (!root) return;

        if (!data.configured) {
          root.innerHTML = '<div class="card"><p class="muted">No credentials saved yet. Open <a href="/setup">Setup</a> to connect.</p></div>';
          return;
        }

        if (data.error && !data.system) {
          root.innerHTML = '<div class="card"><p class="message error">' + escapeHtml(data.error) + "</p></div>";
          return;
        }

        if (!data.system) {
          root.innerHTML = '<div class="card"><p class="muted">No system selected.</p></div>';
          return;
        }

        root.innerHTML = renderFilterCard(data.system) + renderCondensateCard(data.condensate);
        bindCondensateActions(() => loadMaintenance(false));
      }

      async function loadMaintenance(force) {
        const button = force ? window.hvacRefreshButton("maintenance-refresh") : null;
        if (button) {
          button.disabled = true;
          button.classList.add("spinning");
        }
        try {
          const suffix = force ? "?refresh=1" : "";
          const res = await fetch("/api/maintenance" + suffix);
          const data = await res.json();
          renderMaintenance(data);
        } catch (error) {
          const root = document.getElementById("maintenance-content");
          if (root) {
            root.innerHTML = '<div class="card"><p class="message error">' + escapeHtml(String(error)) + "</p></div>";
          }
        } finally {
          if (button) {
            button.disabled = false;
            button.classList.remove("spinning");
          }
        }
      }

      document.getElementById("maintenance-refresh")?.addEventListener("click", () => loadMaintenance(true));
      window.addEventListener("hvac:refresh", () => loadMaintenance(true));
      loadMaintenance(false);
      setInterval(() => loadMaintenance(false), 60000);
    </script>
  `;
}
function circulationContent() {
    return `
    <div class="toolbar">
      <h2>Circulation</h2>
      <button type="button" class="tile-refresh" id="circulation-refresh" aria-label="Refresh circulation">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
      </button>
    </div>
    <div id="circulation-content" class="circulation-grid">
      <div class="card"><p class="muted">Loading circulation…</p></div>
    </div>
    <script>
      const FAN_LEVELS = ["auto", "low", "med", "high"];
      const FAN_LABELS = ["Auto", "Low", "Medium", "High"];

      function escapeHtml(value) {
        return String(value)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;");
      }

      function fanToIndex(fan) {
        if (fan === "on") return 1;
        const index = FAN_LEVELS.indexOf(fan || "auto");
        return index >= 0 ? index : 0;
      }

      function fanSpeedToIndex(speed) {
        if (!speed || speed === "off") return 0;
        if (speed === "on") return 1;
        const index = FAN_LEVELS.indexOf(speed);
        return index >= 0 ? index : 0;
      }

      function fanBarsIndex(zone) {
        return fanSpeedToIndex(zone.fan_speed);
      }

      function renderBlowerMetricRow(label, value) {
        return (
          '<span class="blower-metric"><span class="blower-metric-label">' +
          escapeHtml(label) +
          "</span>" +
          escapeHtml(value) +
          "</span>"
        );
      }

      function renderBlowerReadout(zone) {
        const rpm = zone.fan_rpm_display || "Off";
        const cfm = zone.fan_cfm_display || "Off";
        return renderBlowerMetricRow("RPM", rpm) + renderBlowerMetricRow("CFM", cfm);
      }

      function renderFanBars(zone) {
        const barsIndex = fanBarsIndex(zone);
        return [0, 1, 2, 3].map((index) => {
          const lit = barsIndex > 0 && index < (barsIndex === 1 ? 1 : barsIndex === 2 ? 2 : 4);
          const classes = "fan-bar" + (lit ? " active" : "");
          return '<span class="' + classes + '"></span>';
        }).join("");
      }

      function applyFanSettingUi(card, fan) {
        const fanIndex = fanToIndex(fan);
        const label = card.querySelector("[data-fan-label]");
        const slider = card.querySelector('[data-field="fan"]');
        const labelText = FAN_LABELS[fanIndex] || "Auto";
        if (label) label.textContent = labelText;
        if (slider) slider.value = String(fanIndex);
        card.querySelectorAll(".fan-control .fan-ticks span").forEach((tick, index) => {
          tick.classList.toggle("active", index === fanIndex);
        });
      }

      function syncFanBars(card, zone) {
        const barsIndex = fanBarsIndex(zone);
        card.querySelectorAll("[data-fan-bars] .fan-bar").forEach((bar, index) => {
          const lit = barsIndex > 0 && index < (barsIndex === 1 ? 1 : barsIndex === 2 ? 2 : 4);
          bar.classList.toggle("active", lit);
          bar.classList.toggle("auto", false);
        });
      }

      function syncCirculationCard(card, zone) {
        const readout = card.querySelector("[data-fan-readout]");
        if (readout) readout.innerHTML = renderBlowerReadout(zone);
        syncFanBars(card, zone);
        if (card.dataset.fanEditing === "true") return;
        if (card.dataset.fanUpdateInFlight === "true") return;
        if (card.dataset.mutationPending === "true" && card.dataset.lastFan) {
          applyFanSettingUi(card, card.dataset.lastFan);
          return;
        }
        applyFanSettingUi(card, zone.fan || "auto");
      }

      function renderCirculationZone(zone, singleZone) {
        const fanIndex = fanToIndex(zone.fan);
        const fanReadoutHtml = renderBlowerReadout(zone);
        return (
          '<div class="card circulation-zone-card' +
          (singleZone ? " single-zone" : "") +
          '" data-circulation-card data-zone-id="' +
          escapeHtml(zone.id) +
          '">' +
          (singleZone ? "" : "<h3>" + escapeHtml(zone.name) + "</h3>") +
          '<div class="circulation-panel">' +
          '<div class="blower-indicator">' +
          '<div class="blower-readout chip-value" data-fan-readout>' +
          (fanReadoutHtml === "—" ? "—" : fanReadoutHtml) +
          "</div>" +
          '<div class="fan-bars" data-fan-bars>' +
          renderFanBars(zone) +
          "</div>" +
          "</div>" +
          '<div class="fan-control">' +
          '<span class="fan-control-label" data-fan-label>' +
          escapeHtml(FAN_LABELS[fanIndex] || "Auto") +
          "</span>" +
          '<input type="range" min="0" max="3" step="1" value="' +
          fanIndex +
          '" data-field="fan" aria-label="Blower speed" />' +
          '<div class="fan-ticks">' +
          '<span class="' +
          (fanIndex === 0 ? "active" : "") +
          '">Auto</span>' +
          '<span class="' +
          (fanIndex === 1 ? "active" : "") +
          '">Low</span>' +
          '<span class="' +
          (fanIndex === 2 ? "active" : "") +
          '">Med</span>' +
          '<span class="' +
          (fanIndex === 3 ? "active" : "") +
          '">High</span>' +
          "</div>" +
          "</div>" +
          "</div>" +
          '<div class="message" data-circulation-message></div>' +
          "</div>"
        );
      }

      function releaseFanUpdateLock(card) {
        delete card.dataset.fanUpdateInFlight;
        const timer = card.dataset.fanUpdateLockTimer;
        if (timer) {
          window.clearTimeout(Number(timer));
          delete card.dataset.fanUpdateLockTimer;
        }
        const slider = card.querySelector('[data-field="fan"]');
        if (slider) slider.disabled = false;
      }

      async function postFanUpdate(card, fan) {
        const zoneId = card.dataset.zoneId;
        const message = card.querySelector("[data-circulation-message]");
        if (card.dataset.fanUpdateInFlight === "true") {
          card.dataset.fanPending = fan;
          if (message) {
            message.className = "message";
            message.textContent = "Updating blower speed…";
          }
          return false;
        }
        card.dataset.fanUpdateInFlight = "true";
        card.dataset.fanUpdateLockTimer = String(
          window.setTimeout(() => {
            releaseFanUpdateLock(card);
          }, 45_000),
        );
        card.dataset.mutationPending = "true";
        card.dataset.lastFan = fan;
        applyFanSettingUi(card, fan);
        if (message) {
          message.className = "message";
          message.textContent = "Updating blower speed…";
        }
        let ok = false;
        try {
          const res = await fetch("/api/zone/" + encodeURIComponent(zoneId), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fan }),
          });
          const data = await res.json();
          ok = res.ok;
          if (message) {
            message.className = "message " + (res.ok ? "success" : "error");
            message.textContent = res.ok ? "Updated." : (data.error || "Update failed.");
          }
          if (!res.ok) {
            delete card.dataset.mutationPending;
            delete card.dataset.lastFan;
          }
        } catch (error) {
          if (message) {
            message.className = "message error";
            message.textContent = String(error);
          }
          delete card.dataset.mutationPending;
          delete card.dataset.lastFan;
        } finally {
          releaseFanUpdateLock(card);
          const pending = card.dataset.fanPending;
          delete card.dataset.fanPending;
          if (pending) {
            window.setTimeout(() => {
              void postFanUpdate(card, pending);
            }, 0);
          }
        }
        return ok;
      }

      function initFanSlider(card) {
        const slider = card.querySelector('[data-field="fan"]');
        if (!slider || slider.dataset.initialized === "true") return;
        slider.dataset.initialized = "true";
        releaseFanUpdateLock(card);

        const fanFromSlider = () => FAN_LEVELS[Number.parseInt(slider.value, 10)] || "auto";

        slider.addEventListener("input", () => {
          card.dataset.fanEditing = "true";
          const message = card.querySelector("[data-circulation-message]");
          if (message) {
            message.className = "message";
            message.textContent = "";
          }
          applyFanSettingUi(card, fanFromSlider());
        });
        slider.addEventListener("change", async () => {
          const fan = fanFromSlider();
          try {
            applyFanSettingUi(card, fan);
            await postFanUpdate(card, fan);
          } finally {
            delete card.dataset.fanEditing;
          }
        });
        applyFanSettingUi(card, fanFromSlider());
      }

      function bindCirculationCards(root) {
        root.querySelectorAll("[data-circulation-card]").forEach((card) => {
          initFanSlider(card);
        });
      }

      function renderCirculation(data, options = {}) {
        const root = document.getElementById("circulation-content");
        if (!root) return;

        if (window.hvacUpdateMobileHeader) window.hvacUpdateMobileHeader(data);

        if (!data.configured) {
          root.innerHTML = '<div class="card"><p class="muted">No credentials saved yet. Open <a href="/setup">Setup</a> to connect.</p></div>';
          return;
        }

        const singleZone = data.zones?.length === 1;

        if (data.error && !data.zones?.length) {
          root.innerHTML = '<div class="card"><p class="message error">' + escapeHtml(data.error) + "</p></div>";
          return;
        }

        if (!data.zones?.length) {
          root.innerHTML = '<div class="card"><p class="muted">No circulation data available.</p></div>';
          return;
        }

        const existingCards = root.querySelectorAll("[data-circulation-card]").length;
        if (options.soft && existingCards === data.zones.length) {
          for (const zone of data.zones) {
            const card = root.querySelector('[data-circulation-card][data-zone-id="' + CSS.escape(zone.id) + '"]');
            if (!card || card.dataset.fanEditing === "true") continue;
            syncCirculationCard(card, zone);
          }
          return;
        }

        root.innerHTML = data.zones.map((zone) => renderCirculationZone(zone, singleZone)).join("");
        bindCirculationCards(root);
      }

      async function loadCirculation(options = {}) {
        const button = options.refresh ? window.hvacRefreshButton("circulation-refresh") : null;
        if (button) {
          button.disabled = true;
          button.classList.add("spinning");
        }
        try {
          const suffix = options.refresh ? "?refresh=1" : "";
          const res = await fetch("/api/status" + suffix);
          const data = await res.json();
          renderCirculation(data, options);
        } catch (error) {
          const root = document.getElementById("circulation-content");
          if (root) {
            root.innerHTML = '<div class="card"><p class="message error">' + escapeHtml(String(error)) + "</p></div>";
          }
        } finally {
          if (button) {
            button.disabled = false;
            button.classList.remove("spinning");
          }
        }
      }

      document.getElementById("circulation-refresh")?.addEventListener("click", () => loadCirculation({ refresh: true }));
      window.addEventListener("hvac:refresh", () => loadCirculation({ refresh: true }));
      loadCirculation();
      setInterval(() => loadCirculation({ soft: true }), 15000);
    </script>
  `;
}
function activitiesContent() {
    return `
    <div class="toolbar">
      <h2>Activities</h2>
      <button type="button" class="tile-refresh" id="activities-refresh" aria-label="Refresh activities">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
      </button>
    </div>
    <div id="activities-content" class="activities-grid">
      <div class="card"><p class="muted">Loading activities…</p></div>
    </div>
    <script>
      const FAN_OPTIONS = [
        { value: "auto", label: "Auto" },
        { value: "low", label: "Low" },
        { value: "med", label: "Medium" },
        { value: "high", label: "High" },
      ];

      function escapeHtml(value) {
        return String(value)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;");
      }

      function fanSelectOptions(selected) {
        return FAN_OPTIONS.map((option) =>
          '<option value="' + option.value + '"' + (option.value === selected ? " selected" : "") + ">" + option.label + "</option>"
        ).join("");
      }

      function setCardMessage(card, text, kind) {
        const message = card.querySelector(".message");
        if (!message) return;
        message.className = "message" + (kind ? " " + kind : "");
        message.textContent = text || "";
      }

      function renderActivityCard(zone, activity) {
        const badges = [];
        if (activity.is_current && !zone.hold) badges.push('<span class="activity-badge">Running</span>');
        if (activity.is_held) badges.push('<span class="activity-badge hold">On hold</span>');
        else if (activity.is_current && zone.hold) badges.push('<span class="activity-badge">Active</span>');

        return (
          '<article class="activity-card' +
          (activity.is_current ? " current" : "") +
          '" data-activity-card data-zone-id="' +
          escapeHtml(zone.id) +
          '" data-activity-type="' +
          escapeHtml(activity.type) +
          '">' +
          '<div class="activity-card-header">' +
          "<h4>" +
          escapeHtml(activity.label) +
          "</h4>" +
          '<div class="activity-badges">' +
          badges.join("") +
          "</div>" +
          "</div>" +
          '<div class="activity-readout">' +
          "<span>Heat <strong>" +
          escapeHtml(activity.heat_setpoint_display || "—") +
          (activity.heat_setpoint_display ? "°F" : "") +
          "</strong></span>" +
          "<span>Cool <strong>" +
          escapeHtml(activity.cool_setpoint_display || "—") +
          (activity.cool_setpoint_display ? "°F" : "") +
          "</strong></span>" +
          "<span>Fan <strong>" +
          escapeHtml(activity.fan_label || "—") +
          "</strong></span>" +
          "</div>" +
          '<form class="activity-form">' +
          '<div class="activity-form-row">' +
          '<label>Heat to<input type="number" min="60" max="90" step="1" name="heat_setpoint" value="' +
          escapeHtml(activity.heat_setpoint_display || "") +
          '" /></label>' +
          '<label>Cool to<input type="number" min="60" max="90" step="1" name="cool_setpoint" value="' +
          escapeHtml(activity.cool_setpoint_display || "") +
          '" /></label>' +
          '<label>Blower<select name="fan">' +
          fanSelectOptions(activity.fan || "auto") +
          "</select></label>" +
          "</div>" +
          '<div class="activity-form-actions">' +
          '<button type="submit" class="secondary">Save settings</button>' +
          '<button type="button" class="primary" data-use-activity>Use now</button>' +
          "</div>" +
          '<p class="message"></p>' +
          "</form>" +
          "</article>"
        );
      }

      function renderActivitiesZone(zone, singleZone) {
        const statusText = zone.hold
          ? "On hold: <strong>" + escapeHtml(zone.current_activity_label || "Manual") + "</strong>"
          : "Running: <strong>" + escapeHtml(zone.current_activity_label || "—") + "</strong>";
        const resumeButton = zone.hold
          ? '<div class="activities-zone-actions"><button type="button" class="secondary" data-resume-schedule data-zone-id="' +
            escapeHtml(zone.id) +
            '">Back to schedule</button></div>'
          : "";
        const metaHtml = singleZone ? "" : '<p class="activities-zone-meta">' + statusText + "</p>";

        return (
          '<div class="card activities-zone-card' +
          (singleZone ? " single-zone" : "") +
          '" data-zone-card="' +
          escapeHtml(zone.id) +
          '">' +
          (singleZone ? "" : "<h3>" + escapeHtml(zone.name) + "</h3>") +
          metaHtml +
          resumeButton +
          '<div class="activity-cards">' +
          zone.activities.map((activity) => renderActivityCard(zone, activity)).join("") +
          "</div>" +
          "</div>"
        );
      }

      function bindActivityCards(root) {
        root.querySelectorAll("[data-activity-card]").forEach((card) => {
          const form = card.querySelector("form");
          const useButton = card.querySelector("[data-use-activity]");
          const zoneId = card.dataset.zoneId;
          const activityType = card.dataset.activityType;
          if (!form || !zoneId || !activityType) return;

          form.addEventListener("submit", async (event) => {
            event.preventDefault();
            const saveButton = form.querySelector('button[type="submit"]');
            if (!hvacSetButtonPending(saveButton, "Saving…")) return;
            setCardMessage(card, "", "");
            try {
              const payload = {
                activity_type: activityType,
                heat_setpoint: form.heat_setpoint.value,
                cool_setpoint: form.cool_setpoint.value,
                fan: form.fan.value,
              };
              const res = await fetch("/api/zone/" + encodeURIComponent(zoneId), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
              });
              const data = await res.json();
              if (!res.ok) throw new Error(data.error || "Could not save activity.");
              hvacSetButtonSuccess(saveButton, "Saved");
              setCardMessage(card, "Saved.", "success");
              await loadActivities(true);
            } catch (error) {
              hvacSetButtonError(saveButton, "Try again");
              setCardMessage(card, String(error), "error");
            }
          });

          useButton?.addEventListener("click", async () => {
            if (!hvacSetButtonPending(useButton, "Applying…")) return;
            setCardMessage(card, "", "");
            try {
              const res = await fetch("/api/zone/" + encodeURIComponent(zoneId), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ preset: activityType }),
              });
              const data = await res.json();
              if (!res.ok) throw new Error(data.error || "Could not apply activity.");
              hvacSetButtonSuccess(useButton, "Applied");
              setCardMessage(card, "Applied.", "success");
              await loadActivities(true);
            } catch (error) {
              hvacSetButtonError(useButton, "Try again");
              setCardMessage(card, String(error), "error");
            }
          });
        });

        root.querySelectorAll("[data-resume-schedule]").forEach((button) => {
          button.addEventListener("click", async () => {
            const zoneId = button.dataset.zoneId;
            if (!zoneId || !hvacSetButtonPending(button, "Resuming…")) return;
            try {
              const res = await fetch("/api/zone/" + encodeURIComponent(zoneId), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ preset: "resume" }),
              });
              const data = await res.json();
              if (!res.ok) throw new Error(data.error || "Could not resume schedule.");
              hvacSetButtonSuccess(button, "Resumed");
              await loadActivities(true);
            } catch (error) {
              hvacSetButtonError(button, "Try again");
            }
          });
        });
      }

      function renderActivities(data) {
        const root = document.getElementById("activities-content");
        if (!root) return;

        if (!data.configured) {
          root.innerHTML = '<div class="card"><p class="muted">No credentials saved yet. Open <a href="/setup">Setup</a> to connect.</p></div>';
          return;
        }

        const singleZone = data.zones.length === 1;

        if (data.error && !data.zones.length) {
          root.innerHTML = '<div class="card"><p class="message error">' + escapeHtml(data.error) + "</p></div>";
          return;
        }

        if (!data.zones.length) {
          root.innerHTML = '<div class="card"><p class="muted">No activity data available.</p></div>';
          return;
        }

        root.innerHTML = data.zones.map((zone) => renderActivitiesZone(zone, singleZone)).join("");
        bindActivityCards(root);
      }

      async function loadActivities(force) {
        const button = force ? window.hvacRefreshButton("activities-refresh") : null;
        if (button) {
          button.disabled = true;
          button.classList.add("spinning");
        }
        try {
          const suffix = force ? "?refresh=1" : "";
          const res = await fetch("/api/activities" + suffix);
          const data = await res.json();
          renderActivities(data);
        } catch (error) {
          const root = document.getElementById("activities-content");
          if (root) {
            root.innerHTML = '<div class="card"><p class="message error">' + escapeHtml(String(error)) + "</p></div>";
          }
        } finally {
          if (button) {
            button.disabled = false;
            button.classList.remove("spinning");
          }
        }
      }

      document.getElementById("activities-refresh")?.addEventListener("click", () => loadActivities(true));
      window.addEventListener("hvac:refresh", () => loadActivities(true));
      loadActivities(false);
      setInterval(() => loadActivities(false), 60000);
    </script>
  `;
}
function scheduleContent() {
    return `
    <div class="toolbar">
      <h2>Weekly schedule</h2>
      <button type="button" class="tile-refresh" id="schedule-refresh" aria-label="Refresh schedule">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
      </button>
    </div>
    <div id="schedule-content" class="schedule-grid">
      <div class="card"><p class="muted">Loading schedules…</p></div>
    </div>
    <script>
      function escapeHtml(value) {
        return String(value)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;");
      }

      function formatTimeLabel(time) {
        const parts = String(time || "").split(":");
        const hours = Number.parseInt(parts[0], 10);
        const minutes = Number.parseInt(parts[1], 10);
        if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return time || "—";
        const date = new Date();
        date.setHours(hours, minutes, 0, 0);
        return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      }

      function currentPeriodIndex(periods, nowMinutes) {
        let index = -1;
        for (let i = 0; i < periods.length; i += 1) {
          if (periods[i].time_minutes <= nowMinutes) index = i;
        }
        return index;
      }

      function renderSetpoints(period) {
        const heat = period.heat_setpoint_display;
        const cool = period.cool_setpoint_display;
        if (!heat && !cool) return "";
        const parts = [];
        if (heat) parts.push(heat + "° heat");
        if (cool) parts.push(cool + "° cool");
        return '<span class="schedule-period-setpoints">' + escapeHtml(parts.join(" · ")) + "</span>";
      }

      function renderPeriodPill(period, isCurrent) {
        const activityClass = period.activity ? " activity-" + period.activity : "";
        return (
          '<span class="schedule-period-pill' +
          activityClass +
          (isCurrent ? " current" : "") +
          '">' +
          '<span class="schedule-period-time">' +
          escapeHtml(formatTimeLabel(period.time)) +
          "</span>" +
          '<span class="schedule-period-activity">' +
          escapeHtml(period.activity_label) +
          "</span>" +
          renderSetpoints(period) +
          "</span>"
        );
      }

      function renderScheduleZone(zone, singleZone) {
        const now = new Date();
        const todayId = now.getDay();
        const nowMinutes = now.getHours() * 60 + now.getMinutes();
        const statusText = zone.hold
          ? "On hold: <strong>" + escapeHtml(zone.current_activity_label || "Manual") + "</strong>"
          : "Running: <strong>" + escapeHtml(zone.current_activity_label || "—") + "</strong>";

        const rows = (zone.days || [])
          .map((day) => {
            const isToday = day.day_id === todayId;
            const periods = day.periods || [];
            const currentIndex = isToday ? currentPeriodIndex(periods, nowMinutes) : -1;
            const periodHtml = periods.length
              ? '<div class="schedule-periods">' +
                periods
                  .map((period, index) => renderPeriodPill(period, index === currentIndex))
                  .join("") +
                "</div>"
              : '<span class="schedule-empty">No periods</span>';
            return (
              "<tr" +
              (isToday ? ' class="today"' : "") +
              ">" +
              '<td class="schedule-day-name">' +
              escapeHtml(day.day_name) +
              (isToday ? " (today)" : "") +
              "</td>" +
              "<td>" +
              periodHtml +
              "</td>" +
              "</tr>"
            );
          })
          .join("");

        const metaHtml = singleZone
          ? ""
          : '<p class="schedule-zone-meta">' + statusText + "</p>";
        return (
          '<div class="card schedule-zone-card' +
          (singleZone ? " single-zone" : "") +
          '">' +
          (singleZone ? "" : "<h3>" + escapeHtml(zone.name) + "</h3>") +
          metaHtml +
          '<table class="schedule-table"><thead><tr><th>Day</th><th>Program</th></tr></thead><tbody>' +
          rows +
          "</tbody></table>" +
          "</div>"
        );
      }

      function renderSchedule(data) {
        const root = document.getElementById("schedule-content");
        if (!root) return;

        if (!data.configured) {
          root.innerHTML = '<div class="card"><p class="muted">No credentials saved yet. Open <a href="/setup">Setup</a> to connect.</p></div>';
          return;
        }

        const singleZone = data.zones.length === 1;

        if (data.error && !data.zones.length) {
          root.innerHTML = '<div class="card"><p class="message error">' + escapeHtml(data.error) + "</p></div>";
          return;
        }

        if (!data.zones.length) {
          root.innerHTML = '<div class="card"><p class="schedule-empty">No schedule data available.</p></div>';
          return;
        }

        root.innerHTML = data.zones.map((zone) => renderScheduleZone(zone, singleZone)).join("");
      }

      async function loadSchedule(force) {
        const button = force ? window.hvacRefreshButton("schedule-refresh") : null;
        if (button) {
          button.disabled = true;
          button.classList.add("spinning");
        }
        try {
          const suffix = force ? "?refresh=1" : "";
          const res = await fetch("/api/schedule" + suffix);
          const data = await res.json();
          renderSchedule(data);
        } catch (error) {
          const root = document.getElementById("schedule-content");
          if (root) {
            root.innerHTML = '<div class="card"><p class="message error">' + escapeHtml(String(error)) + "</p></div>";
          }
        } finally {
          if (button) {
            button.disabled = false;
            button.classList.remove("spinning");
          }
        }
      }

      document.getElementById("schedule-refresh")?.addEventListener("click", () => loadSchedule(true));
      window.addEventListener("hvac:refresh", () => loadSchedule(true));
      loadSchedule(false);
      setInterval(() => loadSchedule(false), 60000);
    </script>
  `;
}
function renderApiCatalogTable(rows, columns) {
    const header = columns.map((col) => "<th>" + escapeHtml(col.label) + "</th>").join("");
    const body = rows
        .map((row) => {
        const cells = columns
            .map((col) => {
            const value = row[col.key];
            if (col.key === "used") {
                const yes = value === true;
                return ('<td><span class="' +
                    (yes ? "api-used-yes" : "api-used-no") +
                    '">' +
                    (yes ? "Yes" : "No") +
                    "</span></td>");
            }
            return "<td>" + escapeHtml(value == null ? "—" : String(value)) + "</td>";
        })
            .join("");
        return "<tr>" + cells + "</tr>";
    })
        .join("");
    return '<table class="api-table"><thead><tr>' + header + "</tr></thead><tbody>" + body + "</tbody></table>";
}
function apiExplorerContent() {
    const restRows = API_CATALOG.app_rest.map((row) => ({
        method: row.method,
        path: row.path,
        query: ("query" in row ? row.query : undefined) || ("body" in row ? row.body : undefined) || "—",
        description: row.description,
    }));
    const restTable = renderApiCatalogTable(restRows, [
        { key: "method", label: "Method" },
        { key: "path", label: "Path" },
        { key: "query", label: "Query / Body" },
        { key: "description", label: "Description" },
    ]);
    const queryTable = renderApiCatalogTable(API_CATALOG.carrier_graphql_queries, [
        { key: "name", label: "Query" },
        { key: "used", label: "Used" },
        { key: "description", label: "Description" },
    ]);
    const mutationTable = renderApiCatalogTable(API_CATALOG.carrier_graphql_mutations, [
        { key: "name", label: "Mutation" },
        { key: "used", label: "Used" },
        { key: "description", label: "Description" },
    ]);
    const wsTable = renderApiCatalogTable(API_CATALOG.carrier_websocket, [
        { key: "messageType", label: "Message" },
        { key: "used", label: "Used" },
        { key: "description", label: "Description" },
    ]);
    const endpointTable = renderApiCatalogTable(API_CATALOG.carrier_endpoints, [
        { key: "url", label: "URL" },
        { key: "description", label: "Description" },
    ]);
    return `
    <div class="toolbar">
      <div>
        <h2>API Explorer</h2>
        <p class="toolbar-meta">Live responses from every app endpoint and full Carrier cloud payloads.</p>
      </div>
      <button type="button" class="tile-refresh" id="api-refresh-all" aria-label="Refresh all data">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
      </button>
    </div>
    <div class="card">
      <div class="api-toolbar">
        <span class="muted" id="api-fetched-at">Not loaded yet</span>
      </div>
      <p class="muted" style="margin:0">Passwords are never shown. Carrier responses include every field returned by the cloud GraphQL API.</p>
    </div>

    <div class="card api-section">
      <h2>Live app endpoint responses</h2>
      <details class="json-panel" open><summary>GET /api/status</summary><pre id="api-data-status">Loading…</pre></details>
      <details class="json-panel" open><summary>GET /api/settings</summary><pre id="api-data-settings">Loading…</pre></details>
      <details class="json-panel"><summary>GET /health</summary><pre id="api-data-health">Loading…</pre></details>
      <details class="json-panel" open><summary>GET /api/explorer</summary><pre id="api-data-explorer">Loading…</pre></details>
    </div>

    <div class="card api-section">
      <h2>Carrier cloud data</h2>
      <details class="json-panel" open><summary>getUser</summary><pre id="api-data-user">Loading…</pre></details>
      <details class="json-panel" open><summary>getInfinitySystems (all fields)</summary><pre id="api-data-systems">Loading…</pre></details>
      <details class="json-panel" open><summary>getInfinityEnergy (per system)</summary><pre id="api-data-energy">Loading…</pre></details>
    </div>

    <div class="card api-section">
      <h2>App REST API reference</h2>
      ${restTable}
    </div>

    <div class="card api-section">
      <h2>Carrier GraphQL API reference</h2>
      <h3>Queries</h3>
      ${queryTable}
      <h3>Mutations</h3>
      ${mutationTable}
      <h3>Realtime WebSocket messages</h3>
      ${wsTable}
      <h3>Cloud endpoints</h3>
      ${endpointTable}
    </div>

    <script>
      function prettyJson(value) {
        try {
          return JSON.stringify(value, null, 2);
        } catch {
          return String(value);
        }
      }

      async function fetchPanel(url, options) {
        const res = await fetch(url, options);
        const contentType = res.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          const data = await res.json();
          return { ok: res.ok, status: res.status, body: data };
        }
        const text = await res.text();
        return { ok: res.ok, status: res.status, body: text };
      }

      function setPanel(id, payload, isError) {
        const el = document.getElementById(id);
        if (!el) return;
        const panel = el.closest(".json-panel");
        if (panel) panel.classList.toggle("error", Boolean(isError));
        el.textContent = typeof payload === "string" ? payload : prettyJson(payload);
      }

      async function loadApiExplorer(force) {
        const button = force ? window.hvacRefreshButton("api-refresh-all") : null;
        if (button) {
          button.disabled = true;
          button.classList.add("spinning");
        }
        const suffix = force ? "?refresh=1" : "";
        const fetchedAt = document.getElementById("api-fetched-at");
        if (fetchedAt) fetchedAt.textContent = "Loading…";

        const [status, settings, health, explorer] = await Promise.all([
          fetchPanel("/api/status" + suffix),
          fetchPanel("/api/settings"),
          fetchPanel("/health"),
          fetchPanel("/api/explorer" + suffix),
        ]);

        setPanel("api-data-status", { status: status.status, ok: status.ok, body: status.body }, !status.ok);
        setPanel("api-data-settings", { status: settings.status, ok: settings.ok, body: settings.body }, !settings.ok);
        setPanel("api-data-health", health.body, !health.ok);
        setPanel("api-data-explorer", { status: explorer.status, ok: explorer.ok, body: explorer.body }, !explorer.ok);

        const carrier = explorer.ok && explorer.body && explorer.body.carrier ? explorer.body.carrier : null;
        setPanel("api-data-user", carrier ? carrier.getUser : explorer.body?.errors?.getUser || "No data", carrier ? false : true);
        setPanel("api-data-systems", carrier ? carrier.getInfinitySystems : explorer.body?.errors?.getInfinitySystems || "No data", carrier ? false : true);
        setPanel("api-data-energy", carrier ? carrier.getInfinityEnergy : explorer.body?.errors?.getInfinityEnergy || "No data", carrier ? false : true);

        if (fetchedAt) {
          const stamp = explorer.body?.fetched_at || explorer.body?.carrier?.fetched_at || new Date().toISOString();
          fetchedAt.textContent = "Last fetched " + new Date(stamp).toLocaleString();
        }

        if (button) {
          button.disabled = false;
          button.classList.remove("spinning");
        }
      }

      document.getElementById("api-refresh-all")?.addEventListener("click", () => loadApiExplorer(true));
      window.addEventListener("hvac:refresh", () => loadApiExplorer(true));
      loadApiExplorer(false);
    </script>
  `;
}
function settingsContent(settings) {
    return `
    <div class="toolbar">
      <h2>Settings</h2>
      <button type="button" class="tile-refresh" id="settings-refresh" aria-label="Refresh settings">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
      </button>
    </div>
    <div class="card">
      <form id="settings-form">
        <label>
          Thermostat to control
          <select id="system_serial" name="system_serial">
            <option value="">Loading systems…</option>
          </select>
        </label>
        <p class="muted" style="margin:-0.35rem 0 0.85rem;font-size:0.85rem">
          Pick which Carrier/Bryant system this app connects to. Names come from your Carrier account.
        </p>
        <label>
          Dashboard label
          <input id="system_name" name="system_name" value="${escapeHtml(settings.system_name)}" />
        </label>
        <p class="muted" style="margin:-0.35rem 0 0.85rem;font-size:0.85rem">
          Optional nickname shown on the dashboard only. It does not change which thermostat is controlled.
        </p>
        <label>
          Bryant/Carrier username
          <input id="username" name="username" value="${escapeHtml(settings.username)}" autocomplete="username" />
        </label>
        <label>
          Password
          <input id="password" name="password" type="password" autocomplete="current-password" placeholder="Leave blank to keep saved password" />
        </label>
        <button type="submit">Save settings</button>
        <button type="button" class="secondary" id="clear-credentials" style="margin-left:0.5rem">Sign out</button>
        <div class="message" id="settings-message"></div>
      </form>
    </div>
    <script>
      const savedSystemSerial = ${JSON.stringify(settings.system_serial)};

      function escapeHtml(value) {
        return String(value)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;");
      }

      async function loadSystemPicker(force) {
        const select = document.getElementById("system_serial");
        try {
          const res = await fetch("/api/status" + (force ? "?refresh=1" : ""));
          const data = await res.json();
          const systems = data.systems || [];
          if (!systems.length) {
            select.innerHTML = '<option value="">No systems found on this account</option>';
            return;
          }
          select.innerHTML = systems.map((system) => {
            const label = system.name + " · " + system.serial + (system.model ? " · " + system.model : "");
            const selected = system.serial === savedSystemSerial ? " selected" : "";
            return '<option value="' + escapeHtml(system.serial) + '"' + selected + ">" + escapeHtml(label) + "</option>";
          }).join("");
        } catch (error) {
          select.innerHTML = '<option value="">Could not load systems</option>';
        }
      }

      async function refreshSettingsPage() {
        const button = window.hvacRefreshButton("settings-refresh");
        if (!button) return;
        button.disabled = true;
        button.classList.add("spinning");
        try {
          await loadSystemPicker(true);
        } finally {
          button.disabled = false;
          button.classList.remove("spinning");
        }
      }
      document.getElementById("settings-refresh")?.addEventListener("click", () => refreshSettingsPage());
      window.addEventListener("hvac:refresh", () => refreshSettingsPage());
      loadSystemPicker(false);

      document.getElementById("settings-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const message = document.getElementById("settings-message");
        const form = event.target;
        const button = form.querySelector('button[type="submit"]');
        if (!hvacSetButtonPending(button, "Saving…")) return;
        message.className = "message";
        message.textContent = "Updating settings…";
        try {
          const res = await fetch("/api/settings", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              system_name: form.system_name.value.trim(),
              system_serial: form.system_serial.value.trim(),
              username: form.username.value.trim(),
              password: form.password.value,
            }),
          });
          const data = await res.json();
          if (res.ok) {
            hvacSetButtonSuccess(button, "Saved!");
            message.className = "message success";
            message.textContent = "Settings saved. Reloading…";
            window.setTimeout(() => location.reload(), 700);
            return;
          }
          hvacSetButtonError(button, "Try again");
          message.className = "message error";
          message.textContent = data.error || "Could not save settings.";
        } catch (error) {
          hvacSetButtonError(button, "Try again");
          message.className = "message error";
          message.textContent = String(error);
        }
      });
      document.getElementById("clear-credentials").addEventListener("click", async () => {
        const message = document.getElementById("settings-message");
        const button = document.getElementById("clear-credentials");
        if (!hvacSetButtonPending(button, "Signing out…")) return;
        message.className = "message";
        message.textContent = "Clearing saved credentials…";
        try {
          const res = await fetch("/api/settings", {
            method: "DELETE",
          });
          const data = await res.json();
          if (res.ok) {
            hvacSetButtonSuccess(button, "Signed out");
            message.className = "message success";
            message.textContent = "Signed out. Redirecting…";
            window.setTimeout(() => { window.location.href = "/setup"; }, 700);
            return;
          }
          hvacSetButtonError(button, "Try again");
          message.className = "message error";
          message.textContent = data.error || "Could not clear credentials.";
        } catch (error) {
          hvacSetButtonError(button, "Try again");
          message.className = "message error";
          message.textContent = String(error);
        }
      });
    </script>
  `;
}
function findConfigZoneById(system, zoneId) {
    return findConfigZone(system, zoneId);
}
function findManualActivity(system, zoneId) {
    const zone = findConfigZoneById(system, zoneId);
    return zone?.activities.find((activity) => activity.type === "manual");
}
async function handleApi(route, req, res, settings) {
    if (route === "/api/explorer" && req.method === "GET") {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        const forceRefresh = url.searchParams.get("refresh") === "1";
        const snapshot = buildSnapshot(settings);
        const carrier = await refreshExplorerData(settings, forceRefresh);
        sendJson(res, 200, {
            fetched_at: carrier?.fetched_at ?? lastExplorerFetchAt?.toISOString() ?? null,
            configured: isConfigured(settings),
            error: lastError,
            catalog: API_CATALOG,
            app_snapshot: snapshot,
            carrier,
            local_endpoints: {
                status: "GET /api/status",
                schedule: "GET /api/schedule",
                activities: "GET /api/activities",
                maintenance: "GET /api/maintenance",
                settings: "GET /api/settings",
                health: "GET /health",
                mode: "POST /api/mode",
                zone: "POST /api/zone/:zoneId",
            },
        });
        return;
    }
    if (route === "/api/status" && req.method === "GET") {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        const forceRefresh = url.searchParams.get("refresh") === "1";
        const needsRefresh = forceRefresh ||
            !lastSyncAt ||
            Date.now() - lastSyncAt.getTime() > STATUS_CACHE_MS ||
            (!lastLiveUpdateAt && Date.now() - (lastSyncAt?.getTime() ?? 0) > 5_000);
        const snapshot = await refreshCloudData(settings, needsRefresh);
        sendJson(res, 200, {
            ...snapshot,
            settings: publicSettings(settings),
        });
        return;
    }
    if (route === "/api/schedule" && req.method === "GET") {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        const forceRefresh = url.searchParams.get("refresh") === "1";
        const needsRefresh = forceRefresh ||
            !lastSyncAt ||
            Date.now() - lastSyncAt.getTime() > STATUS_CACHE_MS;
        await refreshCloudData(settings, needsRefresh);
        sendJson(res, 200, buildScheduleSnapshot(settings));
        return;
    }
    if (route === "/api/activities" && req.method === "GET") {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        const forceRefresh = url.searchParams.get("refresh") === "1";
        const needsRefresh = forceRefresh ||
            !lastSyncAt ||
            Date.now() - lastSyncAt.getTime() > STATUS_CACHE_MS;
        await refreshCloudData(settings, needsRefresh);
        sendJson(res, 200, buildActivitiesSnapshot(settings));
        return;
    }
    if (route === "/api/maintenance" && req.method === "GET") {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        const forceRefresh = url.searchParams.get("refresh") === "1";
        const needsRefresh = forceRefresh ||
            !lastSyncAt ||
            Date.now() - lastSyncAt.getTime() > STATUS_CACHE_MS;
        await refreshCloudData(settings, needsRefresh);
        sendJson(res, 200, await buildMaintenanceSnapshot(settings));
        return;
    }
    if (route === "/api/maintenance/condensate" && req.method === "POST") {
        if (!isConfigured(settings)) {
            sendJson(res, 400, { error: "Account not configured" });
            return;
        }
        const system = selectSystem(settings, cachedSystems);
        const serial = system?.profile.serial ?? settings.system_serial;
        if (!serial) {
            sendJson(res, 400, { error: "No system selected" });
            return;
        }
        let clearedAt = new Date().toISOString();
        try {
            const bodyText = (await readBody(req)).toString("utf8").trim();
            if (bodyText) {
                const body = JSON.parse(bodyText);
                if (body.cleared_at) {
                    const parsed = new Date(body.cleared_at);
                    if (Number.isNaN(parsed.getTime())) {
                        sendJson(res, 400, { error: "Invalid cleared_at timestamp" });
                        return;
                    }
                    clearedAt = parsed.toISOString();
                }
            }
        }
        catch {
            sendJson(res, 400, { error: "Invalid request body" });
            return;
        }
        const store = await loadMaintenanceStore();
        store.systems[serial] = {
            ...(store.systems[serial] ?? { condensate_cleared_at: null }),
            condensate_cleared_at: clearedAt,
        };
        await saveMaintenanceStore(store);
        sendJson(res, 200, {
            ok: true,
            condensate: buildCondensateView(serial, store),
        });
        return;
    }
    if (route === "/api/settings" && req.method === "GET") {
        sendJson(res, 200, { settings: publicSettings(settings) });
        return;
    }
    if (route === "/api/settings" && req.method === "DELETE") {
        const cleared = { ...DEFAULT_SETTINGS, system_name: settings.system_name };
        resetCloudConnections();
        await saveSettings(cleared);
        cachedSystems = [];
        cachedExplorerBundle = null;
        lastExplorerFetchAt = null;
        lastSyncAt = null;
        lastLiveUpdateAt = null;
        lastError = null;
        sendJson(res, 200, { settings: publicSettings(cleared) });
        return;
    }
    if (route === "/api/settings" && req.method === "PATCH") {
        const body = JSON.parse((await readBody(req)).toString("utf8"));
        const serial = body.system_serial?.trim();
        if (!serial) {
            sendJson(res, 400, { error: "system_serial is required" });
            return;
        }
        if (!isConfigured(settings)) {
            sendJson(res, 400, { error: "Account not configured" });
            return;
        }
        if (!cachedSystems.some((system) => system.profile.serial === serial)) {
            sendJson(res, 400, { error: "Selected thermostat was not found on your Carrier account" });
            return;
        }
        if (settings.system_serial !== serial) {
            settings.system_serial = serial;
            await saveSettings(settings);
            lastLiveUpdateAt = null;
        }
        sendJson(res, 200, { settings: publicSettings(settings) });
        return;
    }
    if (route === "/api/settings" && req.method === "PUT") {
        const body = JSON.parse((await readBody(req)).toString("utf8"));
        const username = body.username?.trim() ?? settings.username;
        const password = body.password?.trim() ? body.password : settings.password;
        if (!username || !password) {
            sendJson(res, 400, { error: "Username and password are required" });
            return;
        }
        const next = {
            system_name: body.system_name?.trim() || settings.system_name || DEFAULT_SETTINGS.system_name,
            username,
            password,
            system_serial: body.system_serial?.trim() ?? settings.system_serial,
        };
        try {
            const client = getClient(next);
            const validation = await client.validate();
            if (!validation.systemCount) {
                sendJson(res, 400, { error: "No HVAC systems found on this Carrier account" });
                return;
            }
            const systems = await client.loadSystems();
            if (next.system_serial && !systems.some((system) => system.profile.serial === next.system_serial)) {
                sendJson(res, 400, { error: "Selected thermostat was not found on your Carrier account" });
                return;
            }
            resetCloudConnections();
            await saveSettings(next);
            cachedSystems = systems;
            lastSyncAt = new Date();
            lastLiveUpdateAt = null;
            lastError = null;
            ensureRealtime(next);
            ensurePolling(next);
            sendJson(res, 200, { settings: publicSettings(next) });
        }
        catch (error) {
            const message = error instanceof carrier_api_1.CarrierAuthError
                ? error.message
                : error instanceof carrier_api_1.CarrierApiError
                    ? error.message
                    : error instanceof Error
                        ? error.message
                        : "Could not validate credentials";
            sendJson(res, 400, { error: message });
        }
        return;
    }
    if (route === "/api/mode" && req.method === "POST") {
        if (!isConfigured(settings)) {
            sendJson(res, 400, { error: "Account not configured" });
            return;
        }
        const body = JSON.parse((await readBody(req)).toString("utf8"));
        const mode = body.mode?.trim().toLowerCase();
        const allowed = ["heat", "cool", "auto", "off", "fanonly"];
        if (!mode || !allowed.includes(mode)) {
            sendJson(res, 400, { error: "mode must be heat, cool, auto, off, or fanonly" });
            return;
        }
        const system = selectSystem(settings, cachedSystems);
        if (!system) {
            sendJson(res, 502, { error: "No system loaded" });
            return;
        }
        try {
            const client = getClient(settings);
            await client.setMode(system.profile.serial, mode);
            await refreshCloudData(settings, true);
            sendJson(res, 200, { ok: true });
        }
        catch (error) {
            sendJson(res, 502, {
                error: error instanceof Error ? error.message : "Mode update failed",
            });
        }
        return;
    }
    const zoneMatch = route.match(/^\/api\/zone\/([^/]+)$/);
    if (zoneMatch && req.method === "POST") {
        if (!isConfigured(settings)) {
            sendJson(res, 400, { error: "Account not configured" });
            return;
        }
        const zoneId = decodeURIComponent(zoneMatch[1]);
        const body = JSON.parse((await readBody(req)).toString("utf8"));
        const system = selectSystem(settings, cachedSystems);
        if (!system) {
            sendJson(res, 502, { error: "No system loaded" });
            return;
        }
        const client = getClient(settings);
        const serial = system.profile.serial;
        const statusZone = findStatusZone(system, zoneId);
        try {
            const heat = body.heat_setpoint !== undefined && body.heat_setpoint !== "" ? String(body.heat_setpoint) : null;
            const cool = body.cool_setpoint !== undefined && body.cool_setpoint !== "" ? String(body.cool_setpoint) : null;
            const fan = body.fan?.trim().toLowerCase();
            const activityType = body.activity_type?.trim().toLowerCase() ?? null;
            if (body.preset) {
                const preset = body.preset.toLowerCase();
                if (preset === "resume" || preset === "schedule") {
                    await client.resumeSchedule(serial, zoneId);
                }
                else if (["home", "away", "sleep", "wake", "manual", "vacation"].includes(preset)) {
                    await client.setHold(serial, zoneId, preset, null);
                }
            }
            if (activityType &&
                ["home", "away", "sleep", "wake", "manual", "vacation"].includes(activityType)) {
                const configZone = findConfigZoneById(system, zoneId);
                const existing = configZone?.activities.find((item) => item.type === activityType);
                const heatSetpoint = formatCarrierSetpoint(heat ?? existing?.htsp ?? statusZone?.htsp, 68);
                const coolSetpoint = formatCarrierSetpoint(cool ?? existing?.clsp ?? statusZone?.clsp, 74);
                let fanMode;
                if (fan === "auto" || fan === "on") {
                    fanMode = "off";
                }
                else if (fan && ["low", "med", "high", "off"].includes(fan)) {
                    fanMode = fan;
                }
                else if (existing?.fan) {
                    fanMode = existing.fan;
                }
                await client.updateZoneActivity(serial, zoneId, activityType, heatSetpoint, coolSetpoint, fanMode);
                await refreshCloudData(settings, true);
                const activityZone = buildActivitiesSnapshot(settings).zones.find((item) => (0, carrier_api_1.zoneIdsMatch)(item.id, zoneId)) ?? null;
                sendJson(res, 200, { ok: true, zone: activityZone });
                return;
            }
            if (heat || cool) {
                const manual = findManualActivity(system, zoneId);
                const heatSetpoint = formatCarrierSetpoint(heat ?? manual?.htsp ?? statusZone?.htsp, 68);
                const coolSetpoint = formatCarrierSetpoint(cool ?? manual?.clsp ?? statusZone?.clsp, 74);
                let fanMode;
                if (fan === "auto" || fan === "on") {
                    fanMode = "off";
                }
                else if (fan && ["low", "med", "high", "off"].includes(fan)) {
                    fanMode = fan;
                }
                else if (manual?.fan) {
                    fanMode = manual.fan;
                }
                await client.setManualActivity(serial, zoneId, heatSetpoint, coolSetpoint, fanMode);
                await client.setHold(serial, zoneId, "manual", null);
                const zone = await waitForCloudZoneSetpoints(settings, zoneId, heat, cool);
                if (!zone) {
                    sendJson(res, 502, {
                        error: "Setpoint change did not reach the thermostat yet. Wait a few seconds and refresh.",
                    });
                    return;
                }
                sendJson(res, 200, { ok: true, zone });
                return;
            }
            else if (fan) {
                await refreshCloudData(settings, true);
                const beforeZone = buildSnapshot(settings).zones.find((item) => (0, carrier_api_1.zoneIdsMatch)(item.id, zoneId)) ?? null;
                const beforeFan = beforeZone?.fan ?? null;
                const freshSystem = selectSystem(settings, cachedSystems);
                const freshStatus = findStatusZone(freshSystem ?? system, zoneId);
                const configZone = findConfigZoneById(freshSystem ?? system, zoneId);
                const manual = findManualActivity(freshSystem ?? system, zoneId);
                const setpoints = resolveZoneSetpoints(freshStatus, configZone);
                const fanMode = fan === "auto" ? "off" : fan;
                const heatSetpoint = formatCarrierSetpoint(freshStatus?.htsp ?? setpoints.heat ?? manual?.htsp, 68);
                const coolSetpoint = formatCarrierSetpoint(freshStatus?.clsp ?? setpoints.cool ?? manual?.clsp, 74);
                const onManualHold = configZone?.hold === "on" &&
                    (configZone?.holdActivity === "manual" || freshStatus?.currentActivity === "manual");
                if (onManualHold) {
                    await client.updateFan(serial, zoneId, "manual", fanMode);
                }
                else {
                    await client.setManualActivity(serial, zoneId, heatSetpoint, coolSetpoint, fanMode);
                    await sleep(400);
                    await client.setHold(serial, zoneId, "manual", null);
                }
                const zone = await waitForCloudZoneFan(settings, zoneId, fan, beforeFan);
                if (!zone) {
                    sendJson(res, 502, {
                        error: "Blower speed change did not reach the thermostat yet. Wait a few seconds and refresh.",
                    });
                    return;
                }
                sendJson(res, 200, { ok: true, zone });
                return;
            }
            sendJson(res, 200, { ok: true });
        }
        catch (error) {
            sendJson(res, 502, {
                error: error instanceof Error ? error.message : "Zone update failed",
            });
        }
        return;
    }
    sendJson(res, 404, { error: "Not found" });
}
async function handleRequest(req, res) {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const route = url.pathname;
    const settings = await loadSettings();
    ensurePolling(settings);
    if (route === "/health" || route === "/healthz") {
        sendText(res, 200, "text/plain; charset=utf-8", "ok");
        return;
    }
    if (route === "/icon.svg") {
        try {
            const icon = await (0, promises_1.readFile)(ICON_PATH);
            res.writeHead(200, { "Content-Type": "image/svg+xml", "Content-Length": icon.length });
            res.end(icon);
            return;
        }
        catch {
            sendText(res, 404, "text/plain; charset=utf-8", "not found");
            return;
        }
    }
    if (route.startsWith("/api/")) {
        try {
            await handleApi(route, req, res, settings);
        }
        catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
    }
    const publicView = publicSettings(settings);
    if (route === "/setup") {
        sendText(res, 200, "text/html; charset=utf-8", renderPage("setup", setupContent(publicView)));
        return;
    }
    if (route === "/settings") {
        sendText(res, 200, "text/html; charset=utf-8", renderPage("settings", settingsContent(publicView)));
        return;
    }
    if (route === "/mode") {
        sendText(res, 200, "text/html; charset=utf-8", renderPage("mode", modeContent()));
        return;
    }
    if (route === "/weather") {
        sendText(res, 200, "text/html; charset=utf-8", renderPage("weather", weatherContent()));
        return;
    }
    if (route === "/schedule") {
        sendText(res, 200, "text/html; charset=utf-8", renderPage("schedule", scheduleContent()));
        return;
    }
    if (route === "/circulation") {
        sendText(res, 200, "text/html; charset=utf-8", renderPage("circulation", circulationContent()));
        return;
    }
    if (route === "/activities") {
        sendText(res, 200, "text/html; charset=utf-8", renderPage("activities", activitiesContent()));
        return;
    }
    if (route === "/maintenance") {
        sendText(res, 200, "text/html; charset=utf-8", renderPage("maintenance", maintenanceContent()));
        return;
    }
    if (route === "/api") {
        sendText(res, 200, "text/html; charset=utf-8", renderPage("api", apiExplorerContent()));
        return;
    }
    sendText(res, 200, "text/html; charset=utf-8", renderPage("dashboard", dashboardContent()));
}
const port = Number(process.env.PORT ?? 3000);
(0, node_http_1.createServer)((req, res) => {
    handleRequest(req, res).catch((error) => {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
}).listen(port, "0.0.0.0", () => {
    const mode = IS_LOCAL_DEV ? "LOCAL DEV" : "production";
    console.log(`Bryant/Carrier HVAC v${APP_VERSION} [${mode}] listening on http://localhost:${port}`);
    if (IS_LOCAL_DEV) {
        console.log(`  data dir: ${DATA_ROOT}`);
    }
    void loadSettings().then((settings) => {
        ensurePolling(settings);
        if (isConfigured(settings)) {
            void refreshCloudData(settings, true);
        }
    });
});
