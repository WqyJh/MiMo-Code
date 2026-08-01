import path from "path"
import type * as Tool from "./tool"
import { SessionCwd } from "./session-cwd"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { RecoverableError } from "./recoverable"
import type { SessionID } from "../session/schema"

export const RESOLVED_READ_PATH_METADATA_KEY = "resolvedReadPath"

// Same normalization both sides of the comparison go through so a Read on
// a relative path lines up with an Edit on the absolute one.
function canon(sessionID: SessionID, cwd: string | undefined, p: string): string {
  const abs = path.isAbsolute(p) ? p : path.resolve(cwd ?? SessionCwd.get(sessionID), p)
  if (process.platform === "win32") return AppFileSystem.normalizePath(abs).toLowerCase()
  return abs
}

/**
 * Throws RecoverableError if the given file was not previously read by the
 * `read` tool in this conversation. Writes/edits to existing files must be
 * preceded by a Read so the model sees the current contents — this turns the
 * usage note in edit.txt into actual enforcement.
 *
 * RecoverableError is intentional: the failure is surfaced to the agent as a
 * tool result it can act on (call Read, then retry) rather than as a hard
 * system fault.
 */
export function assertFileRead(ctx: Tool.Context, targetPath: string, toolId: string): void {
  const target = canon(ctx.sessionID, ctx.cwd, targetPath)

  for (const msg of ctx.messages) {
    for (const part of msg.parts) {
      if (part.type !== "tool") continue
      if (part.tool !== "read") continue
      if (part.state.status !== "completed") continue

      // New Read calls persist the path resolved against that call's cwd. Do
      // not re-resolve a historical relative argument against this Edit call's
      // cwd: change_directory may have moved the session in between.
      const resolved = part.state.metadata?.[RESOLVED_READ_PATH_METADATA_KEY]
      if (typeof resolved === "string" && path.isAbsolute(resolved)) {
        if (canon(ctx.sessionID, undefined, resolved) === target) return
        continue
      }

      // Backward compatibility for transcripts created before resolved paths
      // were persisted. Absolute arguments are unambiguous; historical
      // relative arguments are intentionally fail-closed.
      const input = part.state.input as { file_path?: unknown } | undefined
      const fp = input?.file_path
      if (typeof fp !== "string" || !path.isAbsolute(fp)) continue
      if (canon(ctx.sessionID, undefined, fp) === target) return
    }
  }

  throw new RecoverableError(
    `${toolId}: ${targetPath} has not been read in this conversation. Call the read tool on this file first, then retry.`,
  )
}
