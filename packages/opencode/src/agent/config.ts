/** Agent types that are spawned by the runtime (prune, scheduler, system code),
 *  NOT by the model. They get tool whitelist defaults and are skipped by
 *  prune/bootstrap/memory/recall scans.
 */
export const SYSTEM_SPAWNED_AGENT_TYPES: ReadonlySet<string> = new Set(["checkpoint-writer", "dream", "distill"])

/** Decide how a permission `ask` from the current turn should be routed:
 *  - system agent -> non-interactive (auto-deny, no human to answer)
 *  - orchestrator peer (background + mode:peer + has a parent) -> forward the ask
 *    for approval (interactive, with the parent session as approval route)
 *  - GRANTED background subagent (background + has a parent whose orchestrator
 *    already ran `grant-approval` for this child) -> forward the ask, so the
 *    standing grant short-circuits it to allow (see Permission.ask grant path).
 *    Without this, a background subagent's `external_directory:ask` for a granted
 *    dir (e.g. the main checkout) would hit the auto-deny path below and fail
 *    closed — `grant-approval` would never reach it. This is the documented gap.
 *  - other (ungranted) background (e.g. compose subagents) -> non-interactive
 *    (auto-deny) — unchanged fail-fast, so a random foreign path still denies.
 *  - normal foreground -> interactive
 *  Pure function so the gate is unit-testable without a full prompt turn. The
 *  caller resolves `grantResolved` (via forwardRef.grantAllowed) since that
 *  consults process-global + on-disk grant state this pure fn must not touch.
 */
export function decideAskRouting(input: {
  askActor?: { agent: string; background: boolean; mode: string; parentActorID?: string }
  sessionParentID?: string
  agentName: string
  // When false, orchestrator-peer forwarding is disabled (feature flag off) and
  // a peer falls back to the background auto-deny path.
  orchestratorEnabled?: boolean
  // True when the parent orchestrator holds a standing grant (grant-approval)
  // covering this child. Only a granted background subagent forwards; an
  // ungranted one keeps failing closed (no hang, no silent broad allow).
  grantResolved?: boolean
}): { interactive: boolean; forward?: { parentSessionID: string } } {
  const isSystemAgent = input.askActor
    ? SYSTEM_SPAWNED_AGENT_TYPES.has(input.askActor.agent)
    : SYSTEM_SPAWNED_AGENT_TYPES.has(input.agentName)
  if (isSystemAgent) return { interactive: false }
  const isOrchestratorPeer =
    input.orchestratorEnabled !== false &&
    !!input.askActor?.background &&
    input.askActor?.mode === "peer" &&
    !!(input.askActor?.parentActorID || input.sessionParentID)
  if (isOrchestratorPeer && input.sessionParentID) {
    return { interactive: true, forward: { parentSessionID: input.sessionParentID } }
  }
  // Granted background subagent: the orchestrator has pre-authorized this child,
  // so forward the ask — Permission.ask's grant short-circuit resolves it allow
  // immediately (no human, no hang). Gated by grantResolved so an ungranted
  // background actor still auto-denies below rather than forwarding into the
  // bounded deny-timeout wait.
  if (
    input.orchestratorEnabled !== false &&
    input.grantResolved &&
    !!input.askActor?.background &&
    !!input.sessionParentID
  ) {
    return { interactive: true, forward: { parentSessionID: input.sessionParentID } }
  }
  return { interactive: !input.askActor?.background }
}
