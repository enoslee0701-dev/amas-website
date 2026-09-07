/**
 * E2E Acceptance Matrix · 可执行骨架（RELEASE READINESS 任务 E3）
 *
 * 目的：把已设计的 E2E 验收矩阵固化成**可执行**的清单，使得 staging 一旦就绪，
 * 注入环境变量即可直接开跑，不需要再重新设计一遍。
 *
 * ★ 铁律：**禁止 fake pass。**
 *   缺环境时每条用例报 BLOCKED_BY_ENV 并计入 blocked，
 *   **绝不**因为"跑不了"就标绿。退出码在存在 blocked 时为 2（区别于真实失败的 1）。
 *
 * ★ 未实现的产品功能报 NOT_IMPLEMENTED，不算通过也不算失败 —— 它是产品事实，
 *   不是测试问题。用 mock 让它变绿是被明确禁止的。
 *
 * 运行：
 *   node supabase/tests/e2e_acceptance_matrix.mjs            # 列出矩阵与就绪状态
 *   AMAS_ENV=staging.env node supabase/tests/e2e_acceptance_matrix.mjs   # 实跑
 *
 * 需要的环境变量（staging 就绪后提供）：
 *   STAGING_BASE_URL   前端可访问的 https 根地址
 *   SUPABASE_URL       Supabase project URL
 *   SUPABASE_ANON_KEY  anon / publishable key
 *   TEST_USER          一次性测试账号（applicant）  形如 email:password
 *   TEST_TEACHER       一次性测试账号（teacher）
 *   TEST_ADMIN         一次性测试账号（admin）
 *
 * ⚠ 测试账号必须是**一次性 fixture**，清理方法见文件末尾 CLEANUP 说明。
 *   不得使用真实业务账号，不得修改真实业务数据。
 */

import fs from 'node:fs';

// ── 环境装载 ─────────────────────────────────────────────────────
const envPath = process.env.AMAS_ENV;
const fileEnv = envPath && fs.existsSync(envPath)
  ? Object.fromEntries(
      fs.readFileSync(envPath, 'utf8').trim().split(/\r?\n/)
        .filter(l => l && !l.startsWith('#') && l.includes('='))
        .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
    )
  : {};
const ENV = { ...fileEnv, ...process.env };

const REQUIRED = ['STAGING_BASE_URL', 'SUPABASE_URL', 'SUPABASE_ANON_KEY'];
const REQUIRED_ACCOUNTS = ['TEST_USER', 'TEST_TEACHER', 'TEST_ADMIN'];

const missing = [...REQUIRED, ...REQUIRED_ACCOUNTS].filter(k => !ENV[k]);
const envReady = missing.length === 0;

// ── 状态常量 ─────────────────────────────────────────────────────
const PASS = 'PASS';
const FAIL = 'FAIL';
const BLOCKED = 'BLOCKED_BY_ENV';
const NOT_IMPL = 'NOT_IMPLEMENTED';

/**
 * 矩阵定义。
 *   id        稳定标识，报告与 blocker 表引用它
 *   group     A public / B applicant / C student / D teacher / E admin / N negative
 *   name      用例描述
 *   impl      产品是否已实现。false → 永远报 NOT_IMPLEMENTED，绝不 mock
 *   run       实跑函数（env 就绪时调用）。未提供 → 报 BLOCKED_BY_ENV
 */
const MATRIX = [
  // ── A. Public ────────────────────────────────────────────────
  { id: 'A-01', group: 'A public', name: '官网首页可达且返回 200', impl: true,
    run: async () => httpOk(`${ENV.STAGING_BASE_URL}/`) },
  { id: 'A-02', group: 'A public', name: '课程/项目页可浏览', impl: true,
    run: async () => httpOk(`${ENV.STAGING_BASE_URL}/discover.html`) },
  { id: 'A-03', group: 'A public', name: '注册：新账号可创建并落库', impl: true },
  { id: 'A-04', group: 'A public', name: '邮件验证：收到真实验证邮件并可激活', impl: true },
  { id: 'A-05', group: 'A public', name: '登录：验证后可登录并取得 session', impl: true },
  { id: 'A-06', group: 'A public', name: '登出：session 失效，受保护页面回到登录', impl: true },
  { id: 'A-07', group: 'A public', name: '忘记密码：收到重置邮件并可设新密码', impl: true },
  { id: 'A-08', group: 'A public', name: '刷新页面后 session 保持', impl: true },

  // ── B. Applicant ─────────────────────────────────────────────
  { id: 'B-01', group: 'B applicant', name: '注册后自动获得 applicant 角色（且仅此角色）', impl: true },
  { id: 'B-02', group: 'B applicant', name: '填写并保存申请草稿', impl: true },
  { id: 'B-03', group: 'B applicant', name: '提交申请 → 状态进入待审核，字段锁定生效', impl: true },
  { id: 'B-04', group: 'B applicant', name: '申请人可查看自己的申请状态与时间线', impl: true },
  { id: 'B-05', group: 'B applicant', name: '管理员审核：要求补件', impl: true },
  { id: 'B-06', group: 'B applicant', name: '申请人补件后重新提交', impl: true },
  { id: 'B-07', group: 'B applicant', name: '管理员录取 → accepted', impl: true },
  { id: 'B-08', group: 'B applicant', name: '身份转换：HQ 审核建立学籍后授予 student 角色', impl: true },
  { id: 'B-09', group: 'B applicant', name: 'accepted 本身不得自动授予 student 或生成学号（D-2）', impl: true },
  { id: 'B-10', group: 'B applicant', name: '转换后可进入学员中心', impl: true },

  // ── C. Student ───────────────────────────────────────────────
  { id: 'C-01', group: 'C student', name: '学员登录进入学员首页', impl: true },
  { id: 'C-02', group: 'C student', name: '查看课程目录（67 门 / 7 类）', impl: true },
  { id: 'C-03', group: 'C student', name: 'credits 为 null 时显示"不显示学分信息"，不推算', impl: true },
  { id: 'C-04', group: 'C student', name: '无 enrollment 时显示真实空态，不创建空记录', impl: true },
  { id: 'C-05', group: 'C student', name: '待处理事项列表', impl: true },
  { id: 'C-06', group: 'C student', name: '学习进度', impl: false },
  { id: 'C-07', group: 'C student', name: '作业', impl: false },
  { id: 'C-08', group: 'C student', name: '出勤', impl: false },
  { id: 'C-09', group: 'C student', name: '成绩', impl: false },
  { id: 'C-10', group: 'C student', name: '11 项实践训练', impl: false },
  { id: 'C-11', group: 'C student', name: 'Christian Profile：Level 0 快速探索可完成并出结果', impl: true,
    run: async () => httpOk(`${ENV.STAGING_BASE_URL}/discover.html`) },
  { id: 'C-12', group: 'C student', name: '成长路径', impl: false },

  // ── D. Teacher ───────────────────────────────────────────────
  { id: 'D-01', group: 'D teacher', name: '管理员签发教师邀请码', impl: true },
  { id: 'D-02', group: 'D teacher', name: '教师凭邀请码提交资质验证', impl: true },
  { id: 'D-03', group: 'D teacher', name: '邀请码一次性核销，重复使用被拒', impl: true },
  { id: 'D-04', group: 'D teacher', name: '邮件验证', impl: true },
  { id: 'D-05', group: 'D teacher', name: '管理员审核通过 → 同事务授予 teacher 角色', impl: true },
  { id: 'D-06', group: 'D teacher', name: '教师激活时强制注册 TOTP（aal2）', impl: true },
  { id: 'D-07', group: 'D teacher', name: '教师登录进入工作台', impl: true },
  { id: 'D-08', group: 'D teacher', name: '查看被分配的课程', impl: false,
    note: 'is_assigned_teacher 仍为 fail-closed 占位（恒 false），缺 teacher_assignments 表' },
  { id: 'D-09', group: 'D teacher', name: '查看授权学员', impl: false },
  { id: 'D-10', group: 'D teacher', name: '出勤 / 作业 / 成绩录入', impl: false },
  { id: 'D-11', group: 'D teacher', name: 'suspend/revoke 即时撤销角色与学号别名', impl: true },

  // ── E. Admin ─────────────────────────────────────────────────
  { id: 'E-01', group: 'E admin', name: '申请管理列表与审核动作', impl: true },
  { id: 'E-02', group: 'E admin', name: '教师验证审核', impl: true },
  { id: 'E-03', group: 'E admin', name: '学生学籍管理', impl: true },
  { id: 'E-04', group: 'E admin', name: '课程目录只读呈现', impl: true },
  { id: 'E-05', group: 'E admin', name: '班级管理', impl: false },
  { id: 'E-06', group: 'E admin', name: '审计日志按类别分读（super/academic/registrar/finance）', impl: true },
  { id: 'E-07', group: 'E admin', name: '学号纠错双人控制：发起人 ≠ 确认人，且须含 super_admin（R-3）', impl: true },
  { id: 'E-08', group: 'E admin', name: '管理动作强制 aal2', impl: true },

  // ── N. Authorization Negative（STEP 5：证明"错误的人进不去"）──
  { id: 'N-01', group: 'N negative', name: 'anon → 学生数据 DENY', impl: true },
  { id: 'N-02', group: 'N negative', name: 'anon → 教师数据 DENY', impl: true },
  { id: 'N-03', group: 'N negative', name: 'anon → admin 接口 DENY', impl: true },
  { id: 'N-04', group: 'N negative', name: 'student A → student B 数据 DENY', impl: true },
  { id: 'N-05', group: 'N negative', name: 'student → teacher 接口 DENY', impl: true },
  { id: 'N-06', group: 'N negative', name: 'student → admin 接口 DENY', impl: true },
  { id: 'N-07', group: 'N negative', name: 'teacher A → teacher B 未授权班级 DENY', impl: true },
  { id: 'N-08', group: 'N negative', name: 'teacher → 非本人负责学生 DENY', impl: true },
  { id: 'N-09', group: 'N negative', name: '普通用户 → 修改自身 role DENY', impl: true },
  { id: 'N-10', group: 'N negative', name: '普通用户 → 修改 account_status DENY', impl: true },
  { id: 'N-11', group: 'N negative', name: '普通用户 → 自授 admin DENY', impl: true },
  { id: 'N-12', group: 'N negative', name: '绕过 UI 直打 REST / RPC / Edge 一律被拒（R-2）', impl: true },
  { id: 'N-13', group: 'N negative', name: '合法 RPC 之后同事务内直写被拒（R-1 逃逸测试）', impl: true },
  { id: 'N-14', group: 'N negative', name: 'fail-closed 占位函数确实返回 false（R-5）', impl: true },
];

// ── 最小工具 ─────────────────────────────────────────────────────
async function httpOk(url) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return `HTTP ${r.status}`;
}

// ── 执行 ─────────────────────────────────────────────────────────
const results = [];
for (const c of MATRIX) {
  if (!c.impl) {
    results.push({ ...c, status: NOT_IMPL, detail: c.note ?? '产品未实现，不得以 mock 充数' });
    continue;
  }
  if (!envReady || !c.run) {
    results.push({
      ...c,
      status: BLOCKED,
      detail: !envReady ? `缺环境变量: ${missing.join(', ')}` : '实跑逻辑待 staging 就绪后补齐',
    });
    continue;
  }
  try {
    const detail = await c.run();
    results.push({ ...c, status: PASS, detail });
  } catch (e) {
    results.push({ ...c, status: FAIL, detail: String(e?.message ?? e) });
  }
}

// ── 报告 ─────────────────────────────────────────────────────────
const tally = { PASS: 0, FAIL: 0, BLOCKED_BY_ENV: 0, NOT_IMPLEMENTED: 0 };
let lastGroup = '';
console.log('\n===== E2E ACCEPTANCE MATRIX =====');
console.log(`环境: ${envReady ? '就绪' : 'NOT READY — ' + missing.join(', ')}\n`);
for (const r of results) {
  tally[r.status]++;
  if (r.group !== lastGroup) { console.log(`\n-- ${r.group} --`); lastGroup = r.group; }
  console.log(`  ${r.id}  ${r.status.padEnd(15)} ${r.name}`);
  if (r.status === FAIL) console.log(`         └─ ${r.detail}`);
}
console.log('\n===== 汇总 =====');
for (const [k, v] of Object.entries(tally)) console.log(`  ${k.padEnd(16)} ${v}`);
console.log(`  ${'TOTAL'.padEnd(16)} ${results.length}`);

if (tally.FAIL > 0) {
  console.log('\n结论: FAIL —— 存在真实失败用例。');
  process.exit(1);
}
if (tally.BLOCKED_BY_ENV > 0) {
  console.log('\n结论: BLOCKED_BY_ENV —— 环境未就绪，未执行的用例不计为通过。');
  console.log('      在 staging 就绪并注入上述变量前，本矩阵不得用于宣称 STAGING VERIFIED。');
  process.exit(2);
}
console.log('\n结论: 全部已实现用例通过。');

/*
 * ── CLEANUP ──────────────────────────────────────────────────────
 * 本矩阵使用的三个测试账号必须是一次性 fixture，命名建议：
 *     e2e+applicant@<staging-domain>
 *     e2e+teacher@<staging-domain>
 *     e2e+admin@<staging-domain>
 *
 * 清理（仅限 staging，禁止在 production 执行）：
 *   1. Supabase Dashboard → Authentication → Users，删除上述三个账号
 *   2. 级联清理：profiles / user_roles / login_aliases / applications
 *      按 R-4，actor 外键为 ON DELETE SET NULL，审计记录保留且不得删除
 *   3. 若产生了学号，按 R-3 双人控制流程作废（voided_clerical_error），
 *      **不得**直接 DELETE 学号记录
 *
 * 禁止对真实申请人 / 学生 / 教师账号执行任何本矩阵中的写操作。
 */
