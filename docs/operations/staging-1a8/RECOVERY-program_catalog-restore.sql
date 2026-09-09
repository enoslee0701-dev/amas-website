-- ══════════════════════════════════════════════════════════════════════
-- PROGRAM_CATALOG 数据级恢复工具  ·  STAGING-1A8
-- ══════════════════════════════════════════════════════════════════════
--
-- ★★ 这个文件会写数据库。它刻意**不**放在 supabase/tests/ 下，
--    以免与那批纯 SELECT 探针混淆而被误运行。
--
-- ★★ 它是「已备妥且已证明」的，但**不是预授权的自动写入**。
--    实际执行需要 Supervisor 的单独 rollback 授权。
--
-- 保险丝：不显式传 -v i_understand_this_writes=YES 就整体中止。
--
-- 用法：
--   1) 先取快照（只读）：
--        pg_dump "$URL" --data-only --column-inserts
--          -t public.program_catalog -f snap.sql
--   2) 把快照改写到临时表（确定性文本替换，不改任何值）：
--        sed 's/INSERT INTO public\.program_catalog /INSERT INTO pg_temp.pc_restore /'
--          snap.sql > snap_tmp.sql
--        ★ 必须写成 pg_temp.pc_restore：pg_dump 的 data-only 输出开头有
--          set_config('search_path','',false)，不加限定名会找不到临时表。
--   3) 恢复：
--        psql "$URL" -v i_understand_this_writes=YES -v snap=snap_tmp.sql -f 本文件
--
-- 恢复合同见文件尾部。本工具**只做 DML**，任何需要 DDL 的还原路径均被禁止。
-- ══════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

\if :{?i_understand_this_writes}
\else
  \echo '拒绝执行：缺少 -v i_understand_this_writes=YES'
  \quit
\endif
\if :{?snap}
\else
  \echo '拒绝执行：缺少 -v snap=<改写后的快照文件>'
  \quit
\endif

-- Supervisor FINAL GATE HARDENING：ROLLBACK DDL = FORBIDDEN。
-- 早期版本曾提供 disable_trigger 开关，现已作废。传入即拒绝执行。
\if :{?disable_trigger}
  \echo '拒绝执行：disable_trigger 已作废。恢复合同禁止 ALTER TABLE、'
  \echo '禁止 disable trigger、禁止 session_replication_role。'
  \echo 'updated_at 前进到回滚时刻是被接受的审计元数据，不需要还原。'
  \quit
\endif

begin;

-- ── 1. 表结构断言：列集合必须与快照制作时完全一致，否则拒绝恢复 ──────
do $$
declare actual text;
begin
  select string_agg(a.attname, ',' order by a.attnum) into actual
    from pg_attribute a
   where a.attrelid = 'public.program_catalog'::regclass
     and a.attnum > 0 and not a.attisdropped;
  if actual is distinct from
     'code,name_zh,name_en,short_label,category,sort_order,'
     'is_open_for_application,intake_note_zh,approved_at,created_at,updated_at'
  then
    raise exception '表结构已变化，拒绝恢复。实际列集合为 %', actual;
  end if;
end $$;

-- ── 2. 载入快照到临时表 ───────────────────────────────────────────────
create temp table pc_restore (like public.program_catalog including defaults)
  on commit drop;

\i :snap

-- ── 3. 键集合断言：快照与现表的 code 集合必须完全相同 ─────────────────
--     恢复只做 UPDATE，不 INSERT 也不 DELETE。若集合不同说明发生了
--     增行/删行，那已超出本工具的爆炸半径，必须停下来人工判断。
do $$
declare missing text; extra text;
begin
  select string_agg(code, ',' order by code) into missing
    from pc_restore where code not in (select code from public.program_catalog);
  select string_agg(code, ',' order by code) into extra
    from public.program_catalog where code not in (select code from pc_restore);
  if missing is not null then
    raise exception '快照中有现表不存在的 code：%（需要 INSERT，本工具不做）', missing;
  end if;
  if extra is not null then
    raise exception '现表有快照中不存在的 code：%（需要 DELETE，本工具不做）', extra;
  end if;
end $$;

-- ── 4. 恢复模式声明（本文件永不执行任何 DDL）─────────────────────────
select 'DML-ONLY：触发器保持启用。业务 9 列与 created_at 精确还原，'
       || 'updated_at 前进到回滚时刻（按恢复合同，这是可接受的审计元数据）'
       as recovery_mode;

-- ── 5. 恢复：只更新「与快照有差异」的行 ───────────────────────────────
--     IS DISTINCT FROM 守卫是必需的 —— 没有它，无差异的行也会被 UPDATE，
--     从而被 BEFORE UPDATE 触发器把 updated_at 刷成 now()，
--     等于恢复动作污染了本来无关的行。
update public.program_catalog t
   set name_zh                 = r.name_zh,
       name_en                 = r.name_en,
       short_label             = r.short_label,
       category                = r.category,
       sort_order              = r.sort_order,
       is_open_for_application = r.is_open_for_application,
       intake_note_zh          = r.intake_note_zh,
       approved_at             = r.approved_at,
       created_at              = r.created_at,
       updated_at              = r.updated_at
  from pc_restore r
 where t.code = r.code
   and (t.name_zh, t.name_en, t.short_label, t.category, t.sort_order,
        t.is_open_for_application, t.intake_note_zh, t.approved_at,
        t.created_at, t.updated_at)
       is distinct from
       (r.name_zh, r.name_en, r.short_label, r.category, r.sort_order,
        r.is_open_for_application, r.intake_note_zh, r.approved_at,
        r.created_at, r.updated_at);

-- ── 6. 事后断言：业务 9 列 + created_at 必须与快照逐行相同 ────────────
--     created_at 按恢复合同是 MUST REMAIN EXACT，故与业务列一同硬断言。
--     updated_at 不在此列 —— 合同允许它前进到回滚时刻。
do $$
declare bad text;
begin
  select string_agg(t.code, ',' order by t.code) into bad
    from public.program_catalog t join pc_restore r on r.code = t.code
   where (t.name_zh, t.name_en, t.short_label, t.category, t.sort_order,
          t.is_open_for_application, t.intake_note_zh, t.approved_at, t.created_at)
         is distinct from
         (r.name_zh, r.name_en, r.short_label, r.category, r.sort_order,
          r.is_open_for_application, r.intake_note_zh, r.approved_at, r.created_at);
  if bad is not null then
    raise exception '恢复后业务列或 created_at 仍与快照不符：%', bad;
  end if;
end $$;

commit;

-- ══════════════════════════════════════════════════════════════════════
-- 恢复合同（Supervisor FINAL GATE HARDENING 裁定，STAGING-1A8 §1）
--
--   业务 9 列   EXACTLY RESTORABLE       —— 已由破坏性沙箱行级对拍证明
--   created_at  MUST REMAIN EXACT        —— 触发器不碰它，本工具原样写回
--   updated_at  MAY ADVANCE TO ROLLBACK TIME
--                                        —— 可接受的审计元数据，不需还原
--
-- 因此 no-hosted-backup 例外**仅限 DML**。以下路径一律 NOT AUTHORIZED：
--   x  alter table public.program_catalog disable trigger ...   （DDL）
--   x  任何其它 ALTER TABLE
--   x  set session_replication_role = 'replica'
-- 前两条在本地沙箱确实能让 updated_at 也精确还原，但按裁定不得使用。
-- 第三条在 live 本就不可行（postgres 非 superuser，
-- 且 pg_parameter_acl 中没有 session_replication_role 条目）。
--
-- 机理：program_catalog_set_updated_at 是 BEFORE UPDATE FOR EACH ROW，
-- 函数体只有 new.updated_at = now()。它只影响同表同行，不写任何其它表。
-- ══════════════════════════════════════════════════════════════════════
