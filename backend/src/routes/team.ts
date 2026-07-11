/**
 * Team management — admin-only endpoints for listing, creating, editing,
 * and removing workspace users.
 *
 * GET    /team                     → list every workspace user
 * POST   /team                     → create a new user (admin sets temp password)
 * PATCH  /team/:id/role            → change a user's role
 * DELETE /team/:id                 → soft-delete a user (history preserved)
 *
 * Safety: the "last admin" guard prevents the workspace from being left
 * without any admin. You can't demote or delete the only remaining admin.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../middleware/auth';
import * as users from '../services/users';
import { audit } from '../services/audit';

export const teamRouter = Router();

// =====================================================================
// GET /team
// =====================================================================
teamRouter.get('/', requireAuth, requireRole('admin'), async (_req: Request, res: Response) => {
  const list = await users.listUsers();
  res.json({ users: list });
});

// =====================================================================
// POST /team — create a new user
// Admin enters email, name, role, and a temporary password the user
// will use to sign in. No email invites yet; admin shares the credentials
// out-of-band (Slack, password manager, etc.).
// =====================================================================
const createSchema = z.object({
  email: z.string().email().max(255),
  name: z.string().min(1).max(120),
  role: z.enum(['admin', 'member', 'viewer']).default('member'),
  password: z.string().min(8).max(200),
});

teamRouter.post('/', requireAuth, requireRole('admin'), async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid input',
      details: parsed.error.flatten(),
    });
  }
  const { email, name, role, password } = parsed.data;

  // Email must be unique (active users only — soft-deleted ones don't
  // count because the index is partial on deleted_at).
  const existing = await users.findUserByEmail(email);
  if (existing) {
    return res.status(409).json({ error: 'A user with that email already exists.' });
  }

  try {
    const created = await users.createUser({ email, name, password, role });
    await audit({
      userId: req.user!.id,
      action: 'user.created',
      resourceType: 'user',
      resourceId: created.id,
      metadata: { email: created.email, role: created.role },
      ipAddress: req.ip,
    });
    res.json({ user: created });
  } catch (err) {
    console.error('[team/create] failed:', err);
    const msg = err instanceof Error ? err.message : 'Failed to create user';
    res.status(500).json({ error: msg });
  }
});

// =====================================================================
// PATCH /team/:id/role
// =====================================================================
const roleSchema = z.object({
  role: z.enum(['admin', 'member', 'viewer']),
});

teamRouter.patch(
  '/:id/role',
  requireAuth,
  requireRole('admin'),
  async (req: Request, res: Response) => {
    const id = req.params.id as string;
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return res.status(400).json({ error: 'Invalid user id' });
    }
    const parsed = roleSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Body must include role' });
    }
    const { role } = parsed.data;

    // Last-admin guard: demoting the only admin is rejected so the
    // workspace doesn't lock itself out of admin functions.
    const target = await users.findUserById(id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'admin' && role !== 'admin') {
      const adminCount = await users.countAdmins();
      if (adminCount <= 1) {
        return res.status(400).json({
          error: 'Cannot demote the last admin. Promote another user to admin first.',
        });
      }
    }

    const updated = await users.updateUserRole(id, role);
    if (!updated) return res.status(404).json({ error: 'User not found' });

    await audit({
      userId: req.user!.id,
      action: 'user.role.changed',
      resourceType: 'user',
      resourceId: id,
      metadata: { from: target.role, to: role },
      ipAddress: req.ip,
    });

    res.json({ user: updated });
  }
);

// =====================================================================
// DELETE /team/:id — soft delete
// =====================================================================
teamRouter.delete(
  '/:id',
  requireAuth,
  requireRole('admin'),
  async (req: Request, res: Response) => {
    const id = req.params.id as string;
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return res.status(400).json({ error: 'Invalid user id' });
    }

    // Don't let the admin delete themselves (footgun).
    if (id === req.user!.id) {
      return res.status(400).json({ error: "You can't delete your own account." });
    }

    const target = await users.findUserById(id);
    if (!target) return res.status(404).json({ error: 'User not found' });

    // Last-admin guard
    if (target.role === 'admin') {
      const adminCount = await users.countAdmins();
      if (adminCount <= 1) {
        return res.status(400).json({
          error: 'Cannot delete the last admin. Promote another user first.',
        });
      }
    }

    const ok = await users.softDeleteUser(id);
    if (!ok) return res.status(404).json({ error: 'User not found or already deleted' });

    await audit({
      userId: req.user!.id,
      action: 'user.deleted',
      resourceType: 'user',
      resourceId: id,
      metadata: { email: target.email },
      ipAddress: req.ip,
    });

    res.json({ ok: true });
  }
);
