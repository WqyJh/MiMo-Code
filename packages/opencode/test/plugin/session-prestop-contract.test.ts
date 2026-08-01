import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "fs"
import path from "path"
import { pathToFileURL } from "url"
import type { Spec as ConfigPluginSpec } from "../../src/config/plugin"
import { tmpdir } from "../fixture/fixture"

const previousDisableDefaultPlugins = process.env.MIMOCODE_DISABLE_DEFAULT_PLUGINS
const originalConfigDirectory = process.env.MIMOCODE_CONFIG_DIR
process.env.MIMOCODE_DISABLE_DEFAULT_PLUGINS = "1"

const { Plugin } = await import("../../src/plugin/index")
const { Instance } = await import("../../src/project/instance")
const { Config } = await import("../../src/config")
const { Bus } = await import("../../src/bus")

afterEach(async () => {
  await Instance.disposeAll()
  if (originalConfigDirectory === undefined) delete process.env.MIMOCODE_CONFIG_DIR
  else process.env.MIMOCODE_CONFIG_DIR = originalConfigDirectory
})

afterAll(() => {
  if (previousDisableDefaultPlugins === undefined) delete process.env.MIMOCODE_DISABLE_DEFAULT_PLUGINS
  else process.env.MIMOCODE_DISABLE_DEFAULT_PLUGINS = previousDisableDefaultPlugins
  if (originalConfigDirectory === undefined) delete process.env.MIMOCODE_CONFIG_DIR
  else process.env.MIMOCODE_CONFIG_DIR = originalConfigDirectory
})

async function pluginProject(sources: string[]) {
  return tmpdir<string[]>({
    init: async (directory) => {
      const plugins: string[] = []
      const files: string[] = []
      const trustedConfig = path.join(directory, "trusted-config")
      await fs.promises.mkdir(trustedConfig, { recursive: true })
      for (const [index, source] of sources.entries()) {
        const file = path.join(directory, `provider-${index}.ts`)
        await Bun.write(file, source)
        files.push(file)
        plugins.push(pathToFileURL(file).href)
      }
      await Bun.write(
        path.join(directory, "mimocode.json"),
        JSON.stringify({ $schema: "https://opencode.ai/config.json" }),
      )
      await Bun.write(
        path.join(trustedConfig, "mimocode.json"),
        JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: plugins }),
      )
      process.env.MIMOCODE_CONFIG_DIR = trustedConfig
      return files
    },
  })
}

const completionInput = (directory: string) => ({
  sessionID: "ses_completion_contract",
  agentID: "main",
  cwd: directory,
  root: directory,
  visibleUserMessageID: "msg_visible_turn",
  loadedSkills: [] as const,
})

describe("session.preStop provider contract", () => {
  test("keeps project config plugins compatible without granting root completion authority", async () => {
    await using tmp = await tmpdir({
      init: async (directory) => {
        const profile = path.join(directory, "empty-profile")
        await fs.promises.mkdir(profile, { recursive: true })
        const file = path.join(directory, "local-provider.ts")
        await Bun.write(
          file,
          [
            "export async function localProvider() {",
            "  return {",
            '    "experimental.chat.system.transform": async (_input, output) => {',
            '      output.system.push("local transform still ran")',
            "    },",
            '    "session.preStop": async (_input, output) => {',
            '      output.status = "blocked"',
            '      output.reason = "project code tried to block completion"',
            "    },",
            "  }",
            "}",
            "",
          ].join("\n"),
        )
        await Bun.write(
          path.join(directory, "mimocode.json"),
          JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: [pathToFileURL(file).href] }),
        )
        process.env.MIMOCODE_CONFIG_DIR = profile
      },
    })

    const result = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          const transformed = { system: [] as string[] }
          yield* plugin.trigger(
            "experimental.chat.system.transform",
            { model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" } as any },
            transformed,
          )
          const completion = yield* plugin.triggerSessionPreStop(completionInput(tmp.path))
          return { transformed, completion }
        }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
    })

    expect(result.transformed.system).toContain("local transform still ran")
    expect(result.completion.status).toBe("allow")
    expect(result.completion.contributingProviderIDs).toEqual([])
  })

  test("does not let a local duplicate shadow a trusted global completion provider", async () => {
    await using tmp = await tmpdir({
      init: async (directory) => {
        const workspace = path.join(directory, "workspace")
        const profile = path.join(directory, "empty-profile")
        const pluginFile = path.join(directory, "shared-provider.ts")
        await fs.promises.mkdir(workspace, { recursive: true })
        await fs.promises.mkdir(profile, { recursive: true })
        await Bun.write(
          pluginFile,
          [
            "export async function sharedProvider(_input, options) {",
            "  return {",
            '    "experimental.chat.system.transform": async (_input, output) => {',
            "      output.system.push(options.marker)",
            "    },",
            "    ...(options.completion ? {",
            '      "session.preStop": async (_input, output) => {',
            '        output.status = "blocked"',
            '        output.reason = "trusted global provider remained authoritative"',
            "      },",
            "    } : {}),",
            "  }",
            "}",
            "",
          ].join("\n"),
        )
        await Bun.write(path.join(workspace, "mimocode.json"), "{}")
        process.env.MIMOCODE_CONFIG_DIR = profile
        return { workspace, profile, pluginFile }
      },
    })

    const spec = pathToFileURL(tmp.extra.pluginFile).href
    const localSpec: ConfigPluginSpec = [spec, { marker: "local", completion: false }]
    const globalSpec: ConfigPluginSpec = [spec, { marker: "global", completion: true }]
    const configLayer = Layer.mock(Config.Service)({
      get: () =>
        Effect.succeed({
          plugin: [localSpec],
          plugin_origins: [{ spec: localSpec, source: "project/mimocode.json", scope: "local" }],
          completion_plugin_origins: [{ spec: globalSpec, source: "profile/mimocode.json", scope: "global" }],
        }),
      directories: () => Effect.succeed([tmp.extra.profile]),
      waitForDependencies: () => Effect.void,
    })
    const pluginLayer = Plugin.layer.pipe(Layer.provide(Bus.layer), Layer.provide(configLayer))

    const result = await Instance.provide({
      directory: tmp.extra.workspace,
      fn: async () =>
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          const transformed = { system: [] as string[] }
          yield* plugin.trigger(
            "experimental.chat.system.transform",
            { model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" } as any },
            transformed,
          )
          const completion = yield* plugin.triggerSessionPreStop(completionInput(tmp.extra.workspace))
          return { transformed, completion }
        }).pipe(Effect.provide(pluginLayer), Effect.runPromise),
    })

    expect(result.transformed.system).toEqual(["local"])
    expect(result.completion.status).toBe("blocked")
    expect(result.completion.reason).toContain("trusted global provider remained authoritative")
    expect(result.completion.contributingProviderIDs).toHaveLength(1)
  })

  test(
    "keeps actor display identity compatible while completion identity is stable and opaque",
    async () => {
      await using tmp = await pluginProject([
        [
          "export async function completionProvider() {",
          "  return {",
          '    "actor.preStop": async (_input, output) => {',
          "      output.continue = true",
          '      output.reason = "actor still working"',
          "    },",
          '    "session.preStop": async (_input, output) => {',
          '      output.status = "blocked"',
          '      output.reason = "root completion is blocked"',
          "    },",
          "  }",
          "}",
          "",
        ].join("\n"),
      ])

      const result = await Instance.provide({
        directory: tmp.path,
        fn: async () =>
          Effect.gen(function* () {
            const plugin = yield* Plugin.Service
            const actor = yield* plugin.triggerActorPreStop({
              sessionID: "ses_completion_contract",
              actorID: "actor_contract",
              agentType: "custom",
              mode: "subagent",
              lifecycle: "ephemeral",
              task: "keep actor identity compatible",
              iteration: 0,
            })
            const first = yield* plugin.triggerSessionPreStop(completionInput(tmp.path))
            const second = yield* plugin.triggerSessionPreStop(completionInput(tmp.path))
            return { actor, first, second }
          }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
      })

      expect(result.actor.contributingPluginNames).toEqual(["completionProvider"])
      expect(result.actor.contributingHookIDs).toEqual(["completionProvider#actor.preStop"])
      expect(result.first.contributingProviderIDs).toHaveLength(1)
      expect(result.first.contributingProviderIDs[0]).toMatch(/^prestop:[0-9a-f]{24}$/)
      expect(result.second.contributingProviderIDs).toEqual(result.first.contributingProviderIDs)
      expect(result.first.contributingHookIDs).toEqual([`${result.first.contributingProviderIDs[0]}#session.preStop`])
      expect(result.first.reason).not.toContain(tmp.path)
      expect(result.first.reason).not.toContain("provider-0.ts")
      expect(result.first.reason).not.toContain("completionProvider")
    },
    { timeout: 30_000 },
  )

  test("bounds aggregate reason and suggested action count and payload size", async () => {
    await using tmp = await pluginProject(
      Array.from({ length: 20 }, (_, index) =>
        [
          "export default async () => ({",
          '  "session.preStop": async (_input, output) => {',
          '    output.status = "continue"',
          `    output.reason = ${JSON.stringify(`provider-${index}:`)} + "R".repeat(10_000)`,
          `    output.nextAction = { description: ${JSON.stringify(`action-${index}:`)} + "D".repeat(2_000), command: Array.from({ length: 16 }, (_, argument) => \`arg-\${argument}\`) }`,
          "  },",
          "})",
          "",
        ].join("\n"),
      ),
    )

    const decision = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          return yield* plugin.triggerSessionPreStop(completionInput(tmp.path))
        }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
    })

    expect(decision.status).toBe("continue")
    expect(decision.contributingProviderIDs).toHaveLength(20)
    expect(Buffer.byteLength(decision.reason ?? "")).toBeLessThanOrEqual(8192)
    expect(decision.reason).not.toContain(tmp.path)
    expect(decision.nextActions).toHaveLength(16)
    for (const action of decision.nextActions) {
      expect(action.providerID).toMatch(/^prestop:[0-9a-f]{24}$/)
      expect(Buffer.byteLength(action.description ?? "")).toBeLessThanOrEqual(512)
      expect(action.command).toHaveLength(16)
      expect(action.command?.every((argument) => Buffer.byteLength(argument) <= 256)).toBe(true)
    }
  })

  test("rejects an oversized argv argument instead of returning a corrupted command", async () => {
    await using tmp = await pluginProject([
      [
        "export default async () => ({",
        '  "session.preStop": async (_input, output) => {',
        '    output.status = "continue"',
        '    output.reason = "run the exact command"',
        '    output.nextAction = { command: ["x".repeat(257)] }',
        "  },",
        "})",
        "",
      ].join("\n"),
    ])

    const decision = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          return yield* plugin.triggerSessionPreStop(completionInput(tmp.path))
        }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
    })

    expect(decision.status).toBe("blocked")
    expect(decision.reason).toContain("completion cannot be verified")
    expect(decision.reason).not.toContain("x".repeat(257))
    expect(decision.nextActions).toEqual([])
  })

  test("enforces the per-turn continuation limit across providers that alternate continue and allow", async () => {
    const eventKey = "__mimocodeSessionPreStopAggregateEvents"
    ;(globalThis as any)[eventKey] = []
    await using tmp = await pluginProject([
      [
        "let checks = 0",
        "export default async () => ({",
        `  event: async ({ event }) => { if (event.type === "hook.session.prestop.executed") (globalThis as any)[${JSON.stringify(eventKey)}].push(event.properties) },`,
        '  "session.preStop": async (_input, output) => {',
        "    checks++",
        '    output.status = checks % 2 === 1 ? "continue" : "allow"',
        "    output.stateDigest = `first-${checks}`",
        '    output.reason = "first provider is incomplete"',
        "  },",
        "})",
        "",
      ].join("\n"),
      [
        "let checks = 0",
        "export default async () => ({",
        '  "session.preStop": async (_input, output) => {',
        "    checks++",
        '    output.status = checks % 2 === 0 ? "continue" : "allow"',
        "    output.stateDigest = `second-${checks}`",
        '    output.reason = "second provider is incomplete"',
        "  },",
        "})",
        "",
      ].join("\n"),
    ])

    const result = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          const decisions = []
          for (let index = 0; index < 10; index++) {
            decisions.push(yield* plugin.triggerSessionPreStop(completionInput(tmp.path)))
          }
          const nextTurn = yield* plugin.triggerSessionPreStop({
            ...completionInput(tmp.path),
            visibleUserMessageID: "msg_next_visible_turn",
          })
          yield* Effect.promise(() => Bun.sleep(20))
          return { decisions, nextTurn }
        }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
    })

    expect(result.decisions.slice(0, 7).every((decision) => decision.status === "continue")).toBe(true)
    expect(result.decisions[7]).toMatchObject({ status: "continue", blockedReport: true })
    expect(result.decisions[7]?.reason).toContain("per-turn limit of 8 continuation checks")
    expect(result.decisions[8]?.status).toBe("blocked")
    expect(result.decisions[9]?.status).toBe("blocked")
    expect(result.nextTurn).toMatchObject({ status: "continue", blockedReport: false })
    const events = (globalThis as any)[eventKey] as Array<{ status: string; blockedReport: boolean }>
    expect(
      events.filter((event) => event.blockedReport).map(({ status, blockedReport }) => ({ status, blockedReport })),
    ).toEqual([{ status: "continue", blockedReport: true }])
    delete (globalThis as any)[eventKey]
  })

  test("restores the per-turn continuation latch from durable progress after Instance disposal", async () => {
    await using tmp = await pluginProject([
      [
        "export default async () => ({",
        '  "session.preStop": async (input, output) => {',
        '    output.status = "continue"',
        '    output.reason = `the changing task is still incomplete: ${input.finalText ?? "missing-state"}`',
        "  },",
        "})",
        "",
      ].join("\n"),
    ])

    const beforeRestart = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          let decision = yield* plugin.triggerSessionPreStop({
            ...completionInput(tmp.path),
            finalText: "changing-state-1",
          })
          for (let index = 2; index <= 7; index++) {
            decision = yield* plugin.triggerSessionPreStop({
              ...completionInput(tmp.path),
              finalText: `changing-state-${index}`,
            })
          }
          return decision
        }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
    })
    expect(beforeRestart).toMatchObject({ status: "continue", blockedReport: false })
    expect(beforeRestart.progress.aggregate).toEqual({ continuationCount: 7, blockedReportIssued: false })

    // Recreate every Instance-scoped service to simulate a process/layer
    // restart. The caller supplies only the snapshot persisted on the visible
    // user turn; no in-memory Map survives this boundary.
    await Instance.disposeAll()
    const blockerReport = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          return yield* plugin.triggerSessionPreStop({
            ...completionInput(tmp.path),
            finalText: "changing-state-8",
            progress: beforeRestart.progress,
          })
        }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
    })
    expect(blockerReport).toMatchObject({ status: "continue", blockedReport: true })
    expect(blockerReport.reason).toContain("per-turn limit of 8 continuation checks")

    await Instance.disposeAll()
    const terminal = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          return yield* plugin.triggerSessionPreStop({
            ...completionInput(tmp.path),
            finalText: "changing-state-9",
            progress: blockerReport.progress,
          })
        }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
    })
    expect(terminal).toMatchObject({ status: "blocked", blockedReport: false })
    expect(terminal.reason).toContain("after its one host-requested blocker report")
    expect(terminal.progress.providers).toEqual([
      expect.objectContaining({
        sameStateCount: 1,
        continuationCount: 8,
        blockedReportIssued: true,
      }),
    ])

    await Instance.disposeAll()
    const repeatedTerminal = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          return yield* plugin.triggerSessionPreStop({
            ...completionInput(tmp.path),
            finalText: "changing-state-10",
            progress: terminal.progress,
          })
        }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
    })
    expect(repeatedTerminal.status).toBe("blocked")
  })

  test("invalidates provider-local progress when configured plugin code changes", async () => {
    const source = (marker: string) =>
      [
        `// implementation ${marker}`,
        "export default async () => ({",
        '  "session.preStop": async (_input, output) => {',
        '    output.status = "continue"',
        '    output.taskId = "same-task"',
        '    output.stateDigest = "same-state"',
        '    output.reason = "work remains"',
        "  },",
        "})",
        "",
      ].join("\n")
    await using tmp = await pluginProject([source("v1")])

    const beforeEdit = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          const input = completionInput(tmp.path)
          yield* plugin.triggerSessionPreStop(input)
          return yield* plugin.triggerSessionPreStop(input)
        }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
    })
    expect(beforeEdit.progress.providers[0]).toMatchObject({ sameStateCount: 2, continuationCount: 2 })

    await Instance.disposeAll()
    await Bun.write(tmp.extra[0], source("v2"))

    const afterEdit = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          return yield* plugin.triggerSessionPreStop({
            ...completionInput(tmp.path),
            progress: beforeEdit.progress,
          })
        }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
    })

    expect(afterEdit.progress.providers[0]).toMatchObject({ sameStateCount: 1, continuationCount: 1 })
    expect(afterEdit.progress.providers[0]?.providerID).toBe(beforeEdit.progress.providers[0]?.providerID)
    expect(afterEdit.progress.providers[0]?.revision).not.toBe(beforeEdit.progress.providers[0]?.revision)
    expect(afterEdit.progress.aggregate).toEqual({ continuationCount: 3, blockedReportIssued: false })
  })

  test("invalidates provider-local progress when configured plugin options change", async () => {
    await using tmp = await tmpdir({
      init: async (directory) => {
        const trustedConfig = path.join(directory, "trusted-config")
        const provider = path.join(directory, "provider.ts")
        await fs.promises.mkdir(trustedConfig, { recursive: true })
        await Bun.write(path.join(directory, "mimocode.json"), "{}")
        await Bun.write(
          provider,
          [
            "export default async (_input, options) => ({",
            '  "session.preStop": async (_input, output) => {',
            '    output.status = "continue"',
            '    output.taskId = "same-task"',
            '    output.stateDigest = "same-state"',
            "    output.reason = `${options.marker} remains incomplete`",
            "  },",
            "})",
            "",
          ].join("\n"),
        )
        process.env.MIMOCODE_CONFIG_DIR = trustedConfig
        return { trustedConfig, provider }
      },
    })
    const providerSpec = pathToFileURL(tmp.extra.provider).href
    const writeConfig = (marker: string) =>
      Bun.write(
        path.join(tmp.extra.trustedConfig, "mimocode.json"),
        JSON.stringify({ plugin: [[providerSpec, { marker }]] }),
      )
    await writeConfig("v1")

    const beforeChange = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          const input = completionInput(tmp.path)
          yield* plugin.triggerSessionPreStop(input)
          return yield* plugin.triggerSessionPreStop(input)
        }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
    })
    expect(beforeChange.progress.providers[0]).toMatchObject({ sameStateCount: 2, continuationCount: 2 })

    await Instance.disposeAll()
    await writeConfig("v2")

    const afterChange = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          return yield* plugin.triggerSessionPreStop({
            ...completionInput(tmp.path),
            progress: beforeChange.progress,
          })
        }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
    })

    expect(afterChange.reason).toContain("v2 remains incomplete")
    expect(afterChange.progress.providers[0]).toMatchObject({ sameStateCount: 1, continuationCount: 1 })
    expect(afterChange.progress.providers[0]?.providerID).toBe(beforeChange.progress.providers[0]?.providerID)
    expect(afterChange.progress.providers[0]?.revision).not.toBe(beforeChange.progress.providers[0]?.revision)
    expect(afterChange.progress.aggregate).toEqual({ continuationCount: 3, blockedReportIssued: false })
  })

  test("restores an unavailable configured completion provider after cold-start load failure", async () => {
    await using tmp = await pluginProject([
      [
        'import fs from "node:fs"',
        'import { fileURLToPath } from "node:url"',
        "export default async () => {",
        '  if (!fs.existsSync(fileURLToPath(new URL("./provider.enabled", import.meta.url)))) {',
        '    throw new Error("configured provider failed during initialization")',
        "  }",
        "  return {",
        '    "session.preStop": async (_input, output) => {',
        '      output.status = "blocked"',
        '      output.reason = "configured provider blocked completion"',
        "    },",
        "  }",
        "}",
        "",
      ].join("\n"),
    ])
    const enabledFile = path.join(tmp.path, "provider.enabled")
    await Bun.write(enabledFile, "enabled")

    const installed = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          return yield* plugin.triggerSessionPreStop(completionInput(tmp.path))
        }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
    })

    await Instance.disposeAll()
    await fs.promises.unlink(enabledFile)

    const afterRestart = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          return yield* plugin.triggerSessionPreStop(completionInput(tmp.path))
        }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
    })

    expect(installed.status).toBe("blocked")
    expect(afterRestart.status).toBe("blocked")
    expect(afterRestart.reason).toContain("could not be loaded")
    expect(afterRestart.contributingProviderIDs).toEqual(installed.contributingProviderIDs)
  })

  test("keeps a configured provider enrolled when a valid update drops session.preStop", async () => {
    await using tmp = await pluginProject([
      [
        'import fs from "node:fs"',
        'import { fileURLToPath } from "node:url"',
        "export default async () => {",
        '  if (fs.existsSync(fileURLToPath(new URL("./provider-without-prestop", import.meta.url)))) return {}',
        "  return {",
        '    "session.preStop": async (_input, output) => {',
        '      output.status = "blocked"',
        '      output.reason = "configured provider is enrolled"',
        "    },",
        "  }",
        "}",
        "",
      ].join("\n"),
    ])
    const disabledFile = path.join(tmp.path, "provider-without-prestop")
    const trustedConfigFile = path.join(tmp.path, "trusted-config", "mimocode.json")

    const installed = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          return yield* plugin.triggerSessionPreStop(completionInput(tmp.path))
        }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
    })

    await Bun.write(disabledFile, "disabled")
    await Instance.disposeAll()
    const invalid = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          return yield* plugin.triggerSessionPreStop(completionInput(tmp.path))
        }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
    })

    expect(installed.status).toBe("blocked")
    expect(invalid.status).toBe("blocked")
    expect(invalid.reason).toContain("no longer exports session.preStop")
    expect(invalid.reason).toContain("ask the user")
    expect(invalid.contributingProviderIDs).toEqual(installed.contributingProviderIDs)

    await Bun.write(
      trustedConfigFile,
      JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: [] }),
    )
    await Instance.disposeAll()
    const uninstalled = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          return yield* plugin.triggerSessionPreStop(completionInput(tmp.path))
        }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
    })

    expect(uninstalled.status).toBe("allow")
    expect(uninstalled.contributingProviderIDs).toEqual([])
  })

  test("caps invoked completion providers and fails closed when the registry exceeds the limit", async () => {
    await using tmp = await pluginProject(
      Array.from({ length: 33 }, (_, index) =>
        [
          "export default async () => ({",
          '  "session.preStop": async (_input, output) => {',
          '    output.status = "blocked"',
          `    output.reason = ${JSON.stringify(`provider ${index} blocked`)}`,
          "  },",
          "})",
          "",
        ].join("\n"),
      ),
    )

    const decision = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          return yield* plugin.triggerSessionPreStop(completionInput(tmp.path))
        }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
    })

    expect(decision.status).toBe("blocked")
    expect(decision.contributingProviderIDs).toHaveLength(33)
    expect(decision.contributingProviderIDs.filter((id) => /^prestop:[0-9a-f]{24}$/.test(id))).toHaveLength(32)
    expect(decision.contributingProviderIDs).toContain("prestop:host")
    expect(decision.contributingHookIDs).toHaveLength(33)
    expect(decision.reason).toContain("exceeding the safe limit of 32")
    expect(Buffer.byteLength(decision.reason ?? "")).toBeLessThanOrEqual(8192)
  })

  test("automatic trusted file-hook reload clears completion progress for the reloaded provider", async () => {
    await using tmp = await tmpdir({})
    const workspace = path.join(tmp.path, "workspace")
    const configDirectory = path.join(tmp.path, "trusted-config")
    const hookDirectory = path.join(configDirectory, "hooks")
    const hookFile = path.join(hookDirectory, "completion.ts")
    await fs.promises.mkdir(workspace, { recursive: true })
    await fs.promises.mkdir(hookDirectory, { recursive: true })
    await Bun.write(path.join(workspace, "mimocode.json"), "{}")

    const source = (version: string) =>
      [
        "export default {",
        '  "session.preStop": async (_input, output) => {',
        '    output.status = "continue"',
        '    output.taskId = "same-task"',
        '    output.stateDigest = "same-state"',
        `    output.reason = ${JSON.stringify(`${version} still incomplete`)}`,
        "  },",
        "}",
        "",
      ].join("\n")
    await Bun.write(hookFile, source("v1"))

    const previousConfigDirectory = process.env.MIMOCODE_CONFIG_DIR
    process.env.MIMOCODE_CONFIG_DIR = configDirectory
    try {
      const decisions = await Instance.provide({
        directory: workspace,
        fn: async () =>
          Effect.gen(function* () {
            const plugin = yield* Plugin.Service
            const input = completionInput(workspace)
            const first = yield* plugin.triggerSessionPreStop(input)
            const second = yield* plugin.triggerSessionPreStop(input)

            yield* Effect.promise(async () => {
              await Bun.write(hookFile, source("v2"))
              const future = new Date(Date.now() + 5_000)
              await fs.promises.utimes(hookFile, future, future)
              await Bun.sleep(600)
            })

            const afterReload = yield* plugin.triggerSessionPreStop(input)
            return { first, second, afterReload }
          }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
      })

      expect(decisions.first.blockedReport).toBe(false)
      expect(decisions.second.blockedReport).toBe(false)
      expect(decisions.afterReload.blockedReport).toBe(false)
      expect(decisions.afterReload.reason).toContain("v2 still incomplete")
      expect(decisions.afterReload.contributingProviderIDs).toEqual(decisions.first.contributingProviderIDs)
    } finally {
      if (previousConfigDirectory === undefined) delete process.env.MIMOCODE_CONFIG_DIR
      else process.env.MIMOCODE_CONFIG_DIR = previousConfigDirectory
    }
  })
})
