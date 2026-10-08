// @ts-nocheck — a dev-only harness. It drives a browser over CDP with Bun's own globals
// (`Bun.spawnSync`, `Bun.write`, `Bun.sleep`), and `@types/bun` is not installed in this
// repo (that is also why `serve.ts` reports the six known errors). Checking it with the
// app's tsconfig would report this file's Bun globals as new errors, so it is opted out
// rather than pretending the app compiles it.
/**
 * verify-layout-overflow.ts — the re-runnable check for "a table wider than its pane".
 *
 * The defect this proves fixed (7 Oct 2026): a dense table inside a master pane is wider
 * than the pane it sits in, so the pane grows a permanent horizontal scrollbar and every
 * column past the third is cut off at the pane's edge. On `/chains` that measured a 755px
 * table in a 416px pane. It reads to an operator as "the screen is overlapping".
 *
 * What it does, per screen / viewport width / density:
 *   * finds the master pane widths (`[role=region]`) and, for every `table.data-table`,
 *     the scroll box's client width vs its scroll width — `hScroll` is the defect;
 *   * lists the columns that are actually visible at that width (the header set);
 *   * compares bounding boxes of every pair of siblings inside `main.shell-content` and
 *     flags any pair overlapping by more than 6px on both axes;
 *   * flags any element whose right edge passes the viewport or whose left edge is
 *     negative, and any element clipped by a scrolling ancestor.
 *
 * It drives a real Chrome over CDP, so it needs a logged-in browser target.
 *
 * Usage (from the site directory, with the dev server up and agent-browser open):
 *   bun scripts/verify-layout-overflow.ts --base http://localhost:3000 --only chains \
 *     --mode after --out /tmp/layout-after.json --shots /home/team/shared/screenshots
 *
 *   --mode before   neutralises the fix in the page (container-type + hide-below) so the
 *                   same run measures the pre-fix layout — the numbers in the report.
 *   --only chains|sweep|all   which screen set to walk.
 *   --cdp <ws-url>  defaults to `agent-browser get cdp-url`.
 *
 * It writes only to the paths you give it; it writes nothing to the database.
 */

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]?.replace(/^--/, "");
  const value = process.argv[i + 1] ?? "1";
  if (key) args.set(key, value);
}
const arg = (name: string, fallback = "") => args.get(name) ?? fallback;

const BASE = arg("base", "http://localhost:3000").replace(/\/$/, "");
const MODE = arg("mode", "after");
const ONLY = arg("only", "all");
const OUT = arg("out", "/tmp/layout-overflow.json");
const SHOTS = arg("shots", "");
const SHOT_WIDTHS = arg("shot-widths", "1280,1024,768,640").split(",").map(Number);
const SHOT_DENSITIES = arg("shot-densities", "cozy").split(",");
const EMAIL = arg("email", "admin@omnihost.ai");
const PASSWORD = arg("password", "OmniHost!Admin#2026");

const HEIGHT = Number(arg("height", "800"));
const CHAIN_WIDTHS = [1280, 1024, 900, 820, 768, 700, 640];
const SWEEP_WIDTHS = [1280, 1024, 768];
const DENSITIES = ["compact", "cozy", "roomy"];

function cdpUrl(): string {
  if (arg("cdp")) return arg("cdp");
  const proc = Bun.spawnSync(["agent-browser", "get", "cdp-url"]);
  const url = proc.stdout.toString().trim().split("\n").pop()?.trim() ?? "";
  if (!url.startsWith("ws")) throw new Error(`could not read a CDP url from agent-browser (got ${JSON.stringify(url)})`);
  return url;
}

/**
 * Minimal CDP client: request/response plus a helper for a settled navigation.
 *
 * `agent-browser get cdp-url` hands back a **browser**-level websocket, so this opens its
 * own tab (`Target.createTarget`) and attaches flattened to it; a page-level url is used
 * as-is. Every page command then carries the session id.
 */
class Cdp {
  private ws: WebSocket;
  private next = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private loaded = 0;
  session = "";

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
        method?: string;
        sessionId?: string;
      };
      if (message.method === "Page.loadEventFired" && (!message.sessionId || message.sessionId === this.session)) this.loaded++;
      if (message.id === undefined) return;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    };
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}, session = this.session): Promise<T> {
    const id = ++this.next;
    const payload: Record<string, unknown> = { id, method, params };
    if (session) payload.sessionId = session;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 30000);
    });
  }

  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send<{ result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true }
    );
    if (result.exceptionDetails) {
      throw new Error(`eval failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    }
    return result.result.value as T;
  }

  async goto(url: string) {
    await this.send("Page.navigate", { url });
    // The route's data is streamed after the document loads; wait for the app's main
    // region to be in the DOM rather than for a load event plus a fixed sleep.
    for (let i = 0; i < 60; i++) {
      const state = await this.evaluate<string>(
        "document.readyState + '|' + (document.querySelector('main.shell-content') ? 'main' : 'no') + '|' + (document.querySelector('main.shell-content table.data-table, main.shell-content h1, main.shell-content header') ? 'content' : 'empty')"
      );
      if (state === "complete|main|content") break;
      await Bun.sleep(80);
    }
    await Bun.sleep(250);
  }
}

const MEASURE = String.raw`(() => {
  const main = document.querySelector('main.shell-content') || document.querySelector('main');
  if (!main) return JSON.stringify({ error: 'no main.shell-content' });
  const vw = window.innerWidth;
  const body = document.body;
  const densityClass = (node) => node ? (node.classList.contains('density-compact') ? 'compact' : node.classList.contains('density-roomy') ? 'roomy' : node.classList.contains('density-cozy') ? 'cozy' : null) : null;
  let density = null;
  for (let e = main; e && !density; e = e.parentElement) density = densityClass(e);
  if (!density) density = densityClass(document.documentElement) || densityClass(body) || 'cozy';

  const describe = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const cls = typeof el.className === 'string' ? el.className : '';
    const first = cls.split(/\s+/).filter((c) => c && !c.startsWith('text-') && !c.startsWith('flex')).slice(0, 2);
    if (first.length) s += '.' + first.join('.');
    const txt = (el.innerText || '').trim().split(String.fromCharCode(10))[0] || '';
    if (txt) s += ' "' + txt.slice(0, 40) + '"';
    return s;
  };

  const mainRect = main.getBoundingClientRect();
  const panes = Array.from(main.querySelectorAll('[role="region"]')).map((el) => {
    const r = el.getBoundingClientRect();
    return {
      label: el.getAttribute('aria-label'),
      w: Math.round(r.width),
      h: Math.round(r.height),
      clientW: el.clientWidth,
      scrollW: el.scrollWidth,
      vScroll: el.scrollHeight - el.clientHeight > 0,
    };
  });

  const tables = Array.from(main.querySelectorAll('table.data-table')).map((t) => {
    const box = t.parentElement;
    const headers = Array.from(t.querySelectorAll('thead th')).map((th) => {
      const r = th.getBoundingClientRect();
      return {
        label: (th.innerText || '').trim().replace(/\s+/g, ' '),
        w: Math.round(r.width),
        hidden: r.width === 0 || getComputedStyle(th).display === 'none',
      };
    });
    const firstRow = Array.from(t.querySelectorAll('tbody tr:first-child td')).map((td) => {
      const r = td.getBoundingClientRect();
      return { w: Math.round(r.width), hidden: r.width === 0 || getComputedStyle(td).display === 'none' };
    });
    return {
      rows: t.querySelectorAll('tbody tr').length,
      tableW: Math.round(t.getBoundingClientRect().width),
      boxW: box ? Math.round(box.getBoundingClientRect().width) : null,
      boxClientW: box ? box.clientWidth : null,
      boxScrollW: box ? box.scrollWidth : null,
      overflowPx: box ? box.scrollWidth - box.clientWidth : null,
      hScroll: box ? box.scrollWidth - box.clientWidth > 1 : null,
      visibleColumns: headers.filter((h) => !h.hidden).map((h) => h.label),
      hiddenColumns: headers.filter((h) => h.hidden).map((h) => h.label),
      columnWidths: headers.map((h) => h.w),
      cellsVisible: firstRow.filter((c) => !c.hidden).length,
    };
  });

  // Every element with a box, grouped by parent, so only siblings are compared.
  const boxes = [];
  for (const el of main.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    boxes.push({ el, r });
  }
  const byParent = new Map();
  for (const b of boxes) {
    const p = b.el.parentElement;
    if (!p) continue;
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(b);
  }
  const overlaps = [];
  for (const [parent, list] of byParent) {
    if (list.length < 2 || list.length > 120) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i].r, b = list[j].r;
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ox > 6 && oy > 6) {
          overlaps.push({ parent: describe(parent), a: describe(list[i].el), b: describe(list[j].el), ox: Math.round(ox), oy: Math.round(oy) });
        }
      }
    }
  }

  const clipAncestor = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === 'hidden' || ox === 'auto' || ox === 'scroll') return p;
    }
    return null;
  };
  const offViewport = [];
  const clipped = [];
  for (const { el, r } of boxes) {
    const label = describe(el);
    if (r.right > vw + 0.5 || r.left < -0.5) {
      offViewport.push({ el: label, left: Math.round(r.left), right: Math.round(r.right), overBy: Math.round(r.right - vw) });
      const anc = clipAncestor(el);
      if (anc) {
        const ar = anc.getBoundingClientRect();
        clipped.push({ el: label, by: describe(anc), overBy: Math.round(r.right - ar.right) });
      }
    }
  }

  return JSON.stringify({
    url: location.pathname,
    vw, vh: window.innerHeight, rem: getComputedStyle(document.documentElement).fontSize,
    mainW: Math.round(mainRect.width), density,
    panes: panes.map((p) => ({ label: p.label, w: p.w })),
    tables,
    overlaps: overlaps.slice(0, 12), overlapCount: overlaps.length,
    offViewport: offViewport.slice(0, 12), offViewportCount: offViewport.length,
    clipped: clipped.slice(0, 12), clippedCount: clipped.length,
  });
})()`;

/** The pre-fix state, exactly: no container query container, every column shown again. */
const NEUTRALISE = `
  (() => {
    const style = document.createElement('style');
    style.id = 'layout-sweep-before';
    style.textContent = '.table-scroll{container-type:normal !important}[data-hide-below]{display:table-cell !important}';
    document.head.appendChild(style);
    return true;
  })()`;

interface Row {
  screen: string;
  url: string;
  width: number;
  density: string;
  mainW: number;
  paneW: number | null;
  tableW: number | null;
  boxClientW: number | null;
  overflowPx: number | null;
  hScroll: boolean | null;
  visibleColumns: string[];
  hiddenColumns: string[];
  overlapCount: number;
  overlaps: { a: string; b: string; ox: number; oy: number }[];
  offViewportCount: number;
  offViewport: { el: string; overBy: number }[];
  clippedCount: number;
  clipped: { el: string; by: string; overBy: number }[];
  error?: string;
}

const screensFor = (name: string, chainId: string | null): { key: string; path: string }[] => {
  const chains = [
    { key: "chains-list", path: "/chains" },
    { key: "chains-detail", path: chainId ? `/chains/${chainId}` : "" },
    { key: "chains-settings", path: chainId ? `/chains/${chainId}/settings` : "" },
    { key: "chains-onboard", path: "/chains/onboard" },
  ].filter((s) => s.path);
  const sweep = [
    { key: "approvals", path: "/approvals" },
    { key: "audit", path: "/audit" },
    { key: "design", path: "/design" },
    { key: "support-queue", path: "/support" },
    { key: "support-access", path: "/support/access" },
    { key: "mdm-articles", path: "/mdm/articles" },
    { key: "mdm-article-record", path: "/mdm/articles/ART-1001" },
    { key: "mdm-vendors", path: "/mdm/vendors" },
    { key: "mdm-sites", path: "/mdm/sites" },
  ];
  if (name === "chains") return chains;
  if (name === "sweep") return sweep;
  return [...chains, ...sweep];
};

const health = await fetch(`${BASE}/login`).then((r) => r.status).catch(() => 0);
if (health !== 200) throw new Error(`${BASE} did not answer (status ${health}) — is the dev server up?`);

const ws = new WebSocket(cdpUrl());
await new Promise<void>((resolve, reject) => {
  ws.onopen = () => resolve();
  ws.onerror = (e) => reject(new Error(`CDP connect failed: ${String(e)}`));
});
const cdp = new Cdp(ws);
const browserLevel = !cdpUrl().includes("/devtools/page/");
if (browserLevel) {
  const target = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" }, "");
  const attached = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true }, "");
  cdp.session = attached.sessionId;
}
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");

// Sign in as the AppAdmin the screen set is written for. The session cookie is HttpOnly;
// a fetch from the page's own origin still sets it in this browser.
await cdp.goto(`${BASE}/login`);
const signIn = await cdp.evaluate<string>(
  `(async () => { const r = await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: ${JSON.stringify(EMAIL)}, password: ${JSON.stringify(PASSWORD)} }) }); const j = await r.json().catch(() => ({})); return r.status + ' ' + ((j.principal && j.principal.roles || []).join(',')); })()`
);
console.log(`sign-in: ${signIn}`);
if (!signIn.startsWith("201") && !signIn.startsWith("200")) throw new Error(`could not sign in: ${signIn}`);

// The chain id the screens are walked against. The list's rows are click targets, not
// links, so the id is read from the URL after opening the first row.
await cdp.goto(`${BASE}/chains`);
const clicked = await cdp.evaluate<boolean>(
  `(() => { const row = document.querySelector('main.shell-content tbody tr[data-clickable="true"]'); if (!row) return false; row.click(); return true; })()`
);
if (!clicked) throw new Error("no clickable row on /chains — is the demo data seeded?");
for (let i = 0; i < 40 && !/^\/chains\/[^/]+$/.test(await cdp.evaluate<string>("location.pathname")); i++) await Bun.sleep(250);
const chainId = (await cdp.evaluate<string>("location.pathname")).split("/")[2] ?? null;
if (!chainId) throw new Error("clicking the first chain row did not open a chain detail route");
console.log(`chain id: ${chainId}`);

// The MDM article record the sweep opens: read from the URL after opening the first row,
// so the check does not depend on a code somebody has to keep in step with the seed.
await cdp.goto(`${BASE}/mdm/articles`);
const articleClicked = await cdp.evaluate<boolean>(
  `(() => { const row = document.querySelector('main.shell-content tbody tr[data-clickable="true"]'); if (!row) return false; row.click(); return true; })()`
);
let articleCode: string | null = null;
if (articleClicked) {
  for (let i = 0; i < 40 && !/^\/mdm\/articles\/[^/]+$/.test(await cdp.evaluate<string>("location.pathname")); i++) await Bun.sleep(250);
  const path = await cdp.evaluate<string>("location.pathname");
  if (/^\/mdm\/articles\/[^/]+$/.test(path)) articleCode = decodeURIComponent(path.split("/")[3] ?? "");
}
console.log(`article code: ${articleCode ?? "(none found — article record skipped)"}`);

const screens = screensFor(ONLY, chainId).map((s) =>
  s.key === "mdm-article-record" && articleCode ? { key: s.key, path: `/mdm/articles/${encodeURIComponent(articleCode)}` } : s
);
if (ONLY === "sweep" && !articleCode) console.log("no article record found; the list-only sweep still runs");
const widths = ONLY === "chains" ? CHAIN_WIDTHS : SWEEP_WIDTHS;
const rows: Row[] = [];

for (const screen of screens) {
  for (const density of DENSITIES) {
    for (const width of widths) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
      await cdp.evaluate(`document.cookie = 'omnihost.density=${density}; path=/'`);
      await cdp.goto(`${BASE}${screen.path}`);
      if (MODE === "before") await cdp.evaluate(NEUTRALISE);
      const raw = await cdp.evaluate<string>(MEASURE);
      const m = JSON.parse(raw) as {
        url: string; vw: number; rem: string; mainW: number; density: string;
        panes: { label: string; w: number }[];
        tables: { boxW: number | null; boxClientW: number | null; overflowPx: number | null; hScroll: boolean | null; tableW: number; visibleColumns: string[]; hiddenColumns: string[] }[];
        overlaps: { a: string; b: string; ox: number; oy: number }[];
        offViewport: { el: string; overBy: number }[];
        clipped: { el: string; by: string; overBy: number }[];
        overlapCount: number; offViewportCount: number; clippedCount: number; error?: string;
      };
      const table = m.tables?.[0];
      const pane = m.panes?.length ? Math.max(...m.panes.map((p) => p.w)) : null;
      const row: Row = {
        screen: screen.key,
        url: m.url ?? screen.path,
        width,
        density: m.density ?? density,
        mainW: m.mainW ?? 0,
        paneW: pane,
        tableW: table?.tableW ?? null,
        boxClientW: table?.boxClientW ?? null,
        overflowPx: table?.overflowPx ?? null,
        hScroll: table?.hScroll ?? null,
        visibleColumns: table?.visibleColumns ?? [],
        hiddenColumns: table?.hiddenColumns ?? [],
        overlapCount: m.overlapCount ?? 0,
        overlaps: m.overlaps ?? [],
        offViewportCount: m.offViewportCount ?? 0,
        offViewport: (m.offViewport ?? []).map((o) => ({ el: o.el, overBy: o.overBy })),
        clippedCount: m.clippedCount ?? 0,
        clipped: (m.clipped ?? []).map((c) => ({ el: c.el, by: c.by, overBy: c.overBy })),
        error: m.error,
      };
      rows.push(row);
      console.log(
        `${screen.key.padEnd(20)} ${String(width).padStart(4)} ${density.padEnd(7)} pane=${String(row.paneW).padStart(4)} box=${String(row.boxClientW).padStart(4)} table=${String(row.tableW).padStart(4)} over=${String(row.overflowPx).padStart(4)} hscroll=${row.hScroll ? "YES" : "no "} cols=${row.visibleColumns.length}[${row.visibleColumns.join("|")}] overlap=${row.overlapCount} offscreen=${row.offViewportCount} clipped=${row.clippedCount}`
      );

      if (SHOTS && SHOT_WIDTHS.includes(width) && SHOT_DENSITIES.includes(density)) {
        const shot = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
        const file = `${SHOTS}/${screen.key}-${width}-${density}-${MODE}.png`;
        await Bun.write(file, Buffer.from(shot.data, "base64"));
      }
    }
  }
}

await cdp.send("Emulation.clearDeviceMetricsOverride");
await Bun.write(OUT, JSON.stringify({ mode: MODE, base: BASE, generatedAt: new Date().toISOString(), rows }, null, 2));

// A short summary: the widths where the scroll box still overflows, and every overlap.
const bad = rows.filter((r) => r.hScroll);
const overlapping = rows.filter((r) => r.overlapCount > 0);
console.log(`\n${rows.length} measurements -> ${OUT}`);
console.log(`horizontal scrollbar still present: ${bad.length}`);
for (const r of bad) console.log(`  ${r.screen} ${r.width} ${r.density}: pane=${r.boxClientW} table=${r.tableW} overflow=${r.overflowPx}px`);
console.log(`sibling overlaps >6px on both axes: ${overlapping.length} measurements`);
const signatures = new Map<string, string>();
for (const r of overlapping) {
  for (const o of r.overlaps) {
    const key = `${o.a} X ${o.b}`;
    if (!signatures.has(key)) signatures.set(key, `${r.screen} ${r.width} ${r.density} (${o.ox}x${o.oy}px)`);
  }
}
for (const [key, where] of signatures) console.log(`  ${where}: ${key}`);
const offscreenSignatures = new Map<string, string>();
for (const r of rows.filter((x) => x.offViewportCount > 0)) {
  for (const o of r.offViewport) {
    if (!offscreenSignatures.has(o.el)) offscreenSignatures.set(o.el, `${r.screen} ${r.width} ${r.density} over by ${o.overBy}px`);
  }
}
console.log(`elements past the viewport / clipped by a scrolling ancestor (distinct elements): ${offscreenSignatures.size}`);
for (const [el, where] of offscreenSignatures) console.log(`  ${where}: ${el}`);
ws.close();

export {};
