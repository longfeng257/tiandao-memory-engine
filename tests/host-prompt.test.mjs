import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadHostPromptProcessor, createPromptTextReader, preparePromptHistory } from '../host-prompt.js';

const roles = { USER_INPUT: 1, AI_OUTPUT: 2 };
test('preview applies native prompt regex per role/depth to copies only', async () => {
    const calls = [];
    const process = await loadHostPromptProcessor({ regex_placement: roles,
        getRegexedString(text, placement, options) {
            calls.push({ placement, ...options });
            return text.replace(/<options>[\s\S]*?<\/options>/g, '');
        },
    });
    const chat = [
        { is_user: true, mes: '玩家正文<options>用户选项</options>' },
        { is_system: true, mes: '隐藏', is_user: false },
        { is_user: false, mes: '角色正文<options>秘密选项</options>', extra: { media: ['fixture'] } },
    ];
    const before = JSON.stringify(chat);
    const core = preparePromptHistory(chat, process);
    assert.deepEqual(core.map(item => item.mes), ['玩家正文', '角色正文']);
    assert.deepEqual(calls, [{ placement: 1, isPrompt: true, depth: 1 }, { placement: 2, isPrompt: true, depth: 0 }]);
    assert.equal(JSON.stringify(chat), before);
    assert.equal(core[1].extra, chat[2].extra);
    calls.length = 0;
    preparePromptHistory(chat, process, 'continue');
    assert.deepEqual(calls.map(item => item.depth), [0, -1]);
    calls.length = 0;
    assert.equal(preparePromptHistory(chat, process, 'swipe').length, 1);
    assert.equal(calls[0].depth, 0);
});

test('summary preprocessing includes opening messages and retains legacy hidden depth', () => {
    const chat = [
        { mes: '开场<options>不要发送</options>', is_user: false },
        { mes: '提问', is_user: true },
        { mes: '回答', is_user: false, is_system: true, extra: { tiandao_hidden: true } },
        { mes: '追问', is_user: true },
    ];
    const calls = [];
    const read = createPromptTextReader(chat, (text, message, depth) => {
        calls.push(depth); return text.replace(/<options>.*?<\/options>/g, '');
    });
    assert.equal(read(0), '开场'); assert.equal(read(2), '回答');
    assert.deepEqual(calls, [2, 1]);
});

const root = process.env.SILLYTAVERN_ROOT || fileURLToPath(new URL('../../../SillyTavern/', import.meta.url));
let nativeSource;
try { nativeSource = (await readFile(root + '/public/scripts/extensions/regex/engine.js', 'utf8')).replace(/\r\n/g, '\n'); }
catch (error) { if (!['ENOENT', 'EACCES'].includes(error.code)) throw error; }
test('actual host regex respects prompt-only/display-only, disabled and depth rules', { skip: !nativeSource }, async () => {
    const start = nativeSource.indexOf('export function getRegexedString(');
    assert.ok(start >= 0);
    const end = nativeSource.indexOf('\n}\n', start);
    const scripts = [
        { scriptName: 'preset prompt', promptOnly: true, placement: [2], find: /<options>.*?<\/options>/g, replacement: '' },
        { scriptName: 'display only', markdownOnly: true, placement: [2], find: /正文/g, replacement: '不应发生' },
        { scriptName: 'disabled', promptOnly: true, disabled: true, placement: [2], find: /正文/g, replacement: '不应发生' },
        { scriptName: 'old only', promptOnly: true, minDepth: 2, placement: [2], find: /旧/g, replacement: '过滤' },
    ];
    const scope = vm.createContext({ console: { ...console, debug() {} }, extension_settings: { disabledExtensions: [] },
        getRegexScripts: ({ allowedOnly }) => { assert.equal(allowedOnly, true); return scripts; },
        runRegexScript: (script, text) => script.disabled ? text : text.replace(script.find, script.replacement) });
    vm.runInContext(nativeSource.slice(start, end + 3).replace(/^export /, '') + '\nglobalThis.run = getRegexedString;', scope);
    const processText = await loadHostPromptProcessor({ getRegexedString: scope.run, regex_placement: roles });
    assert.equal(processText('正文旧<options>选项</options>', { is_user: false }, 0), '正文旧');
    assert.equal(processText('正文旧<options>选项</options>', { is_user: false }, 3), '正文过滤');
    assert.equal(processText('正文<options>用户选项保留</options>', { is_user: true }, 0), '正文<options>用户选项保留</options>');
    scope.extension_settings.disabledExtensions.push('regex');
    assert.equal(processText('正文<options>保留</options>', { is_user: false }, 0), '正文<options>保留</options>');
});

test('a source reader excludes the discarded swipe reply even when read directly', () => {
    const chat = [{ is_user: true, mes: '保留的问题' }, { is_user: false, mes: '被丢弃的回复' }];
    const read = createPromptTextReader(chat, text => text, 'swipe');
    assert.equal(read(0), '保留的问题');
    assert.equal(read(1), '');
});


test('preview preserves visible host tool messages even when their system flag is set', () => {
    const chat = [{ is_user: true, mes: 'question' },
        { is_user: false, is_system: true, mes: 'tool result', extra: { tool_invocations: [{ id: 'call-1' }] } },
        { is_user: false, mes: 'answer' }];
    assert.deepEqual(preparePromptHistory(chat, text => text).map(message => message.mes), ['question', 'tool result', 'answer']);
});
