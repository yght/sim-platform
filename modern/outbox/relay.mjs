/** Publish outside the transaction. Consumers deduplicate using the stable ID. */
export async function relayOne(store, publish, { leaseMs = 30_000, maxAttempts = 5 } = {}) {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError('Maximum attempts must be a positive integer');
  }
  const item = store.claim(leaseMs);
  if (!item) return { status: 'idle' };
  try {
    await publish({ id: item.id, tenant: item.tenant, event: item.payload });
  } catch (error) {
    const exhausted = item.attempts >= maxAttempts;
    const retainedLease = exhausted ? store.quarantine(item) : store.retry(item);
    return { status: retainedLease ? (exhausted ? 'dead' : 'retry') : 'lease-lost', id: item.id, error };
  }
  return { status: store.acknowledge(item) ? 'sent' : 'lease-lost', id: item.id };
}
