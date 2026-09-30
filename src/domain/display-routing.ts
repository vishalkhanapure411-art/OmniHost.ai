import "@tanstack/react-start/server-only";

import { sql, type Queryable } from "~/db";
import { isHttpError, NotFound, ValidationError } from "~/server/errors";
import type { Principal } from "~/server/session";
import { auditedMutation, guard } from "~/server/audit";
import type { TicketRouteSource } from "~/domain/display";
import { assertRoutingEntitled } from "~/domain/display-entitlement";

/**
 * Station-first routing: how a product line resolves to a producing station, and how the
 * routing map behind it is maintained.
 *
 * `DESIGN-kds-and-ticket-routing.md` §1.4 is the specification, and four of its rules are
 * decisions this module exists to make true:
 *
 *   1. **Resolution runs once per line, at fire time, on the server, inside the
 *      transaction that creates the tickets.** It is not in a screen's loader and not in
 *      the client. `resolveLineRoute` is written to be called from inside an
 *      `auditedMutation` transaction and nowhere else.
 *   2. **The answer is recorded, never recomputed** (D4): the caller stores the returned
 *      `routeSource` and section on the line, so "why did this go to the grill?" is
 *      answerable from the row and not by re-running today's configuration against
 *      yesterday's ticket.
 *   3. **There is no third guess.** After the article's own route and the category default
 *      the only remaining target is the outlet's pass (`expedite`) section, flagged
 *      `unrouted`. The article's category *name* is not parsed, and no "beverages probably
 *      go to the bar" heuristic exists: a guess that silently puts a dish on the wrong
 *      station is worse than an unrouted line, because nobody sees it happen (§1.4 item 3).
 *   4. **An unrouted line is never dropped.** It is reported as unrouted and, when the
 *      outlet has no pass section at all, `needsPassSection` says so — the configuration
 *      gap is named rather than papered over.
 *
 * **A note on `needsPassSection`, because it is the one place this build reads D3
 * narrowly.** D3 says an unrouted line goes "to the outlet's `expedite` section if one
 * exists, otherwise to an outlet-scope fallback target". `ticket.section_id` is `NOT NULL`
 * in §2.2's own DDL, so a target has to be a real section: this resolves to the pass
 * section when there is one and reports `needsPassSection` when there is not, leaving S-B
 * to attach the line to the pass it is about to create or to refuse the fire. What it does
 * **not** do is invent a virtual section or attach the line to a random station, which is
 * the failure mode D3 exists to prevent.
 *
 * **Both branches are now demonstrable on seeded data, and the lead ruled on 29 Sept 2026
 * that they must stay two entries in this order rather than one** (DECISIONS.md §"Display
 * build — lead rulings on the S-A read-back"): *an unrouted line falls to a pass if one
 * exists, and refuses the fire if none does — no invented station*. The pilot outlet
 * (`koramangala-restaurant`) has a seeded pass section, `KOR-PASS`, so a line with no route
 * of its own lands there and is flagged `unrouted`; `saffron-koramangala`'s other outlet and
 * `coastal-bandra` have no pass, so a line there stays visibly unrouted with
 * `needsPassSection` and no target at all. The verifier exercises both, against those rows.
 */

export interface RoutedTarget {
  /** Always a real `outlet_section.id` of the line's own outlet. */
  sectionId: string;
  /** The station that owns the `ready` transition when several stations make one article. */
  isPrimary: boolean;
  /** Recorded on the line, so the route can be explained later without re-resolving it. */
  routeSource: TicketRouteSource;
}

export interface LineRouteResolution {
  targets: RoutedTarget[];
  unrouted: boolean;
  /**
   * True when the line is unrouted **and** the outlet has no pass section, so no station
   * could be named at all. S-B must not invent one: the honest outcomes are to attach the
   * line to the pass the outlet is about to have, or to refuse the fire. A silent drop is
   * not among them.
   */
  needsPassSection: boolean;
}

interface RouteRow {
  section_id: string;
  is_primary: boolean;
}

/**
 * §1.4's resolution, in order, with both entitlement gates in front of it.
 *
 * Routing is a **Gold** capability (owner, 29 Sept 2026) and the gate is asked here rather
 * than by the caller, so no fire path can route a line for a chain whose licence does not
 * cover routing **or** whose module switch is off (lead ruling, 29 Sept 2026: the tier is
 * the entitlement, the switch is the operator's own "on for us", and both are enforced —
 * with a different sentence each, so the operator knows which one to move). The refusal is a
 * `PermissionDenied` carrying a code and a catalogue key — see `~/domain/display-entitlement`
 * for what it does and does not record in the ledger today.
 */
export async function resolveLineRoute(
  tx: Queryable,
  args: { chainId: string; outletId: string; articleId: string }
): Promise<LineRouteResolution> {
  await assertRoutingEntitled(tx, args.chainId);

  // (1) An explicit route for this article wins. All of them are returned: the model allows
  // a combo with a grill component and a dessert one (§1.4 item 5), and the pilot simply
  // uses one. `is_primary` decides which station owns `ready`.
  const explicit = await tx.query<RouteRow>(
    `select r.section_id, r.is_primary
       from article_route r
       join outlet_section s on s.id = r.section_id
      where r.chain_id = $1 and r.outlet_id = $2 and r.article_id = $3
        and s.status = 'active'
      order by r.is_primary desc, r.position, s.sort_order`,
    [args.chainId, args.outletId, args.articleId]
  );
  if (explicit.length > 0) {
    return {
      targets: explicit.map((row) => ({
        sectionId: row.section_id,
        isPrimary: row.is_primary,
        routeSource: "article_route" as const,
      })),
      unrouted: false,
      needsPassSection: false,
    };
  }

  // (2) The category default for the article's own category at this outlet.
  const byCategory = await tx.query<{ section_id: string }>(
    `select d.section_id
       from route_default d
       join article a on a.id = $3 and a.category_id = d.article_category_id
       join outlet_section s on s.id = d.section_id
      where d.chain_id = $1 and d.outlet_id = $2 and s.status = 'active'
      limit 1`,
    [args.chainId, args.outletId, args.articleId]
  );
  if (byCategory[0]) {
    return {
      targets: [{ sectionId: byCategory[0].section_id, isPrimary: true, routeSource: "category_default" }],
      unrouted: false,
      needsPassSection: false,
    };
  }

  // (3) The pass, flagged. Nothing else is guessed.
  const pass = await tx.query<{ id: string }>(
    `select id from outlet_section
      where chain_id = $1 and outlet_id = $2 and kind = 'expedite' and status = 'active'
      order by sort_order, code
      limit 1`,
    [args.chainId, args.outletId]
  );
  if (pass[0]) {
    return {
      targets: [{ sectionId: pass[0].id, isPrimary: true, routeSource: "expedite_fallback" }],
      unrouted: true,
      needsPassSection: false,
    };
  }

  // (4) Unrouted with nowhere to put it: reported, not dropped, and not guessed.
  return { targets: [], unrouted: true, needsPassSection: true };
}

export interface OutletRoutingSummary {
  /** Articles priced for sale at this outlet — the denominator of the worklist. */
  priced: number;
  /** Products whose own route exists. */
  routed: number;
  /** Products that resolve through their category default. */
  defaultOnly: number;
  /** Products that would fall to the pass. This is the configuration worklist (§11.4). */
  unrouted: number;
  /** The pass section the unrouted lines would land on, when the outlet has one. */
  passSection: { id: string; code: string; name: string } | null;
}

/**
 * The unrouted count, which §11.4 calls the pilot's configuration worklist and says should
 * be driven to zero before the demo.
 *
 * "Priced for sale at this outlet" is `article_price` (0008:189), because that is the row
 * that actually makes an article sellable there; an article with no price at an outlet is
 * not something a guest can order. The definition is stated rather than assumed, so a
 * disagreement with it is a conversation and not a defect hunt.
 */
export async function outletRoutingSummary(
  tx: Queryable,
  args: { chainId: string; outletId: string }
): Promise<OutletRoutingSummary> {
  const rows = await tx.query<{
    priced: string;
    routed: string;
    default_only: string;
    unrouted: string;
  }>(
    // The outlet is the whole scope of this count: an outlet id is unique to one chain, and
    // the chain id belongs to the pass lookup below. Binding a `$1` this query never
    // references is what made Postgres refuse it outright — 42P18, "could not determine data
    // type of parameter $1", because a parameter that appears nowhere has no type to infer.
    `with sold as (
       select distinct av.article_id, a.category_id
         from article_price ap
         join article_version av on av.id = ap.article_version_id
         join article a on a.id = av.article_id
        where ap.outlet_id = $1
     )
     select count(*)::text as priced,
            count(*) filter (
              where exists (select 1 from article_route r
                             where r.outlet_id = $1 and r.article_id = sold.article_id)
            )::text as routed,
            count(*) filter (
              where not exists (select 1 from article_route r
                                 where r.outlet_id = $1 and r.article_id = sold.article_id)
                and exists (select 1 from route_default d
                             where d.outlet_id = $1 and d.article_category_id = sold.category_id)
            )::text as default_only,
            count(*) filter (
              where not exists (select 1 from article_route r
                                 where r.outlet_id = $1 and r.article_id = sold.article_id)
                and not exists (select 1 from route_default d
                                 where d.outlet_id = $1 and d.article_category_id = sold.category_id)
            )::text as unrouted
       from sold`,
    [args.outletId]
  );
  const row = rows[0];
  const pass = await tx.query<{ id: string; code: string; name: string }>(
    `select id, code, name from outlet_section
      where chain_id = $1 and outlet_id = $2 and kind = 'expedite' and status = 'active'
      order by sort_order, code limit 1`,
    [args.chainId, args.outletId]
  );
  return {
    priced: Number(row?.priced ?? 0),
    routed: Number(row?.routed ?? 0),
    defaultOnly: Number(row?.default_only ?? 0),
    unrouted: Number(row?.unrouted ?? 0),
    passSection: pass[0] ?? null,
  };
}

// ---------------------------------------------------------------------------
// Maintaining the map. Station-first (D17): a station says what it produces, so the
// mutations are addressed by station. Every write is one transaction, one audit row, one
// named capability, and a validation refusal writes nothing at all.
// ---------------------------------------------------------------------------

export interface MutationMeta {
  source?: "screen" | "chatbot" | "api" | "system" | "import";
  intent?: string | null;
}

interface OutletContext {
  id: string;
  chainId: string;
  siteId: string;
}

/**
 * The outlet's own tenant context, read from the database. Nothing about a chain, site or
 * outlet is ever taken from the request: a crafted `outletId` is resolved here, and the
 * permission check then runs against what the row actually says.
 */
async function outletContext(outletId: string): Promise<OutletContext> {
  const rows = await sql()<{ id: string; chain_id: string; site_id: string }>`
    select id, chain_id, site_id from outlet where id = ${outletId} limit 1
  `;
  const row = rows[0];
  if (!row) throw new NotFound("Outlet", outletId);
  return { id: row.id, chainId: row.chain_id, siteId: row.site_id };
}

async function stationOf(
  tx: Queryable,
  args: { outletId: string; sectionId: string }
): Promise<{ id: string; code: string; name: string; kind: string }> {
  const rows = await tx.query<{ id: string; code: string; name: string; kind: string }>(
    `select id, code, name, kind from outlet_section where id = $1 and outlet_id = $2 limit 1`,
    [args.sectionId, args.outletId]
  );
  const row = rows[0];
  if (!row) {
    // A validation refusal that names the real problem in words. Letting the composite
    // foreign key raise instead would reach the operator as a 500.
    throw new ValidationError("That station is not one of this outlet's stations.", {
      code: "route.validation.sectionNotInOutlet",
    });
  }
  return row;
}

export interface RouteWriteResult {
  articleId: string;
  articleCode: string;
  sectionId: string;
  sectionCode: string;
  isPrimary: boolean;
  position: number;
}

/**
 * Routes an article to a station at one outlet.
 *
 * §1.4 item 5: the pilot uses one route per article, so **a second `is_primary` route for
 * the same (article, outlet) is refused** with a sentence that names the conflict
 * (`route.validation.duplicatePrimary` = "{article} already has a primary station at this
 * outlet: {station}"). It is a **validation** refusal: nothing is written, and the ledger's
 * gap is deliberate.
 */
export async function setArticleRoute(
  principal: Principal,
  input: {
    outletId: string;
    articleId: string;
    sectionId: string;
    isPrimary?: boolean;
    position?: number;
  },
  meta: MutationMeta = {}
): Promise<RouteWriteResult> {
  const outlet = await outletContext(input.outletId);
  await guard({
    principal,
    action: "kds.route.manage",
    entityType: "article_route",
    chainId: outlet.chainId,
    siteId: outlet.siteId,
    target: `outlet ${input.outletId}`,
    source: meta.source,
    intent: meta.intent ?? null,
  });

  const isPrimary = input.isPrimary ?? true;
  const position = input.position ?? 0;

  try {
    const outcome = await auditedMutation({
      principal,
      action: "kds.route.manage",
      entityType: "article_route",
      chainId: outlet.chainId,
      siteId: outlet.siteId,
      source: meta.source,
      intent: meta.intent ?? null,
      run: async (tx) => {
        const station = await stationOf(tx, { outletId: outlet.id, sectionId: input.sectionId });
        // An article has no name column of its own (a name is a row in `article_version_text`,
        // per locale — 0008:151), and this read is only here so a refusal can name the dish in
        // words. The current version's first locale is the same resolution
        // `~/domain/mdm-approvals` uses when it needs one name for a version, and an article
        // with no version text at all falls back to its code rather than to an empty box.
        const article = await tx.query<{ id: string; code: string; name: string | null }>(
          `select a.id, a.code,
                  (select t.name from article_version_text t
                    where t.article_version_id = a.current_version_id
                    order by t.locale limit 1) as name
             from article a
            where a.id = $1 and a.chain_id = $2 limit 1`,
          [input.articleId, outlet.chainId]
        );
        const target = article[0];
        if (!target) throw new NotFound("Article", input.articleId);
        const articleLabel = target.name ?? target.code;

        if (isPrimary) {
          const conflict = await tx.query<{ id: string; name: string; code: string }>(
            `select r.id, s.name, s.code
               from article_route r
               join outlet_section s on s.id = r.section_id
              where r.outlet_id = $1 and r.article_id = $2 and r.is_primary
                and r.section_id <> $3
              limit 1`,
            [outlet.id, input.articleId, input.sectionId]
          );
          if (conflict[0]) {
            throw new ValidationError(
              `${articleLabel} already has a primary station at this outlet: ${conflict[0].name}`,
              {
                code: "route.validation.duplicatePrimary",
                params: { article: articleLabel, station: conflict[0].name },
              }
            );
          }
        }

        const before = await tx.query<{ id: string; is_primary: boolean; position: number }>(
          `select id, is_primary, position from article_route
            where outlet_id = $1 and article_id = $2 and section_id = $3 limit 1`,
          [outlet.id, input.articleId, input.sectionId]
        );
        const rows = await tx.query<{ id: string }>(
          `insert into article_route
             (chain_id, outlet_id, article_id, section_id, position, is_primary, created_by_user_id)
           values ($1, $2, $3, $4, $5, $6, $7)
           on conflict (outlet_id, article_id, section_id)
           do update set position = excluded.position, is_primary = excluded.is_primary,
                         updated_at = now()
           returning id`,
          [outlet.chainId, outlet.id, input.articleId, input.sectionId, position, isPrimary, principal.userId]
        );
        const id = rows[0]?.id;
        if (!id) throw new Error("article_route insert returned no row");
        const snapshot = {
          articleCode: target.code,
          stationCode: station.code,
          isPrimary,
          position,
        };
        return {
          entityId: id,
          before: before[0]
            ? {
                articleCode: target.code,
                stationCode: station.code,
                isPrimary: before[0].is_primary,
                position: before[0].position,
              }
            : null,
          after: snapshot,
        };
      },
    });
    const written = outcome.after as
      | { articleCode: string; stationCode: string; isPrimary: boolean; position: number }
      | null;
    return {
      articleId: input.articleId,
      articleCode: written?.articleCode ?? "",
      sectionId: input.sectionId,
      sectionCode: written?.stationCode ?? "",
      isPrimary,
      position,
    };
  } catch (error) {
    // The partial unique index behind the check above is the backstop, not the message: if
    // it ever fires, the operator still gets the worded refusal rather than a 500.
    if (isHttpError(error)) throw error;
    if (typeof error === "object" && error !== null && (error as { code?: string }).code === "23505") {
      throw new ValidationError("That article already has a primary station at this outlet.", {
        code: "route.validation.duplicatePrimary",
      });
    }
    throw error;
  }
}

/** Removes one article's route to one station. A route that is not there is a refusal. */
export async function removeArticleRoute(
  principal: Principal,
  input: { outletId: string; articleId: string; sectionId: string },
  meta: MutationMeta = {}
): Promise<void> {
  const outlet = await outletContext(input.outletId);
  await guard({
    principal,
    action: "kds.route.manage",
    entityType: "article_route",
    chainId: outlet.chainId,
    siteId: outlet.siteId,
    target: `outlet ${input.outletId}`,
    source: meta.source,
    intent: meta.intent ?? null,
  });

  await auditedMutation({
    principal,
    action: "kds.route.manage",
    entityType: "article_route",
    chainId: outlet.chainId,
    siteId: outlet.siteId,
    source: meta.source,
    intent: meta.intent ?? null,
    run: async (tx) => {
      const existing = await tx.query<{ id: string; is_primary: boolean }>(
        `select id, is_primary from article_route
          where outlet_id = $1 and article_id = $2 and section_id = $3 limit 1`,
        [outlet.id, input.articleId, input.sectionId]
      );
      const row = existing[0];
      if (!row) {
        throw new ValidationError("That article is not routed to that station.", {
          code: "route.validation.routeNotFound",
        });
      }
      await tx.query(`delete from article_route where id = $1`, [row.id]);
      return { entityId: row.id, before: { isPrimary: row.is_primary }, after: null };
    },
  });
}

/** Sets the category default for one outlet — the middle step of §1.4's resolution. */
export async function setCategoryDefault(
  principal: Principal,
  input: { outletId: string; articleCategoryId: string; sectionId: string },
  meta: MutationMeta = {}
): Promise<void> {
  const outlet = await outletContext(input.outletId);
  await guard({
    principal,
    action: "kds.route.manage",
    entityType: "route_default",
    chainId: outlet.chainId,
    siteId: outlet.siteId,
    target: `outlet ${input.outletId}`,
    source: meta.source,
    intent: meta.intent ?? null,
  });

  await auditedMutation({
    principal,
    action: "kds.route.manage",
    entityType: "route_default",
    chainId: outlet.chainId,
    siteId: outlet.siteId,
    source: meta.source,
    intent: meta.intent ?? null,
    run: async (tx) => {
      const station = await stationOf(tx, { outletId: outlet.id, sectionId: input.sectionId });
      // `article_category` carries a code and no name (0008: the category table is
      // id/chain_id/parent_id/code/sort_order/status), so this reads the code and the audit
      // row records the code — which is an identifier position, and the one a routing screen
      // addresses a category by.
      const category = await tx.query<{ id: string; code: string }>(
        `select id, code from article_category where id = $1 and chain_id = $2 limit 1`,
        [input.articleCategoryId, outlet.chainId]
      );
      if (!category[0]) throw new NotFound("Article category", input.articleCategoryId);
      const before = await tx.query<{ section_id: string }>(
        `select section_id from route_default
          where outlet_id = $1 and article_category_id = $2 limit 1`,
        [outlet.id, input.articleCategoryId]
      );
      await tx.query(
        `insert into route_default (chain_id, outlet_id, article_category_id, section_id)
         values ($1, $2, $3, $4)
         on conflict (outlet_id, article_category_id) do update set section_id = excluded.section_id`,
        [outlet.chainId, outlet.id, input.articleCategoryId, input.sectionId]
      );
      return {
        entityId: `${outlet.id}:${input.articleCategoryId}`,
        before: before[0] ? { sectionId: before[0].section_id } : null,
        after: { categoryCode: category[0].code, stationCode: station.code },
      };
    },
  });
}
