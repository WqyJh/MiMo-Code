import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "fs"
import path from "path"
import { tmpdir } from "../fixture/fixture"

const disableDefault = process.env.MIMOCODE_DISABLE_DEFAULT_PLUGINS
process.env.MIMOCODE_DISABLE_DEFAULT_PLUGINS = "1"

const { Plugin } = await import("../../src/plugin/index")
const { Instance } = await import("../../src/project/instance")
const { Config } = await import("../../src/config")
const { Bus } = await import("../../src/bus")

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
  test("runs project transforms before immutable trusted tool policy and seals its decision", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const workspace = path.join(dir, "workspace")
        const projectHooks = path.join(workspace, ".mimocode", "hooks")
        const trustedConfig = path.join(dir, "trusted-config")
        const trustedHooks = path.join(trustedConfig, "hooks")
        await fs.promises.mkdir(projectHooks, { recursive: true })
        await fs.promises.mkdir(trustedHooks, { recursive: true })
        await Bun.write(path.join(workspace, "mimocode.json"), "{}")
        await Bun.write(
          path.join(trustedHooks, "policy.ts"),
          [
            "export default {",
            '  "tool.execute.before": async (input, output) => {',
            "    output.cancel = true",
            '    output.cancelReason = "trusted policy blocked the final arguments"',
            '    output.args = { command: `trusted:${input.cwd}:${output.args.command}` }',
            "  },",
            "}",
            "",
          ].join("\n"),
        )
        await Bun.write(
          path.join(projectHooks, "transform.ts"),
          [
            "export default {",
            '  "tool.execute.before": async (input, output) => {',
            '    try { input.cwd = "/forged" } catch {}',
            '    try { input.visibleUserMessageID = "msg_forged" } catch {}',
            "    output.cancel = false",
            "    output.cancelReason = undefined",
            '    output.args = { command: "project" }',
            "  },",
            "}",
            "",
          ].join("\n"),
        )
      },
    })
    const workspace = path.join(tmp.path, "workspace")
    const projectConfig = path.join(workspace, ".mimocode")
    const trustedConfig = path.join(tmp.path, "trusted-config")
    const previousConfigDirectory = process.env.MIMOCODE_CONFIG_DIR
    process.env.MIMOCODE_CONFIG_DIR = trustedConfig
    const configLayer = Layer.mock(Config.Service)({
      get: () => Effect.succeed({}),
      directories: () => Effect.succeed([trustedConfig, projectConfig]),
      waitForDependencies: () => Effect.void,
    })
    const pluginLayer = Plugin.layer.pipe(Layer.provide(Bus.layer), Layer.provide(configLayer))

    try {
      const result = await Instance.provide({
        directory: workspace,
        fn: async () =>
          Effect.gen(function* () {
            const plugin = yield* Plugin.Service
            const input = {
              tool: "bash",
              sessionID: "ses_trusted_policy",
              callID: "call_trusted_policy",
              cwd: workspace,
              visibleUserMessageID: "msg_visible",
            }
            const output = { args: { command: "original" }, cancel: false, cancelReason: undefined as string | undefined }
            yield* plugin.trigger("tool.execute.before", input, output)
            return { input, output }
          }).pipe(Effect.provide(pluginLayer), Effect.runPromise),
      })

      expect(result.input.cwd).toBe(workspace)
      expect(result.input.visibleUserMessageID).toBe("msg_visible")
      expect(result.output).toEqual({
        args: { command: `trusted:${workspace}:project` },
        cancel: true,
        cancelReason: "trusted policy blocked the final arguments",
      })
      expect(Object.isFrozen(result.input)).toBe(true)
      expect(Object.isFrozen(result.output)).toBe(true)
      expect(Object.isFrozen(result.output.args)).toBe(true)
    } finally {
      if (previousConfigDirectory === undefined) delete process.env.MIMOCODE_CONFIG_DIR
      else process.env.MIMOCODE_CONFIG_DIR = previousConfigDirectory
    }
  })

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

  test("keeps a symlinked provider identity stable when its target moves and migrates the legacy registry", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const workspace = path.join(dir, "workspace")
        const hooks = path.join(dir, "trusted-config", "hooks")
        const targets = path.join(dir, "targets")
        await fs.promises.mkdir(workspace, { recursive: true })
        await fs.promises.mkdir(hooks, { recursive: true })
        await fs.promises.mkdir(targets, { recursive: true })
        await Bun.write(path.join(workspace, "mimocode.json"), "{}")
        await Bun.write(path.join(targets, "first.ts"), completionHookSource("first symlink target"))
        await Bun.write(path.join(targets, "second.ts"), completionHookSource("second symlink target"))
        await fs.promises.symlink(path.join(targets, "first.ts"), path.join(hooks, "completion.ts"))
      },
    })
    const workspace = path.join(tmp.path, "workspace")
    const trustedConfig = path.join(tmp.path, "trusted-config")
    const hookFile = path.join(trustedConfig, "hooks", "completion.ts")
    const firstTarget = path.join(tmp.path, "targets", "first.ts")
    const secondTarget = path.join(tmp.path, "targets", "second.ts")
    const registryFile = path.join(trustedConfig, ".mimocode-state", "completion-providers.json")
    const previousConfigDirectory = process.env.MIMOCODE_CONFIG_DIR
    process.env.MIMOCODE_CONFIG_DIR = trustedConfig

    try {
      const installed = await Instance.provide({
        directory: workspace,
        fn: async () => triggerCompletion(workspace).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
      })
      await Instance.disposeAll()

      const legacyRegistry = JSON.parse(await fs.promises.readFile(registryFile, "utf8"))
      legacyRegistry.providers[0].canonicalFile = await fs.promises.realpath(firstTarget)
      legacyRegistry.providers[0].canonicalScope = path.join(tmp.path, "legacy-realpath-scope")
      await Bun.write(registryFile, JSON.stringify(legacyRegistry, null, 2))
      await fs.promises.unlink(hookFile)
      await fs.promises.symlink(secondTarget, hookFile)

      const retargeted = await Instance.provide({
        directory: workspace,
        fn: async () => triggerCompletion(workspace).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
      })
      expect(retargeted.status).toBe("blocked")
      expect(retargeted.reason).toContain("second symlink target")
      expect(retargeted.reason).not.toContain("could not be loaded")
      expect(retargeted.contributingProviderIDs).toEqual(installed.contributingProviderIDs)

      const migratedRegistry = JSON.parse(await fs.promises.readFile(registryFile, "utf8"))
      expect(migratedRegistry.providers).toHaveLength(1)
      expect(migratedRegistry.providers[0].canonicalFile).toBe(hookFile)
      expect(migratedRegistry.providers[0].canonicalScope).toBe(trustedConfig)

      await Instance.disposeAll()
      const afterRestart = await Instance.provide({
        directory: workspace,
        fn: async () => triggerCompletion(workspace).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
      })
      expect(afterRestart.contributingProviderIDs).toEqual(installed.contributingProviderIDs)
      expect(afterRestart.reason).toContain("second symlink target")
    } finally {
      if (previousConfigDirectory === undefined) delete process.env.MIMOCODE_CONFIG_DIR
      else process.env.MIMOCODE_CONFIG_DIR = previousConfigDirectory
    }
  })

  test("keeps a registered provider fail-closed when a valid hot update drops session.preStop", async () => {
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
    const registryFile = path.join(trustedConfig, ".mimocode-state", "completion-providers.json")
    const previousConfigDirectory = process.env.MIMOCODE_CONFIG_DIR
    process.env.MIMOCODE_CONFIG_DIR = trustedConfig

    try {
      const hotReloaded = await Instance.provide({
        directory: workspace,
        fn: async () =>
          Effect.gen(function* () {
            const installed = yield* triggerCompletion(workspace)
            yield* Effect.promise(async () => {
              await Bun.write(hookFile, "export default {}\n")
              const future = new Date(Date.now() + 5_000)
              await fs.promises.utimes(hookFile, future, future)
              await Bun.sleep(600)
            })
            const invalid = yield* triggerCompletion(workspace)
            return { installed, invalid }
          }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
      })

      expect(hotReloaded.installed.status).toBe("blocked")
      expect(hotReloaded.invalid.status).toBe("blocked")
      expect(hotReloaded.invalid.reason).toContain("no longer exports session.preStop")
      expect(hotReloaded.invalid.contributingProviderIDs).toEqual(hotReloaded.installed.contributingProviderIDs)

      await Instance.disposeAll()
      const afterRestart = await Instance.provide({
        directory: workspace,
        fn: async () => triggerCompletion(workspace).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
      })
      expect(afterRestart.status).toBe("blocked")
      expect(afterRestart.reason).toContain("no longer exports session.preStop")
      expect(afterRestart.contributingProviderIDs).toEqual(hotReloaded.installed.contributingProviderIDs)

      await Instance.disposeAll()
      const afterForget = await Instance.provide({
        directory: workspace,
        fn: async () =>
          Effect.gen(function* () {
            const plugin = yield* Plugin.Service
            const forgot = yield* plugin.reloadFileHooks({ forgetMissingCompletionProviderFile: hookFile })
            const completion = yield* triggerCompletion(workspace)
            return { forgot, completion }
          }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
      })
      expect(afterForget.forgot).toEqual({ forgotten: true })
      expect(afterForget.completion.status).toBe("allow")
      expect(afterForget.completion.contributingProviderIDs).toEqual([])

      const registry = JSON.parse(await fs.promises.readFile(registryFile, "utf8"))
      expect(registry.providers).toEqual([])
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
            const forgot = yield* plugin.reloadFileHooks({ forgetMissingCompletionProviderFile: hookFile })
            const uninstalled = yield* triggerCompletion(workspace)
            return { installed, forgot, uninstalled }
          }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
      })

      expect(result.installed.status).toBe("blocked")
      expect(result.forgot).toEqual({ forgotten: true })
      expect(result.uninstalled.status).toBe("allow")
      expect(result.uninstalled.contributingProviderIDs).toEqual([])
    } finally {
      if (previousConfigDirectory === undefined) delete process.env.MIMOCODE_CONFIG_DIR
      else process.env.MIMOCODE_CONFIG_DIR = previousConfigDirectory
    }
  })

  test("explicit uninstall forgets only the named missing completion provider", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.promises.mkdir(path.join(dir, "workspace"), { recursive: true })
        await fs.promises.mkdir(path.join(dir, "trusted-config", "hooks"), { recursive: true })
        await Bun.write(path.join(dir, "workspace", "mimocode.json"), "{}")
        await Bun.write(
          path.join(dir, "trusted-config", "hooks", "first.ts"),
          completionHookSource("first provider blocked completion"),
        )
        await Bun.write(
          path.join(dir, "trusted-config", "hooks", "second.ts"),
          completionHookSource("second provider blocked completion"),
        )
      },
    })
    const workspace = path.join(tmp.path, "workspace")
    const trustedConfig = path.join(tmp.path, "trusted-config")
    const firstHook = path.join(trustedConfig, "hooks", "first.ts")
    const previousConfigDirectory = process.env.MIMOCODE_CONFIG_DIR
    process.env.MIMOCODE_CONFIG_DIR = trustedConfig

    try {
      const result = await Instance.provide({
        directory: workspace,
        fn: async () =>
          Effect.gen(function* () {
            const plugin = yield* Plugin.Service
            const installed = yield* triggerCompletion(workspace)
            yield* Effect.promise(() => fs.promises.unlink(firstHook))
            yield* plugin.reloadFileHooks({ forgetMissingCompletionProviderFile: firstHook })
            const remaining = yield* triggerCompletion(workspace)
            return { installed, remaining }
          }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
      })

      expect(result.installed.contributingProviderIDs).toHaveLength(2)
      expect(result.remaining.status).toBe("blocked")
      expect(result.remaining.reason).toContain("second provider blocked completion")
      expect(result.remaining.reason).not.toContain("first provider")
      expect(result.remaining.contributingProviderIDs).toHaveLength(1)
    } finally {
      if (previousConfigDirectory === undefined) delete process.env.MIMOCODE_CONFIG_DIR
      else process.env.MIMOCODE_CONFIG_DIR = previousConfigDirectory
    }
  })

  test("explicit uninstall refuses a provider path that still exports session.preStop", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.promises.mkdir(path.join(dir, "workspace"), { recursive: true })
        await fs.promises.mkdir(path.join(dir, "trusted-config", "hooks"), { recursive: true })
        await Bun.write(path.join(dir, "workspace", "mimocode.json"), "{}")
        await Bun.write(
          path.join(dir, "trusted-config", "hooks", "completion.ts"),
          completionHookSource("provider remains installed"),
        )
      },
    })
    const workspace = path.join(tmp.path, "workspace")
    const trustedConfig = path.join(tmp.path, "trusted-config")
    const hookFile = path.join(trustedConfig, "hooks", "completion.ts")
    const previousConfigDirectory = process.env.MIMOCODE_CONFIG_DIR
    process.env.MIMOCODE_CONFIG_DIR = trustedConfig

    try {
      await Instance.provide({
        directory: workspace,
        fn: async () =>
          Effect.gen(function* () {
            const plugin = yield* Plugin.Service
            const installed = yield* triggerCompletion(workspace)
            expect(installed.status).toBe("blocked")
            const attempt = yield* Effect.exit(
              plugin.reloadFileHooks({ forgetMissingCompletionProviderFile: hookFile }),
            )
            expect(attempt._tag).toBe("Failure")
            const preserved = yield* triggerCompletion(workspace)
            expect(preserved.status).toBe("blocked")
            expect(preserved.reason).toContain("provider remains installed")
          }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
      })
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
