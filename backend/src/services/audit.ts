/**
 * Audit log — records every meaningful action.
 *
 * Use sparingly. We don't log "user viewed dashboard." We log:
 *   - user.login.success
 *   - user.login.failure
 *   - user.logout
 *   - user.created
 *   - user.password_changed
 *   - batch.launched
 *   - batch.failed
 *   - template.created
 *   - template.deleted
 *
 * When debugging "what happened to my ads on Tuesday?" this is the trail.
 */
import { query } from '../db/pool';

export interface AuditEntry {
  userId?: string | null;
  action: string;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
}

export async function audit(entry: AuditEntry): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_log (user_id, action, resource_type, resource_id, metadata, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        entry.userId ?? null,
        entry.action,
        entry.resourceType ?? null,
        entry.resourceId ?? null,
        JSON.stringify(entry.metadata ?? {}),
        entry.ipAddress ?? null,
      ]
    );
  } catch (err) {
    // Audit failures should never break the request — log and move on
    console.error('[audit] Failed to write entry:', err, entry);
  }
}
