"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CarrierRealtime = exports.CarrierApiClient = exports.CarrierApiError = exports.CarrierAuthError = void 0;
exports.zoneIdsMatch = zoneIdsMatch;
exports.temperatureUnitFromCfgem = temperatureUnitFromCfgem;
exports.toFahrenheit = toFahrenheit;
exports.formatFahrenheit = formatFahrenheit;
exports.applyInfinityStatusMessage = applyInfinityStatusMessage;
const GRAPHQL_NO_AUTH_URL = "https://dataservice.infinity.iot.carrier.com/graphql-no-auth";
const GRAPHQL_AUTH_URL = "https://dataservice.infinity.iot.carrier.com/graphql";
const TOKEN_URL = "https://sso.carrier.com/oauth2/default/v1/token";
const OAUTH_CLIENT_ID = "0oa1ce7hwjuZbfOMB4x7";
const REALTIME_WS_URL = "wss://realtime.infinity.iot.carrier.com/";
class CarrierAuthError extends Error {
    constructor(message) {
        super(message);
        this.name = "CarrierAuthError";
    }
}
exports.CarrierAuthError = CarrierAuthError;
class CarrierApiError extends Error {
    constructor(message) {
        super(message);
        this.name = "CarrierApiError";
    }
}
exports.CarrierApiError = CarrierApiError;
const FULL_INFINITY_SYSTEMS_QUERY = `query getInfinitySystems($userName: String!) {
  infinitySystems(userName: $userName) {
    profile {
      serial
      name
      firmware
      model
      brand
      indoorModel
      indoorSerial
      idutype
      idusource
      outdoorModel
      outdoorSerial
      odutype
    }
    status {
      localTime
      localTimeOffset
      utcTime
      wcTime
      isDisconnected
      cfgem
      mode
      vacatrunning
      oat
      odu {
        type
        opstat
        iducfm
      }
      filtrlvl
      idu {
        type
        opstat
        cfm
        statpress
        blwrpm
        pwmblower
      }
      vent
      ventlvl
      humid
      humlvl
      uvlvl
      zones {
        id
        rt
        rh
        fan
        htsp
        clsp
        hold
        enabled
        currentActivity
        zoneconditioning
        occupancy
        damperposition
        otmr
      }
    }
    config {
      etag
      mode
      cfgem
      cfgdead
      cfgvent
      cfghumid
      cfguv
      cfgfan
      heatsource
      vacat
      vacstart
      vacend
      vacmint
      vacmaxt
      vacfan
      fueltype
      gasunit
      filtertype
      filterinterval
      humidityVacation {
        rclgovercool
        ventspdclg
        ventclg
        rhtg
        humidifier
        humid
        venthtg
        rclg
        ventspdhtg
      }
      zones {
        id
        name
        enabled
        hold
        holdActivity
        otmr
        occEnabled
        program {
          id
          day {
            id
            zoneId
            period {
              id
              zoneId
              dayId
              activity
              time
              enabled
            }
          }
        }
        activities {
          id
          zoneId
          type
          fan
          htsp
          clsp
        }
      }
      humidityAway {
        humid
        humidifier
        rhtg
        rclg
        rclgovercool
      }
      humidityHome {
        humid
        humidifier
        rhtg
        rclg
        rclgovercool
      }
    }
  }
}`;
const FULL_GET_USER_QUERY = `query getUser($userName: String!) {
  user(userName: $userName) {
    username
    identityId
    first
    last
    email
    emailVerified
    postal
    locations {
      locationId
      name
      systems {
        config {
          zones {
            id
            enabled
          }
        }
        profile {
          serial
          name
        }
        status {
          isDisconnected
        }
      }
      devices {
        deviceId
        type
        thingName
        name
        connectionStatus
      }
    }
  }
}`;
const GET_INFINITY_ENERGY_QUERY = `query getInfinityEnergy($serial: String!) {
  infinityEnergy(serial: $serial) {
    energyConfig {
      cooling { display enabled }
      eheat { display enabled }
      fan { display enabled }
      fangas { display enabled }
      gas { display enabled }
      hpheat { display enabled }
      looppump { display enabled }
      reheat { display enabled }
      hspf
      seer
    }
    energyPeriods {
      energyPeriodType
      eHeatKwh
      coolingKwh
      fanGasKwh
      fanKwh
      hPHeatKwh
      loopPumpKwh
      gasKwh
      reheatKwh
    }
  }
}`;
class CarrierApiClient {
    username;
    password;
    tokens = null;
    constructor(username, password) {
        this.username = username.trim();
        this.password = password;
    }
    async validate() {
        await this.ensureLoggedIn();
        const user = await this.getUserInfo();
        const identityId = typeof user.identityId === "string" ? user.identityId : null;
        const systems = await this.getSystems();
        return { identityId, systemCount: systems.length };
    }
    async loadSystems() {
        await this.ensureLoggedIn();
        const rawSystems = await this.fetchRawSystems();
        return rawSystems.map((system) => this.normalizeSystem(system));
    }
    async fetchRawSystems() {
        await this.ensureLoggedIn();
        const result = await this.authedGraphql("getInfinitySystems", FULL_INFINITY_SYSTEMS_QUERY, { userName: this.username });
        return Array.isArray(result.infinitySystems) ? result.infinitySystems : [];
    }
    async fetchUserProfile() {
        await this.ensureLoggedIn();
        const result = await this.authedGraphql("getUser", FULL_GET_USER_QUERY, { userName: this.username });
        return result.user ?? {};
    }
    async fetchEnergy(serial) {
        await this.ensureLoggedIn();
        const result = await this.authedGraphql("getInfinityEnergy", GET_INFINITY_ENERGY_QUERY, { serial });
        return result.infinityEnergy ?? null;
    }
    async loadExplorerBundle() {
        const errors = {
            getUser: null,
            getInfinitySystems: null,
            getInfinityEnergy: null,
        };
        let getUser = null;
        let getInfinitySystems = [];
        const getInfinityEnergy = {};
        try {
            getUser = await this.fetchUserProfile();
        }
        catch (error) {
            errors.getUser = error instanceof Error ? error.message : String(error);
        }
        try {
            getInfinitySystems = await this.fetchRawSystems();
        }
        catch (error) {
            errors.getInfinitySystems = error instanceof Error ? error.message : String(error);
        }
        for (const system of getInfinitySystems) {
            const profile = system.profile ?? {};
            const serial = asString(profile.serial);
            if (!serial)
                continue;
            try {
                getInfinityEnergy[serial] = await this.fetchEnergy(serial);
            }
            catch (error) {
                getInfinityEnergy[serial] = null;
                errors[`getInfinityEnergy.${serial}`] = error instanceof Error ? error.message : String(error);
            }
        }
        return {
            fetched_at: new Date().toISOString(),
            errors,
            getUser,
            getInfinitySystems,
            getInfinityEnergy,
        };
    }
    async getAccessToken() {
        await this.ensureLoggedIn();
        if (!this.tokens) {
            throw new CarrierApiError("Not authenticated");
        }
        return this.tokens.accessToken;
    }
    async setMode(serial, mode) {
        await this.mutate("updateInfinityConfig", `mutation updateInfinityConfig($input: InfinityConfigInput!) {
        updateInfinityConfig(input: $input) { etag }
      }`, { input: { serial, mode } });
    }
    async setManualActivity(serial, zoneId, heatSetpoint, coolSetpoint, fanMode, etag) {
        const input = {
            serial,
            zoneId,
            activityType: "manual",
            htsp: heatSetpoint,
            clsp: coolSetpoint,
        };
        if (fanMode)
            input.fan = fanMode;
        return this.mutateForEtag("updateInfinityZoneActivity", `mutation updateInfinityZoneActivity($input: InfinityZoneActivityInput!) {
        updateInfinityZoneActivity(input: $input) { etag }
      }`, { input }, "updateInfinityZoneActivity");
    }
    async setHold(serial, zoneId, activityType, holdUntil = null, etag) {
        const input = {
            serial,
            zoneId,
            hold: "on",
            holdActivity: activityType,
            otmr: holdUntil,
        };
        return this.mutateForEtag("updateInfinityZoneConfig", `mutation updateInfinityZoneConfig($input: InfinityZoneConfigInput!) {
        updateInfinityZoneConfig(input: $input) { etag }
      }`, { input }, "updateInfinityZoneConfig");
    }
    async resumeSchedule(serial, zoneId, _etag) {
        const input = {
            serial,
            zoneId,
            hold: "off",
            holdActivity: null,
            otmr: null,
        };
        return this.mutateForEtag("updateInfinityZoneConfig", `mutation updateInfinityZoneConfig($input: InfinityZoneConfigInput!) {
        updateInfinityZoneConfig(input: $input) { etag }
      }`, { input }, "updateInfinityZoneConfig");
    }
    async updateZoneActivity(serial, zoneId, activityType, heatSetpoint, coolSetpoint, fanMode, etag) {
        const input = {
            serial,
            zoneId,
            activityType,
            htsp: heatSetpoint,
            clsp: coolSetpoint,
        };
        if (fanMode)
            input.fan = fanMode;
        return this.mutateForEtag("updateInfinityZoneActivity", `mutation updateInfinityZoneActivity($input: InfinityZoneActivityInput!) {
        updateInfinityZoneActivity(input: $input) { etag }
      }`, { input }, "updateInfinityZoneActivity");
    }
    async updateFan(serial, zoneId, activityType, fanMode, etag) {
        const input = {
            serial,
            zoneId,
            activityType,
            fan: fanMode,
        };
        return this.mutateForEtag("updateInfinityZoneActivity", `mutation updateInfinityZoneActivity($input: InfinityZoneActivityInput!) {
        updateInfinityZoneActivity(input: $input) { etag }
      }`, { input }, "updateInfinityZoneActivity");
    }
    async ensureLoggedIn() {
        if (!this.tokens) {
            await this.login();
            return;
        }
        if (Date.now() >= this.tokens.expiresAt - 60_000) {
            await this.refreshToken();
        }
    }
    async login() {
        const result = await this.graphql(GRAPHQL_NO_AUTH_URL, "assistedLogin", `mutation assistedLogin($input: AssistedLoginInput!) {
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
      }`, { input: { username: this.username, password: this.password } });
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
    async refreshToken() {
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
        const data = (await response.json());
        this.tokens = {
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            tokenType: data.token_type,
            expiresAt: Date.now() + data.expires_in * 1000,
        };
    }
    async getUserInfo() {
        const result = await this.authedGraphql("getUser", `query getUser($userName: String!) {
        user(userName: $userName) {
          identityId
        }
      }`, { userName: this.username });
        return result.user ?? {};
    }
    async getSystems() {
        return this.fetchRawSystems();
    }
    async mutate(operationName, query, variables) {
        await this.ensureLoggedIn();
        await this.authedGraphql(operationName, query, variables);
    }
    async mutateForEtag(operationName, query, variables, resultKey) {
        await this.ensureLoggedIn();
        const data = await this.authedGraphql(operationName, query, variables);
        const etag = data[resultKey]?.etag;
        return typeof etag === "string" && etag.length ? etag : null;
    }
    async authedGraphql(operationName, query, variables) {
        if (!this.tokens) {
            throw new CarrierAuthError("Not authenticated");
        }
        return this.graphql(GRAPHQL_AUTH_URL, operationName, query, variables, `${this.tokens.tokenType} ${this.tokens.accessToken}`);
    }
    async graphql(url, operationName, query, variables, authorization) {
        const headers = {
            "Content-Type": "application/json",
            Accept: "application/json",
        };
        if (authorization)
            headers.Authorization = authorization;
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
        const payload = (await response.json());
        if (payload.errors?.length) {
            const message = payload.errors.map((error) => error.message).filter(Boolean).join("; ");
            throw new CarrierApiError(message || "Carrier GraphQL request failed");
        }
        if (!payload.data) {
            throw new CarrierApiError("Carrier API returned no data");
        }
        return payload.data;
    }
    normalizeSystem(raw) {
        const profile = raw.profile ?? {};
        const status = raw.status ?? {};
        const config = raw.config ?? {};
        return {
            profile: {
                serial: asString(profile.serial),
                name: asString(profile.name) || "HVAC System",
                firmware: nullableString(profile.firmware),
                model: nullableString(profile.model),
                brand: nullableString(profile.brand),
                indoorModel: nullableString(profile.indoorModel),
                indoorSerial: nullableString(profile.indoorSerial),
                outdoorModel: nullableString(profile.outdoorModel),
                outdoorSerial: nullableString(profile.outdoorSerial),
                idutype: nullableString(profile.idutype),
                odutype: nullableString(profile.odutype),
            },
            status: {
                isDisconnected: asBool(status.isDisconnected),
                localTime: nullableString(status.localTime),
                mode: nullableString(status.mode),
                cfgem: nullableString(status.cfgem),
                oat: asNumber(status.oat),
                filtrlvl: asNumber(status.filtrlvl),
                vacatrunning: nullableString(status.vacatrunning),
                vent: nullableString(status.vent),
                ventlvl: asNumber(status.ventlvl),
                humid: nullableString(status.humid),
                humlvl: asNumber(status.humlvl),
                uvlvl: asNumber(status.uvlvl),
                zones: normalizeStatusZones(status.zones),
                idu: normalizeIduStatus(status.idu),
                odu: normalizeOduStatus(status.odu),
            },
            config: {
                etag: nullableString(config.etag),
                mode: nullableString(config.mode),
                filterType: nullableString(config.filtertype),
                filterInterval: asNumber(config.filterinterval),
                zones: normalizeConfigZones(config.zones),
            },
        };
    }
}
exports.CarrierApiClient = CarrierApiClient;
function normalizeIduStatus(value) {
    if (!value || typeof value !== "object")
        return null;
    const record = value;
    return {
        type: nullableString(record.type),
        opstat: nullableString(record.opstat),
        statpress: asNumber(record.statpress),
        blwrpm: asNumber(record.blwrpm),
        cfm: asNumber(record.cfm),
        pwmblower: asNumber(record.pwmblower),
    };
}
function normalizeOduStatus(value) {
    if (!value || typeof value !== "object")
        return null;
    const record = value;
    return {
        type: nullableString(record.type),
        opstat: nullableString(record.opstat),
        iducfm: asNumber(record.iducfm),
    };
}
function normalizeStatusZones(value) {
    if (!Array.isArray(value))
        return [];
    return value.map((zone) => {
        const record = zone;
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
function normalizeConfigZones(value) {
    if (!Array.isArray(value))
        return [];
    return value.map((zone) => {
        const record = zone;
        const activities = Array.isArray(record.activities)
            ? record.activities.map((activity) => {
                const item = activity;
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
            program: normalizeZoneProgram(record.program),
        };
    });
}
function normalizeZoneProgram(value) {
    if (!value || typeof value !== "object")
        return null;
    const record = value;
    const days = Array.isArray(record.day)
        ? record.day.map((day) => {
            const dayRecord = day;
            const periods = Array.isArray(dayRecord.period)
                ? dayRecord.period.map((period) => {
                    const periodRecord = period;
                    return {
                        id: asString(periodRecord.id),
                        dayId: asNumber(periodRecord.dayId) ?? 0,
                        activity: asString(periodRecord.activity),
                        time: asString(periodRecord.time),
                        enabled: nullableString(periodRecord.enabled) === "on",
                    };
                })
                : [];
            return {
                id: asNumber(dayRecord.id) ?? 0,
                periods,
            };
        })
        : [];
    return {
        id: asString(record.id),
        days,
    };
}
function zoneIdsMatch(left, right) {
    if (left === undefined || left === null || right === undefined || right === null)
        return false;
    return String(left) === String(right);
}
function temperatureUnitFromCfgem(cfgem) {
    return cfgem === "C" ? "C" : "F";
}
function toFahrenheit(value, cfgem) {
    if (value === null)
        return null;
    return temperatureUnitFromCfgem(cfgem) === "C" ? (value * 9) / 5 + 32 : value;
}
function formatFahrenheit(value, cfgem) {
    const fahrenheit = toFahrenheit(value, cfgem);
    if (fahrenheit === null)
        return null;
    return String(Math.round(fahrenheit));
}
function applyInfinityStatusMessage(systems, rawMessage) {
    let parsed;
    try {
        parsed = JSON.parse(rawMessage);
    }
    catch {
        return false;
    }
    if (parsed.messageType !== "InfinityStatus")
        return false;
    const serial = parsed.deviceId;
    if (typeof serial !== "string")
        return false;
    const system = systems.find((item) => item.profile.serial === serial);
    if (!system)
        return false;
    const zones = parsed.zones;
    if (Array.isArray(zones)) {
        for (const zoneUpdate of zones) {
            if (!zoneUpdate || typeof zoneUpdate !== "object")
                continue;
            const record = zoneUpdate;
            if (record.id === undefined || record.id === null)
                continue;
            const zone = system.status.zones.find((item) => zoneIdsMatch(item.id, asString(record.id)));
            if (!zone)
                continue;
            if (record.rt !== undefined)
                zone.rt = asNumber(record.rt);
            if (record.rh !== undefined)
                zone.rh = asNumber(record.rh);
            if (record.htsp !== undefined)
                zone.htsp = asNumber(record.htsp);
            if (record.clsp !== undefined)
                zone.clsp = asNumber(record.clsp);
            if (record.fan !== undefined)
                zone.fan = nullableString(record.fan);
            if (record.currentActivity !== undefined) {
                zone.currentActivity = nullableString(record.currentActivity);
            }
            if (record.zoneconditioning !== undefined) {
                zone.zoneconditioning = nullableString(record.zoneconditioning);
            }
            if (record.hold !== undefined)
                zone.hold = nullableString(record.hold);
            if (record.enabled !== undefined)
                zone.enabled = nullableString(record.enabled);
        }
    }
    if (parsed.oat !== undefined)
        system.status.oat = asNumber(parsed.oat);
    if (parsed.mode !== undefined)
        system.status.mode = nullableString(parsed.mode);
    if (parsed.filtrlvl !== undefined)
        system.status.filtrlvl = asNumber(parsed.filtrlvl);
    if (parsed.isDisconnected !== undefined) {
        system.status.isDisconnected = asBool(parsed.isDisconnected);
    }
    const idu = parsed.idu;
    if (idu && typeof idu === "object") {
        const record = idu;
        if (!system.status.idu) {
            system.status.idu = {
                type: null,
                opstat: null,
                statpress: null,
                blwrpm: null,
                cfm: null,
                pwmblower: null,
            };
        }
        if (record.type !== undefined)
            system.status.idu.type = nullableString(record.type);
        if (record.opstat !== undefined)
            system.status.idu.opstat = nullableString(record.opstat);
        if (record.statpress !== undefined)
            system.status.idu.statpress = asNumber(record.statpress);
        if (record.blwrpm !== undefined)
            system.status.idu.blwrpm = asNumber(record.blwrpm);
        if (record.cfm !== undefined)
            system.status.idu.cfm = asNumber(record.cfm);
        if (record.pwmblower !== undefined)
            system.status.idu.pwmblower = asNumber(record.pwmblower);
    }
    const odu = parsed.odu;
    if (odu && typeof odu === "object") {
        const record = odu;
        if (!system.status.odu) {
            system.status.odu = { type: null, opstat: null, iducfm: null };
        }
        if (record.type !== undefined)
            system.status.odu.type = nullableString(record.type);
        if (record.opstat !== undefined)
            system.status.odu.opstat = nullableString(record.opstat);
        if (record.iducfm !== undefined)
            system.status.odu.iducfm = asNumber(record.iducfm);
    }
    if (parsed.vent !== undefined)
        system.status.vent = nullableString(parsed.vent);
    if (parsed.ventlvl !== undefined)
        system.status.ventlvl = asNumber(parsed.ventlvl);
    if (parsed.humid !== undefined)
        system.status.humid = nullableString(parsed.humid);
    if (parsed.humlvl !== undefined)
        system.status.humlvl = asNumber(parsed.humlvl);
    if (parsed.uvlvl !== undefined)
        system.status.uvlvl = asNumber(parsed.uvlvl);
    if (parsed.vacatrunning !== undefined) {
        system.status.vacatrunning = nullableString(parsed.vacatrunning);
    }
    return true;
}
class CarrierRealtime {
    getToken;
    onMessage;
    ws = null;
    heartbeatTimer = null;
    reconnectTimer = null;
    running = false;
    connecting = false;
    constructor(getToken, onMessage) {
        this.getToken = getToken;
        this.onMessage = onMessage;
    }
    start() {
        if (this.running)
            return;
        this.running = true;
        void this.connect();
    }
    stop() {
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
    scheduleReconnect() {
        if (!this.running || this.reconnectTimer)
            return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            void this.connect();
        }, 5000);
    }
    async connect() {
        if (!this.running || this.connecting || this.ws)
            return;
        this.connecting = true;
        try {
            const token = await this.getToken();
            const ws = new WebSocket(`${REALTIME_WS_URL}?Token=${encodeURIComponent(token)}`);
            this.ws = ws;
            ws.onopen = () => {
                this.connecting = false;
                if (this.heartbeatTimer)
                    clearInterval(this.heartbeatTimer);
                this.heartbeatTimer = setInterval(() => {
                    if (this.ws?.readyState === WebSocket.OPEN) {
                        this.ws.send(JSON.stringify({ action: "keepalive" }));
                    }
                }, 55_000);
            };
            ws.onmessage = (event) => {
                if (typeof event.data !== "string" || event.data === "close cmd")
                    return;
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
        }
        catch {
            this.connecting = false;
            this.ws = null;
            this.scheduleReconnect();
        }
    }
}
exports.CarrierRealtime = CarrierRealtime;
function asString(value) {
    if (value === undefined || value === null)
        return "";
    return String(value);
}
function nullableString(value) {
    const text = asString(value).trim();
    return text ? text : null;
}
function asNumber(value) {
    if (value === undefined || value === null || value === "")
        return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}
function asBool(value) {
    if (value === undefined || value === null)
        return null;
    if (typeof value === "boolean")
        return value;
    if (value === "true" || value === "on")
        return true;
    if (value === "false" || value === "off")
        return false;
    return null;
}
