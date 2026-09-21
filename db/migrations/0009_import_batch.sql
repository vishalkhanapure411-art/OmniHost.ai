-- ===========================================================================
-- Phase 1 master data, slab 3 — the bulk-import surface
--   spec §16 (the property: a chain's real data lands by import, not by redesign)
--   spec §23.2 (one run, many rows, one report)  §23.3 (idempotency)
--   spec §5    (batchId on the audit row, `source: import`)
--
-- Two tables, and the reason for each:
--
--   * `import_batch` — the run. §23.2 says a chunked import is *one* batch with one
--     batch-level audit row and per-row audit rows, and §23.6 says the report an operator
--     reads is the artefact. A **dry run is a batch too**: it is stored, so "what did you
--     see before you committed" is answerable afterwards and a commit that changed nothing
--     is still a row rather than a gap. Nothing in a dry-run batch writes a master record —
--     that is the point of it.
--   * `import_row` — the report's own rows, keyed by the **line number in the operator's
--     file**. A rejected row that cannot be traced to a line in their spreadsheet is a
--     support ticket waiting to happen, so the line number is a column and not a message.
--
-- This is the vocabulary §23.2 already fixes (`entity`, `counts`, `payload_ref`, `status`),
-- scoped down to what the manual-CSV path actually runs today. It is deliberately *not* a
-- second, parallel ERP model: when the connector work starts (§23.1 `file_drop`,
-- `realtime_api`), the same batch/report shape carries it and `erp_system` supplies the
-- `system` — there is no `system` column here yet precisely because nothing but a human
-- upload can produce a batch at this point.
-- ===========================================================================

create table if not exists import_batch (
  id            uuid primary key default gen_random_uuid(),
  chain_id      uuid not null references chain (id) on delete cascade,
  -- §23.2's `entity` enum, restricted to the masters this platform can actually import
  -- today. Adding one is a migration; the pipeline itself is already entity-agnostic.
  entity        text not null check (entity in ('article', 'raw_material', 'vendor', 'uom', 'site', 'outlet')),
  -- §23.1's four exchange modes. `manual_csv` is what this screen runs, and the spec is
  -- explicit that it "must keep working for ever" once an adapter exists.
  mode          text not null default 'manual_csv' check (mode in ('manual_csv', 'file_drop')),
  -- 'dry_run' is the validation pass; 'commit' is the applying pass. Same file, same rows,
  -- two batch rows, so the two reports can be compared.
  phase         text not null check (phase in ('dry_run', 'commit')),
  file_name     text not null,
  file_bytes    integer not null,
  -- sha256 of the payload as uploaded. §23.3 layer 1's payload identity: re-uploading the
  -- same file is recognisable, and two runs over it are comparable without diffing text.
  file_hash     text not null,
  columns       text[] not null default array[]::text[],
  -- { seen, created, updated, unchanged, rejected, warned } — the running totals the screen
  -- shows and the support query counts.
  counts        jsonb not null default '{}'::jsonb,
  status        text not null check (status in ('succeeded', 'succeeded_with_issues', 'failed')),
  -- The file-level refusal (§17: unreadable file · all rows invalid · a required column
  -- missing), as [code, params] rather than prose: it resolves through the catalog like
  -- every other message.
  file_error_code   text,
  file_error_params jsonb,
  actor_user_id uuid references "user" (id) on delete set null,
  created_at    timestamptz not null default now(),
  finished_at   timestamptz
);
create index if not exists import_batch_chain_time_idx on import_batch (chain_id, created_at desc);
create index if not exists import_batch_payload_idx on import_batch (chain_id, entity, file_hash);

create table if not exists import_row (
  id           uuid primary key default gen_random_uuid(),
  batch_id     uuid not null references import_batch (id) on delete cascade,
  chain_id     uuid not null references chain (id) on delete cascade,
  -- 1-based, counting the header as line 1, because that is what a spreadsheet shows.
  line_number  integer not null,
  -- The business code the row carries, when it carries one. NULL is honest here: a row can
  -- be rejected before a code is readable, and inventing one would be worse.
  row_key      text,
  outcome      text not null check (outcome in ('created', 'updated', 'unchanged', 'rejected')),
  -- The record this row created or changed, so the report links to the record screen.
  entity_id    uuid,
  -- [{ column, code, severity, params }] — the four-part report row of §23.6 (what · where ·
  -- what it blocks · what can be done) with the prose left to the catalog.
  issues       jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists import_row_batch_idx on import_row (batch_id, line_number);
create index if not exists import_row_key_idx on import_row (chain_id, row_key);

-- ---------------------------------------------------------------------------
-- The audit row's import provenance (§5, §23.5)
-- ---------------------------------------------------------------------------
-- §5: "batchId for an import row; the batch itself is audited once with row counts", and
-- `source` gains the value `import`. Both are additive: every existing row keeps the
-- values it had, and a screen path and an import path still produce the same audit shape
-- apart from these two fields.
alter table audit_log add column if not exists batch_id uuid;
create index if not exists audit_log_batch_idx on audit_log (batch_id) where batch_id is not null;

alter table audit_log drop constraint if exists audit_log_request_source_check;
alter table audit_log add constraint audit_log_request_source_check
  check (request_source in ('screen', 'chatbot', 'api', 'system', 'import'));
