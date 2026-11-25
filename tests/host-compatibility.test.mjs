import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETTINGS, createEmptyMemoryData } from '../memory-engine.js';
import { buildHistoryCoverage, buildChatHistoryReplacement } from '../history-builder.js';

import { reconcileNativeVisibility } from '../native-visibility.js';
import { publishDryRunPrompts, clearDryRunPrompts } from '../prompt-bridge.js';

const hostRoot = process.env.SILLYTAVERN_ROOT || fileURLToPath(new URL('../../../SillyTavern/', import.meta.url));
async function optionalSource(relative) {
    try { return await readFile(resolve(hostRoot, relative), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'EACCES') return null; throw error; }
}
const extensionSource = await optionalSource('public/scripts/extensions.js');
const openaiSource = await optionalSource('public/scripts/openai.js');
const generationSource = await optionalSource('public/script.js');
const chatsSource = await optionalSource('public/scripts/chats.js');
function extractFunction(source, declaration) {
    const start = source.indexOf(declaration);
    assert.ok(start >= 0, 'Expected native host function: ' + declaration);
    const match = /\r?\n}\r?\n/.exec(source.slice(start));
    assert.ok(match, 'Native function terminator exists');
    return source.slice(start, start + match.index + match[0].length).replace(/^export /, '');
}
function fixture() {
    const memory = createEmptyMemoryData(), chat = [];
    for (let round=1;round<=7;round++) {
        chat.push({name:'旅人',is_user:true,mes:'玩家第'+round+'轮'}, {name:'守卫',is_user:false,mes:'角色第'+round+'轮'});
        memory.archivePool.push({id:'round-'+round,level:0,roundRange:String(round),startMessageId:round*2-2,endMessageId:round*2-1,text:'历史第'+round+'轮'});
    }
    memory.levels[0]=memory.archivePool.slice(-3);memory.lastProcessedMessageId=13;memory.lastProcessedRound=7;
    const core=chat.map((message,index)=>({...message,index}));
    const settings={...DEFAULT_SETTINGS,keepRecentRoundsCount:2};
    return {memory,chat,core,settings};
}

test('actual SillyTavern interceptor runner accepts an in-place working-history replacement', {skip:!extensionSource}, async () => {
    const f=fixture(), before=JSON.stringify(f.chat);
    const scope=vm.createContext({console,manifests:{suwei:{display_name:'溯微',generate_interceptor:'suwei'}},sortManifestsByOrder:()=>0});
    scope.suwei=async core=>{const plan=buildChatHistoryReplacement(f.memory,f.chat,core,f.settings);core.splice(0,core.length,...plan.messages);};
    vm.runInContext(extractFunction(extensionSource,'export async function runGenerationInterceptors(')+'\nglobalThis.run=runGenerationInterceptors;',scope);
    assert.equal(await scope.run(f.core,32768,'normal'),false);
    assert.equal(JSON.stringify(f.chat),before);
    assert.equal(f.core[0].extra.type,'narrator');
    assert.ok(!f.core.some(message=>message.mes==='玩家第1轮'));
    assert.ok(f.core.some(message=>message.mes==='玩家第7轮'));
});

test('actual SillyTavern message conversion keeps memory in system roles and recent dialogue in order', {skip:!openaiSource}, () => {
    const f=fixture();
    const last=f.core.at(-1);
    last.extra={media:[{type:'image',url:'/fixture.png'}],tool_invocations:[{id:'tool-1',name:'lookup'}],api:'test-api',model:'test-model',reasoning_signature:'signature'};
    const plan=buildChatHistoryReplacement(f.memory,f.chat,f.core,f.settings);
    const scope=vm.createContext({console,oai_settings:{chat_completion_source:'test-api',names_behavior:0},
        getChatCompletionModel:()=> 'test-model',IGNORE_SYMBOL:Symbol('ignore'),system_message_types:{NARRATOR:'narrator'},
        character_names_behavior:{NONE:0,DEFAULT:1,CONTENT:2,COMPLETION:3},selected_group:false,name1:'旅人',
        getMediaDisplay:()=> 'gallery',getMediaIndex:()=>0});
    vm.runInContext(extractFunction(openaiSource,'function setOpenAIMessages(')+'\nglobalThis.format=setOpenAIMessages;',scope);
    // populateDialogueExamples reverses the host's transport array before chatHistory is populated.
    const formatted=scope.format(plan.messages).reverse();
    assert.equal(formatted[0].role,'system');
    assert.match(formatted[0].content,/历史第1轮/);
    const raw=formatted.filter(message=>message.role!=='system');
    assert.deepEqual(Array.from(raw,message=>message.role),['user','assistant','user','assistant']);
    assert.equal(raw.at(-1).content,'角色第7轮');
    assert.equal(raw.at(-1).media[0].url,'/fixture.png');
    assert.equal(raw.at(-1).invocations[0].id,'tool-1');
    assert.equal(raw.at(-1).signature,'signature');
});

test('actual host prepares the replacement before native formatting and keeps its chatHistory slot', {skip:!generationSource||!openaiSource}, () => {
    const intercept=generationSource.indexOf('await runGenerationInterceptors(coreChat');
    const formatting=generationSource.indexOf('setOpenAIMessages(coreChat)',intercept);
    assert.ok(intercept>=0 && formatting>intercept);
    assert.match(openaiSource,/chatCompletion\.add\(new MessageCollection\('chatHistory'\), prompts\.index\('chatHistory'\)\)/);
    assert.match(openaiSource,/messages = messages\.reverse\(\)/);
});

function bridgeContext() {
    const ctx = { extensionPrompts: {} };
    ctx.setExtensionPrompt = (key, value, position, depth, scan, role) => { ctx.extensionPrompts[key] = { value, position, depth, scan, role }; };
    return ctx;
}
function nativeInjectionScope(ctx) {
    return { console, extension_prompt_types: { IN_CHAT: 1 }, extension_prompt_roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
        getExtensionPromptMaxDepth: () => Math.max(0, ...Object.values(ctx.extensionPrompts).map(prompt => prompt.depth)),
        getExtensionPrompt: async (_position, depth, separator, role) => Object.values(ctx.extensionPrompts)
            .filter(prompt => prompt.depth === depth && prompt.role === role).map(prompt => prompt.value).filter(Boolean).join(separator),
        name1: '旅人', name2: '守卫', system_message_types: { NARRATOR: 'narrator' } };
}
for (const backend of ['text', 'openai']) {
    test('actual ' + backend + ' dry-run injection preserves history and ledger source placement without duplication',
        { skip: !generationSource || !openaiSource }, async () => {
        const f = fixture(), ctx = bridgeContext();
        for (const entry of f.memory.archivePool) entry.postStateSnapshot = { time: '第' + entry.roundRange + '轮', characters: {}, todosAndPromises: [] };
        // Keep ledger before the newest round so a wrong depth would visibly move it.
        f.memory.archivePool.at(-1).postStateSnapshot = undefined;
        const coverage = buildHistoryCoverage(f.memory, f.chat, f.settings);
        reconcileNativeVisibility(f.chat, coverage.hiddenIndexes, true);
        const core = f.chat.filter(message => !message.is_system).map((message, index) => ({ ...message, index }));
        const plan = buildChatHistoryReplacement(f.memory, f.chat, core, f.settings);
        publishDryRunPrompts(ctx, plan);
        const scope = vm.createContext(nativeInjectionScope(ctx));
        let result;
        if (backend === 'text') {
            vm.runInContext(extractFunction(generationSource, 'async function doChatInject(') + '\nglobalThis.inject=doChatInject;', scope);
            result = core.map(message => ({ ...message }));
            await scope.inject(result, false);
        } else {
            Object.assign(scope, { oai_settings: { chat_completion_source: 'test', names_behavior: 0 },
                getChatCompletionModel: () => '', IGNORE_SYMBOL: Symbol(), selected_group: false, getMediaDisplay: () => 'gallery', getMediaIndex: () => 0,
                character_names_behavior: { NONE: 0, DEFAULT: 1, CONTENT: 2, COMPLETION: 3 } });
            vm.runInContext(extractFunction(openaiSource, 'function setOpenAIMessages(') + '\nglobalThis.format=setOpenAIMessages;', scope);
            vm.runInContext(extractFunction(openaiSource, 'async function populationInjectionPrompts(') + '\nglobalThis.inject=populationInjectionPrompts;', scope);
            result = (await scope.inject([], scope.format(core))).map(message => ({ mes: message.content }));
        }
        assert.deepEqual(Array.from(result, message => message.mes), plan.messages.map(message => message.mes));
        clearDryRunPrompts(ctx);
        assert.ok(!Object.keys(ctx.extensionPrompts).some(key => key.startsWith('suwei_dry_run_')));
    });
}

test('actual native range hiding updates flags, visible DOM, swipe controls and full-chat save', { skip: !chatsSource }, async () => {
    const f = fixture(), attrs = new Map(); let refreshes = 0, saves = 0, persisted;
    const scope = vm.createContext({ console, chat: f.chat, isNaN,
        $: selector => ({ length: 1, attr: (name, value) => attrs.set(selector, [name, value]) }),
        refreshSwipeButtons: () => { refreshes++; }, saveChatConditional: async () => { saves++; persisted = structuredClone(f.chat); } });
    vm.runInContext(extractFunction(chatsSource, 'export async function hideChatMessageRange(') + '\nglobalThis.hide=hideChatMessageRange;', scope);
    f.chat[0].extra = { tiandao_hidden: true };
    await scope.hide(0, 1, false);
    assert.equal(saves, 1); assert.equal(refreshes, 1);
    assert.equal(attrs.size, 2); assert.equal(persisted[0].extra.tiandao_hidden, true);
    assert.equal(persisted[1].is_system, true);
    assert.equal(persisted.length, f.chat.length);
    await scope.hide(0, 1, true);
    assert.equal(f.chat[0].is_system, false);
});

test('actual host waits for generation setup before raw filtering and skips interceptors only in dry-run', { skip: !generationSource }, () => {
    const start = generationSource.indexOf('await eventSource.emit(event_types.GENERATION_STARTED');
    const filter = generationSource.indexOf('let coreChat = chat.filter', start);
    const intercept = generationSource.indexOf('await runGenerationInterceptors(coreChat', filter);
    assert.ok(start >= 0 && filter > start && intercept > filter);
    assert.match(generationSource.slice(filter, intercept), /if \(!dryRun\)/);
    assert.match(generationSource, /await eventSource\.emit\(event_types\.GENERATE_AFTER_DATA, generate_data, dryRun\)/);
});
