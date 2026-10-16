import { homedir } from 'node:os';
import { join } from 'node:path';
import { detectAccelerators, resolveStateRoot } from './amadeus-runtime.mjs';
import { loadDiscoveryJson } from './provider-discovery.mjs';

// Known dependencies and existing configuration only. No service enumeration,
// registry inventory, arbitrary application launches or inventory-consent gate.
export function dependencyHealth(options = {}) {
  const cache = options.catalog ?? loadDiscoveryJson(join(options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'models_cache.json'), {});
  const models = Array.isArray(cache.models) ? cache.models.filter(m => m.visibility === 'list').map(m => ({ slug: m.slug })) : [];
  const registry = options.registry ?? loadDiscoveryJson(join(options.stateRoot ?? resolveStateRoot(), 'providers/registry.json'), {});
  return { ...detectAccelerators({ ...options, catalogModels: models }),
    configuredProviders: Object.values(registry.providers ?? {}).filter(p => p.approved === true).map(p => ({ id: p.id, enabled: p.enabled === true })),
    inventoryCollected: false, note: 'Known dependency presence and cached availability only. Task preflight verifies actual execution readiness.' };
}
