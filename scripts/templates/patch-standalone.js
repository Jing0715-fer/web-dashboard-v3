#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * 构建后修补 —— 把静态资源搬进 standalone 产物。
 *
 * `next build`（output: "standalone"）只把 JS bundle 放进 .next/standalone，
 * static/ 和 public/ 还得落在 server.js 旁边才能被服务。
 *
 * 原来的做法是 `cp -r …`，但 dashboard 启动子进程时的 PATH 里没有 cp
 * （Windows 的 PATH 只有 Git\cmd，cp 在 Git\usr\bin），于是构建在 cp 这一步
 * 失败、&& 短路、服务根本没起来。这里用 Node 自带的 fs.cpSync，Windows 与
 * POSIX 都能跑。
 */
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const standaloneDir = path.join(root, '.next', 'standalone');

if (!fs.existsSync(path.join(standaloneDir, 'server.js'))) {
  console.log('patch-standalone: no standalone output (next.config has no output: "standalone") — nothing to patch, skipping.');
  process.exit(0);
}

const copies = [
  [path.join(root, '.next', 'static'), path.join(standaloneDir, '.next', 'static')],
  [path.join(root, 'public'), path.join(standaloneDir, 'public')],
];

for (const [src, dst] of copies) {
  if (!fs.existsSync(src)) {
    console.log('patch-standalone: skip (missing) ' + path.relative(root, src));
    continue;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
  console.log('patch-standalone: copied ' + path.relative(root, src) + ' -> ' + path.relative(root, dst));
}

console.log('patch-standalone: done');
