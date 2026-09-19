import { Actor } from 'apify';

/**
 * A run-level time budget guard for adgmSource.ts and difcSource.ts.
 *
 * CONFIRMED BUG this addresses: neither source's per-page retry-and-backoff loop had ANY
 * awareness of the actor's own run timeout. With this actor's real constants
 * (MAX_RETRY_ATTEMPTS=5, REQUEST_TIMEOUT_MS=30_000, exponential backoff up to 30% jitter), a
 * single page whose every attempt times out can alone consume up to ~189s
 * (5 x 30s requests + ~39s of worst-case backoff between attempts 2-5) - and because
 * fetchAllAdgmEntities()/fetchAllDifcCompanies() only return (so routes.ts only starts
 * pushing anything) once ALL pages have been collected, just 3-4 such pages in a row can
 * burn through the actor's entire real, live-confirmed 600s defaultRunOptions.timeoutSecs
 * before a single row is ever pushed - with no guard anywhere stopping the pagination/retry
 * loops early to protect whatever was already fetched.
 *
 * `Actor.getEnv().timeoutAt` is the Apify platform's own real, live deadline for the CURRENT
 * run (parsed from the ACTOR_TIMEOUT_AT/APIFY_TIMEOUT_AT env var by the apify SDK itself) - using
 * it here means this guard always tracks whatever timeoutSecs is actually configured for the
 * run, rather than a hardcoded, easily-stale copy of "600s" baked into source code.
 */
export interface RunDeadline {
    /** `true` once starting another page fetch or another retry attempt is no longer safe. */
    isExpired(): boolean;
}

/**
 * `safetyMarginMs` is reserved AFTER the computed deadline for whatever happens once fetching
 * stops: pushing/notifying the rows already collected (routes.ts's processEntity), any other
 * data source still queued behind this one in routes.ts's run() loop, and the final state save
 * in main.ts. It is a fixed reservation, not a network timeout, so it does not vary with network
 * conditions the way REQUEST_TIMEOUT_MS does.
 *
 * Because both the pagination loop and the per-page retry loop only check `isExpired()` BEFORE
 * starting a new page/attempt (never abort one already in flight), the worst-case overshoot past
 * the computed deadline is bounded by a single REQUEST_TIMEOUT_MS (30s) - not by however many
 * more retries or pages would otherwise have been attempted.
 */
export function createRunDeadline(safetyMarginMs: number): RunDeadline {
    const { timeoutAt } = Actor.getEnv();
    if (!timeoutAt) {
        // No real run deadline known (local dev via tsx, a unit test, or a platform run type
        // that doesn't set it) - nothing real to guard against, so never expire.
        return { isExpired: () => false };
    }
    const deadline = timeoutAt.getTime() - safetyMarginMs;
    return { isExpired: () => Date.now() >= deadline };
}
