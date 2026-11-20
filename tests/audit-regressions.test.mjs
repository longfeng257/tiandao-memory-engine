import test from 'node:test';
import assert from 'node:assert/strict';
import {
 createEmptyMemoryData, mergeStateLedger, applyStateChanges, normalizeMemoryData,
 recordStateLedger, getStateLedgerCursor, reconcileMemoryAfterMessageDeletion,
 buildChatMessageFingerprint, buildInjectedMemoryPrompt, getStateLedgerAtMessage,
} from '../memory-engine.js';
const actor = extra => ({location:'营地', wear:'布衣', inventory:[], removedItemsLock:[], ...extra});
const change = (characters, baseRound = 0) => ({version:1,baseRound,changes:{characters}});
const trait = (state, round) => ({key:'信任',dimension:'relationship',target:'导师',state,evidence:'在剧情中明确作出该决定',sourceRound:round});
const chat = n => Array.from({length:n},(_,i)=>[{is_user:true,mes:'输入'+(i+1)},{is_user:false,mes:'回复'+(i+1)}]).flat();
function archive(memory, round, storage, extra = {}) {
 const item={id:'r'+round,level:0,roundRange:String(round),startMessageId:round*2-2,endMessageId:round*2-1,text:'剧情'+round,...storage,...extra};
 memory.archivePool.push(item); memory.levels[0].push(item);
 memory.lastProcessedMessageId=item.endMessageId; memory.lastProcessedRound=round;
 return item;
}

test('a revealed real name replaces the display identity while retaining the stable archive key', () => {
 let ledger=mergeStateLedger({}, {characters:{戴面具的引路人:actor({canonicalName:'沈舟',named:true,importance:'supporting',importanceReason:'持续带队寻找失踪者'})}}, 1);
 assert.equal(ledger.characters.戴面具的引路人.canonicalName,'沈舟');
 ledger=applyStateChanges(ledger, change({戴面具的引路人:{canonicalName:'沈舟',named:true}}), 2);
 assert.equal(ledger.characters.戴面具的引路人.canonicalName,'沈舟');
 assert.deepEqual(Object.keys(ledger.characters),['戴面具的引路人']);
 assert.match(buildInjectedMemoryPrompt({stateLedger:ledger}), /【沈舟】/);
 assert.match(buildInjectedMemoryPrompt({stateLedger:ledger}), /戴面具的引路人/);
});

test('different named actors sharing a generic title never merge their possessions or private facts', () => {
 const ledger=mergeStateLedger({}, {characters:{
  林舟:actor({canonicalName:'林舟',aliases:['队长'],inventory:['铜钥匙'],viewTarget:'甲队的口令'}),
  顾川:actor({canonicalName:'顾川',aliases:['队长'],inventory:['银钥匙'],viewTarget:'乙队的密令'}),
 }}, 1);
 assert.deepEqual(Object.keys(ledger.characters),['林舟','顾川']);
 assert.deepEqual(ledger.characters.林舟.inventory,['铜钥匙']);
 assert.equal(ledger.characters.顾川.viewTarget,'乙队的密令');
});

test('ambiguous shared nicknames do not select the first matching person', () => {
 const memory=createEmptyMemoryData();
 memory.stateLedger.characters={林舟:actor({aliases:['小林']}),林远:actor({aliases:['小林']})};
 const ledger=applyStateChanges(memory.stateLedger, change({陌生来客:{aliases:['小林'],inventoryAdd:['未确认的信件']}}), 2);
 assert.deepEqual(ledger.characters.林舟.inventory,[]);
 assert.deepEqual(ledger.characters.林远.inventory,[]);
});

test('deleting the first growth keyframe does not revive its unsupported beliefs via the fallback ledger', () => {
 const memory=createEmptyMemoryData();
 const currentChat=chat(3);
 for(let round=1;round<=3;round++) {
  const next=applyStateChanges(memory.stateLedger,change({苏晚: round===1 ? {growth:[trait('不再相信导师',1)]} : {location:'地点'+round}},getStateLedgerCursor(memory).round),round);
  recordStateLedger(memory,{endMessageId:round*2-1,roundNumber:round},next);
  archive(memory,round,round===1 ? {postStateSnapshot:structuredClone(next)} : {postStateDelta:structuredClone(memory.stateSync.entries.at(-1).postStateDelta)});
 }
 memory.stateSync=null;
 const before=buildChatMessageFingerprint(currentChat); currentChat.splice(0,2);
 reconcileMemoryAfterMessageDeletion(memory,currentChat,before,buildChatMessageFingerprint(currentChat));
 assert.doesNotMatch(buildInjectedMemoryPrompt(memory),/不再相信导师/);
});

test('deleting an unarchived tail preserves grouped phase, far history and pending span starts', () => {
 const memory=createEmptyMemoryData(); const currentChat=chat(10);
 const first=archive(memory,5,{postStateSnapshot:{time:'午后',characters:{},todosAndPromises:[]}},{roundRange:'1-5',startMessageId:0});
 archive(memory,10,{postStateDelta:{t:'o',v:{}}},{roundRange:'6-10',startMessageId:10});
 memory.levels[1]=[{id:'phase',level:1,roundRange:'1-10',text:'前十轮的阶段脉络'}];
 memory.farHistory={text:'前十轮的远史',earliestRound:1,latestRound:10};
 memory.fadedHistory={count:2,earliestRound:1,latestRound:10};
 memory.pendingFarHistory=[{roundRange:'1-10',text:'等待合并的前十轮'}];
 currentChat.push({is_user:true,mes:'尚未回复的提问'});
 const before=buildChatMessageFingerprint(currentChat); currentChat.pop();
 reconcileMemoryAfterMessageDeletion(memory,currentChat,before,buildChatMessageFingerprint(currentChat));
 assert.equal(first.roundRange,'1-5');
 assert.equal(memory.levels[1][0].roundRange,'1-10');
 assert.equal(memory.pendingFarHistory[0].roundRange,'1-10');
 assert.equal(memory.farHistory.earliestRound,1);
 assert.equal(memory.fadedHistory.earliestRound,1);
});

test('deletion rebases split-state source positions with the archived narrative rounds', () => {
 const memory=createEmptyMemoryData(); const currentChat=chat(3);
 for(let round=1;round<=3;round++) archive(memory,round,{postStateSnapshot:{time:'剧情时间'+round,characters:{},todosAndPromises:[]}},
   {stateMessageId:round*2-1,stateRound:round});
 memory.stateLedger=structuredClone(memory.archivePool.at(-1).postStateSnapshot);
 const before=buildChatMessageFingerprint(currentChat); currentChat.splice(0,2);
 reconcileMemoryAfterMessageDeletion(memory,currentChat,before,buildChatMessageFingerprint(currentChat));
 assert.deepEqual(memory.archivePool.map(item=>[item.endMessageId,item.stateMessageId,item.stateRound]),[[1,1,1],[3,3,2]]);
});

test('revealing a name does not split one relationship into contradictory old-name and new-name growth', () => {
 let ledger=mergeStateLedger({}, {characters:{
  戴面具的引路人:actor({canonicalName:'戴面具的引路人',named:false,importance:'supporting',importanceReason:'持续带队寻找失踪者'}),
  苏晚:actor({growth:[{...trait('谨慎对待他的提议',1),key:'同行信任',target:'戴面具的引路人'}]}),
 }}, 1);
 ledger=applyStateChanges(ledger,change({戴面具的引路人:{canonicalName:'沈舟',named:true}}),2);
 ledger=applyStateChanges(ledger,change({苏晚:{growth:[{...trait('愿意与他分享调查计划',3),key:'同行信任',target:'沈舟'}]}}),3);
 assert.equal(ledger.characters.苏晚.growth.length,1);
 assert.equal(ledger.characters.苏晚.growth[0].state,'愿意与他分享调查计划');
});

test('a newly revealed canonical identity takes priority over a shared nickname', () => {
 const ledger=mergeStateLedger({}, {characters:{林舟:actor({aliases:['小林']}),林远:actor({aliases:['小林']})}},1);
 const updated=applyStateChanges(ledger,change({来客:{canonicalName:'林远',aliases:['小林'],inventoryAdd:['信件']}}),2);
 assert.deepEqual(updated.characters.林远.inventory,['信件']);
 assert.deepEqual(updated.characters.林舟.inventory,[]);
});

test('a preserved narrative with a deleted stale state source falls back to the last valid source', () => {
 const memory=createEmptyMemoryData(); const currentChat=chat(3);
 const unsafe={time:'错误的旧状态',characters:{苏晚:actor({growth:[trait('不再相信导师',1)]})},todosAndPromises:[]};
 for(let round=1;round<=3;round++)archive(memory,round,{postStateSnapshot:structuredClone(unsafe)},{stateMessageId:1,stateRound:1});
 memory.stateLedger=structuredClone(unsafe);
 const before=buildChatMessageFingerprint(currentChat);currentChat.splice(0,2);
 reconcileMemoryAfterMessageDeletion(memory,currentChat,before,buildChatMessageFingerprint(currentChat));
 for(const item of memory.archivePool){assert.equal(item.stateMessageId,-1);assert.equal(item.stateRound,0);}
 assert.doesNotMatch(buildInjectedMemoryPrompt(memory),/不再相信导师/);
});
