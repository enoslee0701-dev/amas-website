/* G1 的真实 SQL 验证 —— 运行器。
   ────────────────────────────────────────────────────────────────
   上一版（run.sh）被退回，退得对。它的错在于：**连的是用户现有的 cluster**，
   只是在里面新建一个库。而 prelude 要 `create role anon/authenticated/service_role`
   —— 那是 **cluster 级**的变更，`drop database` 根本清不掉。
   「不接触既有数据/设置」那句承诺当时不成立。

   现在只有两种模式，**都不碰任何既有 cluster，也没有 fallback**：

     cluster   用 initdb 在一个临时目录里**自己建一个 cluster**，只监听自己的
               unix socket（listen_addresses=''，不开 TCP），跑完整个目录删掉。
               角色、库、数据全在这个一次性 cluster 里，删目录即全清。
     container 用**本机已有的**镜像起一个全新容器（只 inspect，绝不 pull）。

   两样都没有 → 阻塞，报 NOT_RUN 退出，**不退回去用现成的 cluster**。

   连接目标是写死的：显式 `-h <自己的 socket 目录>`，并且把 libpq 会读的所有
   覆盖来源（PGHOSTADDR / PGSERVICE / PGSERVICEFILE / …）从子进程环境里**删掉** ——
   只白名单 PGHOST 是不够的，PGHOSTADDR 会盖过它，PGSERVICE 能把目标指到任何地方。

   清理只报实际结果：停不掉或删不掉就**如实失败并说清楚残留在哪**，绝不假报已删除。

   用法：
     node scripts/verify-g1/run.mjs            真跑
     node scripts/verify-g1/run.mjs --plan     只打印它打算怎么做，不执行任何东西
*/
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** libpq 会读的、能改变连接目标的环境变量。一个都不能留给子进程。 */
export const LIBPQ_OVERRIDES = [
  "PGHOST", "PGHOSTADDR", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD",
  "PGPASSFILE", "PGSERVICE", "PGSERVICEFILE", "PGOPTIONS", "PGSSLMODE",
  "PGSSLROOTCERT", "PGSSLCERT", "PGSSLKEY", "PGREQUIRESSL", "PGCHANNELBINDING",
  "PGTARGETSESSIONATTRS", "PGCONNECT_TIMEOUT", "PGCLIENTENCODING", "PGAPPNAME",
  "PGREQUIREPEER", "PGKRBSRVNAME", "PGGSSLIB", "PGLOCALEDIR",
];

/** 把外面的环境洗干净，只留下我们自己指定的连接参数。 */
export function sanitizeEnv(outer, own) {
  const env = { ...outer };
  for (const k of LIBPQ_OVERRIDES) delete env[k];
  return { ...env, ...own };
}

const which = (bin, lookup) => (lookup ? lookup(bin) : realWhich(bin));
function realWhich(bin) {
  const r = spawnSync("command", ["-v", bin], { shell: true, encoding: "utf8" });
  const p = (r.stdout || "").trim();
  return p && fs.existsSync(p.split("\n")[0]) ? p.split("\n")[0] : null;
}

/** 决定这一轮怎么跑。**纯函数**：所有外部探测都从 probe 传进来，好离线打。 */
export function plan(probe) {
  const base = { cwd: ROOT };
  if (probe.initdb && probe.pgCtl && probe.psql) {
    const dir = probe.tmpDir;
    return {
      ...base, mode: "cluster", blocked: false,
      dataDir: path.join(dir, "pgdata"),
      sockDir: path.join(dir, "sock"),
      /* 只走 unix socket：listen_addresses='' 关掉 TCP，端口号只用于 socket 文件名。 */
      listenAddresses: "",
      connect: { host: path.join(dir, "sock"), port: 5433, db: "amas_g1", user: probe.user || "postgres" },
      creates: ["临时 cluster 目录 " + path.join(dir, "pgdata"), "socket 目录 " + path.join(dir, "sock")],
    };
  }
  /* 容器模式**没有实现**。之前 plan 会为它返回 blocked:false，等于声称「两种都能真跑」——
     那是假话。在写完执行部分之前，它一律算不支持，不给任何人误以为有这条路。 */
  return {
    ...base, mode: null, blocked: true, containerSupported: false,
    reason: [
      "没有 initdb / pg_ctl / psql（无法自建临时 cluster）",
      "容器模式**尚未实现**" +
        (probe.dockerDaemon
          ? (probe.localImage ? "（本机有镜像 " + probe.localImage + " 也一样：执行部分没写）"
                              : "（而且本机没有可用镜像，且不允许 pull）")
          : "（而且 Docker 守护进程没起，不允许启动它，也不允许 pull 镜像）"),
      "**不会**退回去用现成的 cluster —— 那会往用户的 cluster 里留下角色等 cluster 级改动。",
    ],
  };
}

/** pg_ctl status 的退出码：0=在跑，3=没在跑，4=目录不存在/不是数据目录。
    其余一律算「不明」—— 不明就不许删。 */
export function statusFromExit(codeOrNull) {
  if (codeOrNull === 0) return "running";
  if (codeOrNull === 3) return "stopped";
  if (codeOrNull === 4) return "no-datadir";
  return "unknown";
}

/** 收尾的**实际编排**。所有副作用都从 io 注入，好用假适配器打。
    规矩只有一条：**没有确认它停了，就绝不删这个目录。**
      · 不看「我以为我启没启起来」那个标志 —— 启动命令失败但进程已经活着是常事；
      · 停不掉、或状态不明 —— 保留目录，如实失败，把路径说出来；
      · 确认 stopped / no-datadir 之后才删，删完还要再确认真的没了。 */
export function teardown(ctx, io) {
  const steps = [];
  const dataDir = ctx.dataDir, tmpDir = ctx.tmpDir;

  let st = statusFromExit(io.pgCtlStatus(dataDir));
  steps.push("status:" + st);

  if (st === "running") {
    const stopped = io.pgCtlStop(dataDir);
    steps.push("stop:" + (stopped ? "ok" : "fail"));
    st = statusFromExit(io.pgCtlStatus(dataDir));      // 停完必须**再确认一次**
    steps.push("status:" + st);
  }

  if (st !== "stopped" && st !== "no-datadir") {
    return {
      ok: false, steps, removed: false, kept: tmpDir,
      message: "没能确认数据库已经停下来（当前状态：" + st + "）。" +
        "**没有删除任何东西** —— 目录保留在：" + tmpDir +
        "\n确认它停了之后再手动清理：pg_ctl -D " + dataDir + " -m immediate stop && rm -rf " + tmpDir,
    };
  }

  const rmOk = io.rmDir(tmpDir);
  steps.push("rm:" + (rmOk ? "ok" : "fail"));
  const still = io.exists(tmpDir);
  steps.push("exists:" + still);
  if (!rmOk || still) {
    return {
      ok: false, steps, removed: false, kept: tmpDir,
      message: "数据库已停下，但目录没能删掉，**仍然存在**：" + tmpDir + "\n请手动 rm -rf 它。",
    };
  }
  return { ok: true, steps, removed: true, kept: null, message: "已清理：" + tmpDir };
}

/** 清理只报实际结果。停不掉/删不掉就如实失败并说清楚残留在哪。 */
export function cleanupReport(r) {
  const left = [];
  if (r.stopped === false) left.push("postmaster 没停下来（数据目录 " + r.dataDir + "）");
  if (r.dataDirRemoved === false) left.push("目录仍在：" + r.dataDir);
  if (r.containerRemoved === false) left.push("容器仍在：" + r.container);
  if (!left.length) return { ok: true, message: "已清理：" + (r.dataDir || r.container) };
  return { ok: false, message: "清理失败，以下资源**仍然存在**，请手动处理：\n  - " + left.join("\n  - ") };
}

/* ── 下面是执行部分；被 import 时一行都不跑 ── */
const AS_CLI = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (AS_CLI) {

const PLAN_ONLY = process.argv.includes("--plan");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "amas-g1-"));

const dockerDaemon = (() => {
  if (!realWhich("docker")) return false;
  const r = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", timeout: 15000 });
  return r.status === 0 && !/Cannot connect/i.test((r.stdout || "") + (r.stderr || ""));
})();
const localImage = (() => {
  if (!dockerDaemon) return null;
  for (const img of ["postgres:16", "postgres:15", "postgres:14", "postgres:latest"]) {
    const r = spawnSync("docker", ["image", "inspect", img], { encoding: "utf8", timeout: 15000 });
    if (r.status === 0) return img;       // 只 inspect，绝不 pull
  }
  return null;
})();

const p = plan({
  initdb: realWhich("initdb"), pgCtl: realWhich("pg_ctl"), psql: realWhich("psql"),
  dockerDaemon, localImage, tmpDir, user: process.env.USER,
});

if (p.blocked) {
  console.error("这一步做不了，按 NOT_RUN 记：");
  for (const r of p.reason) console.error("  · " + r);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  process.exit(2);
}

console.log("模式：" + p.mode);
console.log("会创建：");
for (const c of p.creates) console.log("  · " + c);
console.log("连接目标（写死，不读任何 PG* 环境变量）：" +
  p.connect.host + " / " + p.connect.db);
console.log("已从子进程环境中删除的覆盖源：" + LIBPQ_OVERRIDES.join(" "));

if (PLAN_ONLY) { fs.rmSync(tmpDir, { recursive: true, force: true }); process.exit(0); }

if (p.mode !== "cluster") {
  console.error("容器模式的执行部分尚未写完 —— 本机也没有镜像可用，按 NOT_RUN 记。");
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(2);
}

const ENV = sanitizeEnv(process.env, {
  PGHOST: p.connect.host, PGPORT: String(p.connect.port),
  PGDATABASE: p.connect.db, PGUSER: p.connect.user,
});
const run = (bin, args, opts) => {
  const r = spawnSync(bin, args, { encoding: "utf8", env: ENV, ...(opts || {}) });
  if (r.status !== 0) {
    console.error("失败：" + bin + " " + args.join(" ") + "\n" + (r.stderr || r.stdout || ""));
    return false;
  }
  return true;
};
const psql = (args) => run("psql", ["-h", p.connect.host, "-p", String(p.connect.port),
  "-U", p.connect.user, "-v", "ON_ERROR_STOP=1", ...args]);

fs.mkdirSync(p.sockDir, { recursive: true });
let failed = false;
try {
  if (!run("initdb", ["-D", p.dataDir, "-U", p.connect.user, "--auth=trust", "-E", "UTF8"])) throw new Error("initdb");
  /* 启动命令返回非零**不等于**进程没起来（超时、-w 等待失败都会这样）。
     所以这里不记任何「我以为启没启起来」的标志 —— 收尾一律去问 pg_ctl status。 */
  if (!run("pg_ctl", ["-D", p.dataDir, "-o",
      `-k ${p.sockDir} -p ${p.connect.port} -c listen_addresses=''`, "-w", "start"])) throw new Error("pg_ctl start");
  if (!psql(["-d", "postgres", "-c", `create database ${p.connect.db}`])) throw new Error("createdb");
  if (!psql(["-d", p.connect.db, "-f", path.join(ROOT, "scripts/verify-g1/prelude.sql")])) throw new Error("prelude");
  for (const f of fs.readdirSync(path.join(ROOT, "supabase/migrations")).filter(x => x.endsWith(".sql")).sort()) {
    process.stdout.write("   " + f + "\n");
    if (!psql(["-d", p.connect.db, "-f", path.join(ROOT, "supabase/migrations", f)])) throw new Error(f);
  }
  if (!psql(["-d", p.connect.db, "-f", path.join(ROOT, "scripts/verify-g1/checks.sql")])) throw new Error("checks");
  console.log("== 全部断言通过 ==");
} catch (e) {
  failed = true;
  console.error("中断于：" + (e && e.message));
} finally {
  /* 真实适配器：status 用退出码、stop 与 rm 报成败、exists 复查。
     编排逻辑本身在 teardown 里，被 test-verify-g1-guards 用假适配器打过。 */
  const io = {
    pgCtlStatus: (dir) => {
      if (!fs.existsSync(dir)) return 4;
      const r = spawnSync("pg_ctl", ["-D", dir, "status"], { encoding: "utf8", env: ENV });
      return typeof r.status === "number" ? r.status : null;   // 起不来 → null → 不明
    },
    pgCtlStop: (dir) => run("pg_ctl", ["-D", dir, "-m", "immediate", "-w", "stop"]),
    rmDir: (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); return true; } catch (e) { return false; } },
    exists: (dir) => fs.existsSync(dir),
  };
  const rep = teardown({ dataDir: p.dataDir, tmpDir }, io);
  console[rep.ok ? "log" : "error"](rep.message);
  console.error("  收尾步骤：" + rep.steps.join(" → "));
  if (!rep.ok) process.exit(3);
}
process.exit(failed ? 1 : 0);

}   // ← if (AS_CLI)
