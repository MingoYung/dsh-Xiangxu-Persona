import { selfProfileContext } from './onboarding.js';

const identityFields = ['name', 'pronouns', 'gender', 'ageDescription', 'birthday', 'selfDescription'];
const json = value => JSON.stringify(value);
export const contextBudgetError = message => Object.assign(new Error(message), { code: 'PERSONA_CONTEXT_BUDGET' });
export const sectionText = (name, value) => value === '' ? '' : `[${name}]\n${typeof value === 'string' ? value : json(value)}\n`;

/** Core identity is complete. Optional biography and initial wishes remain whole fields. */
export async function requiredSelfProfile(profile, counter) {
  if (!profile) return { text: '', shown: [], omitted: [], sourceDependencies: { refs: [], recordIds: [] } };
  const current = Object.fromEntries(identityFields.filter(field => profile.current?.[field]).map(field => [field, profile.current[field]]));
  const core = { ...profile, current, initial: {} };
  const budget = Math.max(...await Promise.all([true, false].map(moreAvailable => counter.count(sectionText('self_profile', {
    version: profile.version, mode: profile.mode, current, initialWishes: {}, moreAvailable })))));
  const result = await selfProfileContext(core, { counter, budget });
  for (const field of Object.keys(current)) if (!result.shown.includes('current.' + field)) throw contextBudgetError('The complete current identity could not be loaded; no partial identity was supplied');
  return result;
}

/** Select whole structured values; omitted values never become broken JSON. */
export async function fitStructuredSection(name, groups, { counter, budget, canFit }) {
  const selected = {}, shown = [], omitted = [];
  for (const [field, entries] of Object.entries(groups)) {
    if (Array.isArray(entries)) {
      selected[field] = [];
      for (const [index, entry] of entries.entries()) {
        selected[field].push(entry);
        const text = sectionText(name, selected);
        if (await counter.count(text) <= budget && await canFit(text)) shown.push(field + ':' + (entry?.id ?? index));
        else { selected[field].pop(); omitted.push(field + ':' + (entry?.id ?? index)); }
      }
      if (!selected[field].length) delete selected[field];
    } else if (entries !== undefined && entries !== null && entries !== '') {
      selected[field] = entries;
      const text = sectionText(name, selected);
      if (await counter.count(text) <= budget && await canFit(text)) shown.push(field);
      else { delete selected[field]; omitted.push(field); }
    }
  }
  return { text: Object.keys(selected).length ? sectionText(name, selected) : '', selected, shown, omitted, truncated: omitted.length > 0 };
}

/** A bounded view of the same originals, never a consumption or a new summary. */
export async function recentMemorySection(material, context, { counter, budget, canFit }) {
  const source = material.recentMemory ?? { items: material.recent ?? [], total: (material.recent ?? []).length,
    omitted: 0, preferredDays: null, asOf: null, originalsRemainQueryable: true };
  const items = (source.items ?? []).filter(record => !Object.hasOwn(record, 'personId') || record.personId === (context.personId ?? null));
  const provided = new Set([...(context.pending ?? []), ...(context.incoming ? [context.incoming] : [])]
    .filter(record => record.sourceSessionId && record.sourceEventId)
    .map(record => json([record.sourceSessionId, record.sourceEventId])));
  const candidates = items.filter(record => !provided.has(json([record.sourceSessionId, record.sourceEventId])));
  const selected = [], fragments = [];
  const envelope = () => ({ total: Math.max(source.total ?? items.length, items.length), shown: selected.length,
    omitted: Math.max(0, (source.total ?? items.length) - selected.length),
    pendingInputReferences: items.length - candidates.length, preferredDays: source.preferredDays ?? null,
    asOf: source.asOf ?? null, originalsRemainQueryable: true, items: [...selected].reverse() });
  const render = () => sectionText('recent_memory', envelope());
  const fits = async () => await counter.count(render()) <= budget && await canFit(render());
  // An empty recent window is still explicit. Pending references are not claims
  // that the source pager admitted or read those originals in this request.
  if (!await fits()) throw contextBudgetError('The request budget cannot carry the recent-memory availability facts');
  for (const record of [...candidates].reverse()) {
    const entry = { id: record.id ?? record.eventId, role: record.role, speakerId: record.speakerId ?? null,
      sourceAt: record.sourceAt, sourceSessionId: record.sourceSessionId, sourceEventId: record.sourceEventId,
      text: record.text ?? '' };
    if (record.timeline) {
      const annotation = Object.fromEntries(['title', 'background', 'process', 'outcome', 'details', 'feltThen', 'meaningNow', 'indexCodes']
        .filter(key => record.timeline[key] && (!Array.isArray(record.timeline[key]) || record.timeline[key].length)).map(key => [key, record.timeline[key]]));
      if (Object.keys(annotation).length) entry.timeline = annotation;
    }
    selected.push(entry);
    if (await fits()) continue;
    selected.pop();
    // A source may be larger than the entire window. Supply an exact Unicode
    // range and the original reference, with no claim that its tail was read.
    if (!selected.length) {
      const points = Array.from(record.text ?? '');
      let low = 0, high = points.length, best = null;
      while (low <= high) {
        const to = Math.floor((low + high) / 2), fragment = { ...entry, text: points.slice(0, to).join(''),
          fragment: { from: 0, to, total: points.length, complete: to === points.length }, annotationsOmitted: Boolean(entry.timeline) };
        delete fragment.timeline; selected.push(fragment);
        const accepted = await fits(); selected.pop();
        if (accepted) { best = fragment; low = to + 1; } else high = to - 1;
      }
      if (!best || (points.length && best.fragment.to === 0)) throw contextBudgetError('The request budget cannot carry a recent source reference and a complete Unicode fragment');
      selected.push(best); fragments.push({ id: best.id, ...best.fragment });
    }
    break;
  }
  const value = envelope();
  const annotationProvenance = selected.flatMap(entry => {
    if (!entry.timeline) return [];
    const original = candidates.find(record => (record.id ?? record.eventId) === entry.id);
    return Object.keys(entry.timeline).map(field => original?.timeline?.provenance?.[field]).filter(Boolean);
  });
  return { text: render(), value, selected, fragments, annotationProvenance,
    truncated: value.omitted > 0 || fragments.some(item => !item.complete) };
}
