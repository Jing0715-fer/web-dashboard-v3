import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { readProjectDir, checkPortStatus } from '@/lib/process-manager';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execFileAsync = promisify(execFile);

// POST /api/projects/[id]/analyze-cli - Use Claude Code CLI to analyze project
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
      project.environments = [];
    }

    // Check if claude CLI is available
    let claudePath: string;
    try {
      const { stdout } = await execFileAsync('which', ['claude']);
      claudePath = stdout.trim();
    } catch {
      return NextResponse.json({
        error: 'Claude Code CLI not found. Install it with: npm install -g @anthropic-ai/claude-code',
      }, { status: 400 });
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

    // Read the skill file
    const skillPath = path.join(process.cwd(), 'skills', 'project-config-analyzer.md');
    let skillContent = '';
    if (fs.existsSync(skillPath)) {
      skillContent = fs.readFileSync(skillPath, 'utf-8');
    }

    const prompt = `Analyze this project and generate startup configurations.

Project path: ${project.path}
Project name: ${project.name}

Currently used ports (DO NOT assign these): ${Object.keys(portUsage).join(', ') || 'none detected'}

Key files found:
${configSummary}

${skillContent ? `Follow these instructions:\n${skillContent}` : ''}

Based on the project files, generate a JSON response with this exact structure:
{
  "projectName": "string - a descriptive name for the project",
  "description": "string - brief description of what the project does",
  "icon": "string - a lucide-react icon name",
  "environments": [
    {
      "name": "test",
      "cmd": "string - the command to start in test/dev mode",
      "port": number,
      "envVars": { "KEY": "VALUE" }
    },
    {
      "name": "production",
      "cmd": "string - the command to start in production mode",
      "port": number,
      "envVars": { "KEY": "VALUE" }
    }
  ]
}

CRITICAL Rules:
1. Test and Production MUST use DIFFERENT ports
2. Do NOT assign any port that is listed as "in use" above
3. Use 'bun run' instead of 'npm run' if the project uses bun (has bun.lock or bun.lockb)
4. Environment variables should have: NODE_ENV, HOST="0.0.0.0", PORT as string
5. Respond with ONLY valid JSON, no markdown or explanation`;

    // Invoke Claude Code CLI
    const cliArgs = [
      '-p',                           // Print mode (non-interactive)
      '--output-format', 'json',      // JSON output for structured parsing
      '--dangerously-skip-permissions', // Skip permission prompts in sandbox
      prompt,
    ];

    // Set timeout to 120 seconds
    const { stdout, stderr } = await execFileAsync(claudePath, cliArgs, {
      cwd: project.path,
      timeout: 120000,
      maxBuffer: 1024 * 1024, // 1MB buffer
      env: {
        ...process.env,
        // Ensure Claude Code uses the project directory
      },
    });

    if (stderr && !stdout) {
      return NextResponse.json({
        error: `Claude Code CLI error: ${stderr.slice(0, 500)}`,
      }, { status: 500 });
    }

    // Parse the CLI response
    let response: string;
    try {
      // Claude Code with --output-format json returns a structured object
      const cliOutput = JSON.parse(stdout);
      // The actual response text is in the result field
      response = cliOutput.result || cliOutput.content || cliOutput.text || stdout;
    } catch {
      // If JSON parse fails, treat stdout as raw text
      response = stdout;
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
        error: 'Failed to parse Claude Code CLI response',
        rawResponse: response.slice(0, 500),
      }, { status: 500 });
    }

    // Validate LLM-generated values before storing
    const validatedEnvs: Array<{ name: string; cmd: string; port: number; envVars: Record<string, string> }> = [];
    for (const env of (analysis.environments || [])) {
      const sanitizedName = String(env.name || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50);
      if (!sanitizedName) continue;

      const envPort = Number(env.port);
      if (!Number.isInteger(envPort) || envPort < 1 || envPort > 65535) continue;

      const cmdStr = String(env.cmd || '').trim();
      const safeCmdPrefixes = ['npm', 'npx', 'yarn', 'pnpm', 'bun', 'bunx', 'python', 'python3', 'go', 'cargo', 'make', 'node', 'deno', 'flask', 'gunicorn', 'uvicorn', 'django', 'dotnet', 'php', 'ruby', 'rails', 'bundle', 'docker', 'sh', 'bash', './'];
      const isSafe = safeCmdPrefixes.some(prefix => cmdStr.startsWith(prefix));
      if (!isSafe || cmdStr.length > 500) continue;

      let envVarsObj: Record<string, string> = {};
      if (env.envVars && typeof env.envVars === 'object' && !Array.isArray(env.envVars)) {
        for (const [key, value] of Object.entries(env.envVars)) {
          if (typeof key === 'string' && typeof value === 'string') {
            envVarsObj[key] = value;
          }
        }
      }

      validatedEnvs.push({ name: sanitizedName, cmd: cmdStr, port: envPort, envVars: envVarsObj });
    }

    if (validatedEnvs.length === 0) {
      return NextResponse.json({
        error: 'Claude Code CLI did not generate any valid environment configurations',
        rawResponse: response.slice(0, 500),
      }, { status: 500 });
    }

    // Fix port conflicts between validated environments
    const usedPorts = new Set<number>();
    for (const env of validatedEnvs) {
      if (usedPorts.has(env.port)) {
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
      data: { name: sanitizedName, description: sanitizedDesc, icon: sanitizedIcon },
    });

    // Create environments
    for (const env of validatedEnvs) {
      const existing = project.environments.find(e => e.name === env.name);
      if (existing) {
        await db.environment.update({
          where: { id: existing.id },
          data: { cmd: env.cmd, port: env.port, envVars: JSON.stringify(env.envVars) },
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
        provider: 'claude-code-cli',
      },
    });
  } catch (e: any) {
    console.error('Analyze CLI error:', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
