import type { Destination } from "@/lib/types";

export type ReliabilityFix = {
  title: string;
  summary: string;
  bullets: string[];
};

function includesAny(haystack: string, needles: string[]): boolean {
  const h = haystack.toLowerCase();
  return needles.some((n) => h.includes(n.toLowerCase()));
}

export function getReliabilityFix(
  platform: Destination["platform"],
  errorString: string
): ReliabilityFix {
  const e = (errorString || "").trim();
  const eLower = e.toLowerCase();

  const base: ReliabilityFix = {
    title: "Connection issue",
    summary: e || "Unknown relay error",
    bullets: [
      "Re-copy the ingest URL and stream key (hidden whitespace is common).",
      "Verify the live session is created/eligible on the destination platform.",
      "If you’re on a restricted network, try another network (DNS/firewall/VPN can block RTMP/RTMPS).",
    ],
  };

  // TLS / RTMPS / certificate-like errors
  if (
    includesAny(eLower, [
      "tls",
      "ssl",
      "handshake",
      "certificate",
      "wrong version number",
      "alert",
      "sni",
      "rtmps",
    ])
  ) {
    return {
      title: "TLS / RTMPS problem",
      summary: e,
      bullets: [
        "If the platform provides an RTMPS ingest URL, use `rtmps://...` rather than `rtmp://...`.",
        "Try copying the URL directly from the platform’s live dashboard to avoid outdated endpoints.",
        "If you’re behind a proxy/VPN, disable it and retry.",
      ],
    };
  }

  // Auth / key rejected / publish denied
  if (
    includesAny(eLower, [
      "auth",
      "unauthorized",
      "forbidden",
      "denied",
      "rejected",
      "invalid key",
      "bad key",
      "permission",
      "publish",
      "403",
      "401",
    ])
  ) {
    const bullets = [
      "Re-copy the stream key and confirm it matches the live session you created.",
      "Check that your account has RTMP streaming access enabled on the platform.",
      "If you recently rotated keys, update the destination with the new key.",
    ];

    if (platform === "tiktok") {
      bullets.unshift("TikTok stream keys often change per Live session. Refresh the key for your current Live.");
    }

    return {
      title: "Authentication / stream key rejected",
      summary: e,
      bullets,
    };
  }

  // Network timeouts / unreachable
  if (includesAny(eLower, ["timeout", "timed out", "econnreset", "econnrefused", "unreachable", "reset"])) {
    return {
      title: "Network connectivity problem",
      summary: e,
      bullets: [
        "Confirm the ingest hostname resolves (DNS) and the port is reachable from your network.",
        "Try a different network (mobile hotspot) to rule out firewall restrictions.",
        "If the platform has multiple ingest regions, try another endpoint.",
      ],
    };
  }

  // Generic platform-specific hint
  if (platform === "tiktok") {
    return {
      ...base,
      title: "TikTok connection issue",
      bullets: [
        "TikTok keys often change per Live session — refresh URL/key for your current Live.",
        "Confirm RTMP access is enabled in TikTok Live Center for this account.",
        ...base.bullets,
      ],
    };
  }

  if (platform === "instagram") {
    return {
      ...base,
      title: "Instagram connection issue",
      bullets: [
        "Use the RTMPS URL from your Instagram live tool/dashboard (endpoints can vary).",
        ...base.bullets,
      ],
    };
  }

  return base;
}

