// Shared role descriptions, workspace grouping and least-privilege navigation.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const context={window:{},location:{pathname:'/amas-website/portal/',origin:'https://roles.example.invalid'}};
vm.runInNewContext(fs.readFileSync(new URL('../assets/js/portal/auth.js',import.meta.url),'utf8'),context);
const A=context.window.AmasAuth;
const roles=['applicant','student','teacher','mentor','registrar','finance','content_admin','academic_admin','super_admin','attendance_clerk'];
assert.deepEqual([...A.ROLE_CATALOG.map(r=>r.role)].sort(),roles.sort());
assert(Object.isFrozen(A.ROLE_CATALOG));
assert(A.ROLE_CATALOG.every(r=>Object.isFrozen(r)&&r.scope&&r.features&&r.issuance));
assert.deepEqual([...A.ROLE_CATALOG.filter(r=>r.managed).map(r=>r.role)].sort(),['registrar','academic_admin','mentor','finance','content_admin'].sort());
assert.equal(A.workspaceCount(['teacher','mentor']),1);
assert.equal(A.workspaceCount(['registrar','finance','content_admin']),1);
assert.equal(A.workspaceCount(['teacher','student']),2);
assert.equal(A.workspaceCount(['attendance_clerk','student']),1);
assert.equal(A.homeForRoles(['attendance_clerk','student']),'/amas-website/portal/attendance/');
assert.equal(A.homeForRoles(['finance']),'/amas-website/portal/admin/finance/');
assert.equal(A.homeForRoles(['content_admin']),'/amas-website/portal/admin/board/');
for(const role of roles){
 assert.equal(A.canVisit('portal/admin/roles/',[role]),role==='super_admin');
 assert.equal(A.canVisit('portal/admin/teachers/',[role]),['super_admin','academic_admin'].includes(role));
}
assert(A.canVisit('portal/teacher/mentees/',['mentor']));
assert(!A.canVisit('portal/teacher/classes/',['mentor']));
assert(!A.canVisit('portal/teacher/mentees/',['teacher']));
assert(!A.canVisit('portal/admin/inbox/',['finance']));
assert(!A.canVisit('portal/admin/finance/',['content_admin']));
assert(!A.canVisit('portal/admin/roles/',['attendance_clerk','super_admin']));
console.log('PASS shared catalog: ten roles, five managed staff roles, immutable descriptions, workspace grouping and restricted navigation');
