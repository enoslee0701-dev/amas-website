import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const formSource = fs.readFileSync("assets/js/portal/application-form.js", "utf8");
/* 服务端剥离清单以**最后一次**定义 application_strip_forbidden 的迁移为准（0010 → 0043） */
const migDir = "supabase/migrations";
const lastDef = fs.readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort()
  .filter((f) => /function public\.application_strip_forbidden/.test(fs.readFileSync(migDir + "/" + f, "utf8"))).pop();
const migration = fs.readFileSync(migDir + "/" + lastDef, "utf8");
const forbiddenArray = migration.match(/foreach k in array array\[([\s\S]*?)\] loop/);
assert.ok(forbiddenArray, "server forbidden-field policy must be present");
const forbidden = new Set([...forbiddenArray[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));

const context = { window: {} };
vm.runInNewContext(formSource, context, { filename: "application-form.js" });
const steps = context.window.AmasAppForm.STEPS;
const exposed = steps.flatMap((step) => step.fields.map((field) => field.name));
const conflicts = exposed.filter((name) => forbidden.has(name));
assert.equal(conflicts.length, 0, `online form must not offer server-discarded fields: ${conflicts}`);

/* 2026-10-26 Enos：以总校申请表为准 —— 教会种类、家庭状况、健康状况在表上且为选填，不挡报名 */
const all = steps.flatMap((step) => step.fields);
for (const name of ["church_type", "family", "family_status", "health"]) {
  const f = all.find((x) => x.name === name);
  assert.ok(f, `总校表栏位 ${name} 应出现在正式申请表上`);
  assert.ok(!f.required, `总校表栏位 ${name} 应为选填，不影响报名`);
}
assert.ok(forbidden.has("medical") && forbidden.has("diagnosis"), "详细医疗资料仍由服务端剥离");
assert.ok(!forbidden.has("church_type") && !forbidden.has("family") && !forbidden.has("health"), "总校表栏位不应再被服务端剥离");
/* 官网报名（与总校表同栏位名）→ 正式申请草稿：新栏位都要带过去 */
const pf = context.window.AmasAppForm.prefillFromQuickApply({
  nameZh: "测试", churchType: "house", phone_fixed: "053-1", phone_church: "053-2", health: "良好", family_status: "已婚",
  vision: "回乡宣教", motivation: "信主经过", edu0_school: "清迈大学", edu0_end: "2019-06", work0_org: "恩典堂", work0_title: "传道",
  fam0_rel: "配偶", fam0_name: "王弟兄", fam1_rel: "", fam1_name: "" });
assert.equal(pf.church_type, "house");
assert.equal(pf.tel, "053-1"); assert.equal(pf.church_phone, "053-2"); assert.equal(pf.health, "良好"); assert.equal(pf.family_status, "已婚");
assert.equal(pf.calling, "回乡宣教", "有异象时进异象"); assert.equal(pf.testimony, "信主经过", "原来那段进见证");
assert.equal(JSON.stringify(pf.education), '[{"school":"清迈大学","city":"","start_ym":"","end_ym":"2019-06","degree":""}]');
assert.equal(pf.experience[0].position, "传道");
assert.equal(pf.family.length, 1, "空行不带"); assert.equal(pf.family[0].relation, "配偶");
const old = context.window.AmasAppForm.prefillFromQuickApply({ motivation: "旧表见证", eduSchool: "旧学校", eduLevel: "bachelor" });
assert.equal(old.calling, "旧表见证", "旧格式（没有异象栏）照旧进异象 / 蒙召");
assert.equal(old.education[0].school, "旧学校");
console.log("Application field policy OK");
