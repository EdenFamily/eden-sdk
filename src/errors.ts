/** Every error the SDK throws is an EdenError with a stable `code`. */
export class EdenError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;
  constructor(code: string, message: string, details?: Record<string, unknown>, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EdenError";
    this.code = code;
    this.details = details;
  }
}

/** The Eden API answered with an error status: `{ error: "<code>", message }`. */
export class EdenApiError extends EdenError {
  readonly status: number;
  readonly path: string;
  /** The full error body (e.g. 422 simulation:reverted carries reason, revertName, revertData, step; 400 invalid_request carries issues). */
  readonly body: Record<string, unknown> | undefined;
  constructor(status: number, code: string, message: string, path: string, body?: Record<string, unknown>) {
    super(code, message, { status, path, ...body });
    this.body = body;
    this.name = "EdenApiError";
    this.status = status;
    this.path = path;
  }
}

/** A launch refused by Eden's launch limits (2 per UTC day, 10 per UTC month per creator). Do not retry. */
export class LaunchQuotaError extends EdenError {
  readonly scope: "daily" | "monthly";
  readonly resetsAt: string | undefined;
  constructor(scope: "daily" | "monthly", message: string, resetsAt?: string) {
    super(`quota:${scope}`, message, { scope, resetsAt });
    this.name = "LaunchQuotaError";
    this.scope = scope;
    this.resetsAt = resetsAt;
  }
}

/** Launch metadata or an image that breaks Eden's rules (see validateLaunchMetadata). */
export class ValidationError extends EdenError {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`invalid:${field}`, message, { field });
    this.name = "ValidationError";
    this.field = field;
  }
}

/**
 * A transaction step failed verification. Nothing was signed. `step` is the index of the offending step (or -1 for
 * the plan as a whole); `code` says which rule failed (chain_id, to, calldata, recipient, amount, value, min_out,
 * slippage, simulation, ...).
 */
export class VerificationError extends EdenError {
  readonly step: number;
  constructor(code: string, message: string, step: number, details?: Record<string, unknown>) {
    super(code, `Verification failed (${code}${step >= 0 ? `, step ${step}` : ""}): ${message}`, { step, ...details });
    this.name = "VerificationError";
    this.step = step;
  }
}

/** The token cannot be traded right now (e.g. it graduated and its pool is not created yet). */
export class NotTradableError extends EdenError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "NotTradableError";
  }
}

/** A sent transaction reverted or could not be confirmed. `hash` is set once the transaction was broadcast. */
export class TransactionError extends EdenError {
  readonly hash: string | undefined;
  constructor(code: string, message: string, hash?: string, options?: { cause?: unknown }) {
    super(code, message, { hash }, options);
    this.name = "TransactionError";
    this.hash = hash;
  }
}

/** A required input is missing (e.g. no account configured for a write). */
export class ConfigError extends EdenError {
  constructor(message: string) {
    super("config", message);
    this.name = "ConfigError";
  }
}
