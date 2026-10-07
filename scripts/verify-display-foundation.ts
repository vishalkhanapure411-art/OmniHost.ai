/**
 * The display foundation (slice S-A), verified against the **`omnihost_check` scratch
 * database** — the same harness the maker-checker and comparison-view verifications use.
 *
 *   bun run scripts/verify-display-foundation.ts
 *
 * What it proves, in the spec's own read-back order (§11.3.5):
 *   1. migration 0011's objects exist — the four new tables, `outlet_section`'s new columns,
 *      the named constraints and indexes;
 *   2. §2.4's display-layer capabilities are registered — the set is **named** and compared
 *      as a set (fifteen codes: §2.4's table plus its one documented addition, `order.close`),
 *      never as a count over a prefix-wide read, so a code that arrives later is reported as
 *      unexpected by name instead of moving a number — with their grants
 *      counted per role, and `cds.display.view` is held by **no role** — proved not just as a
 *      state but as a *re-run*: the reference seed is run again over this database, twice,
 *      and the grant is read back both times. That is the defect this step exists for: the
 *      blanket `p.code like '%.view'` upsert reaches a code inserted by a later section on a
 *      re-run, and it over-granted the guest display to Site Head in the owner's database;
 *   3. the **two gates** — the licence tier (`chain.licence_tier` against `feature.min_tier`,
 *      fail-closed through `tierSatisfies`) and the module switch (`chain_feature.enabled`) —
 *      are each enforced on their own, each with its own sentence, and neither stands in for
 *      the other (lead ruling, 29 Sept 2026, DECISIONS.md). A refusal writes nothing;
 *   4. station-first routing for real seeded outlets: an article route, a category default,
 *      an **unrouted** line falling to the pilot outlet's **pass section**, and an outlet with
 *      no pass reported unrouted with `needsPassSection` and **no target at all** — no
 *      invented station — plus the duplicate-primary **validation** refusal that writes
 *      nothing;
 *   5. the device principal: a pairing code that is stored hashed, a token that is stored
 *      hashed, a credential revoked and then refused, the fixed capability set by kind,
 *      the wrong-station refusal, and §1.6 items 1–3 executed as SQL.
 *
 * Everything it creates is named `CHECK-*` and removed at the end — including on a failure
 * part-way through — so the run is repeatable. It refuses to run against any database but
 * `omnihost_check`: the reference-seed re-run in step 2 is a write.
 */
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { QueryResultRow } from "pg";
import { Transcript, principalFor } from "./verify-comparison-view-lib";
const CHECK_DATABASE = "omnihost_check";
const TRANSCRIPT = "/home/team/shared/evidence/display-foundation-sA.txt";
const SITE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("DATABASE_URL is not set — nothing to verify against.");
  process.exit(2);
}
const checkUrl = url.replace(/\/(OmniHost|neondb|postgres)(\?|$)/, `/${CHECK_DATABASE}$2`);
if (!new RegExp(`/${CHECK_DATABASE}(\\?|$)`).test(checkUrl)) {
  console.error(`refusing to run: could not point DATABASE_URL at ${CHECK_DATABASE}`);
  process.exit(2);
}
process.env.DATABASE_URL = checkUrl;
console.log(`database: ${checkUrl.replace(/:[^:@]*@/, ":***@")}`);

const { poolQueryable } = await import("~/db");
const { displayCapabilities, deviceAuditReference } = await import("~/domain/display");
const { displayEntitlement, assertRoutingEntitled } = await import("~/domain/display-entitlement");
const { resolveLineRoute, outletRoutingSummary, setArticleRoute, setCategoryDefault } =
  await import("~/domain/display-routing");
const { registerDisplay, pairDisplay, redeemPairingCode, revokeDisplayCredential } =
  await import("~/domain/display-estate");
const { resolveDevicePrincipal, assertDeviceMayActOn, stationQueueWhere, rowScopeWhere } =
  await import("~/server/display-device");
const { can } = await import("~/server/permissions");
const { sha256 } = await import("~/server/crypto");
const { enIN } = await import("~/i18n/catalog-en");

const t = new Transcript();
const q = poolQueryable();
const qq = <R extends QueryResultRow>(text: string, params: unknown[] = []) =>
  q.query<R>(text, params as never[]);
const runStart = new Date();

/**
 * The catalogue sentence a refusal reaches a screen as. Asserting a *code* proves the right
 * branch was taken; reading the sentence proves the operator is told which of the two gates
 * is holding, in words, which is the half of the lead's ruling a code cannot cover.
 */
function sentence(key: string | undefined, params: Record<string, string> = {}): string {
  if (!key) return "(no code)";
  const template = (enIN as unknown as Record<string, string>)[key];
  if (template === undefined) return `(no catalogue entry for ${key})`;
  return Object.entries(params).reduce((text, [name, value]) => text.split(`{${name}}`).join(value), template);
}

async function refusal(
  fn: () => Promise<unknown>
): Promise<{ code: string; message: string; params: Record<string, string> } | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    const details = (error as { details?: { code?: string; params?: Record<string, string> } }).details;
    return {
      code: details?.code ?? "(no code)",
      message: (error as Error).message,
      params: details?.params ?? {},
    };
  }
}

/** Best-effort teardown, so a failure part-way through still leaves the scratch DB as found. */
async function quietly(work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    t.say(`  cleanup note: ${(error as Error).message}`);
  }
}

// The fixtures this run creates, so teardown can name them precisely.
const fixtureChainIds: string[] = [];
let displayId: string | null = null;
let routedOutletId: string | null = null;
let routedArticleId: string | null = null;
let routedCategoryId: string | null = null;
let pricedArticleCodes: string[] = [];

/** A chain with the licence but not the switch, and one with the switch but not the licence. */
async function removeFixtures(): Promise<void> {
  if (displayId) {
    await quietly(() => qq(`delete from display_credential where display_id = $1`, [displayId]));
    await quietly(() => qq(`delete from display where id = $1 or code = 'CHECK-FOREIGN-01'`, [displayId]));
  }
  if (routedOutletId && routedArticleId) {
    await quietly(() => qq(`delete from article_route where outlet_id = $1 and article_id = $2`, [routedOutletId, routedArticleId]));
  }
  if (routedOutletId && routedCategoryId) {
    await quietly(() => qq(`delete from route_default where outlet_id = $1 and article_category_id = $2`, [routedOutletId, routedCategoryId]));
  }
  for (const fixtureId of fixtureChainIds) {
    await quietly(() => qq(`delete from chain_feature where chain_id = $1`, [fixtureId]));
    await quietly(() => qq(`delete from chain where id = $1`, [fixtureId]));
  }
}

try {
  t.say("OmniHost.ai — display foundation (KDS/CDS/KOT slice S-A), against the scratch database.");
  t.say("Writes are confined to this scratch database and to rows named CHECK-*; the owner's demo data is untouched.");

  // -------------------------------------------------------------------------
  t.heading("Migration 0011 — the objects it created");
  // -------------------------------------------------------------------------
  const tables = await qq<{ table_name: string }>(
    `select table_name from information_schema.tables
      where table_schema = 'public'
        and table_name in ('display','display_credential','article_route','route_default')
      order by table_name`
  );
  t.equal(
    "the four new tables exist",
    tables.map((row) => row.table_name).join(","),
    "article_route,display,display_credential,route_default"
  );
  const columns = await qq<{ column_name: string }>(
    `select column_name from information_schema.columns
      where table_name = 'outlet_section' and column_name in ('display_locale','printer_display_id')
      order by column_name`
  );
  t.equal("outlet_section was extended, not replaced", columns.length, 2);
  const constraints = await qq<{ conname: string }>(
    `select conname from pg_constraint
      where conname in ('display_printer_has_section','display_transport_is_printer_only',
                        'display_credential_one_secret','display_credential_display_fk',
                        'article_route_section_same_outlet_fk','route_default_section_same_outlet_fk')
      order by conname`
  );
  t.equal("the named constraints are in place", constraints.length, 6);
  const indexes = await qq<{ indexname: string }>(
    `select indexname from pg_indexes
      where indexname in ('article_route_one_primary_key','display_credential_one_live_key',
                          'display_credential_token_key','display_credential_pairing_key')
      order by indexname`
  );
  t.equal("the four safety indexes are in place", indexes.length, 4);

  // -------------------------------------------------------------------------
  t.heading("§2.4 — the capabilities, their grants, and the over-granted `.view`");
  // -------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // The display layer's vocabulary, **named** and compared as a set.
  //
  // This check used to count what a prefix-wide read returned and compare it to a literal
  // (14, then 13 before that). A count is not a definition: it broke on 7 October when
  // `order.fire` arrived with S-B/2a's fire path and pushed the read from 14 to 15, and it
  // would break again at S-B/3 — and bumping the literal would prove nothing about which
  // codes are there. The set below is named, so an addition is either expected here or
  // reported as *unexpected*, and a removal is reported as *missing*.
  //
  // Where the names come from, code by code:
  //   * `design/kds-and-ticket-routing.md` §2.4's own table — the ten `display.*` / `kds.*`
  //     codes and its three order verbs (`order.book`, `order.fire`, `order.cancel`) — plus
  //     `cds.display.view`, the table's last row (registered, held by no role: step 3 below);
  //   * `order.close`, §2.4's **one deliberate addition**, in `db/seed.sql` section 8's own
  //     words: "§2.3 T11 names order.close and §2.4 registers nothing, so without this row
  //     T11 is a transition no role may make."
  const DISPLAY_LAYER_CAPABILITIES = [
    "display.view",
    "display.manage",
    "kds.route.view",
    "kds.route.manage",
    "kds.ticket.view",
    "kds.ticket.advance",
    "kds.ticket.serve",
    "kds.ticket.recall",
    "kds.ticket.reroute",
    "kds.ticket.void",
    "order.book",
    "order.fire",
    "order.cancel",
    "order.close",
    "cds.display.view",
  ] as const;

  const perms = await qq<{ code: string; action_kind: string }>(
    `select code, action_kind from permission
      where code like 'display.%' or code like 'kds.%' or code like 'order.%' or code = 'cds.display.view'
      order by code`
  );
  // The prefix-wide read stays, but only as the **printed inventory** — it is what shows a
  // code the named set above does not know about instead of hiding it behind a count.
  t.say(`  registered (prefix-wide inventory): ${perms.map((row) => row.code).join(",")}`);
  const registered = new Set(perms.map((row) => row.code));
  const expected = new Set<string>(DISPLAY_LAYER_CAPABILITIES);
  const missing = [...expected].filter((code) => !registered.has(code)).sort();
  const unexpected = [...registered].filter((code) => !expected.has(code)).sort();
  t.check(
    `the display-layer capabilities §2.4 defines are registered and no others — set equality over ${String(expected.size)} named codes`,
    missing.length === 0 && unexpected.length === 0,
    `missing: ${missing.length === 0 ? "none" : missing.join(",")} | unexpected: ${unexpected.length === 0 ? "none" : unexpected.join(",")}`
  );
  const grants = await qq<{ code: string; roles: string; holders: string }>(
    `select p.code, count(distinct r.code)::text as roles, count(rp.role_id)::text as holders
       from permission p
       left join role_permission rp on rp.permission_id = p.id
       left join role r on r.id = rp.role_id
      where p.code like 'display.%' or p.code like 'kds.%' or p.code like 'order.%'
         or p.code = 'cds.display.view'
      group by p.code order by p.code`
  );
  t.json("capability → roles / grants", grants);
  t.check(
    "every capability is held by at least one role, except the guest display's",
    grants.filter((row) => row.code !== "cds.display.view").every((row) => Number(row.roles) > 0)
  );

  const cdsHolderQuery = `select r.code as role from role_permission rp
      join permission p on p.id = rp.permission_id
      join role r on r.id = rp.role_id
     where p.code = 'cds.display.view' order by r.code`;
  const holdersBefore = await qq<{ role: string }>(cdsHolderQuery);
  t.say(
    `  before this step: ${String(holdersBefore.length)} role(s) hold cds.display.view` +
      (holdersBefore.length ? ` — ${holdersBefore.map((row) => row.role).join(", ")}` : "")
  );

  // The re-run, which is the whole point of the check. The reference seed half of `db/seed.sql`
  // is re-runnable by design and this is where that claim is tested: it writes platform
  // vocabulary only (role, permission, role_permission, feature, setting_definition), so
  // running it here touches no tenant row. Twice, because a defect that only appears on the
  // *second* application is exactly what the `%.view` sweep turned out to be.
  const seedRuns: { status: number | null; stderr: string }[] = [];
  for (let pass = 1; pass <= 2; pass += 1) {
    const run = spawnSync("bun", ["run", "scripts/db.ts", "seed-reference"], {
      cwd: SITE_ROOT,
      env: { ...process.env, DATABASE_URL: checkUrl },
      encoding: "utf8",
    });
    const stderr = (run.stderr ?? "").trim();
    seedRuns.push({ status: run.status, stderr });
    t.say(`  reference-seed pass ${String(pass)}: exit ${String(run.status)}${stderr ? ` — ${stderr}` : ""}`);
  }
  t.check(
    "re-running the reference seed over this database succeeds, twice",
    seedRuns.every((run) => run.status === 0)
  );
  const cdsGrant = await qq<{ n: string }>(
    `select count(*)::text as n from role_permission rp
       join permission p on p.id = rp.permission_id where p.code = 'cds.display.view'`
  );
  t.equal(
    "the guest display's capability is granted to no role (device principals only) — after two re-runs",
    cdsGrant[0]?.n,
    "0"
  );
  const holdersAfter = await qq<{ role: string }>(cdsHolderQuery);
  t.say(
    `  after: ${String(holdersAfter.length)} role(s) hold it${holdersAfter.length ? ` — ${holdersAfter.map((row) => row.role).join(", ")}` : " (the over-grant is gone)"}`
  );
  const cdsDefinition = await qq<{ code: string }>(
    `select code from permission where code = 'cds.display.view'`
  );
  t.equal(
    "and the capability itself is still registered — revoked from the role, not deleted",
    cdsDefinition.length,
    1
  );

  // -------------------------------------------------------------------------
  t.heading("The two gates — the licence tier, and the module switch");
  // -------------------------------------------------------------------------
  // The display demo data, **through the seeding path** — the same two facts the owner's
  // database gets from `db:seed:display`: the module switch the pilot chain needs, and the
  // pass section the unrouted fallback needs. Not hand-typed rows: the seeding path is what
  // is being verified, and a hand-typed row here would prove nothing about it.
  const seeded = spawnSync("bun", ["run", "scripts/db.ts", "seed-display"], {
    cwd: SITE_ROOT,
    env: { ...process.env, DATABASE_URL: checkUrl },
    encoding: "utf8",
  });
  t.check(
    "the display demo data applies through the seeding path",
    seeded.status === 0,
    (seeded.stdout ?? "").trim().split("\n").filter((line) => line.startsWith("seed:")).join(" | ") ||
      (seeded.stderr ?? "").trim().slice(0, 200)
  );

  const chain = await qq<{ id: string; code: string; licence_tier: string }>(
    `select id, code, licence_tier from chain where code = 'saffron-table'`
  );
  const goldChain = chain[0];
  if (!goldChain) throw new Error("no saffron-table chain in this database");
  const entitlement = await displayEntitlement(q, goldChain.id);
  t.json("the pilot chain's entitlement", entitlement);
  t.check("the chain's licence covers the Gold routing capability", entitlement?.routing.tierEntitled === true);
  t.equal("routing's minimum tier is Gold", entitlement?.routing.minTier, "gold");
  t.check(
    "the module switch is seeded on for the pilot chain (migration of demo data, not of the licence)",
    entitlement?.routing.toggleEnabled === true
  );
  t.check(
    "so the gate opens — both facts hold, and only then",
    entitlement?.routing.entitled === true && entitlement?.routing.tierEntitled === true
  );
  t.check(
    "the tier and the switch are still reported as two facts, not merged into one",
    typeof entitlement?.routing.tierEntitled === "boolean" &&
      typeof entitlement?.routing.toggleEnabled === "boolean"
  );
  t.check("the guest display's two gates both hold on the pilot chain", entitlement?.guestDisplay.entitled === true);

  // An unrecognised tier is refused rather than read as the cheapest real tier. Two
  // independent proofs, and neither edits a row: the comparison is exercised directly, and
  // the database is asked to store a tier nobody recorded. (It refuses — `chain_licence_tier_check`
  // is why an unknown tier cannot even reach `tierSatisfies` from this column, which makes the
  // fail-closed comparison the second line of defence rather than the only one. The first is
  // the one that matters: a value arrives from any source and still grants nothing.)
  const { tierSatisfies } = await import("~/domain/chains");
  t.check(
    "an unrecognised tier satisfies nothing",
    tierSatisfies("bronze", "gold") === false && tierSatisfies("gold", "bronze") === false
  );
  t.check("and an unknown minimum is not read as the cheapest tier", tierSatisfies("platinum", "bronze") === false);
  let constraintCode = "(none)";
  try {
    await qq(`update chain set licence_tier = 'bronze' where id = $1`, [goldChain.id]);
  } catch (error) {
    constraintCode = (error as { code?: string }).code ?? "(none)";
  }
  t.equal("the database refuses to store a tier the registry does not know", constraintCode, "23514");
  const restored = await qq<{ licence_tier: string }>(`select licence_tier from chain where id = $1`, [
    goldChain.id,
  ]);
  t.equal("and the chain's tier is unchanged", restored[0]?.licence_tier, goldChain.licence_tier);

  const auditBeforeGates = await qq<{ n: string }>(
    `select count(*)::text as n from audit_log where created_at >= $1`,
    [runStart]
  );
  const routesBeforeGates = await qq<{ n: string }>(`select count(*)::text as n from article_route`);

  // (a) the SWITCH holds on its own: a chain whose licence covers routing with the module
  // off, so the refusal must be the switch's and must say so. A fixture chain, because a
  // seeded chain's switch state is demo data this session deliberately changes on the pilot
  // chain alone — and what is under test here is the gate, not the seed.
  const switchFixture = (
    await qq<{ id: string }>(
      `insert into chain (name, code, licence_tier, tax_jurisdiction)
       values ('Check No Switch', 'CHECK-NOSWITCH', 'platinum', null)
       on conflict (code) do update set licence_tier = 'platinum', updated_at = now()
       returning id`
    )
  )[0];
  const noSwitchChainId = switchFixture?.id ?? null;
  if (!noSwitchChainId) throw new Error("could not create the check chain that has no switch");
  fixtureChainIds.push(noSwitchChainId);
  await qq(`delete from chain_feature where chain_id = $1 and feature_code = 'kds_multi_station'`, [
    noSwitchChainId,
  ]);
  const noSwitchEntitlement = await displayEntitlement(q, noSwitchChainId);
  t.json("a chain that holds the tier with the module switched off", noSwitchEntitlement);
  t.check("its licence covers routing", noSwitchEntitlement?.routing.tierEntitled === true);
  t.check("and its module switch is off", noSwitchEntitlement?.routing.toggleEnabled === false);
  const switchRefused = await refusal(() => assertRoutingEntitled(q, noSwitchChainId));
  t.json("routing for that chain", switchRefused);
  t.equal("is refused on the switch", switchRefused?.code, "permission.licence.moduleOff");
  t.say(`  the sentence an operator reads: "${sentence(switchRefused?.code, switchRefused?.params)}"`);
  t.check(
    "its sentence names the module in words",
    sentence(switchRefused?.code, switchRefused?.params).includes("KDS multi-station routing")
  );
  t.check(
    "and says the licence covers it, so the tier is not what is holding",
    sentence(switchRefused?.code, switchRefused?.params).toLowerCase().includes("licence covers it") &&
      !/\{/.test(sentence(switchRefused?.code, switchRefused?.params))
  );
  t.check(
    "so the two failures are two different sentences, not one message for both",
    switchRefused?.code !== "permission.licence.tierBelow"
  );

  // (b) the TIER holds on its own: a chain with the module switched ON and a Silver licence.
  // A fixture chain, written here and removed below, because no seeded chain is below Gold —
  // `saffron-table` is gold and `coastal-catch` platinum (read back 29 Sept 2026).
  const fixture = (
    await qq<{ id: string }>(
      `insert into chain (name, code, licence_tier, tax_jurisdiction)
       values ('Check Low Tier', 'CHECK-LOWTIER', 'silver', null)
       on conflict (code) do update set licence_tier = 'silver', updated_at = now()
       returning id`
    )
  )[0];
  const lowTierChainId = fixture?.id ?? null;
  if (!lowTierChainId) throw new Error("could not create the low-tier check chain");
  fixtureChainIds.push(lowTierChainId);
  await qq(
    `insert into chain_feature (chain_id, feature_code, enabled)
     values ($1, 'kds_multi_station', true)
     on conflict (chain_id, feature_code) do update set enabled = true, updated_at = now()`,
    [lowTierChainId]
  );
  const lowEntitlement = await displayEntitlement(q, lowTierChainId);
  t.json("a chain with the module switched on and a Silver licence", lowEntitlement);
  t.check("its module switch is on", lowEntitlement?.routing.toggleEnabled === true);
  t.check("and its licence does not cover routing", lowEntitlement?.routing.tierEntitled === false);
  const tierRefused = await refusal(() => assertRoutingEntitled(q, lowTierChainId));
  t.json("routing for that chain", tierRefused);
  t.equal("is refused on the licence", tierRefused?.code, "permission.licence.tierBelow");
  t.say(`  the sentence an operator reads: "${sentence(tierRefused?.code, tierRefused?.params)}"`);
  t.check(
    "its sentence names the minimum tier and the tier the chain is on",
    sentence(tierRefused?.code, tierRefused?.params).includes("gold") &&
      sentence(tierRefused?.code, tierRefused?.params).includes("silver")
  );
  t.check(
    "and it is not the switch's sentence",
    tierRefused?.code !== "permission.licence.moduleOff" && tierRefused?.code !== switchRefused?.code
  );

  // (c) and neither refusal touched anything: no data, and no audit row either — the gate is
  // raised inside the resolver, and `guard()` is what writes a `denied` row. Recorded here so
  // the gap is visible rather than assumed away; S-B's fire path has to ask the gate before it
  // opens its transaction for the refusal to reach the ledger.
  const auditAfterGates = await qq<{ n: string }>(
    `select count(*)::text as n from audit_log where created_at >= $1`,
    [runStart]
  );
  const routesAfterGates = await qq<{ n: string }>(`select count(*)::text as n from article_route`);
  t.equal("neither entitlement refusal wrote an audit row", auditAfterGates[0]?.n, auditBeforeGates[0]?.n);
  t.equal("nor a routing row", routesAfterGates[0]?.n, routesBeforeGates[0]?.n);

  // -------------------------------------------------------------------------
  t.heading("Routing — a real seeded outlet, station first, pass second");
  // -------------------------------------------------------------------------
  const outlet = (
    await qq<{ id: string; code: string; chain_id: string; site_id: string }>(
      `select id, code, chain_id, site_id from outlet where code = 'koramangala-restaurant'`
    )
  )[0];
  if (!outlet) throw new Error("no koramangala-restaurant outlet in this database");
  const sections = await qq<{ id: string; code: string; name: string; kind: string }>(
    `select id, code, name, kind from outlet_section where outlet_id = $1 order by sort_order`,
    [outlet.id]
  );
  t.json("the pilot outlet's sections", sections.map((row) => `${row.code} (${row.kind})`));
  const pass = sections.find((row) => row.kind === "expedite");
  t.check(
    "the pilot outlet has a pass section, so an unrouted line has a real place to land",
    pass !== undefined,
    pass ? `${pass.code} — ${pass.name}` : "none"
  );
  const noPass = (
    await qq<{ id: string; code: string; chain_id: string; site_id: string }>(
      `select o.id, o.code, o.chain_id, o.site_id from outlet o
        where o.chain_id = $1 and not exists (
          select 1 from outlet_section s
           where s.outlet_id = o.id and s.kind = 'expedite' and s.status = 'active')
        order by o.code limit 1`,
      [outlet.chain_id]
    )
  )[0];
  t.check(
    "and another outlet of the same chain has none, which is the refusing half of D3",
    noPass !== undefined,
    noPass?.code ?? "none"
  );

  const priced = await qq<{ article_id: string; code: string; name: string | null; category_id: string }>(
    // A name is a row in `article_version_text`, not a column on `article` (0008:151) — the
    // earlier read of `a.name` was reading a column that has never existed.
    `select distinct av.article_id, a.code,
            (select t.name from article_version_text t
              where t.article_version_id = av.id order by t.locale limit 1) as name,
            a.category_id
       from article_price ap
       join article_version av on av.id = ap.article_version_id
       join article a on a.id = av.article_id
      where ap.outlet_id = $1
      order by a.code`,
    [outlet.id]
  );
  t.check("the outlet has priced articles to route", priced.length > 3, `${priced.length} priced`);
  pricedArticleCodes = priced.slice(0, 3).map((row) => row.code);

  const before = await outletRoutingSummary(q, { chainId: outlet.chain_id, outletId: outlet.id });
  t.json("routing summary before this run's writes", before);
  t.check(
    "the summary names the pass those unrouted lines would land on",
    before.passSection !== null,
    before.passSection ? `${before.passSection.code} — ${before.passSection.name}` : "none"
  );

  // The Site Head the demo data gives the role: `site.head@saffron.example`, whose assignment
  // is `SITE_HEAD` at `saffron-koramangala` — the pilot outlet's own site — holding
  // `kds.route.manage` and `display.manage` at role level. Named, not searched for, so a
  // missing account fails as a missing account rather than as a permission mystery.
  const principal = await principalFor(q, "site.head@saffron.example", outlet.chain_id);
  t.say(`principal: ${principal.email} (${principal.roles.map((role) => role.code).join(", ")})`);
  t.check(
    "the principal holds kds.route.manage and display.manage",
    principal.permissions.includes("kds.route.manage") && principal.permissions.includes("display.manage")
  );
  // The scope the harness used to drop. `principalFor` built every principal with
  // `siteId: null`, so this run died with "your scope names no site" *before* the routing
  // under test — looking exactly like a demo-data gap in which the Site Head cannot manage
  // its site's routes. It is not: the account's assignment names the site, and the check is
  // here so the two can never be confused again.
  t.equal("the Site Head's scope names its own site — the pilot outlet's", principal.siteId, outlet.site_id);
  t.check(
    "and its scope recognises a route write at that outlet (the refusal that killed the last run)",
    await can(principal, "kds.route.manage", {
      chainId: outlet.chain_id,
      siteId: outlet.site_id,
      describes: `outlet ${outlet.id}`,
    })
  );

  const grill = sections.find((row) => row.code === "KOR-GRILL")!;
  const hot = sections.find((row) => row.code === "KOR-HOT")!;
  const articleA = priced[0]!;
  const articleB = priced.find((row) => row.category_id !== articleA.category_id)!;
  const articleC = priced.find((row) => row.article_id !== articleA.article_id && row.article_id !== articleB.article_id)!;

  const written = await setArticleRoute(principal, {
    outletId: outlet.id,
    articleId: articleA.article_id,
    sectionId: grill.id,
  });
  routedOutletId = outlet.id;
  routedArticleId = articleA.article_id;
  routedCategoryId = articleB.category_id;
  t.json("article_route written by the domain layer", written);

  const resolvedA = await resolveLineRoute(q, {
    chainId: outlet.chain_id,
    outletId: outlet.id,
    articleId: articleA.article_id,
  });
  t.json(`${articleA.code} resolves to`, resolvedA);
  t.equal("the article's own route wins", resolvedA.targets[0]?.routeSource, "article_route");
  t.equal("and it targets the station that was configured", resolvedA.targets[0]?.sectionId, grill.id);
  t.equal("so the line is routed", resolvedA.unrouted, false);

  await setCategoryDefault(principal, {
    outletId: outlet.id,
    articleCategoryId: articleB.category_id,
    sectionId: hot.id,
  });
  const resolvedB = await resolveLineRoute(q, {
    chainId: outlet.chain_id,
    outletId: outlet.id,
    articleId: articleB.article_id,
  });
  t.json(`${articleB.code} resolves to`, resolvedB);
  t.equal("the category default is the second step", resolvedB.targets[0]?.routeSource, "category_default");
  t.equal("and it targets the category's station", resolvedB.targets[0]?.sectionId, hot.id);

  const resolvedC = await resolveLineRoute(q, {
    chainId: outlet.chain_id,
    outletId: outlet.id,
    articleId: articleC.article_id,
  });
  t.json(`${articleC.code} (no route, no default) resolves to`, resolvedC);
  t.check("the unrouted line is reported unrouted, never dropped", resolvedC.unrouted === true);
  t.equal("and falls to the outlet's pass — a real station, not an invention", resolvedC.targets[0]?.sectionId, pass?.id);
  t.equal("recorded as unrouted, the same value the fire path records (lead ruling, 1 Oct 2026)", resolvedC.targets[0]?.routeSource, "unrouted");
  t.equal("with nothing outstanding, because the pass exists", resolvedC.needsPassSection, false);

  if (noPass) {
    const resolvedNoPass = await resolveLineRoute(q, {
      chainId: noPass.chain_id,
      outletId: noPass.id,
      articleId: articleC.article_id,
    });
    t.json(`${articleC.code} at ${noPass.code} (no pass section) resolves to`, resolvedNoPass);
    t.check("an outlet with no pass leaves the line visibly unrouted", resolvedNoPass.unrouted === true);
    t.equal("with no target at all — no third guess is ever made", resolvedNoPass.targets.length, 0);
    t.check("and says so, instead of naming a station that does not make it", resolvedNoPass.needsPassSection === true);
    const noPassSummary = await outletRoutingSummary(q, { chainId: noPass.chain_id, outletId: noPass.id });
    t.equal("the summary reports no pass for that outlet", noPassSummary.passSection, null);
  }

  const auditBefore = await qq<{ n: string }>(
    `select count(*)::text as n from audit_log where created_at >= $1`,
    [runStart]
  );
  const duplicate = await refusal(async () => {
    await setArticleRoute(principal, { outletId: outlet.id, articleId: articleA.article_id, sectionId: hot.id });
  });
  t.json("routing the same article to a second primary station", duplicate);
  t.equal("is a validation refusal naming the conflict", duplicate?.code, "route.validation.duplicatePrimary");
  t.say(`  the sentence an operator reads: "${sentence(duplicate?.code, duplicate?.params)}"`);
  t.check(
    "and it names the dish and the station it already has, in words",
    sentence(duplicate?.code, duplicate?.params).includes(grill.name) &&
      !sentence(duplicate?.code, duplicate?.params).includes("{"),
    sentence(duplicate?.code, duplicate?.params)
  );
  const auditAfter = await qq<{ n: string }>(
    `select count(*)::text as n from audit_log where created_at >= $1`,
    [runStart]
  );
  t.equal("and it wrote nothing at all — no audit row, no data", auditAfter[0]?.n, auditBefore[0]?.n);

  // Read the category default's reach from the database rather than assuming it: the number
  // of priced articles in `articleB`'s category is exactly what the default now covers.
  const covered = await qq<{ n: string; routed_by_name: string }>(
    `select count(distinct av.article_id)::text as n,
            count(distinct av.article_id) filter (
              where exists (select 1 from article_route r
                             where r.outlet_id = $1 and r.article_id = av.article_id)
            )::text as routed_by_name
       from article_price ap
       join article_version av on av.id = ap.article_version_id
       join article a on a.id = av.article_id
      where ap.outlet_id = $1 and a.category_id = $2`,
    [outlet.id, articleB.category_id]
  );
  const categorySize = Number(covered[0]?.n ?? 0);
  const categoryRoutedByName = Number(covered[0]?.routed_by_name ?? 0);

  const after = await outletRoutingSummary(q, { chainId: outlet.chain_id, outletId: outlet.id });
  t.json("routing summary after this run's writes", after);
  // The summary is three mutually exclusive buckets over the same priced set: `routed` (the
  // product has its own route), `defaultOnly` (its category does) and `unrouted` (neither —
  // §11.4's worklist). This run made **two** configuration writes, and the earlier assertion
  // ("one fewer unrouted") counted only the first, so it failed by 4 — the arithmetic below
  // is the whole effect, with the buckets still partitioning the set.
  t.equal("one more article is routed by name than before", after.routed, before.routed + 1);
  t.equal(
    "the category default lifts every priced article in that category it did not already route",
    after.defaultOnly - before.defaultOnly,
    categorySize - categoryRoutedByName
  );
  t.equal(
    "and the unrouted worklist falls by exactly those two writes, nothing else",
    after.unrouted,
    before.unrouted - (after.routed - before.routed) - (after.defaultOnly - before.defaultOnly)
  );
  t.equal("the priced set is unchanged — no article was added or removed to move a count", after.priced, before.priced);
  t.equal(
    "and routed + defaultOnly + unrouted still add up to every priced article",
    after.routed + after.defaultOnly + after.unrouted,
    after.priced
  );

  // -------------------------------------------------------------------------
  t.heading("The device principal — pairing, the token, revocation");
  // -------------------------------------------------------------------------
  const display = await registerDisplay(principal, {
    outletId: outlet.id,
    code: "CHECK-KDS-01",
    name: "Check KDS 01",
    kind: "kds",
    sectionId: grill.id,
  });
  displayId = display.id;
  t.json("display registered", display);

  const paired = await pairDisplay(principal, { displayId: display.id });
  t.json("pairing issued", {
    displayCode: paired.displayCode,
    expiresAt: paired.expiresAt,
    revokedCredentialId: paired.revokedCredentialId,
  });
  const storedCode = await qq<{ pairing_code_hash: string; token_hash: string | null; operating_role_code: string }>(
    `select pairing_code_hash, token_hash, operating_role_code from display_credential where id = $1`,
    [paired.credentialId]
  );
  t.equal("the pairing code is stored hashed", storedCode[0]?.pairing_code_hash, sha256(paired.pairingCode));
  t.check("and the raw code appears nowhere in the row", storedCode[0]?.pairing_code_hash !== paired.pairingCode);
  t.equal("no token exists until the code is redeemed", storedCode[0]?.token_hash, null);
  t.equal("a KDS acts as the kitchen's own role", storedCode[0]?.operating_role_code, "SITE_CULINARY_TEAM");

  const redeemed = await redeemPairingCode(paired.pairingCode);
  if (!redeemed) throw new Error("the pairing code was not redeemed");
  const storedToken = await qq<{ pairing_code_hash: string | null; token_hash: string }>(
    `select pairing_code_hash, token_hash from display_credential where id = $1`,
    [paired.credentialId]
  );
  t.equal("the device token is stored hashed", storedToken[0]?.token_hash, sha256(redeemed.token));
  t.equal("and the single-use code is cleared", storedToken[0]?.pairing_code_hash, null);
  t.check("the raw token appears nowhere in the row", storedToken[0]?.token_hash !== redeemed.token);

  const resolved = await resolveDevicePrincipal(redeemed.token);
  t.json("the terminal resolves to", resolved.ok ? { ...resolved.device, capabilities: resolved.device.capabilities } : resolved);
  t.check("the terminal resolves", resolved.ok === true);
  if (resolved.ok) {
    t.equal("its chain comes from the display row", resolved.device.chainId, outlet.chain_id);
    t.equal("its outlet comes from the display row", resolved.device.outletId, outlet.id);
    t.equal("its station comes from the display row", resolved.device.sectionId, grill.id);
    t.equal(
      "its capability set is fixed by kind",
      resolved.device.capabilities.join(","),
      "kds.ticket.view,kds.ticket.advance"
    );
    t.equal("and its audit rows would name the device", deviceAuditReference(resolved.device), "display:CHECK-KDS-01");

    // §1.6 item 3, executed: the same fragment an UPDATE binds, as a SELECT.
    const ownScope = rowScopeWhere(resolved.device, { alias: "d", id: display.id, parameterOffset: 0 });
    const ownRows = await qq<{ id: string }>(`select d.id from display d where ${ownScope.sql}`, ownScope.params);
    t.equal("the tenant predicate finds the device's own row", ownRows.length, 1);
    const foreignId = (
      await qq<{ id: string }>(`select id from display where chain_id <> $1 limit 1`, [outlet.chain_id])
    )[0]?.id;
    if (foreignId) {
      const foreignScope = rowScopeWhere(resolved.device, { alias: "d", id: foreignId, parameterOffset: 0 });
      const foreignRows = await qq<{ id: string }>(
        `select d.id from display d where ${foreignScope.sql}`,
        foreignScope.params
      );
      t.equal("and returns nothing for another chain's row, by id", foreignRows.length, 0);
    } else {
      const other = (
        await qq<{ id: string }>(`select id from chain where id <> $1 limit 1`, [outlet.chain_id])
      )[0];
      // A fixture the boundary test needs: a display row in another chain, written directly
      // because our principal is scoped to its own chain and must not be able to create it.
      const otherOutlet = (
        await qq<{ id: string; site_id: string }>(
          `select id, site_id from outlet where chain_id = $1 limit 1`,
          [other?.id]
        )
      )[0];
      if (otherOutlet) {
        await qq(
          `insert into display (chain_id, site_id, outlet_id, code, name, kind)
           values ($1, $2, $3, 'CHECK-FOREIGN-01', 'Check Foreign 01', 'status')
           on conflict (outlet_id, code) do nothing`,
          [other?.id, otherOutlet.site_id, otherOutlet.id]
        );
        const fixture = (
          await qq<{ id: string }>(`select id from display where code = 'CHECK-FOREIGN-01'`)
        )[0];
        const foreignScope = rowScopeWhere(resolved.device, {
          alias: "d",
          id: fixture?.id ?? "",
          parameterOffset: 0,
        });
        const foreignRows = await qq<{ id: string }>(
          `select d.id from display d where ${foreignScope.sql}`,
          foreignScope.params
        );
        t.equal(
          "another chain's row is invisible to this device's predicate, by id",
          foreignRows.length,
          0
        );
      }
    }

    // §1.6 item 2 in its station form.
    const queue = stationQueueWhere(resolved.device, { alias: "t", parameterOffset: 2 });
    t.json("a station screen's queue predicate", queue);
    t.check(
      "the station predicate pins chain, outlet and section",
      queue.sql.includes("chain_id") && queue.sql.includes("outlet_id") && queue.sql.includes("section_id")
    );

    // The refusals, as sentences and as codes.
    const ownTarget = { chainId: outlet.chain_id, outletId: outlet.id, siteId: outlet.site_id, sectionId: grill.id };
    try {
      assertDeviceMayActOn(resolved.device, "kds.ticket.advance", ownTarget);
      t.say("  PASS  its own station's ticket is allowed");
    } catch (error) {
      t.check("its own station's ticket is allowed", false, (error as Error).message);
    }
    const otherStation = await refusal(async () => {
      assertDeviceMayActOn(resolved.device, "kds.ticket.advance", { ...ownTarget, sectionId: hot.id });
    });
    t.equal("another station's ticket is refused, worded", otherStation?.code, "kds.refusal.notYourStation");
    const otherChain = await refusal(async () => {
      assertDeviceMayActOn(resolved.device, "kds.ticket.advance", {
        ...ownTarget,
        chainId: "00000000-0000-0000-0000-000000000000",
      });
    });
    t.equal(
      "and another chain's ticket gives the same sentence, so nothing is confirmed",
      otherChain?.code,
      otherStation?.code
    );
    const cdsDevice = {
      ...resolved.device,
      kind: "cds" as const,
      capabilities: displayCapabilities("cds"),
    };
    const cdsActing = await refusal(async () => {
      assertDeviceMayActOn(cdsDevice, "kds.ticket.advance", ownTarget);
    });
    t.equal(
      "a guest display reaching a kitchen action is refused on its own sentence",
      cdsActing?.code,
      "kds.refusal.actionNotOnTerminal"
    );
    t.equal("and an unknown kind gets no capability at all", displayCapabilities("hologram").length, 0);
  }

  // Revocation stops the terminal.
  const revoked = await refusal(async () => {
    await revokeDisplayCredential(principal, { displayId: display.id, reason: "verification run" });
  });
  t.equal("withdrawing access succeeds", revoked, null);
  const afterRevoke = await resolveDevicePrincipal(redeemed.token);
  t.json("the same token after revocation", afterRevoke);
  t.equal("a revoked credential is refused", afterRevoke.ok === false && afterRevoke.reason, "revoked");
  const noLive = await refusal(async () => {
    await revokeDisplayCredential(principal, { displayId: display.id, reason: "again" });
  });
  t.equal("and withdrawing again is a validation refusal", noLive?.code, "display.validation.noLiveCredential");

  // -------------------------------------------------------------------------
  t.heading("The ledger — one transaction, one row, one capability per mutation");
  // -------------------------------------------------------------------------
  const ledger = await qq<{
    action: string;
    entity_type: string;
    outcome: string;
    actor_role_code: string;
    reason: string | null;
    source: string;
  }>(
    `select action, entity_type, outcome, actor_role_code, reason, request_source as source
       from audit_log where created_at >= $1 order by created_at, action`,
    [runStart]
  );
  t.json("audit rows written by this run", ledger);
  const successes = ledger.filter((row) => row.outcome === "success");
  t.equal(
    "one success row per mutation: register, pair, redeem, route, category default, revoke",
    successes.length,
    6
  );
  t.check(
    "the pairing row is addressed by the device, not by a person",
    ledger.some((row) => row.action === "display.pair" && row.reason?.startsWith("display:CHECK-KDS-01") === true)
  );
  t.equal("no validation refusal wrote a row", ledger.filter((row) => row.outcome === "denied").length, 0);

  // -------------------------------------------------------------------------
  t.heading("Cleanup — the scratch database is left as it was found");
  // -------------------------------------------------------------------------
  await removeFixtures();
  const leftovers = await qq<{ n: string }>(
    // The cast belongs to the whole sum, not to its last term: `bigint + bigint + text` is
    // 42883 "operator does not exist", which is how this check failed the first time it ran.
    `select ((select count(*) from display where code like 'CHECK-%')
           + (select count(*) from chain where code like 'CHECK-%')
           + (select count(*) from article_route r join article a on a.id = r.article_id
               where a.code = any($1::text[])))::text as n`,
    [pricedArticleCodes]
  );
  t.equal("no CHECK-* display, no CHECK chain and no route written by this run remains", leftovers[0]?.n, "0");
} catch (error) {
  await removeFixtures();
  t.check("the run completed", false, (error as Error).message);
  console.error(error);
}

const failures = t.finish(TRANSCRIPT, "S-A's model, capabilities, two gates and boundaries behave as specified.");
process.exit(failures === 0 ? 0 : 1);
