/**
 * Organic layout — pass-through, full-width.
 *
 * Patch 4.36.5: removed the `max-w-6xl mx-auto` constraint. Pipeline's
 * week/month calendars need every available pixel of horizontal space
 * to render 7 columns without squeezing card content. Studio (composer)
 * pages re-apply their own max-width if they need it.
 */
export default function OrganicLayout({ children }: { children: React.ReactNode }) {
  return <div className="w-full">{children}</div>;
}
