import { useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, ExternalLink, Wand2 } from "lucide-react";
import type { Destination } from "@/lib/types";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type DoctorStepId = "eligibility" | "url" | "key" | "common";

type DoctorFix = {
  url?: string;
  streamKey?: string;
};

function normalizeUrl(url: string): string {
  return url.trim();
}

function normalizeStreamKey(key: string): string {
  return key.trim();
}

function inferIssues(platform: Destination["platform"], url: string, streamKey: string): string[] {
  const issues: string[] = [];
  const u = url.trim();
  const k = streamKey.trim();

  if (!u) issues.push("Missing RTMP/RTMPS URL.");
  if (!k) issues.push("Missing stream key.");
  if (u && !/^rtmps?:\/\//i.test(u)) issues.push("URL should start with rtmp:// or rtmps://.");

  if ((platform === "tiktok" || platform === "instagram") && u && /^rtmp:\/\//i.test(u)) {
    issues.push("This platform commonly requires RTMPS. Try an rtmps:// ingest URL if available.");
  }

  if (platform === "tiktok") {
    issues.push("TikTok stream keys often change per Live session. Refresh the key for each new Live.");
  }

  if (u && /\s/.test(u)) issues.push("URL contains whitespace. Remove spaces/newlines.");
  if (k && /\s/.test(k)) issues.push("Stream key contains whitespace. Remove spaces/newlines.");

  return issues;
}

function platformLabel(platform: Destination["platform"]): string {
  switch (platform) {
    case "tiktok":
      return "TikTok Live";
    case "instagram":
      return "Instagram Live";
    case "bigo":
      return "Bigo Live";
    case "youtube":
      return "YouTube";
    case "twitch":
      return "Twitch";
    case "facebook":
      return "Facebook Live";
    case "trovo":
      return "Trovo";
    case "kick":
      return "Kick";
    case "restream":
      return "Restream";
    default:
      return "Custom RTMP";
  }
}

function platformGuidance(platform: Destination["platform"]): { title: string; bullets: string[] } {
  if (platform === "tiktok") {
    return {
      title: "TikTok guidance",
      bullets: [
        "Confirm your account has RTMP streaming access in TikTok Live Center.",
        "Use the RTMPS ingest URL and the stream key for the specific Live you created.",
        "If it worked earlier but fails now, refresh the key for your current Live session.",
      ],
    };
  }
  if (platform === "instagram") {
    return {
      title: "Instagram guidance",
      bullets: [
        "Instagram RTMP access varies by account and tool. Use the RTMPS URL provided by your live dashboard.",
        "If the URL/key pair is copied from a web UI, re-copy to avoid hidden whitespace.",
        "If you get immediate auth failures, verify the live session is created and eligible.",
      ],
    };
  }
  if (platform === "bigo") {
    return {
      title: "Bigo guidance",
      bullets: [
        "Bigo streaming credentials may be session-based. Confirm you’re using the latest ingest URL/key.",
        "If you see timeouts, try a different network/VPN-off and re-check the ingest endpoint.",
      ],
    };
  }
  return {
    title: "General guidance",
    bullets: [
      "Double-check the ingest URL and stream key; most failures are copy/paste or eligibility issues.",
      "If the platform provides multiple ingest regions, try another region endpoint.",
      "If you’re on a restricted network, DNS/firewall can block outbound RTMP/RTMPS.",
    ],
  };
}

export function ConnectionDoctor({
  open,
  onOpenChange,
  platform,
  url,
  streamKey,
  onApply,
  onOpenExternalHelp,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  platform: Destination["platform"];
  url: string;
  streamKey: string;
  onApply?: (fix: DoctorFix) => void;
  onOpenExternalHelp?: () => void;
}) {
  const [step, setStep] = useState<DoctorStepId>("eligibility");
  const [urlDraft, setUrlDraft] = useState(url);
  const [keyDraft, setKeyDraft] = useState(streamKey);

  const issues = useMemo(
    () => inferIssues(platform, urlDraft, keyDraft),
    [platform, urlDraft, keyDraft]
  );

  const guidance = useMemo(() => platformGuidance(platform), [platform]);

  const normalized = useMemo(() => {
    const nextUrl = normalizeUrl(urlDraft);
    const nextKey = normalizeStreamKey(keyDraft);
    return {
      url: nextUrl,
      streamKey: nextKey,
      changed: nextUrl !== urlDraft || nextKey !== keyDraft,
    };
  }, [urlDraft, keyDraft]);

  const canApply = Boolean(onApply) && (normalized.changed || urlDraft !== url || keyDraft !== streamKey);

  function applyFixes() {
    if (!onApply) return;
    onApply({ url: normalized.url, streamKey: normalized.streamKey });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (next) {
          setStep("eligibility");
          setUrlDraft(url);
          setKeyDraft(streamKey);
        }
      }}
    >
      <DialogContent onClose={() => onOpenChange(false)}>
        <DialogHeader>
          <DialogTitle>Connection Doctor</DialogTitle>
        </DialogHeader>

        <div className="flex items-center justify-between gap-3 mb-4">
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{platformLabel(platform)}</p>
            <p className="text-xs text-muted-foreground">
              Guided checks for common RTMP/RTMPS issues.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {issues.length === 0 ? (
              <Badge variant="success" className="gap-1">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Looks good
              </Badge>
            ) : (
              <Badge variant="warning" className="gap-1">
                <AlertCircle className="h-3.5 w-3.5" />
                Needs review
              </Badge>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-2 mb-4">
          {(
            [
              ["eligibility", "Eligibility"],
              ["url", "URL"],
              ["key", "Key"],
              ["common", "Common fixes"],
            ] as const
          ).map(([id, label]) => (
            <Button
              key={id}
              type="button"
              variant={step === id ? "secondary" : "outline"}
              size="sm"
              onClick={() => setStep(id)}
            >
              {label}
            </Button>
          ))}
        </div>

        {step === "eligibility" && (
          <div className="space-y-3">
            <div className="rounded-lg border p-3">
              <p className="text-sm font-medium mb-1">{guidance.title}</p>
              <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1">
                {guidance.bullets.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </div>

            {platform === "tiktok" && (
              <div className="rounded-lg border p-3">
                <p className="text-sm font-medium mb-1">TikTok key rotation</p>
                <p className="text-sm text-muted-foreground">
                  If your TikTok destination fails after a successful previous stream, it’s often
                  because the stream key changed for your new Live. Refresh the URL/key for each
                  Live session.
                </p>
              </div>
            )}

            <div className="flex items-center justify-between gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setStep("url")}
              >
                Next: Check URL
              </Button>
              {onOpenExternalHelp && (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  onClick={onOpenExternalHelp}
                >
                  Open help <ExternalLink className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          </div>
        )}

        {step === "url" && (
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="doctor-url">RTMP URL</Label>
              <Input
                id="doctor-url"
                placeholder="rtmps://..."
                value={urlDraft}
                onChange={(e) => setUrlDraft(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Make sure the URL includes the correct scheme ({platform === "tiktok" || platform === "instagram" ? "often RTMPS" : "RTMP/RTMPS"}).
              </p>
            </div>

            <Button type="button" variant="outline" size="sm" onClick={() => setStep("key")}>
              Next: Check key
            </Button>
          </div>
        )}

        {step === "key" && (
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="doctor-key">Stream Key</Label>
              <Input
                id="doctor-key"
                type="password"
                placeholder="Paste the stream key"
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Avoid leading/trailing spaces. If copied from a web UI, re-copy to prevent hidden whitespace.
              </p>
            </div>

            <Button type="button" variant="outline" size="sm" onClick={() => setStep("common")}>
              Next: Common fixes
            </Button>
          </div>
        )}

        {step === "common" && (
          <div className="space-y-3">
            {issues.length === 0 ? (
              <div className="rounded-lg border p-3">
                <p className="text-sm font-medium mb-1">No obvious issues detected</p>
                <p className="text-sm text-muted-foreground">
                  If the stream still fails, the most common causes are account eligibility, an expired session key, or network restrictions.
                </p>
              </div>
            ) : (
              <div className="rounded-lg border p-3">
                <p className="text-sm font-medium mb-2">Detected issues</p>
                <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1">
                  {issues.map((i) => (
                    <li key={i}>{i}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="rounded-lg border p-3">
              <p className="text-sm font-medium mb-1">Quick actions</p>
              <div className="flex flex-wrap gap-2 mt-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setUrlDraft(normalizeUrl(urlDraft));
                    setKeyDraft(normalizeStreamKey(keyDraft));
                  }}
                >
                  <Wand2 className="h-3.5 w-3.5" />
                  Trim whitespace
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (/^rtmp:\/\//i.test(urlDraft)) {
                      setUrlDraft(urlDraft.replace(/^rtmp:\/\//i, "rtmps://"));
                    }
                  }}
                  disabled={!/^rtmp:\/\//i.test(urlDraft)}
                >
                  Switch to RTMPS
                </Button>
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {onApply && (
            <Button onClick={applyFixes} disabled={!canApply}>
              Apply to destination
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

