/**
 * Tenant Database Helper
 * 
 * Provides utilities for getting the tenant-specific database connection
 * based on the user's session.
 */

import { db, getTenantDatabase, organization } from '@sim/db'
import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

/**
 * Get tenant database from session
 * 
 * Extracts the tenant ID from the user's active organization and returns
 * a database connection for that tenant.
 * 
 * @param session - The user session from getSession()
 * @returns The tenant database connection, or null if not available
 */
export async function getTenantDbFromSession(session: any): Promise<any | null> {
  if (!session) return null
  
  const orgId = session?.session?.activeOrganizationId
  if (!orgId) return null
  
  const orgRecord = await db.query.organization.findFirst({
    where: eq(organization.id, orgId),
  })
  
  if (!orgRecord?.name?.startsWith('ModelFlow-')) return null
  
  const tenantId = orgRecord.name.replace('ModelFlow-', '')
  return getTenantDatabase(tenantId)
}

/**
 * Get tenant ID from session
 * 
 * Extracts just the tenant ID from the user's active organization.
 * Useful when you need the tenant ID but not the database connection.
 * 
 * @param session - The user session from getSession()
 * @returns The tenant ID, or null if not available
 */
export async function getTenantIdFromSession(session: any): Promise<string | null> {
  if (!session) return null
  
  const orgId = session?.session?.activeOrganizationId
  if (!orgId) return null
  
  const orgRecord = await db.query.organization.findFirst({
    where: eq(organization.id, orgId),
  })
  
  if (!orgRecord?.name?.startsWith('ModelFlow-')) return null
  
  return orgRecord.name.replace('ModelFlow-', '')
}

/**
 * Get tenant database or throw error
 * 
 * Same as getTenantDbFromSession but throws an error if tenant is not found.
 * Useful for routes that require tenant isolation.
 * 
 * @param session - The user session from getSession()
 * @returns The tenant database connection
 * @throws Error if tenant is not found
 */
export async function requireTenantDb(session: any): Promise<PostgresJsDatabase<any>> {
  const tenantDb = await getTenantDbFromSession(session)
  if (!tenantDb) {
    throw new Error('Tenant not found. User must belong to an organization.')
  }
  return tenantDb
}
