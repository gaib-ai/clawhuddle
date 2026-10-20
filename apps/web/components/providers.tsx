'use client';

import { SessionProvider, useSession } from 'next-auth/react';
import { setApiToken } from '@/lib/api';
import { OrgProvider } from '@/lib/org-context';
import { ToastProvider } from '@/components/ui/toast';
import { ConfirmProvider } from '@/components/ui/confirm-dialog';
import type { ReactNode } from 'react';

// Hands the session's API token to apiFetch. Set during render, not in an effect,
// so it is in place before any child effect issues its first API call.
function ApiTokenSync() {
  const { data: session } = useSession();
  setApiToken(session?.apiToken);
  return null;
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <ApiTokenSync />
      <OrgProvider>
        <ToastProvider>
          <ConfirmProvider>
            {children}
          </ConfirmProvider>
        </ToastProvider>
      </OrgProvider>
    </SessionProvider>
  );
}
