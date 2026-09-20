-- OmniHost.ai — migration 0003: audit log + the shared approval (maker-checker) inbox
-- ---------------------------------------------------------------------------
-- The audit log is the spec's explicit, non-negotiable requirement, stated in three
-- places and in the same words each time:
--   * "Every chatbot-initiated transaction is audit-logged: who, role, site,
--     before/after state, timestamp — the same log a screen-driven action would
--     produce, since the chatbot calls the identical domain API."
--     (Chatbot Interaction Model)
--   * "Every chatbot- or screen-driven transaction is audit-logged with who, role,
--     site, before/after state." (Non-Functional Requirements → Security)
--   * "Financial actions (refunds, discounts, write-offs, PO approval) keep a full
--     audit trail for Revenue Assurance and, ultimately, statutory audit."
--     (Non-Functional Requirements → Compliance & audit)
--
-- So: one table, written by one helper (src/server/audit.ts), for both surfaces —
-- request_source records which, and `intent` carries the chatbot's raw intent once
-- that layer exists. Both nullable columns are the spec's own ChatbotAuditLog shape
-- ("intent, role, before/after state").

create table if not exists audit_log (
  -- bigint identity, not uuid: the log is read in time order and a monotonic key
  -- makes "what happened after X" cheap.
  id              bigint generated always as identity primary key,
  created_at      timestamptz not null default now(),

  -- Tenant context. App-layer actions (onboarding a chain) have a chain_id but no
  -- site_id; an action that precedes a chain existing has neither.
  chain_id        uuid references chain (id) on delete restrict,
  site_id         uuid references site (id) on delete restrict,

  -- "who, role" — the actor's role code and layer are copied in rather than
  -- referenced, so the log still reads correctly after a person changes role or
  -- leaves the company.
  actor_user_id     uuid references "user" (id) on delete restrict,
  actor_role_code   text not null,
  actor_scope       text not null check (actor_scope in ('app', 'central', 'site')),

  action          text not null,          -- the permission/tool code that authorised the call
  entity_type     text not null,
  entity_id       text,
  before_state    jsonb,
  after_state     jsonb,
  outcome         text not null default 'success'
                  check (outcome in ('success', 'denied', 'error')),
  reason          text,

  -- Chatbot-side fields (null for screen/api calls).
  intent          text,
  request_source  text not null default 'api'
                  check (request_source in ('screen', 'chatbot', 'api', 'system')),

  session_id      uuid,
  request_id      text
);

create index if not exists audit_log_chain_time_idx on audit_log (chain_id, created_at desc);
create index if not exists audit_log_actor_time_idx on audit_log (actor_user_id, created_at desc);
create index if not exists audit_log_entity_idx on audit_log (entity_type, entity_id);
create index if not exists audit_log_action_time_idx on audit_log (action, created_at desc);

-- Append-only enforcement. The compliance requirement is a *trail*, which is worth
-- nothing if rows can be edited after the fact, so the database refuses UPDATE and
-- DELETE outright. This is also why chain_id/site_id/actor_user_id above use
-- ON DELETE RESTRICT rather than SET NULL: a chain with audit history must be
-- off-boarded by status, never deleted, or the trail would have to be rewritten.
create or replace function audit_log_is_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_log is append-only (attempted %)', tg_op
    using errcode = 'check_violation';
end;
$$;

drop trigger if exists audit_log_no_update on audit_log;
create trigger audit_log_no_update
  before update or delete on audit_log
  for each row execute function audit_log_is_append_only();

-- ---------------------------------------------------------------------------
-- approval_task — the shared inbox the app shell renders.
-- Spec "Chatbot Interaction Model" (guardrails): "Maker-checker actions route the
-- confirmation card to the approver's own chatbot as an actionable item, not to the
-- requester — e.g. a Store-raised stock receipt appears in the site Revenue
-- Assurance Team's chat for sign-off". Phase 0a ships the table, the model and the
-- (empty-state) inbox; the modules that raise real items arrive with their modules.
-- ---------------------------------------------------------------------------
create table if not exists approval_task (
  id                  uuid primary key default gen_random_uuid(),
  chain_id            uuid not null references chain (id) on delete restrict,
  site_id             uuid references site (id) on delete restrict,
  -- maker-checker category: 'ra' | 'qa' | 'maintenance' | 'controls' | 'purchase' ...
  -- One ticket/approval model distinguished by category rather than one tracker per
  -- function (spec "Incident & Ticket Management").
  category            text not null,
  title               text not null,
  summary             text,
  entity_type         text not null,
  entity_id           text,
  payload             jsonb not null default '{}'::jsonb,
  raised_by_user_id   uuid not null references "user" (id) on delete restrict,
  raised_by_role_code text not null,
  -- Who must decide: a role code (e.g. CENTRAL_PURCHASE_HEAD, SITE_REVENUE_ASSURANCE_TEAM)
  -- and/or a specific person once routing has resolved one.
  assigned_role_code  text,
  assigned_user_id    uuid references "user" (id) on delete set null,
  status              text not null default 'open'
                      check (status in ('open', 'approved', 'rejected', 'cancelled')),
  -- Spec "Incident & Ticket Management": every ticket carries a severity-based SLA.
  due_at              timestamptz,
  decided_by_user_id  uuid references "user" (id) on delete set null,
  decided_at          timestamptz,
  decision_note       text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists approval_task_inbox_idx
  on approval_task (chain_id, assigned_role_code, status, created_at desc);
create index if not exists approval_task_assignee_idx
  on approval_task (assigned_user_id, status, created_at desc);
