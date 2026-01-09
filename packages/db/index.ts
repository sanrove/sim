import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'
import { initMasterDb, getCurrentDb } from './tenant-context'

export * from './schema'
export * from './tenant-db'
export * from './tenant-context'

/**
 * Master database connection
 * Used for:
 * - Auth/session operations (user, session, organization, member tables)
 * - Migration purposes
 * - Operations that explicitly need master DB
 */
const connectionString = process.env.DATABASE_URL!
if (!connectionString) {
  throw new Error('Missing DATABASE_URL environment variable')
}

const postgresClient = postgres(connectionString, {
  prepare: false,
  idle_timeout: 20,
  connect_timeout: 30,
  max: 30,
  onnotice: () => {},
})

const masterDb = drizzle(postgresClient, { schema })

// Initialize master DB in tenant context
initMasterDb(masterDb)

/**
 * Default database export - TENANT-AWARE PROXY
 * 
 * This proxy automatically routes to:
 * - Tenant DB: if setCurrentTenant() was called for this request
 * - Master DB: if no tenant context is set
 * 
 * For explicit master DB access, use `masterDb` export.
 * For explicit tenant DB access, use `getTenantDatabase(tenantId)`.
 */
export const db = new Proxy(masterDb, {
  get(target, prop, receiver) {
    // Get the appropriate database based on current context
    const currentDb = getCurrentDb()
    return Reflect.get(currentDb, prop, receiver)
  }
})

// Also export masterDb for explicit master database access
export { masterDb }
