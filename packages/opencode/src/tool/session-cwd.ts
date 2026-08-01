import { statSync } from "node:fs"
import path from "node:path"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { BusEvent } from "@/bus/bus-event"
import { registerDisposer } from "@/effect/instance-registry"
import { Instance } from "@/project/instance"
import { SessionID } from "@/session/schema"
import { SessionTable } from "@/session/session.sql"
import { Database, eq } from "@/storage"
import { Log } from "@/util"
import z from "zod"

interface Entry {
  directory: string
  cwd: string
}

const log = Log.create({ service: "session-cwd" })
const store = new Map<string, Entry>()

registerDisposer(async (directory) => {
  // Instance state is only a cache. The authoritative cwd remains on the
  // session row so a resumed session can recover it after this disposal or a
  // complete process restart.
  for (const [sessionID, entry] of store) {
    if (entry.directory === directory) store.delete(sessionID)
  }
})

export const Event = {
  Changed: BusEvent.define(
    "session.cwd",
    z.object({
      sessionID: SessionID.zod,
      cwd: z.string(),
    }),
  ),
}

type Validation = { ok: true; cwd: string } | { ok: false; reason: string }

function validate(value: string): Validation {
  if (!path.isAbsolute(value)) return { ok: false, reason: "cwd is not absolute" }

  let cwd: string
  try {
    cwd = AppFileSystem.resolve(value)
  } catch (error) {
    return {
      ok: false,
      reason: `cwd cannot be resolved: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  try {
    if (!statSync(cwd).isDirectory()) return { ok: false, reason: "cwd is not a directory" }
  } catch (error) {
    return {
      ok: false,
      reason: `cwd is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  return { ok: true, cwd }
}

function root(): string {
  return AppFileSystem.resolve(Instance.directory)
}

function write(sessionID: SessionID, directory: string, cwd: string | null): boolean {
  return Database.transaction(
    (tx) => {
      const row = tx
        .select({ directory: SessionTable.directory })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()

      // A few low-level tool tests use a synthetic session ID. Production
      // change_directory calls always have a durable session row; preserving an
      // in-memory-only fallback here keeps SessionCwd usable in those isolated
      // contexts without inventing a second persistence authority.
      if (!row) return false

      const owner = AppFileSystem.resolve(row.directory)
      if (owner !== directory) {
        throw new Error(
          `Session ${sessionID} belongs to ${owner}; refusing to persist cwd from Instance ${directory}`,
        )
      }

      tx.update(SessionTable).set({ cwd }).where(eq(SessionTable.id, sessionID)).run()
      return true
    },
    { behavior: "immediate" },
  )
}

function invalidate(sessionID: SessionID, directory: string, cwd: string, reason: string): string {
  log.warn("discarding invalid persisted session cwd", {
    sessionID,
    cwd,
    directory,
    reason,
  })

  // Recovery itself must fail safe even if cleanup cannot be written (for
  // example, a transient read-only database). Cache the root first and make
  // the cleanup best-effort; the warning remains visible and a later process
  // will re-validate rather than trusting the bad value.
  store.set(sessionID, { directory, cwd: directory })
  try {
    write(sessionID, directory, null)
  } catch (error) {
    log.warn("failed to clear invalid persisted session cwd", {
      sessionID,
      cwd,
      directory,
      error,
    })
  }
  return directory
}

export function get(sessionID: SessionID): string {
  const directory = root()
  const cached = store.get(sessionID)
  if (cached?.directory === directory) {
    const checked = validate(cached.cwd)
    if (checked.ok) return checked.cwd
    return invalidate(sessionID, directory, cached.cwd, checked.reason)
  }

  let row: { directory: string; cwd: string | null } | undefined
  try {
    row = Database.use((db) =>
      db
        .select({ directory: SessionTable.directory, cwd: SessionTable.cwd })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get(),
    )
  } catch (error) {
    // Tool path resolution must never escape to a stale or unknown path when
    // persistence is unreadable. The immutable Instance root is the safe
    // fallback and the failure is deliberately observable in logs.
    log.warn("failed to restore persisted session cwd; using Instance root", {
      sessionID,
      directory,
      error,
    })
    // Do not cache this transient failure: the next tool boundary should retry
    // the durable authority rather than pinning the session to root until the
    // whole Instance is disposed again.
    return directory
  }

  if (!row) {
    store.set(sessionID, { directory, cwd: directory })
    return directory
  }

  const owner = AppFileSystem.resolve(row.directory)
  if (owner !== directory) {
    log.warn("refusing persisted session cwd from a different Instance root", {
      sessionID,
      sessionDirectory: owner,
      instanceDirectory: directory,
      cwd: row.cwd,
    })
    return directory
  }

  if (!row.cwd) {
    store.set(sessionID, { directory, cwd: directory })
    return directory
  }

  const checked = validate(row.cwd)
  if (!checked.ok) return invalidate(sessionID, directory, row.cwd, checked.reason)

  store.set(sessionID, { directory, cwd: checked.cwd })
  return checked.cwd
}

export function set(sessionID: SessionID, dir: string): void {
  const directory = root()
  const checked = validate(dir)
  if (!checked.ok) throw new Error(`Cannot set session cwd: ${checked.reason}`)
  if (checked.cwd === directory) return clear(sessionID)

  // Commit durable authority before publishing the new cache value. A failed
  // write leaves both the persisted and in-process cwd unchanged.
  write(sessionID, directory, checked.cwd)
  store.set(sessionID, { directory, cwd: checked.cwd })
}

export function clear(sessionID: SessionID): void {
  const directory = root()
  // Reset is a durable null tombstone, not merely a cache eviction. This keeps
  // `~`/empty-path semantics stable across Instance disposal and restart.
  write(sessionID, directory, null)
  store.set(sessionID, { directory, cwd: directory })
}

export * as SessionCwd from "./session-cwd"
