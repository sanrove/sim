/**
 * Tenant Context for Multi-Tenant Database Routing
 * 
 * This provides request-scoped tenant isolation without modifying route files.
 * Uses a simple module-level store that should be set at the start of each request.
 * 
 * IMPORTANT: This relies on Node.js single-threaded execution model.
 * Each request should call setCurrentTenant() before any DB operations.
 */

// We use a Map to store tenant context per "request ID" or similar identifier
// For simpler cases, we can use a single variable (works in serverless where each invocation is isolated)
let _currentTenantDb: any = null
let _currentTenantId: string | null = null
let _masterDb: any = null

/**
 * Initialize the master database reference
 * Called once during module initialization
 */
export function initMasterDb(masterDb: any): void {
  _masterDb = masterDb
}

/**
 * Set the current tenant for this request context
 * @param tenantId - The tenant ID, or null to use master DB
 * @param tenantDb - The tenant database instance
 */
export function setCurrentTenant(tenantId: string | null, tenantDb: any | null): void {
  _currentTenantId = tenantId
  _currentTenantDb = tenantDb
}

/**
 * Clear the current tenant context
 * Call this at the end of request handling if needed
 */
export function clearCurrentTenant(): void {
  _currentTenantId = null
  _currentTenantDb = null
}

/**
 * Get the current tenant ID
 */
export function getCurrentTenantId(): string | null {
  return _currentTenantId
}

/**
 * Get the appropriate database for the current context
 * Returns tenant DB if set, otherwise master DB
 */
export function getCurrentDb(): any {
  return _currentTenantDb ?? _masterDb
}

/**
 * Check if a tenant context is currently active
 */
export function hasTenantContext(): boolean {
  return _currentTenantDb !== null
}
