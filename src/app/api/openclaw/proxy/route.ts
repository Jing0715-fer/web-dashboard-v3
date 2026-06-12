import { NextRequest } from 'next/server';

// Proxy WebSocket connections to OpenClaw through the Dashboard
// This avoids browser security restrictions on cross-origin WebSocket connections
// GET /api/openclaw/proxy?path=/api/v1/health
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const path = searchParams.get('path') || '/';

    // Get token from the original request's Authorization header or cookie
    const authHeader = request.headers.get('authorization') || '';

    const openclawUrl = `http://127.0.0.1:18789${path}`;

    const response = await fetch(openclawUrl, {
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
      },
    });

    const body = await response.text();

    return new NextResponse(body, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('content-type') || 'application/json',
      },
    });
  } catch (e: any) {
    return new NextResponse(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
