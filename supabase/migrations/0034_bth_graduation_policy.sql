-- ============================================================
-- 0034_bth_graduation_policy · B.Th 毕业条件定案（Enos 2026-10-23）
--   · 不设 GPA 门槛，以修满 77 学分为准（GPA 照常计算与显示，不参与毕业判定）
--   · 外校转入学分不设上限
--   · 成绩单由 AMAS 神学院·清迈教学中心出具（分校对学士班有出具权；文字在前端，此处只记决定）
-- ============================================================

update public.program_catalog set min_gpa = null, max_transfer_credits = null where code = 'bth';

comment on column public.program_catalog.min_gpa is
  '毕业平均绩点门槛；null = 不设。B.Th 经 Enos 2026-10-23 决定不设，以修满 77 学分为准。';
comment on column public.program_catalog.max_transfer_credits is
  '外校转入学分上限；null = 不设。B.Th 经 Enos 2026-10-23 决定不设上限。';
