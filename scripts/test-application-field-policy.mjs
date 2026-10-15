import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const formSource = fs.readFileSync("assets/js/portal/application-form.js", "utf8");
const migration = fs.readFileSync("supabase/migrations/0010_program_catalog.sql", "utf8");
const forbiddenArray = migration.match(/foreach k in array array\[([\s\S]*?)\] loop/);
assert.ok(forbiddenArray, "server forbidden-field policy must be present");
const forbidden = new Set([...forbiddenArray[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));

const context = { window: {} };
vm.runInNewContext(formSource, context, { filename: "application-form.js" });
const steps = context.window.AmasAppForm.STEPS;
const exposed = steps.flatMap((step) => step.fields.map((field) => field.name));
const conflicts = exposed.filter((name) => forbidden.has(name));
assert.equal(conflicts.length, 0, `online form must not offer server-discarded fields: ${conflicts}`);

const church = steps.find((step) => step.key === "church");
assert.match(church.note, /不收集教会类型、家庭成员资料与健康医疗信息/);
const specialNotes = steps.flatMap((step) => step.fields).find((field) => field.name === "special_notes");
assert.match(specialNotes.hint, /请勿填写健康或医疗信息/);
console.log("Application field policy OK");
