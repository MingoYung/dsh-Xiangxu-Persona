# Installed DSH host API evidence

Date: 2026-10-25. Scope: read-only installed-source inspection plus a native CLI help probe in a dedicated temporary home. This document does not claim a real model request, persona lifecycle, or UI delivery has passed; those require the integration runner. No existing profile, existing plugin, browser-access setting, application source, or credentials were changed/read.

## Artifact and evidence identity

- Installed application: `C:/Users/Administrator/AppData/Local/Programs/DSH NEXT/resources/app.asar`.
- Root package: `dsh-desktop-next@2.0.19-next`; inspected host packages: `@deepseek-ai/*@0.2.1-rc.2`, Cordis `4.0.5`.
- ASAR SHA-256: `204e1dcc32ff6a9b661200b7ab97bda1cbd449904e2eddb71c9309cf767e06b5`.
- REA CLI: temporary `npx -y rea-agents@6.5.0`; no global install/client configuration changes. Doctor reported no Codex registration; the authorized static CLI path worked without registration or native analysis engines.
- Metadata/inventory Evidence: `ev_43aa9129a8be4962c053e617ede6b763181355d8af236dff9ee62540189937f8`.
- Selected host source Evidence: `ev_53003e37cbdb6a9da7006fd0cc79cf516d2d6e5273ed06e2b19155eb12cab838`.

Complete REA output, summaries, archive inventory, source copies, and the native help result are retained under:

`C:/Users/Administrator/Documents/Codex/2026-10-25/c-users-administrator-dsh-reports/work/persona-build/`

The second REA run selected exactly seven files: `dsh-system-prompt/lib/index.js`, `dsh-agent-loop/lib/index.js`, `dsh-tools/lib/index.js`, `dsh-session/lib/index.js`, `dsh-llm/lib/index.js`, `lib/desktop-cli.js`, `lib/plugin-cli.js`. It read 462,413 source bytes, parsed seven JavaScript files with zero parse failures, and visited 47,039 AST nodes. 16,037 inventoried files remained outside semantic analysis. Graph coverage is explicitly incomplete; zero observed Electron IPC/window findings in this narrow selection does not establish their absence from the app. REA parsed inert source and did not execute bundle bootstrap code.

Additional SDK/preset/boot README and JS files were read as ordinary extracted-source evidence. They are not represented as runtime observations or falsely attributed to the seven-file REA analysis. Unpacked `dsh-agent-preset` files are at `app.asar.unpacked/node_modules/@deepseek-ai/dsh-agent-preset/`.

## 1. Plugin shape, dependency resolution, and optional preset

Existing installed plugins use ESM exports `export const inject = ['tools']; export function apply(ctx, config) { ... }`. The project bundle manifest uses `dsh.bundle.patch`; the patch is a list of Loader patches, such as an `insert` list. Official plugin development and ordinary installed examples support this shape.

Do not assume a linked external package can resolve host bare imports through its own filesystem parents. The adapter can use host services and raw schemas without importing host helpers. When a host helper is required, declare and install proper dependency/peer resolution through the supported package manager; production code should not embed this machine's ASAR path.

A persona-specific agent preset is supported. Sources:

- `dsh-agent-preset/lib/index.js`: default class; `static inject=['agentPresets']`; Config fields `id` required, optional `name/description/order`, required `plugins` array. Its service initializer calls `ctx.agentPresets.register(config)`.
- `dsh-agent-preset-registry/README.zh.md`: new presets are bundle-patch declarations installed through plugin management, not directory scanning or writes through preset remotes. Existing agents retain their bound generation.
- `dsh-agent-preset-registry/lib/index.js:717`: `composedPreset(agent.ctx)` returns the bound preset ID.
- The `agentPreset` session projection starts from the header and follows `agent-preset/selected` events; a header alone may be stale after a blank-session selection.

Recommended bundle fragment:

```yaml
- insert:
    - id: preset-persona-memory
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: persona-memory
        name: 长期人格
        description: 自主记忆与关系人格
        plugins:
          - name: '@local/persona-memory'
            config: {}
```

Keep the user's existing preset default unchanged. Do not also insert the adapter globally. Preset composition provides the scope parent used by agent tools, prompt contributions, and listeners. A plugin using a global discovery listener must still explicitly check `composedPreset(agent.ctx)==='persona-memory'` before attaching or changing an agent. Ordinary coding sessions must remain outside the adapter's action scope.

## 2. Tools: raw definition versus defineTool DSL

`dsh-tools/lib/index.js:838–869` shows that `defineTool` is not an identity helper: it compiles its author DSL into raw JSON Schema and wraps `execute` with argument validation.

`ToolRuntime.register` at `:2974–2982` accepts a raw definition. It requires `output.schema` to be supported raw JSON Schema and `output.render` to be a function, then inserts the definition into the calling context's scope. It does not compile the author parameter DSL. Therefore an adapter without host imports can register this shape:

```js
ctx.tools.register({
  name: 'persona_example',
  description: 'Example only.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
    additionalProperties: false,
  },
  output: {
    schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  },
  async execute(args, exec) {
    // Run the core's structural argument validation here.
    const session = exec.agent?.session;
    exec.signal.throwIfAborted();
    return { ok: Boolean(session && typeof args.query === 'string') };
  },
});
```

The real tool body receives `(args, exec)`. Runtime construction at `dsh-tools/lib/index.js:3239–3264` supplies `callId`, `rootCallId`, `name`, `signal`, optional `agent`, optional `parent`, `deferContext` and `concludeTurn`. `exec.agent.session` is the real session. Do not invent `exec.session` or expect an ambient global current session. Parameters and output are canonical JSON values; rendered text is separate.

## 3. Session events, source identity, and reception before generation

`dsh-session/lib/index.js:1517–1537` constructs an event as:

```js
{ type, seq: sessionLogLength, time: Date.now(), data, ...surfaceMetadata }
```

`seq` is a per-session stable log position. A source key can use the actual session ID and seq, with explicit fork lineage handling during backfill. Message identity is separate from event seq and plugin intake order.

`deriveEventMessage` at `:217–227` is decisive:

- `user/message`: message is `event.data`.
- `assistant/message`: message is `event.data.message`; payload also contains `turn`, `step`, optional usage, compact stream, and interrupted status.
- `tool/result`: message is `event.data.message`.

A user-role event is not proof of a human message. Classify real `message.source.kind` and content blocks. Runtime context, instructions, plugin state and agent notifications may occupy user-role history; keep them out of C1 participant dialogue, but retain useful temporary process material as such. Assistant C1 text comes only from visible text blocks, with reasoning/tool blocks separate.

`session/event` publishes after the log append. Construction/seed events are not replayed through this notification; use a controlled snapshot/history backfill with stable keys. Source gaps cannot be repaired by pretending every prior event was observed live.

**Reentrancy:** `publicationEntry()` at `:1568–1570` refuses a second append while publishing an event. A synchronous `session/event` observer must not call `agent.followup`, inbox mutation, or another session append directly. Queue the operation after the publication boundary. Observer failures are contained and can otherwise look like a log-only failure.

**Reception before generation:** the loop claims inbox messages before pre-step and only writes accepted `user/message` events later. `agent/inbox/inserted` or the normalized inbox splice is needed to preserve accepted inputs during sleep/wait even when no model step is entered. A sleep implementation listening only to `user/message` will miss rejected inputs until explicitly re-admitted.

## 4. Agent driving and durable input

`dsh-agent-loop/lib/index.js:800–814`:

```js
followup(input) { this.send(input, 'next-turn', true); }
steer(input)    { this.send(input, 'next-step', true); }
inject(input)  { this.send(input, 'next-step', false); }
```

The final boolean wakes the driver. Direct inbox `append` persists queue state but does not call `wakeDriver`. Use `followup` for an idle agent's next turn; `steer` for step-boundary input; `inject` for context that should wait for another accepted step. There is no need to invent `agent.run`.

Input must be an identified user message. The SDK implementation calls `createUserMessage` first; `send` does not create an ID or role. An import-free equivalent is:

```js
const message = {
  id: crypto.randomUUID(),
  role: 'user',
  source: { kind: 'persona-memory' },
  content: [{ type: 'text', text: instruction }],
};
agent.followup(message);
await agent.whenIdle();
```

Session shape checks at `dsh-session/lib/index.js:1194–1218` require a nonempty string ID, expected role, nonempty string source.kind and content array. User sources may have a plugin-owned kind; assistant message sources must be `model` with provider/model attribution. Preserve the same message ID when retrying a delivery, and use outbox reconciliation rather than treating a second new UUID as the same delivery.

Inbox API getters are `nextTurn/nextStep`; mutation target strings are **`'next-turn'/'next-step'`**, not camelCase. `claim` removes the batch, emits claimed notifications and does not itself put the batch back.

### Pre-step behavior and sleep

`dsh-agent-loop/lib/index.js:902–925` claims inbox, assembles prompt, then invokes the `agent/pre-step` waterfall. Payload includes `{agent,messages,turn,step,signal}`. The callback form is `(payload,next)`; `next()` gives the downstream enter/reject decision. An enter decision contains the complete admitted message batch and optional `startsRequestSeries`.

At `:960–962`, reject ends the turn as blocked. The already claimed inputs are not automatically restored to inbox. Sleep/wait must persist pending messages before reject and explicitly re-admit them or an attributable summary later. Reject is not a reversible queue pause. A direct return can suppress fallback runtime context; deliberate wrapping must preserve the downstream admission batch when appropriate.

`agent.cancel(cause,{keepInbox?})` aborts current activity, clearing pending inbox unless keepInbox is true. Exact cancellation cleanup/partial-output behavior must be tested. No untested cancellation path should be advertised as retracting text already displayed.

## 5. Prompt scope, synchronous text, and async assembly

`Agent.ctx` is the agent scope; contributions through it apply to that agent and are disposed with it. `assembleContextFor` returns `{agent,scope:agent,signal?}`. The scope key is the Agent, not the Context.

`dsh-system-prompt/lib/index.js:253–255` registers a section in the calling scope. `:388` resolves `section.text(context)` synchronously. Do not return a Promise from `text`. `complete:true` is a boolean declaring the exact whole prompt, not a completion callback.

Since prompt assembly runs **before** `agent/pre-step`, refreshing a section from pre-step is too late for the bound current assembly. For asynchronous core composition, use the actual `system-prompt/assemble` waterfall at `:398`:

```js
ctx.on('system-prompt/assemble', async (assembly, context, next) => {
  // This listener belongs to the persona preset scope, or explicitly checks it.
  const live = await composeFor(context.agent); // returns one immutable request snapshot/text
  const accepted = await next();
  return {
    ...accepted,
    sections: [...accepted.sections, {
      name: 'persona-memory:live',
      text: live.text,
      interpolate: false,
    }],
  };
});
```

Verify Cordis scope filtering with interleaved real agents. Do not share one global lastText/currentPerson. Retries reuse the accepted assembly; snapshots should preserve this binding.

**Complete-section caveat:** `:399–404` restores an effective complete section after the waterfall. A persona preset inheriting another `complete:true` section can discard an appended ordinary section. Configure the persona preset's prompt composition intentionally; do not silently replace the entire host prompt or presume appended material survives. Runtime-context refresh is separate and occurs again before admission.

## 6. Independent model calls without secret access

The real service is **`ctx.llm.stream(options)`**, not `ctx.llm.chat` or `ctx.models`. Options include `{provider,model,messages,signal?,maxTokens?,reasoningEffort?}`. A one-shot textual port consumes the stream and returns a completed value.

With proper host import resolution, `BlockAssembler` from `@deepseek-ai/dsh-llm` has `push`, `blocks()`, `usage`, `finish`, `message()` and replay support. An import-free adapter can retain a map by chunk index:

- `block-start`: `{index,blockType}`.
- `text-delta`: `{index,text}`; append text to that index.
- `reasoning-delta`: same index/text shape, separate kind; not returned as participant prose.
- `tool-call-delta`: `{index,id,name?,argumentsDelta}`; do not execute unexpected calls in a text-only control port.
- `block-end`: `{index,block}`; replace the accumulated block at that index with this completed block, avoiding double concatenation.
- `usage`: `{usage}`.
- `finish`: `{reason,replayState?}`; error/aborted are failures, max-tokens is explicit truncation, not a silently valid JSON patch.

These shapes are implemented at `dsh-llm/lib/index.js:964–1003`. Preserve source order across indices and inspect the terminal reason even if visible text exists.

`ctx.llm.prepareCall(config,signal,configure?)` at `:2220–2260` resolves a route and returns `config`, capabilities/defaults, and a **single-dispatch** `stream(options)`. Use it if configuration and dispatch need binding; do not re-dispatch the same prepared call or change its resolved config.

`ctx.get('agentDefaultModel').currentSelection()` supplies a detached provider/model/reasoning selection. An existing agent's resolved request config is preferable when following its exact selected route. Credentials stay inside the host adapter; no key is needed in the core or this port. Failed resolution is a reported unavailable route, not a reason to copy credentials from another harness.

## 7. Native installed CLI and isolated real engine

Installed executable: `C:/Users/Administrator/AppData/Local/Programs/DSH NEXT/DSH NEXT.exe`.

Installed CLI bootstrap: `resources/app.asar/lib/desktop-cli.js`. It runs the installed `@deepseek-ai/dsh/lib/bin.js` `runCli({manageDesktopProfile:true})`, using Desktop's package policy and runtime resolution. Electron RunAsNode mode is a shipped execution path; this probe did not attach an inspector or change the app.

**Observed native probe:** a hidden child process with `ELECTRON_RUN_AS_NODE=1`, `DSH_HOME=<work>/persona-build/cli-probe-home`, and args:

```text
<app.asar>/lib/desktop-cli.js --profile persona-probe --from-default-profile sdk --help
```

Exited 0 in approximately two seconds, stderr was empty, SDK stdio help was printed, and only the temporary home's `profiles/persona-probe/package.json` was initialized. Evidence: `native-sdk-help.json`, `native-sdk-help.stdout.txt`, `native-sdk-help.stderr.txt`. This proves CLI resolution/boot-to-help in an isolated home, not model initialization or full integration.

`--profile <name>` selects `$DSH_HOME/profiles/<name>`. `--from-default-profile sdk` initializes/replaces a custom profile from the shipped bundle list; use it only for a new dedicated target, not on every restart. It can replace an existing target profile. `--patch <absolute-path>` is a per-launch overlay; it is not a manual profile edit.

Supported templates in installed app-boot source: `web`, `headless`, `sdk`, `sdk-minimal`, `acp`. SDK is best suited for repeated real-session lifecycle probes without browser access. It inherits base credential management; headless disables managed credentials by default. The adapter must never enable browser access merely to avoid a 403 from the existing server.

Official package operations share `dsh-plugin-manager/operations`. The integration runner uses the installed Desktop package-operation carrier in a hidden Electron RunAsNode child:

```text
<DSH NEXT.exe> <app.asar>/lib/plugin-cli.js <dedicated-test-profile> add <absolute-project-directory>
```

Pass `ELECTRON_RUN_AS_NODE=1` and the intended `DSH_HOME` only to this owned child. This calls the installed shared operation implementation and its bundled package manager. Use supported plugin operations rather than hand-editing profile package/patch files. For production Desktop installation, use its normal plugin manager path and preserve existing profile state. The initial help probe above did not install this project; actual isolated installation results are recorded separately in `host-test-results.md`.

## 8. SDK stdio RPC for the real integration runner

Installed `dsh-sdk-app` starts `dsh-sdk-jsonrpc-server`; stdout carries newline-delimited JSON-RPC 2.0 frames. Stderr is diagnostics. No browser/server port is required. Sources: corresponding README and `dsh-sdk-jsonrpc-server/lib/index.js`.

Exact request shapes from server source:

```js
{jsonrpc:'2.0',id:1,method:'initialize',params:{cwd,provider,model,reasoningEffort?,maxTokens?}}
{jsonrpc:'2.0',id:2,method:'session/prompt',params:{sessionId,contentBlocks:[{type:'text',text}]}}
{jsonrpc:'2.0',id:3,method:'session/wait',params:{sessionId}}
{jsonrpc:'2.0',id:4,method:'session/resume',params:{sessionId}}
{jsonrpc:'2.0',id:5,method:'shutdown',params:{}}
```

Optional-field question marks above are notation, not executable object syntax. Wait for successful initialize before prompt. Initialize resolves exact model capability and waits for the Loader tree, returning `serverInfo.name='deepseek-harness-sdk-runtime'`.

Prompt response `{messageId}` is durable queue receipt, not an answer. Observe `session.event` notifications and actual assistant message events; `session.status` tracks running/idle. `session/wait` waits for root and active managed descendants. Resume reads persisted history but does not replay old notifications. Shutdown disposes the owned runtime; EOF is also a bounded app shutdown path.

The SDK server creates agents with route/cwd and has no per-prompt preset argument in this version. Declaring `registry.default=persona-memory` does **not** automatically mount the preset on these SDK agents. The integration bridge explicitly calls `ctx.agentPresets.select(agent,'persona-memory')` on new SDK agents, and `mount(agent.ctx,'persona-memory')` on restored agents. Production installation must still leave normal coding presets/defaults unchanged.

SDK protocol does not expose prompt cancellation or per-session close; integration cancellation tests should use plugin-owned agent APIs within the isolated engine, and terminate only the child process created by the runner. Use hidden Windows children and retain only their own process handles.

## 9. Source backfill and exact query result shapes

Prefer `ctx.sessionQuery` for history reads; the installed live Session `eventAt/snapshotEvents/ownEvents` methods are marked deprecated for new consumers. `dsh-session-query/lib/index.js:1081–1088,1210–1233` implements:

```js
const full = await ctx.sessionQuery.readSession(sessionId);
// {session: headerClone, inheritedEventCount, events}
const exact = await ctx.sessionQuery.readEvent({sessionId, seq, before:0, after:0}, signal);
// {session: headerClone, inheritedEventCount, target, events, startSeq, endSeq}
```

The header key is **session**, not header. `readSurface` returns the currently effective surface; use raw events for original temporary-process sources. `inheritedEventCount` distinguishes a fork's inherited prefix from its own events so backfill does not manufacture new participant experiences. The query backend may internally load/replay the complete logical log even when only one event/window is returned; bound returned material but measure real IO/CPU cost.

The Web bundle's registry declaration has Loader row id `agent-preset-registry`, module `@deepseek-ai/dsh-agent-preset-registry`, and config `{default:standard}`. Config overrides replace the complete config, not merge fields. A **dedicated test profile** lacking a registry can insert that service with `{default:persona-memory}` along with the persona declaration. If overriding a test registry already present, use an id-targeted patch, not a second insert with duplicate id. Production bundle installation should add the optional preset and leave the existing default alone.

## 10. Inactive target restoration and preset lifecycle

`dsh-agent-loop/lib/index.js:1963–2012` restores an inactive persisted session through the bound service method:

```js
const stored = await ctx.sessionQuery.readSession(sessionId);
const persistedConfig = [...stored.events].reverse()
  .find(event => event.type === 'request/header')?.data?.header?.config;
if (!persistedConfig?.provider || !persistedConfig?.model) {
  throw new Error('The inactive target has no saved model route');
}
const handle = await ctx.agents.resume({
  resumeSessionId: sessionId,
  agentOptions: {
    provider: persistedConfig.provider,
    model: persistedConfig.model,
    ...(persistedConfig.reasoningEffort === undefined ? {} : {reasoningEffort:persistedConfig.reasoningEffort}),
    ...(persistedConfig.maxTokens === undefined ? {} : {maxTokens:persistedConfig.maxTokens}),
  },
  setup: async (scope, agent) => {
    await ctx.agentPresets.mount(scope, 'persona-memory');
  },
});
const agent = handle.agent;
// Keep the handle; dispose only handles this plugin owns.
```

The key is `resumeSessionId`. The host invokes `setup(scope,agent)` before publishing `agent/created`, inside the restored agent's maintenance boundary (`:1915–1953`). Restore the preset with `mount(scope,id)`; `select(agent,id)` is for selecting a new session before its first turn. `dsh-agent-preset-registry/lib/index.js:750–755` rejects `select` whenever the session projection has an open turn or `lastTurn>0`, with code `agent-preset/locked` and message `This session has already started`. A constructor/mock accepting `select` during resume would miss this real host restriction.

Restoring a Session does not restore AgentOptions. `dsh-agent-loop/lib/index.js:1591–1592` resolves the `provider` and `model` prompt variables directly from `context.agent.options`; `prepareRequest` (`:1177–1197`) initially seeds from those options too. SDK server (`dsh-sdk-jsonrpc-server/lib/index.js:321–334`) explicitly supplies its initialize route for both new and resumed SDK agents. A plugin performing cold resume must likewise pass the last saved request route. Passing `{}` reaches native prompt assembly with an undefined model, even though the session log contains a prior request header. Read only the whitelisted non-sensitive route/options fields; never serialize provider configuration or credentials into personality storage.

The plugin must load its own registry/checkpoints before releasing persisted wake or control effects, verify the inactive target belongs to its optional preset, mount only that preset, and preserve the resumed session's saved route. The native integration runner includes a cold timer case that starts a fresh SDK process with only `initialize`, then observes the plugin restoring its previously selected target without an SDK `session/resume` or `session/prompt`. Its result belongs to `host-test-results.md`, not this static API claim.

## Runtime probe checklist

This is the checklist derived from source inspection. Completion evidence, exact code versions, and remaining limits are recorded separately in `host-test-results.md`; the following list is not a claim that every item is still pending or has fully passed.

1. Load the actual local bundle through supported package operations and prove preset composition/import resolution.
2. Initialize the real model route through the host's credential service and complete a dedicated test session; do not print/read keys.
3. Exercise scoped async prompt assembly, raw tool definitions and exec.agent with two interleaved agents.
4. Preserve inbox inputs across reject/sleep, recover them after wake/restart, and verify no duplicate source attribution or delivery.
5. Observe actual model output/terminal reason, pending cancellation, complete-section interactions and sleep/no-output behavior.

Static source establishes exact API and ordering; the integration report must state separately which of these checks actually ran and passed.
