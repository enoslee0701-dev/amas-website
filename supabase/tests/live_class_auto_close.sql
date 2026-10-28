begin;
do $$
declare u uuid:=gen_random_uuid();r jsonb;
begin
 insert into auth.users(id,email,email_confirmed_at) values(u,'live-stu@example.invalid',now());
 update public.site_settings set value=jsonb_build_object('enabled',true,'allow_guests',true,'url','https://zoom.us/j/1','close_at',now()+interval '3 hours') where key='live_class';
 if not (public.site_public()#>>'{live_class,enabled}')::boolean then raise exception 'L01 open class hidden from site';end if;
 perform set_config('amas.test.uid',u::text,true);perform set_config('request.jwt.claims',jsonb_build_object('sub',u)::text,true);
 execute 'set local role authenticated';
 if public.portal_board()#>>'{live_class,url}'<>'https://zoom.us/j/1' then raise exception 'L02 open class hidden from portal';end if;
 execute 'reset role';
 update public.site_settings set value=value||jsonb_build_object('close_at',now()-interval '1 minute') where key='live_class';
 r:=public.site_public()->'live_class';if (r->>'enabled')::boolean or r ? 'url' then raise exception 'L03 expired class still public %',r;end if;
 execute 'set local role authenticated';
 r:=public.portal_board()->'live_class';if (r->>'enabled')::boolean or r ? 'url' then raise exception 'L04 expired class still in portal %',r;end if;
 execute 'reset role';
 update public.site_settings set value=value-'close_at' where key='live_class';
 if not (public.site_public()#>>'{live_class,enabled}')::boolean then raise exception 'L05 no close_at should stay open';end if;
 update public.site_settings set value=value||'{"allow_guests":false}' where key='live_class';
 if (public.site_public()#>>'{live_class,enabled}')::boolean then raise exception 'L06 guests off must hide from site';end if;
 raise notice 'LIVE CLASS SQL: 6 PASS';
end $$;
rollback;
