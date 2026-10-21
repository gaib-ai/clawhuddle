import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { getDb } from '../db/index.js';
import { assertApiAuthSecret, verifyApiToken, type ApiTokenAudience } from '@clawhuddle/shared';
import type { User, OrgMember } from '@clawhuddle/shared';

// Extend Fastify request with our custom properties
declare module 'fastify' {
  interface FastifyRequest {
    currentUser?: User;
    orgId?: string;
    orgMember?: OrgMember;
  }
}

/** Shared secret the web app signs API tokens with. Checked once at startup (index.ts). */
export function getApiAuthSecret(): string {
  const secret = process.env.API_AUTH_SECRET;
  assertApiAuthSecret(secret);
  return secret;
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
}

async function verifiedSubject(request: FastifyRequest, aud: ApiTokenAudience): Promise<string | null> {
  const token = bearerToken(request);
  if (!token) return null;
  const claims = await verifyApiToken(token, aud, getApiAuthSecret());
  return claims?.sub ?? null;
}

// Plugin: verifies the bearer API token minted by the web app, decorates request.currentUser
export const authPlugin = fp(async (app: FastifyInstance) => {
  app.decorateRequest('currentUser', undefined);

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = await verifiedSubject(request, 'user');
    if (!userId) {
      return reply.status(401).send({ error: 'unauthorized', message: 'Not authenticated' });
    }

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as User | undefined;
    if (!user) {
      return reply.status(401).send({ error: 'unauthorized', message: 'User not found' });
    }

    if (user.status === 'disabled') {
      return reply.status(403).send({ error: 'forbidden', message: 'Account is disabled' });
    }

    request.currentUser = user;
  });
});

// Prehandler: only the web server (holding API_AUTH_SECRET) may call internal routes
export async function requireInternal(request: FastifyRequest, reply: FastifyReply) {
  if (!(await verifiedSubject(request, 'internal'))) {
    return reply.status(401).send({ error: 'unauthorized', message: 'Internal endpoint' });
  }
}

// Plugin: extracts :orgId from URL, validates membership, decorates request.orgId + request.orgMember
// Must be registered AFTER authPlugin (it depends on request.currentUser)
export const orgPlugin = fp(async (app: FastifyInstance) => {
  // Register authPlugin first so request.currentUser is available
  await app.register(authPlugin);

  app.decorateRequest('orgId', undefined);
  app.decorateRequest('orgMember', undefined);

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const orgId = (request.params as any)?.orgId;
    if (!orgId) {
      return reply.status(400).send({ error: 'bad_request', message: 'Organization ID required' });
    }

    const db = getDb();
    const org = db.prepare('SELECT id FROM organizations WHERE id = ?').get(orgId);
    if (!org) {
      return reply.status(404).send({ error: 'not_found', message: 'Organization not found' });
    }

    const member = db.prepare(
      `SELECT om.*, u.email, u.name, u.avatar_url
       FROM org_members om
       JOIN users u ON u.id = om.user_id
       WHERE om.org_id = ? AND om.user_id = ? AND om.status = 'active'`
    ).get(orgId, request.currentUser!.id) as OrgMember | undefined;

    if (!member) {
      return reply.status(403).send({ error: 'forbidden', message: 'Not a member of this organization' });
    }

    request.orgId = orgId;
    request.orgMember = member;
  });
});

// Prehandler factory: checks orgMember.role against allowed roles
export function requireRole(...roles: string[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.orgMember) {
      return reply.status(403).send({ error: 'forbidden', message: 'Not a member' });
    }
    if (!roles.includes(request.orgMember.role)) {
      return reply.status(403).send({ error: 'forbidden', message: 'Insufficient permissions' });
    }
  };
}
