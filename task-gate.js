/** One FIFO task slot. Invalidating waiters never steals a running slot. */
export function createSummaryTaskGate() {
    let active = null;
    const waiting = [];
    function tryAcquire() {
        if (active) return null;
        active = {};
        return active;
    }
    function drain() {
        while (!active && waiting.length) {
            const waiter = waiting.shift();
            if (!waiter.isReady()) { waiter.resolve(null); continue; }
            waiter.resolve(tryAcquire());
        }
    }
    return {
        tryAcquire,
        acquire(isReady = () => true) {
            if (!isReady()) return Promise.resolve(null);
            if (!active) return Promise.resolve(tryAcquire());
            return new Promise(resolve => waiting.push({ resolve, isReady }));
        },
        release(token) {
            if (!token || token !== active) return false;
            active = null;
            drain();
            return true;
        },
        invalidate() {
            for (const waiter of waiting.splice(0)) waiter.resolve(null);
        },
    };
}
