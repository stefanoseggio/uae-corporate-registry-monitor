import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockInit = vi.fn().mockResolvedValue(undefined);
const mockExit = vi.fn().mockResolvedValue(undefined);
const mockGetInput = vi.fn();
const mockOn = vi.fn();
const mockOff = vi.fn();

vi.mock('apify', () => ({
    Actor: {
        init: mockInit,
        exit: mockExit,
        getInput: mockGetInput,
        on: mockOn,
        off: mockOff,
    },
    log: { info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

const mockRun = vi.fn();
vi.mock('../src/routes.js', () => ({ run: (...args: unknown[]) => mockRun(...args) }));

const mockLoadState = vi.fn();
const mockSaveState = vi.fn();
vi.mock('../src/state.js', () => ({
    loadState: (...args: unknown[]) => mockLoadState(...args),
    saveState: (...args: unknown[]) => mockSaveState(...args),
    stateStoreName: (name: string) => `UAE-CORPORATE-REGISTRY-DELTA-STATE-${name}`,
}));

function handlerFor(event: string): () => Promise<void> {
    const call = mockOn.mock.calls.find(([e]) => e === event);
    if (!call) throw new Error(`No handler registered for '${event}'`);
    return call[1] as () => Promise<void>;
}

beforeEach(() => {
    vi.resetModules();
    mockInit.mockClear();
    mockExit.mockClear();
    mockGetInput.mockReset();
    mockOn.mockClear();
    mockOff.mockClear();
    mockRun.mockReset();
    mockLoadState.mockReset();
    mockSaveState.mockReset().mockResolvedValue(undefined);

    mockGetInput.mockResolvedValue({ dataSources: ['ADGM_FREEZONE'] });
    mockLoadState.mockResolvedValue({ entities: {}, sourceCache: {} });
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('main.ts shutdown-safety wiring', () => {
    it('registers migrating and aborting handlers before running, and deregisters them after a successful run', async () => {
        mockRun.mockResolvedValue({ totalPushed: 1, stopped: false, sourcesChecked: 1, byEventType: { NEW_ENTITY: 1 } });

        await import('../src/main.js');

        expect(mockOn).toHaveBeenCalledWith('migrating', expect.any(Function));
        expect(mockOn).toHaveBeenCalledWith('aborting', expect.any(Function));
        expect(mockOff).toHaveBeenCalledWith('migrating', expect.any(Function));
        expect(mockOff).toHaveBeenCalledWith('aborting', expect.any(Function));
        expect(mockExit).toHaveBeenCalledTimes(1);
    });

    it('the registered migrating handler actually flushes state when invoked - the exact regression this wiring exists to prevent', async () => {
        mockRun.mockResolvedValue({ totalPushed: 0, stopped: false, sourcesChecked: 1, byEventType: {} });

        await import('../src/main.js');
        const migratingHandler = handlerFor('migrating');

        mockSaveState.mockClear();
        await migratingHandler();

        expect(mockSaveState).toHaveBeenCalledTimes(1);
    });

    it('the registered aborting handler also flushes state when invoked', async () => {
        mockRun.mockResolvedValue({ totalPushed: 0, stopped: false, sourcesChecked: 1, byEventType: {} });

        await import('../src/main.js');
        const abortingHandler = handlerFor('aborting');

        mockSaveState.mockClear();
        await abortingHandler();

        expect(mockSaveState).toHaveBeenCalledTimes(1);
    });

    it('the shutdown handler does not throw even if saving state fails - a flush failure must not crash the shutdown path', async () => {
        mockRun.mockResolvedValue({ totalPushed: 0, stopped: false, sourcesChecked: 1, byEventType: {} });

        await import('../src/main.js');
        const migratingHandler = handlerFor('migrating');

        mockSaveState.mockRejectedValueOnce(new Error('KV store unavailable'));
        await expect(migratingHandler()).resolves.toBeUndefined();
    });

    it('saves state even when the run fails, then rethrows - progress already made must not be lost to a later failure', async () => {
        mockRun.mockRejectedValue(new Error('simulated download failure'));

        await expect(import('../src/main.js')).rejects.toThrow('simulated download failure');

        expect(mockSaveState).toHaveBeenCalled();
        expect(mockExit).not.toHaveBeenCalled(); // top-level `await main(); await Actor.exit();` never reaches exit() if main() rethrows
        expect(mockOff).toHaveBeenCalledWith('migrating', expect.any(Function)); // handlers are still deregistered via `finally`
    });

    it('defaults deltaStateName to "default" when Actor.getInput returns nothing', async () => {
        mockGetInput.mockResolvedValue(null);
        mockRun.mockResolvedValue({ totalPushed: 0, stopped: false, sourcesChecked: 1, byEventType: {} });

        await import('../src/main.js');

        expect(mockLoadState).toHaveBeenCalledWith('UAE-CORPORATE-REGISTRY-DELTA-STATE-default', false);
        // The empty-input object itself is passed straight through to routes.ts's run() - the
        // dataSources=DEFAULT_DATA_SOURCES fallback for a missing `dataSources` field lives there.
        expect(mockRun.mock.calls[0][0].dataSources).toBeUndefined();
    });

    it('passes resetState through to loadState', async () => {
        mockGetInput.mockResolvedValue({ resetState: true, deltaStateName: 'custom' });
        mockRun.mockResolvedValue({ totalPushed: 0, stopped: false, sourcesChecked: 1, byEventType: {} });

        await import('../src/main.js');

        expect(mockLoadState).toHaveBeenCalledWith('UAE-CORPORATE-REGISTRY-DELTA-STATE-custom', true);
    });
});
