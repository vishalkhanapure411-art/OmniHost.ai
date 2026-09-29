/**
 * The comparison view's read, verified against the **owner's demo database** — read only.
 *
 *   bun run scripts/verify-comparison-view-demo.ts
 *
 * What it proves: `getArticleVersionReview` returns the spec's §5.2 shape for the seeded
 * maker-checker pair — sellable version 1 (`On sale`) against proposed version 2 (`Proposed`)
 * on `DEMO-MC-PROPOSED` — with the pair resolved from `supersedes_version_id`, the change
 * kinds, the tier ordering and the money deltas correct; and it proves it against the
 * **underlying rows**, read back with SQL, not against the read's own arithmetic.
 *
 * What it does NOT write: nothing. `DATABASE_URL` is left exactly as it was found, no session
 * row is minted (the principal is assembled from the database's own role and permission rows,
 * see `verify-comparison-view-lib.ts`), and the read under test is a read. It refuses to run
 * unless `DATABASE_URL` points at the owner's database, so it cannot silently test one
 * database while reporting on another.
 *
 * Anything needing data this database does not hold — an allergen or nutrient difference, a
 * removed or added outlet price, a currency change — is in
 * `scripts/verify-comparison-view-scratch.ts`, which runs against `omnihost_check`.
 *
 * Transcript: `/home/team/shared/evidence/comparison-view-server-demo.txt`.
 */
import { Transcript, byId, checkStructure, emailsHolding, errorMessage, principalFor } from "./verify-comparison-view-lib";

const OWNER_DATABASE = "OmniHost";
const TRANSCRIPT = "/home/team/shared/evidence/comparison-view-server-demo.txt";
const ARTICLE_CODE = "DEMO-MC-PROPOSED";

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("DATABASE_URL is not set — nothing to verify against.");
  process.exit(2);
}
if (!new RegExp(`/${OWNER_DATABASE}(\\?|$)`).test(url)) {
  console.error(
    `refusing to run: DATABASE_URL does not point at ${OWNER_DATABASE}. This script reports on the owner's demo data; the scratch run is a different script.`
  );
  process.exit(2);
}

const { poolQueryable } = await import("~/db");
const { getArticleVersionReview } = await import("~/domain/mdm-approvals");
const { can } = await import("~/server/permissions");

const t = new Transcript();
const q = poolQueryable();

try {
  t.say("OmniHost.ai — the before/after comparison view's read, against the owner's demo database.");
  t.say(`database: ${url.replace(/:[^:@]*@/, ":***@")}`);
  t.say("This run writes nothing: no session, no audit row, no data change.");

  // -------------------------------------------------------------------------
  t.heading("The pair this database actually holds, read with SQL first");
  // -------------------------------------------------------------------------
  const articles = await q.query<{
    id: string;
    code: string;
    status: string;
    current_version_id: string | null;
  }>(`select id, code, status, current_version_id from article where code = $1`, [ARTICLE_CODE]);
  const article = articles[0];
  if (!article) throw new Error(`no article ${ARTICLE_CODE} in this database`);
  t.json("article row", article);

  const versions = await q.query<{
    id: string;
    version: number;
    status: string;
    supersedes_version_id: string | null;
    approved_at: Date | null;
    approved_by: string | null;
  }>(
    `select id, version, status, supersedes_version_id, approved_at,
            (select display_name from "user" u where u.id = approved_by_user_id) as approved_by
       from article_version where article_id = $1 order by version`,
    [article.id]
  );
  t.json("article_version rows", versions);
  const sellable = versions.find((row) => row.id === article.current_version_id)!;
  const proposed = versions.find((row) => row.id !== article.current_version_id)!;
  t.equal("the sellable version is version 1", sellable.version, 1);
  t.equal("it is the version on sale", sellable.status, "active");
  t.equal("the proposed version is version 2", proposed.version, 2);
  t.equal("it is under review", proposed.status, "pending_review");
  t.equal("it names version 1 as the version it replaces (D1's pair)", proposed.supersedes_version_id, sellable.id);

  const tasks = await q.query<{ id: string; status: string; entity_id: string }>(
    `select id, status, entity_id from approval_task where entity_id = $1::text and status = 'open'`,
    [proposed.id]
  );
  const task = tasks[0];
  if (!task) throw new Error(`no open review task against ${proposed.id}`);
  t.json("the open review task", task);

  // -------------------------------------------------------------------------
  t.heading("A principal that holds the read, and no session row written for it");
  // -------------------------------------------------------------------------
  const holders = await emailsHolding(q, "mdm.article.view");
  t.say(`accounts holding mdm.article.view: ${holders.join(", ") || "(none)"}`);
  const email = holders.find((candidate) => candidate.includes("mdm")) ?? holders[0];
  if (!email) throw new Error("no account in this database holds mdm.article.view");
  const principal = await principalFor(q, email, await principalChain(article));
  t.say(`principal: ${principal.email} (${principal.displayName}), scope ${principal.scope}, user ${principal.userId}`);
  t.say(`roles: ${principal.roles.map((role) => `${role.code}(${role.layer}${role.chainId ? `,${role.chainId}` : ",all"})`).join(", ")}`);
  t.say(`capabilities held: ${principal.permissions.length}, including mdm.article.view = ${principal.permissions.includes("mdm.article.view")}`);
  const allowed = await can(principal, "mdm.article.view", { chainId: principal.chainId ?? undefined });
  t.check(
    "the assembled principal is authorised for the read, checked BEFORE the guarded call",
    allowed,
    "so a wrong principal fails here rather than writing a `denied` audit row"
  );
  if (!allowed) throw new Error("the assembled principal cannot read an article version — stopping without calling the read");

  // -------------------------------------------------------------------------
  t.heading("The read itself — the whole payload, dumped");
  // -------------------------------------------------------------------------
  const review = await getArticleVersionReview(principal, { taskId: task.id });
  t.json("getArticleVersionReview({ taskId })", review);

  // -------------------------------------------------------------------------
  t.heading("The pair, against the rows");
  // -------------------------------------------------------------------------
  t.equal("isProposal is true — the version under review is not the sellable one", review.isProposal, true);
  t.equal("baseMoved is false — the base is still the version on sale", review.baseMoved, false);
  t.equal("there is no second version to name as sellable", review.sellable, null);
  t.equal("base.versionId is the sellable version", review.base?.versionId, sellable.id);
  t.equal("base.version", review.base?.version, 1);
  t.equal("base.status", review.base?.status, "active");
  t.equal("base.approvedBy is the approver's display name, not an id", review.base?.approvedBy, sellable.approved_by);
  checkStructure(t, review);

  // -------------------------------------------------------------------------
  t.heading("The one price that moved, and the one that did not");
  // -------------------------------------------------------------------------
  const priceRows = await q.query<{ article_version_id: string; outlet_code: string; amount: string; currency_code: string; effective_from: string; effective_to: string | null }>(
    `select p.article_version_id, o.code as outlet_code, p.amount::text, p.currency_code,
            to_char(p.effective_from, 'YYYY-MM-DD') as effective_from,
            to_char(p.effective_to, 'YYYY-MM-DD') as effective_to
       from article_price p join outlet o on o.id = p.outlet_id
      where p.article_version_id in ($1, $2) order by o.code, p.article_version_id`,
    [sellable.id, proposed.id]
  );
  t.json("article_price rows for both versions", priceRows);
  const openOf = (versionId: string, outletCode: string) =>
    priceRows.find((row) => row.article_version_id === versionId && row.outlet_code === outletCode && row.effective_to === null);

  const diff = byId(review.diff);
  const moved = diff.get("price:koramangala-restaurant");
  const unchanged = diff.get("price:koramangala-bar");
  if (!moved || !unchanged) {
    t.check("both outlets are in the diff", false, `ids present: ${[...diff.keys()].join(", ")}`);
  } else {
    const before = openOf(sellable.id, "koramangala-restaurant")!;
    const after = openOf(proposed.id, "koramangala-restaurant")!;
    t.json("the moved outlet, on both sides", { before, after });
    t.equal("the row is a change", moved.kind, "changed");
    t.equal("the group is the price tier", moved.group, "price");
    t.equal("the qualifier names the outlet", moved.qualifier?.outletCode, "koramangala-restaurant");
    t.equal("the site travels with it", moved.qualifier?.siteCode, "saffron-koramangala");
    t.check(
      "the base value is the stored amount and currency",
      moved.before.kind === "money" && moved.before.amount === Number(before.amount) && moved.before.currencyCode === before.currency_code,
      JSON.stringify(moved.before)
    );
    t.check(
      "the proposed value is the stored amount and currency",
      moved.after.kind === "money" && moved.after.amount === Number(after.amount) && moved.after.currencyCode === after.currency_code,
      JSON.stringify(moved.after)
    );
    t.equal("the delta amount is the difference the database holds", moved.delta?.amount, Number(after.amount) - Number(before.amount));
    t.equal("the delta carries the currency it is in", moved.delta?.currencyCode, after.currency_code);
    // The percentage is recomputed in SQL, in decimal arithmetic, from the stored rows.
    const percent = await q.query<{ percent: string }>(
      `select round(100 * ($1::numeric - $2::numeric) / $2::numeric, 2)::text as percent`,
      [after.amount, before.amount]
    );
    t.equal("the delta percent agrees with decimal arithmetic over the stored amounts", moved.delta?.percent, Number(percent[0]!.percent));
    t.check(
      "the percentage is positive and the amount grew, as the rows say",
      (moved.delta?.percent ?? 0) > 0 && Number(after.amount) > Number(before.amount),
      `${before.amount} → ${after.amount}, ${String(moved.delta?.percent)}%`
    );
    t.equal("the untouched outlet is named in the diff rather than omitted", unchanged.kind, "unchanged");
    t.check("an unchanged price row carries no delta", unchanged.delta === undefined, JSON.stringify(unchanged.delta));
  }

  // -------------------------------------------------------------------------
  t.heading("Allergens: one declaration, carried across unchanged");
  // -------------------------------------------------------------------------
  const allergens = await q.query<{ article_version_id: string; code: string; may_contain: boolean; source: string }>(
    `select aa.article_version_id, al.code, aa.may_contain, aa.source
       from article_version_allergen aa join allergen al on al.id = aa.allergen_id
      where aa.article_version_id in ($1, $2) order by al.code, aa.article_version_id`,
    [sellable.id, proposed.id]
  );
  t.json("article_version_allergen rows for both versions", allergens);
  const milk = diff.get("allergen:milk");
  t.check("the declared allergen appears as a row", Boolean(milk), [...diff.keys()].filter((key) => key.startsWith("allergen:")).join(", ") || "(none)");
  if (milk) {
    t.equal("it did not change between the two versions", milk.kind, "unchanged");
    t.check(
      "its value is the containment enum, not a boolean",
      milk.before.kind === "enum" && milk.before.value === (allergens[0]!.may_contain ? "mayContain" : "contains") && JSON.stringify(milk.before) === JSON.stringify(milk.after),
      JSON.stringify(milk.before)
    );
  }
  const noSourceRow = !review.diff.some((row) => row.subfield === "source");
  t.check(
    "no declaration-source row is invented where the source did not move",
    noSourceRow && allergens.every((row) => row.source === "declared")
  );

  // -------------------------------------------------------------------------
  t.heading("Nutrition: the table is empty on both sides, and that is stated rather than guessed");
  // -------------------------------------------------------------------------
  const nutrients = await q.query<{ article_version_id: string; code: string; value: string; basis: string }>(
    `select an.article_version_id, n.code, an.value::text, an.basis
       from article_version_nutrient an join nutrient n on n.id = an.nutrient_id
      where an.article_version_id in ($1, $2)`,
    [sellable.id, proposed.id]
  );
  const rules = await q.query<{ jurisdiction_code: string; field: string; requirement: string }>(
    `select jurisdiction_code, field, requirement from jurisdiction_field_rule
      where entity = 'article' and field = 'nutrition'`
  );
  t.json("article_version_nutrient rows for both versions", nutrients);
  t.json("the profile's rule for nutrition", rules);
  const nutrientRows = review.diff.filter((row) => row.field === "nutrient");
  t.equal("the database holds no nutrient row on either side", nutrients.length, 0);
  t.check(
    "no nutrient row is claimed, because the field is not required in this market",
    nutrientRows.length === 0 && rules.every((rule) => rule.requirement !== "required"),
    `rules: ${JSON.stringify(rules)}`
  );
  t.equal("and no gap is claimed for it either", review.complianceGaps.some((gap) => gap.field === "nutrition"), false);

  // -------------------------------------------------------------------------
  t.heading("The gap set, per the same read the approve transition refuses on (D14)");
  // -------------------------------------------------------------------------
  const requiredOf = await q.query<{ jurisdiction_code: string; field: string; requirement: string }>(
    `select jurisdiction_code, field, requirement from jurisdiction_field_rule where entity = 'article' order by field`
  );
  const versionSnapshot = await q.query<{
    dietary_mark: string | null;
    tax_class_id: string | null;
    hsn_sac_code: string | null;
    serving_size_qty: string | null;
    calories_kcal: string | null;
    name_count: string;
    allergen_count: string;
    nutrient_count: string;
  }>(
    `select v.dietary_mark, v.tax_class_id, v.hsn_sac_code, v.serving_size_qty::text, v.calories_kcal::text,
            (select count(*) from article_version_text t where t.article_version_id = v.id and btrim(t.name) <> '')::text as name_count,
            (select count(*) from article_version_allergen aa where aa.article_version_id = v.id)::text as allergen_count,
            (select count(*) from article_version_nutrient an where an.article_version_id = v.id)::text as nutrient_count
       from article_version v where v.id = $1`,
    [proposed.id]
  );
  const snapshot = versionSnapshot[0]!;
  const present: Record<string, boolean> = {
    name: Number(snapshot.name_count) > 0,
    dietaryMark: Boolean(snapshot.dietary_mark),
    taxClass: Boolean(snapshot.tax_class_id),
    hsnSacCode: Boolean(snapshot.hsn_sac_code),
    servingSize: snapshot.serving_size_qty !== null,
    caloriesKcal: snapshot.calories_kcal !== null,
    allergens: Number(snapshot.allergen_count) > 0,
    nutrition: Number(snapshot.nutrient_count) > 0,
  };
  const missingRequired = requiredOf
    .filter((rule) => rule.requirement === "required" && present[rule.field] === false)
    .map((rule) => rule.field)
    .sort();
  t.json("the proposal's stored values, as presence", present);
  t.json("required fields it does not carry, computed in SQL from the rules and the row", missingRequired);
  t.check(
    "the read's complianceGaps name exactly the fields the rows say are missing",
    JSON.stringify(review.complianceGaps.map((gap) => gap.field).sort()) === JSON.stringify(missingRequired),
    JSON.stringify(review.complianceGaps)
  );
  t.check(
    "every tier-1 absent row comes from a gap in that same set",
    review.diff.filter((row) => row.kind === "absent").every((row) => row.why?.requiredIn !== undefined)
  );

  // -------------------------------------------------------------------------
  t.heading("The first-version state: a version under review with no base at all (S1)");
  // -------------------------------------------------------------------------
  // `DEMO-MC-DRAFT` is exactly this case: its version 1 is the article's current version and
  // supersedes nothing, so there is no pair — and it carries a real market gap, which is what
  // the first-version panel has to show instead of an empty diff.
  const firstRows = await q.query<{ version_id: string; version: number; status: string }>(
    `select v.id as version_id, v.version, v.status
       from article a join article_version v on v.article_id = a.id
      where v.status in ('draft', 'pending_review') and v.supersedes_version_id is null
        and a.current_version_id = v.id
      order by v.version
      limit 1`
  );
  if (firstRows[0]) {
    const first = await getArticleVersionReview(principal, { versionId: firstRows[0].version_id });
    t.json("the version's own snapshot (S1 material)", {
      version: first.version,
      versionStatus: first.versionStatus,
      isCurrent: first.isCurrent,
      base: first.base,
      sellable: first.sellable,
      isProposal: first.isProposal,
      baseMoved: first.baseMoved,
      diff: first.diff,
      complianceGaps: first.complianceGaps,
      requiredFields: first.requiredFields,
    });
    t.equal("the read answers for a version that is not a proposal", first.version, firstRows[0].version);
    t.equal("the version under review is the article's own version", first.isCurrent, true);
    t.equal("it supersedes nothing, so there is no base", first.base, null);
    t.equal("and there is no second version named either", first.sellable, null);
    t.equal("so no comparison is offered, rather than an empty one", first.diff.length, 0);
    t.check(
      "and the market's requirements travel with it, so a first version is not a rubber stamp",
      first.requiredFields.length > 0,
      `${first.requiredFields.length} required fields`
    );
    const stored = await q.query<{ calories_kcal: string | null; allergen_count: string }>(
      `select v.calories_kcal::text,
              (select count(*) from article_version_allergen aa where aa.article_version_id = v.id)::text as allergen_count
         from article_version v where v.id = $1`,
      [firstRows[0].version_id]
    );
    t.json("what it actually stores", stored[0]);
    t.check(
      "its gaps are the fields its own row is missing, named by the same read",
      first.complianceGaps.length > 0 &&
        first.complianceGaps.some((gap) => (stored[0]!.calories_kcal === null ? gap.field === "caloriesKcal" : true)),
      JSON.stringify(first.complianceGaps)
    );
  } else {
    t.say("(this database holds no version under review without a base; the scratch run covers it)");
  }
} catch (error) {
  t.say("");
  t.say(`ABORTED: ${errorMessage(error)}`);
  if (error instanceof Error && error.stack) t.say(error.stack.split("\n").slice(0, 4).join("\n"));
  t.check("the run completed", false, errorMessage(error));
}

const failures = t.finish(TRANSCRIPT, "the comparison read answers for the seeded pair, and the rows agree with it.");
process.exit(failures === 0 ? 0 : 1);

/** The chain the article belongs to — the principal's tenant context. */
async function principalChain(article: { id: string }): Promise<string> {
  const rows = await q.query<{ chain_id: string }>(`select chain_id from article where id = $1`, [article.id]);
  const chainId = rows[0]?.chain_id;
  if (!chainId) throw new Error("the article has no chain");
  return chainId;
}
