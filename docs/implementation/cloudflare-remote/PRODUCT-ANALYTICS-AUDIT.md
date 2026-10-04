# Product analytics audit — 5 October 2026

Status: research and implementation plan, **not an implemented or deployed analytics feature**.
The requested direction is Cloudflare, both Stable and Beta, with a control in Settings.
No PostHog account or SDK is required. Existing Beta crash diagnostics remain a distinct
collection path; extending product analytics must not silently enable crash uploads in Stable.

## Sources inspected

- Synara remote branch at `db9aa8f`, integrated with main `f2069a6`.
- [Original upstream repository](../../../README.md#origins), main commit `efecd3cf8bcec3d1891b5f5a27dc2f6d797c6448`.
  A fresh Git checkout superseded the older snapshot returned by web search.
- [Synara diagnostics, f917899ab4925fa35fd0a12c7e2fa7b58072e7c7](https://github.com/Emanuele-web04/synara-beta-diagnostics/tree/f917899ab4925fa35fd0a12c7e2fa7b58072e7c7).
- Native branches `codex/ios-remote-connections` and `codex/ipad-support`: no product
  analytics client found. Their privacy policy currently says they do not collect telemetry.

## What is actually present

| Area                        | Implemented today                                                                                           | Missing for product analytics                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Desktop Beta                | Thirteen event names covering lifecycle, crash/error, updates, daily provider usage counts, Beta entry/exit | Feature adoption, onboarding/pairing outcomes, reconnect duration, true turn completion metrics    |
| Latest main context         | A bounded activity ring and recent memory samples attached to error/crash reports                           | These are diagnostic context, not standalone feature or performance time series                    |
| Desktop Stable              | No automatic app diagnostics sender                                                                         | Consent, a separate product event sender and Settings control                                      |
| iPhone/iPad                 | Account data, remote operations, local operational state                                                    | Consent and native product event instrumentation                                                   |
| Account usage / Saved Inbox | Private account data and separately published profile aggregates                                            | These are user features, not a maintainer analytics feed; never copy their payloads into telemetry |
| Cloudflare                  | Worker ingestion, D1, idempotent event IDs, authenticated dashboard; R2 for crash dumps                     | Product event route/table, channel filters, adoption and reliability views                         |

Source owners: `apps/desktop/src/betaDiagnostics.ts`, `apps/web/src/lib/rendererErrorDiagnostics.ts`,
`packages/shared/src/diagnosticsRedaction.ts`, `docs/diagnostics.md`; diagnostics repository
`worker.ts`, `migrations/0001_init.sql` through `0004_usage.sql`, `src/App.tsx`, `wrangler.toml`.

The Worker explicitly rejects events whose `flavor` is not `beta`. Its existing dashboard
has Overview, Issues, Usage and Releases. Changing only the client would therefore not
produce Stable analytics. Existing diagnostics have no retention expiry; new product events
need their own bounded retention policy.

## What to take from the upstream application

The upstream application records explicit server events and sends HTTP batches to PostHog rather than adding
browser autocapture or session replay. `apps/server/src/telemetry/AnalyticsService.ts`
has a bounded in-memory queue, per-event UUIDs, serialized batch sends, timeout, jittered
retry/backoff and a shutdown flush. Its defaults are batches of 20, a 1,000-event buffer,
one-second flush ticks, a ten-second send timeout and five attempts per failed batch.

Current call sites include `server.boot.heartbeat`, `client.connected`,
`client.thread.started`, `client.turn.requested` and `provider.turn.completed`. The last
event carries terminal outcome, token usage and duration, separately from the request.
See `serverRuntimeStartup.ts`,
`ws.ts` and `orchestration-v2/ProviderEventIngestor.ts` in that pinned checkout.
Measure meaningful transitions rather than every click, token or streamed chunk.

Do not copy its identity or defaults: `Identify.ts` first hashes provider account IDs,
and its telemetry environment switch defaults to true. The service also accepts arbitrary
property dictionaries. Synara should retain explicit schemas and a random analytics
installation identifier unrelated to account, provider or hardware identity.

Synara already persists diagnostic events across restarts and the Worker deduplicates
retried UUIDs. Reuse those delivery principles; a second vendor is not needed.

## Smallest implementation on Cloudflare

1. **Consent and ownership.** Recommend default-off product analytics, with a clear local
   Settings switch in each app. Persist consent independently per installation/flavor;
   do not inherit it from an account login or another connected computer. No collection
   before opt-in. Opt-out stops timers and sends, cancels pending requests where possible,
   clears unsent events and removes the analytics identifier. Already delivered data is
   governed by retention; do not imply a toggle retracts it.
2. **Shared event contract.** Put the versioned wire schemas in `packages/contracts`, with
   fixed event names, enum fields and bounded counts/durations. Runtime code belongs in
   its existing runtime layer, not contracts. No free-text properties. Generate IDs only
   after opt-in; never reuse provider/account/device IDs or the Beta crash identity.
3. **Event owners.** Emit UI adoption at the initiating client and execution outcomes at
   the owning host, respecting each emitter's consent. Label the surface/channel and
   distinguish client intent from server execution so remote use is not double-counted.
   A successful send RPC is an acknowledgement, not an assistant turn completion.
4. **Delivery.** Use bounded, nonblocking batches with UUID deduplication, retry/backoff,
   timeout and an expiring bounded queue. Analytics failures must never fail a chat,
   pairing, login, shutdown or reconnection. No production secret may be baked into a
   distributed app; public ingestion needs schema validation, limits and abuse controls.
5. **Worker and storage.** In the diagnostics repository add a separate
   `/v1/product-events` route and D1 product table. Retain the Beta-only behavior of
   `/v1/events` and `/v1/crash`. Validate at ingestion, use a unique event UUID, enforce
   batch/field limits, and reject unknown event types. Proposed initial product retention:
   30 days raw events, with longer-lived daily aggregates if needed. This is a proposal,
   not a change to existing diagnostics retention.
6. **Dashboard.** Extend the existing private dashboard with daily feature counts,
   onboarding/pairing outcomes, reconnect and turn outcome rates, and duration summaries.
   Filter by app surface, version, platform and channel. Keep diagnostic issues and product
   adoption distinct. Counters are best-effort telemetry, not billing records; never use
   consent-dependent data to enforce purchases or calculate charges.
7. **Native parity.** Implement the same versioned contract and local consent in iOS/iPadOS,
   using app lifecycle-aware bounded sending. Do not count suspension as a connection
   failure or rely on iOS executing a shutdown flush. Test foreground/reconnect behavior
   on physical devices as well as Simulator.
8. **Ship in dependency order.** Migrate and deploy the receiving Worker first, verify
   synthetic allowlisted events in a test dataset, then release consent-aware clients.
   Verify opt-out and mixed old/new client behavior before enabling a wider rollout.

D1 and the existing private dashboard are sufficient for an initial bounded rollout.
[Workers Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/)
is an option if measured volume/query costs justify a separate telemetry store; it is
not required just to send app events to Cloudflare.

## Initial event coverage and acceptance checks

| Question                  | Owner and bounded measurement                                                  | Required behavior check                                                                       |
| ------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Can users get started?    | Login/pairing flow outcome and elapsed duration; categorical failure code      | Failed/expired/cancelled attempts differ; no email, pairing code or token leaves the app      |
| Are connections reliable? | Host supervisor reconnect result, reason enum, duration                        | No success before usable connection; one result per attempt; another host remains independent |
| Do messages finish?       | Dispatch acknowledgement separately from provider turn completion/error/cancel | Retries do not double-count; interrupted/uncertain delivery is not reported as success        |
| Which features are used?  | Existing navigation/action owners emit fixed feature enums                     | No route URL, query, task title, project name, content or arbitrary model name is captured    |
| Is performance improving? | Startup/first-response durations and coarse memory counters                    | Monotonic elapsed measurement; no per-token network events or instrumentation in render loops |
| Does consent work?        | Local persisted switch and bounded queue                                       | Zero product requests before opt-in and after opt-out; restart cannot revive cleared events   |

Additional contract checks: malformed/unknown fields are rejected or reconstructed from the
allowlist, retry UUIDs are idempotent, queue size/age is bounded, ingest outages do not affect
work, Stable never acquires Beta crash upload behavior, and dashboards exclude rejected data.

## Copy and accuracy issues to resolve with implementation

- `apps/marketing/src/app/privacy/page.tsx` still claims optional PostHog analytics and
  `SYNARA_TELEMETRY_ENABLED` exist; that integration was removed. It also predates account
  and managed remote features. `PrivacySection.tsx` repeats the optional analytics claim.
- Update `docs/diagnostics.md`, native privacy policy, Settings disclosure and release notes
  together to distinguish opt-in product analytics from Beta diagnostics and account data.
- The diagnostics repository's `ANALYTICS.md` is historical: it leaves the switch undecided
  and proposes widening the existing Beta sender. The current user decision supersedes
  that design: both channels with a Settings control, without enabling Stable crash uploads.
- New main breadcrumbs for browser actions and interrupted RPC reconnects currently record
  starts without matching terminal outcomes. They are context clues, not reliable outcome
  metrics. Add completion instrumentation at the lifecycle owner before charting success rates.

No analytics endpoint, database migration, Settings switch or native sender was changed or
deployed by this audit. Existing account usage and Inbox deployment status is unchanged.
