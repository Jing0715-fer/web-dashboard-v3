import { NextRequest, NextResponse } from 'next/server';
import { getResponse } from 'next/dist/server/web/spec-extension/response';

// Middleware to proxy /openclaw/* requests to OpenClaw
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  
  if (pathname.startsWith('/openclaw')) {
    // Rewrite to the openclaw-proxy API route
    const url = request.nextUrl.clone();
    url.pathname = pathname.replace(/^\/openclaw/, '/api/openclaw-proxy');
    return NextResponse.rewrite(url);
  }
  
  return NextResponse.next();
}

export const config = {
  matcher: '/openclaw/:path*',
};
