import { FastifyInstance } from 'fastify';
import { getDb } from '../../db/index.js';
import { v4 as uuid } from 'uuid';
import { requireRole } from '../../middleware/auth.js';
import { PROVIDERS, PROVIDER_IDS, parseGoogleOAuthClient, type SetApiKeyRequest, type CredentialType } from '@clawhuddle/shared';
import { syncAuthProfiles, syncAuthProfilesForUser, secretStatusFor } from '../../services/gateway.js';
import { listMemberGateways, listOrgGateways, type GatewayRow } from '../../services/gateway-store.js';
import type { SecretStatusEntry } from '@clawhuddle/shared';

// WARNING: base64 is NOT real encryption — it only obscures keys in the DB.
// For production, replace with AES-GCM using an ENCRYPTION_KEY env variable.
function encodeKey(key: string): string {
  return Buffer.from(key).toString('base64');
}

function decodeKey(encoded: string): string {
  return Buffer.from(encoded, 'base64').toString('utf-8');
}

function maskKey(key: string): string {
  // A Google OAuth client is shown by its client id; the secret stays hidden.
  const client = parseGoogleOAuthClient(key);
  if (client) return `client ${client.client_id.split('-')[0]}-…`;
  if (key.length <= 8) return '****';
  return key.slice(0, 4) + '...' + key.slice(-4);
}

type ApiKeyRow = {
  id: string;
  provider: string;
  key_value: string;
  is_company_default: number;
  org_id: string;
  user_id: string | null;
  credential_type: string | null;
  default_model: string | null;
  priority: number | null;
  created_at: string;
};

/** Scope of an api_keys query: NULL user_id = org default, string = personal override. */
type Scope = { orgId: string; userId: string | null };

function scopeWhere(scope: Scope): { sql: string; params: any[] } {
  return scope.userId === null
    ? { sql: 'org_id = ? AND user_id IS NULL', params: [scope.orgId] }
    : { sql: 'org_id = ? AND user_id = ?', params: [scope.orgId, scope.userId] };
}

/** Sync gateway(s) after CRUD on this scope. */
function syncForScope(scope: Scope) {
  if (scope.userId === null) {
    // Org-default change affects every member without a personal override.
    syncAuthProfiles(scope.orgId);
  } else {
    syncAuthProfilesForUser(scope.orgId, scope.userId);
  }
}

function registerCrud(
  app: FastifyInstance,
  basePath: string,
  getScope: (req: any) => Scope,
  opts: { preHandler?: any; enforcePersonalOverridable?: boolean } = {},
) {
  const { preHandler, enforcePersonalOverridable } = opts;

  // List
  app.get(basePath, preHandler ? { preHandler } : {}, async (request) => {
    const scope = getScope(request);
    const db = getDb();
    const { sql, params } = scopeWhere(scope);
    const keys = db
      .prepare(`SELECT * FROM api_keys WHERE ${sql} ORDER BY provider, priority ASC, created_at DESC`)
      .all(...params) as ApiKeyRow[];

    return {
      data: keys.map((k) => ({
        id: k.id,
        provider: k.provider,
        key_masked: maskKey(decodeKey(k.key_value)),
        is_company_default: !!k.is_company_default,
        credential_type: (k.credential_type || 'api_key') as CredentialType,
        default_model: k.default_model || null,
        priority: k.priority ?? 0,
      })),
    };
  });

  // Create
  app.post<{ Body: SetApiKeyRequest }>(
    basePath,
    preHandler ? { preHandler } : {},
    async (request, reply) => {
      const scope = getScope(request);
      const { provider, key, credentialType, defaultModel } = request.body;
      if (!provider || !key) {
        return reply.status(400).send({ error: 'validation', message: 'provider and key are required' });
      }
      if (!PROVIDER_IDS.includes(provider)) {
        return reply.status(400).send({ error: 'validation', message: `Unknown provider: ${provider}` });
      }
      if (enforcePersonalOverridable) {
        const cfg = PROVIDERS.find((p) => p.id === provider);
        if (cfg?.personalOverridable === false) {
          return reply
            .status(403)
            .send({ error: 'forbidden', message: `Provider "${provider}" is managed at the organization level only` });
        }
      }
      if (PROVIDERS.find((p) => p.id === provider)?.kind === 'oauth-client' && !parseGoogleOAuthClient(key)) {
        return reply.status(400).send({
          error: 'validation',
          message: 'Paste the whole client_secret_….json from Google Cloud Console (needs client_id and client_secret)',
        });
      }
      const ct: CredentialType =
        credentialType === 'token' ? 'token' : credentialType === 'oauth' ? 'oauth' : 'api_key';

      const db = getDb();
      const { sql, params } = scopeWhere(scope);
      const maxRow = db
        .prepare(`SELECT MAX(priority) as max_p FROM api_keys WHERE provider = ? AND ${sql}`)
        .get(provider, ...params) as { max_p: number | null } | undefined;
      const nextPriority = (maxRow?.max_p ?? -1) + 1;

      const id = uuid();
      db.prepare(
        'INSERT INTO api_keys (id, provider, key_value, is_company_default, org_id, user_id, credential_type, default_model, priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        id,
        provider,
        encodeKey(key),
        scope.userId === null ? 1 : 0,
        scope.orgId,
        scope.userId,
        ct,
        defaultModel || null,
        nextPriority,
      );

      syncForScope(scope);

      return reply.status(201).send({
        data: {
          id,
          provider,
          key_masked: maskKey(key),
          is_company_default: scope.userId === null,
          credential_type: ct,
          default_model: defaultModel || null,
          priority: nextPriority,
        },
      });
    },
  );

  // Update default model
  app.patch<{ Params: { id: string }; Body: { defaultModel: string } }>(
    `${basePath}/:id`,
    preHandler ? { preHandler } : {},
    async (request, reply) => {
      const scope = getScope(request);
      const { id } = request.params;
      const { defaultModel } = request.body;
      const db = getDb();
      const { sql, params } = scopeWhere(scope);
      const result = db
        .prepare(`UPDATE api_keys SET default_model = ? WHERE id = ? AND ${sql}`)
        .run(defaultModel || null, id, ...params);
      if (result.changes === 0) {
        return reply.status(404).send({ error: 'not_found', message: 'API key not found' });
      }
      syncForScope(scope);
      return { data: { id, default_model: defaultModel || null } };
    },
  );

  // Delete
  app.delete<{ Params: { id: string } }>(
    `${basePath}/:id`,
    preHandler ? { preHandler } : {},
    async (request, reply) => {
      const scope = getScope(request);
      const { id } = request.params;
      const db = getDb();
      const { sql, params } = scopeWhere(scope);
      const result = db.prepare(`DELETE FROM api_keys WHERE id = ? AND ${sql}`).run(id, ...params);
      if (result.changes === 0) {
        return reply.status(404).send({ error: 'not_found', message: 'API key not found' });
      }
      syncForScope(scope);
      return { data: { id, deleted: true } };
    },
  );

  // Reorder
  app.put<{ Body: { provider: string; keyIds: string[] } }>(
    `${basePath}/reorder`,
    preHandler ? { preHandler } : {},
    async (request, reply) => {
      const scope = getScope(request);
      const { provider, keyIds } = request.body;
      if (!provider || !keyIds?.length) {
        return reply.status(400).send({ error: 'validation', message: 'provider and keyIds are required' });
      }
      const db = getDb();
      const { sql, params } = scopeWhere(scope);
      const existingIds = db
        .prepare(`SELECT id FROM api_keys WHERE provider = ? AND ${sql}`)
        .all(provider, ...params) as { id: string }[];
      const existingSet = new Set(existingIds.map((r) => r.id));
      if (keyIds.length !== existingIds.length || !keyIds.every((id) => existingSet.has(id))) {
        return reply.status(400).send({ error: 'validation', message: 'keyIds must match all keys for this provider' });
      }
      const updateStmt = db.prepare(`UPDATE api_keys SET priority = ? WHERE id = ? AND ${sql}`);
      const txn = db.transaction(() => {
        for (let i = 0; i < keyIds.length; i++) {
          updateStmt.run(i, keyIds[i], ...params);
        }
      });
      txn();
      syncForScope(scope);
      return { data: { provider, order: keyIds } };
    },
  );
}

export async function orgApiKeyRoutes(app: FastifyInstance) {
  // Organization defaults (admin-only)
  registerCrud(
    app,
    '/api/orgs/:orgId/api-keys',
    (req) => ({ orgId: req.orgId, userId: null }),
    { preHandler: requireRole('owner', 'admin') },
  );

  // Personal overrides (any active member)
  registerCrud(
    app,
    '/api/orgs/:orgId/me/api-keys',
    (req) => ({ orgId: req.orgId, userId: req.currentUser.id }),
    { enforcePersonalOverridable: true },
  );

  // Admin-managed per-member overrides. Same storage as a member's own
  // personal keys (user_id = that member) — no separate "locked" concept,
  // the member can still see/edit them. claw-proxy is NOT restricted here.
  const resolveTargetMember = async (request: any, reply: any) => {
    const memberId = request.params.memberId as string;
    const db = getDb();
    const row = db
      .prepare('SELECT user_id FROM org_members WHERE id = ? AND org_id = ?')
      .get(memberId, request.orgId) as { user_id: string } | undefined;
    if (!row) {
      return reply.status(404).send({ error: 'not_found', message: 'Member not found' });
    }
    request.targetUserId = row.user_id;
  };

  registerCrud(
    app,
    '/api/orgs/:orgId/members/:memberId/api-keys',
    (req) => ({ orgId: req.orgId, userId: req.targetUserId }),
    { preHandler: [requireRole('owner', 'admin'), resolveTargetMember] },
  );

  // Where each secret-kind key (Notion) stands on every instance in the org:
  // in the store, waiting for the instance, the member's own entry, or no key.
  app.get(
    '/api/orgs/:orgId/api-keys/secret-status',
    { preHandler: requireRole('owner', 'admin') },
    async (request) => {
      const orgId = request.orgId!;
      const users = new Map(
        (getDb()
          .prepare('SELECT om.id AS member_id, u.email, u.name FROM org_members om JOIN users u ON u.id = om.user_id WHERE om.org_id = ?')
          .all(orgId) as { member_id: string; email: string; name: string | null }[]).map((u) => [u.member_id, u]),
      );
      return {
        data: listOrgGateways(orgId).map((g) => ({
          ...secretStatusEntry(g),
          email: users.get(g.member_id)?.email,
          name: users.get(g.member_id)?.name ?? null,
        })),
      };
    },
  );

  // Same for the current member's own instances.
  app.get('/api/orgs/:orgId/me/api-keys/secret-status', async (request) => {
    return { data: listMemberGateways(request.orgMember!.id).map(secretStatusEntry) };
  });

  // Provider source summary for a specific member (admin view).
  app.get(
    '/api/orgs/:orgId/members/:memberId/api-keys/summary',
    { preHandler: [requireRole('owner', 'admin'), resolveTargetMember] },
    async (request: any) => {
      const targetUserId = request.targetUserId as string;
      const db = getDb();
      const rows = db
        .prepare(
          `SELECT provider,
                  SUM(CASE WHEN user_id IS NULL THEN 1 ELSE 0 END) AS org_count,
                  SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS user_count
           FROM api_keys
           WHERE org_id = ? AND (user_id IS NULL OR user_id = ?)
           GROUP BY provider`,
        )
        .all(targetUserId, request.orgId, targetUserId) as {
        provider: string;
        org_count: number;
        user_count: number;
      }[];
      return {
        data: rows.map((r) => ({
          provider: r.provider,
          has_org_default: r.org_count > 0,
          has_personal_override: r.user_count > 0,
          source: r.user_count > 0 ? 'user' : r.org_count > 0 ? 'org' : 'none',
        })),
      };
    },
  );

  // Provider source summary for the current member — used by the
  // personal API keys page so non-admins know which providers fall back
  // to an org default without exposing the org key value.
  app.get('/api/orgs/:orgId/me/api-keys/summary', async (request) => {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT provider,
                SUM(CASE WHEN user_id IS NULL THEN 1 ELSE 0 END) AS org_count,
                SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS user_count
         FROM api_keys
         WHERE org_id = ? AND (user_id IS NULL OR user_id = ?)
         GROUP BY provider`,
      )
      .all(request.currentUser!.id, request.orgId!, request.currentUser!.id) as {
      provider: string;
      org_count: number;
      user_count: number;
    }[];
    return {
      data: rows.map((r) => ({
        provider: r.provider,
        has_org_default: r.org_count > 0,
        has_personal_override: r.user_count > 0,
        source: r.user_count > 0 ? 'user' : r.org_count > 0 ? 'org' : 'none',
      })),
    };
  });
}

type ResolvedKey = {
  provider: string;
  key: string;
  credential_type: CredentialType;
  default_model: string | null;
};

/**
 * Returns the API keys a given member's gateway should use.
 * Per provider: prefer the user's personal keys; fall back to org defaults.
 * No mixing within a single provider — keeps priority ordering predictable.
 */
export function getResolvedApiKeysForMember(orgId: string, userId: string): ResolvedKey[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT provider, key_value, credential_type, default_model, user_id, priority
       FROM api_keys
       WHERE org_id = ? AND (user_id IS NULL OR user_id = ?)
       ORDER BY provider, priority ASC, created_at DESC`,
    )
    .all(orgId, userId) as {
    provider: string;
    key_value: string;
    credential_type: string | null;
    default_model: string | null;
    user_id: string | null;
    priority: number | null;
  }[];

  // Group by provider, decide source (personal wins)
  const byProvider = new Map<string, typeof rows>();
  for (const row of rows) {
    const arr = byProvider.get(row.provider) ?? [];
    arr.push(row);
    byProvider.set(row.provider, arr);
  }

  const resolved: ResolvedKey[] = [];
  for (const [, group] of byProvider) {
    const personal = group.filter((r) => r.user_id !== null);
    const chosen = personal.length > 0 ? personal : group.filter((r) => r.user_id === null);
    for (const r of chosen) {
      resolved.push({
        provider: r.provider,
        key: decodeKey(r.key_value),
        credential_type: (r.credential_type || 'api_key') as CredentialType,
        default_model: r.default_model || null,
      });
    }
  }
  return resolved;
}

/** Highest-priority resolved key for a single provider (personal override beats org default). */
export function getResolvedApiKey(orgId: string, userId: string, provider: string): string | null {
  const resolved = getResolvedApiKeysForMember(orgId, userId).filter((k) => k.provider === provider);
  return resolved[0]?.key ?? null;
}

function secretStatusEntry(g: GatewayRow): SecretStatusEntry {
  return { gateway_id: g.id, slot: g.slot, label: g.label, status: g.status, secrets: secretStatusFor(g) };
}
