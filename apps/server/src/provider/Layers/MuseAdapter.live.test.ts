import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId, type ProviderRuntimeEvent } from "@synara/contracts";
import { Deferred, Effect, Layer, Stream } from "effect";
import { expect, it } from "vitest";
import { ServerConfig } from "../../config.ts";
import { MuseAdapter } from "../Services/MuseAdapter.ts";
import { MuseAdapterLive, museResumeId } from "./MuseAdapter.ts";

it("rejects malformed resume cursors", () => {
  expect(museResumeId({ schemaVersion: 1, sessionId: "saved-session" })).toBe("saved-session");
  expect(museResumeId({ schemaVersion: 2, sessionId: "saved-session" })).toBeUndefined();
  expect(museResumeId({ schemaVersion: 1, sessionId: " " })).toBeUndefined();
});

it.skipIf(process.env.SYNARA_LIVE_MUSE !== "1")(
  "streams a real Muse turn, closes, and resumes its native session",
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), "synara-muse-live-"));
    const layer = MuseAdapterLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          ServerConfig.layerTest(cwd, { prefix: "synara-muse-state-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
      ),
    );
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* MuseAdapter;
          const received: ProviderRuntimeEvent[] = [];
          const done = yield* Deferred.make<ProviderRuntimeEvent>();
          yield* Stream.runForEach(adapter.streamEvents, (event) =>
            Effect.gen(function* () {
              received.push(event);
              if (event.type === "turn.completed") yield* Deferred.succeed(done, event);
            }),
          ).pipe(Effect.forkScoped);
          const threadId = ThreadId.makeUnsafe("muse-live-test");
          const binaryPath = process.env.MUSE_ACP_TEST_BINARY ?? "muse-acp";
          const input = {
            threadId,
            provider: "muse" as const,
            cwd,
            runtimeMode: "approval-required" as const,
            providerOptions: { muse: { binaryPath } },
            modelSelection: { provider: "muse" as const, model: "default" },
          };
          const models = yield* adapter.listModels!({ provider: "muse", binaryPath, cwd });
          expect(models.models.some((model) => model.slug.startsWith("muse-"))).toBe(true);
          const spark = models.models.find((model) => model.slug === "muse-spark-1.3");
          expect(spark?.supportedReasoningEfforts?.map((effort) => effort.value)).toContain("max");
          const session = yield* adapter.startSession(input);
          expect(museResumeId(session.resumeCursor)).toBeTruthy();
          yield* adapter.sendTurn({
            threadId,
            input: "Reply exactly MUSE_READY. Do not use tools or modify any files.",
          });
          const terminal = yield* Deferred.await(done).pipe(Effect.timeout(90_000));
          expect(terminal.type === "turn.completed" && terminal.payload.state).toBe("completed");
          expect(JSON.stringify(received)).toContain("MUSE_READY");
          yield* adapter.stopSession(threadId);
          expect(yield* adapter.hasSession(threadId)).toBe(false);
          const resumed = yield* adapter.startSession({
            ...input,
            resumeCursor: session.resumeCursor,
          });
          expect(resumed.resumeCursor).toEqual(session.resumeCursor);
          const cancelled = yield* adapter.sendTurn({
            threadId,
            input: "Explain recursion in detail. Do not use tools.",
          });
          yield* adapter.interruptTurn(threadId, cancelled.turnId);
          yield* Effect.sleep(100);
          const cancelledEvents = received.filter(
            (event) => event.type === "turn.completed" && event.turnId === cancelled.turnId,
          );
          expect(cancelledEvents).toHaveLength(1);
          expect(
            cancelledEvents[0]?.type === "turn.completed" && cancelledEvents[0].payload.state,
          ).toBe("cancelled");
          yield* adapter.stopSession(threadId);
          expect(yield* adapter.listSessions()).toEqual([]);
        }).pipe(Effect.scoped, Effect.provide(layer)),
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
  240_000,
);
