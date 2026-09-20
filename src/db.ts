import { Pool, type PoolClient, type QueryResultRow } from "pg";

/**
 * Server-only handle to the team's database (PostgreSQL).
 *
 * The connection string comes from `DATABASE_URL`, which the owner connects via the
 * database card and which is injected into the sandbox and passed to the live host.
 * Resolved lazily (per call, not at module load) so the site still builds and serves
 * before a database is connected.
 *
 * Use it only inside a `createServerFn()` handler or an `src/routes/api/*` route
 * (never client code):
 *
 *   import { sql } from "~/db";
 *   const rows = await sql()`select id, title, created_at from posts`;
 *   // Coerce non-primitive columns (timestamps are JS Dates) to strings before
 *   // returning to the client, or React will refuse to render them:
 *   return rows.map((r) => ({ ...r, created_at: String(r.created_at) }));
 *
 * Phase 0a changed the driver from the Neon HTTP client to a pooled TCP client
 * (`pg`), because the audit requirement makes a mutation and its audit row one
 * atomic unit and Neon-over-HTTP cannot hold a transaction open across statements.
 * A Neon connection string works unchanged over TCP, so the same code runs against
 * the managed database and against a local PostgreSQL.
 */

/**
 * The identity local development connects as when DATABASE_URL is absent — see
 * resolveDatabaseUrl(). It is exported as a structure, not just a URL, because
 * `scripts/db.ts` has to hand this same role the privileges on the schema it recreates:
 * there is exactly one definition of "the dev fallback role" and both the app and the
 * reset script read it from here.
 */
export const DEV_FALLBACK = {
  role: "omnihost",
  password: "omnihost",
  host: "127.0.0.1",
  port: 5432,
  database: "omnihost",
} as const;

/** Seed/demo URL for local development only — see resolveDatabaseUrl(). */
const DEV_FALLBACK_URL = `postgres://${DEV_FALLBACK.role}:${DEV_FALLBACK.password}@${DEV_FALLBACK.host}:${String(DEV_FALLBACK.port)}/${DEV_FALLBACK.database}`;

export class DatabaseNotConfigured extends Error {
  constructor() {
    super(
      "DATABASE_URL is not set — connect a database (via the database card) before running queries."
    );
    this.name = "DatabaseNotConfigured";
  }
}

/**
 * The database to talk to. `DATABASE_URL` always wins. Only when it is absent *and*
 * we are not running a production build do we fall back to the local PostgreSQL used
 * to develop and verify this phase — so the sandbox dev server can exercise the real
 * schema before a managed database is attached. A production build without
 * DATABASE_URL fails loudly rather than quietly talking to localhost.
 */
export function resolveDatabaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (url) return url;
  if (process.env.NODE_ENV === "production") throw new DatabaseNotConfigured();
  return DEV_FALLBACK_URL;
}

export function databaseIsConfigured(): boolean {
  try {
    resolveDatabaseUrl();
    return true;
  } catch {
    return false;
  }
}

function sslFor(url: string): false | { rejectUnauthorized: boolean } {
  // Local sockets/loopback need no TLS; a managed host may present a certificate
  // chain we are not carrying a CA for.
  const isLoopback = /(@|\/\/)(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url);
  return isLoopback ? false : { rejectUnauthorized: false };
}

let pool: Pool | undefined;
let poolUrl: string | undefined;

export function getPool(): Pool {
  const url = resolveDatabaseUrl();
  if (!pool || poolUrl !== url) {
    void pool?.end().catch(() => undefined);
    pool = new Pool({
      connectionString: url,
      ssl: sslFor(url),
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    poolUrl = url;
  }
  return pool;
}

/**
 * Runs one statement with no bind parameters. For dev tooling only: DDL such as GRANT and
 * CREATE ROLE cannot be parameterised, so the caller is responsible for the text.
 */
export async function exec(text: string): Promise<void> {
  await getPool().query(text);
}

export type Row = QueryResultRow;

/** Minimal query surface shared by the pool and a transaction client. */
export interface Queryable {
  query<R extends Row = Row>(text: string, values?: unknown[]): Promise<R[]>;
}

function queryableFrom(client: Pool | PoolClient): Queryable {
  return {
    async query<R extends Row = Row>(text: string, values?: unknown[]): Promise<R[]> {
      const result = await client.query<R>(text, values as never);
      return result.rows;
    },
  };
}

export function poolQueryable(): Queryable {
  return queryableFrom(getPool());
}
export type SqlTag = <R extends Row = Row>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<R[]>;

/**
 * Tagged-template query helper. Interpolated values become bind parameters ($1, $2…)
 * — never string-concatenated SQL — which is what keeps every tenant-scoped query
 * injection-safe.
 */
export function sql(): SqlTag {
  const q = queryableFrom(getPool());
  return async <R extends Row = Row>(strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce(
      (acc, chunk, i) => acc + chunk + (i < values.length ? `$${String(i + 1)}` : ""),
      ""
    );
    return q.query<R>(text, values);
  };
}

/**
 * Runs `fn` inside a single database transaction and commits, or rolls back on any
 * throw. Every mutating domain call goes through this so the write and the
 * audit_log row describing it either both land or neither does.
 */
export async function withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const result = await fn(queryableFrom(client));
    await client.query("commit");
    return result;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // The connection is already broken; the pool will discard it.
    }
    throw error;
  } finally {
    client.release();
  }
}
