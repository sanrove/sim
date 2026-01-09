import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

export * from './schema'
export * from './tenant-db'

/**
 * Default database connection (for backward compatibility)
 * 
 * NOTE: For per-tenant isolation, use getTenantDatabase(tenantId) from tenant-db.ts instead
 * This default connection is only used for:
 * - Migration purposes
 * - Legacy code that hasn't been updated to use per-tenant databases
 * 
 * For SSO and new features, ALWAYS use getTenantDatabase(tenantId)
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

export const db = drizzle(postgresClient, { schema })
