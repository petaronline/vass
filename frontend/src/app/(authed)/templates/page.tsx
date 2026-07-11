'use client';

/**
 * Templates page — Phase 0 placeholder.
 * The actual templates library lands in Phase 5.
 */
import { PageHeader, PAGE_TINTS } from '@/components/PageHeader';
import { Copy } from 'lucide-react';

export default function TemplatesPage() {
  return (
    <div>
      <PageHeader
        icon={Copy}
        title="Templates"
        description="Save and reuse your best-performing ad copy. Coming in Phase 5."
        tint={PAGE_TINTS.templates}
      />
      <div className="card py-20 text-center text-sm text-ink-subtle">
        Nothing here yet. Save copy templates to speed up future launches.
      </div>
    </div>
  );
}
