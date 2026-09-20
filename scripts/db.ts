/**
 * Database CLI — migrations and seed.
 *
 *   bun run db:migrate   apply any pending db/migrations/*.sql
 *   bun run db:seed      re-runnable reference + demo data
 *   bun run db:reset     drop the schema, then migrate and seed from scratch
 *
 * Every statement runs against `process.env.DATABASE_URL` (falling back to the local
 * PostgreSQL used to develop this phase when it is absent — see src/db.ts), so the
 * same commands work against the managed database.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEV_FALLBACK, exec, getPool, sql, withTransaction, type Queryable } from "../src/db";
import { hashPassword } from "../src/server/crypto";
import { DEMO_ACCOUNTS, DEMO_CHAINS, DEMO_SITES, DEMO_SUPPORT_TICKETS } from "../src/domain/demo-data";
import { seedMdm } from "../src/domain/mdm-seed";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(root, "db", "migrations");

const LEDGER = `create table if not exists schema_migration (
  filename   text primary key,
  checksum   text not null,
  applied_at timestamptz not null default now()
)`;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function runSqlFile(tx: Queryable, file: string): Promise<void> {
  const text = await readFile(file, "utf8");
  // One round trip per file, so a migration that fails part-way rolls back whole.
  await tx.query(text);
}

export async function migrate(): Promise<void> {
  await withTransaction((tx) => tx.query(LEDGER));
  const applied = new Map(
    (
      await sql()<{ filename: string; checksum: string }>`select filename, checksum from schema_migration`
    ).map((row) => [row.filename, row.checksum])
  );

  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
  let count = 0;
  for (const name of files) {
    const file = path.join(migrationsDir, name);
    const body = await readFile(file, "utf8");
    const checksum = sha256(body);
    const previous = applied.get(name);
    if (previous) {
      if (previous !== checksum) {
        throw new Error(
          `${name} has changed since it was applied. Add a new migration instead of editing an applied one.`
        );
      }
      continue;
    }
    await withTransaction(async (tx) => {
      await runSqlFile(tx, file);
      await tx.query(`insert into schema_migration (filename, checksum) values ($1, $2)`, [
        name,
        checksum,
      ]);
    });
    console.log(`  applied ${name}`);
    count += 1;
  }
  console.log(count === 0 ? "migrations: already up to date" : `migrations: ${String(count)} applied`);
}

export async function seed(): Promise<void> {
  await withTransaction((tx) => runSqlFile(tx, path.join(root, "db", "seed.sql")));
  console.log("seed: reference data (roles, tool registry, features) upserted");
  await withTransaction(async (tx) => {
    await seedTenantData(tx);
    await seedUsersAndScopes(tx);
    await seedSupportTickets(tx);
  });
  console.log("seed: demo tenant, users and support queue upserted");
  // Phase 1 master data. It runs after the tenant and users because it resolves the
  // chain, the sites and the outlets the Phase 0 seed creates, and because the loader is
  // the path a chain's real extract comes through — same order, same upsert-on-code
  // behaviour, so replacing this dataset is a data change and not a code change.
  await withTransaction((tx) => seedMdm(tx));
  console.log(
    "seed: master data (jurisdictions, tax classes, UOMs, allergens, vendors, raw materials, articles)"
  );
}

async function upsertUserId(
  tx: Queryable,
  account: { email: string; displayName: string; password: string; locale: string | null }
): Promise<string> {
  const digest = hashPassword(account.password);
  const existing = await tx.query<{ id: string }>(
    `select id from "user" where lower(email) = lower($1)`,
    [account.email]
  );
  if (existing[0]) {
    // Re-seeding refreshes the demo password so the credentials shown on the sign-in
    // screen always work.
    await tx.query(
      `update "user"
          set display_name = $2, auth_provider = 'native', status = 'active',
              password_hash = $3, password_salt = $4, password_algo = $5,
              locale = $6, updated_at = now()
        where id = $1`,
      [
        existing[0].id,
        account.displayName,
        digest.hash,
        digest.salt,
        digest.algo,
        account.locale,
      ]
    );
    return existing[0].id;
  }
  const inserted = await tx.query<{ id: string }>(
    `insert into "user" (email, display_name, auth_provider, password_hash, password_salt, password_algo, locale)
     values ($1, $2, 'native', $3, $4, $5, $6)
     returning id`,
    [
      account.email,
      account.displayName,
      digest.hash,
      digest.salt,
      digest.algo,
      account.locale,
    ]
  );
  const id = inserted[0]?.id;
  if (!id) throw new Error(`could not create user ${account.email}`);
  return id;
}

async function seedTenantData(tx: Queryable): Promise<void> {
  for (const chain of DEMO_CHAINS) {
    const rows = await tx.query<{ id: string }>(
      `insert into chain (name, code, licence_tier, tax_jurisdiction)
       values ($1, $2, $3, $4)
       on conflict (code) do update
         set name = excluded.name,
             licence_tier = excluded.licence_tier,
             tax_jurisdiction = excluded.tax_jurisdiction,
             updated_at = now()
       returning id`,
      [chain.name, chain.code, chain.licenceTier, chain.taxJurisdiction]
    );
    const chainId = rows[0]?.id;
    if (!chainId) throw new Error(`could not seed chain ${chain.code}`);

    // Registry defaults first, so a newly added feature appears on every chain.
    await tx.query(
      `insert into chain_feature (chain_id, feature_code, enabled)
       select $1, f.code, not f.toggleable
         from feature f
       on conflict (chain_id, feature_code) do nothing`,
      [chainId]
    );
    for (const [code, enabled] of Object.entries(chain.features)) {
      await tx.query(
        `update chain_feature set enabled = $3, updated_at = now()
          where chain_id = $1 and feature_code = $2`,
        [chainId, code, enabled]
      );
    }

    for (const site of DEMO_SITES.filter((s) => s.chainCode === chain.code)) {
      const siteRows = await tx.query<{ id: string }>(
        `insert into site (chain_id, name, code, timezone, tax_jurisdiction, locale)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (chain_id, code) do update
           set name = excluded.name, timezone = excluded.timezone,
               locale = excluded.locale, updated_at = now()
         returning id`,
        [chainId, site.name, site.code, site.timezone, site.taxJurisdiction, site.locale]
      );
      const siteId = siteRows[0]?.id;
      if (!siteId) throw new Error(`could not seed site ${site.code}`);
      for (const outlet of site.outlets) {
        await tx.query(
          `insert into outlet (chain_id, site_id, name, code, kind)
           values ($1, $2, $3, $4, $5)
           on conflict (site_id, code) do update
             set name = excluded.name, kind = excluded.kind, updated_at = now()`,
          [chainId, siteId, outlet.name, outlet.code, outlet.kind]
        );
      }
    }
  }
  console.log(`seed: ${String(DEMO_CHAINS.length)} chains, ${String(DEMO_SITES.length)} sites`);
}

async function seedUsersAndScopes(tx: Queryable): Promise<void> {
  const roleRows = await tx.query<{ id: string; code: string }>(`select id, code from role`);
  const roleId = new Map(roleRows.map((row) => [row.code, row.id]));
  const chainRows = await tx.query<{ id: string; code: string }>(`select id, code from chain`);
  const chainId = new Map(chainRows.map((row) => [row.code, row.id]));
  const siteRows = await tx.query<{ id: string; code: string }>(`select id, code from site`);
  const siteId = new Map(siteRows.map((row) => [row.code, row.id]));

  const permissionRows = await tx.query<{ id: string; code: string }>(`select id, code from permission`);
  const permissionId = new Map(permissionRows.map((row) => [row.code, row.id]));

  const userId = new Map<string, string>();
  for (const account of DEMO_ACCOUNTS) {
    userId.set(account.email, await upsertUserId(tx, account));
  }

  // AppAdmin acts as the grantor of record for the seeded delegations.
  const adminId = userId.get("admin@omnihost.ai");
  if (!adminId) throw new Error("seed requires admin@omnihost.ai");

  for (const account of DEMO_ACCOUNTS) {
    const uid = userId.get(account.email);
    if (!uid) continue;
    for (const assignment of account.assignments) {
      const rid = roleId.get(assignment.roleCode);
      if (!rid) throw new Error(`seed references unknown role ${assignment.roleCode}`);
      const cid = assignment.chainCode ? (chainId.get(assignment.chainCode) ?? null) : null;
      const sid = assignment.siteCode ? (siteId.get(assignment.siteCode) ?? null) : null;
      if (assignment.chainCode && !cid) throw new Error(`unknown chain ${assignment.chainCode}`);
      if (assignment.siteCode && !sid) throw new Error(`unknown site ${assignment.siteCode}`);
      const scopeKey = [uid, rid, cid ?? "-", sid ?? "-"].join("|");
      await tx.query(
        `insert into role_assignment (user_id, role_id, chain_id, site_id, status, granted_by_user_id, scope_key)
         values ($1, $2, $3, $4, 'active', $5, $6)
         on conflict (scope_key) do update
           set status = 'active', revoked_at = null, revoked_by_user_id = null,
               revoke_reason = null, updated_at = now()`,
        [uid, rid, cid, sid, adminId, scopeKey]
      );
    }

    for (const grant of account.grants) {
      const cid = grant.chainCode ? (chainId.get(grant.chainCode) ?? null) : null;
      if (grant.chainCode && !cid) throw new Error(`unknown chain ${grant.chainCode}`);
      const scopeKey = ["grant", uid, cid ?? "-", "-"].join("|");
      const rows = await tx.query<{ id: string }>(
        `insert into scope_grant (granted_to_user_id, granted_by_user_id, chain_id, reason, status, expires_at, scope_key)
         values ($1, $2, $3, $4, 'active', now() + ($5 || ' days')::interval, $6)
         on conflict (scope_key) do update
           set reason = excluded.reason, status = 'active',
               expires_at = excluded.expires_at, revoked_at = null, updated_at = now()
         returning id`,
        [uid, adminId, cid, grant.reason, String(grant.expiresInDays), scopeKey]
      );
      const grantId = rows[0]?.id;
      if (!grantId) throw new Error(`could not seed scope grant for ${account.email}`);
      await tx.query(`delete from scope_grant_permission where scope_grant_id = $1`, [grantId]);
      for (const code of grant.permissions) {
        const pid = permissionId.get(code);
        if (!pid) throw new Error(`seed grants unknown permission ${code}`);
        await tx.query(
          `insert into scope_grant_permission (scope_grant_id, permission_id)
           values ($1, $2) on conflict do nothing`,
          [grantId, pid]
        );
      }
    }
  }
  console.log(`seed: ${String(DEMO_ACCOUNTS.length)} demo users with assignments and delegations`);
}

async function seedSupportTickets(tx: Queryable): Promise<void> {
  const chainRows = await tx.query<{ id: string; code: string }>(`select id, code from chain`);
  const chainId = new Map(chainRows.map((row) => [row.code, row.id]));
  const siteRows = await tx.query<{ id: string; code: string }>(`select id, code from site`);
  const siteId = new Map(siteRows.map((row) => [row.code, row.id]));
  const userRows = await tx.query<{ id: string; email: string }>(`select id, email from "user"`);
  const userId = new Map(userRows.map((row) => [row.email, row.id]));

  for (const ticket of DEMO_SUPPORT_TICKETS) {
    const cid = ticket.chainCode ? (chainId.get(ticket.chainCode) ?? null) : null;
    if (ticket.chainCode && !cid) throw new Error(`unknown chain ${ticket.chainCode}`);
    const sid = ticket.siteCode ? (siteId.get(ticket.siteCode) ?? null) : null;
    if (ticket.siteCode && !sid) throw new Error(`unknown site ${ticket.siteCode}`);
    const assignee = ticket.assignedToEmail
      ? (userId.get(ticket.assignedToEmail) ?? null)
      : null;
    // The SLA clocks are relative to the seed run, so re-seeding always leaves a live
    // queue with one breach in it rather than a queue of stale timestamps.
    await tx.query(
      `insert into support_ticket (
         reference, chain_id, site_id, category, severity, source, subject, detail, status,
         raised_by_label, assigned_user_id, assigned_at, response_due_at, resolve_due_at, payload
       ) values (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
         case when $11::uuid is null then null else now() end,
         now() + ($12 || ' hours')::interval,
         now() + ($13 || ' hours')::interval,
         '{}'::jsonb
       )
       on conflict (reference) do update
         set chain_id = excluded.chain_id, site_id = excluded.site_id,
             category = excluded.category, severity = excluded.severity,
             source = excluded.source, subject = excluded.subject, detail = excluded.detail,
             status = excluded.status, raised_by_label = excluded.raised_by_label,
             assigned_user_id = excluded.assigned_user_id, assigned_at = excluded.assigned_at,
             response_due_at = excluded.response_due_at,
             resolve_due_at = excluded.resolve_due_at, updated_at = now()`,
      [
        ticket.reference,
        cid,
        sid,
        ticket.category,
        ticket.severity,
        ticket.source,
        ticket.subject,
        ticket.detail,
        ticket.status,
        ticket.raisedByLabel,
        assignee,
        String(ticket.responseDueInHours),
        String(ticket.resolveDueInHours),
      ]
    );
  }
  console.log(`seed: ${String(DEMO_SUPPORT_TICKETS.length)} support tickets`);
}

/** A role name we are willing to interpolate into DDL (GRANT has no parameters). */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A SQL string literal for DDL we cannot parameterise (CREATE ROLE … PASSWORD …). */
function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Recreates `public`, tolerating the case where the role running the reset does not own
 * it — which is what happens when an earlier reset ran under a different role, because a
 * schema belongs to whoever created it.
 */
async function dropPublicSchema(): Promise<void> {
  const attempts = [
    `drop schema public cascade`,
    // Hand ownership to the dev fallback role and retry: the reset may legitimately be
    // running as a different role (DATABASE_URL set), and PostgreSQL allows this when the
    // current role can SET ROLE to that role.
    `alter schema public owner to ${DEV_FALLBACK.role}`,
    `drop schema public cascade`,
    // A superuser can always take the schema for itself.
    `alter schema public owner to current_user`,
    `drop schema public cascade`,
  ];
  let failure: unknown;
  for (const statement of attempts) {
    try {
      await exec(statement);
      return;
    } catch (error) {
      failure = error;
    }
  }
  const state = await sql()<{ owner: string; me: string; database: string }>`
    select pg_get_userbyid(nspowner) as owner, current_user as me, current_database() as database
      from pg_namespace where nspname = 'public'
  `;
  throw new Error(
    `reset: schema public is owned by "${state[0]?.owner ?? "?"}" and cannot be dropped by ` +
      `"${state[0]?.me ?? "?"}" (${String(failure)}). Fix it once, as a superuser, then re-run:\n` +
      `  psql -U postgres -d ${state[0]?.database ?? DEV_FALLBACK.database} ` +
      `-c "alter schema public owner to ${DEV_FALLBACK.role}"`
  );
}

/**
 * Hands the dev fallback role (src/db.ts DEV_FALLBACK) the privileges it needs on the
 * schema the reset just recreated, and — best effort — makes that role the schema's owner
 * so the next reset can drop it from either role.
 *
 * A dropped schema loses its ACL along with its contents, so without this step a reset
 * leaves the documented dev setup — no DATABASE_URL, so the app connects as the fallback
 * role — unable to see a single table (`relation "user" does not exist`, pg 42P01).
 * Granting here, rather than exporting DATABASE_URL by hand, means the reset and the app
 * always agree on the identity, whichever role ran the reset.
 */
async function grantDevFallbackRole(): Promise<void> {
  const { role } = DEV_FALLBACK;
  if (!IDENTIFIER.test(role)) {
    console.warn(`reset: WARNING — refusing to grant to non-identifier role "${role}"`);
    return;
  }
  const known = await sql()<{ present: boolean }>`
    select exists (select 1 from pg_roles where rolname = ${role}) as present
  `;
  if (!known[0]?.present) {
    // Only a role with CREATEROLE (or a superuser) can create it; say what to run rather
    // than failing the whole reset over a role that may not even be the one in use.
    try {
      await exec(`create role ${role} login password ${literal(DEV_FALLBACK.password)}`);
    } catch {
      console.warn(
        `reset: WARNING — role "${role}" does not exist and this role cannot create it.\n` +
          `  As a superuser: psql -U postgres -c "create role ${role} login password '<pw>'" ` +
          `(keep DEV_FALLBACK in src/db.ts in step), then re-run the reset.`
      );
      return;
    }
  }
  const statements = [
    `grant usage, create on schema public to ${role}`,
    `grant select, insert, update, delete on all tables in schema public to ${role}`,
    `grant usage, select on all sequences in schema public to ${role}`,
    `grant execute on all functions in schema public to ${role}`,
    // Objects a later `db:migrate` creates while this role is connected must be usable by
    // the dev role too, without another reset.
    `alter default privileges in schema public grant select, insert, update, delete on tables to ${role}`,
    `alter default privileges in schema public grant usage, select on sequences to ${role}`,
  ];
  for (const statement of statements) {
    try {
      await exec(statement);
    } catch (error) {
      console.warn(
        `reset: WARNING — "${statement}" failed (${String(error)}). The dev fallback role may ` +
          `not be able to use this schema.`
      );
    }
  }
  try {
    await exec(`alter schema public owner to ${role}`);
  } catch {
    // Not possible on a database where this role is a plain client of a managed instance.
    // The grants above are what actually matter there.
  }
  const verdict = await sql()<{ usage: boolean; rows: boolean }>`
    select
      has_schema_privilege(to_regrole(${role})::oid, 'public', 'usage') as usage,
      has_table_privilege(to_regrole(${role})::oid, 'public."user"', 'select') as rows
  `;
  const usable = verdict[0]?.usage === true && verdict[0]?.rows === true;
  console.log(
    `reset: dev role "${role}" — schema usage=${String(verdict[0]?.usage)}, ` +
      `select on "user"=${String(verdict[0]?.rows)}`
  );
  if (!usable) {
    console.warn(
      `reset: WARNING — the documented no-DATABASE_URL dev setup is NOT usable: grant "${role}" ` +
        `privileges on schema public as a superuser and re-run.`
    );
  }
}

async function reset(): Promise<void> {
  await dropPublicSchema();
  await sql()`create schema public`;
  console.log("reset: schema dropped");
  await migrate();
  await seed();
  await grantDevFallbackRole();
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "migrate";
  try {
    if (command === "migrate") await migrate();
    else if (command === "seed") await seed();
    else if (command === "reset") await reset();
    else throw new Error(`unknown command "${command}" (expected migrate | seed | reset)`);
  } finally {
    await getPool().end();
  }
}

await main();
