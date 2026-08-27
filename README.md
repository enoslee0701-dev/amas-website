# AMAS 亚洲宣教神学院 · 官网

**Asia Missionary Association Seminary — Chiang Mai, Thailand**

学院官方网站（纯静态站，GitHub Pages 发布）。四语言（中 / 英 / 韩 / 泰），含课程设置、招生信息、学费与学习支持、奉献同工、数字校园、资源下载、AI 咨询助手与「定制化神学」三分钟快速测评入口。

- 🌐 线上地址：https://enoslee0701-dev.github.io/amas-website/
- 🧭 快速测评（Discover）：https://enoslee0701-dev.github.io/amas-website/discover.html

## 关联项目

| 项目 | 仓库 | 说明 |
|---|---|---|
| **AMAS App**（移动端） | [enoslee0701-dev/AMAS-Seminary](https://github.com/enoslee0701-dev/AMAS-Seminary) | React + Vite + Capacitor，课程、校友圈、语音房、口袋神学、AI 定制化神学（九维评估与成长画像） |
| **AMAS 官网**（本仓库） | enoslee0701-dev/amas-website | 对外门户与招生入口；网站上的快速测评是 App 完整评估的「Discover」层 |

两者同属 AMAS 亚洲宣教神学院，分工：**网站负责发现与招生，App 负责持续装备与成长。**

> **Source of Truth**：`discover.html`（快速测评）以本仓库为唯一权威版本；`AMAS-Seminary/public/discover.html` 仅为集成副本，改动一律先在本仓库完成再同步过去，避免双向独立修改造成漂移。
> App 链接由 `assets/js/main.js` 的 `CONFIG.app` 统一配置（地址 + deep link + source / assessment / profile 参数），`appUrl()` 负责拼装。

## 目录

```
index.html        首页（全部版块）
discover.html     定制化神学 · 4 分钟快速测评（十题九维 · 十二大成长角色）
giving.html       与我们同工（奉献，一对一联系）
login.html        登录
admin.html        管理后台（Supabase）
assets/css/       样式
assets/js/        逻辑与四语言词典
assets/img/       图片（WebP）
assets/files/     申请表、手册、课程目录（四语言）
```

## 本地预览

```bash
python -m http.server 8080
# 打开 http://localhost:8080/
```

推送到 `master` 分支后 GitHub Pages 自动发布。
