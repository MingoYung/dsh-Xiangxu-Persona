import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewAssistantMessages,reviewAssistantReport,visibleContextRecordIds} from '../core/review-assistant.js';

test('optional assistant gets labelled actual fragments and no write authority',()=>{
 const messages=reviewAssistantMessages({runId:'run_actual',input:{chat:[{id:'c1',text:'我当时很难过'}]},memoryContext:{fragment:{complete:false},text:'actual frozen page'}});
 const body=JSON.parse(messages[1].content);
 assert.equal(body.input.chat[0].text,'我当时很难过');assert.equal(body.memoryContext.fragment.complete,false);
 assert.match(messages[0].content,/not a judge of its character/);assert.match(messages[0].content,/empty observations array is valid/);
});
test('assistant patches and claimed authority never become a memory patch',()=>{
 const report=reviewAssistantReport({text:JSON.stringify({entries:[{documentKey:'persona'}],authoritative:true,observations:[{category:'source',detail:'possible speaker mix-up',recordIds:['real','forged']}]})},{recordIds:['real']});
 assert.equal(report.advisoryOnly,true);assert.equal(report.entries,undefined);assert.equal(report.authoritative,undefined);
 assert.deepEqual(report.observations[0].recordIds,['real']);assert.equal(report.unverifiedReferences,true);
});
test('assistant advice is Unicode bounded and honestly partial',()=>{
 const report=reviewAssistantReport({observations:[{category:'context',detail:'情绪😀é'.repeat(2000),recordIds:[]}]},{maxChars:200});
 assert.equal(report.complete,false);assert.ok(Array.from(JSON.stringify(report.observations)).length<=200);assert.ok(JSON.stringify(report).isWellFormed());
});
test('empty advice is valid and malformed advice cannot silently become facts',()=>{
 assert.equal(reviewAssistantReport({observations:[]}).complete,true);
 assert.throws(()=>reviewAssistantReport({text:'this personality must become kinder'}),{code:'REVIEW_ASSISTANT_FORMAT'});
});

test('advice may refer to visible frozen old memories but not unseen or invented IDs',()=>{
 const context={memoryIndexes:{global:{items:[{id:'旧记忆甲'},{id:'unseen'}]}},deepMemories:[{id:'deep-old'}]};
 const ids=visibleContextRecordIds(context,{text:'{"id":"旧记忆甲"}, {"id":"deep-old"}, {"id":"invented"}'});
 assert.deepEqual(ids,['旧记忆甲','deep-old']);
 const report=reviewAssistantReport({observations:[{detail:'Possible old context',recordIds:['旧记忆甲','deep-old']}]},{recordIds:ids});
 assert.equal(report.unverifiedReferences,false);assert.deepEqual(report.observations[0].recordIds,ids);
 assert.deepEqual(visibleContextRecordIds(context,{text:'{"id":"旧记忆'}),[]);
});
