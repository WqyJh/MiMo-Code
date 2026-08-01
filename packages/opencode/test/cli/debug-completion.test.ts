import { describe, expect, test } from "bun:test"
import {
  assertCompletionProviderAdminInvocation,
  HostCapabilities,
  isAgentManagedCompletionAdminInvocation,
} from "../../src/cli/cmd/debug/completion"

describe("debug completion host contract", () => {
  test("advertises the complete deterministic completion-provider capability set", () => {
    expect(HostCapabilities).toEqual({
      schemaVersion: 1,
      sessionPreStop: true,
      trustedGlobalCompletionProviders: true,
      toolHookHostCwd: true,
      durableSessionCwd: true,
      durableCompletionProviderRegistry: true,
      forgetCompletionProviderFile: true,
    })
  })

  test("refuses completion-provider administration inherited from an Agent/MiMoCode process", () => {
    expect(isAgentManagedCompletionAdminInvocation({ AGENT: "1" })).toBe(true)
    expect(isAgentManagedCompletionAdminInvocation({ MIMOCODE: "1" })).toBe(true)
    expect(isAgentManagedCompletionAdminInvocation({ MIMOCODE_PID: "123" })).toBe(true)
    expect(isAgentManagedCompletionAdminInvocation({})).toBe(false)
    expect(() => assertCompletionProviderAdminInvocation(true)).toThrow("user-started administrator terminal")
    expect(() => assertCompletionProviderAdminInvocation(false)).not.toThrow()
  })
})
