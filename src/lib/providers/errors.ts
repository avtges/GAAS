/**
 * Normalised error for all Google API calls so sync code can react uniformly:
 *  - unauthenticated: token invalid/expired (and refresh failed) → mark revoked
 *  - permission_denied: property/account access removed or scope missing
 *  - not_found: property deleted / wrong id
 *  - rate_limited / unavailable: transient; retried then surfaced
 *  - malformed: response did not match the documented schema
 */
export type GoogleApiErrorKind = "unauthenticated" | "permission_denied" | "not_found" | "rate_limited" | "unavailable" | "invalid_request" | "malformed" | "network";

export class GoogleApiError extends Error {
  constructor(
    public readonly kind: GoogleApiErrorKind,
    message: string,
    public readonly status?: number,
    public readonly service?: string,
  ) {
    super(message);
    this.name = "GoogleApiError";
  }
  get isTransient(): boolean {
    return this.kind === "rate_limited" || this.kind === "unavailable" || this.kind === "network";
  }
}

export function kindFromStatus(status: number): GoogleApiErrorKind {
  if (status === 401) return "unauthenticated";
  if (status === 403) return "permission_denied";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "unavailable";
  return "invalid_request";
}
