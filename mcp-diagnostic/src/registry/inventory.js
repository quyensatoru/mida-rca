import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const inventoryPath = resolvePath(__dirname, '../../inventory.yaml');

let _inv = null;

function load() {
    if (_inv) return _inv;
    const raw = readFileSync(inventoryPath, 'utf8');
    _inv = yaml.load(raw);
    validate(_inv);
    return _inv;
}

function validate(inv) {
    if (!inv.services || !Array.isArray(inv.services)) throw new Error('inventory: missing services[]');
    if (!inv.sources || typeof inv.sources !== 'object') throw new Error('inventory: missing sources{}');
    for (const svc of inv.services) {
        if (!svc.name) throw new Error('inventory: service missing name');
        for (const inst of svc.instances ?? []) {
            if (!inst.id) throw new Error(`inventory: instance missing id in service ${svc.name}`);
            for (const [cap, srcId] of Object.entries(inst.sources ?? {})) {
                if (!inv.sources[srcId]) {
                    throw new Error(`inventory: instance ${inst.id} cap ${cap} references unknown source ${srcId}`);
                }
            }
        }
    }
}

/** @returns {Array<{id,shard,sources}>} */
export function getInstances(serviceName) {
    const inv = load();
    const svc = inv.services.find((s) => s.name === serviceName);
    if (!svc) return [];
    return svc.instances ?? [];
}

/** @returns {Object} sourceCfg from inventory */
export function getSource(sourceId) {
    const inv = load();
    const src = inv.sources[sourceId];
    if (!src) throw new Error(`inventory: source not found: ${sourceId}`);
    return { id: sourceId, ...src };
}

export function listServices() {
    return load().services.map((s) => s.name);
}

export function getTenancyResolver() {
    return load().tenancy?.resolver ?? null;
}
