import type {
  ClasspilotCommandAckPersistenceResult,
  ClasspilotCommandAckTerminalCode,
} from "./storage.js";

export type ClasspilotCommandAckReceipt = {
  ackId: string;
  commandId: string;
  accepted: boolean;
  disposition: "applied" | "idempotent" | "terminal_rejected";
  retryable: false;
  code:
    | "COMMAND_ACK_APPLIED"
    | "COMMAND_ACK_IDEMPOTENT"
    | ClasspilotCommandAckTerminalCode;
};

export function terminalClasspilotCommandAckReceipt(
  ackId: string,
  commandId: string,
  code: ClasspilotCommandAckTerminalCode
): ClasspilotCommandAckReceipt {
  return {
    ackId,
    commandId,
    accepted: false,
    disposition: "terminal_rejected",
    retryable: false,
    code,
  };
}

export function classpilotCommandAckReceipt(
  ackId: string,
  commandId: string,
  outcome: ClasspilotCommandAckPersistenceResult
): ClasspilotCommandAckReceipt {
  return {
    ackId,
    commandId,
    accepted: outcome.disposition !== "terminal_rejected",
    disposition: outcome.disposition,
    retryable: false,
    code: outcome.code,
  };
}
