import { Actor } from 'apify';

import type { DataSourceId, DeltaState, SourceCacheEntry, StoredFingerprint } from './types.js';

/** Mirrors the fleet's `deltaStateName` convention: scope the KV store name per schedule/query. */
export function stateStoreName(deltaStateName: string): string {
    return `UAE-CORPORATE-REGISTRY-DELTA-STATE-${deltaStateName}`;
}

const STATE_KEY = 'STATE';

function emptyState(): DeltaState {
    return { entities: {}, sourceCache: {} };
}

export async function loadState(storeName: string, resetState: boolean): Promise<DeltaState> {
    if (resetState) return emptyState();
    const store = await Actor.openKeyValueStore(storeName);
    const stored = await store.getValue<DeltaState>(STATE_KEY);
    return stored ?? emptyState();
}

export async function saveState(storeName: string, state: DeltaState): Promise<void> {
    const store = await Actor.openKeyValueStore(storeName);
    await store.setValue(STATE_KEY, state);
}

export function recordSeen(state: DeltaState, recordId: string, fingerprint: StoredFingerprint): void {
    // eslint-disable-next-line no-param-reassign -- `state` is an explicit mutable accumulator passed in by design, mirroring Actor #3's state.ts
    state.entities[recordId] = fingerprint;
}

export function recordSourceChecked(state: DeltaState, dataSource: DataSourceId, entry: SourceCacheEntry): void {
    // eslint-disable-next-line no-param-reassign
    state.sourceCache[dataSource] = entry;
}
