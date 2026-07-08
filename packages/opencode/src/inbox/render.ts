import type { InboxRow } from "./inbox.sql"

export function renderInboxRow(row: InboxRow): string {
  if (row.type === "actor_notification") {
    // Pre-rendered notification text — sender produced the full
    // <actor-notification>...</actor-notification> wrapper.
    const content = row.content as { text?: string }
    return content.text ?? "(no notification body)"
  }
  // Default: type === "text" or unknown — wrap as <inbox> element so
  // the LLM can route by sender; the wrapper format mirrors the
  // <actor-notification> convention from the legacy completion.ts.
  const content = row.content as { text?: string }
  const sender = row.sender_session_id
    ? `${row.sender_session_id}:${row.sender_actor_id ?? "?"}`
    : "system"
  const sentAt = new Date(row.created_at).toISOString()
  return `<inbox from="${sender}" sent_at="${sentAt}">\n${content.text ?? "(empty)"}\n</inbox>`
}

export function renderActorNotification(event: {
  actorID: string
  description: string
  status: "completed" | "failed" | "cancelled" | "stalled"
  result?: string
  error?: string
  reportedStatus?: string
  reportedSummary?: string
  // For a stalled notification: how long (ms) since the child's last turn advanced.
  stalledForMs?: number
}): string {
  const header = `Background actor "${event.description}" (actor_id: ${event.actorID})`
  if (event.status === "completed") {
    const statusLine = `Status: ${event.reportedStatus ?? "unknown"}`
    const summaryLine = event.reportedSummary ? `\nSummary: ${event.reportedSummary}` : ""
    return `<actor-notification>\n${header} completed.\n${statusLine}${summaryLine}\nResult: ${event.result ?? "(no output)"}\n</actor-notification>`
  }
  if (event.status === "failed") {
    return `<actor-notification>\n${header} failed.\nError: ${event.error ?? "unknown"}\n</actor-notification>`
  }
  if (event.status === "stalled") {
    const forLine =
      event.stalledForMs !== undefined ? ` (no turn advance for ${Math.floor(event.stalledForMs / 1000)}s)` : ""
    return `<actor-notification>\n${header} appears stalled${forLine}. It is still running but has made no progress. Consider checking on it, sending it a nudge, or cancelling it.\n</actor-notification>`
  }
  return `<actor-notification>\n${header} was cancelled.\n</actor-notification>`
}
