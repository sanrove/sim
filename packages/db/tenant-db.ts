/**
 * Tenant-Specific Database Service
 * 
 * Provides per-tenant PostgreSQL database isolation.
 * Each tenant gets their own dedicated database instance.
 * 
 * Example:
 * - Tenant 1: sim_tenant_6940fe29284471286882fbf1
 * - Tenant 2: sim_tenant_a1b2c3d4e5f6g7h8i9j0k1l2
 * - Tenant 3: sim_tenant_x9y8z7w6v5u4t3s2r1q0p9o8
 */

import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

// Simple console logger for package-level logging
const logger = {
  debug: (msg: string, data?: any) => console.debug(`[TenantDatabase] ${msg}`, data),
  info: (msg: string, data?: any) => console.log(`[TenantDatabase] ${msg}`, data),
  warn: (msg: string, data?: any) => console.warn(`[TenantDatabase] ${msg}`, data),
  error: (msg: string, data?: any) => console.error(`[TenantDatabase] ${msg}`, data),
}

// Cache for tenant database connections
const tenantDatabaseCache: Map<string, any> = new Map()

/**
 * Get or create a tenant-specific database connection
 * 
 * @param tenantId - The tenant ID (from ModelFlow token)
 * @returns Drizzle database instance for the tenant
 * 
 * @throws Error if database connection fails
 */
export async function getTenantDatabase(tenantId: string) {
  // Validate tenant ID
  if (!tenantId || tenantId.trim().length === 0) {
    throw new Error('Invalid tenantId provided to getTenantDatabase')
  }

  // Check if connection is already cached
  if (tenantDatabaseCache.has(tenantId)) {
    logger.debug('Using cached database connection for tenant', { tenantId })
    return tenantDatabaseCache.get(tenantId).db
  }

  try {
    // Build tenant-specific database URL
    const dbUrl = buildTenantDatabaseUrl(tenantId)
    logger.info('Connecting to tenant database', { tenantId, database: getDatabaseName(tenantId) })

    // Create postgres client for this tenant
    const postgresClient = postgres(dbUrl, {
      prepare: false,
      idle_timeout: 20,
      connect_timeout: 30,
      max: 30,
      onnotice: () => {},
    })

    // Test connection
    try {
      await postgresClient`SELECT 1`
      logger.info('Successfully connected to tenant database', { tenantId })
    } catch (connError) {
      logger.error('Failed to connect to tenant database', {
        tenantId,
        error: connError instanceof Error ? connError.message : String(connError),
      })
      throw new Error(`Cannot connect to database for tenant ${tenantId}`)
    }

    // Create drizzle instance
    const tenantDb = drizzle(postgresClient, { schema })

    // Cache the connection with metadata for lifecycle management
    tenantDatabaseCache.set(tenantId, {
      db: tenantDb,
      client: postgresClient,
      createdAt: new Date(),
    })

    logger.info('Tenant database connection cached', { tenantId })

    return tenantDb
  } catch (error) {
    logger.error('Error getting tenant database', {
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

/**
 * Close a tenant database connection
 * Useful for cleanup or when tenant is deleted
 * 
 * @param tenantId - The tenant ID to close connection for
 */
export async function closeTenantDatabase(tenantId: string) {
  const cached = tenantDatabaseCache.get(tenantId)
  if (cached) {
    try {
      await cached.client.end()
      tenantDatabaseCache.delete(tenantId)
      logger.info('Closed tenant database connection', { tenantId })
    } catch (error) {
      logger.error('Error closing tenant database connection', {
        tenantId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

/**
 * Close all tenant database connections
 * Useful for application shutdown
 */
export async function closeAllTenantDatabases() {
  const tenantIds = Array.from(tenantDatabaseCache.keys())
  logger.info('Closing all tenant database connections', { count: tenantIds.length })

  for (const tenantId of tenantIds) {
    await closeTenantDatabase(tenantId)
  }

  logger.info('All tenant database connections closed')
}

/**
 * Build connection string for tenant database
 * 
 * Supports two modes:
 * 1. Dynamic: Uses environment variables to build connection string
 *    Format: postgresql://user:password@host:port/sim_${tenantId}
 * 
 * 2. Static mapping: Uses environment variables with tenant-specific passwords
 *    Format: POSTGRES_TENANT1_HOST, POSTGRES_TENANT1_PASSWORD, etc.
 * 
 * @param tenantId - The tenant ID
 * @returns Connection string for the tenant
 */
function buildTenantDatabaseUrl(tenantId: string): string {
  const mode = process.env.POSTGRES_MODE || 'dynamic'

  if (mode === 'static') {
    // Static mapping mode for known tenants
    const tenantKey = getTenantKey(tenantId)
    const host = process.env[`POSTGRES_${tenantKey}_HOST`]
    const password = process.env[`POSTGRES_${tenantKey}_PASSWORD`]
    const user = process.env[`POSTGRES_${tenantKey}_USER`] || process.env.POSTGRES_USER || 'postgres'
    const port = process.env[`POSTGRES_${tenantKey}_PORT`] || process.env.POSTGRES_PORT || '5432'

    if (!host || !password) {
      throw new Error(
        `Missing configuration for tenant ${tenantId}. ` +
        `Set POSTGRES_${tenantKey}_HOST and POSTGRES_${tenantKey}_PASSWORD`
      )
    }

    const dbName = getDatabaseName(tenantId)
    return `postgresql://${user}:${password}@${host}:${port}/${dbName}`
  }

  // Default: Dynamic mode
  // Build from common environment variables
  const host = process.env.POSTGRES_HOST
  const user = process.env.POSTGRES_USER || 'postgres'
  const password = process.env.POSTGRES_PASSWORD
  const port = process.env.POSTGRES_PORT || '5432'

  if (!host || !password) {
    throw new Error(
      'Missing PostgreSQL configuration. ' +
      'Set POSTGRES_HOST and POSTGRES_PASSWORD environment variables'
    )
  }

  const dbName = getDatabaseName(tenantId)
  return `postgresql://${user}:${password}@${host}:${port}/${dbName}`
}

/**
 * Get tenant-specific database name
 * 
 * @param tenantId - The tenant ID from ModelFlow
 * @returns Database name in format: sim_${tenantId}
 * 
 * Example:
 * - Input: "6940fe29284471286882fbf1"
 * - Output: "sim_6940fe29284471286882fbf1"
 */
function getDatabaseName(tenantId: string): string {
  // Sanitize tenant ID for database name (alphanumeric and hyphens only)
  const sanitized = tenantId.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase()
  return `sim_${sanitized}`
}

/**
 * Convert tenant ID to uppercase key for environment variable lookup
 * Uses first 8 characters of tenant ID for env var naming
 * 
 * @param tenantId - The tenant ID
 * @returns Uppercase tenant identifier for env var naming
 * 
 * Example:
 * - Input: "6940fe29284471286882fbf1"
 * - Output: "6940FE29"
 */
function getTenantKey(tenantId: string): string {
  return tenantId.substring(0, 8).toUpperCase()
}

/**
 * Get all cached tenant IDs
 * Useful for monitoring/debugging
 * 
 * @returns Array of cached tenant IDs
 */
export function getCachedTenantIds(): string[] {
  return Array.from(tenantDatabaseCache.keys())
}

/**
 * Get cache statistics
 * Useful for monitoring connection pool health
 * 
 * @returns Object with cache statistics
 */
export function getTenantCacheStats() {
  const entries = Array.from(tenantDatabaseCache.entries())
  return {
    totalConnections: entries.length,
    tenants: entries.map(([tenantId, conn]) => ({
      tenantId,
      createdAt: conn.createdAt,
      uptime: Date.now() - conn.createdAt.getTime(),
    })),
  }
}
