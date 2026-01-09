import { randomUUID } from 'crypto'
import { db, getTenantDatabase, organization, member, workspace } from '@sim/db'
import { chat, workflow, workflowDeploymentVersion } from '@sim/db/schema'
import { and, desc, eq } from 'drizzle-orm'
import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { generateRequestId } from '@/lib/core/utils/request'
import { preprocessExecution } from '@/lib/execution/preprocessing'
import { createLogger } from '@/lib/logs/console/logger'
import { LoggingSession } from '@/lib/logs/execution/logging-session'
import { ChatFiles } from '@/lib/uploads'
import {
  addCorsHeaders,
  setChatAuthCookie,
  validateAuthToken,
  validateChatAuth,
} from '@/app/api/chat/utils'
import { createErrorResponse, createSuccessResponse } from '@/app/api/workflows/utils'

const logger = createLogger('ChatIdentifierAPI')

// Helper to find chat deployment across all tenant databases
async function findChatByIdentifier(identifier: string) {
  try {
    // First, get all organizations with ModelFlow prefix
    const orgs = await db.query.organization.findMany({
      where: (org, { like }) => like(org.name, 'ModelFlow-%'),
    })

    logger.debug('findChatByIdentifier: searching across tenants', { 
      identifier, 
      tenantCount: orgs.length 
    })

    // Search each tenant database
    for (const org of orgs) {
      const tenantId = org.name.replace('ModelFlow-', '')
      try {
        const tenantDb = await getTenantDatabase(tenantId)
        const [chatRecord] = await tenantDb
          .select({
            id: chat.id,
            workflowId: chat.workflowId,
            userId: chat.userId,
            isActive: chat.isActive,
            authType: chat.authType,
            password: chat.password,
            allowedEmails: chat.allowedEmails,
            outputConfigs: chat.outputConfigs,
            title: chat.title,
            description: chat.description,
            customizations: chat.customizations,
          })
          .from(chat)
          .where(eq(chat.identifier, identifier))
          .limit(1)

        if (chatRecord) {
          logger.info('findChatByIdentifier: chat found', { 
            identifier, 
            tenantId, 
            chatId: chatRecord.id 
          })
          return { chatRecord, tenantDb, tenantId, organizationId: org.id }
        }
      } catch (error) {
        logger.warn('findChatByIdentifier: error searching tenant', { 
          tenantId, 
          error 
        })
        continue
      }
    }

    logger.warn('findChatByIdentifier: chat not found in any tenant', { identifier })
    return null
  } catch (error) {
    logger.error('findChatByIdentifier: search failed', { error, identifier })
    return null
  }
}

// Helper to get tenant database from user's organization
async function getTenantDbFromUser(userId: string) {
  try {
    // Get user's organization membership
    const [memberRecord] = await db
      .select({ organizationId: member.organizationId })
      .from(member)
      .where(eq(member.userId, userId))
      .limit(1)
    
    logger.debug('getTenantDbFromUser: member query result', { userId, memberRecord })
    
    if (!memberRecord?.organizationId) {
      logger.warn('getTenantDbFromUser: No member record found', { userId })
      return null
    }
    
    const orgRecord = await db.query.organization.findFirst({
      where: eq(organization.id, memberRecord.organizationId),
    })
    
    logger.debug('getTenantDbFromUser: org query result', { organizationId: memberRecord.organizationId, orgRecord })
    
    if (!orgRecord?.name?.startsWith('ModelFlow-')) {
      logger.warn('getTenantDbFromUser: Organization name does not match ModelFlow pattern', { 
        organizationId: memberRecord.organizationId,
        orgName: orgRecord?.name 
      })
      return null
    }
    
    const tenantId = orgRecord.name.replace('ModelFlow-', '')
    logger.info('getTenantDbFromUser: Successfully resolved tenant', { userId, tenantId, organizationId: memberRecord.organizationId })
    return { tenantDb: await getTenantDatabase(tenantId), tenantId, organizationId: memberRecord.organizationId }
  } catch (error) {
    logger.warn('Failed to get tenant database from user', { error, userId })
    return null
  }
}

const chatFileSchema = z.object({
  name: z.string().min(1, 'File name is required'),
  type: z.string().min(1, 'File type is required'),
  size: z.number().positive('File size must be positive'),
  data: z.string().min(1, 'File data is required'),
  lastModified: z.number().optional(),
})

const chatPostBodySchema = z.object({
  input: z.string().optional(),
  password: z.string().optional(),
  email: z.string().email('Invalid email format').optional().or(z.literal('')),
  conversationId: z.string().optional(),
  files: z.array(chatFileSchema).optional().default([]),
})

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ identifier: string }> }
) {
  const { identifier } = await params
  const requestId = generateRequestId()

  try {
    logger.debug(`[${requestId}] Processing chat request for identifier: ${identifier}`)

    let parsedBody
    try {
      const rawBody = await request.json()
      const validation = chatPostBodySchema.safeParse(rawBody)

      if (!validation.success) {
        const errorMessage = validation.error.errors
          .map((err) => `${err.path.join('.')}: ${err.message}`)
          .join(', ')
        logger.warn(`[${requestId}] Validation error: ${errorMessage}`)
        return addCorsHeaders(
          createErrorResponse(`Invalid request body: ${errorMessage}`, 400),
          request
        )
      }

      parsedBody = validation.data
    } catch (_error) {
      return addCorsHeaders(createErrorResponse('Invalid request body', 400), request)
    }

    // Find chat deployment across tenant databases
    const chatResult = await findChatByIdentifier(identifier)
    
    if (!chatResult) {
      logger.warn(`[${requestId}] Chat not found for identifier: ${identifier}`)
      return addCorsHeaders(createErrorResponse('Chat not found', 404), request)
    }

    const { chatRecord: deployment, tenantDb, tenantId, organizationId } = chatResult

    logger.info(`[${requestId}] Chat deployment found in tenant database`, { 
      chatId: deployment.id, 
      workflowId: deployment.workflowId, 
      userId: deployment.userId,
      tenantId,
      organizationId
    })

    // Get workflow to determine workspace
    const [workflowRecord] = await tenantDb
      .select({ workspaceId: workflow.workspaceId })
      .from(workflow)
      .where(eq(workflow.id, deployment.workflowId))
      .limit(1)

    if (!deployment.isActive) {
      logger.warn(`[${requestId}] Chat is not active: ${identifier}`)

      const workspaceId = workflowRecord?.workspaceId
      if (!workspaceId) {
        logger.warn(`[${requestId}] Cannot log: workflow ${deployment.workflowId} has no workspace`)
        return addCorsHeaders(
          createErrorResponse('This chat is currently unavailable', 403),
          request
        )
      }

      const executionId = randomUUID()
      const loggingSession = new LoggingSession(
        deployment.workflowId,
        executionId,
        'chat',
        requestId
      )

      await loggingSession.safeStart({
        userId: deployment.userId,
        workspaceId,
        variables: {},
      })

      await loggingSession.safeCompleteWithError({
        error: {
          message: 'This chat is currently unavailable. The chat has been disabled.',
          stackTrace: undefined,
        },
        traceSpans: [],
      })

      return addCorsHeaders(createErrorResponse('This chat is currently unavailable', 403), request)
    }

    const authResult = await validateChatAuth(requestId, deployment, request, parsedBody)
    if (!authResult.authorized) {
      return addCorsHeaders(
        createErrorResponse(authResult.error || 'Authentication required', 401),
        request
      )
    }

    const { input, password, email, conversationId, files } = parsedBody

    if ((password || email) && !input) {
      const response = addCorsHeaders(createSuccessResponse({ authenticated: true }), request)

      setChatAuthCookie(response, deployment.id, deployment.authType, deployment.password)

      return response
    }

    if (!input && (!files || files.length === 0)) {
      return addCorsHeaders(createErrorResponse('No input provided', 400), request)
    }

    // Check if workflow has active deployment in tenant database
    // Auto-deploy if needed to handle multi-tenant scenarios
    try {
      const [activeDeployment] = await tenantDb
        .select({ id: workflowDeploymentVersion.id })
        .from(workflowDeploymentVersion)
        .where(
          and(
            eq(workflowDeploymentVersion.workflowId, deployment.workflowId),
            eq(workflowDeploymentVersion.isActive, true)
          )
        )
        .limit(1)

      if (!activeDeployment) {
        logger.warn(
          `[${requestId}] No active deployment found for workflow ${deployment.workflowId}, auto-deploying`
        )

        const { deployWorkflow } = await import('@/lib/workflows/persistence/utils')
        const deployResult = await deployWorkflow({
          workflowId: deployment.workflowId,
          deployedBy: deployment.userId,
          tenantDb,
        })

        if (!deployResult.success) {
          logger.error(`[${requestId}] Failed to auto-deploy workflow: ${deployResult.error}`)
          return addCorsHeaders(
            createErrorResponse(
              'Workflow is not deployed. Please deploy the workflow first.',
              403
            ),
            request
          )
        }

        logger.info(
          `[${requestId}] Auto-deployed workflow ${deployment.workflowId} successfully (v${deployResult.version})`
        )
      }
    } catch (deployError: any) {
      logger.error(`[${requestId}] Error checking/deploying workflow:`, deployError)
      return addCorsHeaders(
        createErrorResponse('Failed to verify workflow deployment status', 500),
        request
      )
    }

    const executionId = randomUUID()

    const loggingSession = new LoggingSession(deployment.workflowId, executionId, 'chat', requestId)

    const preprocessResult = await preprocessExecution({
      workflowId: deployment.workflowId,
      userId: deployment.userId,
      triggerType: 'chat',
      executionId,
      requestId,
      checkRateLimit: true,
      checkDeployment: true,
      loggingSession,
      tenantId,
      organizationId,
    })

    if (!preprocessResult.success) {
      logger.warn(`[${requestId}] Preprocessing failed: ${preprocessResult.error?.message}`)
      return addCorsHeaders(
        createErrorResponse(
          preprocessResult.error?.message || 'Failed to process request',
          preprocessResult.error?.statusCode || 500
        ),
        request
      )
    }

    const { actorUserId, workflowRecord: preprocessWorkflow } = preprocessResult
    const workspaceOwnerId = actorUserId!
    const workspaceId = preprocessWorkflow?.workspaceId || workflowRecord?.workspaceId
    if (!workspaceId) {
      logger.error(`[${requestId}] Workflow ${deployment.workflowId} has no workspaceId`)
      return addCorsHeaders(
        createErrorResponse('Workflow has no associated workspace', 500),
        request
      )
    }

    try {
      const selectedOutputs: string[] = []
      if (deployment.outputConfigs && Array.isArray(deployment.outputConfigs)) {
        for (const config of deployment.outputConfigs) {
          const outputId = config.path
            ? `${config.blockId}_${config.path}`
            : `${config.blockId}_content`
          selectedOutputs.push(outputId)
        }
      }

      const { createStreamingResponse } = await import('@/lib/workflows/streaming/streaming')
      const { SSE_HEADERS } = await import('@/lib/core/utils/sse')

      const workflowInput: any = { input, conversationId }
      if (files && Array.isArray(files) && files.length > 0) {
        const executionContext = {
          workspaceId,
          workflowId: deployment.workflowId,
          executionId,
        }

        try {
          const uploadedFiles = await ChatFiles.processChatFiles(
            files,
            executionContext,
            requestId,
            deployment.userId
          )

          if (uploadedFiles.length > 0) {
            workflowInput.files = uploadedFiles
            logger.info(`[${requestId}] Successfully processed ${uploadedFiles.length} files`)
          }
        } catch (fileError: any) {
          logger.error(`[${requestId}] Failed to process chat files:`, fileError)

          await loggingSession.safeStart({
            userId: workspaceOwnerId,
            workspaceId,
            variables: {},
          })

          await loggingSession.safeCompleteWithError({
            error: {
              message: `File upload failed: ${fileError.message || 'Unable to process uploaded files'}`,
              stackTrace: fileError.stack,
            },
            traceSpans: [],
          })

          throw fileError
        }
      }

      const workflowForExecution = {
        id: deployment.workflowId,
        userId: deployment.userId,
        workspaceId,
        isDeployed: preprocessWorkflow?.isDeployed ?? false,
        variables: preprocessWorkflow?.variables || {},
      }

      const stream = await createStreamingResponse({
        requestId,
        workflow: workflowForExecution,
        input: workflowInput,
        executingUserId: workspaceOwnerId,
        streamConfig: {
          selectedOutputs,
          isSecureMode: true,
          workflowTriggerType: 'chat',
        },
        executionId,
        tenantDb,
      })

      const streamResponse = new NextResponse(stream, {
        status: 200,
        headers: SSE_HEADERS,
      })
      return addCorsHeaders(streamResponse, request)
    } catch (error: any) {
      logger.error(`[${requestId}] Error processing chat request:`, error)
      return addCorsHeaders(
        createErrorResponse(error.message || 'Failed to process request', 500),
        request
      )
    }
  } catch (error: any) {
    logger.error(`[${requestId}] Error processing chat request:`, error)
    return addCorsHeaders(
      createErrorResponse(error.message || 'Failed to process request', 500),
      request
    )
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ identifier: string }> }
) {
  const { identifier } = await params
  const requestId = generateRequestId()

  try {
    logger.debug(`[${requestId}] Fetching chat info for identifier: ${identifier}`)

    // Find chat deployment across tenant databases
    const chatResult = await findChatByIdentifier(identifier)
    
    if (!chatResult) {
      logger.warn(`[${requestId}] Chat not found for identifier: ${identifier}`)
      return addCorsHeaders(createErrorResponse('Chat not found', 404), request)
    }

    const { chatRecord: deployment } = chatResult

    if (!deployment.isActive) {
      logger.warn(`[${requestId}] Chat is not active: ${identifier}`)
      return addCorsHeaders(createErrorResponse('This chat is currently unavailable', 403), request)
    }

    const cookieName = `chat_auth_${deployment.id}`
    const authCookie = request.cookies.get(cookieName)

    if (
      deployment.authType !== 'public' &&
      authCookie &&
      validateAuthToken(authCookie.value, deployment.id, deployment.password)
    ) {
      return addCorsHeaders(
        createSuccessResponse({
          id: deployment.id,
          title: deployment.title,
          description: deployment.description,
          customizations: deployment.customizations,
          authType: deployment.authType,
          outputConfigs: deployment.outputConfigs,
        }),
        request
      )
    }

    const authResult = await validateChatAuth(requestId, deployment, request)
    if (!authResult.authorized) {
      logger.info(
        `[${requestId}] Authentication required for chat: ${identifier}, type: ${deployment.authType}`
      )
      return addCorsHeaders(
        createErrorResponse(authResult.error || 'Authentication required', 401),
        request
      )
    }

    return addCorsHeaders(
      createSuccessResponse({
        id: deployment.id,
        title: deployment.title,
        description: deployment.description,
        customizations: deployment.customizations,
        authType: deployment.authType,
        outputConfigs: deployment.outputConfigs,
      }),
      request
    )
  } catch (error: any) {
    logger.error(`[${requestId}] Error fetching chat info:`, error)
    return addCorsHeaders(
      createErrorResponse(error.message || 'Failed to fetch chat information', 500),
      request
    )
  }
}
