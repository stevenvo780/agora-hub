# NAS PostgreSQL 17 deployment package

This directory contains the deployment assets prepared for the NAS data server.

## Target

- Host: `nass-stev`
- NetBird IP: `100.98.67.189`
- Engine: PostgreSQL 17
- Compose project path on NAS: `/mnt/pool/datos/educacion-cooperativa/postgres/compose`
- Data path on NAS: `/mnt/pool/datos/educacion-cooperativa/postgres/data`
- Backups path on NAS: `/mnt/pool/datos/educacion-cooperativa/postgres/backups`
- Port: `100.98.67.189:5433 -> 5432/tcp`

## Files

- `docker-compose.yml`: PostgreSQL 17 service definition.
- `.env.example`: non-secret variable template.
- `deploy-over-ssh.sh`: idempotent deployment helper to run from the workstation once SSH is available.
- `verify-over-ssh.sh`: post-deployment persistence and connectivity checks.
- `unblock-nas-admin.md`: local NAS checklist to restore SSH/admin access safely.

## Current blocker

SSH/admin access to the NAS is not currently available. See `../../docs/10-nas-postgresql17-preflight.md` for the latest audit and blockers.

If you are at the NAS console, follow `unblock-nas-admin.md` first.

## Secret policy

Create the real `.env` only on the NAS with mode `0600`. Store the generated database password in Vaultwarden/Bitwarden, not in this repository.
