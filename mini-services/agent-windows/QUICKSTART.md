# Dashboard Agent - Quick Start (Windows)

## 🚀 一键启动

**双击 `start.cmd`** — 第一次会装依赖、生成 Prisma、初始化数据库，之后直接启动。

启动后会：
- 自动找一个空闲端口（默认 3100，被占就 3101、3102…）
- 生成一个随机的 API Key（每次启动都不一样）
- 3 秒后自动打开浏览器到健康检查页
- 关闭窗口 = 停止服务

## 停止

**双击 `stop.cmd`** — 杀掉所有 agent 进程。

## 文件说明

| 文件 | 作用 |
|------|------|
| `start.cmd` | ⭐ **双击启动**（一键） |
| `stop.cmd` | 双击停止 |
| `agent.js` | 主程序（`node agent.js` 手动启动） |
| `setup.js` | 交互式配置向导 |
| `install-service.ps1` | 安装为 Windows 服务（开机自启） |
| `db\agent.db` | SQLite 数据文件（自动生成） |
| `.agent-session.env` | 临时文件，记录本次启动的端口和 Key |

## API 端点

| 端点 | 鉴权 | 说明 |
|------|------|------|
| `GET /api/agent/health` | ❌ 免鉴权 | 健康检查 |
| `GET /api/agent/info` | ✅ 需 Bearer | Agent 信息 + Key |
| `POST /api/agent/start-service` | ✅ | 装 Windows 服务 |
| `POST /api/agent/stop-service` | ✅ | 卸 Windows 服务 |

需要鉴权的接口在 header 里加：`Authorization: Bearer <key>`

## 常见问题

**Q: 浏览器打开 3100 显示 "Unauthorized"？**
A: `/api/agent/health` 是免鉴权的；其他端点需要 Bearer token（启动时打印过）。

**Q: 端口 3100 被占了？**
A: start.cmd 会自动找 3101/3102/...，不用管。

**Q: 怎么固定端口和 Key？**
A: 用 setup.js 交互式生成 `agent-config.json`，下次启动会读它。
   ```cmd
   node setup.js
   ```

**Q: 怎么开机自启？**
A: 用管理员权限运行 PowerShell：
   ```powershell
   powershell -ExecutionPolicy Bypass -File install-service.ps1
   ```
