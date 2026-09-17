<div align="center">

# Web Dashboard

**自部署的多机开发项目控制面板。**

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js%2016-000000?logo=nextdotjs&logoColor=white)](https://nextjs.org)
[![Bun](https://img.shields.io/badge/runtime-Bun-f9f1e0?logo=bun)](https://bun.sh)
[![Prisma](https://img.shields.io/badge/Prisma%20%2B%20SQLite-2D3748?logo=prisma&logoColor=white)](https://prisma.io)

[English](README.md) · [简体中文](README.zh-CN.md)

</div>

---

填一个目录路径，面板自己弄清项目怎么启动——装依赖、起服务、验证可用——然后你可以在一个页面里启动、停止、重启、重建、拉取、切分支家里任何一台机器上的任何环境。全部跑在你自己的硬件上：一个 SQLite 文件、一个端口，不依赖云服务。

![面板总览](docs/images/dashboard-overview.png)

## 工作原理

添加项目时，进程内的分析代理（deepseek-harness）会遍历目录、补装缺失依赖、挑空闲端口、启动开发服务器、轮询到它真正应答为止；中途失败就带日志自动排障，验证通过后才保存配置。产出的 `dev` 和 `production` 两条环境都是验证过的真实命令和环境变量，之后随时可以手改。

![分析向导](docs/images/analysis-wizard.png)

分析一完成，结果就在服务端落库，关掉向导或刷新页面都不会丢。

日常操作走同一套保障：环境启动按端口实测验证（而不是两秒钟猜一下），失败会带着日志尾部进入 LLM 自动修复循环，巡检器每 60 秒复核一遍。

## 功能

**项目与环境**
- 每个项目多个环境（`dev`、`production`、自定义），一条命令 + 一个端口
- 卡片、右键菜单、详情页三处都能启动 / 停止 / 重启 / 重建
- 真实 TCP 端口探测的实时状态、PID 跟踪、日志流
- 拖拽排序、置顶、标签、⌘K 搜索、卡片与列表两种视图

**GitHub 集成**
- 卡片上一键 Pull（缺失的 `origin` 远程自动补全）
- 分支切换器列出本地 + 远程分支，checkout + pull 一步完成
- 版本徽标：分支 @ commit、提交时间、未提交改动红点
- 每 10 分钟检查远程更新，落后的项目挂徽标并弹汇总提醒

**多机管理**
- Windows / macOS / Linux 小型 agent 通过局域网注册，把项目列表镜像回面板
- 远程项目与本地项目操作完全一致——启动、停止、重建、日志、编辑
- Agent 自升级：一台机器 `git pull` 后，其余机器自动跟随并重启自己
- 单向防火墙也能用：agent 靠 60 秒心跳把数据推出来

**端口治理**
- 实时端口占用面板，带归属进程与 PID
- 一键「整理端口」：dev 从 3001 起、prod = dev + 1000、避开系统端口，已合规的保持不变——应用前先预览

![端口占用](docs/images/ports-panel.png)

**可靠性**
- 启动失败自动进入 LLM 修复循环（带日志上下文）
- 巡检器每 60 秒检查 agent 健康、数据库迁移、面板自更新
- 全链路安全护栏，见下方[安全设计](#安全设计)

## 架构

单个 Next.js 进程，你在其他机器上部署的 agent 是仅有的其他组件。

![架构图](docs/images/architecture.png)

| 路径 | 内容 |
|---|---|
| `src/app/` | 面板页面与 REST API（App Router） |
| `src/lib/` | 进程管理、分析引擎、设备网络、同步、安全护栏 |
| `prisma/` | 数据库 schema（SQLite） |
| `mini-services/agent-*` | Windows / macOS / Linux 设备 agent |
| `start-dashboard.bat`、`start-agent.bat` | Windows 一键脚本 |

技术栈：Next.js 16、React 19、TypeScript、Prisma + SQLite、Tailwind CSS、shadcn/ui，Bun 运行时。

## 快速开始

### macOS / Linux

```bash
git clone https://github.com/Jing0715-fer/web-dashboard-v3.git
cd web-dashboard-v3
bun install
cp .env.example .env        # 默认值即可
bun run db:push
bun run dev
```

打开 http://localhost:3000，用引导账号登录：

```
admin@dashboard.local / admin123456
```

首次登录后请改密码（账号菜单 → 修改密码），或在首次启动前于 `.env` 中设置 `ADMIN_EMAIL` / `ADMIN_PASSWORD`。

### Windows（一键）

```bat
git clone https://github.com/Jing0715-fer/web-dashboard-v3.git
cd web-dashboard-v3
start-dashboard.bat
```

脚本自动完成：依赖安装（无需 bun）→ 生成 `.env` → 初始化数据库 → 启动。重复执行没有负担：依赖都装好时秒级启动。

唯一必填配置是 `DATABASE_URL`（SQLite 位置）。保持默认的 `file:../db/custom.db` 即可（相对 prisma/ 目录解析，落在仓库根的 db/ 下）；自定义时推荐写**绝对路径**（正斜杠）。

## 接入第二台电脑

在另一台机器的仓库根目录启动 agent：

```bash
./start-agent.sh 3101          # macOS / Linux
start-agent.bat 3101           # Windows
```

然后在面板上：**设备 → 加入网络**，填对方地址（如 `http://192.168.1.43:3000`），输入验证码完成配对。配对是双向的——两边互看对方的项目，地址或密钥变化会自动修复。之后只需在面板这台机器 `git pull`，agent 升级全自动。

对方防火墙拦了入站也没关系：agent 用心跳把项目数据推出来，设备卡片会带「推送」徽标，状态一目了然。

## 日常使用

| 想做什么 | 怎么做 |
|---|---|
| 添加项目 | 「添加项目」→ 填路径 → 自动分析生成环境命令（之后可手改） |
| 启动 / 停止 | 环境行的 ▶ / ■、卡片菜单、详情页 |
| 配 GitHub 链接 | 详情页 → GitHub 链接输入框（自动同步到所有机器） |
| 拉取最新代码 | 卡片上的 Pull 按钮（远程项目同样可用） |
| 切换分支 | 卡片菜单「切换分支…」 |
| 整理端口 | 端口面板 →「整理端口」→ 预览 → 应用 |
| 看日志 / 状态 | 详情页：实时日志、版本、活动记录 |
| 加环境 | 详情页 → 环境 → 添加 |

## 配置

| 变量 | 默认值 | 用途 |
|---|---|---|
| `DATABASE_URL` | `file:../db/custom.db` | SQLite 位置（必填） |
| `ADMIN_EMAIL` | `admin@dashboard.local` | 引导管理员账号 |
| `ADMIN_PASSWORD` | `admin123456` | 引导管理员密码 |
| `RESERVED_PORTS` | *(空)* | 额外保留端口（逗号分隔），面板不会杀掉或分配 |
| `START_VERIFY_TIMEOUT_MS` | `45000` | 环境启动等待端口就绪的超时时间 |

LLM 提供方在应用内配置（系统 → LLM 设置）：内置网关在 `/api/llm/v1` 上讲 OpenAI 兼容协议，可以包装自带 SDK、Anthropic 端点或任何自定义的 OpenAI 兼容地址。分析流量走这个网关，除非你显式指向外部提供方，否则项目代码不会离开你的网络。

## 安全设计

进程管理就是这个工具的本职，所以护栏是功能的一部分，不是补丁：

- **保留端口** —— 面板自己的端口（默认 `3000`）和 agent 区间（`3100–3105`）永远不会被分配给项目，也不会被面板杀掉。
- **自路径拒绝** —— 注册或分析面板*自己的*目录会被明确拒绝。加这条护栏之前，分析代理的启动前清理会读到面板自己的 `.next/dev/lock` 并杀掉正在运行的服务——面板在分析途中把自己停掉。现在这个拒绝落在四层（项目创建、分析 API、引擎入口、进程孵化），而且路径比对是*规范化*的：盘符大小写不同、软链接/junction 别名、或者子目录向上找 package.json 落在面板上，都会被识别为同一个目录。agent 内部（v1.15+）也有同样的护栏，远程「获取环境」指向那台机器上面板自己的目录时会直接拒绝，而不是与运行中的服务争抢。
- **PID 链保护** —— 面板自己的进程树永远不会成为击杀目标，无论是直接指定还是启动前的杂散监听清扫。
- **命令白名单** —— 环境命令按安全前缀列表校验，`rm -rf`、管道执行脚本这类永远到不了 `spawn`。
- **隔离的子进程环境** —— 被拉起的项目继承的是净化过的环境变量：面板自己的 `DATABASE_URL`、`__NEXT_PRIVATE_*`、`TURBOPACK` 都会被剥离，子项目不会误开面板的数据库。
- **全程静默运行** —— 面板与 agent 的每一次后台探测/进程操作（端口检查、git 轮询、进程击杀、项目启动）都以直接 argv + `CREATE_NO_WINDOW` 执行，不再经过 `cmd.exe` 管道。在 Windows 上，无控制台的后台服务每跑一个 `netstat`/`git`/`taskkill` 子进程都会分配一个自己的控制台窗口——也就是「桌面每隔几十秒闪一下终端」的元凶（agent v1.16+）。

## 常见问题

| 症状 | 原因与解决 |
|---|---|
| 添加项目报"包含面板自身" | 这是有意为之。分析面板自己的目录曾经会停掉服务（分析代理通过 `.next/dev/lock` 杀掉了运行中的开发服务器）。把项目副本放到别的目录再注册即可。 |
| 某个指向面板自身的项目（路径大小写不同或经软链接）「重新获取环境」仍被拒绝 | 同一条护栏在起作用——即使存储路径与面板目录字符串不一致，规范化比对也能识别出来。想纳管就把项目复制到独立目录。 |
| 远程解析指向某台机器上面板自己的目录 | 会被 agent 的自护栏拒绝（v1.15+）。旧版 agent 没有这道护栏，可能在那台机器上与运行中的面板争抢——在那台机器 `git pull` 并重启 agent 即可。 |
| Windows 桌面每隔几十秒闪一个终端窗口 | 那台机器上的代码早于 v1.16：周期性探测（netstat 端口检查、git 更新轮询）走的是 `cmd.exe /c netstat | findstr …` 管道，无控制台服务的每个子进程都会弹一个窗口。在那台机器 `git pull` 并重启即可——v1.16 的所有探测都带 `CREATE_NO_WINDOW` 且不经过 shell 包装；设备卡片也会把 v1.16 之前的 agent 标记为过旧。 |
| 远程解析（「添加远程项目」）报 "Not found" | 目标设备上的 agent 版本早于远程解析端点（TS 版 agent 需 v1.14+，旧安装包同样没有）。弹窗会标明对方正在运行的版本——在那台机器上更新 agent（项目目录 `git pull` 后重启 agent，或在设备面板重新下载安装包）再重试。 |
| 设备「在线」但 0 个项目，那台机器自己却能看见 | 该机器的 agent 找不到同机面板数据库（`DATABASE_URL` 不在默认位置）。在那台机器 `git pull` 并重启 agent（v1.12+ 自动识别自定义位置），设备卡片会直接标注原因。 |
| Pull 提示「agent 过旧」/ 一台看不到另一台的项目 | 拉了新代码但没重启 agent（git 无法热替换运行中的进程）。设备卡片的琥珀色徽标会指明是哪台，重启 agent 即可。 |
| 远程编辑报 401 | agent 重装后密钥轮换。新版会自动重新认证；仍未恢复时重新配对一次。 |
| 设备列表出现重复行 | 几分钟内自动合并；手动添加设备时请填 agent 的真实 apiKey。 |
| 启动报「进程立即退出」 | 命令在该机器上不存在（PATH 问题）。错误信息带退出码和日志路径，用绝对路径写命令。 |
| `package.json` 冲突标记导致启动失败 | `git checkout origin/main -- package.json` 后重启；本地有改动先 commit / stash 再 pull。 |
| 终端 `git pull` 报「本地修改会被合并覆盖」（如 `src/app/api/jobs/[id]/outputs/route.ts`）＋「未跟踪文件」（`package-lock.json`） | 本地改动与远程提交冲突。v1.17 起面板的一键拉取会直接弹窗询问：「暂存本地修改后拉取」（保留修改，拉取后自动恢复）或「放弃本地修改并拉取」（仅丢弃所列文件，取远程版）——不再死路一条。手动处理：`git stash push --include-untracked && git pull && git stash pop`（保留修改）或 `git checkout -- <文件>`＋删除所列未跟踪文件（取远程）。 |
| 一键拉取偶尔报 `fatal: unable to access 'https://github.com/...': OpenSSL SSL_connect: SSL_ERROR_SYSCALL in connection to github.com:443`，再点一次就好了 | 访问 github.com 的 TLS 连接被中途掐断（网络抖动，常见于不稳定的链路）。v1.18 起面板和 agent 会对这类瞬时网络错误自动重试最多 3 次（约 1 秒/2.5 秒/5 秒退避）——原来需要手动「再点一次」的步骤现在自动完成，重试成功后提示「网络抖动，已自动重试后成功」；若重试后仍失败，错误会标记为网络瞬时问题，稍后再点一次拉取即可。 |

## 更新

```bash
git pull
bun run dev        # 需要时自动补装依赖、迁移数据库
```

Windows 用 `start-dashboard.bat`（自动检测依赖变化）。其他机器上的 agent 自己更新——无需逐台维护。

## 许可

[MIT](LICENSE)
