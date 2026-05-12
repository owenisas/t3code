import { createFileRoute, retainSearchParams, useNavigate } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime";
import type { TurnId } from "@t3tools/contracts";
import {
  type ComponentProps,
  type PointerEvent as ReactPointerEvent,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import ChatView from "../components/ChatView";
import { threadHasStarted } from "../components/ChatView.logic";
import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider";
import {
  DiffPanelHeaderSkeleton,
  DiffPanelLoadingState,
  DiffPanelShell,
  type DiffPanelMode,
} from "../components/DiffPanelShell";
import { finalizePromotedDraftThreadByRef, useComposerDraftStore } from "../composerDraftStore";
import {
  type DiffRouteSearch,
  parseDiffRouteSearch,
  stripDiffSearchParams,
  stripSplitDiffSearchParams,
  stripSplitSearchParams,
} from "../diffRouteSearch";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../rightPanelLayout";
import { selectEnvironmentState, selectThreadExistsByRef, useStore } from "../store";
import { createThreadSelectorByRef } from "../storeSelectors";
import { resolveThreadRouteRef, buildThreadRouteParams } from "../threadRoutes";
import { RightPanelSheet } from "../components/RightPanelSheet";
import { Sidebar, SidebarInset, SidebarProvider, SidebarRail } from "~/components/ui/sidebar";
import { Button } from "../components/ui/button";
import { cn } from "~/lib/utils";

const DiffPanel = lazy(() => import("../components/DiffPanel"));
const DIFF_INLINE_SIDEBAR_WIDTH_STORAGE_KEY = "chat_diff_sidebar_width";
const DIFF_INLINE_DEFAULT_WIDTH = "clamp(24rem,34vw,36rem)";
const DIFF_INLINE_SIDEBAR_MIN_WIDTH = 22 * 16;
const DIFF_INLINE_SIDEBAR_MAX_WIDTH = 256 * 16;
const COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX = 208;
const CHAT_SPLIT_RATIO_STORAGE_KEY = "chat_split_ratio";
const CHAT_SPLIT_DEFAULT_RATIO = 0.5;
const CHAT_SPLIT_MIN_PANE_WIDTH = 360;

const DiffLoadingFallback = (props: { mode: DiffPanelMode }) => {
  return (
    <DiffPanelShell mode={props.mode} header={<DiffPanelHeaderSkeleton />}>
      <DiffPanelLoadingState label="Loading diff viewer..." />
    </DiffPanelShell>
  );
};

const LazyDiffPanel = (props: { mode: DiffPanelMode }) => {
  return (
    <DiffWorkerPoolProvider>
      <Suspense fallback={<DiffLoadingFallback mode={props.mode} />}>
        <DiffPanel mode={props.mode} />
      </Suspense>
    </DiffWorkerPoolProvider>
  );
};

const LazyScopedDiffPanel = (props: ComponentProps<typeof DiffPanel>) => {
  return (
    <DiffWorkerPoolProvider>
      <Suspense fallback={<DiffLoadingFallback mode={props.mode ?? "sheet"} />}>
        <DiffPanel {...props} />
      </Suspense>
    </DiffWorkerPoolProvider>
  );
};

const DiffPanelInlineSidebar = (props: {
  diffOpen: boolean;
  onCloseDiff: () => void;
  onOpenDiff: () => void;
  renderDiffContent: boolean;
}) => {
  const { diffOpen, onCloseDiff, onOpenDiff, renderDiffContent } = props;
  const onOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        onOpenDiff();
        return;
      }
      onCloseDiff();
    },
    [onCloseDiff, onOpenDiff],
  );
  const shouldAcceptInlineSidebarWidth = useCallback(
    ({ nextWidth, wrapper }: { nextWidth: number; wrapper: HTMLElement }) => {
      const composerForm = document.querySelector<HTMLElement>("[data-chat-composer-form='true']");
      if (!composerForm) return true;
      const composerViewport = composerForm.parentElement;
      if (!composerViewport) return true;
      const previousSidebarWidth = wrapper.style.getPropertyValue("--sidebar-width");
      wrapper.style.setProperty("--sidebar-width", `${nextWidth}px`);

      const viewportStyle = window.getComputedStyle(composerViewport);
      const viewportPaddingLeft = Number.parseFloat(viewportStyle.paddingLeft) || 0;
      const viewportPaddingRight = Number.parseFloat(viewportStyle.paddingRight) || 0;
      const viewportContentWidth = Math.max(
        0,
        composerViewport.clientWidth - viewportPaddingLeft - viewportPaddingRight,
      );
      const formRect = composerForm.getBoundingClientRect();
      const composerFooter = composerForm.querySelector<HTMLElement>(
        "[data-chat-composer-footer='true']",
      );
      const composerRightActions = composerForm.querySelector<HTMLElement>(
        "[data-chat-composer-actions='right']",
      );
      const composerRightActionsWidth = composerRightActions?.getBoundingClientRect().width ?? 0;
      const composerFooterGap = composerFooter
        ? Number.parseFloat(window.getComputedStyle(composerFooter).columnGap) ||
          Number.parseFloat(window.getComputedStyle(composerFooter).gap) ||
          0
        : 0;
      const minimumComposerWidth =
        COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX + composerRightActionsWidth + composerFooterGap;
      const hasComposerOverflow = composerForm.scrollWidth > composerForm.clientWidth + 0.5;
      const overflowsViewport = formRect.width > viewportContentWidth + 0.5;
      const violatesMinimumComposerWidth = composerForm.clientWidth + 0.5 < minimumComposerWidth;

      if (previousSidebarWidth.length > 0) {
        wrapper.style.setProperty("--sidebar-width", previousSidebarWidth);
      } else {
        wrapper.style.removeProperty("--sidebar-width");
      }

      return !hasComposerOverflow && !overflowsViewport && !violatesMinimumComposerWidth;
    },
    [],
  );

  return (
    <SidebarProvider
      defaultOpen={false}
      open={diffOpen}
      onOpenChange={onOpenChange}
      className="w-auto min-h-0 flex-none bg-transparent"
      style={{ "--sidebar-width": DIFF_INLINE_DEFAULT_WIDTH } as React.CSSProperties}
    >
      <Sidebar
        side="right"
        collapsible="offcanvas"
        className="border-l border-border bg-card text-foreground"
        resizable={{
          maxWidth: DIFF_INLINE_SIDEBAR_MAX_WIDTH,
          minWidth: DIFF_INLINE_SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: shouldAcceptInlineSidebarWidth,
          storageKey: DIFF_INLINE_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        {renderDiffContent ? <LazyDiffPanel mode="sidebar" /> : null}
        <SidebarRail />
      </Sidebar>
    </SidebarProvider>
  );
};

function readStoredSplitRatio(): number {
  if (typeof window === "undefined") return CHAT_SPLIT_DEFAULT_RATIO;
  const raw = Number(window.localStorage.getItem(CHAT_SPLIT_RATIO_STORAGE_KEY));
  if (!Number.isFinite(raw)) return CHAT_SPLIT_DEFAULT_RATIO;
  return Math.min(0.72, Math.max(0.28, raw));
}

function writeStoredSplitRatio(ratio: number): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(CHAT_SPLIT_RATIO_STORAGE_KEY, String(ratio));
}

function SplitSessionPlaceholder(props: { onClose: () => void }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col border-l border-border/60 bg-background">
      <div className="flex h-[52px] shrink-0 items-center justify-between border-b border-border px-5">
        <div>
          <div className="text-sm font-medium text-foreground">Split session</div>
          <div className="text-xs text-muted-foreground">
            Choose a session to open beside this one.
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={props.onClose}>
          Close
        </Button>
      </div>
      <div className="flex flex-1 items-center justify-center px-8 text-center">
        <div className="max-w-sm rounded-2xl border border-border/70 bg-card/60 px-6 py-7 shadow-sm">
          <div className="text-base font-medium text-foreground">
            Choose a session from the sidebar
          </div>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Click any thread to load it into the focused split pane, or use a thread context menu
            and choose Open in split.
          </p>
        </div>
      </div>
    </div>
  );
}

function ChatThreadRouteView() {
  const navigate = useNavigate();
  const threadRef = Route.useParams({
    select: (params) => resolveThreadRouteRef(params),
  });
  const search = Route.useSearch();
  const bootstrapComplete = useStore(
    (store) => selectEnvironmentState(store, threadRef?.environmentId ?? null).bootstrapComplete,
  );
  const serverThread = useStore(useMemo(() => createThreadSelectorByRef(threadRef), [threadRef]));
  const threadExists = useStore((store) => selectThreadExistsByRef(store, threadRef));
  const environmentHasServerThreads = useStore(
    (store) => selectEnvironmentState(store, threadRef?.environmentId ?? null).threadIds.length > 0,
  );
  const draftThreadExists = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) !== null : false,
  );
  const draftThread = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) : null,
  );
  const environmentHasDraftThreads = useComposerDraftStore((store) => {
    if (!threadRef) {
      return false;
    }
    return store.hasDraftThreadsInEnvironment(threadRef.environmentId);
  });
  const routeThreadExists = threadExists || draftThreadExists;
  const serverThreadStarted = threadHasStarted(serverThread);
  const environmentHasAnyThreads = environmentHasServerThreads || environmentHasDraftThreads;
  const diffOpen = search.diff === "1";
  const splitRequested = Boolean(search.splitEnv || search.splitThread || search.focusedPane);
  const secondaryThreadRef =
    search.splitEnv && search.splitThread
      ? scopeThreadRef(search.splitEnv, search.splitThread)
      : null;
  const secondaryThreadExists = useStore((store) =>
    selectThreadExistsByRef(store, secondaryThreadRef),
  );
  const hasSecondaryThread = Boolean(secondaryThreadRef && secondaryThreadExists);
  const splitOpen = splitRequested || hasSecondaryThread;
  const focusedPane = splitOpen ? (search.focusedPane ?? "secondary") : "primary";
  const [narrowSplitTab, setNarrowSplitTab] = useState<"primary" | "secondary">(
    focusedPane === "secondary" ? "secondary" : "primary",
  );
  const [splitRatio, setSplitRatio] = useState(readStoredSplitRatio);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const shouldUseDiffSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const shouldUseSplitTabs = useMediaQuery("(max-width: 900px)");
  const currentThreadKey = threadRef ? `${threadRef.environmentId}:${threadRef.threadId}` : null;
  const [diffPanelMountState, setDiffPanelMountState] = useState(() => ({
    threadKey: currentThreadKey,
    hasOpenedDiff: diffOpen,
  }));
  const hasOpenedDiff =
    diffPanelMountState.threadKey === currentThreadKey
      ? diffPanelMountState.hasOpenedDiff
      : diffOpen;
  const markDiffOpened = useCallback(() => {
    setDiffPanelMountState((previous) => {
      if (previous.threadKey === currentThreadKey && previous.hasOpenedDiff) {
        return previous;
      }
      return {
        threadKey: currentThreadKey,
        hasOpenedDiff: true,
      };
    });
  }, [currentThreadKey]);
  const closeDiff = useCallback(() => {
    if (!threadRef) {
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      search: { diff: undefined },
    });
  }, [navigate, threadRef]);
  const openDiff = useCallback(() => {
    if (!threadRef) {
      return;
    }
    markDiffOpened();
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return { ...rest, diff: "1" };
      },
    });
  }, [markDiffOpened, navigate, threadRef]);
  const closeSplit = useCallback(() => {
    if (!threadRef) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      search: (previous) => stripSplitSearchParams(previous),
    });
  }, [navigate, threadRef]);
  const openSplitPlaceholder = useCallback(() => {
    if (!threadRef) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      search: (previous) => {
        if (previous.splitThread) {
          return { ...previous, focusedPane: "secondary" };
        }
        return {
          ...previous,
          splitEnv: threadRef.environmentId,
          splitThread: undefined,
          focusedPane: "secondary",
        };
      },
    });
  }, [navigate, threadRef]);
  const focusPane = useCallback(
    (pane: "primary" | "secondary") => {
      if (!threadRef || !splitOpen || focusedPane === pane) return;
      setNarrowSplitTab(pane);
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
        search: (previous) => ({ ...previous, focusedPane: pane }),
        replace: true,
      });
    },
    [focusedPane, navigate, splitOpen, threadRef],
  );
  const togglePrimaryDiff = useCallback(() => {
    if (!threadRef) return;
    if (!diffOpen) {
      markDiffOpened();
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      replace: true,
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return diffOpen ? { ...rest, diff: undefined } : { ...rest, diff: "1" };
      },
    });
  }, [diffOpen, markDiffOpened, navigate, threadRef]);
  const toggleSecondaryDiff = useCallback(() => {
    if (!threadRef || !secondaryThreadRef) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      replace: true,
      search: (previous) => {
        const rest = stripSplitDiffSearchParams(previous);
        return search.splitDiff === "1"
          ? { ...rest, splitDiff: undefined }
          : { ...rest, splitDiff: "1" };
      },
    });
  }, [navigate, search.splitDiff, secondaryThreadRef, threadRef]);
  const selectPrimaryDiffTurn = useCallback(
    (turnId: TurnId) => {
      if (!threadRef) return;
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
        search: (previous) => {
          const rest = stripDiffSearchParams(previous);
          return { ...rest, diff: "1", diffTurnId: turnId };
        },
      });
    },
    [navigate, threadRef],
  );
  const selectPrimaryWholeDiff = useCallback(() => {
    if (!threadRef) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return { ...rest, diff: "1" };
      },
    });
  }, [navigate, threadRef]);
  const selectSecondaryDiffTurn = useCallback(
    (turnId: TurnId) => {
      if (!threadRef) return;
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
        search: (previous) => {
          const rest = stripSplitDiffSearchParams(previous);
          return { ...rest, splitDiff: "1", splitDiffTurnId: turnId };
        },
      });
    },
    [navigate, threadRef],
  );
  const selectSecondaryWholeDiff = useCallback(() => {
    if (!threadRef) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      search: (previous) => {
        const rest = stripSplitDiffSearchParams(previous);
        return { ...rest, splitDiff: "1" };
      },
    });
  }, [navigate, threadRef]);
  const swapSplitPanes = useCallback(() => {
    if (!threadRef || !secondaryThreadRef) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(secondaryThreadRef),
      search: (previous) => {
        const rest = stripSplitSearchParams(previous);
        return {
          ...stripDiffSearchParams(rest),
          splitEnv: threadRef.environmentId,
          splitThread: threadRef.threadId,
          focusedPane: focusedPane === "primary" ? "secondary" : "primary",
          ...(search.splitDiff ? { diff: search.splitDiff } : {}),
          ...(search.splitDiffTurnId ? { diffTurnId: search.splitDiffTurnId } : {}),
          ...(search.splitDiffFilePath ? { diffFilePath: search.splitDiffFilePath } : {}),
          ...(search.diff ? { splitDiff: search.diff } : {}),
          ...(search.diffTurnId ? { splitDiffTurnId: search.diffTurnId } : {}),
          ...(search.diffFilePath ? { splitDiffFilePath: search.diffFilePath } : {}),
        };
      },
    });
  }, [focusedPane, navigate, search, secondaryThreadRef, threadRef]);
  const beginResizeSplit = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const container = splitContainerRef.current;
      if (!container) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      const rect = container.getBoundingClientRect();
      const handlePointerMove = (moveEvent: PointerEvent) => {
        const nextPrimaryWidth = moveEvent.clientX - rect.left;
        const minRatio = Math.min(0.45, CHAT_SPLIT_MIN_PANE_WIDTH / rect.width);
        const maxRatio = 1 - minRatio;
        const nextRatio = Math.min(maxRatio, Math.max(minRatio, nextPrimaryWidth / rect.width));
        setSplitRatio(nextRatio);
      };
      const handlePointerUp = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        writeStoredSplitRatio(splitRatio);
      };
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp, { once: true });
    },
    [splitRatio],
  );

  useEffect(() => {
    setNarrowSplitTab(focusedPane);
  }, [focusedPane]);

  useEffect(() => {
    writeStoredSplitRatio(splitRatio);
  }, [splitRatio]);

  useEffect(() => {
    if (!threadRef || !secondaryThreadRef) return;
    if (
      threadRef.environmentId !== secondaryThreadRef.environmentId ||
      threadRef.threadId !== secondaryThreadRef.threadId
    ) {
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      replace: true,
      search: (previous) => stripSplitSearchParams(previous),
    });
  }, [navigate, secondaryThreadRef, threadRef]);

  useEffect(() => {
    if (!threadRef || !bootstrapComplete) {
      return;
    }

    if (!routeThreadExists && environmentHasAnyThreads) {
      void navigate({ to: "/", replace: true });
    }
  }, [bootstrapComplete, environmentHasAnyThreads, navigate, routeThreadExists, threadRef]);

  useEffect(() => {
    if (!threadRef || !serverThreadStarted || !draftThread?.promotedTo) {
      return;
    }
    finalizePromotedDraftThreadByRef(threadRef);
  }, [draftThread?.promotedTo, serverThreadStarted, threadRef]);

  if (!threadRef || !bootstrapComplete || !routeThreadExists) {
    return null;
  }

  const shouldRenderPrimaryDiffContent = diffOpen || hasOpenedDiff;
  const splitDiffThreadRef =
    focusedPane === "secondary" && secondaryThreadRef ? secondaryThreadRef : threadRef;
  const splitDiffOpen = focusedPane === "secondary" ? search.splitDiff === "1" : diffOpen;
  const splitDiffSearch =
    focusedPane === "secondary"
      ? {
          ...(search.splitDiff ? { diff: search.splitDiff } : {}),
          ...(search.splitDiffTurnId ? { diffTurnId: search.splitDiffTurnId } : {}),
          ...(search.splitDiffFilePath ? { diffFilePath: search.splitDiffFilePath } : {}),
        }
      : {
          ...(search.diff ? { diff: search.diff } : {}),
          ...(search.diffTurnId ? { diffTurnId: search.diffTurnId } : {}),
          ...(search.diffFilePath ? { diffFilePath: search.diffFilePath } : {}),
        };

  if (splitOpen) {
    const primaryPane = (
      <ChatView
        environmentId={threadRef.environmentId}
        threadId={threadRef.threadId}
        paneId="primary"
        isSplitPane
        isFocusedPane={focusedPane === "primary"}
        diffOpen={diffOpen}
        onTogglePaneDiff={togglePrimaryDiff}
        onOpenSplit={openSplitPlaceholder}
        onFocusPane={() => focusPane("primary")}
        onDiffPanelOpen={markDiffOpened}
        reserveTitleBarControlInset={false}
        routeKind="server"
      />
    );
    const secondaryPane =
      secondaryThreadRef && secondaryThreadExists ? (
        <ChatView
          environmentId={secondaryThreadRef.environmentId}
          threadId={secondaryThreadRef.threadId}
          paneId="secondary"
          isSplitPane
          isFocusedPane={focusedPane === "secondary"}
          diffOpen={search.splitDiff === "1"}
          onTogglePaneDiff={toggleSecondaryDiff}
          onCloseSplitPane={closeSplit}
          onSwapSplitPane={swapSplitPanes}
          onFocusPane={() => focusPane("secondary")}
          reserveTitleBarControlInset={false}
          routeKind="server"
        />
      ) : (
        <SplitSessionPlaceholder onClose={closeSplit} />
      );

    return (
      <>
        <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
          {shouldUseSplitTabs ? (
            <div className="flex h-full min-h-0 min-w-0 flex-col">
              <div className="flex shrink-0 gap-1 border-b border-border bg-card/60 px-3 py-2">
                <Button
                  variant={narrowSplitTab === "primary" ? "default" : "outline"}
                  size="sm"
                  onClick={() => {
                    setNarrowSplitTab("primary");
                    focusPane("primary");
                  }}
                >
                  Primary
                </Button>
                <Button
                  variant={narrowSplitTab === "secondary" ? "default" : "outline"}
                  size="sm"
                  onClick={() => {
                    setNarrowSplitTab("secondary");
                    focusPane("secondary");
                  }}
                >
                  Secondary
                </Button>
              </div>
              <div className="min-h-0 min-w-0 flex-1">
                <div
                  className={cn(
                    "flex h-full min-h-0 min-w-0 flex-col",
                    narrowSplitTab !== "primary" && "hidden",
                  )}
                >
                  {primaryPane}
                </div>
                <div
                  className={cn(
                    "flex h-full min-h-0 min-w-0 flex-col",
                    narrowSplitTab !== "secondary" && "hidden",
                  )}
                >
                  {secondaryPane}
                </div>
              </div>
            </div>
          ) : (
            <div ref={splitContainerRef} className="flex h-full min-h-0 min-w-0">
              <div
                className="flex min-h-0 min-w-0 flex-col"
                style={{
                  flex: `0 1 ${splitRatio * 100}%`,
                  minWidth: CHAT_SPLIT_MIN_PANE_WIDTH,
                }}
              >
                {primaryPane}
              </div>
              <div
                role="separator"
                aria-orientation="vertical"
                title="Drag to resize split panes"
                className="group relative z-20 w-1.5 shrink-0 cursor-col-resize bg-border/50 transition-colors hover:bg-primary/50"
                onPointerDown={beginResizeSplit}
              >
                <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border group-hover:bg-primary/70" />
              </div>
              <div
                className="flex min-h-0 min-w-0 flex-1 flex-col"
                style={{ minWidth: CHAT_SPLIT_MIN_PANE_WIDTH }}
              >
                {secondaryPane}
              </div>
            </div>
          )}
        </SidebarInset>
        <RightPanelSheet
          open={splitDiffOpen}
          onClose={focusedPane === "secondary" ? toggleSecondaryDiff : closeDiff}
        >
          {splitDiffOpen && splitDiffThreadRef ? (
            <LazyScopedDiffPanel
              mode="sheet"
              threadRef={splitDiffThreadRef}
              diffSearch={splitDiffSearch}
              onSelectTurn={
                focusedPane === "secondary" ? selectSecondaryDiffTurn : selectPrimaryDiffTurn
              }
              onSelectWholeConversation={
                focusedPane === "secondary" ? selectSecondaryWholeDiff : selectPrimaryWholeDiff
              }
            />
          ) : null}
        </RightPanelSheet>
      </>
    );
  }

  if (!shouldUseDiffSheet) {
    return (
      <>
        <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
          <ChatView
            environmentId={threadRef.environmentId}
            threadId={threadRef.threadId}
            onDiffPanelOpen={markDiffOpened}
            reserveTitleBarControlInset={!diffOpen}
            onOpenSplit={openSplitPlaceholder}
            routeKind="server"
          />
        </SidebarInset>
        <DiffPanelInlineSidebar
          diffOpen={diffOpen}
          onCloseDiff={closeDiff}
          onOpenDiff={openDiff}
          renderDiffContent={shouldRenderPrimaryDiffContent}
        />
      </>
    );
  }

  return (
    <>
      <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
        <ChatView
          environmentId={threadRef.environmentId}
          threadId={threadRef.threadId}
          onDiffPanelOpen={markDiffOpened}
          onOpenSplit={openSplitPlaceholder}
          routeKind="server"
        />
      </SidebarInset>
      <RightPanelSheet open={diffOpen} onClose={closeDiff}>
        {shouldRenderPrimaryDiffContent ? <LazyDiffPanel mode="sheet" /> : null}
      </RightPanelSheet>
    </>
  );
}

export const Route = createFileRoute("/_chat/$environmentId/$threadId")({
  validateSearch: (search) => parseDiffRouteSearch(search),
  search: {
    middlewares: [
      retainSearchParams<DiffRouteSearch>([
        "diff",
        "diffTurnId",
        "diffFilePath",
        "splitEnv",
        "splitThread",
        "focusedPane",
        "splitDiff",
        "splitDiffTurnId",
        "splitDiffFilePath",
      ]),
    ],
  },
  component: ChatThreadRouteView,
});
