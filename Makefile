# ============================================================
# Vass — Makefile
# Friendly aliases for common Docker Compose commands.
# Usage: `make <target>` (e.g. `make up`, `make logs`)
# ============================================================

.PHONY: help up down restart logs ps build migrate create-user backup shell-db shell-backend update clean

# Default: show available commands
help:
	@echo "Vass — available commands:"
	@echo ""
	@echo "  make up             Start all services in the background"
	@echo "  make down           Stop all services (data preserved)"
	@echo "  make restart        Restart all services"
	@echo "  make logs           Follow logs from all services"
	@echo "  make ps             Show running containers"
	@echo "  make build          Rebuild containers from source"
	@echo "  make migrate        Run database migrations"
	@echo "  make create-user    Create a new user (interactive)"
	@echo "  make backup         Create a timestamped database backup"
	@echo "  make shell-db       Open a Postgres shell"
	@echo "  make shell-backend  Open a shell inside the backend container"
	@echo "  make update         Pull latest code, rebuild, restart, migrate"
	@echo "  make clean          Stop services and remove unused Docker resources"
	@echo ""

up:
	docker compose up -d
	@echo "✓ Vass is starting. Run 'make logs' to follow."

down:
	docker compose down

restart:
	docker compose restart

logs:
	docker compose logs -f

ps:
	docker compose ps

build:
	docker compose up -d --build

migrate:
	docker compose exec backend npm run migrate

create-user:
	docker compose exec backend npm run create-user

backup:
	@mkdir -p backups
	@FILENAME="backups/vass-$$(date +%Y%m%d-%H%M%S).sql.gz"; \
	docker compose exec -T postgres pg_dump -U vass vass | gzip > "$$FILENAME"; \
	echo "✓ Backup saved to $$FILENAME"

shell-db:
	docker compose exec postgres psql -U vass -d vass

shell-backend:
	docker compose exec backend sh

update:
	@echo "→ Pulling latest code..."
	git pull
	@echo "→ Rebuilding containers..."
	docker compose up -d --build
	@echo "→ Running migrations..."
	docker compose exec backend npm run migrate
	@echo "✓ Update complete."

clean:
	docker compose down
	docker system prune -f
	@echo "✓ Cleaned up unused Docker resources. Data is preserved."
