#!/usr/bin/env python3
"""AMAS 数据库每日备份（测试库 amas-staging，2026-10-26 起线上网站在用）。

为什么要有它：Supabase 免费版没有自动备份，而且一周没人访问会自动暂停。
这个脚本每天把 public 下所有表导出成 JSON（外加 auth 账号清单，不含密码），
存到「文稿/AMAS数据备份/日期/」，保留 90 天；每天这一次访问本身也让数据库不会被暂停。

用到的凭据：~/.config/amas/supabase-token（Supabase 个人访问令牌，Enos 2026-10-26 给的，约 30 天后过期）。
令牌失效时脚本写出「备份失败」并以 2 退出，请重新生成令牌放回同一位置。
不连任何别的地方，不改数据库，只读。

运行：python3 scripts/backup-db.py            （launchd 每天 03:15 自动跑，见 scripts/launchd/）
恢复：每个表一份 <表名>.json，是行数组；按需用 insert ... select from json_populate_recordset 导回。
"""
import datetime, json, os, shutil, ssl, sys, urllib.request, zipfile

REF = "sdrwyebizfdwldlfjyim"
TOKEN_FILE = os.path.expanduser("~/.config/amas/supabase-token")
OUT_ROOT = os.path.expanduser("~/Documents/AMAS数据备份")
KEEP_DAYS = 90
CTX = ssl.create_default_context(cafile="/etc/ssl/cert.pem") if os.path.exists("/etc/ssl/cert.pem") else ssl.create_default_context()


def sql(token, query):
    req = urllib.request.Request(f"https://api.supabase.com/v1/projects/{REF}/database/query",
                                 data=json.dumps({"query": query}).encode(), method="POST",
                                 headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, context=CTX, timeout=120) as r:
        return json.load(r)


def main():
    day = datetime.date.today().isoformat()
    out = os.path.join(OUT_ROOT, day)
    os.makedirs(out, exist_ok=True)
    log = []
    try:
        token = open(TOKEN_FILE).read().strip()
        tables = [r["t"] for r in sql(token, "select tablename t from pg_tables where schemaname='public' order by 1")]
        total = 0
        for t in tables:
            rows = sql(token, f'select coalesce(json_agg(x), \'[]\'::json) j from public."{t}" x')[0]["j"]
            with open(os.path.join(out, t + ".json"), "w", encoding="utf-8") as f:
                json.dump(rows, f, ensure_ascii=False)
            total += len(rows)
            log.append(f"{t}\t{len(rows)}")
        users = sql(token, "select coalesce(json_agg(x),'[]'::json) j from (select id, email, created_at, last_sign_in_at, "
                           "raw_user_meta_data from auth.users order by created_at) x")[0]["j"]
        with open(os.path.join(out, "_auth_users.json"), "w", encoding="utf-8") as f:
            json.dump(users, f, ensure_ascii=False)
        log.append(f"_auth_users\t{len(users)}")
        with open(os.path.join(out, "_备份说明.txt"), "w", encoding="utf-8") as f:
            f.write(f"AMAS 数据备份 {datetime.datetime.now():%Y-%m-%d %H:%M}\n共 {len(tables)} 张表、{total} 行；账号 {len(users)} 个（不含密码）。\n\n"
                    + "\n".join(log) + "\n")
        zpath = out + ".zip"
        with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
            for n in os.listdir(out):
                z.write(os.path.join(out, n), arcname=os.path.join(day, n))
        shutil.rmtree(out)
        print(f"备份完成：{zpath}（{len(tables)} 张表，{total} 行，账号 {len(users)} 个）")
    except Exception as e:
        with open(os.path.join(out, "备份失败.txt"), "w", encoding="utf-8") as f:
            f.write(f"{datetime.datetime.now():%Y-%m-%d %H:%M} 备份失败：{e}\n"
                    "最常见原因：Supabase 令牌过期。请在 supabase.com → Account → Access Tokens 重新生成，"
                    f"放到 {TOKEN_FILE}。\n")
        print("备份失败：", e, file=sys.stderr)
        sys.exit(2)
    # 只保留最近 KEEP_DAYS 天
    cutoff = datetime.date.today() - datetime.timedelta(days=KEEP_DAYS)
    for n in os.listdir(OUT_ROOT):
        try:
            if datetime.date.fromisoformat(n[:10]) < cutoff:
                p = os.path.join(OUT_ROOT, n)
                shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)
        except ValueError:
            pass


if __name__ == "__main__":
    main()
