import { useEffect, useState } from "react";
import { RefreshCw, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  type ProfileStatus,
  type StreamFallbackSlate,
  SLATE_GRACE_PERIOD_MS_DEFAULT,
  SLATE_GRACE_PERIOD_MS_MAX,
  SLATE_GRACE_PERIOD_MS_MIN,
  SLATE_RTMP_STREAM_KEY,
} from "@/lib/types";
import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-dialog";

interface SettingsPanelProps {
  selectedProfile: ProfileStatus | null;
  canDeleteProfile: boolean;
  onProfileNameChange: (name: string) => void;
  onPortChange: (port: number) => void;
  onAutoStartChange: (autoStart: boolean) => void;
  onDeleteProfile: () => void;
  onStreamFallbackSlateChange: (slate: StreamFallbackSlate) => void;
  debugMode: boolean;
  onDebugModeChange: (enabled: boolean) => void;
  onCheckUpdates: () => void;
}

function clampGraceMs(n: number): number {
  return Math.min(
    SLATE_GRACE_PERIOD_MS_MAX,
    Math.max(SLATE_GRACE_PERIOD_MS_MIN, Math.round(n))
  );
}

function StreamFallbackCard({
  slate,
  onChange,
}: {
  slate: StreamFallbackSlate | undefined;
  onChange: (next: StreamFallbackSlate) => void;
}) {
  const effective: StreamFallbackSlate =
    slate ?? {
      enabled: false,
      mediaPath: "",
      gracePeriodMs: SLATE_GRACE_PERIOD_MS_DEFAULT,
    };

  const [graceDraft, setGraceDraft] = useState(() =>
    String(slate?.gracePeriodMs ?? SLATE_GRACE_PERIOD_MS_DEFAULT)
  );

  async function handleBrowse() {
    try {
      const selected = await open({
        multiple: false,
        filters: [
          {
            name: "Image or video",
            extensions: [
              "png",
              "jpg",
              "jpeg",
              "webp",
              "gif",
              "mp4",
              "mov",
              "mkv",
              "webm",
              "m4v",
            ],
          },
        ],
      });
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (typeof path === "string" && path.length > 0) {
        onChange({
          ...effective,
          enabled: true,
          mediaPath: path,
        });
      }
    } catch {
      /* dialog unavailable outside Tauri */
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Stream fallback slate</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5 flex-1 min-w-0">
            <Label>Enable fallback when OBS disconnects</Label>
            <p className="text-xs text-muted-foreground">
              After the grace period, Broadcaster publishes your chosen image or video to local ingest
              so relays stay live until OBS reconnects (only while you are already pushing).
            </p>
          </div>
          <Switch
            checked={effective.enabled}
            onCheckedChange={(checked) =>
              onChange({
                ...effective,
                enabled: checked,
              })
            }
          />
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5 flex-1 min-w-0">
            <Label>Grace period (ms)</Label>
            <p className="text-xs text-muted-foreground">
              Wait this long after OBS stops before starting fallback ({SLATE_GRACE_PERIOD_MS_MIN}–
              {SLATE_GRACE_PERIOD_MS_MAX} ms). Brief drops may reconnect without slate.
            </p>
          </div>
          <Input
            className="w-28 text-right tabular-nums"
            type="number"
            min={SLATE_GRACE_PERIOD_MS_MIN}
            max={SLATE_GRACE_PERIOD_MS_MAX}
            value={graceDraft}
            onChange={(e) => setGraceDraft(e.target.value)}
            onBlur={() => {
              const parsed = parseInt(graceDraft, 10);
              const next = clampGraceMs(
                Number.isNaN(parsed) ? effective.gracePeriodMs : parsed
              );
              setGraceDraft(String(next));
              if (next !== effective.gracePeriodMs) {
                onChange({ ...effective, gracePeriodMs: next });
              }
            }}
          />
        </div>

        <div className="space-y-2">
          <Label>Fallback media file</Label>
          <div className="flex gap-2">
            <Input
              className="font-mono text-xs flex-1 min-w-0"
              readOnly
              placeholder="Pick an image or video file…"
              value={effective.mediaPath}
            />
            <Button type="button" variant="secondary" size="sm" onClick={() => void handleBrowse()}>
              Browse…
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Still images (PNG, JPG, …) or video (MP4, MOV, …). Uses bundled FFmpeg to encode for RTMP.
          </p>
        </div>

        <p className="text-xs text-amber-700 dark:text-amber-400 border border-amber-500/30 rounded-md p-2 bg-amber-500/5">
          <strong className="text-foreground">Reserved stream key:</strong> Do not set your encoder
          stream key to{" "}
          <code className="rounded bg-muted px-1 font-mono">{SLATE_RTMP_STREAM_KEY}</code> — Broadcaster
          uses it internally for fallback.
        </p>
      </CardContent>
    </Card>
  );
}

function ProfileSettingsFields({
  profile,
  canDeleteProfile,
  onProfileNameChange,
  onPortChange,
  onAutoStartChange,
  onDeleteProfile,
}: {
  profile: ProfileStatus;
  canDeleteProfile: boolean;
  onProfileNameChange: (name: string) => void;
  onPortChange: (port: number) => void;
  onAutoStartChange: (autoStart: boolean) => void;
  onDeleteProfile: () => void;
}) {
  const [portInput, setPortInput] = useState(String(profile.port));
  const [nameInput, setNameInput] = useState(profile.profileName);

  function handlePortBlur() {
    const parsed = parseInt(portInput, 10);
    if (!isNaN(parsed) && parsed >= 1024 && parsed <= 65535) {
      onPortChange(parsed);
    } else {
      setPortInput(String(profile.port));
    }
  }

  function handleNameBlur() {
    const next = nameInput.trim();
    if (next.length > 0 && next !== profile.profileName) {
      onProfileNameChange(next);
    } else {
      setNameInput(profile.profileName);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Profile</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5 flex-1 min-w-0">
            <Label>Profile name</Label>
            <p className="text-xs text-muted-foreground">
              Shown in the profile bar
            </p>
          </div>
          <Input
            className="max-w-[200px]"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onBlur={handleNameBlur}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleNameBlur();
            }}
          />
        </div>

        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label>RTMP Ingest Port</Label>
            <p className="text-xs text-muted-foreground">
              Port for OBS on this profile (1024-65535)
            </p>
          </div>
          <Input
            className="w-24 text-right"
            value={portInput}
            onChange={(e) => setPortInput(e.target.value)}
            onBlur={handlePortBlur}
            onKeyDown={(e) => {
              if (e.key === "Enter") handlePortBlur();
            }}
          />
        </div>

        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label>Auto-start server</Label>
            <p className="text-xs text-muted-foreground">
              Start this profile&apos;s RTMP server when the app launches
            </p>
          </div>
          <Switch
            checked={profile.autoStart}
            onCheckedChange={onAutoStartChange}
          />
        </div>

        {canDeleteProfile ? (
          <div className="pt-2 border-t">
            <Button
              type="button"
              variant="destructive"
              size="sm"
              className="gap-2"
              onClick={onDeleteProfile}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete this profile
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function SettingsPanel({
  selectedProfile,
  canDeleteProfile,
  onProfileNameChange,
  onPortChange,
  onAutoStartChange,
  onDeleteProfile,
  onStreamFallbackSlateChange,
  debugMode,
  onDebugModeChange,
  onCheckUpdates,
}: SettingsPanelProps) {
  const [appVersion, setAppVersion] = useState<string>("2.2.0");

  useEffect(() => {
    getVersion()
      .then((v) => setAppVersion(v))
      .catch(() => {
        // ignore (e.g. running outside tauri)
      });
  }, []);

  if (!selectedProfile) {
    return (
      <p className="text-sm text-muted-foreground">
        No profile selected. Create a profile from the bar above.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <ProfileSettingsFields
        key={`${selectedProfile.profileId}-${selectedProfile.port}-${selectedProfile.profileName}-${selectedProfile.autoStart}`}
        profile={selectedProfile}
        canDeleteProfile={canDeleteProfile}
        onProfileNameChange={onProfileNameChange}
        onPortChange={onPortChange}
        onAutoStartChange={onAutoStartChange}
        onDeleteProfile={onDeleteProfile}
      />

      <StreamFallbackCard
        key={`slate-${selectedProfile.profileId}-${JSON.stringify(selectedProfile.streamFallbackSlate ?? null)}`}
        slate={selectedProfile.streamFallbackSlate}
        onChange={onStreamFallbackSlateChange}
      />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Debug</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Debug Mode</Label>
              <p className="text-xs text-muted-foreground">
                Show diagnostic output for troubleshooting
              </p>
            </div>
            <Switch checked={debugMode} onCheckedChange={onDebugModeChange} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">About</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Broadcaster</p>
              <p className="text-xs text-muted-foreground">Version {appVersion}</p>
            </div>
            <Button variant="outline" size="sm" onClick={onCheckUpdates}>
              <RefreshCw className="h-3.5 w-3.5" />
              Check for Updates
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Usage</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>
              <strong className="text-foreground">OBS Setup:</strong> In OBS, go
              to Settings &gt; Stream. Set Service to &quot;Custom&quot;, Server to{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                rtmp://localhost:{selectedProfile.port}/live
              </code>
              , and Stream Key to{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                stream
              </code>
              .
            </p>
            <p>
              <strong className="text-foreground">Profiles:</strong> Each profile
              uses its own port so you can run multiple ingest servers at once (for
              example backup or split distribution). Switch profiles with the bar
              under the title bar.
            </p>
            <p>
              <strong className="text-foreground">How it works:</strong>{" "}
              Broadcaster receives your stream locally and re-broadcasts it to all
              enabled destinations for that profile using a built-in RTMP relay
              client.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
