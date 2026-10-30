import Fastify from 'fastify';
import cors from '@fastify/cors';
import dotenv from 'dotenv';
dotenv.config({ path: '../../.env' });
import { authRoutes } from './routes/auth.js';
import { orgRoutes } from './routes/orgs.js';
import { orgPlugin, getApiAuthSecret } from './middleware/auth.js';
import { orgMemberRoutes } from './routes/org/members.js';
import { orgSkillRoutes } from './routes/org/skills.js';
import { orgApiKeyRoutes } from './routes/org/api-keys.js';
import { orgGatewayRoutes } from './routes/org/gateways.js';
import { orgUserSkillRoutes } from './routes/org/user-skills.js';
import { orgChatRoutes } from './routes/org/chat.js';
import { orgPortForwardRoutes } from './routes/org/port-forwards.js';
import { superAdminRoutes } from './routes/super-admin.js';
import { syncAllPortForwards } from './services/port-forward.js';

// Refuse to start without the secret API tokens are verified with
getApiAuthSecret();

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  credentials: true,
});

// Public / auth routes (no org context needed)
await app.register(authRoutes);

// Authed routes (authPlugin only, no org context)
await app.register(orgRoutes);

// Super admin routes
await app.register(superAdminRoutes);

// Org-scoped routes (orgPlugin = auth + membership check)
await app.register(async function orgScopedRoutes(instance) {
  await instance.register(orgPlugin);
  await instance.register(orgMemberRoutes);
  await instance.register(orgSkillRoutes);
  await instance.register(orgApiKeyRoutes);
  await instance.register(orgGatewayRoutes);
  await instance.register(orgUserSkillRoutes);
  await instance.register(orgChatRoutes);
  await instance.register(orgPortForwardRoutes);
});

// Regenerate traefik config files for stored port forwards
syncAllPortForwards();

app.get('/api/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

const port = Number(process.env.PORT) || 4000;
const host = process.env.HOST || '0.0.0.0';

await app.listen({ port, host });
console.log(`API server running on http://${host}:${port}`);
