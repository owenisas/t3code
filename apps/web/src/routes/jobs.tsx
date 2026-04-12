import { CalendarClockIcon } from "lucide-react";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { ScheduledJobsPanel } from "../components/settings/SettingsPanels";
import {
  ensurePrimaryEnvironmentReady,
  resolveInitialServerAuthGateState,
} from "../environments/primary";
import { SidebarInset, SidebarTrigger } from "../components/ui/sidebar";
import { isElectron } from "../env";

function JobsRouteView() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {!isElectron && (
          <header className="border-b border-border px-3 py-2 sm:px-5">
            <div className="flex items-center gap-2">
              <SidebarTrigger className="size-7 shrink-0 md:hidden" />
              <CalendarClockIcon className="size-4 text-muted-foreground" />
              <span className="text-sm font-medium text-foreground">Jobs</span>
            </div>
          </header>
        )}

        {isElectron && (
          <div className="drag-region flex h-[52px] shrink-0 items-center gap-2 border-b border-border px-5">
            <CalendarClockIcon className="size-3.5 text-muted-foreground/70" />
            <span className="text-xs font-medium tracking-wide text-muted-foreground/70">Jobs</span>
          </div>
        )}

        <div className="min-h-0 flex flex-1 flex-col">
          <ScheduledJobsPanel />
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/jobs")({
  beforeLoad: async () => {
    const [, authGateState] = await Promise.all([
      ensurePrimaryEnvironmentReady(),
      resolveInitialServerAuthGateState(),
    ]);
    if (authGateState.status !== "authenticated") {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: JobsRouteView,
});
