import { type NextRequest, NextResponse } from 'next/server'
import { PauseResumeManager } from '@/lib/workflows/executor/human-in-the-loop-manager'
import { validateWorkflowAccess } from '@/app/api/workflows/middleware'
import { getTenantDbFromSession } from '@/app/api/workflows/tenant-utils'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  {
    params,
  }: {
    params: Promise<{ id: string; executionId: string }>
  }
) {
  const { id: workflowId, executionId } = await params

  const tenantDb = await getTenantDbFromSession()
  const access = await validateWorkflowAccess(request, workflowId, false, tenantDb)
  if (access.error) {
    return NextResponse.json({ error: access.error.message }, { status: access.error.status })
  }

  const detail = await PauseResumeManager.getPausedExecutionDetail({
    workflowId,
    executionId,
  })

  if (!detail) {
    return NextResponse.json({ error: 'Paused execution not found' }, { status: 404 })
  }

  return NextResponse.json(detail)
}
