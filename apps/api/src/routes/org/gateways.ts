import { FastifyInstance } from 'fastify';
import { getDb } from '../../db/index.js';
import { requireRole } from '../../middleware/auth.js';
import {
  provisionGateway,
  stopGateway,
  startGateway,
  removeGateway,
  redeployGateway,
  redeployAllGateways,
  getGatewayStatus,
} from '../../services/gateway.js';

export async function orgGatewayRoutes(app: FastifyInstance) {
  // Provision gateway for member (admin+ only)
  app.post<{ Params: { orgId: string; memberId: string } }>(
    '/api/orgs/:orgId/gateways/members/:memberId',
    { preHandler: requireRole('owner', 'admin') },
    async (request, reply) => {
      const { orgId, memberId } = request.params;
      const db = getDb();
      const member = db.prepare('SELECT * FROM org_members WHERE id = ? AND org_id = ?').get(memberId, orgId);
      if (!member) {
        return reply.status(404).send({ error: 'not_found', message: 'Member not found' });
      }

      try {
        const result = await provisionGateway(orgId, memberId);
        return reply.status(201).send({ data: result });
      } catch (err: any) {
        return reply.status(400).send({ error: 'gateway_error', message: err.message });
      }
    }
  );

  // Remove gateway
  app.delete<{ Params: { orgId: string; memberId: string } }>(
    '/api/orgs/:orgId/gateways/members/:memberId',
    { preHandler: requireRole('owner', 'admin') },
    async (request, reply) => {
      const { orgId, memberId } = request.params;
      try {
        const result = await removeGateway(orgId, memberId);
        return { data: result };
      } catch (err: any) {
        return reply.status(400).send({ error: 'gateway_error', message: err.message });
      }
    }
  );

  // Start gateway
  app.post<{ Params: { orgId: string; memberId: string } }>(
    '/api/orgs/:orgId/gateways/members/:memberId/start',
    { preHandler: requireRole('owner', 'admin') },
    async (request, reply) => {
      const { orgId, memberId } = request.params;
      try {
        const result = await startGateway(orgId, memberId);
        return { data: result };
      } catch (err: any) {
        return reply.status(400).send({ error: 'gateway_error', message: err.message });
      }
    }
  );

  // Stop gateway
  app.post<{ Params: { orgId: string; memberId: string } }>(
    '/api/orgs/:orgId/gateways/members/:memberId/stop',
    { preHandler: requireRole('owner', 'admin') },
    async (request, reply) => {
      const { orgId, memberId } = request.params;
      try {
        const result = await stopGateway(orgId, memberId);
        return { data: result };
      } catch (err: any) {
        return reply.status(400).send({ error: 'gateway_error', message: err.message });
      }
    }
  );

  // Redeploy all gateways
  app.post<{ Params: { orgId: string } }>(
    '/api/orgs/:orgId/gateways/redeploy-all',
    { preHandler: requireRole('owner', 'admin') },
    async (request, reply) => {
      const { orgId } = request.params;
      try {
        const result = await redeployAllGateways(orgId);
        return { data: result };
      } catch (err: any) {
        return reply.status(400).send({ error: 'gateway_error', message: err.message });
      }
    }
  );

  // Redeploy gateway
  app.post<{ Params: { orgId: string; memberId: string } }>(
    '/api/orgs/:orgId/gateways/members/:memberId/redeploy',
    { preHandler: requireRole('owner', 'admin') },
    async (request, reply) => {
      const { orgId, memberId } = request.params;
      try {
        const result = await redeployGateway(orgId, memberId);
        return { data: result };
      } catch (err: any) {
        return reply.status(400).send({ error: 'gateway_error', message: err.message });
      }
    }
  );

  // Member self-stop (any org member can stop their own gateway)
  app.post<{ Params: { orgId: string } }>(
    '/api/orgs/:orgId/gateways/me/stop',
    async (request, reply) => {
      const { orgId } = request.params;
      const memberId = request.orgMember!.id;
      try {
        const result = await stopGateway(orgId, memberId);
        return { data: result };
      } catch (err: any) {
        return reply.status(400).send({ error: 'gateway_error', message: err.message });
      }
    }
  );

  // Member self-deploy (any org member can deploy/restart their own gateway):
  // first deploy provisions; afterwards redeploys (also covers restart from stopped)
  app.post<{ Params: { orgId: string } }>(
    '/api/orgs/:orgId/gateways/me/deploy',
    async (request, reply) => {
      const { orgId } = request.params;
      const member = request.orgMember!;
      try {
        const result = member.gateway_token
          ? await redeployGateway(orgId, member.id)
          : await provisionGateway(orgId, member.id);
        return reply.status(member.gateway_token ? 200 : 201).send({ data: result });
      } catch (err: any) {
        return reply.status(400).send({ error: 'gateway_error', message: err.message });
      }
    }
  );

  // Hand an admin the credentials to open a member's Control UI. Gateway tokens
  // are never part of the members list; they are only released here, one member
  // at a time, on an explicit request that is logged. Admins can't open an
  // owner's gateway (same rule as role changes); owners can open any.
  app.get<{ Params: { orgId: string; memberId: string } }>(
    '/api/orgs/:orgId/gateways/members/:memberId/access',
    { preHandler: requireRole('owner', 'admin') },
    async (request, reply) => {
      const { orgId, memberId } = request.params;
      const db = getDb();
      const member = db
        .prepare(
          'SELECT user_id, role, gateway_token, gateway_subdomain, gateway_port FROM org_members WHERE id = ? AND org_id = ?',
        )
        .get(memberId, orgId) as
        | { user_id: string; role: string; gateway_token: string | null; gateway_subdomain: string | null; gateway_port: number | null }
        | undefined;
      if (!member) {
        return reply.status(404).send({ error: 'not_found', message: 'Member not found' });
      }
      if (member.role === 'owner' && request.orgMember!.role !== 'owner') {
        return reply.status(403).send({ error: 'forbidden', message: "Only owners can open an owner's gateway" });
      }
      if (!member.gateway_token) {
        return reply.status(400).send({ error: 'gateway_error', message: 'No gateway deployed' });
      }

      request.log.info(
        { orgId, memberId, targetUserId: member.user_id, adminUserId: request.currentUser!.id },
        'admin opened member gateway',
      );
      reply.header('Cache-Control', 'no-store');
      return {
        data: {
          gateway_token: member.gateway_token,
          gateway_subdomain: member.gateway_subdomain,
          gateway_port: member.gateway_port,
        },
      };
    }
  );

  // Get gateway status
  app.get<{ Params: { orgId: string; memberId: string } }>(
    '/api/orgs/:orgId/gateways/members/:memberId/status',
    { preHandler: requireRole('owner', 'admin') },
    async (request, reply) => {
      const { orgId, memberId } = request.params;
      try {
        const result = await getGatewayStatus(orgId, memberId);
        return { data: result };
      } catch (err: any) {
        return reply.status(400).send({ error: 'gateway_error', message: err.message });
      }
    }
  );
}
