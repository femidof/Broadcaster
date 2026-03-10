import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { DestinationCard } from "@/components/destination-card";
import type { Destination, RelayStatus } from "@/lib/types";
import { PLATFORM_PRESETS } from "@/lib/types";
import type { featureFlags } from "@/lib/feature-flags";
import { ConnectionDoctor } from "@/components/reliability/connection-doctor";

interface DestinationsPanelProps {
  destinations: Destination[];
  relays: RelayStatus[];
  onAdd: (dest: Destination) => void;
  onUpdate: (dest: Destination) => void;
  onRemove: (id: string) => void;
  featureFlags: typeof featureFlags;
}

function generateId(): string {
  return crypto.randomUUID();
}

const EMPTY_DESTINATION: Destination = {
  id: "",
  name: "",
  platform: "custom",
  url: "",
  streamKey: "",
  enabled: true,
};

export function DestinationsPanel({
  destinations,
  relays,
  onAdd,
  onUpdate,
  onRemove,
  featureFlags,
}: DestinationsPanelProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [doctorOpen, setDoctorOpen] = useState(false);
  const [editing, setEditing] = useState<Destination | null>(null);
  const [form, setForm] = useState<Destination>({ ...EMPTY_DESTINATION });
  const selectedPreset =
    form.platform !== "custom" ? PLATFORM_PRESETS[form.platform] : undefined;

  function openAdd() {
    setEditing(null);
    setForm({ ...EMPTY_DESTINATION, id: generateId() });
    setDialogOpen(true);
  }

  function openEdit(dest: Destination) {
    setEditing(dest);
    setForm({ ...dest });
    setDialogOpen(true);
  }

  function handlePlatformChange(platform: string) {
    const p = platform as Destination["platform"];
    const newForm = { ...form, platform: p };

    if (p !== "custom") {
      const preset = PLATFORM_PRESETS[p];
      if (preset) {
        if (preset.url) {
          newForm.url = preset.url;
        }
        if (!newForm.name) {
          newForm.name = preset.label;
        }
      }
    }

    setForm(newForm);
  }

  function handleSave() {
    if (!form.name.trim() || !form.url.trim() || !form.streamKey.trim()) return;

    if (editing) {
      onUpdate(form);
    } else {
      onAdd(form);
    }
    setDialogOpen(false);
  }

  function getRelayStatus(destId: string): RelayStatus | undefined {
    return relays.find((r) => r.destinationId === destId);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Destinations</h2>
        <Button size="sm" onClick={openAdd}>
          <Plus className="h-4 w-4" />
          Add Destination
        </Button>
      </div>

      {destinations.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed p-8 text-center">
          <p className="text-sm text-muted-foreground">
            No destinations configured yet.
          </p>
          <Button variant="outline" size="sm" className="mt-4" onClick={openAdd}>
            <Plus className="h-4 w-4" />
            Add your first destination
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {destinations.map((dest) => (
            <DestinationCard
              key={dest.id}
              destination={dest}
              relayStatus={getRelayStatus(dest.id)}
              onToggle={(enabled) => onUpdate({ ...dest, enabled })}
              onEdit={() => openEdit(dest)}
              onRemove={() => onRemove(dest.id)}
            />
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent onClose={() => setDialogOpen(false)}>
          <DialogHeader>
            <DialogTitle>
              {editing ? "Edit Destination" : "Add Destination"}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="platform">Platform</Label>
                {featureFlags.reliabilitySuite ? (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-xs"
                    onClick={() => setDoctorOpen(true)}
                  >
                    Guided setup
                  </Button>
                ) : null}
              </div>
              <Select
                id="platform"
                value={form.platform}
                onValueChange={handlePlatformChange}
              >
                {Object.entries(PLATFORM_PRESETS).map(([platform, preset]) => (
                  <option key={platform} value={platform}>
                    {preset.label}
                  </option>
                ))}
                <option value="custom">Custom RTMP</option>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                placeholder="e.g. My Twitch Channel"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="url">RTMP URL</Label>
              <Input
                id="url"
                placeholder="rtmp://..."
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
              />
              {selectedPreset?.urlHint ? (
                <p className="text-xs text-muted-foreground">
                  {selectedPreset.urlHint}
                </p>
              ) : null}
            </div>

            <div className="space-y-2">
              <Label htmlFor="streamKey">Stream Key</Label>
              <Input
                id="streamKey"
                type="password"
                placeholder="Your stream key"
                value={form.streamKey}
                onChange={(e) =>
                  setForm({ ...form, streamKey: e.target.value })
                }
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={
                !form.name.trim() || !form.url.trim() || !form.streamKey.trim()
              }
            >
              {editing ? "Save Changes" : "Add Destination"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {featureFlags.reliabilitySuite ? (
        <ConnectionDoctor
          open={doctorOpen}
          onOpenChange={setDoctorOpen}
          platform={form.platform}
          url={form.url}
          streamKey={form.streamKey}
          onApply={(fix) => {
            setForm((prev) => ({
              ...prev,
              url: fix.url ?? prev.url,
              streamKey: fix.streamKey ?? prev.streamKey,
            }));
          }}
        />
      ) : null}
    </div>
  );
}
