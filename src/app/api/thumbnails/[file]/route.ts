import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import { isValidThumbnailFile, thumbnailFilePath } from '@/lib/thumbnail';
import { requireApprovedUser } from '@/lib/auth';

// GET /api/thumbnails/[file] — serve a captured preview JPEG.
//
// Auth rides on the session cookie (same-origin <img> requests carry it), so
// thumbnails stay private to signed-in dashboard users. The URL embeds a
// cache-busting ?v=<capturedAtMs> (see lib/thumbnail.ts), which lets the
// response be immutable-cached forever while still refreshing on re-capture.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ file: string }> }
) {
  const authGuard = await requireApprovedUser(req);
  if (authGuard.error) return authGuard.error;

  const { file } = await params;

  // Strict allowlist — the file segment becomes a filesystem path, so only
  // `<envId>.jpg` shapes (cuid ids) are ever readable.
  if (!isValidThumbnailFile(file)) {
    return NextResponse.json({ error: 'Invalid thumbnail file name' }, { status: 400 });
  }

  try {
    const buf = await fs.readFile(thumbnailFilePath(file));
    return new NextResponse(new Uint8Array(buf), {
      status: 200,
      headers: {
        'Content-Type': 'image/jpeg',
        'Content-Length': String(buf.byteLength),
        // `private` (never CDN-shared) + immutable: re-captures change ?v=.
        'Cache-Control': 'private, max-age=31536000, immutable',
      },
    });
  } catch {
    return NextResponse.json({ error: 'Thumbnail not found' }, { status: 404 });
  }
}
