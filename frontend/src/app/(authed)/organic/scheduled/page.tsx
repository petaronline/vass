'use client';
import { Clock } from 'lucide-react';

export default function OrganicScheduledPage() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <div className="w-14 h-14 rounded-lg bg-white/70 border border-white/60 shadow-card flex items-center justify-center mb-5">
        <Clock size={26} strokeWidth={1.5} className="text-ink-muted" />
      </div>
      <h2 className="h-section text-ink mb-2">Scheduled posts — coming in patch 4.26</h2>
      <p className="text-sm text-ink-muted max-w-sm">
        Queue posts to go out at a specific time. Powered by BullMQ — same worker infrastructure as ad launches.
      </p>
    </div>
  );
}
