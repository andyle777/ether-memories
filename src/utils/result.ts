import type { EtherErrorCode } from "../types/index.js";

export interface EtherError {
  code: EtherErrorCode;
  message: string;
  details?: unknown;
}

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: EtherError };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });

export const err = (
  code: EtherErrorCode,
  message: string,
  details?: unknown
): Result<never> => ({ ok: false, error: { code, message, details } });
