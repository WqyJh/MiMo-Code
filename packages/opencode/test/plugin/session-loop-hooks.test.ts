import fs from "fs"
import path from "path"
import { pathToFileURL } from "url"
import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"
import {
  contentFilterResponse,
  startScriptedLLMServer,
  textStopResponse,
  toolCallResponse,
} from "../lib/scripted-llm-server"

void Log.init({ print: false })

const originalConfigDirectory = process.env.MIMOCODE_CONFIG_DIR

afterEach(async () => {
  await Instance.disposeAll()
  if (originalConfigDirectory === undefined) delete process.env.MIMOCODE_CONFIG_DIR
  else process.env.MIMOCODE_CONFIG_DIR = originalConfigDirectory
})

function run<A, E>(fx: Effect.Effect<A, E, SessionPrompt.Service | Session.Service>) {
  return Effect.runPromise(
    fx.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(SessionPrompt.defaultLayer, Session.defaultLayer))),
  )
}

async function configureProject(input: { directory: string; origin: string; plugins?: string[] }) {
  if (input.plugins?.length) {
    const trustedConfig = path.join(input.directory, "trusted-config")
    await fs.promises.mkdir(trustedConfig, { recursive: true })
    await Bun.write(
      path.join(trustedConfig, "mimocode.json"),
      JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: input.plugins }),
    )
    process.env.MIMOCODE_CONFIG_DIR = trustedConfig
  }
  await Bun.write(
    path.join(input.directory, "mimocode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      enabled_providers: ["alibaba"],
      provider: {
        alibaba: { options: { apiKey: "test-key", baseURL: `${input.origin}/v1` } },
      },
      agent: { build: { model: "alibaba/qwen-plus" } },
    }),
  )
}

async function writePlugin(directory: string, name: string, source: string) {
  const file = path.join(directory, name)
  await Bun.write(file, source)
  return pathToFileURL(file).href
}

async function writeFileHook(directory: string, name: string, source: string) {
  const hooks = path.join(directory, ".mimocode", "hooks")
  await fs.promises.mkdir(hooks, { recursive: true })
  const file = path.join(hooks, name)
  await Bun.write(file, source)
  return file
}

async function writeSkill(directory: string, name: string) {
  const skill = path.join(directory, ".mimocode", "skill", name)
  await fs.promises.mkdir(skill, { recursive: true })
  await Bun.write(
    path.join(skill, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test skill ${name}.\n---\n\n# ${name}\n\nTest instructions.\n`,
  )
}

describe("SessionPrompt session loop hooks", () => {
  test(
    "session.pre cancel aborts before LLM and fires session.post",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const stub = startScriptedLLMServer([{ lines: textStopResponse("should not run") }])
      try {
        const file = path.join(tmp.path, "plugin.ts")
        await Bun.write(
          file,
          [
            "export default async () => ({",
            '  "session.pre": async (_input, output) => {',
            "    output.cancel = true",
            '    output.cancelReason = "blocked by test"',
            "  },",
            '  "session.post": async (input) => {',
            '    if (input.outcome !== "cancelled") throw new Error(`expected cancelled, got ${input.outcome}`)',
            "  },",
            "})",
            "",
          ].join("\n"),
        )
        await Bun.write(
          path.join(tmp.path, "mimocode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            plugin: [pathToFileURL(file).href],
            enabled_providers: ["alibaba"],
            provider: {
              alibaba: { options: { apiKey: "test-key", baseURL: `${stub.origin}/v1` } },
            },
            agent: { build: { model: "alibaba/qwen-plus" } },
          }),
        )

        const exit = await Instance.provide({
          directory: tmp.path,
          fn: () =>
            run(
              Effect.gen(function* () {
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                const session = yield* sessions.create({ title: "pre-cancel" })
                return yield* prompt
                  .prompt({
                    sessionID: session.id,
                    agent: "build",
                    parts: [{ type: "text", text: "hello" }],
                  })
                  .pipe(Effect.exit)
              }),
            ),
        })

        expect(Exit.isFailure(exit)).toBe(true)
        expect(stub.captures.length).toBe(0)
      } finally {
        await stub.stop()
      }
    },
    { timeout: 30_000 },
  )

  test(
    "fires pre/post session and userQuery hooks around a single LLM step",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const stub = startScriptedLLMServer([{ lines: textStopResponse("hook answer") }])
      const markerPath = path.join(tmp.path, "hook-events.json")
      try {
        const file = path.join(tmp.path, "plugin.ts")
        await Bun.write(
          file,
          [
            "import * as fs from 'fs/promises'",
            `const MARKER = ${JSON.stringify(markerPath)}`,
            "async function push(label: string) {",
            "  let cur: string[] = []",
            "  try { cur = JSON.parse(await fs.readFile(MARKER, 'utf8')) } catch {}",
            "  cur.push(label)",
            "  await fs.writeFile(MARKER, JSON.stringify(cur))",
            "}",
            "export default async () => ({",
            '  "session.pre": async (input) => { await push(`pre:${input.agentID}`) },',
            '  "session.userQuery.pre": async (input) => { await push(`query.pre:${input.step}:${input.query}`) },',
            '  "session.llm.request": async (input) => { await push(`llm.request:${input.trajectory.map((message) => message.role).join(",")}`) },',
            '  "session.userQuery.post": async (input) => { await push(`query.post:${input.step}:${input.finalText ?? ""}:${input.trajectory.length}`) },',
            '  "session.post": async (input) => { await push(`post:${input.outcome}:${input.finalText ?? ""}:${input.trajectory.length}`) },',
            "})",
            "",
          ].join("\n"),
        )
        await Bun.write(
          path.join(tmp.path, "mimocode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            plugin: [pathToFileURL(file).href],
            enabled_providers: ["alibaba"],
            provider: {
              alibaba: { options: { apiKey: "test-key", baseURL: `${stub.origin}/v1` } },
            },
            agent: { build: { model: "alibaba/qwen-plus" } },
          }),
        )

        await Instance.provide({
          directory: tmp.path,
          fn: () =>
            run(
              Effect.gen(function* () {
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                const session = yield* sessions.create({ title: "hook-order" })
                yield* prompt.prompt({
                  sessionID: session.id,
                  agent: "build",
                  parts: [{ type: "text", text: "What is the answer?" }],
                })
              }),
            ),
        })

        const events = JSON.parse(await Bun.file(markerPath).text()) as string[]
        expect(events[0]).toBe("pre:main")
        expect(events[1]).toMatch(/^query\.pre:1:/)
        expect(events[2]).toBe("llm.request:system,user")
        expect(events[3]).toMatch(/^query\.post:1:hook answer:\d+$/)
        expect(events[4]).toMatch(/^post:completed:hook answer:\d+$/)
        expect(Number(events[4]?.split(":").pop())).toBeGreaterThan(0)
        expect(stub.captures.length).toBe(1)
      } finally {
        await stub.stop()
      }
    },
    { timeout: 30_000 },
  )

  test(
    "tool hooks bind local root-main calls to the persistent visible user turn and omit child calls",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const stub = startScriptedLLMServer([
        {
          lines: toolCallResponse({
            id: "call-root-skill",
            name: "skill",
            args: JSON.stringify({ name: "mimo-cut" }),
          }),
        },
        { lines: textStopResponse("root complete") },
        {
          lines: toolCallResponse({
            id: "call-child-skill",
            name: "skill",
            args: JSON.stringify({ name: "mimo-cut" }),
          }),
        },
        { lines: textStopResponse("child complete") },
      ])
      const marker = path.join(tmp.path, "tool-hook-visible-turn.jsonl")
      try {
        await writeSkill(tmp.path, "mimo-cut")
        const plugin = await writePlugin(
          tmp.path,
          "tool-hook-visible-turn-plugin.ts",
          [
            "import * as fs from 'fs/promises'",
            `const marker = ${JSON.stringify(marker)}`,
            "async function record(phase: string, input: Record<string, unknown>) {",
            "  await fs.appendFile(marker, `${JSON.stringify({ phase, ...input })}\\n`)",
            "}",
            "export default async () => ({",
            '  "tool.execute.before": async (input) => { await record("before", input) },',
            '  "tool.execute.after": async (input) => { await record("after", input) },',
            "})",
            "",
          ].join("\n"),
        )
        await configureProject({ directory: tmp.path, origin: stub.origin, plugins: [plugin] })

        let rootSessionID = ""
        let childSessionID = ""
        let rootVisibleUserMessageID = ""
        await Instance.provide({
          directory: tmp.path,
          fn: () =>
            run(
              Effect.gen(function* () {
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                const root = yield* sessions.create({ title: "root tool hook" })
                rootSessionID = root.id
                yield* prompt.prompt({
                  sessionID: root.id,
                  agent: "build",
                  parts: [{ type: "text", text: "load the root skill" }],
                })
                const rootMessages = yield* sessions.messages({ sessionID: root.id, agentID: "main" })
                const visibleRoot = rootMessages.find(
                  (message) =>
                    message.info.role === "user" &&
                    message.parts.some(
                      (part) => part.type === "text" && !part.synthetic && part.text === "load the root skill",
                    ),
                )
                if (!visibleRoot) throw new Error("Root visible user message was not persisted")
                rootVisibleUserMessageID = visibleRoot.info.id

                const child = yield* sessions.create({ parentID: root.id, title: "child tool hook" })
                childSessionID = child.id
                yield* prompt.prompt({
                  sessionID: child.id,
                  agent: "build",
                  parts: [{ type: "text", text: "load the child skill" }],
                })
              }),
            ),
        })

        const events = (await Bun.file(marker).text())
          .trim()
          .split("\n")
          .map(
            (line) =>
              JSON.parse(line) as {
                phase: "before" | "after"
                tool: string
                sessionID: string
                visibleUserMessageID?: string
              },
          )
        const rootEvents = events.filter((event) => event.sessionID === rootSessionID && event.tool === "skill")
        expect(rootEvents.map(({ phase }) => phase)).toEqual(["before", "after"])
        expect(rootEvents.map(({ visibleUserMessageID }) => visibleUserMessageID)).toEqual([
          rootVisibleUserMessageID,
          rootVisibleUserMessageID,
        ])

        const childEvents = events.filter((event) => event.sessionID === childSessionID && event.tool === "skill")
        expect(childEvents.map(({ phase }) => phase)).toEqual(["before", "after"])
        expect(childEvents.every((event) => !("visibleUserMessageID" in event))).toBe(true)
      } finally {
        await stub.stop()
      }
    },
    { timeout: 30_000 },
  )

  test(
    "session.preStop does not override session.userQuery.pre cancellation",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const stub = startScriptedLLMServer([{ lines: textStopResponse("must not run") }])
      const marker = path.join(tmp.path, "cancelled-prestop.json")
      try {
        const plugin = await writePlugin(
          tmp.path,
          "cancelled-prestop-plugin.ts",
          [
            "import * as fs from 'fs/promises'",
            `const marker = ${JSON.stringify(marker)}`,
            "let completionChecks = 0",
            "export default async () => ({",
            '  "session.userQuery.pre": async (_input, output) => {',
            "    output.cancel = true",
            '    output.cancelReason = "query policy rejected this turn"',
            "  },",
            '  "session.preStop": async (_input, output) => {',
            "    completionChecks++",
            '    output.status = "continue"',
            '    output.stateDigest = "incomplete"',
            "  },",
            '  "session.post": async (input) => {',
            "    await fs.writeFile(marker, JSON.stringify({ completionChecks, outcome: input.outcome }))",
            "  },",
            "})",
            "",
          ].join("\n"),
        )
        await configureProject({ directory: tmp.path, origin: stub.origin, plugins: [plugin] })

        await Instance.provide({
          directory: tmp.path,
          fn: () =>
            run(
              Effect.gen(function* () {
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                const session = yield* sessions.create({ title: "cancelled-prestop" })
                yield* prompt.prompt({
                  sessionID: session.id,
                  agent: "build",
                  parts: [{ type: "text", text: "request rejected by policy" }],
                })
              }),
            ),
        })

        expect(stub.captures).toHaveLength(0)
        expect(JSON.parse(await Bun.file(marker).text())).toEqual({ completionChecks: 0, outcome: "cancelled" })
      } finally {
        await stub.stop()
      }
    },
    { timeout: 30_000 },
  )

  test(
    "session.preStop does not re-enter after a content-filter terminal",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const stub = startScriptedLLMServer([{ lines: contentFilterResponse() }])
      const marker = path.join(tmp.path, "filtered-prestop.json")
      try {
        const plugin = await writePlugin(
          tmp.path,
          "filtered-prestop-plugin.ts",
          [
            "import * as fs from 'fs/promises'",
            `const marker = ${JSON.stringify(marker)}`,
            "let completionChecks = 0",
            "export default async () => ({",
            '  "session.preStop": async (_input, output) => {',
            "    completionChecks++",
            '    output.status = "continue"',
            '    output.stateDigest = "incomplete"',
            "  },",
            '  "session.post": async (input) => {',
            "    await fs.writeFile(marker, JSON.stringify({ completionChecks, outcome: input.outcome }))",
            "  },",
            "})",
            "",
          ].join("\n"),
        )
        await configureProject({ directory: tmp.path, origin: stub.origin, plugins: [plugin] })

        await Instance.provide({
          directory: tmp.path,
          fn: () =>
            run(
              Effect.gen(function* () {
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                const session = yield* sessions.create({ title: "filtered-prestop" })
                yield* prompt.prompt({
                  sessionID: session.id,
                  agent: "build",
                  parts: [{ type: "text", text: "provider filters this request" }],
                })
              }),
            ),
        })

        expect(stub.captures).toHaveLength(1)
        expect(JSON.parse(await Bun.file(marker).text())).toEqual({ completionChecks: 0, outcome: "error" })
      } finally {
        await stub.stop()
      }
    },
    { timeout: 30_000 },
  )

  test(
    "session.preStop aggregates providers and injects continue reason plus argv nextAction",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const stub = startScriptedLLMServer([
        { lines: textStopResponse("premature") },
        { lines: textStopResponse("completed after deterministic check") },
      ])
      try {
        const allow = await writePlugin(
          tmp.path,
          "allow-plugin.ts",
          [
            "export default async () => ({",
            '  "session.preStop": async (_input, output) => { output.status = "allow" },',
            "})",
            "",
          ].join("\n"),
        )
        const completion = await writePlugin(
          tmp.path,
          "completion-plugin.ts",
          [
            "let checks = 0",
            "export default async () => ({",
            '  "session.preStop": async (input, output) => {',
            "    checks++",
            '    if (input.agentID !== "main") { output.status = "continue"; output.stateDigest = `bad-agent-${checks}`; output.reason = "expected main"; return }',
            `    if (input.cwd !== ${JSON.stringify(tmp.path)}) { output.status = "continue"; output.stateDigest = \`bad-cwd-\${checks}\`; output.reason = \`unexpected cwd: \${input.cwd}\`; return }`,
            `    if (input.root !== ${JSON.stringify(tmp.path)}) { output.status = "continue"; output.stateDigest = \`bad-root-\${checks}\`; output.reason = \`unexpected root: \${input.root}\`; return }`,
            '    if (input.lastUserMessage !== "finish the edit") { output.status = "continue"; output.stateDigest = `bad-user-${checks}`; output.reason = `unexpected user message: ${input.lastUserMessage}`; return }',
            '    if (checks > 1) { output.status = "allow"; return }',
            '    output.status = "continue"',
            '    output.taskId = "video-edit"',
            '    output.stateDigest = "revision-1"',
            '    output.reason = "final export is missing"',
            '    output.nextAction = { description: "Render and verify the final export", command: ["mimo-cut", "deliver", "--json"] }',
            "  },",
            "})",
            "",
          ].join("\n"),
        )
        await configureProject({ directory: tmp.path, origin: stub.origin, plugins: [allow, completion] })

        await Instance.provide({
          directory: tmp.path,
          fn: () =>
            run(
              Effect.gen(function* () {
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                const session = yield* sessions.create({ title: "pre-stop-continue" })
                yield* prompt.prompt({
                  sessionID: session.id,
                  agent: "build",
                  task_id: "caller-task",
                  parts: [{ type: "text", text: "finish the edit" }],
                })
              }),
            ),
        })

        expect(stub.captures.length).toBe(2)
        const reentry = JSON.stringify(stub.captures[1].messages)
        expect(reentry).toContain("final export is missing")
        expect(reentry).toContain("Render and verify the final export")
        expect(reentry).toContain('[\\"mimo-cut\\",\\"deliver\\",\\"--json\\"]')
      } finally {
        await stub.stop()
      }
    },
    { timeout: 30_000 },
  )

  test(
    "session.preStop observes a successfully loaded skill in the current visible user turn",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const stub = startScriptedLLMServer([
        {
          lines: toolCallResponse({
            id: "call-load-mimo-cut",
            name: "skill",
            args: JSON.stringify({ name: "mimo-cut" }),
          }),
        },
        { lines: textStopResponse("finished after loading the skill") },
      ])
      const marker = path.join(tmp.path, "loaded-skills.json")
      try {
        await writeSkill(tmp.path, "mimo-cut")
        const plugin = await writePlugin(
          tmp.path,
          "loaded-skills-plugin.ts",
          [
            "import * as fs from 'fs/promises'",
            `const marker = ${JSON.stringify(marker)}`,
            "export default async () => ({",
            '  "session.preStop": async (input, output) => {',
            "    await fs.writeFile(marker, JSON.stringify(input.loadedSkills ?? null))",
            '    output.status = "allow"',
            "  },",
            "})",
            "",
          ].join("\n"),
        )
        await configureProject({ directory: tmp.path, origin: stub.origin, plugins: [plugin] })

        await Instance.provide({
          directory: tmp.path,
          fn: () =>
            run(
              Effect.gen(function* () {
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                const session = yield* sessions.create({ title: "current-turn-loaded-skill" })
                yield* prompt.prompt({
                  sessionID: session.id,
                  agent: "build",
                  parts: [{ type: "text", text: "Use the video editing skill" }],
                })
              }),
            ),
        })

        expect(stub.captures.length).toBe(2)
        expect(JSON.parse(await Bun.file(marker).text())).toEqual(["mimo-cut"])
      } finally {
        await stub.stop()
      }
    },
    { timeout: 30_000 },
  )

  test(
    "session.preStop skill observations ignore old turns and failures while preferring canonical metadata names",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const stub = startScriptedLLMServer([{ lines: textStopResponse("must not run") }])
      const marker = path.join(tmp.path, "filtered-loaded-skills.json")
      try {
        const plugin = await writePlugin(
          tmp.path,
          "filtered-loaded-skills-plugin.ts",
          [
            "import * as fs from 'fs/promises'",
            `const marker = ${JSON.stringify(marker)}`,
            "export default async () => ({",
            '  "session.preStop": async (input, output) => {',
            "    await fs.writeFile(marker, JSON.stringify(input.loadedSkills ?? null))",
            '    output.status = "allow"',
            "  },",
            "})",
            "",
          ].join("\n"),
        )
        await configureProject({ directory: tmp.path, origin: stub.origin, plugins: [plugin] })

        await Instance.provide({
          directory: tmp.path,
          fn: () =>
            run(
              Effect.gen(function* () {
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                const session = yield* sessions.create({ title: "filtered-loaded-skills" })

                const oldUser = yield* sessions.updateMessage({
                  id: MessageID.ascending(),
                  role: "user" as const,
                  sessionID: session.id,
                  agentID: "main",
                  agent: "build",
                  model: { providerID: ProviderID.make("alibaba"), modelID: ModelID.make("qwen-plus") },
                  time: { created: Date.now() - 4 },
                })
                yield* sessions.updatePart({
                  id: PartID.ascending(),
                  messageID: oldUser.id,
                  sessionID: session.id,
                  type: "text",
                  text: "old visible turn",
                })
                const oldAssistant = yield* sessions.updateMessage({
                  id: MessageID.ascending(),
                  role: "assistant" as const,
                  sessionID: session.id,
                  parentID: oldUser.id,
                  agentID: "main",
                  agent: "build",
                  mode: "build",
                  path: { cwd: tmp.path, root: tmp.path },
                  cost: 0,
                  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                  modelID: ModelID.make("qwen-plus"),
                  providerID: ProviderID.make("alibaba"),
                  finish: "stop",
                  time: { created: Date.now() - 3, completed: Date.now() - 3 },
                } satisfies MessageV2.Assistant)
                yield* sessions.updatePart({
                  id: PartID.ascending(),
                  messageID: oldAssistant.id,
                  sessionID: session.id,
                  type: "tool",
                  callID: "old-skill",
                  tool: "skill",
                  state: {
                    status: "completed",
                    input: { name: "old-skill" },
                    output: "old",
                    title: "Loaded old skill",
                    metadata: { name: "old-skill" },
                    time: { start: Date.now() - 3, end: Date.now() - 3 },
                  },
                })

                const currentUser = yield* sessions.updateMessage({
                  id: MessageID.ascending(),
                  role: "user" as const,
                  sessionID: session.id,
                  agentID: "main",
                  agent: "build",
                  model: { providerID: ProviderID.make("alibaba"), modelID: ModelID.make("qwen-plus") },
                  time: { created: Date.now() - 2 },
                })
                yield* sessions.updatePart({
                  id: PartID.ascending(),
                  messageID: currentUser.id,
                  sessionID: session.id,
                  type: "text",
                  text: "current visible turn",
                })
                const workerAssistant = yield* sessions.updateMessage({
                  id: MessageID.ascending(),
                  role: "assistant" as const,
                  sessionID: session.id,
                  parentID: currentUser.id,
                  agentID: "worker-1",
                  agent: "build",
                  mode: "build",
                  path: { cwd: tmp.path, root: tmp.path },
                  cost: 0,
                  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                  modelID: ModelID.make("qwen-plus"),
                  providerID: ProviderID.make("alibaba"),
                  finish: "stop",
                  time: { created: Date.now() - 1, completed: Date.now() - 1 },
                } satisfies MessageV2.Assistant)
                yield* sessions.updatePart({
                  id: PartID.ascending(),
                  messageID: workerAssistant.id,
                  sessionID: session.id,
                  type: "tool",
                  callID: "worker-skill",
                  tool: "skill",
                  state: {
                    status: "completed",
                    input: { name: "worker-skill" },
                    output: "worker loaded",
                    title: "Loaded worker skill",
                    metadata: { name: "worker-skill" },
                    time: { start: Date.now() - 1, end: Date.now() - 1 },
                  },
                })
                const currentAssistant = yield* sessions.updateMessage({
                  id: MessageID.ascending(),
                  role: "assistant" as const,
                  sessionID: session.id,
                  parentID: currentUser.id,
                  agentID: "main",
                  agent: "build",
                  mode: "build",
                  path: { cwd: tmp.path, root: tmp.path },
                  cost: 0,
                  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                  modelID: ModelID.make("qwen-plus"),
                  providerID: ProviderID.make("alibaba"),
                  finish: "stop",
                  time: { created: Date.now() - 1, completed: Date.now() },
                } satisfies MessageV2.Assistant)
                const completedSkill = (input: {
                  callID: string
                  inputName: string
                  metadataName?: string
                }): MessageV2.ToolPart => ({
                  id: PartID.ascending(),
                  messageID: currentAssistant.id,
                  sessionID: session.id,
                  type: "tool",
                  callID: input.callID,
                  tool: "skill",
                  state: {
                    status: "completed",
                    input: { name: input.inputName },
                    output: "loaded",
                    title: "Loaded skill",
                    metadata: input.metadataName ? { name: input.metadataName } : {},
                    time: { start: Date.now(), end: Date.now() },
                  },
                })
                yield* sessions.updatePart(
                  completedSkill({ callID: "canonical", inputName: "requested-alias", metadataName: "mimo-cut" }),
                )
                yield* sessions.updatePart(completedSkill({ callID: "input-fallback", inputName: "input-fallback" }))
                yield* sessions.updatePart(
                  completedSkill({ callID: "duplicate", inputName: "mimo-cut", metadataName: "mimo-cut" }),
                )
                yield* sessions.updatePart({
                  id: PartID.ascending(),
                  messageID: currentAssistant.id,
                  sessionID: session.id,
                  type: "tool",
                  callID: "failed",
                  tool: "skill",
                  state: {
                    status: "error",
                    input: { name: "failed-skill" },
                    error: "not found",
                    time: { start: Date.now(), end: Date.now() },
                  },
                })
                yield* sessions.updatePart({
                  ...completedSkill({ callID: "not-a-skill", inputName: "other-tool" }),
                  tool: "read",
                })

                yield* prompt.loop({ sessionID: session.id, agentID: "main" })
              }),
            ),
        })

        expect(stub.captures.length).toBe(1)
        expect(JSON.parse(await Bun.file(marker).text())).toEqual(["mimo-cut", "input-fallback"])
      } finally {
        await stub.stop()
      }
    },
    { timeout: 30_000 },
  )

  test(
    "session.preStop bounds current-turn loaded skill observations to 64 unique names",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const stub = startScriptedLLMServer([{ lines: textStopResponse("must not run") }])
      const marker = path.join(tmp.path, "bounded-loaded-skills.json")
      try {
        const plugin = await writePlugin(
          tmp.path,
          "bounded-loaded-skills-plugin.ts",
          [
            "import * as fs from 'fs/promises'",
            `const marker = ${JSON.stringify(marker)}`,
            "export default async () => ({",
            '  "session.preStop": async (input, output) => {',
            "    await fs.writeFile(marker, JSON.stringify(input.loadedSkills ?? null))",
            '    output.status = "allow"',
            "  },",
            "})",
            "",
          ].join("\n"),
        )
        await configureProject({ directory: tmp.path, origin: stub.origin, plugins: [plugin] })

        await Instance.provide({
          directory: tmp.path,
          fn: () =>
            run(
              Effect.gen(function* () {
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                const session = yield* sessions.create({ title: "bounded-loaded-skills" })
                const user = yield* sessions.updateMessage({
                  id: MessageID.ascending(),
                  role: "user" as const,
                  sessionID: session.id,
                  agentID: "main",
                  agent: "build",
                  model: { providerID: ProviderID.make("alibaba"), modelID: ModelID.make("qwen-plus") },
                  time: { created: Date.now() - 1 },
                })
                yield* sessions.updatePart({
                  id: PartID.ascending(),
                  messageID: user.id,
                  sessionID: session.id,
                  type: "text",
                  text: "load many skills",
                })
                const assistant = yield* sessions.updateMessage({
                  id: MessageID.ascending(),
                  role: "assistant" as const,
                  sessionID: session.id,
                  parentID: user.id,
                  agentID: "main",
                  agent: "build",
                  mode: "build",
                  path: { cwd: tmp.path, root: tmp.path },
                  cost: 0,
                  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                  modelID: ModelID.make("qwen-plus"),
                  providerID: ProviderID.make("alibaba"),
                  finish: "stop",
                  time: { created: Date.now(), completed: Date.now() },
                } satisfies MessageV2.Assistant)
                for (let index = 0; index < 70; index++) {
                  if (index > 0) {
                    yield* sessions.updatePart({
                      id: PartID.ascending(),
                      messageID: assistant.id,
                      sessionID: session.id,
                      type: "tool",
                      callID: `duplicate-skill-${index}`,
                      tool: "skill",
                      state: {
                        status: "completed",
                        input: { name: `skill-${index - 1}` },
                        output: "loaded",
                        title: "Loaded duplicate skill",
                        metadata: { name: `skill-${index - 1}` },
                        time: { start: Date.now(), end: Date.now() },
                      },
                    })
                  }
                  yield* sessions.updatePart({
                    id: PartID.ascending(),
                    messageID: assistant.id,
                    sessionID: session.id,
                    type: "tool",
                    callID: `skill-${index}`,
                    tool: "skill",
                    state: {
                      status: "completed",
                      input: { name: `skill-${index}` },
                      output: "loaded",
                      title: "Loaded skill",
                      metadata: { name: `skill-${index}` },
                      time: { start: Date.now(), end: Date.now() },
                    },
                  })
                }
                yield* prompt.loop({ sessionID: session.id, agentID: "main" })
              }),
            ),
        })

        expect(stub.captures.length).toBe(1)
        const observed = JSON.parse(await Bun.file(marker).text()) as string[]
        expect(observed).toHaveLength(64)
        expect(observed[0]).toBe("skill-0")
        expect(observed[63]).toBe("skill-63")
      } finally {
        await stub.stop()
      }
    },
    { timeout: 30_000 },
  )

  test(
    "session.preStop uses an attachment-only user message as the current-turn boundary",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const stub = startScriptedLLMServer([{ lines: textStopResponse("tool observation consumed") }])
      const marker = path.join(tmp.path, "attachment-turn.json")
      try {
        const plugin = await writePlugin(
          tmp.path,
          "attachment-turn-plugin.ts",
          [
            "import * as fs from 'fs/promises'",
            `const marker = ${JSON.stringify(marker)}`,
            "export default async () => ({",
            '  "session.preStop": async (input, output) => {',
            "    await fs.writeFile(marker, JSON.stringify({ loadedSkills: input.loadedSkills, lastUserMessage: input.lastUserMessage ?? null, visibleUserMessageID: input.visibleUserMessageID ?? null }))",
            '    output.status = "allow"',
            "  },",
            "})",
            "",
          ].join("\n"),
        )
        await configureProject({ directory: tmp.path, origin: stub.origin, plugins: [plugin] })

        let currentUserID = ""
        await Instance.provide({
          directory: tmp.path,
          fn: () =>
            run(
              Effect.gen(function* () {
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                const session = yield* sessions.create({ title: "attachment-turn" })
                const oldUser = yield* sessions.updateMessage({
                  id: MessageID.ascending(),
                  role: "user" as const,
                  sessionID: session.id,
                  agentID: "main",
                  agent: "build",
                  model: { providerID: ProviderID.make("alibaba"), modelID: ModelID.make("qwen-plus") },
                  time: { created: Date.now() - 4 },
                })
                yield* sessions.updatePart({
                  id: PartID.ascending(),
                  messageID: oldUser.id,
                  sessionID: session.id,
                  type: "text",
                  text: "old text request",
                })
                const oldAssistant = yield* sessions.updateMessage({
                  id: MessageID.ascending(),
                  role: "assistant" as const,
                  sessionID: session.id,
                  parentID: oldUser.id,
                  agentID: "main",
                  agent: "build",
                  mode: "build",
                  path: { cwd: tmp.path, root: tmp.path },
                  cost: 0,
                  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                  modelID: ModelID.make("qwen-plus"),
                  providerID: ProviderID.make("alibaba"),
                  finish: "stop",
                  time: { created: Date.now() - 3, completed: Date.now() - 3 },
                } satisfies MessageV2.Assistant)
                yield* sessions.updatePart({
                  id: PartID.ascending(),
                  messageID: oldAssistant.id,
                  sessionID: session.id,
                  type: "tool",
                  callID: "old-skill",
                  tool: "skill",
                  state: {
                    status: "completed",
                    input: { name: "old-skill" },
                    output: "loaded",
                    title: "Loaded old skill",
                    metadata: { name: "old-skill" },
                    time: { start: Date.now() - 3, end: Date.now() - 3 },
                  },
                })
                const currentUser = yield* sessions.updateMessage({
                  id: MessageID.ascending(),
                  role: "user" as const,
                  sessionID: session.id,
                  agentID: "main",
                  agent: "build",
                  model: { providerID: ProviderID.make("alibaba"), modelID: ModelID.make("qwen-plus") },
                  time: { created: Date.now() - 2 },
                })
                currentUserID = currentUser.id
                yield* sessions.updatePart({
                  id: PartID.ascending(),
                  messageID: currentUser.id,
                  sessionID: session.id,
                  type: "file",
                  mime: "image/png",
                  filename: "frame.png",
                  url: "data:image/png;base64,iVBORw0KGgo=",
                })
                const currentAssistant = yield* sessions.updateMessage({
                  id: MessageID.ascending(),
                  role: "assistant" as const,
                  sessionID: session.id,
                  parentID: currentUser.id,
                  agentID: "main",
                  agent: "build",
                  mode: "build",
                  path: { cwd: tmp.path, root: tmp.path },
                  cost: 0,
                  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                  modelID: ModelID.make("qwen-plus"),
                  providerID: ProviderID.make("alibaba"),
                  finish: "stop",
                  time: { created: Date.now() - 1, completed: Date.now() },
                } satisfies MessageV2.Assistant)
                yield* sessions.updatePart({
                  id: PartID.ascending(),
                  messageID: currentAssistant.id,
                  sessionID: session.id,
                  type: "tool",
                  callID: "current-skill",
                  tool: "skill",
                  state: {
                    status: "completed",
                    input: { name: "current-skill" },
                    output: "loaded",
                    title: "Loaded current skill",
                    metadata: { name: "current-skill" },
                    time: { start: Date.now() - 1, end: Date.now() - 1 },
                  },
                })
                yield* prompt.loop({ sessionID: session.id, agentID: "main" })
              }),
            ),
        })

        expect(JSON.parse(await Bun.file(marker).text())).toEqual({
          loadedSkills: ["current-skill"],
          lastUserMessage: null,
          visibleUserMessageID: currentUserID,
        })
      } finally {
        await stub.stop()
      }
    },
    { timeout: 30_000 },
  )

  test(
    "session.preStop recovers the visible request and skill loads across a checkpoint boundary",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const stub = startScriptedLLMServer([{ lines: textStopResponse("must not run") }])
      const marker = path.join(tmp.path, "checkpoint-turn.json")
      try {
        const plugin = await writePlugin(
          tmp.path,
          "checkpoint-turn-plugin.ts",
          [
            "import * as fs from 'fs/promises'",
            `const marker = ${JSON.stringify(marker)}`,
            "export default async () => ({",
            '  "session.preStop": async (input, output) => {',
            "    await fs.writeFile(marker, JSON.stringify({ visibleUserMessageID: input.visibleUserMessageID ?? null, lastUserMessage: input.lastUserMessage ?? null, loadedSkills: input.loadedSkills }))",
            '    output.status = "allow"',
            "  },",
            "})",
            "",
          ].join("\n"),
        )
        await configureProject({ directory: tmp.path, origin: stub.origin, plugins: [plugin] })

        let visibleUserMessageID = ""
        await Instance.provide({
          directory: tmp.path,
          fn: () =>
            run(
              Effect.gen(function* () {
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                const session = yield* sessions.create({ title: "checkpoint-turn" })
                const visibleUser = yield* sessions.updateMessage({
                  id: MessageID.ascending(),
                  role: "user" as const,
                  sessionID: session.id,
                  agentID: "main",
                  agent: "build",
                  model: { providerID: ProviderID.make("alibaba"), modelID: ModelID.make("qwen-plus") },
                  time: { created: Date.now() - 4 },
                })
                visibleUserMessageID = visibleUser.id
                yield* sessions.updatePart({
                  id: PartID.ascending(),
                  messageID: visibleUser.id,
                  sessionID: session.id,
                  type: "text",
                  text: "finish the latest video revision",
                })
                const skillAssistant = yield* sessions.updateMessage({
                  id: MessageID.ascending(),
                  role: "assistant" as const,
                  sessionID: session.id,
                  parentID: visibleUser.id,
                  agentID: "main",
                  agent: "build",
                  mode: "build",
                  path: { cwd: tmp.path, root: tmp.path },
                  cost: 0,
                  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                  modelID: ModelID.make("qwen-plus"),
                  providerID: ProviderID.make("alibaba"),
                  finish: "stop",
                  time: { created: Date.now() - 3, completed: Date.now() - 3 },
                } satisfies MessageV2.Assistant)
                yield* sessions.updatePart({
                  id: PartID.ascending(),
                  messageID: skillAssistant.id,
                  sessionID: session.id,
                  type: "tool",
                  callID: "checkpoint-skill",
                  tool: "skill",
                  state: {
                    status: "completed",
                    input: { name: "requested-alias" },
                    output: "loaded",
                    title: "Loaded skill",
                    metadata: { name: "mimo-cut" },
                    time: { start: Date.now() - 3, end: Date.now() - 3 },
                  },
                })
                const checkpoint = yield* sessions.updateMessage({
                  id: MessageID.ascending(),
                  role: "user" as const,
                  sessionID: session.id,
                  agentID: "main",
                  agent: "build",
                  model: { providerID: ProviderID.make("alibaba"), modelID: ModelID.make("qwen-plus") },
                  time: { created: Date.now() - 2 },
                })
                yield* sessions.updatePart({
                  id: PartID.ascending(),
                  messageID: checkpoint.id,
                  sessionID: session.id,
                  type: "checkpoint",
                  checkpointDir: "",
                  checkpointNumber: 0,
                  coveredUpTo: skillAssistant.id,
                })
                yield* sessions.updatePart({
                  id: PartID.ascending(),
                  messageID: checkpoint.id,
                  sessionID: session.id,
                  type: "text",
                  synthetic: true,
                  text: "rebuilt context",
                })
                const finalAssistant = yield* sessions.updateMessage({
                  id: MessageID.ascending(),
                  role: "assistant" as const,
                  sessionID: session.id,
                  parentID: checkpoint.id,
                  agentID: "main",
                  agent: "build",
                  mode: "build",
                  path: { cwd: tmp.path, root: tmp.path },
                  cost: 0,
                  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                  modelID: ModelID.make("qwen-plus"),
                  providerID: ProviderID.make("alibaba"),
                  finish: "stop",
                  time: { created: Date.now() - 1, completed: Date.now() },
                } satisfies MessageV2.Assistant)
                yield* sessions.updatePart({
                  id: PartID.ascending(),
                  messageID: finalAssistant.id,
                  sessionID: session.id,
                  type: "text",
                  text: "finished after rebuilding context",
                })

                yield* prompt.loop({ sessionID: session.id, agentID: "main" })
              }),
            ),
        })

        expect(stub.captures).toHaveLength(0)
        expect(JSON.parse(await Bun.file(marker).text())).toEqual({
          visibleUserMessageID,
          lastUserMessage: "finish the latest video revision",
          loadedSkills: ["mimo-cut"],
        })
      } finally {
        await stub.stop()
      }
    },
    { timeout: 30_000 },
  )

  test(
    "session.preStop gives each concurrent provider an isolated loadedSkills snapshot",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const stub = startScriptedLLMServer([
        {
          lines: toolCallResponse({
            id: "call-isolated-skill",
            name: "skill",
            args: JSON.stringify({ name: "mimo-cut" }),
          }),
        },
        { lines: textStopResponse("done") },
      ])
      const marker = path.join(tmp.path, "isolated-provider-input.json")
      try {
        await writeSkill(tmp.path, "mimo-cut")
        const mutator = await writePlugin(
          tmp.path,
          "mutating-provider.ts",
          [
            "export default async () => ({",
            '  "session.preStop": async (input, output) => {',
            "    try { input.loadedSkills.splice(0) } catch {}",
            '    output.status = "allow"',
            "  },",
            "})",
            "",
          ].join("\n"),
        )
        const observer = await writePlugin(
          tmp.path,
          "observing-provider.ts",
          [
            "import * as fs from 'fs/promises'",
            `const marker = ${JSON.stringify(marker)}`,
            "export default async () => ({",
            '  "session.preStop": async (input, output) => {',
            "    await new Promise((resolve) => setTimeout(resolve, 20))",
            "    await fs.writeFile(marker, JSON.stringify(input.loadedSkills))",
            '    output.status = "allow"',
            "  },",
            "})",
            "",
          ].join("\n"),
        )
        await configureProject({ directory: tmp.path, origin: stub.origin, plugins: [mutator, observer] })

        await Instance.provide({
          directory: tmp.path,
          fn: () =>
            run(
              Effect.gen(function* () {
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                const session = yield* sessions.create({ title: "isolated-provider-input" })
                yield* prompt.prompt({
                  sessionID: session.id,
                  agent: "build",
                  parts: [{ type: "text", text: "load the skill" }],
                })
              }),
            ),
        })

        expect(JSON.parse(await Bun.file(marker).text())).toEqual(["mimo-cut"])
      } finally {
        await stub.stop()
      }
    },
    { timeout: 30_000 },
  )

  test(
    "session.preStop runs before the existing-assistant stop exit",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const stub = startScriptedLLMServer([{ lines: textStopResponse("continued from existing assistant") }])
      try {
        const plugin = await writePlugin(
          tmp.path,
          "existing-assistant-plugin.ts",
          [
            "let checks = 0",
            "export default async () => ({",
            '  "session.preStop": async (_input, output) => {',
            "    checks++",
            '    output.status = checks === 1 ? "continue" : "allow"',
            '    output.taskId = "existing-assistant"',
            "    output.stateDigest = `state-${checks}`",
            '    output.reason = "existing assistant still needs verification"',
            "  },",
            "})",
            "",
          ].join("\n"),
        )
        await configureProject({ directory: tmp.path, origin: stub.origin, plugins: [plugin] })

        await Instance.provide({
          directory: tmp.path,
          fn: () =>
            run(
              Effect.gen(function* () {
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                const session = yield* sessions.create({ title: "existing-assistant" })
                const user = yield* sessions.updateMessage({
                  id: MessageID.ascending(),
                  role: "user" as const,
                  sessionID: session.id,
                  agentID: "main",
                  agent: "build",
                  model: { providerID: ProviderID.make("alibaba"), modelID: ModelID.make("qwen-plus") },
                  time: { created: Date.now() - 2 },
                })
                const assistant = yield* sessions.updateMessage({
                  id: MessageID.ascending(),
                  role: "assistant" as const,
                  sessionID: session.id,
                  parentID: user.id,
                  agentID: "main",
                  agent: "build",
                  mode: "build",
                  path: { cwd: tmp.path, root: tmp.path },
                  cost: 0,
                  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                  modelID: ModelID.make("qwen-plus"),
                  providerID: ProviderID.make("alibaba"),
                  finish: "stop",
                  time: { created: Date.now() - 1, completed: Date.now() },
                } satisfies MessageV2.Assistant)
                yield* sessions.updatePart({
                  id: PartID.ascending(),
                  messageID: assistant.id,
                  sessionID: session.id,
                  type: "text",
                  text: "seeded terminal response",
                })
                yield* prompt.loop({ sessionID: session.id, agentID: "main" })
              }),
            ),
        })

        expect(stub.captures.length).toBe(1)
        expect(JSON.stringify(stub.captures[0].messages)).toContain("existing assistant still needs verification")
      } finally {
        await stub.stop()
      }
    },
    { timeout: 30_000 },
  )

  test(
    "session.preStop continuation does not reuse a previous structured output",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const readPath = path.join(tmp.path, "verification.txt")
      await Bun.write(readPath, "verified")
      const stub = startScriptedLLMServer([
        {
          lines: toolCallResponse({
            id: "call-structured-before-gate",
            name: "StructuredOutput",
            args: JSON.stringify({ answer: 1 }),
          }),
        },
        {
          lines: toolCallResponse({
            id: "call-read-after-gate",
            name: "read",
            args: JSON.stringify({ filePath: readPath }),
          }),
        },
        {
          lines: toolCallResponse({
            id: "call-structured-after-gate",
            name: "StructuredOutput",
            args: JSON.stringify({ answer: 2 }),
          }),
        },
      ])
      try {
        const plugin = await writePlugin(
          tmp.path,
          "structured-continuation-plugin.ts",
          [
            "let checks = 0",
            "export default async () => ({",
            '  "session.preStop": async (_input, output) => {',
            "    checks++",
            '    output.status = checks === 1 ? "continue" : "allow"',
            '    output.taskId = "structured-repair"',
            "    output.stateDigest = `check-${checks}`",
            '    output.reason = "verify before returning structured output"',
            "  },",
            "})",
            "",
          ].join("\n"),
        )
        await configureProject({ directory: tmp.path, origin: stub.origin, plugins: [plugin] })

        const result = await Instance.provide({
          directory: tmp.path,
          fn: () =>
            run(
              Effect.gen(function* () {
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                const session = yield* sessions.create({ title: "structured-prestop-continuation" })
                return yield* prompt.prompt({
                  sessionID: session.id,
                  agent: "build",
                  parts: [{ type: "text", text: "Return a verified answer" }],
                  format: {
                    type: "json_schema",
                    retryCount: 2,
                    schema: {
                      type: "object",
                      properties: { answer: { type: "number" } },
                      required: ["answer"],
                    },
                  },
                })
              }),
            ),
        })

        expect(stub.captures.length).toBe(3)
        expect(result.info.role).toBe("assistant")
        if (result.info.role === "assistant") expect(result.info.structured).toEqual({ answer: 2 })
      } finally {
        await stub.stop()
      }
    },
    { timeout: 30_000 },
  )

  test(
    "session.preStop ignores loaded skills from child sessions and non-main slices",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const stub = startScriptedLLMServer([
        {
          lines: toolCallResponse({
            id: "call-child-skill",
            name: "skill",
            args: JSON.stringify({ name: "mimo-cut" }),
          }),
        },
        { lines: textStopResponse("child answer") },
        {
          lines: toolCallResponse({
            id: "call-worker-skill",
            name: "skill",
            args: JSON.stringify({ name: "mimo-cut" }),
          }),
        },
        { lines: textStopResponse("non-main answer") },
        { lines: textStopResponse("root answer") },
      ])
      const marker = path.join(tmp.path, "root-loaded-skills.jsonl")
      try {
        await writeSkill(tmp.path, "mimo-cut")
        const plugin = await writePlugin(
          tmp.path,
          "root-only-plugin.ts",
          [
            "import * as fs from 'fs/promises'",
            `const marker = ${JSON.stringify(marker)}`,
            "export default async () => ({",
            '  "session.preStop": async (input, output) => {',
            "    await fs.appendFile(marker, `${JSON.stringify(input.loadedSkills ?? null)}\\n`)",
            '    output.status = "allow"',
            "  },",
            "})",
            "",
          ].join("\n"),
        )
        await configureProject({ directory: tmp.path, origin: stub.origin, plugins: [plugin] })

        await Instance.provide({
          directory: tmp.path,
          fn: () =>
            run(
              Effect.gen(function* () {
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                const root = yield* sessions.create({ title: "root" })
                const child = yield* sessions.create({ parentID: root.id, title: "child" })
                yield* prompt.prompt({
                  sessionID: child.id,
                  agent: "build",
                  parts: [{ type: "text", text: "child work" }],
                })
                yield* prompt.prompt({
                  sessionID: root.id,
                  agentID: "worker-1",
                  agent: "build",
                  parts: [{ type: "text", text: "non-main work" }],
                })
                yield* prompt.prompt({
                  sessionID: root.id,
                  agent: "build",
                  parts: [{ type: "text", text: "root work" }],
                })
              }),
            ),
        })

        expect(stub.captures.length).toBe(5)
        const observations = (await Bun.file(marker).text())
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
        expect(observations).toEqual([[]])
      } finally {
        await stub.stop()
      }
    },
    { timeout: 30_000 },
  )

  test(
    "session.preStop fails closed for throwing and timed-out providers",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const stub = startScriptedLLMServer([{ lines: textStopResponse("done despite broken providers") }])
      const abortedMarker = path.join(tmp.path, "timed-out-provider-aborted")
      try {
        const throwing = await writePlugin(
          tmp.path,
          "throwing-plugin.ts",
          [
            "export default async () => ({",
            '  "session.preStop": async () => { throw new Error("provider exploded") },',
            "})",
            "",
          ].join("\n"),
        )
        const hanging = await writePlugin(
          tmp.path,
          "hanging-plugin.ts",
          [
            "export default async () => ({",
            '  "session.preStop": async () => { await new Promise(() => {}) },',
            "})",
            "",
          ].join("\n"),
        )
        const lateRejecting = await writePlugin(
          tmp.path,
          "late-rejecting-plugin.ts",
          [
            "export default async () => ({",
            '  "session.preStop": async () => { await new Promise((resolve) => setTimeout(resolve, 3200)); throw new Error("late rejection") },',
            "})",
            "",
          ].join("\n"),
        )
        const cooperativelyCancelled = await writePlugin(
          tmp.path,
          "cooperatively-cancelled-plugin.ts",
          [
            "import * as fs from 'fs/promises'",
            `const marker = ${JSON.stringify(abortedMarker)}`,
            "export default async () => ({",
            '  "session.preStop": async (input) => {',
            "    await new Promise((resolve) => input.abortSignal.addEventListener('abort', () => { void fs.writeFile(marker, 'aborted').then(resolve) }, { once: true }))",
            "  },",
            "})",
            "",
          ].join("\n"),
        )
        await configureProject({
          directory: tmp.path,
          origin: stub.origin,
          plugins: [throwing, hanging, lateRejecting, cooperativelyCancelled],
        })

        const startedAt = Date.now()
        const messages = await Instance.provide({
          directory: tmp.path,
          fn: () =>
            run(
              Effect.gen(function* () {
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                const session = yield* sessions.create({ title: "isolated-providers" })
                yield* prompt.prompt({
                  sessionID: session.id,
                  agent: "build",
                  parts: [{ type: "text", text: "finish safely" }],
                })
                return yield* sessions.messages({ sessionID: session.id, agentID: "main" })
              }),
            ),
        })
        // Let the timed-out provider reject after the host has already moved
        // on. Bun fails the test if that rejection is left unhandled.
        await Bun.sleep(500)

        expect(stub.captures.length).toBe(1)
        expect(Date.now() - startedAt).toBeLessThan(6_500)
        expect(await Bun.file(abortedMarker).text()).toBe("aborted")
        const terminal = messages
          .flatMap((message) => message.parts)
          .find((part) => part.type === "text" && part.metadata?.sessionPreStopTerminal)
        expect(terminal?.type).toBe("text")
        if (terminal?.type === "text") {
          expect(terminal.text).toContain("completion cannot be verified")
          expect(terminal.text).toMatch(/prestop:[0-9a-f]{24}/)
          expect(terminal.text).not.toContain(tmp.path)
          expect(terminal.text).not.toContain("throwing-plugin.ts")
          expect(terminal.text).not.toContain("hanging-plugin.ts")
        }
      } finally {
        await stub.stop()
      }
    },
    { timeout: 30_000 },
  )

  test(
    "session.preStop permits an explicitly fail-open advisory provider",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const stub = startScriptedLLMServer([{ lines: textStopResponse("advisory provider did not gate completion") }])
      try {
        const plugin = await writePlugin(
          tmp.path,
          "advisory-plugin.ts",
          [
            "export default async () => ({",
            '  "session.preStop": {',
            '    failureMode: "open",',
            '    run: async () => { throw new Error("advisory failure") },',
            "  },",
            "})",
            "",
          ].join("\n"),
        )
        await configureProject({ directory: tmp.path, origin: stub.origin, plugins: [plugin] })

        const messages = await Instance.provide({
          directory: tmp.path,
          fn: () =>
            run(
              Effect.gen(function* () {
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                const session = yield* sessions.create({ title: "fail-open-provider" })
                yield* prompt.prompt({
                  sessionID: session.id,
                  agent: "build",
                  parts: [{ type: "text", text: "finish despite advisory failure" }],
                })
                return yield* sessions.messages({ sessionID: session.id, agentID: "main" })
              }),
            ),
        })

        expect(stub.captures).toHaveLength(1)
        expect(
          messages
            .flatMap((message) => message.parts)
            .some((part) => part.type === "text" && part.metadata?.sessionPreStopTerminal),
        ).toBe(false)
      } finally {
        await stub.stop()
      }
    },
    { timeout: 30_000 },
  )

  test(
    "session.preStop turns malformed provider output into a visible blocked result",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const stub = startScriptedLLMServer([{ lines: textStopResponse("invalid provider output") }])
      try {
        const plugin = await writePlugin(
          tmp.path,
          "malformed-plugin.ts",
          [
            "export default async () => ({",
            '  "session.preStop": async (_input, output) => { output.status = "not-a-status" },',
            "})",
            "",
          ].join("\n"),
        )
        await configureProject({ directory: tmp.path, origin: stub.origin, plugins: [plugin] })

        const messages = await Instance.provide({
          directory: tmp.path,
          fn: () =>
            run(
              Effect.gen(function* () {
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                const session = yield* sessions.create({ title: "malformed-provider" })
                yield* prompt.prompt({
                  sessionID: session.id,
                  agent: "build",
                  parts: [{ type: "text", text: "validate completion" }],
                })
                return yield* sessions.messages({ sessionID: session.id, agentID: "main" })
              }),
            ),
        })

        expect(stub.captures).toHaveLength(1)
        const terminal = messages
          .flatMap((message) => message.parts)
          .find((part) => part.type === "text" && part.metadata?.sessionPreStopTerminal)
        expect(terminal?.type).toBe("text")
        if (terminal?.type === "text") {
          expect(terminal.text).toContain("completion cannot be verified")
          expect(terminal.text).not.toContain("not-a-status")
          expect(terminal.text).not.toContain("malformed-plugin.ts")
        }
      } finally {
        await stub.stop()
      }
    },
    { timeout: 30_000 },
  )

  test(
    "session.preStop terminal decisions outrank continue and preserve every terminal provider",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const stub = startScriptedLLMServer([
        { lines: textStopResponse("model final remains visible") },
        { lines: textStopResponse("continue must not trigger this request") },
      ])
      const postMarker = path.join(tmp.path, "terminal-post.json")
      try {
        const continuing = await writePlugin(
          tmp.path,
          "continuing-plugin.ts",
          [
            "export default async () => ({",
            '  "session.preStop": async (_input, output) => {',
            '    output.status = "continue"',
            '    output.reason = "continue reason must not win"',
            '    output.nextAction = { description: "keep working" }',
            "  },",
            "})",
            "",
          ].join("\n"),
        )
        const awaiting = await writePlugin(
          tmp.path,
          "awaiting-plugin.ts",
          [
            "export default async () => ({",
            '  "session.preStop": async (_input, output) => {',
            '    output.status = "awaiting_user"',
            '    output.reason = "operator approval is required"',
            "  },",
            "})",
            "",
          ].join("\n"),
        )
        const blocked = await writePlugin(
          tmp.path,
          "blocked-plugin.ts",
          [
            "import * as fs from 'fs/promises'",
            `const marker = ${JSON.stringify(postMarker)}`,
            "export default async () => ({",
            '  "session.preStop": async (_input, output) => {',
            '    output.status = "blocked"',
            '    output.reason = "render manifest is missing"',
            "  },",
            '  "session.post": async (input) => {',
            "    await fs.writeFile(marker, JSON.stringify({",
            "      outcome: input.outcome,",
            "      error: input.error,",
            "      finalText: input.finalText,",
            "      terminalStop: input.terminalStop,",
            "      trajectory: input.trajectory,",
            "    }))",
            "  },",
            "})",
            "",
          ].join("\n"),
        )
        await configureProject({ directory: tmp.path, origin: stub.origin, plugins: [continuing, awaiting, blocked] })

        const messages = await Instance.provide({
          directory: tmp.path,
          fn: () =>
            run(
              Effect.gen(function* () {
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                const session = yield* sessions.create({ title: "terminal-providers" })
                yield* prompt.prompt({
                  sessionID: session.id,
                  agent: "build",
                  parts: [{ type: "text", text: "pause if necessary" }],
                })
                return yield* sessions.messages({ sessionID: session.id, agentID: "main" })
              }),
            ),
        })

        expect(stub.captures.length).toBe(1)
        const post = JSON.parse(await Bun.file(postMarker).text()) as {
          outcome: string
          error?: string
          finalText?: string
          terminalStop?: {
            status: string
            reason: string
            contributingProviderIDs: string[]
            contributingHookIDs: string[]
          }
          trajectory: Array<{
            role: string
            parts: Array<{ type: string; text?: string; metadata?: Record<string, unknown> }>
          }>
        }
        expect(post.outcome).toBe("cancelled")
        expect(post.finalText).toBe("model final remains visible")
        expect(post.error).toContain("operator approval is required")
        expect(post.error).toContain("render manifest is missing")
        expect(post.error).not.toContain("continue reason must not win")
        expect(post.terminalStop?.status).toBe("blocked")
        expect(post.terminalStop?.reason).toContain("operator approval is required")
        expect(post.terminalStop?.reason).toContain("render manifest is missing")
        expect(post.terminalStop?.reason).not.toContain("continue reason must not win")
        expect(post.terminalStop?.contributingProviderIDs).toHaveLength(2)
        expect(post.terminalStop?.contributingProviderIDs.every((id) => /^prestop:[0-9a-f]{24}$/.test(id))).toBe(true)
        expect(new Set(post.terminalStop?.contributingProviderIDs).size).toBe(2)
        expect(post.terminalStop?.contributingHookIDs).toHaveLength(2)
        expect(
          post.terminalStop?.contributingHookIDs.every((id) => /^prestop:[0-9a-f]{24}#session\.preStop$/.test(id)),
        ).toBe(true)

        const assistant = messages.findLast((message) => message.info.role === "assistant")
        expect(assistant?.info.role).toBe("assistant")
        const textParts = assistant?.parts.filter((part) => part.type === "text") ?? []
        expect(textParts.some((part) => part.text === "model final remains visible")).toBe(true)
        const terminalParts = textParts.filter((part) => part.metadata?.sessionPreStopTerminal)
        expect(terminalParts).toHaveLength(1)
        expect(terminalParts[0]?.time?.end).toBeNumber()
        expect(terminalParts[0]?.text).toContain("operator approval is required")
        expect(terminalParts[0]?.text).toContain("render manifest is missing")
        expect(terminalParts[0]?.text).not.toContain("continue reason must not win")
        const trajectoryTerminalParts = post.trajectory
          .flatMap((message) => message.parts)
          .filter((part) => part.metadata?.sessionPreStopTerminal)
        expect(trajectoryTerminalParts).toHaveLength(1)
      } finally {
        await stub.stop()
      }
    },
    { timeout: 30_000 },
  )

  test(
    "session.preStop terminal assistant content is idempotent across repeated loop calls",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const stub = startScriptedLLMServer([{ lines: textStopResponse("original model final") }])
      const postMarker = path.join(tmp.path, "terminal-post-lines.jsonl")
      try {
        const plugin = await writePlugin(
          tmp.path,
          "idempotent-terminal-plugin.ts",
          [
            "import * as fs from 'fs/promises'",
            `const marker = ${JSON.stringify(postMarker)}`,
            "export default async () => ({",
            '  "session.preStop": async (_input, output) => {',
            '    output.status = "blocked"',
            '    output.reason = "a durable blocker remains"',
            "  },",
            '  "session.post": async (input) => {',
            "    await fs.appendFile(marker, JSON.stringify({ outcome: input.outcome, finalText: input.finalText, terminalStop: input.terminalStop }) + '\\n')",
            "  },",
            "})",
            "",
          ].join("\n"),
        )
        await configureProject({ directory: tmp.path, origin: stub.origin, plugins: [plugin] })

        const messages = await Instance.provide({
          directory: tmp.path,
          fn: () =>
            run(
              Effect.gen(function* () {
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                const session = yield* sessions.create({ title: "idempotent-terminal-content" })
                yield* prompt.prompt({
                  sessionID: session.id,
                  agent: "build",
                  parts: [{ type: "text", text: "finish once" }],
                })
                yield* prompt.loop({ sessionID: session.id, agentID: "main" })
                return yield* sessions.messages({ sessionID: session.id, agentID: "main" })
              }),
            ),
        })

        expect(stub.captures.length).toBe(1)
        const postEvents = (await Bun.file(postMarker).text())
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { outcome: string; finalText?: string; terminalStop?: { status: string } })
        expect(postEvents).toHaveLength(2)
        expect(postEvents.every((event) => event.outcome === "cancelled")).toBe(true)
        expect(postEvents.every((event) => event.finalText === "original model final")).toBe(true)
        expect(postEvents.every((event) => event.terminalStop?.status === "blocked")).toBe(true)

        const assistant = messages.findLast((message) => message.info.role === "assistant")
        const textParts = assistant?.parts.filter((part) => part.type === "text") ?? []
        expect(textParts.filter((part) => part.text === "original model final")).toHaveLength(1)
        expect(textParts.filter((part) => part.metadata?.sessionPreStopTerminal)).toHaveLength(1)
      } finally {
        await stub.stop()
      }
    },
    { timeout: 30_000 },
  )

  test.each(["allow", "continue"] as const)(
    "session.preStop removes a stale terminal notice when the provider transitions to %s",
    async (transition) => {
      await using tmp = await tmpdir({ git: true })
      const stub = startScriptedLLMServer([
        { lines: textStopResponse("initial model final") },
        { lines: textStopResponse("model final after continuation") },
      ])
      try {
        const plugin = await writePlugin(
          tmp.path,
          `terminal-to-${transition}.ts`,
          [
            "let checks = 0",
            "export default async () => ({",
            '  "session.preStop": async (_input, output) => {',
            "    checks++",
            '    if (checks === 1) { output.status = "blocked"; output.reason = "temporary blocker"; return }',
            transition === "continue"
              ? '    if (checks === 2) { output.status = "continue"; output.stateDigest = "retry"; output.reason = "retry once"; return }'
              : "",
            '    output.status = "allow"',
            "  },",
            "})",
            "",
          ].join("\n"),
        )
        await configureProject({ directory: tmp.path, origin: stub.origin, plugins: [plugin] })

        const messages = await Instance.provide({
          directory: tmp.path,
          fn: () =>
            run(
              Effect.gen(function* () {
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                const session = yield* sessions.create({ title: `terminal-to-${transition}` })
                yield* prompt.prompt({
                  sessionID: session.id,
                  agent: "build",
                  parts: [{ type: "text", text: "finish after temporary blocker" }],
                })
                yield* prompt.loop({ sessionID: session.id, agentID: "main" })
                return yield* sessions.messages({ sessionID: session.id, agentID: "main" })
              }),
            ),
        })

        expect(stub.captures.length).toBe(transition === "continue" ? 2 : 1)
        expect(
          messages
            .flatMap((message) => message.parts)
            .filter((part) => part.type === "text" && part.metadata?.sessionPreStopTerminal),
        ).toHaveLength(0)
      } finally {
        await stub.stop()
      }
    },
    { timeout: 30_000 },
  )

  test.each([
    ["awaiting_user", "processed", 1],
    ["blocked", "processed", 1],
    ["awaiting_user", "existing-assistant", 1],
    ["blocked", "existing-assistant", 1],
  ] as const)(
    "session.preStop %s bypasses an active goal on the %s stop path",
    async (status, stopPath, expectedCalls) => {
      await using tmp = await tmpdir({ git: true })
      const judgeVerdict = '{"ok":true,"reason":"judge should not run"}'
      const postMarker = path.join(tmp.path, `${status}-${stopPath}-post.json`)
      const stub = startScriptedLLMServer(
        stopPath === "processed"
          ? [{ lines: textStopResponse("provider-terminal answer") }, { lines: textStopResponse(judgeVerdict) }]
          : [{ lines: textStopResponse(judgeVerdict) }],
      )
      try {
        const plugin = await writePlugin(
          tmp.path,
          `${status}-${stopPath}-plugin.ts`,
          [
            "import * as fs from 'fs/promises'",
            `const marker = ${JSON.stringify(postMarker)}`,
            "export default async () => ({",
            '  "session.preStop": async (_input, output) => {',
            `    output.status = ${JSON.stringify(status)}`,
            '    output.reason = "deterministic terminal state"',
            "  },",
            '  "session.post": async (input) => {',
            "    await fs.writeFile(marker, JSON.stringify({ outcome: input.outcome, error: input.error, terminalStop: input.terminalStop }))",
            "  },",
            "})",
            "",
          ].join("\n"),
        )
        await configureProject({ directory: tmp.path, origin: stub.origin, plugins: [plugin] })

        await Instance.provide({
          directory: tmp.path,
          fn: () =>
            run(
              Effect.gen(function* () {
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                const session = yield* sessions.create({ title: `${status}-${stopPath}` })
                yield* prompt.command({
                  sessionID: session.id,
                  command: "goal",
                  arguments: "legacy goal must remain active",
                  agent: "build",
                })
                if (stopPath === "existing-assistant") {
                  yield* prompt.loop({ sessionID: session.id, agentID: "main" })
                }
              }),
            ),
        })

        expect(stub.captures.length).toBe(expectedCalls)
        const post = JSON.parse(await Bun.file(postMarker).text()) as {
          outcome: string
          error?: string
          terminalStop?: { status: string; reason: string }
        }
        expect(post.outcome).toBe("cancelled")
        expect(post.error).toContain("deterministic terminal state")
        expect(post.terminalStop?.status).toBe(status)
        expect(post.terminalStop?.reason).toContain("deterministic terminal state")
      } finally {
        await stub.stop()
      }
    },
    { timeout: 30_000 },
  )

  test(
    "session.preStop converges unchanged continue state into one blocked-report turn",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const stub = startScriptedLLMServer([
        { lines: textStopResponse("attempt one") },
        { lines: textStopResponse("attempt two") },
        { lines: textStopResponse("attempt three") },
        { lines: textStopResponse("blocked report") },
        { lines: textStopResponse("must never be requested") },
      ])
      try {
        const plugin = await writePlugin(
          tmp.path,
          "stalled-plugin.ts",
          [
            "export default async () => ({",
            '  "session.preStop": async (_input, output) => {',
            '    output.status = "continue"',
            '    output.taskId = "video-edit"',
            '    output.stateDigest = "unchanged-revision"',
            '    output.reason = "render remains unavailable"',
            '    output.nextAction = { description: "Retry render", command: ["mimo-cut", "deliver"] }',
            "  },",
            "})",
            "",
          ].join("\n"),
        )
        await configureProject({ directory: tmp.path, origin: stub.origin, plugins: [plugin] })

        const sessionID = await Instance.provide({
          directory: tmp.path,
          fn: () =>
            run(
              Effect.gen(function* () {
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                const session = yield* sessions.create({ title: "stalled-provider" })
                yield* prompt.prompt({
                  sessionID: session.id,
                  agent: "build",
                  parts: [{ type: "text", text: "finish the video" }],
                })
                return session.id
              }),
            ),
        })
        await Instance.disposeAll()
        const messages = await Instance.provide({
          directory: tmp.path,
          fn: () =>
            run(
              Effect.gen(function* () {
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                // Rechecking after every Instance-scoped service has been
                // rebuilt must use the latch stored on the visible user turn,
                // rather than starting another retry cycle from an empty Map.
                yield* prompt.loop({ sessionID, agentID: "main" })
                return yield* sessions.messages({ sessionID, agentID: "main" })
              }),
            ),
        })

        expect(stub.captures.length).toBe(4)
        const blockedReportPrompt = JSON.stringify(stub.captures[3].messages)
        expect(blockedReportPrompt).toContain("three consecutive completion checks")
        expect(blockedReportPrompt).toContain("report this blocker")
        expect(blockedReportPrompt).toContain('[\\"mimo-cut\\",\\"deliver\\"]')
        const assistant = messages.findLast((message) => message.info.role === "assistant")
        const terminalParts =
          assistant?.parts.filter((part) => part.type === "text" && part.metadata?.sessionPreStopTerminal) ?? []
        expect(terminalParts).toHaveLength(1)
        expect(terminalParts[0]?.type).toBe("text")
        if (terminalParts[0]?.type === "text") {
          expect(terminalParts[0].text).toContain("remained incomplete after its one host-requested blocker report")
        }
      } finally {
        await stub.stop()
      }
    },
    { timeout: 30_000 },
  )

  test(
    "session.preStop enforces an absolute per-turn continuation limit even when state digests keep changing",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const stub = startScriptedLLMServer(
        Array.from({ length: 10 }, (_, index) => ({ lines: textStopResponse(`attempt ${index + 1}`) })),
      )
      try {
        const plugin = await writePlugin(
          tmp.path,
          "changing-state-plugin.ts",
          [
            "let checks = 0",
            "export default async () => ({",
            '  "session.preStop": async (_input, output) => {',
            "    checks++",
            '    output.status = "continue"',
            '    output.taskId = "video-edit"',
            "    output.stateDigest = `state-${checks}`",
            "    output.reason = `revision ${checks} is still incomplete`",
            "  },",
            "})",
            "",
          ].join("\n"),
        )
        await configureProject({ directory: tmp.path, origin: stub.origin, plugins: [plugin] })

        const messages = await Instance.provide({
          directory: tmp.path,
          fn: () =>
            run(
              Effect.gen(function* () {
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                const session = yield* sessions.create({ title: "absolute-continuation-limit" })
                yield* prompt.prompt({
                  sessionID: session.id,
                  agent: "build",
                  parts: [{ type: "text", text: "finish changing revisions" }],
                })
                return yield* sessions.messages({ sessionID: session.id, agentID: "main" })
              }),
            ),
        })

        expect(stub.captures).toHaveLength(9)
        const blockerReportPrompt = JSON.stringify(stub.captures[8].messages)
        expect(blockerReportPrompt).toContain("per-turn limit of 8 continuation checks")
        expect(blockerReportPrompt).toContain("report this blocker")
        const terminal = messages
          .flatMap((message) => message.parts)
          .find((part) => part.type === "text" && part.metadata?.sessionPreStopTerminal)
        expect(terminal?.type).toBe("text")
        if (terminal?.type === "text") {
          expect(terminal.text).toContain("remained incomplete after its one host-requested blocker report")
        }
        const visibleUser = messages.find(
          (message) =>
            message.info.role === "user" &&
            message.parts.some((part) => part.type === "text" && part.text === "finish changing revisions"),
        )
        const progressPart = visibleUser?.parts.find(
          (part): part is MessageV2.TextPart =>
            part.type === "text" && part.metadata?.sessionPreStopProgress !== undefined,
        )
        expect(progressPart).toMatchObject({ type: "text", text: "", synthetic: true, ignored: true })
        const progress = progressPart?.metadata?.sessionPreStopProgress as
          | {
              version: number
              turnID: string
              providers: Array<{ blockedReportIssued: boolean }>
              aggregate?: unknown
            }
          | undefined
        expect(progress).toMatchObject({
          version: 1,
          turnID: visibleUser?.info.id,
          providers: [{ blockedReportIssued: true }],
        })
        expect(progress?.aggregate).toBeUndefined()
      } finally {
        await stub.stop()
      }
    },
    { timeout: 30_000 },
  )

  test(
    "session.preStop no-progress checks are consecutive across A, B, A task changes",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const stub = startScriptedLLMServer(
        Array.from({ length: 7 }, (_, index) => ({ lines: textStopResponse(`attempt ${index + 1}`) })),
      )
      try {
        const plugin = await writePlugin(
          tmp.path,
          "alternating-task-plugin.ts",
          [
            "let checks = 0",
            "export default async () => ({",
            '  "session.preStop": async (_input, output) => {',
            "    checks++",
            '    output.status = "continue"',
            '    output.taskId = checks === 2 ? "B" : "A"',
            '    output.stateDigest = "unchanged"',
            "    output.reason = `task ${output.taskId} remains incomplete`",
            "  },",
            "})",
            "",
          ].join("\n"),
        )
        await configureProject({ directory: tmp.path, origin: stub.origin, plugins: [plugin] })

        await Instance.provide({
          directory: tmp.path,
          fn: () =>
            run(
              Effect.gen(function* () {
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                const session = yield* sessions.create({ title: "alternating-task" })
                yield* prompt.prompt({
                  sessionID: session.id,
                  agent: "build",
                  parts: [{ type: "text", text: "finish alternating tasks" }],
                })
              }),
            ),
        })

        expect(stub.captures.length).toBe(6)
        expect(JSON.stringify(stub.captures[5].messages)).toContain("three consecutive completion checks")
      } finally {
        await stub.stop()
      }
    },
    { timeout: 30_000 },
  )

  test(
    "session.preStop no-progress checks restart for a new visible user turn",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const stub = startScriptedLLMServer(
        Array.from({ length: 9 }, (_, index) => ({ lines: textStopResponse(`attempt ${index + 1}`) })),
      )
      try {
        const plugin = await writePlugin(
          tmp.path,
          "turn-scoped-progress-plugin.ts",
          [
            "export default async () => ({",
            '  "session.preStop": async (_input, output) => {',
            '    output.status = "continue"',
            '    output.taskId = "same-task"',
            '    output.stateDigest = "same-state"',
            '    output.reason = "still incomplete"',
            "  },",
            "})",
            "",
          ].join("\n"),
        )
        await configureProject({ directory: tmp.path, origin: stub.origin, plugins: [plugin] })

        await Instance.provide({
          directory: tmp.path,
          fn: () =>
            run(
              Effect.gen(function* () {
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                const session = yield* sessions.create({ title: "turn-scoped-progress" })
                yield* prompt.prompt({
                  sessionID: session.id,
                  agent: "build",
                  parts: [{ type: "text", text: "first request" }],
                })
                yield* prompt.prompt({
                  sessionID: session.id,
                  agent: "build",
                  parts: [{ type: "text", text: "second request" }],
                })
              }),
            ),
        })

        expect(stub.captures.length).toBe(8)
        expect(JSON.stringify(stub.captures[7].messages)).toContain("three consecutive completion checks")
      } finally {
        await stub.stop()
      }
    },
    { timeout: 30_000 },
  )

  test(
    "legacy plugins with the same exported function name keep distinct provider identities",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const stub = startScriptedLLMServer(
        Array.from({ length: 5 }, (_, index) => ({ lines: textStopResponse(`attempt ${index + 1}`) })),
      )
      const source = (reason: string) =>
        [
          "export async function completionProvider() {",
          "  return {",
          '    "session.preStop": async (_input, output) => {',
          '      output.status = "continue"',
          '      output.taskId = "shared-task"',
          '      output.stateDigest = "same-state"',
          `      output.reason = ${JSON.stringify(reason)}`,
          "    },",
          "  }",
          "}",
          "",
        ].join("\n")
      try {
        const first = await writePlugin(tmp.path, "legacy-one.ts", source("first legacy provider"))
        const second = await writePlugin(tmp.path, "legacy-two.ts", source("second legacy provider"))
        await configureProject({ directory: tmp.path, origin: stub.origin, plugins: [first, second] })

        await Instance.provide({
          directory: tmp.path,
          fn: () =>
            run(
              Effect.gen(function* () {
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                const session = yield* sessions.create({ title: "legacy-provider-identities" })
                yield* prompt.prompt({
                  sessionID: session.id,
                  agent: "build",
                  parts: [{ type: "text", text: "run both legacy providers" }],
                })
              }),
            ),
        })

        expect(stub.captures.length).toBe(4)
        const blockedReport = JSON.stringify(stub.captures[3].messages)
        expect(blockedReport).toContain("first legacy provider")
        expect(blockedReport).toContain("second legacy provider")
        expect(blockedReport).not.toContain("legacy-one.ts")
        expect(blockedReport).not.toContain("legacy-two.ts")
        const providerIDs = blockedReport.match(/prestop:[0-9a-f]{24}/g) ?? []
        expect(new Set(providerIDs).size).toBe(2)
      } finally {
        await stub.stop()
      }
    },
    { timeout: 30_000 },
  )

  test(
    "loads global completion file hooks but ignores project-local session.preStop registrations",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const workspace = path.join(tmp.path, "workspace")
      const trustedConfig = path.join(tmp.path, "trusted-config")
      await fs.promises.mkdir(workspace, { recursive: true })
      const hookSource = (reason: string) =>
        [
          "export default {",
          '  "session.preStop": async (_input, output) => {',
          '    output.status = "continue"',
          '    output.taskId = "shared-task"',
          '    output.stateDigest = "same-state"',
          `    output.reason = ${JSON.stringify(reason)}`,
          "  },",
          "}",
          "",
        ].join("\n")
      await writeFileHook(workspace, "untrusted.ts", hookSource("project hook must not execute"))
      const trustedHooksDirectory = path.join(trustedConfig, "hooks")
      await fs.promises.mkdir(trustedHooksDirectory, { recursive: true })
      const trustedHook = path.join(trustedHooksDirectory, "trusted.ts")
      await Bun.write(trustedHook, hookSource("trusted global hook"))
      const trustedCanonical = await fs.promises.realpath(trustedHook)
      const stub = startScriptedLLMServer(
        Array.from({ length: 5 }, (_, index) => ({ lines: textStopResponse(`attempt ${index + 1}`) })),
      )
      const previousConfigDir = process.env.MIMOCODE_CONFIG_DIR
      process.env.MIMOCODE_CONFIG_DIR = trustedConfig
      try {
        await configureProject({ directory: workspace, origin: stub.origin })

        await Instance.provide({
          directory: workspace,
          fn: () =>
            run(
              Effect.gen(function* () {
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                const session = yield* sessions.create({ title: "trusted-file-hooks-only" })
                yield* prompt.prompt({
                  sessionID: session.id,
                  agent: "build",
                  parts: [{ type: "text", text: "run the trusted completion provider" }],
                })
              }),
            ),
        })

        expect(stub.captures.length).toBe(4)
        const blockedReportPrompt = JSON.stringify(stub.captures[3].messages)
        expect(blockedReportPrompt).not.toContain(trustedCanonical)
        expect(blockedReportPrompt).not.toContain(trustedHook)
        expect(blockedReportPrompt).toMatch(/prestop:[0-9a-f]{24}/)
        expect(blockedReportPrompt).toContain("trusted global hook")
        expect(blockedReportPrompt).not.toContain("project hook must not execute")
      } finally {
        if (previousConfigDir === undefined) delete process.env.MIMOCODE_CONFIG_DIR
        else process.env.MIMOCODE_CONFIG_DIR = previousConfigDir
        await stub.stop()
      }
    },
    { timeout: 30_000 },
  )

  test(
    "trusted global file-hook compile failures remain visible fail-closed completion providers",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const workspace = path.join(tmp.path, "workspace")
      const trustedConfig = path.join(tmp.path, "trusted-config")
      const trustedHooksDirectory = path.join(trustedConfig, "hooks")
      const brokenHook = path.join(trustedHooksDirectory, "broken-completion.ts")
      await fs.promises.mkdir(workspace, { recursive: true })
      await fs.promises.mkdir(trustedHooksDirectory, { recursive: true })
      await Bun.write(
        brokenHook,
        'export default { "session.preStop": async (_input, output) => { output.status = "blocked" }, this is not valid TypeScript',
      )
      const stub = startScriptedLLMServer([{ lines: textStopResponse("model tried to finish") }])
      const previousConfigDir = process.env.MIMOCODE_CONFIG_DIR
      process.env.MIMOCODE_CONFIG_DIR = trustedConfig
      try {
        await configureProject({ directory: workspace, origin: stub.origin })

        const messages = await Instance.provide({
          directory: workspace,
          fn: () =>
            run(
              Effect.gen(function* () {
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                const session = yield* sessions.create({ title: "broken-trusted-file-hook" })
                yield* prompt.prompt({
                  sessionID: session.id,
                  agent: "build",
                  parts: [{ type: "text", text: "validate the required completion provider" }],
                })
                return yield* sessions.messages({ sessionID: session.id, agentID: "main" })
              }),
            ),
        })

        expect(stub.captures).toHaveLength(1)
        const terminal = messages
          .flatMap((message) => message.parts)
          .find((part) => part.type === "text" && part.metadata?.sessionPreStopTerminal)
        expect(terminal?.type).toBe("text")
        if (terminal?.type === "text") {
          expect(terminal.text).toContain("could not be loaded")
          expect(terminal.text).toContain("completion cannot be verified")
          expect(terminal.text).toMatch(/prestop:[0-9a-f]{24}/)
          expect(terminal.text).not.toContain(brokenHook)
          expect(terminal.text).not.toContain("broken-completion.ts")
        }
      } finally {
        if (previousConfigDir === undefined) delete process.env.MIMOCODE_CONFIG_DIR
        else process.env.MIMOCODE_CONFIG_DIR = previousConfigDir
        await stub.stop()
      }
    },
    { timeout: 30_000 },
  )
})
