-- Canonical activity/MFA checks and invitation/audit write in one transaction.
-- The Edge passes the validated caller JWT; no client-supplied actor parameter.
create or replace function public.create_teacher_invitation(
 p_email text,p_token_hash text,p_expected_name text default '',p_staff_number text default null,p_days int default 14)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); invitation uuid; expiry timestamptz;
begin
 if actor is null or not (public.has_active_role(actor,'academic_admin') or public.has_active_role(actor,'super_admin')) then
  raise exception using errcode='42501',message='forbidden';
 end if;
 if not public.request_is_aal2() then raise exception using errcode='42501',message='mfa_required';end if;
 if p_email is null or length(p_email)>190 or p_email!~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  or p_token_hash is null or p_token_hash!~'^[A-Za-z0-9_-]{43}$' or p_days is null or p_days not between 1 and 60 then
  return jsonb_build_object('ok',false,'error','validation_failed');
 end if;
 expiry:=now()+p_days*interval '1 day';
 insert into public.teacher_invitations(email_normalized,expected_name,staff_number,token_hash,expires_at,created_by)
 values(lower(btrim(p_email)),left(coalesce(p_expected_name,''),80),left(p_staff_number,40),p_token_hash,expiry,actor) returning id into invitation;
 insert into public.audit_logs(actor_id,event_type,target_type,target_id,category,new_value)
 values(actor,'teacher_invitation_created','teacher_invitations',invitation::text,'academic',jsonb_build_object('email',lower(btrim(p_email)),'expires_at',expiry));
 return jsonb_build_object('ok',true,'id',invitation,'expires_at',expiry);
end $$;
revoke all on function public.create_teacher_invitation(text,text,text,text,int) from public,anon;
grant execute on function public.create_teacher_invitation(text,text,text,text,int) to authenticated;
