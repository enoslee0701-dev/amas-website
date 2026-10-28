-- 总览「待办提醒」（Enos 2026-10-28）：哪些学员还在用统一发的初始密码。
-- 只回姓名与班级，不回账号、邮箱或任何密码相关内容；教务 / 教学主管 / 系统管理员 + 现行 MFA 开关。
create or replace function public.admin_initial_password_list()
returns table(name text, cohort text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.is_admin_any(auth.uid()) or not public.request_is_aal2() then
    raise exception using errcode = '42501', message = 'initial_password_list_forbidden';
  end if;
  return query
    select s.name, s.cohort from public.submissions s
      join auth.users u on u.id = s.student_user_id
     where s.type = 'application'
       and coalesce(u.raw_user_meta_data->>'must_change_password', '') = 'true'
     order by s.cohort, s.created_at, s.id;
end $$;
revoke all on function public.admin_initial_password_list() from public, anon;
grant execute on function public.admin_initial_password_list() to authenticated;
