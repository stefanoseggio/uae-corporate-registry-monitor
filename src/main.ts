import { Actor, log } from 'apify';

import { run } from './routes.js';
import { loadState, saveState, stateStoreName } from './state.js';
import type { ActorInput } from './types.js';

await Actor.init();

async function main(): Promise<void> {
    const input = (await Actor.getInput<ActorInput>()) ?? ({} as ActorInput);
    const resetState = input.resetState ?? false;
    const storeName = stateStoreName(input.deltaStateName ?? 'default');

    const state = await loadState(storeName, resetState);

    const flushState = async (): Promise<void> => {
        try {
            await saveState(storeName, state);
        } catch (error) {
            log.warning(`Failed to flush state during shutdown: ${error instanceof Error ? error.message : String(error)}`);
        }
    };
    Actor.on('migrating', flushState);
    Actor.on('aborting', flushState);

    try {
        const stats = await run(input, state);
        log.info(
            `Run complete: ${stats.totalPushed} records pushed across ${stats.sourcesChecked} data source(s). By event type: ${JSON.stringify(stats.byEventType)}${stats.stopped ? ' (stopped early - charge limit or maxItems reached)' : ''}`,
        );
        await saveState(storeName, state);
    } catch (error) {
        await saveState(storeName, state);
        throw error;
    } finally {
        Actor.off('migrating', flushState);
        Actor.off('aborting', flushState);
    }
}

await main();
await Actor.exit();
