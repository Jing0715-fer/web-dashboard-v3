#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * 生产环境入口 —— 启动 Next.js standalone 产物。
 *
 * 为什么不用 `bun .next/standalone/server.js`：
 *   - standalone 的 server.js 需要 DATABASE_URL 才能找到 SQLite 库，而
 *     dashboard 启动子进程时会剥离父进程里的 DATABASE_URL（见
 *     process-manager.ts 的 sanitizedParentEnv），所以必须由 dashboard 的
 *     环境变量显式注入；
 *   - 这里统一处理 PORT / HOSTNAME，缺失时给出可用的默认值。
 *
 * 用法（dashboard 的 production 环境命令）：
 *   node scripts/start-standalone.js
 */
const path = require('path');
const fs = require('fs');

process.env.PORT = process.env.PORT || '3000';
process.env.HOSTNAME = process.env.HOSTNAME || '0.0.0.0';
if (!process.env.DATABASE_URL) {
  console.error('start-standalone: DATABASE_URL is not set — the app cannot open its SQLite database.');
}

const serverJs = path.join(__dirname, '..', '.next', 'standalone', 'server.js');
if (!fs.existsSync(serverJs)) {
  console.error('start-standalone: .next/standalone/server.js not found — run the build first (dashboard: Rebuild).');
  process.exit(1);
}

require(serverJs);
