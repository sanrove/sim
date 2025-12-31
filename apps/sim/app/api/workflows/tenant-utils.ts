import { db, getTenantDatabase, organization } from '@sim/db'
import { eq } from 'drizzle-orm'
import { getSession } from '@/lib/auth'

/**
 * Get tenant database from session if user is in a multi-tenant organization
 * Returns null if not in a tenant organization (uses main db)
 */
export async function getTenantDbFromSession() {
  const session = await getSession()
  const orgId = (session as any)?.session?.activeOrganizationId
  if (!orgId) return null

  const orgRecord = await db.query.organization.findFirst({
    where: eq(organization.id, orgId),
  })

  if (!orgRecord?.name?.startsWith('ModelFlow-')) return null

  const tenantId = orgRecord.name.replace('ModelFlow-', '')
  return getTenantDatabase(tenantId)
}
