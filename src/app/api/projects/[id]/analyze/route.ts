import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { readProjectDir, checkPortStatus, batchCheckPorts } from '@/lib/process-manager';
import { callLLM } from '@/lib/llm-providers';
import { logActivity } from '@/lib/activity';

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

    // Check which ports are already in use — single batched `ss` call instead
    // of 12 sequential checks (each spawning up to 2 shell commands).
    const commonlyUsedPorts = [3000, 3001, 3002, 4000, 5000, 5173, 5174, 8000, 8080, 8081, 8888, 9000];
    const portUsage: Record<number, string> = {};
    const activePorts = await batchCheckPorts(commonlyUsedPorts);
    for (const p of commonlyUsedPorts) {
      if (activePorts.has(p)) {
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

    // Call the configured LLM via the shared client (zai SDK fallback,
    // Anthropic Messages API, or any OpenAI-compatible provider).
    let response: string;
    let providerUsed: string;
    let modelUsed: string;
    try {
      const llm = await callLLM({ system: SYSTEM_PROMPT, prompt, temperature: 0.3 });
      response = llm.text;
      providerUsed = llm.provider;
      modelUsed = llm.model;
    } catch (err: any) {
      logActivity({
        type: 'error',
        level: 'error',
        message: `LLM analysis failed for '${project.name}'`,
        projectId: id,
        projectName: project.name,
        detail: err?.message || String(err),
      });
      return NextResponse.json({
        error: `LLM call failed: ${err?.message || String(err)}`,
      }, { status: 500 });
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
      logActivity({
        type: 'error',
        level: 'error',
        message: `LLM analysis failed for '${project.name}'`,
        projectId: id,
        projectName: project.name,
        detail: 'Failed to parse LLM response as JSON',
      });
      return NextResponse.json({
        error: 'Failed to parse LLM response',
        rawResponse: response.slice(0, 500),
      }, { status: 500 });
    }

    // Validate LLM-generated values before storing
    let validatedEnvs: Array<{ name: string; cmd: string; port: number; envVars: Record<string, string> }> = [];
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
      logActivity({
        type: 'error',
        level: 'error',
        message: `LLM analysis failed for '${project.name}'`,
        projectId: id,
        projectName: project.name,
        detail: 'LLM did not generate any valid environment configurations',
      });
      return NextResponse.json({
        error: 'LLM did not generate any valid environment configurations',
        rawResponse: response.slice(0, 500),
      }, { status: 500 });
    }

    // Dedupe by sanitized name — the LLM occasionally emits two environments
    // that sanitize to the same name (e.g. "dev" + "development"), which both
    // missed the existing-row check below and produced duplicate rows.
    const seenNames = new Set<string>();
    validatedEnvs = validatedEnvs.filter((env) => {
      if (seenNames.has(env.name)) return false;
      seenNames.add(env.name);
      return true;
    });

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

    logActivity({
      type: 'analyze',
      level: 'success',
      message: `LLM analysis completed — ${validatedEnvs.length} environments`,
      projectId: id,
      projectName: project.name,
      detail: `provider: ${providerUsed}, model: ${modelUsed}`,
    });

    return NextResponse.json({
      project: updatedProject,
      analysis: {
        projectName: sanitizedName,
        description: sanitizedDesc,
        icon: sanitizedIcon,
        environments: validatedEnvs,
        provider: providerUsed,
      },
    });
  } catch (e: any) {
    console.error('Analyze error:', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
