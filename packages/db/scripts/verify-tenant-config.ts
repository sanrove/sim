import { db } from '@sim/db';
import { tenantConfig } from '@sim/db/schema';

async function verifyTenantConfig() {
  const result = await db.select().from(tenantConfig);
  console.table(result);
}

verifyTenantConfig().catch(console.error);