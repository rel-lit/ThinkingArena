import { loadBundle, buildMockPriceTable } from '../../cli/run.ts';
import { createLLMGateway } from '../../services/llm-gateway.ts';
import { createMockExecutor } from '../../cli/mock-llm.ts';
const b = loadBundle('bundles/isekai-mvp');
const t = buildMockPriceTable(b);
console.log('table keys:', Object.keys(t));
const gw = createLLMGateway({ priceTable: t, executor: createMockExecutor([{text:'hi'}]) });
const r = gw.route('deepseek-v4-flash');
console.log('route:', JSON.stringify(r));
if (r.ok) {
  const c = await gw.call(r.value, { prompt: 'x' }, new AbortController().signal);
  console.log('call ok:', c.ok, c.ok ? c.value.text : c.error);
}
