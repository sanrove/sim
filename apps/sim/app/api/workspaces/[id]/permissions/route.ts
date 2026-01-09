import crypto from 'crypto'
import { db, getTenantDatabase, organization } from '@sim/db'
import { permissions, workspace } from '@sim/db/schema'
import { and, eq } from 'drizzle-orm'
import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSession } from '@/lib/auth'
import { createLogger } from '@/lib/logs/console/logger'
import {
  getUsersWithPermissions,
  hasWorkspaceAdminAccess,
} from '@/lib/workspaces/permissions/utils'

const logger = createLogger('WorkspacesPermissionsAPI')

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

const updatePermissionsSchema = z.object({
  updates: z.array(
    z.object({
      userId: z.string(),
      permissions: z.enum(['admin', 'write', 'read']),
    })
  ),
})

/**
 * GET /api/workspaces/[id]/permissions
 *
 * Retrieves all users who have permissions for the specified workspace.
 * Returns user details along with their specific permissions.
 *
 * @param workspaceId - The workspace ID from the URL parameters
 * @returns Array of users with their permissions for the workspace
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: workspaceId } = await params
    const session = await getSession()

    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    // Get tenant database
    const tenantDb = await getTenantDbFromSession(session)
    if (!tenantDb) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 400 })
    }

    const userPermission = await tenantDb
      .select()
      .from(permissions)
      .where(
        and(
          eq(permissions.entityId, workspaceId),
          eq(permissions.entityType, 'workspace'),
          eq(permissions.userId, session.user.id)
        )
      )
      .limit(1)

    if (userPermission.length === 0) {
      return NextResponse.json({ error: 'Workspace not found or access denied' }, { status: 404 })
    }

    // Get users with permissions from tenant DB
    const result = await getUsersWithPermissionsFromTenant(workspaceId, tenantDb)

    return NextResponse.json({
      users: result,
      total: result.length,
    })
  } catch (error) {
    logger.error('Error fetching workspace permissions:', error)
    return NextResponse.json({ error: 'Failed to fetch workspace permissions' }, { status: 500 })
  }
}

// Helper function to get users with permissions from tenant DB
async function getUsersWithPermissionsFromTenant(workspaceId: string, tenantDb: any) {
  // Query permissions from tenant DB, but user info from master DB
  const permissionRecords = await tenantDb
    .select({
      userId: permissions.userId,
      permissionType: permissions.permissionType,
    })
    .from(permissions)
    .where(and(eq(permissions.entityType, 'workspace'), eq(permissions.entityId, workspaceId)))

  // Get user info from master DB
  const userIds = permissionRecords.map((p: any) => p.userId)
  if (userIds.length === 0) return []

  const { user } = await import('@sim/db/schema')
  const { inArray } = await import('drizzle-orm')
  
  const users = await db
    .select({ id: user.id, email: user.email, name: user.name })
    .from(user)
    .where(inArray(user.id, userIds))

  const userMap = new Map(users.map(u => [u.id, u]))

  return permissionRecords.map((p: any) => {
    const u = userMap.get(p.userId)
    return {
      userId: p.userId,
      email: u?.email || '',
      name: u?.name || '',
      permissionType: p.permissionType,
    }
  })
}

/**
 * PATCH /api/workspaces/[id]/permissions
 *
 * Updates permissions for existing workspace members.
 * Only admin users can update permissions.
 *
 * @param workspaceId - The workspace ID from the URL parameters
 * @param updates - Array of permission updates for users
 * @returns Success message or error
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: workspaceId } = await params
    const session = await getSession()

    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    // Get tenant database
    const tenantDb = await getTenantDbFromSession(session)
    if (!tenantDb) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 400 })
    }

    const hasAdminAccess = await hasWorkspaceAdminAccess(session.user.id, workspaceId, tenantDb)

    if (!hasAdminAccess) {
      return NextResponse.json(
        { error: 'Admin access required to update permissions' },
        { status: 403 }
      )
    }

    const body = updatePermissionsSchema.parse(await request.json())

    const workspaceRow = await tenantDb
      .select({ billedAccountUserId: workspace.billedAccountUserId })
      .from(workspace)
      .where(eq(workspace.id, workspaceId))
      .limit(1)

    if (!workspaceRow.length) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 })
    }

    const billedAccountUserId = workspaceRow[0].billedAccountUserId

    const selfUpdate = body.updates.find((update) => update.userId === session.user.id)
    if (selfUpdate && selfUpdate.permissions !== 'admin') {
      return NextResponse.json(
        { error: 'Cannot remove your own admin permissions' },
        { status: 400 }
      )
    }

    if (
      billedAccountUserId &&
      body.updates.some(
        (update) => update.userId === billedAccountUserId && update.permissions !== 'admin'
      )
    ) {
      return NextResponse.json(
        { error: 'Workspace billing account must retain admin permissions' },
        { status: 400 }
      )
    }

    await tenantDb.transaction(async (tx: any) => {
      for (const update of body.updates) {
        await tx
          .delete(permissions)
          .where(
            and(
              eq(permissions.userId, update.userId),
              eq(permissions.entityType, 'workspace'),
              eq(permissions.entityId, workspaceId)
            )
          )

        await tx.insert(permissions).values({
          id: crypto.randomUUID(),
          userId: update.userId,
          entityType: 'workspace' as const,
          entityId: workspaceId,
          permissionType: update.permissions,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
      }
    })

    const updatedUsers = await getUsersWithPermissionsFromTenant(workspaceId, tenantDb)

    return NextResponse.json({
      message: 'Permissions updated successfully',
      users: updatedUsers,
      total: updatedUsers.length,
    })
  } catch (error) {
    logger.error('Error updating workspace permissions:', error)
    return NextResponse.json({ error: 'Failed to update workspace permissions' }, { status: 500 })
  }
}
