import { db, getTenantDatabase, organization } from '@sim/db'
import { chat, workflowExecutionLogs } from '@sim/db/schema'
import { and, desc, eq, sql } from 'drizzle-orm'
import { type NextRequest, NextResponse } from 'next/server'
import { createLogger } from '@/lib/logs/console/logger'
import { addCorsHeaders } from '@/app/api/chat/utils'
import { createErrorResponse, createSuccessResponse } from '@/app/api/workflows/utils'

const logger = createLogger('ChatHistoryAPI')

// Helper to find chat deployment across all tenant databases
async function findChatByIdentifier(identifier: string) {
  try {
    // First, get all organizations with ModelFlow prefix
    const orgs = await db.query.organization.findMany({
      where: (org, { like }) => like(org.name, 'ModelFlow-%'),
    })

    logger.debug('findChatByIdentifier: searching across tenants', {
      identifier,
      tenantCount: orgs.length,
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
            isActive: chat.isActive,
            outputConfigs: chat.outputConfigs,
          })
          .from(chat)
          .where(eq(chat.identifier, identifier))
          .limit(1)

        if (chatRecord) {
          logger.info('findChatByIdentifier: chat found', {
            identifier,
            tenantId,
            chatId: chatRecord.id,
          })
          return { chatRecord, tenantDb, tenantId }
        }
      } catch (error) {
        logger.warn('findChatByIdentifier: error searching tenant', {
          tenantId,
          error,
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

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ identifier: string }> }
) {
  const { identifier } = await params
  const { searchParams } = new URL(request.url)
  const conversationId = searchParams.get('conversationId')

  if (!conversationId) {
    return addCorsHeaders(createErrorResponse('conversationId is required', 400), request)
  }

  try {
    logger.debug('Fetching chat history', { identifier, conversationId })

    // Find chat deployment across tenant databases
    const chatResult = await findChatByIdentifier(identifier)

    if (!chatResult) {
      logger.warn('Chat not found for identifier', { identifier })
      return addCorsHeaders(createErrorResponse('Chat not found', 404), request)
    }

    const { chatRecord, tenantDb } = chatResult

    if (!chatRecord.isActive) {
      logger.warn('Chat is not active', { identifier })
      return addCorsHeaders(
        createErrorResponse('This chat is currently unavailable', 403),
        request
      )
    }

    // Query execution logs for this workflow and conversationId
    // Filter by conversationId stored in executionData
    const historyLogs = await tenantDb
      .select({
        executionId: workflowExecutionLogs.executionId,
        executionData: workflowExecutionLogs.executionData,
        startedAt: workflowExecutionLogs.startedAt,
        status: workflowExecutionLogs.status,
      })
      .from(workflowExecutionLogs)
      .where(
        and(
          eq(workflowExecutionLogs.workflowId, chatRecord.workflowId),
          eq(workflowExecutionLogs.trigger, 'chat'),
          // Use jsonb operator to filter by conversationId
          sql`${workflowExecutionLogs.executionData}->>'conversationId' = ${conversationId}`
        )
      )
      .orderBy(workflowExecutionLogs.startedAt)
      .limit(100) // Limit to last 100 messages

    // Helper function to extract content from complex outputs (same logic as streaming)
    const extractOutputContent = (finalOutput: any, outputConfigs?: any[]): string => {
      if (!finalOutput) return ''
      
      // If it's already a simple string, return it
      if (typeof finalOutput === 'string') {
        return finalOutput
      }

      // Debug log the structure
      logger.debug('Extracting output content', { 
        finalOutputKeys: Object.keys(finalOutput),
        outputConfigs,
        hasOutputConfigs: !!outputConfigs
      })

      // If there are outputConfigs, use them to extract the right content
      if (outputConfigs && outputConfigs.length > 0 && typeof finalOutput === 'object') {
        for (const config of outputConfigs) {
          const blockId = config.blockId
          
          // Check if finalOutput is wrapped with blockId or is direct output
          const blockOutputs = finalOutput[blockId] || finalOutput
          
          logger.debug('Checking block output', { 
            blockId, 
            hasBlockOutputs: !!blockOutputs,
            blockOutputsKeys: blockOutputs && typeof blockOutputs === 'object' ? Object.keys(blockOutputs) : [],
            isWrapped: !!finalOutput[blockId]
          })
          
          if (!blockOutputs || typeof blockOutputs !== 'object') continue

          // Try to get the configured path
          let value
          const path = config.path
          
          if (!path || path === 'content') {
            value = blockOutputs.content ?? blockOutputs.result ?? blockOutputs.output ?? blockOutputs
          } else if (blockOutputs[path] !== undefined) {
            value = blockOutputs[path]
          } else if (path.includes('.')) {
            // Handle nested paths
            value = path.split('.').reduce((current: any, segment: string) => {
              return current && typeof current === 'object' && segment in current 
                ? current[segment] 
                : undefined
            }, blockOutputs)
          } else {
            // Try blockOutputs.content, blockOutputs.result as fallback
            value = blockOutputs.content ?? blockOutputs.result ?? blockOutputs.output
          }

          logger.debug('Extracted value', { 
            blockId, 
            path, 
            valueType: typeof value,
            isArray: Array.isArray(value),
            hasContent: !!value
          })

          // If we found a string value, return it
          if (typeof value === 'string') {
            return value
          }
          
          // If value is an array (like search results), format it nicely
          if (Array.isArray(value)) {
            // Format search results into readable text
            if (value.length > 0 && value[0].title && value[0].snippet) {
              return value.map((item: any, idx: number) => 
                `${idx + 1}. **${item.title}**\n${item.snippet}\n[${item.link || item.url}](${item.link || item.url})`
              ).join('\n\n')
            }
            // Other arrays - just stringify
            return JSON.stringify(value, null, 2)
          }
          
          // If value is an object with content property
          if (value && typeof value === 'object') {
            if (value.content && typeof value.content === 'string') {
              return value.content
            }
            if (value.output && typeof value.output === 'string') {
              return value.output
            }
            if (value.result && typeof value.result === 'string') {
              return value.result
            }
            // If object has text property
            if (value.text && typeof value.text === 'string') {
              return value.text
            }
          }
        }
      }

      // Fallback: try common properties on the root level or first block
      const firstKey = Object.keys(finalOutput)[0]
      if (firstKey && typeof finalOutput[firstKey] === 'object') {
        const firstBlock = finalOutput[firstKey]
        if (firstBlock.content && typeof firstBlock.content === 'string') {
          return firstBlock.content
        }
        if (firstBlock.result && typeof firstBlock.result === 'string') {
          return firstBlock.result
        }
        if (firstBlock.output && typeof firstBlock.output === 'string') {
          return firstBlock.output
        }
      }

      // Try root level properties
      if (finalOutput.content) {
        return typeof finalOutput.content === 'string' ? finalOutput.content : JSON.stringify(finalOutput.content)
      }
      if (finalOutput.output) {
        return typeof finalOutput.output === 'string' ? finalOutput.output : JSON.stringify(finalOutput.output)
      }
      if (finalOutput.result) {
        return typeof finalOutput.result === 'string' ? finalOutput.result : JSON.stringify(finalOutput.result)
      }

      // Last resort: stringify the whole thing
      logger.warn('Could not extract clean content, returning JSON', { 
        finalOutputKeys: Object.keys(finalOutput) 
      })
      return JSON.stringify(finalOutput)
    }

    // Transform execution logs into chat messages
    const messages = historyLogs
      .filter((log: { executionData: any }) => {
        // Filter out logs that don't have proper input/output
        const data = log.executionData as any
        return data?.workflowInput?.input || data?.finalOutput
      })
      .flatMap((log: { executionId: string; executionData: any; startedAt: Date }) => {
        const data = log.executionData as any
        const msgs = []

        // Add user message if input exists
        if (data.workflowInput?.input) {
          msgs.push({
            id: `${log.executionId}-user`,
            content: data.workflowInput.input,
            type: 'user',
            timestamp: log.startedAt,
            // Include file information if present
            ...(data.workflowInput.files && {
              attachments: data.workflowInput.files.map((file: any) => ({
                id: file.id || file.name,
                name: file.name,
                type: file.type,
                size: file.size,
              })),
            }),
          })
        }

        // Add assistant message if output exists
        if (data.finalOutput) {
          // Log the structure for debugging
          logger.debug('Processing assistant message', {
            executionId: log.executionId,
            finalOutputType: typeof data.finalOutput,
            finalOutputKeys: typeof data.finalOutput === 'object' ? Object.keys(data.finalOutput) : [],
            outputConfigs: chatRecord.outputConfigs
          })
          
          // Use the extraction helper with chat's outputConfigs
          const outputContent = extractOutputContent(data.finalOutput, chatRecord.outputConfigs as any[])

          logger.debug('Extracted content', {
            executionId: log.executionId,
            contentLength: outputContent.length,
            contentPreview: outputContent.substring(0, 100)
          })

          msgs.push({
            id: `${log.executionId}-assistant`,
            content: outputContent,
            type: 'assistant',
            timestamp: log.startedAt,
          })
        }

        return msgs
      })

    logger.info('Chat history fetched successfully', {
      identifier,
      conversationId,
      messageCount: messages.length,
    })

    return addCorsHeaders(
      createSuccessResponse({
        conversationId,
        messages,
      }),
      request
    )
  } catch (error: any) {
    logger.error('Error fetching chat history', { error, identifier, conversationId })
    return addCorsHeaders(
      createErrorResponse(error.message || 'Failed to fetch chat history', 500),
      request
    )
  }
}
