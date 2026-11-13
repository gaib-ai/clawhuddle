import { FastifyInstance } from 'fastify';
import { getDb } from '../../db/index.js';
import { v4 as uuid } from 'uuid';
import crypto from 'node:crypto';
import { requireRole } from '../../middleware/auth.js';
import { sendInvitationEmail } from '../../services/email.js';
import { getOrgContainerIds, removeGateway, syncAuthProfilesForUser } from '../../services/gateway.js';
import { containerNameFor, effectiveGatewayLimit, listMemberGateways, listOrgGateways, summarizeGateway } from '../../services/gateway-store.js';
import type { InviteMemberRequest, UpdateMemberRequest } from '@clawhuddle/shared';
import { DEFAULT_MAX_MEMBERS, PROVIDER_IDS } from '@clawhuddle/shared';

// gateway_token is a bearer credential for that member's slot-1 gateway, so
// member responses only carry the caller's own. Admins fetch another member's
// one at a time from GET .../gateways/:gatewayId/access.
function withoutOthersGatewayToken<T extends { user_id: string; gateway_token?: string | null }>(
  member: T,
  viewerUserId: string,
): T {
  return member.user_id === viewerUserId ? member : { ...member, gateway_token: null };
}

/** null clears the override; otherwise an integer >= 1. Returns an error message or null. */
export function maxGatewaysProblem(value: unknown): string | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || (value as number) < 1) return 'max_gateways must be an integer >= 1 or null';
  return null;
}

export const ROLES = ['owner', 'admin', 'maintainer', 'member'];
const STATUSES = ['active', 'disabled'];

export async function orgMemberRoutes(app: FastifyInstance) {
  // List members
  app.get('/api/orgs/:orgId/members', async (request) => {
    const db = getDb();
    const members = db.prepare(
      `SELECT om.*, u.email, u.name, u.avatar_url
       FROM org_members om
       JOIN users u ON u.id = om.user_id
       WHERE om.org_id = ?
       ORDER BY om.joined_at`
    ).all(request.orgId!) as any[];

    // Attach each member's instances (tokens stripped) with their Docker
    // container IDs, plus the limit that applies to them. container_id on the
    // member itself is the slot-1 instance's, as before instances existed.
    const containerIds = await getOrgContainerIds(request.orgId!);
    const byMember = new Map<string, any[]>();
    for (const g of listOrgGateways(request.orgId!)) {
      const list = byMember.get(g.member_id) ?? [];
      list.push({ ...summarizeGateway(g), container_id: containerIds.get(containerNameFor(g)) ?? null });
      byMember.set(g.member_id, list);
    }
    for (const m of members) {
      m.gateways = byMember.get(m.id) ?? [];
      m.gateway_count = m.gateways.length;
      m.effective_max_gateways = effectiveGatewayLimit(request.orgId!, m.id).limit;
      m.container_id = m.gateways.find((g: any) => g.slot === 1)?.container_id ?? null;
    }

    // A maintainer only sees the plain members they look after, and themselves.
    const viewerId = request.currentUser!.id;
    const visible = request.orgMember!.role === 'maintainer'
      ? members.filter((m) => m.role === 'member' || m.user_id === viewerId)
      : members;

    return { data: visible.map((m) => withoutOthersGatewayToken(m, viewerId)) };
  });

  // Invite member (admin+ only)
  app.post<{ Body: InviteMemberRequest }>(
    '/api/orgs/:orgId/members/invite',
    { preHandler: requireRole('owner', 'admin') },
    async (request, reply) => {
      const { email, role } = request.body;
      if (!email) {
        return reply.status(400).send({ error: 'validation', message: 'email is required' });
      }
      // The body type says admin|member, but it's client input — check it
      const memberRole: string = role || 'member';
      if (!ROLES.includes(memberRole)) {
        return reply.status(400).send({ error: 'validation', message: `role must be one of: ${ROLES.join(', ')}` });
      }
      // Only owners can grant owner — on invites too, or an admin could invite a
      // second account as owner and take over the org
      if (memberRole === 'owner' && request.orgMember!.role !== 'owner') {
        return reply.status(403).send({ error: 'forbidden', message: 'Only owners can invite owners' });
      }

      const db = getDb();

      // Check if already a member
      const existing = db.prepare(
        `SELECT om.id FROM org_members om
         JOIN users u ON u.id = om.user_id
         WHERE om.org_id = ? AND u.email = ?`
      ).get(request.orgId!, email);

      if (existing) {
        return reply.status(409).send({ error: 'conflict', message: 'User is already a member' });
      }

      // Check for pending invitation
      const pendingInvite = db.prepare(
        "SELECT id FROM invitations WHERE org_id = ? AND email = ? AND status = 'pending'"
      ).get(request.orgId!, email);

      if (pendingInvite) {
        return reply.status(409).send({ error: 'conflict', message: 'Invitation already pending for this email' });
      }

      // Enforce member limit (configurable via env var)
      const limit = Number(process.env.MAX_MEMBERS_PER_ORG) || DEFAULT_MAX_MEMBERS;
      const { count: currentCount } = db.prepare(
        `SELECT COUNT(*) as count FROM (
           SELECT user_id FROM org_members WHERE org_id = ?
           UNION ALL
           SELECT email FROM invitations WHERE org_id = ? AND status = 'pending'
         )`
      ).get(request.orgId!, request.orgId!) as { count: number };

      if (currentCount >= limit) {
        return reply.status(403).send({
          error: 'member_limit',
          message: `Member limit reached (${currentCount}/${limit}). Adjust MAX_MEMBERS_PER_ORG to increase.`,
          limit,
          current: currentCount,
        });
      }

      const id = uuid();
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days

      db.prepare(
        'INSERT INTO invitations (id, org_id, email, role, token, invited_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(id, request.orgId!, email, memberRole, token, request.currentUser!.id, expiresAt);

      // Send invitation email (non-blocking — don't fail the API if email fails)
      const org = db.prepare('SELECT name FROM organizations WHERE id = ?').get(request.orgId!) as any;
      sendInvitationEmail({
        to: email,
        orgName: org?.name || 'your team',
        invitedByName: request.currentUser!.name || request.currentUser!.email,
        role: memberRole,
        token,
      }).catch((err) => {
        console.error('[email] Failed to send invitation:', err);
      });

      const invitation = db.prepare('SELECT * FROM invitations WHERE id = ?').get(id);
      return reply.status(201).send({ data: invitation });
    }
  );

  // List pending invitations (admin+ only)
  app.get(
    '/api/orgs/:orgId/members/invitations',
    { preHandler: requireRole('owner', 'admin') },
    async (request) => {
      const db = getDb();
      const invitations = db.prepare(
        `SELECT i.*, u.name as invited_by_name
         FROM invitations i
         JOIN users u ON u.id = i.invited_by
         WHERE i.org_id = ? AND i.status = 'pending'
         ORDER BY i.created_at DESC`
      ).all(request.orgId!);

      return { data: invitations };
    }
  );

  // Cancel invitation (admin+ only)
  app.delete<{ Params: { orgId: string; id: string } }>(
    '/api/orgs/:orgId/members/invitations/:id',
    { preHandler: requireRole('owner', 'admin') },
    async (request, reply) => {
      const { id } = request.params;
      const db = getDb();

      const invitation = db.prepare(
        "SELECT * FROM invitations WHERE id = ? AND org_id = ? AND status = 'pending'"
      ).get(id, request.orgId!) as any;

      if (!invitation) {
        return reply.status(404).send({ error: 'not_found', message: 'Invitation not found' });
      }

      db.prepare("UPDATE invitations SET status = 'expired' WHERE id = ?").run(id);
      return { data: { id, cancelled: true } };
    }
  );

  // Update member role/status (admin+ only)
  app.patch<{ Params: { orgId: string; memberId: string }; Body: UpdateMemberRequest }>(
    '/api/orgs/:orgId/members/:memberId',
    { preHandler: requireRole('owner', 'admin') },
    async (request, reply) => {
      const { memberId } = request.params;
      const { role, status } = request.body;
      const hasMaxGateways = 'max_gateways' in request.body;

      const db = getDb();
      const member = db.prepare(
        'SELECT * FROM org_members WHERE id = ? AND org_id = ?'
      ).get(memberId, request.orgId!) as any;

      if (!member) {
        return reply.status(404).send({ error: 'not_found', message: 'Member not found' });
      }
      if (hasMaxGateways) {
        const problem = maxGatewaysProblem(request.body.max_gateways);
        if (problem) return reply.status(400).send({ error: 'validation', message: problem });
      }

      // Only owners can change roles to/from owner
      if ((role === 'owner' || member.role === 'owner') && request.orgMember!.role !== 'owner') {
        return reply.status(403).send({ error: 'forbidden', message: 'Only owners can manage owner role' });
      }
      if (role !== undefined && !ROLES.includes(role)) {
        return reply.status(400).send({ error: 'validation', message: `role must be one of: ${ROLES.join(', ')}` });
      }
      if (status !== undefined && !STATUSES.includes(status)) {
        return reply.status(400).send({ error: 'validation', message: `status must be one of: ${STATUSES.join(', ')}` });
      }

      const updates: string[] = [];
      const values: any[] = [];

      if (role !== undefined) {
        updates.push('role = ?');
        values.push(role);
      }
      if (status !== undefined) {
        updates.push('status = ?');
        values.push(status);
      }
      if (hasMaxGateways) {
        updates.push('max_gateways = ?');
        values.push(request.body.max_gateways ?? null);
      }

      if (updates.length > 0) {
        values.push(memberId);
        db.prepare(`UPDATE org_members SET ${updates.join(', ')} WHERE id = ?`).run(...values);
      }

      const updated = db.prepare(
        `SELECT om.*, u.email, u.name, u.avatar_url
         FROM org_members om
         JOIN users u ON u.id = om.user_id
         WHERE om.id = ?`
      ).get(memberId) as any;

      return { data: withoutOthersGatewayToken(updated, request.currentUser!.id) };
    }
  );

  // Remove member (admin+ only)
  app.delete<{ Params: { orgId: string; memberId: string } }>(
    '/api/orgs/:orgId/members/:memberId',
    { preHandler: requireRole('owner', 'admin') },
    async (request, reply) => {
      const { memberId } = request.params;
      const db = getDb();

      const member = db.prepare(
        'SELECT * FROM org_members WHERE id = ? AND org_id = ?'
      ).get(memberId, request.orgId!) as any;

      if (!member) {
        return reply.status(404).send({ error: 'not_found', message: 'Member not found' });
      }

      if (member.role === 'owner') {
        return reply.status(400).send({ error: 'validation', message: 'Cannot remove org owner' });
      }

      // Containers, workspaces and port-forward files first: the row's cascade
      // only takes the DB rows with it.
      for (const g of listMemberGateways(memberId)) {
        try {
          await removeGateway(request.orgId!, g.id);
        } catch (err: any) {
          request.log.error({ gatewayId: g.id, err: err.message }, 'failed to remove gateway while removing member');
        }
      }

      db.prepare('DELETE FROM org_members WHERE id = ?').run(memberId);
      return { data: { id: memberId, removed: true } };
    }
  );

  // Get own primary provider (any member). Returns the personal override
  // (null = follow org default) alongside the org default for display.
  app.get('/api/orgs/:orgId/me/primary-provider', async (request) => {
    const db = getDb();
    const org = db
      .prepare('SELECT primary_provider FROM organizations WHERE id = ?')
      .get(request.orgId!) as { primary_provider: string | null };
    return {
      data: {
        primary_provider: (request.orgMember as any).primary_provider ?? null,
        org_primary_provider: org?.primary_provider ?? null,
      },
    };
  });

  // Set own primary provider (any member). null clears the override so the
  // member follows the org default again.
  app.put<{ Body: { primary_provider?: string | null } }>(
    '/api/orgs/:orgId/me/primary-provider',
    async (request, reply) => {
      const next = request.body?.primary_provider ?? null;
      if (next !== null && !PROVIDER_IDS.includes(next)) {
        return reply.status(400).send({ error: 'validation', message: `Unknown provider: ${next}` });
      }

      const db = getDb();
      db.prepare('UPDATE org_members SET primary_provider = ? WHERE id = ?')
        .run(next, request.orgMember!.id);

      // Primary provider is baked into agents.defaults in openclaw.json at
      // config-generation time — rewrite every instance this member owns that
      // does not pin its own; the change takes effect on the next restart.
      syncAuthProfilesForUser(request.orgId!, (request.orgMember as any).user_id);

      return { data: { primary_provider: next } };
    }
  );
}
