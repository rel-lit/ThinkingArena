import { createEventLog } from '../../services/event-log.ts';
const el = createEventLog({ filePath: 'runs/first-real/script.jsonl' });
const r = el.append({ exec: null, type: 'run_started', payload: {
  bundle_hash: 'a81f6c70b41482a23a890f9cff5c7bd381106b00d9be17c6d2fa2cdc774a0c75',
  bundle_path: 'runs/first-real', mode: 'fresh', fork_from_event_id: null } });
console.log('ok?', r.ok, 'error?', r.ok ? '' : r.error);
