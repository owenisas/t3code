import { RuntimeMode } from "@t3tools/contracts";
import { memo, type ReactNode } from "react";
import { EllipsisIcon, ListTodoIcon } from "lucide-react";
import type { ComposerMode, YoloIterationLimit, YoloTriggerDelaySeconds } from "./ChatComposer";
import { Button } from "../ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  activePlan: boolean;
  composerMode: ComposerMode;
  planSidebarLabel: string;
  planSidebarOpen: boolean;
  runtimeMode: RuntimeMode;
  yoloIterationLimit: YoloIterationLimit;
  yoloTriggerDelaySeconds: YoloTriggerDelaySeconds;
  showInteractionModeToggle: boolean;
  traitsMenuContent?: ReactNode;
  onComposerModeChange: (mode: ComposerMode) => void;
  onTogglePlanSidebar: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  onYoloIterationLimitChange: (limit: YoloIterationLimit) => void;
  onYoloTriggerDelaySecondsChange: (seconds: YoloTriggerDelaySeconds) => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 px-2 text-muted-foreground/70 hover:text-foreground/80"
            aria-label="More composer controls"
          />
        }
      >
        <EllipsisIcon aria-hidden="true" className="size-4" />
      </MenuTrigger>
      <MenuPopup align="start">
        {props.traitsMenuContent ? (
          <>
            {props.traitsMenuContent}
            <MenuDivider />
          </>
        ) : null}
        {props.showInteractionModeToggle ? (
          <>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Mode</div>
            <MenuRadioGroup
              value={props.composerMode}
              onValueChange={(value) => {
                if (!value || value === props.composerMode) return;
                props.onComposerModeChange(value as ComposerMode);
              }}
            >
              <MenuRadioItem value="default">Build</MenuRadioItem>
              <MenuRadioItem value="plan">Plan</MenuRadioItem>
              <MenuRadioItem value="yolo">YOLO</MenuRadioItem>
            </MenuRadioGroup>
            {props.composerMode === "yolo" ? (
              <>
                <MenuDivider />
                <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
                  YOLO limit
                </div>
                <MenuRadioGroup
                  value={
                    props.yoloIterationLimit === null
                      ? "unlimited"
                      : String(props.yoloIterationLimit)
                  }
                  onValueChange={(value) => {
                    if (!value) return;
                    props.onYoloIterationLimitChange(
                      value === "unlimited" ? null : Number.parseInt(value, 10),
                    );
                  }}
                >
                  <MenuRadioItem value="3">3 reviews</MenuRadioItem>
                  <MenuRadioItem value="10">10 reviews</MenuRadioItem>
                  <MenuRadioItem value="25">25 reviews</MenuRadioItem>
                  <MenuRadioItem value="unlimited">Unlimited</MenuRadioItem>
                </MenuRadioGroup>
                <MenuDivider />
                <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
                  YOLO review delay
                </div>
                <MenuRadioGroup
                  value={String(props.yoloTriggerDelaySeconds)}
                  onValueChange={(value) => {
                    if (!value) return;
                    props.onYoloTriggerDelaySecondsChange(Number.parseInt(value, 10));
                  }}
                >
                  <MenuRadioItem value="0">Immediately</MenuRadioItem>
                  <MenuRadioItem value="10">10 sec</MenuRadioItem>
                  <MenuRadioItem value="30">30 sec</MenuRadioItem>
                  <MenuRadioItem value="60">1 min</MenuRadioItem>
                  <MenuRadioItem value="300">5 min</MenuRadioItem>
                </MenuRadioGroup>
              </>
            ) : null}
            <MenuDivider />
          </>
        ) : null}
        <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Access</div>
        <MenuRadioGroup
          value={props.runtimeMode}
          onValueChange={(value) => {
            if (!value || value === props.runtimeMode) return;
            props.onRuntimeModeChange(value as RuntimeMode);
          }}
        >
          <MenuRadioItem value="approval-required">Supervised</MenuRadioItem>
          <MenuRadioItem value="auto-accept-edits">Auto-accept edits</MenuRadioItem>
          <MenuRadioItem value="full-access">Full access</MenuRadioItem>
        </MenuRadioGroup>
        {props.activePlan ? (
          <>
            <MenuDivider />
            <MenuItem onClick={props.onTogglePlanSidebar}>
              <ListTodoIcon className="size-4 shrink-0" />
              {props.planSidebarOpen
                ? `Hide ${props.planSidebarLabel.toLowerCase()} sidebar`
                : `Show ${props.planSidebarLabel.toLowerCase()} sidebar`}
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
});
