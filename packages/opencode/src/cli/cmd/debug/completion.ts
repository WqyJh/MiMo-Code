import { EOL } from "os"
import path from "path"
import { Effect } from "effect"
import { AppRuntime } from "@/effect/app-runtime"
import { Plugin } from "../../../plugin"
import { bootstrap } from "../../bootstrap"
import { cmd } from "../cmd"

export const HostCapabilities = {
  schemaVersion: 1,
  sessionPreStop: true,
  trustedGlobalCompletionProviders: true,
  toolHookHostCwd: true,
  durableSessionCwd: true,
  durableCompletionProviderRegistry: true,
  forgetCompletionProviderFile: true,
} as const

export function isAgentManagedCompletionAdminInvocation(env: NodeJS.ProcessEnv): boolean {
  return env.AGENT === "1" || env.MIMOCODE === "1" || env.MIMOCODE_PID !== undefined
}

// Capture the parent environment before the root CLI middleware marks this
// MiMoCode process itself as AGENT/MIMOCODE. A normal human terminal invocation
// remains available; a subprocess launched by an active agent does not get to
// remove the policy that decides whether that agent may stop.
const inheritedAgentManagedInvocation = isAgentManagedCompletionAdminInvocation(process.env)

export function assertCompletionProviderAdminInvocation(
  agentManaged = inheritedAgentManagedInvocation,
): void {
  if (!agentManaged) return
  throw new Error(
    "Completion providers may only be forgotten from a user-started administrator terminal, not from an Agent/MiMoCode subprocess.",
  )
}

export const CapabilitiesCommand = cmd({
  command: "capabilities",
  describe: "show machine-readable host capabilities",
  builder: (yargs) => yargs,
  handler() {
    process.stdout.write(JSON.stringify(HostCapabilities) + EOL)
  },
})

const ForgetCommand = cmd({
  command: "forget",
  describe: "unregister exactly one trusted completion provider",
  builder: (yargs) =>
    yargs.option("file", {
      type: "string",
      demandOption: true,
      describe: "absolute path of the trusted completion-provider file",
    }),
  async handler(args) {
    assertCompletionProviderAdminInvocation()
    if (!path.isAbsolute(args.file)) {
      throw new Error("--file must be an absolute path")
    }
    const file = path.resolve(args.file)
    await bootstrap(process.cwd(), async () => {
      const result = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          return yield* plugin.reloadFileHooks({ forgetMissingCompletionProviderFile: file })
        }),
      )
      process.stdout.write(JSON.stringify({ ok: true, file, forgotten: result.forgotten }) + EOL)
    })
  },
})

export const CompletionProvidersCommand = cmd({
  command: "completion-providers",
  describe: "administer trusted completion providers",
  builder: (yargs) => yargs.command(ForgetCommand).demandCommand(),
  async handler() {},
})
