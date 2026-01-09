import { db, getTenantDatabase, organization, user, workflowDeploymentVersion } from '@sim/db'
import { desc, eq } from 'drizzle-orm'
import type { NextRequest } from 'next/server'
import { getSession } from '@/lib/auth'
import { generateRequestId } from '@/lib/core/utils/request'
import { createLogger } from '@/lib/logs/console/logger'
import { validateWorkflowPermissions } from '@/lib/workflows/utils'
import { createErrorResponse, createSuccessResponse } from '@/app/api/workflows/utils'

const logger = createLogger('WorkflowDeploymentsListAPI')

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

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = generateRequestId()
  const { id } = await params

  try {
    // Get tenant database
    const tenantDb = await getTenantDbFromSession()
    const database = tenantDb || db

    const { error } = await validateWorkflowPermissions(id, requestId, 'read', tenantDb)
    if (error) {
      return createErrorResponse(error.message, error.status)
    }

    const versions = await database
      .select({
        id: workflowDeploymentVersion.id,
        version: workflowDeploymentVersion.version,
        name: workflowDeploymentVersion.name,
        isActive: workflowDeploymentVersion.isActive,
        createdAt: workflowDeploymentVersion.createdAt,
        createdBy: workflowDeploymentVersion.createdBy,
        deployedBy: user.name,
      })
      .from(workflowDeploymentVersion)
      .leftJoin(user, eq(workflowDeploymentVersion.createdBy, user.id))
      .where(eq(workflowDeploymentVersion.workflowId, id))
      .orderBy(desc(workflowDeploymentVersion.version))

    return createSuccessResponse({ versions })
  } catch (error: any) {
    logger.error(`[${requestId}] Error listing deployments for workflow: ${id}`, error)
    return createErrorResponse(error.message || 'Failed to list deployments', 500)
  }
}
