// 入学申请表打印（Enos 2026-11-21 递交总校时发现）：后台整页的米黄底层会印到纸上，表格右边框正好压在页边被裁掉。
import fs from "node:fs";
const s = fs.readFileSync("assets/js/portal/school-form.js", "utf8");
const print = (s.match(/@media print\{[^"]*/) || [""])[0];
let fail = 0;
const ok = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); if (!c) fail++; };
ok("P1 打印时去掉 body::before 底层", /body::before\{display:none\}/.test(print));
ok("P2 打印时表格留出边框宽度，不贴页边", /table\.af\{[^}]*width:calc\(100% - 2px\)/.test(print));
console.log(`\nSCHOOL FORM PRINT: ${2 - fail} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
