# Supabase 接入说明（管理后台启用步骤）

> 现状：`assets/js/supabase-config.js` 两个值为空 → 数据库通道关闭，网站一切正常，
> 所有表单仍走 Gmail（FormSubmit → amasthai2026@gmail.com）。
> 按下面步骤接入后，提交会**同时**写入数据库，`admin.html` 后台可登录管理。

## 一、创建项目
1. https://supabase.com → New project（区域建议 Singapore，离清迈近）
2. 记下两个值：**Project Settings → API** 里的
   - `Project URL`（形如 `https://xxxx.supabase.co`）
   - `anon` / `publishable` key（公开密钥，可放前端）

## 二、建表与权限（一次性）
SQL Editor → 粘贴运行仓库中的 **`supabase/migrations/0001_init.sql`**。
它会创建 `submissions` 表并配置 RLS：

| 角色 | 权限 |
|---|---|
| 匿名访客（网站表单） | 只能写入 |
| 登录管理员（authenticated） | 读取 + 更新（状态/备注） |
| 任何客户端 | 不能删除（需删除时在控制台操作） |

## 三、建管理员账号
Authentication → Users → **Add user** → 填管理员邮箱 + 密码，勾选 *Auto Confirm*。
（可建多个；每个同工一个账号，便于区分操作人。）

## 四、填入前端配置
编辑 `assets/js/supabase-config.js`：

```js
window.SUPA = {
  url: "https://xxxx.supabase.co",   // Project URL
  anonKey: "eyJhbGciOi..."           // anon / publishable key
};
```

提交推送后生效。**只允许填这两个值；`service_role` / secret key 严禁出现在前端或仓库。**

## 五、验证
1. 打开官网提交一条测试咨询 → Supabase Table Editor 的 `submissions` 里应出现记录
2. 打开 `/admin.html` → 未登录只能看到登录框 → 用第三步的账号登录 → 能看到记录、改状态、写备注、导出 CSV
3. 退出登录后刷新 → 数据不可见（RLS 生效）
4. 浏览器控制台执行
   `fetch(SUPA.url + "/rest/v1/submissions", {headers:{apikey: SUPA.anonKey}})`
   应返回空数组或 401/403 —— 匿名读不到数据即为正确

## 常见问题
- **后台提示"尚未配置数据库连接"**：`supabase-config.js` 还是空值，或 CDN 的 supabase-js 未加载
- **登录后读取失败**：0001_init.sql 未完整执行（RLS 策略缺失）
- **想改状态选项**：状态是纯文本（待处理/已联系/已录取/不合适），在 `admin.html` 里搜索修改即可
