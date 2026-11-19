import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETTINGS, createEmptyMemoryData } from '../memory-engine.js';
import { buildChatHistoryReplacement } from '../history-builder.js';

const hostRoot = process.env.SILLYTAVERN_ROOT || fileURLToPath(new URL('../../../SillyTavern/', import.meta.url));
async function optionalSource(relative) {
    try { return await readFile(resolve(hostRoot, relative), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'EACCES') return null; throw error; }
}
const extensionSource = await optionalSource('public/scripts/extensions.js');
const openaiSource = await optionalSource('public/scripts/openai.js');
const generationSource = await optionalSource('public/script.js');
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
