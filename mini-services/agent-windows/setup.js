/**
 * Dashboard Agent — Interactive Setup Wizard for Windows
 *
 * This script guides the user through the initial setup process:
 *   1. Checks system requirements (Node.js version, available ports)
 *   2. Asks for configuration (port, name, API key)
 *   3. Runs npm install
 *   4. Runs prisma generate + db push
 *   5. Creates agent-config.json
 *   6. Optionally installs as Windows Service
 *   7. Tests the connection
 *   8. Shows next steps
 *
 * Usage:
 *   node setup.js
 *   node setup.js --port 3100 --apiKey my-key --name "My-PC"
 */

'use strict';

const http = require('http');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const readline = require('readline');

const IS_WINDOWS = os.platform() === 'win32';

// ======================== COLORS ========================

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
};

function log(msg, color) {
  if (color) {
    console.log(`${colors[color]}${msg}${colors.reset}`);
  } else {
    console.log(msg);
  }
}

function logSuccess(msg) { log(`  ✓ ${msg}`, 'green'); }
function logError(msg) { log(`  ✗ ${msg}`, 'red'); }
function logInfo(msg) { log(`  → ${msg}`, 'cyan'); }
function logWarn(msg) { log(`  ⚠ ${msg}`, 'yellow'); }

// ======================== READLINE HELPER ========================

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question, defaultValue) {
  return new Promise((resolve) => {
    const prompt = defaultValue
      ? `${question} [${defaultValue}]: `
      : `${question}: `;
    rl.question(prompt, (answer) => {
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

function askYesNo(question, defaultValue) {
  return new Promise((resolve) => {
    const hint = defaultValue ? 'Y/n' : 'y/N';
    rl.question(`${question} (${hint}): `, (answer) => {
      const a = answer.trim().toLowerCase();
      if (a === '') return resolve(defaultValue);
      if (a === 'y' || a === 'yes') return resolve(true);
      if (a === 'n' || a === 'no') return resolve(false);
      return resolve(defaultValue);
    });
  });
}

// ======================== MAIN SETUP ========================

async function main() {
  const scriptDir = __dirname;

  console.log('');
  log('╔══════════════════════════════════════════════════════════╗', 'cyan');
  log('║        Dashboard Agent — Setup Wizard (Windows)         ║', 'cyan');
  log('╚══════════════════════════════════════════════════════════╝', 'cyan');
  console.log('');

  // ===================== Step 1: System Requirements =====================

  log('Step 1: Checking system requirements...', 'bright');
  console.log('');

  // Check Node.js
  let nodeVersion = null;
  try {
    nodeVersion = execSync('node --version', { encoding: 'utf-8' }).trim();
    const major = parseInt(nodeVersion.replace('v', '').split('.')[0], 10);
    if (major >= 18) {
      logSuccess(`Node.js ${nodeVersion} detected`);
    } else {
      logError(`Node.js ${nodeVersion} detected — version 18+ required`);
      logInfo('Please install Node.js 18+ from https://nodejs.org');
      rl.close();
      process.exit(1);
    }
  } catch (e) {
    logError('Node.js is not installed');
    logInfo('Please install Node.js 18+ from https://nodejs.org');
    rl.close();
    process.exit(1);
  }

  // Check npm
  try {
    const npmVersion = execSync('npm --version', { encoding: 'utf-8' }).trim();
    logSuccess(`npm ${npmVersion} detected`);
  } catch (e) {
    logError('npm is not available');
    rl.close();
    process.exit(1);
  }

  // Check platform
  logSuccess(`Platform: ${os.platform()} ${os.arch()}`);
  logSuccess(`OS: ${os.type()} ${os.release()}`);

  // Check available memory
  const totalMemGB = (os.totalmem() / (1024 * 1024 * 1024)).toFixed(1);
  const freeMemGB = (os.freemem() / (1024 * 1024 * 1024)).toFixed(1);
  logInfo(`Memory: ${freeMemGB}GB free / ${totalMemGB}GB total`);

  console.log('');

  // ===================== Step 2: Configuration =====================

  log('Step 2: Configuration', 'bright');
  console.log('');

  // Port
  const port = await ask('Agent port', '3100');
  const portNum = parseInt(port, 10);
  if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
    logError(`Invalid port: ${port}`);
    rl.close();
    process.exit(1);
  }

  // Check if port is available
  try {
    const testServer = http.createServer((req, res) => res.end());
    await new Promise((resolve, reject) => {
      testServer.once('error', reject);
      testServer.once('listening', resolve);
      testServer.listen(portNum, '0.0.0.0');
    });
    testServer.close();
    logSuccess(`Port ${portNum} is available`);
  } catch (e) {
    logWarn(`Port ${portNum} may already be in use`);
  }

  // Agent name
  const defaultName = os.hostname();
  const name = await ask('Agent name', defaultName);

  // API Key
  const generatedKey = crypto.randomBytes(32).toString('hex');
  console.log('');
  logInfo(`Generated API Key: ${generatedKey}`);
  const useGenerated = await askYesNo('Use this API key?', true);
  let apiKey;
  if (useGenerated) {
    apiKey = generatedKey;
  } else {
    apiKey = await ask('Enter your API key');
    if (!apiKey) {
      logError('API key cannot be empty');
      rl.close();
      process.exit(1);
    }
  }

  console.log('');

  // ===================== Step 3: Install Dependencies =====================

  log('Step 3: Installing dependencies...', 'bright');
  console.log('');

  if (fs.existsSync(path.join(scriptDir, 'node_modules'))) {
    logInfo('node_modules already exists — skipping npm install');
    logInfo('Run "npm install" manually if you need to update');
  } else {
    try {
      logInfo('Running npm install --production...');
      execSync('npm install --production', {
        cwd: scriptDir,
        stdio: 'inherit',
        timeout: 300000, // 5 minutes
      });
      logSuccess('Dependencies installed');
    } catch (e) {
      logError('Failed to install dependencies');
      logError(e.message);
      rl.close();
      process.exit(1);
    }
  }

  console.log('');

  // ===================== Step 4: Database Setup =====================

  log('Step 4: Setting up database...', 'bright');
  console.log('');

  // Ensure db directory exists
  const dbDir = path.join(scriptDir, 'db');
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
    logSuccess('Created db/ directory');
  }

  // Set DATABASE_URL for prisma commands
  process.env.DATABASE_URL = `file:${path.join(dbDir, 'agent.db')}`;

  try {
    logInfo('Running prisma generate...');
    execSync('npx prisma generate', {
      cwd: scriptDir,
      stdio: 'inherit',
      timeout: 120000,
    });
    logSuccess('Prisma client generated');
  } catch (e) {
    logError('Failed to generate Prisma client');
    logError(e.message);
    rl.close();
    process.exit(1);
  }

  try {
    logInfo('Running prisma db push...');
    execSync('npx prisma db push', {
      cwd: scriptDir,
      stdio: 'inherit',
      timeout: 120000,
    });
    logSuccess('Database schema pushed');
  } catch (e) {
    logError('Failed to push database schema');
    logError(e.message);
    rl.close();
    process.exit(1);
  }

  console.log('');

  // ===================== Step 5: Save Configuration =====================

  log('Step 5: Saving configuration...', 'bright');
  console.log('');

  const config = {
    port: portNum,
    apiKey: apiKey,
    name: name,
    dbPath: path.join(scriptDir, 'db', 'agent.db'),
    createdAt: new Date().toISOString(),
    version: '1.2.0',
  };

  const configPath = path.join(scriptDir, 'agent-config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  logSuccess(`Configuration saved to: ${configPath}`);

  // Also save .env file
  const envContent = `# Dashboard Agent Configuration\nDATABASE_URL=file:${path.join(scriptDir, 'db', 'agent.db')}\n`;
  fs.writeFileSync(path.join(scriptDir, '.env'), envContent, 'utf-8');
  logSuccess('.env file created');

  console.log('');

  // ===================== Step 6: Windows Service (Optional) =====================

  if (IS_WINDOWS) {
    log('Step 6: Windows Service (optional)', 'bright');
    console.log('');
    logInfo('You can install Dashboard Agent as a Windows Service');
    logInfo('so it starts automatically when the computer boots.');
    console.log('');

    const installService = await askYesNo('Install as Windows Service?', false);

    if (installService) {
      try {
        logInfo('Running install-service.ps1...');
        // Try to run the PowerShell script
        const psCmd = `powershell -ExecutionPolicy Bypass -File "${path.join(scriptDir, 'install-service.ps1')}" -Port ${portNum} -ApiKey "${apiKey}" -Name "${name}"`;
        execSync(psCmd, {
          cwd: scriptDir,
          stdio: 'inherit',
          timeout: 60000,
        });
        logSuccess('Windows Service installed');
      } catch (e) {
        logWarn('Failed to install service automatically');
        logInfo('You can install manually by running:');
        logInfo('  powershell -ExecutionPolicy Bypass -File install-service.ps1');
        logInfo('  (Run as Administrator)');
      }
    } else {
      logInfo('Skipping service installation.');
      logInfo('You can install later with: install-service.ps1');
    }
    console.log('');
  }

  // ===================== Step 7: Test Connection =====================

  log('Step 7: Testing connection...', 'bright');
  console.log('');

  const testServer = await askYesNo('Start the agent and test the connection?', true);

  if (testServer) {
    logInfo('Starting Dashboard Agent in background...');

    // Start the agent process
    const { spawn } = require('child_process');
    const agentProcess = spawn('node', [
      'agent.js',
      '--port', String(portNum),
      '--apiKey', apiKey,
      '--name', name,
    ], {
      cwd: scriptDir,
      detached: !IS_WINDOWS,
      stdio: 'pipe',
      env: Object.assign({}, process.env, {
        DATABASE_URL: `file:${path.join(scriptDir, 'db', 'agent.db')}`,
      }),
    });

    // Wait for startup
    await new Promise(r => setTimeout(r, 3000));

    // Test health endpoint
    try {
      const healthData = await new Promise((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port: portNum,
          path: '/api/agent/health',
          method: 'GET',
          timeout: 5000,
        }, (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => {
            try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
          });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.end();
      });

      if (healthData.status === 'ok') {
        logSuccess('Health check passed!');
        logInfo(`  Status: ${healthData.status}`);
        logInfo(`  Name: ${healthData.name}`);
        logInfo(`  Platform: ${healthData.platform} ${healthData.arch}`);
        logInfo(`  Uptime: ${healthData.uptime}s`);
      } else {
        logWarn('Health check returned unexpected response');
      }
    } catch (e) {
      logWarn('Could not connect to agent — it may need more time to start');
      logInfo('You can test manually: curl http://127.0.0.1:' + portNum + '/api/agent/health');
    }

    // Stop the test agent
    try {
      if (IS_WINDOWS) {
        execSync(`taskkill /PID ${agentProcess.pid} /T /F`, { stdio: 'pipe' });
      } else {
        process.kill(agentProcess.pid, 'SIGTERM');
      }
    } catch (e) { /* ignore */ }

    console.log('');
  }

  // ===================== Final Summary =====================

  log('╔══════════════════════════════════════════════════════════╗', 'green');
  log('║              Setup Complete!                             ║', 'green');
  log('╚══════════════════════════════════════════════════════════╝', 'green');
  console.log('');
  log('Configuration Summary:', 'bright');
  console.log(`  Port:     ${portNum}`);
  console.log(`  Name:     ${name}`);
  console.log(`  API Key:  ${apiKey}`);
  console.log(`  Config:   ${configPath}`);
  console.log(`  Database: ${path.join(scriptDir, 'db', 'agent.db')}`);
  console.log('');
  log('Quick Start:', 'bright');
  console.log('  1. Double-click start.bat to start the agent');
  console.log('  2. Or run: node agent.js --port ' + portNum + ' --apiKey ' + apiKey);
  console.log('');
  log('Windows Service (optional):', 'bright');
  console.log('  Install:  powershell -ExecutionPolicy Bypass -File install-service.ps1');
  console.log('  Uninstall: powershell -ExecutionPolicy Bypass -File uninstall-service.ps1');
  console.log('');
  log('Add to Dashboard:', 'bright');
  console.log('  1. Open your Dashboard application');
  console.log('  2. Go to Device Management');
  console.log('  3. Add a new device with:');
  console.log(`     IP:       <this computer's IP address>`);
  console.log(`     Port:     ${portNum}`);
  console.log(`     API Key:  ${apiKey}`);
  console.log('');

  // Firewall reminder
  if (IS_WINDOWS) {
    log('Firewall Setup (important!):', 'bright');
    console.log('  Run this command as Administrator to open the port:');
    console.log(`  netsh advfirewall firewall add rule name="Dashboard Agent" dir=in action=allow protocol=TCP localport=${portNum}`);
    console.log('');
  }

  rl.close();
}

main().catch((err) => {
  logError('Setup failed: ' + err.message);
  console.error(err);
  rl.close();
  process.exit(1);
});
