import { NextRequest, NextResponse } from 'next/server';
import { validateModelFlowToken } from '@/lib/auth/validate-modelflow-token';
import { getTenantDatabase, user, organization, member, session, workspace, permissions, workflow, db as masterDb } from '@sim/db';
import { and, eq } from 'drizzle-orm';
import { createLogger } from '@/lib/logs/console/logger';
import { v4 as uuidv4 } from 'uuid';
import { buildDefaultWorkflowArtifacts } from '@/lib/workflows/defaults';
import { saveWorkflowToNormalizedTables } from '@/lib/workflows/persistence/utils';
import crypto from 'crypto';

const logger = createLogger('ModelFlowSSO');

export async function GET(request: NextRequest) {
  try {
    const token = request.nextUrl.searchParams.get('token');

    if (!token) {
      logger.warn('No token provided in SSO request');
      return NextResponse.redirect(new URL('/login', request.url));
    }

    // Get shared secret from environment
    const sharedSecret = process.env.MODELFLOW_SIM_SHARED_SECRET;
    if (!sharedSecret) {
      logger.error('MODELFLOW_SIM_SHARED_SECRET is not configured');
      return NextResponse.redirect(new URL('/login', request.url));
    }

    // Validate the token
    let payload;
    try {
      payload = validateModelFlowToken(token, sharedSecret);
      logger.info('Token validated successfully', { email: payload.email, tenantId: payload.tenantId });
    } catch (tokenError: any) {
      logger.warn('Token validation failed', { error: tokenError.message });
      return NextResponse.redirect(new URL('/login', request.url));
    }

    // Handle user creation/retrieval in MASTER database only
    const result = await handleSSO(payload);

    // Create session token - better-auth expects the DB to store a SHA-256 hash
    const sessionToken = crypto.randomBytes(32).toString('base64url'); // Token for cookie
    const sessionTokenHash = crypto.createHash('sha256').update(sessionToken).digest('hex'); // Hash for DB
    const sessionId = uuidv4();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
    const now = new Date();

    const sessionData = {
      id: sessionId,
      userId: result.user.id,
      token: sessionTokenHash, // Store the HASH, not plain text
      expiresAt,
      createdAt: now,
      updatedAt: now,
      ipAddress: request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || null,
      userAgent: request.headers.get('user-agent') || null,
      activeOrganizationId: result.organizationId,
    };

    await masterDb.insert(session).values(sessionData);

    logger.info('Session created with hashed token', { 
      sessionId,
      userId: result.user.id,
      organizationId: result.organizationId,
      tenantId: payload.tenantId,
    });

    const response = NextResponse.redirect(new URL('/workspace', request.url));
    
    // Set cookie with the PLAIN token (not the hash)
    response.cookies.set('better-auth.session_token', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60,
      path: '/',
    });

    return response;
  } catch (error: any) {
    logger.error('SSO GET error', { error: error.message, stack: error.stack });
    return NextResponse.redirect(new URL('/login', request.url));
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const token = body.token;

    if (!token) {
      logger.warn('No token provided in SSO POST request');
      return NextResponse.json(
        { error: 'Token is required' },
        { status: 400 }
      );
    }

    // Get shared secret from environment
    const sharedSecret = process.env.MODELFLOW_SIM_SHARED_SECRET;
    if (!sharedSecret) {
      logger.error('MODELFLOW_SIM_SHARED_SECRET is not configured');
      return NextResponse.json(
        { error: 'Server configuration error' },
        { status: 500 }
      );
    }

    // Validate the token
    let payload;
    try {
      payload = validateModelFlowToken(token, sharedSecret);
      logger.info('Token validated successfully in POST', { email: payload.email, tenantId: payload.tenantId });
    } catch (tokenError: any) {
      logger.warn('Token validation failed in POST', { error: tokenError.message });
      return NextResponse.json(
        { error: 'Invalid token' },
        { status: 401 }
      );
    }

    // Handle user creation/retrieval in BOTH master and tenant databases
    const result = await handleSSO(payload);

    // Create session with proper token hashing
    const sessionToken = crypto.randomBytes(32).toString('base64url');
    const sessionTokenHash = crypto.createHash('sha256').update(sessionToken).digest('hex');
    const sessionId = uuidv4();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const now = new Date();

    const sessionData = {
      id: sessionId,
      userId: result.user.id,
      token: sessionTokenHash,
      expiresAt,
      createdAt: now,
      updatedAt: now,
      ipAddress: request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || null,
      userAgent: request.headers.get('user-agent') || null,
      activeOrganizationId: result.organizationId,
    };

    await masterDb.insert(session).values(sessionData);

    logger.info('Session created', { 
      sessionId,
      userId: result.user.id,
      organizationId: result.organizationId,
      tenantId: payload.tenantId,
    });

    const response = NextResponse.json(
      {
        success: true,
        user: {
          id: result.user.id,
          email: result.user.email,
          name: result.user.name,
          image: result.user.image,
        },
        organizationId: result.organizationId,
      },
      { status: 200 }
    );

    // Set cookie with plain token
    response.cookies.set('better-auth.session_token', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60,
      path: '/',
    });

    return response;
  } catch (error: any) {
    logger.error('SSO POST error', { error: error.message, stack: error.stack });
    return NextResponse.json(
      { error: 'Server error during SSO' },
      { status: 500 }
    );
  }
}

/**
 * Handle ModelFlow SSO authentication
 * Creates user and organization in BOTH master and tenant databases
 * - Master DB: For better-auth session validation
 * - Tenant DB: For workspace data isolation
 */
async function handleSSO(payload: any) {
  const { email, tenantId, name, avatar, firstName, lastName } = payload;
  const fullName = name || `${firstName} ${lastName}`.trim() || email;
  const now = new Date();

  // Get tenant database connection
  const tenantDb = await getTenantDatabase(tenantId);

  // Step 1: Get or create user in MASTER database (for better-auth)
  let masterUserRecord = await masterDb.query.user.findFirst({
    where: eq(user.email, email),
  });

  if (!masterUserRecord) {
    logger.info('Creating new user in MASTER database', { email, tenantId });
    const userId = uuidv4();
    const [newUser] = await masterDb
      .insert(user)
      .values({
        id: userId,
        name: fullName,
        email,
        image: avatar || null,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    masterUserRecord = newUser;
  }

  const userId = masterUserRecord.id;

  // Step 2: Get or create user in TENANT database (with same ID)
  let tenantUserRecord = await tenantDb.query.user.findFirst({
    where: eq(user.email, email),
  });

  if (!tenantUserRecord) {
    logger.info('Creating new user in TENANT database', { email, tenantId });
    const [newUser] = await tenantDb
      .insert(user)
      .values({
        id: userId, // Same ID as master!
        name: fullName,
        email,
        image: avatar || null,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    tenantUserRecord = newUser;
  }

  // Step 3: Get or create organization in MASTER database
  let masterOrgRecord = await masterDb.query.organization.findFirst({
    where: eq(organization.name, `ModelFlow-${tenantId}`),
  });

  if (!masterOrgRecord) {
    logger.info('Creating organization in MASTER database', { tenantId });
    const orgId = uuidv4();
    const [newOrg] = await masterDb
      .insert(organization)
      .values({
        id: orgId,
        name: `ModelFlow-${tenantId}`,
        slug: `modelflow-${tenantId.substring(0, 8)}`,
      })
      .returning();
    masterOrgRecord = newOrg;
  }

  const organizationId = masterOrgRecord.id;

  // Step 4: Get or create organization in TENANT database (with same ID)
  let tenantOrgRecord = await tenantDb.query.organization.findFirst({
    where: eq(organization.name, `ModelFlow-${tenantId}`),
  });

  if (!tenantOrgRecord) {
    logger.info('Creating organization in TENANT database', { tenantId });
    const [newOrg] = await tenantDb
      .insert(organization)
      .values({
        id: organizationId, // Same ID as master!
        name: `ModelFlow-${tenantId}`,
        slug: `modelflow-${tenantId.substring(0, 8)}`,
      })
      .returning();
    tenantOrgRecord = newOrg;
  }

  // Step 5: Ensure user is a member in MASTER database
  const masterMemberRecord = await masterDb.query.member.findFirst({
    where: eq(member.userId, userId),
  });

  if (!masterMemberRecord) {
    logger.info('Adding user as member in MASTER database', { userId, organizationId, tenantId });
    await masterDb
      .insert(member)
      .values({
        id: uuidv4(),
        organizationId,
        userId,
        role: 'owner',
      })
      .onConflictDoNothing();
  }

  // Step 6: Ensure user is a member in TENANT database
  const tenantMemberRecord = await tenantDb.query.member.findFirst({
    where: eq(member.userId, userId),
  });

  let isNewMember = false;
  if (!tenantMemberRecord) {
    logger.info('Adding user as member in TENANT database', { userId, organizationId, tenantId });
    await tenantDb
      .insert(member)
      .values({
        id: uuidv4(),
        organizationId,
        userId,
        role: 'owner',
      })
      .onConflictDoNothing();
    isNewMember = true;
  }

  // Step 7: Create default workspace for NEW users ONLY
  if (isNewMember) {
    logger.info('Checking for existing workspace for new user', { userId, tenantId });
    
    // Check if user already has a workspace
    const existingWorkspaces = await tenantDb
      .select({ id: workspace.id })
      .from(permissions)
      .innerJoin(workspace, eq(permissions.entityId, workspace.id))
      .where(
        and(
          eq(permissions.userId, userId),
          eq(permissions.entityType, 'workspace')
        )
      )
      .limit(1);

    if (existingWorkspaces.length === 0) {
      logger.info('Creating default workspace for new user', { userId, tenantId, userName: fullName });
      
      try {
        const workspaceId = uuidv4();
        const workflowId = uuidv4();
        const firstName = fullName.split(' ')[0] || null;
        const workspaceName = firstName ? `${firstName}'s Workspace` : 'My Workspace';

        // Create workspace and workflow in transaction
        await tenantDb.transaction(async (tx: any) => {
          // Create the workspace
          await tx.insert(workspace).values({
            id: workspaceId,
            name: workspaceName,
            ownerId: userId,
            billedAccountUserId: userId,
            allowPersonalApiKeys: true,
            createdAt: now,
            updatedAt: now,
          });

          // Create admin permissions for the workspace owner
          await tx.insert(permissions).values({
            id: uuidv4(),
            entityType: 'workspace' as const,
            entityId: workspaceId,
            userId: userId,
            permissionType: 'admin' as const,
            createdAt: now,
            updatedAt: now,
          });

          // Create initial workflow
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
          });
        });

        // Save default workflow state
        const { workflowState } = buildDefaultWorkflowArtifacts();
        await saveWorkflowToNormalizedTables(workflowId, workflowState);

        logger.info('Default workspace and workflow created successfully', { 
          workspaceId, 
          workflowId, 
          userId, 
          tenantId 
        });
      } catch (error: any) {
        logger.error('Failed to create default workspace during SSO', { 
          error: error.message, 
          userId, 
          tenantId 
        });
        // Don't fail SSO if workspace creation fails - it will be created on first access
      }
    }
  }

  logger.info('SSO handling complete in both databases', {
    userId,
    organizationId,
    email,
    tenantId,
  });

  return {
    user: { id: userId, email, name: fullName, image: avatar || null },
    organizationId,
  };
}
