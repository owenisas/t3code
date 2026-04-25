import {
  ArchiveIcon,
  ArchiveX,
  CalendarClockIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  Clock3Icon,
  InfoIcon,
  LoaderIcon,
  PlusIcon,
  RefreshCwIcon,
  PlayIcon,
  PencilIcon,
  PauseIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CommandId,
  PROVIDER_DISPLAY_NAMES,
  ScheduledJobId,
  type DesktopUpdateChannel,
  type ThreadFollowUpMode,
  type ScopedThreadRef,
  type ProviderKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { createModelSelection, normalizeModelSlug } from "@t3tools/shared/model";
import { Equal } from "effect";
import { APP_VERSION } from "../../branding";
import {
  canCheckForUpdate,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
} from "../../components/desktopUpdate.logic";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { resolveAndPersistPreferredEditor } from "../../editorPreferences";
import { isElectron } from "../../env";
import { useTheme } from "../../hooks/useTheme";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { useThreadActions } from "../../hooks/useThreadActions";
import {
  setDesktopUpdateStateQueryData,
  useDesktopUpdateState,
} from "../../lib/desktopUpdateReactQuery";
import {
  MAX_CUSTOM_MODEL_LENGTH,
  getCustomModelOptionsByProvider,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import { ensureLocalApi, readLocalApi } from "../../localApi";
import { ensureEnvironmentApi } from "../../environmentApi";
import { useShallow } from "zustand/react/shallow";
import {
  selectProjectsAcrossEnvironments,
  selectScheduledJobsAcrossEnvironments,
  selectThreadShellsAcrossEnvironments,
  useStore,
} from "../../store";
import { formatRelativeTime, formatRelativeTimeLabel } from "../../timestampFormat";
import { cn } from "../../lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import {
  buildScheduledJobCreateCommand,
  buildScheduledJobDeleteCommand,
  buildScheduledJobPauseCommand,
  buildScheduledJobResumeCommand,
  buildScheduledJobRunNowCommand,
} from "../../scheduledJobs";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent } from "../ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "./settingsLayout";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  useServerAvailableEditors,
  useServerKeybindingsConfigPath,
  useServerObservability,
  useServerProviders,
} from "../../rpc/serverState";
import { formatProviderKindLabel } from "../../providerModels";

const THEME_OPTIONS = [
  {
    value: "system",
    label: "System",
  },
  {
    value: "light",
    label: "Light",
  },
  {
    value: "dark",
    label: "Dark",
  },
] as const;

const TIMESTAMP_FORMAT_LABELS = {
  locale: "System default",
  "12-hour": "12-hour",
  "24-hour": "24-hour",
} as const;

const ACTIVE_TURN_FOLLOW_UP_MODE_LABELS: Record<ThreadFollowUpMode, string> = {
  steer: "Steer running turn",
  queue: "Queue behind running turn",
};

type InstallProviderSettings = {
  provider: ProviderKind;
  title: string;
  badgeLabel?: string;
  binaryPlaceholder: string;
  binaryDescription: ReactNode;
  serverUrlPlaceholder?: string;
  serverUrlDescription?: ReactNode;
  serverPasswordPlaceholder?: string;
  serverPasswordDescription?: ReactNode;
  homePathKey?: "codexHomePath";
  homePlaceholder?: string;
  homeDescription?: ReactNode;
};

const PROVIDER_SETTINGS: readonly InstallProviderSettings[] = [
  {
    provider: "codex",
    title: "Codex",
    binaryPlaceholder: "Codex binary path",
    binaryDescription: "Path to the Codex binary",
    homePathKey: "codexHomePath",
    homePlaceholder: "CODEX_HOME",
    homeDescription: "Optional custom Codex home and config directory.",
  },
  {
    provider: "claudeAgent",
    title: "Claude",
    binaryPlaceholder: "Claude binary path",
    binaryDescription: "Path to the Claude binary",
  },
  {
    provider: "cursor",
    title: "Cursor",
    badgeLabel: "Early Access",
    binaryPlaceholder: "Cursor agent binary path",
    binaryDescription: "Path to the Cursor agent binary",
  },
  {
    provider: "opencode",
    title: "OpenCode",
    binaryPlaceholder: "OpenCode binary path",
    binaryDescription: "Path to the OpenCode binary",
    serverUrlPlaceholder: "http://127.0.0.1:4096",
    serverUrlDescription: "Leave blank to let T3 Code spawn the server when needed",
    serverPasswordPlaceholder: "Server password (optional)",
    serverPasswordDescription:
      "If your OpenCode server requires authentication, enter the password here. NOTE: Stored in plain text on disk",
  },
] as const;

const PROVIDER_STATUS_STYLES = {
  disabled: {
    dot: "bg-amber-400",
  },
  error: {
    dot: "bg-destructive",
  },
  ready: {
    dot: "bg-success",
  },
  warning: {
    dot: "bg-warning",
  },
} as const;

function getProviderSummary(provider: ServerProvider | undefined) {
  if (!provider) {
    return {
      headline: "Checking provider status",
      detail: "Waiting for the server to report installation and authentication details.",
    };
  }
  if (!provider.enabled) {
    return {
      headline: "Disabled",
      detail:
        provider.message ?? "This provider is installed but disabled for new sessions in T3 Code.",
    };
  }
  if (!provider.installed) {
    return {
      headline: "Not found",
      detail: provider.message ?? "CLI not detected on PATH.",
    };
  }
  if (provider.auth.status === "authenticated") {
    const authLabel = provider.auth.label ?? provider.auth.type;
    return {
      headline: authLabel ? `Authenticated · ${authLabel}` : "Authenticated",
      detail: provider.message ?? null,
    };
  }
  if (provider.auth.status === "unauthenticated") {
    return {
      headline: "Not authenticated",
      detail: provider.message ?? null,
    };
  }
  if (provider.status === "warning") {
    return {
      headline: "Needs attention",
      detail:
        provider.message ?? "The provider is installed, but the server could not fully verify it.",
    };
  }
  if (provider.status === "error") {
    return {
      headline: "Unavailable",
      detail: provider.message ?? "The provider failed its startup checks.",
    };
  }
  return {
    headline: "Available",
    detail: provider.message ?? "Installed and ready, but authentication could not be verified.",
  };
}

function getProviderVersionLabel(version: string | null | undefined) {
  if (!version) return null;
  return version.startsWith("v") ? version : `v${version}`;
}

function ProviderLastChecked({ lastCheckedAt }: { lastCheckedAt: string | null }) {
  useRelativeTimeTick();
  const lastCheckedRelative = lastCheckedAt ? formatRelativeTime(lastCheckedAt) : null;

  if (!lastCheckedRelative) {
    return null;
  }

  return (
    <span className="text-[11px] text-muted-foreground/60">
      {lastCheckedRelative.suffix ? (
        <>
          Checked <span className="font-mono tabular-nums">{lastCheckedRelative.value}</span>{" "}
          {lastCheckedRelative.suffix}
        </>
      ) : (
        <>Checked {lastCheckedRelative.value}</>
      )}
    </span>
  );
}

function AboutVersionTitle() {
  return (
    <span className="inline-flex items-center gap-2">
      <span>Version</span>
      <code className="text-[11px] font-medium text-muted-foreground">{APP_VERSION}</code>
    </span>
  );
}

function AboutVersionSection() {
  const queryClient = useQueryClient();
  const updateStateQuery = useDesktopUpdateState();
  const [isChangingUpdateChannel, setIsChangingUpdateChannel] = useState(false);

  const updateState = updateStateQuery.data ?? null;
  const hasDesktopBridge = typeof window !== "undefined" && Boolean(window.desktopBridge);
  const selectedUpdateChannel = updateState?.channel ?? "latest";

  const handleUpdateChannelChange = useCallback(
    (channel: DesktopUpdateChannel) => {
      const bridge = window.desktopBridge;
      if (
        !bridge ||
        typeof bridge.setUpdateChannel !== "function" ||
        channel === selectedUpdateChannel
      ) {
        return;
      }

      setIsChangingUpdateChannel(true);
      void bridge
        .setUpdateChannel(channel)
        .then((state) => {
          setDesktopUpdateStateQueryData(queryClient, state);
        })
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not change update track",
              description: error instanceof Error ? error.message : "Update track change failed.",
            }),
          );
        })
        .finally(() => {
          setIsChangingUpdateChannel(false);
        });
    },
    [queryClient, selectedUpdateChannel],
  );

  const handleButtonClick = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge) return;

    const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";

    if (action === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          setDesktopUpdateStateQueryData(queryClient, result.state);
        })
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not download update",
              description: error instanceof Error ? error.message : "Download failed.",
            }),
          );
        });
      return;
    }

    if (action === "install") {
      const confirmed = window.confirm(
        getDesktopUpdateInstallConfirmationMessage(
          updateState ?? { availableVersion: null, downloadedVersion: null },
        ),
      );
      if (!confirmed) return;
      void bridge
        .installUpdate()
        .then((result) => {
          setDesktopUpdateStateQueryData(queryClient, result.state);
        })
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not install update",
              description: error instanceof Error ? error.message : "Install failed.",
            }),
          );
        });
      return;
    }

    if (typeof bridge.checkForUpdate !== "function") return;
    void bridge
      .checkForUpdate()
      .then((result) => {
        setDesktopUpdateStateQueryData(queryClient, result.state);
        if (!result.checked) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not check for updates",
              description:
                result.state.message ?? "Automatic updates are not available in this build.",
            }),
          );
        }
      })
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not check for updates",
            description: error instanceof Error ? error.message : "Update check failed.",
          }),
        );
      });
  }, [queryClient, updateState]);

  const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";
  const buttonTooltip = updateState ? getDesktopUpdateButtonTooltip(updateState) : null;
  const buttonDisabled =
    action === "none"
      ? !canCheckForUpdate(updateState)
      : isDesktopUpdateButtonDisabled(updateState);

  const actionLabel: Record<string, string> = { download: "Download", install: "Install" };
  const statusLabel: Record<string, string> = {
    checking: "Checking…",
    downloading: "Downloading…",
    "up-to-date": "Up to Date",
  };
  const buttonLabel =
    actionLabel[action] ?? statusLabel[updateState?.status ?? ""] ?? "Check for Updates";
  const description =
    action === "download" || action === "install"
      ? "Update available."
      : "Current version of the application.";

  return (
    <>
      <SettingsRow
        title={<AboutVersionTitle />}
        description={description}
        control={
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="xs"
                  variant={action === "install" ? "default" : "outline"}
                  disabled={buttonDisabled}
                  onClick={handleButtonClick}
                >
                  {buttonLabel}
                </Button>
              }
            />
            {buttonTooltip ? <TooltipPopup>{buttonTooltip}</TooltipPopup> : null}
          </Tooltip>
        }
      />
      <SettingsRow
        title="Update track"
        description="Stable follows full releases. Nightly follows the nightly desktop channel and can switch back to stable immediately."
        control={
          <Select
            value={selectedUpdateChannel}
            onValueChange={(value) => {
              handleUpdateChannelChange(value as DesktopUpdateChannel);
            }}
          >
            <SelectTrigger
              className="w-full sm:w-40"
              aria-label="Update track"
              disabled={!hasDesktopBridge || isChangingUpdateChannel}
            >
              <SelectValue>
                {selectedUpdateChannel === "nightly" ? "Nightly" : "Stable"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="latest">
                Stable
              </SelectItem>
              <SelectItem hideIndicator value="nightly">
                Nightly
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />
    </>
  );
}

export function useSettingsRestore(onRestored?: () => void) {
  const { theme, setTheme } = useTheme();
  const settings = useSettings();
  const { resetSettings } = useUpdateSettings();

  const isGitWritingModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );
  const areProviderSettingsDirty = PROVIDER_SETTINGS.some((providerSettings) => {
    const currentSettings = settings.providers[providerSettings.provider];
    const defaultSettings = DEFAULT_UNIFIED_SETTINGS.providers[providerSettings.provider];
    return !Equal.equals(currentSettings, defaultSettings);
  });

  const changedSettingLabels = useMemo(
    () => [
      ...(theme !== "system" ? ["Theme"] : []),
      ...(settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat
        ? ["Time format"]
        : []),
      ...(settings.diffWordWrap !== DEFAULT_UNIFIED_SETTINGS.diffWordWrap
        ? ["Diff line wrapping"]
        : []),
      ...(settings.autoOpenPlanSidebar !== DEFAULT_UNIFIED_SETTINGS.autoOpenPlanSidebar
        ? ["Task sidebar"]
        : []),
      ...(settings.enableAssistantStreaming !== DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming
        ? ["Assistant output"]
        : []),
      ...(settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode
        ? ["New thread mode"]
        : []),
      ...(settings.addProjectBaseDirectory !== DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory
        ? ["Add project base directory"]
        : []),
      ...(settings.activeTurnFollowUpMode !== DEFAULT_UNIFIED_SETTINGS.activeTurnFollowUpMode
        ? ["Running turn follow-up"]
        : []),
      ...(settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive
        ? ["Archive confirmation"]
        : []),
      ...(settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete
        ? ["Delete confirmation"]
        : []),
      ...(isGitWritingModelDirty ? ["Git writing model"] : []),
      ...(areProviderSettingsDirty ? ["Providers"] : []),
    ],
    [
      areProviderSettingsDirty,
      isGitWritingModelDirty,
      settings.activeTurnFollowUpMode,
      settings.autoOpenPlanSidebar,
      settings.confirmThreadArchive,
      settings.confirmThreadDelete,
      settings.addProjectBaseDirectory,
      settings.defaultThreadEnvMode,
      settings.diffWordWrap,
      settings.enableAssistantStreaming,
      settings.timestampFormat,
      theme,
    ],
  );

  const restoreDefaults = useCallback(async () => {
    if (changedSettingLabels.length === 0) return;
    const api = readLocalApi();
    const confirmed = await (api ?? ensureLocalApi()).dialogs.confirm(
      ["Restore default settings?", `This will reset: ${changedSettingLabels.join(", ")}.`].join(
        "\n",
      ),
    );
    if (!confirmed) return;

    setTheme("system");
    resetSettings();
    onRestored?.();
  }, [changedSettingLabels, onRestored, resetSettings, setTheme]);

  return {
    changedSettingLabels,
    restoreDefaults,
  };
}

export function GeneralSettingsPanel() {
  const { theme, setTheme } = useTheme();
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const [openingPathByTarget, setOpeningPathByTarget] = useState({
    keybindings: false,
    logsDirectory: false,
  });
  const [openPathErrorByTarget, setOpenPathErrorByTarget] = useState<
    Partial<Record<"keybindings" | "logsDirectory", string | null>>
  >({});
  const [openProviderDetails, setOpenProviderDetails] = useState<Record<ProviderKind, boolean>>({
    codex: Boolean(
      settings.providers.codex.binaryPath !== DEFAULT_UNIFIED_SETTINGS.providers.codex.binaryPath ||
      settings.providers.codex.homePath !== DEFAULT_UNIFIED_SETTINGS.providers.codex.homePath ||
      settings.providers.codex.customModels.length > 0,
    ),
    claudeAgent: Boolean(
      settings.providers.claudeAgent.binaryPath !==
        DEFAULT_UNIFIED_SETTINGS.providers.claudeAgent.binaryPath ||
      settings.providers.claudeAgent.customModels.length > 0 ||
      settings.providers.claudeAgent.launchArgs !== "",
    ),
    cursor: Boolean(
      settings.providers.cursor.binaryPath !==
        DEFAULT_UNIFIED_SETTINGS.providers.cursor.binaryPath ||
      settings.providers.cursor.customModels.length > 0,
    ),
    opencode: Boolean(
      settings.providers.opencode.binaryPath !==
        DEFAULT_UNIFIED_SETTINGS.providers.opencode.binaryPath ||
      settings.providers.opencode.serverUrl !==
        DEFAULT_UNIFIED_SETTINGS.providers.opencode.serverUrl ||
      settings.providers.opencode.serverPassword !==
        DEFAULT_UNIFIED_SETTINGS.providers.opencode.serverPassword ||
      settings.providers.opencode.customModels.length > 0,
    ),
  });
  const [customModelInputByProvider, setCustomModelInputByProvider] = useState<
    Record<ProviderKind, string>
  >({
    codex: "",
    claudeAgent: "",
    cursor: "",
    opencode: "",
  });
  const [customModelErrorByProvider, setCustomModelErrorByProvider] = useState<
    Partial<Record<ProviderKind, string | null>>
  >({});
  const [isRefreshingProviders, setIsRefreshingProviders] = useState(false);
  const refreshingRef = useRef(false);
  const modelListRefs = useRef<Partial<Record<ProviderKind, HTMLDivElement | null>>>({});
  const refreshProviders = useCallback(() => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setIsRefreshingProviders(true);
    void ensureLocalApi()
      .server.refreshProviders()
      .catch((error: unknown) => {
        console.warn("Failed to refresh providers", error);
      })
      .finally(() => {
        refreshingRef.current = false;
        setIsRefreshingProviders(false);
      });
  }, []);

  const keybindingsConfigPath = useServerKeybindingsConfigPath();
  const availableEditors = useServerAvailableEditors();
  const observability = useServerObservability();
  const serverProviders = useServerProviders();
  const visibleProviderSettings = PROVIDER_SETTINGS.filter(
    (providerSettings) =>
      providerSettings.provider !== "cursor" ||
      serverProviders.some((provider) => provider.provider === "cursor"),
  );
  const codexHomePath = settings.providers.codex.homePath;
  const logsDirectoryPath = observability?.logsDirectoryPath ?? null;
  const diagnosticsDescription = (() => {
    const exports: string[] = [];
    if (observability?.otlpTracesEnabled && observability.otlpTracesUrl) {
      exports.push(`traces to ${observability.otlpTracesUrl}`);
    }
    if (observability?.otlpMetricsEnabled && observability.otlpMetricsUrl) {
      exports.push(`metrics to ${observability.otlpMetricsUrl}`);
    }
    const mode = observability?.localTracingEnabled ? "Local trace file" : "Terminal logs only";
    return exports.length > 0 ? `${mode}. OTLP exporting ${exports.join(" and ")}.` : `${mode}.`;
  })();

  const textGenerationModelSelection = resolveAppModelSelectionState(settings, serverProviders);
  const textGenProvider = textGenerationModelSelection.provider;
  const textGenModel = textGenerationModelSelection.model;
  const textGenModelOptions = textGenerationModelSelection.options;
  const gitModelOptionsByProvider = getCustomModelOptionsByProvider(
    settings,
    serverProviders,
    textGenProvider,
    textGenModel,
  );
  const isGitWritingModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );

  const openInPreferredEditor = useCallback(
    (target: "keybindings" | "logsDirectory", path: string | null, failureMessage: string) => {
      if (!path) return;
      setOpenPathErrorByTarget((existing) => ({ ...existing, [target]: null }));
      setOpeningPathByTarget((existing) => ({ ...existing, [target]: true }));

      const editor = resolveAndPersistPreferredEditor(availableEditors ?? []);
      if (!editor) {
        setOpenPathErrorByTarget((existing) => ({
          ...existing,
          [target]: "No available editors found.",
        }));
        setOpeningPathByTarget((existing) => ({ ...existing, [target]: false }));
        return;
      }

      void ensureLocalApi()
        .shell.openInEditor(path, editor)
        .catch((error) => {
          setOpenPathErrorByTarget((existing) => ({
            ...existing,
            [target]: error instanceof Error ? error.message : failureMessage,
          }));
        })
        .finally(() => {
          setOpeningPathByTarget((existing) => ({ ...existing, [target]: false }));
        });
    },
    [availableEditors],
  );

  const openKeybindingsFile = useCallback(() => {
    openInPreferredEditor("keybindings", keybindingsConfigPath, "Unable to open keybindings file.");
  }, [keybindingsConfigPath, openInPreferredEditor]);

  const openLogsDirectory = useCallback(() => {
    openInPreferredEditor("logsDirectory", logsDirectoryPath, "Unable to open logs folder.");
  }, [logsDirectoryPath, openInPreferredEditor]);

  const openKeybindingsError = openPathErrorByTarget.keybindings ?? null;
  const openDiagnosticsError = openPathErrorByTarget.logsDirectory ?? null;
  const isOpeningKeybindings = openingPathByTarget.keybindings;
  const isOpeningLogsDirectory = openingPathByTarget.logsDirectory;

  const addCustomModel = useCallback(
    (provider: ProviderKind) => {
      const customModelInput = customModelInputByProvider[provider];
      const customModels = settings.providers[provider].customModels;
      const normalized = normalizeModelSlug(customModelInput, provider);
      if (!normalized) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "Enter a model slug.",
        }));
        return;
      }
      if (
        serverProviders
          .find((candidate) => candidate.provider === provider)
          ?.models.some((option) => !option.isCustom && option.slug === normalized)
      ) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "That model is already built in.",
        }));
        return;
      }
      if (normalized.length > MAX_CUSTOM_MODEL_LENGTH) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: `Model slugs must be ${MAX_CUSTOM_MODEL_LENGTH} characters or less.`,
        }));
        return;
      }
      if (customModels.includes(normalized)) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "That custom model is already saved.",
        }));
        return;
      }

      updateSettings({
        providers: {
          ...settings.providers,
          [provider]: {
            ...settings.providers[provider],
            customModels: [...customModels, normalized],
          },
        },
      });
      setCustomModelInputByProvider((existing) => ({
        ...existing,
        [provider]: "",
      }));
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: null,
      }));

      const el = modelListRefs.current[provider];
      if (!el) return;
      const scrollToEnd = () => el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      requestAnimationFrame(scrollToEnd);
      const observer = new MutationObserver(() => {
        scrollToEnd();
        observer.disconnect();
      });
      observer.observe(el, { childList: true, subtree: true });
      setTimeout(() => observer.disconnect(), 2_000);
    },
    [customModelInputByProvider, serverProviders, settings, updateSettings],
  );

  const removeCustomModel = useCallback(
    (provider: ProviderKind, slug: string) => {
      updateSettings({
        providers: {
          ...settings.providers,
          [provider]: {
            ...settings.providers[provider],
            customModels: settings.providers[provider].customModels.filter(
              (model) => model !== slug,
            ),
          },
        },
      });
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: null,
      }));
    },
    [settings, updateSettings],
  );

  const providerCards = visibleProviderSettings.map((providerSettings) => {
    const liveProvider = serverProviders.find(
      (candidate) => candidate.provider === providerSettings.provider,
    );
    const providerConfig = settings.providers[providerSettings.provider];
    const defaultProviderConfig = DEFAULT_UNIFIED_SETTINGS.providers[providerSettings.provider];
    const statusKey = liveProvider?.status ?? (providerConfig.enabled ? "warning" : "disabled");
    const summary = getProviderSummary(liveProvider);
    const models: ReadonlyArray<ServerProviderModel> =
      liveProvider?.models ??
      providerConfig.customModels.map((slug) => ({
        slug,
        name: slug,
        isCustom: true,
        capabilities: null,
      }));

    return {
      provider: providerSettings.provider,
      title: providerSettings.title,
      badgeLabel: providerSettings.badgeLabel,
      binaryPlaceholder: providerSettings.binaryPlaceholder,
      binaryDescription: providerSettings.binaryDescription,
      serverUrlPlaceholder: providerSettings.serverUrlPlaceholder,
      serverUrlDescription: providerSettings.serverUrlDescription,
      serverPasswordPlaceholder: providerSettings.serverPasswordPlaceholder,
      serverPasswordDescription: providerSettings.serverPasswordDescription,
      homePathKey: providerSettings.homePathKey,
      homePlaceholder: providerSettings.homePlaceholder,
      homeDescription: providerSettings.homeDescription,
      binaryPathValue: providerConfig.binaryPath,
      serverUrlValue: "serverUrl" in providerConfig ? providerConfig.serverUrl : "",
      serverPasswordValue: "serverPassword" in providerConfig ? providerConfig.serverPassword : "",
      isDirty: !Equal.equals(providerConfig, defaultProviderConfig),
      liveProvider,
      models,
      providerConfig,
      statusStyle: PROVIDER_STATUS_STYLES[statusKey],
      summary,
      versionLabel: getProviderVersionLabel(liveProvider?.version),
    };
  });

  const lastCheckedAt =
    serverProviders.length > 0
      ? serverProviders.reduce(
          (latest, provider) => (provider.checkedAt > latest ? provider.checkedAt : latest),
          serverProviders[0]!.checkedAt,
        )
      : null;

  return (
    <SettingsPageContainer>
      <SettingsSection title="General">
        <SettingsRow
          title="Theme"
          description="Choose how T3 Code looks across the app."
          resetAction={
            theme !== "system" ? (
              <SettingResetButton label="theme" onClick={() => setTheme("system")} />
            ) : null
          }
          control={
            <Select
              value={theme}
              onValueChange={(value) => {
                if (value === "system" || value === "light" || value === "dark") {
                  setTheme(value);
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Theme preference">
                <SelectValue>
                  {THEME_OPTIONS.find((option) => option.value === theme)?.label ?? "System"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {THEME_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Time format"
          description="System default follows your browser or OS clock preference."
          resetAction={
            settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat ? (
              <SettingResetButton
                label="time format"
                onClick={() =>
                  updateSettings({
                    timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.timestampFormat}
              onValueChange={(value) => {
                if (value === "locale" || value === "12-hour" || value === "24-hour") {
                  updateSettings({ timestampFormat: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Timestamp format">
                <SelectValue>{TIMESTAMP_FORMAT_LABELS[settings.timestampFormat]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="locale">
                  {TIMESTAMP_FORMAT_LABELS.locale}
                </SelectItem>
                <SelectItem hideIndicator value="12-hour">
                  {TIMESTAMP_FORMAT_LABELS["12-hour"]}
                </SelectItem>
                <SelectItem hideIndicator value="24-hour">
                  {TIMESTAMP_FORMAT_LABELS["24-hour"]}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Diff line wrapping"
          description="Set the default wrap state when the diff panel opens."
          resetAction={
            settings.diffWordWrap !== DEFAULT_UNIFIED_SETTINGS.diffWordWrap ? (
              <SettingResetButton
                label="diff line wrapping"
                onClick={() =>
                  updateSettings({
                    diffWordWrap: DEFAULT_UNIFIED_SETTINGS.diffWordWrap,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.diffWordWrap}
              onCheckedChange={(checked) => updateSettings({ diffWordWrap: Boolean(checked) })}
              aria-label="Wrap diff lines by default"
            />
          }
        />

        <SettingsRow
          title="Assistant output"
          description="Show token-by-token output while a response is in progress."
          resetAction={
            settings.enableAssistantStreaming !==
            DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming ? (
              <SettingResetButton
                label="assistant output"
                onClick={() =>
                  updateSettings({
                    enableAssistantStreaming: DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.enableAssistantStreaming}
              onCheckedChange={(checked) =>
                updateSettings({ enableAssistantStreaming: Boolean(checked) })
              }
              aria-label="Stream assistant messages"
            />
          }
        />

        <SettingsRow
          title="Task sidebar"
          description="Open the plan and task sidebar automatically when steps appear."
          resetAction={
            settings.autoOpenPlanSidebar !== DEFAULT_UNIFIED_SETTINGS.autoOpenPlanSidebar ? (
              <SettingResetButton
                label="task sidebar"
                onClick={() =>
                  updateSettings({
                    autoOpenPlanSidebar: DEFAULT_UNIFIED_SETTINGS.autoOpenPlanSidebar,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.autoOpenPlanSidebar}
              onCheckedChange={(checked) =>
                updateSettings({ autoOpenPlanSidebar: Boolean(checked) })
              }
              aria-label="Open the task sidebar automatically"
            />
          }
        />

        <SettingsRow
          title="New threads"
          description="Pick the default workspace mode for newly created draft threads."
          resetAction={
            settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode ? (
              <SettingResetButton
                label="new threads"
                onClick={() =>
                  updateSettings({
                    defaultThreadEnvMode: DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.defaultThreadEnvMode}
              onValueChange={(value) => {
                if (value === "local" || value === "worktree") {
                  updateSettings({ defaultThreadEnvMode: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-44" aria-label="Default thread mode">
                <SelectValue>
                  {settings.defaultThreadEnvMode === "worktree" ? "New worktree" : "Local"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="local">
                  Local
                </SelectItem>
                <SelectItem hideIndicator value="worktree">
                  New worktree
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Add project starts in"
          description='Leave empty to use "~/" when the Add Project browser opens.'
          resetAction={
            settings.addProjectBaseDirectory !==
            DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory ? (
              <SettingResetButton
                label="add project base directory"
                onClick={() =>
                  updateSettings({
                    addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory,
                  })
                }
              />
            ) : null
          }
          control={
            <Input
              className="w-full sm:w-72"
              value={settings.addProjectBaseDirectory}
              onChange={(event) => updateSettings({ addProjectBaseDirectory: event.target.value })}
              placeholder="~/"
              spellCheck={false}
              aria-label="Add project base directory"
            />
          }
        />

        <SettingsRow
          title="Running turn follow-up"
          description="Choose what the main send action does while the current turn is still responding."
          resetAction={
            settings.activeTurnFollowUpMode !== DEFAULT_UNIFIED_SETTINGS.activeTurnFollowUpMode ? (
              <SettingResetButton
                label="running turn follow-up"
                onClick={() =>
                  updateSettings({
                    activeTurnFollowUpMode: DEFAULT_UNIFIED_SETTINGS.activeTurnFollowUpMode,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.activeTurnFollowUpMode}
              onValueChange={(value) => {
                if (value === "steer" || value === "queue") {
                  updateSettings({ activeTurnFollowUpMode: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-56" aria-label="Running turn follow-up mode">
                <SelectValue>
                  {ACTIVE_TURN_FOLLOW_UP_MODE_LABELS[settings.activeTurnFollowUpMode]}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="steer">
                  {ACTIVE_TURN_FOLLOW_UP_MODE_LABELS.steer}
                </SelectItem>
                <SelectItem hideIndicator value="queue">
                  {ACTIVE_TURN_FOLLOW_UP_MODE_LABELS.queue}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Archive confirmation"
          description="Require a second click on the inline archive action before a thread is archived."
          resetAction={
            settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive ? (
              <SettingResetButton
                label="archive confirmation"
                onClick={() =>
                  updateSettings({
                    confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadArchive}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadArchive: Boolean(checked) })
              }
              aria-label="Confirm thread archiving"
            />
          }
        />

        <SettingsRow
          title="Delete confirmation"
          description="Ask before deleting a thread and its chat history."
          resetAction={
            settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete ? (
              <SettingResetButton
                label="delete confirmation"
                onClick={() =>
                  updateSettings({
                    confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadDelete}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadDelete: Boolean(checked) })
              }
              aria-label="Confirm thread deletion"
            />
          }
        />

        <SettingsRow
          title="Text generation model"
          description="Configure the model used for generated commit messages, PR titles, and similar Git text."
          resetAction={
            isGitWritingModelDirty ? (
              <SettingResetButton
                label="text generation model"
                onClick={() =>
                  updateSettings({
                    textGenerationModelSelection:
                      DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              <ProviderModelPicker
                provider={textGenProvider}
                model={textGenModel}
                lockedProvider={null}
                providers={serverProviders}
                modelOptionsByProvider={gitModelOptionsByProvider}
                triggerVariant="outline"
                triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                onProviderModelChange={(provider, model) => {
                  updateSettings({
                    textGenerationModelSelection: resolveAppModelSelectionState(
                      {
                        ...settings,
                        textGenerationModelSelection: createModelSelection(provider, model),
                      },
                      serverProviders,
                    ),
                  });
                }}
              />
              <TraitsPicker
                provider={textGenProvider}
                models={
                  serverProviders.find((provider) => provider.provider === textGenProvider)
                    ?.models ?? []
                }
                model={textGenModel}
                prompt=""
                onPromptChange={() => {}}
                modelOptions={textGenModelOptions}
                allowPromptInjectedEffort={false}
                triggerVariant="outline"
                triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                onModelOptionsChange={(nextOptions) => {
                  updateSettings({
                    textGenerationModelSelection: resolveAppModelSelectionState(
                      {
                        ...settings,
                        textGenerationModelSelection: createModelSelection(
                          textGenProvider,
                          textGenModel,
                          nextOptions,
                        ),
                      },
                      serverProviders,
                    ),
                  });
                }}
              />
            </div>
          }
        />
      </SettingsSection>

      <SettingsSection
        title="Providers"
        headerAction={
          <div className="flex items-center gap-1.5">
            <ProviderLastChecked lastCheckedAt={lastCheckedAt} />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                    disabled={isRefreshingProviders}
                    onClick={() => void refreshProviders()}
                    aria-label="Refresh provider status"
                  >
                    {isRefreshingProviders ? (
                      <LoaderIcon className="size-3 animate-spin" />
                    ) : (
                      <RefreshCwIcon className="size-3" />
                    )}
                  </Button>
                }
              />
              <TooltipPopup side="top">Refresh provider status</TooltipPopup>
            </Tooltip>
          </div>
        }
      >
        {providerCards.map((providerCard) => {
          const customModelInput = customModelInputByProvider[providerCard.provider];
          const customModelError = customModelErrorByProvider[providerCard.provider] ?? null;
          const providerDisplayName =
            providerCard.liveProvider?.displayName?.trim() ||
            providerCard.title ||
            formatProviderKindLabel(providerCard.provider);

          return (
            <div key={providerCard.provider} className="border-t border-border first:border-t-0">
              <div className="px-4 py-4 sm:px-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex min-h-5 items-center gap-1.5">
                      <span
                        className={cn("size-2 shrink-0 rounded-full", providerCard.statusStyle.dot)}
                      />
                      <h3 className="text-sm font-medium text-foreground">{providerDisplayName}</h3>
                      {providerCard.badgeLabel ? (
                        <Badge variant="warning" size="sm" className="shrink-0">
                          {providerCard.badgeLabel}
                        </Badge>
                      ) : null}
                      {providerCard.versionLabel ? (
                        <code className="text-xs text-muted-foreground">
                          {providerCard.versionLabel}
                        </code>
                      ) : null}
                      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
                        {providerCard.isDirty ? (
                          <SettingResetButton
                            label={`${providerDisplayName} provider settings`}
                            onClick={() => {
                              updateSettings({
                                providers: {
                                  ...settings.providers,
                                  [providerCard.provider]:
                                    DEFAULT_UNIFIED_SETTINGS.providers[providerCard.provider],
                                },
                              });
                              setCustomModelErrorByProvider((existing) => ({
                                ...existing,
                                [providerCard.provider]: null,
                              }));
                            }}
                          />
                        ) : null}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {providerCard.summary.headline}
                      {providerCard.summary.detail ? ` - ${providerCard.summary.detail}` : null}
                    </p>
                  </div>
                  <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                      onClick={() =>
                        setOpenProviderDetails((existing) => ({
                          ...existing,
                          [providerCard.provider]: !existing[providerCard.provider],
                        }))
                      }
                      aria-label={`Toggle ${providerDisplayName} details`}
                    >
                      <ChevronDownIcon
                        className={cn(
                          "size-3.5 transition-transform",
                          openProviderDetails[providerCard.provider] && "rotate-180",
                        )}
                      />
                    </Button>
                    <Switch
                      checked={providerCard.providerConfig.enabled}
                      onCheckedChange={(checked) => {
                        const isDisabling = !checked;
                        const shouldClearModelSelection =
                          isDisabling && textGenProvider === providerCard.provider;
                        updateSettings({
                          providers: {
                            ...settings.providers,
                            [providerCard.provider]: {
                              ...settings.providers[providerCard.provider],
                              enabled: Boolean(checked),
                            },
                          },
                          ...(shouldClearModelSelection
                            ? {
                                textGenerationModelSelection:
                                  DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                              }
                            : {}),
                        });
                      }}
                      aria-label={`Enable ${providerDisplayName}`}
                    />
                  </div>
                </div>
              </div>

              <Collapsible
                open={openProviderDetails[providerCard.provider]}
                onOpenChange={(open) =>
                  setOpenProviderDetails((existing) => ({
                    ...existing,
                    [providerCard.provider]: open,
                  }))
                }
              >
                <CollapsibleContent>
                  <div className="space-y-0">
                    <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                      <label
                        htmlFor={`provider-install-${providerCard.provider}-binary-path`}
                        className="block"
                      >
                        <span className="text-xs font-medium text-foreground">
                          {providerDisplayName} binary path
                        </span>
                        <Input
                          id={`provider-install-${providerCard.provider}-binary-path`}
                          className="mt-1.5"
                          value={providerCard.binaryPathValue}
                          onChange={(event) =>
                            updateSettings({
                              providers: {
                                ...settings.providers,
                                [providerCard.provider]: {
                                  ...settings.providers[providerCard.provider],
                                  binaryPath: event.target.value,
                                },
                              },
                            })
                          }
                          placeholder={providerCard.binaryPlaceholder}
                          spellCheck={false}
                        />
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {providerCard.binaryDescription}
                        </span>
                      </label>
                    </div>

                    {providerCard.serverUrlPlaceholder ? (
                      <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                        <label
                          htmlFor={`provider-install-${providerCard.provider}-server-url`}
                          className="block"
                        >
                          <span className="text-xs font-medium text-foreground">
                            {providerDisplayName} server URL
                          </span>
                          <Input
                            id={`provider-install-${providerCard.provider}-server-url`}
                            className="mt-1.5"
                            value={providerCard.serverUrlValue}
                            onChange={(event) =>
                              updateSettings({
                                providers: {
                                  ...settings.providers,
                                  [providerCard.provider]: {
                                    ...settings.providers[providerCard.provider],
                                    ...(providerCard.provider === "opencode"
                                      ? { serverUrl: event.target.value }
                                      : {}),
                                  },
                                },
                              })
                            }
                            placeholder={providerCard.serverUrlPlaceholder}
                            spellCheck={false}
                          />
                          {providerCard.serverUrlDescription ? (
                            <span className="mt-1 block text-xs text-muted-foreground">
                              {providerCard.serverUrlDescription}
                            </span>
                          ) : null}
                        </label>
                      </div>
                    ) : null}

                    {providerCard.serverPasswordPlaceholder ? (
                      <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                        <label
                          htmlFor={`provider-install-${providerCard.provider}-server-password`}
                          className="block"
                        >
                          <span className="text-xs font-medium text-foreground">
                            {providerDisplayName} server password
                          </span>
                          <Input
                            id={`provider-install-${providerCard.provider}-server-password`}
                            className="mt-1.5"
                            type="password"
                            autoComplete="off"
                            value={providerCard.serverPasswordValue}
                            onChange={(event) =>
                              updateSettings({
                                providers: {
                                  ...settings.providers,
                                  [providerCard.provider]: {
                                    ...settings.providers[providerCard.provider],
                                    ...(providerCard.provider === "opencode"
                                      ? { serverPassword: event.target.value }
                                      : {}),
                                  },
                                },
                              })
                            }
                            placeholder={providerCard.serverPasswordPlaceholder}
                            spellCheck={false}
                          />
                          {providerCard.serverPasswordDescription ? (
                            <span className="mt-1 block text-xs text-muted-foreground">
                              {providerCard.serverPasswordDescription}
                            </span>
                          ) : null}
                        </label>
                      </div>
                    ) : null}

                    {providerCard.homePathKey ? (
                      <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                        <label
                          htmlFor={`provider-install-${providerCard.homePathKey}`}
                          className="block"
                        >
                          <span className="text-xs font-medium text-foreground">
                            CODEX_HOME path
                          </span>
                          <Input
                            id={`provider-install-${providerCard.homePathKey}`}
                            className="mt-1.5"
                            value={codexHomePath}
                            onChange={(event) =>
                              updateSettings({
                                providers: {
                                  ...settings.providers,
                                  codex: {
                                    ...settings.providers.codex,
                                    homePath: event.target.value,
                                  },
                                },
                              })
                            }
                            placeholder={providerCard.homePlaceholder}
                            spellCheck={false}
                          />
                          {providerCard.homeDescription ? (
                            <span className="mt-1 block text-xs text-muted-foreground">
                              {providerCard.homeDescription}
                            </span>
                          ) : null}
                        </label>
                      </div>
                    ) : null}

                    {providerCard.provider === "claudeAgent" ? (
                      <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                        <label htmlFor="provider-install-claudeAgent-launch-args" className="block">
                          <span className="text-xs font-medium text-foreground">
                            Launch arguments
                          </span>
                          <Input
                            id="provider-install-claudeAgent-launch-args"
                            className="mt-1.5"
                            value={settings.providers.claudeAgent.launchArgs}
                            onChange={(event) =>
                              updateSettings({
                                providers: {
                                  ...settings.providers,
                                  claudeAgent: {
                                    ...settings.providers.claudeAgent,
                                    launchArgs: event.target.value,
                                  },
                                },
                              })
                            }
                            placeholder="e.g. --chrome"
                            spellCheck={false}
                          />
                          <span className="mt-1 block text-xs text-muted-foreground">
                            Additional CLI arguments passed to Claude Code on session start.
                          </span>
                        </label>
                      </div>
                    ) : null}

                    <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                      <div className="text-xs font-medium text-foreground">Models</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {providerCard.models.length} model
                        {providerCard.models.length === 1 ? "" : "s"} available.
                      </div>
                      <div
                        ref={(el) => {
                          modelListRefs.current[providerCard.provider] = el;
                        }}
                        className="mt-2 max-h-40 overflow-y-auto pb-1"
                      >
                        {providerCard.models.map((model) => {
                          const caps = model.capabilities;
                          const capLabels: string[] = [];
                          const descriptors = caps?.optionDescriptors ?? [];
                          if (descriptors.some((descriptor) => descriptor.id === "fastMode")) {
                            capLabels.push("Fast mode");
                          }
                          if (descriptors.some((descriptor) => descriptor.id === "thinking")) {
                            capLabels.push("Thinking");
                          }
                          if (
                            descriptors.some(
                              (descriptor) =>
                                descriptor.type === "select" &&
                                (descriptor.id === "reasoningEffort" ||
                                  descriptor.id === "effort" ||
                                  descriptor.id === "reasoning" ||
                                  descriptor.id === "variant"),
                            )
                          ) {
                            capLabels.push("Reasoning");
                          }
                          const hasDetails = capLabels.length > 0 || model.name !== model.slug;

                          return (
                            <div
                              key={`${providerCard.provider}:${model.slug}`}
                              className="flex items-center gap-2 py-1"
                            >
                              <span className="min-w-0 truncate text-xs text-foreground/90">
                                {model.name}
                              </span>
                              {hasDetails ? (
                                <Tooltip>
                                  <TooltipTrigger
                                    render={
                                      <button
                                        type="button"
                                        className="shrink-0 text-muted-foreground/40 transition-colors hover:text-muted-foreground"
                                        aria-label={`Details for ${model.name}`}
                                      />
                                    }
                                  >
                                    <InfoIcon className="size-3" />
                                  </TooltipTrigger>
                                  <TooltipPopup side="top" className="max-w-56">
                                    <div className="space-y-1">
                                      <code className="block text-[11px] text-foreground">
                                        {model.slug}
                                      </code>
                                      {capLabels.length > 0 ? (
                                        <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                                          {capLabels.map((label) => (
                                            <span
                                              key={label}
                                              className="text-[10px] text-muted-foreground"
                                            >
                                              {label}
                                            </span>
                                          ))}
                                        </div>
                                      ) : null}
                                    </div>
                                  </TooltipPopup>
                                </Tooltip>
                              ) : null}
                              {model.isCustom ? (
                                <div className="ml-auto flex shrink-0 items-center gap-1.5">
                                  <span className="text-[10px] text-muted-foreground">custom</span>
                                  <button
                                    type="button"
                                    className="text-muted-foreground transition-colors hover:text-foreground"
                                    aria-label={`Remove ${model.slug}`}
                                    onClick={() =>
                                      removeCustomModel(providerCard.provider, model.slug)
                                    }
                                  >
                                    <XIcon className="size-3" />
                                  </button>
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>

                      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                        <Input
                          id={`custom-model-${providerCard.provider}`}
                          value={customModelInput}
                          onChange={(event) => {
                            const value = event.target.value;
                            setCustomModelInputByProvider((existing) => ({
                              ...existing,
                              [providerCard.provider]: value,
                            }));
                            if (customModelError) {
                              setCustomModelErrorByProvider((existing) => ({
                                ...existing,
                                [providerCard.provider]: null,
                              }));
                            }
                          }}
                          onKeyDown={(event) => {
                            if (event.key !== "Enter") return;
                            event.preventDefault();
                            addCustomModel(providerCard.provider);
                          }}
                          placeholder={
                            providerCard.provider === "codex"
                              ? "gpt-6.7-codex-ultra-preview"
                              : providerCard.provider === "opencode"
                                ? "openai/gpt-5"
                                : "claude-sonnet-5-0"
                          }
                          spellCheck={false}
                        />
                        <Button
                          className="shrink-0"
                          variant="outline"
                          onClick={() => addCustomModel(providerCard.provider)}
                        >
                          <PlusIcon className="size-3.5" />
                          Add
                        </Button>
                      </div>

                      {customModelError ? (
                        <p className="mt-2 text-xs text-destructive">{customModelError}</p>
                      ) : null}
                    </div>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </div>
          );
        })}
      </SettingsSection>

      <SettingsSection title="Advanced">
        <SettingsRow
          title="Keybindings"
          description="Open the persisted `keybindings.json` file to edit advanced bindings directly."
          status={
            <>
              <span className="block break-all font-mono text-[11px] text-foreground">
                {keybindingsConfigPath ?? "Resolving keybindings path..."}
              </span>
              {openKeybindingsError ? (
                <span className="mt-1 block text-destructive">{openKeybindingsError}</span>
              ) : (
                <span className="mt-1 block">Opens in your preferred editor.</span>
              )}
            </>
          }
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={!keybindingsConfigPath || isOpeningKeybindings}
              onClick={openKeybindingsFile}
            >
              {isOpeningKeybindings ? "Opening..." : "Open file"}
            </Button>
          }
        />
      </SettingsSection>

      <SettingsSection title="About">
        {isElectron ? (
          <AboutVersionSection />
        ) : (
          <SettingsRow
            title={<AboutVersionTitle />}
            description="Current version of the application."
          />
        )}
        <SettingsRow
          title="Diagnostics"
          description={diagnosticsDescription}
          status={
            <>
              <span className="block break-all font-mono text-[11px] text-foreground">
                {logsDirectoryPath ?? "Resolving logs directory..."}
              </span>
              {openDiagnosticsError ? (
                <span className="mt-1 block text-destructive">{openDiagnosticsError}</span>
              ) : null}
            </>
          }
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={!logsDirectoryPath || isOpeningLogsDirectory}
              onClick={openLogsDirectory}
            >
              {isOpeningLogsDirectory ? "Opening..." : "Open logs folder"}
            </Button>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

type ScheduledJobFormState = {
  projectId: string;
  title: string;
  prompt: string;
  provider: ProviderKind;
  model: string;
  runtimeMode: "approval-required" | "auto-accept-edits" | "full-access";
  interactionMode: "default" | "plan";
  intervalHours: string;
};

const DEFAULT_SCHEDULED_JOB_FORM: ScheduledJobFormState = {
  projectId: "",
  title: "",
  prompt: "",
  provider: "codex",
  model: "",
  runtimeMode: "full-access",
  interactionMode: "default",
  intervalHours: "24",
};

function toScheduledJobFormState(
  job: ReturnType<typeof selectScheduledJobsAcrossEnvironments>[number],
): ScheduledJobFormState {
  return {
    projectId: job.projectId,
    title: job.title,
    prompt: job.prompt,
    provider: job.modelSelection.provider,
    model: job.modelSelection.model,
    runtimeMode: job.runtimeMode,
    interactionMode: job.interactionMode,
    intervalHours: String(Math.max(1, Math.round(job.schedule.intervalMinutes / 60))),
  };
}

function providerModelOptionsByProvider(
  providers: ReadonlyArray<ServerProvider>,
): Record<ProviderKind, ReadonlyArray<ServerProviderModel>> {
  return {
    codex: providers.find((provider) => provider.provider === "codex")?.models ?? [],
    claudeAgent: providers.find((provider) => provider.provider === "claudeAgent")?.models ?? [],
    cursor: providers.find((provider) => provider.provider === "cursor")?.models ?? [],
    opencode: providers.find((provider) => provider.provider === "opencode")?.models ?? [],
  };
}

function nextScheduledJobModel(
  provider: ProviderKind,
  modelsByProvider: Record<ProviderKind, ReadonlyArray<ServerProviderModel>>,
  currentModel: string,
): string {
  const providerModels = modelsByProvider[provider];
  if (providerModels.some((model) => model.slug === currentModel)) {
    return currentModel;
  }
  return providerModels[0]?.slug ?? "";
}

function formatScheduledJobInterval(
  job: ReturnType<typeof selectScheduledJobsAcrossEnvironments>[number],
) {
  const hours = Math.max(1, Math.round(job.schedule.intervalMinutes / 60));
  return hours === 1 ? "Every hour" : `Every ${hours} hours`;
}

function scheduledJobStatusLabel(status: "active" | "paused") {
  return status === "active" ? "Active" : "Paused";
}

function scheduledJobOutcomeLabel(outcome: "succeeded" | "failed" | "interrupted" | null) {
  switch (outcome) {
    case "succeeded":
      return "Succeeded";
    case "failed":
      return "Failed";
    case "interrupted":
      return "Interrupted";
    default:
      return "No runs yet";
  }
}

export function ScheduledJobsPanel() {
  const navigate = useNavigate();
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const jobs = useStore(useShallow(selectScheduledJobsAcrossEnvironments));
  const providers = useServerProviders();
  const [formState, setFormState] = useState<ScheduledJobFormState>(() => {
    const initialProject = projects[0];
    const modelsByProvider = providerModelOptionsByProvider(providers);
    const initialModel = nextScheduledJobModel("codex", modelsByProvider, "");
    return {
      ...DEFAULT_SCHEDULED_JOB_FORM,
      projectId: initialProject?.id ?? "",
      model: initialModel,
    };
  });
  const [editingJobId, setEditingJobId] = useState<ScheduledJobId | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const editingJob = useMemo(
    () => jobs.find((job) => job.id === editingJobId) ?? null,
    [editingJobId, jobs],
  );
  const modelsByProvider = useMemo(() => providerModelOptionsByProvider(providers), [providers]);
  const projectsById = useMemo(
    () => Object.fromEntries(projects.map((project) => [project.id, project] as const)),
    [projects],
  );
  const selectedProjectTitle = projectsById[formState.projectId]?.name;
  const providerSupportSummary = useMemo(() => {
    return providers
      .filter((provider) => provider.schedulingSupport !== "none")
      .map(
        (provider) => `${PROVIDER_DISPLAY_NAMES[provider.provider]}: ${provider.schedulingSupport}`,
      )
      .join(" · ");
  }, [providers]);

  const updateForm = useCallback(
    (patch: Partial<ScheduledJobFormState>) =>
      setFormState((current) => {
        const next = {
          ...current,
          ...patch,
        };
        if (patch.provider !== undefined) {
          next.model = nextScheduledJobModel(patch.provider, modelsByProvider, current.model);
        }
        return next;
      }),
    [modelsByProvider],
  );

  const resetForm = useCallback(() => {
    const defaultProject = projects[0];
    setEditingJobId(null);
    setFormState({
      ...DEFAULT_SCHEDULED_JOB_FORM,
      projectId: defaultProject?.id ?? "",
      model: nextScheduledJobModel("codex", modelsByProvider, ""),
    });
  }, [modelsByProvider, projects]);

  useEffect(() => {
    if (!editingJobId) {
      return;
    }
    if (!editingJob) {
      resetForm();
      return;
    }
    setFormState(toScheduledJobFormState(editingJob));
  }, [editingJob, editingJobId, resetForm]);

  const validateForm = useCallback(() => {
    const selectedProject = projectsById[formState.projectId];
    if (!selectedProject) {
      throw new Error("Choose a project for this job.");
    }
    if (formState.title.trim().length === 0) {
      throw new Error("Enter a title for this job.");
    }
    if (formState.prompt.trim().length === 0) {
      throw new Error("Enter the prompt to run.");
    }
    const intervalHours = Number.parseInt(formState.intervalHours, 10);
    if (!Number.isInteger(intervalHours) || intervalHours < 1 || intervalHours > 168) {
      throw new Error("Interval must be between 1 and 168 hours.");
    }
    if (formState.model.trim().length === 0) {
      throw new Error("Choose a model.");
    }
    return {
      project: selectedProject,
      intervalHours,
    };
  }, [formState, projectsById]);

  const saveJob = useCallback(async () => {
    const { project, intervalHours } = validateForm();
    const api = ensureEnvironmentApi(project.environmentId);
    setIsSaving(true);
    try {
      if (editingJobId) {
        await api.orchestration.dispatchCommand({
          type: "scheduled-job.update",
          commandId: CommandId.make(crypto.randomUUID()),
          jobId: editingJobId,
          title: formState.title,
          prompt: formState.prompt,
          modelSelection: {
            provider: formState.provider,
            model: formState.model,
          },
          runtimeMode: formState.runtimeMode,
          interactionMode: formState.interactionMode,
          schedule: {
            type: "interval",
            intervalMinutes: intervalHours * 60,
          },
          createdAt: new Date().toISOString(),
        });
      } else {
        await api.orchestration.dispatchCommand(
          buildScheduledJobCreateCommand({
            projectId: project.id,
            title: formState.title,
            prompt: formState.prompt,
            modelSelection: {
              provider: formState.provider,
              model: formState.model,
            },
            runtimeMode: formState.runtimeMode,
            interactionMode: formState.interactionMode,
            intervalHours,
          }),
        );
      }
      resetForm();
    } finally {
      setIsSaving(false);
    }
  }, [editingJobId, formState, resetForm, validateForm]);

  const handleJobAction = useCallback(
    async (
      job: ReturnType<typeof selectScheduledJobsAcrossEnvironments>[number],
      action: "pause" | "resume" | "run" | "delete",
    ) => {
      const project = projectsById[job.projectId];
      if (!project) {
        return;
      }
      const api = ensureEnvironmentApi(project.environmentId);
      const createdAt = new Date().toISOString();
      switch (action) {
        case "pause":
          await api.orchestration.dispatchCommand(
            buildScheduledJobPauseCommand({ jobId: job.id, createdAt }),
          );
          return;
        case "resume":
          await api.orchestration.dispatchCommand(
            buildScheduledJobResumeCommand({ jobId: job.id, createdAt }),
          );
          return;
        case "delete":
          await api.orchestration.dispatchCommand(
            buildScheduledJobDeleteCommand({ jobId: job.id, createdAt }),
          );
          if (editingJobId === job.id) {
            resetForm();
          }
          return;
        case "run":
          await api.orchestration.dispatchCommand(
            buildScheduledJobRunNowCommand({ jobId: job.id, createdAt }),
          );
          return;
      }
    },
    [editingJobId, projectsById, resetForm],
  );

  const groupedJobs = useMemo(() => {
    return projects
      .map((project) => ({
        project,
        jobs: jobs
          .filter((job) => job.projectId === project.id)
          .toSorted(
            (left, right) =>
              right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id),
          ),
      }))
      .filter((group) => group.jobs.length > 0);
  }, [jobs, projects]);

  return (
    <SettingsPageContainer>
      <SettingsSection
        title={editingJobId ? "Edit job" : "New job"}
        icon={<CalendarClockIcon className="size-3.5" />}
      >
        <SettingsRow
          title={editingJobId ? "Scheduled job" : "Create scheduled job"}
          description="Project-level recurring jobs create a fresh thread on each run and dispatch a normal agent turn through orchestration."
          status={
            providerSupportSummary
              ? providerSupportSummary
              : "Provider-native scheduling metadata is informational only in this version."
          }
        >
          <div className="mt-4 grid gap-3 pb-4 sm:grid-cols-2">
            <Select
              value={formState.projectId}
              onValueChange={(value) => {
                if (value) {
                  updateForm({ projectId: value });
                }
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choose project">
                  {selectedProjectTitle ?? "Choose project"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Input
              value={formState.title}
              placeholder="Daily review"
              onChange={(event) => updateForm({ title: event.target.value })}
            />
            <Select
              value={formState.provider}
              onValueChange={(value) =>
                updateForm({ provider: value as ScheduledJobFormState["provider"] })
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choose provider" />
              </SelectTrigger>
              <SelectPopup>
                {providers.map((provider) => (
                  <SelectItem key={provider.provider} value={provider.provider}>
                    {PROVIDER_DISPLAY_NAMES[provider.provider]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Select
              value={formState.model}
              onValueChange={(value) => {
                if (value) {
                  updateForm({ model: value });
                }
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choose model" />
              </SelectTrigger>
              <SelectPopup>
                {modelsByProvider[formState.provider].map((model) => (
                  <SelectItem key={model.slug} value={model.slug}>
                    {model.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Select
              value={formState.runtimeMode}
              onValueChange={(value) =>
                updateForm({ runtimeMode: value as ScheduledJobFormState["runtimeMode"] })
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="full-access">Full access</SelectItem>
                <SelectItem value="auto-accept-edits">Auto-accept edits</SelectItem>
                <SelectItem value="approval-required">Approval required</SelectItem>
              </SelectPopup>
            </Select>
            <Select
              value={formState.interactionMode}
              onValueChange={(value) =>
                updateForm({ interactionMode: value as ScheduledJobFormState["interactionMode"] })
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="default">Default</SelectItem>
                <SelectItem value="plan">Plan</SelectItem>
              </SelectPopup>
            </Select>
            <Input
              type="number"
              min={1}
              max={168}
              value={formState.intervalHours}
              placeholder="24"
              onChange={(event) => updateForm({ intervalHours: event.target.value })}
            />
            <div className="sm:col-span-2">
              <Textarea
                value={formState.prompt}
                rows={6}
                placeholder="Review the project and summarize any build breaks, CI issues, or obvious regressions."
                onChange={(event) => updateForm({ prompt: event.target.value })}
              />
            </div>
            <div className="flex items-center gap-2 sm:col-span-2">
              <Button
                size="sm"
                className="gap-1.5"
                disabled={isSaving || projects.length === 0}
                onClick={() =>
                  void saveJob().catch((error) => {
                    toastManager.add({
                      type: "error",
                      title: editingJobId ? "Failed to update job" : "Failed to create job",
                      description: error instanceof Error ? error.message : "An error occurred.",
                    });
                  })
                }
              >
                {isSaving ? (
                  <LoaderIcon className="size-3.5 animate-spin" />
                ) : (
                  <PlusIcon className="size-3.5" />
                )}
                {editingJobId ? "Save changes" : "Create job"}
              </Button>
              {editingJobId ? (
                <Button size="sm" variant="outline" onClick={resetForm}>
                  Cancel
                </Button>
              ) : null}
            </div>
          </div>
        </SettingsRow>
      </SettingsSection>

      {groupedJobs.length === 0 ? (
        <SettingsSection title="Scheduled jobs">
          <Empty className="min-h-88">
            <EmptyMedia variant="icon">
              <Clock3Icon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>No scheduled jobs</EmptyTitle>
              <EmptyDescription>
                Create a recurring project job to run agent turns on a schedule.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </SettingsSection>
      ) : (
        groupedJobs.map(({ project, jobs: projectJobs }) => (
          <SettingsSection
            key={project.id}
            title={project.name}
            icon={<ProjectFavicon environmentId={project.environmentId} cwd={project.cwd} />}
          >
            {projectJobs.map((job) => (
              <div
                key={job.id}
                className="border-t border-border px-4 py-4 first:border-t-0 sm:px-5"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate text-sm font-medium text-foreground">{job.title}</h3>
                      <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                        {scheduledJobStatusLabel(job.status)}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatScheduledJobInterval(job)} {" · "}
                      {PROVIDER_DISPLAY_NAMES[job.modelSelection.provider]} {" · "}
                      {job.modelSelection.model}
                    </p>
                    <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-muted-foreground/85">
                      {job.prompt}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                      <span>
                        Next run{" "}
                        {job.nextRunAt ? formatRelativeTimeLabel(job.nextRunAt) : "not scheduled"}
                      </span>
                      <span>Last outcome {scheduledJobOutcomeLabel(job.lastOutcome)}</span>
                      <span>Updated {formatRelativeTimeLabel(job.updatedAt)}</span>
                    </div>
                    {job.lastError ? (
                      <p className="mt-2 text-[11px] text-destructive">{job.lastError}</p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5"
                      onClick={() =>
                        void handleJobAction(job, "run").catch((error) => {
                          toastManager.add({
                            type: "error",
                            title: "Failed to run job",
                            description:
                              error instanceof Error ? error.message : "An error occurred.",
                          });
                        })
                      }
                    >
                      <PlayIcon className="size-3.5" />
                      Run now
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5"
                      onClick={() => {
                        setEditingJobId(job.id);
                        setFormState(toScheduledJobFormState(job));
                      }}
                    >
                      <PencilIcon className="size-3.5" />
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5"
                      onClick={() =>
                        void handleJobAction(
                          job,
                          job.status === "active" ? "pause" : "resume",
                        ).catch((error) => {
                          toastManager.add({
                            type: "error",
                            title:
                              job.status === "active"
                                ? "Failed to pause job"
                                : "Failed to resume job",
                            description:
                              error instanceof Error ? error.message : "An error occurred.",
                          });
                        })
                      }
                    >
                      {job.status === "active" ? (
                        <PauseIcon className="size-3.5" />
                      ) : (
                        <PlayIcon className="size-3.5" />
                      )}
                      {job.status === "active" ? "Pause" : "Resume"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5 text-destructive hover:text-destructive"
                      onClick={() =>
                        void handleJobAction(job, "delete").catch((error) => {
                          toastManager.add({
                            type: "error",
                            title: "Failed to delete job",
                            description:
                              error instanceof Error ? error.message : "An error occurred.",
                          });
                        })
                      }
                    >
                      <Trash2Icon className="size-3.5" />
                      Delete
                    </Button>
                  </div>
                </div>
                <div className="mt-4 rounded-xl border border-border/70 bg-background/40 p-3">
                  <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                    <CheckCircle2Icon className="size-3.5" />
                    Recent runs
                  </div>
                  {job.runs.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No runs recorded yet.</p>
                  ) : (
                    <div className="space-y-2">
                      {job.runs.slice(0, 5).map((run) => (
                        <div
                          key={run.id}
                          className="flex flex-wrap items-center justify-between gap-2 text-xs"
                        >
                          <div className="min-w-0 text-muted-foreground">
                            <span className="font-medium text-foreground">
                              {scheduledJobOutcomeLabel(run.outcome)}
                            </span>
                            {" · "}
                            {formatRelativeTimeLabel(run.startedAt)}
                            {" · "}
                            {run.trigger === "manual" ? "Manual" : "Scheduled"}
                            {run.error ? ` · ${run.error}` : ""}
                          </div>
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() =>
                              void navigate({
                                to: "/$environmentId/$threadId",
                                params: buildThreadRouteParams(
                                  scopeThreadRef(job.environmentId, run.threadId),
                                ),
                              })
                            }
                          >
                            Open thread
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </SettingsSection>
        ))
      )}
    </SettingsPageContainer>
  );
}

export function ArchivedThreadsPanel() {
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const threads = useStore(useShallow(selectThreadShellsAcrossEnvironments));
  const { unarchiveThread, confirmAndDeleteThread } = useThreadActions();
  const archivedGroups = useMemo(() => {
    return projects
      .map((project) => ({
        project,
        threads: threads
          .filter((thread) => thread.projectId === project.id && thread.archivedAt !== null)
          .toSorted((left, right) => {
            const leftKey = left.archivedAt ?? left.createdAt;
            const rightKey = right.archivedAt ?? right.createdAt;
            return rightKey.localeCompare(leftKey) || right.id.localeCompare(left.id);
          }),
      }))
      .filter((group) => group.threads.length > 0);
  }, [projects, threads]);

  const handleArchivedThreadContextMenu = useCallback(
    async (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const clicked = await api.contextMenu.show(
        [
          { id: "unarchive", label: "Unarchive" },
          { id: "delete", label: "Delete", destructive: true },
        ],
        position,
      );

      if (clicked === "unarchive") {
        try {
          await unarchiveThread(threadRef);
        } catch (error) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to unarchive thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }

      if (clicked === "delete") {
        await confirmAndDeleteThread(threadRef);
      }
    },
    [confirmAndDeleteThread, unarchiveThread],
  );

  return (
    <SettingsPageContainer>
      {archivedGroups.length === 0 ? (
        <SettingsSection title="Archived threads">
          <Empty className="min-h-88">
            <EmptyMedia variant="icon">
              <ArchiveIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>No archived threads</EmptyTitle>
              <EmptyDescription>Archived threads will appear here.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </SettingsSection>
      ) : (
        archivedGroups.map(({ project, threads: projectThreads }) => (
          <SettingsSection
            key={project.id}
            title={project.name}
            icon={<ProjectFavicon environmentId={project.environmentId} cwd={project.cwd} />}
          >
            {projectThreads.map((thread) => (
              <div
                key={thread.id}
                className="flex items-center justify-between gap-3 border-t border-border px-4 py-3 first:border-t-0 sm:px-5"
                onContextMenu={(event) => {
                  event.preventDefault();
                  void handleArchivedThreadContextMenu(
                    scopeThreadRef(thread.environmentId, thread.id),
                    {
                      x: event.clientX,
                      y: event.clientY,
                    },
                  );
                }}
              >
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-sm font-medium text-foreground">{thread.title}</h3>
                  <p className="text-xs text-muted-foreground">
                    Archived {formatRelativeTimeLabel(thread.archivedAt ?? thread.createdAt)}
                    {" \u00b7 Created "}
                    {formatRelativeTimeLabel(thread.createdAt)}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 shrink-0 cursor-pointer gap-1.5 px-2.5"
                  onClick={() =>
                    void unarchiveThread(scopeThreadRef(thread.environmentId, thread.id)).catch(
                      (error) => {
                        toastManager.add(
                          stackedThreadToast({
                            type: "error",
                            title: "Failed to unarchive thread",
                            description:
                              error instanceof Error ? error.message : "An error occurred.",
                          }),
                        );
                      },
                    )
                  }
                >
                  <ArchiveX className="size-3.5" />
                  <span>Unarchive</span>
                </Button>
              </div>
            ))}
          </SettingsSection>
        ))
      )}
    </SettingsPageContainer>
  );
}
