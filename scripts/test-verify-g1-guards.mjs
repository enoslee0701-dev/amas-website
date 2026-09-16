/* verify-g1 运行器的**防误连判据**。
   全程离线：只 import 真实的 run.mjs 里那几个纯函数，不起数据库、不连任何东西。

   要验的就是上一版被退回的那几条：
     · 绝不退回去用用户现成的 cluster（哪怕机器上装着 psql）；
     · 连接目标写死在自己创建的 socket 目录上；
     · libpq 的覆盖来源（PGHOSTADDR / PGSERVICE / …）从子进程环境里删干净；
     · 清理失败就如实失败并说清楚残留在哪，不假报已删除。 */
import { plan, sanitizeEnv, cleanupReport, teardown, statusFromExit, LIBPQ_OVERRIDES }
  from "./verify-g1/run.mjs";

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

/* 容器模式的执行部分没写。plan 不许为它返回 blocked:false —— 那等于声称
   「两种模式都能真跑」，是假话。 */
const daemonWithImage = plan({ initdb: null, pgCtl: null, psql: null,
  dockerDaemon: true, localImage: "postgres:16", tmpDir: TMP });
ok("P4 就算 Docker 在、镜像也在，容器模式仍算不支持（执行部分没写）",
   daemonWithImage.blocked === true && daemonWithImage.mode === null, JSON.stringify(daemonWithImage.mode));
ok("P4b 并且说出来是「尚未实现」，不含糊成别的原因",
   (daemonWithImage.reason || []).some(r => /尚未实现/.test(r)), JSON.stringify(daemonWithImage.reason));
ok("P4c plan 明确标了 containerSupported:false",
   daemonWithImage.containerSupported === false, JSON.stringify(daemonWithImage.containerSupported));

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
  PATH: "/usr/bin", HOME: "/Users/x",   // machine-path-ok（这是被清洗的脏环境夹具，不是真实路径）
  PGHOST: "prod.example.com", PGHOSTADDR: "10.0.0.9", PGPORT: "5432",
  PGSERVICE: "production", PGSERVICEFILE: "/Users/x/.pg_service.conf",   // machine-path-ok（这是被清洗的脏环境夹具，不是真实路径）
  PGDATABASE: "amas_prod", PGUSER: "admin", PGPASSWORD: "s3cret", PGPASSFILE: "/Users/x/.pgpass",   // machine-path-ok（这是被清洗的脏环境夹具，不是真实路径）
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
   clean.PATH === "/usr/bin" && clean.HOME === "/Users/x", JSON.stringify({ p: clean.PATH, h: clean.HOME }));   // machine-path-ok（这是被清洗的脏环境夹具，不是真实路径）
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

console.log("\n=== T 收尾编排：没确认停下来就绝不删（用假适配器打真实编排）===");
/* 这一段不测文案，测的是**实际做了哪几步、有没有调 rm**。
   假适配器把每一次调用记下来，顺序也要对。 */
const mkIo = (script) => {
  const calls = [];
  const statuses = (script.status || []).slice();
  return {
    calls,
    io: {
      pgCtlStatus: () => { calls.push("status"); return statuses.length ? statuses.shift() : script.statusTail; },
      pgCtlStop:   () => { calls.push("stop");   return script.stop !== false; },
      rmDir:       () => { calls.push("rm");     return script.rm !== false; },
      exists:      () => { calls.push("exists"); return script.existsAfter === true; },
    },
  };
};
const CTX = { dataDir: "/tmp/amas-g1-xyz/pgdata", tmpDir: "/tmp/amas-g1-xyz" };
const run1 = (script) => { const m = mkIo(script); const r = teardown(CTX, m.io); return { r, calls: m.calls }; };

// T1 停不掉：**一次 rm 都不许调**
const t1 = run1({ status: [0, 0], stop: false });
ok("T1 停不掉时绝不删目录", !t1.calls.includes("rm"), t1.calls.join(","));
ok("T1b 判失败并保留目录", t1.r.ok === false && t1.r.removed === false && t1.r.kept === CTX.tmpDir, JSON.stringify(t1.r.kept));
ok("T1c 消息里给出准确路径与手动清理办法",
   t1.r.message.includes(CTX.tmpDir) && /pg_ctl -D/.test(t1.r.message), t1.r.message.slice(0, 120));

// T2 启动命令失败、但进程其实活着：编排不看任何「我以为启没启起来」的标志，先停
const t2 = run1({ status: [0, 3], stop: true });
ok("T2 进程活着时先停，再确认，确认停了才删",
   t2.calls.join(",") === "status,stop,status,rm,exists", t2.calls.join(","));
ok("T2b 结果成功", t2.r.ok === true && t2.r.removed === true, JSON.stringify(t2.r));

// T3 状态不明：保留，不删
const t3 = run1({ status: [null], statusTail: null });
ok("T3 状态不明时不删", !t3.calls.includes("rm"), t3.calls.join(","));
ok("T3b 判失败并说明是「不明」", t3.r.ok === false && /unknown|不明/.test(t3.r.message), t3.r.message.slice(0, 100));

// T4 停了之后还是没停（stop 返回成功但 status 仍是 running）：仍然不删
const t4 = run1({ status: [0, 0], stop: true });
ok("T4 stop 说成功但状态仍是 running：还是不删", !t4.calls.includes("rm"), t4.calls.join(","));
ok("T4b 判失败", t4.r.ok === false, JSON.stringify(t4.r.ok));

// T5 确认停了才删；rm 之后必须复查
const t5 = run1({ status: [3], stop: true });
ok("T5 本来就没在跑：不调 stop，直接删", t5.calls.join(",") === "status,rm,exists", t5.calls.join(","));
ok("T5b 成功", t5.r.ok === true, JSON.stringify(t5.r.ok));

// T6 rm 报失败 → 如实失败
const t6 = run1({ status: [3], rm: false });
ok("T6 删不掉时如实失败并给路径",
   t6.r.ok === false && t6.r.message.includes(CTX.tmpDir) && /仍然存在/.test(t6.r.message), t6.r.message.slice(0, 100));

// T7 rm 说成功但目录还在 → 也要如实失败（不能只信返回值）
const t7 = run1({ status: [3], rm: true, existsAfter: true });
ok("T7 rm 说成功但复查发现目录还在：仍判失败", t7.r.ok === false, JSON.stringify(t7.r.ok));
ok("T7b 复查这一步确实做了", t7.calls.includes("exists"), t7.calls.join(","));

// T8 数据目录压根没建起来（initdb 就失败了）：没有进程可停，直接删
const t8 = run1({ status: [4] });
ok("T8 数据目录不存在时不调 stop，直接删", t8.calls.join(",") === "status,rm,exists", t8.calls.join(","));
ok("T8b 成功", t8.r.ok === true, JSON.stringify(t8.r.ok));

// T9 退出码到状态的映射
ok("T9 退出码映射：0=running 3=stopped 4=no-datadir 其余=unknown",
   statusFromExit(0) === "running" && statusFromExit(3) === "stopped" &&
   statusFromExit(4) === "no-datadir" && statusFromExit(1) === "unknown" &&
   statusFromExit(null) === "unknown",
   [0, 3, 4, 1, null].map(statusFromExit).join(","));

console.log(`\n  PASS ${pass}  FAIL ${fail}`);
console.log("本套件只跑真实 run.mjs 的纯函数：未起数据库、未连任何东西、未创建任何资源。");
console.log("NOT_RUN：真正的 SQL 执行（checks.sql）—— 本机没有 initdb/pg_ctl/psql，Docker 守护进程也没起。");
process.exit(fail ? 1 : 0);
