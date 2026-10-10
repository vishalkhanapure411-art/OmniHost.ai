-- The approver split (migration 0019) moved everyday master-data approval off
-- CENTRAL_MDM_HEAD onto CENTRAL_MDM_APPROVER. A task that was still OPEN at that moment
-- kept its old `assigned_role_code`, and routing follows that column: the approver's queue
-- is scoped by the caller's role codes (inbox.ts), and CENTRAL_MDM_HEAD no longer holds
-- `mdm.article.approve`. So a task left assigned to the head is invisible to the approver
-- and un-decidable by the head — the operator's queue is broken for it.
--
-- This re-routes every still-open MDM review task from the retired office to the function's
-- approver role. It is scoped to `category = 'mdm'` (the only implemented approval path) and
-- `status = 'open'`: decided tasks are history — the head was legitimately the approver when
-- they were decided, and rewriting their routing would falsify the ledger's own record.
--
-- `raised_by_role_code` is deliberately left alone: who raised a task is a historical fact,
-- not a routing decision, and the queue renders it as such.
update approval_task
   set assigned_role_code = 'CENTRAL_MDM_APPROVER',
       updated_at = now()
 where status = 'open'
   and category = 'mdm'
   and assigned_role_code = 'CENTRAL_MDM_HEAD';
