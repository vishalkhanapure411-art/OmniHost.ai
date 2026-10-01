-- OmniHost.ai — migration 0016: the offline replay key, and the reason vocabulary the code already has
-- ---------------------------------------------------------------------------------------------------
-- Two small gaps the lead ruled on 1 Oct 2026 (`/home/team/shared/DECISIONS.md`, the display-layer
-- rulings, items 4 and 5), closed now **while the only writer of `ticket_transition` is the fire path
-- and the lifecycle this slice adds** — the same argument both rulings make: a later migration on a
-- table the kitchen has been writing to for weeks is the expensive path.
--
--   (a) `ticket_transition.transition_id` — a nullable column plus a partial unique index, so offline
--       replay (S-F, design §3.4) has a **database-level backstop instead of a convention**.
--   (b) `ticket.void_reason_code` / `hold_reason_code` — the closed vocabulary that exists **in code**
--       (`TICKET_REASON_CODES` in `src/domain/order-rules.ts`) made true in the database.
--
-- Additive, and nothing else: no table is dropped or renamed, no column changes type or nullability,
-- no index is removed, and no row is edited. Both statements are `if not exists`/`drop … if exists` so
-- a re-run is harmless.
-- ---------------------------------------------------------------------------------------------------
-- (a) The replay key.
--
-- `DESIGN-kds-and-ticket-routing.md` §3.4 item 2: an outbox entry is submitted with the
-- **client-generated `transition_id`**, and "`transition_id` already in `ticket_transition` ⇒ the server
-- returns the existing outcome and applies nothing (idempotent replay)". §6.4's client list names the
-- same thing: "one `transition_id` per operator action, reused on every retry".
--
-- **Nullable, and that is the point.** Every row written today — T1 by the fire path, T2–T7/T9 by the
-- lifecycle — is written by code that is *online*: there is no client action to key, and inventing an id
-- server-side would be a number that proves nothing (a retry of it would not match the client's own
-- id). So the column is written by S-F and is NULL until then, which is why the index below is
-- **partial**: a plain unique index would also be satisfied by NULLs (Postgres treats them as distinct),
-- but the partial form states the intent — this key constrains *replayed* transitions, and the rows
-- that carry no client action are simply not part of it.
--
-- Global, not per chain (design §6.4's `unique (transition_id)`): the id is generated on a terminal, so
-- uniqueness is a property of the id and not of a tenant, and a second chain that replayed another
-- chain's id would be a defect rather than a legitimate row.
-- ---------------------------------------------------------------------------------------------------
alter table ticket_transition add column if not exists transition_id uuid;
comment on column ticket_transition.transition_id is
  'The client-generated id of one operator action (DESIGN-kds-and-ticket-routing.md §3.4, §6.4). NULL for every transition written by online code — T1 and the lifecycle — because no client action is being replayed. S-F''s offline outbox submits it, and ticket_transition_replay_key is the database-level duplicate suppression: a replayed id must not write a second row.';
create unique index if not exists ticket_transition_replay_key
  on ticket_transition (transition_id) where transition_id is not null;
comment on index ticket_transition_replay_key is
  'One row per client-generated transition_id (partial: online transitions carry NULL and are not part of the key). The backstop to S-F''s "a replayed transition applies nothing" — enforced by the database rather than by a convention in the outbox.';
-- ---------------------------------------------------------------------------------------------------
-- (b) The reason vocabulary, which the code already has.
--
-- `src/domain/order-rules.ts` declares `TICKET_REASON_CODES` — the closed set each reasoned act offers
-- — and `requireReasonCode()` refuses anything outside it as a **validation** refusal that writes
-- nothing. The columns were unconstrained `text` (0014), so the database would accept a code the code
-- cannot produce; two records of the same vocabulary that can disagree is exactly the defect class this
-- team keeps closing.
--
-- **Pre-check, run against the pilot database before this migration was written (1 Oct 2026):**
--
--   select void_reason_code, hold_reason_code, count(*) from ticket group by 1,2;
--   → one row: (NULL, NULL, 3) — three queued tickets, no reason code anywhere.
--
-- So the constraints below reject **no existing row**; if that query had returned any non-null value
-- outside the sets, this migration would have stopped and reported it rather than editing the data.
--
-- **`void_reason_code` gets exactly `TICKET_REASON_CODES.void`** — the four codes the void act accepts:
-- `dropped`, `guest_cancelled`, `article_unavailable`, `duplicate_ticket`. `voidTicket()` is the only
-- writer of this column.
--
-- **`hold_reason_code` gets the whole closed set**, because it has no list of its own in code yet: T8
-- (`held_unavailable`) is named in §2.3 and deliberately not built — its availability path is its own
-- slice — and `TICKET_REASON_CODES` has no `hold` entry. The one value the design names for it is §2.6
-- case 2's `article_unavailable`, which is in the set below. Admitting the union is the honest reading
-- of "the closed set the code has": tightening this to a hold-only list belongs to the slice that
-- writes the column, and narrowing it here would be this migration guessing a vocabulary nothing has
-- agreed. Stated rather than left implicit.
--
-- **The existing non-empty rule stays exactly as 0014 wrote it** (`ticket_void_reason`,
-- `ticket_hold_reason`: a ticket in `voided`/`held_unavailable` must carry a non-empty code). These two
-- constraints are additions beside it, not replacements: one says a code is *required* in those states,
-- the other says which codes exist at all.
-- ---------------------------------------------------------------------------------------------------
alter table ticket drop constraint if exists ticket_void_reason_vocabulary;
alter table ticket add constraint ticket_void_reason_vocabulary
  check (void_reason_code is null
         or void_reason_code in ('dropped', 'guest_cancelled', 'article_unavailable', 'duplicate_ticket'));
comment on constraint ticket_void_reason_vocabulary on ticket is
  'void_reason_code is one of TICKET_REASON_CODES.void (src/domain/order-rules.ts), the four codes voidTicket() accepts. The non-empty rule for a voided ticket is 0014''s ticket_void_reason; this constraint says which codes exist at all.';

alter table ticket drop constraint if exists ticket_hold_reason_vocabulary;
alter table ticket add constraint ticket_hold_reason_vocabulary
  check (hold_reason_code is null
         or hold_reason_code in ('marked_ready_in_error', 'quality_check_failed',
                                 'dropped', 'guest_cancelled', 'article_unavailable', 'duplicate_ticket',
                                 'wrong_station', 'station_unavailable'));
comment on constraint ticket_hold_reason_vocabulary on ticket is
  'hold_reason_code is one of the codes TICKET_REASON_CODES declares (src/domain/order-rules.ts). T8 is not built, so there is no hold-only list to narrow this to; §2.6 case 2''s value (article_unavailable) is in the set. Tighten when the availability slice names its own list.';
