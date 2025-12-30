import { toNextJsHandler } from 'better-auth/next-js'
import { type NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { createAnonymousSession, ensureAnonymousUserExists } from '@/lib/auth/anonymous'
import { isAuthDisabled } from '@/lib/core/config/feature-flags'
import { db, session, user } from '@sim/db'
import { eq } from 'drizzle-orm'
import crypto from 'crypto'

export const dynamic = 'force-dynamic'

const { GET: betterAuthGET, POST: betterAuthPOST } = toNextJsHandler(auth.handler)

// Check for SSO session using our custom token hashing
async function checkSSOSession(request: NextRequest) {
  const cookieToken = request.cookies.get('better-auth.session_token')?.value
  if (!cookieToken) return null
  
  // Hash the cookie token with SHA-256 (matching our SSO session creation)
  const tokenHash = crypto.createHash('sha256').update(cookieToken).digest('hex')
  
  // Look up session by hashed token
  const sessionRecord = await db.query.session.findFirst({
    where: eq(session.token, tokenHash),
  })
  
  if (!sessionRecord || sessionRecord.expiresAt < new Date()) {
    return null
  }
  
  // Get the user
  const userRecord = await db.query.user.findFirst({
    where: eq(user.id, sessionRecord.userId),
  })
  
  if (!userRecord) return null
  
  return {
    session: {
      id: sessionRecord.id,
      userId: sessionRecord.userId,
      expiresAt: sessionRecord.expiresAt,
      activeOrganizationId: sessionRecord.activeOrganizationId,
    },
    user: {
      id: userRecord.id,
      name: userRecord.name,
      email: userRecord.email,
      image: userRecord.image,
      emailVerified: userRecord.emailVerified,
    },
  }
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const path = url.pathname.replace('/api/auth/', '')

  if (path === 'get-session' && isAuthDisabled) {
    await ensureAnonymousUserExists()
    return NextResponse.json(createAnonymousSession())
  }

  // For get-session, first check our SSO sessions
  if (path === 'get-session') {
    const ssoSession = await checkSSOSession(request)
    if (ssoSession) {
      return NextResponse.json(ssoSession)
    }
  }

  return betterAuthGET(request)
}

export const POST = betterAuthPOST
