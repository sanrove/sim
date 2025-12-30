import { NextResponse } from 'next/server'
import { createLogger } from '@/lib/logs/console/logger'
import { getUserEntityPermissions } from '@/lib/workspaces/permissions/utils'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

const logger = createLogger('WorkflowUtils')

export function createErrorResponse(error: string, status: number, code?: string) {
  return NextResponse.json(
    {
      error,
      code: code || error.toUpperCase().replace(/\s+/g, '_'),
    },
    { status }
  )
}

export function createSuccessResponse(data: any) {
  return NextResponse.json(data)
}

/**
 * Verifies user's workspace permissions using the permissions table
 * @param userId User ID to check
 * @param workspaceId Workspace ID to check
 * @returns Permission type if user has access, null otherwise
 */
export async function verifyWorkspaceMembership(
  userId: string,
  workspaceId: string
): Promise<string | null> {
  try {
    const permission = await getUserEntityPermissions(userId, 'workspace', workspaceId)

    return permission
  } catch (error) {
    logger.error(`Error verifying workspace permissions for ${userId} in ${workspaceId}:`, error)
    return null
  }
}

/**
 * Verifies user's workspace permissions using a specific database connection
 * @param userId User ID to check
 * @param workspaceId Workspace ID to check
 * @param tenantDb Tenant database connection
 * @returns Permission type if user has access, null otherwise
 */
export async function verifyWorkspaceMembershipWithDb(
  userId: string,
  workspaceId: string,
  tenantDb: PostgresJsDatabase<any>
): Promise<string | null> {
  try {
    const permission = await getUserEntityPermissions(userId, 'workspace', workspaceId, tenantDb)
    return permission
  } catch (error) {
    logger.error(`Error verifying workspace permissions for ${userId} in ${workspaceId}:`, error)
    return null
  }
}
