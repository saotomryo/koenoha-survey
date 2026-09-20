import pg from 'pg';
import { postgresConfig, PostgresStore, databaseError } from '../lib/postgres.js';

// Reads connection settings without switching the application's storage driver.
let pool;
try {
  const initialize = process.argv.includes('--initialize');
  const env = { ...process.env, DATABASE_URL: initialize ? process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL : process.env.DATABASE_URL };
  pool = new pg.Pool(postgresConfig(env));
  pool.on('error', () => {});
  await pool.query('SELECT 1');
  console.log('PostgreSQL connection: OK');
  const store = new PostgresStore(pool);
  if (initialize) {
    await store.initialize();
    console.log('Koenoha tables: initialized (existing data preserved)');
  } else {
    const result = await pool.query("SELECT to_regclass('public.koenoha_surveys') IS NOT NULL AND to_regclass('public.koenoha_responses') IS NOT NULL AS ready");
    console.log(`Koenoha tables: ${result.rows[0].ready ? 'ready' : 'not initialized'}`);
  }
} catch (error) {
  console.error(databaseError(error).message);
  process.exitCode = 1;
} finally { await pool?.end(); }
