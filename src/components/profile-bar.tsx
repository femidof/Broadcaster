import { useState } from "react";
import { Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { ProfileStatus } from "@/lib/types";

interface ProfileBarProps {
  profiles: ProfileStatus[];
  selectedId: string | null;
  onSelect: (profileId: string) => void;
  onCreateProfile: (name: string, port: number) => void;
}

export function ProfileBar({
  profiles,
  selectedId,
  onSelect,
  onCreateProfile,
}: ProfileBarProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [newName, setNewName] = useState("Profile");
  const [newPort, setNewPort] = useState(() => {
    const max = profiles.reduce((m, p) => Math.max(m, p.port), 1935);
    return Math.min(max + 1, 65535);
  });

  function openDialog() {
    const max = profiles.reduce((m, p) => Math.max(m, p.port), 1935);
    setNewPort(Math.min(max + 1, 65535));
    setNewName(`Profile ${profiles.length + 1}`);
    setDialogOpen(true);
  }

  function submitNew() {
    const port = parseInt(String(newPort), 10);
    if (isNaN(port) || port < 1024 || port > 65535) return;
    const name = newName.trim() || "Profile";
    onCreateProfile(name, port);
    setDialogOpen(false);
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <span className="text-xs font-medium text-muted-foreground shrink-0">
          Profile
        </span>
        <div className="flex flex-wrap items-center gap-1.5 min-w-0">
          {profiles.map((p) => (
            <button
              key={p.profileId}
              type="button"
              onClick={() => onSelect(p.profileId)}
              className={cn(
                "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer max-w-[140px] truncate",
                selectedId === p.profileId
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-transparent bg-muted/50 text-muted-foreground hover:bg-muted"
              )}
              title={p.profileName}
            >
              {p.serverRunning ? "● " : "○ "}
              {p.profileName}
            </button>
          ))}
        </div>
        <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={openDialog}>
          <Plus className="h-3.5 w-3.5" />
          New
        </Button>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent onClose={() => setDialogOpen(false)}>
          <DialogHeader>
            <DialogTitle>New profile</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="space-y-2">
              <Label htmlFor="new-profile-name">Name</Label>
              <Input
                id="new-profile-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-profile-port">RTMP port</Label>
              <Input
                id="new-profile-port"
                type="number"
                min={1024}
                max={65535}
                value={newPort}
                onChange={(e) => setNewPort(Number(e.target.value))}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="button" onClick={submitNew}>
                Create
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
