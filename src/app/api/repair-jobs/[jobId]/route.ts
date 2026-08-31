import { NextRequest, NextResponse } from 'next/server';
import { getRepairJob } from '@/lib/llm-repair';

/**
 * GET /api/repair-jobs/[jobId]
 * Polls the status/progress of an LLM auto-repair job.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  try {
    const { jobId } = await params;
    const job = getRepairJob(jobId);
    if (!job) {
      return NextResponse.json({ error: 'Repair job not found (it may belong to a previous server process)' }, { status: 404 });
    }
    return NextResponse.json(job);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
