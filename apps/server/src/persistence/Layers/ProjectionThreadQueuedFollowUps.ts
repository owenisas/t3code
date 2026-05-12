// @effect-diagnostics importFromBarrel:off globalDate:off globalDateInEffect:off globalTimers:off globalErrorInEffectFailure:off
import { Effect, Layer, Option, Schema, Struct } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionThreadQueuedFollowUpByIdInput,
  DeleteProjectionThreadQueuedFollowUpsInput,
  GetProjectionThreadQueuedFollowUpByMessageIdInput,
  ListProjectionThreadQueuedFollowUpsInput,
  ProjectionThreadQueuedFollowUp,
  ProjectionThreadQueuedFollowUpRepository,
  type ProjectionThreadQueuedFollowUpRepositoryShape,
} from "../Services/ProjectionThreadQueuedFollowUps.ts";

const ProjectionThreadQueuedFollowUpDbRowSchema = ProjectionThreadQueuedFollowUp.mapFields(
  Struct.assign({
    attachments: Schema.fromJsonString(ProjectionThreadQueuedFollowUp.fields.attachments),
    modelSelection: Schema.NullOr(
      Schema.fromJsonString(ProjectionThreadQueuedFollowUp.fields.modelSelection),
    ),
  }),
);

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProjectionThreadQueuedFollowUpRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: ProjectionThreadQueuedFollowUp,
    execute: (row) =>
      sql`
        INSERT INTO projection_thread_queued_follow_ups (
          follow_up_id,
          thread_id,
          message_id,
          text,
          attachments_json,
          model_selection_json,
          interaction_mode,
          queued_at
        )
        VALUES (
          ${row.followUpId},
          ${row.threadId},
          ${row.messageId},
          ${row.text},
          ${JSON.stringify(row.attachments)},
          ${row.modelSelection ? JSON.stringify(row.modelSelection) : null},
          ${row.interactionMode},
          ${row.queuedAt}
        )
        ON CONFLICT (follow_up_id)
        DO UPDATE SET
          thread_id = excluded.thread_id,
          message_id = excluded.message_id,
          text = excluded.text,
          attachments_json = excluded.attachments_json,
          model_selection_json = excluded.model_selection_json,
          interaction_mode = excluded.interaction_mode,
          queued_at = excluded.queued_at
      `,
  });

  const getByMessageIdRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadQueuedFollowUpByMessageIdInput,
    Result: ProjectionThreadQueuedFollowUpDbRowSchema,
    execute: ({ messageId }) =>
      sql`
        SELECT
          follow_up_id AS "followUpId",
          thread_id AS "threadId",
          message_id AS "messageId",
          text,
          attachments_json AS "attachments",
          model_selection_json AS "modelSelection",
          interaction_mode AS "interactionMode",
          queued_at AS "queuedAt"
        FROM projection_thread_queued_follow_ups
        WHERE message_id = ${messageId}
      `,
  });

  const listByThreadIdRows = SqlSchema.findAll({
    Request: ListProjectionThreadQueuedFollowUpsInput,
    Result: ProjectionThreadQueuedFollowUpDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          follow_up_id AS "followUpId",
          thread_id AS "threadId",
          message_id AS "messageId",
          text,
          attachments_json AS "attachments",
          model_selection_json AS "modelSelection",
          interaction_mode AS "interactionMode",
          queued_at AS "queuedAt"
        FROM projection_thread_queued_follow_ups
        WHERE thread_id = ${threadId}
        ORDER BY queued_at ASC, follow_up_id ASC
      `,
  });

  const deleteByMessageIdRows = SqlSchema.void({
    Request: GetProjectionThreadQueuedFollowUpByMessageIdInput,
    execute: ({ messageId }) =>
      sql`
        DELETE FROM projection_thread_queued_follow_ups
        WHERE message_id = ${messageId}
      `,
  });

  const deleteByFollowUpIdRows = SqlSchema.void({
    Request: DeleteProjectionThreadQueuedFollowUpByIdInput,
    execute: ({ followUpId }) =>
      sql`
        DELETE FROM projection_thread_queued_follow_ups
        WHERE follow_up_id = ${followUpId}
      `,
  });

  const deleteByThreadIdRows = SqlSchema.void({
    Request: DeleteProjectionThreadQueuedFollowUpsInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_thread_queued_follow_ups
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProjectionThreadQueuedFollowUpRepositoryShape["upsert"] = (row) =>
    upsertRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadQueuedFollowUpRepository.upsert:query",
          "ProjectionThreadQueuedFollowUpRepository.upsert:encodeRequest",
        ),
      ),
    );

  const getByMessageId: ProjectionThreadQueuedFollowUpRepositoryShape["getByMessageId"] = (input) =>
    getByMessageIdRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadQueuedFollowUpRepository.getByMessageId:query",
          "ProjectionThreadQueuedFollowUpRepository.getByMessageId:decodeRow",
        ),
      ),
      Effect.map(
        Option.map((value) => ({
          followUpId: value.followUpId,
          threadId: value.threadId,
          messageId: value.messageId,
          text: value.text,
          attachments: value.attachments,
          modelSelection: value.modelSelection,
          interactionMode: value.interactionMode,
          queuedAt: value.queuedAt,
        })),
      ),
    );

  const listByThreadId: ProjectionThreadQueuedFollowUpRepositoryShape["listByThreadId"] = (input) =>
    listByThreadIdRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadQueuedFollowUpRepository.listByThreadId:query",
          "ProjectionThreadQueuedFollowUpRepository.listByThreadId:decodeRows",
        ),
      ),
      Effect.map((rows) =>
        rows.map((row) => ({
          followUpId: row.followUpId,
          threadId: row.threadId,
          messageId: row.messageId,
          text: row.text,
          attachments: row.attachments,
          modelSelection: row.modelSelection,
          interactionMode: row.interactionMode,
          queuedAt: row.queuedAt,
        })),
      ),
    );

  const deleteByMessageId: ProjectionThreadQueuedFollowUpRepositoryShape["deleteByMessageId"] = (
    input,
  ) =>
    deleteByMessageIdRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadQueuedFollowUpRepository.deleteByMessageId:query"),
      ),
    );

  const deleteByFollowUpId: ProjectionThreadQueuedFollowUpRepositoryShape["deleteByFollowUpId"] = (
    input,
  ) =>
    deleteByFollowUpIdRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadQueuedFollowUpRepository.deleteByFollowUpId:query"),
      ),
    );

  const deleteByThreadId: ProjectionThreadQueuedFollowUpRepositoryShape["deleteByThreadId"] = (
    input,
  ) =>
    deleteByThreadIdRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadQueuedFollowUpRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    getByMessageId,
    listByThreadId,
    deleteByMessageId,
    deleteByFollowUpId,
    deleteByThreadId,
  } satisfies ProjectionThreadQueuedFollowUpRepositoryShape;
});

export const ProjectionThreadQueuedFollowUpRepositoryLive = Layer.effect(
  ProjectionThreadQueuedFollowUpRepository,
  makeProjectionThreadQueuedFollowUpRepository,
);
