import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer, Fiber } from "effect"
import { Bus } from "../../src/bus"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Permission } from "../../src/permission"
import { forwardRef } from "../../src/permission/permission-forward-ref"
import { Instance } from "../../src/project/instance"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Log } from "../../src/util"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

const bus = Bus.layer
const env = Layer.mergeAll(Permission.layer.pipe(Layer.provide(bus)), bus, CrossSpawnSpawner.defaultLayer)
const it = testEffect(env)

function buildRequest(extra?: Partial<Parameters<Permission.Interface["ask"]>[0]>) {
  return {
    permission: "edit" as never,
    patterns: ["/some/never-allowed-path"],
    always: ["*"],
    metadata: {},
    sessionID: "ses_child" as never,
    ruleset: [],
    tool: { messageID: "msg_test" as never, callID: "call_test" },
    ...extra,
  }
}

describe("Permission.ask forward mode", () => {
  it.live(
    "a delegation grant for the child auto-resolves allow without a human",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        forwardRef.setGrant("ses_parent", "ses_child")
        const perm = yield* Permission.Service
        // With a grant, the forwarded ask resolves (allow) immediately — no hang.
        const result = yield* perm
          .ask(buildRequest({ forward: { parentSessionID: "ses_parent" } }))
          .pipe(Effect.exit)
        expect(result._tag).toBe("Success")
        forwardRef.clearGrantsForParent("ses_parent")
      }),
    ),
  )

  it.live(
    "an 'all' grant auto-resolves any child of that parent",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        forwardRef.setGrant("ses_parent2", "*")
        const perm = yield* Permission.Service
        const result = yield* perm
          .ask(buildRequest({ sessionID: "ses_whatever" as never, forward: { parentSessionID: "ses_parent2" } }))
          .pipe(Effect.exit)
        expect(result._tag).toBe("Success")
        forwardRef.clearGrantsForParent("ses_parent2")
      }),
    ),
  )

  it.live(
    "granted background subagent: external_directory ask for the main checkout auto-approves",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        // Orchestrator ran `grant-approval` for this child (or `all`). The
        // subagent forwards its external_directory ask (decideAskRouting routes a
        // granted background subagent to forward), and the standing grant
        // resolves it allow without a human — this is the gap the fix closes.
        forwardRef.setGrant("ses_orch", "ses_bg_child")
        const perm = yield* Permission.Service
        const result = yield* perm
          .ask(
            buildRequest({
              permission: "external_directory" as never,
              patterns: ["/Users/me/projects/mi/mimocode/*"],
              always: ["/Users/me/projects/mi/mimocode/*"],
              sessionID: "ses_bg_child" as never,
              forward: { parentSessionID: "ses_orch" },
            }),
          )
          .pipe(Effect.exit)
        expect(result._tag).toBe("Success")
        forwardRef.clearGrantsForParent("ses_orch")
      }),
    ),
  )

  it.live(
    "ungranted foreign path for a background subagent still fails closed (interactive:false)",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        // No grant for this child. decideAskRouting keeps it non-interactive, so
        // the ask (interactive:false) denies immediately — a random foreign path
        // like /tmp/foreign never auto-approves.
        const perm = yield* Permission.Service
        let asked = 0
        const unsub = Bus.subscribe(Permission.Event.Asked, () => {
          asked += 1
        })
        const result = yield* perm
          .ask(
            buildRequest({
              permission: "external_directory" as never,
              patterns: ["/tmp/foreign/*"],
              always: ["/tmp/foreign/*"],
              sessionID: "ses_ungranted" as never,
              interactive: false,
            }),
          )
          .pipe(Effect.exit)
        unsub()
        expect(result._tag).toBe("Failure")
        expect(asked).toBe(0)
      }),
    ),
  )
})
