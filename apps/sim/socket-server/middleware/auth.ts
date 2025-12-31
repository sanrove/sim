import type { Socket } from 'socket.io'
import { db, getTenantDatabase, organization } from '@sim/db'
import { session, user, verification } from '@sim/db/schema'
import { desc, eq } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { ANONYMOUS_USER, ANONYMOUS_USER_ID } from '@/lib/auth/constants'
import { isAuthDisabled } from '@/lib/core/config/feature-flags'
import { createLogger } from '@/lib/logs/console/logger'

const logger = createLogger('SocketAuth')

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
    logger.error('Error getting tenant database for socket auth:', error)
    return null
  }
}

/**
 * Authenticated socket with user data attached.
 */
export interface AuthenticatedSocket extends Socket {
  userId?: string
  userName?: string
  userEmail?: string
  activeOrganizationId?: string
  userImage?: string | null
}

/**
 * Socket.IO authentication middleware.
 * Handles both anonymous mode (DISABLE_AUTH=true) and normal token-based auth.
 */
export async function authenticateSocket(socket: AuthenticatedSocket, next: any) {
  try {
    if (isAuthDisabled) {
      socket.userId = ANONYMOUS_USER_ID
      socket.userName = ANONYMOUS_USER.name
      socket.userEmail = ANONYMOUS_USER.email
      socket.userImage = ANONYMOUS_USER.image
      logger.debug(`Socket ${socket.id} authenticated as anonymous`)
      return next()
    }

    // Extract authentication data from socket handshake
    const token = socket.handshake.auth?.token
    const origin = socket.handshake.headers.origin
    const referer = socket.handshake.headers.referer

    logger.info(`Socket ${socket.id} authentication attempt:`, {
      hasToken: !!token,
      origin,
      referer,
    })

    if (!token) {
      logger.warn(`Socket ${socket.id} rejected: No authentication token found`)
      return next(new Error('Authentication required'))
    }

    // Validate one-time token
    try {
      logger.info(`Attempting token validation for socket ${socket.id}`, {
        tokenLength: token?.length || 0,
        tokenPrefix: token?.substring(0, 8),
        origin,
      })

      // We need to find which tenant database contains this token
      // The token identifier contains userId:tenantId format
      let userId: string | null = null
      let tenantDb: any = null
      let tokenRecord: any = null

      // Strategy: Get all ModelFlow organizations and check their databases
      const allOrgs = await db.query.organization.findMany({
        limit: 100,
      })

      const tenantsToCheck = new Set<string>()
      for (const org of allOrgs) {
        if (org.name?.startsWith('ModelFlow-')) {
          const tenantId = org.name.replace('ModelFlow-', '')
          tenantsToCheck.add(tenantId)
        }
      }

      logger.info(`Checking ${tenantsToCheck.size} tenant databases for token`)

      // Try each tenant database
      for (const tenantId of tenantsToCheck) {
        try {
          const testTenantDb = await getTenantDatabase(tenantId)
          const testTokenRecords = await testTenantDb
            .select()
            .from(verification)
            .where(eq(verification.value, token))
            .limit(1)

          if (testTokenRecords.length > 0) {
            tokenRecord = testTokenRecords[0]
            // Extract userId from identifier (format: userId:tenantId)
            const identifierParts = tokenRecord.identifier.split(':')
            userId = identifierParts[0]
            tenantDb = testTenantDb
            logger.info(`Found token in tenant database: ${tenantId}`, {
              identifier: tokenRecord.identifier,
              userId: userId,
            })
            break
          }
        } catch (error) {
          logger.debug(`Error checking tenant ${tenantId}:`, error)
          continue
        }
      }

      logger.info(`Token lookup result for socket ${socket.id}`, {
        found: !!tokenRecord,
        userId: userId,
        tenantsChecked: tenantsToCheck.size,
      })

      if (!tokenRecord || !userId || !tenantDb) {
        logger.warn(`Socket ${socket.id} rejected: Invalid token - not found in any tenant database`)
        return next(new Error('Invalid token'))
      }

      // Check if token has expired
      if (tokenRecord.expiresAt < new Date()) {
        logger.warn(`Socket ${socket.id} rejected: Token has expired`)
        // Clean up expired token from tenant db
        await tenantDb.delete(verification).where(eq(verification.id, tokenRecord.id))
        return next(new Error('Token expired'))
      }

      // Fetch user details from MASTER database (users are not in tenant db)
      const [userRecord] = await db
        .select()
        .from(user)
        .where(eq(user.id, userId))
        .limit(1)

      if (!userRecord) {
        logger.warn(`Socket ${socket.id} rejected: User not found for token`)
        return next(new Error('User not found'))
      }

      // Fetch active session to get organization info from MASTER database
      const [sessionRecord] = await db
        .select()
        .from(session)
        .where(eq(session.userId, userId))
        .orderBy(desc(session.createdAt))
        .limit(1)

      // Store user info in socket for later use
      socket.userId = userRecord.id
      socket.userName = userRecord.name || userRecord.email || 'Unknown User'
      socket.userEmail = userRecord.email
      socket.userImage = userRecord.image || null
      socket.activeOrganizationId = sessionRecord?.activeOrganizationId || undefined

      // Delete the one-time token after successful use from tenant database
      await tenantDb.delete(verification).where(eq(verification.id, tokenRecord.id))

      logger.info(`Socket ${socket.id} authenticated successfully`, {
        userId: userRecord.id,
        userName: userRecord.name,
      })

      next()
    } catch (tokenError) {
      const errorMessage = tokenError instanceof Error ? tokenError.message : String(tokenError)
      const errorStack = tokenError instanceof Error ? tokenError.stack : undefined

      logger.warn(`Token validation failed for socket ${socket.id}:`, {
        error: errorMessage,
        stack: errorStack,
        origin,
        referer,
      })
      return next(new Error('Token validation failed'))
    }
  } catch (error) {
    logger.error(`Socket authentication error for ${socket.id}:`, error)
    next(new Error('Authentication failed'))
  }
}
