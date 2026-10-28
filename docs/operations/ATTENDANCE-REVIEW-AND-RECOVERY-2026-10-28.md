# 考勤核查与恢复验收 · 2026-10-28

## 使用

考勤负责人继续只使用10月班专用工作台。汇总按钮可筛选未登记成员；全屏点名仍默认展示全班。一键出席只处理未登记，已有请假、迟到、缺席保留。保存存在未登记时须明确选择返回补登或保存未完成记录；未登记永远不自动算出席。

管理总览新增“考勤核查”，各班上课记录也提供入口。选择班级、月份，可查看月历、逐课次未登记人数、学员分类次数、CSV月报及分页修改记录。记录从数据库返回，不根据前端菜单授予权限；仅现有教务、教学主管、系统管理员可读。普通学员、考勤负责人、财务、内容管理、教师和导师均不能调用管理核查接口。

只统计已建立的课次。没有排课资料时，不把空白日期误称为漏登或缺勤。不自行计算出席率，不把请假换算成缺席。

新课次保存姓名及名单快照。后续转班、改名不改写这些快照；教务明确新增该课次点名记录时可补入名单。旧课次无法精确还原当时的完整名单，按升级时分班和已有点名记录补齐并标注“历史课次”，不得作为确定的历史入班依据。

逐项变更从本次升级开始记录，包含专用考勤账号及教务直改的考勤状态、考勤备注、删除和课次信息变化；作业正文不进入此日志。重复保存相同状态不新增逐项变更。旧版 attendance.saved 审计保留，页面显示旧版保存次数；不伪造过去未采集的逐项操作人信息。

## 备份格式2

`scripts/backup-db.py` 先读取表结构，再用单条SQL在同一MVCC快照下读取 public、amas_private、auth.users、auth.identities 和认证迁移版本。它包含考勤职责、名单快照、变更记录及账号密码哈希。恢复令牌被清空，活动会话、MFA因子、Storage文件内容、托管服务配置不导出；MFA恢复后需重新绑定。

归档在写入磁盘前使用 AES-256-GCM 加密，校验解密、摘要和每表行数后原子替换；失败保留旧归档。文件权限0600，密钥默认 `~/.config/amas/backup-v2.key`，归档默认 `~/Documents/AMAS数据备份/*.amasbak`。密钥必须另行离线保管，不能与归档一起公开或提交Git；密钥丢失无法恢复。旧版JSON/ZIP不作为完整账号恢复备份，也不会被新版脚本自动删除。

恢复必须匹配数据库结构与所有者、认证迁移版本及应用迁移版本。本次原生演练以源库的精确schema dump创建隔离库；仅有数据归档不等于能自动重建托管配置或Storage文件。生产恢复不得直接运行演练脚本中的TRUNCATE、replica模式或删库命令。

安装独立运行环境：

```sh
python3 -m venv "$HOME/.local/share/amas-backup-venv"
"$HOME/.local/share/amas-backup-venv/bin/python3" -m pip install -r scripts/requirements-backup.txt
mkdir -p "$HOME/.local/share/amas-backup"
cp scripts/backup-db.py "$HOME/.local/share/amas-backup/backup-db.py"
"$HOME/.local/share/amas-backup-venv/bin/python3" "$HOME/.local/share/amas-backup/backup-db.py"
```

运行结果写入备份目录 `_backup-status.json`。失败返回非零，不记录凭据或数据正文。launchd模板已改用独立运行环境；本次没有新建或安装定时任务，不应把模板存在当作每日备份已启用。

## 自动验收

日常快速、隔离数据库和关键浏览器检查已接入现有CI。另有真实本地Supabase验收入口，使用官方GoTrue、PostgREST、Mailpit和原生PostgreSQL，没有模拟SDK或伪造JWT：

```sh
node scripts/run-local-acceptance.mjs --cli /absolute/path/to/supabase \
  --python "$HOME/.local/share/amas-backup-venv/bin/python3" --out /tmp/amas-local-results
```

前提为运行中的Docker Desktop、Supabase CLI 2.122.0、已安装备份依赖的Python及Chrome。CLI应从官方npm包固定版本安装在仓库外。默认创建专属临时工作目录和55321起的端口，首次需要拉取官方镜像；已存在同名隔离栈时拒绝覆盖，可显式指定 `--existing-workdir` 复用合成测试数据。测试从不接受远端后端地址，不读取线上用户密码。

覆盖10类职分真实登录与签名JWT权限、角色过期/账号停用、真实TOTP的AAL1拒绝/AAL2放行、本地SMTP找回邮件、一次性链接与新密码登录、退出后刷新令牌拒绝。加密归档在新原生数据库还原，核对全部行、私有配置、密码和序列，再启动独立认证服务验证还原后密码登录。网页还使用真实SDK验证管理员、学员和考勤负责人的登录落点及退出。

本地邮件收到不代表公网邮件供应商可达；本地真实Auth通过不等于所有真实人员的生产密码、手机设备或线上邮件已逐个验收。本次不向真实学员发邮件，不向线上写入测试考勤、成绩或账目。

## 发布

新增一份 `attendance_review_history` 数据库迁移，先做加密备份、执行迁移和权限核查，再发布对应页面。旧考勤页面仍兼容接口扩展；新增月报页必须与迁移协调发布。此次不修改账号密码、孙莹的职分范围、正式学籍或线上MFA开关。
