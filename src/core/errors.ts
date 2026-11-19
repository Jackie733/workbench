export type WorkbenchErrorCode =
  | "not_initialized"
  | "already_initialized"
  | "invalid_path"
  | "symlink_not_allowed"
  | "invalid_input"
  | "payload_too_large"
  | "not_found"
  | "revision_conflict"
  | "invalid_transition"
  | "approval_required"
  | "acceptance_gate_failed"
  | "corrupt_record"
  | "unsupported_schema"
  | "lock_timeout"
  | "execution_failed";

/** Domain and storage error with a stable machine-readable error code. */
export class WorkbenchError extends Error {
  readonly code: WorkbenchErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: WorkbenchErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "WorkbenchError";
    this.code = code;
    this.details = details;
  }

  toJSON(): { code: WorkbenchErrorCode; message: string; details?: Record<string, unknown> } {
    return this.details ? { code: this.code, message: this.message, details: this.details } : { code: this.code, message: this.message };
  }
}

export interface StructuredMessageRef {
  key: string;
  params?: Record<string, string | number>;
}

/** Extracts a serializable message ref from WorkbenchError details for warning/toast localization. */
export function extractMessageRef(err: unknown): StructuredMessageRef | null {
  if (!(err instanceof WorkbenchError) || typeof err.details?.messageKey !== "string") return null;
  const rawParams = err.details.messageParams;
  const params =
    rawParams && typeof rawParams === "object"
      ? (Object.fromEntries(
          Object.entries(rawParams as Record<string, unknown>).filter(
            ([, v]) => typeof v === "string" || typeof v === "number",
          ),
        ) as Record<string, string | number>)
      : undefined;
  return {
    key: err.details.messageKey,
    ...(params && Object.keys(params).length > 0 ? { params } : {}),
  };
}
