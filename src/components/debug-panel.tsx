import { useRef, useEffect } from "react";
import { Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export interface DebugLogEntry {
  id: number;
  source: string;
  message: string;
  timestamp: number;
  level: "info" | "warn" | "error";
}

interface DebugPanelProps {
  logs: DebugLogEntry[];
  onClear: () => void;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function LevelBadge({ level }: { level: DebugLogEntry["level"] }) {
  switch (level) {
    case "error":
      return <Badge variant="destructive">ERR</Badge>;
    case "warn":
      return <Badge variant="warning">WRN</Badge>;
    default:
      return <Badge variant="secondary">INF</Badge>;
  }
}

export function DebugPanel({ logs, onClear }: DebugPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs.length]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Debug Output</CardTitle>
          <Button variant="ghost" size="sm" onClick={onClear}>
            <Trash2 className="h-3.5 w-3.5 mr-1" />
            Clear
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div
          ref={scrollRef}
          className="h-64 overflow-y-auto rounded-md border bg-muted/30 p-2 font-mono text-xs"
        >
          {logs.length === 0 ? (
            <p className="py-8 text-center text-muted-foreground text-xs">
              No debug output yet. Diagnostics will appear here when events
              occur.
            </p>
          ) : (
            <div className="space-y-1">
              {logs.map((entry) => (
                <div key={entry.id} className="flex items-start gap-2">
                  <span className="shrink-0 text-muted-foreground">
                    {formatTime(entry.timestamp)}
                  </span>
                  <LevelBadge level={entry.level} />
                  <span className="shrink-0 text-muted-foreground">
                    [{entry.source}]
                  </span>
                  <span className="break-all whitespace-pre-wrap">
                    {entry.message}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
