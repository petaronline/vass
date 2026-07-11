/**
 * Audit routes — POST /audits, GET /audits/:id, POST /audits/:id/fix.
 *
 * The frontend polls GET /audits/:id every couple of seconds during a scan
 * to show live progress, and again during fix to show fix progress.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import * as audits from '../services/audits';

export const auditsRouter = Router();

const createSchema = z.object({
  adAccountId: z.string().uuid(),
  metaCampaignId: z.string().min(1).max(64),
  metaCampaignName: z.string().max(400).optional(),
  targetAdSetIds: z.array(z.string().min(1).max(64)).min(1).max(50),
  activeOnly: z.boolean().default(true),
});

// POST /audits — start a new audit run
auditsRouter.post('/', requireAuth, async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', issues: parsed.error.issues });
  }
  try {
    const result = await audits.createAuditRun(req.user!.id, parsed.data);
    res.status(201).json({ runId: result.runId });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Failed to create audit',
    });
  }
});

// GET /audits — list current user's recent audit runs
auditsRouter.get('/', requireAuth, async (req: Request, res: Response) => {
  const rows = await audits.listAuditRunsForUser(req.user!.id, 25);
  res.json({ runs: rows.map(rowToRun) });
});

// GET /audits/:id — single run + findings
auditsRouter.get('/:id', requireAuth, async (req: Request, res: Response) => {
  const id = req.params.id as string;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ error: 'Invalid id' });
  }
  const run = await audits.getAuditRun(id);
  if (!run) return res.status(404).json({ error: 'Audit not found' });
  if (run.user_id !== req.user!.id) {
    // Don't reveal it exists at all
    return res.status(404).json({ error: 'Audit not found' });
  }
  const findings = await audits.listFindings(id);
  // Lookup Meta account id for the deep-link to Ads Manager
  const { findAdAccountById } = await import('../services/ad-accounts');
  const account = await findAdAccountById(req.user!.id, run.ad_account_id);
  res.json({
    run: { ...rowToRun(run), metaAdAccountId: account?.metaAccountId ?? null },
    findings: findings.map(rowToFinding),
  });
});

// POST /audits/:id/fix — queue selected findings for fix
//
// Accepts either:
//   { findings: [{ id: '...', violationKeys: ['translate_text'] }, ...] }
//   { findingIds: [...] }   (legacy — fixes ALL violations for those findings)
const fixSchema = z.union([
  z.object({
    findings: z
      .array(
        z.object({
          id: z.string().uuid(),
          violationKeys: z.array(z.string().min(1).max(64)).optional(),
        })
      )
      .min(1)
      .max(2000),
  }),
  z.object({
    findingIds: z.array(z.string().uuid()).min(1).max(2000),
  }),
]);
auditsRouter.post('/:id/fix', requireAuth, async (req: Request, res: Response) => {
  const id = req.params.id as string;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ error: 'Invalid id' });
  }
  const run = await audits.getAuditRun(id);
  if (!run) return res.status(404).json({ error: 'Audit not found' });
  if (run.user_id !== req.user!.id) {
    return res.status(404).json({ error: 'Audit not found' });
  }
  const parsed = fixSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', issues: parsed.error.issues });
  }
  // Normalize either input shape to a FixSelection[]
  const selections: audits.FixSelection[] =
    'findings' in parsed.data
      ? parsed.data.findings.map((f) => ({
          findingId: f.id,
          violationKeys: f.violationKeys,
        }))
      : parsed.data.findingIds.map((id) => ({ findingId: id }));

  const result = await audits.queueFixes(req.user!.id, id, selections);
  res.json({ queued: result.queued });
});

// POST /audits/:id/rescan — re-run the scan with the original scope.
// Used after the user publishes changes in Meta UI; lets Vass confirm
// pending_publish findings actually went through.
auditsRouter.post('/:id/rescan', requireAuth, async (req: Request, res: Response) => {
  const id = req.params.id as string;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ error: 'Invalid id' });
  }
  const run = await audits.getAuditRun(id);
  if (!run) return res.status(404).json({ error: 'Audit not found' });
  if (run.user_id !== req.user!.id) {
    return res.status(404).json({ error: 'Audit not found' });
  }
  if (run.status === 'scanning') {
    return res.status(409).json({ error: 'A scan is already running' });
  }
  await audits.queueRescan(req.user!.id, id);
  res.json({ rescanQueued: true });
});

// ----- helpers -----

function rowToRun(r: audits.AuditRunRow) {
  return {
    id: r.id,
    adAccountId: r.ad_account_id,
    metaCampaignId: r.meta_campaign_id,
    metaCampaignName: r.meta_campaign_name,
    targetAdSetIds: r.target_ad_set_ids,
    activeOnly: r.active_only,
    status: r.status,
    errorMessage: r.error_message,
    adsTotal: r.ads_total,
    adsScanned: r.ads_scanned,
    findingsCount: r.findings_count,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    createdAt: r.created_at,
  };
}

function rowToFinding(r: audits.AuditFindingRow) {
  return {
    id: r.id,
    auditRunId: r.audit_run_id,
    metaAdId: r.meta_ad_id,
    metaAdName: r.meta_ad_name,
    metaAdStatus: r.meta_ad_status,
    metaAdSetId: r.meta_ad_set_id,
    metaCreativeId: r.meta_creative_id,
    foundFeatures: r.found_features,
    foundMultiAd: r.found_multi_ad,
    violations: r.violations,
    fixStatus: r.fix_status,
    fixError: r.fix_error,
    fixStartedAt: r.fix_started_at,
    fixCompletedAt: r.fix_completed_at,
    newCreativeId: r.new_creative_id,
    createdAt: r.created_at,
  };
}
