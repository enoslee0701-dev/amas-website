-- ============================================================
-- 0010_program_catalog · 招生项目权威目录（D-2 决议）
-- 决议：不再由官网 / Portal / Word 表各自维护 hard-coded 项目列表；
--       本表为 canonical source，其他三处引用或由此导出。
-- 边界：招生「项目」≠ 教学「课程」。67 门课程目录不进入本表。
-- 授权：任何人可读（招生公开信息）；仅 service_role 可写（政策变更留痕）。
-- ============================================================

create table if not exists public.program_catalog (
  code            text primary key,              -- 稳定键，与官网 i18n key 一致
  name_zh         text not null,
  name_en         text not null,
  short_label     text,                          -- B.Th / G.Dip / M.Div …
  category        text not null,                 -- degree | certificate | equipping
  sort_order      int  not null default 100,
  is_open_for_application boolean not null default true,
  intake_note_zh  text,                          -- 如「2026 届 · 2026 年 9 月开学」
  approved_at     date,                          -- 政策批准日期
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
comment on table public.program_catalog is
  'AMAS 招生项目权威目录（D-2 决议 2026-09-03）。招生项目 ≠ 教学课程；67 门课程目录不入此表。';

drop trigger if exists program_catalog_set_updated_at on public.program_catalog;
create trigger program_catalog_set_updated_at before update on public.program_catalog
  for each row execute function public.set_updated_at();

-- ---------- Seed：当前已批准并对外使用的 9 个项目（与官网现行清单一致）----------
insert into public.program_catalog
  (code, name_zh, name_en, short_label, category, sort_order, intake_note_zh, approved_at)
values
  ('bth',       '神学学士',              'Bachelor of Theology',                  'B.Th',   'degree',      10, '2026 届招生 · 2026 年 9 月开学 · 90 学分', '2026-09-02'),
  ('gdip',      '教牧学研究硕士',        'Master of Ministry Studies',            'G.Dip',  'degree',      20, '90 学分 · 按科修读 · 补修学分可衔接 M.Div', '2026-09-02'),
  ('mdiv',      '道学硕士',              'Master of Divinity',                    'M.Div',  'degree',      30, '90 学分 · 按科修读', '2026-09-02'),
  ('dmin',      '教牧学博士 / 宣教学博士','Doctor of Ministry / Missiology',       'D.Min',  'degree',      40, '48 学分（含论文）', '2026-09-02'),
  ('laycert',   '平信徒指导者课程',      'Lay Leader Course',                     '证书',   'certificate', 50, '36 学分 · 每 3 个月集中学习 10 天', '2026-09-02'),
  ('pdip',      '牧会训练课程',          'Pastoral Training Diploma',             '文凭',   'certificate', 60, '60 学分 · 可在线按科学习', '2026-09-02'),
  ('pastor',    '牧会者进修',            'Pastoral Continuing Education',         '进修',   'equipping',   70, '在职牧者的持续装备与更新', '2026-09-02'),
  ('preaching', '讲道学校',              'School of Preaching',                   '讲道',   'equipping',   80, '从释经到宣讲的集中训练', '2026-09-02'),
  ('missionary','宣教士训练',            'Missionary Training',                   '宣教',   'equipping',   90, '跨文化事奉的呼召分辨与差派预备', '2026-09-02')
on conflict (code) do update
  set name_zh = excluded.name_zh, name_en = excluded.name_en,
      short_label = excluded.short_label, category = excluded.category,
      sort_order = excluded.sort_order, intake_note_zh = excluded.intake_note_zh;

-- ---------- RLS：公开可读，仅服务端可写 ----------
alter table public.program_catalog enable row level security;
drop policy if exists pc_public_read on public.program_catalog;
create policy pc_public_read on public.program_catalog
  for select to anon, authenticated using (true);
revoke insert, update, delete on public.program_catalog from anon, authenticated;

-- ---------- 申请表单只允许选择目录内、且开放申请的项目（D-1：单一主项目）----------
create or replace function public.application_validate_program(p_form jsonb)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_array_length(p_form -> 'programs'), 0) = 1
     and exists (
       select 1 from public.program_catalog c
       where c.code = (p_form -> 'programs' ->> 0)
         and c.is_open_for_application
     );
$$;
grant execute on function public.application_validate_program(jsonb) to authenticated, service_role;

-- 表单校验接入：programs 必须恰好 1 项且在目录内（D-1 单一主项目）
create or replace function public.application_validate_form(p_form jsonb, p_pathway text)
returns text[] language plpgsql stable set search_path = '' as $$
declare missing text[] := '{}'; f text;
begin
  foreach f in array array[
    'name_zh','birth_ym','gender','nationality','phone','address',
    'church_name','church_role','conversion_date',
    'calling','testimony','declaration_accepted'
  ] loop
    if coalesce(btrim(p_form ->> f), '') = '' or (p_form ->> f) = 'false' then
      missing := missing || f::text;
    end if;
  end loop;

  -- D-1：恰好一个主项目，且必须来自 program_catalog 且开放申请
  if not public.application_validate_program(p_form) then
    missing := missing || 'programs'::text;
  end if;
  if coalesce(jsonb_array_length(p_form -> 'languages'), 0) = 0 then
    missing := missing || 'languages'::text;
  end if;
  if coalesce(jsonb_array_length(p_form -> 'education'), 0) = 0 then
    missing := missing || 'education'::text;
  end if;
  -- D-3：学习路径 V1 必填
  if p_pathway is null or p_pathway = 'undecided' then
    missing := missing || 'pathway'::text;
  end if;
  return missing;
end $$;

-- ---------- D-4/D-5/D-6：禁止收集的字段在服务端硬性拒绝 ----------
-- 即使前端被篡改，这些键也不会进入数据库。
create or replace function public.application_strip_forbidden()
returns trigger language plpgsql set search_path = '' as $$
declare k text;
begin
  foreach k in array array[
    'church_type',                                   -- D-4 教会类型
    'family', 'family_members', 'spouse', 'children',-- D-5 家庭成员隐私
    'health', 'health_status', 'medical', 'diagnosis'-- D-6 健康/医疗
  ] loop
    if new.form_data ? k then
      new.form_data := new.form_data - k;
    end if;
  end loop;
  return new;
end $$;

drop trigger if exists applications_strip_forbidden on public.applications;
create trigger applications_strip_forbidden before insert or update on public.applications
  for each row execute function public.application_strip_forbidden();

comment on function public.application_strip_forbidden is
  'D-4/D-5/D-6 决议（2026-09-03）：教会类型、家庭成员隐私、健康医疗资料一律不入库；服务端强制剥离，前端篡改无效。';
