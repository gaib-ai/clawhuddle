import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getDb } from '../../db/index.js';
import { requireRole } from '../../middleware/auth.js';
import {
  createGateway,
  deployGateway,
  stopGateway,
  startGateway,
  restartGateway,
  removeGateway,
  redeployAllGateways,
  getGatewayStatus,
  getOrgContainerIds,
  approvePairing,
  listPairingRequests,
  listDeviceRequests,
  approveDeviceRequest,
  rejectDeviceRequest,
  collectDeviceRequests,
  syncGatewayConfig,
  GatewayLimitError,
} from '../../services/gateway.js';
import {
  containerNameFor,
  effectiveGatewayLimit,
  findGatewayRow,
  listMemberGateways,
  listOrgGateways,
  setGatewayState,
  summarizeGateway,
  type GatewayRow,
} from '../../services/gateway-store.js';
import { PROVIDER_IDS, MODEL_IDS, type CreateGatewayRequest, type UpdateGatewayRequest } from '@clawhuddle/shared';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by requireGatewayAccess: the instance :gatewayId names. */
    gateway?: GatewayRow;
  }
}

const MAX_LABEL_LENGTH = 60;
const CHANNELS = ['telegram', 'discord', 'slack'];

/** Error message for an invalid label, or null. */
function labelProblem(label: unknown): string | null {
  if (label === undefined || label === null) return null;
  if (typeof label !== 'string') return 'Label must be a string';
  if (label.length > MAX_LABEL_LENGTH) return `Label must be at most ${MAX_LABEL_LENGTH} characters`;
  if (/[\u0000-\u001f\u007f]/.test(label)) return 'Label must be a single line of text';
  return null;
}

function maskToken(token: string): string {
  if (token.length <= 10) return '***';
  return token.slice(0, 6) + '...' + token.slice(-4);
}

/**
 * Loads :gatewayId onto request.gateway. A member may act on their own
 * instances; owners and admins on anyone's — except that, as for role changes,
 * an admin cannot `release` (open) an owner's gateway.
 */
function requireGatewayAccess(opts: { release?: boolean } = {}) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const { gatewayId } = request.params as { gatewayId: string };
    const row = findGatewayRow(request.orgId!, gatewayId);
    if (!row) {
      return reply.status(404).send({ error: 'not_found', message: 'Gateway not found' });
    }
    const me = request.orgMember!;
    if (row.member_id !== me.id) {
      if (!['owner', 'admin'].includes(me.role)) {
        return reply.status(403).send({ error: 'forbidden', message: 'Insufficient permissions' });
      }
      if (opts.release && row.member_role === 'owner' && me.role !== 'owner') {
        return reply.status(403).send({ error: 'forbidden', message: "Only owners can open an owner's gateway" });
      }
    }
    request.gateway = row;
  };
}

function sendGatewayError(reply: FastifyReply, err: any) {
  if (err instanceof GatewayLimitError) {
    return reply.status(403).send({ error: err.code, message: err.message, limit: err.limit, current: err.current });
  }
  return reply.status(400).send({ error: 'gateway_error', message: err.message });
}

export async function orgGatewayRoutes(app: FastifyInstance) {
  app.decorateRequest('gateway', undefined);

  // Every instance in the org (admin+ only). Tokens are never part of a list;
  // an admin gets one at a time from GET .../gateways/:gatewayId/access.
  app.get(
    '/api/orgs/:orgId/gateways',
    { preHandler: requireRole('owner', 'admin') },
    async (request) => {
      const orgId = request.orgId!;
      const db = getDb();
      const users = new Map(
        (db
          .prepare('SELECT om.id AS member_id, u.email, u.name FROM org_members om JOIN users u ON u.id = om.user_id WHERE om.org_id = ?')
          .all(orgId) as { member_id: string; email: string; name: string | null }[]).map((u) => [u.member_id, u]),
      );
      const containerIds = await getOrgContainerIds(orgId);
      const data = listOrgGateways(orgId).map((g) => ({
        ...summarizeGateway(g),
        email: users.get(g.member_id)?.email,
        name: users.get(g.member_id)?.name ?? null,
        container_id: containerIds.get(containerNameFor(g)) ?? null,
      }));
      return { data };
    },
  );

  // Own instances, with the bearer token the Control UI needs, and the limit.
  app.get('/api/orgs/:orgId/me/gateways', async (request) => {
    const me = request.orgMember!;
    const { limit, current } = effectiveGatewayLimit(request.orgId!, me.id);
    return { data: listMemberGateways(me.id), limit, current };
  });

  // Browsers waiting to be let into one of my instances' Control UI. Pairing is
  // never approved automatically; this list (and the per-instance routes below)
  // is how a device gets in.
  app.get('/api/orgs/:orgId/me/device-requests', async (request) => {
    return collectDeviceRequests(listMemberGateways(request.orgMember!.id));
  });

  // Same across the whole org (admin+), each request tagged with its member.
  app.get(
    '/api/orgs/:orgId/device-requests',
    { preHandler: requireRole('owner', 'admin') },
    async (request) => {
      const orgId = request.orgId!;
      const users = new Map(
        (getDb()
          .prepare('SELECT om.id AS member_id, u.email, u.name FROM org_members om JOIN users u ON u.id = om.user_id WHERE om.org_id = ?')
          .all(orgId) as { member_id: string; email: string; name: string | null }[]).map((u) => [u.member_id, u]),
      );
      return collectDeviceRequests(listOrgGateways(orgId), (g) => ({
        ...summarizeGateway(g),
        email: users.get(g.member_id)?.email,
        name: users.get(g.member_id)?.name ?? null,
      }));
    },
  );

  // Member self-service: add an instance (within the limit) and deploy it
  app.post<{ Body: CreateGatewayRequest }>(
    '/api/orgs/:orgId/me/gateways',
    async (request, reply) => {
      const labelError = labelProblem(request.body?.label);
      if (labelError) return reply.status(400).send({ error: 'validation', message: labelError });
      try {
        const result = await createGateway(request.orgId!, request.orgMember!.id, { label: request.body?.label?.trim() || null });
        return reply.status(201).send({ data: result });
      } catch (err: any) {
        return sendGatewayError(reply, err);
      }
    },
  );

  // Add an instance for a member (admin+ only); same limit as self-service
  app.post<{ Params: { orgId: string; memberId: string }; Body: CreateGatewayRequest }>(
    '/api/orgs/:orgId/gateways/members/:memberId',
    { preHandler: requireRole('owner', 'admin') },
    async (request, reply) => {
      const { orgId, memberId } = request.params;
      const member = getDb().prepare('SELECT id FROM org_members WHERE id = ? AND org_id = ?').get(memberId, orgId);
      if (!member) {
        return reply.status(404).send({ error: 'not_found', message: 'Member not found' });
      }
      const labelError = labelProblem(request.body?.label);
      if (labelError) return reply.status(400).send({ error: 'validation', message: labelError });
      try {
        const result = await createGateway(orgId, memberId, { label: request.body?.label?.trim() || null });
        return reply.status(201).send({ data: result });
      } catch (err: any) {
        return sendGatewayError(reply, err);
      }
    },
  );

  // Redeploy every instance in the org
  app.post<{ Params: { orgId: string } }>(
    '/api/orgs/:orgId/gateways/redeploy-all',
    { preHandler: requireRole('owner', 'admin') },
    async (request, reply) => {
      try {
        return { data: await redeployAllGateways(request.params.orgId) };
      } catch (err: any) {
        return sendGatewayError(reply, err);
      }
    },
  );

  // --- per-instance routes: own instance, or admin+ ---------------------------

  type GatewayParams = { Params: { orgId: string; gatewayId: string } };
  const own = { preHandler: requireGatewayAccess() };

  app.get<GatewayParams>('/api/orgs/:orgId/gateways/:gatewayId/status', own, async (request, reply) => {
    try {
      return { data: await getGatewayStatus(request.orgId!, request.gateway!.id) };
    } catch (err: any) {
      return sendGatewayError(reply, err);
    }
  });

  // restart = reboot the container as is; redeploy = rebuild it from the
  // current platform config (keys, skills, channels, model).
  for (const [action, run] of [
    ['start', startGateway],
    ['stop', stopGateway],
    ['restart', restartGateway],
    ['redeploy', deployGateway],
  ] as const) {
    app.post<GatewayParams>(`/api/orgs/:orgId/gateways/:gatewayId/${action}`, own, async (request, reply) => {
      try {
        return { data: await run(request.orgId!, request.gateway!.id) };
      } catch (err: any) {
        return sendGatewayError(reply, err);
      }
    });
  }

  app.delete<GatewayParams>('/api/orgs/:orgId/gateways/:gatewayId', own, async (request, reply) => {
    try {
      return { data: await removeGateway(request.orgId!, request.gateway!.id) };
    } catch (err: any) {
      return sendGatewayError(reply, err);
    }
  });

  // Label and per-instance primary-provider pin (null = follow the member/org)
  app.patch<GatewayParams & { Body: UpdateGatewayRequest }>(
    '/api/orgs/:orgId/gateways/:gatewayId',
    own,
    async (request, reply) => {
      const body = request.body || {};
      const patch: { label?: string | null; primary_provider?: string | null; primary_model?: string | null } = {};
      if ('label' in body) {
        const labelError = labelProblem(body.label);
        if (labelError) return reply.status(400).send({ error: 'validation', message: labelError });
        patch.label = body.label?.trim() || null;
      }
      if ('primary_provider' in body) {
        const next = body.primary_provider ?? null;
        if (next !== null && !PROVIDER_IDS.includes(next)) {
          return reply.status(400).send({ error: 'validation', message: `Unknown provider: ${next}` });
        }
        patch.primary_provider = next;
      }
      if ('primary_model' in body) {
        const next = body.primary_model ?? null;
        if (next !== null && !MODEL_IDS.includes(next)) {
          return reply.status(400).send({ error: 'validation', message: `Unknown model: ${next}` });
        }
        patch.primary_model = next;
        // A model names its provider, so the older provider pin would only
        // shadow it on clear; drop it unless this request sets it explicitly.
        if (!('primary_provider' in body)) patch.primary_provider = null;
      }
      if (Object.keys(patch).length === 0) {
        return reply.status(400).send({ error: 'validation', message: 'No updatable fields provided' });
      }

      setGatewayState(request.gateway!.id, patch);
      // The primary provider is baked into agents.defaults at config-generation
      // time; rewrite the file now, the change takes effect on the next restart.
      if ('primary_provider' in patch || 'primary_model' in patch) syncGatewayConfig(request.orgId!, request.gateway!.id);

      return { data: summarizeGateway(findGatewayRow(request.orgId!, request.gateway!.id)!) };
    },
  );

  // Hand an admin the credentials to open an instance's Control UI. Gateway
  // tokens are never part of a list; they are only released here, one instance
  // at a time, on an explicit request that is logged. Admins can't open an
  // owner's gateway (same rule as role changes); owners can open any.
  app.get<GatewayParams>(
    '/api/orgs/:orgId/gateways/:gatewayId/access',
    { preHandler: [requireRole('owner', 'admin'), requireGatewayAccess({ release: true })] },
    async (request, reply) => {
      const g = request.gateway!;
      request.log.info(
        { orgId: request.orgId, gatewayId: g.id, memberId: g.member_id, targetUserId: g.user_id, adminUserId: request.currentUser!.id },
        'admin opened member gateway',
      );
      reply.header('Cache-Control', 'no-store');
      return {
        data: {
          gateway_token: g.token,
          gateway_subdomain: g.subdomain,
          gateway_port: g.port,
        },
      };
    },
  );

  // --- channels: bot tokens are per instance ----------------------------------

  app.get<GatewayParams>('/api/orgs/:orgId/gateways/:gatewayId/channels', own, async (request) => {
    const rows = getDb()
      .prepare('SELECT channel, bot_token, created_at, updated_at FROM gateway_channels WHERE gateway_id = ?')
      .all(request.gateway!.id) as { channel: string; bot_token: string; created_at: string; updated_at: string }[];
    return {
      data: rows.map((r) => ({
        channel: r.channel,
        configured: true,
        masked_token: maskToken(r.bot_token),
        updated_at: r.updated_at,
      })),
    };
  });

  // Redeploys the instance if it is up, so the token change takes effect.
  // Failures are swallowed: the token itself was saved.
  const redeployIfUp = async (orgId: string, g: GatewayRow) => {
    if (g.status !== 'running' && g.status !== 'deploying') return;
    try {
      await deployGateway(orgId, g.id);
    } catch {
      // Redeploy failed, but the channel change was saved
    }
  };

  app.put<GatewayParams & { Params: { channel: string }; Body: { bot_token: string; app_token?: string } }>(
    '/api/orgs/:orgId/gateways/:gatewayId/channels/:channel',
    own,
    async (request, reply) => {
      const { channel } = request.params;
      const { bot_token, app_token } = request.body || ({} as { bot_token?: string; app_token?: string });

      if (!bot_token || !bot_token.trim()) {
        return reply.status(400).send({ error: 'validation', message: 'bot_token is required' });
      }
      if (!CHANNELS.includes(channel)) {
        return reply.status(400).send({ error: 'validation', message: `Invalid channel: ${channel}` });
      }
      // Slack DMs require Socket Mode, which needs an app-level token (xapp-…) too.
      if (channel === 'slack' && (!app_token || !app_token.trim())) {
        return reply.status(400).send({
          error: 'validation',
          message: 'Slack requires app_token (xapp-…) for Socket Mode / DMs',
        });
      }
      const appToken = channel === 'slack' ? app_token!.trim() : null;

      getDb().prepare(
        `INSERT INTO gateway_channels (gateway_id, channel, bot_token, app_token, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(gateway_id, channel) DO UPDATE SET bot_token = ?, app_token = ?, updated_at = datetime('now')`,
      ).run(request.gateway!.id, channel, bot_token.trim(), appToken, bot_token.trim(), appToken);

      await redeployIfUp(request.orgId!, request.gateway!);
      return { data: { channel, configured: true } };
    },
  );

  app.delete<GatewayParams & { Params: { channel: string } }>(
    '/api/orgs/:orgId/gateways/:gatewayId/channels/:channel',
    own,
    async (request, reply) => {
      const { channel } = request.params;
      const result = getDb()
        .prepare('DELETE FROM gateway_channels WHERE gateway_id = ? AND channel = ?')
        .run(request.gateway!.id, channel);
      if (result.changes === 0) {
        return reply.status(404).send({ error: 'not_found', message: 'Channel not configured' });
      }
      await redeployIfUp(request.orgId!, request.gateway!);
      return { data: { channel, configured: false } };
    },
  );

  app.post<GatewayParams & { Params: { channel: string }; Body: { code: string } }>(
    '/api/orgs/:orgId/gateways/:gatewayId/channels/:channel/pair',
    own,
    async (request, reply) => {
      const { channel } = request.params;
      const code = request.body?.code;
      if (!code || !code.trim()) {
        return reply.status(400).send({ error: 'validation', message: 'Pairing code is required' });
      }
      try {
        const output = await approvePairing(request.orgId!, request.gateway!.id, channel, code.trim());
        return { data: { channel, approved: true, output } };
      } catch (err: any) {
        return reply.status(400).send({ error: 'pairing_error', message: err.message });
      }
    },
  );

  app.get<GatewayParams & { Params: { channel: string } }>(
    '/api/orgs/:orgId/gateways/:gatewayId/channels/:channel/pair',
    own,
    async (request, reply) => {
      const { channel } = request.params;
      try {
        const output = await listPairingRequests(request.orgId!, request.gateway!.id, channel);
        return { data: { channel, output } };
      } catch (err: any) {
        return reply.status(400).send({ error: 'pairing_error', message: err.message });
      }
    },
  );

  // ── Device pairing: who may open this instance's Control UI ──

  app.get<GatewayParams>('/api/orgs/:orgId/gateways/:gatewayId/devices', own, async (request, reply) => {
    try {
      return { data: await listDeviceRequests(request.orgId!, request.gateway!.id) };
    } catch (err: any) {
      return reply.status(400).send({ error: 'device_error', message: err.message });
    }
  });

  for (const action of ['approve', 'reject'] as const) {
    app.post<GatewayParams & { Params: { requestId: string } }>(
      `/api/orgs/:orgId/gateways/:gatewayId/devices/:requestId/${action}`,
      own,
      async (request, reply) => {
        const { requestId } = request.params;
        const g = request.gateway!;
        try {
          const run = action === 'approve' ? approveDeviceRequest : rejectDeviceRequest;
          await run(request.orgId!, g.id, requestId);
        } catch (err: any) {
          return reply.status(400).send({ error: 'device_error', message: err.message });
        }
        request.log.info(
          { orgId: request.orgId, gatewayId: g.id, memberId: g.member_id, requestId, by: request.orgMember!.id },
          `device pairing ${action}d`,
        );
        return { data: { requestId, [action === 'approve' ? 'approved' : 'rejected']: true } };
      },
    );
  }
}
