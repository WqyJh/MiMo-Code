import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionID } from "../../src/session/schema"
import { SessionCwd } from "../../src/tool/session-cwd"
import { tmpdir } from "../fixture/fixture"

afterEach(() => Instance.disposeAll())

test("disposing one instance preserves other session cwd overrides", async () => {
  await using one = await tmpdir()
  await using two = await tmpdir()
  const first = SessionID.make("ses_cwd_first")
  const second = SessionID.make("ses_cwd_second")
  const firstCwd = path.join(one.path, "first")
  const secondCwd = path.join(two.path, "second")
  await Promise.all([fs.mkdir(firstCwd), fs.mkdir(secondCwd)])

  await Instance.provide({
    directory: one.path,
    fn: () => SessionCwd.set(first, firstCwd),
  })
  await Instance.provide({
    directory: two.path,
    fn: () => SessionCwd.set(second, secondCwd),
  })

  await Instance.disposeDirectory(one.path)

  const reset = await Instance.provide({
    directory: one.path,
    fn: () => SessionCwd.get(first),
  })
  const preserved = await Instance.provide({
    directory: two.path,
    fn: () => SessionCwd.get(second),
  })
  expect(reset).toBe(one.path)
  expect(preserved).toBe(secondCwd)
})

test("restores a session cwd after Instance disposal and durably resets it", async () => {
  await using tmp = await tmpdir({ git: true })
  const nested = path.join(tmp.path, "nested")
  await fs.mkdir(nested)

  const sessionID = await Instance.provide({
    directory: tmp.path,
    fn: () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const session = yield* sessions.create({ title: "durable cwd" })
          SessionCwd.set(session.id, nested)
          return session.id
        }).pipe(Effect.scoped, Effect.provide(Session.defaultLayer)),
      ),
  })

  await Instance.disposeDirectory(tmp.path)
  expect(
    await Instance.provide({
      directory: tmp.path,
      fn: () => SessionCwd.get(sessionID),
    }),
  ).toBe(nested)

  await Instance.provide({
    directory: tmp.path,
    fn: () => SessionCwd.clear(sessionID),
  })
  await Instance.disposeDirectory(tmp.path)

  expect(
    await Instance.provide({
      directory: tmp.path,
      fn: () => SessionCwd.get(sessionID),
    }),
  ).toBe(tmp.path)
})

test("clears an unavailable persisted cwd and fails safe to the Instance root", async () => {
  await using tmp = await tmpdir({ git: true })
  const nested = path.join(tmp.path, "removed-after-cd")
  await fs.mkdir(nested)

  const sessionID = await Instance.provide({
    directory: tmp.path,
    fn: () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const session = yield* sessions.create({ title: "invalid cwd recovery" })
          SessionCwd.set(session.id, nested)
          return session.id
        }).pipe(Effect.scoped, Effect.provide(Session.defaultLayer)),
      ),
  })

  await Instance.disposeDirectory(tmp.path)
  await fs.rm(nested, { recursive: true })

  expect(
    await Instance.provide({
      directory: tmp.path,
      fn: () => SessionCwd.get(sessionID),
    }),
  ).toBe(tmp.path)

  // The fallback is a durable tombstone, not just a one-process cache repair.
  await Instance.disposeDirectory(tmp.path)
  expect(
    await Instance.provide({
      directory: tmp.path,
      fn: () => SessionCwd.get(sessionID),
    }),
  ).toBe(tmp.path)
})
