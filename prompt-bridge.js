const PREFIX = "suwei_dry_run_";
const activeKeys = new Set();

export function clearDryRunPrompts(ctx) {
    const keys = new Set([...activeKeys, ...Object.keys(ctx.extensionPrompts || {}).filter(key => key.startsWith(PREFIX))]);
    for (const key of keys) {
        ctx.setExtensionPrompt?.(key, "", 1, 0, false, 0);
        if (ctx.extensionPrompts) delete ctx.extensionPrompts[key];
    }
    activeKeys.clear();
}

// IN_CHAT depths count raw messages from the tail in both native backends.
export function publishDryRunPrompts(ctx, plan) {
    clearDryRunPrompts(ctx);
    if (typeof ctx.setExtensionPrompt !== "function") return false;
    const groups = new Map();
    for (const injection of plan.injections || []) {
        if (!groups.has(injection.depth)) groups.set(injection.depth, []);
        groups.get(injection.depth).push(injection.text);
    }
    for (const [depth, parts] of groups) {
        const key = PREFIX + depth;
        ctx.setExtensionPrompt(key, parts.join("\n\n"), 1, depth, false, 0);
        activeKeys.add(key);
    }
    return true;
}
