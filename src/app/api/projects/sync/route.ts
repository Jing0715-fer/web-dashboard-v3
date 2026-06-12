import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

interface ParsedProject {
  name: string
  path: string
  devPort: number
  prodPort: number
}

function parseBashArray(content: string, arrayName: string): string[] {
  // Match bash array in two formats:
  // 1. Multi-line: ARRAY_NAME=(\n  "value1"\n  "value2"\n)
  // 2. Single-line: ARRAY_NAME=(value1 value2 value3)
  const regex = new RegExp(
    `${arrayName}=\\(\\s*([\\s\\S]*?)\\s*\\)`,
    'm'
  )
  const match = content.match(regex)
  if (!match) return []

  const body = match[1]
  const values: string[] = []

  // First try to extract quoted values: "value"
  const valueRegex = /"([^"]*)"/g
  let valueMatch
  while ((valueMatch = valueRegex.exec(body)) !== null) {
    values.push(valueMatch[1])
  }

  // If no quoted values found, try unquoted space-separated values
  if (values.length === 0) {
    const unquoted = body.trim().split(/\s+/).filter(Boolean)
    values.push(...unquoted)
  }

  return values
}

function parseProjectData(content: string): ParsedProject[] {
  const names = parseBashArray(content, 'PROJECT_NAMES')
  const paths = parseBashArray(content, 'PROJECT_PATHS')
  const ports = parseBashArray(content, 'PROJECT_PORTS')

  if (names.length === 0 || paths.length === 0 || ports.length === 0) {
    return []
  }

  const count = Math.min(names.length, paths.length, ports.length)
  const projects: ParsedProject[] = []

  for (let i = 0; i < count; i++) {
    const name = names[i]
    const projPath = paths[i]
    const devPort = parseInt(ports[i], 10)

    if (isNaN(devPort)) continue

    // Compute prod port: special cases for dashboard and pdb-tracker
    let prodPort: number
    const nameLower = name.toLowerCase().replace(/[-_\s]/g, '')

    if (nameLower === 'dashboard') {
      prodPort = 4000
    } else if (nameLower.includes('pdb') && nameLower.includes('tracker')) {
      prodPort = 4003
    } else {
      prodPort = devPort + 1000
    }

    projects.push({
      name,
      path: projPath,
      devPort,
      prodPort,
    })
  }

  return projects
}

function toDisplayName(bashName: string): string {
  // Convert "dashboard" → "Dashboard", "pdb-tracker-web-v3" → "PDB Tracker Web V3"
  return bashName
    .split('-')
    .map((part) => {
      // Keep known acronyms uppercase
      const upper = ['pdb', 'api', 'ui', 'web', 'v3', 'v2', 'v1']
      if (upper.includes(part.toLowerCase())) {
        return part.toUpperCase()
      }
      return part.charAt(0).toUpperCase() + part.slice(1)
    })
    .join(' ')
}

function inferIcon(name: string): string {
  const lower = name.toLowerCase()
  if (lower.includes('dashboard')) return 'monitor'
  if (lower.includes('hermes') || lower.includes('web')) return 'globe'
  if (lower.includes('script') || lower.includes('terminal')) return 'terminal'
  if (lower.includes('pdb') || lower.includes('database') || lower.includes('tracker'))
    return 'database'
  if (lower.includes('pptx') || lower.includes('template') || lower.includes('editor'))
    return 'folder'
  if (lower.includes('lab') || lower.includes('virtual') || lower.includes('cpu'))
    return 'cpu'
  return 'folder'
}

function inferTags(name: string): string[] {
  const lower = name.toLowerCase()
  const tags: string[] = []

  if (lower.includes('web') || lower.includes('dashboard') || lower.includes('editor'))
    tags.push('Frontend')
  if (lower.includes('api') || lower.includes('script') || lower.includes('manager'))
    tags.push('Backend')
  if (lower.includes('dashboard') || lower.includes('tracker') || lower.includes('lab'))
    tags.push('Fullstack')
  if (lower.includes('devops') || lower.includes('script') || lower.includes('manager'))
    tags.push('DevOps')
  if (lower.includes('database') || lower.includes('pdb') || lower.includes('tracker'))
    tags.push('Database')
  if (lower.includes('lab') || lower.includes('virtual') || lower.includes('ml'))
    tags.push('ML/AI')

  if (tags.length === 0) tags.push('Frontend')
  return tags
}

function inferDescription(name: string): string {
  const lower = name.toLowerCase()
  if (lower.includes('dashboard'))
    return 'Main project management dashboard — Next.js web app for monitoring and controlling all sub-projects'
  if (lower.includes('hermes'))
    return 'Hermes messaging platform web interface — Real-time communication web application'
  if (lower.includes('script') && lower.includes('manager'))
    return 'Script management and automation tool — Organize, schedule, and monitor shell scripts'
  if (lower.includes('pdb') && lower.includes('tracker'))
    return 'Protein Data Bank tracker — Structural biology data tracking and visualization platform'
  if (lower.includes('pptx') || lower.includes('template'))
    return 'PowerPoint template editor — Design and customize presentation templates with drag-and-drop'
  if (lower.includes('virtual') && lower.includes('lab'))
    return 'Virtual laboratory environment — Simulate experiments and analyze results in a web-based lab'
  return `${toDisplayName(name)} project`
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { content } = body as { content: string }

    if (!content || typeof content !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid "content" field in request body' },
        { status: 400 }
      )
    }

    const parsedProjects = parseProjectData(content)

    if (parsedProjects.length === 0) {
      return NextResponse.json(
        { error: 'No projects could be parsed from the provided content' },
        { status: 400 }
      )
    }

    const results = []

    for (const proj of parsedProjects) {
      const displayName = toDisplayName(proj.name)
      const icon = inferIcon(proj.name)
      const tags = inferTags(proj.name)
      const description = inferDescription(proj.name)

      // Upsert: if project with same path exists, update it; otherwise create
      const upserted = await db.project.upsert({
        where: { path: proj.path },
        update: {
          name: displayName,
          description,
          icon,
          tags: JSON.stringify(tags),
        },
        create: {
          name: displayName,
          path: proj.path,
          description,
          icon,
          tags: JSON.stringify(tags),
          environments: {
            create: [
              {
                name: 'development',
                cmd: 'npm run dev',
                port: proj.devPort,
                envVars: JSON.stringify({}),
                status: 'stopped',
              },
              {
                name: 'production',
                cmd: 'node .next/standalone/server.js',
                port: proj.prodPort,
                envVars: JSON.stringify({ NODE_ENV: 'production' }),
                status: 'stopped',
              },
            ],
          },
        },
        include: { environments: true },
      })

      results.push(upserted)
    }

    return NextResponse.json({
      message: `Synced ${results.length} projects from project-manager.sh`,
      projects: results,
    })
  } catch (error) {
    console.error('Failed to sync projects:', error)
    return NextResponse.json(
      { error: 'Failed to sync projects' },
      { status: 500 }
    )
  }
}
