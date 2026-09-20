/**
 * Permission matrix — what a fresh checkout actually does.
 *
 *   bun run scripts/permission-matrix.ts [baseUrl]
 *
 * Runs every seeded account against the app's own HTTP API (the same domain functions
 * the screens call) and prints the *observed* status code for each line. It exists
 * because a permission model that has only been reasoned about is not a permission
 * model: the point of the matrix is the difference between the code the design intends
 * and the code a clean `bun run db:reset` produces.
 *
 * Run it against a server whose database has just been reset:
 *
 *   bun run db:reset
 *   DATABASE_URL=... npx vite dev --port 4455 &
 *   bun run scripts/permission-matrix.ts http://127.0.0.1:4455
 *
 * Nothing here sets a permission, fakes a grant or reaches into the database: it logs in
 * as the seeded accounts and reports what comes back. Two of the lines are *expected* to
 * be refusals (a chain nobody was granted, and an AppSupport identity reading a chain's
 * configuration) — a matrix of nothing but 200s would mean the checks are not there.
 *
 * NOTE: the two PATCH lines write real rows (one chain setting, one auth config) into
 * whatever database the server is pointed at. They are chosen to be idempotent and
 * harmless, and they end up in the audit trail like any other legitimate write.
 */
import { DEMO_ACCOUNTS } from "../src/domain/demo-data";

const base = (process.argv[2] ?? "http://127.0.0.1:4455").replace(/\/$/, "");

interface Result {
  status: number;
  body: unknown;
}

async function login(email: string, password: string): Promise<string> {
  const response = await fetch(`${base}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (response.status !== 201) {
    throw new Error(`login as ${email} failed with ${String(response.status)}`);
  }
  const cookie = response.headers.get("set-cookie");
  if (!cookie) throw new Error(`login as ${email} returned no session cookie`);
  return cookie.split(";")[0] ?? "";
}

async function call(method: string, path: string, cookie: string, body?: unknown): Promise<Result> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      cookie,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let parsed: unknown = null;
  const text = await response.text();
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text.slice(0, 120);
  }
  return { status: response.status, body: parsed };
}

/** The refusal reason the server recorded, if this was a 403. */
function reason(result: Result): string {
  const body = result.body as { error?: string; message?: string } | null;
  if (!body || typeof body !== "object") return "";
  if (result.status !== 403) return typeof body.message === "string" ? body.message.slice(0, 48) : "";
  return `${body.error ?? "denied"}: ${(body.message ?? "").slice(0, 60)}`;
}

async function main(): Promise<void> {
  const admin = DEMO_ACCOUNTS.find((account) => account.email === "admin@omnihost.ai");
  if (!admin) throw new Error("demo data no longer names admin@omnihost.ai");
  const adminCookie = await login(admin.email, admin.password);
  const listed = await call("GET", "/api/chains", adminCookie);
  const chains = (listed.body as { chains?: { id: string; code: string }[] }).chains ?? [];
  const saffron = chains.find((chain) => chain.code === "saffron-table");
  const coastal = chains.find((chain) => chain.code === "coastal-catch");
  if (!saffron || !coastal) throw new Error(`expected both seeded chains, got ${JSON.stringify(chains)}`);

  const lines: {
    who: string;
    what: string;
    method: string;
    path: string;
    body?: unknown;
  }[] = [
    { who: "saffron", what: "chain settings read", method: "GET", path: `/api/chains/${saffron.id}/settings` },
    {
      who: "saffron",
      what: "chain setting write (chain-scoped)",
      method: "PATCH",
      path: `/api/chains/${saffron.id}/settings`,
      body: { key: "notifications.sla_escalation", value: "one_level" },
    },
    { who: "saffron", what: "auth config read", method: "GET", path: `/api/chains/${saffron.id}/auth` },
    {
      who: "saffron",
      what: "auth config write (native)",
      method: "PATCH",
      path: `/api/chains/${saffron.id}/auth`,
      body: { authMode: "native" },
    },
    { who: "coastal", what: "chain settings read", method: "GET", path: `/api/chains/${coastal.id}/settings` },
    { who: "coastal", what: "auth config read", method: "GET", path: `/api/chains/${coastal.id}/auth` },
  ];

  console.log(`matrix against ${base} — observed status codes\n`);
  for (const account of DEMO_ACCOUNTS) {
    const cookie = await login(account.email, account.password);
    const list = await call("GET", "/api/chains", cookie);
    const listCodes = ((list.body as { chains?: { code: string }[] }).chains ?? [])
      .map((chain) => chain.code)
      .join(",");
    console.log(`\n${account.email}  (${account.assignments.map((a) => a.roleCode).join(", ")})`);
    console.log(
      `  ${pad("GET /api/chains")} ${String(list.status)}  reachable: ${listCodes || "none"}`
    );
    for (const [name, id] of [
      ["saffron", saffron.id],
      ["coastal", coastal.id],
    ] as const) {
      const detail = await call("GET", `/api/chains/${id}`, cookie);
      console.log(`  ${pad(`GET /api/chains/:${name}`)} ${String(detail.status)}  ${reason(detail)}`);
    }
    for (const line of lines) {
      const path = line.path;
      const result = await call(line.method, path, cookie, line.body);
      console.log(
        `  ${pad(`${line.method} ${path.replace(saffron.id, ":saffron").replace(coastal.id, ":coastal")}`)} ${String(result.status)}  ${reason(result)}`
      );
    }
  }
  console.log("");
}

function pad(value: string): string {
  return value.length >= 52 ? value : value + " ".repeat(52 - value.length);
}

await main();
