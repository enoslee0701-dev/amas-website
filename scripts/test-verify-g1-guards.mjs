/* verify-g1 运行器的**防误连判据**。
   全程离线：只 import 真实的 run.mjs 里那几个纯函数，不起数据库、不连任何东西。

   要验的就是上一版被退回的那几条：
     · 绝不退回去用用户现成的 cluster（哪怕机器上装着 psql）；
     · 连接目标写死在自己创建的 socket 目录上；
     · libpq 的覆盖来源（PGHOSTADDR / PGSERVICE / …）从子进程环境里删干净；
     · 清理失败就如实失败并说清楚残留在哪，不假报已删除。 */
import { plan, sanitizeEnv, cleanupReport, LIBPQ_OVERRIDES } from "./verify-g1/run.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  ← " + detail : "")); }
};
const TMP = "/tmp/amas-g1-probe";

console.log("\n=== P 绝不借用现成的 cluster ===");
const noRuntime = plan({ initdb: null, pgCtl: null, psql: null, dockerDaemon: false, localImage: null, tmpDir: TMP });
ok("P1 什么都没有时判为阻塞", noRuntime.blocked === true, JSON.stringify(noRuntime.mode));
ok("P1b 并且明说不会退回去用现成的 cluster",
   (noRuntime.reason || []).some(r => /不会.*退回|现成的 cluster/.test(r)), JSON.stringify(noRuntime.reason));

/* 这一条正是上一版被退回的场景：机器上**有 psql**，但没有 initdb/pg_ctl ——
   也就是「能连用户现成的 cluster」。必须仍然判阻塞。 */
const onlyClient = plan({ initdb: null, pgCtl: null, psql: "/usr/bin/psql",
  dockerDaemon: false, localImage: null, tmpDir: TMP });
ok("P2 只有 psql（能连用户现成 cluster）时**仍然**阻塞，不拿它当 fallback",
   onlyClient.blocked === true && !onlyClient.mode, JSON.stringify(onlyClient.mode));

const daemonNoImage = plan({ initdb: null, pgCtl: null, psql: null,
  dockerDaemon: true, localImage: null, tmpDir: TMP });
ok("P3 Docker 在但本机没有镜像时阻塞，并说明不允许 pull",
   daemonNoImage.blocked === true &&
   (daemonNoImage.reason || []).some(r => /pull/.test(r)), JSON.stringify(daemonNoImage.reason));

console.log("\n=== Q 自建 cluster 时，目标写死在自己的 socket 上 ===");
const own = plan({ initdb: "/usr/bin/initdb", pgCtl: "/usr/bin/pg_ctl", psql: "/usr/bin/psql",
  dockerDaemon: false, localImage: null, tmpDir: TMP, user: "tester" });
ok("Q1 三样齐了才走 cluster 模式", own.mode === "cluster" && own.blocked === false, JSON.stringify(own.mode));
ok("Q1b 数据目录与 socket 目录都在自己的临时目录下",
   String(own.dataDir).startsWith(TMP) && String(own.sockDir).startsWith(TMP),
   JSON.stringify({ d: own.dataDir, s: own.sockDir }));
ok("Q1c 连接 host 就是自己的 socket 目录（不是主机名、不是 127.0.0.1）",
   own.connect.host === own.sockDir, JSON.stringify(own.connect));
ok("Q1d 不开 TCP（listen_addresses 为空）", own.listenAddresses === "", JSON.stringify(own.listenAddresses));

console.log("\n=== R libpq 的覆盖来源必须洗干净 ===");
const dirty = {
  PATH: "/usr/bin", HOME: "/Users/x",
  PGHOST: "prod.example.com", PGHOSTADDR: "10.0.0.9", PGPORT: "5432",
  PGSERVICE: "production", PGSERVICEFILE: "/Users/x/.pg_service.conf",
  PGDATABASE: "amas_prod", PGUSER: "admin", PGPASSWORD: "s3cret", PGPASSFILE: "/Users/x/.pgpass",
  PGSSLMODE: "require", PGOPTIONS: "-c search_path=evil",
};
const clean = sanitizeEnv(dirty, { PGHOST: own.sockDir, PGPORT: "5433", PGDATABASE: "amas_g1", PGUSER: "tester" });
ok("R1 PGHOSTADDR 被删掉（它会盖过 PGHOST —— 只白名单 PGHOST 根本不管用）",
   clean.PGHOSTADDR === undefined, JSON.stringify(clean.PGHOSTADDR));
ok("R2 PGSERVICE / PGSERVICEFILE 被删掉（它们能把目标指到任何地方）",
   clean.PGSERVICE === undefined && clean.PGSERVICEFILE === undefined,
   JSON.stringify([clean.PGSERVICE, clean.PGSERVICEFILE]));
ok("R3 PGPASSWORD / PGPASSFILE / PGOPTIONS / PGSSLMODE 也不留",
   clean.PGPASSWORD === undefined && clean.PGPASSFILE === undefined &&
   clean.PGOPTIONS === undefined && clean.PGSSLMODE === undefined, JSON.stringify(clean));
ok("R4 最终 host 是我们指定的 socket 目录，不是外面那个 prod",
   clean.PGHOST === own.sockDir && clean.PGDATABASE === "amas_g1", JSON.stringify({ h: clean.PGHOST, d: clean.PGDATABASE }));
ok("R5 无关的环境变量照常保留（不是把整个环境清空了事）",
   clean.PATH === "/usr/bin" && clean.HOME === "/Users/x", JSON.stringify({ p: clean.PATH, h: clean.HOME }));
ok("R6 清单里确实包含那几个关键覆盖源",
   ["PGHOST", "PGHOSTADDR", "PGPORT", "PGSERVICE", "PGSERVICEFILE", "PGPASSFILE", "PGOPTIONS"]
     .every(k => LIBPQ_OVERRIDES.includes(k)), JSON.stringify(LIBPQ_OVERRIDES));

console.log("\n=== S 清理只报实际结果 ===");
const notRemoved = cleanupReport({ stopped: true, dataDirRemoved: false, dataDir: "/tmp/amas-g1-abc" });
ok("S1 没删掉就判失败", notRemoved.ok === false, JSON.stringify(notRemoved));
ok("S1b 不说「已删除 / 已清理」", !/已删除|已清理/.test(notRemoved.message), notRemoved.message);
ok("S1c 而是说清楚残留在哪", /\/tmp\/amas-g1-abc/.test(notRemoved.message), notRemoved.message);
const notStopped = cleanupReport({ stopped: false, dataDirRemoved: true, dataDir: "/tmp/amas-g1-def" });
ok("S2 停不下来也判失败并点名数据目录",
   notStopped.ok === false && /amas-g1-def/.test(notStopped.message), notStopped.message);
const fine = cleanupReport({ stopped: true, dataDirRemoved: true, dataDir: "/tmp/amas-g1-ghi" });
ok("S3 对照：都成功了才说已清理", fine.ok === true && /已清理/.test(fine.message), fine.message);

console.log(`\n  PASS ${pass}  FAIL ${fail}`);
console.log("本套件只跑真实 run.mjs 的纯函数：未起数据库、未连任何东西、未创建任何资源。");
console.log("NOT_RUN：真正的 SQL 执行（checks.sql）—— 本机没有 initdb/pg_ctl/psql，Docker 守护进程也没起。");
process.exit(fail ? 1 : 0);
