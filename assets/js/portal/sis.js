/* 学员管理系统各页共用：文案、日期、带输入的确认框、写入包装。
   写入包装守三条规矩：结果不明（断网 / 5xx / 空响应）不劝重试；同一对象在途不发第二笔；
   服务端给了错误码就照实翻译。依赖 AmasApi / AmasUI。 */
(function () {
  "use strict";
  const Api = window.AmasApi, UI = window.AmasUI;

  const MODE = { online: "线上", onsite: "清迈线下", hybrid: "线上 + 线下" };
  const OST = { planned: "未开课", in_progress: "上课中", completed: "已结课", cancelled: "已取消" };
  const ATT = { present: "出席", late: "迟到", excused: "请假", absent: "缺席" };
  const GST = { none: "未录", draft: "草稿", submitted: "待教务发布", published: "已发布" };
  const SST = { pre_enrolled: "待正式注册", active: "在读", on_leave: "休学中", withdrawn: "已退学", graduated: "已毕业" };
  const UNKNOWN_TEXT = "没有拿到这次操作的结果，无法确认它是否已经生效。请先刷新核实，不要重复提交。";
  const UNKNOWN_CODES = { network: 1, server_error: 1, unknown: 1 };

  const ERR = {
    mfa_required: "这项操作需要先完成两步验证。请退出后重新登录并完成验证。",
    not_assigned: "你现在不是这个班的任课教授（或已被撤下），不能操作。",
    invalid_state: "当前状态不允许这项操作。",
    invalid_fields: "填写有误，请检查日期、链接（须以 https:// 开头）或权重（1–100）。",
    bad_request: "提交的内容不完整或格式不对。",
    not_found: "要操作的记录已经不存在，请刷新。",
    reason_required: "请填写原因。",
    grades_incomplete: "还有学员没有录总评，全部录完才能提交。",
    nothing_to_submit: "没有可提交的草稿（可能已经提交过）。",
    nothing_to_publish: "这个班没有待发布的成绩。",
    nothing_to_return: "这个班没有待发布的成绩可退回。",
    not_published: "这条成绩还没有发布，直接在草稿里改即可。",
    unchanged: "新等级与原等级相同。",
    correction_pending: "这条成绩已有一份待审批的更正申请。",
    bad_grade: "不是有效的等级。",
    same_actor_not_allowed: "不能审批自己发起的更正，请由另一位教务处理。",
    not_eligible: "还不满足毕业条件。",
    not_a_mentor: "这个账号没有有效的导师身份。",
    already_assigned: "已经指派过了。",
    not_active: "只有在读或休学中的学员才能指派导师。",
    bad_date: "日期不能晚于今天。",
    unknown_item: "不是本项目的实践训练项目。",
    not_reported: "这一项还没有填报。",
    not_a_student: "你的学员身份当前无效。",
    already_credited: "这门课已经有学分（本校修过或已免修），不能再转入。",
    unknown_course: "不是本项目带学分的课程。",
    bad_credits: "学分须在 0 到 30 之间。",
    over_cap: "超过转入学分上限。",
    already_revoked: "这笔转入已经撤回过了。",
  };

  const d = (v) => (v ? String(v).slice(0, 10) : "待定");
  const span = (a, b) => (a || b ? d(a) + " 至 " + d(b) : "日期待定");
  const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

  const busy = new Set();
  /** 写入。kind = "rpc"（authenticated RPC）或 "fn"（Edge Function 名）。返回 data 或 null。 */
  async function write({ lock, rpc, fn, args, say }) {
    if (lock && busy.has(lock)) { UI.toast("上一次提交还没有回结果，这一次没有发出。", "err"); return null; }
    if (lock) busy.add(lock);
    try {
      const { data, error } = rpc ? await Api.rpc(rpc, args) : await Api.fn(fn, args, { requireAal2: true });
      if (error) {
        if (!error.code || UNKNOWN_CODES[error.code]) say(UNKNOWN_TEXT);
        else say(ERR[error.code] || error.message || error.code);
        return null;
      }
      if (!data) { say(UNKNOWN_TEXT); return null; }
      if (data.ok === false) {
        say((ERR[data.error] || data.error) + (data.missing ? "（还差 " + data.missing + " 人）" : ""));
        return null;
      }
      if (data.ok !== true) { say(UNKNOWN_TEXT); return null; }
      return data;
    } finally { if (lock) busy.delete(lock); }
  }

  /** 带输入的确认框。fields: [{id,label,type:"text"|"textarea"|"select"|"date",options:[[v,l]],required,value}]
      返回 {id: value} 或 null（取消）。 */
  function ask({ title, text, fields, confirmLabel, danger }) {
    return new Promise((resolve) => {
      const prev = document.activeElement;
      const wrap = document.createElement("div");
      wrap.className = "portal-modal";
      const inp = (f) => {
        const id = "ask-" + f.id;
        const base = 'id="' + id + '" data-k="' + f.id + '" style="width:100%;min-height:44px;padding:9px 12px;border:1.5px solid var(--line);border-radius:10px;font:inherit"';
        const ctl = f.type === "textarea" ? "<textarea " + base + ' rows="3" maxlength="1000">' + UI.esc(f.value || "") + "</textarea>"
          : f.type === "select" ? "<select " + base + ">" + f.options.map((o) =>
              '<option value="' + UI.esc(o[0]) + '"' + (o[0] === f.value ? " selected" : "") + ">" + UI.esc(o[1]) + "</option>").join("") + "</select>"
          : "<input " + base + ' type="' + (f.type || "text") + '" value="' + UI.esc(f.value || "") + '">';
        return '<div style="margin-top:10px"><label for="' + id + '" style="display:block;font-size:13px;font-weight:700;color:var(--navy);margin-bottom:5px">' +
          UI.esc(f.label) + (f.required ? "" : "（可选）") + "</label>" + ctl + "</div>";
      };
      wrap.innerHTML = '<div class="pm-backdrop" data-x></div><div class="pm-card" role="dialog" aria-modal="true" aria-labelledby="ask-t">' +
        '<h3 id="ask-t">' + UI.esc(title) + "</h3>" + (text ? "<p>" + UI.esc(text) + "</p>" : "") +
        (fields || []).map(inp).join("") +
        '<div class="msg err" id="ask-err" style="margin-top:8px"></div>' +
        '<div class="pm-acts"><button class="btn ghost" data-cancel style="width:auto;padding:0 20px">取消</button>' +
        '<button class="btn' + (danger ? " danger" : "") + '" data-ok style="width:auto;padding:0 20px">' + UI.esc(confirmLabel || "确认") + "</button></div></div>";
      document.body.appendChild(wrap);
      (wrap.querySelector("[data-k]") || wrap.querySelector("[data-ok]")).focus();
      const close = (v) => { wrap.remove(); document.removeEventListener("keydown", onKey); prev?.focus?.(); resolve(v); };
      const onKey = (e) => { if (e.key === "Escape") close(null); };
      document.addEventListener("keydown", onKey);
      wrap.querySelector("[data-cancel]").addEventListener("click", () => close(null));
      wrap.querySelector("[data-x]").addEventListener("click", () => close(null));
      wrap.querySelector("[data-ok]").addEventListener("click", () => {
        const v = {};
        wrap.querySelectorAll("[data-k]").forEach((el) => { v[el.dataset.k] = el.value.trim(); });
        const miss = (fields || []).filter((f) => f.required && !v[f.id]);
        if (miss.length) {
          const e = wrap.querySelector("#ask-err");
          e.textContent = "请填写：" + miss.map((f) => f.label).join("、"); e.classList.add("show"); return;
        }
        close(v);
      });
    });
  }

  let scale = null;
  /** 等级表（A+ … F）。读不到时返回 null，调用方不得自己编一份。 */
  async function gradeScale() {
    if (scale) return scale;
    const { data, error } = await Api.select("grade_scale", { columns: "letter,points,passing,sort", order: { column: "sort", asc: true } });
    if (error || !Array.isArray(data) || !data.length) return null;
    return (scale = data);
  }

  const CSS = ".ofs{display:grid;gap:14px}" +
    ".of{border:1px solid #e6e2d8;border-radius:16px;background:#fff;padding:18px 20px;display:grid;gap:8px;box-shadow:0 8px 24px rgba(16,40,72,.06)}" +
    ".of h3{margin:0;font-size:17px;color:var(--navy);font-weight:700}" +
    ".of .meta{font-size:12.5px;color:var(--muted);display:flex;flex-wrap:wrap;gap:4px 12px}" +
    ".of .top{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}" +
    ".chip{display:inline-block;padding:2px 10px;border-radius:99px;font-size:11.5px;font-weight:700;white-space:nowrap;background:#f1efe8;color:#5f5a4c}" +
    ".chip.planned,.chip.draft,.chip.pre_enrolled{background:#fdf4e3;color:#7a5a12}" +
    ".chip.in_progress,.chip.published,.chip.active,.chip.present{background:#e9f3ee;color:var(--ok)}" +
    ".chip.completed,.chip.submitted,.chip.on_leave,.chip.graduated,.chip.late{background:#eaf0f8;color:#10305a}" +
    ".chip.cancelled,.chip.withdrawn,.chip.absent{background:#f3e9e9;color:#8a2c2c}.chip.excused{background:#f4f1ea;color:#6b4d22}" +
    ".sbtn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:42px;padding:0 15px;border:1px solid #cfd5df;border-radius:9px;background:#fff;color:var(--ink);font:inherit;font-size:13.5px;cursor:pointer;white-space:nowrap;text-decoration:none;transition:border-color .15s,background .15s}" +
    ".sbtn:hover{border-color:var(--navy2);background:#f7f9fc}" +
    ".sbtn.pri{background:var(--navy);border-color:var(--navy);color:#fff;font-weight:600;box-shadow:0 4px 12px rgba(16,47,85,.22)}.sbtn.pri:hover{background:var(--navy2)}.sbtn:disabled{opacity:.5;cursor:not-allowed}" +
    ".bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}" +
    ".tabs{display:flex;gap:4px;margin:0 0 14px;padding:5px;background:#fff;border:1px solid #e6e2d8;border-radius:14px;box-shadow:0 6px 18px rgba(16,40,72,.05);overflow-x:auto}" +
    ".tabs button{flex:1 0 auto;display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:44px;padding:0 16px;border:0;border-radius:10px;background:none;font:inherit;font-size:14px;cursor:pointer;color:var(--ink);white-space:nowrap}" +
    ".tabs button:hover{background:#f2f4f8}" +
    ".tabs button[aria-selected=true]{background:var(--navy);color:#fff;font-weight:600;box-shadow:0 4px 12px rgba(16,47,85,.25)}" +
    ".row{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line);font-size:14px;flex-wrap:wrap}" +
    ".row:last-child{border-bottom:0}.row small{color:var(--muted)}" +
    ".row select,.row input,.f input,.f select,.f textarea{min-height:42px;padding:8px 10px;border:1.5px solid var(--line);border-radius:9px;font:inherit;background:#fff;color:var(--ink);max-width:100%}" +
    ".f{display:flex;flex-direction:column;gap:5px}.f label{font-size:13px;font-weight:700;color:var(--navy)}" +
    ".grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}.full{grid-column:1/-1}" +
    ".meter{height:12px;border-radius:99px;background:#eceae3;overflow:hidden}.meter i{display:block;height:100%;background:var(--navy)}" +
    ".stat{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.stat div{border:1px solid var(--line);border-radius:12px;background:#fff;padding:12px;text-align:center}" +
    ".stat b{display:block;font-size:22px;color:var(--navy)}.stat span{font-size:12px;color:var(--muted)}" +
    "@media(max-width:640px){.grid2{grid-template-columns:1fr}}" +
    ".tr{background:#fff;border:1px solid var(--line);border-radius:12px;padding:18px;color:#111}" +
    ".tr-head{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;border-bottom:2px solid #10305a;padding-bottom:8px;margin-bottom:10px;font-size:14px}" +
    ".tr table{width:100%;border-collapse:collapse;margin:10px 0;font-size:13px}" +
    ".tr th,.tr td{border:1px solid #cfcac0;padding:6px 8px;text-align:left;vertical-align:top}" +
    ".tr th{background:#f4f1ea;font-weight:700;white-space:nowrap}.tr-c td:nth-child(n+3){white-space:nowrap}" +
    ".tr-note{font-size:12px;color:#555;margin:10px 0 0}" +
    ".tr-sign{display:flex;flex-wrap:wrap;gap:8px 28px;margin-top:22px;font-size:13px}" +
    "@media print{.pn,.portal-shell>header,.ph,.no-print,.toast{display:none!important}body{background:#fff!important}" +
    ".tr{border:0;padding:0}main{padding:0!important;margin:0!important}}";
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);

  /* 成绩单（my_transcript / admin_transcript 的结果）。
     Enos 2026-10-23：学士班成绩单由 AMAS神学院-清迈分院出具（分校对学士班有出具权）。
     系统只排版、留签章栏，不印电子章：加盖教务章后为正式成绩单。 */
  function transcriptHtml(t) {
    const e = UI.esc;
    const courses = t.courses || [], transfers = t.transfers || [], prac = (t.practicum || []).filter((p) => p.done);
    const num = (v) => (v == null ? "—" : Number(v).toFixed(2));
    return '<div class="tr">' +
      '<div class="tr-head"><b>AMAS神学院-清迈分院　成绩单</b><span>打印日期 ' + today() + '</span></div>' +
      '<table class="tr-id"><tr><th>姓名</th><td>' + e(t.name || "—") + '</td><th>学号</th><td>' + e(t.student_number || "—") + '</td></tr>' +
      '<tr><th>项目</th><td>' + e(t.program_name || t.program_code || "—") + '</td><th>学籍状态</th><td>' + e(SST[t.status] || t.status || "—") + '</td></tr>' +
      '<tr><th>入学（正式注册）</th><td>' + d(t.activated_at) + '</td><th>毕业</th><td>' + (t.graduation ? d(t.graduation.graduated_on) : "—") + '</td></tr></table>' +
      '<table class="tr-c"><thead><tr><th>学年</th><th>课程</th><th>学分</th><th>等级</th><th>绩点</th></tr></thead><tbody>' +
      (courses.length ? courses.map((c) => '<tr><td>' + e(c.academic_year) + '</td><td>' + e(c.title_zh) + '</td><td>' + (c.credits ?? "—") +
          '</td><td>' + e(c.grade) + '</td><td>' + Number(c.points).toFixed(1) + '</td></tr>').join("")
        : '<tr><td colspan="5">尚无已发布的课程成绩</td></tr>') + '</tbody></table>' +
      (transfers.length ? '<table class="tr-c"><thead><tr><th colspan="2">外校转入 / 免修</th><th>学分</th><th colspan="2">依据</th></tr></thead><tbody>' +
        transfers.map((x) => '<tr><td colspan="2">' + e(x.title_zh || "一般转入学分") + '</td><td>' + x.credits + '</td><td colspan="2">' + e(x.evidence || x.reason || "") + '</td></tr>').join("") +
        '</tbody></table>' : "") +
      (prac.length ? '<table class="tr-c"><thead><tr><th colspan="2">实践训练</th><th>学分</th><th colspan="2">完成日期</th></tr></thead><tbody>' +
        prac.map((p) => '<tr><td colspan="2">' + e(p.title_zh) + '</td><td>' + p.credits + '</td><td colspan="2">' + d(p.completed_on) + '</td></tr>').join("") +
        '</tbody></table>' : "") +
      '<table class="tr-id"><tr><th>课程学分</th><td>' + (t.course_credits || 0) + '</td><th>实践训练学分</th><td>' + (t.practicum_credits || 0) + '</td></tr>' +
      '<tr><th>转入学分</th><td>' + (t.transfer_credits || 0) + '</td><th>合计 / 毕业要求</th><td><b>' + (t.credits_earned || 0) +
        (t.credits_required ? ' / ' + t.credits_required : "") + '</b></td></tr>' +
      '<tr><th>平均绩点 GPA</th><td><b>' + num(t.gpa) + '</b></td><th>计分方式</th><td>A+ 至 F，4.0 制；转入学分不计 GPA</td></tr></table>' +
      '<div class="tr-sign"><span>出具单位：AMAS神学院-清迈分院</span><span>教务签章：＿＿＿＿＿＿＿＿</span><span>日期：＿＿＿＿＿＿</span></div>' +
      '<p class="tr-note">本成绩单由 AMAS神学院-清迈分院出具，加盖教务章后为正式成绩单。</p></div>';
  }

  window.AmasSis = { MODE, OST, ATT, GST, SST, ERR, UNKNOWN_TEXT, d, span, today, write, ask, gradeScale, transcriptHtml };
})();
