import {
  ChatAttachment,
  IsoDateTime,
  MessageId,
  ModelSelection,
  ThreadId,
} from "@t3tools/contracts";
import { Context, Option, Schema } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadQueuedFollowUp = Schema.Struct({
  followUpId: Schema.String,
  threadId: ThreadId,
  messageId: MessageId,
  text: Schema.String,
  attachments: Schema.Array(ChatAttachment),
  modelSelection: Schema.NullOr(ModelSelection),
  queuedAt: IsoDateTime,
});
export type ProjectionThreadQueuedFollowUp = typeof ProjectionThreadQueuedFollowUp.Type;

export const ListProjectionThreadQueuedFollowUpsInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadQueuedFollowUpsInput =
  typeof ListProjectionThreadQueuedFollowUpsInput.Type;

export const DeleteProjectionThreadQueuedFollowUpsInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadQueuedFollowUpsInput =
  typeof DeleteProjectionThreadQueuedFollowUpsInput.Type;

export const GetProjectionThreadQueuedFollowUpByMessageIdInput = Schema.Struct({
  messageId: MessageId,
});
export type GetProjectionThreadQueuedFollowUpByMessageIdInput =
  typeof GetProjectionThreadQueuedFollowUpByMessageIdInput.Type;

export const DeleteProjectionThreadQueuedFollowUpByIdInput = Schema.Struct({
  followUpId: Schema.String,
});
export type DeleteProjectionThreadQueuedFollowUpByIdInput =
  typeof DeleteProjectionThreadQueuedFollowUpByIdInput.Type;

export interface ProjectionThreadQueuedFollowUpRepositoryShape {
  readonly upsert: (
    row: ProjectionThreadQueuedFollowUp,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getByMessageId: (
    input: GetProjectionThreadQueuedFollowUpByMessageIdInput,
  ) => Effect.Effect<Option.Option<ProjectionThreadQueuedFollowUp>, ProjectionRepositoryError>;
  readonly listByThreadId: (
    input: ListProjectionThreadQueuedFollowUpsInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadQueuedFollowUp>, ProjectionRepositoryError>;
  readonly deleteByMessageId: (
    input: GetProjectionThreadQueuedFollowUpByMessageIdInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteByFollowUpId: (
    input: DeleteProjectionThreadQueuedFollowUpByIdInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadQueuedFollowUpsInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadQueuedFollowUpRepository extends Context.Service<
  ProjectionThreadQueuedFollowUpRepository,
  ProjectionThreadQueuedFollowUpRepositoryShape
>()(
  "t3/persistence/Services/ProjectionThreadQueuedFollowUps/ProjectionThreadQueuedFollowUpRepository",
) {}
