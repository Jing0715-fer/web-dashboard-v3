import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import fs from 'fs'
import path from 'path'

interface ConfigEnvironment {
  name: string
  cmd: string
  port: number
  envVars: Record<string, string>
}

interface ConfigProject {
  name: string
  path: string
  description: string
  icon: string
  tags: string[]
  environments: ConfigEnvironment[]
}

interface ProjectsConfig {
  version: string
  description: string
  projects: ConfigProject[]
}

export async function GET() {
  try {
    const projectCount = await db.project.count()
    const environmentCount = await db.environment.count()
    const projects = await db.project.findMany({
      select: { id: true, name: true, path: true },
    })

    return NextResponse.json({
      seeded: projectCount > 0,
      projectCount,
      environmentCount,
      projects,
    })
  } catch (error) {
    console.error('Failed to get seed status:', error)
    return NextResponse.json(
      { error: 'Failed to get seed status' },
      { status: 500 }
    )
  }
}

export async function POST() {
  try {
    const configPath = path.join(process.cwd(), 'projects.config.json')

    if (!fs.existsSync(configPath)) {
      return NextResponse.json(
        { error: 'projects.config.json not found' },
        { status: 404 }
      )
    }

    const configRaw = fs.readFileSync(configPath, 'utf-8')
    const config: ProjectsConfig = JSON.parse(configRaw)

    if (!config.projects || !Array.isArray(config.projects)) {
      return NextResponse.json(
        { error: 'Invalid config: missing projects array' },
        { status: 400 }
      )
    }

    // Delete all environments first (due to foreign key constraint)
    await db.environment.deleteMany()

    // Delete all projects
    await db.project.deleteMany()

    // Create each project with its environments
    const createdProjects = []
    for (const project of config.projects) {
      const created = await db.project.create({
        data: {
          name: project.name,
          path: project.path,
          description: project.description || '',
          icon: project.icon || 'folder',
          tags: JSON.stringify(project.tags || []),
          environments: {
            create: (project.environments || []).map((env) => ({
              name: env.name,
              cmd: env.cmd,
              port: env.port,
              envVars: JSON.stringify(env.envVars || {}),
              status: 'stopped',
            })),
          },
        },
        include: { environments: true },
      })
      createdProjects.push(created)
    }

    return NextResponse.json({
      message: `Seeded ${createdProjects.length} projects with ${createdProjects.reduce((sum, p) => sum + p.environments.length, 0)} environments`,
      projects: createdProjects,
    })
  } catch (error) {
    console.error('Failed to seed database:', error)
    return NextResponse.json(
      { error: 'Failed to seed database' },
      { status: 500 }
    )
  }
}
