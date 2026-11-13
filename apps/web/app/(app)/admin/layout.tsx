'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useOrg } from '@/lib/org-context';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { memberRole, loading } = useOrg();
  const router = useRouter();
  const pathname = usePathname();
  const isAdmin = memberRole === 'admin' || memberRole === 'owner';
  // Maintainers get the Members page (/admin) and nothing else under Admin.
  const allowed = isAdmin || (memberRole === 'maintainer' && pathname === '/admin');

  useEffect(() => {
    if (loading) return;
    if (!allowed) {
      router.replace(memberRole === 'maintainer' ? '/admin' : '/home');
    }
  }, [allowed, loading, memberRole, router]);

  if (loading || !allowed) return null;

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-8">
      {children}
    </div>
  );
}
