'use client';

/**
 * Settings → Connections.
 *
 * Patch 4.47.0: removed the in-page left rail that 4.46.0 introduced — it
 * competed with the settings sub-nav (settings/layout.tsx already provides
 * the left sidebar). Now uses a horizontal segmented control at the top of
 * the content area, matching the in-page tab pattern used elsewhere (e.g.
 * Brands' All / Profiles / Ad accounts pills). One vertical nav, one flow.
 */

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { MetaConnectionSection } from '@/components/settings/MetaConnectionSection';
import { ThreadsAppSection } from '@/components/settings/ThreadsAppSection';
import { TikTokAppSection } from '@/components/settings/TikTokAppSection';
import { LinkedInAppSection } from '@/components/settings/LinkedInAppSection';

type TabId = 'meta' | 'threads' | 'tiktok' | 'linkedin' | 'linkedin_org';

const TABS: { id: TabId; label: string }[] = [
  { id: 'meta',         label: 'Meta (FB/IG)' },
  { id: 'threads',      label: 'Threads' },
  { id: 'tiktok',       label: 'TikTok' },
  { id: 'linkedin',     label: 'LinkedIn — Profiles' },
  { id: 'linkedin_org', label: 'LinkedIn — Pages' },
];

const VALID_TABS = new Set<TabId>(['meta', 'threads', 'tiktok', 'linkedin', 'linkedin_org']);

export default function ConnectionsPage() {
  const params = useSearchParams();
  const requested = params.get('tab') as TabId | null;
  const [active, setActive] = useState<TabId>(
    requested && VALID_TABS.has(requested) ? requested : 'meta'
  );

  return (
    <div>
      {/* Horizontal segmented control — matches the in-page tab pattern
          used elsewhere in settings (Brands pills). */}
      <div className="flex flex-wrap gap-1 mb-8 border-b border-line">
        {TABS.map((tab) => {
          const isActive = active === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActive(tab.id)}
              className={[
                'px-3.5 py-2 text-sm font-medium transition-colors border-b-2 -mb-px',
                isActive
                  ? 'border-accent text-accent'
                  : 'border-transparent text-ink-muted hover:text-ink',
              ].join(' ')}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {active === 'meta' && <MetaConnectionSection />}
      {active === 'threads' && <ThreadsAppSection />}
      {active === 'tiktok' && <TikTokAppSection />}
      {active === 'linkedin' && <LinkedInAppSection kind="profile" />}
      {active === 'linkedin_org' && <LinkedInAppSection kind="org" />}
    </div>
  );
}
