/* 总校《神学校入学申请表》网页版的共用部分（Enos 2026-10-26 提供的 Word 表格）。
   单份编辑页 portal/admin/inbox/form/ 与全班打印页 portal/admin/inbox/forms/ 共用：
     AmasSchoolForm.values(row)          报名记录 → 表格栏位值（已保存的 school_form 优先，没有的按报名资料预填）
     AmasSchoolForm.html(V, { editable }) 整张表的 HTML（editable=false 时只读，用于批量打印）
   样式随本文件注入一次。 */
(function () {
  "use strict";
  const UI = window.AmasUI, A = window.AmasAuth;

  const COURSES = ["牧会者进修", "讲道学校", "大学（DIP）", "大学（B.TH）", "研究生院（G/DIP）", "研究生院（M.DIV）", "道学,宣教博士（D.MIN/D.MISS）", "宣教士训练"];
  const PROG = { bth: "大学（B.TH）", pastor: "牧会者进修", preaching: "讲道学校", dip: "大学（DIP）", gdip: "研究生院（G/DIP）",
                 mdiv: "研究生院（M.DIV）", dmin: "道学,宣教博士（D.MIN/D.MISS）", missionary: "宣教士训练" };
  /* 官网报名表 2026-10-26 起直接用本表的栏位名（固定电话、家庭、学历 / 工作多行等），原样带入。 */
  const SAME = /^(phone_fixed|phone_church|family_status|health|personality|vision|(edu|work)[0-3]_(school|city|start|end|degree|org|title)|fam[0-5]_(rel|name|birth|faith))$/;
  const EDU = { secondary: "高中及以下", college: "大专", bachelor: "本科", master: "硕士及以上" };
  const NAT = { C: "中国", China: "中国", Myanmar: "缅甸" };
  const ROWS = 4, FAM = 6;

  /* 报名资料 → 表格栏位。只填有的，没有的留空给教务补。 */
  function prefill(d) {
    const f = {
      course: PROG[d.program] || "", name_zh: d.fullName || "", name_en: d.englishName || "",
      gender: d.gender === "male" ? "男" : d.gender === "female" ? "女" : "",
      nationality: NAT[d.nationality] || d.nationality || "", birth: d.birth || "",
      language: d.language === "mandarin" ? "普通话" : d.language === "cantonese" ? "广东话" : d.language ? "其他" : "",
      language_other: d.language && !["mandarin", "cantonese"].includes(d.language) ? d.language : "",
      address: d.location || "", church: d.church || "",
      church_type: d.churchType === "tspm" ? "三自" : d.churchType === "house" ? "家庭" : d.churchType ? "其它" : "",
      mobile: d.phone || "", email: d.email || "",
      apply_date: (d.submittedAt || "").slice(0, 10),
      first_faith: d.conversionDate || "", baptism: d.baptismDate || "", referrer: d.referrer || "",
      gifts: d.gifts || "", testimony: d.motivation || "",
    };
    if (d.eduSchool || d.eduLevel) { f.edu0_school = d.eduSchool || ""; f.edu0_degree = EDU[d.eduLevel] || d.eduLevel || ""; }
    if (d.role && d.church) { f.work0_org = d.church; f.work0_title = d.role; }
    const hasRows = (p) => Object.keys(d).some((k) => k.startsWith(p) && SAME.test(k) && d[k]);
    if (hasRows("edu")) { delete f.edu0_school; delete f.edu0_degree; }
    if (hasRows("work")) { delete f.work0_org; delete f.work0_title; }
    for (const k of Object.keys(d)) if (SAME.test(k) && d[k]) f[k] = d[k];
    /* 新表只填了学历行、没写学位时，用「最高学历」补第一行的学位 */
    if (hasRows("edu") && !f.edu0_degree && d.eduLevel) f.edu0_degree = EDU[d.eduLevel] || d.eduLevel;
    return f;
  }

  const saved = (row) => row && row.school_form && Object.keys(row.school_form).length ? row.school_form : null;
  const values = (row) => Object.assign(prefill((row && row.data) || {}), saved(row) || {});

  function html(V, opts) {
    const editable = !opts || opts.editable !== false;
    const e = (k, cls) => editable
      ? '<div class="v' + (cls ? " " + cls : "") + '" contenteditable="plaintext-only" data-k="' + k + '" aria-label="' + k + '">' + UI.esc(V[k] || "") + '</div>'
      : '<div class="v' + (cls ? " " + cls : "") + '" data-k="' + k + '">' + UI.esc(V[k] || "") + '</div>';
    const ck = (k, list) => list.map((o) => editable
      ? '<button type="button" class="ck" data-ck="' + k + '" data-v="' + UI.esc(o) + '" aria-pressed="' + (V[k] === o) + '">' + UI.esc(o) + '</button>'
      : '<span class="ck" data-ck="' + k + '" aria-pressed="' + (V[k] === o) + '">' + UI.esc(o) + '</span>').join("");
    const l = (t, span, rows) => '<td class="l"' + (span ? ' colspan="' + span + '"' : "") + (rows ? ' rowspan="' + rows + '"' : "") + '>' + t + '</td>';
    const c = (inner, span) => '<td' + (span ? ' colspan="' + span + '"' : "") + '>' + inner + '</td>';
    const rep = (n, f) => Array.from({ length: n }, (_, i) => f(i)).join("");
    /* 8 列网格，对应纸本表的栏位顺序。 */
    const table =
      '<table class="af"><colgroup>' + rep(8, () => '<col>') + '</colgroup>' +
      '<tr>' + l("申请修读课程", 2) + c(ck("course", COURSES), 6) + '</tr>' +
      '<tr>' + l("姓名", 1, 2) + l("中文") + c(e("name_zh"), 2) + c('性别：' + ck("gender", ["男", "女"]), 2) + l("国籍") + c(e("nationality")) + '</tr>' +
      '<tr>' + l("英文") + c(e("name_en"), 2) + l("出生年月") + c(e("birth"), 3) + '</tr>' +
      '<tr>' + l("使用语言", 2) + c(ck("language", ["普通话", "广东话", "其他"]) + '<span style="display:inline-block;min-width:80px;vertical-align:middle">' + e("language_other") + '</span>', 6) + '</tr>' +
      '<tr>' + l("地址", 2) + c(e("address"), 6) + '</tr>' +
      '<tr>' + l("教会名", 2) + c(e("church"), 2) + l("教会种类") + c(ck("church_type", ["三自", "家庭", "其它"]), 3) + '</tr>' +
      '<tr>' + l("联系处", 1, 2) + l("固定电话") + c(e("phone_fixed"), 2) + l("教会") + c(e("phone_church"), 3) + '</tr>' +
      '<tr>' + l("手机") + c(e("mobile"), 2) + l("Email/QQ") + c(e("email"), 3) + '</tr>' +
      '<tr>' + l("学历", 1, ROWS + 1) + l("学校", 2) + l("城市") + l("入学日期") + l("毕业日期") + l("学位或文凭", 2) + '</tr>' +
      rep(ROWS, (i) => '<tr>' + c(e("edu" + i + "_school"), 2) + c(e("edu" + i + "_city")) + c(e("edu" + i + "_start")) + c(e("edu" + i + "_end")) + c(e("edu" + i + "_degree"), 2) + '</tr>') +
      '<tr>' + l("工作简历", 1, ROWS + 1) + l("教会或机构名", 2) + l("城市") + l("开始日期") + l("离职日期") + l("职位", 2) + '</tr>' +
      rep(ROWS, (i) => '<tr>' + c(e("work" + i + "_org"), 2) + c(e("work" + i + "_city")) + c(e("work" + i + "_start")) + c(e("work" + i + "_end")) + c(e("work" + i + "_title"), 2) + '</tr>') +
      '<tr>' + c('<div style="display:flex;gap:10px;align-items:center;justify-content:flex-end"><span>日期</span><span style="min-width:110px">' + e("apply_date") +
        '</span><span>申请人签署：</span><span style="min-width:140px">' + e("signature") + '</span></div>', 8) + '</tr>' +
      '<tr class="sec"><td colspan="8">家庭状况</td></tr>' +
      '<tr>' + l("关系") + l("姓名") + l("出生年月") + l("信仰") + l("关系") + l("姓名") + l("出生年月") + l("信仰") + '</tr>' +
      rep(FAM / 2, (i) => '<tr>' + ["rel", "name", "birth", "faith"].map((k) => c(e("fam" + (i * 2) + "_" + k))).join("") +
                                   ["rel", "name", "birth", "faith"].map((k) => c(e("fam" + (i * 2 + 1) + "_" + k))).join("") + '</tr>') +
      '<tr class="sec"><td colspan="8">特记事项</td></tr>' +
      '<tr>' + l("初信日期") + c(e("first_faith")) + l("受洗日期") + c(e("baptism")) + l("健康状况") + c(e("health")) + l("性格") + c(e("personality")) + '</tr>' +
      '<tr>' + l("介绍人及电话") + c(e("referrer"), 3) + l("家庭状况") + c(e("family_status"), 3) + '</tr>' +
      '<tr>' + l("恩赐") + c(e("gifts"), 3) + l("异象") + c(e("vision"), 3) + '</tr>' +
      '<tr class="sec"><td colspan="8">自我介绍及信仰见证</td></tr>' +
      '<tr>' + c(e("testimony", "big"), 8) + '</tr></table>';
    return '<div class="af-wrap"><div class="af-head"><img src="' + A.ROOT + 'assets/img/ama-form-logo.jpg" alt="AMA Theological Seminary"><h2>神学校入学申请表</h2>' +
      '<span style="width:44px"></span></div>' + table + '</div>';
  }

  const CSS =
    ".af-wrap{background:#fff;border:1px solid var(--line);border-radius:12px;padding:18px;overflow-x:auto}" +
    ".af-head{display:flex;align-items:center;gap:14px;margin-bottom:10px}.af-head img{height:44px}" +
    ".af-head h2{flex:1;text-align:center;margin:0;font-size:22px;letter-spacing:.3em;color:#111}" +
    "table.af{width:100%;min-width:640px;border-collapse:collapse;table-layout:fixed;font-size:13px;color:#111}" +
    ".af td{border:1px solid #333;padding:4px 6px;vertical-align:middle;word-break:break-word}" +
    ".af td.l{background:#f6f4ee;text-align:center;font-weight:700;white-space:nowrap}" +
    ".af .sec td{background:#ece8dc;text-align:center;font-weight:700;letter-spacing:.2em}" +
    ".v{min-height:22px;outline:none;white-space:pre-wrap}.v:focus{background:#fff8e1}.v.big{min-height:120px}" +
    ".ck{display:inline-flex;align-items:center;gap:3px;margin:2px 10px 2px 0;border:0;background:none;font:inherit;font-size:13px;cursor:pointer;padding:2px 0;color:#111}" +
    ".ck::before{content:'☐';font-size:15px}.ck[aria-pressed=true]::before{content:'☑'}" +
    "@media print{@page{size:A4;margin:12mm}.af-wrap{border:0;padding:0;overflow:visible}table.af{min-width:0;font-size:11.5px}" +
    ".v:focus{background:none}.v:empty::after{content:'\\00a0'}.af-page{break-after:page}.af-page:last-child{break-after:auto}}";
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);

  window.AmasSchoolForm = { prefill, values, saved, html, COURSES };
})();
