-- SQL Script to Create Per-Tenant Databases
-- Run this in your PostgreSQL client

-- Create tenant database for ModelFlow tenant: 6940fe29284471286882fbf1
CREATE DATABASE sim_6940fe29284471286882fbf1;

-- You can add more tenant databases as needed
-- Example for additional tenants:
-- CREATE DATABASE sim_a1b2c3d4e5f6g7h8i9j0k1l2;
-- CREATE DATABASE sim_x9y8z7w6v5u4t3s2r1q0p9o8;

-- Note: After creating each database, you need to run migrations on it:
-- 1. Update DATABASE_URL in sim/packages/db/.env
-- 2. Run: cd sim/packages/db && bun run db:push
