import { db, getTenantDatabase, organization, workflowDeploymentVersion } from '@sim/db'
import { and, eq } from 'drizzle-orm'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { getSession } from '@/lib/auth'
import { generateRequestId } from '@/lib/core/utils/request'
import { createLogger } from '@/lib/logs/console/logger'
import { validateWorkflowPermissions } from '@/lib/workflows/utils'
import { createErrorResponse, createSuccessResponse } from '@/app/api/workflows/utils'

const logger = createLogger('WorkflowDeploymentVersionAPI')

// Helper to get tenant database from session
async function getTenantDbFromSession() {
  const session = await getSession()
  const orgId = (session as any)?.session?.activeOrganizationId
  if (!orgId) return null
  
  const orgRecord = await db.query.organization.findFirst({
    where: eq(organization.id, orgId),
  })
  
  if (!orgRecord?.name?.startsWith('ModelFlow-')) return null
  
  const tenantId = orgRecord.name.replace('ModelFlow-', '')
  return getTenantDatabase(tenantId)
}

const patchBodySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name cannot be empty')
    .max(100, 'Name must be 100 characters or less'),
})

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; version: string }> }
) {
  const requestId = generateRequestId()
  const { id, version } = await params

  try {
    // Get tenant database
    const tenantDb = await getTenantDbFromSession()
    const database = tenantDb || db

    const { error } = await validateWorkflowPermissions(id, requestId, 'read', tenantDb)
    if (error) {
      return createErrorResponse(error.message, error.status)
    }

    const versionNum = Number(version)
    if (!Number.isFinite(versionNum)) {
      return createErrorResponse('Invalid version', 400)
    }

    const [row] = await database
      .select({ state: workflowDeploymentVersion.state })
      .from(workflowDeploymentVersion)
      .where(
        and(
          eq(workflowDeploymentVersion.workflowId, id),
          eq(workflowDeploymentVersion.version, versionNum)
        )
      )
      .limit(1)

    if (!row?.state) {
      return createErrorResponse('Deployment version not found', 404)
    }

    return createSuccessResponse({ deployedState: row.state })
  } catch (error: any) {
    logger.error(
      `[${requestId}] Error fetching deployment version ${version} for workflow ${id}`,
      error
    )
    return createErrorResponse(error.message || 'Failed to fetch deployment version', 500)
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; version: string }> }
) {
  const requestId = generateRequestId()
  const { id, version } = await params

  try {
    // Get tenant database
    const tenantDb = await getTenantDbFromSession()
    const database = tenantDb || db

    const { error } = await validateWorkflowPermissions(id, requestId, 'write', tenantDb)
    if (error) {
      return createErrorResponse(error.message, error.status)
    }

    const versionNum = Number(version)
    if (!Number.isFinite(versionNum)) {
      return createErrorResponse('Invalid version', 400)
    }

    const body = await request.json()
    const validation = patchBodySchema.safeParse(body)

    if (!validation.success) {
      return createErrorResponse(validation.error.errors[0]?.message || 'Invalid request body', 400)
    }

    const { name } = validation.data

    const [updated] = await database
      .update(workflowDeploymentVersion)
      .set({ name })
      .where(
        and(
          eq(workflowDeploymentVersion.workflowId, id),
          eq(workflowDeploymentVersion.version, versionNum)
        )
      )
      .returning({ id: workflowDeploymentVersion.id, name: workflowDeploymentVersion.name })

    if (!updated) {
      return createErrorResponse('Deployment version not found', 404)
    }

    logger.info(
      `[${requestId}] Renamed deployment version ${version} for workflow ${id} to "${name}"`
    )

    return createSuccessResponse({ name: updated.name })
  } catch (error: any) {
    logger.error(
      `[${requestId}] Error renaming deployment version ${version} for workflow ${id}`,
      error
    )
    return createErrorResponse(error.message || 'Failed to rename deployment version', 500)
  }
}
