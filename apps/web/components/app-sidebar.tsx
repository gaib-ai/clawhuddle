'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useSession, signOut } from 'next-auth/react';
import { useOrg } from '@/lib/org-context';
import { useOrgFetch } from '@/lib/use-org-fetch';
import { useSuperAdmin } from '@/lib/use-super-admin';
import { OrgSwitcher } from './org-switcher';
import { ClawHuddleLogo } from './logo';

/* ─── Icons (Lucide-style, 16x16) ─── */

const icons = {
  home: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
      <polyline points="9 22 9 12 15 12 15 22"/>
    </svg>
  ),
  skills: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
    </svg>
  ),
  channels: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </svg>
  ),
  devices: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
      <line x1="8" y1="21" x2="16" y2="21"/>
      <line x1="12" y1="17" x2="12" y2="21"/>
    </svg>
  ),
  members: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
      <circle cx="9" cy="7" r="4"/>
      <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
      <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg>
  ),
  invitations: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
      <polyline points="22,6 12,13 2,6"/>
    </svg>
  ),
  skillLibrary: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
    </svg>
  ),
  keys: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
    </svg>
  ),
  portForwards: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="17 1 21 5 17 9"/>
      <path d="M3 11V9a4 4 0 0 1 4-4h14"/>
      <polyline points="7 23 3 19 7 15"/>
      <path d="M21 13v2a4 4 0 0 1-4 4H3"/>
    </svg>
  ),
  settings: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>
  ),
  shield: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
    </svg>
  ),
  menu: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="7" x2="20" y2="7"/>
      <line x1="4" y1="12" x2="20" y2="12"/>
      <line x1="4" y1="17" x2="20" y2="17"/>
    </svg>
  ),
  close: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18"/>
      <line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  ),
  signOut: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
      <polyline points="16 17 21 12 16 7"/>
      <line x1="21" y1="12" x2="9" y2="12"/>
    </svg>
  ),
};

/* ─── Nav Item ─── */

function NavItem({
  href,
  icon,
  label,
  active,
  badge,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  active: boolean;
  badge?: number;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3 md:gap-2.5 px-3 py-2.5 md:py-[7px] rounded-lg text-[15px] md:text-[13px] font-medium transition-colors"
      style={{
        color: active ? 'var(--accent-text)' : 'var(--text-secondary)',
        background: active ? 'var(--accent-muted)' : 'transparent',
      }}
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.background = 'var(--bg-hover)';
          e.currentTarget.style.color = 'var(--text-primary)';
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = 'var(--text-secondary)';
        }
      }}
    >
      <span style={{ opacity: active ? 1 : 0.5 }}>{icon}</span>
      <span className="flex-1">{label}</span>
      {badge ? (
        <span
          className="text-[10px] font-semibold tabular-nums px-1.5 py-0.5 rounded-full"
          style={{ background: 'var(--accent)', color: 'var(--text-inverse)' }}
        >
          {badge}
        </span>
      ) : null}
    </Link>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="text-[10px] font-semibold uppercase tracking-[0.12em] mb-1.5 mt-5 px-3"
      style={{ color: 'var(--text-tertiary)' }}
    >
      {children}
    </p>
  );
}

/**
 * Browsers waiting to be let into one of my instances. Only my own instances
 * are counted (admins see the org-wide list on the page itself); polled
 * slowly since every poll runs a command in each running container.
 */
export function usePendingDeviceCount(): number {
  const { orgFetch } = useOrgFetch();
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!orgFetch) return;
    let cancelled = false;
    const load = () =>
      orgFetch<{ data: unknown[] }>('/me/device-requests')
        .then((res) => { if (!cancelled) setCount(res.data.length); })
        .catch(() => {});
    load();
    const timer = setInterval(load, 30000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [orgFetch]);
  return count;
}

/* ─── Mobile top bar (phones only; the sidebar is a drawer there) ─── */

export function MobileTopBar({ onMenu, badge }: { onMenu: () => void; badge?: number }) {
  const { currentOrg } = useOrg();
  return (
    <header
      className="md:hidden shrink-0 safe-top"
      style={{ background: 'var(--bg-primary)', borderBottom: '1px solid var(--border-subtle)' }}
    >
      <div className="h-14 flex items-center gap-1 px-2">
        <button
          onClick={onMenu}
          aria-label="Open menu"
          className="relative w-11 h-11 flex items-center justify-center rounded-lg"
          style={{ color: 'var(--text-secondary)' }}
        >
          {icons.menu}
          {badge ? (
            <span
              className="absolute top-2 right-2 w-2 h-2 rounded-full"
              style={{ background: 'var(--accent)', boxShadow: '0 0 0 2px var(--bg-primary)' }}
            />
          ) : null}
        </button>
        <Link
          href="/home"
          className="flex items-center gap-2 font-semibold text-[16px] tracking-tight"
          style={{ color: 'var(--accent)' }}
        >
          <ClawHuddleLogo size={20} />
          ClawHuddle
        </Link>
        {currentOrg?.name && (
          <span className="ml-auto pr-2 text-xs truncate max-w-[40%]" style={{ color: 'var(--text-tertiary)' }}>
            {currentOrg.name}
          </span>
        )}
      </div>
    </header>
  );
}

/* ─── Sidebar ─── */

/**
 * Static column from md up. Below that it is an off-canvas drawer opened from
 * MobileTopBar; the layout closes it on navigation.
 */
export function AppSidebar({
  mobileOpen = false,
  onClose,
  pendingDevices = 0,
}: {
  mobileOpen?: boolean;
  onClose?: () => void;
  pendingDevices?: number;
}) {
  const pathname = usePathname();
  const { data: session } = useSession();
  const { currentOrgId, memberRole } = useOrg();
  const isAdmin = memberRole === 'admin' || memberRole === 'owner';
  const isSuperAdmin = useSuperAdmin();

  return (
    <>
    {/* Backdrop (phones, drawer open) */}
    {mobileOpen && (
      <div
        className="md:hidden fixed inset-0 z-40"
        style={{ background: 'rgba(0, 0, 0, 0.55)', backdropFilter: 'blur(2px)', animation: 'fade-in 0.15s ease-out' }}
        onClick={onClose}
        aria-hidden
      />
    )}
    <aside
      className={`flex flex-col shrink-0 fixed inset-y-0 left-0 z-50 w-[17.5rem] max-w-[85vw] transition-[transform,visibility] duration-200 ease-out md:static md:z-auto md:w-56 md:max-w-none md:translate-x-0 md:visible md:transition-none ${
        mobileOpen ? 'translate-x-0 visible shadow-2xl' : '-translate-x-full invisible'
      }`}
      style={{
        background: 'var(--bg-primary)',
        borderRight: '1px solid var(--border-subtle)',
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
        paddingLeft: 'env(safe-area-inset-left)',
      }}
    >
      {/* Logo + Org */}
      <div
        className="px-4 py-4"
        style={{ borderBottom: '1px solid var(--border-subtle)' }}
      >
        <div className="flex items-center justify-between mb-3">
          <Link
            href="/home"
            className="flex items-center gap-2 font-semibold text-[15px] tracking-tight"
            style={{ color: 'var(--accent)' }}
          >
            <ClawHuddleLogo size={18} />
            ClawHuddle
          </Link>
          <button
            onClick={onClose}
            aria-label="Close menu"
            className="md:hidden -mr-2 w-10 h-10 flex items-center justify-center rounded-lg"
            style={{ color: 'var(--text-tertiary)' }}
          >
            {icons.close}
          </button>
        </div>
        <OrgSwitcher />
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-2 overflow-y-auto">
        {currentOrgId && (
          <>
            {/* General */}
            <SectionLabel>General</SectionLabel>
            <div className="space-y-0.5">
              <NavItem href="/home" icon={icons.home} label="Home" active={pathname === '/home'} />
              <NavItem href="/skills" icon={icons.skills} label="My Skills" active={pathname.startsWith('/skills')} />
              <NavItem href="/channels" icon={icons.channels} label="Channels" active={pathname.startsWith('/channels')} />
              <NavItem href="/devices" icon={icons.devices} label="Device Requests" active={pathname.startsWith('/devices')} badge={pendingDevices} />
              <NavItem href="/api-keys" icon={icons.keys} label="My API Keys" active={pathname.startsWith('/api-keys')} />
            </div>

            {/* Admin */}
            {isAdmin && (
              <>
                <SectionLabel>Admin</SectionLabel>
                <div className="space-y-0.5">
                  <NavItem href="/admin" icon={icons.members} label="Members" active={pathname === '/admin'} />
                  <NavItem href="/admin/invitations" icon={icons.invitations} label="Invitations" active={pathname.startsWith('/admin/invitations')} />
                  <NavItem href="/admin/skills" icon={icons.skillLibrary} label="Skill Library" active={pathname.startsWith('/admin/skills')} />
                  <NavItem href="/admin/api-keys" icon={icons.keys} label="API Keys" active={pathname.startsWith('/admin/api-keys')} />
                  <NavItem href="/admin/port-forwards" icon={icons.portForwards} label="Port Forwards" active={pathname.startsWith('/admin/port-forwards')} />
                </div>
              </>
            )}
          </>
        )}
      </nav>

      {/* Bottom: Settings + User */}
      <div
        className="px-3 py-3 space-y-0.5"
        style={{ borderTop: '1px solid var(--border-subtle)' }}
      >
        {currentOrgId && (
          <NavItem href="/settings" icon={icons.settings} label="Settings" active={pathname.startsWith('/settings')} />
        )}
        {isSuperAdmin && (
          <NavItem href="/super-admin" icon={icons.shield} label="Super Admin" active={pathname.startsWith('/super-admin')} />
        )}

        <button
          onClick={() => signOut({ callbackUrl: '/login' })}
          className="w-full flex items-center gap-3 md:gap-2.5 px-3 py-2.5 md:py-[7px] rounded-lg text-[15px] md:text-[13px] font-medium transition-colors"
          style={{ color: 'var(--text-tertiary)', background: 'transparent' }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--bg-hover)';
            e.currentTarget.style.color = 'var(--text-primary)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = 'var(--text-tertiary)';
          }}
        >
          <span style={{ opacity: 0.5 }}>{icons.signOut}</span>
          Sign out
        </button>

        {/* Sponsor + User info */}
        <div className="px-3 pt-2 space-y-2">
          <a
            href="https://buymeacoffee.com/unless"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-[11px] transition-colors"
            style={{ color: 'var(--text-tertiary)' }}
            onMouseEnter={(e) => { e.currentTarget.style.color = '#ffdd00'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-tertiary)'; }}
          >
            ☕ Buy me a coffee
          </a>
          <p className="text-[11px] truncate" style={{ color: 'var(--text-tertiary)' }}>
            {session?.user?.email}
          </p>
        </div>
      </div>
    </aside>
    </>
  );
}
