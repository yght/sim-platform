import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProvisioningStore, CommandConflict } from './store.mjs';
import { relayOne } from './relay.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sim-outbox-'));
  const path = join(dir, 'test.db');
  const db = new DatabaseSync(path);
  const other = new DatabaseSync(path);
  let now = 1_700_000_000_000;
  const store = new ProvisioningStore(db, { now: () => now });
  const second = new ProvisioningStore(other, { now: () => now });
  store.seed('a', { iccid: 'sim-1', carrier: 'bell', state: 'PRE_ACTIVE' });
  t.after(() => { db.close(); other.close(); rmSync(dir, { recursive: true }); });
  return { db, store, second, path, advance: ms => { now += ms; } };
}
const command = { tenant: 'a', commandId: 'cmd-1', iccid: 'sim-1', event: 'ACTIVATE_REQUESTED', context: { ratePlanId: 'basic' } };

test('command, state and event persist together; retry from another connection replays', t => {
  const { store, second, db } = fixture(t);
  const original = store.execute(command);
  const retry = second.execute(command);
  assert.equal(retry.replayed, true);
  assert.deepEqual(retry.eventIds, original.eventIds);
  assert.equal(second.getSim('a', 'sim-1').state, 'ACTIVATING');
  assert.equal(db.prepare('SELECT count(*) AS n FROM outbox').get().n, 1);
});

test('receipt survives reopening the database', t => {
  const { store, path } = fixture(t);
  const original = store.execute(command);
  const reopened = new DatabaseSync(path);
  try {
    const restarted = new ProvisioningStore(reopened);
    assert.deepEqual(restarted.execute(command).eventIds, original.eventIds);
  } finally { reopened.close(); }
});

test('a reused key with different content conflicts', t => {
  const { store } = fixture(t);
  store.execute(command);
  assert.throws(() => store.execute({ ...command, context: { ratePlanId: 'other' } }), CommandConflict);
});

test('context key ordering does not change request identity', t => {
  const { store } = fixture(t);
  store.execute({ ...command, context: { ratePlanId: 'basic', note: 'test' } });
  assert.equal(store.execute({ ...command, context: { note: 'test', ratePlanId: 'basic' } }).replayed, true);
});

test('tenant boundaries apply to SIM lookup and command receipts', t => {
  const { store } = fixture(t);
  assert.equal(store.getSim('b', 'sim-1'), null);
  assert.throws(() => store.execute({ ...command, tenant: 'b' }), /SIM not found/);
  store.seed('b', { iccid: 'sim-1', carrier: 'bell', state: 'PRE_ACTIVE' });
  assert.equal(store.execute(command).replayed, false);
  assert.equal(store.execute({ ...command, tenant: 'b' }).replayed, false);
});

test('receipt write failure rolls back SIM update and outbox insert', t => {
  const { store, db } = fixture(t);
  db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT, 'disk failure'); END;");
  assert.throws(() => store.execute(command), /disk failure/);
  assert.equal(store.getSim('a', 'sim-1').state, 'PRE_ACTIVE');
  assert.equal(db.prepare('SELECT count(*) AS n FROM outbox').get().n, 0);
  db.exec('DROP TRIGGER fail_receipt');
  assert.equal(store.execute(command).replayed, false);
});

test('domain rejection writes no receipt or event', t => {
  const { store, db } = fixture(t);
  assert.throws(() => store.execute({ ...command, context: {} }), /rate plan/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM outbox').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM receipts').get().n, 0);
});

test('only one worker owns a live lease', t => {
  const { store, second } = fixture(t);
  store.execute(command);
  assert.ok(store.claim());
  assert.equal(second.claim(), null);
});

test('worker crash permits replay with the same ID and fences stale acknowledgements', t => {
  const { store, second, advance } = fixture(t);
  store.execute(command);
  const first = store.claim(100);
  advance(101);
  const replacement = second.claim();
  assert.equal(replacement.id, first.id);
  assert.notEqual(replacement.token, first.token);
  assert.equal(store.acknowledge(first), false);
  assert.equal(store.retry(first), false);
  assert.equal(second.acknowledge(replacement), true);
  assert.equal(store.claim(), null);
});

test('publish failure backs off; success acknowledges durable delivery', async t => {
  const { store, advance } = fixture(t);
  store.execute(command);
  const failed = await relayOne(store, async () => { throw new Error('carrier offline'); });
  assert.equal(failed.status, 'retry');
  assert.equal((await relayOne(store, async () => assert.fail('too early'))).status, 'idle');
  advance(1000);
  const sent = await relayOne(store, async envelope => assert.equal(envelope.id, failed.id));
  assert.equal(sent.status, 'sent');
  assert.equal((await relayOne(store, async () => assert.fail('already sent'))).status, 'idle');
});
