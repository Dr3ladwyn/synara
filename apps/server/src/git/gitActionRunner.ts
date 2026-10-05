import { createHash } from "node:crypto";

import {
  type GitActionProgressEvent,
  type GitRunStackedActionInput,
  WsRpcError,
} from "@synara/contracts";
import { stableJsonStringify } from "@synara/shared/browserAutomationCatalogue";
import { Cause, Effect, Exit, Queue, Stream } from "effect";

import { CurrentManagedAttachmentPrincipal } from "../managedAttachmentPrincipal";

type Observer = Queue.Queue<GitActionProgressEvent, WsRpcError | Cause.Done>;
interface Action {
  readonly fingerprint: string;
  readonly observers: Set<Observer>;
  latest?: GitActionProgressEvent;
  outcome?: Exit.Exit<void, WsRpcError>;
}

// Receipts are bounded independently of operation size and duration. Missing
// receipts on resume (including after a server restart) must never rerun Git.
const COMPLETED_ACTIONS_TO_KEEP = 256;

export const makeGitActionRunner = (
  run: (
    input: GitRunStackedActionInput,
    publish: (event: GitActionProgressEvent) => Effect.Effect<void>,
  ) => Effect.Effect<unknown, WsRpcError>,
) =>
  Effect.gen(function* () {
    const serverScope = yield* Effect.scope;
    const actions = new Map<string, Action>();
    const completed: string[] = [];

    const finishObserver = (queue: Observer, outcome: Exit.Exit<void, WsRpcError>) => {
      if (Exit.isFailure(outcome)) Queue.failCauseUnsafe(queue, outcome.cause);
      else Queue.endUnsafe(queue);
    };

    return (input: GitRunStackedActionInput) =>
      Stream.callback<GitActionProgressEvent, WsRpcError>(
        (queue) =>
          Effect.gen(function* () {
            const principal = yield* CurrentManagedAttachmentPrincipal;
            const key = JSON.stringify([principal.ownerKind, principal.ownerId, input.actionId]);
            const { resume, ...command } = input;
            const fingerprint = createHash("sha256")
              .update(stableJsonStringify(JSON.parse(JSON.stringify(command))))
              .digest("hex");
            let action = actions.get(key);
            const isNew = !action;
            if (!action) {
              if (resume)
                return yield* Effect.fail(
                  new WsRpcError({
                    message:
                      "The Git action result is unavailable. The server may have restarted or the request may not have arrived. Check the repository status before trying again.",
                  }),
                );
              action = { fingerprint, observers: new Set() };
              actions.set(key, action);
            } else if (action.fingerprint !== fingerprint) {
              return yield* Effect.fail(
                new WsRpcError({ message: "Git action ID was reused with different inputs." }),
              );
            }
            const current = action;
            if (current.latest) Queue.offerUnsafe(queue, current.latest);
            if (current.outcome) {
              finishObserver(queue, current.outcome);
              return;
            }
            current.observers.add(queue);
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                current.observers.delete(queue);
              }),
            );
            if (isNew) {
              yield* Effect.suspend(() =>
                run(command, (event) =>
                  Effect.sync(() => {
                    current.latest = event;
                    for (const observer of current.observers) Queue.offerUnsafe(observer, event);
                  }),
                ),
              ).pipe(
                Effect.asVoid,
                Effect.onExit((outcome) =>
                  Effect.sync(() => {
                    current.outcome = outcome;
                    for (const observer of current.observers) finishObserver(observer, outcome);
                    current.observers.clear();
                    completed.push(key);
                    while (completed.length > COMPLETED_ACTIONS_TO_KEEP)
                      actions.delete(completed.shift()!);
                  }),
                ),
                Effect.forkIn(serverScope, { uninterruptible: false }),
              );
            }
          }).pipe(
            Effect.uninterruptible,
            Effect.catchCause((cause) => Queue.failCause(queue, cause)),
          ),
        { bufferSize: 128, strategy: "sliding" },
      );
  });
