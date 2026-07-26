/**
 * Canonical entitlement decision for standalone tier-1 JSON endpoints.
 *
 * Pro access has two equivalent signals throughout the product:
 *   - Clerk session role === 'pro' (complimentary, tester, or legacy grants)
 *   - a resolved Convex entitlement with tier >= 1
 *
 * Keep standalone handlers on this helper so they cannot unlock their client
 * UI on the Clerk role and then require a billed Convex row at the API gate.
 */
import {
  getBillingVerificationDenial,
  getEntitlements,
  type EntitlementCheckOptions,
} from './entitlement-check';

type ProEntitlementDecision =
  | { allowed: true }
  | { allowed: false; billingDenial: Response | null };

type EntitlementLoader = typeof getEntitlements;

export async function checkProEntitlement(
  userId: string,
  clerkRole: EntitlementCheckOptions['clerkRole'],
  corsHeaders: Record<string, string>,
  loadEntitlements: EntitlementLoader = getEntitlements,
): Promise<ProEntitlementDecision> {
  // Avoid turning a complimentary Clerk grant into a dependency on a Convex
  // row it does not have. This also avoids an unnecessary backend lookup for
  // role-only Pro.
  if (clerkRole === 'pro') return { allowed: true };

  // Preserves the exact tier check each of these five handlers already ran
  // inline (tier >= 1, no validUntil check) — this intentionally does NOT
  // match checkEntitlementDetailed, which additionally requires
  // `validUntil >= Date.now()`. Unifying that gap is a separate concern from
  // this PR's Clerk-role fix.
  const entitlements = await loadEntitlements(userId);
  if (entitlements && entitlements.features.tier >= 1) {
    return { allowed: true };
  }

  return {
    allowed: false,
    billingDenial: getBillingVerificationDenial(entitlements, corsHeaders, 1),
  };
}
