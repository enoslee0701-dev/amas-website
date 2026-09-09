-- ══════════════════════════════════════════════════════════════════════
-- PROGRAM_CATALOG 数据级恢复工具  ·  STAGING-1A8
-- ══════════════════════════════════════════════════════════════════════
--
-- ★★ 这个文件会写数据库。它刻意**不**放在 supabase/tests/ 下，
--    以免与那批纯 SELECT 探针混淆而被误运行。
--
-- 保险丝：不显式传 -v i_understand_this_writes=YES 就整体中止。
--
-- 用法：
--   1) 先取快照（只读）：
--        pg_dump "$URL" --data-only --column-inserts -t public.program_catalog -f snap.sql
--   2) 把快照改写到临时表（确定性文本替换，不改任何值）：
--        sed 's/INSERT INTO public\.program_catalog /INSERT INTO pg_temp.pc_restore /' \n--            snap.sql > snap_tmp.sql
--        ★ 必须写成 pg_temp.pc_restore：pg_dump 的 data-only 输出开头有
--          set_config('search_path','',false)，不加限定名会找不到临时表。
--   3) 恢复：
--        psql "$URL" -v i_understand_this_writes=YES \
--             -v snap=snap_tmp.sql -v disable_trigger=NO -f 本文件
--
-- disable_trigger 的意义见文件尾部「updated_at 的不可还原性」。
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
\if :{?disable_trigger}
\else
  \set disable_trigger 'NO'
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

-- ── 4. 触发器模式声明（仅报告，不在此文件内执行任何 DDL）─────────────
select case when :'disable_trigger' = 'YES'
            then 'DISABLE-TRIGGER MODE 需由调用方自行授权并执行，本文件不代劳'
            else 'trigger 保持启用：updated_at 将被刷新为 now()，业务 9 列可精确还原'
       end as trigger_mode;

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

-- ── 6. 事后断言：业务字段必须与快照逐行相同 ───────────────────────────
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
    raise exception '恢复后业务字段仍与快照不符：%', bad;
  end if;
end $$;

commit;

-- ══════════════════════════════════════════════════════════════════════
-- updated_at 的不可还原性
--
-- program_catalog_set_updated_at 是 BEFORE UPDATE FOR EACH ROW，
-- 无条件执行 new.updated_at = now()。它会覆盖本工具第 5 步写入的旧值。
-- 因此在触发器启用时：
--   业务字段（9 列）  可以逐字段精确还原
--   updated_at        不可还原，恢复后为 now()
--   created_at        可以还原（触发器不碰它）
--
-- 要连 updated_at 一起还原，只有两条路，都需要额外授权：
--   ① alter table public.program_catalog disable trigger
--        program_catalog_set_updated_at;   —— 这是 DDL
--   ② set session_replication_role = 'replica';  —— 需要相应权限
-- 两者都不在 STAGING-1A8 的授权范围内，故本文件不内置执行，
-- 只把事实写清楚。
-- ══════════════════════════════════════════════════════════════════════
