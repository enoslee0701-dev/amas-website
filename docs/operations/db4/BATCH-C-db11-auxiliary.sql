-- ══════════════════════════════════════════════════════════════════════
-- BATCH C  ·  DB-11 附属数据迁移  ·  一次性数据脚本
-- ══════════════════════════════════════════════════════════════════════
--
-- ★★ 本文件会写数据库。不放 supabase/migrations/（不是 migration apply，
--    不得产生新 ledger 版本），也不放 supabase/tests/（那是纯 SELECT 探针）。
--
-- 保险丝：缺 -v i_understand_this_writes=YES 直接中止。
--
-- 范围（Supervisor STAGING-1A11 授权）：
--   course_files 68 → public.app_course_files
--   cooperation_submissions 1 → public.app_cooperation_submissions
--
-- 转换：
--   course_id → course_code（仅改名，值不变）
--   uploaded_at / received_at：epoch 毫秒 integer → to_timestamp(x/1000.0)
--   uploader_id：源侧 68/68 全为 NULL，保持 NULL（目标列可空）
--   id：源侧 68/68 与 1/1 均为合法 uuid，原样搬运，不重新生成
--
-- 存储契约：本表是元数据索引，二进制留在 App 后端本地磁盘
--   （backend/uploads/course-files，见 backend/src/db.ts 注释）。
--   执行前已做有界资产存在性检查：68 个 stored_name 在磁盘上 68/68 存在，
--   缺失 0。本阶段不重新设计存储。
--
-- 不触碰 course_catalog。
-- ══════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on
\if :{?i_understand_this_writes}
\else
  \echo '拒绝执行：缺少 -v i_understand_this_writes=YES'
  \quit
\endif

begin;

-- ── 前置断言 ─────────────────────────────────────────────────────────
do $$
declare n int; bad text := '';
begin
  select count(*) into n from public.app_course_files;
  if n<>0 then bad:=bad||format('app_course_files=%s(期望0); ',n); end if;
  select count(*) into n from public.app_cooperation_submissions;
  if n<>0 then bad:=bad||format('app_cooperation_submissions=%s(期望0); ',n); end if;
  select count(*) into n from migration.row_manifest where batch='DB-11';
  if n<>0 then bad:=bad||format('DB-11 manifest=%s(期望0); ',n); end if;
  select count(*) into n from public.course_catalog;
  if n<>67 then bad:=bad||format('course_catalog=%s(期望67); ',n); end if;
  if bad<>'' then raise exception 'BATCH C 前置失败：%', bad; end if;
end $$;

-- ── 1. app_course_files：68 行 ───────────────────────────────────────
insert into public.app_course_files
  (id, course_code, filename, stored_name, mime, size_bytes, uploader_id, uploaded_at)
values
  ('00debb91-d4d2-4103-a17b-d943ca5216c3'::uuid, 'c_greek', '希腊语书写练习一.pdf', 'c_greek__00debb91-d4d2-4103-a17b-d943ca5216c3', 'application/pdf', 13599, null, to_timestamp(1786699195852/1000.0)),
  ('089a3716-4338-401d-a0a3-d61299bdc455'::uuid, 'c_dr_jude', '犹大书（讲义）.pdf', 'c_dr_jude__089a3716-4338-401d-a0a3-d61299bdc455', 'application/pdf', 550406, null, to_timestamp(1786699189122/1000.0)),
  ('08b20851-9baa-43dd-889b-ebd342606d8d'::uuid, 'c_dr_luke', '路加福音.pdf', 'c_dr_luke__08b20851-9baa-43dd-889b-ebd342606d8d', 'application/pdf', 1120439, null, to_timestamp(1786699146160/1000.0)),
  ('0904df7d-7ff1-494b-9023-102f11cbf305'::uuid, 'c_titus', '提多书.pdf', 'c_dr_pastoral__0904df7d-7ff1-494b-9023-102f11cbf305', 'application/pdf', 781140, null, to_timestamp(1786699170114/1000.0)),
  ('0a2cd421-8411-4b69-a9a9-e4ff8d6af153'::uuid, 'c_3john', '约翰三书（二）.pdf', 'c_dr_johannine__0a2cd421-8411-4b69-a9a9-e4ff8d6af153', 'application/pdf', 268406, null, to_timestamp(1786699181857/1000.0)),
  ('0fd94ffc-ca4d-4674-af63-56a54df1f86e'::uuid, 'c_greek', '希腊语词汇.pdf', 'c_greek__0fd94ffc-ca4d-4674-af63-56a54df1f86e', 'application/pdf', 214989, null, to_timestamp(1786699201396/1000.0)),
  ('150137f6-05e7-45a2-93e0-54bdb0aca2dd'::uuid, 'c_evangelism', '传道法.pdf', 'c_evangelism__150137f6-05e7-45a2-93e0-54bdb0aca2dd', 'application/pdf', 512964, null, to_timestamp(1786673557790/1000.0)),
  ('1d8733d5-fd86-47b6-a52a-699290146efe'::uuid, 'c_newbeliever', '新信徒教材.pdf', 'c_newbeliever__1d8733d5-fd86-47b6-a52a-699290146efe', 'application/pdf', 638704, null, to_timestamp(1786674092668/1000.0)),
  ('23555783-39e8-4adb-9f37-c50b72bb6b80'::uuid, 'c_dr_galatians', '加拉太书.pdf', 'c_dr_galatians__23555783-39e8-4adb-9f37-c50b72bb6b80', 'application/pdf', 831877, null, to_timestamp(1786699152835/1000.0)),
  ('278a8aab-c990-432b-aa5c-78b7a2f7ced1'::uuid, 'c_dr_marking', '研经标记法.pdf', 'c_dr_marking__278a8aab-c990-432b-aa5c-78b7a2f7ced1', 'application/pdf', 438276, null, to_timestamp(1786699191893/1000.0)),
  ('28b14332-ad78-4ba6-b578-5a4a283879c4'::uuid, 'c_1cor', '哥林多前书.pdf', 'c_1cor__28b14332-ad78-4ba6-b578-5a4a283879c4', 'application/pdf', 713133, null, to_timestamp(1786673553074/1000.0)),
  ('29c610cd-f065-4c11-b62e-7185d828d89f'::uuid, 'c_dr_philippians', '腓立比书（补充）.pdf', 'c_dr_philippians__29c610cd-f065-4c11-b62e-7185d828d89f', 'application/pdf', 411857, null, to_timestamp(1786699160122/1000.0)),
  ('2a43f2eb-70c3-423c-8687-5104c767eb9a'::uuid, 'c_greek', '希腊语词典.pdf', 'c_greek__2a43f2eb-70c3-423c-8687-5104c767eb9a', 'application/pdf', 461315, null, to_timestamp(1786699200015/1000.0)),
  ('2f300b83-004a-41de-872e-f606049ced23'::uuid, 'c_matthew', '马太福音.pdf', 'c_matthew__2f300b83-004a-41de-872e-f606049ced23', 'application/pdf', 969283, null, to_timestamp(1786673553683/1000.0)),
  ('30cb1404-8001-42a8-8c89-3ef8053c42ae'::uuid, 'c_smallgroup', '小组运营.pdf', 'c_smallgroup__30cb1404-8001-42a8-8c89-3ef8053c42ae', 'application/pdf', 1190953, null, to_timestamp(1786673653540/1000.0)),
  ('322a2b61-e549-483b-87c2-0024757998d9'::uuid, 'c_acts', '使徒行传.pdf', 'c_acts__322a2b61-e549-483b-87c2-0024757998d9', 'application/pdf', 2364552, null, to_timestamp(1786673554448/1000.0)),
  ('33515345-155e-4667-867e-2f48fee13bd0'::uuid, 'c_revelation', '启示录.pdf', 'c_revelation__33515345-155e-4667-867e-2f48fee13bd0', 'application/pdf', 2619474, null, to_timestamp(1786673556660/1000.0)),
  ('347740c6-6ef0-473d-9121-6ec67603ddce'::uuid, 'c_dr_jude', '犹大书.pdf', 'c_dr_jude__347740c6-6ef0-473d-9121-6ec67603ddce', 'application/pdf', 793133, null, to_timestamp(1786699187630/1000.0)),
  ('35991301-c95b-4fc9-af43-9c0dc4de7a68'::uuid, 'c_worship_order', '礼拜顺序.pdf', 'c_worship_order__35991301-c95b-4fc9-af43-9c0dc4de7a68', 'application/pdf', 197182, null, to_timestamp(1786673654733/1000.0)),
  ('3a88b842-41f7-49e5-81bb-6ac046bfa198'::uuid, 'c_healing_inner', '内在医治.pdf', 'c_healing__3a88b842-41f7-49e5-81bb-6ac046bfa198', 'application/pdf', 481930, null, to_timestamp(1786673557960/1000.0)),
  ('3aed3893-0fdc-43b0-a106-5b1ecaad2f5d'::uuid, 'c_healing_word', '医治疾病.pdf', 'c_healing__3aed3893-0fdc-43b0-a106-5b1ecaad2f5d', 'application/pdf', 256556, null, to_timestamp(1786674085015/1000.0)),
  ('4113cc4a-a3fe-4505-ac31-1badf3aa9e1b'::uuid, 'c_dr_luke', '路加福音（补充）.pdf', 'c_dr_luke__4113cc4a-a3fe-4505-ac31-1badf3aa9e1b', 'application/pdf', 1128155, null, to_timestamp(1786699149882/1000.0)),
  ('43afb88a-a3a4-4066-b870-350b0c7459f4'::uuid, 'c_revelation', '启示录（博士班）.pdf', 'c_revelation__43afb88a-a3a4-4066-b870-350b0c7459f4', 'application/pdf', 9724939, null, to_timestamp(1786699216260/1000.0)),
  ('4d8c1f57-6511-44de-811e-b735ffb294a9'::uuid, 'c_dr_philippians', '腓立比书.pdf', 'c_dr_philippians__4d8c1f57-6511-44de-811e-b735ffb294a9', 'application/pdf', 880834, null, to_timestamp(1786699158672/1000.0)),
  ('52745b52-1341-4628-8403-44dd37e86d88'::uuid, 'c_romans', '罗马书.pdf', 'c_romans__52745b52-1341-4628-8403-44dd37e86d88', 'application/pdf', 1196422, null, to_timestamp(1786673557612/1000.0)),
  ('5376d3a1-6248-4eff-bd28-3ee2fa69c125'::uuid, 'c_greek', '马太福音希腊语选读.pdf', 'c_greek__5376d3a1-6248-4eff-bd28-3ee2fa69c125', 'application/pdf', 27789, null, to_timestamp(1786699202716/1000.0)),
  ('5438510f-2191-4972-b231-52d59ac87646'::uuid, 'c_greek', '希腊语字母歌.mp3', 'c_greek__5438510f-2191-4972-b231-52d59ac87646', 'audio/mpeg', 1221528, null, to_timestamp(1786699206140/1000.0)),
  ('559dd717-3523-430c-94ed-ddc2537ff09c'::uuid, 'c_acts', '使徒行传（新教材）.pdf', 'c_acts__559dd717-3523-430c-94ed-ddc2537ff09c', 'application/pdf', 1010773, null, to_timestamp(1786674076533/1000.0)),
  ('56c8d64e-e503-4dd0-945e-0a2547993908'::uuid, 'c_1john', '约翰一书.pdf', 'c_dr_johannine__56c8d64e-e503-4dd0-945e-0a2547993908', 'application/pdf', 797870, null, to_timestamp(1786699177628/1000.0)),
  ('59a9fd30-0c45-407e-a5c2-126951c6009e'::uuid, 'c_1tim', '提摩太前书.pdf', 'c_dr_pastoral__59a9fd30-0c45-407e-a5c2-126951c6009e', 'application/pdf', 406397, null, to_timestamp(1786699165617/1000.0)),
  ('5f0b75b2-69eb-4519-a5ae-90a3d23b2036'::uuid, 'c_bible_intro', '圣经综合概观.pdf', 'c_bible_intro__5f0b75b2-69eb-4519-a5ae-90a3d23b2036', 'application/pdf', 1085987, null, to_timestamp(1786673557027/1000.0)),
  ('65178524-f24a-4538-bfcb-1f95239c8625'::uuid, 'c_1pet', '彼得前书.pdf', 'c_dr_peter__65178524-f24a-4538-bfcb-1f95239c8625', 'application/pdf', 1272302, null, to_timestamp(1786699173110/1000.0)),
  ('6637056e-f693-484e-852f-e143af96fa64'::uuid, 'c_dr_luke', '路加福音（讲义）.pdf', 'c_dr_luke__6637056e-f693-484e-852f-e143af96fa64', 'application/pdf', 2447591, null, to_timestamp(1786699148213/1000.0)),
  ('69a0864a-3d48-4201-b1c1-ca74d11222f7'::uuid, 'c_2john', '约翰二书.pdf', 'c_dr_johannine__69a0864a-3d48-4201-b1c1-ca74d11222f7', 'application/pdf', 222100, null, to_timestamp(1786699179028/1000.0)),
  ('69f01e71-9701-4b7f-8eb1-4adf0247687a'::uuid, 'c_disciple', '门徒生活.pdf', 'c_disciple__69f01e71-9701-4b7f-8eb1-4adf0247687a', 'application/pdf', 2019450, null, to_timestamp(1786673655324/1000.0)),
  ('7186d7d8-ce0b-42e2-a524-355b91bf396e'::uuid, 'c_basics', '基督徒生活.pdf', 'c_basics__7186d7d8-ce0b-42e2-a524-355b91bf396e', 'application/pdf', 672269, null, to_timestamp(1786673653048/1000.0)),
  ('754e5b94-9541-4e1a-87c6-0cb67ea8e1ea'::uuid, 'c_dr_colossians', '歌罗西书.pdf', 'c_dr_colossians__754e5b94-9541-4e1a-87c6-0cb67ea8e1ea', 'application/pdf', 990865, null, to_timestamp(1786699155761/1000.0)),
  ('782dc47b-c68b-439d-9687-2c008f0c40f1'::uuid, 'c_dr_mark', '马可福音（二）.pdf', 'c_dr_mark__782dc47b-c68b-439d-9687-2c008f0c40f1', 'application/pdf', 2256029, null, to_timestamp(1786699143173/1000.0)),
  ('81ff1d97-abb6-4cc8-a3a2-9362cfce66a2'::uuid, 'c_healing_inner', '一日内在医治.pdf', 'c_healing__81ff1d97-abb6-4cc8-a3a2-9362cfce66a2', 'application/pdf', 2014560, null, to_timestamp(1786674082514/1000.0)),
  ('82ac3fda-7dcf-4001-8401-d799b5769cce'::uuid, 'c_2tim', '提摩太后书.pdf', 'c_dr_pastoral__82ac3fda-7dcf-4001-8401-d799b5769cce', 'application/pdf', 366523, null, to_timestamp(1786699168529/1000.0)),
  ('83c4f3be-68d2-42c7-8721-f994f909a75a'::uuid, 'c_church_ops', '教会运营.pdf', 'c_church_ops__83c4f3be-68d2-42c7-8721-f994f909a75a', 'application/pdf', 767635, null, to_timestamp(1786673653892/1000.0)),
  ('85949f35-ec75-4a9a-b910-828a4200144d'::uuid, 'c_dr_philemon', '腓利门书.pdf', 'c_dr_philemon__85949f35-ec75-4a9a-b910-828a4200144d', 'application/pdf', 317375, null, to_timestamp(1786699162861/1000.0)),
  ('95695223-78b8-4231-8c80-0d46e7187d20'::uuid, 'c_assurance', '确信生活.pdf', 'c_assurance__95695223-78b8-4231-8c80-0d46e7187d20', 'application/pdf', 1587086, null, to_timestamp(1786673654662/1000.0)),
  ('96bb643c-6a89-44bf-a743-9423dbb580cd'::uuid, 'c_healing_word', '通过宣告神的话语医治疾病.pdf', 'c_healing__96bb643c-6a89-44bf-a743-9423dbb580cd', 'application/pdf', 404876, null, to_timestamp(1786674090038/1000.0)),
  ('977d0a14-7377-40de-9a7a-884e2a4c905c'::uuid, 'c_newbeliever', '新信徒事工.pdf', 'c_newbeliever__977d0a14-7377-40de-9a7a-884e2a4c905c', 'application/pdf', 273309, null, to_timestamp(1786673653987/1000.0)),
  ('9fa251d4-ea4a-4719-8317-991f6b9918f2'::uuid, 'c_lay_systematic', '平信徒系统神学.pdf', 'c_lay_systematic__9fa251d4-ea4a-4719-8317-991f6b9918f2', 'application/pdf', 815313, null, to_timestamp(1786673655615/1000.0)),
  ('a76122d6-6d0f-4b38-8c1b-e2bbff1c1ddc'::uuid, 'c_greek', '希腊语课件.pdf', 'c_greek__a76122d6-6d0f-4b38-8c1b-e2bbff1c1ddc', 'application/pdf', 1387032, null, to_timestamp(1786699204450/1000.0)),
  ('a7d5a027-51e1-40f6-8cd4-19168ad11f20'::uuid, 'c_counseling', '协谈学.pdf', 'c_counseling__a7d5a027-51e1-40f6-8cd4-19168ad11f20', 'application/pdf', 417506, null, to_timestamp(1786673652827/1000.0)),
  ('a8c862b4-1367-4567-8d4e-9d294f7049c4'::uuid, 'c_dr_mark', '马可福音.pdf', 'c_dr_mark__a8c862b4-1367-4567-8d4e-9d294f7049c4', 'application/pdf', 2329945, null, to_timestamp(1786699141060/1000.0)),
  ('b5abb5fa-0928-46fb-940a-d397c9a09a4e'::uuid, 'c_dr_james', '雅各书.pdf', 'c_dr_james__b5abb5fa-0928-46fb-940a-d397c9a09a4e', 'application/pdf', 852113, null, to_timestamp(1786699184769/1000.0)),
  ('b6156c83-77f9-4750-bd6f-505b5e36095a'::uuid, 'c_hebrews', '希伯来书.pdf', 'c_hebrews__b6156c83-77f9-4750-bd6f-505b5e36095a', 'application/pdf', 1110571, null, to_timestamp(1786673555159/1000.0)),
  ('bd75dfd8-51d3-4585-b302-c8214c2bd310'::uuid, 'c_greek', '希腊语书写练习三.pdf', 'c_greek__bd75dfd8-51d3-4585-b302-c8214c2bd310', 'application/pdf', 269045, null, to_timestamp(1786699198567/1000.0)),
  ('bf78e08d-5375-4d80-bd34-1ae738386e3f'::uuid, 'c_greek', '希腊语字母表.pdf', 'c_greek__bf78e08d-5375-4d80-bd34-1ae738386e3f', 'application/pdf', 54094, null, to_timestamp(1786699194535/1000.0)),
  ('ca7accb8-049b-4b42-b8b9-3fa5bc83b474'::uuid, 'c_john', '约翰福音.pdf', 'c_john__ca7accb8-049b-4b42-b8b9-3fa5bc83b474', 'application/pdf', 864599, null, to_timestamp(1786673553358/1000.0)),
  ('cb27dced-a40f-4a01-85e4-3f1eef5c8ce8'::uuid, 'c_1tim', '提摩太前书（整理）.pdf', 'c_dr_pastoral__cb27dced-a40f-4a01-85e4-3f1eef5c8ce8', 'application/pdf', 444903, null, to_timestamp(1786699167074/1000.0)),
  ('cd0b64b4-43df-4b91-88d4-e62698b62a57'::uuid, 'c_3john', '约翰三书.pdf', 'c_dr_johannine__cd0b64b4-43df-4b91-88d4-e62698b62a57', 'application/pdf', 231482, null, to_timestamp(1786699180445/1000.0)),
  ('ddc17dea-472d-40a2-9751-fd25c3ee5ce9'::uuid, 'c_2cor', '哥林多后书（博士班讲义）.pdf', 'c_2cor__ddc17dea-472d-40a2-9751-fd25c3ee5ce9', 'application/pdf', 973722, null, to_timestamp(1786699209061/1000.0)),
  ('deb82f81-0bed-4d5c-834b-18769ee47e1a'::uuid, 'c_revelation', '启示录（博士班讲义）.pdf', 'c_revelation__deb82f81-0bed-4d5c-834b-18769ee47e1a', 'application/pdf', 1306983, null, to_timestamp(1786699212081/1000.0)),
  ('e0ab0812-9652-4e79-a5bc-c56d9bd4ddc0'::uuid, 'c_2cor', '哥林多后书.pdf', 'c_2cor__e0ab0812-9652-4e79-a5bc-c56d9bd4ddc0', 'application/pdf', 588079, null, to_timestamp(1786673557219/1000.0)),
  ('e2cc6f4c-5537-4715-80ef-013e148fb00d'::uuid, 'c_dr_reformed', '改革宗与福音派神学讲义.pdf', 'c_dr_reformed__e2cc6f4c-5537-4715-80ef-013e148fb00d', 'application/pdf', 1226252, null, to_timestamp(1786699134314/1000.0)),
  ('e58599de-fb27-4b0d-aa6d-2f8500161da2'::uuid, 'c_greek', '希腊语书写练习二.pdf', 'c_greek__e58599de-fb27-4b0d-aa6d-2f8500161da2', 'application/pdf', 23135, null, to_timestamp(1786699197166/1000.0)),
  ('e6c4ebab-1e0e-4174-951d-cb63158ffe5f'::uuid, 'c_warfare', '属灵争战.pdf', 'c_warfare__e6c4ebab-1e0e-4174-951d-cb63158ffe5f', 'application/pdf', 307966, null, to_timestamp(1786673653645/1000.0)),
  ('e8095aad-89b8-405c-921a-bdc8e3afda11'::uuid, 'c_dr_genesis', '创世记.pdf', 'c_dr_genesis__e8095aad-89b8-405c-921a-bdc8e3afda11', 'application/pdf', 2586967, null, to_timestamp(1786699137737/1000.0)),
  ('f35e2eb2-951d-4f17-a1bf-42e8139005b7'::uuid, 'c_ephesians', '以弗所书.pdf', 'c_ephesians__f35e2eb2-951d-4f17-a1bf-42e8139005b7', 'application/pdf', 412955, null, to_timestamp(1786673555808/1000.0)),
  ('f5cc7203-b672-4144-b76c-3448a0707850'::uuid, 'c_hebrews', '希伯来书（二）.pdf', 'c_hebrews__f5cc7203-b672-4144-b76c-3448a0707850', 'application/pdf', 1535395, null, to_timestamp(1786674079477/1000.0)),
  ('f81d10b6-cbd2-4c57-bdea-591b4c5c10a9'::uuid, 'c_healing_word', '宣告神话语的医治.pdf', 'c_healing__f81d10b6-cbd2-4c57-bdea-591b4c5c10a9', 'application/pdf', 312046, null, to_timestamp(1786674087514/1000.0)),
  ('fa8b9914-f455-4795-ab13-40647fb66516'::uuid, 'c_2pet', '彼得后书.pdf', 'c_dr_peter__fa8b9914-f455-4795-ab13-40647fb66516', 'application/pdf', 874142, null, to_timestamp(1786699174711/1000.0)),
  ('fb5007ae-06da-42db-9bed-731c73e04c70'::uuid, 'c_contextual', '处境化神学.pdf', 'c_contextual__fb5007ae-06da-42db-9bed-731c73e04c70', 'application/pdf', 250613, null, to_timestamp(1786673653137/1000.0));

-- ── 2. app_cooperation_submissions：1 行 ─────────────────────────────
insert into public.app_cooperation_submissions
  (id, name, email, organization, message, type, received_at)
values
  ('7df6113b-40eb-4314-9390-1fa11a7aa914'::uuid, '管理员', 'admin@amas.hk', 'AMAS App · 定制化神学', '【成长档案·事奉申请】角色：门训陪伴（匹配度 83%）。来自定制化神学的恩赐辨识匹配。', '事奉申请', to_timestamp(1787735790733/1000.0));

-- ── 3. row_manifest：69 条，全部 MIGRATED ───────────────────────────
insert into migration.row_manifest
  (batch, source_table, source_pk, target_table, target_pk, status,
   transformation, identity_mapping, manual_review)
values
  ('DB-11', 'course_files', '00debb91-d4d2-4103-a17b-d943ca5216c3', 'public.app_course_files', '00debb91-d4d2-4103-a17b-d943ca5216c3', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', '089a3716-4338-401d-a0a3-d61299bdc455', 'public.app_course_files', '089a3716-4338-401d-a0a3-d61299bdc455', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', '08b20851-9baa-43dd-889b-ebd342606d8d', 'public.app_course_files', '08b20851-9baa-43dd-889b-ebd342606d8d', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', '0904df7d-7ff1-494b-9023-102f11cbf305', 'public.app_course_files', '0904df7d-7ff1-494b-9023-102f11cbf305', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', '0a2cd421-8411-4b69-a9a9-e4ff8d6af153', 'public.app_course_files', '0a2cd421-8411-4b69-a9a9-e4ff8d6af153', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', '0fd94ffc-ca4d-4674-af63-56a54df1f86e', 'public.app_course_files', '0fd94ffc-ca4d-4674-af63-56a54df1f86e', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', '150137f6-05e7-45a2-93e0-54bdb0aca2dd', 'public.app_course_files', '150137f6-05e7-45a2-93e0-54bdb0aca2dd', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', '1d8733d5-fd86-47b6-a52a-699290146efe', 'public.app_course_files', '1d8733d5-fd86-47b6-a52a-699290146efe', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', '23555783-39e8-4adb-9f37-c50b72bb6b80', 'public.app_course_files', '23555783-39e8-4adb-9f37-c50b72bb6b80', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', '278a8aab-c990-432b-aa5c-78b7a2f7ced1', 'public.app_course_files', '278a8aab-c990-432b-aa5c-78b7a2f7ced1', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', '28b14332-ad78-4ba6-b578-5a4a283879c4', 'public.app_course_files', '28b14332-ad78-4ba6-b578-5a4a283879c4', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', '29c610cd-f065-4c11-b62e-7185d828d89f', 'public.app_course_files', '29c610cd-f065-4c11-b62e-7185d828d89f', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', '2a43f2eb-70c3-423c-8687-5104c767eb9a', 'public.app_course_files', '2a43f2eb-70c3-423c-8687-5104c767eb9a', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', '2f300b83-004a-41de-872e-f606049ced23', 'public.app_course_files', '2f300b83-004a-41de-872e-f606049ced23', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', '30cb1404-8001-42a8-8c89-3ef8053c42ae', 'public.app_course_files', '30cb1404-8001-42a8-8c89-3ef8053c42ae', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', '322a2b61-e549-483b-87c2-0024757998d9', 'public.app_course_files', '322a2b61-e549-483b-87c2-0024757998d9', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', '33515345-155e-4667-867e-2f48fee13bd0', 'public.app_course_files', '33515345-155e-4667-867e-2f48fee13bd0', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', '347740c6-6ef0-473d-9121-6ec67603ddce', 'public.app_course_files', '347740c6-6ef0-473d-9121-6ec67603ddce', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', '35991301-c95b-4fc9-af43-9c0dc4de7a68', 'public.app_course_files', '35991301-c95b-4fc9-af43-9c0dc4de7a68', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', '3a88b842-41f7-49e5-81bb-6ac046bfa198', 'public.app_course_files', '3a88b842-41f7-49e5-81bb-6ac046bfa198', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', '3aed3893-0fdc-43b0-a106-5b1ecaad2f5d', 'public.app_course_files', '3aed3893-0fdc-43b0-a106-5b1ecaad2f5d', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', '4113cc4a-a3fe-4505-ac31-1badf3aa9e1b', 'public.app_course_files', '4113cc4a-a3fe-4505-ac31-1badf3aa9e1b', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', '43afb88a-a3a4-4066-b870-350b0c7459f4', 'public.app_course_files', '43afb88a-a3a4-4066-b870-350b0c7459f4', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', '4d8c1f57-6511-44de-811e-b735ffb294a9', 'public.app_course_files', '4d8c1f57-6511-44de-811e-b735ffb294a9', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', '52745b52-1341-4628-8403-44dd37e86d88', 'public.app_course_files', '52745b52-1341-4628-8403-44dd37e86d88', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', '5376d3a1-6248-4eff-bd28-3ee2fa69c125', 'public.app_course_files', '5376d3a1-6248-4eff-bd28-3ee2fa69c125', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', '5438510f-2191-4972-b231-52d59ac87646', 'public.app_course_files', '5438510f-2191-4972-b231-52d59ac87646', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', '559dd717-3523-430c-94ed-ddc2537ff09c', 'public.app_course_files', '559dd717-3523-430c-94ed-ddc2537ff09c', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', '56c8d64e-e503-4dd0-945e-0a2547993908', 'public.app_course_files', '56c8d64e-e503-4dd0-945e-0a2547993908', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', '59a9fd30-0c45-407e-a5c2-126951c6009e', 'public.app_course_files', '59a9fd30-0c45-407e-a5c2-126951c6009e', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', '5f0b75b2-69eb-4519-a5ae-90a3d23b2036', 'public.app_course_files', '5f0b75b2-69eb-4519-a5ae-90a3d23b2036', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', '65178524-f24a-4538-bfcb-1f95239c8625', 'public.app_course_files', '65178524-f24a-4538-bfcb-1f95239c8625', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', '6637056e-f693-484e-852f-e143af96fa64', 'public.app_course_files', '6637056e-f693-484e-852f-e143af96fa64', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', '69a0864a-3d48-4201-b1c1-ca74d11222f7', 'public.app_course_files', '69a0864a-3d48-4201-b1c1-ca74d11222f7', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', '69f01e71-9701-4b7f-8eb1-4adf0247687a', 'public.app_course_files', '69f01e71-9701-4b7f-8eb1-4adf0247687a', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', '7186d7d8-ce0b-42e2-a524-355b91bf396e', 'public.app_course_files', '7186d7d8-ce0b-42e2-a524-355b91bf396e', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', '754e5b94-9541-4e1a-87c6-0cb67ea8e1ea', 'public.app_course_files', '754e5b94-9541-4e1a-87c6-0cb67ea8e1ea', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', '782dc47b-c68b-439d-9687-2c008f0c40f1', 'public.app_course_files', '782dc47b-c68b-439d-9687-2c008f0c40f1', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', '81ff1d97-abb6-4cc8-a3a2-9362cfce66a2', 'public.app_course_files', '81ff1d97-abb6-4cc8-a3a2-9362cfce66a2', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', '82ac3fda-7dcf-4001-8401-d799b5769cce', 'public.app_course_files', '82ac3fda-7dcf-4001-8401-d799b5769cce', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', '83c4f3be-68d2-42c7-8721-f994f909a75a', 'public.app_course_files', '83c4f3be-68d2-42c7-8721-f994f909a75a', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', '85949f35-ec75-4a9a-b910-828a4200144d', 'public.app_course_files', '85949f35-ec75-4a9a-b910-828a4200144d', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', '95695223-78b8-4231-8c80-0d46e7187d20', 'public.app_course_files', '95695223-78b8-4231-8c80-0d46e7187d20', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', '96bb643c-6a89-44bf-a743-9423dbb580cd', 'public.app_course_files', '96bb643c-6a89-44bf-a743-9423dbb580cd', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', '977d0a14-7377-40de-9a7a-884e2a4c905c', 'public.app_course_files', '977d0a14-7377-40de-9a7a-884e2a4c905c', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', '9fa251d4-ea4a-4719-8317-991f6b9918f2', 'public.app_course_files', '9fa251d4-ea4a-4719-8317-991f6b9918f2', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', 'a76122d6-6d0f-4b38-8c1b-e2bbff1c1ddc', 'public.app_course_files', 'a76122d6-6d0f-4b38-8c1b-e2bbff1c1ddc', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', 'a7d5a027-51e1-40f6-8cd4-19168ad11f20', 'public.app_course_files', 'a7d5a027-51e1-40f6-8cd4-19168ad11f20', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', 'a8c862b4-1367-4567-8d4e-9d294f7049c4', 'public.app_course_files', 'a8c862b4-1367-4567-8d4e-9d294f7049c4', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', 'b5abb5fa-0928-46fb-940a-d397c9a09a4e', 'public.app_course_files', 'b5abb5fa-0928-46fb-940a-d397c9a09a4e', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', 'b6156c83-77f9-4750-bd6f-505b5e36095a', 'public.app_course_files', 'b6156c83-77f9-4750-bd6f-505b5e36095a', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', 'bd75dfd8-51d3-4585-b302-c8214c2bd310', 'public.app_course_files', 'bd75dfd8-51d3-4585-b302-c8214c2bd310', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', 'bf78e08d-5375-4d80-bd34-1ae738386e3f', 'public.app_course_files', 'bf78e08d-5375-4d80-bd34-1ae738386e3f', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', 'ca7accb8-049b-4b42-b8b9-3fa5bc83b474', 'public.app_course_files', 'ca7accb8-049b-4b42-b8b9-3fa5bc83b474', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', 'cb27dced-a40f-4a01-85e4-3f1eef5c8ce8', 'public.app_course_files', 'cb27dced-a40f-4a01-85e4-3f1eef5c8ce8', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', 'cd0b64b4-43df-4b91-88d4-e62698b62a57', 'public.app_course_files', 'cd0b64b4-43df-4b91-88d4-e62698b62a57', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', 'ddc17dea-472d-40a2-9751-fd25c3ee5ce9', 'public.app_course_files', 'ddc17dea-472d-40a2-9751-fd25c3ee5ce9', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', 'deb82f81-0bed-4d5c-834b-18769ee47e1a', 'public.app_course_files', 'deb82f81-0bed-4d5c-834b-18769ee47e1a', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', 'e0ab0812-9652-4e79-a5bc-c56d9bd4ddc0', 'public.app_course_files', 'e0ab0812-9652-4e79-a5bc-c56d9bd4ddc0', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', 'e2cc6f4c-5537-4715-80ef-013e148fb00d', 'public.app_course_files', 'e2cc6f4c-5537-4715-80ef-013e148fb00d', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', 'e58599de-fb27-4b0d-aa6d-2f8500161da2', 'public.app_course_files', 'e58599de-fb27-4b0d-aa6d-2f8500161da2', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', 'e6c4ebab-1e0e-4174-951d-cb63158ffe5f', 'public.app_course_files', 'e6c4ebab-1e0e-4174-951d-cb63158ffe5f', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', 'e8095aad-89b8-405c-921a-bdc8e3afda11', 'public.app_course_files', 'e8095aad-89b8-405c-921a-bdc8e3afda11', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', 'f35e2eb2-951d-4f17-a1bf-42e8139005b7', 'public.app_course_files', 'f35e2eb2-951d-4f17-a1bf-42e8139005b7', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', 'f5cc7203-b672-4144-b76c-3448a0707850', 'public.app_course_files', 'f5cc7203-b672-4144-b76c-3448a0707850', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', 'f81d10b6-cbd2-4c57-bdea-591b4c5c10a9', 'public.app_course_files', 'f81d10b6-cbd2-4c57-bdea-591b4c5c10a9', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', 'fa8b9914-f455-4795-ab13-40647fb66516', 'public.app_course_files', 'fa8b9914-f455-4795-ab13-40647fb66516', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'course_files', 'fb5007ae-06da-42db-9bed-731c73e04c70', 'public.app_course_files', 'fb5007ae-06da-42db-9bed-731c73e04c70', 'MIGRATED', 'course_id -> course_code; uploaded_at epoch_ms -> timestamptz', 'none (uploader_id NULL in source; target column nullable)', false),
  ('DB-11', 'cooperation_submissions', '7df6113b-40eb-4314-9390-1fa11a7aa914', 'public.app_cooperation_submissions', '7df6113b-40eb-4314-9390-1fa11a7aa914', 'MIGRATED', 'received_at epoch_ms -> timestamptz', 'none (no user FK on this path)', false);

-- ── 4. 事务内硬断言 ─────────────────────────────────────────────────
do $$
declare bad text := ''; n int; m int;
begin
  select count(*) into n from public.app_course_files;
  if n<>68 then bad:=bad||format('app_course_files=%s(期望68); ',n); end if;
  select count(*) into n from public.app_cooperation_submissions;
  if n<>1 then bad:=bad||format('app_cooperation_submissions=%s(期望1); ',n); end if;

  -- FK 闭合：不得有任何 course_code 落在 course_catalog 之外
  select count(*) into n from public.app_course_files f
   where not exists (select 1 from public.course_catalog c where c.code = f.course_code);
  if n<>0 then bad:=bad||format('course_code 悬空=%s(期望0); ',n); end if;
  select count(distinct course_code) into n from public.app_course_files;
  if n<>44 then bad:=bad||format('distinct course_code=%s(期望44); ',n); end if;
  select count(*) into n from public.app_course_files where uploader_id is not null;
  if n<>0 then bad:=bad||format('uploader_id 非空=%s(期望0); ',n); end if;

  select count(*) filter (where status='MIGRATED'), count(*)
    into m, n from migration.row_manifest where batch='DB-11';
  if (m,n) is distinct from (69,69) then bad:=bad||format('DB-11 manifest=%s/%s(期望 69/69); ',m,n); end if;

  -- 其余 26 张 app_* 必须仍为 0（app_rooms 由 BATCH B 写入 5，单列）
  select coalesce(sum(cnt),0) into n from (
    select (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', c.relname), false,true,'')))[1]::text::int as cnt
    from pg_class c join pg_namespace nsp on nsp.oid=c.relnamespace
    where nsp.nspname='public' and c.relkind='r' and c.relname like 'app\_%'
      and c.relname not in ('app_rooms','app_course_files','app_cooperation_submissions')) t;
  if n<>0 then bad:=bad||format('其余 app_* 合计=%s(期望0); ',n); end if;
  select count(*) into n from public.app_rooms; if n<>5 then bad:=bad||format('app_rooms=%s(期望5); ',n); end if;

  select count(*) into n from public.course_catalog;  if n<>67 then bad:=bad||format('course_catalog=%s; ',n); end if;
  select count(*) into n from public.program_catalog; if n<>9  then bad:=bad||format('program_catalog=%s; ',n); end if;
  select count(*) into n from auth.users;             if n<>1  then bad:=bad||format('auth.users=%s; ',n); end if;
  select count(*) into n from public.profiles;        if n<>1  then bad:=bad||format('profiles=%s; ',n); end if;
  select count(*) into n from public.user_roles;      if n<>1  then bad:=bad||format('user_roles=%s; ',n); end if;
  select count(*) into n from supabase_migrations.schema_migrations; if n<>26 then bad:=bad||format('ledger=%s; ',n); end if;

  if bad<>'' then raise exception 'BATCH C 事务内断言失败，整体回滚: %', bad; end if;
  raise notice 'BATCH C 断言全过：files=68 coop=1 · course_code 闭合 44/0悬空 · uploader 全 NULL · DB-11 manifest 69/69 · 其余 app_* 0 · rooms 5 · cc67 pc9 · 身份 1/1/1 · ledger 26';
end $$;

commit;
select 'BATCH-C|COMMITTED' as result;
