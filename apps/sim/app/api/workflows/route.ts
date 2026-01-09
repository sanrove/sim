import { db, getTenantDatabase, organization } from '@sim/db'
import { workflow, workspace } from '@sim/db/schema'
import { eq } from 'drizzle-orm'
import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSession } from '@/lib/auth'
import { generateRequestId } from '@/lib/core/utils/request'
import { createLogger } from '@/lib/logs/console/logger'
import { getUserEntityPermissions } from '@/lib/workspaces/permissions/utils'
import { verifyWorkspaceMembershipWithDb } from '@/app/api/workflows/utils'

const logger = createLogger('WorkflowAPI')

// Helper to get tenant database from session
async function getTenantDbFromSession(session: any) {
  const orgId = session?.session?.activeOrganizationId
  if (!orgId) return null
  
  const orgRecord = await db.query.organization.findFirst({
    where: eq(organization.id, orgId),
  })
  
  if (!orgRecord?.name?.startsWith('ModelFlow-')) return null
  
  const tenantId = orgRecord.name.replace('ModelFlow-', '')
  return getTenantDatabase(tenantId)
}

const CreateWorkflowSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string().optional().default(''),
  color: z.string().optional().default('#3972F6'),
  workspaceId: z.string().optional(),
  folderId: z.string().nullable().optional(),
})

// GET /api/workflows - Get workflows for user (optionally filtered by workspaceId)
export async function GET(request: Request) {
  const requestId = generateRequestId()
  const startTime = Date.now()
  const url = new URL(request.url)
  const workspaceId = url.searchParams.get('workspaceId')

  try {
    const session = await getSession()
    if (!session?.user?.id) {
      logger.warn(`[${requestId}] Unauthorized workflow access attempt`)
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const userId = session.user.id

    // Get tenant database
    const tenantDb = await getTenantDbFromSession(session)
    if (!tenantDb) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 400 })
    }

    if (workspaceId) {
      const workspaceExists = await tenantDb
        .select({ id: workspace.id })
        .from(workspace)
        .where(eq(workspace.id, workspaceId))
        .then((rows: any[]) => rows.length > 0)

      if (!workspaceExists) {
        logger.warn(
          `[${requestId}] Attempt to fetch workflows for non-existent workspace: ${workspaceId}`
        )
        return NextResponse.json(
          { error: 'Workspace not found', code: 'WORKSPACE_NOT_FOUND' },
          { status: 404 }
        )
      }

      const userRole = await verifyWorkspaceMembershipWithDb(userId, workspaceId, tenantDb)

      if (!userRole) {
        logger.warn(
          `[${requestId}] User ${userId} attempted to access workspace ${workspaceId} without membership`
        )
        return NextResponse.json(
          { error: 'Access denied to this workspace', code: 'WORKSPACE_ACCESS_DENIED' },
          { status: 403 }
        )
      }
    }

    let workflows

    if (workspaceId) {
      workflows = await tenantDb.select().from(workflow).where(eq(workflow.workspaceId, workspaceId))
    } else {
      workflows = await tenantDb.select().from(workflow).where(eq(workflow.userId, userId))
    }

    return NextResponse.json({ data: workflows }, { status: 200 })
  } catch (error: any) {
    const elapsed = Date.now() - startTime
    logger.error(`[${requestId}] Workflow fetch error after ${elapsed}ms`, error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// POST /api/workflows - Create a new workflow
export async function POST(req: NextRequest) {
  const requestId = generateRequestId()
  const session = await getSession()

  if (!session?.user?.id) {
    logger.warn(`[${requestId}] Unauthorized workflow creation attempt`)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    // Get tenant database
    const tenantDb = await getTenantDbFromSession(session)
    if (!tenantDb) {
      logger.error(`[${requestId}] Tenant database not found for user ${session.user.id}`)
      return NextResponse.json({ error: 'Tenant not found' }, { status: 400 })
    }

    const body = await req.json()
    const { name, description, color, workspaceId, folderId } = CreateWorkflowSchema.parse(body)

    if (workspaceId) {
      const workspacePermission = await getUserEntityPermissions(
        session.user.id,
        'workspace',
        workspaceId,
        tenantDb
      )

      if (!workspacePermission || workspacePermission === 'read') {
        logger.warn(
          `[${requestId}] User ${session.user.id} attempted to create workflow in workspace ${workspaceId} without write permissions`
        )
        return NextResponse.json(
          { error: 'Write or Admin access required to create workflows in this workspace' },
          { status: 403 }
        )
      }
    }

    const workflowId = crypto.randomUUID()
    const now = new Date()

    logger.info(`[${requestId}] Creating workflow ${workflowId} for user ${session.user.id}`)

    import('@/lib/core/telemetry')
      .then(({ trackPlatformEvent }) => {
        trackPlatformEvent('platform.workflow.created', {
          'workflow.id': workflowId,
          'workflow.name': name,
          'workflow.has_workspace': !!workspaceId,
          'workflow.has_folder': !!folderId,
        })
      })
      .catch(() => {
        // Silently fail
      })

    // Use tenant database instead of master db
    await tenantDb.insert(workflow).values({
      id: workflowId,
      userId: session.user.id,
      workspaceId: workspaceId || null,
      folderId: folderId || null,
      name,
      description,
      color,
      lastSynced: now,
      createdAt: now,
      updatedAt: now,
      isDeployed: false,
      runCount: 0,
      variables: {},
    })

    logger.info(`[${requestId}] Successfully created empty workflow ${workflowId}`)

    return NextResponse.json({
      id: workflowId,
      name,
      description,
      color,
      workspaceId,
      folderId,
      createdAt: now,
      updatedAt: now,
    })
  } catch (error) {
    if (error instanceof z.ZodError) {
      logger.warn(`[${requestId}] Invalid workflow creation data`, {
        errors: error.errors,
      })
      return NextResponse.json(
        { error: 'Invalid request data', details: error.errors },
        { status: 400 }
      )
    }

    logger.error(`[${requestId}] Error creating workflow`, error)
    return NextResponse.json({ error: 'Failed to create workflow' }, { status: 500 })
  }
}
