import {
  operatorDeliveryPayload,
  type OperatorDelivery
} from "./operatorDelivery.js";
import type {
  OperatorRoleBinding,
  OperatorSessionReservation
} from "./operatorRoleBindingAuthority.js";

export type StructuredPtyDeliveryRequest = {
  jsonrpc: "2.0";
  id: string;
  method: "taskmux.operator.input_request";
  params: Readonly<{
    type: "input-request";
    deliveryId: string;
    taskId: string;
    requestId: string;
  }>;
};

export type StructuredPtyDeliveryResponse =
  | {
      jsonrpc: "2.0";
      id: string;
      result: { accepted: true };
    }
  | {
      jsonrpc: "2.0";
      id: string;
      error: { code: string; message: string };
    };

export type StructuredPtyStartContext = {
  binding: OperatorRoleBinding;
  reservation: OperatorSessionReservation;
};

/**
 * The foreground process boundary is deliberately structured. There is no
 * raw-PTY prompt scraping or fallback delivery channel in this integration.
 */
export interface StructuredPtyTransport {
  start(context: StructuredPtyStartContext): void;
  request(request: StructuredPtyDeliveryRequest): unknown;
  stop?(): void;
}

export function createStructuredPtyDeliveryRequest(
  delivery: OperatorDelivery
): StructuredPtyDeliveryRequest {
  return {
    jsonrpc: "2.0",
    id: delivery.deliveryId,
    method: "taskmux.operator.input_request",
    params: operatorDeliveryPayload(delivery)
  };
}

/**
 * `true` means only that the transport accepted the envelope. It intentionally
 * says nothing about a user-visible presentation or a user response.
 */
export function isStructuredPtyTransportAccepted(
  value: unknown,
  expectedId: string
): value is Extract<StructuredPtyDeliveryResponse, { result: { accepted: true } }> {
  if (!isPlainRecord(value) || Object.keys(value).length !== 3) {
    return false;
  }
  if (value.jsonrpc !== "2.0" || value.id !== expectedId || !isPlainRecord(value.result)) {
    return false;
  }
  return Object.keys(value.result).length === 1 && value.result.accepted === true;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
