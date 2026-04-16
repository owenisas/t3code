import { PROVIDER_DISPLAY_NAMES } from "@t3tools/contracts";
import type { Thread } from "../../types";

function summarizeQueuedFollowUp(followUp: Thread["queuedFollowUps"][number]): {
  preview: string;
  attachmentLabel: string | null;
  modelLabel: string | null;
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

  return {
    preview,
    attachmentLabel,
    modelLabel,
  };
}

export function ComposerQueuedFollowUps(props: { followUps: Thread["queuedFollowUps"] }) {
  if (props.followUps.length === 0) {
    return null;
  }

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
                  <p
                    className="line-clamp-2 text-sm leading-5 text-foreground/92"
                    title={summary.preview}
                  >
                    {summary.preview}
                  </p>
                  {summary.attachmentLabel || summary.modelLabel ? (
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground/80">
                      {summary.attachmentLabel ? <span>{summary.attachmentLabel}</span> : null}
                      {summary.modelLabel ? <span>{summary.modelLabel}</span> : null}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
