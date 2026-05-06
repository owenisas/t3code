import { MessageId, ProviderInstanceId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ComposerQueuedFollowUps } from "./ComposerQueuedFollowUps";

describe("ComposerQueuedFollowUps", () => {
  it("renders queued follow-ups above the composer with text, attachment, and model metadata", () => {
    const markup = renderToStaticMarkup(
      <ComposerQueuedFollowUps
        onEdit={() => undefined}
        onDelete={() => undefined}
        followUps={[
          {
            id: "follow-up-1",
            messageId: MessageId.make("message-1"),
            text: "Please also update the error state copy in the empty view.",
            attachments: [],
            modelSelection: null,
            queuedAt: "2026-04-12T23:00:00.000Z",
          },
          {
            id: "follow-up-2",
            messageId: MessageId.make("message-2"),
            text: "",
            attachments: [
              {
                id: "attachment-1",
                type: "image",
                mimeType: "image/png",
                name: "bug.png",
                sizeBytes: 1024,
                previewUrl: "http://localhost/attachments/attachment-1",
              },
            ],
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "sonnet",
            },
            queuedAt: "2026-04-12T23:01:00.000Z",
          },
        ]}
      />,
    );

    expect(markup).toContain('data-chat-composer-queued-follow-ups="true"');
    expect(markup).toContain("Queued Follow-Ups");
    expect(markup).toContain("Please also update the error state copy in the empty view.");
    expect(markup).toContain("1 attachment");
    expect(markup).toContain("Edit");
    expect(markup).toContain("Delete");
    expect(markup).toContain('src="http://localhost/attachments/attachment-1"');
    expect(markup).toContain('alt="bug.png"');
    expect(markup).toContain("claudeAgent sonnet");
  });
});
