import "@tanstack/react-start/server-only";

import { poolQueryable, type Queryable } from "~/db";
import { parseTier, tierSatisfies } from "~/domain/chains";
import { PermissionDenied } from "~/server/errors";

/**
 * The two gates on the display layer, and the places they must hold.
 *
 * **The owner's decision (29 Sept 2026): station routing and the guest display stay Gold.**
 * The registry already carries exactly those two gates — `kds_multi_station` and `cds`,
 * both `min_tier = 'gold'` (`db/seed.sql` section 4; the PRD's own tier table, p.19) — so
 * this module adds no feature row and seeds no entitlement. It reads the two that exist.
 *
 * **Both gates are enforced, and the lead ruled on 29 Sept 2026 that they are not the same
 * thing** (DECISIONS.md §"Display build — lead rulings on the S-A read-back"):
 *
 *   * the **tier** (`chain.licence_tier` against `feature.min_tier`) is the commercial
 *     entitlement — the owner's decision, what the licence pays for;
 *   * the **module switch** (`chain_feature.enabled`) is the operator's own "this module is
 *     on for us" — a configuration fact about one chain.
 *
 * A chain that holds Gold but has switched the module off must not have work routed to it,
 * and a chain that has switched the module on without the licence must not either. So the
 * gate is the conjunction, and neither fact is allowed to stand in for the other. An earlier
 * draft of this module enforced the tier alone and argued that the switch was "reported and
 * not enforced"; that reasoning is overruled, and the switch the operator can see and set is
 * now load-bearing rather than decorative.
 *
 * **It fails closed, through `tierSatisfies`** (`~/domain/chains.ts:52`, the fix landed on
 * `main` as `b7bf885`). There is no `?? "gold"` and no coercion to Silver: a chain whose
 * stored `licence_tier` is not one the registry knows satisfies nothing, and a `min_tier`
 * nobody recognises satisfies nothing either. An unrecognised tier **grants nothing** —
 * which is the whole point, because the earlier helper read an unrecognised value as
 * Silver and could *lower* a Gold gate (FINDINGS-label-fallback-sweep.md §G1.0).
 *
 * Which of the two is holding is said in words, because the two have different remedies:
 * the tier sentence names the tier and the minimum, and the switch sentence says the module
 * is off for this chain. §11.5.6's rule still stands — a switch state must not be described
 * as routing working — and the honest reading of the seeded data is now "gold, and the
 * module switch is on for the pilot chain".
 */
export const ROUTING_FEATURE = "kds_multi_station";
export const GUEST_DISPLAY_FEATURE = "cds";

export interface FeatureEntitlement {
  featureCode: string;
  /**
   * The registry's own name for the feature (`feature.name`), so a refusal can name the
   * module in words. A refusal that said `kds_multi_station` to a kitchen manager would be
   * a machine identifier in prose — the rule is that codes stay codes only where a code is
   * the subject (DECISIONS, 28 Sept 2026).
   */
  featureName: string;
  /** The raw value the registry holds. Never coerced; rendered as the value it is. */
  minTier: string;
  /** True when the chain's tier meets `minTier` under the fail-closed comparison. */
  tierEntitled: boolean;
  /** The chain's stored tier, as stored. `null` when it is not a tier the registry knows. */
  storedTier: string;
  /** The per-chain switch — the operator's own "this module is on for us". */
  toggleEnabled: boolean;
  /**
   * The gate the fire path asks: **the tier *and* the switch** (lead ruling, 29 Sept 2026).
   * Both are real gates and they mean different things, so neither may be dropped: a chain
   * that holds Gold with the module switched off must not have work routed to it, and a
   * chain with the switch on and no licence must not either.
   */
  entitled: boolean;
}

export interface DisplayEntitlement {
  chainId: string;
  licenceTier: string;
  routing: FeatureEntitlement;
  guestDisplay: FeatureEntitlement;
}

interface EntitlementRow {
  licence_tier: string;
  code: string;
  name: string;
  min_tier: string;
  enabled: boolean | null;
}

function toEntitlement(row: EntitlementRow): FeatureEntitlement {
  // `tierSatisfies` is the gate; `parseTier` is here only so the sentence a refusal reads
  // can say whether the stored value is a tier at all (it is not, for a value nobody
  // recorded — and then nothing is satisfied).
  const tierEntitled = tierSatisfies(row.licence_tier, row.min_tier);
  // A missing `chain_feature` row is *off*, never "not configured, so allow it": the
  // registry seeds one row per toggleable feature on onboarding, so an absent row means the
  // switch was never turned on, and the fail-closed reading of that is `false`.
  const toggleEnabled = row.enabled === true;
  return {
    featureCode: row.code,
    featureName: row.name,
    minTier: row.min_tier,
    tierEntitled,
    storedTier: row.licence_tier,
    toggleEnabled,
    entitled: tierEntitled && toggleEnabled,
  };
}

/**
 * The display layer's entitlement for one chain. A read; no audit row, no side effect.
 *
 * `parseTier` on the stored tier is deliberately *not* used to default anything: when it
 * returns null the value is reported as it is stored, and `tierSatisfies` has already
 * refused to satisfy anything with it.
 */
export async function displayEntitlement(
  db: Queryable,
  chainId: string
): Promise<DisplayEntitlement | null> {
  const rows = await db.query<EntitlementRow>(
    `select c.licence_tier,
            f.code,
            f.name,
            f.min_tier,
            cf.enabled
       from chain c
       join feature f on f.code in ($2, $3)
       left join chain_feature cf on cf.chain_id = c.id and cf.feature_code = f.code
      where c.id = $1`,
    [chainId, ROUTING_FEATURE, GUEST_DISPLAY_FEATURE]
  );
  const chain = rows[0];
  if (!chain) return null;
  const routingRow = rows.find((row) => row.code === ROUTING_FEATURE);
  const guestRow = rows.find((row) => row.code === GUEST_DISPLAY_FEATURE);
  // The registry is reference data seeded with the platform: a missing row is a
  // programming error, and treating it as "entitled" would be exactly the fail-open this
  // module exists to remove. A missing row grants nothing — and since its `tierEntitled` is
  // false, the tier sentence is the one that fires rather than a sentence about a switch
  // nobody can find.
  const nothing: FeatureEntitlement = {
    featureCode: "",
    featureName: "",
    minTier: "",
    tierEntitled: false,
    storedTier: chain.licence_tier,
    toggleEnabled: false,
    entitled: false,
  };
  return {
    chainId,
    licenceTier: chain.licence_tier,
    routing: routingRow ? toEntitlement(routingRow) : nothing,
    guestDisplay: guestRow ? toEntitlement(guestRow) : nothing,
  };
}

/** The same read on its own connection, for a caller that holds no transaction. */
export async function displayEntitlementForChain(chainId: string): Promise<DisplayEntitlement | null> {
  return displayEntitlement(poolQueryable(), chainId);
}

/** The registry is reference data; a missing row must never read as an entitlement. */
function missingFeature(featureCode: string, minTier: string, storedTier: string): FeatureEntitlement {
  return {
    featureCode,
    featureName: "",
    minTier,
    tierEntitled: false,
    storedTier,
    toggleEnabled: false,
    entitled: false,
  };
}

/** The licence is the gate that is holding. A refusal of the permission shape. */
function tierRefusal(entitlement: FeatureEntitlement, action: string): PermissionDenied {
  // The sentence is a catalog key and the values are the tier as stored — never a label
  // that could name a tier the row does not carry (`tierLabel` words an unreadable value
  // as unreadable).
  return new PermissionDenied(action, `${action} is not entitled on this chain`, {
    code: "permission.licence.tierBelow",
    params: {
      capability: entitlement.featureCode,
      minTier: entitlement.minTier,
      tier: entitlement.storedTier,
    },
    // Kept machine-readable as well, so a ledger row or a log line says which of the two
    // independent gates failed without anyone parsing a sentence.
    featureCode: entitlement.featureCode,
    minTier: entitlement.minTier,
    storedTier: entitlement.storedTier,
    tierEntitled: entitlement.tierEntitled,
    toggleEnabled: entitlement.toggleEnabled,
    tierReadable: parseTier(entitlement.storedTier) !== null,
  });
}

/**
 * The switch is the gate that is holding: the tier covers the module and the chain has
 * switched it off. A different sentence from the tier's, because it is a different remedy —
 * an operator turns the module on, rather than the licence moving.
 */
function switchRefusal(entitlement: FeatureEntitlement, action: string): PermissionDenied {
  return new PermissionDenied(action, `${entitlement.featureName} is switched off for this chain`, {
    code: "permission.licence.moduleOff",
    params: { module: entitlement.featureName },
    featureCode: entitlement.featureCode,
    minTier: entitlement.minTier,
    storedTier: entitlement.storedTier,
    tierEntitled: entitlement.tierEntitled,
    toggleEnabled: entitlement.toggleEnabled,
  });
}

/**
 * Both gates, asked in one place so a caller cannot ask only one of them.
 *
 * The tier is asked first: when both are holding, the licence is the more fundamental of
 * the two and the one the owner's sign-off is about, so that is the sentence an operator
 * should read first. Neither branch is reachable by "falling through" — every path that
 * does not pass throws.
 *
 * **A note for S-B, because this is a gap rather than a feature.** The refusal is raised
 * here, inside whatever transaction the caller is in, and `guard()` is what writes a
 * `denied` audit row. So a refused resolution currently changes nothing and records nothing:
 * the verifier asserts exactly that (it counts the audit rows before and after). If the fire
 * path wants the refusal in the ledger — and the platform's refusal rule says a capability
 * refusal is a `denied` row — then S-B must ask this gate **before** it opens the
 * transaction, or record the refusal itself. The check is in the right place for safety; the
 * ledger half of it is still to build.
 */
function assertFeatureOpen(entitlement: FeatureEntitlement, action: string): void {
  if (!entitlement.tierEntitled) throw tierRefusal(entitlement, action);
  if (!entitlement.toggleEnabled) throw switchRefusal(entitlement, action);
}

/**
 * Routing is a paid capability, so the resolver asks before it routes. Called by
 * `resolveLineRoute` for every line rather than once by its caller, because a check a
 * caller can forget is not a check. A booking has a handful of lines and the read is
 * indexed; that is the whole cost of not having a hole here.
 */
export async function assertRoutingEntitled(db: Queryable, chainId: string): Promise<void> {
  const entitlement = await displayEntitlement(db, chainId);
  if (!entitlement) {
    throw tierRefusal(missingFeature(ROUTING_FEATURE, "gold", ""), "kds.route.view");
  }
  assertFeatureOpen(entitlement.routing, "kds.route.view");
}

/** The same gate for the guest display (S-D), put here now so the rule lives in one place. */
export async function assertGuestDisplayEntitled(db: Queryable, chainId: string): Promise<void> {
  const entitlement = await displayEntitlement(db, chainId);
  if (!entitlement) {
    throw tierRefusal(missingFeature(GUEST_DISPLAY_FEATURE, "gold", ""), "cds.display.view");
  }
  assertFeatureOpen(entitlement.guestDisplay, "cds.display.view");
}
