/**
 * Launch defaults routes.
 *
 * Endpoints:
 *   GET    /settings/launch-defaults              → global config
 *   PUT    /settings/launch-defaults              → set global (admin)
 *   GET    /ad-accounts/:id/launch-defaults       → resolved config for one account
 *   PUT    /ad-accounts/:id/launch-defaults       → set per-account override (admin)
 *   DELETE /ad-accounts/:id/launch-defaults       → clear override, fall back to global (admin)
 *
 * Note: the GET on the per-account route returns the RESOLVED config (account
 * override OR global), with a `source` field so the UI can show where it
 * came from.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../middleware/auth';
import { audit } from '../services/audit';
import * as launchDefaults from '../services/launch-defaults';
import { ENHANCEMENT_KEYS } from '../services/launch-defaults';

export const launchDefaultsRouter = Router();

// Validate the config shape coming in over the wire
const configSchema = z.object({
  disable_enhancements: z.boolean(),
  granular_overrides: z
    .record(z.enum(ENHANCEMENT_KEYS as unknown as [string, ...string[]]), z.boolean())
    .default({}),
  // Default to true (opt-out) to match BUILTIN_DEFAULT — older clients that
  // don't send this field still get the safe default.
  disable_multi_advertiser_ads: z.boolean().default(true),
  // Default to true (only show currently-serving items in launch dropdowns)
  show_active_only_default: z.boolean().default(true),
});

// -----------------------------------------------------------------
// Global
// -----------------------------------------------------------------

launchDefaultsRouter.get(
  '/settings/launch-defaults',
  requireAuth,
  async (_req: Request, res: Response) => {
    const config = await launchDefaults.getGlobalConfig();
    const effective = launchDefaults.effectiveEnhancements(config);
    res.json({ config, effective });
  }
);

launchDefaultsRouter.put(
  '/settings/launch-defaults',
  requireAuth,
  requireRole('admin'),
  async (req: Request, res: Response) => {
    const parsed = configSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid config', detail: parsed.error.flatten() });
    }
    await launchDefaults.setGlobalConfig(
      parsed.data as launchDefaults.LaunchDefaultsConfig,
      req.user!.id
    );
    await audit({
      userId: req.user!.id,
      action: 'launch_defaults.global.updated',
      metadata: { config: parsed.data },
      ipAddress: req.ip,
    });
    const config = await launchDefaults.getGlobalConfig();
    res.json({ config, effective: launchDefaults.effectiveEnhancements(config) });
  }
);

// -----------------------------------------------------------------
// Per-account
// -----------------------------------------------------------------

const UUID_RX = /^[0-9a-f-]{36}$/i;

launchDefaultsRouter.get(
  '/ad-accounts/:id/launch-defaults',
  requireAuth,
  async (req: Request, res: Response) => {
    const id = req.params.id as string;
    if (!UUID_RX.test(id)) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    const accountConfig = await launchDefaults.getAccountConfig(id);
    const resolved = await launchDefaults.resolveForAccount(id);
    res.json({
      hasOverride: accountConfig !== null,
      config: resolved.config,
      source: resolved.source,
      effective: launchDefaults.effectiveEnhancements(resolved.config),
    });
  }
);

launchDefaultsRouter.put(
  '/ad-accounts/:id/launch-defaults',
  requireAuth,
  requireRole('admin'),
  async (req: Request, res: Response) => {
    const id = req.params.id as string;
    if (!UUID_RX.test(id)) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    const parsed = configSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid config', detail: parsed.error.flatten() });
    }
    await launchDefaults.setAccountConfig(
      id,
      parsed.data as launchDefaults.LaunchDefaultsConfig,
      req.user!.id
    );
    await audit({
      userId: req.user!.id,
      action: 'launch_defaults.account.updated',
      resourceType: 'ad_account',
      resourceId: id,
      metadata: { config: parsed.data },
      ipAddress: req.ip,
    });
    const resolved = await launchDefaults.resolveForAccount(id);
    res.json({
      hasOverride: true,
      config: resolved.config,
      source: resolved.source,
      effective: launchDefaults.effectiveEnhancements(resolved.config),
    });
  }
);

launchDefaultsRouter.delete(
  '/ad-accounts/:id/launch-defaults',
  requireAuth,
  requireRole('admin'),
  async (req: Request, res: Response) => {
    const id = req.params.id as string;
    if (!UUID_RX.test(id)) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    await launchDefaults.setAccountConfig(id, null, req.user!.id);
    await audit({
      userId: req.user!.id,
      action: 'launch_defaults.account.cleared',
      resourceType: 'ad_account',
      resourceId: id,
      ipAddress: req.ip,
    });
    const resolved = await launchDefaults.resolveForAccount(id);
    res.json({
      hasOverride: false,
      config: resolved.config,
      source: resolved.source,
      effective: launchDefaults.effectiveEnhancements(resolved.config),
    });
  }
);
