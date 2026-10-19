import type { Database } from '../db/client.js'
import { auditLogs } from '../db/schema.js'

export interface AuditEntry {
  userId?: string | null
  username?: string | null
  action: string
  target?: string | null
  ip?: string | null
  success: boolean
  details?: Record<string, unknown>
}

export async function audit(db: Database, entry: AuditEntry): Promise<void> {
  await db.insert(auditLogs).values({
    userId: entry.userId ?? null,
    username: entry.username ?? null,
    action: entry.action,
    target: entry.target ?? null,
    ip: entry.ip ?? null,
    success: entry.success,
    details: entry.details ?? null,
  })
}
