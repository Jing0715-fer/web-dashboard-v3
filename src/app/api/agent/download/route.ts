import { NextRequest, NextResponse } from 'next/server'
import { execSync } from 'child_process'
import { existsSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

export const dynamic = 'force-dynamic'

/**
 * GET /api/agent/download
 * Downloads the Windows Agent package as a ZIP file.
 * Query params:
 *   - platform: 'windows' (default) | 'linux' | 'macos'
 */
export async function GET(req: NextRequest) {
  const platform = req.nextUrl.searchParams.get('platform') || 'windows'

  const agentDir = join(process.cwd(), 'mini-services', `agent-${platform}`)

  if (!existsSync(agentDir)) {
    return NextResponse.json(
      { error: `Agent package for '${platform}' not found`, availablePlatforms: ['windows'] },
      { status: 404 }
    )
  }

  try {
    // Create a zip file of the agent directory
    const tmpDir = join(process.cwd(), '.tmp')
    if (!existsSync(tmpDir)) {
      execSync(`mkdir -p ${tmpDir}`)
    }

    const zipFileName = `dashboard-agent-${platform}.zip`
    const zipPath = join(tmpDir, zipFileName)

    // Remove old zip if exists
    if (existsSync(zipPath)) {
      execSync(`rm -f ${zipPath}`)
    }

    // Create the zip (exclude node_modules, db files, dist, zip archives, and temp files)
    execSync(
      `cd ${agentDir} && zip -r ${zipPath} . -x "node_modules/*" -x "db/*" -x "*.db" -x "*.lock" -x ".tmp/*" -x "dist/*" -x "*.zip"`,
      { timeout: 30000 }
    )

    if (!existsSync(zipPath)) {
      return NextResponse.json(
        { error: 'Failed to create agent package' },
        { status: 500 }
      )
    }

    const zipBuffer = readFileSync(zipPath)
    const fileSize = statSync(zipPath).size

    // Clean up the temp zip
    try { execSync(`rm -f ${zipPath}`) } catch {}

    return new NextResponse(zipBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${zipFileName}"`,
        'Content-Length': String(fileSize),
        'Cache-Control': 'no-cache',
      },
    })
  } catch (error: any) {
    console.error('[Agent Download] Error:', error)
    return NextResponse.json(
      { error: 'Failed to package agent', details: error.message },
      { status: 500 }
    )
  }
}
