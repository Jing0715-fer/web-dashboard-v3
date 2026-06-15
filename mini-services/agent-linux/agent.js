const http = require('http');
const { execSync } = require('child_process');
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('fs');
const { join } = require('path');
const Database = require('better-sqlite3');

// ── Configuration ──────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3100', 10);
const RAW_API_KEY = process.env.API_KEY;
const API_KEY = RAW_API_KEY || generateApiKey();
const DB_PATH = process.env.DB_PATH || join(__dirname, 'db', 'agent.db');

function generateApiKey() {
  return 'da_' + require('crypto').randomBytes(24).toString('hex');
}

// ── Database ───────────────────────────────────────────────────────────────
function ensureDb() {
  const dbDir = join(__dirname, 'db');
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS health_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cpu REAL,
      memory REAL,
      uptime INTEGER,
      recorded_at TEXT DEFAULT (datetime('now'))
    );
  `);
  return db;
}

// ── System Info ────────────────────────────────────────────────────────────
function getSystemInfo() {
  const os = require('os');
  const platform = process.platform;
  try {
    let cpu = 'Unknown';
    let mem = '0';
    const hostname = os.hostname();

    if (platform === 'darwin') {
      cpu = execSync('sysctl -n machdep.cpu.brand_string 2>/dev/null || echo Unknown').toString().trim();
      mem = execSync('sysctl -n hw.memsize 2>/dev/null || echo 0').toString().trim();
    } else if (platform === 'linux') {
      cpu = execSync("cat /proc/cpuinfo 2>/dev/null | grep 'model name' | head -1 | cut -d: -f2 || echo Unknown").toString().trim();
      mem = execSync("grep MemTotal /proc/meminfo 2>/dev/null | awk '{print $2}' || echo 0").toString().trim() + ' kB';
    } else if (platform === 'win32') {
      try { cpu = execSync('wmic cpu get name /value 2>nul').toString().split('=').pop().trim() || 'Unknown'; } catch (_) {}
      try { mem = execSync('wmic OS get TotalVisibleMemorySize /value 2>nul').toString().split('=').pop().trim() || '0'; } catch (_) {}
    }

    return { cpu, memory: mem, hostname, nodeVersion: process.version, platform };
  } catch (_) {
    return { platform, nodeVersion: process.version };
  }
}

function collectHealth() {
  try {
    const platform = process.platform;
    let cpuLoad = '0';
    let memInfo = 'N/A';

    if (platform === 'darwin') {
      cpuLoad = execSync("ps -A -o %cpu 2>/dev/null | awk '{s+=$1} END {print s}'").toString().trim();
      memInfo = execSync('vm_stat 2>/dev/null | head -5').toString();
    } else if (platform === 'linux') {
      cpuLoad = execSync("grep 'cpu ' /proc/stat 2>/dev/null | awk '{usage=($2+$4)*100/($2+$4+$5)} END {print usage}'").toString().trim();
      memInfo = execSync('free -m 2>/dev/null | head -3').toString();
    } else if (platform === 'win32') {
      try {
        const loadOut = execSync('wmic cpu get loadpercentage /value 2>nul').toString();
        cpuLoad = loadOut.split('=').pop().trim() || '0';
      } catch (_) {}
      try {
        const memOut = execSync('wmic OS get FreePhysicalMemory /value 2>nul').toString();
        memInfo = memOut.split('=').pop().trim() || 'N/A';
      } catch (_) {}
    }

    return { cpu: parseFloat(cpuLoad) || 0, memory: memInfo || 'N/A', uptime: Math.round(process.uptime()) };
  } catch (_) {
    return { cpu: 0, memory: 'N/A', uptime: Math.round(process.uptime()) };
  }
}

// ── LaunchAgent / systemd / schtasks helpers ───────────────────────────────
function installService() {
  const platform = process.platform;
  const nodeExec = process.execPath;
  const scriptPath = __dirname + '/agent.js';
  const workDir = __dirname;

  if (platform === 'win32') {
    execSync('schtasks /create /tn "DashboardAgent" /tr "\\"' + nodeExec + '\\" \\"' + scriptPath + '\\"" /sc onlogon /f 2>nul || true');
    return 'scheduled-task-created';
  }

  if (platform === 'darwin') {
    const plistLines = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      '  <key>Label</key><string>com.dashboard.agent</string>',
      '  <key>ProgramArguments><array>',
      '    <string>' + nodeExec + '</string>',
      '    <string>' + scriptPath + '</string>',
      '  </array></key>',
      '  <key>RunAtLoad</key><true/>',
      '  <key>KeepAlive</key><true/>',
      '  <key>WorkingDirectory</key><string>' + workDir + '</string>',
      '  <key>StandardOutPath</key><string>' + workDir + '/logs/agent.log</string>',
      '  <key>StandardErrorPath</key><string>' + workDir + '/logs/agent-error.log</string>',
      '</dict></plist>'
    ];
    const logsDir = join(workDir, 'logs');
    if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
    const home = process.env.HOME || '/tmp';
    const plistPath = join(home, 'Library/LaunchAgents/com.dashboard.agent.plist');
    writeFileSync(plistPath, plistLines.join('\n'));
    execSync('launchctl load "' + plistPath + '" 2>/dev/null || true');
    return 'launchagent-installed';
  }

  // Linux
  const svcLines = [
    '[Unit]',
    'Description=Dashboard Agent',
    'After=network.target',
    '',
    '[Service]',
    'ExecStart=' + nodeExec + ' ' + scriptPath,
    'Restart=always',
    'WorkingDirectory=' + workDir,
    'Environment=PORT=' + PORT,
    '',
    '[Install]',
    'WantedBy=default.target'
  ];
  const home = process.env.HOME || '/tmp';
  const svcDir = join(home, '.config/systemd/user');
  if (!existsSync(svcDir)) mkdirSync(svcDir, { recursive: true });
  writeFileSync(join(svcDir, 'dashboard-agent.service'), svcLines.join('\n'));
  execSync('systemctl --user daemon-reload 2>/dev/null || true');
  execSync('systemctl --user enable dashboard-agent 2>/dev/null || true');
  execSync('systemctl --user start dashboard-agent 2>/dev/null || true');
  return 'systemd-service-installed';
}

function stopService() {
  const platform = process.platform;

  if (platform === 'win32') {
    execSync('schtasks /delete /tn "DashboardAgent" /f 2>nul || true');
  } else if (platform === 'darwin') {
    const plistPath = join(process.env.HOME || '/tmp', 'Library/LaunchAgents/com.dashboard.agent.plist');
    execSync('launchctl unload "' + plistPath + '" 2>/dev/null || true');
  } else {
    execSync('systemctl --user stop dashboard-agent 2>/dev/null || true');
  }
  return 'service-stopped';
}

// ── HTTP Server ────────────────────────────────────────────────────────────
const db = ensureDb();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost:' + PORT);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ') || auth.slice(7) !== API_KEY) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  if (url.pathname === '/api/agent/health') {
    const health = collectHealth();
    const info = getSystemInfo();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString(), ...health, ...info }));
    return;
  }

  if (url.pathname === '/api/agent/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ apiKey: API_KEY, port: PORT, ...getSystemInfo() }));
    return;
  }

  if (url.pathname === '/api/agent/start-service') {
    try {
      const status = installService();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/agent/stop-service') {
    try {
      const status = stopService();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  const platformLabels = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };
  const label = platformLabels[process.platform] || process.platform;
  const header = '\n🔵 Dashboard Agent v1.0.0 — ' + label + '\n';
  console.log(header);
  console.log('   Port:     ' + PORT);
  console.log('   API Key:  ' + API_KEY);
  console.log('   DB:       ' + DB_PATH);
  console.log('   Health:   http://localhost:' + PORT + '/api/agent/health');
  console.log('   Auth:     Header "Authorization: Bearer <API_KEY>"\n');
});

process.on('SIGTERM', () => { server.close(); db.close(); process.exit(0); });
process.on('SIGINT', () => { server.close(); db.close(); process.exit(0); });
