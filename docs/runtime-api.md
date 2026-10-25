# Portable runtime API

The implementation is ESM on Node >=22, has no external dependency, DSH imports, provider credentials or installed application paths. `core/index.js` exports `PersonaRuntime`, `MemoryRepository`, `JsonStore`, schema utilities and prompt snapshot helpers. The current product authority remains `plan/persona/persona-schema.md`; `identityPlan` is an additive expression of the already requested autonomous recognition, not an authentication system.

```js
const runtime = new PersonaRuntime({ repository, clock, model, host, config,
  tokenCounter, autoSchedule: true });
await runtime.open();
```

`clock` is an epoch-ms function, or `{now(),setTimeout(fn,delay),clearTimeout(id)}`. Supplying a fake clock or `autoSchedule:false` allows a caller to drive `handleDue()` without real timers. No fixed polling interval is installed. Long timers are split only to respect the native timer range; this never triggers an early personality decision.

## Model port

`model.complete({purpose,messages,context?,run?,requestId,signal,maxOutputTokens})` returns:

- `purpose:"control"`: `{decision:PersonaDecideInput,usage?,model?}` or a JSON object/text encoding the decision.
- `purpose:"reply"`: `{text,usage?,model?}` or plain text.
- `purpose:"consolidation"`: `{patch:{entries,evictSourceIds?},usage?,model?}`, an entries array, or JSON text. Entry document names and structural rules are in `repository-api.md`.

Consolidation prompts carry a value-shape guide for axes (n/position/sd/metric/window), facets, free signatures, habits, index items, codes, impression scalar/coordinate/event values, temporary interpretations and retired entries. These are structural examples, not required opinions or formation thresholds. A single experience can produce a subjective impression/signature; an empty patch is equally valid.

Provider usage is recorded verbatim, split by purpose. Missing usage remains `null` with `observed:false`; it is never fabricated as zero billing. Aborts and failures also have usage records. Optional `model.maxInputTokens` rejects an oversized model request before calling the provider and before consuming sources. Optional `model.countTokens(text)` (or `host.countTokens` / constructor `tokenCounter`) must be local and return a nonnegative number or `{tokens}`. Snapshot budgets use that supplied counter. Without one, snapshots explicitly label `tokenAccounting:"utf8_bytes_estimate"`; this is an estimate, not verified model token usage or a universal tokenizer guarantee. The host adapter must compare provider token usage with the actual model tokenizer and full host request, including history, tools and output reserve.

## Host ports

- `requestDecision(payload)` is optional. When present, it replaces the separate `model.complete(control)` call so a host can enqueue a real native-agent turn. Payload includes `controlId`, reason, target context, snapshot, current decision and pending input. Return `{queued:true}` if not yet decided; return `{decision}` only for an actual decision. Persist the same `controlId` in the native host message and pass it to `decide(...,{controlId,executeReply:false})`. Only a matching acknowledgement clears `execution.pendingControl`.

  `payload.pending` is a bounded source page. A long record has `fragment:{from,to,total,complete}`. `payload.pendingPage` contains `{completeEventIds,progress,total,remaining,tokens}`; progress values are Unicode offsets or null at a complete source. The adapter includes that page in the actual host request and calls `acknowledgePendingPage(page,{clearComplete:false})` only after actual admission. Clear only actual complete source IDs after the corresponding native response. Queuing alone does not acknowledge reading. Wake summaries contain counts and limited refs rather than repeating all pending bodies; originals and unseen tails remain queryable.
- `deliver({deliveryId,decisionId,proactiveId,target,text,status,submittedAt,snapshot?,signal?})` submits actual chosen text. Return `{status:"submitted"|"delivered"|"unknown",receiptId?,sourceSessionId?,sourceEventId?,sourceKind?,text?,deliveredAt?}`. `delivered` must mean an actual observable host output/receipt, not inbox acceptance. A stable receipt or source event permits recording the actual text in C1. No receipt means no fabricated source event. A host that generates its own native replies can avoid this port and acknowledge actual outgoing events separately.
- `reconcileDelivery(record)` checks an ambiguous submitted/unknown delivery and returns a real receipt or null. An unknown outcome is not blindly resent.
- `cancelDelivery(record)` attempts cancellation of queued/in-flight proactive output; unsupported cancellation remains unknown. The runtime never claims a delivered message was undone.
- `readTrace(locator,{sourceRef,cursor,maxChars})` returns `{available,text?,nextCursor?,truncated?,reason?}` or a text string. Cursor pages are read sequentially. A truncated page without a continuation cursor fails the batch; an explicit unavailable source is labelled as missing. A transport exception fails without consuming the source.
- `onWake({wakeId,groups,pendingEventIds,context})` may persist a native summary message. Return `{accepted:true,status:"queued"}` while it is only queued, then call `acknowledgeWake(wakeId)` when the host really accepts it. Each group retains person/channel/session and original records; late messages are not in that acknowledgement. Repeated open retries the same wake ID, so the host must deduplicate its native queued message by wakeId.
- Optional `onDecision(decision,context)`, `onIdentity(identity,context)`, `onError(error)` expose actual execution transitions without deciding whether an opinion is correct.

Host control and wake messages are runtime instructions, not participant dialogue. Their later native `user/message` event must not be ingested as a human C1 utterance. The DSH adapter performs that classification.

## Public methods

| Method | Behavior |
|---|---|
| `open()/close()` | Open/close repository, restore complete current decision and selected timers/listeners, reconcile outbox; replay durable queued control/wake work with stable identifiers. Clear actual timers on close. |
| `accept(input,environment,options?)` | Record participant dialogue inside an explicitly selected attention range, independently of replying. Does not authenticate by session. `options.decide:true` also signals new_message; native host loops normally leave it false to avoid duplicate generation. In on_write mode, merges a bounded opportunity fact for the normal personality turn; no separate paid consolidation starts until selected. |
| `decide(input,context)` | Validate executable structure, merge omitted top-level fields, replace supplied subplans, persist complete `currentDecision` and sleep/schedule together. Context includes personId, environment, source refs, controlId, proactive and executeReply. |
| `compose(context)` | Build a deeply frozen, independently attributed request snapshot, save bounded diagnostics and source IDs present in injected text. Explicit `personId:null` never means another person from the last context. |
| `handleDue(context?)/handleSignal(typeOrObject,context?)` | Execute only personality-selected time/signal conditions. Event-only listening has no deadline. Selected timer expiration reconsiders even without new messages; explicit-only sleep does not become a fixed wake time. |
| `search/forget/introspect(input,context)` | Forward to repository; explicit unknown targets stay unknown. Cross-subject queries are allowed with truthful subjects. |
| `consolidate(context)` | Prepare and commit one bounded increment via the model; accepts personId, maxInputChars and an optional previously prepared run. Preserves later arrivals. |
| `recoverConsolidations(context?)` | Retry recorded prepared runs; caller can inspect failures such as stale touched versions rather than inventing new personality content. |
| `deliver(text,context)` | Persist/reserve an outbox ID, submit once, record only a true receipt. `context.deliveryId` supports idempotent callers; context includes target and selected pendingEventIds. |
| `acknowledgeDelivery(id,receipt)` | Apply actual native output/delivery evidence; clear only that delivery's selected pending input; delivered assistant text is memory, not a new pending user message. |
| `retryDelivery(id)` | Retry only a durable pending entry that was never submitted; submitted/unknown entries require reconciliation. |
| `acknowledgeWake(wakeId)` | Mark exactly that queued wake summary accepted; never clear messages that arrived afterward. |
| `acknowledgePendingPage(page,{clearComplete?})` | Advance only actual read fragments; optionally consume only the page's completeEventIds. Unseen tails never become read merely because the body was clipped. |
| `retryPendingControl()` | Retry the durable selected decision attempt after an error; no invented periodic retry interval. |
| `stopProactive()/resumeProactive()` | Honor the user's stop intent, abort supported proactive model calls, cancel or reconcile outbox. Normal user replies remain available. No daily quota or silence penalty. |
| `updateConfig(partial)` | Validate/persist mode or budget changes without resetting source/consumption cursors. |
| `idle()` | Wait for currently tracked asynchronous work in tests/shutdown orchestration. |

When `decide` is called as a tool in an existing host-agent turn, pass `executeReply:false`: the host continues its own real generation, avoiding a second core reply plus another host generation. For fully portable operation, omit it and `replyPlan.action:"reply"` uses model(reply) and host(deliver). `identityPlan` new gets a stable internal person ID before it is persisted; associate links chosen source refs; unknown does not steal a previous person's identity. Host adapters consume `onIdentity`/the returned effects to update environment routing.

## Recovery, memory and autonomy

`RuntimeState.execution` contains bounded implementation metadata: last routing context, a selected pending control attempt, and an unacknowledged wake summary. It does not contain an endless second transcript. Complete current decisions remain in the schema's `currentDecision`. Sleep business state, model work and process serialization are separate. In-progress source recording does not wait for an LLM consolidation call.

The runtime keeps a detached base for each state edit. Repositories offering `patchRuntime(base,next)` apply only the top-level keys that this edit actually changed, preserving concurrent ingestion cursors, consolidation cursors and gap updates. A simultaneous change to the same touched key still raises `VERSION_CONFLICT`; the runtime does not blindly retry a decision or its external effects. Legacy repository ports without this method retain the full-state `saveRuntime(...,{expectedVersion})` comparison.

Decisions also have a durable pending-effects journal. A caller may supply `context.operationId` (e.g. a stable native tool invocation ID); otherwise `controlId` plus a canonical input fingerprint identifies a retried control, and independent calls get a new operation ID. Identity allocation and delivery IDs are stable before effects run. Successful steps are checkpointed, completed recent operation receipts are retained, and startup resumes interrupted effects. Native `executeReply:false` uses the same identity/notification deduplication without generating an extra reply. This is technical idempotence, not a restriction on future independent decisions. Hosts should make `onIdentity/onDecision` idempotent by context.decisionId across the callback/receipt boundary.

Actual delivery and its local memory projection are separate durable stages. A delivered outbox retains the actual source receipt and `projectionPending` until C1 ingestion and selected pending consumption finish. Startup completes this local projection without external resend. Source receipts deduplicate a crash after ingestion but before its marker. A newer personality reply subplan supersedes an old in-flight generated reply rather than falsely attributing that old text to the new decision.

Sleep creates background incremental work over known people and staging. Only the personality-selected wake condition ends sleep. Model failure is recorded and leaves sources unconsumed; no automatic punishment, frequency gate, forced sleep, evidence quorum or mandatory commitment executor is added. Repository transactions implement multi-file atomic recovery. Cached large source blocks and host trace pointers are paged; intermediate model proposals are not committed until the full selected increment succeeds. A failed later page does not consume earlier selected hot sources. Repeated root references are not new experiences.

Tests cover real local repository persistence and fault behavior with injected clocks/model/host ports. They do not prove a real DSH entry point, provider behavior, delivery surface or longitudinal personality quality; the actual adapter probes must establish those independently.

## Real-model contract clarifications (0.1.1)

identityPlan.sourceRefs selects originals/source-session groups to assign; it is not a recognition-evidence requirement. Omission selects the current participant scope, an explicit empty array performs no historical assignment, and explicit foreign sources do not silently bind the current session. identityAssociation reports the chosen identity separately from actual registry routing, including selectedSourceSessionIds, currentSessionWasSelected and currentRoute. No whole-session automatic historical reassignment is implied. personId is the relationship/search partition; role/sourceRole and speakerId describe the actual source. The model may choose to associate assistant originals without changing their speaker or making them human statements.

In DSH, executeReply:false continues native generation only for the same target. The adapter executes a different selected target through the real core reply/outbox/delivery path, while suppressing the redirected source continuation. describeTarget resolves and validates actual channel/session environment. A selected due control restores that selected target rather than an unrelated later lastContext.

attention dimensions use omission=unrestricted, []=none and intersection when both are present; null clears the choice. Incoming participant admission honors it. An already admitted native turn may complete the model's chosen reply even when a new attention selection excludes later inputs. Actual sent assistant text is still recorded. environment_change is emitted for observed persona channel/config/visible environment changes, including a real timezone update; no generic sensor or periodic polling coverage is claimed.

consolidate accepts an explicit runId for a previously prepared run and returns a committed run without another model call when already committed. Failed candidates retain structural errors and available usage; no automatic paid correction loop runs. Source revocation invalidates affected uncommitted candidates. See [real-model validation](real-model-validation.md).

## Autonomous consolidation jobs (0.2.0)

consolidationPlan={action:"run"|"defer",targetPersonIds?:[PersonId|null],reason?} selects one bounded increment per target, while awake or asleep. Omitted target scope defaults to the current recognized person plus unknown/global; [] is no_work. The one-shot decision uses durable jobs/child-runs; omission never repeats a completed job. on_write merges opportunities, not automatic model calls. Other sleep can be rest; consolidation_complete must match the chosen job and all committed children, with legacy run recovery retained.

Frozen memory context is paged by consolidationContextPage. A model can return readContext:{cursor} using a disclosed nextCursor. reviewState persists actual input/trace/context progress and cumulative calls without source consumption. consolidationCallsPerSegment limits a single explicitly started execution segment; exhaustion pauses without automatic paid continuation. An explicit runId continuation restores the manifest person scope and refreshes only an untouched child's context, never its frozen input. Input/output and metadata limits remain technical, with no personality frequency or evidence threshold. Current defaults and actual tests are in [the current report](evolution-and-wake-validation.md).

compose supplies a bounded real resources summary, including usage/limits, pressure and unresolved gaps. Unavailable measurements remain unavailable; pressure does not start consolidation. The state introspection returns global runtime plus personState/capacity, and page.callBudget discloses execution-attempt allowance. Format errors retain the actual response fragment/full hash and previous draft without source consumption. needs_format_correction resumes only the failed page; replaceDraft can withdraw unpaid proposals without deleting existing memories. CLI exceptions reconcile the selected job's latest error rather than leaving an old budget reason visible.

## Management lifecycle boundary (0.3.0)

The DSH management layer owns instance loading, operator receipts and scoped tool/listener cleanup. It never makes an autonomous personality decision by viewing data. Explicit UI consolidation/backfill records a durable receipt before execution; cold interrupted operations are unknown and not replayed. A live setting changes only after repository updateConfig succeeds. Restore/recover leaves the instance unloaded, since normal open can resume previously selected timers/control work. The continuing personality and data contract remain persona-memory/3. See [native management](management-ui.md).
