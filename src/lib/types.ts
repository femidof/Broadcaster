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
}

export interface RelayStatus {
  destinationId: string;
  name: string;
  status: "idle" | "live" | "error";
  error?: string;
  restartCount: number;
  bitrateKbps: number;
}

export interface Profile {
  id: string;
  name: string;
  port: number;
  autoStart: boolean;
  destinations: Destination[];
}

export interface ProfileStatus {
  profileId: string;
  profileName: string;
  port: number;
  autoStart: boolean;
  serverRunning: boolean;
  streamActive: boolean;
  pushing: boolean;
  relays: RelayStatus[];
  destinations: Destination[];
}

/** Full app state from the sidecar (all profiles + global debug). */
export interface AppStatus {
  profiles: ProfileStatus[];
  debugMode: boolean;
}

export type SidecarEvent =
  | { event: "ready" }
  | { event: "server_started"; profileId: string; port: number }
  | { event: "server_stopped"; profileId: string }
  | { event: "all_servers_stopped" }
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
  bigo: {
    url: "rtmp://",
    label: "BIGO LIVE",
    urlHint: "Paste the RTMP URL from BIGO LIVE stream settings.",
  },
};

/** Dashboard-style view of one profile (subset of ProfileStatus fields used by UI). */
export type DashboardStatus = Pick<
  ProfileStatus,
  | "serverRunning"
  | "port"
  | "streamActive"
  | "pushing"
  | "relays"
  | "destinations"
>;
