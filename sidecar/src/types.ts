export interface Destination {
  id: string;
  name: string;
  platform:
    | "twitch"
    | "youtube"
    | "facebook"
    | "instagram"
    | "tiktok"
    | "trovo"
    | "kick"
    | "restream"
    | "bigo"
    | "custom";
  url: string;
  streamKey: string;
  enabled: boolean;
  /** Route this destination through the bundled ffmpeg instead of the native RTMP client. */
  useFfmpeg?: boolean;
  /** Optional override for ffmpeg output args (defaults to `-c copy`). Only used when useFfmpeg is true. */
  ffmpegArgs?: string;
}

export interface RelayStatus {
  destinationId: string;
  name: string;
  status: "idle" | "live" | "error";
  error?: string;
  restartCount: number;
  bitrateKbps: number;
}

/** Reserved RTMP stream key for internal slate injector — encoders must not use this key. */
export const SLATE_RTMP_STREAM_KEY = "_bc_slate";

/** OBS disconnect fallback: FFmpeg publishes this media to local ingest while relays stay live. */
export interface StreamFallbackSlate {
  enabled: boolean;
  mediaPath: string;
  gracePeriodMs: number;
}

export const SLATE_GRACE_PERIOD_MS_DEFAULT = 2000;
export const SLATE_GRACE_PERIOD_MS_MIN = 0;
export const SLATE_GRACE_PERIOD_MS_MAX = 60000;

export interface Profile {
  id: string;
  name: string;
  port: number;
  autoStart: boolean;
  destinations: Destination[];
  streamFallbackSlate?: StreamFallbackSlate;
}

export interface ProfileStatus {
  profileId: string;
  profileName: string;
  port: number;
  autoStart: boolean;
  serverRunning: boolean;
  /** True when OBS (or another encoder) is publishing to ingest — excludes internal slate publisher. */
  streamActive: boolean;
  pushing: boolean;
  /** True when relays are pulling the slate injector stream instead of OBS. */
  slateActive: boolean;
  streamFallbackSlate?: StreamFallbackSlate;
  relays: RelayStatus[];
  destinations: Destination[];
}

// Inbound commands from Rust via stdin
export type InboundCommand =
  | { cmd: "create_profile"; profile: Profile }
  | { cmd: "update_profile"; profile: Profile }
  | { cmd: "delete_profile"; profileId: string }
  | { cmd: "start_server"; profileId: string }
  | { cmd: "stop_server"; profileId: string }
  | { cmd: "add_destination"; profileId: string; destination: Destination }
  | { cmd: "remove_destination"; profileId: string; id: string }
  | { cmd: "update_destination"; profileId: string; destination: Destination }
  | { cmd: "push_destinations"; profileId: string }
  | { cmd: "stop_pushing"; profileId: string }
  | { cmd: "get_status" }
  | { cmd: "set_debug_mode"; enabled: boolean }
  | { cmd: "shutdown" };

// Outbound events to Rust via stdout
export type OutboundEvent =
  | { event: "server_started"; profileId: string; port: number }
  | { event: "server_stopped"; profileId: string }
  | { event: "server_error"; profileId: string; error: string }
  | { event: "stream_connected"; profileId: string; streamKey: string }
  | { event: "stream_disconnected"; profileId: string; streamKey: string }
  | { event: "relay_started"; profileId: string; destinationId: string }
  | {
      event: "relay_stopped";
      profileId: string;
      destinationId: string;
      reason: string;
    }
  | { event: "relay_error"; profileId: string; destinationId: string; error: string }
  | {
      event: "status";
      profiles: ProfileStatus[];
      debugMode: boolean;
    }
  | { event: "destinations_updated"; profileId: string; destinations: Destination[] }
  | { event: "debug_log"; source: string; message: string; timestamp: number }
  | { event: "relay_stats"; profileId: string; relays: RelayStatus[] }
  | { event: "ready" }
  | { event: "error"; error: string }
  | { event: "all_servers_stopped" };

export interface AppConfig {
  debugMode: boolean;
  profiles: Profile[];
}
