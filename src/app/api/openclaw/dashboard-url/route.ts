import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs';

// GET /api/openclaw/dashboard-url - Get the OpenClaw dashboard URL with token
// Uses the same-origin /openclaw proxy path to bypass browser secure context restrictions
export async function GET(request: NextRequest) {
  try {
    // Try to get the token from openclaw.json
    const configPath = process.env.HOME + '/.openclaw/openclaw.json';
    let token = '';

    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        token = config?.gateway?.auth?.token || '';
      } catch {
        // ignore parse errors
      }
    }

    // Use same-origin relative path: /openclaw/
    // This avoids browser secure context restrictions for WebSocket
    const baseUrl = '/openclaw/';

    if (token) {
      return NextResponse.json({
        url: `${baseUrl}#token=${token}`,
        baseUrl,
        hasToken: true,
      });
    }

    return NextResponse.json({
      url: baseUrl,
      baseUrl,
      hasToken: false,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
