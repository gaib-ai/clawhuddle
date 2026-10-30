import { getDb, closeDb } from './index.js';
import { applyMigrations } from './apply-migrations.js';
import dotenv from 'dotenv';
dotenv.config({ path: '../../.env' });

applyMigrations(getDb());
closeDb();
console.log('Database migrated successfully.');
