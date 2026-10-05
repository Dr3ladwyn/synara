import { WsRpcError, type GitRunStackedActionInput } from "@synara/contracts";
import { Deferred, Effect, Exit, Fiber, Scope, Stream } from "effect";
import { expect, it } from "vitest";

import { CurrentManagedAttachmentPrincipal } from "../managedAttachmentPrincipal";
import { makeGitActionRunner } from "./gitActionRunner";

const input: GitRunStackedActionInput = { actionId: "original", cwd: "/repo", action: "push" };

it("replays a failed action, rejects changed inputs and foreign or missing receipts without executing", async () => {
  let runs = 0;
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const observe = yield* makeGitActionRunner(() => {
          runs++;
          return Effect.fail(new WsRpcError({ message: "remote rejected push" }));
        });
        for (const request of [input, { ...input, resume: true }]) {
          const failure = yield* observe(request).pipe(Stream.runDrain, Effect.flip);
          expect(failure.message).toBe("remote rejected push");
        }
        const changed = yield* observe({ ...input, action: "commit", resume: true }).pipe(
          Stream.runDrain,
          Effect.flip,
        );
        expect(changed.message).toContain("different inputs");
        const missing = yield* observe({ ...input, actionId: "missing", resume: true }).pipe(
          Stream.runDrain,
          Effect.flip,
        );
        expect(missing.message).toContain("result is unavailable");
        const foreign = yield* observe({ ...input, resume: true }).pipe(
          Stream.runDrain,
          Effect.provideService(CurrentManagedAttachmentPrincipal, {
            ownerKind: "session" as const,
            ownerId: "other-session",
          }),
          Effect.flip,
        );
        expect(foreign.message).toContain("result is unavailable");
        expect(runs).toBe(1);
      }),
    ),
  );
});

it("retains running actions through observer cancellation but interrupts them on server shutdown", async () => {
  let finalized = false;
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const serverScope = yield* Scope.make();
        const started = yield* Deferred.make<void>();
        const observe = yield* makeGitActionRunner(() =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Effect.sync(() => {
                finalized = true;
              }),
            ),
          ),
        ).pipe(Scope.provide(serverScope));
        const observer = yield* observe(input).pipe(Stream.runDrain, Effect.forkChild);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(observer);
        expect(finalized).toBe(false);
        yield* Scope.close(serverScope, Exit.void);
        expect(finalized).toBe(true);
      }),
    ),
  );
});
