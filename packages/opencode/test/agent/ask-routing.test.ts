import { describe, expect, test } from "bun:test"
import { decideAskRouting } from "../../src/agent/config"

describe("decideAskRouting", () => {
  test("system agent (by actor) -> non-interactive, no forward", () => {
    const r = decideAskRouting({
      askActor: { agent: "checkpoint-writer", background: true, mode: "subagent" },
      sessionParentID: "ses_parent",
      agentName: "checkpoint-writer",
    })
    expect(r.interactive).toBe(false)
    expect(r.forward).toBeUndefined()
  })

  test("system agent (by name, no actor row) -> non-interactive", () => {
    const r = decideAskRouting({ sessionParentID: undefined, agentName: "dream" })
    expect(r.interactive).toBe(false)
    expect(r.forward).toBeUndefined()
  })

  test("orchestrator peer (background + mode:peer + parent) -> forward", () => {
    const r = decideAskRouting({
      askActor: { agent: "build", background: true, mode: "peer", parentActorID: "main" },
      sessionParentID: "ses_orchestrator",
      agentName: "build",
    })
    expect(r.interactive).toBe(true)
    expect(r.forward).toEqual({ parentSessionID: "ses_orchestrator" })
  })

  test("compose subagent (background + mode:subagent) -> non-interactive, no forward", () => {
    const r = decideAskRouting({
      askActor: { agent: "general", background: true, mode: "subagent" },
      sessionParentID: "ses_parent",
      agentName: "general",
    })
    expect(r.interactive).toBe(false)
    expect(r.forward).toBeUndefined()
  })

  test("normal foreground (no actor, not system) -> interactive, no forward", () => {
    const r = decideAskRouting({ sessionParentID: undefined, agentName: "build" })
    expect(r.interactive).toBe(true)
    expect(r.forward).toBeUndefined()
  })

  test("peer WITHOUT a parent -> not forwarded (falls to background auto-deny)", () => {
    const r = decideAskRouting({
      askActor: { agent: "build", background: true, mode: "peer" },
      sessionParentID: undefined,
      agentName: "build",
    })
    expect(r.interactive).toBe(false)
    expect(r.forward).toBeUndefined()
  })

  test("orchestrator disabled (flag off) -> peer does NOT forward, auto-denies", () => {
    const r = decideAskRouting({
      askActor: { agent: "build", background: true, mode: "peer", parentActorID: "main" },
      sessionParentID: "ses_orchestrator",
      agentName: "build",
      orchestratorEnabled: false,
    })
    expect(r.interactive).toBe(false)
    expect(r.forward).toBeUndefined()
  })

  test("GRANTED background subagent (background + parent + grantResolved) -> forward", () => {
    // The documented gap: a granted background subagent's ask (e.g.
    // external_directory for the main checkout) must forward so the standing
    // grant short-circuits it to allow instead of hard-denying.
    const r = decideAskRouting({
      askActor: { agent: "general", background: true, mode: "subagent" },
      sessionParentID: "ses_orchestrator",
      agentName: "general",
      grantResolved: true,
    })
    expect(r.interactive).toBe(true)
    expect(r.forward).toEqual({ parentSessionID: "ses_orchestrator" })
  })

  test("UNGRANTED background subagent (grantResolved false) -> still auto-denies", () => {
    // Safety: without a grant, the background subagent keeps failing closed —
    // a random foreign path never silently forwards into an allow.
    const r = decideAskRouting({
      askActor: { agent: "general", background: true, mode: "subagent" },
      sessionParentID: "ses_orchestrator",
      agentName: "general",
      grantResolved: false,
    })
    expect(r.interactive).toBe(false)
    expect(r.forward).toBeUndefined()
  })

  test("granted background subagent with orchestrator flag OFF -> no forward", () => {
    const r = decideAskRouting({
      askActor: { agent: "general", background: true, mode: "subagent" },
      sessionParentID: "ses_orchestrator",
      agentName: "general",
      grantResolved: true,
      orchestratorEnabled: false,
    })
    expect(r.interactive).toBe(false)
    expect(r.forward).toBeUndefined()
  })

  test("grantResolved without a parent -> no forward (nothing to route to)", () => {
    const r = decideAskRouting({
      askActor: { agent: "general", background: true, mode: "subagent" },
      sessionParentID: undefined,
      agentName: "general",
      grantResolved: true,
    })
    expect(r.interactive).toBe(false)
    expect(r.forward).toBeUndefined()
  })

  test("grantResolved on a FOREGROUND actor -> stays interactive, no forward", () => {
    // grantResolved only elevates BACKGROUND actors; a foreground turn is
    // already interactive and must not be turned into a forward.
    const r = decideAskRouting({
      sessionParentID: "ses_orchestrator",
      agentName: "build",
      grantResolved: true,
    })
    expect(r.interactive).toBe(true)
    expect(r.forward).toBeUndefined()
  })
})
