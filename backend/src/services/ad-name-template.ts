/**
 * Ad name template expansion.
 *
 * Supported placeholders (case-insensitive, in {curly_braces}):
 *   {creative_name}  → the creative's display name
 *   {creative}       → short form alias
 *   {ad_set_name}    → the Meta ad set name
 *   {ad_set}         → short alias
 *   {adset_name}     → no-underscore alias for the ad set name
 *   {adset}          → short alias
 *   {account_name}   → the Vass ad account display name
 *   {account}        → short alias
 *   {date}           → ISO date YYYY-MM-DD
 *   {date_short}     → MM/DD
 *   {batch_name}     → the parent batch name (if set)
 *   {index}          → 1-based index within the batch (for disambiguation
 *                      when the same creative+ad-set combo would repeat)
 *
 * If a placeholder isn't recognized or its value is empty, it's left as-is
 * in the output (so users notice they typo'd it).
 *
 * Whitespace is normalized: any sequence of two-or-more spaces becomes one,
 * and the result is trimmed.
 */

export interface AdNameTemplateVars {
  creativeName: string;
  adSetName: string;
  accountName: string;
  batchName?: string;
  index?: number;
  /** Override the date for testing / specific use cases. Default = today. */
  date?: Date;
}

export function expandAdNameTemplate(
  template: string,
  vars: AdNameTemplateVars
): string {
  const d = vars.date ?? new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');

  const substitutions: Record<string, string | undefined> = {
    creative_name: vars.creativeName,
    creative: vars.creativeName,
    ad_set_name: vars.adSetName,
    ad_set: vars.adSetName,
    adset_name: vars.adSetName,
    adset: vars.adSetName,
    account_name: vars.accountName,
    account: vars.accountName,
    date: `${yyyy}-${mm}-${dd}`,
    date_short: `${mm}/${dd}`,
    batch_name: vars.batchName,
    index: vars.index !== undefined ? String(vars.index) : undefined,
  };

  let result = template.replace(/\{([a-z_]+)\}/gi, (match, rawKey) => {
    const key = String(rawKey).toLowerCase();
    const value = substitutions[key];
    return value !== undefined && value !== '' ? value : match;
  });

  // Normalize whitespace
  result = result.replace(/\s{2,}/g, ' ').trim();

  // Fall back to a sensible default if the template was just whitespace
  return result || `${vars.creativeName} · ${vars.adSetName}`;
}

/** The default ad name template used by Vass when the user doesn't set one. */
export const DEFAULT_AD_NAME_TEMPLATE = '{creative_name} · {ad_set_name}';
