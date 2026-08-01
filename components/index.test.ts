// Version: 1.0.0
/** index.ts 测试：内置组件注册表（orchestrator/types.ts ComponentRegistry 的实现）。 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createBuiltinComponentRegistry } from './index.ts';

describe('createBuiltinComponentRegistry（ComponentRegistry 实现）', () => {
  const registry = createBuiltinComponentRegistry({ rngSeed: 42 });

  test('六个内置组件全部注册；type+version 寻址', () => {
    assert.deepEqual(
      registry.list().map((c) => c.description.name),
      ['role_create', 'role_destroy', 'narrative', 'dice', 'judge', 'director_gate'],
    );
    assert.ok(registry.get('narrative'));
    assert.ok(registry.get('narrative', '1.0.0'));
    assert.equal(registry.get('narrative', '9.9.9'), undefined);
    assert.equal(registry.get('no_such'), undefined);
  });

  test('每个组件两元结构完整：version / ports / writable_prefixes / parameters（JSON Schema）', () => {
    for (const c of registry.list()) {
      assert.match(c.description.version, /^\d+\.\d+\.\d+$/);
      assert.ok(Array.isArray(c.description.inputs) && Array.isArray(c.description.outputs));
      assert.ok(Array.isArray(c.description.writable_prefixes));
      assert.equal(typeof c.description.parameters, 'object');
    }
    assert.deepEqual(registry.get('director_gate')!.description.writable_prefixes, ['environment', 'worldbook']);
    assert.deepEqual(registry.get('judge')!.description.writable_prefixes, ['state', 'protagonist']);
  });
});
