/* PORTAL-1 · 正式申请表定义（字段映射 v1 的前端实现）
   Source of Truth 优先级（2026-09-03 决议）：
     1 当前批准的招生政策/决策 → 2 program_catalog → 3 最新正式申请表 → 4 官网 Quick Apply → 5 Legacy
   D-1 单一主项目 · D-3 学习路径必填
   2026-10-26 Enos：统一为总校《神学校入学申请表》格式 —— 教会种类、家庭状况、健康状况照收（选填），
   取代 D-4/D-5/D-6「不收集」；只有详细医疗资料（medical / diagnosis）仍由服务端剥离（0043）。
   注意：本文件只定义「展示与前端提示」；必填与合法性由数据库 application_validate_form 权威判定。 */
(function () {
  "use strict";

  const PATHWAYS = [
    { value: "bth", label: "正式 B.Th 学籍路径", hint: "按学位要求逐科修读，学籍由 AMAS 总校审核建立" },
    { value: "common_learning", label: "共同学习路径", hint: "与学员一同修读，不自动建立学籍、不自动转换为学位学分" },
  ];

  /** 分步定义：每步 fields[]，每个 field 定义渲染方式 */
  const STEPS = [
    {
      key: "basic", title: "1 · 基本资料",
      fields: [
        { name: "name_zh", label: "中文 / 常用姓名", type: "text", required: true, max: 80 },
        { name: "name_en", label: "英文姓名", type: "text", max: 80 },
        { name: "gender", label: "性别", type: "select", required: true,
          options: [["male", "男"], ["female", "女"]] },
        { name: "birth_ym", label: "出生年月", type: "month", required: true },
        { name: "nationality", label: "国籍", type: "text", required: true, max: 60 },
        { name: "languages", label: "使用语言", type: "checkboxes", required: true,
          options: [["mandarin", "普通话"], ["cantonese", "广东话"], ["other", "其他"]] },
        { name: "language_other", label: "其他语言（若选“其他”）", type: "text", max: 60 },
        { name: "address", label: "现居地址", type: "text", required: true, max: 160, full: true },
        { name: "phone", label: "手机", type: "tel", required: true, max: 40 },
        { name: "tel", label: "固定电话", type: "tel", max: 40 },
        { name: "email_alt", label: "备用 Email / QQ", type: "text", max: 120 },
        { name: "im_contact", label: "微信 / Line", type: "text", max: 80 },
      ],
    },
    {
      key: "church", title: "2 · 信仰与教会",
      fields: [
        { name: "church_name", label: "教会名称", type: "text", required: true, max: 120 },
        { name: "church_type", label: "教会种类（选填）", type: "select",
          options: [["tspm", "三自"], ["house", "家庭"], ["other", "其它"]] },
        { name: "church_phone", label: "教会电话", type: "tel", max: 40 },
        { name: "church_role", label: "目前服事", type: "text", required: true, max: 120 },
        { name: "conversion_date", label: "初信日期", type: "month", required: true },
        { name: "baptism_date", label: "受洗日期", type: "month" },
      ],
    },
    {
      key: "study", title: "3 · 学历与经历",
      fields: [
        { name: "education", label: "学历（至少一项）", type: "rows", required: true, full: true,
          columns: [["school", "学校"], ["city", "城市"], ["start_ym", "入学年月"], ["end_ym", "毕业年月"], ["degree", "学位 / 文凭"]] },
        { name: "experience", label: "工作 / 事奉简历（选填）", type: "rows", full: true,
          columns: [["org", "教会或机构"], ["city", "城市"], ["start_ym", "开始"], ["end_ym", "结束"], ["position", "职位"]] },
        { name: "family", label: "家庭状况（选填）", type: "rows", full: true,
          columns: [["relation", "关系"], ["name", "姓名"], ["birth_ym", "出生年月"], ["faith", "信仰"]] },
        { name: "family_status", label: "家庭状况说明（选填）", type: "text", max: 200, full: true },
      ],
    },
    {
      key: "intent", title: "4 · 申请意向",
      fields: [
        { name: "programs", label: "申请修读项目（单选）", type: "program", required: true, full: true },
        { name: "__pathway", label: "学习路径", type: "pathway", required: true, full: true },
        { name: "personality", label: "性格", type: "text", max: 120 },
        { name: "health", label: "健康状况（选填）", type: "text", max: 120,
          hint: "一句话即可，例如「良好」。不需要提供病历。" },
        { name: "gifts", label: "恩赐", type: "text", max: 160 },
        { name: "calling", label: "异象 / 蒙召", type: "textarea", required: true, max: 800, full: true },
        { name: "referrer", label: "介绍人及电话", type: "text", max: 120, full: true },
        { name: "special_notes", label: "特记事项（选填）", type: "textarea", max: 800, full: true,
          hint: "如有需要说明的事项请在此填写。" },
      ],
    },
    {
      key: "testimony", title: "5 · 自我介绍与见证",
      fields: [
        { name: "testimony", label: "自我介绍及信仰见证", type: "textarea", required: true, max: 5000, full: true,
          hint: "可包括：信主经过、生命成长、蒙召经历、对神学装备的期待等。" },
      ],
    },
    {
      key: "declare", title: "6 · 确认与提交",
      fields: [
        { name: "declaration_accepted", label: "本人确认以上所填资料真实无误，并愿意接受学校的后续联系与入学安排。",
          type: "checkbox", required: true, full: true },
      ],
    },
  ];

  /** 从 Quick Apply（官网弹窗）预填正式申请草稿 */
  function prefillFromQuickApply(qs) {
    const f = {};
    const map = {
      nameZh: "name_zh", nameEn: "name_en", gender: "gender", birth: "birth_ym",
      nationality: "nationality", phone: "phone", church: "church_name",
      role: "church_role", conversion: "conversion_date", baptism: "baptism_date",
      gifts: "gifts", motivation: "calling", referrer: "referrer", location: "address",
      /* 2026-10-26 官网报名表与总校表统一后新增的栏位 */
      phone_fixed: "tel", phone_church: "church_phone", family_status: "family_status", health: "health",
      personality: "personality",
    };
    for (const [k, v] of Object.entries(map)) if (qs[k]) f[v] = qs[k];
    /* 官网新表把「异象」与「自我介绍及信仰见证」分开了：有异象时它进异象，原来的那段进见证 */
    if (qs.vision) { f.calling = qs.vision; if (qs.motivation) f.testimony = qs.motivation; }
    const CT = { tspm: "tspm", house: "house", other: "other" };
    if (CT[qs.churchType]) f.church_type = CT[qs.churchType];
    const rows = (pre, n, map2) => Array.from({ length: n }, (_, i) => {
      const r = {}; let any = false;
      for (const [from, to] of map2) { const v = qs[pre + i + "_" + from]; if (v) { r[to] = v; any = true; } else r[to] = ""; }
      return any ? r : null;
    }).filter(Boolean);
    const edu = rows("edu", 4, [["school", "school"], ["city", "city"], ["start", "start_ym"], ["end", "end_ym"], ["degree", "degree"]]);
    const work = rows("work", 4, [["org", "org"], ["city", "city"], ["start", "start_ym"], ["end", "end_ym"], ["title", "position"]]);
    const fam = rows("fam", 6, [["rel", "relation"], ["name", "name"], ["birth", "birth_ym"], ["faith", "faith"]]);
    if (work.length) f.experience = work;
    if (fam.length) f.family = fam;
    if (qs.language) f.languages = [qs.language];
    if (qs.program) f.programs = [qs.program];
    if (edu.length) f.education = edu;
    else if (qs.eduSchool || qs.eduLevel) {
      f.education = [{ school: qs.eduSchool || "", city: "", start_ym: "", end_ym: "", degree: qs.eduLevel || "" }];
    }
    return f;
  }

  window.AmasAppForm = { STEPS, PATHWAYS, prefillFromQuickApply };
})();
