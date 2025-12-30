# PowerShell script to setup per-tenant databases
# Usage: .\setup-tenant-db.ps1 -TenantId "6940fe29284471286882fbf1"

param(
    [Parameter(Mandatory=$true)]
    [string]$TenantId
)

$ErrorActionPreference = "Stop"

$dbName = "sim_$TenantId"
$postgresPassword = "postgres"  # Change this to your actual password
$postgresUser = "postgres"
$postgresHost = "localhost"
$postgresPort = "5432"

Write-Host "==================================" -ForegroundColor Cyan
Write-Host "Setting up tenant database: $dbName" -ForegroundColor Cyan
Write-Host "==================================" -ForegroundColor Cyan

# Step 1: Create the database
Write-Host "`n[1/3] Creating database $dbName..." -ForegroundColor Yellow
$env:PGPASSWORD = $postgresPassword
try {
    psql -h $postgresHost -U $postgresUser -d postgres -c "CREATE DATABASE $dbName;" 2>&1 | Out-Null
    Write-Host "✓ Database created successfully" -ForegroundColor Green
} catch {
    Write-Host "⚠ Database might already exist (this is OK)" -ForegroundColor Yellow
}

# Step 2: Run migrations on the tenant database
Write-Host "`n[2/3] Running migrations on tenant database..." -ForegroundColor Yellow
$originalDatabaseUrl = $env:DATABASE_URL
$env:DATABASE_URL = "postgresql://${postgresUser}:${postgresPassword}@${postgresHost}:${postgresPort}/${dbName}"

try {
    Set-Location -Path "$PSScriptRoot\packages\db"
    bun run db:push
    Write-Host "✓ Migrations completed successfully" -ForegroundColor Green
} catch {
    Write-Host "✗ Migration failed: $_" -ForegroundColor Red
    $env:DATABASE_URL = $originalDatabaseUrl
    exit 1
} finally {
    $env:DATABASE_URL = $originalDatabaseUrl
}

# Step 3: Verify tables were created
Write-Host "`n[3/3] Verifying tables..." -ForegroundColor Yellow
$env:PGPASSWORD = $postgresPassword
try {
    $tables = psql -h $postgresHost -U $postgresUser -d $dbName -t -c "\dt" | Where-Object { $_.Trim() -ne "" }
    $tableCount = ($tables | Measure-Object).Count
    Write-Host "✓ Created $tableCount tables in $dbName" -ForegroundColor Green
} catch {
    Write-Host "⚠ Could not verify tables" -ForegroundColor Yellow
}

Write-Host "`n==================================" -ForegroundColor Cyan
Write-Host "✓ Tenant database setup complete!" -ForegroundColor Green
Write-Host "==================================" -ForegroundColor Cyan
Write-Host "`nDatabase: $dbName" -ForegroundColor White
Write-Host "Tenant ID: $TenantId" -ForegroundColor White
Write-Host "`nYou can now restart Sim and login with ModelFlow SSO." -ForegroundColor White
