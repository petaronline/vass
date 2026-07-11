#!/usr/bin/env python3
"""
Patch the live docker-compose.yml at /opt/vass/docker-compose.yml to add:
  1. A new named volume `uploads_data`
  2. A mount on the backend service: /uploads → uploads_data
  3. The UPLOAD_ROOT env var on backend (defaults to /uploads anyway, but explicit)

Idempotent — safe to run multiple times. Detects existing config.
"""
import sys
import re

COMPOSE_PATH = '/opt/vass/docker-compose.yml'

try:
    content = open(COMPOSE_PATH).read()
except FileNotFoundError:
    print(f'ERROR: {COMPOSE_PATH} not found', file=sys.stderr)
    sys.exit(1)

# --- 1. Add uploads_data to top-level volumes section if missing ---
if 'uploads_data' not in content:
    # Find the `volumes:` block at the bottom and add our volume.
    # We look for a line that is exactly `volumes:` at the start (no leading space),
    # since service-level volume keys are indented.
    new_content = re.sub(
        r'(^volumes:\s*\n)',
        r'\1  uploads_data:\n',
        content,
        count=1,
        flags=re.MULTILINE,
    )
    if new_content == content:
        # `volumes:` block didn't exist — add one at the end
        new_content = content.rstrip() + '\n\nvolumes:\n  uploads_data:\n'
    content = new_content
    print('  + added uploads_data volume')
else:
    print('  ✓ uploads_data volume already present')

# --- 2. Add the mount to backend service ---
# Find the `backend:` service block and either add a `volumes:` key
# or append to existing one.

# Identify the backend service section. Match its line + following indented lines.
backend_match = re.search(
    r'(^  backend:\n(?:    .*\n)+)',
    content,
    flags=re.MULTILINE,
)
if not backend_match:
    print('ERROR: could not find `backend:` service block', file=sys.stderr)
    sys.exit(1)

backend_block = backend_match.group(1)

if 'uploads_data:/uploads' in backend_block:
    print('  ✓ backend uploads mount already present')
else:
    # Does backend already have a `volumes:` sub-key?
    vol_re = re.compile(r'^(    volumes:\n)', re.MULTILINE)
    if vol_re.search(backend_block):
        new_block = vol_re.sub(
            r'\1      - uploads_data:/uploads\n',
            backend_block,
            count=1,
        )
    else:
        # No volumes key in backend — add one at the end of the block
        new_block = backend_block.rstrip('\n') + '\n    volumes:\n      - uploads_data:/uploads\n'
    content = content.replace(backend_block, new_block, 1)
    print('  + added backend → uploads_data:/uploads mount')

# --- 3. Add UPLOAD_ROOT env var (explicit) ---
if 'UPLOAD_ROOT' in content:
    print('  ✓ UPLOAD_ROOT env already present')
else:
    backend_match = re.search(
        r'(^  backend:\n(?:    .*\n)+)',
        content,
        flags=re.MULTILINE,
    )
    backend_block = backend_match.group(1)
    # Look for `    environment:` block in backend and add UPLOAD_ROOT
    env_re = re.compile(r'(^    environment:\n)', re.MULTILINE)
    m = env_re.search(backend_block)
    if m:
        new_block = backend_block.replace(
            m.group(1),
            m.group(1) + '      UPLOAD_ROOT: /uploads\n',
            1,
        )
        content = content.replace(backend_block, new_block, 1)
        print('  + added UPLOAD_ROOT env var to backend')
    else:
        print('  ⚠ could not find backend `environment:` block — skipping UPLOAD_ROOT env')

# --- Write back ---
open(COMPOSE_PATH, 'w').write(content)
print(f'\nDone. {COMPOSE_PATH} updated.')
print('Run `cd /opt/vass && docker compose up -d --build backend` to apply.')
