import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  ThreadId,
  type ChatAttachment,
  type ClientOrchestrationCommand,
} from "@t3tools/contracts";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../config.ts";
import { WorkspacePathsLive } from "../workspace/Layers/WorkspacePaths.ts";
import { normalizeDispatchCommand } from "./Normalizer.ts";

const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

const TestLayer = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-normalizer-test-" }),
  WorkspacePathsLive,
).pipe(Layer.provideMerge(NodeServices.layer));

function queueCommandWithImage(): ClientOrchestrationCommand {
  return {
    type: "thread.follow-up.queue",
    commandId: CommandId.make("cmd-queue-image"),
    threadId: ThreadId.make("thread-queue-image"),
    followUpId: "follow-up-image",
    message: {
      messageId: MessageId.make("message-queue-image"),
      role: "user",
      text: "look at this",
      attachments: [
        {
          type: "image",
          name: "queued.png",
          mimeType: "image/png",
          sizeBytes: 68,
          dataUrl: PNG_DATA_URL,
        },
      ],
    },
    createdAt: "2026-04-24T00:00:00.000Z",
  };
}

function steerCommandWithImage(): ClientOrchestrationCommand {
  return {
    type: "thread.turn.steer",
    commandId: CommandId.make("cmd-steer-image"),
    threadId: ThreadId.make("thread-steer-image"),
    message: {
      messageId: MessageId.make("message-steer-image"),
      role: "user",
      text: "include this image",
      attachments: [
        {
          type: "image",
          name: "steer.png",
          mimeType: "image/png",
          sizeBytes: 68,
          dataUrl: PNG_DATA_URL,
        },
      ],
    },
    createdAt: "2026-04-24T00:00:00.000Z",
  };
}

describe("normalizeDispatchCommand", () => {
  it("persists queued follow-up image uploads into chat attachments", async () => {
    const normalized = await Effect.runPromise(
      normalizeDispatchCommand(queueCommandWithImage()).pipe(Effect.provide(TestLayer)),
    );

    expect(normalized.type).toBe("thread.follow-up.queue");
    if (normalized.type !== "thread.follow-up.queue") {
      throw new Error("Expected thread.follow-up.queue");
    }
    expect(normalized.message.attachments).toHaveLength(1);
    const attachment = normalized.message.attachments[0] as ChatAttachment | undefined;
    expect(attachment).toMatchObject({
      type: "image",
      name: "queued.png",
      mimeType: "image/png",
    });
    expect(attachment).not.toHaveProperty("dataUrl");
    expect(attachment?.id).toMatch(/^thread-queue-image-/);
  });

  it("persists steer image uploads through the same attachment path", async () => {
    const normalized = await Effect.runPromise(
      normalizeDispatchCommand(steerCommandWithImage()).pipe(Effect.provide(TestLayer)),
    );

    expect(normalized.type).toBe("thread.turn.steer");
    if (normalized.type !== "thread.turn.steer") {
      throw new Error("Expected thread.turn.steer");
    }
    expect(normalized.message.attachments[0]).toMatchObject({
      type: "image",
      name: "steer.png",
      mimeType: "image/png",
    });
    expect(normalized.message.attachments[0]).not.toHaveProperty("dataUrl");
  });
});
