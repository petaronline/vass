/**
 * Notification routes — the top-bar bell.
 *
 *   GET    /notifications        — recent notifications + unread count
 *   POST   /notifications/read   — mark ids read, or all when body is empty
 *   DELETE /notifications        — clear all of the user's notifications
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import * as notifications from '../services/notifications';

export const notificationsRouter = Router();

notificationsRouter.get('/', requireAuth, async (req: Request, res: Response) => {
  const [rows, unread] = await Promise.all([
    notifications.listForUser(req.user!.id, 30),
    notifications.unreadCount(req.user!.id),
  ]);
  res.json({ notifications: rows.map(rowToNotification), unreadCount: unread });
});

const readSchema = z.object({
  ids: z.array(z.string().uuid()).max(200).optional(),
});

notificationsRouter.post('/read', requireAuth, async (req: Request, res: Response) => {
  const parsed = readSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', issues: parsed.error.issues });
  }
  const updated = await notifications.markRead(req.user!.id, parsed.data.ids);
  res.json({ updated });
});

notificationsRouter.delete('/', requireAuth, async (req: Request, res: Response) => {
  const deleted = await notifications.clearAll(req.user!.id);
  res.json({ deleted });
});

function rowToNotification(r: notifications.NotificationRow) {
  return {
    id: r.id,
    type: r.type,
    severity: r.severity,
    title: r.title,
    body: r.body,
    link: r.link,
    metadata: r.metadata,
    readAt: r.read_at,
    createdAt: r.created_at,
  };
}
