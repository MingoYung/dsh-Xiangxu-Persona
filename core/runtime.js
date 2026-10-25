import { SCHEMA_VERSION, defaultConfig, mergeConfig, validateDecision, observationAllows, newId, emptyRuntime } from './schema.js';
import { detached, freeze, createTokenCounter, buildSnapshot, controlMessages, replyMessages, consolidationMessages, consolidationContextPage, conversationPage } from './prompts.js';
import { createHash } from 'node:crypto';

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const terminal = status => status === 'delivered' || status === 'cancelled';
const canonical = value => value && typeof value === 'object' ? (Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))) : value;
const fingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const compactContext = context => Object.fromEntries(['environment', 'personId', 'sessionId', 'channelId', 'target', 'proactive', 'eventContext']
  .filter(key => own(context, key)).map(key => [key, detached(context[key])]));
const asObject = result => {
  if (typeof result === 'string') return JSON.parse(result.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  if (result?.text && !result.decision && !result.patch) {
    try { return JSON.parse(result.text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); } catch { return result; }
  }
  return result;
};

export class PersonaRuntime {
  constructor({ repository, clock = Date.now, model = {}, host = {}, config = {}, tokenCounter, autoSchedule = true } = {}) {
    if (!repository) throw new TypeError('repository is required');
    this.repository = repository; this.clock = clock; this.model = model; this.host = host;
    this.config = defaultConfig(config); this.tokenCounter = createTokenCounter({ model, host, counter: tokenCounter });
    this.autoSchedule = autoSchedule; this.opened = false; this.closed = false;
    this._serial = Promise.resolve(); this._work = Promise.resolve(); this._tasks = new Set();
    this._controllers = new Map(); this._sending = new Set(); this._effectTasks = new Map(); this._jobTasks = new Map(); this._timer = null; this.errors = [];
  }
  now() { return typeof this.clock === 'function' ? this.clock() : this.clock.now(); }
  _lock(fn) {
    const p = this._serial.then(fn); this._serial = p.catch(() => {}); return p;
  }
  _track(promise) {
    const p = Promise.resolve(promise); this._tasks.add(p);
    p.catch(error => this._report(error)).finally(() => this._tasks.delete(p)); return p;
  }
  _report(error) { this.errors.push({ at: this.now(), message: error.message, code: error.code }); this.errors = this.errors.slice(-50); this.host.onError?.(error); }
  _requireOpen() { if (!this.opened || this.closed) throw new Error('Runtime is not open'); }
  async _refresh() {
    this.state = await this.repository.getRuntime() ?? emptyRuntime(this.now());
    this._stateBase = detached(this.state); return this.state;
  }
  async _save(state) {
    this.state = typeof this.repository.patchRuntime === 'function'
      ? await this.repository.patchRuntime(this._stateBase, state)
      : await this.repository.saveRuntime(state, { expectedVersion: state.version });
    this._stateBase = detached(this.state); return this.state;
  }
  async open() {
    if (this.opened && !this.closed) return this;
    await this.repository.open(); this.closed = false; this.opened = true;
    if (this.repository.config) this.config = defaultConfig(this.repository.config);
    await this._refresh(); await this.reconcileOutbox(); this._schedule();
    for (const record of await this.repository.getOutbox()) if (record.status === 'pending') this._track(this.retryDelivery(record.deliveryId));
    const pendingEffects = Object.values(this.state.execution?.pendingEffects ?? {});
    if (pendingEffects.length) for (const effect of pendingEffects) this._track(this._executeDecisionEffects(effect));
    else if (this.state.execution?.pendingWake) this._track(this._deliverWake(this.state.execution.pendingWake));
    else if (this.state.execution?.pendingControl) this._track(this.retryPendingControl());
    const jobs = Object.values(this.state.execution?.consolidationJobs ?? {});
    for (const job of jobs) if (['queued', 'running'].includes(job.status)) this._track(this._scheduleConsolidationJob(job.jobId, { automatic: true }));
    const selectedCompleted = jobs.find(job => job.jobId === this.state.sleep?.wakeJobId && job.status === 'completed');
    if (selectedCompleted && !this.state.execution?.pendingWake) this._track(this._wakeForCompletedJob(selectedCompleted));
    if (this.state.activeRunId && !jobs.some(job => job.children?.some(child => child.runId === this.state.activeRunId))) {
      const run = await this.repository.getConsolidationRun?.(this.state.activeRunId);
      if (run?.status === 'prepared' && run.reviewState?.status !== 'paused' && !run.reviewState?.callInFlight) this._track(this.consolidate({ ...this._context(), run, personId: run.personId, automatic: true }));
      else await this._lock(async () => { const current = await this._refresh(); current.activeRunId = null; await this._save(current); });
    } else if (!jobs.length && this.state.sleep?.state === 'sleeping' && this.state.sleep.wakeCondition === 'consolidation_complete') {
      if (this.state.sleep.wakeRunId) {
        const legacy = await this.repository.getConsolidationRun?.(this.state.sleep.wakeRunId);
        if (legacy?.status === 'committed') this._track(this.handleSignal({ type: 'consolidation_complete', runId: legacy.runId }));
        else if (legacy?.status === 'prepared' && legacy.reviewState?.status !== 'paused' && !legacy.reviewState?.callInFlight) {
          this._track(this.consolidate({ ...this._context(), run: legacy, personId: legacy.personId, automatic: true }));
        } else if (!legacy || legacy.status === 'failed') this._report(Object.assign(new Error('The legacy selected wake run is missing or invalidated; no replacement work was invented'), { code: legacy ? 'RUN_INVALIDATED' : 'RUN_NOT_FOUND' }));
      } else this._track(this._startConsolidationPlan(this.state.currentDecision?.consolidationPlan ?? { action: 'run' },
        { ...this._context(), sleepDecisionId: this.state.sleep.sleepDecisionId }, this.state.sleep.sleepDecisionId));
    }
    return this;
  }
  async close() {
    this.closed = true; this._clearTimer();
    for (const { controller } of this._controllers.values()) controller.abort();
    await Promise.allSettled([...this._tasks]); await this._serial; await this._work;
    await this.repository.close(); this.opened = false;
  }
  async idle() { while (this._tasks.size) await Promise.allSettled([...this._tasks]); await this._serial; await this._work; }
  _clearTimer() {
    if (this._timer !== null) (this.clock.clearTimeout?.bind(this.clock) ?? clearTimeout)(this._timer);
    this._timer = null;
  }
  _schedule() {
    this._clearTimer(); if (!this.autoSchedule || !this.opened || this.closed) return;
    const state = this.state, decision = state?.currentDecision;
    if (!state) return;
    const candidates = state.sleep?.state === 'sleeping'
      ? (state.sleep.wakeCondition === 'at_time' ? [state.sleep.wakeAt] : [])
      : (state.globalMuted ? [] : [state.schedule?.nextCheckAt, decision?.replyPlan?.replyAt]);
    const times = candidates.filter(x => Number.isFinite(x) && x !== null);
    if (!times.length) return;
    const delay = Math.min(2_147_483_647, Math.max(0, Math.min(...times) - this.now()));
    this._timer = (this.clock.setTimeout?.bind(this.clock) ?? setTimeout)(() => {
      this._timer = null; this._track(this.handleDue());
    }, delay);
    this._timer?.unref?.();
  }
  _context(context = {}) {
    const last = this.state?.execution?.lastContext ?? {};
    const merged = { ...detached(last), ...detached(context) };
    const env = merged.environment ?? {};
    merged.sessionId ??= env.sessionId ?? ''; merged.channelId ??= env.channelId ?? '';
    if (!own(merged, 'personId')) merged.personId = merged.target?.personId ?? null;
    return merged;
  }
  async _targetContext(context, target) {
    const current = this._context(context);
    if (!target?.sessionId || !target?.channelId) return current;
    const sameRoute = current.sessionId === target.sessionId && current.channelId === target.channelId;
    const described = await this.host.describeTarget?.(detached(target));
    if (described && (described.sessionId != null && described.sessionId !== target.sessionId || described.channelId != null && described.channelId !== target.channelId)) {
      throw Object.assign(new Error('The target environment does not match the selected delivery route'), { code: 'TARGET_ENVIRONMENT_MISMATCH' });
    }
    const environment = described ?? (sameRoute ? current.environment : null) ?? { timezone: this.config.timezone };
    const eventContext = current.eventContext ?? compactContext({ environment: current.environment,
      personId: current.personId, sessionId: current.sessionId, channelId: current.channelId });
    return { ...current, target: detached(target), personId: target.personId ?? null,
      sessionId: target.sessionId, channelId: target.channelId,
      environment: { ...detached(environment), sessionId: target.sessionId, channelId: target.channelId },
      ...(!sameRoute || current.personId !== (target.personId ?? null) ? { eventContext } : {}) };
  }
  async accept(input, environment = {}, options = {}) {
    this._requireOpen();
    const result = await this._lock(async () => {
      await this._refresh();
      if (input.role === 'user' && !observationAllows(this.state.currentDecision?.attention,
        { channelId: input.channelId ?? environment.channelId, personId: input.personId ?? null })) return { observed: false, reason: 'outside_selected_attention' };
      const value = await this.repository.ingest(input);
      const state = await this._refresh();
      state.execution = { ...state.execution, lastContext: { environment: detached(environment),
        personId: input.personId ?? null, sessionId: input.sourceSessionId ?? environment.sessionId, channelId: input.channelId ?? environment.channelId } };
      if (!value.duplicate && value.eventId && this.config.consolidationMode === 'on_write') {
        const previous = state.execution.consolidationOpportunity;
        state.execution.consolidationOpportunity = { mode: 'on_write', kind: 'observed_writes', writesObserved: Math.min(Number.MAX_SAFE_INTEGER, (previous?.writesObserved ?? previous?.count ?? 0) + 1),
          firstEventId: previous?.firstEventId ?? value.eventId, lastEventId: value.eventId,
          firstAt: previous?.firstAt ?? this.now(), lastAt: this.now() };
      }
      await this._save(state); return value;
    });
    if (options.decide && result.observed !== false) result.control = await this.handleSignal('new_message', { environment, personId: input.personId ?? null, incoming: result.record });
    return result;
  }
  async decide(input, context = {}) {
    this._requireOpen(); validateDecision(input);
    if (input.sleepPlan?.action === 'sleep' && input.sleepPlan.wakeCondition === 'consolidation_complete' &&
      (input.consolidationPlan?.action === 'defer' || input.consolidationPlan?.targetPersonIds?.length === 0)) {
      throw Object.assign(new Error('consolidation_complete has no selected work; choose a run or another wake condition'), { code: 'CONSOLIDATION_NOT_SELECTED' });
    }
    const operationId = context.operationId ?? (context.controlId ? `${context.controlId}:${fingerprint(input)}` : newId('operation'));
    const persisted = await this._lock(async () => {
      const state = await this._refresh(), previous = state.currentDecision ?? {}, wasSleeping = state.sleep.state === 'sleeping';
      const receipt = state.execution?.effectReceipts?.find(x => x.operationId === operationId);
      if (receipt) return { receipt, state: detached(state) };
      const failed = state.execution?.effectFailures?.find(x => x.operationId === operationId);
      if (failed) throw Object.assign(new Error(failed.error.message), { code: failed.error.code, effectStatus: 'failed', operationId });
      const pending = Object.values(state.execution?.pendingEffects ?? {}).find(x => x.operationId === operationId);
      if (pending) return { pending };
      const identityScope = this._resolveIdentityScope(input.identityPlan, this._context(context));
      await this._validateIdentitySources(input.identityPlan, { ...context, ...identityScope });
      const merged = { ...detached(previous), ...detached(input), schemaVersion: SCHEMA_VERSION,
        decisionId: newId('decision'), decidedAt: this.now(), contextVersion: context.environment?.version ?? context.contextVersion ?? 0,
        srcRefs: detached(context.srcRefs ?? previous.srcRefs ?? []) };
      if (input.identityPlan?.action === 'new') merged.identityPlan = { ...input.identityPlan, personId: input.identityPlan.personId ?? newId('person') };
      validateDecision(merged);
      state.currentDecision = merged;
      state.execution = { ...state.execution, lastContext: compactContext(this._context(context)) };
      if (own(input, 'nextCheckAt')) state.schedule.nextCheckAt = input.nextCheckAt;
      state.schedule.decisionId = merged.decisionId;
      if (own(input, 'replyPlan')) state.schedule.recheckOn = [...(input.replyPlan?.recheckOn ?? [])];
      if (own(input, 'sleepPlan')) {
        const plan = input.sleepPlan;
        if (plan?.action === 'sleep') state.sleep = { state: 'sleeping', sleepDecisionId: merged.decisionId,
          wakeAt: plan.wakeAt ?? null, wakeCondition: plan.wakeCondition ?? null, wakeRunId: null, wakeJobId: null };
        else if (plan?.action === 'wake') state.sleep = { state: 'awake', sleepDecisionId: null, wakeAt: null, wakeCondition: null, wakeRunId: null, wakeJobId: null };
      }
      const effect = { operationId, decision: merged, input: { ...detached(input), ...(input.identityPlan ? { identityPlan: merged.identityPlan } : {}) },
        context: { ...compactContext(this._context(context)), executeReply: context.executeReply, controlId: context.controlId,
          srcRefs: detached(context.srcRefs ?? []), decisionId: merged.decisionId, ...identityScope,
          ...(Array.isArray(context.pendingEventIds) ? { pendingEventIds: detached(context.pendingEventIds) }
            : Array.isArray(context.pending) ? { pendingEventIds: context.pending.map(record => record.eventId).filter(Boolean) } : {}),
          ...(Array.isArray(context.pendingSourceEventIds) ? { pendingSourceEventIds: detached(context.pendingSourceEventIds) }
            : Array.isArray(context.pending) ? { pendingSourceEventIds: context.pending.map(record => record.eventId).filter(Boolean) } : {}),
          ...(context.pending?.some(record => record.fragment) ? { pendingSlices: context.pending.filter(record => record.fragment)
            .map(record => ({ eventId: record.eventId, fragment: detached(record.fragment) })) } : {}) },
        wasSleeping, completed: [], values: {} };
      state.execution.pendingEffects = { ...state.execution.pendingEffects, [merged.decisionId]: effect };
      await this._save(state); return { pending: detached(effect) };
    });
    if (persisted.receipt) return { decision: detached(persisted.receipt.decision), state: persisted.state,
      effects: { duplicate: true, ...(persisted.receipt.identity ? { identity: detached(persisted.receipt.identity) } : {}) }, duplicate: true };
    return this._executeDecisionEffects(persisted.pending);
  }
  _executeDecisionEffects(entry) {
    const id = entry.decision.decisionId;
    if (this._effectTasks.has(id)) return this._effectTasks.get(id);
    const task = (async () => {
      const ctx = { ...this._context(entry.context), ...entry.context }, input = entry.input, effects = { ...entry.values };
      const done = new Set(entry.completed);
      const mark = async (key, value) => {
        effects[key] = value; done.add(key);
        await this._lock(async () => { const state = await this._refresh(), pending = state.execution?.pendingEffects?.[id];
          if (pending) { pending.completed = [...done]; pending.values = detached(effects); await this._save(state); }
        });
      };
      if (input.identityPlan) {
        if (!own(ctx, 'identityRefs')) {
          Object.assign(ctx, this._resolveIdentityScope(entry.decision.identityPlan, ctx));
          await this._lock(async () => { const state = await this._refresh(), pending = state.execution?.pendingEffects?.[id];
            if (pending) { Object.assign(pending.context, { identityRefs: detached(ctx.identityRefs),
              identitySourceSessionIds: detached(ctx.identitySourceSessionIds), identityAffectsCurrent: ctx.identityAffectsCurrent }); await this._save(state); }
          });
        }
        if (!done.has('identity')) {
          try {
            await this._validateIdentitySources(entry.decision.identityPlan, ctx);
            const identity = await this._applyIdentity(entry.decision.identityPlan, ctx);
            await this.host.onIdentity?.(detached(identity), ctx); await mark('identity', identity);
          } catch (error) {
            if (error.sourceReferenceInvalid || ['SOURCE_UNKNOWN', 'SOURCE_REVOKED', 'SOURCE_UNAVAILABLE', 'REVOKED_SOURCE'].includes(error.code)) {
              await this._failDecisionEffects(entry, error);
            }
            throw error;
          }
        }
        if (ctx.identityAffectsCurrent) ctx.personId = effects.identity.personId;
      }
      if (!done.has('notified')) { await this.host.onDecision?.(detached(entry.decision), ctx); await mark('notified', true); }
      this._schedule();
      const selectedConsolidation = input.consolidationPlan ?? (input.sleepPlan?.action === 'sleep' && input.sleepPlan.wakeCondition === 'consolidation_complete' ? { action: 'run' } : null);
      if (selectedConsolidation && !done.has('consolidation')) {
        const work = await this._startConsolidationPlan(selectedConsolidation, { ...ctx,
          sleepDecisionId: input.sleepPlan?.action === 'sleep' ? id : undefined }, id);
        await mark('consolidation', work);
      }
      if (input.sleepPlan?.action === 'wake' && entry.wasSleeping && !done.has('wake')) await mark('wake', await this._wake({ ...ctx, deferControl: Boolean(input.replyPlan) || ctx.executeReply === false }));
      if (input.retrievePlan?.action === 'search' && !done.has('retrieval')) await mark('retrieval', await this.search(input.retrievePlan, ctx));
      const plan = input.replyPlan;
      if (plan?.action === 'reply' && ctx.executeReply !== false && (plan.replyAt == null || plan.replyAt <= this.now()) && !done.has('reply')) {
        await mark('reply', await this._reply({ ...ctx, deliveryId: `delivery_${id}`, replyPlanFingerprint: fingerprint(plan), target: plan.target ?? ctx.target,
          pendingSourceEventIds: ctx.pendingSourceEventIds ?? ctx.pendingEventIds, pendingEventIds: ctx.pendingEventIds ?? plan.pendingEventIds ?? [], proactive: ctx.proactive ?? false }));
      }
      await this._lock(async () => { const state = await this._refresh();
        delete state.execution.pendingEffects[id];
        state.execution.effectReceipts = [...(state.execution.effectReceipts ?? []), { operationId: entry.operationId, decision: entry.decision, identity: effects.identity ?? null }].slice(-16);
        if (ctx.controlId && state.execution.pendingControl?.controlId === ctx.controlId) delete state.execution.pendingControl;
        await this._save(state);
      });
      return { decision: detached(entry.decision), state: detached(this.state), effects };
    })();
    this._effectTasks.set(id, task); task.finally(() => this._effectTasks.delete(id)).catch(() => {}); return task;
  }
  _resolveIdentityScope(plan, context) {
    if (!plan) return {};
    const visible = context.srcRefs ?? [], current = visible.filter(ref => ref.sourceSessionId === context.sessionId);
    const identityRefs = detached(plan.sourceRefs ?? (context.sessionId ? current : visible));
    const identitySourceSessionIds = identityRefs.length ? [...new Set(identityRefs.map(ref => ref.sourceSessionId))]
      : context.sessionId ? [context.sessionId] : [];
    return { identityRefs, identitySourceSessionIds, identityAffectsCurrent: !identityRefs.length || identitySourceSessionIds.includes(context.sessionId) };
  }
  async _validateIdentitySources(plan, context) {
    if (!plan || typeof this.repository.validateSourceRefs !== 'function') return;
    const refs = context.identityRefs ?? this._resolveIdentityScope(plan, context).identityRefs;
    try { await this.repository.validateSourceRefs(refs, { requireOriginal: plan.action !== 'unknown' }); }
    catch (error) { if (error.code === 'SCHEMA_INVALID') error.sourceReferenceInvalid = true; throw error; }
  }
  async _failDecisionEffects(entry, error) {
    await this._lock(async () => {
      const state = await this._refresh(), pending = state.execution?.pendingEffects?.[entry.decision.decisionId];
      if (!pending) return;
      delete state.execution.pendingEffects[entry.decision.decisionId];
      state.execution.effectFailures = [...(state.execution.effectFailures ?? []).filter(failed => failed.operationId !== entry.operationId), {
        operationId: entry.operationId, decisionId: entry.decision.decisionId, status: 'failed', failedAt: this.now(),
        completed: pending.completed ?? [], error: { code: error.code ?? 'SOURCE_REFERENCE_INVALID', message: error.message },
      }].slice(-16);
      await this._save(state);
    });
  }
  async _applyIdentity(plan, context) {
    const person = plan.action === 'unknown' ? { personId: null } : plan.action === 'new' ? await this.repository.upsertPerson({ personId: plan.personId, displayName: plan.displayName ?? null })
      : await this.repository.upsertPerson({ personId: plan.personId, ...(plan.displayName ? { displayName: plan.displayName } : {}) });
    for (const ref of person.personId ? context.identityRefs ?? [] : []) await this.repository.assign({ ...ref, personId: person.personId,
      reason: plan.reason ?? '', environmentVersion: context.environment?.version ?? 0 });
    await this._lock(async () => {
      const state = await this._refresh();
      if (context.identityAffectsCurrent && state.execution?.lastContext?.sessionId === context.sessionId) {
        state.execution = { ...state.execution, lastContext: { ...state.execution.lastContext, personId: person.personId } }; await this._save(state);
      }
    });
    return person;
  }
  _person(context) { return own(context, 'personId') ? context.personId : this.state?.execution?.lastContext?.personId; }
  async search(input, context = {}) { return this.repository.search(input, { personId: this._person(context) }); }
  async forget(input, context = {}) { return this.repository.forget(input, { personId: this._person(context) }); }
  async introspect(input = {}, context = {}) { return this.repository.introspect(input, { personId: this._person(context) }); }
  async compose(context = {}) {
    this._requireOpen(); const state = detached(await this.repository.getRuntime()), ctx = { ...this._context(context) };
    const material = await this.repository.getContext({ personId: ctx.personId });
    if (!own(ctx, 'capacity') && typeof this.repository.getCapacity === 'function') {
      try { ctx.capacity = this._capacityFacts(await this.repository.getCapacity(), state); }
      catch (error) {
        ctx.capacity = { available: false, errorCode: typeof error.code === 'string' ? error.code.slice(0, 128) : 'CAPACITY_UNAVAILABLE' };
        const diagnostic = Object.assign(new Error(`Capacity facts unavailable: ${String(error.message ?? error).slice(0, 512)}`), { code: 'CAPACITY_UNAVAILABLE' });
        // A diagnostic callback cannot turn an unavailable optional fact into a chat rejection.
        try { this._report(diagnostic); } catch {}
      }
    } else if (ctx.capacity != null) ctx.capacity = this._capacityFacts(ctx.capacity, state);
    const plan = ctx.retrievePlan ?? state.currentDecision?.retrievePlan;
    if (!own(ctx, 'memories')) ctx.memories = plan?.action === 'search' ? (await this.repository.search(plan, { personId: ctx.personId })).items : [];
    const snapshot = await buildSnapshot({ context: ctx, material, state, config: this.config, now: this.now(), counter: this.tokenCounter });
    await this.repository.saveSnapshot(detached(snapshot)); return snapshot;
  }
  _capacityFacts(value, state) {
    if (!value || typeof value !== 'object' || value.available === false) return { available: false,
      errorCode: typeof value?.errorCode === 'string' ? value.errorCode.slice(0, 128) : 'CAPACITY_UNAVAILABLE' };
    const number = name => Number.isFinite(value[name]) && value[name] >= 0 ? value[name] : null;
    return { persistentChars: number('persistentChars'), longTermTargetChars: number('longTermTargetChars'),
      hotChars: number('hotChars'), tempTargetChars: number('tempTargetChars'), physicalBytes: number('physicalBytes'),
      storeBytes: number('storeBytes') ?? this.config.capacityLimits?.storeBytes ?? null,
      pressure: Object.fromEntries(['longTerm', 'hot', 'disk'].map(key => [key, typeof value.pressure?.[key] === 'boolean' ? value.pressure[key] : null])),
      memoryGapCount: number('memoryGapCount') ?? (state.memoryGaps ?? []).filter(gap => gap.resolvedAt == null).length };
  }
  async _call(purpose, messages, extra = {}) {
    const startedAt = this.now(), requestId = newId('model');
    const controller = new AbortController(); this._controllers.set(requestId, { controller, proactive: Boolean(extra.context?.proactive) });
    try {
      if (typeof this.model.complete !== 'function' && typeof this.model !== 'function') throw new Error('model.complete port is required');
      const call = typeof this.model === 'function' ? this.model : this.model.complete.bind(this.model);
      const limits = this._processing(), inputTokens = await this.tokenCounter.count(JSON.stringify(messages));
      const inputBudget = this._inputBudget();
      if (inputTokens > inputBudget) {
        const error = new Error('Selected model input exceeds the supplied model input budget; no source was consumed');
        error.code = 'MODEL_INPUT_BUDGET'; throw error;
      }
      const maxOutputTokens = purpose === 'consolidation' ? limits.consolidationOutputTokens : purpose === 'control' ? limits.controlOutputTokens : limits.replyOutputTokens;
      const response = await call({ purpose, messages, ...extra, requestId, signal: controller.signal, maxOutputTokens });
      await this.repository.recordUsage({ requestId, purpose, startedAt, finishedAt: this.now(), model: response?.model ?? null,
        usage: detached(response?.usage ?? null), observed: response?.usage != null, error: null });
      return response;
    } catch (error) {
      await this.repository.recordUsage({ requestId, purpose, startedAt, finishedAt: this.now(), model: error.model ?? null,
        usage: detached(error.usage ?? null), observed: error.usage != null, error: error.message });
      throw error;
    } finally { this._controllers.delete(requestId); }
  }
  async _requestControl(context = {}) {
    if (this.closed) return { status: 'closed' };
    const state = await this.repository.getRuntime();
    const selectedTarget = own(context, 'target') ? context.target
      : ['reply_due', 'recheck_due'].includes(context.reason) ? state.currentDecision?.replyPlan?.target : null;
    const ctx = selectedTarget ? await this._targetContext(context, selectedTarget) : this._context(context);
    ctx.pending ??= await this.repository.getPending({ personId: ctx.personId });
    ctx.identityClues ??= await this.repository.listPeople();
    if (state.sleep.state === 'sleeping') return { status: 'sleeping' };
    if (ctx.proactive && state.globalMuted) return { status: 'muted' };
    const controlId = context.pendingControlId ?? newId('control');
    ctx.controlId = controlId;
    await this._lock(async () => { const current = await this._refresh(); current.execution = { ...current.execution,
      pendingControl: { controlId, reason: ctx.reason ?? null, context: compactContext(ctx) } }; await this._save(current); });
    const snapshot = await this.compose(ctx);
    const page = await conversationPage(snapshot, ctx, { purpose: 'control', counter: this.tokenCounter,
      maxTokens: this._inputBudget(),
      offsets: state.execution?.pendingOffsets ?? {} });
    ctx.pending = page.records;
    ctx.pendingPage = { completeEventIds: page.completeEventIds, progress: page.progress, total: page.total, remaining: page.remaining, tokens: page.tokens };
    let answer;
    if (this.host.requestDecision) {
      const result = await this.host.requestDecision({ ...ctx, snapshot, currentDecision: state.currentDecision });
      if (!result || result.queued) return { status: 'queued' };
      answer = await this.decide(asObject(result)?.decision ?? asObject(result), ctx);
    } else {
      const raw = await this._call('control', page.messages, { context: ctx });
      const result = asObject(raw); answer = await this.decide(result?.decision ?? result, ctx);
    }
    await this._ackPendingPage(page, false);
    await this._lock(async () => { const current = await this._refresh();
      if (current.execution?.pendingControl?.controlId === controlId) { delete current.execution.pendingControl; await this._save(current); }
    });
    return { ...answer, pendingPage: { completeEventIds: page.completeEventIds, remaining: page.remaining } };
  }
  async _ackPendingPage(page, clearComplete) {
    await this._lock(async () => { const state = await this._refresh(); state.execution = { ...state.execution, pendingOffsets: { ...state.execution?.pendingOffsets } };
      for (const [id, offset] of Object.entries(page?.progress ?? {})) {
        if (offset === null) delete state.execution.pendingOffsets[id]; else state.execution.pendingOffsets[id] = Math.max(offset, state.execution.pendingOffsets[id] ?? 0);
      }
      await this._save(state);
    });
    if (clearComplete) await this.repository.clearPending(page.completeEventIds ?? []);
  }
  async acknowledgePendingPage(page, { clearComplete = true } = {}) { await this._ackPendingPage(page, clearComplete); return { accepted: true, eventIds: clearComplete ? page.completeEventIds ?? [] : [] }; }
  async retryPendingControl() {
    const pending = (await this.repository.getRuntime()).execution?.pendingControl;
    if (!pending) return { status: 'none_pending' };
    return this._requestControl({ ...pending.context, reason: pending.reason, pendingControlId: pending.controlId });
  }
  async handleDue(context = {}) {
    this._requireOpen();
    const action = await this._lock(async () => {
      const state = await this._refresh(), now = this.now();
      if (state.sleep.state === 'sleeping') return state.sleep.wakeCondition === 'at_time' && state.sleep.wakeAt != null && state.sleep.wakeAt <= now ? 'wake' : null;
      if (state.globalMuted) return null;
      const check = state.schedule.nextCheckAt != null && state.schedule.nextCheckAt <= now;
      const reply = state.currentDecision?.replyPlan?.replyAt != null && state.currentDecision.replyPlan.replyAt <= now;
      if (!check && !reply) return null;
      if (check) state.schedule.nextCheckAt = null;
      if (check && state.currentDecision) state.currentDecision.nextCheckAt = null;
      if (reply) state.currentDecision.replyPlan.replyAt = null;
      await this._save(state); return reply ? 'reply_due' : 'recheck_due';
    });
    let result = { status: 'not_due' };
    try {
      if (action === 'wake') result = await this._wake({ ...context, reason: 'selected_wake_time' });
      else if (action) result = await this._requestControl({ ...context, reason: action, proactive: true });
      return result;
    } finally { this._schedule(); }
  }
  async handleSignal(signal, context = {}) {
    this._requireOpen(); const type = typeof signal === 'string' ? signal : signal.type;
    await this._lock(async () => { await this._refresh(); });
    if (this.state.sleep.state === 'sleeping') {
      if (type === 'explicit_wake') return this._wake({ ...context, reason: type });
      if (type === 'consolidation_complete' && this.state.sleep.wakeCondition === 'consolidation_complete' && !this.state.sleep.wakeJobId && signal.runId && signal.runId === this.state.sleep.wakeRunId) return this._wake({ ...context, reason: type });
      return { status: 'sleeping' };
    }
    const plan = this.state.currentDecision?.replyPlan;
    const triggers = plan?.recheckOn ?? this.state.schedule?.recheckOn ?? [];
    if (!this.state.currentDecision || triggers.includes(type)) return this._requestControl({ ...context, reason: type, proactive: context.proactive ?? false });
    return { status: 'listening', triggers: detached(triggers) };
  }
  async _wake(context) {
    const pending = await this.repository.getPending();
    const ctx = this._context(context), snapshot = await this.compose(ctx);
    const page = await conversationPage(snapshot, { ...ctx, pending }, { purpose: 'control', counter: this.tokenCounter,
      maxTokens: this._inputBudget(),
      offsets: this.state.execution?.pendingOffsets ?? {} });
    const key = x => JSON.stringify([x.personId, x.channelId, x.sourceSessionId]);
    const totalGroups = Object.groupBy(pending, key);
    const groups = Object.values(Object.groupBy(page.records, key)).map(records => ({
      personId: records[0].personId, channelId: records[0].channelId, sessionId: records[0].sourceSessionId,
      totalCount: totalGroups[key(records[0])].length, records }));
    const wake = { wakeId: newId('wake'), groups, totalCount: pending.length, remainingCount: page.remaining,
      pendingEventIds: page.completeEventIds, pendingPage: { completeEventIds: page.completeEventIds, progress: page.progress, total: page.total, remaining: page.remaining }, context: ctx };
    await this._lock(async () => {
      const state = await this._refresh(); state.sleep = { state: 'awake', sleepDecisionId: null, wakeAt: null, wakeCondition: null, wakeRunId: null, wakeJobId: null };
      if (state.currentDecision) delete state.currentDecision.sleepPlan;
      state.execution = { ...state.execution, pendingWake: wake }; await this._save(state);
    });
    this._schedule(); return this._deliverWake(wake);
  }
  async _deliverWake(wake) {
    if (this.closed) return { status: 'closed' };
    const accepted = await this.host.onWake?.(detached(wake));
    if (!accepted?.accepted && wake.context.deferControl) return { status: 'pending_wake', wakeId: wake.wakeId, groups: detached(wake.groups) };
    const result = accepted?.accepted ? accepted : await this._requestControl({ ...wake.context, reason: 'wake', wakeSummary: wake.groups, pending: wake.groups.flatMap(x => x.records), proactive: false });
    if (result.status !== 'queued' && result.status !== 'closed') {
      await this.acknowledgeWake(wake.wakeId);
    }
    return result;
  }
  async acknowledgeWake(wakeId) {
    const wake = (await this.repository.getRuntime()).execution?.pendingWake;
    if (!wake || wake.wakeId !== wakeId) return { accepted: false };
    if (wake.pendingPage) await this._ackPendingPage(wake.pendingPage, false);
    await this.repository.clearPending(wake.pendingEventIds);
    await this._lock(async () => { const state = await this._refresh();
      if (state.execution?.pendingWake?.wakeId === wakeId) { delete state.execution.pendingWake; await this._save(state); }
    });
    return { accepted: true, wakeId };
  }
  async _reply(context) {
    if (context.deliveryId) {
      const existing = (await this.repository.getOutbox()).find(x => x.deliveryId === context.deliveryId);
      if (existing) return existing.status === 'pending' ? this.retryDelivery(existing.deliveryId)
        : existing.status === 'delivered' && existing.projectionPending ? this.acknowledgeDelivery(existing.deliveryId) : existing;
    }
    const state = await this.repository.getRuntime();
    if (context.replyPlanFingerprint && fingerprint(state.currentDecision?.replyPlan ?? null) !== context.replyPlanFingerprint) return { status: 'superseded' };
    if (state.sleep.state === 'sleeping' || (context.proactive && state.globalMuted)) return { status: state.sleep.state === 'sleeping' ? 'sleeping' : 'muted' };
    const ctx = context.target ? await this._targetContext(context, context.target) : this._context(context);
    if (!own(ctx, 'pending')) {
      if (Array.isArray(ctx.pendingSourceEventIds)) {
        if (typeof this.repository.readSources === 'function') ctx.pending = await this.repository.readSources({ eventIds: ctx.pendingSourceEventIds });
        else { const selected = new Set(ctx.pendingSourceEventIds); ctx.pending = (await this.repository.getPending()).filter(record => selected.has(record.eventId)); }
      } else ctx.pending = await this.repository.getPending({ personId: ctx.personId });
    }
    const slices = new Map((ctx.pendingSlices ?? []).map(source => [source.eventId, source.fragment]));
    if (slices.size) ctx.pending = ctx.pending.map(record => {
      const slice = slices.get(record.eventId); if (!slice) return record;
      const selected = { ...record, text: Array.from(record.text).slice(slice.from, slice.to).join(''), chars: slice.to - slice.from };
      delete selected.fragment; return selected;
    });
    const snapshot = await this.compose(ctx);
    const page = ctx.pendingPrepared ? ctx.pendingPage : await conversationPage(snapshot, ctx, { purpose: 'reply', counter: this.tokenCounter,
      maxTokens: this._inputBudget(),
      offsets: Array.isArray(ctx.pendingSourceEventIds) ? {} : state.execution?.pendingOffsets ?? {} });
    if (slices.size && !ctx.pendingPrepared) {
      page.records = page.records.map(record => {
        const slice = slices.get(record.eventId); if (!slice) return record;
        const local = record.fragment ?? { from: 0, to: slice.to - slice.from, complete: true };
        const fragment = { from: slice.from + local.from, to: slice.from + local.to, total: slice.total,
          complete: local.complete && (slice.complete ?? slice.to >= slice.total) };
        page.progress[record.eventId] = fragment.complete ? null : fragment.to;
        if (!fragment.complete) page.completeEventIds = page.completeEventIds.filter(id => id !== record.eventId);
        return { ...record, fragment };
      });
      page.remaining = Math.max(0, page.total - page.completeEventIds.length);
    }
    const replyContext = { ...ctx, pending: page.records, pendingPageInfo: { total: page.total, remaining: page.remaining } };
    const raw = await this._call('reply', replyMessages(snapshot, replyContext), { context: replyContext });
    const text = typeof raw === 'string' ? raw : raw?.text;
    if (typeof text !== 'string') throw new Error('Reply model did not return text');
    if (context.replyPlanFingerprint && fingerprint((await this.repository.getRuntime()).currentDecision?.replyPlan ?? null) !== context.replyPlanFingerprint) return { status: 'superseded' };
    const intended = ctx.pendingEventIds ?? page.completeEventIds;
    const delivered = await this.deliver(text, { ...ctx, snapshot, pendingEventIds: intended.filter(id => page.completeEventIds.includes(id)) });
    await this._ackPendingPage(page, false); return delivered;
  }
  async deliver(text, context = {}) {
    this._requireOpen(); const ctx = this._context(context), decision = this.state.currentDecision;
    const target = ctx.target ?? decision?.replyPlan?.target;
    if (!target?.channelId || !target?.sessionId) return { status: 'needs_target' };
    const record = { schemaVersion: SCHEMA_VERSION, deliveryId: ctx.deliveryId ?? newId('delivery'),
      decisionId: ctx.decisionId ?? decision?.decisionId ?? newId('decision'), proactiveId: ctx.proactive ? ctx.proactiveId ?? newId('proactive') : null,
      target: detached(target), text, status: 'pending', submittedAt: null, deliveredAt: null, receiptId: null,
      pendingEventIds: detached(ctx.pendingEventIds ?? decision?.replyPlan?.pendingEventIds ?? []) };
    const reserved = await this._lock(async () => {
      const records = await this.repository.getOutbox(), existing = records.find(x => x.deliveryId === record.deliveryId);
      if (existing) return { existing };
      records.push(record); await this.repository.saveOutbox(records); return { existing: null };
    });
    if (reserved.existing) {
      if (!ctx.retryPending || reserved.existing.status !== 'pending') return detached(reserved.existing);
      Object.assign(record, reserved.existing);
    }
    if (this._sending.has(record.deliveryId)) return detached(record);
    this._sending.add(record.deliveryId);
    try {
    const state = await this.repository.getRuntime();
    if (state.sleep.state === 'sleeping' || (record.proactiveId && state.globalMuted)) {
      record.status = 'cancelled'; await this._updateOutbox(record); return { ...record, blockedBy: state.sleep.state === 'sleeping' ? 'sleeping' : 'muted' };
    }
    if (!this.host.deliver) throw new Error('host.deliver port is required');
    record.status = 'submitted'; record.submittedAt = this.now(); await this._updateOutbox(record);
    const beforeSubmit = await this.repository.getRuntime();
    if (beforeSubmit.sleep.state === 'sleeping' || (record.proactiveId && beforeSubmit.globalMuted)) {
      record.status = 'cancelled'; await this._updateOutbox(record); return record;
    }
    try {
      const receipt = await this.host.deliver({ ...detached(record), snapshot: ctx.snapshot, signal: ctx.signal });
      const result = await this.acknowledgeDelivery(record.deliveryId, receipt ?? { status: 'unknown' });
      if (result.status === 'delivered') await this.repository.clearPending(ctx.pendingEventIds ?? decision?.replyPlan?.pendingEventIds ?? []);
      return result;
    } catch (error) {
      const latest = (await this.repository.getOutbox()).find(x => x.deliveryId === record.deliveryId);
      if (latest?.status !== 'delivered') await this._updateOutbox({ ...(latest ?? record), status: 'unknown' });
      throw error;
    }
    } finally { this._sending.delete(record.deliveryId); }
  }
  async _updateOutbox(record) {
    return this._lock(async () => { const list = await this.repository.getOutbox(), i = list.findIndex(x => x.deliveryId === record.deliveryId);
      if (i < 0) list.push(detached(record)); else list[i] = detached(record); await this.repository.saveOutbox(list); return record; });
  }
  async acknowledgeDelivery(deliveryId, receipt = {}) {
    const record = (await this.repository.getOutbox()).find(x => x.deliveryId === deliveryId);
    if (!record) throw new Error(`Unknown delivery ${deliveryId}`);
    if (record.status === 'delivered' && !record.projectionPending && !receipt.sourceEventId && !receipt.receiptId) return record;
    if (record.status === 'cancelled' && receipt.status !== 'delivered') return record;
    const status = record.status === 'delivered' ? 'delivered' : ['submitted', 'delivered', 'cancelled', 'unknown'].includes(receipt.status) ? receipt.status : 'unknown';
    Object.assign(record, { status, receiptId: receipt.receiptId ?? record.receiptId });
    if (status === 'delivered') {
      record.deliveredAt = receipt.deliveredAt ?? record.deliveredAt ?? this.now();
      if (typeof receipt.text === 'string') record.text = receipt.text;
      record.deliverySource = { sourceSessionId: receipt.sourceSessionId ?? record.deliverySource?.sourceSessionId ?? record.target.sessionId,
        sourceEventId: receipt.sourceEventId ?? record.deliverySource?.sourceEventId ?? receipt.receiptId ?? record.receiptId ?? null,
        sourceKind: receipt.sourceKind ?? record.deliverySource?.sourceKind ?? 'delivery_receipt' };
      record.projectionPending = true;
    }
    await this._updateOutbox(record);
    if (status === 'delivered') await this.repository.clearPending(record.pendingEventIds ?? []);
    if (status === 'delivered' && record.deliverySource?.sourceEventId) {
      const projected = await this.repository.ingest({
      ...record.deliverySource, contentClass: 'participant_dialogue', channelId: record.target.channelId,
      personId: record.target.personId, speakerId: null, role: 'assistant', origin: record.proactiveId ? 'ai_initiated' : 'ai_reply',
      text: record.text, proactiveId: record.proactiveId, sourceAt: record.deliveredAt, observedAt: this.now(), timezone: this.config.timezone });
      record.projectionPending = Boolean(projected.gap); record.projectionGap = projected.gap ?? null;
    } else if (status === 'delivered') {
      record.projectionPending = false; record.projectionGap = 'source_receipt_unavailable';
    }
    if (status === 'delivered') await this._updateOutbox(record);
    return detached(record);
  }
  async retryDelivery(deliveryId) {
    const record = (await this.repository.getOutbox()).find(x => x.deliveryId === deliveryId);
    if (!record || record.status !== 'pending') return record ?? { status: 'not_found' };
    return this.deliver(record.text, { target: record.target, deliveryId, proactive: Boolean(record.proactiveId),
      proactiveId: record.proactiveId, pendingEventIds: record.pendingEventIds, retryPending: true });
  }
  async reconcileOutbox() {
    const result = [];
    for (const record of await this.repository.getOutbox()) {
      if (record.status === 'delivered' && record.projectionPending) { result.push(await this.acknowledgeDelivery(record.deliveryId)); continue; }
      if (terminal(record.status) || record.status === 'pending') continue;
      const receipt = await this.host.reconcileDelivery?.(detached(record));
      result.push(await this.acknowledgeDelivery(record.deliveryId, receipt ?? { status: 'unknown' }));
    }
    return result;
  }
  async stopProactive() {
    this._requireOpen(); await this._lock(async () => { const state = await this._refresh(); state.globalMuted = true; await this._save(state); });
    this._clearTimer();
    for (const { controller, proactive } of this._controllers.values()) if (proactive) controller.abort();
    for (const record of await this.repository.getOutbox()) {
      if (!record.proactiveId || terminal(record.status)) continue;
      if (record.status === 'pending') await this._updateOutbox({ ...record, status: 'cancelled' });
      else {
        const receipt = await this.host.cancelDelivery?.(detached(record));
        await this.acknowledgeDelivery(record.deliveryId, receipt ?? { status: 'unknown' });
      }
    }
    return detached(this.state);
  }
  async resumeProactive() { await this._lock(async () => { const state = await this._refresh(); state.globalMuted = false; await this._save(state); }); this._schedule(); return detached(this.state); }
  async updateConfig(partial) { const stored = await this.repository.updateConfig(partial); this.config = detached(stored); this._schedule(); return detached(this.config); }
  _processing() {
    return { consolidationInputChars: 16000, consolidationRequestTokens: 32768, consolidationContextChars: 4000,
      consolidationOutputTokens: 16384, controlOutputTokens: 4096, replyOutputTokens: 4096,
      consolidationCallsPerSegment: 8, maxQueuedConsolidations: 8, maxTargetsPerJob: 8, ...this.config.processingLimits };
  }
  _inputBudget() {
    return Math.min(this._processing().consolidationRequestTokens, Number.isFinite(this.model.maxInputTokens) ? this.model.maxInputTokens : Infinity);
  }
  async _saveJob(job) {
    return this._lock(async () => {
      const state = await this._refresh(); state.execution = { ...state.execution, consolidationJobs: { ...state.execution?.consolidationJobs, [job.jobId]: detached(job) } };
      const jobs = Object.values(state.execution.consolidationJobs), terminalJobs = jobs.filter(value => ['completed', 'no_work', 'invalidated'].includes(value.status));
      const retain = Math.max(0, this.config.retention?.snapshotMaxRequests ?? 50);
      for (const old of terminalJobs.slice(0, Math.max(0, terminalJobs.length - retain))) if (old.jobId !== job.jobId) delete state.execution.consolidationJobs[old.jobId];
      await this._save(state); return detached(job);
    });
  }
  async _startConsolidationPlan(plan, context, decisionId) {
    if (plan.action === 'defer') return { status: 'deferred', decisionId };
    const targets = [...new Set(plan.targetPersonIds ?? [context.personId ?? null, null])];
    if (!targets.length) return { status: 'no_work', decisionId, targetPersonIds: [] };
    if (targets.length > this._processing().maxTargetsPerJob) throw Object.assign(new Error('The selected target count exceeds the configured work fan-out capacity; no target was silently omitted'), { code: 'CONSOLIDATION_TARGET_CAPACITY' });
    let schedule = false;
    const job = await this._lock(async () => {
      const state = await this._refresh(), jobs = state.execution?.consolidationJobs ?? {}, jobId = `job_${decisionId}`;
      if (jobs[jobId]) return detached(jobs[jobId]);
      const knownPeople = new Set((await this.repository.listPeople()).filter(Boolean).map(person => person.personId));
      const unknownTarget = targets.find(personId => personId !== null && !knownPeople.has(personId));
      if (unknownTarget !== undefined) throw Object.assign(new Error(`The selected person does not exist: ${unknownTarget}`),
        { code: 'UNKNOWN_PERSON_TARGET', personId: unknownTarget });
      for (const old of Object.values(jobs)) if (old.status === 'paused') {
        for (const child of old.children) if (child.runId && child.status !== 'committed') {
          const manifest = await this.repository.getConsolidationRun(child.runId);
          if (!manifest || manifest.status === 'failed') { old.status = 'invalidated'; old.error = { code: manifest ? 'RUN_INVALIDATED' : 'RUN_NOT_FOUND', message: 'A selected child is no longer executable' }; break; }
        }
      }
      const paused = Object.values(jobs).find(value => value.status === 'paused' && fingerprint(value.targets) === fingerprint(targets));
      if (paused) { paused.status = 'queued'; paused.resumedByDecisionId = decisionId; paused.segmentCallsUsed = 0; delete paused.error;
        paused.context = compactContext(context); paused.sleepDecisionId = context.sleepDecisionId ?? paused.sleepDecisionId;
        if (context.sleepDecisionId && state.sleep.sleepDecisionId === context.sleepDecisionId && state.sleep.wakeCondition === 'consolidation_complete') state.sleep.wakeJobId = paused.jobId;
        schedule = true;
        state.execution = { ...state.execution, consolidationJobs: jobs }; await this._save(state); return detached(paused); }
      if (Object.values(jobs).filter(value => !['completed', 'no_work', 'invalidated'].includes(value.status)).length >= this._processing().maxQueuedConsolidations) {
        throw Object.assign(new Error('The bounded consolidation queue is full; no new work was created'), { code: 'CONSOLIDATION_QUEUE_CAPACITY' });
      }
      const next = { jobId, decisionId, status: 'queued', createdAt: this.now(), targets, context: compactContext(context),
        sleepDecisionId: context.sleepDecisionId ?? null, segmentCallsUsed: 0,
        children: targets.map(personId => ({ personId, runId: null, status: 'queued' })) };
      state.execution = { ...state.execution, consolidationJobs: { ...jobs, [jobId]: next } };
      if (context.sleepDecisionId && state.sleep.sleepDecisionId === context.sleepDecisionId && state.sleep.wakeCondition === 'consolidation_complete') state.sleep.wakeJobId = jobId;
      schedule = true; await this._save(state); return detached(next);
    });
    if (schedule && !['completed', 'no_work'].includes(job.status)) this._track(this._scheduleConsolidationJob(job.jobId));
    return { jobId: job.jobId, status: job.status, targetPersonIds: job.targets };
  }
  _scheduleConsolidationJob(jobId, options = {}) {
    if (this._jobTasks.has(jobId)) return this._jobTasks.get(jobId);
    const task = this._work.then(() => this._runConsolidationJob(jobId, options)); this._work = task.catch(() => {});
    this._jobTasks.set(jobId, task); task.finally(() => this._jobTasks.delete(jobId)).catch(() => {}); return task;
  }
  async _runConsolidationJob(jobId, { automatic = false } = {}) {
    let job = detached((await this.repository.getRuntime()).execution?.consolidationJobs?.[jobId]);
    if (!job || ['completed', 'no_work', 'paused', 'invalidated'].includes(job.status)) return job;
    const budget = { used: automatic ? job.segmentCallsUsed ?? 0 : 0, limit: this._processing().consolidationCallsPerSegment };
    job.status = 'running'; await this._saveJob(job);
    // Freeze each selected target before the first model call. Actual incoming
    // participant records use the same runtime lock, so later arrivals remain
    // outside all manifests of this selected work segment.
    try { await this._lock(async () => {
      const state = await this._refresh();
      for (const child of job.children) if (!child.runId) {
        const prepared = await this.repository.prepareConsolidation({ personId: child.personId, maxInputChars: this._processing().consolidationInputChars });
        child.runId = prepared.runId; child.status = 'prepared';
      }
      state.execution.consolidationJobs[jobId] = detached(job); await this._save(state);
    }); } catch (error) { job.status = 'paused'; job.error = { code: error.code ?? 'CONSOLIDATION_PREPARE_FAILED', message: error.message }; await this._saveJob(job); return job; }
    for (const child of job.children) {
      if (child.status === 'committed') continue;
      if (this.closed) { job.status = 'paused'; job.error = { code: 'RUNTIME_CLOSED', message: 'Work is retained for explicit continuation' }; break; }
      try {
        const existing = await this.repository.getConsolidationRun(child.runId);
        if (!existing) throw Object.assign(new Error('The selected child manifest is missing; no replacement input was prepared'), { code: 'RUN_NOT_FOUND' });
        if (automatic && (existing?.reviewState?.status === 'paused' || existing?.reviewState?.callInFlight)) {
          job.status = 'paused'; job.error = { code: existing.reviewState.callInFlight ? 'MODEL_OUTCOME_UNKNOWN' : existing.reviewState.pauseReason,
            message: 'The selected run needs an explicit continuation; no model retry was started' }; break;
        }
        const result = await this._consolidate({ ...job.context, personId: child.personId, run: existing, automatic, segmentBudget: budget });
        child.status = result.committed ? 'committed' : 'paused'; child.modelCalls = result.modelCalls ?? result.run?.reviewState?.modelCalls ?? child.modelCalls ?? 0;
        job.segmentCallsUsed = budget.used;
        if (!result.committed) { job.status = 'paused'; job.error = { code: result.pauseReason ?? 'CONSOLIDATION_PAUSED', message: 'Selected input remains unconsumed' }; break; }
        await this._saveJob(job);
      } catch (error) { child.status = ['RUN_INVALIDATED', 'RUN_NOT_FOUND', 'SOURCE_REVOKED'].includes(error.code) ? 'invalidated' : 'paused';
        job.status = child.status === 'invalidated' ? 'invalidated' : 'paused'; job.segmentCallsUsed = budget.used;
        job.error = { code: error.code ?? 'CONSOLIDATION_FAILED', message: error.message }; break; }
    }
    if (job.children.every(child => child.status === 'committed')) { job.status = 'completed'; job.completedAt = this.now(); delete job.error; }
    await this._saveJob(job); await this._wakeForCompletedJob(job); return job;
  }
  async _wakeForCompletedJob(job) {
    const state = await this.repository.getRuntime();
    if (job.status === 'completed' && state.sleep.state === 'sleeping' && state.sleep.wakeCondition === 'consolidation_complete' && state.sleep.wakeJobId === job.jobId) {
      return this._wake({ ...job.context, reason: 'selected_consolidation_complete', jobId: job.jobId });
    }
  }
  async _reconcileConsolidationJob(runId, result) {
    const jobs = Object.values((await this.repository.getRuntime()).execution?.consolidationJobs ?? {});
    for (const value of jobs) if (value.children.some(child => child.runId === runId)) {
      const job = detached(value), child = job.children.find(entry => entry.runId === runId);
      const invalidated = result.run?.status === 'failed' || ['RUN_INVALIDATED', 'RUN_NOT_FOUND', 'SOURCE_REVOKED'].includes(result.error?.code);
      child.status = result.committed ? 'committed' : invalidated ? 'invalidated' : 'paused';
      child.modelCalls = result.modelCalls ?? result.run?.reviewState?.modelCalls ?? child.modelCalls ?? 0;
      if (result.committed) delete child.error;
      else child.error = { code: result.error?.code ?? result.pauseReason ?? result.run?.reviewState?.pauseReason ?? 'CONSOLIDATION_PAUSED',
        message: result.error?.message ?? 'Selected input remains unconsumed' };
      job.status = job.children.every(entry => entry.status === 'committed') ? 'completed'
        : job.children.some(entry => entry.status === 'invalidated') ? 'invalidated' : 'paused';
      if (job.status === 'completed') { job.completedAt = this.now(); delete job.error; }
      else job.error = detached(child.error ?? job.children.find(entry => entry.error)?.error ?? job.error
        ?? { code: 'CONSOLIDATION_PAUSED', message: 'Selected input remains unconsumed' });
      await this._saveJob(job); await this._wakeForCompletedJob(job);
    }
    if (!jobs.some(job => job.children.some(child => child.runId === runId)) && result.committed) {
      const state = await this.repository.getRuntime();
      if (!state.sleep.wakeJobId && state.sleep.wakeRunId === runId) await this.handleSignal({ type: 'consolidation_complete', runId });
    }
  }
  consolidate(context = {}) {
    const task = this._work.then(async () => { let result;
      try { result = await this._consolidate(context); }
      catch (error) {
        const runId = context.runId ?? context.run?.runId;
        if (runId && error.code !== 'RUN_SCOPE_MISMATCH') {
          try { const run = await this.repository.getConsolidationRun?.(runId);
            await this._reconcileConsolidationJob(runId, { committed: run?.status === 'committed', run,
              error: { code: error.code ?? 'CONSOLIDATION_FAILED', message: error.message } });
          } catch (reconciliationError) { try { this._report(reconciliationError); } catch {} }
        }
        throw error;
      }
      if (result.run?.runId) await this._reconcileConsolidationJob(result.run.runId, result); return result; });
    this._work = task.catch(() => {}); return task;
  }
  async _consolidate(context) {
    this._requireOpen();
    const limits = this._processing();
    let run = context.run ?? (context.runId != null ? { runId: context.runId } : undefined);
    if (run && typeof this.repository.getConsolidationRun === 'function') {
      run = await this.repository.getConsolidationRun(run.runId);
      if (!run) throw Object.assign(new Error('The selected consolidation run is no longer available'), { code: 'RUN_NOT_FOUND' });
    }
    run ??= await this.repository.prepareConsolidation({ personId: context.personId ?? null, maxInputChars: context.maxInputChars ?? limits.consolidationInputChars });
    const runPersonId = run.personId ?? null;
    if (own(context, 'personId') && context.personId !== runPersonId) throw Object.assign(new Error('The supplied person does not match the selected consolidation run'),
      { code: 'RUN_SCOPE_MISMATCH', runId: run.runId, personId: runPersonId });
    context = { ...context, personId: runPersonId };
    if (run.status === 'failed') throw Object.assign(new Error('The selected consolidation input was invalidated; prepare a new run'), { code: 'RUN_INVALIDATED' });
    if (run.status === 'committed') return { committed: true, duplicate: true, run, inputCount: 0, traceMaterial: [] };
    if (context.automatic && (run.reviewState?.status === 'paused' || run.reviewState?.callInFlight)) return { status: 'paused', paused: true,
      pauseReason: run.reviewState.callInFlight ? 'MODEL_OUTCOME_UNKNOWN' : run.reviewState.pauseReason, run, inputCount: 0 };
    if (run.status === 'prepared' && run.reviewState?.modelCalls === 0 && !own(run, 'candidatePatch') && typeof this.repository.refreshConsolidationContext === 'function') {
      run = await this.repository.refreshConsolidationContext(run.runId);
    }
    await this._lock(async () => { const state = await this._refresh(); state.activeRunId = run.runId;
      if (context.sleepDecisionId && state.sleep.sleepDecisionId === context.sleepDecisionId && !state.sleep.wakeJobId) state.sleep.wakeRunId = run.runId;
      await this._save(state); });
    const traceMaterial = [];
    const previous = run.reviewState ?? {}, correcting = previous.stage === 'needs_correction';
    const correctionCandidate = correcting || previous.stage === 'needs_format_correction' ? detached(run.candidatePatch) : null;
    let correctionPending = correcting || previous.stage === 'needs_format_correction';
    const review = { dataPageIndex: 0, dataPartOffset: 0, dataPageFingerprints: {}, contextCursor: 0, exposedContextCursors: [0], contextReadRanges: [], contextComplete: false,
      modelCalls: 0, pageChars: context.maxInputChars ?? limits.consolidationInputChars, ...detached(previous), status: 'running', callInFlight: false };
    if (correcting) { review.dataPageIndex = 0; review.dataPartOffset = 0; }
    const budget = context.segmentBudget ?? { used: context.automatic ? previous.segmentCallsUsed ?? 0 : 0, limit: limits.consolidationCallsPerSegment };
    if (context.automatic) budget.used = Math.max(budget.used, previous.segmentCallsUsed ?? 0);
    const proposals = new Map((!correcting && previous.stage ? run.candidatePatch?.entries ?? [] : []).map(entry => [JSON.stringify([entry.documentKey, entry.recordId]), entry]));
    const evictions = new Set(!correcting && previous.stage ? run.candidatePatch?.evictSourceIds ?? [] : []);
    const candidate = () => ({ entries: [...proposals.values()], evictSourceIds: [...evictions] });
    const persist = async (patch = correctionPending ? correctionCandidate : candidate()) => {
      review.segmentCallsUsed = budget.used;
      if (typeof this.repository.recordConsolidationProgress === 'function') run = await this.repository.recordConsolidationProgress(run.runId, { reviewState: detached(review), candidatePatch: patch });
      else run = { ...run, reviewState: detached(review), candidatePatch: detached(patch) };
    };
    const pause = async reason => { review.status = 'paused'; review.pauseReason = reason; review.callInFlight = false; await persist();
      return { status: 'paused', paused: true, pauseReason: reason, run, inputCount: 0, modelCalls: review.modelCalls, traceMaterial }; };
    try {
      const capacity = await this.repository.getCapacity();
      let pageIndex = 0;
      for await (const page of this._consolidationPages(run, { ...context, maxInputChars: review.pageChars })) {
        const dataIndex = pageIndex++, signature = fingerprint({ input: page.input, traceMaterial: page.traceMaterial.map(value => ({
          sourceRef: value.sourceRef, locator: value.locator, cursor: value.cursor, nextCursor: value.nextCursor,
          available: value.available, truncated: value.truncated, text: value.text })) });
        if (review.dataPageFingerprints[dataIndex] && review.dataPageFingerprints[dataIndex] !== signature) {
          await pause('SOURCE_REPLAY_CHANGED'); throw Object.assign(new Error('The selected source pages changed during replay; unread input was not consumed'), { code: 'SOURCE_REPLAY_CHANGED' });
        }
        review.dataPageFingerprints[dataIndex] = signature;
        if (dataIndex < review.dataPageIndex) continue;
        const total = this._consolidationPageLength(page);
        traceMaterial.push(...page.traceMaterial.map(x => ({ sourceRef: x.sourceRef, locator: x.locator, available: x.available, cursor: x.cursor, nextCursor: x.nextCursor, reason: x.reason })));
        let complete = false;
        while (!complete) {
          if (this.closed) return pause('RUNTIME_CLOSED');
          if (budget.used >= budget.limit) return pause('CONSOLIDATION_CALL_BUDGET');
          const memoryContext = consolidationContextPage(run, { cursor: review.contextCursor, maxChars: limits.consolidationContextChars });
          let chars = Math.max(0, total - review.dataPartOffset), selected, messages;
          const requestBudget = this._inputBudget();
          while (true) {
            selected = this._sliceConsolidationPage(page, review.dataPartOffset, chars);
            const feedbackCandidate = correctionPending ? correctionCandidate : null;
            const previousDraft = feedbackCandidate && fingerprint(feedbackCandidate) === fingerprint(candidate()) ? [] : [...proposals.values()];
            messages = consolidationMessages({ ...run, validationError: correctionPending ? run.validationError : null }, { ...context, ...selected,
              page: { index: dataIndex, from: review.dataPartOffset, to: review.dataPartOffset + chars, total, sameRootEvents: true,
                callBudget: { used: budget.used, limit: budget.limit, remaining: Math.max(0, budget.limit - budget.used) } },
              memoryContext, previousProposedPatch: previousDraft, candidatePatch: feedbackCandidate,
              validationError: correctionPending ? run.validationError : null, capacity });
            if (await this.tokenCounter.count(JSON.stringify(messages)) <= requestBudget) break;
            if (chars <= 1) { await pause('MODEL_INPUT_BUDGET'); throw Object.assign(new Error('The frozen context page, draft and framing cannot fit the configured request budget; no model call was made for this page'), { code: 'MODEL_INPUT_BUDGET' }); }
            chars = Math.floor(chars / 2);
          }
          review.callInFlight = true; review.status = 'running'; review.modelCalls += 1; budget.used += 1;
          await persist();
          let raw;
          try { raw = await this._call('consolidation', messages, { run: detached(run), context: detached(context) }); }
          catch (error) {
            if (['INVALID_MODEL_JSON', 'INVALID_MODEL_PATCH'].includes(error.code) && typeof this.repository.recordConsolidationAttempt === 'function') {
              const rawText = typeof error.responseText === 'string' ? error.responseText : null;
              const points = rawText == null ? [] : Array.from(rawText), limit = limits.consolidationContextChars;
              await this.repository.recordConsolidationAttempt(run.runId, { candidatePatch: correctionPending ? correctionCandidate : candidate(),
                validationError: { code: error.code, message: error.message, ...(rawText == null ? {} : { responseText: {
                  format: 'text_fragment', text: points.slice(0, limit).join(''),
                  fragment: { from: 0, to: Math.min(points.length, limit), total: points.length, complete: points.length <= limit },
                  sha256: createHash('sha256').update(rawText).digest('hex'),
                  ...(typeof error.responsePointer === 'string' ? { pointer: error.responsePointer } : typeof error.responseLocator === 'string' ? { pointer: error.responseLocator } : {}),
                } }) } });
              review.stage = correcting && correctionPending ? 'needs_correction' : 'needs_format_correction';
            }
            await pause(error.code ?? 'MODEL_CALL_FAILED'); throw error;
          }
          review.callInFlight = false;
          const parsed = asObject(raw), proposed = parsed?.patch ?? parsed;
          const entries = Array.isArray(proposed) ? proposed : proposed?.entries;
          if (!Array.isArray(entries)) { await pause('SCHEMA_INVALID'); throw Object.assign(new Error('Consolidation model must return patch entries'), { code: 'SCHEMA_INVALID' }); }
          correctionPending = false;
          if (parsed?.replaceDraft === true || proposed?.replaceDraft === true) { proposals.clear(); evictions.clear(); }
          for (const entry of entries) proposals.set(JSON.stringify([entry.documentKey, entry.recordId]), entry);
          for (const id of proposed.evictSourceIds ?? []) evictions.add(id);
          review.contextReadRanges = this._mergeReadRanges([...review.contextReadRanges, [memoryContext.fragment.from, memoryContext.fragment.to]]);
          review.contextComplete = Boolean(review.contextReadRanges[0]?.[0] === 0 && review.contextReadRanges[0]?.[1] >= memoryContext.fragment.total);
          review.exposedContextCursors = [...new Set([...review.exposedContextCursors, ...(memoryContext.nextCursor == null ? [] : [memoryContext.nextCursor])])];
          const readContext = parsed?.readContext ?? proposed?.readContext;
          if (readContext != null) {
            if (!Number.isSafeInteger(readContext.cursor) || !review.exposedContextCursors.includes(readContext.cursor)) {
              await pause('CONTEXT_CURSOR_INVALID'); throw Object.assign(new Error('The model requested a context cursor that was not exposed by the frozen reader'), { code: 'CONTEXT_CURSOR_INVALID' });
            }
            review.contextCursor = readContext.cursor; review.stage = 'context'; await persist(); continue;
          }
          review.dataPartOffset += chars; complete = total === 0 || review.dataPartOffset >= total;
          if (complete) { review.dataPageIndex = pageIndex; review.dataPartOffset = 0; }
          review.stage = 'data'; await persist();
        }
      }
      if (pageIndex < review.dataPageIndex) { await pause('SOURCE_REPLAY_CHANGED'); throw Object.assign(new Error('The selected source replay ended before its saved position'), { code: 'SOURCE_REPLAY_CHANGED' }); }
      const patch = { entries: [...proposals.values()], evictSourceIds: [...evictions] };
      review.stage = 'ready_to_commit'; await persist(patch);
      let committed;
      try { committed = await this.repository.applyConsolidation(run, patch); }
      catch (error) {
        if (['SCHEMA_INVALID', 'CAPACITY_EXCEEDED', 'CONTEXT_NOT_READ'].includes(error.code) && typeof this.repository.recordConsolidationAttempt === 'function') {
          await this.repository.recordConsolidationAttempt(run.runId, { candidatePatch: patch,
            validationError: { code: error.code, message: error.message } });
          review.stage = 'needs_correction'; await pause(error.code);
        }
        throw error;
      }
      return { ...committed, inputCount: (run.input?.chat?.length ?? 0) + (run.input?.hot?.length ?? 0), modelCalls: review.modelCalls, traceMaterial };
    } finally { await this._lock(async () => { const state = await this._refresh(); if (state.activeRunId === run.runId) { state.activeRunId = null; await this._save(state); } }); }
  }
  _mergeReadRanges(ranges) {
    const result = [];
    for (const range of ranges.sort((a, b) => a[0] - b[0])) {
      const last = result.at(-1); if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]); else result.push([...range]);
    }
    return result;
  }
  _consolidationPageLength(page) {
    return [...page.input.chat.map(record => record.text ?? ''), ...page.input.hot.filter(record => record.content.mode === 'cached').map(record => record.content.text),
      ...page.traceMaterial.map(record => record.text ?? '')].reduce((sum, text) => sum + Array.from(text).length, 0);
  }
  _sliceConsolidationPage(page, from, chars) {
    const result = { input: { chat: [], hot: [] }, traceMaterial: [] }; let offset = 0;
    const select = (text, original) => {
      const points = Array.from(text ?? ''), begin = Math.max(0, from - offset), end = Math.min(points.length, from + chars - offset); offset += points.length;
      if (end <= begin && points.length) return null;
      const base = original?.fragment?.from ?? 0, total = original?.fragment?.total ?? points.length;
      return { text: points.slice(begin, end).join(''), chars: Math.max(0, end - begin),
        fragment: { from: base + begin, to: base + end, total, complete: base + end >= total } };
    };
    for (const record of page.input.chat) { const part = select(record.text, record); if (part) result.input.chat.push({ ...record, ...part }); }
    for (const record of page.input.hot) if (record.content.mode === 'cached') { const part = select(record.content.text, record);
      if (part) result.input.hot.push({ ...record, fragment: part.fragment, content: { ...record.content, text: part.text, chars: part.chars } }); }
    for (const record of page.traceMaterial) { const part = select(record.text, record); if (part) result.traceMaterial.push({ ...record, text: part.text, fragment: part.fragment }); }
    if (result.traceMaterial.length) result.input.hot.push(...page.input.hot.filter(record => record.content.mode === 'host_trace'));
    return result;
  }
  async *_consolidationPages(run, context) {
    const limit = Math.max(1, context.maxInputChars ?? 16000);
    let page = { input: { chat: [], hot: [] }, traceMaterial: [] }, chars = 0;
    const chunks = function*(text) { const points = Array.from(text); if (!points.length) yield ''; for (let i = 0; i < points.length; i += limit) yield points.slice(i, i + limit).join(''); };
    for (const record of run.input?.chat ?? []) {
      let part = 0;
      for (const text of chunks(record.text)) {
        const size = Array.from(text).length;
        if (chars && chars + size > limit) { yield page; page = { input: { chat: [], hot: [] }, traceMaterial: [] }; chars = 0; }
        page.input.chat.push({ ...record, text, chars: size, sourcePart: part++ }); chars += size;
      }
    }
    for (const record of run.input?.hot ?? []) {
      if (record.content.mode === 'cached') {
        let part = 0;
        for (const text of chunks(record.content.text)) {
          const size = Array.from(text).length;
          if (chars && chars + size > limit) { yield page; page = { input: { chat: [], hot: [] }, traceMaterial: [] }; chars = 0; }
          page.input.hot.push({ ...record, sourcePart: part++, content: { mode: 'cached', text, chars: size } }); chars += size;
        }
      } else {
        if (chars || page.input.hot.length || page.input.chat.length) { yield page; page = { input: { chat: [], hot: [] }, traceMaterial: [] }; chars = 0; }
        let cursor = null; const seen = new Set();
        do {
          const raw = await this.host.readTrace?.(record.content.locator, { sourceRef: record.sourceRef, maxChars: limit, cursor });
          const value = typeof raw === 'string' ? { text: raw, available: true } : raw ?? { available: false, reason: 'source_port_unavailable' };
          if (value.truncated && value.nextCursor == null) throw Object.assign(new Error('Truncated trace has no continuation cursor; selected hot record was not consumed'), { code: 'TRACE_INCOMPLETE' });
          for (const text of chunks(value.text ?? '')) yield { input: { chat: [], hot: [record] }, traceMaterial: [{
            ...value, text, sourceRef: record.sourceRef, locator: record.content.locator, cursor,
          }] };
          const next = value.nextCursor ?? null;
          if (next != null && seen.has(JSON.stringify(next))) throw Object.assign(new Error('Trace continuation cursor did not advance'), { code: 'TRACE_CURSOR_LOOP' });
          if (next != null) seen.add(JSON.stringify(next)); cursor = next;
        } while (cursor != null);
      }
    }
    if (chars || page.input.chat.length || page.input.hot.length) yield page;
  }
  async recoverConsolidations(context = {}) {
    const runs = await this.repository.listConsolidationRuns?.({ status: 'prepared' }) ?? [];
    const results = [];
    for (const run of runs) results.push(await this.consolidate({ ...context, personId: run.personId ?? null, run }));
    return results;
  }
  async _sleepWork(context) {
    return this._startConsolidationPlan({ action: 'run' }, context, context.sleepDecisionId ?? newId('legacy_sleep'));
  }
}
