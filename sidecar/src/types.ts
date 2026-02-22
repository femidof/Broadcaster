export interface Destination {
  id: string;
  name: string;
  platform: "twitch" | "youtube" | "custom";
  url: string;
  streamKey: string;
  enabled: boolean;
}

export interface RelayStatus {
  destinationId: string;
  name: string;
  status: "idle" | "live" | "error";
  error?: string;
  restartCount: number;
}

// Inbound commands from Rust via stdin
export type InboundCommand =
  | { cmd: "start_server"; port: number }
  | { cmd: "stop_server" }
  | { cmd: "add_destination"; destination: Destination }
  | { cmd: "remove_destination"; id: string }
  | { cmd: "update_destination"; destination: Destination }
  | { cmd: "get_status" }
  | { cmd: "shutdown" };

// Outbound events to Rust via stdout
export type OutboundEvent =
  | { event: "server_started"; port: number }
  | { event: "server_stopped" }
  | { event: "server_error"; error: string }
  | { event: "stream_connected"; streamKey: string }
  | { event: "stream_disconnected"; streamKey: string }
  | { event: "relay_started"; destinationId: string }
  | { event: "relay_stopped"; destinationId: string; reason: string }
  | { event: "relay_error"; destinationId: string; error: string }
  | {
      event: "status";
      serverRunning: boolean;
      port: number;
      streamActive: boolean;
      relays: RelayStatus[];
      destinations: Destination[];
    }
  | { event: "destinations_updated"; destinations: Destination[] }
  | { event: "ready" }
  | { event: "error"; error: string };

export interface AppConfig {
  port: number;
  autoStart: boolean;
  destinations: Destination[];
}
