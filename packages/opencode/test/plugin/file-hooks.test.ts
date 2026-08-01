import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "fs"
import path from "path"
import { tmpdir } from "../fixture/fixture"

const disableDefault = process.env.MIMOCODE_DISABLE_DEFAULT_PLUGINS
process.env.MIMOCODE_DISABLE_DEFAULT_PLUGINS = "1"

const { Plugin } = await import("../../src/plugin/index")
const { Instance } = await import("../../src/project/instance")

afterEach(async () => {
  await Instance.disposeAll()
})

afterAll(() => {
  if (disableDefault === undefined) {
    delete process.env.MIMOCODE_DISABLE_DEFAULT_PLUGINS
    return
  }
  process.env.MIMOCODE_DISABLE_DEFAULT_PLUGINS = disableDefault
})

function hookSource(marker: string) {
  return [
    "export default {",
    '  "experimental.chat.system.transform": async (_input, output) => {',
    `    output.system.push(${JSON.stringify(marker)})`,
    "  },",
    "}",
    "",
  ].join("\n")
}

const triggerTransform = () =>
  Effect.gen(function* () {
    const plugin = yield* Plugin.Service
    const out = { system: [] as string[] }
    yield* plugin.trigger(
      "experimental.chat.system.transform",
      { model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" } as any },
      out,
    )
    return out
  })

function completionHookSource(reason: string) {
  return [
    "export default {",
    '  "session.preStop": async (_input, output) => {',
    '    output.status = "blocked"',
    `    output.reason = ${JSON.stringify(reason)}`,
    "  },",
    "}",
    "",
  ].join("\n")
}

const triggerCompletion = (workspace: string) =>
  Effect.gen(function* () {
    const plugin = yield* Plugin.Service
    return yield* plugin.triggerSessionPreStop({
      sessionID: "ses_file_hook_completion",
      agentID: "main",
      cwd: workspace,
      root: workspace,
      visibleUserMessageID: "msg_visible",
      loadedSkills: [],
    })
  })

describe("plugin file hooks", () => {
  test("keeps a trusted completion provider fail-closed while its file is missing", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.promises.mkdir(path.join(dir, "workspace"), { recursive: true })
        await fs.promises.mkdir(path.join(dir, "trusted-config", "hooks"), { recursive: true })
        await Bun.write(path.join(dir, "workspace", "mimocode.json"), "{}")
        await Bun.write(
          path.join(dir, "trusted-config", "hooks", "completion.ts"),
          completionHookSource("installed provider blocked completion"),
        )
      },
    })
    const workspace = path.join(tmp.path, "workspace")
    const trustedConfig = path.join(tmp.path, "trusted-config")
    const hookFile = path.join(trustedConfig, "hooks", "completion.ts")
    const previousConfigDirectory = process.env.MIMOCODE_CONFIG_DIR
    process.env.MIMOCODE_CONFIG_DIR = trustedConfig

    try {
      const result = await Instance.provide({
        directory: workspace,
        fn: async () =>
          Effect.gen(function* () {
            const installed = yield* triggerCompletion(workspace)

            yield* Effect.promise(async () => {
              await fs.promises.unlink(hookFile)
              await Bun.sleep(600)
            })
            const missing = yield* triggerCompletion(workspace)

            yield* Effect.promise(async () => {
              await Bun.write(hookFile, completionHookSource("restored provider blocked completion"))
              const future = new Date(Date.now() + 5_000)
              await fs.promises.utimes(hookFile, future, future)
              await Bun.sleep(600)
            })
            const restored = yield* triggerCompletion(workspace)
            return { installed, missing, restored }
          }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
      })

      expect(result.installed.status).toBe("blocked")
      expect(result.missing.status).toBe("blocked")
      expect(result.missing.reason).toContain("could not be loaded")
      expect(result.missing.contributingProviderIDs).toEqual(result.installed.contributingProviderIDs)
      expect(result.restored.status).toBe("blocked")
      expect(result.restored.reason).toContain("restored provider blocked completion")
      expect(result.restored.contributingProviderIDs).toEqual(result.installed.contributingProviderIDs)
    } finally {
      if (previousConfigDirectory === undefined) delete process.env.MIMOCODE_CONFIG_DIR
      else process.env.MIMOCODE_CONFIG_DIR = previousConfigDirectory
    }
  })

  test("restores a missing completion-provider tombstone after Instance disposal", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.promises.mkdir(path.join(dir, "workspace"), { recursive: true })
        await fs.promises.mkdir(path.join(dir, "trusted-config", "hooks"), { recursive: true })
        await Bun.write(path.join(dir, "workspace", "mimocode.json"), "{}")
        await Bun.write(
          path.join(dir, "trusted-config", "hooks", "completion.ts"),
          completionHookSource("installed provider blocked completion"),
        )
      },
    })
    const workspace = path.join(tmp.path, "workspace")
    const trustedConfig = path.join(tmp.path, "trusted-config")
    const hookFile = path.join(trustedConfig, "hooks", "completion.ts")
    const previousConfigDirectory = process.env.MIMOCODE_CONFIG_DIR
    process.env.MIMOCODE_CONFIG_DIR = trustedConfig

    try {
      const installed = await Instance.provide({
        directory: workspace,
        fn: async () => triggerCompletion(workspace).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
      })

      await fs.promises.unlink(hookFile)
      await Instance.disposeAll()

      const afterRestart = await Instance.provide({
        directory: workspace,
        fn: async () => triggerCompletion(workspace).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
      })

      expect(installed.status).toBe("blocked")
      expect(afterRestart.status).toBe("blocked")
      expect(afterRestart.reason).toContain("could not be loaded")
      expect(afterRestart.contributingProviderIDs).toEqual(installed.contributingProviderIDs)
    } finally {
      if (previousConfigDirectory === undefined) delete process.env.MIMOCODE_CONFIG_DIR
      else process.env.MIMOCODE_CONFIG_DIR = previousConfigDirectory
    }
  })

  test("fails closed when the persistent completion-provider registry is corrupt", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.promises.mkdir(path.join(dir, "workspace"), { recursive: true })
        await fs.promises.mkdir(path.join(dir, "trusted-config", "hooks"), { recursive: true })
        await Bun.write(path.join(dir, "workspace", "mimocode.json"), "{}")
        await Bun.write(
          path.join(dir, "trusted-config", "hooks", "completion.ts"),
          [
            "export default {",
            '  "session.preStop": async (_input, output) => {',
            '    output.status = "allow"',
            "  },",
            "}",
            "",
          ].join("\n"),
        )
      },
    })
    const workspace = path.join(tmp.path, "workspace")
    const trustedConfig = path.join(tmp.path, "trusted-config")
    const registryFile = path.join(trustedConfig, ".mimocode-state", "completion-providers.json")
    const previousConfigDirectory = process.env.MIMOCODE_CONFIG_DIR
    process.env.MIMOCODE_CONFIG_DIR = trustedConfig

    try {
      const installed = await Instance.provide({
        directory: workspace,
        fn: async () => triggerCompletion(workspace).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
      })
      expect(installed.status).toBe("allow")

      await Instance.disposeAll()
      await Bun.write(registryFile, "{corrupt")

      const afterRestart = await Instance.provide({
        directory: workspace,
        fn: async () => triggerCompletion(workspace).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
      })
      expect(afterRestart.status).toBe("blocked")
      expect(afterRestart.reason).toContain("completion-provider registry could not be read or updated")
    } finally {
      if (previousConfigDirectory === undefined) delete process.env.MIMOCODE_CONFIG_DIR
      else process.env.MIMOCODE_CONFIG_DIR = previousConfigDirectory
    }
  })

  test("can explicitly uninstall a missing trusted completion provider", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.promises.mkdir(path.join(dir, "workspace"), { recursive: true })
        await fs.promises.mkdir(path.join(dir, "trusted-config", "hooks"), { recursive: true })
        await Bun.write(path.join(dir, "workspace", "mimocode.json"), "{}")
        await Bun.write(
          path.join(dir, "trusted-config", "hooks", "completion.ts"),
          completionHookSource("installed provider blocked completion"),
        )
      },
    })
    const workspace = path.join(tmp.path, "workspace")
    const trustedConfig = path.join(tmp.path, "trusted-config")
    const hookFile = path.join(trustedConfig, "hooks", "completion.ts")
    const previousConfigDirectory = process.env.MIMOCODE_CONFIG_DIR
    process.env.MIMOCODE_CONFIG_DIR = trustedConfig

    try {
      const result = await Instance.provide({
        directory: workspace,
        fn: async () =>
          Effect.gen(function* () {
            const plugin = yield* Plugin.Service
            const installed = yield* triggerCompletion(workspace)
            yield* Effect.promise(() => fs.promises.unlink(hookFile))
            yield* plugin.reloadFileHooks({ forgetMissingCompletionProviders: true })
            const uninstalled = yield* triggerCompletion(workspace)
            return { installed, uninstalled }
          }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
      })

      expect(result.installed.status).toBe("blocked")
      expect(result.uninstalled.status).toBe("allow")
      expect(result.uninstalled.contributingProviderIDs).toEqual([])
    } finally {
      if (previousConfigDirectory === undefined) delete process.env.MIMOCODE_CONFIG_DIR
      else process.env.MIMOCODE_CONFIG_DIR = previousConfigDirectory
    }
  })

  test("keeps non-completion project file hooks compatible", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.promises.mkdir(path.join(dir, "workspace", ".mimocode", "hooks"), { recursive: true })
        await fs.promises.mkdir(path.join(dir, "trusted-config"), { recursive: true })
        await Bun.write(path.join(dir, "workspace", "mimocode.json"), "{}")
        await Bun.write(
          path.join(dir, "workspace", ".mimocode", "hooks", "project.ts"),
          hookSource("project-compatible"),
        )
      },
    })
    const workspace = path.join(tmp.path, "workspace")
    const trustedConfig = path.join(tmp.path, "trusted-config")
    const previousConfigDirectory = process.env.MIMOCODE_CONFIG_DIR
    process.env.MIMOCODE_CONFIG_DIR = trustedConfig

    try {
      const out = await Instance.provide({
        directory: workspace,
        fn: async () => triggerTransform().pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
      })
      expect(out.system).toContain("project-compatible")
    } finally {
      if (previousConfigDirectory === undefined) delete process.env.MIMOCODE_CONFIG_DIR
      else process.env.MIMOCODE_CONFIG_DIR = previousConfigDirectory
    }
  })

  test("does not turn an unrelated broken global hook into a completion blocker", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.promises.mkdir(path.join(dir, "workspace"), { recursive: true })
        await fs.promises.mkdir(path.join(dir, "trusted-config", "hooks"), { recursive: true })
        await Bun.write(path.join(dir, "workspace", "mimocode.json"), "{}")
        await Bun.write(
          path.join(dir, "trusted-config", "hooks", "broken-transform.ts"),
          'export default { "experimental.chat.system.transform": async () => {}, this is invalid TypeScript',
        )
      },
    })
    const workspace = path.join(tmp.path, "workspace")
    const trustedConfig = path.join(tmp.path, "trusted-config")
    const previousConfigDirectory = process.env.MIMOCODE_CONFIG_DIR
    process.env.MIMOCODE_CONFIG_DIR = trustedConfig

    try {
      const decision = await Instance.provide({
        directory: workspace,
        fn: async () =>
          Effect.gen(function* () {
            const plugin = yield* Plugin.Service
            return yield* plugin.triggerSessionPreStop({
              sessionID: "ses_broken_non_completion_hook",
              agentID: "main",
              cwd: workspace,
              root: workspace,
              visibleUserMessageID: "msg_visible",
              loadedSkills: [],
            })
          }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
      })

      expect(decision.status).toBe("allow")
      expect(decision.contributingProviderIDs).toEqual([])
    } finally {
      if (previousConfigDirectory === undefined) delete process.env.MIMOCODE_CONFIG_DIR
      else process.env.MIMOCODE_CONFIG_DIR = previousConfigDirectory
    }
  })

  test("loads trusted global hooks and picks up external edits without reload call", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.promises.mkdir(path.join(dir, "workspace"), { recursive: true })
        await fs.promises.mkdir(path.join(dir, "trusted-config", "hooks"), { recursive: true })
        await Bun.write(path.join(dir, "trusted-config", "hooks", "greet.ts"), hookSource("v1"))
        await Bun.write(path.join(dir, "workspace", "mimocode.json"), "{}")
      },
    })
    const workspace = path.join(tmp.path, "workspace")
    const trustedConfig = path.join(tmp.path, "trusted-config")
    const hookFile = path.join(trustedConfig, "hooks", "greet.ts")
    const previousConfigDirectory = process.env.MIMOCODE_CONFIG_DIR
    process.env.MIMOCODE_CONFIG_DIR = trustedConfig

    try {
      const out = await Instance.provide({
        directory: workspace,
        fn: async () =>
          Effect.gen(function* () {
            const first = yield* triggerTransform()
            expect(first.system).toEqual(["v1"])

            // Simulate an EXTERNAL edit (no write/edit tool, no reloadFileHooks):
            // bump content and force a distinct mtime past the staleness throttle.
            fs.writeFileSync(hookFile, hookSource("v2"))
            const future = new Date(Date.now() + 5000)
            fs.utimesSync(hookFile, future, future)
            yield* Effect.promise(() => Bun.sleep(1200))

            return yield* triggerTransform()
          }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
      })

      expect(out.system).toEqual(["v2"])
    } finally {
      if (previousConfigDirectory === undefined) delete process.env.MIMOCODE_CONFIG_DIR
      else process.env.MIMOCODE_CONFIG_DIR = previousConfigDirectory
    }
  })

  test("detects newly added trusted global hook files", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.promises.mkdir(path.join(dir, "workspace"), { recursive: true })
        await fs.promises.mkdir(path.join(dir, "trusted-config", "hooks"), { recursive: true })
        await Bun.write(path.join(dir, "workspace", "mimocode.json"), "{}")
      },
    })
    const workspace = path.join(tmp.path, "workspace")
    const trustedConfig = path.join(tmp.path, "trusted-config")
    const previousConfigDirectory = process.env.MIMOCODE_CONFIG_DIR
    process.env.MIMOCODE_CONFIG_DIR = trustedConfig

    try {
      const out = await Instance.provide({
        directory: workspace,
        fn: async () =>
          Effect.gen(function* () {
            const first = yield* triggerTransform()
            expect(first.system).toEqual([])

            fs.writeFileSync(path.join(trustedConfig, "hooks", "late.ts"), hookSource("late"))
            yield* Effect.promise(() => Bun.sleep(1200))

            return yield* triggerTransform()
          }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
      })

      expect(out.system).toEqual(["late"])
    } finally {
      if (previousConfigDirectory === undefined) delete process.env.MIMOCODE_CONFIG_DIR
      else process.env.MIMOCODE_CONFIG_DIR = previousConfigDirectory
    }
  })

  test("dispatches bus events to file hook event handlers", async () => {
    const { AppRuntime } = await import("../../src/effect/app-runtime")
    const { Bus } = await import("../../src/bus")
    const { Session } = await import("../../src/session")

    await using tmp = await tmpdir({
      init: async (dir) => {
        const sink = path.join(dir, "events.log")
        await fs.promises.mkdir(path.join(dir, "workspace"), { recursive: true })
        await fs.promises.mkdir(path.join(dir, "trusted-config", "hooks"), { recursive: true })
        await Bun.write(path.join(dir, "workspace", "mimocode.json"), "{}")
        await Bun.write(
          path.join(dir, "trusted-config", "hooks", "listener.ts"),
          [
            "import fs from 'fs'",
            "export default {",
            "  event: async ({ event }) => {",
            `    fs.appendFileSync(${JSON.stringify(sink)}, event.type + "\\n")`,
            "  },",
            "}",
            "",
          ].join("\n"),
        )
      },
    })
    const sink = path.join(tmp.path, "events.log")
    const workspace = path.join(tmp.path, "workspace")
    const trustedConfig = path.join(tmp.path, "trusted-config")
    const previousConfigDirectory = process.env.MIMOCODE_CONFIG_DIR
    process.env.MIMOCODE_CONFIG_DIR = trustedConfig

    try {
      await Instance.provide({
        directory: workspace,
        fn: async () =>
          AppRuntime.runPromise(
            Effect.gen(function* () {
              // Force file hook state (and its bus subscription) to initialize.
              const plugin = yield* Plugin.Service
              yield* plugin.init()
              // Give the forked subscription fiber time to register on the bus.
              yield* Effect.promise(() => Bun.sleep(100))

              const bus = yield* Bus.Service
              yield* bus.publish(Session.Event.Error, {
                error: { name: "UnknownError", data: { message: "probe" } } as any,
              })
              yield* Effect.promise(() => Bun.sleep(600))
            }),
          ),
      })

      const logged = fs.existsSync(sink) ? fs.readFileSync(sink, "utf8") : ""
      expect(logged).toContain("session.error")
    } finally {
      if (previousConfigDirectory === undefined) delete process.env.MIMOCODE_CONFIG_DIR
      else process.env.MIMOCODE_CONFIG_DIR = previousConfigDirectory
    }
  })
})
