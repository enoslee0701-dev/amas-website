-- ============================================================
-- 0039 · 官网提交去重 + 「账号名」登录别名
--
-- 1) 2026-10-26 起官网先写库再发邮件（邮件失败也不丢报名）。邮件失败后访客重交会再写一次，
--    前端按内容算 data.dedupeKey；这里让同一指纹只能存一条，重复的 insert 得到 409，前端静默忽略。
-- 2) Enos 2026-10-26：学员账号统一用「姓名拼音 + 2026」登录（例 zhaijinli2026）。
--    login_aliases 原只有学号 / 教职工号两类，加一类 username；login-by-identifier 按别名查号，无需改。
-- ============================================================

create unique index if not exists submissions_dedupe_key
  on public.submissions ((data->>'dedupeKey'))
  where data ? 'dedupeKey';

alter type alias_type add value if not exists 'username';
