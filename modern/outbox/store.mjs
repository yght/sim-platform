import { randomUUID } from 'node:crypto';
import lifecycle from '../../services/sim-service/src/domain/simLifecycle.js';

const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
};

export class CommandConflict extends Error {}

/**
 * SQLite is the transaction boundary. Carrier calls never run inside it.
 * Callers must supply a trusted tenant identity after authenticating the user.
 */
export class ProvisioningStore {
  constructor(db, { now = Date.now } = {}) {
    this.db = db;
    this.now = now;
    db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sims (
        tenant TEXT NOT NULL, iccid TEXT NOT NULL, document TEXT NOT NULL,
        PRIMARY KEY(tenant, iccid)
      );
      CREATE TABLE IF NOT EXISTS receipts (
        tenant TEXT NOT NULL, command_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        result TEXT NOT NULL, PRIMARY KEY(tenant, command_id)
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY, tenant TEXT NOT NULL, payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        available_at INTEGER NOT NULL DEFAULT 0,
        lease_token TEXT, lease_until INTEGER
      );
      CREATE INDEX IF NOT EXISTS outbox_available ON outbox(status, available_at, lease_until);
    `);
  }

  seed(tenant, sim) {
    this.db.prepare('INSERT INTO sims VALUES (?, ?, ?)').run(tenant, sim.iccid, JSON.stringify(sim));
  }

  getSim(tenant, iccid) {
    const row = this.db.prepare('SELECT document FROM sims WHERE tenant=? AND iccid=?').get(tenant, iccid);
    return row ? JSON.parse(row.document) : null;
  }

  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  execute({ tenant, commandId, iccid, event, context = {} }) {
    if (![tenant, commandId, iccid, event].every(v => typeof v === 'string' && v.trim() && v.length <= 128)) {
      throw new TypeError('Tenant, command ID, ICCID and event must be nonblank strings up to 128 characters');
    }
    if (!context || Array.isArray(context) || typeof context !== 'object' || 'occurredAt' in context) {
      throw new TypeError('Context must be an object; occurrence time is assigned by the store');
    }
    const fingerprint = JSON.stringify(canonical({ iccid, event, context }));
    return this.transaction(() => {
      const receipt = this.db.prepare('SELECT * FROM receipts WHERE tenant=? AND command_id=?').get(tenant, commandId);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new CommandConflict('Command ID already used for another payload');
        return { ...JSON.parse(receipt.result), replayed: true };
      }
      const sim = this.getSim(tenant, iccid);
      if (!sim) throw new Error('SIM not found');
      const result = lifecycle.apply(sim, event, { ...context, occurredAt: new Date(this.now()).toISOString() });
      const eventIds = result.events.map(payload => {
        const id = randomUUID();
        this.db.prepare('INSERT INTO outbox(id,tenant,payload) VALUES (?,?,?)').run(id, tenant, JSON.stringify(payload));
        return id;
      });
      this.db.prepare('UPDATE sims SET document=? WHERE tenant=? AND iccid=?').run(JSON.stringify(result.sim), tenant, iccid);
      const response = { sim: result.sim, eventIds };
      this.db.prepare('INSERT INTO receipts VALUES (?,?,?,?)').run(tenant, commandId, fingerprint, JSON.stringify(response));
      return { ...response, replayed: false };
    });
  }

  claim(leaseMs = 30_000) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new TypeError('Lease duration must be positive');
    return this.transaction(() => {
      const now = this.now();
      const row = this.db.prepare(`SELECT * FROM outbox
        WHERE (status='pending' AND available_at<=?) OR (status='leased' AND lease_until<=?)
        ORDER BY rowid LIMIT 1`).get(now, now);
      if (!row) return null;
      const token = randomUUID();
      this.db.prepare(`UPDATE outbox SET status='leased',lease_token=?,lease_until=?,attempts=attempts+1 WHERE id=?`)
        .run(token, now + leaseMs, row.id);
      return { id: row.id, tenant: row.tenant, payload: JSON.parse(row.payload), token, attempts: row.attempts + 1 };
    });
  }

  acknowledge(item) {
    return this.db.prepare(`UPDATE outbox SET status='sent',lease_token=NULL,lease_until=NULL
      WHERE id=? AND status='leased' AND lease_token=?`).run(item.id, item.token).changes === 1;
  }

  quarantine(item) {
    return this.db.prepare(`UPDATE outbox SET status='dead',lease_token=NULL,lease_until=NULL
      WHERE id=? AND status='leased' AND lease_token=?`).run(item.id, item.token).changes === 1;
  }

  // Trusted operator action after fixing the cause. Preserve the consumer deduplication ID.
  requeue(id, tenant) {
    return this.db.prepare(`UPDATE outbox SET status='pending',attempts=0,available_at=?
      WHERE id=? AND tenant=? AND status='dead'`).run(this.now(), id, tenant).changes === 1;
  }

  retry(item) {
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(item.attempts - 1, 6));
    return this.db.prepare(`UPDATE outbox SET status='pending',available_at=?,lease_token=NULL,lease_until=NULL
      WHERE id=? AND status='leased' AND lease_token=?`).run(this.now() + delay, item.id, item.token).changes === 1;
  }
}
