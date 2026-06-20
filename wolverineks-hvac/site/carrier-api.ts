const GRAPHQL_NO_AUTH_URL = "https://dataservice.infinity.iot.carrier.com/graphql-no-auth";
const GRAPHQL_AUTH_URL = "https://dataservice.infinity.iot.carrier.com/graphql";
const TOKEN_URL = "https://sso.carrier.com/oauth2/default/v1/token";
const OAUTH_CLIENT_ID = "0oa1ce7hwjuZbfOMB4x7";
const REALTIME_WS_URL = "wss://realtime.infinity.iot.carrier.com/";

export type SystemMode = "off" | "cool" | "heat" | "auto" | "fanonly";
export type ActivityType = "home" | "away" | "sleep" | "wake" | "manual" | "vacation";
export type FanMode = "off" | "low" | "med" | "high";

export class CarrierAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CarrierAuthError";
  }
}

export class CarrierApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CarrierApiError";
  }
}

type TokenState = {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresAt: number;
};

type GraphqlEnvelope<T> = {
  data?: T;
  errors?: Array<{ message?: string }>;
};

export type CarrierZoneActivity = {
  id: string;
  type: string;
  fan: string;
  htsp: number;
  clsp: number;
};

export type CarrierConfigZone = {
  id: string;
  name: string;
  enabled: string | null;
  hold: string;
  holdActivity: string | null;
  otmr: string | null;
  activities: CarrierZoneActivity[];
};

export type CarrierStatusZone = {
  id: string;
  rt: number | null;
  rh: number | null;
  fan: string | null;
  htsp: number | null;
  clsp: number | null;
  hold: string | null;
  currentActivity: string | null;
  zoneconditioning: string | null;
  enabled: string | null;
};

export type CarrierIduStatus = {
  blwrpm: number | null;
  cfm: number | null;
  pwmblower: number | null;
};

export type CarrierSystem = {
  profile: {
    serial: string;
    name: string;
    firmware: string | null;
    model: string | null;
    brand: string | null;
  };
  status: {
    isDisconnected: boolean | null;
    mode: string | null;
    cfgem: string | null;
    oat: number | null;
    filtrlvl: number | null;
    zones: CarrierStatusZone[];
    idu: CarrierIduStatus | null;
  };
  config: {
    etag: string | null;
    mode: string | null;
    zones: CarrierConfigZone[];
  };
};

export class CarrierApiClient {
  private readonly username: string;
  private readonly password: string;
  private tokens: TokenState | null = null;

  constructor(username: string, password: string) {
    this.username = username.trim();
    this.password = password;
  }

  async validate(): Promise<{ identityId: string | null; systemCount: number }> {
    await this.ensureLoggedIn();
    const user = await this.getUserInfo();
    const identityId = typeof user.identityId === "string" ? user.identityId : null;
    const systems = await this.getSystems();
    return { identityId, systemCount: systems.length };
  }

  async loadSystems(): Promise<CarrierSystem[]> {
    await this.ensureLoggedIn();
    const rawSystems = await this.getSystems();
    return rawSystems.map((system) => this.normalizeSystem(system));
  }

  async getAccessToken(): Promise<string> {
    await this.ensureLoggedIn();
    if (!this.tokens) {
      throw new CarrierApiError("Not authenticated");
    }
    return this.tokens.accessToken;
  }

  async setMode(serial: string, mode: SystemMode): Promise<void> {
    await this.mutate(
      "updateInfinityConfig",
      `mutation updateInfinityConfig($input: InfinityConfigInput!) {
        updateInfinityConfig(input: $input) { etag }
      }`,
      { input: { serial, mode } },
    );
  }

  async setManualActivity(
    serial: string,
    zoneId: string,
    heatSetpoint: string,
    coolSetpoint: string,
    fanMode?: FanMode,
  ): Promise<void> {
    const input: Record<string, string> = {
      serial,
      zoneId,
      activityType: "manual",
      htsp: heatSetpoint,
      clsp: coolSetpoint,
    };
    if (fanMode) input.fan = fanMode;
    await this.mutate(
      "updateInfinityZoneActivity",
      `mutation updateInfinityZoneActivity($input: InfinityZoneActivityInput!) {
        updateInfinityZoneActivity(input: $input) { etag }
      }`,
      { input },
    );
  }

  async setHold(
    serial: string,
    zoneId: string,
    activityType: ActivityType,
    holdUntil: string | null = null,
  ): Promise<void> {
    await this.mutate(
      "updateInfinityZoneConfig",
      `mutation updateInfinityZoneConfig($input: InfinityZoneConfigInput!) {
        updateInfinityZoneConfig(input: $input) { etag }
      }`,
      {
        input: {
          serial,
          zoneId,
          hold: "on",
          holdActivity: activityType,
          otmr: holdUntil,
        },
      },
    );
  }

  async resumeSchedule(serial: string, zoneId: string): Promise<void> {
    await this.mutate(
      "updateInfinityZoneConfig",
      `mutation updateInfinityZoneConfig($input: InfinityZoneConfigInput!) {
        updateInfinityZoneConfig(input: $input) { etag }
      }`,
      {
        input: {
          serial,
          zoneId,
          hold: "off",
          holdActivity: null,
          otmr: null,
        },
      },
    );
  }

  async updateFan(
    serial: string,
    zoneId: string,
    activityType: ActivityType,
    fanMode: FanMode,
  ): Promise<void> {
    await this.mutate(
      "updateInfinityZoneActivity",
      `mutation updateInfinityZoneActivity($input: InfinityZoneActivityInput!) {
        updateInfinityZoneActivity(input: $input) { etag }
      }`,
      {
        input: {
          serial,
          zoneId,
          activityType,
          fan: fanMode,
        },
      },
    );
  }

  private async ensureLoggedIn(): Promise<void> {
    if (!this.tokens) {
      await this.login();
      return;
    }
    if (Date.now() >= this.tokens.expiresAt - 60_000) {
      await this.refreshToken();
    }
  }

  private async login(): Promise<void> {
    const result = await this.graphql<{
      assistedLogin: {
        success: boolean;
        errorMessage?: string | null;
        data?: {
          token_type: string;
          expires_in: number;
          access_token: string;
          refresh_token: string;
        } | null;
      };
    }>(
      GRAPHQL_NO_AUTH_URL,
      "assistedLogin",
      `mutation assistedLogin($input: AssistedLoginInput!) {
        assistedLogin(input: $input) {
          success
          errorMessage
          data {
            token_type
            expires_in
            access_token
            refresh_token
          }
        }
      }`,
      { input: { username: this.username, password: this.password } },
    );

    const payload = result.assistedLogin;
    if (!payload.success || !payload.data) {
      throw new CarrierAuthError(payload.errorMessage || "Invalid Bryant/Carrier credentials");
    }
    this.tokens = {
      accessToken: payload.data.access_token,
      refreshToken: payload.data.refresh_token,
      tokenType: payload.data.token_type,
      expiresAt: Date.now() + payload.data.expires_in * 1000,
    };
  }

  private async refreshToken(): Promise<void> {
    if (!this.tokens?.refreshToken) {
      await this.login();
      return;
    }

    const body = new URLSearchParams({
      client_id: OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: this.tokens.refreshToken,
      scope: "offline_access",
    });

    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new CarrierAuthError("Carrier session expired — sign in again");
      }
      throw new CarrierApiError(`Token refresh failed (HTTP ${response.status})`);
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
    };

    this.tokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      tokenType: data.token_type,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
  }

  private async getUserInfo(): Promise<{ identityId?: string | null }> {
    const result = await this.authedGraphql<{
      user: { identityId?: string | null };
    }>(
      "getUser",
      `query getUser($userName: String!) {
        user(userName: $userName) {
          identityId
        }
      }`,
      { userName: this.username },
    );
    return result.user ?? {};
  }

  private async getSystems(): Promise<Array<Record<string, unknown>>> {
    const result = await this.authedGraphql<{
      infinitySystems: Array<Record<string, unknown>>;
    }>(
      "getInfinitySystems",
      `query getInfinitySystems($userName: String!) {
        infinitySystems(userName: $userName) {
          profile {
            serial
            name
            firmware
            model
            brand
          }
          status {
            isDisconnected
            mode
            cfgem
            oat
            filtrlvl
            zones {
              id
              rt
              rh
              fan
              htsp
              clsp
              hold
              currentActivity
              zoneconditioning
              enabled
            }
            idu {
              blwrpm
              cfm
              pwmblower
            }
          }
          config {
            etag
            mode
            zones {
              id
              name
              enabled
              hold
              holdActivity
              otmr
              activities {
                id
                type
                fan
                htsp
                clsp
              }
            }
          }
        }
      }`,
      { userName: this.username },
    );
    return Array.isArray(result.infinitySystems) ? result.infinitySystems : [];
  }

  private async mutate(
    operationName: string,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<void> {
    await this.ensureLoggedIn();
    await this.authedGraphql(operationName, query, variables);
  }

  private async authedGraphql<T>(
    operationName: string,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    if (!this.tokens) {
      throw new CarrierAuthError("Not authenticated");
    }
    return this.graphql<T>(
      GRAPHQL_AUTH_URL,
      operationName,
      query,
      variables,
      `${this.tokens.tokenType} ${this.tokens.accessToken}`,
    );
  }

  private async graphql<T>(
    url: string,
    operationName: string,
    query: string,
    variables: Record<string, unknown>,
    authorization?: string,
  ): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (authorization) headers.Authorization = authorization;

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ operationName, query, variables }),
    });

    if (response.status === 401 || response.status === 403) {
      throw new CarrierAuthError("Carrier rejected credentials");
    }
    if (!response.ok) {
      throw new CarrierApiError(`Carrier API error (HTTP ${response.status})`);
    }

    const payload = (await response.json()) as GraphqlEnvelope<T>;
    if (payload.errors?.length) {
      const message = payload.errors.map((error) => error.message).filter(Boolean).join("; ");
      throw new CarrierApiError(message || "Carrier GraphQL request failed");
    }
    if (!payload.data) {
      throw new CarrierApiError("Carrier API returned no data");
    }
    return payload.data;
  }

  private normalizeSystem(raw: Record<string, unknown>): CarrierSystem {
    const profile = (raw.profile as Record<string, unknown> | undefined) ?? {};
    const status = (raw.status as Record<string, unknown> | undefined) ?? {};
    const config = (raw.config as Record<string, unknown> | undefined) ?? {};

    return {
      profile: {
        serial: asString(profile.serial),
        name: asString(profile.name) || "HVAC System",
        firmware: nullableString(profile.firmware),
        model: nullableString(profile.model),
        brand: nullableString(profile.brand),
      },
      status: {
        isDisconnected: asBool(status.isDisconnected),
        mode: nullableString(status.mode),
        cfgem: nullableString(status.cfgem),
        oat: asNumber(status.oat),
        filtrlvl: asNumber(status.filtrlvl),
        zones: normalizeStatusZones(status.zones),
        idu: normalizeIduStatus(status.idu),
      },
      config: {
        etag: nullableString(config.etag),
        mode: nullableString(config.mode),
        zones: normalizeConfigZones(config.zones),
      },
    };
  }
}

function normalizeIduStatus(value: unknown): CarrierIduStatus | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return {
    blwrpm: asNumber(record.blwrpm),
    cfm: asNumber(record.cfm),
    pwmblower: asNumber(record.pwmblower),
  };
}

function normalizeStatusZones(value: unknown): CarrierStatusZone[] {
  if (!Array.isArray(value)) return [];
  return value.map((zone) => {
    const record = zone as Record<string, unknown>;
    return {
      id: asString(record.id),
      rt: asNumber(record.rt),
      rh: asNumber(record.rh),
      fan: nullableString(record.fan),
      htsp: asNumber(record.htsp),
      clsp: asNumber(record.clsp),
      hold: nullableString(record.hold),
      currentActivity: nullableString(record.currentActivity),
      zoneconditioning: nullableString(record.zoneconditioning),
      enabled: nullableString(record.enabled),
    };
  });
}

function normalizeConfigZones(value: unknown): CarrierConfigZone[] {
  if (!Array.isArray(value)) return [];
  return value.map((zone) => {
    const record = zone as Record<string, unknown>;
    const activities = Array.isArray(record.activities)
      ? record.activities.map((activity) => {
          const item = activity as Record<string, unknown>;
          return {
            id: asString(item.id),
            type: asString(item.type),
            fan: asString(item.fan),
            htsp: asNumber(item.htsp) ?? 0,
            clsp: asNumber(item.clsp) ?? 0,
          };
        })
      : [];
    return {
      id: asString(record.id),
      name: asString(record.name) || "Zone",
      enabled: nullableString(record.enabled),
      hold: asString(record.hold),
      holdActivity: nullableString(record.holdActivity),
      otmr: nullableString(record.otmr),
      activities,
    };
  });
}

export function zoneIdsMatch(
  left: string | number | null | undefined,
  right: string | number | null | undefined,
): boolean {
  if (left === undefined || left === null || right === undefined || right === null) return false;
  return String(left) === String(right);
}

export function temperatureUnitFromCfgem(cfgem: string | null | undefined): "F" | "C" {
  return cfgem === "C" ? "C" : "F";
}

export function toFahrenheit(value: number | null, cfgem: string | null | undefined): number | null {
  if (value === null) return null;
  return temperatureUnitFromCfgem(cfgem) === "C" ? (value * 9) / 5 + 32 : value;
}

export function formatFahrenheit(value: number | null, cfgem: string | null | undefined): string | null {
  const fahrenheit = toFahrenheit(value, cfgem);
  if (fahrenheit === null) return null;
  return String(Math.round(fahrenheit));
}

export function applyInfinityStatusMessage(systems: CarrierSystem[], rawMessage: string): boolean {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawMessage) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (parsed.messageType !== "InfinityStatus") return false;
  const serial = parsed.deviceId;
  if (typeof serial !== "string") return false;

  const system = systems.find((item) => item.profile.serial === serial);
  if (!system) return false;

  const zones = parsed.zones;
  if (Array.isArray(zones)) {
    for (const zoneUpdate of zones) {
      if (!zoneUpdate || typeof zoneUpdate !== "object") continue;
      const record = zoneUpdate as Record<string, unknown>;
      if (record.id === undefined || record.id === null) continue;
      const zone = system.status.zones.find((item) => zoneIdsMatch(item.id, asString(record.id)));
      if (!zone) continue;
      if (record.rt !== undefined) zone.rt = asNumber(record.rt);
      if (record.rh !== undefined) zone.rh = asNumber(record.rh);
      if (record.htsp !== undefined) zone.htsp = asNumber(record.htsp);
      if (record.clsp !== undefined) zone.clsp = asNumber(record.clsp);
      if (record.fan !== undefined) zone.fan = nullableString(record.fan);
      if (record.currentActivity !== undefined) {
        zone.currentActivity = nullableString(record.currentActivity);
      }
      if (record.zoneconditioning !== undefined) {
        zone.zoneconditioning = nullableString(record.zoneconditioning);
      }
      if (record.hold !== undefined) zone.hold = nullableString(record.hold);
      if (record.enabled !== undefined) zone.enabled = nullableString(record.enabled);
    }
  }

  if (parsed.oat !== undefined) system.status.oat = asNumber(parsed.oat);
  if (parsed.mode !== undefined) system.status.mode = nullableString(parsed.mode);
  if (parsed.filtrlvl !== undefined) system.status.filtrlvl = asNumber(parsed.filtrlvl);
  if (parsed.isDisconnected !== undefined) {
    system.status.isDisconnected = asBool(parsed.isDisconnected);
  }

  const idu = parsed.idu;
  if (idu && typeof idu === "object") {
    const record = idu as Record<string, unknown>;
    if (!system.status.idu) {
      system.status.idu = { blwrpm: null, cfm: null, pwmblower: null };
    }
    if (record.blwrpm !== undefined) system.status.idu.blwrpm = asNumber(record.blwrpm);
    if (record.cfm !== undefined) system.status.idu.cfm = asNumber(record.cfm);
    if (record.pwmblower !== undefined) system.status.idu.pwmblower = asNumber(record.pwmblower);
  }

  return true;
}

export class CarrierRealtime {
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private running = false;
  private connecting = false;

  constructor(
    private readonly getToken: () => Promise<string>,
    private readonly onMessage: (message: string) => void,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.connect();
  }

  stop(): void {
    this.running = false;
    this.connecting = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, 5000);
  }

  private async connect(): Promise<void> {
    if (!this.running || this.connecting || this.ws) return;
    this.connecting = true;
    try {
      const token = await this.getToken();
      const ws = new WebSocket(`${REALTIME_WS_URL}?Token=${encodeURIComponent(token)}`);
      this.ws = ws;

      ws.onopen = () => {
        this.connecting = false;
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ action: "keepalive" }));
          }
        }, 55_000);
      };

      ws.onmessage = (event) => {
        if (typeof event.data !== "string" || event.data === "close cmd") return;
        this.onMessage(event.data);
      };

      ws.onclose = () => {
        this.connecting = false;
        if (this.heartbeatTimer) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = null;
        }
        this.ws = null;
        this.scheduleReconnect();
      };

      ws.onerror = () => {
        ws.close();
      };
    } catch {
      this.connecting = false;
      this.ws = null;
      this.scheduleReconnect();
    }
  }
}

function asString(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value);
}

function nullableString(value: unknown): string | null {
  const text = asString(value).trim();
  return text ? text : null;
}

function asNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function asBool(value: unknown): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "on") return true;
  if (value === "false" || value === "off") return false;
  return null;
}