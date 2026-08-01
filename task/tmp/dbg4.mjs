import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
const dir = mkdtempSync('/tmp/dbg-');
try { execFileSync('node', ['cli/run.ts', '--bundle', 'bundles/isekai-mvp', '--run-dir', dir, '--mock-llm', 'bundles/isekai-mvp/mock-llm.script.json', '--poll-interval-ms', '50'], { timeout: 20000 }); } catch {}
if (existsSync(dir + '/script.jsonl')) {
  for (const l of readFileSync(dir + '/script.jsonl', 'utf8').trim().split('\n')) {
    const e = JSON.parse(l);
    console.log(e.id, e.type, JSON.stringify(e.payload).slice(0, 160));
  }
}
