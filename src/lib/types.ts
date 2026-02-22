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

export interface AppStatus {
  serverRunning: boolean;
  port: number;
  streamActive: boolean;
  relays: RelayStatus[];
  destinations: Destination[];
}

export type SidecarEvent =
  | { event: "ready" }
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
  | { event: "error"; error: string };

export const PLATFORM_PRESETS: Record<
  "twitch" | "youtube",
  { url: string; label: string }
> = {
  twitch: {
    url: "rtmp://live.twitch.tv/app/",
    label: "Twitch",
  },
  youtube: {
    url: "rtmp://a.rtmp.youtube.com/live2/",
    label: "YouTube",
  },
};
