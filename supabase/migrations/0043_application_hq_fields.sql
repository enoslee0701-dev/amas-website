-- ============================================================
-- 0043_application_hq_fields · 门户正式申请表统一为总校《神学校入学申请表》格式
--
-- 2026-10-26 Enos（院长、最终决定人）：申请表「统一称为总校格式」，教会种类、家庭状况、健康状况等
-- 总校表上有的栏位都要收，必填的强制、不必要的选填，不影响报名。
-- 这取代 2026-09-03 的 D-4 / D-5 / D-6「不收集」决议：服务端不再剥离 church_type、family、health。
-- 仍然不收：病历诊断一类的详细医疗资料（medical / diagnosis），总校表上也没有这一栏。
-- 这些资料只有申请人本人与教务可读（applications 原有 RLS 不变）。
-- ============================================================

create or replace function public.application_strip_forbidden()
returns trigger language plpgsql set search_path = '' as $$
declare k text;
begin
  foreach k in array array[
    'medical', 'diagnosis'                            -- 详细医疗资料：不收（总校表只有「健康状况」一栏，可填一句话）
  ] loop
    if new.form_data ? k then
      new.form_data := new.form_data - k;
    end if;
  end loop;
  return new;
end $$;

comment on function public.application_strip_forbidden is
  '2026-10-26 Enos 以总校申请表为准：教会种类、家庭成员、健康状况可收（选填）；只剥离 medical / diagnosis 详细医疗资料。取代 D-4/5/6（2026-09-03）。';
