import {
  type Turn
} from "../turn/turn.js";
import { MAX_TURN_RESULT_OUTPUT_BYTES } from "../domain/agentResultTransport.js";

export const MAX_SYNTHESIS_SOURCE_TURNS = 8;
export const MAX_CONTEXT_SOURCE_TURNS = MAX_SYNTHESIS_SOURCE_TURNS + 1;
export const MAX_CONTEXT_SOURCE_TURN_BYTES =
  MAX_CONTEXT_SOURCE_TURNS * (MAX_TURN_RESULT_OUTPUT_BYTES + 16 * 1024);

/**
 * Frozen input for synthesis. The main Agent needs the producer identity and
 * exact result, not another copy of its prompt history, launch configuration,
 * or workspace descriptor.
 */
export function sourceTurnContextValue(
  turn: Readonly<Pick<
    Turn,
    "id" | "taskId" | "roleName" | "purpose" | "workItemId" | "reviewRoundId"
      | "executionGroupId" | "executionLaneId" | "result" | "createdAt" | "updatedAt"
  >>
): Readonly<Record<string, unknown>> {
  if (turn.result === undefined) {
    throw new Error(`Source Turn has no result: ${turn.id}.`);
  }
  return Object.freeze({
    schemaVersion: 1,
    id: turn.id,
    taskId: turn.taskId,
    roleName: turn.roleName,
    purpose: turn.purpose,
    ...(turn.workItemId === undefined ? {} : { workItemId: turn.workItemId }),
    ...(turn.reviewRoundId === undefined ? {} : { reviewRoundId: turn.reviewRoundId }),
    ...(turn.executionGroupId === undefined
      ? {}
      : { executionGroupId: turn.executionGroupId }),
    ...(turn.executionLaneId === undefined ? {} : { executionLaneId: turn.executionLaneId }),
    result: turn.result,
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt
  });
}
