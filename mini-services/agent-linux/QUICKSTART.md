# Dashboard Agent - Quick Start (macOS / Linux)

## 🚀 一键启动

**双击或在终端运行 `./start.sh`** — 第一次会装依赖、生成 Prisma、初始化数据库，之后直接启动。

启动后会：
- 自动找一个空闲端口（默认 3100，被占就 3101、3102…）
- 读取 `agent-config.json` 中的 API Key（首次运行保存默认 Key）
- 启动 Dashboard Agent 服务

## 停止

**运行 `./stop.sh`** — 杀掉所有 agent 进程。

## 文件说明

| 文件 | 作用 |
|------|------|
| `start.sh` | ⭐ **一键启动** |
| `stop.sh` | 一键停止 |
| `agent.js` | 主程序（`node agent.js` 手动启动） |
| `setup.js` | 交互式配置向导 |
| `db/agent.db` | SQLite 数据文件（自动生成） |
| `.agent-session.env` | 临时文件，记录本次启动的端口和 Key |

## API 端点

| 端点 | 鉴权 | 说明 |
|------|------|------|
| `GET /api/agent/health` | ❌ 免鉴权 | 健康检查 |
| `GET /api/agent/info` | ✅ 需 Bearer | Agent 信息 + Key |
| `GET /api/agent/projects` | ✅ | 列出所有项目（含 environments） |
| `POST /api/agent/projects` | ✅ | 创建项目 |
| `POST /api/agent/projects/:id/environments` | ✅ | 添加 environment |
| `POST /api/agent/projects/:id/environments/:envId/start` | ✅ | 启动 environment |
| `POST /api/agent/projects/:id/environments/:envId/stop` | ✅ | 停止 environment |
| `POST /api/agent/projects/:id/environments/:envId/restart` | ✅ | 重启 environment |
| `POST /api/agent/projects/:id/environments/:envId/rebuild` | ✅ | 重建 environment |

需要鉴权的接口在 header 里加：`Authorization: Bearer <key>`

## 常见问题

**Q: 端口 3100 被占了？**
A: start.sh 会自动找 3101/3102/...，不用管。

**Q: 怎么固定端口和 Key？**
A: 首次启动会自动保存默认 Key 到 `agent-config.json`。修改 `start.sh` 中的 `DEFAULT_API_KEY` 变量并删除 `agent-config.json` 即可重新生成。
