# Local PostgreSQL Setup - Complete

## ✅ Databases Created

### 1. Master Database
- **Name**: `simstudio`
- **Purpose**: Authentication and session management (better-auth)
- **URL**: `postgresql://postgres:postgres@localhost:5432/simstudio`
- **Tables**: 53 tables
- **Contains**: Users, sessions, organizations (for auth only)

### 2. Tenant Database
- **Name**: `sim_6940fe29284471286882fbf1`
- **Tenant ID**: `6940fe29284471286882fbf1`
- **Purpose**: Tenant-specific data (workspaces, workflows, agents)
- **URL**: `postgresql://postgres:postgres@localhost:5432/sim_6940fe29284471286882fbf1`
- **Tables**: 53 tables
- **Contains**: All application data for this tenant

## 🐳 Docker Container

**Container Name**: `sim-postgres`
**Image**: `pgvector/pgvector:pg17`
**Port**: `5432` (mapped to localhost:5432)
**Status**: ✅ Running and Healthy

### Container Commands

```powershell
# View logs
docker logs sim-postgres

# Stop container
docker-compose -f docker-compose.db.yml down

# Start container
docker-compose -f docker-compose.db.yml up -d

# Access PostgreSQL shell
docker exec -it sim-postgres psql -U postgres -d simstudio
```

## 📝 Environment Configuration

Your `.env` files have been updated:

### sim/apps/sim/.env
```
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/simstudio"
POSTGRES_HOST=localhost
POSTGRES_PASSWORD=postgres
```

### sim/packages/db/.env
```
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/simstudio"
```

## 🔧 Common Commands

### Run Migrations on Master Database
```powershell
cd C:\Users\sidha\werp-new\sim\packages\db
bun run db:migrate
```

### Run Migrations on Tenant Database
```powershell
$env:DATABASE_URL="postgresql://postgres:postgres@localhost:5432/sim_6940fe29284471286882fbf1"
cd C:\Users\sidha\werp-new\sim\packages\db
bun run db:push
```

### Create Additional Tenant Database
```powershell
# Replace with your tenant ID
$tenantId = "your_tenant_id_here"
docker exec sim-postgres psql -U postgres -d postgres -c "CREATE DATABASE sim_$tenantId;"
docker exec sim-postgres psql -U postgres -d "sim_$tenantId" -c "CREATE EXTENSION IF NOT EXISTS vector;"
$env:DATABASE_URL="postgresql://postgres:postgres@localhost:5432/sim_$tenantId"
cd C:\Users\sidha\werp-new\sim\packages\db
bun run db:push
```

### Check Database Tables
```powershell
# Master database
docker exec sim-postgres psql -U postgres -d simstudio -c "\dt"

# Tenant database
docker exec sim-postgres psql -U postgres -d sim_6940fe29284471286882fbf1 -c "\dt"
```

## 🚀 Next Steps

1. **Start Sim Application**:
   ```powershell
   cd C:\Users\sidha\werp-new\sim\apps\sim
   bun run dev
   ```

2. **Access**: http://localhost:5863

3. **Login**: Use ModelFlow SSO with tenant ID `6940fe29284471286882fbf1`

## 🔐 Database Credentials

- **Username**: `postgres`
- **Password**: `postgres`
- **Host**: `localhost`
- **Port**: `5432`

## 📊 Database Tools

You can connect to these databases using:
- **pgAdmin**: http://localhost:5050 (if you have it installed)
- **DBeaver**: Community Edition
- **Command Line**: `psql -U postgres -h localhost -d simstudio`

## 🆘 Troubleshooting

### If database is not responding:
```powershell
docker restart sim-postgres
```

### If you need to reset everything:
```powershell
docker-compose -f docker-compose.db.yml down -v
docker-compose -f docker-compose.db.yml up -d
# Then re-run migrations
```

### Check database connection:
```powershell
docker exec sim-postgres pg_isready -U postgres
```
