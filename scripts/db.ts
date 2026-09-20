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

import { getPool, sql, withTransaction, type Queryable } from "../src/db";
import { hashPassword } from "../src/server/crypto";
import { DEMO_ACCOUNTS, DEMO_CHAINS, DEMO_SITES } from "../src/domain/demo-data";

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
  });
  console.log("seed: demo tenant and users upserted");
}

async function upsertUserId(
  tx: Queryable,
  account: { email: string; displayName: string; password: string; locale: string }
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
        `insert into site (chain_id, name, code, timezone, tax_jurisdiction)
         values ($1, $2, $3, $4, $5)
         on conflict (chain_id, code) do update
           set name = excluded.name, timezone = excluded.timezone, updated_at = now()
         returning id`,
        [chainId, site.name, site.code, site.timezone, site.taxJurisdiction]
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

async function reset(): Promise<void> {
  await sql()`drop schema public cascade`;
  await sql()`create schema public`;
  console.log("reset: schema dropped");
  await migrate();
  await seed();
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
