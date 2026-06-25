import { execFile } from "node:child_process";
import { createSocket } from "node:dgram";
import { createConnection } from "node:net";
import { promisify } from "node:util";
import dorita980 from "dorita980";

const execFileAsync = promisify(execFile);
const CONNECT_TIMEOUT_MS = 15_000;
const ROBOT_READ_TIMEOUT_MS = 10_000;
const ROBOT_PMAPS_TIMEOUT_MS = 15_000;
const ROBOT_OPERATION_TIMEOUT_MS = 35_000;
const ROBOT_DISCONNECT_TIMEOUT_MS = 4_000;
const MQTT_PORT = 8883;
const DISCOVERY_PORT = 5678;
const DISCOVERY_MESSAGE = Buffer.from("irobotmcs");
const DISCOVERY_TIMEOUT_MS = 4_000;
const SUBNET_SCAN_TIMEOUT_MS = 10_000;

export type ConnectionMode = "on_demand" | "live";

export type RobotSettings = {
  robot_ip: string;
  blid: string;
  password: string;
  robot_name: string;
  firmware_version: string;
  connection_mode: ConnectionMode;
  live_poll_seconds: number;
  irobot_username: string;
  irobot_password: string;
};

export type DiscoveryRobot = {
  ip: string;
  robotname: string;
  hostname: string;
  sw: string;
  sku: string;
  blid?: string;
};

export type RoombaFavorite = {
  id: string;
  name: string;
  pmap_id: string | null;
  user_pmapv_id: string | null;
  ordered: boolean;
  region_count: number;
  regions_summary: string;
  runnable: boolean;
};

const PHASE_LABELS: Record<string, string> = {
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

const CYCLE_LABELS: Record<string, string> = {
  clean: "Whole-home clean",
  spot: "Spot clean",
  quick: "Quick clean",
  mop: "Mop",
  train: "Mapping run",
  manual: "Manual clean",
};

const JOB_WHEN_IDLE: Record<string, string> = {
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

const SCHEDULE_CYCLE_LABELS: Record<string, string> = {
  none: "Off",
  start: "Scheduled clean",
  clean: "Scheduled clean",
};

export function formatPhaseLabel(phase: string | null | undefined): string {
  const key = (phase ?? "").trim();
  if (!key) return PHASE_LABELS[""];
  return PHASE_LABELS[key] ?? key.replace(/([a-z])([A-Z])/g, "$1 $2");
}

export function formatJobLabel(
  phase: string | null | undefined,
  cycle: string | null | undefined,
): string {
  const cycleKey = (cycle ?? "").trim() || "none";
  const phaseKey = (phase ?? "").trim();

  if (cycleKey !== "none") {
    const base =
      CYCLE_LABELS[cycleKey] ?? cycleKey.charAt(0).toUpperCase() + cycleKey.slice(1).replace(/([a-z])([A-Z])/g, "$1 $2");
    if (phaseKey === "pause") return `${base} — paused`;
    if (phaseKey === "stop") return `${base} — stopped`;
    if (phaseKey === "stuck") return `${base} — stuck`;
    if (["hmPostMsn", "hmMidMsn", "hmUsrDock", "dock"].includes(phaseKey)) {
      return `${base} — heading home`;
    }
    if (phaseKey === "evac") return `${base} — emptying bin`;
    if (phaseKey === "recharge") return `${base} — recharging`;
    return base;
  }

  return JOB_WHEN_IDLE[phaseKey] ?? JOB_WHEN_IDLE[""];
}

/** @deprecated Use formatJobLabel(phase, cycle) for dashboard job text. */
export function formatCycleLabel(cycle: string | null | undefined): string {
  return formatJobLabel(null, cycle);
}

export function formatScheduleCycleLabel(cycle: string | null | undefined): string {
  const key = (cycle ?? "").trim() || "none";
  return SCHEDULE_CYCLE_LABELS[key] ?? formatJobLabel(null, key === "none" ? "none" : key);
}

export function formatMissionStatus(
  phase: string | null | undefined,
  cycle: string | null | undefined,
): string {
  const jobLabel = formatJobLabel(phase, cycle);
  const phaseLabel = formatPhaseLabel(phase);
  const cycleKey = (cycle ?? "").trim() || "none";
  if (cycleKey === "none") return `${jobLabel} — ${phaseLabel}`;
  return `${jobLabel} — ${phaseLabel}`;
}

export type RobotStatus = {
  connected: boolean;
  configured: boolean;
  error: string | null;
  robot_name: string;
  robot_ip: string;
  firmware_version: string | null;
  battery_percent: number | null;
  phase: string | null;
  cycle: string | null;
  phase_label: string | null;
  cycle_label: string | null;
  status_label: string | null;
  bin_full: boolean | null;
  bin_present: boolean | null;
  docked: boolean | null;
  sqft: number | null;
  mission_minutes: number | null;
  last_command: string | null;
  software_version: string | null;
  sku: string | null;
  favorites: RoombaFavorite[];
  favorites_error: string | null;
  last_sync: string;
};

export type RoombaDeviceDiagnostics = {
  connected: boolean;
  battery_percent: number | null;
  phase: string | null;
  cycle: string | null;
  phase_label: string | null;
  cycle_label: string | null;
  status_label: string | null;
  bin_full: boolean | null;
  bin_present: boolean | null;
  software_version: string | null;
  sku: string | null;
  last_sync: string | null;
  wireless: {
    wifi: number | null;
    cloud: number | null;
    cloud_status: string;
    ssid: string | null;
  } | null;
  cloud_env: string | null;
  error: string | null;
};

export type RoombaDiagnostics = {
  configured: boolean;
  host: string;
  name: string;
  firmware_protocol: string;
  mqtt: {
    host: string;
    port: number;
    reachable: boolean;
    latency_ms: number | null;
  };
  device: RoombaDeviceDiagnostics | null;
  errors: string[];
};

export type IrobotCloudRobot = {
  blid: string;
  name: string;
  sku: string;
  software_version: string;
  password_matches_saved: boolean | null;
};

export type IrobotDiagnostics = {
  account_configured: boolean;
  username_preview: string | null;
  endpoints: {
    discovery_url: string;
    discovery_reachable: boolean;
    discovery_latency_ms: number | null;
    discovery_status: number | null;
    gigya_base: string | null;
    http_base: string | null;
  };
  account: {
    authenticated: boolean;
    robot_count: number | null;
  };
  matched_robot: IrobotCloudRobot | null;
  robots: IrobotCloudRobot[];
  errors: string[];
};

const IROBOT_DISCOVERY_URL =
  process.env.IROBOT_DISCOVERY_URL ??
  `https://disc-prod.iot.irobotapi.com/v1/discover/endpoints?country_code=${process.env.IROBOT_COUNTRY_CODE ?? "US"}`;
const IROBOT_APP_ID = "ANDROID-C7FB240E-DF34-42D7-AE4E-A8C17079A294";
const HTTP_PROBE_TIMEOUT_MS = 10_000;

type DoritaLocal = InstanceType<typeof dorita980.Local>;

let mutexBusy = false;
const mutexQueue: Array<() => void> = [];
let discoveryBusy = false;
const discoveryQueue: Array<() => void> = [];
let lastError: string | null = null;

function setLastError(message: string | null): void {
  lastError = message;
}

export function getLastError(): string | null {
  return lastError;
}

export function isMutexBusy(): boolean {
  return mutexBusy;
}

export function isDiscoveryBusy(): boolean {
  return discoveryBusy;
}

async function acquireMutex(): Promise<void> {
  if (!mutexBusy) {
    mutexBusy = true;
    return;
  }
  await new Promise<void>((resolve) => {
    mutexQueue.push(resolve);
  });
}

function releaseMutex(): void {
  const next = mutexQueue.shift();
  if (next) {
    next();
    return;
  }
  mutexBusy = false;
}

async function acquireDiscoveryMutex(): Promise<void> {
  if (!discoveryBusy) {
    discoveryBusy = true;
    return;
  }
  await new Promise<void>((resolve) => {
    discoveryQueue.push(resolve);
  });
}

function releaseDiscoveryMutex(): void {
  const next = discoveryQueue.shift();
  if (next) {
    next();
    return;
  }
  discoveryBusy = false;
}

function isRoombaDiscoveryHost(hostname: string): boolean {
  const prefix = hostname.split("-")[0];
  return prefix === "Roomba" || prefix === "iRobot";
}

function parseDiscoveryRobot(parsed: Record<string, unknown>): DiscoveryRobot | null {
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

function isConfigured(settings: RobotSettings): boolean {
  return Boolean(settings.robot_ip.trim() && settings.blid.trim() && settings.password.trim());
}

function isValidIpv4(value: string): boolean {
  const parts = value.trim().split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    const octet = Number(part);
    return Number.isInteger(octet) && octet >= 0 && octet <= 255;
  });
}

function localProtocolVersion(firmwareVersion: string): number {
  return firmwareVersion.trim() === "1" ? 1 : 2;
}

function createRobotClient(settings: RobotSettings): DoritaLocal {
  return new dorita980.Local(
    settings.blid.trim(),
    settings.password.trim(),
    settings.robot_ip.trim(),
    localProtocolVersion(settings.firmware_version),
    {
      connectTimeout: CONNECT_TIMEOUT_MS,
      reconnectPeriod: 0,
    },
  );
}

function mqttBusyHint(): string {
  return " Close the iRobot mobile app and wait a few seconds, then try again.";
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
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

function isRobotConnected(robot: DoritaLocal): boolean {
  return Boolean((robot as { connected?: boolean }).connected);
}

function waitForConnect(robot: DoritaLocal): Promise<void> {
  if (isRobotConnected(robot)) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      robot.removeListener("connect", onConnect);
      robot.removeListener("error", onError);
      if (error) reject(error);
      else resolve();
    };

    const timeout = setTimeout(() => {
      void endRobot(robot);
      finish(new Error(`Timed out connecting to the robot over local MQTT.${mqttBusyHint()}`));
    }, CONNECT_TIMEOUT_MS);

    const onConnect = () => finish();
    const onError = (error: Error) => finish(error);

    robot.once("connect", onConnect);
    robot.once("error", onError);
  });
}

async function endRobot(robot: DoritaLocal): Promise<void> {
  await withTimeout(
    new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      try {
        robot.end(true, finish);
      } catch {
        finish();
        return;
      }

      setTimeout(finish, ROBOT_DISCONNECT_TIMEOUT_MS);
    }),
    ROBOT_DISCONNECT_TIMEOUT_MS + 1_000,
    "Robot disconnect",
  ).catch(() => {});
}

export async function withRobot<T>(
  settings: RobotSettings,
  fn: (robot: DoritaLocal) => Promise<T>,
): Promise<T> {
  if (!isConfigured(settings)) {
    throw new Error("Robot is not configured yet");
  }

  await acquireMutex();
  try {
    const result = await withTimeout(
      withRobotSession(settings, fn),
      ROBOT_OPERATION_TIMEOUT_MS,
      "Robot operation",
    );
    setLastError(null);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setLastError(message);
    throw error;
  } finally {
    releaseMutex();
  }
}

async function withRobotSession<T>(
  settings: RobotSettings,
  fn: (robot: DoritaLocal) => Promise<T>,
): Promise<T> {
  const robot = createRobotClient(settings);

  try {
    await waitForConnect(robot);
    return await fn(robot);
  } finally {
    await endRobot(robot);
  }
}

function normalizeSubnetPrefix(value: string): string {
  return value.replace(/\/24$/i, "").replace(/\.\d+$/, "").trim();
}

function getScanSubnets(robotIpHint = ""): string[] {
  const fromEnv = (process.env.ROOMBA_SCAN_SUBNETS ?? "")
    .split(",")
    .map((value) => normalizeSubnetPrefix(value.trim()))
    .filter(Boolean);
  if (fromEnv.length) return fromEnv;

  const hint = robotIpHint.trim() || process.env.ROOMBA_IP?.trim() || "";
  if (hint) {
    const parts = hint.split(".");
    if (parts.length === 4) return [`${parts[0]}.${parts[1]}.${parts[2]}`];
  }

  return [];
}

function collectDiscoveryResponses(durationMs: number, targetIps: string[]): Promise<DiscoveryRobot[]> {
  return new Promise((resolve, reject) => {
    const robots: DiscoveryRobot[] = [];
    const seenIps = new Set<string>();
    const server = createSocket({ type: "udp4", reuseAddr: true });
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      server.removeAllListeners();
      try {
        server.close();
      } catch {
        // ignore close errors
      }
      if (error) reject(error);
      else resolve(robots);
    };

    const timeout = setTimeout(() => finish(), durationMs);

    server.on("error", (error) => finish(error));

    server.on("message", (message) => {
      try {
        const parsed = JSON.parse(message.toString()) as Record<string, unknown>;
        const robot = parseDiscoveryRobot(parsed);
        if (!robot || seenIps.has(robot.ip)) return;
        seenIps.add(robot.ip);
        robots.push(robot);
      } catch {
        // ignore malformed discovery payloads
      }
    });

    server.bind(DISCOVERY_PORT, () => {
      for (const ip of targetIps) {
        if (ip === "255.255.255.255") {
          server.setBroadcast(true);
        }
        server.send(DISCOVERY_MESSAGE, DISCOVERY_PORT, ip, () => {});
      }
    });
  });
}

export async function discoverRobots(robotIpHint = ""): Promise<DiscoveryRobot[]> {
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setLastError(message);
    throw error;
  } finally {
    releaseDiscoveryMutex();
  }
}

async function readRobotState(robot: DoritaLocal): Promise<Record<string, unknown>> {
  return withTimeout(
    robot.getRobotState(["batPct", "cleanMissionStatus", "bin"]),
    ROBOT_READ_TIMEOUT_MS,
    "Robot status",
  );
}

const COMMAND_SETTLE_MS = 2_500;

export type RobotActionResult = {
  ok: true;
  phase: string | null;
  cycle: string | null;
  phase_label: string | null;
  cycle_label: string | null;
  status_label: string | null;
};

async function readMissionSnapshot(robot: DoritaLocal): Promise<{
  mission: Record<string, unknown>;
  bin: Record<string, unknown>;
  batPct: number | null;
}> {
  const state = await readRobotState(robot);
  return {
    mission: (state.cleanMissionStatus ?? {}) as Record<string, unknown>,
    bin: (state.bin ?? {}) as Record<string, unknown>,
    batPct: typeof state.batPct === "number" ? state.batPct : null,
  };
}

function missionIsActive(mission: Record<string, unknown>): boolean {
  const phase = String(mission.phase ?? "");
  const cycle = String(mission.cycle ?? "");
  if (cycle !== "none") return true;
  return ["run", "resume", "spot"].includes(phase);
}

function formatMissionState(mission: Record<string, unknown>): {
  phase: string | null;
  cycle: string | null;
  phase_label: string | null;
  cycle_label: string | null;
  status_label: string | null;
} {
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

function buildMissionFailureMessage(
  mission: Record<string, unknown>,
  bin: Record<string, unknown>,
  batPct: number | null,
  actionLabel: string,
): string {
  const phase = typeof mission.phase === "string" ? mission.phase : null;
  const cycle = typeof mission.cycle === "string" ? mission.cycle : null;
  const status = formatMissionStatus(phase, cycle);
  const hints: string[] = [];
  if (bin.full === true) hints.push("bin is full");
  if (batPct !== null && batPct < 15) hints.push("battery is low");
  if (typeof mission.error === "number" && mission.error > 0) hints.push(`robot error code ${mission.error}`);
  if (typeof mission.notReady === "number" && mission.notReady > 0) {
    hints.push(`robot not ready (code ${mission.notReady})`);
  }
  const hintText = hints.length ? ` ${hints.join(", ")}.` : "";
  return `${actionLabel} was sent, but the robot did not start (${status}).${hintText} Close the iRobot app and try again.`;
}

async function waitForMissionChange(
  robot: DoritaLocal,
  previous: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let latest = previous;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const snapshot = await readMissionSnapshot(robot);
    latest = snapshot.mission;
    if (missionIsActive(latest)) return latest;
    if (String(latest.phase ?? "") !== String(previous.phase ?? "")) return latest;
    if (String(latest.cycle ?? "") !== String(previous.cycle ?? "")) return latest;
  }
  return latest;
}

async function sendStartClean(robot: DoritaLocal): Promise<RobotActionResult> {
  const before = await readMissionSnapshot(robot);
  if (missionIsActive(before.mission)) {
    return { ok: true, ...formatMissionState(before.mission) };
  }

  const phase = String(before.mission.phase ?? "");
  if (phase === "pause") {
    await robot.resume();
  } else {
    await robot.start();
  }

  await new Promise((resolve) => setTimeout(resolve, COMMAND_SETTLE_MS));
  const after = await waitForMissionChange(robot, before.mission, 8_000);
  if (!missionIsActive(after)) {
    throw new Error(buildMissionFailureMessage(after, before.bin, before.batPct, "Start clean"));
  }
  return { ok: true, ...formatMissionState(after) };
}

async function sendDock(robot: DoritaLocal): Promise<RobotActionResult> {
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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function favoriteDisplayName(favorite: Record<string, unknown>, index: number): string {
  const name = favorite.name ?? favorite.favorite_name ?? favorite.label ?? favorite.display_name;
  if (typeof name === "string" && name.trim()) return name.trim();
  return `Favorite ${index + 1}`;
}

function favoriteIdentifier(favorite: Record<string, unknown>, index: number): string {
  const id = favorite.favorite_id ?? favorite.id ?? favorite.fav_id;
  if (typeof id === "string" || typeof id === "number") return String(id);
  return String(index);
}

function normalizeFavoriteRegions(
  regions: unknown,
): Array<{ region_id: string; region_name: string; region_type: string; type: string }> {
  if (!Array.isArray(regions)) return [];
  return regions
    .map((region) => asRecord(region))
    .filter((region): region is Record<string, unknown> => region !== null)
    .map((region) => ({
      region_id: String(region.region_id ?? region.id ?? ""),
      region_name: String(region.region_name ?? region.name ?? ""),
      region_type: String(region.region_type ?? "rid"),
      type: String(region.type ?? "rid"),
    }))
    .filter((region) => region.region_id);
}

function summarizeRegions(
  regions: Array<{ region_id: string; region_name: string; region_type: string; type: string }>,
): string {
  if (!regions.length) return "";
  const labels = regions.map((region) => region.region_name || region.region_id);
  return labels.join(", ");
}

function extractFavoritesFromPmapEntry(
  entry: Record<string, unknown>,
  fallbackPmapId = "",
): RoombaFavorite[] {
  const pmapId = String(entry.pmap_id ?? fallbackPmapId ?? "").trim();
  const activeDetails = asRecord(entry.active_pmapv_details);
  const activePmapv = activeDetails ? asRecord(activeDetails.active_pmapv) : null;
  const defaultPmapVersion = String(
    entry.user_pmapv_id ?? entry.active_pmapv_id ?? activePmapv?.user_pmapv_id ?? "",
  ).trim();
  const favoriteLists = [entry.smart_clean_favs, entry.smartCleanFavs, entry.favorites, entry.favs];

  for (const list of favoriteLists) {
    if (!Array.isArray(list)) continue;

    return list
      .map((item, index) => {
        const favorite = asRecord(item);
        if (!favorite) return null;

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
        } satisfies RoombaFavorite;
      })
      .filter((favorite): favorite is RoombaFavorite => favorite !== null);
  }

  return [];
}

export function parseFavoritesFromPmaps(pmaps: unknown): RoombaFavorite[] {
  const favorites: RoombaFavorite[] = [];
  const seen = new Set<string>();

  const addFavorites = (items: RoombaFavorite[]) => {
    for (const favorite of items) {
      const key = `${favorite.id}:${favorite.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      favorites.push(favorite);
    }
  };

  if (Array.isArray(pmaps)) {
    for (const item of pmaps) {
      const entry = asRecord(item);
      if (!entry) continue;
      addFavorites(extractFavoritesFromPmapEntry(entry));
    }
    return favorites;
  }

  const root = asRecord(pmaps);
  if (!root) return favorites;

  if (root.smart_clean_favs || root.smartCleanFavs || root.favorites || root.favs) {
    addFavorites(extractFavoritesFromPmapEntry(root));
    return favorites;
  }

  for (const [pmapId, value] of Object.entries(root)) {
    const entry = asRecord(value);
    if (!entry) continue;
    addFavorites(extractFavoritesFromPmapEntry(entry, pmapId));
  }

  return favorites;
}

function buildFavoriteCommand(
  favorite: RoombaFavorite,
  regions: Array<{ region_id: string; region_name: string; region_type: string; type: string }>,
): Record<string, unknown> {
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

async function readFavoriteCommand(
  robot: DoritaLocal,
  favoriteId: string,
): Promise<Record<string, unknown>> {
  const snapshot = await withTimeout(
    robot.getRobotState(["pmaps"]),
    ROBOT_PMAPS_TIMEOUT_MS,
    "Robot favorites",
  );
  const favorites = parseFavoritesFromPmaps(snapshot.pmaps);
  const favorite = favorites.find((entry) => entry.id === favoriteId);
  if (!favorite?.runnable || !favorite.pmap_id) {
    throw new Error("Favorite not found on the robot");
  }

  const pmapState = asRecord(snapshot.pmaps);
  let regions: Array<{ region_id: string; region_name: string; region_type: string; type: string }> =
    [];

  const pmapLists = Array.isArray(snapshot.pmaps)
    ? snapshot.pmaps.map((item) => asRecord(item)).filter((item): item is Record<string, unknown> => item !== null)
    : pmapState
      ? [pmapState]
      : [];

  for (const entry of pmapLists) {
    if (String(entry.pmap_id ?? "") !== favorite.pmap_id) continue;
    const favoriteLists = [entry.smart_clean_favs, entry.smartCleanFavs, entry.favorites, entry.favs];
    for (const list of favoriteLists) {
      if (!Array.isArray(list)) continue;
      for (const [index, item] of list.entries()) {
        const record = asRecord(item);
        if (!record || favoriteIdentifier(record, index) !== favorite.id) continue;
        regions = normalizeFavoriteRegions(record.regions);
        break;
      }
      if (regions.length) break;
    }
    if (regions.length) break;
  }

  if (!regions.length) {
    throw new Error("Favorite has no rooms configured");
  }

  return buildFavoriteCommand(favorite, regions);
}

async function readOptionalRobotValue<T>(
  label: string,
  timeoutMs: number,
  read: () => Promise<T>,
): Promise<T | null> {
  try {
    return await withTimeout(read(), timeoutMs, label);
  } catch {
    return null;
  }
}

export async function fetchCredentialsFromCloud(
  username: string,
  password: string,
): Promise<{ robots: Array<RobotSettings & { sku: string; software_version: string }> }> {
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
      connection_mode: "on_demand" as const,
      live_poll_seconds: 0,
      irobot_username: "",
      irobot_password: "",
      sku: skuMatch?.[1]?.trim() ?? "",
      software_version: software,
    };
  });

  return { robots };
}

export async function testConnection(settings: RobotSettings): Promise<RobotStatus> {
  return getRobotStatus(settings);
}

export async function getRobotStatus(settings: RobotSettings): Promise<RobotStatus> {
  const base: RobotStatus = {
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
    bin_full: null,
    bin_present: null,
    docked: null,
    sqft: null,
    mission_minutes: null,
    last_command: null,
    software_version: null,
    sku: null,
    favorites: [],
    favorites_error: null,
    last_sync: new Date().toISOString(),
  };

  if (!base.configured) {
    base.error = "Robot is not configured yet";
    return base;
  }

  try {
    const snapshot = await withRobot(settings, async (robot) => {
      const state = await readRobotState(robot);
      const pmapState = await readOptionalRobotValue("Robot favorites", ROBOT_PMAPS_TIMEOUT_MS, () =>
        robot.getRobotState(["pmaps"]),
      );
      return { state, pmapState };
    });

    const state = snapshot.state;
    const mission = (state.cleanMissionStatus ?? {}) as Record<string, unknown>;
    const bin = (state.bin ?? {}) as Record<string, unknown>;
    const lastCommand = (state.lastCommand ?? {}) as Record<string, unknown>;
    base.connected = true;
    base.battery_percent = typeof state.batPct === "number" ? state.batPct : null;
    base.phase = typeof mission.phase === "string" ? mission.phase : null;
    base.cycle = typeof mission.cycle === "string" ? mission.cycle : null;
    base.phase_label = formatPhaseLabel(base.phase);
    base.cycle_label = formatJobLabel(base.phase, base.cycle);
    base.status_label = formatMissionStatus(base.phase, base.cycle);
    base.bin_full = typeof bin.full === "boolean" ? bin.full : null;
    base.bin_present = typeof bin.present === "boolean" ? bin.present : null;
    base.docked = base.phase === "charge" || base.phase === "dock";
    base.sqft = typeof mission.sqft === "number" ? mission.sqft : null;
    base.mission_minutes = typeof mission.mssnM === "number" ? mission.mssnM : null;
    base.last_command = typeof lastCommand.command === "string" ? lastCommand.command : null;
    base.software_version = typeof state.softwareVer === "string" ? state.softwareVer : null;
    base.sku = typeof state.sku === "string" ? state.sku : null;
    if (snapshot.pmapState && typeof snapshot.pmapState.pmaps !== "undefined") {
      base.favorites = parseFavoritesFromPmaps(snapshot.pmapState.pmaps);
    } else {
      base.favorites_error = "Favorites were not returned by the robot on this connection";
    }
    return base;
  } catch (error) {
    base.error = error instanceof Error ? error.message : String(error);
    return base;
  }
}

export async function runRobotFavorite(settings: RobotSettings, favoriteId: string): Promise<{ ok: true }> {
  const trimmedId = favoriteId.trim();
  if (!trimmedId) {
    throw new Error("favorite_id is required");
  }

  await withRobot(settings, async (robot) => {
    const command = await readFavoriteCommand(robot, trimmedId);
    await robot.cleanRoom(command);
  });
  return { ok: true };
}

export async function runRobotAction(
  settings: RobotSettings,
  action: "clean" | "pause" | "resume" | "stop" | "dock",
): Promise<RobotActionResult> {
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

export async function getRobotSchedule(settings: RobotSettings): Promise<unknown> {
  return withRobot(settings, async (robot) => robot.getWeek());
}

export async function getRobotPreferences(settings: RobotSettings): Promise<unknown> {
  return withRobot(settings, async (robot) => robot.getPreferences());
}

export function checkMqttReachable(host: string, timeoutMs = 5_000): Promise<{ reachable: boolean; latencyMs: number | null }> {
  const trimmed = host.trim();
  if (!trimmed) {
    return Promise.resolve({ reachable: false, latencyMs: null });
  }

  const started = Date.now();
  return new Promise((resolve) => {
    const socket = createConnection({ host: trimmed, port: MQTT_PORT, timeout: timeoutMs });
    const finish = (reachable: boolean) => {
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

function cloudStatusLabel(cloud: number | null | undefined): string {
  if (cloud === null || cloud === undefined) return "Unknown";
  if (cloud === 0) return "Disconnected";
  if (cloud === 4) return "Connected";
  return `Code ${cloud}`;
}

async function probeHttpGet(
  url: string,
  timeoutMs = HTTP_PROBE_TIMEOUT_MS,
): Promise<{ ok: boolean; status: number | null; latency_ms: number | null; error: string | null }> {
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
  } catch (error) {
    return {
      ok: false,
      status: null,
      latency_ms: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

type IrobotEndpoints = {
  apiKey: string;
  gigyaBase: string;
  httpBase: string;
};

async function discoverIrobotEndpoints(): Promise<IrobotEndpoints> {
  const response = await fetch(IROBOT_DISCOVERY_URL, {
    signal: AbortSignal.timeout(HTTP_PROBE_TIMEOUT_MS),
    headers: { Connection: "close" },
  });
  if (!response.ok) {
    throw new Error(`iRobot discovery endpoint returned HTTP ${response.status}`);
  }

  const body = (await response.json()) as Record<string, unknown>;
  const gigya = (body.gigya ?? {}) as Record<string, unknown>;
  const deployments = (body.deployments ?? {}) as Record<string, Record<string, unknown>>;
  const apiKey = String(process.env.GIGYA_API_KEY ?? gigya.api_key ?? "");
  const datacenter = String(gigya.datacenter_domain ?? "");
  const gigyaBase =
    process.env.GIGYA_BASE ?? (datacenter ? `https://accounts.${datacenter}` : "https://accounts.us1.gigya.com");

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

type CloudLoginBody = {
  robots?: Record<
    string,
    {
      name?: string;
      sku?: string;
      softwareVer?: string;
      password?: string;
    }
  >;
};

async function loginIrobotCloud(
  username: string,
  password: string,
): Promise<{ endpoints: IrobotEndpoints; robots: Record<string, NonNullable<CloudLoginBody["robots"]>[string]> }> {
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
  const gigyaBody = (await gigyaResponse.json()) as Record<string, unknown>;
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
  const irobotBody = (await irobotResponse.json()) as CloudLoginBody;
  if (!irobotResponse.ok || !irobotBody.robots) {
    throw new Error("iRobot cloud login failed — no robots returned");
  }

  return { endpoints, robots: irobotBody.robots };
}

function mapCloudRobots(
  robots: Record<string, { name?: string; sku?: string; softwareVer?: string; password?: string }>,
  savedBlid: string,
  savedPassword: string,
): IrobotCloudRobot[] {
  return Object.entries(robots).map(([blid, robot]) => ({
    blid,
    name: String(robot.name ?? "Roomba"),
    sku: String(robot.sku ?? ""),
    software_version: String(robot.softwareVer ?? ""),
    password_matches_saved:
      savedBlid && savedPassword && blid === savedBlid
        ? robot.password === savedPassword
        : null,
  }));
}

async function fetchRoombaDeviceDiagnostics(settings: RobotSettings): Promise<RoombaDeviceDiagnostics> {
  const base: RoombaDeviceDiagnostics = {
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

    const state = snapshot.state as Record<string, unknown>;
    const mission = (state.cleanMissionStatus ?? {}) as Record<string, unknown>;
    const bin = (state.bin ?? {}) as Record<string, unknown>;
    const wireless = (snapshot.wireless ?? {}) as Record<string, unknown>;
    const wifistat = (wireless.wifistat ?? wireless) as Record<string, unknown>;
    const wlcfg = (wireless.wlcfg ?? {}) as Record<string, unknown>;
    const cloudConfig = (snapshot.cloudConfig ?? {}) as Record<string, unknown>;
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
  } catch (error) {
    base.error = error instanceof Error ? error.message : String(error);
    return base;
  }
}

export async function buildRoombaDiagnostics(settings: RobotSettings): Promise<RoombaDiagnostics> {
  const configured = isConfigured(settings);
  const host = settings.robot_ip.trim();
  const errors: string[] = [];
  let device: RoombaDeviceDiagnostics | null = null;

  if (configured) {
    device = await fetchRoombaDeviceDiagnostics(settings);
    if (device.error) {
      errors.push(device.error);
    }
  } else {
    errors.push("Robot is not configured yet");
  }

  // Probe TCP only after MQTT — a raw socket to :8883 blocks the robot's single local MQTT slot.
  const reachability =
    device?.connected || !host
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

export async function buildIrobotDiagnostics(settings: RobotSettings): Promise<IrobotDiagnostics> {
  const username = settings.irobot_username.trim();
  const password = settings.irobot_password.trim();
  const accountConfigured = Boolean(username && password);
  const errors: string[] = [];

  const discoveryProbe = await probeHttpGet(IROBOT_DISCOVERY_URL);
  if (!discoveryProbe.ok) {
    errors.push(
      discoveryProbe.error ??
        `iRobot discovery endpoint unreachable (HTTP ${discoveryProbe.status ?? "error"})`,
    );
  }

  let endpoints: IrobotEndpoints | null = null;
  try {
    if (discoveryProbe.ok) {
      endpoints = await discoverIrobotEndpoints();
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  const result: IrobotDiagnostics = {
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
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  return result;
}

export function getDorita980Version(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("dorita980/package.json").version as string;
  } catch {
    return null;
  }
}