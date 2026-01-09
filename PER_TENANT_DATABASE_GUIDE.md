# Per-Tenant Database Implementation - Complete Guide

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│ ModelFlow (Tenant: 6940fe29284471286882fbf1)                │
│ User: demo-test@ethana.ai                                   │
└────────────────────┬────────────────────────────────────────┘
                     │ SSO Token
                     ↓
┌─────────────────────────────────────────────────────────────┐
│ Sim - SSO Handler                                           │
│ 1. Validate JWT token                                       │
│ 2. Create user in MASTER DB (for better-auth)              │
│ 3. Create user in TENANT DB (same ID)                      │
│ 4. Create organization in both DBs                         │
│ 5. Create member relationships in both DBs                 │
│ 6. Create session in MASTER DB only                        │
└─────────────────────────────────────────────────────────────┘
                     │
        ┌────────────┴─────────────┐
        │                          │
        ↓                          ↓
┌──────────────────┐    ┌──────────────────────┐
│ Master Database  │    │ Tenant Database      │
│ simstudio        │    │ sim_6940fe29...      │
├──────────────────┤    ├──────────────────────┤
│ • user           │    │ • user               │
│ • session ✓      │    │ • organization       │
│ • organization   │    │ • member             │
│ • member         │    │ • workspace ✓        │
└──────────────────┘    │ • workflow ✓         │
                        │ • permissions ✓      │
                        └──────────────────────┘
```

## Why Dual-Database Approach?

### Master Database (`simstudio`)

- **Purpose**: Authentication and session management
- **Used by**: better-auth for session validation
- **Contains**: Users, sessions, organization references
- **Why needed**: Better-auth can only connect to ONE database

### Tenant Database (`sim_{tenantId}`)

- **Purpose**: Data isolation per tenant
- **Used by**: Application logic (workspaces, workflows, agents)
- **Contains**: Workspaces, workflows, agents, all tenant-specific data
- **Why needed**: Complete data isolation, independent backups

## Setup Instructions

### 1. Create Tenant Database

**Option A: Using PowerShell Script**

```powershell
cd C:\Users\sidha\werp-new\sim
.\setup-tenant-db.ps1 -TenantId "6940fe29284471286882fbf1"
```

**Option B: Manual Setup**

1. Open PostgreSQL client (pgAdmin, DBeaver, or command line)
2. Create database:

   ```sql
   CREATE DATABASE sim_6940fe29284471286882fbf1;
   ```

3. Run migrations:
   ```powershell
   cd C:\Users\sidha\werp-new\sim\packages\db
   $env:DATABASE_URL="postgresql://postgres:postgres@localhost:5432/sim_6940fe29284471286882fbf1"
   bun run db:push
   ```

### 2. Verify Setup

Check both databases exist:

```sql
-- List all databases
SELECT datname FROM pg_database WHERE datname LIKE 'sim%';

-- Should show:
-- simstudio (master)
-- sim_6940fe29284471286882fbf1 (tenant)
```

### 3. Restart Sim

```powershell
cd C:\Users\sidha\werp-new\sim\apps\sim
bun run dev
```

### 4. Test SSO Flow

1. Open ModelFlow: http://localhost:3000
2. Login with: demo-test@ethana.ai
3. Click "Agent Builder"
4. Should redirect to: http://localhost:5863/agents ✓

## How It Works

### SSO Authentication Flow

1. **ModelFlow generates token**:

   ```json
   {
     "email": "demo-test@ethana.ai",
     "tenantId": "6940fe29284471286882fbf1"
   }
   ```

2. **Sim receives SSO request**:

   - Validates token
   - Extracts tenantId
   - Connects to master DB: `simstudio`
   - Connects to tenant DB: `sim_6940fe29284471286882fbf1`

3. **Creates/updates in MASTER DB**:

   ```sql
   INSERT INTO user (id, email, name) VALUES (...);
   INSERT INTO organization (id, name) VALUES (..., 'ModelFlow-6940fe29...');
   INSERT INTO member (userId, organizationId) VALUES (...);
   INSERT INTO session (userId, token) VALUES (...); -- For better-auth
   ```

4. **Creates/updates in TENANT DB**:

   ```sql
   INSERT INTO user (id, email, name) VALUES (...); -- Same ID as master!
   INSERT INTO organization (id, name) VALUES (...); -- Same ID as master!
   INSERT INTO member (userId, organizationId) VALUES (...);
   ```

5. **Sets session cookie**:
   - Cookie: `better-auth.session_token`
   - Better-auth validates from MASTER DB

### Workspace API Flow

1. **User requests workspaces**: `GET /api/workspaces`

2. **Better-auth validates session**:

   - Reads session from MASTER DB ✓
   - Returns userId and organizationId

3. **Extract tenantId**:

   ```javascript
   const org = await masterDb.query.organization.findFirst(...)
   const tenantId = org.name.replace('ModelFlow-', '')
   // tenantId = "6940fe29284471286882fbf1"
   ```

4. **Connect to tenant database**:

   ```javascript
   const tenantDb = await getTenantDatabase(tenantId);
   // Connects to: sim_6940fe29284471286882fbf1
   ```

5. **Query workspaces**:
   ```sql
   SELECT workspace.* FROM workspace
   JOIN permissions ON permissions.workspaceId = workspace.id
   WHERE permissions.userId = '...'
   ```

## Data Synchronization

### IDs Must Match

**Critical**: User IDs and Organization IDs MUST be the same in both databases:

```javascript
// ✓ CORRECT
Master DB:  user.id = "abc-123"
Tenant DB:  user.id = "abc-123"  // Same ID!

// ✗ WRONG
Master DB:  user.id = "abc-123"
Tenant DB:  user.id = "xyz-789"  // Different ID = broken!
```

### What's in Each Database

**Master Database (simstudio)**:

- ✓ All users (cross-tenant)
- ✓ All sessions
- ✓ Organization metadata
- ❌ No workspaces
- ❌ No workflows

**Tenant Database (sim\_{tenantId})**:

- ✓ Tenant's users (duplicate with same IDs)
- ✓ Tenant's workspaces
- ✓ Tenant's workflows
- ✓ Tenant's agents
- ❌ No sessions (better-auth doesn't read from here)

## Adding New Tenants

When a new ModelFlow tenant needs Sim access:

1. **Get tenant ID** from ModelFlow database
2. **Create tenant database**:
   ```sql
   CREATE DATABASE sim_{tenantId};
   ```
3. **Run migrations**:
   ```powershell
   .\setup-tenant-db.ps1 -TenantId "{tenantId}"
   ```
4. **First SSO login** automatically creates user/org/member

## Benefits of This Approach

✅ **Complete Data Isolation**: Each tenant has own database  
✅ **Independent Backups**: Backup/restore per tenant  
✅ **Compliance Ready**: Physical separation for regulations  
✅ **Better-auth Compatible**: Sessions in master DB  
✅ **Scalable**: Can move tenant DBs to different servers

## Maintenance

### Backup Strategy

**Master Database**:

```bash
pg_dump -h localhost -U postgres simstudio > master_backup.sql
```

**Tenant Database**:

```bash
pg_dump -h localhost -U postgres sim_6940fe29284471286882fbf1 > tenant_backup.sql
```

### Schema Updates

When schema changes:

1. Update schema.ts
2. Run migrations on MASTER:
   ```bash
   DATABASE_URL="...simstudio" bun run db:push
   ```
3. Run migrations on ALL tenant databases:
   ```bash
   foreach ($tenant in $tenants) {
     DATABASE_URL="...sim_$tenant" bun run db:push
   }
   ```

## Troubleshooting

### SSO fails with "User not found"

- Check user exists in MASTER DB
- Check session exists in MASTER DB
- Better-auth only reads from master!

### Workspace page blank

- Check tenant database exists
- Check user/org/member exist in TENANT DB
- Check IDs match between master and tenant

### "Database does not exist"

- Run setup script for that tenant
- Verify DATABASE_URL in .env

## Code Changes Made

### Files Modified

1. **sim/apps/sim/app/api/auth/ethana-sso/route.ts**

   - Restored `getTenantDatabase()` import
   - Updated `handleSSO()` to create in both databases
   - Session creation only in master DB

2. **sim/apps/sim/app/api/workspaces/route.ts**

   - Restored `getTenantDatabase()` import
   - Updated all functions to use tenant DB for workspaces
   - Extract tenantId from organization name

3. **sim/packages/db/tenant-db.ts**
   - Already configured for per-tenant connections
   - Connection pooling for each tenant

### Files Created

1. **sim/create-tenant-databases.sql** - SQL script for manual setup
2. **sim/setup-tenant-db.ps1** - Automated setup script
3. **sim/PER_TENANT_DATABASE_GUIDE.md** - This documentation

## Conclusion

You now have **true per-tenant database isolation** with full compatibility with better-auth. Each ModelFlow tenant gets their own PostgreSQL database while authentication remains centralized in the master database.
