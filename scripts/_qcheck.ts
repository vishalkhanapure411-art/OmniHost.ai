/**
 * SCRATCH helper (deleted before the branch is pushed): run one SQL statement against the
 * scratch database `omnihost_check`, derived from DATABASE_URL, so evidence can be read back
 * without psql (which the machine replacement removed).
 *
 *   bun scripts/_qcheck.ts "select 1"
 *
 * Refuses to run against the owner's demo database.
 */
import pg from "pg";

const OWNER = "OmniHost";
const CHECK = "omnihost_check";
const raw = process.env.DATABASE_URL?.trim() ?? "";
const ownerReadOnly = process.env.QDB === "owner";
const url = ownerReadOnly ? raw : raw.replace(new RegExp(`/${OWNER}(\\?|$)`), `/${CHECK}$1`);
if (!ownerReadOnly && !url.includes(`/${CHECK}?`) && !url.endsWith(`/${CHECK}`)) {
  console.error("refusing: DATABASE_URL does not point at the owner's database, so the scratch database cannot be derived.");
  process.exit(2);
}
const sql = process.argv.slice(2).join(" ");
if (!sql) {
  console.error("usage: bun scripts/_qcheck.ts \"<sql>\"");
  process.exit(2);
}
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  if (ownerReadOnly && !/^\s*select\b/i.test(sql)) {
    throw new Error("QDB=owner is read-only: only select statements are allowed against the demo database.");
  }
  const result = await client.query(sql);
  if (Array.isArray(result)) {
    console.log(JSON.stringify(result.map((r) => r.rows), null, 1));
  } else {
    console.log(JSON.stringify({ rowCount: result.rowCount, rows: result.rows }, null, 1));
  }
} catch (error) {
  console.error("SQL ERROR:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await client.end();
}
