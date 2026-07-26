// @ts-expect-error — JS module, no declaration file
import { validateApiKey } from '../../api/_api-key.js';
// @ts-expect-error — JS module, no declaration file
import { timingSafeIncludes } from '../../api/_crypto.js';
import { validateBearerToken } from '../auth-session';
import { getEntitlements } from './entitlement-check';
import {
  INTERNAL_MCP_VERIFIED_HEADER,
  TRUSTED_USER_ID_HEADER,
  getInternalMcpVerifiedNonce,
} from './mcp-internal-hmac';
import { validateUserApiKey } from './user-api-key';

export type PremiumCallerIdentity =
  | { isPremium: true; userId: string; kind: 'internal-mcp'; quotaExempt: true }
  | { isPremium: true; userId: string; kind: 'user-api-key' | 'bearer'; quotaExempt: false }
  | { isPremium: true; userId: null; kind: 'enterprise'; quotaExempt: true }
  | {
    isPremium: false;
    userId: null;
    kind: null;
    quotaExempt: false;
    /**
     * Set when the denial rests on an entitlement lookup that FAILED rather
     * than on a confirmed non-premium answer (#5622).
     *
     * The field is additive and optional on purpose: `isPremium: false` keeps
     * its exact meaning ("do not grant premium"), so all ~25 existing callers
     * — including every `isCallerPremium()` boolean consumer — are unaffected.
     * A caller that wants the retryable posture opts in by reading this and
     * answering 503 + Retry-After instead of a terminal 403. Without it, a
     * Convex blip during a paying customer's request is indistinguishable from
     * "you are not a subscriber", which is exactly the #5600 failure mode.
     */
    verificationUnavailable?: true;
  };

/** Deny with no information about WHY — a confirmed non-premium caller. */
const DENIED: PremiumCallerIdentity = {
  isPremium: false,
  userId: null,
  kind: null,
  quotaExempt: false,
};

/**
 * Deny because the entitlement could not be verified. Same authorization
 * outcome as DENIED; the marker only lets a caller choose retryable wording.
 */
const DENIED_UNVERIFIABLE: PremiumCallerIdentity = {
  ...DENIED,
  verificationUnavailable: true,
};

/**
 * A deny-side entitlement answer, plus whether it was CONFIRMED.
 *
 * `verificationUnavailable` on the row means getEntitlements() synthesized it
 * after a transient backend failure (server/_shared/entitlement-check.ts), so
 * the tier/apiAccess fields on it are placeholders, not findings.
 */
function denyFor(entitlements: { verificationUnavailable?: true } | null): PremiumCallerIdentity {
  return entitlements?.verificationUnavailable ? DENIED_UNVERIFIABLE : DENIED;
}

/**
 * Resolves premium status and the user-bound identity for spend controls.
 */
export async function resolvePremiumCallerIdentity(request: Request): Promise<PremiumCallerIdentity> {
  // Internal-MCP context: trusted markers are set by the gateway AFTER an
  // HMAC verification on `X-WM-MCP-Internal` succeeds. Inbound copies of
  // these headers are stripped at the gateway entry (defense-in-depth) so
  // a client cannot reach this branch by injecting them directly.
  //
  // The verified-marker value is a per-process-startup random nonce. We
  // compare with timing-safe equality, not just `=== '1'`, so an attacker
  // hitting a direct (non-gateway-routed) edge function with a spoofed
  // marker fails closed — the gateway is the ONLY entity that knows the
  // nonce, and only it produces the value.
  //
  // Defensive re-fetch of getEntitlements (cache-hot, ~free): catches any
  // future code path where someone forgets to verify upstream, and any
  // mid-request entitlement lapse (tier just dropped to 0). The gateway
  // already entitlement-checks before propagating, so this is belt-and-
  // suspenders — but cheap and worth it for a security-critical gate.
  const verifiedMarker = request.headers.get(INTERNAL_MCP_VERIFIED_HEADER);
  const trustedUserId = request.headers.get(TRUSTED_USER_ID_HEADER);
  if (verifiedMarker && trustedUserId) {
    const expectedNonce = getInternalMcpVerifiedNonce();
    // Length-safe-then-byte-compare. JS strings cannot leak per-char timing
    // the way C strcmp does, but we still avoid early-exit branches.
    let diff = verifiedMarker.length ^ expectedNonce.length;
    const len = Math.max(verifiedMarker.length, expectedNonce.length);
    for (let i = 0; i < len; i++) {
      const a = i < verifiedMarker.length ? verifiedMarker.charCodeAt(i) : 0;
      const b = i < expectedNonce.length ? expectedNonce.charCodeAt(i) : 0;
      diff |= a ^ b;
    }
    if (diff === 0) {
      const ent = await getEntitlements(trustedUserId);
      if (
        ent &&
        ent.features.tier >= 1 &&
        // mcpAccess lands in U10. Until then the field is undefined for
        // existing entitlement rows; treat undefined as false (fail-closed)
        // so a misconfigured / pre-U10 row cannot grant premium semantics
        // through the internal-MCP path.
        (ent.features as { mcpAccess?: boolean }).mcpAccess === true
      ) {
        return { isPremium: true, userId: trustedUserId, kind: 'internal-mcp', quotaExempt: true };
      }
      return denyFor(ent);
    }
    // Marker present but nonce mismatch: do NOT short-circuit. Fall
    // through to the normal auth flow — an attacker spoofing the marker
    // gets exactly the same auth surface as one without the marker, no
    // information leak about the nonce.
  }

  // Browser tester keys — validateApiKey returns required:false for trusted origins
  // even when a valid key is present, so we check the header directly first.
  const wmKey =
    request.headers.get('X-WorldMonitor-Key') ??
    request.headers.get('X-Api-Key') ??
    '';
  if (wmKey) {
    const validKeys = (process.env.WORLDMONITOR_VALID_KEYS ?? '')
      .split(',').map((k) => k.trim()).filter(Boolean);
    if (await timingSafeIncludes(wmKey, validKeys)) {
      return { isPremium: true, userId: null, kind: 'enterprise', quotaExempt: true };
    }

    // Check user-owned API keys (wm_ prefix) via Convex lookup.
    // Key existence alone is not sufficient — verify the owner's entitlement.
    const userKey = await validateUserApiKey(wmKey);
    if (userKey) {
      const ent = await getEntitlements(userKey.userId);
      if (ent && ent.features.apiAccess === true) {
        return { isPremium: true, userId: userKey.userId, kind: 'user-api-key', quotaExempt: false };
      }
      return denyFor(ent);
    }
  }

  const keyCheck = (await validateApiKey(request, {})) as { valid: boolean; required: boolean };
  // Only treat as premium when an explicit API key was validated (required: true).
  // Trusted-origin short-circuits (required: false) do NOT imply PRO entitlement.
  if (keyCheck.valid && keyCheck.required) {
    return { isPremium: true, userId: null, kind: 'enterprise', quotaExempt: true };
  }

  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const session = await validateBearerToken(authHeader.slice(7));
    // An invalid token is a confirmed answer about the CREDENTIAL, not a failed
    // entitlement lookup — it stays a plain deny.
    if (!session.valid) return DENIED;
    if (session.role === 'pro' && session.userId) {
      return { isPremium: true, userId: session.userId, kind: 'bearer', quotaExempt: false };
    }
    // Clerk role isn't 'pro' — check Dodo entitlement tier as second signal.
    // A Dodo subscriber (tier >= 1) is premium regardless of Clerk role.
    if (session.userId) {
      const ent = await getEntitlements(session.userId);
      if (ent && ent.features.tier >= 1) {
        return { isPremium: true, userId: session.userId, kind: 'bearer', quotaExempt: false };
      }
      return denyFor(ent);
    }
  }
  return DENIED;
}

/**
 * Returns true when the caller has a valid API key OR a PRO bearer token.
 * Used by handlers where the RPC endpoint is public but certain fields
 * (e.g. framework/systemAppend) should only be honored for premium callers.
 *
 * DELIBERATELY LOSSY (#5622): a boolean cannot express "we could not verify".
 * That is acceptable for this function's actual job — the majority of its ~25
 * callers use it to decide whether to *enrich* a public response (honor
 * `framework`, return populated vs empty arrays), where the worst case of a
 * transient failure is a degraded payload rather than a wrong verdict about the
 * user's plan.
 *
 * It is NOT acceptable for a caller that turns `false` into a terminal
 * "Pro subscription required" 403 — that flattens a backend blip into a
 * misleading upsell for a paying customer. Those callers must use
 * `resolvePremiumCallerIdentity()` and branch on `verificationUnavailable` to
 * answer a retryable 503 instead (see api/chat-analyst.ts). Threading the
 * signal through this boolean would mean changing its return type and every
 * caller, which is why the identity API carries it instead.
 */
export async function isCallerPremium(request: Request): Promise<boolean> {
  return (await resolvePremiumCallerIdentity(request)).isPremium;
}
