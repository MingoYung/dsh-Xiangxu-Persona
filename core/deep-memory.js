/** References describe remembered experiences; they are never automatic recall triggers. */
export function deepMemoryReferenceCards(items = []) {
  return items.map(item => ({ id: item.id, title: item.title, reference: item.reference,
    cues: item.cues ?? [], aboutPersonIds: item.aboutPersonIds ?? [], updatedAt: item.updatedAt }));
}

/** Keep whole cards and truthful completeness facts inside the caller's existing context budget. */
export async function fitDeepMemoryReferences(items, { budget, counter } = {}) {
  const cards = deepMemoryReferenceCards(items);
  const selected = [];
  const payload = () => ({ referenceOnly: true, automaticRecall: false, total: cards.length,
    shown: selected.length, catalogueComplete: selected.length === cards.length,
    truncated: selected.length < cards.length || selected.some(item => item.partial === true), nextOffset: selected.length < cards.length ? selected.length : null,
    items: selected });
  const text = () => '[deep_memory_reference]\n' + JSON.stringify(payload()) + '\n';
  if (!cards.length || !Number.isFinite(budget) || budget <= 0) return { text: '', shownIds: [], total: cards.length, shown: 0, truncated: cards.length > 0 };
  if (await counter.count(text()) > budget) return { text: '', shownIds: [], total: cards.length, shown: 0, truncated: true };
  for (const card of cards) {
    selected.push(card);
    if (await counter.count(text()) > budget) {
      selected.pop();
      // A valid long first card must not hide the whole catalogue. The visible fields are
      // labelled previews, never a generated summary or an automatic recall decision.
      if (!selected.length) {
        const title = Array.from(card.title ?? ''), reference = Array.from(card.reference ?? '');
        const preview = { ...card, title: title.slice(0, 16).join(''), reference: '', cues: [], aboutPersonIds: [],
          partial: true, titleTotalChars: title.length, referenceTotalChars: reference.length,
          omittedFields: ['cues', 'aboutPersonIds'] };
        selected.push(preview);
        if (await counter.count(text()) > budget) { selected.pop(); break; }
        let low = 0, high = reference.length, best = '';
        while (low <= high) {
          const mid = Math.floor((low + high) / 2); preview.reference = reference.slice(0, mid).join('');
          if (await counter.count(text()) <= budget) { best = preview.reference; low = mid + 1; }
          else high = mid - 1;
        }
        preview.reference = best;
      }
      break;
    }
  }
  return { text: text(), shownIds: selected.map(item => item.id), total: cards.length,
    shown: selected.length, truncated: selected.length < cards.length || selected.some(item => item.partial === true) };
}
