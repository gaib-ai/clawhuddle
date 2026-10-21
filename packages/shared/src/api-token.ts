// === API Tokens ===
//
// Short-lived HS256 JWTs the web app mints (with API_AUTH_SECRET) and the API
// verifies. Built on Web Crypto so the same code runs in Node (API, Next.js
// route handlers) and the Edge runtime (Next.js middleware, where NextAuth's
// jwt callback also runs).

/**
 * `user`: a signed-in user calling the API from the browser (sub = user id).
 * `internal`: the web server calling internal-only API routes (sub = "web").
 */
export type ApiTokenAudience = 'user' | 'internal';

export interface ApiTokenClaims {
  sub: string;
  aud: ApiTokenAudience;
  iat: number;
  exp: number;
}

/** Lifetime of a user token. NextAuth's jwt callback re-mints it before expiry. */
export const USER_API_TOKEN_TTL_SECONDS = 60 * 60;
/** Lifetime of a web→API internal token; minted per request. */
export const INTERNAL_API_TOKEN_TTL_SECONDS = 60;

const MIN_SECRET_LENGTH = 32;
const encoder = new TextEncoder();
const HEADER = base64UrlEncode(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));

/** Throws unless `secret` is long enough to sign API tokens. */
export function assertApiAuthSecret(secret: string | undefined): asserts secret is string {
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `API_AUTH_SECRET must be set to at least ${MIN_SECRET_LENGTH} characters (generate one with \`openssl rand -hex 32\`)`,
    );
  }
}

export async function signApiToken(
  sub: string,
  aud: ApiTokenAudience,
  secret: string,
  ttlSeconds: number,
): Promise<{ token: string; exp: number }> {
  assertApiAuthSecret(secret);
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + ttlSeconds;
  const claims: ApiTokenClaims = { sub, aud, iat, exp };
  const signingInput = `${HEADER}.${base64UrlEncode(encoder.encode(JSON.stringify(claims)))}`;
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(signingInput));
  return { token: `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`, exp };
}

/** Returns the claims if the token is well-formed, correctly signed, unexpired and for `aud`; else null. */
export async function verifyApiToken(
  token: string,
  aud: ApiTokenAudience,
  secret: string,
): Promise<ApiTokenClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== HEADER) return null;

  let signature: Uint8Array<ArrayBuffer>;
  let claims: ApiTokenClaims;
  try {
    signature = base64UrlDecode(parts[2]);
    claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])));
  } catch {
    return null;
  }

  // crypto.subtle.verify compares in constant time
  const valid = await crypto.subtle.verify(
    'HMAC',
    await hmacKey(secret),
    signature,
    encoder.encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) return null;

  if (claims.aud !== aud || typeof claims.sub !== 'string' || !claims.sub) return null;
  if (typeof claims.exp !== 'number' || claims.exp <= Math.floor(Date.now() / 1000)) return null;
  return claims;
}

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(input: string): Uint8Array<ArrayBuffer> {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
