import { useEffect, useRef, useState } from "react";
import { RefreshCw, Trash2, AlertCircle } from "lucide-react";
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
  SLATE_STOP_AFTER_MS_DEFAULT,
  SLATE_STOP_AFTER_MS_MAX,
  SLATE_STOP_AFTER_MS_MIN,
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
  onStreamFallbackSlateChange: (slate: StreamFallbackSlate) => Promise<void>;
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

function clampStopAfterMs(n: number): number {
  return Math.min(
    SLATE_STOP_AFTER_MS_MAX,
    Math.max(SLATE_STOP_AFTER_MS_MIN, Math.round(n))
  );
}

function msToMinutes(ms: number): number {
  return Math.max(1, Math.round(ms / 60_000));
}

function minutesToMs(m: number): number {
  return m * 60_000;
}

function StreamFallbackCard({
  slate,
  onChange,
}: {
  slate: StreamFallbackSlate | undefined;
  onChange: (next: StreamFallbackSlate) => Promise<void>;
}) {
  const defaults: StreamFallbackSlate = {
    enabled: false,
    mediaPath: "",
    sourceMode: "slate_only",
    gracePeriodMs: SLATE_GRACE_PERIOD_MS_DEFAULT,
    durationMode: "indefinite",
    stopAfterMs: SLATE_STOP_AFTER_MS_DEFAULT,
  };
  const effective = slate ?? defaults;

  const [draft, setDraft] = useState<StreamFallbackSlate>(effective);
  const [graceDraft, setGraceDraft] = useState(() =>
    String(effective.gracePeriodMs ?? SLATE_GRACE_PERIOD_MS_DEFAULT)
  );
  const [stopMinutesDraft, setStopMinutesDraft] = useState(() =>
    String(msToMinutes(effective.stopAfterMs ?? SLATE_STOP_AFTER_MS_DEFAULT))
  );
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const commitIdRef = useRef(0);

  async function commit(next: StreamFallbackSlate) {
    setDraft(next);
    setSaving(true);
    setSaveError(null);
    const id = ++commitIdRef.current;
    try {
      await onChange(next);
      if (id === commitIdRef.current) {
        setSavedAt(Date.now());
      }
    } catch (e) {
      if (id === commitIdRef.current) {
        const msg = e instanceof Error ? e.message : String(e);
        setSaveError(msg);
      }
    } finally {
      if (id === commitIdRef.current) {
        setSaving(false);
      }
    }
  }

  async function handleBrowse() {
    try {
      const selected = await open({
        multiple: false,
        filters: [
          {
            name: "Image or video",
            extensions: [
              "png", "jpg", "jpeg", "webp", "gif",
              "mp4", "mov", "mkv", "webm", "m4v",
            ],
          },
        ],
      });
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (typeof path === "string" && path.length > 0) {
        await commit({ ...draft, enabled: true, mediaPath: path });
      }
    } catch {
      /* dialog unavailable outside Tauri */
    }
  }

  const graceLabel =
    draft.sourceMode === "last_frame_then_slate"
      ? "Hold-last-frame duration (ms)"
      : "Debounce before slate (ms)";

  const graceHint =
    draft.sourceMode === "last_frame_then_slate"
      ? `How long to loop the last cached keyframe before switching to slate (${SLATE_GRACE_PERIOD_MS_MIN}–${SLATE_GRACE_PERIOD_MS_MAX} ms).`
      : `Short wait after OBS stops before activating slate (${SLATE_GRACE_PERIOD_MS_MIN}–${SLATE_GRACE_PERIOD_MS_MAX} ms). Set to 0 to switch immediately.`;

  const eligible = draft.enabled && draft.mediaPath.trim().length > 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-base">Stream fallback keepalive</CardTitle>
          <div className="text-xs text-muted-foreground">
            {saving ? "Saving…" : savedAt ? "Saved" : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md border bg-muted/30 p-3">
          <p className="text-sm font-medium">How to use fallback (quick)</p>
          <ol className="mt-1 list-decimal pl-4 text-xs text-muted-foreground space-y-1">
            <li>Pick a fallback media file and enable fallback below.</li>
            <li>Go live (push destinations) from the Dashboard.</li>
            <li>When OBS disconnects, Broadcaster keeps platforms live and streams fallback.</li>
          </ol>
        </div>

        {/* Enable toggle */}
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5 flex-1 min-w-0">
            <Label>Step 1 — Enable fallback when OBS disconnects</Label>
            <p className="text-xs text-muted-foreground">
              Keeps destination publish sockets live and streams fallback media
              until OBS reconnects (only active while you are already pushing).
            </p>
          </div>
          <Switch
            checked={draft.enabled}
            onCheckedChange={(checked) => void commit({ ...draft, enabled: checked })}
          />
        </div>

        {/* Fallback media file */}
        <div className="space-y-2">
          <Label>Step 2 — Pick fallback media</Label>
          <div className="flex gap-2">
            <Input
              className="font-mono text-xs flex-1 min-w-0"
              readOnly
              placeholder="Pick an image or video file…"
              value={draft.mediaPath}
            />
            <Button type="button" variant="secondary" size="sm" onClick={() => void handleBrowse()}>
              Browse…
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Still image (PNG, JPG …) or video (MP4, MOV …). Uses bundled FFmpeg to encode for RTMP.
          </p>
          {!eligible ? (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Choose a file and enable fallback to unlock the options below.
            </p>
          ) : null}
        </div>

        {/* Source mode */}
        <div className="space-y-2">
          <Label>Step 3 — Choose fallback behavior</Label>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                {
                  value: "slate_only" as const,
                  label: "Slate only",
                  hint: "Switch to the slate image/video immediately — simplest, most reliable",
                },
                {
                  value: "last_frame_then_slate" as const,
                  label: "Hold last frame → slate",
                  hint: "Freeze on the last keyframe briefly while the slate warms up, then switch",
                },
              ] as const
            ).map(({ value, label, hint }) => (
              <button
                key={value}
                type="button"
                disabled={!eligible || saving}
                aria-disabled={!eligible || saving}
                onClick={() => void commit({ ...draft, sourceMode: value })}
                className={`rounded-md border px-3 py-2 text-left text-xs transition-colors ${
                  draft.sourceMode === value
                    ? "border-primary bg-primary/10 text-primary"
                    : !eligible || saving
                      ? "border-border opacity-50 cursor-not-allowed"
                      : "border-border hover:border-primary/50"
                }`}
              >
                <p className="font-medium">{label}</p>
                <p className="text-muted-foreground mt-0.5">{hint}</p>
              </button>
            ))}
          </div>
        </div>

        {/* Grace period */}
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5 flex-1 min-w-0">
            <Label>{graceLabel}</Label>
            <p className="text-xs text-muted-foreground">{graceHint}</p>
          </div>
          <Input
            className="w-28 text-right tabular-nums"
            type="number"
            min={SLATE_GRACE_PERIOD_MS_MIN}
            max={SLATE_GRACE_PERIOD_MS_MAX}
            disabled={!eligible || saving}
            value={graceDraft}
            onChange={(e) => setGraceDraft(e.target.value)}
            onBlur={() => {
              const parsed = parseInt(graceDraft, 10);
              const next = clampGraceMs(
                Number.isNaN(parsed) ? draft.gracePeriodMs : parsed
              );
              setGraceDraft(String(next));
              if (next !== draft.gracePeriodMs) {
                void commit({ ...draft, gracePeriodMs: next });
              }
            }}
          />
        </div>

        {/* Duration mode */}
        <div className="space-y-2">
          <Label>Fallback duration</Label>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                {
                  value: "indefinite" as const,
                  label: "Until OBS reconnects",
                  hint: "Keep slate live as long as needed",
                },
                {
                  value: "stop_after" as const,
                  label: "Stop after N minutes",
                  hint: "End the broadcast if OBS does not return in time",
                },
              ] as const
            ).map(({ value, label, hint }) => (
              <button
                key={value}
                type="button"
                disabled={!eligible || saving}
                aria-disabled={!eligible || saving}
                onClick={() => void commit({ ...draft, durationMode: value })}
                className={`rounded-md border px-3 py-2 text-left text-xs transition-colors ${
                  draft.durationMode === value
                    ? "border-primary bg-primary/10 text-primary"
                    : !eligible || saving
                      ? "border-border opacity-50 cursor-not-allowed"
                      : "border-border hover:border-primary/50"
                }`}
              >
                <p className="font-medium">{label}</p>
                <p className="text-muted-foreground mt-0.5">{hint}</p>
              </button>
            ))}
          </div>
        </div>

        {/* Stop-after minutes — only shown when stop_after is selected */}
        {draft.durationMode === "stop_after" && (
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5 flex-1 min-w-0">
              <Label>Stop after (minutes)</Label>
              <p className="text-xs text-muted-foreground">
                Broadcaster stops pushing entirely after this many minutes on
                fallback ({Math.round(SLATE_STOP_AFTER_MS_MIN / 60_000)}–
                {Math.round(SLATE_STOP_AFTER_MS_MAX / 60_000)} min).
              </p>
            </div>
            <Input
              className="w-24 text-right tabular-nums"
              type="number"
              min={Math.round(SLATE_STOP_AFTER_MS_MIN / 60_000)}
              max={Math.round(SLATE_STOP_AFTER_MS_MAX / 60_000)}
              disabled={!eligible || saving}
              value={stopMinutesDraft}
              onChange={(e) => setStopMinutesDraft(e.target.value)}
              onBlur={() => {
                const parsed = parseInt(stopMinutesDraft, 10);
                const ms = clampStopAfterMs(
                  minutesToMs(Number.isNaN(parsed) ? msToMinutes(draft.stopAfterMs) : parsed)
                );
                setStopMinutesDraft(String(msToMinutes(ms)));
                if (ms !== draft.stopAfterMs) {
                  void commit({ ...draft, stopAfterMs: ms });
                }
              }}
            />
          </div>
        )}

        {saveError ? (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs">
            <AlertCircle className="h-4 w-4 text-destructive mt-0.5" />
            <div className="min-w-0">
              <p className="font-medium text-destructive">Couldn’t save fallback settings</p>
              <p className="text-muted-foreground break-words">{saveError}</p>
            </div>
          </div>
        ) : null}

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
  const [appVersion, setAppVersion] = useState<string>("2.2.2");

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
        key={selectedProfile.profileId}
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
