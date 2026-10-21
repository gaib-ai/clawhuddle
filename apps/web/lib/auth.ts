import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import Credentials from 'next-auth/providers/credentials';
import {
  signApiToken,
  INTERNAL_API_TOKEN_TTL_SECONDS,
  USER_API_TOKEN_TTL_SECONDS,
} from '@clawhuddle/shared';

const API_URL = process.env.NEXT_PUBLIC_API_URL || process.env.API_URL || 'http://localhost:4000';

// Re-mint the user's API token once less than this much of its lifetime is left
const API_TOKEN_REFRESH_WINDOW_SECONDS = 15 * 60;

/** Authorization header for internal-only API routes (/api/auth/login, /api/auth/check-access). */
async function internalAuthHeader(): Promise<Record<string, string>> {
  const { token } = await signApiToken(
    'web',
    'internal',
    process.env.API_AUTH_SECRET!,
    INTERNAL_API_TOKEN_TTL_SECONDS,
  );
  return { Authorization: `Bearer ${token}` };
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    ...(process.env.GOOGLE_CLIENT_ID
      ? [
          Google({
            clientId: process.env.GOOGLE_CLIENT_ID!,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
          }),
        ]
      : []),
    ...(process.env.NODE_ENV === 'development'
      ? [
          Credentials({
            name: 'Dev Login',
            credentials: {
              email: { label: 'Email', type: 'email' },
            },
            async authorize(credentials) {
              const email = credentials?.email as string;
              if (!email) return null;
              return { id: email, email, name: email.split('@')[0] };
            },
          }),
        ]
      : []),
  ],
  callbacks: {
    async signIn({ user }) {
      if (!user.email) return true;
      try {
        const res = await fetch(`${API_URL}/api/auth/check-access?email=${encodeURIComponent(user.email)}`, {
          headers: await internalAuthHeader(),
        });
        if (res.ok) {
          const data = await res.json();
          return data.allowed;
        }
        // If API is unreachable, allow sign-in to avoid lockout
        return true;
      } catch {
        return true;
      }
    },
    async jwt({ token, user }) {
      if (user) {
        try {
          const res = await fetch(`${API_URL}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(await internalAuthHeader()) },
            body: JSON.stringify({
              email: user.email,
              name: user.name,
              avatar_url: (user as any).image || null,
            }),
          });
          if (res.ok) {
            const data = await res.json();
            token.userId = data.data.id;
          }
        } catch (err) {
          console.error('Failed to sync user with API:', err);
        }
      }

      // The API authenticates the browser with this short-lived signed token, so
      // keep a fresh one in the session (this callback runs on every session read)
      const now = Math.floor(Date.now() / 1000);
      if (token.userId && (!token.apiTokenExp || token.apiTokenExp - now < API_TOKEN_REFRESH_WINDOW_SECONDS)) {
        try {
          const { token: apiToken, exp } = await signApiToken(
            token.userId,
            'user',
            process.env.API_AUTH_SECRET!,
            USER_API_TOKEN_TTL_SECONDS,
          );
          token.apiToken = apiToken;
          token.apiTokenExp = exp;
        } catch (err) {
          console.error('Failed to mint API token:', err);
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.userId as string;
      }
      session.apiToken = token.apiToken;
      return session;
    },
  },
  pages: {
    signIn: '/login',
    error: '/auth/error',
  },
});
