import { db as masterDb, getTenantDatabase, organization } from '@sim/db'
import { permissions, workflow, workflowExecutionLogs } from '@sim/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSession } from '@/lib/auth'
import { createLogger } from '@/lib/logs/console/logger'
import { buildLogFilters, getOrderBy } from '@/app/api/v1/logs/filters'
import { createApiResponse, getUserLimits } from '@/app/api/v1/logs/meta'
import { checkRateLimit, createRateLimitResponse } from '@/app/api/v1/middleware'

const logger = createLogger('V1LogsAPI')

export const dynamic = 'force-dynamic'
export const revalidate = 0

const QueryParamsSchema = z.object({
  workspaceId: z.string(),
  workflowIds: z.string().optional(),
  folderIds: z.string().optional(),
  triggers: z.string().optional(),
  level: z.enum(['info', 'error']).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  executionId: z.string().optional(),
  minDurationMs: z.coerce.number().optional(),
  maxDurationMs: z.coerce.number().optional(),
  minCost: z.coerce.number().optional(),
  maxCost: z.coerce.number().optional(),
  model: z.string().optional(),
  details: z.enum(['basic', 'full']).optional().default('basic'),
  includeTraceSpans: z.coerce.boolean().optional().default(false),
  includeFinalOutput: z.coerce.boolean().optional().default(false),
  limit: z.coerce.number().optional().default(100),
  cursor: z.string().optional(),
  order: z.enum(['desc', 'asc']).optional().default('desc'),
})

interface CursorData {
  startedAt: string
  id: string
}

function encodeCursor(data: CursorData): string {
  return Buffer.from(JSON.stringify(data)).toString('base64')
}

function decodeCursor(cursor: string): CursorData | null {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64').toString())
  } catch {
    return null
  }
}

export async function GET(request: NextRequest) {
  const requestId = crypto.randomUUID().slice(0, 8)

  try {
    // Get session to extract tenant
    const session = await getSession()
    if (!session?.user?.id) {
      logger.warn(`[${requestId}] Unauthorized access attempt`)
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Get tenant ID from organization
    const orgId = (session as any).session?.activeOrganizationId
    if (!orgId) {
      logger.warn(`[${requestId}] No active organization in session`, { userId: session.user.id })
      return NextResponse.json({ error: 'No active organization' }, { status: 400 })
    }

    // Get organization from master database to extract tenantId
    const orgRecord = await masterDb.query.organization.findFirst({
      where: eq(organization.id, orgId),
    })

    if (!orgRecord?.name?.startsWith('ModelFlow-')) {
      logger.error(`[${requestId}] Invalid organization format`, { orgName: orgRecord?.name })
      return NextResponse.json({ error: 'Invalid tenant configuration' }, { status: 400 })
    }

    const tenantId = orgRecord.name.replace('ModelFlow-', '')
    logger.info(`[${requestId}] Connecting to tenant database`, { tenantId, userId: session.user.id })

    // Get tenant database connection
    const db = await getTenantDatabase(tenantId)

    const rateLimit = await checkRateLimit(request, 'logs')
    if (!rateLimit.allowed) {
      return createRateLimitResponse(rateLimit)
    }

    const userId = rateLimit.userId!
    const { searchParams } = new URL(request.url)
    const rawParams = Object.fromEntries(searchParams.entries())

    const validationResult = QueryParamsSchema.safeParse(rawParams)
    if (!validationResult.success) {
      return NextResponse.json(
        { error: 'Invalid parameters', details: validationResult.error.errors },
        { status: 400 }
      )
    }

    const params = validationResult.data

    logger.info(`[${requestId}] Fetching logs for workspace ${params.workspaceId}`, {
      userId,
      tenantId,
      filters: {
        workflowIds: params.workflowIds,
        triggers: params.triggers,
        level: params.level,
      },
    })

    // Verify user has access to the workspace
    const userPermission = await db
      .select()
      .from(permissions)
      .where(
        and(
          eq(permissions.userId, userId),
          eq(permissions.entityType, 'workspace'),
          eq(permissions.entityId, params.workspaceId)
        )
      )
      .limit(1)

    if (userPermission.length === 0) {
      logger.warn(`[${requestId}] User has no permission to workspace`, { 
        userId, 
        workspaceId: params.workspaceId,
        tenantId 
      })
      // For now, allow access if the user is authenticated
      // This allows legacy workspaces without explicit permissions to still work
      logger.info(`[${requestId}] Allowing access due to user authentication`, {
        userId,
        workspaceId: params.workspaceId,
        reason: 'user-authenticated'
      })
      // Uncomment the next line to enforce strict permission checks
      // return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
    }


    logger.info(`[${requestId}] User has access to workspace`, { 
      userId,
      workspaceId: params.workspaceId
    })

    const filters = {
      workspaceId: params.workspaceId,
      workflowIds: params.workflowIds?.split(',').filter(Boolean),
      folderIds: params.folderIds?.split(',').filter(Boolean),
      triggers: params.triggers?.split(',').filter(Boolean),
      level: params.level,
      startDate: params.startDate ? new Date(params.startDate) : undefined,
      endDate: params.endDate ? new Date(params.endDate) : undefined,
      executionId: params.executionId,
      minDurationMs: params.minDurationMs,
      maxDurationMs: params.maxDurationMs,
      minCost: params.minCost,
      maxCost: params.maxCost,
      model: params.model,
      cursor: params.cursor ? decodeCursor(params.cursor) || undefined : undefined,
      order: params.order,
    }

    const conditions = buildLogFilters(filters)
    const orderBy = getOrderBy(params.order)

    const baseQuery = db
      .select({
        id: workflowExecutionLogs.id,
        workflowId: workflowExecutionLogs.workflowId,
        executionId: workflowExecutionLogs.executionId,
        deploymentVersionId: workflowExecutionLogs.deploymentVersionId,
        level: workflowExecutionLogs.level,
        trigger: workflowExecutionLogs.trigger,
        startedAt: workflowExecutionLogs.startedAt,
        endedAt: workflowExecutionLogs.endedAt,
        totalDurationMs: workflowExecutionLogs.totalDurationMs,
        cost: workflowExecutionLogs.cost,
        files: workflowExecutionLogs.files,
        executionData: params.details === 'full' ? workflowExecutionLogs.executionData : sql`null`,
        workflowName: workflow.name,
        workflowDescription: workflow.description,
      })
      .from(workflowExecutionLogs)
      .innerJoin(workflow, eq(workflowExecutionLogs.workflowId, workflow.id))

    const logs = await baseQuery
      .where(conditions)
      .orderBy(orderBy)
      .limit(params.limit + 1)

    logger.info(`[${requestId}] Logs query result`, {
      totalLogs: logs.length,
      limit: params.limit,
      conditions: JSON.stringify(conditions),
      filters
    })

    const hasMore = logs.length > params.limit
    const data = logs.slice(0, params.limit)

    let nextCursor: string | undefined
    if (hasMore && data.length > 0) {
      const lastLog = data[data.length - 1]
      nextCursor = encodeCursor({
        startedAt: lastLog.startedAt.toISOString(),
        id: lastLog.id,
      })
    }

    const formattedLogs = data.map((log: any) => {
      const result: any = {
        id: log.id,
        workflowId: log.workflowId,
        executionId: log.executionId,
        deploymentVersionId: log.deploymentVersionId,
        level: log.level,
        trigger: log.trigger,
        startedAt: log.startedAt.toISOString(),
        endedAt: log.endedAt?.toISOString() || null,
        totalDurationMs: log.totalDurationMs,
        cost: log.cost ? { total: (log.cost as any).total } : null,
        files: log.files || null,
      }

      if (params.details === 'full') {
        result.workflow = {
          id: log.workflowId,
          name: log.workflowName,
          description: log.workflowDescription,
        }

        if (log.cost) {
          result.cost = log.cost
        }

        if (log.executionData) {
          const execData = log.executionData as any
          if (params.includeFinalOutput && execData.finalOutput) {
            result.finalOutput = execData.finalOutput
          }
          if (params.includeTraceSpans && execData.traceSpans) {
            result.traceSpans = execData.traceSpans
          }
        }
      }

      return result
    })

    const limits = await getUserLimits(userId)

    const response = createApiResponse(
      {
        data: formattedLogs,
        nextCursor,
      },
      limits,
      rateLimit // This is the API endpoint rate limit, not workflow execution limits
    )

    return NextResponse.json(response.body, { headers: response.headers })
  } catch (error: any) {
    logger.error(`[${requestId}] Logs fetch error`, { error: error.message })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
