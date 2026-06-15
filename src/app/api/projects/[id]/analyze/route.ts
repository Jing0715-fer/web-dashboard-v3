import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { readProjectDir, checkPortStatus } from '@/lib/process-manager';

// z-ai-web-dev-sdk is optional — only used when provider is 'zai'
let ZAI: unknown;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ZAI = require('z-ai-web-dev-sdk');
} catch {
  // package not installed — zai provider will be unavailable
}

const SYSTEM_PROMPT = 'You are a DevOps expert that analyzes project structures and generates startup configurations. Always respond with valid JSON only. Ensure all port numbers are different between environments and all IP addresses are valid.';

// POST /api/projects/[id]/analyze - LLM analyzes project directory
// Query params:
//   ?replace=true  — delete all existing environments before creating new ones
//                    (default: update by name or create)
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const replace = req.nextUrl.searchParams.get('replace') === 'true';
    const project = await db.project.findUnique({
      where: { id },
      include: { environments: true },
    });

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    // If replace=true, delete all existing environments first
    if (replace && project.environments.length > 0) {
      await db.environment.deleteMany({ where: { projectId: id } });
      // Refetch after deletion so the rest of the flow sees an empty set
      project.environments = [];
    }

    // Read project directory
    const dirInfo = await readProjectDir(project.path);
    if (!dirInfo.success) {
      return NextResponse.json({ error: dirInfo.error }, { status: 400 });
    }

    // Build context for LLM
    const configSummary = (dirInfo.configFile || [])
      .map(f => `=== ${f.name} ===\n${f.content}`)
      .join('\n\n');

    // Check which ports are already in use
    const commonlyUsedPorts = [3000, 3001, 3002, 4000, 5000, 5173, 5174, 8000, 8080, 8081, 8888, 9000];
    const portUsage: Record<number, string> = {};
    for (const p of commonlyUsedPorts) {
      if (await checkPortStatus(p)) {
        portUsage[p] = 'in use';
      }
    }

    const prompt = `You are a DevOps expert. Analyze the following project directory and generate startup configurations for both a test environment and a production environment.

Project path: ${project.path}
Project name: ${project.name}

Currently used ports (DO NOT assign these): ${Object.keys(portUsage).join(', ') || 'none detected'}

Key files found:
${configSummary}

Based on the project files, generate a JSON response with this exact structure:
{
  "projectName": "string - a descriptive name for the project",
  "description": "string - brief description of what the project does",
  "icon": "string - a lucide-react icon name that represents the project (e.g., 'globe', 'code', 'database', 'smartphone', 'shopping-cart', 'layout', 'palette', 'cpu', 'book-open', 'music', 'gamepad-2', 'bar-chart', 'shield', 'heart', 'camera', 'map', 'cloud', 'terminal', 'rocket', 'puzzle')",
  "environments": [
    {
      "name": "test",
      "cmd": "string - the command to start in test/dev mode",
      "port": number - the port the app runs on in test mode (MUST be different from production port),
      "envVars": { "KEY": "VALUE" } - environment variables for test mode
    },
    {
      "name": "production",
      "cmd": "string - the command to start in production mode",
      "port": number - the port the app runs on in production mode (MUST be different from test port),
      "envVars": { "KEY": "VALUE" } - environment variables for production mode
    }
  ]
}

CRITICAL Rules:
1. Test and Production MUST use DIFFERENT ports. For example: test=3001, production=3000
2. Do NOT assign any port that is listed as "in use" above
3. Common port conventions:
   - Next.js: test uses 'npm run dev' (port 3001), production uses 'npm run build && npm run start' (port 3000)
   - Vite/Vue: test uses 'npm run dev' (port 5173), production uses 'npm run build && npm run preview' (port 4173)
   - React: test uses 'npm start' (port 3001), production uses 'npx serve -s build' (port 3000)
   - Python/Flask: test uses 'flask run' (port 5001), production uses 'gunicorn' (port 5000)
4. Use 'bun run' instead of 'npm run' if the project uses bun (has bun.lock or bun.lockb).
   IMPORTANT: For Next.js standalone mode (output: "standalone" in next.config), the production command MUST use 'node' not 'bun' to run .next/standalone/server.js — it is a Node.js CJS module.
5. Environment variables should have proper values:
   - NODE_ENV: "development" for test, "production" for production
   - HOST: "0.0.0.0" (NOT "0.0.0.0.0" - exactly four octets)
   - PORT: the port number as a string
6. Set appropriate env vars based on the project type
7. Respond with ONLY valid JSON, no markdown or explanation
8. The icon should be a lucide-react icon name (e.g., 'globe', 'code', 'database', 'smartphone', 'terminal', 'rocket') that best represents the project's purpose`;

    // Get LLM configuration
    const llmConfig = await db.llmConfig.findUnique({ where: { id: 'default' } });
    const provider = llmConfig?.provider || 'zai';

    let response: string;

    if (provider === 'zai' || (!llmConfig?.apiKey && provider !== 'claude-code')) {
      // Use built-in z-ai-web-dev-sdk
      const zai = await ZAI.create();
      const completion = await zai.chat.completions.create({
        messages: [
          { role: 'assistant', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        thinking: { type: 'disabled' },
      });
      response = completion.choices[0]?.message?.content || '';
    } else if (provider === 'anthropic' || provider === 'claude-code') {
      // Use Anthropic Messages API
      // For claude-code provider, try environment variables if no stored key
      let effectiveApiKey = llmConfig.apiKey;
      let effectiveBaseUrl = llmConfig.baseUrl;
      let effectiveModel = llmConfig.model || 'claude-sonnet-4-20250514';

      if (provider === 'claude-code' && !effectiveApiKey) {
        // Try to detect from environment
        effectiveApiKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || '';
        effectiveBaseUrl = process.env.ANTHROPIC_BASE_URL || process.env.CLAUDE_BASE_URL || effectiveBaseUrl;
        effectiveModel = process.env.CLAUDE_MODEL || process.env.ANTHROPIC_MODEL || effectiveModel;
      }

      if (!effectiveApiKey) {
        return NextResponse.json({
          error: 'No API key available. Please configure LLM settings or set ANTHROPIC_API_KEY environment variable.',
        }, { status: 400 });
      }

      const apiUrl = effectiveBaseUrl
        ? `${effectiveBaseUrl.replace(/\/$/, '')}/v1/messages`
        : 'https://api.anthropic.com/v1/messages';

      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': effectiveApiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: effectiveModel,
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          messages: [
            { role: 'user', content: prompt },
          ],
          temperature: 0.3,
        }),
      });

      if (!res.ok) {
        const errorText = await res.text();
        return NextResponse.json({
          error: `Anthropic API error (${res.status}): ${errorText.slice(0, 300)}`,
        }, { status: 500 });
      }

      const data = await res.json();
      response = data.content?.[0]?.text || '';
    } else {
      // Use custom OpenAI-compatible API (also handles provider === 'openai')
      const apiUrl = llmConfig.baseUrl
        ? `${llmConfig.baseUrl.replace(/\/$/, '')}/v1/chat/completions`
        : 'https://api.openai.com/v1/chat/completions';
      const model = llmConfig.model || 'gpt-4o-mini';

      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${llmConfig.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: prompt },
          ],
          temperature: 0.3,
        }),
      });

      if (!res.ok) {
        const errorText = await res.text();
        return NextResponse.json({
          error: `LLM API error (${res.status}): ${errorText.slice(0, 200)}`,
        }, { status: 500 });
      }

      const data = await res.json();
      response = data.choices?.[0]?.message?.content || '';
    }

    // Parse JSON from response (handle markdown code blocks)
    let jsonStr = response;
    const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1];
    }

    let analysis;
    try {
      analysis = JSON.parse(jsonStr.trim());
    } catch {
      return NextResponse.json({
        error: 'Failed to parse LLM response',
        rawResponse: response.slice(0, 500),
      }, { status: 500 });
    }

    // Validate LLM-generated values before storing
    const validatedEnvs: Array<{ name: string; cmd: string; port: number; envVars: Record<string, string> }> = [];
    for (const env of (analysis.environments || [])) {
      // Validate environment name - only alphanumeric, dash, underscore
      const sanitizedName = String(env.name || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50);
      if (!sanitizedName) continue;

      // Validate port
      const envPort = Number(env.port);
      if (!Number.isInteger(envPort) || envPort < 1 || envPort > 65535) continue;

      // Validate command - must start with a known safe prefix
      const cmdStr = String(env.cmd || '').trim();
      const safeCmdPrefixes = ['npm', 'npx', 'yarn', 'pnpm', 'bun', 'python', 'python3', 'go', 'cargo', 'make', 'node', 'deno', 'flask', 'gunicorn', 'uvicorn', 'django', 'dotnet', 'php', 'ruby', 'rails', 'bundle', 'docker', 'sh', 'bash', './'];
      const isSafe = safeCmdPrefixes.some(prefix => cmdStr.startsWith(prefix));
      if (!isSafe || cmdStr.length > 500) continue;

      // Validate envVars is an object
      let envVarsObj: Record<string, string> = {};
      if (env.envVars && typeof env.envVars === 'object' && !Array.isArray(env.envVars)) {
        for (const [key, value] of Object.entries(env.envVars)) {
          if (typeof key === 'string' && typeof value === 'string') {
            envVarsObj[key] = value;
          }
        }
      }

      validatedEnvs.push({
        name: sanitizedName,
        cmd: cmdStr,
        port: envPort,
        envVars: envVarsObj,
      });
    }

    if (validatedEnvs.length === 0) {
      return NextResponse.json({
        error: 'LLM did not generate any valid environment configurations',
        rawResponse: response.slice(0, 500),
      }, { status: 500 });
    }

    // Fix port conflicts between validated environments
    const usedPorts = new Set<number>();
    for (const env of validatedEnvs) {
      if (usedPorts.has(env.port)) {
        // Find next available port
        let newPort = env.port + 1;
        while (usedPorts.has(newPort) || await checkPortStatus(newPort)) {
          newPort++;
        }
        env.port = newPort;
      }
      usedPorts.add(env.port);
    }

    // Validate and sanitize project name/description/icon
    const sanitizedName = String(analysis.projectName || project.name).slice(0, 100);
    const sanitizedDesc = String(analysis.description || project.description).slice(0, 500);
    const allowedIcons = ['folder', 'globe', 'code', 'database', 'smartphone', 'shopping-cart', 'layout', 'palette', 'cpu', 'book-open', 'music', 'gamepad-2', 'bar-chart', 'shield', 'camera', 'map', 'cloud', 'terminal', 'rocket', 'puzzle', 'package', 'zap', 'laptop', 'atom', 'flame', 'server'];
    const sanitizedIcon = allowedIcons.includes(analysis.icon) ? analysis.icon : project.icon;

    // Update project info
    await db.project.update({
      where: { id },
      data: {
        name: sanitizedName,
        description: sanitizedDesc,
        icon: sanitizedIcon,
      },
    });

    // Create environments
    for (const env of validatedEnvs) {
      const existing = project.environments.find(e => e.name === env.name);
      if (existing) {
        await db.environment.update({
          where: { id: existing.id },
          data: {
            cmd: env.cmd,
            port: env.port,
            envVars: JSON.stringify(env.envVars),
          },
        });
      } else {
        await db.environment.create({
          data: {
            projectId: id,
            name: env.name,
            cmd: env.cmd,
            port: env.port,
            envVars: JSON.stringify(env.envVars),
          },
        });
      }
    }

    // Return the updated project
    const updatedProject = await db.project.findUnique({
      where: { id },
      include: { environments: true },
    });

    return NextResponse.json({
      project: updatedProject,
      analysis: {
        projectName: sanitizedName,
        description: sanitizedDesc,
        icon: sanitizedIcon,
        environments: validatedEnvs,
        provider,
      },
    });
  } catch (e: any) {
    console.error('Analyze error:', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
