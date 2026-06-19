const GRAPHQL_NO_AUTH_URL = "https://dataservice.infinity.iot.carrier.com/graphql-no-auth";
const GRAPHQL_AUTH_URL = "https://dataservice.infinity.iot.carrier.com/graphql";
const TOKEN_URL = "https://sso.carrier.com/oauth2/default/v1/token";
const OAUTH_CLIENT_ID = "0oa1ce7hwjuZbfOMB4x7";

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
      },
      config: {
        etag: nullableString(config.etag),
        mode: nullableString(config.mode),
        zones: normalizeConfigZones(config.zones),
      },
    };
  }
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