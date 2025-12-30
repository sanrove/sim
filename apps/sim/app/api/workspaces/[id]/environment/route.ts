import { db, getTenantDatabase, organization } from '@sim/db'
import { environment, workspace, workspaceEnvironment } from '@sim/db/schema'
import { eq } from 'drizzle-orm'
import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSession } from '@/lib/auth'
import { decryptSecret, encryptSecret } from '@/lib/core/security/encryption'
import { generateRequestId } from '@/lib/core/utils/request'
import { createLogger } from '@/lib/logs/console/logger'
import { getUserEntityPermissions } from '@/lib/workspaces/permissions/utils'

const logger = createLogger('WorkspaceEnvironmentAPI')

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

const UpsertSchema = z.object({
  variables: z.record(z.string()),
})

const DeleteSchema = z.object({
  keys: z.array(z.string()).min(1),
})

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = generateRequestId()
  const workspaceId = (await params).id

  try {
    const session = await getSession()
    if (!session?.user?.id) {
      logger.warn(`[${requestId}] Unauthorized workspace env access attempt`)
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const userId = session.user.id

    // Get tenant database
    const tenantDb = await getTenantDbFromSession(session)
    if (!tenantDb) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 400 })
    }

    // Validate workspace exists in tenant DB
    const ws = await tenantDb.select().from(workspace).where(eq(workspace.id, workspaceId)).limit(1)
    if (!ws.length) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 })
    }

    // Require any permission to read
    const permission = await getUserEntityPermissions(userId, 'workspace', workspaceId, tenantDb)
    if (!permission) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Workspace env (encrypted) from tenant DB
    const wsEnvRow = await tenantDb
      .select()
      .from(workspaceEnvironment)
      .where(eq(workspaceEnvironment.workspaceId, workspaceId))
      .limit(1)

    const wsEncrypted: Record<string, string> = (wsEnvRow[0]?.variables as any) || {}

    // Personal env (encrypted) from tenant DB
    const personalRow = await tenantDb
      .select()
      .from(environment)
      .where(eq(environment.userId, userId))
      .limit(1)

    const personalEncrypted: Record<string, string> = (personalRow[0]?.variables as any) || {}

    // Decrypt both for UI
    const decryptAll = async (src: Record<string, string>) => {
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(src)) {
        try {
          const { decrypted } = await decryptSecret(v)
          out[k] = decrypted
        } catch {
          out[k] = ''
        }
      }
      return out
    }

    const [workspaceDecrypted, personalDecrypted] = await Promise.all([
      decryptAll(wsEncrypted),
      decryptAll(personalEncrypted),
    ])

    const conflicts = Object.keys(personalDecrypted).filter((k) => k in workspaceDecrypted)

    return NextResponse.json(
      {
        data: {
          workspace: workspaceDecrypted,
          personal: personalDecrypted,
          conflicts,
        },
      },
      { status: 200 }
    )
  } catch (error: any) {
    logger.error(`[${requestId}] Workspace env GET error`, error)
    return NextResponse.json(
      { error: error.message || 'Failed to load environment' },
      { status: 500 }
    )
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = generateRequestId()
  const workspaceId = (await params).id

  try {
    const session = await getSession()
    if (!session?.user?.id) {
      logger.warn(`[${requestId}] Unauthorized workspace env update attempt`)
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const userId = session.user.id

    // Get tenant database
    const tenantDb = await getTenantDbFromSession(session)
    if (!tenantDb) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 400 })
    }

    const permission = await getUserEntityPermissions(userId, 'workspace', workspaceId, tenantDb)
    if (!permission || (permission !== 'admin' && permission !== 'write')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const body = await request.json()
    const { variables } = UpsertSchema.parse(body)

    // Read existing encrypted ws vars from tenant DB
    const existingRows = await tenantDb
      .select()
      .from(workspaceEnvironment)
      .where(eq(workspaceEnvironment.workspaceId, workspaceId))
      .limit(1)

    const existingEncrypted: Record<string, string> = (existingRows[0]?.variables as any) || {}

    // Encrypt incoming
    const encryptedIncoming = await Promise.all(
      Object.entries(variables).map(async ([key, value]) => {
        const { encrypted } = await encryptSecret(value)
        return [key, encrypted] as const
      })
    ).then((entries) => Object.fromEntries(entries))

    const merged = { ...existingEncrypted, ...encryptedIncoming }

    // Upsert by unique workspace_id in tenant DB
    await tenantDb
      .insert(workspaceEnvironment)
      .values({
        id: crypto.randomUUID(),
        workspaceId,
        variables: merged,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [workspaceEnvironment.workspaceId],
        set: { variables: merged, updatedAt: new Date() },
      })

    return NextResponse.json({ success: true })
  } catch (error: any) {
    logger.error(`[${requestId}] Workspace env PUT error`, error)
    return NextResponse.json(
      { error: error.message || 'Failed to update environment' },
      { status: 500 }
    )
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = generateRequestId()
  const workspaceId = (await params).id

  try {
    const session = await getSession()
    if (!session?.user?.id) {
      logger.warn(`[${requestId}] Unauthorized workspace env delete attempt`)
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const userId = session.user.id

    // Get tenant database
    const tenantDb = await getTenantDbFromSession(session)
    if (!tenantDb) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 400 })
    }

    const permission = await getUserEntityPermissions(userId, 'workspace', workspaceId, tenantDb)
    if (!permission || (permission !== 'admin' && permission !== 'write')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const body = await request.json()
    const { keys } = DeleteSchema.parse(body)

    const wsRows = await tenantDb
      .select()
      .from(workspaceEnvironment)
      .where(eq(workspaceEnvironment.workspaceId, workspaceId))
      .limit(1)

    const current: Record<string, string> = (wsRows[0]?.variables as any) || {}
    let changed = false
    for (const k of keys) {
      if (k in current) {
        delete current[k]
        changed = true
      }
    }

    if (!changed) {
      return NextResponse.json({ success: true })
    }

    await tenantDb
      .insert(workspaceEnvironment)
      .values({
        id: wsRows[0]?.id || crypto.randomUUID(),
        workspaceId,
        variables: current,
        createdAt: wsRows[0]?.createdAt || new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [workspaceEnvironment.workspaceId],
        set: { variables: current, updatedAt: new Date() },
      })

    return NextResponse.json({ success: true })
  } catch (error: any) {
    logger.error(`[${requestId}] Workspace env DELETE error`, error)
    return NextResponse.json(
      { error: error.message || 'Failed to remove environment keys' },
      { status: 500 }
    )
  }
}
