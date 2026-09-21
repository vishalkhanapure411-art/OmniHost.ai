---
name: agent-browser-react-controlled-inputs
description: "Driving the OmniHost.ai dev site with agent-browser: logging in past React controlled inputs, where `fill` silently does nothing, and reading screenshots back."
---
# agent-browser against the OmniHost.ai site (React 19 controlled inputs)
## `fill` does not stick on this app's controlled inputs — use `type` after clearing
The sign-in and other forms are React controlled inputs. `agent-browser fill "#login-email" "..."`
writes the DOM value directly, React's state never changes, the next re-render restores the old
value, and the form submits the *old* credentials. It looks like a failed login, not a failed fill.
Working sequence:
```bash
agent-browser click "#login-email"
agent-browser key ctrl+a
agent-browser key Delete
agent-browser type "#login-email" "user@example.com"     # real Input events -> React onChange fires
agent-browser get value "#login-email"                   # confirm BEFORE submitting
```
Always `get value` on each field before clicking submit. If it still shows the old value, the fill
did not take and submitting will waste a round trip.
## Login form specifics
Field ids are `#login-email` and `#login-password`; the submit button is `button[type=submit]`.
Submitting live credentials shows in `audit_log` as `action=auth.sign_in`, which is a handy way to
confirm a browser session really authenticated as the account you think.
If interactive login keeps failing, fall back to `curl` for the API work and use the browser only
for rendering evidence — the session cookie is HttpOnly, so it cannot be injected from JS.
## If NOTHING on the page reacts — check hydration first (seen 21 Sept 2026)
On the hosted dev preview the app rendered (SSR HTML with real data) but **never hydrated**: no React
event handler was attached to anything. Symptoms, in the order they show up:
- `submit` on the sign-in form does a **native GET submit** and the URL becomes `/login?` (the inputs
  have no `name`, so a native GET yields an empty query). A hydrated handler would `preventDefault()`
  and navigate to `/approvals`.
- Raw mouse `down`/`up` on a segmented button (Compact/Cozy/Roomy) leaves `aria-pressed` unchanged.
- Clicking an `<a href="/mdm/articles/ART-1003">` leaves `location.pathname` and
  `performance.getEntriesByType('navigation').length` unchanged.
- Typing into a controlled input changes the DOM value but never the rendered data.
- `window.$_TSR` holds the raw stream payload (`streamEnded:true`) and **no element, `document` or
  `documentElement` has a `__reactFiber$`/`__reactContainer$` expando**. `eval` is in the main world —
  prove it by injecting a `<script>` that sets a global and reading it back — so this is real, not an
  isolated-world artefact.
Before blaming your automation, check that all client modules returned 200
(`agent-browser network requests | grep -E "default-entry|Hydrate|react-dom_client"`) and that
`agent-browser console` / `errors` are clean: module-loading failure is a different bug. If it is
hydration, no click-driven step is testable — verify the server-rendered state and report the rest as
blocked rather than guessing.
## Sign in without the form: in-page fetch (works even when the page is inert)
The session cookie is HttpOnly, but a fetch **from the page's own origin** sets it in the browser:
```bash
set +H   # '!' in a password triggers bash history expansion otherwise
agent-browser open "https://<host>/login" ; sleep 3
agent-browser eval "(async()=>{const r=await fetch('/api/session',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({email:'mdm.head@saffron.example',password:'Saffron!MdmHead#2026'})});
  const j=await r.json();return r.status+' '+(j.principal?j.principal.roles.join(','):'?')})()"
# -> "201 CENTRAL_MDM_HEAD"; then `agent-browser open /mdm/articles` serves the page AS THAT USER,
# including server-rendered permission refusals (the loader runs on the server).
```
Switching accounts is just another fetch — no sign-out needed. This is the only reliable way to test
permission-shaped screens when the form does not submit.
## Reading screenshots
`agent-browser screenshot /tmp/x.png` then `ReadMediaFile`. Identical pixels return the **same
image URL** as an earlier screenshot, which is the signal that nothing changed on the page — useful
for telling "the click did nothing" from "the screenshot call failed".
Screenshots for the owner go in `/home/team/shared/screenshots/` with descriptive names.
## Session hygiene
The `browser` session is shared across the team and keeps scrollback from whoever used it last
(a previous member's Neon-docs session was still on screen). Prefix every command with `clear;` and
pipe through `tail`/`head` so the replay does not eat the context window. Use a separate bash
session name for non-browser work so browser scrollback does not bury build output.
## Root cause of the 21 Sept "never hydrates" bug: a client/server boundary defect
**The rule:** in this app (TanStack Start + Vite), any module that is **retained in the client
bundle** may import **only import-free modules**. A module-scope import of a server-only module
(`~/server-fns`, `~/db`, auth/password code) drags the whole server graph into the browser
bundle; the client entry then fails while it is still loading and **nothing hydrates**. The page
still looks perfect, because the SSR HTML is served by the server, which is healthy.
The specific defect: a navigation constant that client code reads at **module scope** lived in a
server-only module, so `import`ing the constant (not calling it — reading it) pulled in
password-hashing and database code. Vite "externalised for browser" warnings are the smell.
Fixed structurally by moving the nav registry and the public principal type into client-safe
modules (OmniHost.ai PR #9) — no polyfill, no weakened permission path.
**The one-command probe (run it in the browser console, on the dev server):**
```js
await import('/src/domain/<module>.ts')            // or '/src/server-fns.ts', '/src/db.ts'
```
A client-safe module resolves and prints its exports. A server-only module rejects with the
import error, or the console shows `Module "node:crypto"/"pg" has been externalised for browser
compatibility` — that message, on a module the client graph reaches, *is* the defect. Check it
before believing any other explanation. Corroborate the other way round too: `agent-browser
console` for that warning and `agent-browser network requests` for a client module that never
finishes.
**Do not** conclude "the platform's proxy ate hydration" — the SSR payload (`window.$_TSR`)
being present and `streamEnded:true` is the *healthy* half. `hydrated === true` is provable on
any page with one line:
```js
Object.keys(document.body).some(k => k.startsWith('__react'))
```
