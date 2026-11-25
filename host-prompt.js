import { stripStateUpdateBlocks } from "./state-protocol.js";
// Use the host engine so global, character and preset regex scopes stay native.
let hostRegexModule;
export async function loadHostPromptProcessor(ctx = {}) {
    let engine = ctx;
    if (typeof engine.getRegexedString !== 'function') {
        // Standalone/node consumers do not have a SillyTavern regex engine.
        if (typeof window === 'undefined') return text => String(text ?? '');
        hostRegexModule ||= import('../../regex/engine.js').catch(error => {
            hostRegexModule = null;
            throw new Error('无法加载酒馆发出正则，已停止以避免发送未过滤原文：' + error.message);
        });
        engine = await hostRegexModule;
    }
    const placement = engine.regex_placement || { USER_INPUT: 1, AI_OUTPUT: 2 };
    return (text, message, depth) => engine.getRegexedString(String(text ?? ''),
        message.is_user ? placement.USER_INPUT : placement.AI_OUTPUT, { isPrompt: true, depth });
}

// Shared summary visibility rule; legacy plugin-hidden story remains recoverable.
export function isStoryMessage(message, includeNativeHidden = false) {
    return Boolean(message && (!message.is_system || message.extra?.tiandao_hidden || includeNativeHidden));
}

export function createPromptTextReader(chat, processText, generationType = '', includeNativeHidden = false, canUseTools = true) {
    const visible = chat.map((message, index) => ({ message, index }))
        .filter(({ message }) => message && (!message.is_system || (canUseTools && Array.isArray(message.extra?.tool_invocations))));
    const excludedIndex = generationType === 'swipe' ? visible.pop()?.index : undefined;
    const depthByIndex = new Map(visible.map(({ index }, position) =>
        [index, visible.length - position - (generationType === 'continue' ? 2 : 1)]));
    const fallbackDepths = new Map();
    let following = 0;
    for (let index = chat.length - 1; index >= 0; index--) {
        fallbackDepths.set(index, following);
        const message = chat[index];
        if (isStoryMessage(message, includeNativeHidden) || Array.isArray(message?.extra?.tool_invocations)) following++;
    }
    return index => {
        const message = chat[index];
        const visibleToolMessage = !message?.is_user && Array.isArray(message?.extra?.tool_invocations);
        if ((!isStoryMessage(message, includeNativeHidden) && !visibleToolMessage) || index === excludedIndex) return '';
        // Legacy plugin-hidden turns remain valid summary input, retaining chronological depth.
        const depth = depthByIndex.get(index) ?? fallbackDepths.get(index);
        return processText(message.is_user ? message.mes : stripStateUpdateBlocks(message.mes), message, depth);
    };
}

export function preparePromptHistory(chat, processText, generationType = '', canUseTools = true) {
    const read = createPromptTextReader(chat, processText, generationType, false, canUseTools);
    const visible = chat.map((message, sourceIndex) => ({ message, sourceIndex }))
        .filter(({ message }) => message && (!message.is_system || (canUseTools && Array.isArray(message.extra?.tool_invocations))));
    if (generationType === 'swipe') visible.pop();
    return visible.map(({ message, sourceIndex }, index) => ({ ...message, index, mes: read(sourceIndex) }));
}
