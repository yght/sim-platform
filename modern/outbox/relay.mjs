/** Publish outside the transaction. Consumers deduplicate using the stable ID. */
export async function relayOne(store, publish, { leaseMs = 30_000 } = {}) {
  const item = store.claim(leaseMs);
  if (!item) return { status: 'idle' };
  try {
    await publish({ id: item.id, tenant: item.tenant, event: item.payload });
  } catch (error) {
    const retainedLease = store.retry(item);
    return { status: retainedLease ? 'retry' : 'lease-lost', id: item.id, error };
  }
  return { status: store.acknowledge(item) ? 'sent' : 'lease-lost', id: item.id };
}
