import type { ErrorCode } from "@sob/contracts";

/**
 * Business-rule failure raised by the service layer. Transport-agnostic: the REST layer
 * maps `code` to an HTTP status, an MCP tool would map it to a tool error.
 */
export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
