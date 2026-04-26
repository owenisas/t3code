import { useState } from "react";
import { PROVIDER_DISPLAY_NAMES } from "@t3tools/contracts";
import { CheckIcon, PencilIcon, Trash2Icon, XIcon } from "lucide-react";
import type { Thread } from "../../types";
import { Button } from "../ui/button";

function summarizeQueuedFollowUp(followUp: Thread["queuedFollowUps"][number]): {
  preview: string;
  attachmentLabel: string | null;
  modelLabel: string | null;
  modeLabel: string | null;
  imageAttachments: Thread["queuedFollowUps"][number]["attachments"];
} {
  const trimmedText = followUp.text.trim();
  const attachmentCount = followUp.attachments.length;

  const preview =
    trimmedText.length > 0
      ? trimmedText
      : attachmentCount === 0
        ? "Queued follow-up"
        : attachmentCount === 1
          ? "Queued follow-up with 1 attachment"
          : `Queued follow-up with ${attachmentCount} attachments`;

  const attachmentLabel =
    attachmentCount === 0
      ? null
      : attachmentCount === 1
        ? "1 attachment"
        : `${attachmentCount} attachments`;

  const modelLabel = followUp.modelSelection
    ? `${PROVIDER_DISPLAY_NAMES[followUp.modelSelection.provider]} ${followUp.modelSelection.model}`
    : null;
  const modeLabel =
    followUp.interactionMode === "plan"
      ? "Plan"
      : followUp.interactionMode === "default"
        ? "Build"
        : null;

  return {
    preview,
    attachmentLabel,
    modelLabel,
    modeLabel,
    imageAttachments: followUp.attachments.filter((attachment) => attachment.type === "image"),
  };
}

export function ComposerQueuedFollowUps(props: {
  followUps: Thread["queuedFollowUps"];
  onEdit?: (followUpId: string, text: string) => void | Promise<void>;
  onDelete?: (followUpId: string) => void | Promise<void>;
}) {
  const [editingFollowUpId, setEditingFollowUpId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [busyFollowUpId, setBusyFollowUpId] = useState<string | null>(null);

  if (props.followUps.length === 0) {
    return null;
  }

  const startEditing = (followUp: Thread["queuedFollowUps"][number]) => {
    setEditingFollowUpId(followUp.id);
    setEditingText(followUp.text);
  };

  const cancelEditing = () => {
    setEditingFollowUpId(null);
    setEditingText("");
  };

  const saveEditing = async (followUp: Thread["queuedFollowUps"][number]) => {
    if (!props.onEdit) return;
    const nextText = editingText;
    if (nextText.trim().length === 0 && followUp.attachments.length === 0) return;
    setBusyFollowUpId(followUp.id);
    try {
      await props.onEdit(followUp.id, nextText);
      cancelEditing();
    } finally {
      setBusyFollowUpId(null);
    }
  };

  const deleteFollowUp = async (followUpId: string) => {
    if (!props.onDelete) return;
    if (editingFollowUpId === followUpId) {
      cancelEditing();
    }
    setBusyFollowUpId(followUpId);
    try {
      await props.onDelete(followUpId);
    } finally {
      setBusyFollowUpId(null);
    }
  };

  return (
    <div
      data-chat-composer-queued-follow-ups="true"
      className="mx-2.5 mb-2 rounded-2xl border border-border/65 bg-muted/20 px-2.5 py-2 sm:mx-3"
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="text-[11px] font-medium tracking-[0.12em] text-muted-foreground/80 uppercase">
          Queued Follow-Ups
        </div>
        <div className="text-[11px] text-muted-foreground/75">
          {props.followUps.length === 1
            ? "Runs after this turn finishes"
            : `${props.followUps.length} waiting`}
        </div>
      </div>
      <div className="flex max-h-36 flex-col gap-1.5 overflow-y-auto pr-1">
        {props.followUps.map((followUp, index) => {
          const summary = summarizeQueuedFollowUp(followUp);
          const isEditing = editingFollowUpId === followUp.id;
          const isBusy = busyFollowUpId === followUp.id;
          const canSave =
            props.onEdit !== undefined &&
            isEditing &&
            editingText !== followUp.text &&
            (editingText.trim().length > 0 || followUp.attachments.length > 0);
          return (
            <div
              key={followUp.id}
              className="rounded-xl border border-border/55 bg-background/80 px-2.5 py-2"
            >
              <div className="flex items-start gap-2.5">
                <div className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground">
                  {index + 1}
                </div>
                <div className="min-w-0 flex-1">
                  {isEditing ? (
                    <textarea
                      value={editingText}
                      rows={2}
                      className="min-h-16 w-full resize-y rounded-lg border border-border bg-background px-2 py-1.5 text-sm leading-5 outline-none focus:border-primary/60"
                      aria-label="Edit queued follow-up"
                      disabled={isBusy}
                      onChange={(event) => {
                        setEditingText(event.target.value);
                      }}
                    />
                  ) : (
                    <p
                      className="line-clamp-2 text-sm leading-5 text-foreground/92"
                      title={summary.preview}
                    >
                      {summary.preview}
                    </p>
                  )}
                  {summary.attachmentLabel || summary.modelLabel || summary.modeLabel ? (
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground/80">
                      {summary.attachmentLabel ? <span>{summary.attachmentLabel}</span> : null}
                      {summary.modelLabel ? <span>{summary.modelLabel}</span> : null}
                      {summary.modeLabel ? <span>{summary.modeLabel}</span> : null}
                    </div>
                  ) : null}
                  {summary.imageAttachments.length > 0 ? (
                    <div className="mt-2 flex gap-1.5 overflow-hidden">
                      {summary.imageAttachments.slice(0, 4).map((attachment) =>
                        attachment.previewUrl ? (
                          <img
                            key={attachment.id}
                            src={attachment.previewUrl}
                            alt={attachment.name}
                            className="size-11 shrink-0 rounded-md border border-border/70 object-cover"
                          />
                        ) : (
                          <div
                            key={attachment.id}
                            className="flex size-11 shrink-0 items-center justify-center rounded-md border border-border/70 bg-muted/45 px-1 text-center text-[9px] leading-3 text-muted-foreground"
                            title={attachment.name}
                          >
                            IMG
                          </div>
                        ),
                      )}
                    </div>
                  ) : null}
                  {isEditing ? (
                    <div className="mt-2 flex items-center justify-end gap-1.5">
                      <Button
                        size="xs"
                        variant="secondary"
                        disabled={!canSave || isBusy}
                        onClick={() => void saveEditing(followUp)}
                      >
                        <CheckIcon className="size-3.5" />
                        Save
                      </Button>
                      <Button size="xs" variant="ghost" disabled={isBusy} onClick={cancelEditing}>
                        <XIcon className="size-3.5" />
                        Cancel
                      </Button>
                    </div>
                  ) : null}
                </div>
                {!isEditing && (props.onEdit || props.onDelete) ? (
                  <div className="ml-auto flex shrink-0 items-center gap-0.5">
                    {props.onEdit ? (
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        disabled={isBusy}
                        aria-label="Edit queued follow-up"
                        title="Edit queued follow-up"
                        onClick={() => startEditing(followUp)}
                      >
                        <PencilIcon className="size-3.5" />
                      </Button>
                    ) : null}
                    {props.onDelete ? (
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        disabled={isBusy}
                        aria-label="Delete queued follow-up"
                        title="Delete queued follow-up"
                        onClick={() => void deleteFollowUp(followUp.id)}
                      >
                        <Trash2Icon className="size-3.5" />
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
