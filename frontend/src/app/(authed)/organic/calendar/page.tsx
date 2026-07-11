/**
 * /organic/calendar — DEPRECATED (Patch 4.36).
 *
 * The Pipeline page now owns calendar AND list views in one place.
 * This stub server-side redirects any lingering bookmarks or external
 * links to the new home.
 */
import { redirect } from 'next/navigation';

export default function OrganicCalendarRedirect() {
  redirect('/organic/pipeline');
}
