begin;
select no_plan();

insert into auth.users (id, instance_id, aud, role, email) values
  ('88888888-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'fotografo@cartlio.test');
insert into public.tenants (id, slug, name, created_by) values
  ('88888888-8888-4888-8888-888888888888', 'notifications-a', 'Notifications A', '88888888-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
insert into public.tenant_members (tenant_id, user_id, role) values
  ('88888888-8888-4888-8888-888888888888', '88888888-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'owner');
insert into public.customers (id, tenant_id, name, email) values
  ('88888888-0000-4000-8000-000000000001', '88888888-8888-4888-8888-888888888888', 'Cliente da galeria', 'cliente@cartlio.test');
insert into public.galleries (id, tenant_id, customer_id, title, slug, status) values
  ('88888888-0000-4000-8000-000000000002', '88888888-8888-4888-8888-888888888888', '88888888-0000-4000-8000-000000000001', 'Ensaio de teste', 'ensaio-notificacoes', 'published');
insert into public.photos (id, tenant_id, gallery_id, object_path, original_filename, content_type, byte_size, created_by, processing_status) values
  ('88888888-0000-4000-8000-000000000003', '88888888-8888-4888-8888-888888888888', '88888888-0000-4000-8000-000000000002', '88888888-8888-4888-8888-888888888888/88888888-0000-4000-8000-000000000002/88888888-0000-4000-8000-000000000003.png', 'foto.png', 'image/png', 128, '88888888-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'ready');

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '88888888-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select set_config('test.notification_token', public.create_gallery_share(
  '88888888-8888-4888-8888-888888888888', '88888888-0000-4000-8000-000000000002', now() + interval '7 days', 10, 'selection'), true);
reset role;
select set_config('test.notification_share_id', (
  select id::text from public.gallery_shares where token_hash = extensions.digest(current_setting('test.notification_token'), 'sha256')
), true);

set local role anon;
select set_config('request.jwt.claim.role', 'anon', true);
select is(public.set_gallery_selection(current_setting('test.notification_token'), '88888888-0000-4000-8000-000000000003', true), 1, 'Client can select a ready photo');
reset role;
update private.gallery_share_selection_rate_limits set window_started_at = clock_timestamp(), request_count = 300,
  updated_at = clock_timestamp() where share_id = current_setting('test.notification_share_id')::uuid;
set local role anon;
select set_config('request.jwt.claim.role', 'anon', true);
select throws_ok($$select public.submit_gallery_selection(current_setting('test.notification_token'), 'Cliente da galeria')$$,
  'PT429', 'SELECTION_RATE_LIMITED', 'Selection submission is covered by the per-link rate limit');
reset role;
update private.gallery_share_selection_rate_limits set window_started_at = clock_timestamp() - interval '61 seconds',
  request_count = 300, updated_at = clock_timestamp() - interval '61 seconds'
  where share_id = current_setting('test.notification_share_id')::uuid;
set local role anon;
select set_config('request.jwt.claim.role', 'anon', true);
select is(public.submit_gallery_selection(current_setting('test.notification_token'), 'Cliente da galeria'), true, 'Client submits the selection');
select is(public.submit_gallery_selection(current_setting('test.notification_token'), 'Cliente da galeria'), true, 'Selection submission is retry-safe');
reset role;

select is((select count(*)::integer from public.gallery_notification_outbox where notification_type = 'selection_submitted'), 1, 'A submitted selection creates one notification');
select is((select recipient_email from public.gallery_notification_outbox where notification_type = 'selection_submitted'), 'fotografo@cartlio.test', 'Selection notification is addressed to the workspace owner');
select is((select selected_count from public.gallery_notification_outbox where notification_type = 'selection_submitted'), 1, 'Selection notification contains only the selected photo count');
select is((select message is null from public.gallery_notification_outbox where notification_type = 'selection_submitted'), true, 'Selection notification does not include client PIN or link token');

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '88888888-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select is(public.request_gallery_selection_revision(
  '88888888-8888-4888-8888-888888888888', '88888888-0000-4000-8000-000000000002',
  current_setting('test.notification_share_id')::uuid, 'Revise a foto principal.'), true, 'Photographer requests changes');
select is((select delivery_state from public.gallery_notification_status(
  '88888888-8888-4888-8888-888888888888', '88888888-0000-4000-8000-000000000002'
  ) where notification_type = 'selection_submitted'), 'queued', 'Workspace member can see the safe queued status for a submitted selection');
select is((select delivery_state from public.gallery_notification_status(
  '88888888-8888-4888-8888-888888888888', '88888888-0000-4000-8000-000000000002'
  ) where notification_type = 'selection_revision_requested'), 'queued', 'Workspace member can see the safe queued status for a revision request');
select throws_ok($$select * from public.gallery_notification_outbox$$, '42501', null, 'Authenticated users cannot read queued notification addresses or messages');
select throws_ok($$select public.claim_gallery_notifications()$$, '42501', null, 'Authenticated users cannot claim queued notifications');
select set_config('request.jwt.claim.sub', '99999999-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select throws_ok($$select * from public.gallery_notification_status(
  '88888888-8888-4888-8888-888888888888', '88888888-0000-4000-8000-000000000002')$$,
  '42501', 'NOTIFICATION_STATUS_DENIED', 'Non-members cannot read notification delivery statuses');
select throws_ok($$select public.retry_failed_gallery_notification(
  '88888888-8888-4888-8888-888888888888', '88888888-0000-4000-8000-000000000002',
  current_setting('test.notification_share_id')::uuid, 'selection_revision_requested')$$,
  '42501', 'NOTIFICATION_RETRY_DENIED', 'Non-members cannot retry gallery notifications');
select set_config('request.jwt.claim.sub', '88888888-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
reset role;

select is((select count(*)::integer from public.gallery_notification_outbox where notification_type = 'selection_revision_requested'), 1, 'A revision request creates a customer notification');
select is((select recipient_email from public.gallery_notification_outbox where notification_type = 'selection_revision_requested'), 'cliente@cartlio.test', 'Revision notification uses the linked customer email');
select is((select message from public.gallery_notification_outbox where notification_type = 'selection_revision_requested'), 'Revise a foto principal.', 'Revision notification contains the photographer instruction');
select is((select count(*)::integer from public.gallery_notification_outbox where share_id = current_setting('test.notification_share_id')::uuid), 2, 'The queue contains one event for each completed workflow action');

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select is((select count(*)::integer from public.claim_gallery_notifications(10, current_setting('test.notification_share_id')::uuid, null)), 2, 'Service worker atomically claims the share notifications');
select is((select bool_and(attempts = 1 and claimed_at is not null) from public.gallery_notification_outbox where share_id = current_setting('test.notification_share_id')::uuid), true, 'Claiming increments attempt count and assigns a lease');
select is(public.finish_gallery_notification((select id from public.gallery_notification_outbox where notification_type = 'selection_submitted'), true), true, 'Worker marks a delivered message as sent');
select is(public.finish_gallery_notification((select id from public.gallery_notification_outbox where notification_type = 'selection_revision_requested'), false, 'smtp_send_failed'), true, 'Worker schedules a safe retry after SMTP failure');
select throws_ok($$select public.prune_gallery_notification_outbox(29)$$, '22023', 'NOTIFICATION_RETENTION_INVALID', 'Notification retention stays within safe bounds');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '88888888-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select is((select delivery_state from public.gallery_notification_status(
  '88888888-8888-4888-8888-888888888888', '88888888-0000-4000-8000-000000000002'
  ) where notification_type = 'selection_submitted'), 'sent', 'Photographer can see when the submission email was sent');
select is((select delivery_state from public.gallery_notification_status(
  '88888888-8888-4888-8888-888888888888', '88888888-0000-4000-8000-000000000002'
  ) where notification_type = 'selection_revision_requested'), 'retry_wait', 'Photographer can see that a failed email will be retried');
reset role;

select is((select sent_at is not null and claimed_at is null and last_error_code is null from public.gallery_notification_outbox where notification_type = 'selection_submitted'), true, 'Successful delivery clears the lease and error state');
select is((select sent_at is null and claimed_at is null and last_error_code = 'smtp_send_failed' and available_at > now() from public.gallery_notification_outbox where notification_type = 'selection_revision_requested'), true, 'Failed delivery remains queued for retry without saving provider details');
update public.gallery_notification_outbox set attempts = 5, claimed_at = now() where notification_type = 'selection_revision_requested';
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select is(public.finish_gallery_notification((select id from public.gallery_notification_outbox where notification_type = 'selection_revision_requested'), false, 'smtp_send_failed'), true, 'The final failed attempt is recorded');
select is(public.prune_gallery_notification_outbox(90), 0, 'Retention leaves recent completed notices available');
reset role;
select is((select failed_at is not null and attempts = 5 and last_error_code = 'max_attempts' from public.gallery_notification_outbox where notification_type = 'selection_revision_requested'), true, 'A fifth failure is moved out of the retry queue');
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '88888888-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select is((select delivery_state from public.gallery_notification_status(
  '88888888-8888-4888-8888-888888888888', '88888888-0000-4000-8000-000000000002'
  ) where notification_type = 'selection_revision_requested'), 'failed', 'Photographer can see when an email reached its retry limit');
select is((select manual_retry_count from public.gallery_notification_status(
  '88888888-8888-4888-8888-888888888888', '88888888-0000-4000-8000-000000000002'
  ) where notification_type = 'selection_revision_requested'), 0, 'Notification status exposes the bounded manual retry count');
select throws_ok($$select public.retry_failed_gallery_notification(
  '88888888-8888-4888-8888-888888888888', '88888888-0000-4000-8000-000000000002',
  current_setting('test.notification_share_id')::uuid, 'selection_submitted')$$,
  '42501', 'NOTIFICATION_RETRY_UNAVAILABLE', 'A stale submission notice cannot be retried while the client is revising');
reset role;
update public.customers set email = 'cliente-atualizado@cartlio.test'
  where tenant_id = '88888888-8888-4888-8888-888888888888'
    and id = '88888888-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '88888888-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select is(public.retry_failed_gallery_notification(
  '88888888-8888-4888-8888-888888888888', '88888888-0000-4000-8000-000000000002',
  current_setting('test.notification_share_id')::uuid, 'selection_revision_requested'), true,
  'Workspace member can manually retry a permanently failed current revision email');
reset role;
select is((select recipient_email from public.gallery_notification_outbox where notification_type = 'selection_revision_requested'),
  'cliente-atualizado@cartlio.test', 'Manual retry uses the current customer email');
select is((select attempts = 0 and manual_retry_count = 1 and failed_at is null and claimed_at is null
  and last_error_code is null and available_at <= clock_timestamp()
  from public.gallery_notification_outbox where notification_type = 'selection_revision_requested'),
  true, 'Manual retry safely returns the event to the queue and records its retry count');
update public.gallery_notification_outbox set attempts = 5, claimed_at = null,
  failed_at = clock_timestamp(), last_error_code = 'max_attempts'
  where notification_type = 'selection_revision_requested';
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '88888888-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select is(public.retry_failed_gallery_notification(
  '88888888-8888-4888-8888-888888888888', '88888888-0000-4000-8000-000000000002',
  current_setting('test.notification_share_id')::uuid, 'selection_revision_requested'), true,
  'A second bounded manual retry is available after another permanent failure');
reset role;
update public.gallery_notification_outbox set attempts = 5, claimed_at = null,
  failed_at = clock_timestamp(), last_error_code = 'max_attempts'
  where notification_type = 'selection_revision_requested';
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '88888888-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select throws_ok($$select public.retry_failed_gallery_notification(
  '88888888-8888-4888-8888-888888888888', '88888888-0000-4000-8000-000000000002',
  current_setting('test.notification_share_id')::uuid, 'selection_revision_requested')$$,
  '22023', 'NOTIFICATION_RETRY_LIMIT', 'Manual retry cannot be used more than twice for one notification');
reset role;
update public.gallery_notification_outbox set sent_at = now() - interval '91 days' where notification_type = 'selection_submitted';
update public.gallery_notification_outbox set failed_at = now() - interval '91 days' where notification_type = 'selection_revision_requested';
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select is(public.prune_gallery_notification_outbox(90), 2, 'Retention removes sent and permanently failed notices after 90 days');
reset role;
select is((select count(*)::integer from public.gallery_notification_outbox), 0, 'Pruned notices no longer retain recipient details');

select * from finish();
rollback;
