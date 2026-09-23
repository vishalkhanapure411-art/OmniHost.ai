-- ===========================================================================
-- 0010 — the draft-version rule: a version supersedes another, and only one
-- version of an article may be open at a time.
--
-- WHY THIS EXISTS (§7.2 item 5, §7.3; PRD "Price or recipe changes create a new
-- version rather than overwriting the old one, so a historical order keeps the
-- figures it was actually sold under").
--
-- Until now a price change edited the article's current version in place: it
-- closed the open window the day before the new one opened and opened a new row.
-- The rule the spec actually states is that a price change opens version N+1 in
-- `draft` while N stays `active` and sellable, and approving N+1 supersedes N.
-- Two things the schema was missing for that:
--
--   1. **The link between a version and the version it replaces.** §7.3 promises
--      a `versionOf` link and `0008_mdm_masters.sql` does not carry one. Without
--      it, "what does this proposal change?" can only be guessed from version
--      numbers, and the supersede transaction cannot assert that the base it is
--      about to overwrite is still the base it cloned from.
--
--   2. **A structural answer to "how many versions of one article can be open?"**
--      A `draft` or `pending_review` version is one nobody has decided yet. Two of
--      them for one article is a queue holding two generations of the same record,
--      and approving the older one moves the base out from under the newer one.
--      The partial unique index below makes that unrepresentable rather than
--      merely discouraged. `0003_audit_and_inbox.sql` has indexes on
--      `approval_task` only, so nothing stopped it before.
--
-- Both statements are additive: the column is nullable and nothing reads it
-- except the review path. Existing rows are untouched — a version with no
-- predecessor (every version 1, and every version created before this migration)
-- carries NULL, which is the honest answer for it.
-- ===========================================================================

alter table article_version
  add column if not exists supersedes_version_id uuid
    references article_version (id) on delete set null;

comment on column article_version.supersedes_version_id is
  '§7.3 versionOf: the version this one replaces. Set when a price (or later a content) change opens N+1 as a draft; read by the review dialog to show what the proposal changes, and asserted at approval so a proposal whose base has moved is refused rather than applied.';

create index if not exists article_version_supersedes_idx
  on article_version (supersedes_version_id);

-- One open version per article. `draft` is open (nobody has decided it) and
-- `pending_review` is open (a decision is waiting). Everything else — `active`,
-- `seasonal`, `superseded`, `discontinued` — is a version whose state is settled.
create unique index if not exists article_version_open_key
  on article_version (article_id)
  where status in ('draft', 'pending_review');
