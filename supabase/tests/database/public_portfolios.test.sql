begin;
select plan(10);

insert into auth.users (id, instance_id, aud, role, email) values
  ('11115555-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'portfolio-owner@cartlio.test'),
  ('11115555-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'portfolio-outsider@cartlio.test');

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '11115555-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select set_config('test.portfolio_tenant', public.create_workspace('Estúdio interno', 'piloto-portfolio-rls')::text, true);
select lives_ok($$select public.save_portfolio(current_setting('test.portfolio_tenant')::uuid,
  'Estúdio público', 'Apresentação pública', null, false)$$, 'Owner can save the draft');
select is((select display_name from public.photographer_portfolios where tenant_id = current_setting('test.portfolio_tenant')::uuid),
  'Estúdio público', 'Owner can read the draft');

select set_config('request.jwt.claim.sub', '11115555-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true);
select is((select count(*) from public.photographer_portfolios where tenant_id = current_setting('test.portfolio_tenant')::uuid),
  0::bigint, 'Another workspace cannot read the draft');
select throws_ok($$select public.save_portfolio(current_setting('test.portfolio_tenant')::uuid,
  'Outro estúdio', '', null, true)$$, '42501', 'PORTFOLIO_EDIT_DENIED', 'Another user cannot publish this portfolio');
select throws_ok($$select public.set_portfolio_photo(current_setting('test.portfolio_tenant')::uuid,
  '11115555-cccc-4ccc-8ccc-cccccccccccc', true)$$, '42501', 'PORTFOLIO_EDIT_DENIED', 'Another user cannot add a photo');

set local role anon;
select set_config('request.jwt.claim.role', 'anon', true);
select is(public.get_public_portfolio('piloto-portfolio-rls'), null::jsonb, 'An anonymous visitor cannot read the draft');
select throws_ok($$select public.resolve_public_portfolio_image('piloto-portfolio-rls',
  '11115555-cccc-4ccc-8ccc-cccccccccccc')$$, '42501', null, 'An anonymous caller cannot ask for an object key');

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '11115555-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select throws_ok($$select public.set_portfolio_photo(current_setting('test.portfolio_tenant')::uuid,
  '11115555-cccc-4ccc-8ccc-cccccccccccc', true)$$, '22023', 'PORTFOLIO_PHOTO_INVALID', 'Owner cannot select an unknown photo');
select lives_ok($$select public.save_portfolio(current_setting('test.portfolio_tenant')::uuid,
  'Estúdio público', 'Apresentação pública', null, true)$$, 'Owner can publish the portfolio');

set local role anon;
select set_config('request.jwt.claim.role', 'anon', true);
select is(public.get_public_portfolio('piloto-portfolio-rls'),
  '{"display_name":"Estúdio público","bio":"Apresentação pública","contact_email":null,"photo_ids":[]}'::jsonb,
  'Public payload contains only published fields');

select * from finish();
rollback;
