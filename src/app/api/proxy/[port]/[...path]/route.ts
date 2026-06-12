import { NextRequest, NextResponse } from 'next/server'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ port: string; path?: string[] }> }
) {
  const { port: portStr, path: pathSegments } = await params
  const port = parseInt(portStr, 10)

  if (isNaN(port) || port < 1 || port > 65535) {
    return NextResponse.json({ error: 'Invalid port number' }, { status: 400 })
  }

  const targetPath = pathSegments ? '/' + pathSegments.join('/') : '/'
  const search = request.nextUrl.search
  const targetUrl = `http://127.0.0.1:${port}${targetPath}${search}`

  try {
    const headers = new Headers(request.headers)
    headers.set('host', `localhost:${port}`)
    headers.delete('x-forwarded-for')
    headers.delete('x-forwarded-host')
    headers.delete('x-forwarded-proto')

    const response = await fetch(targetUrl, {
      method: 'GET',
      headers,
      redirect: 'manual',
    })

    const responseHeaders = new Headers(response.headers)
    responseHeaders.delete('content-encoding')

    // Rewrite redirect locations to go through the proxy
    const location = responseHeaders.get('location')
    if (location && response.status >= 300 && response.status < 400) {
      try {
        const redirectUrl = new URL(location, targetUrl)
        if (redirectUrl.hostname === '127.0.0.1' || redirectUrl.hostname === 'localhost') {
          const proxyLocation = `/api/proxy/${redirectUrl.port}${redirectUrl.pathname}${redirectUrl.search}`
          responseHeaders.set('location', proxyLocation)
        }
      } catch {
        // Keep original location if URL parsing fails
      }
    }

    return new NextResponse(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Proxy request failed'
    return NextResponse.json(
      { error: 'Failed to connect to service', details: message, port, targetPath },
      { status: 502 }
    )
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ port: string; path?: string[] }> }
) {
  const { port: portStr, path: pathSegments } = await params
  const port = parseInt(portStr, 10)

  if (isNaN(port) || port < 1 || port > 65535) {
    return NextResponse.json({ error: 'Invalid port number' }, { status: 400 })
  }

  const targetPath = pathSegments ? '/' + pathSegments.join('/') : '/'
  const search = request.nextUrl.search
  const targetUrl = `http://127.0.0.1:${port}${targetPath}${search}`

  try {
    const headers = new Headers(request.headers)
    headers.set('host', `localhost:${port}`)
    headers.delete('x-forwarded-for')
    headers.delete('x-forwarded-host')
    headers.delete('x-forwarded-proto')

    const body = await request.arrayBuffer()

    const response = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body,
      redirect: 'manual',
    })

    const responseHeaders = new Headers(response.headers)
    responseHeaders.delete('content-encoding')

    return new NextResponse(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Proxy request failed'
    return NextResponse.json(
      { error: 'Failed to connect to service', details: message, port, targetPath },
      { status: 502 }
    )
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ port: string; path?: string[] }> }
) {
  const { port: portStr, path: pathSegments } = await params
  const port = parseInt(portStr, 10)

  if (isNaN(port) || port < 1 || port > 65535) {
    return NextResponse.json({ error: 'Invalid port number' }, { status: 400 })
  }

  const targetPath = pathSegments ? '/' + pathSegments.join('/') : '/'
  const search = request.nextUrl.search
  const targetUrl = `http://127.0.0.1:${port}${targetPath}${search}`

  try {
    const headers = new Headers(request.headers)
    headers.set('host', `localhost:${port}`)
    headers.delete('x-forwarded-for')
    headers.delete('x-forwarded-host')
    headers.delete('x-forwarded-proto')

    const body = await request.arrayBuffer()

    const response = await fetch(targetUrl, {
      method: 'PUT',
      headers,
      body,
      redirect: 'manual',
    })

    const responseHeaders = new Headers(response.headers)
    responseHeaders.delete('content-encoding')

    return new NextResponse(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Proxy request failed'
    return NextResponse.json(
      { error: 'Failed to connect to service', details: message, port, targetPath },
      { status: 502 }
    )
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ port: string; path?: string[] }> }
) {
  const { port: portStr, path: pathSegments } = await params
  const port = parseInt(portStr, 10)

  if (isNaN(port) || port < 1 || port > 65535) {
    return NextResponse.json({ error: 'Invalid port number' }, { status: 400 })
  }

  const targetPath = pathSegments ? '/' + pathSegments.join('/') : '/'
  const search = request.nextUrl.search
  const targetUrl = `http://127.0.0.1:${port}${targetPath}${search}`

  try {
    const headers = new Headers(request.headers)
    headers.set('host', `localhost:${port}`)
    headers.delete('x-forwarded-for')
    headers.delete('x-forwarded-host')
    headers.delete('x-forwarded-proto')

    const body = await request.arrayBuffer()

    const response = await fetch(targetUrl, {
      method: 'PATCH',
      headers,
      body,
      redirect: 'manual',
    })

    const responseHeaders = new Headers(response.headers)
    responseHeaders.delete('content-encoding')

    return new NextResponse(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Proxy request failed'
    return NextResponse.json(
      { error: 'Failed to connect to service', details: message, port, targetPath },
      { status: 502 }
    )
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ port: string; path?: string[] }> }
) {
  const { port: portStr, path: pathSegments } = await params
  const port = parseInt(portStr, 10)

  if (isNaN(port) || port < 1 || port > 65535) {
    return NextResponse.json({ error: 'Invalid port number' }, { status: 400 })
  }

  const targetPath = pathSegments ? '/' + pathSegments.join('/') : '/'
  const search = request.nextUrl.search
  const targetUrl = `http://127.0.0.1:${port}${targetPath}${search}`

  try {
    const headers = new Headers(request.headers)
    headers.set('host', `localhost:${port}`)
    headers.delete('x-forwarded-for')
    headers.delete('x-forwarded-host')
    headers.delete('x-forwarded-proto')

    const response = await fetch(targetUrl, {
      method: 'DELETE',
      headers,
      redirect: 'manual',
    })

    const responseHeaders = new Headers(response.headers)
    responseHeaders.delete('content-encoding')

    return new NextResponse(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Proxy request failed'
    return NextResponse.json(
      { error: 'Failed to connect to service', details: message, port, targetPath },
      { status: 502 }
    )
  }
}
