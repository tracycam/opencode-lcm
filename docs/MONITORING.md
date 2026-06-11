# Monitoring and Operations Guide

Monitoring the Lossless Context Memory (LCM) plugin ensures your archived session data remains healthy and storage usage stays within bounds. Regular checks prevent database bloat and keep search indexes fast. It's best to track these metrics to avoid performance issues.

## Health Metrics

The `lcm_status` tool exposes several health metrics. You can query these metrics to monitor the state of the LCM archive.

| Metric Field | Description | Suggested Alert Threshold |
| :--- | :--- | :--- |
| `db_bytes` | Size of the SQLite database file on disk. | Warn > 300MB, Critical > 500MB |
| `wal_bytes` | Current size of the SQLite Write-Ahead Log file. | Warn > 50MB, Critical > 100MB |
| `shm_bytes` | Active size of the SQLite shared memory file. | Warn > 8MB, Critical > 16MB |
| `total_bytes` | Combined storage size of the database, WAL, and SHM files. | Warn > 400MB, Critical > 600MB |
| `total_events` | Count of all captured events in the archive. | Informational |
| `prunable_events` | Number of events eligible for pruning. | Warn > 5000, Critical > 10000 |
| `session_count` | Total number of archived sessions. | Informational |
| `root_sessions` | Number of root sessions that have no parent. | Informational |
| `branched_sessions` | Total branched sessions created from other sessions. | Informational |
| `pinned_sessions` | Active sessions protected from pruning. | Warn > 50, Critical > 100 |
| `summary_nodes` | Number of summary nodes. | Informational |
| `summary_states` | Sum of summary states. | Informational |
| `artifacts` | Count of externalized artifacts. | Informational |
| `artifact_blobs` | Deduplicated artifact blobs count. | Informational |
| `shared_artifact_blobs` | Count of artifact blobs shared across multiple sessions. | Informational |
| `orphan_artifact_blobs` | Count of orphaned artifact blobs with no session references. | Informational |
| `message_fts` | Entry count in the message full-text search index. | Informational |
| `summary_fts` | Total entries in the summary full-text search index. | Informational |
| `artifact_fts` | Active entries in the artifact full-text search index. | Informational |

## Retention Operations

Manual retention tasks help keep the archive size under control. You can preview pruning candidates before deleting any data. The `lcm_retention_report` tool shows what would be pruned based on your retention settings. To run a preview, execute the tool without applying changes. If you want to apply the pruning, use `lcm_retention_prune` with the `apply` argument set to `true`.

### Previewing Retention Candidates

Run `lcm_retention_report` to see which sessions and blobs are eligible for pruning. This tool accepts the following arguments:

- `staleSessionDays`: Number of days before a session is considered stale. This defaults to `undefined` (disabled), meaning stale sessions are never pruned unless you explicitly configure it. Example: set to 90 to prune sessions with no activity in 90 days.
- `deletedSessionDays`: Number of days before a deleted session is pruned (default is 30).
- `orphanBlobDays`: Number of days before an orphaned artifact blob is pruned (default is 14).
- `limit`: Maximum number of candidates to display in the preview (default is 10).

### Applying Retention Pruning

Run `lcm_retention_prune` to delete stale sessions and orphaned blobs. This tool accepts the same arguments as `lcm_retention_report`, plus:

- `apply`: Set to `true` to execute the deletion. If `false` or omitted, it runs in dry-run mode.

### Garbage Collecting Orphan Blobs

Run `lcm_blob_gc` to clean up orphaned artifact blobs that are no longer referenced by any session. This tool accepts:

- `apply`: Set to `true` to delete the orphaned blobs.
- `limit`: Maximum number of blobs to display in the preview (default is 10).

### Diagnosing and Repairing the Archive

Run `lcm_doctor` to inspect and repair archive summaries, indexes, and lineage. This tool accepts:

- `apply`: Set to `true` to apply repairs.
- `sessionID`: Optional session ID to limit the check to a specific session.
- `limit`: Maximum number of issues to display in the preview (default is 10).

### Pinning and Unpinning Sessions

Run `lcm_pin_session` to protect a session from being pruned. This tool accepts:

- `sessionID`: The ID of the session to pin.
- `reason`: Optional reason for pinning the session.

Run `lcm_unpin_session` to remove the protection pin from a session. This tool accepts:

- `sessionID`: The ID of the session to unpin.

## Automating Retention

No dedicated CLI command exists for tool invocation. Operations must be driven through the assistant's tool interface.

To run retention pruning, ask the assistant in an OpenCode session:

> Run `lcm_retention_prune` with `apply: true`, `staleSessionDays: 90`, and `deletedSessionDays: 30`.

The assistant will invoke the tool with your requested arguments and report results.

To automate recurring retention, create a shell script that starts an OpenCode session and sends an appropriate prompt, then schedule that script via cron or systemd.

## Alerting Rules

Alerting rules help you detect storage issues before they affect performance. This Prometheus alerting rules snippet triggers alerts when database or WAL file sizes exceed recommended thresholds.

```yaml
groups:
  - name: opencode-lcm-alerts
    rules:
      - alert: OpencodeLcmDatabaseTooLarge
        expr: opencode_lcm_db_bytes > 524288000  # 500MB
        for: 1h
        labels:
          severity: critical
        annotations:
          summary: "Opencode LCM database size exceeds 500MB"
          description: "The SQLite database file size is {{ $value }} bytes. Run lcm_retention_prune to free up space."

      - alert: OpencodeLcmDatabaseLargeWarning
        expr: opencode_lcm_db_bytes > 314572800  # 300MB
        for: 4h
        labels:
          severity: warning
        annotations:
          summary: "Opencode LCM database size exceeds 300MB"
          description: "The SQLite database file size is {{ $value }} bytes. Consider reviewing pinned sessions."

      - alert: OpencodeLcmWalFileTooLarge
        expr: opencode_lcm_wal_bytes > 104857600  # 100MB
        for: 15m
        labels:
          severity: critical
        annotations:
          summary: "Opencode LCM WAL file size exceeds 100MB"
          description: "The SQLite Write-Ahead Log size is {{ $value }} bytes. This indicates high write activity or checkpoint failure."

      - alert: OpencodeLcmWalFileLargeWarning
        expr: opencode_lcm_wal_bytes > 52428800  # 50MB
        for: 30m
        labels:
          severity: warning
        annotations:
          summary: "Opencode LCM WAL file size exceeds 50MB"
          description: "The SQLite Write-Ahead Log size is {{ $value }} bytes. Check if checkpointing is running normally."
```

> **Note**: OpenCode LCM does not ship a Prometheus exporter. This snippet is a template that you must wire through your own exporter sidecar.

## CI Integration

No dedicated CLI command exists for tool invocation. Operations must be driven through the assistant's tool interface. Consequently, running automated archive checks like `lcm_doctor` directly in a standard CI pipeline is not supported.

## Troubleshooting

Troubleshooting common operational issues helps maintain a healthy archive. Here are solutions for typical problems you might encounter.

### Write-Ahead Log (WAL) File Growing

The WAL file (`wal_bytes`) should stay small under normal conditions. If it grows beyond 100MB, checkpointing might be blocked.

- **Cause**: Long-running read transactions or active connections can prevent SQLite from checkpointing the WAL file.
- **Solution**: Ensure all OpenCode sessions close properly. You can also run `lcm_doctor` with `apply: true` to force a database check and trigger checkpointing.

### Large Database File Size

If `db_bytes` exceeds 500MB, the archive contains a large volume of historical data.

- **Cause**: High event counts, large externalized artifacts, or long retention periods can cause database growth.
- **Solution**: Run `lcm_retention_prune` with shorter retention periods. For example, set `staleSessionDays` to 45 and `deletedSessionDays` to 15. Also, run `lcm_blob_gc` with `apply: true` to delete orphaned artifact blobs.

### Pinned Sessions Filling Up Storage

Pinned sessions are excluded from pruning, which can lead to storage exhaustion if too many sessions are pinned.

- **Cause**: Automated scripts or users pinning sessions without unpinning them later.
- **Solution**: Check the count of pinned sessions using `lcm_status`. Run `lcm_retention_report` to identify pinned sessions, then use `lcm_unpin_session` to unpin those that are no longer needed.
