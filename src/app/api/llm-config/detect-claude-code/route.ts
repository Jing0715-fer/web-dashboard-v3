import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

interface DetectedConfig {
  found: boolean;
  source: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  details: string[];
}

// GET /api/llm-config/detect-claude-code - Detect Claude Code CLI configuration
export async function GET() {
  try {
    const results: DetectedConfig = {
      found: false,
      source: '',
      apiKey: '',
      baseUrl: '',
      model: '',
      details: [],
    };

    const homeDir = os.homedir();

    // 1. Check environment variables (most reliable)
    const envApiKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || '';
    const envBaseUrl = process.env.ANTHROPIC_BASE_URL || process.env.CLAUDE_BASE_URL || '';
    const envModel = process.env.CLAUDE_MODEL || process.env.ANTHROPIC_MODEL || '';

    if (envApiKey) {
      results.found = true;
      results.apiKey = envApiKey;
      results.source = 'environment';
      results.details.push(`API key found in ANTHROPIC_API_KEY`);
      if (envBaseUrl) {
        results.baseUrl = envBaseUrl;
        results.details.push(`Base URL: ${envBaseUrl}`);
      }
      if (envModel) {
        results.model = envModel;
        results.details.push(`Model: ${envModel} (from env)`);
      }
    }

    // 2. Check ~/.claude/ directory for config files
    const claudeDir = path.join(homeDir, '.claude');
    if (fs.existsSync(claudeDir)) {
      // Check for settings.json (Claude Code's main config file)
      const settingsPath = path.join(claudeDir, 'settings.json');
      if (fs.existsSync(settingsPath)) {
        try {
          const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
          results.details.push(`Found ~/.claude/settings.json`);

          // Check for API key
          if (settings.apiKey && !results.apiKey) {
            results.apiKey = settings.apiKey;
            results.found = true;
            results.source = results.source || 'claude-settings';
          }
          if (settings.apiBaseUrl && !results.baseUrl) {
            results.baseUrl = settings.apiBaseUrl;
          }
          // Model from settings (Claude Code stores model preference here)
          if (settings.model && !results.model) {
            results.model = settings.model;
            results.details.push(`Model: ${settings.model} (from ~/.claude/settings.json)`);
          }
          // Check nested api config
          if (settings.api?.key && !results.apiKey) {
            results.apiKey = settings.api.key;
            results.found = true;
            results.source = results.source || 'claude-settings';
          }
          if (settings.api?.baseUrl && !results.baseUrl) {
            results.baseUrl = settings.api.baseUrl;
          }
          if (settings.api?.model && !results.model) {
            results.model = settings.api.model;
            results.details.push(`Model: ${settings.api.model} (from ~/.claude/settings.json api section)`);
          }
        } catch {
          results.details.push(`Found ~/.claude/settings.json but could not parse it`);
        }
      }

      // Check for credentials
      const credentialsPath = path.join(claudeDir, 'credentials.json');
      if (fs.existsSync(credentialsPath)) {
        try {
          const cred = JSON.parse(fs.readFileSync(credentialsPath, 'utf-8'));
          results.details.push(`Found ~/.claude/credentials.json`);
          if (cred.apiKey && !results.apiKey) {
            results.apiKey = cred.apiKey;
            results.found = true;
            results.source = results.source || 'claude-credentials';
          }
          if (cred.apiBaseUrl && !results.baseUrl) {
            results.baseUrl = cred.apiBaseUrl;
          }
        } catch {
          results.details.push(`Found ~/.claude/credentials.json but could not parse it`);
        }
      }

      // Check for .env file
      const envPath = path.join(claudeDir, '.env');
      if (fs.existsSync(envPath)) {
        try {
          const envVars = parseEnvFile(fs.readFileSync(envPath, 'utf-8'));
          results.details.push(`Found ~/.claude/.env`);
          if (envVars.ANTHROPIC_API_KEY && !results.apiKey) {
            results.apiKey = envVars.ANTHROPIC_API_KEY;
            results.found = true;
            results.source = results.source || 'claude-env';
          }
          if (envVars.CLAUDE_API_KEY && !results.apiKey) {
            results.apiKey = envVars.CLAUDE_API_KEY;
            results.found = true;
            results.source = results.source || 'claude-env';
          }
          if (envVars.ANTHROPIC_BASE_URL && !results.baseUrl) {
            results.baseUrl = envVars.ANTHROPIC_BASE_URL;
          }
          if (envVars.CLAUDE_BASE_URL && !results.baseUrl) {
            results.baseUrl = envVars.CLAUDE_BASE_URL;
          }
          if (envVars.CLAUDE_MODEL && !results.model) {
            results.model = envVars.CLAUDE_MODEL;
            results.details.push(`Model: ${envVars.CLAUDE_MODEL} (from ~/.claude/.env)`);
          }
          if (envVars.ANTHROPIC_MODEL && !results.model) {
            results.model = envVars.ANTHROPIC_MODEL;
            results.details.push(`Model: ${envVars.ANTHROPIC_MODEL} (from ~/.claude/.env)`);
          }
        } catch {
          results.details.push(`Found ~/.claude/.env but could not read it`);
        }
      }
    }

    // 3. Check ~/.claude.json (legacy format)
    const claudeJsonPath = path.join(homeDir, '.claude.json');
    if (fs.existsSync(claudeJsonPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
        results.details.push(`Found ~/.claude.json`);
        if (config.apiKey && !results.apiKey) {
          results.apiKey = config.apiKey;
          results.found = true;
          results.source = results.source || 'claude-json';
        }
        if (config.apiBaseUrl && !results.baseUrl) {
          results.baseUrl = config.apiBaseUrl;
        }
        if (config.model && !results.model) {
          results.model = config.model;
          results.details.push(`Model: ${config.model} (from ~/.claude.json)`);
        }
      } catch {
        results.details.push(`Found ~/.claude.json but could not parse it`);
      }
    }

    // 4. Check ~/.config/claude-code/ directory
    const configDir = path.join(homeDir, '.config', 'claude-code');
    if (fs.existsSync(configDir)) {
      const configPath = path.join(configDir, 'config.json');
      if (fs.existsSync(configPath)) {
        try {
          const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
          results.details.push(`Found ~/.config/claude-code/config.json`);
          if (config.apiKey && !results.apiKey) {
            results.apiKey = config.apiKey;
            results.found = true;
            results.source = results.source || 'claude-code-config';
          }
          if (config.apiBaseUrl && !results.baseUrl) {
            results.baseUrl = config.apiBaseUrl;
          }
          if (config.model && !results.model) {
            results.model = config.model;
            results.details.push(`Model: ${config.model} (from ~/.config/claude-code/config.json)`);
          }
        } catch {
          results.details.push(`Found ~/.config/claude-code/config.json but could not parse it`);
        }
      }
    }

    // 5. Try reading model from Claude Code CLI config via `claude config list`
    if (!results.model) {
      try {
        const { stdout } = await execFileAsync('claude', ['config', 'list'], {
          timeout: 10000,
          maxBuffer: 64 * 1024,
        });
        // Parse output for model setting
        const modelMatch = stdout.match(/model[:\s]+(\S+)/i);
        if (modelMatch) {
          results.model = modelMatch[1];
          results.details.push(`Model: ${modelMatch[1]} (from claude config list)`);
        }
      } catch {
        // CLI not available or config not set
      }
    }

    // 6. Set sensible defaults if config found but no model specified
    if (results.found && !results.model) {
      results.model = 'claude-sonnet-4-20250514';
      results.details.push('Model: claude-sonnet-4-20250514 (default)');
    }

    // Set default base URL for Anthropic if not specified
    if (results.found && !results.baseUrl) {
      results.baseUrl = 'https://api.anthropic.com';
    }

    // Mask the API key in the response
    const maskedResult = {
      ...results,
      apiKey: results.apiKey
        ? '*'.repeat(Math.max(0, results.apiKey.length - 4)) + results.apiKey.slice(-4)
        : '',
      hasApiKey: !!results.apiKey,
    };

    return NextResponse.json({ config: maskedResult });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// Parse a simple .env file
function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}
