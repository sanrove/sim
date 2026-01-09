import postgres from 'postgres';

async function createTenantDB() {
  const sql = postgres('postgresql://postgres:your_password@localhost:5432/simstudio');
  
  try {
    await sql`CREATE DATABASE sim_6940fe29284471286882fbf1`;
    console.log('Database created successfully');
  } catch (err) {
    console.error('Error creating database:', err.message);
  } finally {
    sql.end();
  }
}

createTenantDB();