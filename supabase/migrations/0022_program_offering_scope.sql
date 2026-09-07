-- ============================================================
-- 0022_program_offering_scope · 收窄对外开放申请的项目范围
--
-- 决策（2026-09-04，甲方指示）：申请入口暂时只保留四个学位项目；
-- 证书与装备类五项「先撤走」，日后可能恢复。
--
-- ★ 用 is_open_for_application 开关，**不删除 program_catalog 行**：
--   1. 已提交的申请通过 program code 外引这些行，删行会破坏历史记录；
--   2. 「先撤走」是暂时状态，翻回 true 即可恢复，无需重建数据；
--   3. D-2 一致性守卫（program_catalog_consistency.mjs）比对的是
--      **开放项目**清单与官网下拉，故翻开关即可保持两侧一致。
--
-- ★ dmin 同时更名：对外只呈现「教牧学博士 D.Min」，不再并列宣教学博士。
--   这是**呈现范围收窄**，不是新增或删除项目 —— 该 code 仍是同一行。
-- ============================================================

update public.program_catalog
   set is_open_for_application = false
 where code in ('laycert','pdip','pastor','preaching','missionary');

update public.program_catalog
   set name_zh = '教牧学博士',
       name_en = 'Doctor of Ministry'
 where code = 'dmin';

-- 幂等性与结果自检：开放项目必须恰好是这四个，且顺序与官网下拉一致
do $$
declare open_codes text[];
begin
  select array_agg(code order by sort_order) into open_codes
    from public.program_catalog where is_open_for_application;
  if open_codes is distinct from array['bth','gdip','mdiv','dmin']::text[] then
    raise exception '开放项目清单不符合预期，实际为 %', open_codes;
  end if;
end $$;
