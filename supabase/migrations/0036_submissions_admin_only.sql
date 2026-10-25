-- ============================================================
-- 0036_submissions_admin_only · 官网报名收件箱只给教务看
--
-- 0001 的 submissions 策略是 `for select to authenticated using (true)`：任何登录用户都能读全部报名。
-- 2026-10-26 线上网站接上测试库并开放注册后，这等于任何人注册一个账号就能看到所有报名人的姓名与联系方式。
-- 改为只有 registrar / academic_admin / super_admin 可读、可改状态与备注；访客匿名提交（anon insert）不变。
-- ============================================================

drop policy if exists auth_select on public.submissions;
create policy auth_select on public.submissions
  for select to authenticated using (public.is_admin_any(auth.uid()));

drop policy if exists auth_update on public.submissions;
create policy auth_update on public.submissions
  for update to authenticated
  using (public.is_admin_any(auth.uid())) with check (public.is_admin_any(auth.uid()));

-- 匿名访客只能写入、不能回读（PostgREST 的 return=representation 也读不到）
revoke select, update, delete on public.submissions from anon;
