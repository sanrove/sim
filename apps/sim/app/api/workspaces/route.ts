import { getTenantDatabase, permissions, user, workflow, workspace, organization, db as masterDb } from '@sim/db'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getSession } from '@/lib/auth'
import { createLogger } from '@/lib/logs/console/logger'
import { buildDefaultWorkflowArtifacts } from '@/lib/workflows/defaults'
import { saveWorkflowToNormalizedTables } from '@/lib/workflows/persistence/utils'

const logger = createLogger('Workspaces')

const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
})

// Get all workspaces for the current user
export async function GET() {
  console.log('\n=== WORKSPACE GET REQUEST STARTED ===')
  const session = await getSession()
  console.log('Session retrieved:', JSON.stringify(session, null, 2))

  if (!session?.user?.id) {
    console.log('ERROR: No user in session')
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Get tenant ID from organization
  const orgId = (session as any).session?.activeOrganizationId
  console.log('Active organization ID from session:', orgId)
  
  if (!orgId) {
    console.log('WARNING: No active organization in session - returning empty array')
    logger.warn('No active organization in session', { userId: session.user.id })
    return NextResponse.json({ workspaces: [] }, { status: 200 })
  }

  // Get organization from master database to extract tenantId
  console.log('Querying master database for organization:', orgId)
  const orgRecord = await masterDb.query.organization.findFirst({
    where: eq(organization.id, orgId),
  })
  console.log('Organization record found:', orgRecord)
  
  if (!orgRecord?.name?.startsWith('ModelFlow-')) {
    console.log('ERROR: Invalid organization format:', orgRecord?.name)
    logger.error('Invalid organization format', { orgName: orgRecord?.name })
    return NextResponse.json({ error: 'Invalid tenant configuration' }, { status: 400 })
  }

  const tenantId = orgRecord.name.replace('ModelFlow-', '')
  console.log('Extracted tenantId:', tenantId)
  console.log('Connecting to tenant database: sim_' + tenantId)
  logger.info('Fetching workspaces from tenant database', { 
    userId: session.user.id,
    tenantId,
    orgId 
  })

  // Connect to tenant database
  const tenantDb = await getTenantDatabase(tenantId)
  console.log('Connected to tenant database successfully')

  // Query workspaces from TENANT database
  console.log('Querying workspaces for userId:', session.user.id)
  const userWorkspaces = await tenantDb
    .select({
      workspace: workspace,
      permissionType: permissions.permissionType,
    })
    .from(permissions)
    .innerJoin(workspace, eq(permissions.entityId, workspace.id))
    .where(
      and(
        eq(permissions.userId, session.user.id), 
        eq(permissions.entityType, 'workspace')
      )
    )
    .orderBy(desc(workspace.createdAt))

  console.log('Query result - Number of workspaces found:', userWorkspaces.length)
  logger.info('Workspaces retrieved from tenant database', { 
    count: userWorkspaces.length,
    userId: session.user.id,
    tenantId
  })

  if (userWorkspaces.length === 0) {
    console.log('🔧 No workspaces found - Creating default workspace...')
    logger.info('No workspaces found, creating default workspace', { 
      userId: session.user.id, 
      tenantId 
    })
    
    try {
      console.log('Calling createDefaultWorkspace with:', { userId: session.user.id, tenantId, userName: session.user.name })
      // Create a default workspace for the user
      const defaultWorkspace = await createDefaultWorkspace(session.user.id, tenantId, session.user.name)
      console.log('✅ Default workspace created:', defaultWorkspace)
      logger.info('Default workspace created successfully', { 
        workspaceId: defaultWorkspace.id,
        userId: session.user.id,
        tenantId 
      })

      console.log('Migrating existing workflows...')
      // Migrate existing workflows to the default workspace
      await migrateExistingWorkflows(session.user.id, defaultWorkspace.id, tenantId)
      console.log('✅ Migration complete')

      return NextResponse.json({ workspaces: [defaultWorkspace] })
    } catch (error: any) {
      console.error('❌ Failed to create default workspace:', error)
      logger.error('Failed to create default workspace', { 
        error: error.message,
        stack: error.stack,
        userId: session.user.id,
        tenantId 
      })
      return NextResponse.json({ 
        error: 'Failed to create workspace', 
        details: error.message 
      }, { status: 500 })
    }
  }

  // If user has workspaces but might have orphaned workflows, migrate them
  await ensureWorkflowsHaveWorkspace(session.user.id, userWorkspaces[0].workspace.id, tenantId)

  // Format the response with permission information
  const workspacesWithPermissions = userWorkspaces.map(
    ({ workspace: workspaceDetails, permissionType }: any) => ({
      ...workspaceDetails,
      role: permissionType === 'admin' ? 'owner' : 'member',
      permissions: permissionType,
    })
  )

  return NextResponse.json({ workspaces: workspacesWithPermissions })
}

// POST /api/workspaces - Create a new workspace
export async function POST(req: Request) {
  const session = await getSession()

  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Get tenant ID from organization
  const orgId = (session as any).session?.activeOrganizationId
  const orgRecord = await masterDb.query.organization.findFirst({
    where: eq(organization.id, orgId),
  })
  
  if (!orgRecord?.name?.startsWith('ModelFlow-')) {
    return NextResponse.json({ error: 'Invalid tenant configuration' }, { status: 400 })
  }

  const tenantId = orgRecord.name.replace('ModelFlow-', '')

  try {
    const { name } = createWorkspaceSchema.parse(await req.json())

    const newWorkspace = await createWorkspace(session.user.id, name, tenantId)

    return NextResponse.json({ workspace: newWorkspace })
  } catch (error) {
    logger.error('Error creating workspace:', error)
    return NextResponse.json({ error: 'Failed to create workspace' }, { status: 500 })
  }
}

// Helper function to create a default workspace
async function createDefaultWorkspace(userId: string, tenantId: string, userName?: string | null) {
  // Extract first name only by splitting on spaces and taking the first part
  const firstName = userName?.split(' ')[0] || null
  const workspaceName = firstName ? `${firstName}'s Workspace` : 'My Workspace'
  logger.info('Creating default workspace', { userId, tenantId, workspaceName })
  return createWorkspace(userId, workspaceName, tenantId)
}

// Helper function to create a workspace
async function createWorkspace(userId: string, name: string, tenantId: string) {
  const tenantDb = await getTenantDatabase(tenantId)
  const workspaceId = crypto.randomUUID()
  const workflowId = crypto.randomUUID()
  const now = new Date()

  // Create the workspace and initial workflow in a transaction
  try {
    await tenantDb.transaction(async (tx: any) => {
      // Create the workspace
      await tx.insert(workspace).values({
        id: workspaceId,
        name,
        ownerId: userId,
        billedAccountUserId: userId,
        allowPersonalApiKeys: true,
        createdAt: now,
        updatedAt: now,
      })

      // Create admin permissions for the workspace owner
      await tx.insert(permissions).values({
        id: crypto.randomUUID(),
        entityType: 'workspace' as const,
        entityId: workspaceId,
        userId: userId,
        permissionType: 'admin' as const,
        createdAt: now,
        updatedAt: now,
      })

      // Create initial workflow for the workspace (empty canvas)
      // Create the workflow
      await tx.insert(workflow).values({
        id: workflowId,
        userId,
        workspaceId,
        folderId: null,
        name: 'default-agent',
        description: 'Your first workflow - start building here!',
        color: '#3972F6',
        lastSynced: now,
        createdAt: now,
        updatedAt: now,
        isDeployed: false,
        runCount: 0,
        variables: {},
      })

      // No blocks are inserted - empty canvas

      logger.info(
        `Created workspace ${workspaceId} with initial workflow ${workflowId} for user ${userId}`
      )
    })

    const { workflowState } = buildDefaultWorkflowArtifacts()
    const seedResult = await saveWorkflowToNormalizedTables(workflowId, workflowState)

    if (!seedResult.success) {
      throw new Error(seedResult.error || 'Failed to seed default workflow state')
    }
  } catch (error) {
    logger.error(`Failed to create workspace ${workspaceId} with initial workflow:`, error)
    throw error
  }

  // Return the workspace data directly instead of querying again
  return {
    id: workspaceId,
    name,
    ownerId: userId,
    billedAccountUserId: userId,
    allowPersonalApiKeys: true,
    createdAt: now,
    updatedAt: now,
    role: 'owner',
  }
}

// Helper function to migrate existing workflows to a workspace
async function migrateExistingWorkflows(userId: string, workspaceId: string, tenantId: string) {
  const tenantDb = await getTenantDatabase(tenantId)
  
  // Find all workflows that have no workspace ID
  const orphanedWorkflows = await tenantDb
    .select({ id: workflow.id })
    .from(workflow)
    .where(and(eq(workflow.userId, userId), isNull(workflow.workspaceId)))

  if (orphanedWorkflows.length === 0) {
    return // No orphaned workflows to migrate
  }

  logger.info(
    `Migrating ${orphanedWorkflows.length} workflows to workspace ${workspaceId} for user ${userId}`
  )

  // Bulk update all orphaned workflows at once
  await tenantDb
    .update(workflow)
    .set({
      workspaceId: workspaceId,
      updatedAt: new Date(),
    })
    .where(and(eq(workflow.userId, userId), isNull(workflow.workspaceId)))
}

// Helper function to ensure all workflows have a workspace
async function ensureWorkflowsHaveWorkspace(userId: string, defaultWorkspaceId: string, tenantId: string) {
  const tenantDb = await getTenantDatabase(tenantId)
  
  // First check if there are any orphaned workflows
  const orphanedWorkflows = await tenantDb
    .select()
    .from(workflow)
    .where(and(eq(workflow.userId, userId), isNull(workflow.workspaceId)))

  if (orphanedWorkflows.length > 0) {
    // Directly update any workflows that don't have a workspace ID in a single query
    await tenantDb
      .update(workflow)
      .set({
        workspaceId: defaultWorkspaceId,
        updatedAt: new Date(),
      })
      .where(and(eq(workflow.userId, userId), isNull(workflow.workspaceId)))

    logger.info(`Fixed ${orphanedWorkflows.length} orphaned workflows for user ${userId}`)
  }
}