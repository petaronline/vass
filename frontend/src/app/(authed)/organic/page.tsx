import { redirect } from 'next/navigation';

/**
 * /organic — convenience redirect to the Studio sub-page.
 * The sidebar exposes Studio / Pipeline / Calendar as separate entries;
 * if a user lands on bare /organic (old bookmark, link from elsewhere)
 * we send them to Studio.
 */
export default function OrganicIndex() {
  redirect('/organic/studio');
}
