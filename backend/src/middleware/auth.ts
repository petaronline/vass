/**
 * Auth middleware.
 *
 * Two flavors:
 *   - requireAuth: 401s if no valid session
 *   - requireRole: 403s if user lacks the role
 */
import { Request, Response, NextFunction } from 'express';
import { findSession } from '../services/sessions';
import { findUserById, User, UserRole } from '../services/users';

// Extend Express Request with our user
declare global {
  namespace Express {
    interface Request {
      user?: User;
      sessionToken?: string;
    }
  }
}

export const SESSION_COOKIE_NAME = 'vass_session';

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = req.cookies[SESSION_COOKIE_NAME];
  if (!token) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const session = await findSession(token);
  if (!session) {
    // Token is invalid or expired — clear the cookie so the browser stops sending it
    res.clearCookie(SESSION_COOKIE_NAME);
    res.status(401).json({ error: 'Session expired' });
    return;
  }

  const user = await findUserById(session.userId);
  if (!user) {
    res.clearCookie(SESSION_COOKIE_NAME);
    res.status(401).json({ error: 'User not found' });
    return;
  }

  req.user = user;
  req.sessionToken = token;
  next();
}

export function requireRole(...allowed: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    if (!allowed.includes(req.user.role)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    next();
  };
}
