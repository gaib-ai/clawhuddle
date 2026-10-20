import 'next-auth';
import 'next-auth/jwt';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      email: string;
      name?: string | null;
      image?: string | null;
    };
    /** Short-lived bearer token for the API (see @clawhuddle/shared api-token). */
    apiToken?: string;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    userId?: string;
    apiToken?: string;
    apiTokenExp?: number;
  }
}
