/**
 * Sheet parser — handles Google Sheets URLs, OneDrive/SharePoint shareable links,
 * and uploaded .xlsx/.csv buffers.
 *
 * Two-phase API:
 *
 *   1. inspectSource(source) → list of tab/sheet names + which one Vass would
 *      pick by default (prefers "Media Asset Sheet" or similar names). Used so
 *      the frontend can show a tab picker for multi-tab workbooks.
 *
 *   2. parseSource(source, tabName, columnMap?) → ParsedSheet
 *      Final parse. The optional columnMap lets the frontend override
 *      auto-detection if our header recognition fails.
 */
import * as XLSX from 'xlsx';

export interface SheetRow {
  rowIndex: number;
  adSetName: string;
  creative: string | null;
  primaryText: string | null;
  headline: string | null;
  description: string | null;
  cta: string | null;
  linkUrl: string | null;
  adName: string | null;
  /**
   * Optional media-format hint from the sheet (e.g., "SIA", "Single image",
   * "Image", "Video", "Carousel"). Normalized server-side to "image" | "video"
   * | null when ambiguous. The frontend lets the user override per ad.
   */
  mediaFormat: 'image' | 'video' | null;
}

export interface ParsedSheet {
  campaignLabel: string | null;
  rows: SheetRow[];
  warnings: string[];
}

export interface TabHeaderInfo {
  headerRowIdx: number;
  headers: string[];
  autoMap: Array<keyof Omit<SheetRow, 'rowIndex'> | null>;
  autoComplete: boolean;
  campaignLabel: string | null;
  approxDataRows: number;
  /** First few non-empty rows of the entire tab, for the user to inspect when picking a header. */
  preview: string[][];
}

export interface InspectedSource {
  tabs: string[];
  defaultTab: string;
  tabHeaders: Record<string, TabHeaderInfo>;
}

export type UserColumnMap = Record<number, keyof Omit<SheetRow, 'rowIndex'>>;

export type Source =
  | { kind: 'url'; url: string }
  | { kind: 'buffer'; data: Buffer };

const COLUMN_ALIASES: Record<string, keyof Omit<SheetRow, 'rowIndex'>> = {
  'creative':         'creative',
  'image':            'creative',
  'video':            'creative',
  'media':            'creative',
  'creative url':     'creative',
  'asset':            'creative',
  'asset link':       'creative',
  'asset url':        'creative',

  'primary text':     'primaryText',
  'primary':          'primaryText',
  'body':             'primaryText',
  'text':             'primaryText',
  'copy':             'primaryText',
  'message':          'primaryText',
  'caption':          'primaryText',
  'post text':        'primaryText',

  'headline':         'headline',
  'title':            'headline',

  'description':      'description',
  'link description': 'description',

  'cta':              'cta',
  'call to action':   'cta',
  'button':           'cta',
  'cta type':         'cta',

  'url':              'linkUrl',
  'link':             'linkUrl',
  'link url':         'linkUrl',
  'website url':      'linkUrl',
  'destination':      'linkUrl',
  'destination url':  'linkUrl',
  'landing page':     'linkUrl',
  'landing url':      'linkUrl',

  'ad name':          'adName',
  'name':             'adName',

  'media format':     'mediaFormat',
  'format':           'mediaFormat',
  'ad format':        'mediaFormat',
  'ad type':          'mediaFormat',
  'type':             'mediaFormat',
};

/**
 * Normalize a raw "media format" cell value to a canonical kind.
 * - "SIA", "Single image", "Image", "Static" → "image"
 * - "Video" → "video"
 * - "Carousel", anything else, or empty → null (user picks)
 */
function normalizeMediaFormat(raw: string): 'image' | 'video' | null {
  const v = raw.trim().toLowerCase().replace(/[^a-z]/g, '');
  if (!v) return null;
  if (['sia', 'image', 'singleimage', 'staticimage', 'static', 'photo', 'img'].includes(v)) return 'image';
  if (['video', 'vid', 'mp4', 'reel', 'reels'].includes(v)) return 'video';
  return null;
}

const PREFERRED_TAB_NAMES = [
  'media asset sheet',
  'media schedule',
  'media plan',
  'ads',
  'ad list',
  'ad sets',
  'launch',
  'launches',
];

/**
 * Fields exposed in the column-mapping UI. Ad set is NOT here — sheets don't
 * have an ad-set column; instead Vass detects section-divider rows (rows where
 * only column A has content) and treats them as ad-set group boundaries.
 */
export const VASS_FIELDS: Array<{ key: keyof Omit<SheetRow, 'rowIndex' | 'adSetName'>; label: string; required: boolean }> = [
  { key: 'creative',    label: 'Creative',     required: false },
  { key: 'mediaFormat', label: 'Media format', required: false },
  { key: 'adName',      label: 'Ad name',      required: false },
  { key: 'primaryText', label: 'Primary text', required: false },
  { key: 'headline',    label: 'Headline',     required: false },
  { key: 'description', label: 'Description',  required: false },
  { key: 'cta',         label: 'CTA',          required: false },
  { key: 'linkUrl',     label: 'Link URL',     required: false },
];

// ============================================================
// Public API
// ============================================================

export async function inspectSource(source: Source): Promise<InspectedSource> {
  const wb = await loadWorkbook(source);
  if (wb.SheetNames.length === 0) {
    throw new Error('Workbook has no sheets');
  }

  const tabHeaders: Record<string, TabHeaderInfo> = {};
  for (const name of wb.SheetNames) {
    const rows = sheetToRows(wb.Sheets[name]);
    tabHeaders[name] = inspectRows(rows);
  }

  return {
    tabs: wb.SheetNames,
    defaultTab: pickDefaultTab(wb.SheetNames, tabHeaders),
    tabHeaders,
  };
}

export async function parseSource(
  source: Source,
  tabName?: string,
  columnMap?: UserColumnMap,
  headerRowIdx?: number
): Promise<ParsedSheet> {
  const wb = await loadWorkbook(source);
  if (wb.SheetNames.length === 0) {
    return { campaignLabel: null, rows: [], warnings: ['Workbook has no sheets'] };
  }

  let target = tabName && wb.SheetNames.find((n) => n === tabName);
  if (!target) {
    const headers: Record<string, TabHeaderInfo> = {};
    for (const name of wb.SheetNames) {
      headers[name] = inspectRows(sheetToRows(wb.Sheets[name]));
    }
    target = pickDefaultTab(wb.SheetNames, headers);
  }

  const rows = sheetToRows(wb.Sheets[target]);
  return parseRows(rows, columnMap, headerRowIdx);
}

// ============================================================
// Internals
// ============================================================

function sheetToRows(sheet: XLSX.WorkSheet): string[][] {
  return XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: '',
    blankrows: false,
  }) as string[][];
}

function inspectRows(rows: string[][]): TabHeaderInfo {
  // First N raw rows for the UI to show as a preview grid.
  const preview = rows.slice(0, 15).map((r) => r.map((c) => String(c ?? '')));

  if (rows.length === 0) {
    return {
      headerRowIdx: -1,
      headers: [],
      autoMap: [],
      autoComplete: false,
      campaignLabel: null,
      approxDataRows: 0,
      preview,
    };
  }

  // Scan all rows (not just first 15) for the row with the most recognized
  // column-name cells. Real sheets sometimes have lots of preamble.
  let bestIdx = -1;
  let bestScore = 0;
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i].map((c) => String(c ?? '').trim().toLowerCase());
    const score = cells.filter((c) => COLUMN_ALIASES[c]).length;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  if (bestIdx === -1) {
    // No recognized headers found anywhere — fall back to first non-empty row
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].some((c) => String(c ?? '').trim() !== '')) {
        bestIdx = i;
        break;
      }
    }
  }

  if (bestIdx === -1) {
    return {
      headerRowIdx: -1,
      headers: [],
      autoMap: [],
      autoComplete: false,
      campaignLabel: null,
      approxDataRows: 0,
      preview,
    };
  }

  const headers = rows[bestIdx].map((c) => String(c ?? '').trim());
  const autoMap = headers.map((h) => COLUMN_ALIASES[h.toLowerCase()] ?? null);
  // "autoComplete" means we recognized at least one ad-content column in this
  // row's headers. Used to score which tab/header looks most likely correct.
  const autoComplete = autoMap.some((f) => f !== null);

  let campaignLabel: string | null = null;
  if (bestIdx > 0) {
    const labelCell = String(rows[bestIdx - 1][0] ?? '').trim();
    campaignLabel = labelCell || null;
  }

  const approxDataRows = Math.max(0, rows.length - bestIdx - 1);

  return {
    headerRowIdx: bestIdx,
    headers,
    autoMap,
    autoComplete,
    campaignLabel,
    approxDataRows,
    preview,
  };
}

function pickDefaultTab(
  tabs: string[],
  tabHeaders: Record<string, TabHeaderInfo>
): string {
  for (const name of tabs) {
    const lc = name.trim().toLowerCase();
    if (PREFERRED_TAB_NAMES.some((p) => lc.includes(p)) && tabHeaders[name]?.autoComplete) {
      return name;
    }
  }
  for (const name of tabs) {
    if (tabHeaders[name]?.autoComplete) return name;
  }
  for (const name of tabs) {
    const lc = name.trim().toLowerCase();
    if (PREFERRED_TAB_NAMES.some((p) => lc.includes(p))) return name;
  }
  return tabs[0];
}

function parseRows(
  rows: string[][],
  userMap?: UserColumnMap,
  userHeaderRowIdx?: number
): ParsedSheet {
  const warnings: string[] = [];
  if (rows.length === 0) {
    return { campaignLabel: null, rows: [], warnings: ['Sheet is empty'] };
  }

  const auto = inspectRows(rows);

  // The user's chosen header row (if given) overrides our auto-detected one.
  // We then re-derive autoMap for THAT row so unmatched columns still warn.
  const headerRowIdx =
    typeof userHeaderRowIdx === 'number' && userHeaderRowIdx >= 0 && userHeaderRowIdx < rows.length
      ? userHeaderRowIdx
      : auto.headerRowIdx;

  if (headerRowIdx < 0) {
    return {
      campaignLabel: null,
      rows: [],
      warnings: [
        'No header row found. Add a row with column names like "Ad set", "Creative", "Primary text".',
      ],
    };
  }

  const headers = rows[headerRowIdx].map((c) => String(c ?? '').trim());
  const autoMap = headers.map((h) => COLUMN_ALIASES[h.toLowerCase()] ?? null);
  let campaignLabel: string | null = null;
  if (headerRowIdx > 0) {
    const labelCell = String(rows[headerRowIdx - 1][0] ?? '').trim();
    campaignLabel = labelCell || null;
  }

  const colMap: Record<number, keyof Omit<SheetRow, 'rowIndex'>> = {};
  autoMap.forEach((field, idx) => {
    if (field) colMap[idx] = field;
  });
  if (userMap) {
    for (const [idxStr, field] of Object.entries(userMap)) {
      colMap[Number(idxStr)] = field;
    }
  }

  if (!userMap) {
    headers.forEach((h, i) => {
      if (h && !colMap[i]) {
        warnings.push(`Column "${h}" (col ${columnLetter(i)}) not recognized — ignored`);
      }
    });
  }

  const out: SheetRow[] = [];
  let adCounter = 0;

  /**
   * "Section divider" detection: a row that visually labels the ads beneath
   * it (e.g., "AWARENESS - META" spans across in green). Such a row has text
   * in 1 column only (usually col A), and none of our mapped Vass fields
   * has a value in it — so it's not an ad, it's a section header.
   *
   * When we encounter one, we remember its label and use it as the ad set
   * name for every subsequent ad row, until the next divider.
   */
  let currentSectionLabel = '';

  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const cells = rows[i];
    if (!cells || cells.every((c) => String(c ?? '').trim() === '')) continue;

    const row: SheetRow = {
      rowIndex: i + 1,
      adSetName: '',
      creative: null,
      primaryText: null,
      headline: null,
      description: null,
      cta: null,
      linkUrl: null,
      adName: null,
      mediaFormat: null,
    };
    let funnel: string | null = null;

    for (const [colIdxStr, field] of Object.entries(colMap)) {
      const v = String(cells[Number(colIdxStr)] ?? '').trim();
      if (!v) continue;
      if (field === 'adSetName') row.adSetName = v;
      else if (field === 'creative') row.creative = v;
      else if (field === 'primaryText') row.primaryText = v;
      else if (field === 'headline') row.headline = v;
      else if (field === 'description') row.description = v;
      else if (field === 'cta') row.cta = v;
      else if (field === 'linkUrl') row.linkUrl = v;
      else if (field === 'adName') row.adName = v;
      else if (field === 'mediaFormat') row.mediaFormat = normalizeMediaFormat(v);
    }

    for (let c = 0; c < headers.length; c++) {
      const h = headers[c]?.toLowerCase() ?? '';
      if (['funnel', 'stage', 'phase'].includes(h)) {
        const v = String(cells[c] ?? '').trim();
        if (v) funnel = v;
        break;
      }
    }

    const adHasAnyVassContent =
      row.creative || row.primaryText || row.headline ||
      row.description || row.cta || row.linkUrl || row.adName ||
      row.mediaFormat;

    // SECTION DIVIDER: the row's non-empty cells are NOT in any column that's
    // mapped to a Vass field. Treat the row as a label, not an ad.
    if (!adHasAnyVassContent && !row.adSetName) {
      const nonEmpty = cells
        .map((c, idx) => ({ idx, val: String(c ?? '').trim() }))
        .filter((c) => c.val);
      // Heuristic: divider rows have 1 or 2 non-empty cells, usually in the
      // first 2 columns. Allow up to 3 to be permissive.
      if (nonEmpty.length >= 1 && nonEmpty.length <= 3) {
        // Combine non-empty values into a single label (e.g., "AWARENESS - META")
        // Skip cells that just say "META" or "Meta" alone (platform tag, not the label)
        const label = nonEmpty.map((c) => c.val).join(' - ');
        currentSectionLabel = label;
        continue; // don't emit this row as an ad
      }
    }

    // Drop rows with no content of any kind (no Vass fields, no ad-set value,
    // and didn't match the divider heuristic)
    if (!adHasAnyVassContent && !row.adSetName) continue;

    // If we don't have an explicit ad set value from a mapped column, fall back
    // to the most recent section divider label.
    if (!row.adSetName && currentSectionLabel) {
      row.adSetName = currentSectionLabel;
    }

    adCounter++;

    if (!row.adName) {
      const parts = ['Ad', String(adCounter)];
      if (funnel) parts.push(slug(funnel));
      if (row.cta) parts.push(slug(row.cta));
      row.adName = parts.join('_');
    }

    out.push(row);
  }

  if (out.length === 0) {
    warnings.push('No valid rows found below the header');
  }

  return { campaignLabel, rows: out, warnings };
}

/** Slug a value for use inside an auto-generated ad name. */
function slug(v: string): string {
  return v.trim().replace(/[^A-Za-z0-9]+/g, '').slice(0, 40);
}

// ============================================================
// Source loading: Google Sheets, OneDrive, SharePoint, buffer
// ============================================================

async function loadWorkbook(source: Source): Promise<XLSX.WorkBook> {
  try {
    if (source.kind === 'buffer') {
      // sheetStubs keeps "empty" sheets visible, raw avoids style parsing
      // (faster and more robust on complex workbooks)
      return XLSX.read(source.data, { type: 'buffer', sheetStubs: true, cellDates: true });
    }
    return await loadWorkbookFromUrl(source.url);
  } catch (err) {
    if (err instanceof Error) throw err;
    throw new Error('Failed to read workbook');
  }
}

async function loadWorkbookFromUrl(url: string): Promise<XLSX.WorkBook> {
  const lower = url.toLowerCase();

  // Google Sheets — use xlsx export (preserves all tabs)
  if (lower.includes('docs.google.com/spreadsheets/')) {
    const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (!m) throw new Error('Not a recognizable Google Sheets URL');
    const sheetId = m[1];
    const xlsxUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=xlsx`;
    const res = await fetch(xlsxUrl, { redirect: 'follow' });
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        'Sheet is not publicly accessible. Share it with "Anyone with the link can view" and try again.'
      );
    }
    if (!res.ok) {
      throw new Error(`Failed to fetch sheet (HTTP ${res.status})`);
    }
    const ct = (res.headers.get('content-type') ?? '').toLowerCase();
    if (ct.startsWith('text/html')) {
      throw new Error(
        'Sheet requires sign-in. Share it with "Anyone with the link can view" and try again.'
      );
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return XLSX.read(buf, { type: 'buffer', sheetStubs: true, cellDates: true });
  }

  // OneDrive personal (1drv.ms)
  if (/^https?:\/\/1drv\.ms\//i.test(url)) {
    const b64 = Buffer.from(url, 'utf8')
      .toString('base64')
      .replace(/=+$/, '')
      .replace(/\//g, '_')
      .replace(/\+/g, '-');
    const apiUrl = `https://api.onedrive.com/v1.0/shares/u!${b64}/root/content`;
    const res = await fetch(apiUrl, { redirect: 'follow' });
    if (!res.ok) {
      throw new Error(
        `Couldn't fetch OneDrive file (HTTP ${res.status}). Make sure the link's sharing setting is "Anyone with the link".`
      );
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return XLSX.read(buf, { type: 'buffer', sheetStubs: true, cellDates: true });
  }

  // SharePoint / OneDrive Business / OneDrive Live — add ?download=1
  if (
    lower.includes('.sharepoint.com/') ||
    lower.includes('onedrive.live.com/') ||
    lower.includes('-my.sharepoint.com/')
  ) {
    const downloadUrl = url.includes('?')
      ? `${url}&download=1`
      : `${url}?download=1`;
    const res = await fetch(downloadUrl, { redirect: 'follow' });
    if (!res.ok) {
      throw new Error(
        `Couldn't fetch the file (HTTP ${res.status}). Make sure the sharing setting is "Anyone with the link can view".`
      );
    }
    const ct = (res.headers.get('content-type') ?? '').toLowerCase();
    if (ct.startsWith('text/html')) {
      throw new Error(
        'The link returned a preview page, not a file. Open the file in OneDrive/SharePoint, click Share → "Anyone with the link can view", then paste that link.'
      );
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return XLSX.read(buf, { type: 'buffer', sheetStubs: true, cellDates: true });
  }

  // Generic .xlsx / .csv URL
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Failed to fetch URL (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  try {
    return XLSX.read(buf, { type: 'buffer', sheetStubs: true, cellDates: true });
  } catch {
    try {
      return XLSX.read(buf.toString('utf8'), { type: 'string' });
    } catch {
      throw new Error('URL did not return a recognizable .xlsx or .csv file');
    }
  }
}

function columnLetter(idx: number): string {
  let s = '';
  let n = idx + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
