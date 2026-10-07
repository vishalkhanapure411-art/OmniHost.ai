-- OmniHost.ai — migration 0017: the reason vocabulary both records can agree on (S-B/2b, second pass)
-- -------------------------------------------------------------------------------------------------
-- 0016 added `ticket.void_reason_code` / `hold_reason_code` checks over `TICKET_REASON_CODES`
-- (`src/domain/order-rules.ts`) — the codes the shipped `voidTicket()` accepts. Between writing 0016
-- and finishing this session the lead's audit of S-B/2b (`/home/team/shared/DECISIONS.md`, "The
-- independent audit of S-B/2b", item 2) ruled the code's own list the **defect**: ruling 4 of 1 Oct
-- had fixed the vocabulary as
--
--   dropped, wrong_item, remade, guest_changed, quality, other
--
-- and the code carries eight different, unruled codes and is missing `other` — the escape hatch
-- ruling 4 names as the thing that "keeps the list honest rather than a lie".
--
-- **So the two records disagree, and this migration is what keeps them from disagreeing destructively
-- while the code is reconciled.** It widens both checks to the **union** of the two vocabularies:
--
--   ruling 4 (DECISIONS.md, 1 Oct)   dropped, wrong_item, remade, guest_changed, quality, other
--   the shipped code (order-rules)   dropped, guest_cancelled, article_unavailable, duplicate_ticket,
--                                    marked_ready_in_error, quality_check_failed,
--                                    wrong_station, station_unavailable
--
-- **Why the union rather than ruling 4's six, stated plainly.** The two halves of the ruling have to
-- land together: the code change (drop the eight unruled codes, rename `quality_check_failed` →
-- `quality`, add `other` with its en + hi labels) is the 2b remainder's, per the same audit entry. If
-- this migration enforced only the six **now**, three codes the shipped `voidTicket()` accepts
-- (`guest_cancelled`, `article_unavailable`, `duplicate_ticket`) and §2.6 case 2's own
-- `hold_reason_code = 'article_unavailable'` would be refused **by the database** — a raw 23514 where
-- the operator should get a worded validation refusal. That trades a vocabulary defect for a live
-- failure in the kitchen, which is worse than the defect. The union closes the hole 0016 exists to
-- close (a code no act and no ruling offers) without refusing a single write either record can
-- currently produce.
--
-- **The exact next step, for whoever lands the remainder.** When `TICKET_REASON_CODES` is reconciled
-- with ruling 4 and the labels for `other`, `wrong_item`, `remade` and `guest_changed` exist in both
-- catalogues, the tightening is one statement per column:
--
--   alter table ticket drop constraint ticket_void_reason_vocabulary;
--   alter table ticket add constraint ticket_void_reason_vocabulary
--     check (void_reason_code is null
--            or void_reason_code in ('dropped','wrong_item','remade','guest_changed','quality','other'));
--
-- and the same for `ticket_hold_reason_vocabulary`. Nothing here needs reversing to do it.
--
-- **The non-empty rules from 0014 are untouched** (`ticket_void_reason`, `ticket_hold_reason`): a
-- ticket in `voided`/`held_unavailable` must still carry a non-empty code. Pre-check before writing
-- this file, against the pilot database: every `ticket` row has NULL in both columns (three queued
-- tickets), so neither constraint below rejects an existing row.
-- -------------------------------------------------------------------------------------------------
alter table ticket drop constraint if exists ticket_void_reason_vocabulary;
alter table ticket add constraint ticket_void_reason_vocabulary
  check (void_reason_code is null
         or void_reason_code in ('dropped', 'wrong_item', 'remade', 'guest_changed', 'quality', 'other',
                                 'guest_cancelled', 'article_unavailable', 'duplicate_ticket',
                                 'marked_ready_in_error', 'quality_check_failed',
                                 'wrong_station', 'station_unavailable'));
comment on constraint ticket_void_reason_vocabulary on ticket is
  'The union of ruling 4''s vocabulary (DECISIONS.md, 1 Oct 2026) and the codes TICKET_REASON_CODES.void offers today, until the code is reconciled with the ruling. A value outside both lists is refused; nothing the shipped voidTicket() accepts is refused. Tighten to ruling 4''s six when the code and labels land (see migration 0017''s header for the statement).';

alter table ticket drop constraint if exists ticket_hold_reason_vocabulary;
alter table ticket add constraint ticket_hold_reason_vocabulary
  check (hold_reason_code is null
         or hold_reason_code in ('dropped', 'wrong_item', 'remade', 'guest_changed', 'quality', 'other',
                                 'guest_cancelled', 'article_unavailable', 'duplicate_ticket',
                                 'marked_ready_in_error', 'quality_check_failed',
                                 'wrong_station', 'station_unavailable'));
comment on constraint ticket_hold_reason_vocabulary on ticket is
  'The same union as ticket_void_reason_vocabulary. T8 (held_unavailable) is not built, so there is no hold-only list to narrow this to; the design document §2.6 case 2 names article_unavailable, which is in the list. Tighten with the void constraint when the code is reconciled.';
