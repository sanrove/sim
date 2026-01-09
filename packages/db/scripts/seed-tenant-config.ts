import { db } from '@sim/db';
import { tenantConfig } from '@sim/db/schema';
import { randomUUID } from 'crypto';

async function seedTenantConfig() {
  const tenantMappings = [
    {
      id: randomUUID(),
      tenantId: '6953a481f938be4b37f4f351',
      baseUrl: 'http://localhost:5432',
      description: 'SimStudio 1',
    },
    {
      id: randomUUID(),
      tenantId: '6953a482f938be4b37f4f352',
      baseUrl: 'http://localhost:5433',
      description: 'SimStudio 2',
    },
    {
      id: randomUUID(),
      tenantId: '6953a483f938be4b37f4f353',
      baseUrl: 'http://localhost:5434',
      description: 'SimStudio 3',
    },
  ];

  for (const mapping of tenantMappings) {
    await db.insert(tenantConfig).values(mapping).onConflictDoNothing();
  }

  console.log('Tenant configuration seeded successfully');
}

seedTenantConfig().catch(console.error);