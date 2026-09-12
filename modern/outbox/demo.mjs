import { DatabaseSync } from 'node:sqlite';
import { ProvisioningStore } from './store.mjs';
import { relayOne } from './relay.mjs';

const db = new DatabaseSync(process.env.SIM_DB || 'sim-demo.db');
try {
  const store = new ProvisioningStore(db);
  const tenant = 'demo-reseller';
  const iccid = '8944100000000000016';
  if (!store.getSim(tenant, iccid)) store.seed(tenant, { iccid, carrier: 'bell', state: 'PRE_ACTIVE' });
  const command = { tenant, iccid, commandId: 'demo-activation', event: 'ACTIVATE_REQUESTED', context: { ratePlanId: 'demo-plan' } };
  console.log('Command:', store.execute(command));
  console.log('Retry:', store.execute(command));
  console.log('Relay:', await relayOne(store, async envelope => console.log('Stub carrier delivery:', envelope)));
} finally {
  db.close();
}
