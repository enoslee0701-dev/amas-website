-- ============================================================
-- 0007_actor_fk_policy · SEC-3 验收发现问题修复
-- 问题：teacher_invitations.created_by / user_roles.granted_by /
--       teacher_verification_requests.reviewed_by 等「操作者」外键无删除策略（默认 NO ACTION），
--       导致删除账号时被历史记录阻塞——数据保留权与个人数据删除权（§17.4）冲突。
-- 处理原则：
--   * 「归属者」外键（本人数据）保持 ON DELETE CASCADE；
--   * 「操作者」外键改为 ON DELETE SET NULL —— 账号可删除，历史记录与审计仍保留，
--     操作者字段置空（审计表本就不设外键，历史事实不丢失）。
-- ============================================================

-- user_roles.granted_by
alter table public.user_roles drop constraint if exists user_roles_granted_by_fkey;
alter table public.user_roles
  add constraint user_roles_granted_by_fkey
  foreign key (granted_by) references public.profiles(id) on delete set null;

-- login_aliases.created_by
alter table public.login_aliases drop constraint if exists login_aliases_created_by_fkey;
alter table public.login_aliases
  add constraint login_aliases_created_by_fkey
  foreign key (created_by) references public.profiles(id) on delete set null;

-- teacher_invitations.created_by（原为 NOT NULL，放宽以支持置空）
alter table public.teacher_invitations alter column created_by drop not null;
alter table public.teacher_invitations drop constraint if exists teacher_invitations_created_by_fkey;
alter table public.teacher_invitations
  add constraint teacher_invitations_created_by_fkey
  foreign key (created_by) references public.profiles(id) on delete set null;

-- teacher_verification_requests.reviewed_by
alter table public.teacher_verification_requests drop constraint if exists teacher_verification_requests_reviewed_by_fkey;
alter table public.teacher_verification_requests
  add constraint teacher_verification_requests_reviewed_by_fkey
  foreign key (reviewed_by) references public.profiles(id) on delete set null;

-- teacher_verification_internal.updated_by（原无外键约束，补齐并置空策略）
do $$ begin
  alter table public.teacher_verification_internal
    add constraint tvi_updated_by_fkey
    foreign key (updated_by) references public.profiles(id) on delete set null;
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.teacher_profiles_internal
    add constraint tpi_updated_by_fkey
    foreign key (updated_by) references public.profiles(id) on delete set null;
exception when duplicate_object then null; end $$;

comment on constraint teacher_invitations_created_by_fkey on public.teacher_invitations is
  'SEC-3：操作者引用，账号删除时置空，历史邀请记录保留（审计不受影响）。';
