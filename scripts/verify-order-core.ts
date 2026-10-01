/**
 * S-B/1 read-back: the order-side capabilities, who holds them, and the tables the slice
 * writes to.
 *
 * Read-only against `DATABASE_URL`. It exists because "the capability is declared" and "the
 * role holds it" are two different claims and only the second one decides whether a booking
 * can be taken — `guard()` resolves the caller's role registry, so a permission row with no
 * `role_permission` row fails closed and the screen says nothing about why.
 *
 *   bun run scripts/verify-order-core.ts        (from the site directory)
 *
 * Prints the permission rows for every `order.` code, the grants beside each, and the
 * row counts of `order`/`outlet_order`/`order_line`. The S-B/1 acceptance criterion is the
 * grant lines, not the permission lines: `db/seed.sql` section 8 declares the codes and
 * grants them in one statement, so a code that exists with no grant means the seed ran and
 * that half of it did not.
 */
import { writeFileSync } from "node:fs";

import { poolQueryable } from "~/db";

const q = poolQueryable();
const out: string[] = [];

async function block(label: string, sql: string): Promise<void> {
  out.push(`=== ${label} ===`);
  try {
    const rows = await q.query<{ line: string }>(sql);
    if (rows.length === 0) out.push("(no rows)");
    for (const row of rows) out.push(row.line);
  } catch (error) {
    out.push(`ERROR ${(error as Error).message}`);
  }
  out.push("");
}

async function main(): Promise<void> {
  await block(
    "order capabilities declared (permission)",
    `select p.code || ' | ' || p.module || ' | kind=' || p.action_kind || ' | layer=' || p.layer
            || ' | siteScope=' || p.requires_site_scope || ' | financial_or_stock=' || p.financial_or_stock
            || ' | implemented_in=' || coalesce(p.implemented_in, '-') as line
       from permission p
      where p.code like 'order.%'
      order by p.code`
  );
  await block(
    "who holds each order capability (role_permission)",
    `select p.code || ' -> ' || r.code
            || ' (' || r.layer || ')' as line
       from role_permission rp
       join permission p on p.id = rp.permission_id
       join role r on r.id = rp.role_id
      where p.code like 'order.%'
      order by p.code, r.code`
  );
  await block(
    "order capability with no holder (the fail-closed case)",
    `select p.code || ' | no role holds it' as line
       from permission p
      where p.code like 'order.%'
        and not exists (select 1 from role_permission rp where rp.permission_id = p.id)
      order by p.code`
  );
  await block(
    "the code the spec leaves unregistered (order.close)",
    `select case when count(*) = 1 then 'order.close is declared when db/seed.sql section 8 has been applied'
                 else 'order.close is MISSING - the seed section has not been applied' end as line
       from permission where code = 'order.close'`
  );
  await block(
    "S-B/1 tables exist and are empty",
    `select 'order=' || (select count(*) from "order")
            || ' outlet_order=' || (select count(*) from outlet_order)
            || ' order_line=' || (select count(*) from order_line) as line`
  );
  await block(
    "migration ledger",
    `select filename || ' | applied_at=' || applied_at::text as line
       from schema_migration where filename like '001%.sql' order by filename`
  );

  writeFileSync("/tmp/order-core-readback.txt", out.join("\n"));
  process.stdout.write(out.join("\n"));
  process.exit(0);
}

main().catch((error) => {
  writeFileSync("/tmp/order-core-readback.txt", `${out.join("\n")}\nFATAL ${String(error)}`);
  process.exit(1);
});
