import { db, getTenantDatabase, organization, user } from '@sim/db'
import { session } from '@sim/db/schema'
import { desc, eq } from 'drizzle-orm'
import { createLogger } from '@/lib/logs/console/logger'
import { getWorkflowState } from '@/socket-server/database/operations'
import type { AuthenticatedSocket } from '@/socket-server/middleware/auth'
import { verifyWorkflowAccess } from '@/socket-server/middleware/permissions'
import type { RoomManager, UserPresence, WorkflowRoom } from '@/socket-server/rooms/manager'

const logger = createLogger('WorkflowHandlers')

export type { UserPresence, WorkflowRoom }

export interface HandlerDependencies {
  roomManager: RoomManager
}

// Helper to get tenant database from user ID
async function getTenantDbFromUserId(userId: string) {
  try {
    // Get user's active session to find organization
    const [sessionRecord] = await db
      .select()
      .from(session)
      .where(eq(session.userId, userId))
      .orderBy(desc(session.createdAt))
      .limit(1)
    
    if (!sessionRecord?.activeOrganizationId) return null
    
    const orgRecord = await db.query.organization.findFirst({
      where: eq(organization.id, sessionRecord.activeOrganizationId),
    })
    
    if (!orgRecord?.name?.startsWith('ModelFlow-')) return null
    
    const tenantId = orgRecord.name.replace('ModelFlow-', '')
    return getTenantDatabase(tenantId)
  } catch (error) {
    logger.error('Error getting tenant database for workflow handler:', error)
    return null
  }
}

export const createWorkflowRoom = (workflowId: string): WorkflowRoom => ({
  workflowId,
  users: new Map(),
  lastModified: Date.now(),
  activeConnections: 0,
})

export const cleanupUserFromRoom = (
  socketId: string,
  workflowId: string,
  roomManager: RoomManager
) => {
  roomManager.cleanupUserFromRoom(socketId, workflowId)
}

export function setupWorkflowHandlers(
  socket: AuthenticatedSocket,
  deps: HandlerDependencies | RoomManager
) {
  const roomManager =
    deps instanceof Object && 'roomManager' in deps ? deps.roomManager : (deps as RoomManager)
  socket.on('join-workflow', async ({ workflowId }) => {
    try {
      const userId = socket.userId
      const userName = socket.userName

      if (!userId || !userName) {
        logger.warn(`Join workflow rejected: Socket ${socket.id} not authenticated`)
        socket.emit('join-workflow-error', { error: 'Authentication required' })
        return
      }

      logger.info(`Join workflow request from ${userId} (${userName}) for workflow ${workflowId}`)

      // Get tenant database for this user first
      const tenantDb = await getTenantDbFromUserId(userId)

      logger.info(`[Socket] Tenant database resolved for user ${userId}:`, {
        hasTenantDb: !!tenantDb,
        workflowId,
      })

      let userRole: string
      try {
        const accessInfo = await verifyWorkflowAccess(userId, workflowId, tenantDb || undefined)
        if (!accessInfo.hasAccess) {
          logger.warn(`User ${userId} (${userName}) denied access to workflow ${workflowId}`)
          socket.emit('join-workflow-error', { error: 'Access denied to workflow' })
          return
        }
        userRole = accessInfo.role || 'read'
      } catch (error) {
        logger.warn(`Error verifying workflow access for ${userId}:`, error)
        socket.emit('join-workflow-error', { error: 'Failed to verify workflow access' })
        return
      }

      const currentWorkflowId = roomManager.getWorkflowIdForSocket(socket.id)
      if (currentWorkflowId) {
        socket.leave(currentWorkflowId)
        roomManager.cleanupUserFromRoom(socket.id, currentWorkflowId)

        roomManager.broadcastPresenceUpdate(currentWorkflowId)
      }

      socket.join(workflowId)

      if (!roomManager.hasWorkflowRoom(workflowId)) {
        roomManager.setWorkflowRoom(workflowId, roomManager.createWorkflowRoom(workflowId, tenantDb || undefined))
        logger.info(`[Socket] Created new workflow room with tenant database`, {
          workflowId,
          hasTenantDb: !!tenantDb,
        })
      }

      const room = roomManager.getWorkflowRoom(workflowId)!
      room.activeConnections++

      let avatarUrl = socket.userImage || null
      if (!avatarUrl) {
        try {
          const [userRecord] = await db
            .select({ image: user.image })
            .from(user)
            .where(eq(user.id, userId))
            .limit(1)

          avatarUrl = userRecord?.image ?? null
        } catch (error) {
          logger.warn('Failed to load user avatar for presence', { userId, error })
        }
      }

      const userPresence: UserPresence = {
        userId,
        workflowId,
        userName,
        socketId: socket.id,
        joinedAt: Date.now(),
        lastActivity: Date.now(),
        role: userRole,
        avatarUrl,
      }

      room.users.set(socket.id, userPresence)
      roomManager.setWorkflowForSocket(socket.id, workflowId)
      roomManager.setUserSession(socket.id, {
        userId,
        userName,
        avatarUrl,
      })

      const workflowState = await getWorkflowState(workflowId, tenantDb || undefined)
      socket.emit('workflow-state', workflowState)

      roomManager.broadcastPresenceUpdate(workflowId)

      const uniqueUserCount = roomManager.getUniqueUserCount(workflowId)
      logger.info(
        `User ${userId} (${userName}) joined workflow ${workflowId}. Room now has ${uniqueUserCount} unique users (${room.activeConnections} connections).`
      )
    } catch (error) {
      logger.error('Error joining workflow:', error)
      socket.emit('error', {
        type: 'JOIN_ERROR',
        message: 'Failed to join workflow',
      })
    }
  })

  socket.on('leave-workflow', () => {
    const workflowId = roomManager.getWorkflowIdForSocket(socket.id)
    const session = roomManager.getUserSession(socket.id)

    if (workflowId && session) {
      socket.leave(workflowId)
      roomManager.cleanupUserFromRoom(socket.id, workflowId)

      roomManager.broadcastPresenceUpdate(workflowId)

      logger.info(`User ${session.userId} (${session.userName}) left workflow ${workflowId}`)
    }
  })
}
