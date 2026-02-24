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
    | "custom";
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
  debugMode: boolean;
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
      debugMode: boolean;
    }
  | { event: "destinations_updated"; destinations: Destination[] }
  | { event: "debug_log"; source: string; message: string; timestamp: number }
  | { event: "sidecar_error"; error: string }
  | { event: "error"; error: string };

export type PlatformPreset = {
  url: string;
  label: string;
  urlHint?: string;
};

export const PLATFORM_PRESETS: Record<
  Exclude<Destination["platform"], "custom">,
  PlatformPreset
> = {
  twitch: {
    url: "rtmp://live.twitch.tv/app/",
    label: "Twitch",
  },
  youtube: {
    url: "rtmp://a.rtmp.youtube.com/live2/",
    label: "YouTube",
  },
  facebook: {
    url: "rtmps://live-api-s.facebook.com:443/rtmp/",
    label: "Facebook Live",
    urlHint: "If this does not work, paste the stream URL from Facebook Live Producer.",
  },
  instagram: {
    url: "rtmps://live-upload.instagram.com:443/rtmp/",
    label: "Instagram Live",
    urlHint:
      "If this does not work, paste the stream URL from your Instagram live dashboard/tool.",
  },
  tiktok: {
    url: "rtmps://push-rtmp-global.tiktok.com/live/",
    label: "TikTok Live",
    urlHint: "If this does not work, paste the stream URL from TikTok Live Center.",
  },
  trovo: {
    url: "rtmp://livepush.trovo.live/live/",
    label: "Trovo",
  },
  kick: {
    url: "rtmps://fa723fc1b171.global-contribute.live-video.net:443/app/",
    label: "Kick",
  },
  restream: {
    url: "rtmp://live.restream.io/live/",
    label: "Restream",
  },
};
