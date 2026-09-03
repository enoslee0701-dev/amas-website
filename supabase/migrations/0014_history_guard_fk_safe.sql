-- ============================================================
-- 0014_history_guard_fk_safe · PORTAL-2 验收发现的真实缺陷修复
--
-- 缺陷：0012 给 student_status_history 加了 append-only 触发器（拦截 UPDATE 与 DELETE）。
--       但 actor_id 的外键是 ON DELETE SET NULL（0007 既定策略），注销账号时数据库会对
--       历史行发出 UPDATE ... SET actor_id = NULL，被触发器挡下；同理 student_id 的
--       ON DELETE CASCADE 发出的 DELETE 也被挡下。
--       结果：只要某人在学籍流程里留过痕，其账号就永远删不掉——
--       这正是 0007 当初修掉的那类问题，被新触发器重新引入了。
--
-- 修复：
--   1. 触发器只管 UPDATE，且放行"仅把 actor_id 置空、其余字段一字未改"的外键维护更新；
--      任何真正改写历史内容的 UPDATE 仍然被拒。
--   2. DELETE 不再由触发器拦截——客户端本来就没有 delete 权限
--      （0012 已 revoke all，只按列 grant select），级联清理交给外键。
--      这与 PORTAL-1 的 application_status_history 保持一致。
--
-- 结论：对客户端仍是严格 append-only（无 insert/update/delete 权限），
--       对数据库自身的引用完整性维护则不再误伤。
-- ============================================================

create or replace function public.append_only_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- 放行：账号注销时外键 ON DELETE SET NULL 造成的 actor_id 置空
  if tg_op = 'UPDATE'
     and old.actor_id is not null and new.actor_id is null
     and new.student_id              is not distinct from old.student_id
     and new.from_status             is not distinct from old.from_status
     and new.to_status               is not distinct from old.to_status
     and new.actor_role              is not distinct from old.actor_role
     and new.student_visible_message is not distinct from old.student_visible_message
     and new.internal_note           is not distinct from old.internal_note
     and new.created_at              is not distinct from old.created_at
  then
    return new;
  end if;
  raise exception 'history is append-only';
end $$;

comment on function public.append_only_guard is
  '历史表写保护（0014）：拒绝一切改写历史内容的 UPDATE，但放行外键 ON DELETE SET NULL 的 actor_id 置空；DELETE 交由外键级联，客户端本就无删除权限。';

-- 只保留 UPDATE 触发器；DELETE 由级联负责
drop trigger if exists ssh_append_only on public.student_status_history;
create trigger ssh_append_only before update on public.student_status_history
  for each row execute function public.append_only_guard();
