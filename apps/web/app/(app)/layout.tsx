'use client';

import { useSession } from 'next-auth/react';
import { usePathname, useRouter } from 'next/navigation';
import { useOrg } from '@/lib/org-context';
import { AppSidebar, MobileTopBar, usePendingDeviceCount } from '@/components/app-sidebar';
import { useEffect, useState } from 'react';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();
  const { orgs, loading } = useOrg();
  const router = useRouter();
  const pathname = usePathname();
  const [navOpen, setNavOpen] = useState(false);
  const pendingDevices = usePendingDeviceCount();

  useEffect(() => {
    if (status === 'loading' || loading) return;
    if (!session) {
      router.replace('/login');
    }
  }, [session, status, loading, router]);

  // Phone drawer: close on navigation and on Escape.
  useEffect(() => { setNavOpen(false); }, [pathname]);
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setNavOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navOpen]);

  // Still loading auth / org data
  if (status === 'loading' || loading || !session) {
    return (
      <div className="min-h-dvh flex items-center justify-center" style={{ background: 'var(--bg-base)' }}>
        <div
          className="w-8 h-8 rounded-full border-2 animate-spin"
          style={{
            borderColor: 'var(--border-primary)',
            borderTopColor: 'var(--accent)',
          }}
        />
      </div>
    );
  }

  // No orgs yet — dashboard page will show the create-org form, no sidebar needed
  if (orgs.length === 0) {
    return (
      <div className="h-dvh flex flex-col safe-top safe-bottom safe-x" style={{ background: 'var(--bg-base)' }}>
        {children}
      </div>
    );
  }

  return (
    <div className="h-dvh flex flex-col md:flex-row safe-x" style={{ background: 'var(--bg-base)' }}>
      <MobileTopBar onMenu={() => setNavOpen(true)} badge={pendingDevices} />
      <AppSidebar mobileOpen={navOpen} onClose={() => setNavOpen(false)} pendingDevices={pendingDevices} />
      <main className="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden safe-bottom">
        {children}
      </main>
    </div>
  );
}
