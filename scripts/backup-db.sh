#!/usr/bin/env bash
set -euo pipefail

# Backup Claude Memory databases
# Run via cron: 0 3 * * * /opt/claude-memory/app/scripts/backup-db.sh

DATA_DIR="${DATA_DIR:-/opt/claude-memory/data}"
BACKUP_DIR="${BACKUP_DIR:-/opt/claude-memory/backups}"
RETENTION_DAYS=30

mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/claude-memory-$TIMESTAMP.tar.gz"

echo "Backing up databases from $DATA_DIR..."

# Use SQLite backup command for safe online backup
for db in $(find "$DATA_DIR" -name "*.db" -type f); do
  BACKUP_DB="${db}.backup"
  sqlite3 "$db" ".backup '$BACKUP_DB'"
done

# Create tar of all backup files
tar -czf "$BACKUP_FILE" -C "$DATA_DIR" $(find "$DATA_DIR" -name "*.db.backup" -printf "%P\n")

# Clean up individual backup files
find "$DATA_DIR" -name "*.db.backup" -delete

# Remove old backups
find "$BACKUP_DIR" -name "claude-memory-*.tar.gz" -mtime +$RETENTION_DAYS -delete

SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "Backup complete: $BACKUP_FILE ($SIZE)"
echo "Retained: last $RETENTION_DAYS days"
