import crypto from 'crypto'
import { db, getTenantDatabase, organization } from '@sim/db'
import { verification } from '@sim/db/schema'
import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { isAuthDisabled } from '@/lib/core/config/feature-flags'
import { createLogger } from '@/lib/logs/console/logger'

const logger = createLogger('SocketToken')

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

export async function POST() {
  try {
    if (isAuthDisabled) {
      logger.info('Auth is disabled, returning anonymous token')
      return NextResponse.json({ token: 'anonymous-socket-token' })
    }

    logger.info('Generating one-time token for socket authentication')
    
    // Use custom getSession that handles SSO sessions properly
    const session = await getSession()
    
    if (!session || !session.user) {
      logger.warn('No active session found for socket token generation')
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }
    
    logger.info('Valid session found, generating one-time token', {
      userId: session.user?.id,
    })
    
    // Get tenant database
    const tenantDb = await getTenantDbFromSession(session)
    if (!tenantDb) {
      logger.error('Tenant database not found for socket token generation')
      return NextResponse.json({ error: 'Tenant not found' }, { status: 400 })
    }
    
    // Extract tenant ID from organization name
    const orgId = (session as any).session?.activeOrganizationId
    const orgRecord = await db.query.organization.findFirst({
      where: eq(organization.id, orgId),
    })
    const tenantId = orgRecord?.name?.replace('ModelFlow-', '') || 'unknown'
    
    // Generate a secure random token for Socket.IO authentication
    // We'll manually create and store this in the verification table
    const token = crypto.randomBytes(32).toString('hex')
    const tokenId = crypto.randomBytes(16).toString('hex')
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours
    
    try {
      // Store the token in the verification table (in tenant db)
      // Store userId:tenantId in identifier for easy lookup
      await tenantDb.insert(verification).values({
        id: tokenId,
        identifier: `${session.session.userId}:${tenantId}`,
        value: token,
        expiresAt,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      
      logger.info('Successfully generated and stored socket token', {
        userId: session.user?.id,
        tokenId,
      })
      
      return NextResponse.json({ token })
    } catch (dbError) {
      logger.error('Database error while storing token:', dbError)
      return NextResponse.json({ error: 'Failed to store token' }, { status: 500 })
    }
  } catch (error) {
    logger.error('Error generating socket token:', error)
    return NextResponse.json({ 
      error: 'Failed to generate token',
      details: error instanceof Error ? error.message : String(error)
    }, { status: 500 })
  }
}
