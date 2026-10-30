import { FastifyInstance } from 'fastify';
import { getDb } from '../db/index.js';
import { v4 as uuid } from 'uuid';
import { authPlugin } from '../middleware/auth.js';
import { deleteOrgGateways, syncAuthProfiles } from '../services/gateway.js';
import { PROVIDER_IDS, MODEL_IDS, providerForModel, type CreateOrgRequest, type UpdateOrgRequest } from '@clawhuddle/shared';
import { maxGatewaysProblem } from './org/members.js';

// Call deleteOrgGateways() first: it removes containers, workspaces and the
// port-forward files, which the cascades below cannot.
export function purgeOrgFromDb(db: any, orgId: string) {
  db.prepare('DELETE FROM invitations WHERE org_id = ?').run(orgId);
  db.prepare('DELETE FROM user_skills WHERE skill_id IN (SELECT id FROM skills WHERE org_id = ?)').run(orgId);
  db.prepare('DELETE FROM skills WHERE org_id = ?').run(orgId);
  db.prepare('DELETE FROM api_keys WHERE org_id = ?').run(orgId);
  db.prepare('UPDATE usage_logs SET org_id = NULL WHERE org_id = ?').run(orgId);
  db.prepare('DELETE FROM port_forwards WHERE org_id = ?').run(orgId);
  db.prepare('DELETE FROM org_members WHERE org_id = ?').run(orgId); // cascades gateways, gateway_channels, member_channels
  db.prepare('DELETE FROM organizations WHERE id = ?').run(orgId);
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

export async function orgRoutes(app: FastifyInstance) {
  // All routes here require auth
  await app.register(authPlugin);

  // List user's organizations
  app.get('/api/orgs', async (request) => {
    const db = getDb();
    const orgs = db.prepare(
      `SELECT o.*, om.role as member_role
       FROM organizations o
       JOIN org_members om ON om.org_id = o.id
       WHERE om.user_id = ? AND om.status = 'active'
       ORDER BY o.name`
    ).all(request.currentUser!.id);

    return { data: orgs };
  });

  // Create organization
  app.post<{ Body: CreateOrgRequest }>('/api/orgs', async (request, reply) => {
    const { name, slug: customSlug } = request.body;
    if (!name) {
      return reply.status(400).send({ error: 'validation', message: 'name is required' });
    }

    const db = getDb();
    const slug = customSlug || slugify(name);

    const existing = db.prepare('SELECT id FROM organizations WHERE slug = ?').get(slug);
    if (existing) {
      return reply.status(409).send({ error: 'conflict', message: 'Organization slug already taken' });
    }

    const orgId = uuid();
    const memberId = uuid();

    db.prepare('INSERT INTO organizations (id, name, slug) VALUES (?, ?, ?)').run(orgId, name, slug);
    db.prepare(
      "INSERT INTO org_members (id, org_id, user_id, role) VALUES (?, ?, ?, 'owner')"
    ).run(memberId, orgId, request.currentUser!.id);

    const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(orgId);
    return reply.status(201).send({ data: org });
  });

  // Update organization settings (admin/owner only): primary_provider, max_gateways_per_user.
  app.patch<{ Params: { orgId: string }; Body: UpdateOrgRequest }>(
    '/api/orgs/:orgId',
    async (request, reply) => {
      const { orgId } = request.params;
      const db = getDb();

      const membership = db
        .prepare(
          "SELECT role FROM org_members WHERE org_id = ? AND user_id = ? AND status = 'active'",
        )
        .get(orgId, request.currentUser!.id) as { role: string } | undefined;
      if (!membership || !['owner', 'admin'].includes(membership.role)) {
        return reply.status(403).send({ error: 'forbidden', message: 'Admin or owner access required' });
      }

      const updates: string[] = [];
      const params: any[] = [];

      if ('primary_provider' in request.body) {
        const next = request.body.primary_provider;
        if (next !== null && !PROVIDER_IDS.includes(next as string)) {
          return reply.status(400).send({ error: 'validation', message: `Unknown provider: ${next}` });
        }
        updates.push('primary_provider = ?');
        params.push(next ?? null);
        // The model pin belongs to the provider it was chosen under; a new
        // provider starts from its default unless the same request pins a model.
        if (!('primary_model' in request.body)) {
          updates.push('primary_model = NULL');
        }
      }

      if ('primary_model' in request.body) {
        const model = request.body.primary_model ?? null;
        if (model !== null) {
          if (!MODEL_IDS.includes(model)) {
            return reply.status(400).send({ error: 'validation', message: `Unknown model: ${model}` });
          }
          const provider = 'primary_provider' in request.body
            ? request.body.primary_provider
            : (db.prepare('SELECT primary_provider FROM organizations WHERE id = ?').get(orgId) as { primary_provider: string | null } | undefined)?.primary_provider;
          if (providerForModel(model)?.id !== provider) {
            return reply.status(400).send({ error: 'validation', message: `${model} is not a model of the pinned primary provider` });
          }
        }
        updates.push('primary_model = ?');
        params.push(model);
      }

      if ('max_gateways_per_user' in request.body) {
        const problem = maxGatewaysProblem(request.body.max_gateways_per_user ?? null);
        if (problem) {
          return reply.status(400).send({ error: 'validation', message: problem.replace('max_gateways', 'max_gateways_per_user') });
        }
        updates.push('max_gateways_per_user = ?');
        params.push(request.body.max_gateways_per_user ?? null);
      }

      if (updates.length === 0) {
        return reply.status(400).send({ error: 'validation', message: 'No updatable fields provided' });
      }

      params.push(orgId);
      db.prepare(`UPDATE organizations SET ${updates.join(', ')} WHERE id = ?`).run(...params);

      // Primary provider is baked into agents.defaults at config-generation time,
      // not read at runtime from a file — so changing it requires rewriting every
      // member's openclaw.json. auth-profiles.json hot-reload won't pick it up.
      if ('primary_provider' in request.body || 'primary_model' in request.body) syncAuthProfiles(orgId);

      const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(orgId);
      return { data: org };
    },
  );

  // Delete organization (admin/owner of that org only)
  app.delete<{ Params: { orgId: string } }>(
    '/api/orgs/:orgId',
    async (request, reply) => {
      const { orgId } = request.params;
      const db = getDb();

      const membership = db.prepare(
        "SELECT role FROM org_members WHERE org_id = ? AND user_id = ? AND status = 'active'"
      ).get(orgId, request.currentUser!.id) as any;

      if (!membership || !['owner', 'admin'].includes(membership.role)) {
        return reply.status(403).send({ error: 'forbidden', message: 'Admin or owner access required' });
      }

      const org = db.prepare('SELECT id FROM organizations WHERE id = ?').get(orgId);
      if (!org) {
        return reply.status(404).send({ error: 'not_found', message: 'Organization not found' });
      }

      await deleteOrgGateways(orgId);
      purgeOrgFromDb(db, orgId);

      return reply.status(200).send({ data: { deleted: true } });
    }
  );

}
