/**
 * How the apex `/mcp-grant` consent page reacts to a denial from
 * `api/internal/mcp-grant-{context,mint}`.
 *
 * Extracted from `src/mcp-grant-main.ts` as a zero-import leaf (same reason as
 * `src/services/premium-denial.ts`): the page module boots Clerk and touches
 * `window`/`localStorage` at import time, so its decision logic was
 * unreachable from a test. The decision that matters here — is this denial
 * terminal, or should the user be allowed to try again — was previously a
 * `switch` with a terminal `default`, so #5622's new retryable 503 would have
 * been rendered as "could not be completed. Start over from your MCP client."
 * and destroyed the consent card.
 */

/** What the page should do with a denial. */
export type GrantDenialAction =
  /** Terminal: replace the consent card with the error view. */
  | 'terminal'
  /** Transient: keep the consent card, surface the message, re-enable Authorize. */
  | 'retryable'
  /** The Clerk token is stale — re-prompt for sign-in. */
  | 'sign_in';

export interface GrantDenialVerdict {
  action: GrantDenialAction;
  message: string;
}

/**
 * `TIER_VERIFICATION_UNAVAILABLE` (server/_shared/pro-mcp-gate.ts) is the ONE
 * retryable entitlement code the handshake emits. `SERVICE_UNAVAILABLE` (Redis
 * transport) is retryable for the same reason, and was already worded that way
 * — it just had no way to say so to the caller.
 */
const RETRYABLE_CODES = new Set(['TIER_VERIFICATION_UNAVAILABLE', 'SERVICE_UNAVAILABLE']);

const MESSAGES: Record<string, string> = {
  INVALID_NONCE: 'This authorization request expired or is invalid. Start over from your MCP client.',
  UNKNOWN_CLIENT: 'The OAuth client is no longer registered. Start over from your MCP client.',
  INVALID_REDIRECT_URI: 'The redirect destination is not allowed. Start over from your MCP client.',
  INSUFFICIENT_TIER: 'A WorldMonitor Pro subscription is required to authorize MCP clients.',
  NONCE_CLAIMED_BY_OTHER_USER:
    'This authorization request has already been claimed by another account. Start over from your MCP client.',
  CONFIGURATION_ERROR: 'MCP authorization is temporarily unavailable. Please try again later.',
  SERVICE_UNAVAILABLE: 'The authorization service is temporarily unavailable. Please try again in a moment.',
  TIER_VERIFICATION_UNAVAILABLE:
    'We could not confirm your Pro subscription just now. This is temporary — try again in a moment.',
};

const FALLBACK_MESSAGE =
  'This authorization request could not be completed. Start over from your MCP client.';

/** User-facing copy for a handshake error code. */
export function grantErrorMessage(code: string | undefined): string {
  return (code && MESSAGES[code]) || FALLBACK_MESSAGE;
}

/**
 * Classify a denial into what the page should do.
 *
 * A 401 is sign-in regardless of body, matching the page's existing behavior.
 * Everything else is terminal UNLESS the server named a retryable code — an
 * unrecognised code stays terminal so an unknown failure never becomes a retry
 * loop, which is why the retryable set is an explicit allowlist rather than a
 * status check. (A bare 503 with no/unparseable body is an intermediary, not the
 * handshake speaking.)
 */
export function classifyGrantDenial(status: number, code: string | undefined): GrantDenialVerdict {
  if (status === 401) return { action: 'sign_in', message: grantErrorMessage(code) };
  return {
    action: code && RETRYABLE_CODES.has(code) ? 'retryable' : 'terminal',
    message: grantErrorMessage(code),
  };
}
