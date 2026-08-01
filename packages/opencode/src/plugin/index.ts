import type {
  Hooks,
  PluginInput,
  Plugin as PluginInstance,
  PluginModule,
  WorkspaceAdaptor as PluginWorkspaceAdaptor,
  ActorPreStopInput,
  ActorPostStopInput,
  ActorStopOutput,
  ActorMatcher,
  SessionPreStopInput,
  SessionPreStopFailureMode,
  SessionPreStopNextAction,
  SessionPreStopOutput,
  SessionPreStopStatus,
} from "@mimo-ai/plugin"
import { z } from "zod"
import { matchesActor } from "./matcher"
import { Config } from "../config"
import { Bus } from "../bus"
import { BusEvent } from "../bus/bus-event"
import { Log } from "../util"
import { createOpencodeClient } from "@mimo-ai/sdk"
import { Flag } from "../flag/flag"
import { CodexAuthPlugin } from "./codex"
import { XaiAuthPlugin } from "./xai"
import { MimoAuthPlugin, AnthropicProxyPlugin } from "./mimo"
import { Session } from "../session"
import type { SessionID } from "../session/schema"
import { NamedError } from "@mimo-ai/shared/util/error"
import { CopilotAuthPlugin } from "./github-copilot/copilot"
import { gitlabAuthPlugin as GitlabAuthPlugin } from "opencode-gitlab-auth"
import { PoeAuthPlugin } from "opencode-poe-auth"
import { CloudflareAIGatewayAuthPlugin, CloudflareWorkersAuthPlugin } from "./cloudflare"
import { CheckpointSplitoverPlugin } from "./checkpoint-splitover"
import { SubagentProgressCheckerPlugin } from "./subagent-progress-checker"
import { Effect, Layer, Context, Stream } from "effect"
import { EffectBridge } from "@/effect"
import { InstanceState } from "@/effect"
import { errorMessage } from "@/util/error"
import { PluginLoader } from "./loader"
import { parsePluginSpecifier, readPluginId, readV1Plugin, resolvePluginId } from "./shared"
import { ConfigPlugin } from "@/config/plugin"
import { registerAdaptor } from "@/control-plane/adaptors"
import type { WorkspaceAdaptor } from "@/control-plane/types"
import { Glob } from "@mimo-ai/shared/util/glob"
import fs from "fs"
import path from "path"
import { pathToFileURL, fileURLToPath } from "url"
import { Global } from "../global"
import { createHash } from "node:crypto"
import { Filesystem } from "@/util"
import { Flock } from "@mimo-ai/shared/util/flock"

const log = Log.create({ service: "plugin" })

export const HookEvent = {
  Executed: BusEvent.define(
    "hook.executed",
    z.object({
      event: z.enum(["actor.preStop", "actor.postStop"]),
      hookID: z.string(),
      pluginName: z.string(),
      actorID: z.string(),
      agentType: z.string(),
      durationMs: z.number(),
      outcome: z.enum(["success", "error", "skipped"]),
      continueRequested: z.boolean(),
      reasonLength: z.number(),
    }),
  ),
  ReActReentered: BusEvent.define(
    "hook.react.reentered",
    z.object({
      phase: z.enum(["pre", "post"]),
      actorID: z.string(),
      agentType: z.string(),
      iteration: z.number(),
      triggeredByPlugins: z.array(z.string()),
      reasonPreview: z.string(),
    }),
  ),
  ReActMaxReached: BusEvent.define(
    "hook.react.max_reached",
    z.object({
      phase: z.enum(["pre", "post"]),
      actorID: z.string(),
      agentType: z.string(),
    }),
  ),
  SessionPreStopExecuted: BusEvent.define(
    "hook.session.prestop.executed",
    z.object({
      providerID: z.string(),
      hookID: z.string(),
      sessionID: z.string(),
      durationMs: z.number(),
      outcome: z.enum(["success", "error", "timeout"]),
      status: z.enum(["allow", "continue", "awaiting_user", "blocked"]),
      taskID: z.string().optional(),
      stateDigest: z.string().optional(),
      noProgressCount: z.number().optional(),
      continuationCount: z.number().optional(),
      blockedReport: z.boolean(),
    }),
  ),
} as const

type HookEntry = {
  hook: Hooks
  /** Backwards-compatible display identity used by actor lifecycle events. */
  pluginName: string
  /** Stable per-event hook ID: `${pluginName}#${eventName}` */
  hookIDFor: (eventName: string) => string
  /** Opaque identity used only by root completion checks and model-visible text. */
  completionProviderID: string
  /** Stable identity material retained for durable completion-provider enrollment. */
  completionIdentity: readonly string[]
  /** Stable implementation revision used to invalidate provider-local progress after a hook edit. */
  completionRevision: string
  /** Whether this entry may authoritatively decide root-session completion. */
  completionTrusted: boolean
  /** Synthetic fail-closed stand-in for an enrolled provider that is unavailable. */
  completionUnavailable: boolean
}

type State = {
  hooks: Hooks[]
  hooksWithMeta: HookEntry[]
}

type FileHookState = {
  hooks: Hooks[]
  meta: HookEntry[]
  dirs: string[]
  /** Absolute path -> mtimeMs at load time, for cheap staleness checks. */
  files: Record<string, number>
  /** Mutable box: last staleness check timestamp (throttle). */
  lastCheck: { value: number }
}

type KnownCompletionFileHook = {
  canonicalFile: string
  canonicalScope: string
  filePath: string
  name: string
}

type ConfiguredCompletionProvider = {
  kind: "configured"
  configIdentity: string
  completionIdentity: string[]
  pluginName: string
}

type FileCompletionProvider = KnownCompletionFileHook & {
  kind: "file"
}

type CompletionProviderRecord = ConfiguredCompletionProvider | FileCompletionProvider

const FILE_HOOK_GLOB = "{hook,hooks}/*.{js,ts}"
const FILE_HOOK_CHECK_INTERVAL_MS = 500
const SESSION_PRESTOP_TIMEOUT_MS = 3000
const SESSION_PRESTOP_NO_PROGRESS_LIMIT = 3
const SESSION_PRESTOP_TOTAL_CONTINUE_LIMIT = 8
const SESSION_PRESTOP_MAX_PROVIDERS = 32
const SESSION_PRESTOP_MAX_ACTIONS = 16
const SESSION_PRESTOP_MAX_REASON_BYTES = 2048
const SESSION_PRESTOP_MAX_AGGREGATE_REASON_BYTES = 8192
const SESSION_PRESTOP_MAX_DESCRIPTION_BYTES = 512
const SESSION_PRESTOP_MAX_COMMAND_ARGS = 16
const SESSION_PRESTOP_MAX_COMMAND_ARG_BYTES = 256
const SESSION_PRESTOP_MAX_TASK_ID_BYTES = 256
const SESSION_PRESTOP_MAX_STATE_DIGEST_BYTES = 256
const SESSION_PRESTOP_HOST_PROVIDER_ID = "prestop:host"
export const SESSION_PRESTOP_PROGRESS_METADATA_KEY = "sessionPreStopProgress"

const CompletionProviderRegistrySchema = z
  .object({
    version: z.literal(1),
    providers: z
      .array(
        z.discriminatedUnion("kind", [
          z
            .object({
              kind: z.literal("configured"),
              configIdentity: z.string().min(1),
              completionIdentity: z.array(z.string()).min(1).max(16),
              pluginName: z.string().min(1),
            })
            .strict(),
          z
            .object({
              kind: z.literal("file"),
              canonicalFile: z.string().min(1),
              canonicalScope: z.string().min(1),
              filePath: z.string().min(1),
              name: z.string().min(1),
            })
            .strict(),
        ]),
      )
      .max(1024),
  })
  .strict()

type CompletionProviderRegistry = z.infer<typeof CompletionProviderRegistrySchema>

const SessionPreStopPersistedProgressSchema = z
  .object({
    version: z.literal(1),
    turnID: z.string().max(256),
    providers: z
      .array(
        z.object({
          providerID: z.string().max(128),
          revision: z.string().max(128),
          taskID: z.string().max(SESSION_PRESTOP_MAX_TASK_ID_BYTES),
          stateDigest: z.string().max(SESSION_PRESTOP_MAX_STATE_DIGEST_BYTES),
          sameStateCount: z.number().int().nonnegative().max(SESSION_PRESTOP_NO_PROGRESS_LIMIT),
          continuationCount: z.number().int().nonnegative().max(SESSION_PRESTOP_TOTAL_CONTINUE_LIMIT),
          blockedReportIssued: z.boolean(),
        }),
      )
      .max(SESSION_PRESTOP_MAX_PROVIDERS),
    aggregate: z
      .object({
        continuationCount: z.number().int().nonnegative().max(SESSION_PRESTOP_TOTAL_CONTINUE_LIMIT),
        blockedReportIssued: z.boolean(),
      })
      .optional(),
  })
  .strict()

export type SessionPreStopPersistedProgress = z.infer<typeof SessionPreStopPersistedProgressSchema>

function boundedUtf8(input: string, maxBytes: number) {
  const bytes = Buffer.from(input)
  if (bytes.byteLength <= maxBytes) return input
  const suffix = Buffer.from("…")
  return (
    bytes
      .subarray(0, Math.max(0, maxBytes - suffix.byteLength))
      .toString("utf8")
      .replace(/\uFFFD$/u, "") + "…"
  )
}

function completionProviderID(...identity: string[]) {
  return `prestop:${createHash("sha256").update(identity.join("\0")).digest("hex").slice(0, 24)}`
}

function completionFileHookKey(canonicalFile: string, canonicalScope: string) {
  return `${canonicalScope}\0${canonicalFile}`
}

function completionFileLexicalScope(filePath: string) {
  // FILE_HOOK_GLOB only admits <scope>/{hook,hooks}/<file>. Deriving the
  // scope from the persisted lexical file path lets legacy realpath-based
  // records migrate even when the configured scope itself is a symlink.
  return path.dirname(path.dirname(path.resolve(filePath)))
}

function completionProviderRegistryFile() {
  const root = Flag.MIMOCODE_CONFIG_DIR
    ? path.join(path.resolve(Flag.MIMOCODE_CONFIG_DIR), ".mimocode-state")
    : Global.Path.state
  return path.join(root, "completion-providers.json")
}

function completionProviderRecordKey(record: CompletionProviderRecord) {
  if (record.kind === "file") return completionFileHookKey(record.canonicalFile, record.canonicalScope)
  return `${record.configIdentity}\0${completionProviderID(...record.completionIdentity)}`
}

function deduplicateCompletionProviderRecords(records: CompletionProviderRecord[]) {
  const seen = new Set<string>()
  return records.filter((record) => {
    const key = `${record.kind}\0${completionProviderRecordKey(record)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function readCompletionProviderRegistry(file = completionProviderRegistryFile()) {
  const source = await Filesystem.readText(file).catch((error) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined
    throw error
  })
  if (source === undefined) {
    return { version: 1, providers: [] } satisfies CompletionProviderRegistry
  }
  return normalizeCompletionProviderRegistry(CompletionProviderRegistrySchema.parse(JSON.parse(source)))
}

function normalizeCompletionProviderRegistry(registry: CompletionProviderRegistry): CompletionProviderRegistry {
  return {
    version: 1,
    providers: deduplicateCompletionProviderRecords(
      registry.providers.map((record) =>
        record.kind === "file"
          ? (() => {
              const filePath = path.resolve(record.filePath)
              return {
                ...record,
                filePath,
                // The configured hook path and scope are the durable identity.
                // realpath is deliberately excluded: installers commonly use
                // stable symlinks whose targets move between releases.
                canonicalFile: filePath,
                canonicalScope: completionFileLexicalScope(filePath),
              }
            })()
          : record,
      ),
    ),
  }
}

async function updateCompletionProviderRegistry(
  update: (registry: CompletionProviderRegistry) => CompletionProviderRegistry,
) {
  const file = completionProviderRegistryFile()
  return Flock.withLock(`completion-provider-registry:${file}`, async () => {
    const source = await Filesystem.readText(file).catch((error) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined
      throw error
    })
    const stored =
      source === undefined
        ? ({ version: 1, providers: [] } satisfies CompletionProviderRegistry)
        : CompletionProviderRegistrySchema.parse(JSON.parse(source))
    const current = normalizeCompletionProviderRegistry(stored)
    const next = CompletionProviderRegistrySchema.parse(update(current))
    // Compare against the on-disk representation so legacy realpath-based file
    // records are actually migrated, rather than normalized only in memory on
    // every process start.
    if (JSON.stringify(stored) === JSON.stringify(next)) return next

    await fs.promises.mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    try {
      await fs.promises.writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 })
      await fs.promises.rename(tmp, file)
    } finally {
      await fs.promises.unlink(tmp).catch(() => {})
    }
    return next
  })
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  return `{${Object.keys(value)
    .toSorted()
    .map((key) => {
      const item: unknown = Reflect.get(value, key)
      return `${JSON.stringify(key)}:${stableJson(item)}`
    })
    .join(",")}}`
}

function hookEntry(input: {
  hook: Hooks
  pluginName: string
  completionIdentity: string[]
  completionRevision?: string
  completionTrusted: boolean
  completionUnavailable?: boolean
}): HookEntry {
  const providerID = completionProviderID(...input.completionIdentity)
  return {
    hook: input.hook,
    pluginName: input.pluginName,
    hookIDFor: (event: string) => `${input.pluginName}#${event}`,
    completionProviderID: providerID,
    completionIdentity: input.completionIdentity,
    completionRevision: input.completionRevision ?? providerID,
    completionTrusted: input.completionTrusted,
    completionUnavailable: input.completionUnavailable ?? false,
  }
}

async function canonicalizePath(input: string) {
  try {
    return await fs.promises.realpath(input)
  } catch {
    return path.resolve(input)
  }
}

export type ActorStopAggregatedDecision = ActorStopOutput & {
  contributingPluginNames: string[]
  contributingHookIDs: string[]
}

export type SessionPreStopAggregatedDecision = {
  status: SessionPreStopStatus
  reason?: string
  nextActions: Array<SessionPreStopNextAction & { providerID: string }>
  contributingProviderIDs: string[]
  contributingHookIDs: string[]
  /** True only on the one bounded re-entry that asks the model to report a stalled provider. */
  blockedReport: boolean
  /** Host-owned progress snapshot that must be persisted with the visible user turn. */
  progress: SessionPreStopPersistedProgress
}

type SessionPreStopHostInput = Omit<SessionPreStopInput, "abortSignal"> & {
  /** Previously persisted host progress. Provider hooks never receive this field. */
  progress?: unknown
}

// Hook names that follow the (input, output) => Promise<void> trigger pattern
type TriggerName = {
  [K in keyof Hooks]-?: NonNullable<Hooks[K]> extends (input: any, output: any) => Promise<void> ? K : never
}[keyof Hooks]

export interface Interface {
  readonly trigger: <
    Name extends TriggerName,
    Input = Parameters<Required<Hooks>[Name]>[0],
    Output = Parameters<Required<Hooks>[Name]>[1],
  >(
    name: Name,
    input: Input,
    output: Output,
  ) => Effect.Effect<Output>
  readonly list: () => Effect.Effect<Hooks[]>
  readonly init: () => Effect.Effect<void>
  readonly reloadFileHooks: (options?: {
    forgetMissingCompletionProviderFile?: string
  }) => Effect.Effect<{ forgotten: boolean }>
  readonly triggerActorPreStop: (input: ActorPreStopInput) => Effect.Effect<ActorStopAggregatedDecision>
  readonly triggerActorPostStop: (input: ActorPostStopInput) => Effect.Effect<ActorStopAggregatedDecision>
  readonly triggerSessionPreStop: (input: SessionPreStopHostInput) => Effect.Effect<SessionPreStopAggregatedDecision>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Plugin") {}

// Built-in plugins that are directly imported (not installed from npm)
const INTERNAL_PLUGINS: PluginInstance[] = [
  MimoAuthPlugin,
  AnthropicProxyPlugin,
  CodexAuthPlugin,
  XaiAuthPlugin,
  CopilotAuthPlugin,
  // gitlab/poe auth are external npm packages typed against the published
  // upstream plugin package, which carries a duplicate (nominal) copy of the
  // SDK client; cast through unknown to the workspace Plugin type.
  GitlabAuthPlugin as unknown as PluginInstance,
  PoeAuthPlugin as unknown as PluginInstance,
  CloudflareWorkersAuthPlugin,
  CloudflareAIGatewayAuthPlugin,
  CheckpointSplitoverPlugin,
  SubagentProgressCheckerPlugin,
]

function isServerPlugin(value: unknown): value is PluginInstance {
  return typeof value === "function"
}

function getServerPlugin(value: unknown) {
  if (isServerPlugin(value)) return value
  if (!value || typeof value !== "object" || !("server" in value)) return
  if (!isServerPlugin(value.server)) return
  return value.server
}

function getLegacyPlugins(mod: Record<string, unknown>) {
  const seen = new Set<unknown>()
  const result: PluginInstance[] = []

  for (const entry of Object.values(mod)) {
    if (seen.has(entry)) continue
    seen.add(entry)
    const plugin = getServerPlugin(entry)
    if (!plugin) throw new TypeError("Plugin export is not a function")
    result.push(plugin)
  }

  return result
}

async function pluginCompletionRevision(load: PluginLoader.Loaded) {
  const hash = createHash("sha256").update(load.source).update("\0").update(load.spec).update("\0").update(load.entry)

  const version = load.pkg?.json.version
  if (typeof version === "string") hash.update("\0version\0").update(version)
  hash.update("\0options\0").update(stableJson(load.options ?? null))

  const entry = load.entry.startsWith("file://") ? fileURLToPath(load.entry) : load.entry
  const source = await fs.promises.readFile(entry).catch(() => undefined)
  if (source) hash.update("\0entry\0").update(source)

  return hash.digest("hex")
}

async function applyPlugin(
  load: PluginLoader.Loaded,
  origin: ConfigPlugin.Origin,
  input: PluginInput,
  hooks: Hooks[],
  hooksWithMeta: HookEntry[],
  completionOnly = false,
) {
  const entries: HookEntry[] = []
  const completionRevision = await pluginCompletionRevision(load)
  const completionTrusted = origin.scope === "global"
  const plugin = readV1Plugin(load.mod, load.spec, "server", "detect")
  if (plugin) {
    await resolvePluginId(load.source, load.spec, load.target, readPluginId(plugin.id, load.spec), load.pkg)
    const pluginName = readPluginId(plugin.id, load.spec) ?? load.pkg?.pkg ?? load.spec
    const hookObj = await (plugin as PluginModule).server(input, load.options)
    const registeredHook: Hooks = completionOnly ? { "session.preStop": hookObj["session.preStop"] } : hookObj
    if (completionOnly && !registeredHook["session.preStop"]) return entries
    if (!completionOnly) hooks.push(hookObj)
    const entry = hookEntry({
      hook: registeredHook,
      pluginName,
      completionIdentity: ["v1", load.source, load.spec, load.entry, pluginName],
      completionRevision,
      completionTrusted,
    })
    hooksWithMeta.push(entry)
    entries.push(entry)
    if (!completionTrusted && hookObj["session.preStop"]) {
      log.warn("ignored project-local session.preStop registration; declare the plugin in global config", {
        path: load.spec,
        pluginName,
        source: origin.source,
      })
    }
    return entries
  }

  for (const [index, server] of getLegacyPlugins(load.mod).entries()) {
    const fnName = (server as { name?: string }).name
    const pluginName = fnName && fnName !== "default" && fnName !== "" ? fnName : (load.pkg?.pkg ?? load.spec)
    const hookObj = await server(input, load.options)
    const registeredHook: Hooks = completionOnly ? { "session.preStop": hookObj["session.preStop"] } : hookObj
    if (completionOnly && !registeredHook["session.preStop"]) continue
    if (!completionOnly) hooks.push(hookObj)
    const entry = hookEntry({
      hook: registeredHook,
      pluginName,
      completionIdentity: ["legacy", load.source, load.spec, load.entry, pluginName, String(index)],
      completionRevision,
      completionTrusted,
    })
    hooksWithMeta.push(entry)
    entries.push(entry)
    if (!completionTrusted && hookObj["session.preStop"]) {
      log.warn("ignored project-local session.preStop registration; declare the plugin in global config", {
        path: load.spec,
        pluginName,
        source: origin.source,
      })
    }
  }
  return entries
}

function unavailableCompletionHook(input: {
  completionIdentity: string[]
  pluginName: string
  state: "missing" | "unloadable" | "invalid" | "registry"
}) {
  const providerID = completionProviderID(...input.completionIdentity)
  const hook: Hooks = {
    "session.preStop": async (_input, output) => {
      output.status = "blocked"
      output.reason =
        input.state === "registry"
          ? "The authoritative completion-provider registry could not be read or updated; completion cannot be verified. User action is required: ask the user to inspect local MiMoCode logs."
          : input.state === "invalid"
            ? `Required completion provider ${providerID} no longer exports session.preStop; completion cannot be verified. Restore the provider or ask the user to remove it through the administrator control plane.`
            : `Required completion provider ${providerID} could not be loaded; completion cannot be verified. User action is required: restore the provider or ask the user to remove it through the administrator control plane.`
    },
  }
  return {
    hook,
    entry: hookEntry({
      hook,
      pluginName: input.pluginName,
      completionIdentity: input.completionIdentity,
      completionRevision: createHash("sha256")
        .update(input.completionIdentity.join("\0"))
        .update(`\0${input.state}`)
        .digest("hex"),
      completionTrusted: true,
      completionUnavailable: true,
    }),
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const config = yield* Config.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("Plugin.state")(function* (ctx) {
        const hooks: Hooks[] = []
        const hooksWithMeta: HookEntry[] = []
        const bridge = yield* EffectBridge.make()

        function publishPluginError(message: string) {
          bridge.fork(bus.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() }))
        }

        const { Server } = yield* Effect.promise(() => import("../server/server"))

        const client = createOpencodeClient({
          baseUrl: "http://localhost:4096",
          directory: ctx.directory,
          headers: Flag.MIMOCODE_SERVER_PASSWORD
            ? {
                Authorization: `Basic ${Buffer.from(`${Flag.MIMOCODE_SERVER_USERNAME ?? "mimocode"}:${Flag.MIMOCODE_SERVER_PASSWORD}`).toString("base64")}`,
              }
            : undefined,
          fetch: async (...args) => (await Server.Default()).app.fetch(...args),
        })
        const cfg = yield* config.get()
        const input: PluginInput = {
          client,
          project: ctx.project,
          worktree: ctx.worktree,
          directory: ctx.directory,
          experimental_workspace: {
            register(type: string, adaptor: PluginWorkspaceAdaptor) {
              registerAdaptor(ctx.project.id, type, adaptor as WorkspaceAdaptor)
            },
          },
          get serverUrl(): URL {
            return Server.url ?? new URL("http://localhost:4096")
          },
          // @ts-expect-error
          $: typeof Bun === "undefined" ? undefined : Bun.$,
        }

        for (const plugin of INTERNAL_PLUGINS) {
          log.info("loading internal plugin", { name: plugin.name })
          const init = yield* Effect.tryPromise({
            try: () => plugin(input),
            catch: (err) => {
              log.error("failed to load internal plugin", { name: plugin.name, error: err })
            },
          }).pipe(Effect.option)
          if (init._tag === "Some") {
            hooks.push(init.value)
            hooksWithMeta.push(
              hookEntry({
                hook: init.value,
                pluginName: plugin.name,
                completionIdentity: ["internal", plugin.name],
                completionTrusted: true,
              }),
            )
          }
        }

        // Load optional local extensions under src/ext/. Prefers the generated
        // _manifest.ts (a fixed import specifier resolves inside Bun single-file
        // executables, where filesystem scans do not); falls back to a directory
        // scan for unbundled runs. Each *Plugin-named export is registered.
        const extModules: Record<string, Record<string, unknown>> = {}
        // @ts-ignore generated manifest; may not exist at type-check time
        const manifest = yield* Effect.tryPromise(() => import("../ext/_manifest")).pipe(Effect.option)
        if (manifest._tag === "Some") {
          Object.assign(
            extModules,
            (manifest.value as { modules?: Record<string, Record<string, unknown>> }).modules ?? {},
          )
        } else {
          const extDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ext")
          const extFiles = fs.existsSync(extDir)
            ? fs.readdirSync(extDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts") && f !== "_manifest.ts")
            : []
          for (const entry of extFiles) {
            const mod = yield* Effect.tryPromise({
              try: () => import(/* @vite-ignore */ pathToFileURL(path.join(extDir, entry)).href),
              catch: (err) => log.error("failed to import extension", { name: entry, error: err }),
            }).pipe(Effect.option)
            if (mod._tag === "Some") extModules[entry.replace(/\.ts$/, "")] = mod.value as Record<string, unknown>
          }
        }
        for (const [name, value] of Object.entries(extModules)) {
          // Only treat *Plugin-named function exports as plugins. Other modules
          // (e.g. a CLI helper export) are not plugins and must not be invoked
          // as plugin factories.
          const overlay = Object.entries(value).find(
            ([exportName, v]) => typeof v === "function" && exportName.endsWith("Plugin"),
          )?.[1] as PluginInstance | undefined
          if (!overlay) continue
          log.info("loading extension", { name })
          const init = yield* Effect.tryPromise({
            try: () => overlay(input),
            catch: (err) => log.error("failed to load extension", { name, error: err }),
          }).pipe(Effect.option)
          if (init._tag === "Some") {
            hooks.push(init.value)
            hooksWithMeta.push(
              hookEntry({
                hook: init.value,
                pluginName: name,
                completionIdentity: ["extension", name],
                completionTrusted: true,
              }),
            )
          }
        }

        const plugins = Flag.MIMOCODE_PURE ? [] : (cfg.plugin_origins ?? [])
        const activeTrustedIdentities = new Set(
          plugins
            .filter((origin) => origin.scope === "global")
            .map((origin) => ConfigPlugin.pluginIdentity(origin.spec)),
        )
        const completionOnlyPlugins = Flag.MIMOCODE_PURE
          ? []
          : (cfg.completion_plugin_origins ?? []).filter(
              (origin) => !activeTrustedIdentities.has(ConfigPlugin.pluginIdentity(origin.spec)),
            )
        const activeConfiguredCompletionIdentities = new Set(
          (Flag.MIMOCODE_PURE ? [] : (cfg.completion_plugin_origins ?? [])).map((origin) =>
            ConfigPlugin.pluginIdentity(origin.spec),
          ),
        )
        const successfullyLoadedConfiguredIdentities = new Set<string>()
        const liveConfiguredCompletionProviders: ConfiguredCompletionProvider[] = []
        if (Flag.MIMOCODE_PURE && cfg.plugin_origins?.length) {
          log.info("skipping external plugins in pure mode", { count: cfg.plugin_origins.length })
        }
        if (plugins.length || completionOnlyPlugins.length) yield* config.waitForDependencies()

        const loadConfiguredPlugins = (items: ConfigPlugin.Origin[]) =>
          PluginLoader.loadExternal({
            items,
            kind: "server",
            finish: async (load, origin) => ({ load, origin }),
            report: {
              start(candidate) {
                log.info("loading plugin", { path: candidate.plan.spec })
              },
              missing(candidate, _retry, message) {
                log.warn("plugin has no server entrypoint", { path: candidate.plan.spec, message })
              },
              error(candidate, _retry, stage, error, resolved) {
                const spec = candidate.plan.spec
                const cause = error instanceof Error ? (error.cause ?? error) : error
                const message = stage === "load" ? errorMessage(error) : errorMessage(cause)

                if (stage === "install") {
                  const parsed = parsePluginSpecifier(spec)
                  log.error("failed to install plugin", { pkg: parsed.pkg, version: parsed.version, error: message })
                  publishPluginError(`Failed to install plugin ${parsed.pkg}@${parsed.version}: ${message}`)
                  return
                }

                if (stage === "compatibility") {
                  log.warn("plugin incompatible", { path: spec, error: message })
                  publishPluginError(`Plugin ${spec} skipped: ${message}`)
                  return
                }

                if (stage === "entry") {
                  log.error("failed to resolve plugin server entry", { path: spec, error: message })
                  publishPluginError(`Failed to load plugin ${spec}: ${message}`)
                  return
                }

                log.error("failed to load plugin", { path: spec, target: resolved?.entry, error: message })
                publishPluginError(`Failed to load plugin ${spec}: ${message}`)
              },
            },
          })

        const applyConfiguredPlugin = async (
          load: PluginLoader.Loaded,
          origin: ConfigPlugin.Origin,
          completionOnly = false,
        ) => {
          try {
            const entries = await applyPlugin(load, origin, input, hooks, hooksWithMeta, completionOnly)
            if (origin.scope !== "global") return
            const configIdentity = ConfigPlugin.pluginIdentity(origin.spec)
            successfullyLoadedConfiguredIdentities.add(configIdentity)
            liveConfiguredCompletionProviders.push(
              ...entries
                .filter((entry) => entry.completionTrusted && !!entry.hook["session.preStop"])
                .map((entry) => ({
                  kind: "configured" as const,
                  configIdentity,
                  completionIdentity: [...entry.completionIdentity],
                  pluginName: entry.pluginName,
                })),
            )
          } catch (err) {
            log.error(completionOnly ? "failed to load shadowed trusted completion plugin" : "failed to load plugin", {
              path: load.spec,
              error: errorMessage(err),
            })
          }
        }

        const loaded = yield* Effect.promise(() => loadConfiguredPlugins(plugins))
        for (const loadedPlugin of loaded) {
          const { load, origin } = loadedPlugin
          // Keep plugin execution sequential so hook registration and execution
          // order remains deterministic across plugin runs.
          yield* Effect.promise(() => applyConfiguredPlugin(load, origin))
        }

        // Preserve the ordinary local-wins plugin behavior while separately
        // restoring any trusted completion provider shadowed by that local
        // declaration. Register only session.preStop so config, event, tool,
        // and transform hooks still follow the established dedupe winner.
        const loadedCompletionOnly = yield* Effect.promise(() => loadConfiguredPlugins(completionOnlyPlugins))
        for (const loadedPlugin of loadedCompletionOnly) {
          const { load, origin } = loadedPlugin
          yield* Effect.promise(() => applyConfiguredPlugin(load, origin, true))
        }

        if (!Flag.MIMOCODE_PURE) {
          const liveProviderIDs = new Set(
            liveConfiguredCompletionProviders.map((record) => completionProviderID(...record.completionIdentity)),
          )
          const registry = yield* Effect.tryPromise({
            try: () =>
              updateCompletionProviderRegistry((current) => ({
                version: 1,
                providers: deduplicateCompletionProviderRecords([
                  ...current.providers.filter((record) => record.kind === "file"),
                  ...current.providers.filter(
                    (record): record is ConfiguredCompletionProvider =>
                      record.kind === "configured" &&
                      activeConfiguredCompletionIdentities.has(record.configIdentity),
                  ),
                  ...liveConfiguredCompletionProviders,
                ]),
              })),
            catch: (error) => error,
          }).pipe(Effect.option)

          if (registry._tag === "None") {
            const unavailable = unavailableCompletionHook({
              completionIdentity: ["registry", "configured"],
              pluginName: "completion-provider-registry",
              state: "registry",
            })
            hooksWithMeta.push(unavailable.entry)
            log.error("failed to persist configured completion providers")
          } else {
            for (const record of registry.value.providers) {
              if (record.kind !== "configured") continue
              if (!activeConfiguredCompletionIdentities.has(record.configIdentity)) continue
              const providerID = completionProviderID(...record.completionIdentity)
              if (liveProviderIDs.has(providerID)) continue
              const unavailable = unavailableCompletionHook({
                completionIdentity: record.completionIdentity,
                pluginName: record.pluginName,
                state: successfullyLoadedConfiguredIdentities.has(record.configIdentity) ? "invalid" : "unloadable",
              })
              hooksWithMeta.push(unavailable.entry)
              log.error("registered fail-closed completion provider for unavailable configured plugin", {
                providerID,
                configIdentity: record.configIdentity,
              })
            }
          }
        }

        // Notify plugins of current config
        for (const hook of hooks) {
          yield* Effect.tryPromise({
            try: () => Promise.resolve((hook as any).config?.(cfg)),
            catch: (err) => {
              log.error("plugin config hook failed", { error: err })
            },
          }).pipe(Effect.ignore)
        }

        // Subscribe to bus events, fiber interrupted when scope closes
        yield* bus.subscribeAll().pipe(
          Stream.runForEach((input) =>
            Effect.sync(() => {
              for (const hook of hooks) {
                void hook["event"]?.({ event: input as any })
              }
            }),
          ),
          Effect.forkScoped,
        )

        return { hooks, hooksWithMeta }
      }),
    )

    const fileHookState = yield* InstanceState.make<FileHookState>(
      Effect.fn("Plugin.fileHooks")(function* () {
        const hooks: Hooks[] = []
        const meta: HookEntry[] = []
        const files: Record<string, number> = {}
        const seenCompletionFileHooks = new Set<string>()
        const registry = yield* Effect.tryPromise({
          try: () => readCompletionProviderRegistry(),
          catch: (error) => error,
        }).pipe(Effect.option)
        const knownCompletionFileHooks = new Map<string, KnownCompletionFileHook>()
        if (registry._tag === "Some") {
          for (const record of registry.value.providers) {
            if (record.kind !== "file") continue
            knownCompletionFileHooks.set(completionFileHookKey(record.canonicalFile, record.canonicalScope), record)
          }
        } else {
          const unavailable = unavailableCompletionHook({
            completionIdentity: ["registry", "file"],
            pluginName: "completion-provider-registry",
            state: "registry",
          })
          meta.push(unavailable.entry)
          log.error("failed to read file completion-provider registry")
        }
        yield* config.get()
        const configuredDirs = yield* config.directories()
        // File hooks retain their established actor/event behavior from every
        // configured directory. Only user-global/profile directories are
        // authoritative completion providers; a project hook that exports
        // session.preStop is loaded for compatibility but ignored for that one
        // completion decision, with a diagnostic below.
        const trustedDirCandidates = [
          Global.Path.config,
          path.join(Global.Path.home, ".mimocode"),
          Flag.MIMOCODE_CONFIG_DIR,
        ].filter((value): value is string => typeof value === "string" && value.length > 0)
        const trustedDirs = new Set(
          yield* Effect.promise(() => Promise.all(trustedDirCandidates.map(canonicalizePath))),
        )
        const dirs: string[] = []
        const seenDirs = new Set<string>()
        for (const configuredDir of configuredDirs) {
          const canonicalDir = yield* Effect.promise(() => canonicalizePath(configuredDir))
          if (seenDirs.has(canonicalDir)) continue
          seenDirs.add(canonicalDir)
          dirs.push(configuredDir)
        }

        const activeTrustedScopes = new Set<string>()
        const registerUnavailableCompletionHook = (
          known: KnownCompletionFileHook,
          _completionRevision: string,
          state: "missing" | "unloadable" | "invalid",
        ) => {
          const identity = ["file", known.canonicalFile, known.canonicalScope]
          const providerID = completionProviderID(...identity)
          const unavailable = unavailableCompletionHook({
            completionIdentity: identity,
            pluginName: `file:${known.name}`,
            state,
          })
          hooks.push(unavailable.hook)
          meta.push(unavailable.entry)
          log.error(`registered fail-closed completion provider for ${state} file hook`, {
            path: known.filePath,
            name: known.name,
            providerID,
          })
        }

        for (const dir of dirs) {
          const resolvedScope = yield* Effect.promise(() => canonicalizePath(dir))
          const canonicalScope = path.resolve(dir)
          const completionTrusted = trustedDirs.has(resolvedScope)
          if (completionTrusted) activeTrustedScopes.add(canonicalScope)
          const matches = Glob.scanSync(FILE_HOOK_GLOB, { cwd: dir, absolute: true, dot: true, symlink: true })
          for (const match of matches) {
            // Use the stable configured path, not its current realpath target.
            // A symlink retarget is a provider implementation update, not an
            // uninstall plus a permanently-missing second provider.
            const canonicalFile = path.resolve(match)
            const name = path.basename(match, path.extname(match))
            const identity = ["file", canonicalFile, canonicalScope]
            const completionKey = completionFileHookKey(canonicalFile, canonicalScope)
            if (completionTrusted) seenCompletionFileHooks.add(completionKey)
            const providerID = completionProviderID(...identity)
            const source = yield* Effect.promise(() => fs.promises.readFile(match, "utf8").catch(() => undefined))
            const completionRevision = source
              ? createHash("sha256").update(source).digest("hex")
              : createHash("sha256").update(`${canonicalFile}\0unreadable`).digest("hex")
            // A cold-start syntax/import failure cannot be introspected as a
            // module. Recognize the ordinary object-property spellings used by
            // file hooks, while the last-known set covers imported/spread
            // registrations after a successful load in this process.
            const declaresSessionPreStop =
              source !== undefined &&
              /(?:["']session\.preStop["']\s*|\[\s*["']session\.preStop["']\s*\])\s*:/.test(source)
            const known = { canonicalFile, canonicalScope, filePath: match, name }
            const stat = yield* Effect.tryPromise({
              try: () => fs.promises.stat(match),
              catch: (err) => err,
            }).pipe(Effect.catch(() => Effect.succeed(undefined)))
            files[match] = stat?.mtimeMs ?? 0
            // Transpile and load the hook file. We use Bun.build to produce a
            // temporary .js artifact, then dynamic-import that artifact. This
            // avoids two pitfalls: (1) Bun's import() ignores query-string cache
            // busters so re-imports return stale modules, (2) require() transpiles
            // .ts in some contexts but not others (CI Linux edge case).
            const mod = yield* Effect.tryPromise({
              try: async () => {
                const result = await Bun.build({
                  entrypoints: [match],
                  target: "bun",
                  format: "esm",
                })
                if (!result.success) throw new Error(result.logs.map(String).join("\n"))
                const blob = result.outputs[0]
                const tmpFile = `${match}.${Date.now()}.mjs`
                await Bun.write(tmpFile, blob)
                try {
                  return (await import(tmpFile)) as Record<string, unknown>
                } finally {
                  fs.promises.unlink(tmpFile).catch(() => {})
                }
              },
              catch: (err) => err,
            }).pipe(
              Effect.catch((err) => {
                log.error("failed to load file hook", { path: match, error: errorMessage(err) })
                return Effect.succeed(undefined)
              }),
            )
            if (!mod) {
              // Trusted global hooks are installed executable policy. Losing a
              // hook to a compile/import error must not silently remove its
              // completion gate. Keep a synthetic provider with the same
              // stable opaque identity; file/error details stay in local logs.
              if (completionTrusted && (knownCompletionFileHooks.has(completionKey) || declaresSessionPreStop)) {
                registerUnavailableCompletionHook(known, completionRevision, "unloadable")
              }
              continue
            }
            const hookObj: Hooks = (mod.default ?? mod) as Hooks
            if (!hookObj || typeof hookObj !== "object" || Array.isArray(hookObj)) {
              log.error("file hook module did not export a hook object", { path: match, name, providerID })
              if (completionTrusted && (knownCompletionFileHooks.has(completionKey) || declaresSessionPreStop)) {
                registerUnavailableCompletionHook(known, completionRevision, "unloadable")
              }
              continue
            }
            if (completionTrusted) {
              if (hookObj["session.preStop"]) {
                knownCompletionFileHooks.set(completionKey, known)
              } else if (knownCompletionFileHooks.has(completionKey) || declaresSessionPreStop) {
                // Enrollment is durable policy, not a fresh inference from the
                // current module shape. A valid hot update that accidentally
                // drops session.preStop must therefore fail closed across this
                // reload and future process restarts. Only the explicit forget
                // command is allowed to remove the persisted enrollment.
                knownCompletionFileHooks.set(completionKey, known)
                registerUnavailableCompletionHook(known, completionRevision, "invalid")
              }
            }
            hooks.push(hookObj)
            const entry = hookEntry({
              hook: hookObj,
              pluginName: `file:${name}`,
              completionIdentity: identity,
              completionRevision,
              completionTrusted,
            })
            meta.push(entry)
            if (!completionTrusted && hookObj["session.preStop"]) {
              log.warn("ignored project-local session.preStop registration; install it in a global hook directory", {
                path: match,
                name,
              })
            }
            log.info("loaded file hook", { path: match, name, providerID: entry.completionProviderID })
          }
        }

        // A trusted completion hook can briefly disappear during an editor's
        // atomic-save rename, or permanently disappear because of an unsafe
        // deletion. Neither event may silently remove an installed completion
        // policy. Keep a tombstone provider until the file returns, the trusted
        // scope is removed from config, or an administrator explicitly forgets
        // the provider through reloadFileHooks().
        for (const [key, known] of knownCompletionFileHooks) {
          if (seenCompletionFileHooks.has(key)) continue
          if (!activeTrustedScopes.has(known.canonicalScope)) {
            knownCompletionFileHooks.delete(key)
            continue
          }
          const revision = createHash("sha256").update(`${known.canonicalFile}\0missing`).digest("hex")
          registerUnavailableCompletionHook(known, revision, "missing")
        }

        if (registry._tag === "Some") {
          const persisted = yield* Effect.tryPromise({
            try: () =>
              updateCompletionProviderRegistry((current) => ({
                version: 1,
                providers: deduplicateCompletionProviderRecords([
                  ...current.providers.filter((record) => record.kind === "configured"),
                  ...[...knownCompletionFileHooks.values()].map(
                    (known): FileCompletionProvider => ({ kind: "file", ...known }),
                  ),
                ]),
              })),
            catch: (error) => error,
          }).pipe(Effect.option)
          if (persisted._tag === "None") {
            const unavailable = unavailableCompletionHook({
              completionIdentity: ["registry", "file-persist"],
              pluginName: "completion-provider-registry",
              state: "registry",
            })
            meta.push(unavailable.entry)
            log.error("failed to persist file completion providers")
          }
        }

        // Dispatch bus events to file hooks' `event` handlers. Scoped to this
        // cache entry: invalidation interrupts the fiber, and the rebuild
        // re-subscribes with the fresh hook set.
        if (hooks.some((hook) => typeof hook.event === "function")) {
          yield* bus.subscribeAll().pipe(
            Stream.runForEach((input) =>
              Effect.sync(() => {
                for (const entry of meta) {
                  const fn = entry.hook.event
                  if (!fn) continue
                  try {
                    void Promise.resolve(fn({ event: input as any })).catch((err) => {
                      log.error("file hook event handler failed", { hook: entry.pluginName, error: errorMessage(err) })
                    })
                  } catch (err) {
                    log.error("file hook event handler failed", { hook: entry.pluginName, error: errorMessage(err) })
                  }
                }
              }),
            ),
            Effect.forkScoped,
          )
        }

        return { hooks, meta, dirs, files, lastCheck: { value: Date.now() } }
      }),
    )

    // Staleness check: re-stat known hook files and re-glob hook dirs. Any
    // mtime change, added, or removed file invalidates the cache so the next
    // InstanceState.get rebuilds it. Covers ALL writers (editors, git, other
    // processes) — not just this process's write/edit tools. Throttled to
    // avoid stat storms on hot trigger paths.
    const freshFileHooks = Effect.gen(function* () {
      const fh = yield* InstanceState.get(fileHookState)
      const now = Date.now()
      if (now - fh.lastCheck.value < FILE_HOOK_CHECK_INTERVAL_MS) return fh
      fh.lastCheck.value = now

      const stale = yield* Effect.promise(async () => {
        const known = Object.keys(fh.files)
        const seen = new Set<string>()
        for (const dir of fh.dirs) {
          for (const match of Glob.scanSync(FILE_HOOK_GLOB, { cwd: dir, absolute: true, dot: true, symlink: true })) {
            seen.add(match)
            if (!(match in fh.files)) return true
          }
        }
        for (const file of known) {
          if (!seen.has(file)) return true
          const stat = await fs.promises.stat(file).catch(() => undefined)
          if ((stat?.mtimeMs ?? 0) !== fh.files[file]) return true
        }
        return false
      })

      if (!stale) return fh
      log.info("file hooks changed on disk, reloading")
      clearFileHookSessionPreStopProgress(fh.meta)
      yield* InstanceState.invalidate(fileHookState)
      return yield* InstanceState.get(fileHookState)
    })

    const aggregateDecision = (
      input: ActorPreStopInput | ActorPostStopInput,
      eventName: "actor.preStop" | "actor.postStop",
    ) =>
      Effect.gen(function* () {
        const s = yield* InstanceState.get(state)
        const fh = yield* freshFileHooks
        const reasons: string[] = []
        const pluginNames: string[] = []
        const hookIDs: string[] = []
        let anyContinue = false

        for (const entry of [...s.hooksWithMeta, ...fh.meta]) {
          const reg = entry.hook[eventName]
          if (!reg) continue

          const fn = typeof reg === "function" ? reg : reg.run
          const matcher: ActorMatcher | undefined = typeof reg === "function" ? undefined : reg.matcher

          if (!matchesActor(matcher, input)) {
            yield* bus.publish(HookEvent.Executed, {
              event: eventName,
              hookID: entry.hookIDFor(eventName),
              pluginName: entry.pluginName,
              actorID: input.actorID,
              agentType: input.agentType,
              durationMs: 0,
              outcome: "skipped",
              continueRequested: false,
              reasonLength: 0,
            })
            continue
          }

          const startedAt = Date.now()
          const o: ActorStopOutput = { continue: false }
          let hookOutcome: "success" | "error" = "success"
          // TODO: pass an AbortSignal to fn so plugin authors can wire cooperative
          // cancellation into their fetch / DB calls. Effect interrupt only stops
          // the awaiting fiber — the underlying Promise keeps running and may
          // bus.publish events after the actor has been cleaned up. See spec
          // Future work for full discussion. Strict in-process cancellation
          // (子进程隔离) is out of scope; AbortSignal is the in-process ceiling.
          yield* Effect.tryPromise({
            try: () => fn(input as never, o),
            catch: (err) => err,
          }).pipe(
            Effect.tapError((err) =>
              Effect.gen(function* () {
                hookOutcome = "error"
                log.error(`${eventName} hook failed`, {
                  pluginName: entry.pluginName,
                  hookID: entry.hookIDFor(eventName),
                  error: err,
                })
                yield* bus.publish(Session.Event.Error, {
                  sessionID: input.sessionID as SessionID,
                  error: new NamedError.Unknown({
                    message: `${eventName} hook (${entry.pluginName}) failed: ${errorMessage(err)}`,
                  }).toObject(),
                })
              }),
            ),
            Effect.ignore,
          )

          const durationMs = Date.now() - startedAt
          yield* bus.publish(HookEvent.Executed, {
            event: eventName,
            hookID: entry.hookIDFor(eventName),
            pluginName: entry.pluginName,
            actorID: input.actorID,
            agentType: input.agentType,
            durationMs,
            outcome: hookOutcome,
            continueRequested: o.continue === true,
            reasonLength: o.reason?.length ?? 0,
          })

          if (o.continue === true && o.reason && o.reason.length > 0) {
            anyContinue = true
            reasons.push(o.reason)
            pluginNames.push(entry.pluginName)
            hookIDs.push(entry.hookIDFor(eventName))
          } else if (o.continue === true) {
            log.warn(`${eventName} hook returned continue=true without reason; ignored`, {
              pluginName: entry.pluginName,
            })
          }
        }

        const aggregated: ActorStopAggregatedDecision = {
          continue: anyContinue,
          reason: reasons.length > 0 ? reasons.join("\n\n") : undefined,
          contributingPluginNames: pluginNames,
          contributingHookIDs: hookIDs,
        }
        return aggregated
      })

    const triggerActorPreStop = Effect.fn("Plugin.triggerActorPreStop")(function* (input: ActorPreStopInput) {
      return yield* aggregateDecision(input, "actor.preStop")
    })

    const triggerActorPostStop = Effect.fn("Plugin.triggerActorPostStop")(function* (input: ActorPostStopInput) {
      return yield* aggregateDecision(input, "actor.postStop")
    })

    const sessionPreStopProgress = new Map<
      string,
      {
        turnID: string
        revision: string
        taskID: string
        stateDigest: string
        sameStateCount: number
        continuationCount: number
        blockedReportIssued: boolean
      }
    >()
    const sessionPreStopTurnProgress = new Map<
      string,
      {
        turnID: string
        continuationCount: number
        blockedReportIssued: boolean
      }
    >()

    const clearSessionPreStopProgress = (sessionID: string, providerID: string) => {
      sessionPreStopProgress.delete(`${sessionID}\0${providerID}`)
    }

    const clearSessionPreStopProgressForSession = (sessionID: string) => {
      sessionPreStopTurnProgress.delete(sessionID)
      const prefix = `${sessionID}\0`
      for (const key of sessionPreStopProgress.keys()) {
        if (key.startsWith(prefix)) sessionPreStopProgress.delete(key)
      }
    }

    const clearSessionPreStopProgressForProviders = (providerIDs: ReadonlySet<string>) => {
      for (const key of sessionPreStopProgress.keys()) {
        const providerID = key.slice(key.indexOf("\0") + 1)
        if (providerIDs.has(providerID)) sessionPreStopProgress.delete(key)
      }
    }

    const clearFileHookSessionPreStopProgress = (entries: HookEntry[]) => {
      clearSessionPreStopProgressForProviders(new Set(entries.map((entry) => entry.completionProviderID)))
    }

    const restoreSessionPreStopProgress = (
      input: SessionPreStopHostInput,
      entries: HookEntry[],
    ): SessionPreStopPersistedProgress | undefined => {
      const parsed = SessionPreStopPersistedProgressSchema.safeParse(input.progress)
      if (!parsed.success) return
      const turnID = input.visibleUserMessageID ?? "(session)"
      if (parsed.data.turnID !== turnID) return

      // The durable snapshot is authoritative after an Instance/process
      // restart. Rebuild this session's cache from it, filtering provider-local
      // state by implementation revision so hot-reloaded hook code starts a
      // fresh no-progress run while the aggregate spend cap remains durable.
      clearSessionPreStopProgressForSession(input.sessionID)
      const revisions = new Map(entries.map((entry) => [entry.completionProviderID, entry.completionRevision]))
      for (const provider of parsed.data.providers) {
        if (revisions.get(provider.providerID) !== provider.revision) continue
        sessionPreStopProgress.set(`${input.sessionID}\0${provider.providerID}`, {
          turnID,
          revision: provider.revision,
          taskID: provider.taskID,
          stateDigest: provider.stateDigest,
          sameStateCount: provider.sameStateCount,
          continuationCount: provider.continuationCount,
          blockedReportIssued: provider.blockedReportIssued,
        })
      }
      if (parsed.data.aggregate) {
        sessionPreStopTurnProgress.set(input.sessionID, {
          turnID,
          continuationCount: parsed.data.aggregate.continuationCount,
          blockedReportIssued: parsed.data.aggregate.blockedReportIssued,
        })
      }
      return parsed.data
    }

    const snapshotSessionPreStopProgress = (
      input: SessionPreStopHostInput,
      entries: HookEntry[],
    ): SessionPreStopPersistedProgress => {
      const turnID = input.visibleUserMessageID ?? "(session)"
      const revisions = new Map(entries.map((entry) => [entry.completionProviderID, entry.completionRevision]))
      const providers: SessionPreStopPersistedProgress["providers"] = []
      const prefix = `${input.sessionID}\0`
      for (const [key, progress] of sessionPreStopProgress) {
        if (!key.startsWith(prefix) || progress.turnID !== turnID) continue
        const providerID = key.slice(prefix.length)
        if (revisions.get(providerID) !== progress.revision) continue
        providers.push({
          providerID,
          revision: progress.revision,
          taskID: progress.taskID,
          stateDigest: progress.stateDigest,
          sameStateCount: progress.sameStateCount,
          continuationCount: progress.continuationCount,
          blockedReportIssued: progress.blockedReportIssued,
        })
      }
      const aggregate = sessionPreStopTurnProgress.get(input.sessionID)
      return {
        version: 1,
        turnID,
        providers: providers.slice(0, SESSION_PRESTOP_MAX_PROVIDERS),
        aggregate:
          aggregate?.turnID === turnID
            ? {
                continuationCount: aggregate.continuationCount,
                blockedReportIssued: aggregate.blockedReportIssued,
              }
            : undefined,
      }
    }

    yield* bus.subscribe(Session.Event.Deleted).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => clearSessionPreStopProgressForSession(event.properties.sessionID)),
      ),
      Effect.forkScoped,
    )

    const normalizeSessionPreStopOutput = (output: SessionPreStopOutput): SessionPreStopOutput => {
      if (!["allow", "continue", "awaiting_user", "blocked"].includes(output.status)) {
        throw new TypeError("session.preStop returned an invalid status")
      }
      if (output.taskId !== undefined && typeof output.taskId !== "string") {
        throw new TypeError("session.preStop taskId must be a string")
      }
      if (output.stateDigest !== undefined && typeof output.stateDigest !== "string") {
        throw new TypeError("session.preStop stateDigest must be a string")
      }
      if (output.reason !== undefined && typeof output.reason !== "string") {
        throw new TypeError("session.preStop reason must be a string")
      }
      if (
        output.nextAction !== undefined &&
        (typeof output.nextAction !== "object" || output.nextAction === null || Array.isArray(output.nextAction))
      ) {
        throw new TypeError("session.preStop nextAction must be an object")
      }
      if (output.nextAction?.description !== undefined && typeof output.nextAction.description !== "string") {
        throw new TypeError("session.preStop nextAction.description must be a string")
      }
      if (
        output.nextAction?.command !== undefined &&
        (!Array.isArray(output.nextAction.command) ||
          !output.nextAction.command.every((argument) => typeof argument === "string"))
      ) {
        throw new TypeError("session.preStop nextAction.command must be a string array")
      }
      if ((output.nextAction?.command?.length ?? 0) > SESSION_PRESTOP_MAX_COMMAND_ARGS) {
        throw new TypeError(
          `session.preStop nextAction.command exceeds ${SESSION_PRESTOP_MAX_COMMAND_ARGS} arguments`,
        )
      }
      if (
        output.nextAction?.command?.some(
          (argument) => Buffer.byteLength(argument) > SESSION_PRESTOP_MAX_COMMAND_ARG_BYTES,
        )
      ) {
        // An argv hint must be byte-for-byte executable. Truncating JSON or a
        // path creates a different, usually invalid command and can trap the
        // model in a deterministic retry loop.
        throw new TypeError(
          `session.preStop nextAction.command argument exceeds ${SESSION_PRESTOP_MAX_COMMAND_ARG_BYTES} bytes`,
        )
      }
      const description = output.nextAction?.description
        ? boundedUtf8(output.nextAction.description, SESSION_PRESTOP_MAX_DESCRIPTION_BYTES)
        : undefined
      const command = output.nextAction?.command ? [...output.nextAction.command] : undefined
      const nextAction = description || command ? { description, command } : undefined
      return {
        status: output.status,
        taskId: output.taskId ? boundedUtf8(output.taskId, SESSION_PRESTOP_MAX_TASK_ID_BYTES) : undefined,
        stateDigest: output.stateDigest
          ? boundedUtf8(output.stateDigest, SESSION_PRESTOP_MAX_STATE_DIGEST_BYTES)
          : undefined,
        reason: output.reason ? boundedUtf8(output.reason, SESSION_PRESTOP_MAX_REASON_BYTES) : undefined,
        nextAction,
      }
    }

    const appendProviderReason = (reason: string | undefined, message: string) =>
      boundedUtf8([reason, message].filter(Boolean).join("\n"), SESSION_PRESTOP_MAX_REASON_BYTES)

    const triggerSessionPreStop = Effect.fn("Plugin.triggerSessionPreStop")(function* (input: SessionPreStopHostInput) {
      const s = yield* InstanceState.get(state)
      const fh = yield* freshFileHooks
      const allEntries = [...s.hooksWithMeta, ...fh.meta].filter(
        (entry) => entry.completionTrusted && !!entry.hook["session.preStop"],
      )
      restoreSessionPreStopProgress(input, allEntries)
      const entries = allEntries.slice(0, SESSION_PRESTOP_MAX_PROVIDERS)
      const checked: Array<{
        providerID: string
        completionRevision: string
        hookID: string
        durationMs: number
        outcome: "success" | "error" | "timeout"
        output: SessionPreStopOutput
      }> = yield* Effect.forEach(
        entries,
        (entry) =>
          Effect.promise(async () => {
            const startedAt = Date.now()
            const output: SessionPreStopOutput = { status: "allow" }
            const registration = entry.hook["session.preStop"]!
            const record =
              typeof registration === "object" && registration !== null
                ? (registration as { run?: unknown; failureMode?: unknown })
                : undefined
            const hook =
              typeof registration === "function"
                ? registration
                : typeof record?.run === "function"
                  ? (record.run as (input: SessionPreStopInput, output: SessionPreStopOutput) => Promise<void>)
                  : undefined
            const failureMode: SessionPreStopFailureMode = record?.failureMode === "open" ? "open" : "closed"
            const invalidFailureMode =
              record?.failureMode !== undefined && record.failureMode !== "open" && record.failureMode !== "closed"
            const controller = new AbortController()
            const providerInput = Object.freeze({
              sessionID: input.sessionID,
              agentID: input.agentID,
              cwd: input.cwd,
              root: input.root,
              taskId: input.taskId,
              finalText: input.finalText,
              assistantMessageID: input.assistantMessageID,
              visibleUserMessageID: input.visibleUserMessageID,
              lastUserMessage: input.lastUserMessage,
              loadedSkills: Object.freeze([...input.loadedSkills]),
              abortSignal: controller.signal,
            }) satisfies SessionPreStopInput
            let result: { outcome: "success" | "error" | "timeout"; error?: unknown }
            if (!hook || invalidFailureMode) {
              result = { outcome: "error", error: new TypeError("Invalid session.preStop registration") }
            } else {
              result = await new Promise<{ outcome: "success" | "error" | "timeout"; error?: unknown }>((resolve) => {
                const timer = setTimeout(() => {
                  controller.abort()
                  resolve({ outcome: "timeout" })
                }, SESSION_PRESTOP_TIMEOUT_MS)
                Promise.resolve()
                  .then(() => hook(providerInput, output))
                  .then(
                    () => {
                      clearTimeout(timer)
                      resolve({ outcome: "success" })
                    },
                    (error) => {
                      clearTimeout(timer)
                      resolve({ outcome: "error", error })
                    },
                  )
              })
            }

            let normalized: SessionPreStopOutput = { status: "allow" }
            if (result.outcome === "success") {
              try {
                normalized = normalizeSessionPreStopOutput(output)
              } catch (error) {
                result = { outcome: "error", error }
              }
            }

            const providerID = entry.completionProviderID
            const hookID = `${providerID}#session.preStop`
            if (result.outcome === "timeout") {
              log.warn("session.preStop provider timed out", {
                providerID,
                pluginName: entry.pluginName,
                hookID,
                timeoutMs: SESSION_PRESTOP_TIMEOUT_MS,
                failureMode,
              })
            }
            if (result.outcome === "error") {
              log.error("session.preStop provider failed", {
                providerID,
                pluginName: entry.pluginName,
                hookID,
                error: errorMessage(result.error),
                failureMode,
              })
            }
            const failedOutput: SessionPreStopOutput =
              failureMode === "open"
                ? { status: "allow" }
                : {
                    status: "blocked",
                    reason:
                      result.outcome === "timeout"
                        ? `Required completion provider ${providerID} timed out; completion cannot be verified.`
                        : `Required completion provider ${providerID} failed; completion cannot be verified. Inspect local MiMoCode logs.`,
                  }
            return {
              providerID,
              completionRevision: entry.completionRevision,
              hookID,
              durationMs: Date.now() - startedAt,
              outcome: result.outcome,
              output: result.outcome === "success" ? normalized : failedOutput,
            }
          }),
        { concurrency: "unbounded" },
      )
      if (allEntries.length > SESSION_PRESTOP_MAX_PROVIDERS) {
        // Put the host guard first so its explanation survives aggregate
        // reason truncation even when every selected provider returns a
        // maximum-sized reason.
        checked.unshift({
          providerID: SESSION_PRESTOP_HOST_PROVIDER_ID,
          completionRevision: SESSION_PRESTOP_HOST_PROVIDER_ID,
          hookID: `${SESSION_PRESTOP_HOST_PROVIDER_ID}#session.preStop`,
          durationMs: 0,
          outcome: "error",
          output: {
            status: "blocked",
            reason: `Completion check registered ${allEntries.length} providers, exceeding the safe limit of ${SESSION_PRESTOP_MAX_PROVIDERS}.`,
          },
        })
      }

      const providers: Array<{
        providerID: string
        completionRevision: string
        hookID: string
        durationMs: number
        outcome: "success" | "error" | "timeout"
        output: SessionPreStopOutput
        noProgressCount?: number
        continuationCount?: number
        blockedReport: boolean
      }> = []
      const hasExplicitTerminal = checked.some(
        (provider) => provider.output.status === "blocked" || provider.output.status === "awaiting_user",
      )

      for (const provider of checked) {
        const taskID =
          boundedUtf8(provider.output.taskId ?? input.taskId ?? "", SESSION_PRESTOP_MAX_TASK_ID_BYTES) || undefined
        const comparableDigest =
          provider.output.stateDigest ??
          `sha256:${createHash("sha256")
            .update(JSON.stringify({ reason: provider.output.reason, nextAction: provider.output.nextAction }))
            .digest("hex")}`
        let output: SessionPreStopOutput = { ...provider.output, taskId: taskID }
        let noProgressCount: number | undefined
        let continuationCount: number | undefined
        let blockedReport = false

        if (provider.outcome === "success" && output.status === "continue" && !hasExplicitTerminal) {
          const progressKey = `${input.sessionID}\0${provider.providerID}`
          const comparableTurnID = input.visibleUserMessageID ?? "(session)"
          const comparableTaskID = taskID ?? "(session)"
          const previous = sessionPreStopProgress.get(progressKey)
          const sameTurn = previous?.turnID === comparableTurnID && previous.revision === provider.completionRevision
          const unchanged =
            sameTurn && previous.taskID === comparableTaskID && previous.stateDigest === comparableDigest
          noProgressCount = unchanged ? Math.min(previous.sameStateCount + 1, SESSION_PRESTOP_NO_PROGRESS_LIMIT) : 1
          continuationCount = sameTurn
            ? Math.min(previous.continuationCount + 1, SESSION_PRESTOP_TOTAL_CONTINUE_LIMIT)
            : 1
          const progress = {
            turnID: comparableTurnID,
            revision: provider.completionRevision,
            taskID: comparableTaskID,
            stateDigest: comparableDigest,
            sameStateCount: noProgressCount,
            continuationCount,
            blockedReportIssued: sameTurn ? previous.blockedReportIssued : false,
          }

          if (progress.blockedReportIssued) {
            output = {
              ...output,
              status: "blocked",
              reason: appendProviderReason(
                output.reason,
                `Completion provider ${provider.providerID} remained incomplete after its one host-requested blocker report.`,
              ),
            }
          } else if (
            noProgressCount >= SESSION_PRESTOP_NO_PROGRESS_LIMIT ||
            continuationCount >= SESSION_PRESTOP_TOTAL_CONTINUE_LIMIT
          ) {
            progress.blockedReportIssued = true
            blockedReport = true
            output = {
              ...output,
              reason: appendProviderReason(
                output.reason,
                noProgressCount >= SESSION_PRESTOP_NO_PROGRESS_LIMIT
                  ? `Completion provider ${provider.providerID} reported the same task state for three consecutive completion checks.`
                  : `Completion provider ${provider.providerID} reached the per-turn limit of ${SESSION_PRESTOP_TOTAL_CONTINUE_LIMIT} continuation checks.`,
              ),
            }
          }
          // Once the host has requested a blocker report, any further
          // `continue` in this visible turn becomes terminal even if a provider
          // keeps changing its digest. This is the absolute spend/convergence
          // bound; a real `allow`/terminal result still clears the latch.
          sessionPreStopProgress.set(progressKey, progress)
        } else {
          // A provider result other than the host-managed continue path breaks
          // its consecutive-check run. A later continue starts fresh.
          clearSessionPreStopProgress(input.sessionID, provider.providerID)
        }

        providers.push({ ...provider, output, noProgressCount, continuationCount, blockedReport })
      }

      let terminal = providers.filter(
        (provider) => provider.output.status === "blocked" || provider.output.status === "awaiting_user",
      )
      let continuing = providers.filter((provider) => provider.output.status === "continue")
      if (terminal.length > 0 || continuing.length === 0) {
        sessionPreStopTurnProgress.delete(input.sessionID)
      } else {
        const turnID = input.visibleUserMessageID ?? "(session)"
        const previous = sessionPreStopTurnProgress.get(input.sessionID)
        const sameTurn = previous?.turnID === turnID
        const progress = {
          turnID,
          continuationCount: sameTurn ? previous.continuationCount + 1 : 1,
          blockedReportIssued: sameTurn ? previous.blockedReportIssued : false,
        }
        if (progress.blockedReportIssued) {
          for (const [index, provider] of continuing.entries()) {
            provider.output = {
              ...provider.output,
              status: "blocked",
              reason:
                index === 0
                  ? appendProviderReason(
                      provider.output.reason,
                      "Completion providers remained incomplete after their one host-requested blocker report.",
                    )
                  : provider.output.reason,
            }
          }
          terminal = continuing
          continuing = []
        } else {
          const providerBlockedReport = continuing.some((provider) => provider.blockedReport)
          if (providerBlockedReport || progress.continuationCount >= SESSION_PRESTOP_TOTAL_CONTINUE_LIMIT) {
            progress.blockedReportIssued = true
            if (!providerBlockedReport) {
              continuing[0].blockedReport = true
              continuing[0].output = {
                ...continuing[0].output,
                reason: appendProviderReason(
                  continuing[0].output.reason,
                  `Completion providers reached the per-turn limit of ${SESSION_PRESTOP_TOTAL_CONTINUE_LIMIT} continuation checks.`,
                ),
              }
            }
          }
          sessionPreStopTurnProgress.set(input.sessionID, progress)
        }
      }
      if (terminal.length > 0) {
        // A hard terminal aggregate wins this check. Do not let unrelated
        // continuing providers accumulate hidden no-progress counts while the
        // turn cannot re-enter for their requested work.
        for (const provider of continuing) {
          clearSessionPreStopProgress(input.sessionID, provider.providerID)
        }
      }
      // Publish after aggregate convergence handling. The aggregate safeguard
      // may promote one provider to the blocker-report turn (or all continuing
      // providers to blocked), and observers must see the same final status the
      // caller receives rather than the pre-aggregation intermediate value.
      for (const provider of providers) {
        yield* bus.publish(HookEvent.SessionPreStopExecuted, {
          providerID: provider.providerID,
          hookID: provider.hookID,
          sessionID: input.sessionID,
          durationMs: provider.durationMs,
          outcome: provider.outcome,
          status: provider.output.status,
          taskID: provider.output.taskId,
          stateDigest: provider.output.stateDigest,
          noProgressCount: provider.noProgressCount,
          continuationCount: provider.continuationCount,
          blockedReport: provider.blockedReport,
        })
      }
      // A terminal provider is a hard gate: it outranks every continue request.
      // Keep all terminal contributors (including both blocked and
      // awaiting_user) so no provider reason or identity is lost.
      const contributors = terminal.length > 0 ? terminal : continuing
      const status: SessionPreStopStatus = terminal.some((provider) => provider.output.status === "blocked")
        ? "blocked"
        : terminal.length > 0
          ? "awaiting_user"
          : continuing.length > 0
            ? "continue"
            : "allow"
      const reasons = contributors
        .filter((provider) => provider.output.reason)
        .map((provider) => `[${provider.providerID}] ${provider.output.reason}`)
      return {
        status,
        reason:
          reasons.length > 0
            ? boundedUtf8(reasons.join("\n\n"), SESSION_PRESTOP_MAX_AGGREGATE_REASON_BYTES)
            : undefined,
        nextActions: contributors
          .flatMap((provider) =>
            provider.output.nextAction ? [{ ...provider.output.nextAction, providerID: provider.providerID }] : [],
          )
          .slice(0, SESSION_PRESTOP_MAX_ACTIONS),
        contributingProviderIDs: contributors.map((provider) => provider.providerID),
        contributingHookIDs: contributors.map((provider) => provider.hookID),
        blockedReport: status === "continue" && continuing.some((provider) => provider.blockedReport),
        progress: snapshotSessionPreStopProgress(input, allEntries),
      } satisfies SessionPreStopAggregatedDecision
    })

    const HOOK_TIMEOUT_MS = 5000
    const CIRCUIT_BREAKER_THRESHOLD = 3
    const hookFailures = new Map<string, number>()

    const deepFreeze = (value: unknown, seen = new WeakSet<object>()): void => {
      if (typeof value !== "object" || value === null || seen.has(value)) return
      seen.add(value)
      for (const child of Object.values(value)) deepFreeze(child, seen)
      Object.freeze(value)
    }

    const trigger = Effect.fn("Plugin.trigger")(function* <
      Name extends TriggerName,
      Input = Parameters<Required<Hooks>[Name]>[0],
      Output = Parameters<Required<Hooks>[Name]>[1],
    >(name: Name, input: Input, output: Output) {
      if (!name) return output
      const s = yield* InstanceState.get(state)
      const fh = yield* freshFileHooks
      const toolExecuteEvent = name === "tool.execute.before" || name === "tool.execute.after"
      const toolExecuteBefore = name === "tool.execute.before"
      if (toolExecuteEvent && typeof input === "object" && input !== null) {
        // sessionID/callID/cwd/visibleUserMessageID are Host evidence. Plugin
        // code may transform output.args, but it may never rewrite the identity
        // of the tool call that the trusted policy is evaluating.
        Object.freeze(input)
      }

      type TriggerEntry = { entry: HookEntry; file: boolean }
      const registered: TriggerEntry[] = [
        ...s.hooksWithMeta.map((entry) => ({ entry, file: false })),
        ...fh.meta.map((entry) => ({ entry, file: true })),
      ]
      // Project/local hooks retain their transform behavior, but all transforms
      // must settle before trusted global policy sees the final arguments.
      const ordered = toolExecuteEvent
        ? [
            ...registered.filter(({ entry }) => !entry.completionTrusted),
            ...registered.filter(({ entry }) => entry.completionTrusted),
          ]
        : registered
      let stickyCancel = false
      let stickyCancelReason: string | undefined
      const preserveCancellation = () => {
        if (!toolExecuteBefore || typeof output !== "object" || output === null) return
        const candidate = output as { cancel?: boolean; cancelReason?: string }
        if (candidate.cancel === true) {
          stickyCancel = true
          if (!stickyCancelReason && candidate.cancelReason) stickyCancelReason = candidate.cancelReason
        }
        if (!stickyCancel) return
        candidate.cancel = true
        if (stickyCancelReason) candidate.cancelReason = stickyCancelReason
      }
      preserveCancellation()

      for (const { entry, file } of ordered) {
        const fn = entry.hook[name] as any
        if (!fn) continue
        if (!file) {
          yield* Effect.promise(async () => fn(input, output))
          preserveCancellation()
          continue
        }
        const hookID = entry.hookIDFor(name)

        if ((hookFailures.get(hookID) ?? 0) >= CIRCUIT_BREAKER_THRESHOLD) {
          log.warn("hook circuit-breaker open, skipping", { hook: hookID })
          continue
        }

        const snapshot = structuredClone(output)
        const failed = yield* Effect.tryPromise({
          try: async () => {
            await Promise.race([
              Promise.resolve(fn(input, output)),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`hook timed out after ${HOOK_TIMEOUT_MS}ms`)), HOOK_TIMEOUT_MS),
              ),
            ])
          },
          catch: (err) => err,
        }).pipe(
          Effect.map(() => false),
          Effect.catch((err) => {
            Object.assign(output as any, snapshot)
            const count = (hookFailures.get(hookID) ?? 0) + 1
            hookFailures.set(hookID, count)
            log.error("file hook failed, output rolled back", {
              hook: hookID,
              event: name,
              error: errorMessage(err),
              consecutiveFailures: count,
              circuitOpen: count >= CIRCUIT_BREAKER_THRESHOLD,
            })
            return Effect.succeed(true)
          }),
        )
        if (!failed) hookFailures.delete(hookID)
        preserveCancellation()
      }
      if (toolExecuteBefore && typeof output === "object" && output !== null) {
        preserveCancellation()
        // Hooks may retain references and schedule later mutations. Freeze the
        // final JSON arguments and envelope so the exact arguments approved by
        // trusted policy are the arguments the tool executes.
        deepFreeze((output as { args?: unknown }).args)
        Object.freeze(output)
      }
      return output
    })

    const list = Effect.fn("Plugin.list")(function* () {
      const s = yield* InstanceState.get(state)
      return s.hooks
    })

    const init = Effect.fn("Plugin.init")(function* () {
      yield* InstanceState.get(state)
      yield* InstanceState.get(fileHookState)
    })

    const reloadFileHooks: Interface["reloadFileHooks"] = Effect.fn("Plugin.reloadFileHooks")(function* (options) {
      const current = yield* InstanceState.get(fileHookState)
      let forgotten = false
      if (options?.forgetMissingCompletionProviderFile) {
        if (!path.isAbsolute(options.forgetMissingCompletionProviderFile)) {
          return yield* Effect.die(new Error("Completion provider file must be an absolute path"))
        }
        const requestedFile = path.resolve(options.forgetMissingCompletionProviderFile)
        forgotten = yield* Effect.promise(async () => {
          const registry = await readCompletionProviderRegistry()
          const matching = new Set(
            registry.providers
              .filter(
                (record): record is FileCompletionProvider =>
                  record.kind === "file" && record.canonicalFile === requestedFile,
              )
              .map(completionProviderRecordKey),
          )
          if (matching.size === 0) return false
          const matchingProviderIDs = new Set(
            registry.providers
              .filter(
                (record): record is FileCompletionProvider =>
                  record.kind === "file" && matching.has(completionProviderRecordKey(record)),
              )
              .map((record) => completionProviderID("file", record.canonicalFile, record.canonicalScope)),
          )
          const activeProvider = current.meta.find(
            (entry) =>
              matchingProviderIDs.has(entry.completionProviderID) &&
              !entry.completionUnavailable &&
              !!entry.hook["session.preStop"],
          )
          const fileExists = await fs.promises.stat(requestedFile).then(
            () => true,
            (error) => {
              if (
                error instanceof Error &&
                "code" in error &&
                (error.code === "ENOENT" || error.code === "ENOTDIR")
              ) {
                return false
              }
              throw error
            },
          )
          if (fileExists && activeProvider) {
            throw new Error(`Refusing to forget an active completion provider file: ${requestedFile}`)
          }
          await updateCompletionProviderRegistry((current) => ({
            version: 1,
            providers: current.providers.filter(
              (record) => record.kind !== "file" || !matching.has(completionProviderRecordKey(record)),
            ),
          }))
          return true
        })
      }
      clearFileHookSessionPreStopProgress(current.meta)
      yield* InstanceState.invalidate(fileHookState)
      return { forgotten }
    })

    return Service.of({
      trigger,
      list,
      init,
      reloadFileHooks,
      triggerActorPreStop,
      triggerActorPostStop,
      triggerSessionPreStop,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer), Layer.provide(Config.defaultLayer))

export * as Plugin from "."
