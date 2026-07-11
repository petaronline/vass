/**
 * Create a user from the command line.
 *
 * Use this to bootstrap the first admin account after initial deploy.
 *
 * Recommended usage (password from environment variable, never appears on screen):
 *
 *   docker compose exec -e VASS_PASSWORD='your-password' backend npm run create-user -- \
 *     --email admin@example.com --name "Your Name" --role admin
 *
 * The password is read from VASS_PASSWORD if set. Otherwise the script
 * refuses to run interactively, because Docker exec in non-TTY mode
 * can echo passwords back to the screen.
 */
import { createUser, findUserByEmail, UserRole } from '../services/users';
import { closePool } from '../db/pool';

interface Args {
  email?: string;
  name?: string;
  role?: UserRole;
}

function parseArgs(): Args {
  const args: Args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const flag = process.argv[i];
    const value = process.argv[i + 1];
    if (flag === '--email') args.email = value;
    if (flag === '--name') args.name = value;
    if (flag === '--role') args.role = value as UserRole;
  }
  return args;
}

function usage(): never {
  console.error('');
  console.error('Usage:');
  console.error('  docker compose exec \\');
  console.error('    -e VASS_EMAIL="user@example.com" \\');
  console.error('    -e VASS_NAME="Full Name" \\');
  console.error('    -e VASS_ROLE="admin" \\');
  console.error('    -e VASS_PASSWORD="your-password-12-chars-min" \\');
  console.error('    backend npm run create-user');
  console.error('');
  console.error('Or pass email/name/role as flags and only the password as an env var:');
  console.error('  docker compose exec \\');
  console.error('    -e VASS_PASSWORD="your-password" \\');
  console.error('    backend npm run create-user -- \\');
  console.error('      --email user@example.com --name "Full Name" --role admin');
  console.error('');
  console.error('Roles: admin, member, viewer (default: admin)');
  console.error('Password requirement: at least 12 characters.');
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs();

  const email = (process.env.VASS_EMAIL ?? args.email ?? '').trim().toLowerCase();
  const name = (process.env.VASS_NAME ?? args.name ?? '').trim();
  const role = (process.env.VASS_ROLE ?? args.role ?? 'admin').trim() as UserRole;
  const password = process.env.VASS_PASSWORD ?? '';

  try {
    if (!email) {
      console.error('Missing email. Provide via VASS_EMAIL or --email');
      usage();
    }
    if (!email.includes('@')) {
      throw new Error(`Invalid email: ${email}`);
    }
    if (!name) {
      console.error('Missing name. Provide via VASS_NAME or --name');
      usage();
    }
    if (!['admin', 'member', 'viewer'].includes(role)) {
      throw new Error(`Invalid role: ${role}`);
    }
    if (!password) {
      console.error('');
      console.error('Missing password. The password MUST be provided via the');
      console.error('VASS_PASSWORD environment variable, not interactively, so');
      console.error('it never appears on screen.');
      usage();
    }
    if (password.length < 12) {
      throw new Error('Password must be at least 12 characters');
    }

    const existing = await findUserByEmail(email);
    if (existing) {
      throw new Error(`A user with email ${email} already exists`);
    }

    const user = await createUser({ email, name, password, role });
    console.log(`\n✓ Created user: ${user.name} <${user.email}> (${user.role})`);
    console.log(`  User ID: ${user.id}`);
  } catch (err) {
    console.error('\n✗ Failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

main();
