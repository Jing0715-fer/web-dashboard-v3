import { NextRequest, NextResponse } from 'next/server';

const OPENCLAW_URL = 'http://127.0.0.1:18789';

// Proxy all requests to OpenClaw through the Dashboard
// This allows LAN clients to access OpenClaw without browser security restrictions
// Any request to /openclaw-proxy/* will be forwarded to OpenClaw
export async function GET(request: NextRequest) {
  return proxyRequest(request);
}

export async function POST(request: NextRequest) {
  return proxyRequest(request);
}

export async function PUT(request: NextRequest) {
  return proxyRequest(request);
}

export async function DELETE(request: NextRequest) {
  return proxyRequest(request);
}

export async function PATCH(request: NextRequest) {
  return proxyRequest(request);
}

export async function OPTIONS(request: NextRequest) {
  return proxyRequest(request);
}

async function proxyRequest(request: NextRequest) {
  try {
    // Get the path after /openclaw-proxy/
    const url = new URL(request.url);
    const pathname = url.pathname;
    
    // Remove the /openclaw-proxy prefix to get the actual OpenClaw path
    let openClawPath = pathname.replace(/^\/openclaw-proxy/, '') || '/';
    
    // Append query string if present
    if (url.search) {
      openClawPath += url.search;
    }

    const targetUrl = `${OPENCLAW_URL}${openClawPath}`;

    // Forward headers
    const headers = new Headers();
    request.headers.forEach((value, key) => {
      // Skip hop-by-hop headers
      if (!['host', 'connection', 'transfer-encoding'].includes(key.toLowerCase())) {
        headers.set(key, value);
      }
    });

    // Override the host header
    headers.set('host', '127.0.0.1:18789');

    // Get request body if present
    const body = ['GET', 'HEAD', 'OPTIONS'].includes(request.method) ? undefined : await request.arrayBuffer();

    const response = await fetch(targetUrl, {
      method: request.method,
      headers,
      body,
      // @ts-ignore - some runtimes support this
      duplex: 'half',
    });

    // Copy response headers
    const responseHeaders = new Headers();
    response.headers.forEach((value, key) => {
      if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
        responseHeaders.set(key, value);
      }
    });

    // Ensure CORS headers are set for the dashboard origin
    const origin = request.headers.get('origin');
    if (origin) {
      responseHeaders.set('access-control-allow-origin', origin);
      responseHeaders.set('access-control-allow-credentials', 'true');
      responseHeaders.set('access-control-allow-methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
      responseHeaders.set('access-control-allow-headers', '*');
    }

    const responseBody = await response.arrayBuffer();

    return new NextResponse(responseBody, {
      status: response.status,
      headers: responseHeaders,
    });
  } catch (e: any) {
    return new NextResponse(JSON.stringify({ 
      error: e.message,
      detail: 'OpenClaw proxy failed. Is OpenClaw running?',
    }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
