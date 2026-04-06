import { Radio, Send, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { DebugPanel, type DebugLogEntry } from "@/components/debug-panel";

const tabs = [
  { id: "dashboard" as const, label: "Dashboard", icon: Radio },
  { id: "destinations" as const, label: "Destinations", icon: Send },
  { id: "settings" as const, label: "Settings", icon: Settings },
];

export type TabId = (typeof tabs)[number]["id"];

interface LayoutProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  children: React.ReactNode;
  profileBar?: React.ReactNode;
  debugMode?: boolean;
  debugLogs?: DebugLogEntry[];
  onClearDebugLogs?: () => void;
}

export function Layout({
  activeTab,
  onTabChange,
  children,
  profileBar,
  debugMode = false,
  debugLogs = [],
  onClearDebugLogs,
}: LayoutProps) {
  return (
    <div className="flex h-screen flex-col">
      {/* Header */}
      <header className="flex h-12 items-center border-b px-4" data-tauri-drag-region>
        <div className="flex items-center gap-2">
          <Radio className="h-5 w-5 text-primary" />
          <span className="text-sm font-semibold">Broadcaster</span>
        </div>
      </header>

      <div className="flex flex-1 flex-col overflow-hidden min-h-0">
        {profileBar}
        <div className="flex flex-1 overflow-hidden min-h-0">
        {/* Sidebar Nav */}
        <nav className="flex w-48 flex-col border-r p-2 shrink-0">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => onTabChange(tab.id)}
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors cursor-pointer",
                  activeTab === tab.id
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                )}
              >
                <Icon className="h-4 w-4" />
                {tab.label}
              </button>
            );
          })}
        </nav>

        {/* Main Content */}
        <main className="flex-1 overflow-y-auto p-6 min-w-0">
          {children}
          {debugMode && (
            <div className="mt-6">
              <DebugPanel logs={debugLogs} onClear={() => onClearDebugLogs?.()} />
            </div>
          )}
        </main>
        </div>
      </div>
    </div>
  );
}
