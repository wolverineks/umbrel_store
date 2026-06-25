declare module "dorita980" {
  import { EventEmitter } from "node:events";

  export type DoritaDiscoveryRobot = {
    ver?: string;
    hostname?: string;
    robotname?: string;
    ip?: string;
    mac?: string;
    sw?: string;
    sku?: string;
    nc?: number;
    proto?: string;
  };

  export type DoritaLocalOptions = {
    connectTimeout?: number;
    reconnectPeriod?: number;
    port?: number;
  };

  export class Local extends EventEmitter {
    constructor(
      blid: string,
      password: string,
      ip: string,
      protocolVersion?: number,
      options?: DoritaLocalOptions,
    );
    end(force?: boolean, callback?: () => void): void;
    clean(): Promise<void>;
    cleanRoom(args: Record<string, unknown>): Promise<void>;
    pause(): Promise<void>;
    resume(): Promise<void>;
    stop(): Promise<void>;
    dock(): Promise<void>;
    getRobotState(fields?: string[]): Promise<Record<string, unknown>>;
    getWeek(): Promise<Record<string, unknown>>;
    getPreferences(): Promise<Record<string, unknown>>;
    getWirelessStatus(): Promise<Record<string, unknown>>;
    getCloudConfig(): Promise<Record<string, unknown>>;
    connected?: boolean;
  }

  export function discovery(
    callback: (error: Error | null, robots?: DoritaDiscoveryRobot | DoritaDiscoveryRobot[]) => void,
  ): void;

  const dorita980: {
    Local: typeof Local;
    discovery: typeof discovery;
  };

  export default dorita980;
}