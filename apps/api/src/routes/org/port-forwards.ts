import { FastifyInstance } from 'fastify';
import { v4 as uuid } from 'uuid';
import { getDb } from '../../db/index.js';
import { requireRole } from '../../middleware/auth.js';
import {
  writePortForwardConfig,
  removePortForwardConfig,
  portForwardHostname,
  type PortForward,
} from '../../services/port-forward.js';

const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export async function orgPortForwardRoutes(app: FastifyInstance) {
  // List port forwards (admin+ only)
  app.get(
    '/api/orgs/:orgId/port-forwards',
    { preHandler: requireRole('owner', 'admin') },
    async (request) => {
      const db = getDb();
      const rows = db.prepare(
        `SELECT pf.*, u.email AS member_email, u.name AS member_name, om.gateway_status
         FROM port_forwards pf
         JOIN org_members om ON om.id = pf.member_id
         JOIN users u ON u.id = om.user_id
         WHERE pf.org_id = ?
         ORDER BY pf.created_at DESC`
      ).all(request.orgId!) as any[];

      for (const row of rows) {
        row.hostname = portForwardHostname(row.subdomain);
      }
      return { data: rows };
    }
  );

  // Create port forward (admin+ only)
  app.post<{ Body: { memberId?: string; subdomain?: string; port?: number; description?: string } }>(
    '/api/orgs/:orgId/port-forwards',
    { preHandler: requireRole('owner', 'admin') },
    async (request, reply) => {
      const { memberId, subdomain, port, description } = request.body || {};

      if (!memberId || !subdomain || !port) {
        return reply.status(400).send({ error: 'validation', message: 'memberId, subdomain and port are required' });
      }
      const normalized = subdomain.trim().toLowerCase();
      if (!SUBDOMAIN_RE.test(normalized)) {
        return reply.status(400).send({
          error: 'validation',
          message: 'Subdomain must be lowercase letters, digits and hyphens (max 63 chars)',
        });
      }
      const portNum = Number(port);
      if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
        return reply.status(400).send({ error: 'validation', message: 'Port must be an integer between 1 and 65535' });
      }

      const db = getDb();
      const member = db
        .prepare('SELECT id FROM org_members WHERE id = ? AND org_id = ?')
        .get(memberId, request.orgId!);
      if (!member) {
        return reply.status(404).send({ error: 'not_found', message: 'Member not found' });
      }

      // Subdomain must not collide with another forward or a gateway subdomain
      const existingForward = db.prepare('SELECT id FROM port_forwards WHERE subdomain = ?').get(normalized);
      const existingGateway = db.prepare('SELECT id FROM org_members WHERE gateway_subdomain = ?').get(normalized);
      if (existingForward || existingGateway) {
        return reply.status(409).send({ error: 'conflict', message: 'Subdomain is already in use' });
      }

      const pf: PortForward = {
        id: uuid(),
        org_id: request.orgId!,
        member_id: memberId,
        subdomain: normalized,
        port: portNum,
        description: description?.trim() || null,
        created_at: new Date().toISOString(),
      };

      try {
        writePortForwardConfig(pf);
      } catch (err: any) {
        return reply.status(400).send({ error: 'port_forward_error', message: err.message });
      }

      db.prepare(
        'INSERT INTO port_forwards (id, org_id, member_id, subdomain, port, description) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(pf.id, pf.org_id, pf.member_id, pf.subdomain, pf.port, pf.description);

      return reply.status(201).send({ data: { ...pf, hostname: portForwardHostname(pf.subdomain) } });
    }
  );

  // Update port forward (admin+ only)
  app.patch<{
    Params: { orgId: string; forwardId: string };
    Body: { memberId?: string; subdomain?: string; port?: number; description?: string | null };
  }>(
    '/api/orgs/:orgId/port-forwards/:forwardId',
    { preHandler: requireRole('owner', 'admin') },
    async (request, reply) => {
      const { forwardId } = request.params;
      const db = getDb();
      const existing = db
        .prepare('SELECT * FROM port_forwards WHERE id = ? AND org_id = ?')
        .get(forwardId, request.orgId!) as PortForward | undefined;
      if (!existing) {
        return reply.status(404).send({ error: 'not_found', message: 'Port forward not found' });
      }

      const { memberId, subdomain, port, description } = request.body || {};
      const updated: PortForward = { ...existing };

      if (memberId !== undefined) {
        const member = db
          .prepare('SELECT id FROM org_members WHERE id = ? AND org_id = ?')
          .get(memberId, request.orgId!);
        if (!member) {
          return reply.status(404).send({ error: 'not_found', message: 'Member not found' });
        }
        updated.member_id = memberId;
      }

      if (subdomain !== undefined) {
        const normalized = subdomain.trim().toLowerCase();
        if (!SUBDOMAIN_RE.test(normalized)) {
          return reply.status(400).send({
            error: 'validation',
            message: 'Subdomain must be lowercase letters, digits and hyphens (max 63 chars)',
          });
        }
        const conflictForward = db
          .prepare('SELECT id FROM port_forwards WHERE subdomain = ? AND id != ?')
          .get(normalized, forwardId);
        const conflictGateway = db
          .prepare('SELECT id FROM org_members WHERE gateway_subdomain = ?')
          .get(normalized);
        if (conflictForward || conflictGateway) {
          return reply.status(409).send({ error: 'conflict', message: 'Subdomain is already in use' });
        }
        updated.subdomain = normalized;
      }

      if (port !== undefined) {
        const portNum = Number(port);
        if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
          return reply.status(400).send({ error: 'validation', message: 'Port must be an integer between 1 and 65535' });
        }
        updated.port = portNum;
      }

      if (description !== undefined) {
        updated.description = description?.trim() || null;
      }

      try {
        writePortForwardConfig(updated);
      } catch (err: any) {
        return reply.status(400).send({ error: 'port_forward_error', message: err.message });
      }

      db.prepare(
        'UPDATE port_forwards SET member_id = ?, subdomain = ?, port = ?, description = ? WHERE id = ?'
      ).run(updated.member_id, updated.subdomain, updated.port, updated.description, updated.id);

      return { data: { ...updated, hostname: portForwardHostname(updated.subdomain) } };
    }
  );

  // Delete port forward (admin+ only)
  app.delete<{ Params: { orgId: string; forwardId: string } }>(
    '/api/orgs/:orgId/port-forwards/:forwardId',
    { preHandler: requireRole('owner', 'admin') },
    async (request, reply) => {
      const { forwardId } = request.params;
      const db = getDb();
      const pf = db
        .prepare('SELECT * FROM port_forwards WHERE id = ? AND org_id = ?')
        .get(forwardId, request.orgId!) as PortForward | undefined;
      if (!pf) {
        return reply.status(404).send({ error: 'not_found', message: 'Port forward not found' });
      }

      removePortForwardConfig(pf.id);
      db.prepare('DELETE FROM port_forwards WHERE id = ?').run(pf.id);
      return { data: { deleted: true } };
    }
  );
}
