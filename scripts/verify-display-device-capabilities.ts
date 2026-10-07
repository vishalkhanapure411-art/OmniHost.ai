/**
 * Display S-B/2c, part 1 — the device capability set and the two serve refusals, asserted by
 * **naming the sets** (set equality with `missing:` / `unexpected:`), never by counting a list
 * a later slice keeps growing. That exact defect cost a session on the S-A verifier
 * (`order.fire` and `order.close` broke a check on a correct product; WORKFLOW.md, "the
 * evidence standard").
 *
 *   bun run scripts/verify-display-device-capabilities.ts
 *
 * **What it does and does not prove.** It proves the pure half of the S-B/2c ruling: the
 * capability set per display kind, the pass's serve grant keyed on the *section kind*, and the
 * refusals `assertDeviceMayActOn` raises — each refusal proven by **calling the act** and
 * asserting the thrown error *is* that refusal (its capability, its catalogue key, its device),
 * never by quoting an older run's `denied` row.
 *
 * It writes nothing and touches no database: it needs none, because every case is a function of
 * the kind, the section kind and the target's scope. The ledger half — one `denied` row per
 * capability refusal, counted before and after, and the licence/module refusals from
 * `registerDisplay`/`pairDisplay`/`fireOutletOrder` on a chain where the gate is closed — is the
 * **next** piece of this slice and is NOT covered here (see the HONEST LIMITS at the end).
 */
import { displayCapabilities, EXPEDITE_SECTION_KIND, type DevicePrincipal } from "~/domain/display";
import { assertDeviceMayActOn } from "~/server/display-device";

const TRANSCRIPT = "/home/team/shared/evidence/sb2c-device-capabilities.txt";
const lines: string[] = [];
const failures: string[] = [];
let step = 0;

function say(text = ""): void {
  lines.push(text);
  console.log(text);
}
function heading(text: string): void {
  step += 1;
  say("");
  say("=".repeat(78));
  say(`STEP ${step}. ${text}`);
  say("=".repeat(78));
}
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) say(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  else {
    say(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    failures.push(label);
  }
}

/** Set equality over **named** codes: a code that arrives later is named, not counted. */
function expectSet(label: string, actual: readonly string[], expected: readonly string[]): void {
  const have = new Set(actual);
  const missing = expected.filter((code) => !have.has(code));
  const unexpected = actual.filter((code) => !expected.includes(code));
  check(
    label,
    missing.length === 0 && unexpected.length === 0,
    `read ${JSON.stringify([...actual].sort())}` +
      (missing.length ? ` missing: ${missing.join(", ")}` : "") +
      (unexpected.length ? ` unexpected: ${unexpected.join(", ")}` : "")
  );
}

/** The principal shape a terminal resolves to, once. */
function device(kind: string, sectionKind: string | null, sectionId: string | null): DevicePrincipal {
  return {
    credentialId: "verify-credential",
    displayId: "verify-display",
    code: `VERIFY-${kind}-${sectionKind ?? "none"}`,
    name: `In-process ${kind} principal`,
    kind: kind as DevicePrincipal["kind"],
    chainId: "verify-chain",
    siteId: "verify-site",
    outletId: "verify-outlet",
    sectionId,
    sectionKind,
    operatingRoleCode: "SITE_CULINARY_TEAM",
    capabilities: displayCapabilities(kind, sectionKind),
  };
}

/** Calls the act and returns the refusal it raised, or null when it was allowed. */
function callAct(fn: () => void): { capability: string; code: string | undefined; reason: string } | null {
  try {
    fn();
    return null;
  } catch (error) {
    // The refusal crosses as a `PermissionDenied`: `details.action` is the capability that was
    // refused, `details.code` the catalogue key the screen words it with. (This read
    // `(x as { action?: string }).message`, which is a type error — `tsc` reported it as a
    // seventh error beside the six known `serve.ts` ones until S-B/2c's evidence session fixed
    // it here, with the field the error actually carries.)
    const refused = error as { message: string; details?: { code?: string; action?: string } };
    return {
      capability: refused.details?.action ?? "(no action)",
      code: refused.details?.code,
      reason: refused.message,
    };
  }
}

say("OmniHost.ai — display S-B/2c part 1: the device capability sets and the serve refusals.");
say("No database is read or written by this run: every case is a function of the kind, the");
say("section kind and the target's scope. Set equality names the codes, never counts them.");

heading("The capability set per display kind, and the pass's serve grant (ruling 2)");
const STATION = ["kds.ticket.view", "kds.ticket.advance", "kds.ticket.recall", "kds.ticket.void"];
expectSet("kds on a producing station (kind 'kitchen'): view + advance + recall + void", displayCapabilities("kds", "kitchen"), STATION);
expectSet("kds on the pass (section kind 'expedite'): the four, plus serve", displayCapabilities("kds", EXPEDITE_SECTION_KIND), [...STATION, "kds.ticket.serve"]);
expectSet("kds with no section at all: the four, no serve (fail closed — the pass is known by its section)", displayCapabilities("kds", null), STATION);
expectSet("cds: the guest display code and nothing else", displayCapabilities("cds"), ["cds.display.view"]);
expectSet("status board: read-only", displayCapabilities("status"), ["kds.ticket.view"]);
expectSet("printer: holds nothing", displayCapabilities("printer"), []);
expectSet("an unrecognised kind ('hologram'): empty, never a generous default", displayCapabilities("hologram"), []);
check(
  "re-route is in NO device set — it is a configuration act (§2.3 names Site Head)",
  !["kds", "cds", "status", "printer"].some((kind) => displayCapabilities(kind, EXPEDITE_SECTION_KIND).includes("kds.ticket.reroute"))
);

heading("The refusals, proven by calling the act and asserting the error IS that refusal");
const station = device("kds", "kitchen", "section-hgrill");
const pass = device("kds", EXPEDITE_SECTION_KIND, "section-pass");
const ownScope = { chainId: station.chainId, outletId: station.outletId, siteId: station.siteId, sectionId: station.sectionId };
const otherStation = { ...ownScope, sectionId: "section-other" };
const passScope = { chainId: pass.chainId, outletId: pass.outletId, siteId: pass.siteId, sectionId: pass.sectionId };

const reroute = callAct(() => {
  assertDeviceMayActOn(station, "kds.ticket.reroute", ownScope);
});
check(
  "a station screen re-routing its OWN station's ticket is refused, and the refusal is the capability refusal",
  reroute !== null && reroute.code === "kds.refusal.actionNotOnTerminal",
  reroute ? `code=${String(reroute.code)} — "this terminal is not configured for that action at all"` : "the act was ALLOWED — the rule is broken"
);
const recall = callAct(() => {
  assertDeviceMayActOn(station, "kds.ticket.recall", ownScope);
});
check("the same screen recalling its own station's ticket is ALLOWED (R on the keyboard map)", recall === null, recall ? `refused: ${String(recall.code)}` : "no refusal raised");
const voidAct = callAct(() => {
  assertDeviceMayActOn(station, "kds.ticket.void", ownScope);
});
check("the same screen voiding its own station's ticket is ALLOWED (V on the keyboard map)", voidAct === null, voidAct ? `refused: ${String(voidAct.code)}` : "no refusal raised");

const stationServe = callAct(() => {
  assertDeviceMayActOn(station, "kds.ticket.serve", ownScope);
});
check(
  "a producing station cannot serve (it holds no serve code), and is told so about the device",
  stationServe !== null && stationServe.code === "kds.refusal.actionNotOnTerminal",
  stationServe ? `code=${String(stationServe.code)}` : "the act was ALLOWED"
);
const passServe = callAct(() => {
  assertDeviceMayActOn(pass, "kds.ticket.serve", passScope);
});
check("the pass serves its own station's ready ticket", passServe === null, passServe ? `refused: ${String(passServe.code)}` : "no refusal raised");
const crossServe = callAct(() => {
  assertDeviceMayActOn(pass, "kds.ticket.serve", otherStation);
});
check(
  "a station-attached screen serving ANOTHER station stays refused (ruling 2's own sentence)",
  crossServe !== null && crossServe.code === "kds.refusal.notYourStation",
  crossServe ? `code=${String(crossServe.code)}` : "the act was ALLOWED"
);
const crossAdvance = callAct(() => {
  assertDeviceMayActOn(station, "kds.ticket.advance", otherStation);
});
check(
  "a station screen advancing another station's ticket is refused (D27), as before",
  crossAdvance !== null && crossAdvance.code === "kds.refusal.notYourStation",
  crossAdvance ? `code=${String(crossAdvance.code)}` : "the act was ALLOWED"
);

say("");
say("=".repeat(78));
say("HONEST LIMITS — what this run does NOT prove");
say("=".repeat(78));
say("1. NOT in this transcript: the credential path. A real `display_credential` token redeemed through");
say("   `redeemPairingCode` and resolved by `resolveDevicePrincipal` is what reads the section kind in");
say("   production; this run builds the principal in process, exactly as `verify-ticket-lifecycle`");
say("   does. The resolver's own change (the `outlet_section` join and the section-kind argument) is");
say("   therefore read, not exercised, here.");
say("2. NOT in this transcript: the ledger. Every capability refusal above is a pure function that");
say("   throws; the `denied` audit row is written by the caller (`refuseDevice`). Row counts before and");
say("   after each refusal are the S-B/2c evidence's remaining half, together with the licence/module");
say("   refusals from `registerDisplay`, `pairDisplay` and `fireOutletOrder` called on a chain whose");
say("   gate is CLOSED — never by reading the entitlement code.");
say("3. NOT in this transcript: the terminal half of the ticket lifecycle (T5/T6/T7/T9 from a");
say("   terminal), which the brief defers by name.");

say("");
say("=".repeat(78));
say(`steps: ${String(step)}`);
say(`failures: ${String(failures.length)}`);
for (const failure of failures) say(`  FAILED  ${failure}`);
say(failures.length === 0 ? "VERDICT: the device capability sets and the two serve refusals hold." : "VERDICT: SEE FAILURES ABOVE.");
const fs = await import("node:fs");
fs.writeFileSync(TRANSCRIPT, `${lines.join("\n")}\n`);
process.exit(failures.length === 0 ? 0 : 1);
