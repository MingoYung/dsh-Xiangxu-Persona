import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EXTERNAL_OUTPUT_FORMAT, EXTERNAL_OUTPUT_LIMITS, projectExternalOutput, resolveExternalOutput } from '../adapters/dsh/external-output.js';

const fence = value => '```dsh-ui\n' + JSON.stringify(value) + '\n```';
const card = items => ({ title:'资料卡草案', items });
test('the reported profile card becomes readable chat text, preserving its content and surrounding answer', () => {
  const source = '我有自己的想法。\n\n' + fence(card([
    { type:'keyvalue',pairs:[{key:'昵称',value:'相续'},{key:'一句话',value:'喜欢短话，把话说在点上'},{key:'状态',value:'写入失败：来源引用 27 > 上限 16'}] },
    { type:'callout',tone:'warning',content:'等修好后，我再自己写进去。' },
  ])) + '\n后面还有一句。';
  const result = projectExternalOutput(source);
  assert.equal(result.text,'我有自己的想法。\n\n资料卡草案\n昵称：相续\n一句话：喜欢短话，把话说在点上\n状态：写入失败：来源引用 27 > 上限 16\n等修好后，我再自己写进去。\n后面还有一句。');
  assert.equal(result.converted,true); assert.equal(result.complete,true); assert.equal(result.cards,1);
  assert.equal(result.formatVersion,EXTERNAL_OUTPUT_FORMAT);
  assert.equal(result.sourceTextHash,createHash('sha256').update(source).digest('hex'));
  assert.equal(result.deliveryTextHash,createHash('sha256').update(result.text).digest('hex'));
});
test('ordinary text, JSON and source code are preserved exactly, including CRLF and quoted dsh-ui examples', () => {
  const source = '你好\r\n```json\r\n{"title":"用户真正想看的JSON"}\r\n```\r\n````markdown\r\n```dsh-ui\r\n{"items":[]}\r\n```\r\n````\r\n';
  const result = projectExternalOutput(source);
  assert.equal(result.text,source); assert.equal(result.converted,false); assert.equal(result.sourceTextHash,result.deliveryTextHash);
});
test('multiple cards, language case and supported punctuation preserve document order', () => {
  const source = '前\n``` DSH-UI>\n{"items":[{"type":"text","content":"甲"}]}\n```\n中\n~~~dsh-ui\n{"items":[{"type":"text","content":"乙"}]}\n~~~\n后';
  const result = projectExternalOutput(source);
  assert.equal(result.text,'前\n甲\n中\n乙\n后'); assert.equal(result.cards,2); assert.deepEqual(result.issues,[]);
});
test('similar language names and escaped fence markers remain ordinary source text', () => {
  for (const source of ['```dsh-ui-example\n{}\n```','\\```dsh-ui\n{}\n\\```']) {
    assert.equal(projectExternalOutput(source).text,source); assert.equal(projectExternalOutput(source).converted,false);
  }
});
test('malformed and unterminated cards expose a readable fallback rather than their internal JSON', () => {
  for (const [source, issue] of [['前\n```dsh-ui\n{"items": INVALID}\n```\n后','invalid_json'],['前\n```dsh-ui\n{"items":[','unterminated_fence']]) {
    const result = projectExternalOutput(source); assert.equal(result.complete,false); assert.ok(result.issues.includes(issue));
    assert.match(result.text,/前\n.*无法完整转换/u); assert.doesNotMatch(result.text,/INVALID|"items"|```dsh-ui/u);
    if (source.endsWith('后')) assert.ok(result.text.endsWith('\n后'));
  }
});
test('a failed card does not hide neighboring valid cards or prose', () => {
  const result = projectExternalOutput(fence({ items:[{type:'text',content:'甲'}] }) + '\n```dsh-ui\nBAD\n```\n' + fence({ items:[{type:'text',content:'乙'}] }));
  assert.match(result.text,/甲\n.*无法完整转换.*\n乙/u); assert.equal(result.cards,3); assert.deepEqual(result.issues,['invalid_json']);
});
test('tables retain headers, row values and per-row detail content', () => {
  const result = projectExternalOutput(fence({items:[{type:'table',columns:['姓名','数量'],rows:[['甲',2],['乙',false]],details:[[{type:'text',content:'甲的细节'}],null]}]}));
  assert.equal(result.text,'姓名 | 数量\n甲 | 2\n甲的细节\n乙 | false'); assert.equal(result.complete,true);
});
test('structured values in scalar-only display fields are explicitly unavailable rather than silently lost', () => {
  const result=projectExternalOutput(fence({items:[{type:'keyvalue',pairs:[{key:'资料',value:{internal:'NOT_RAW'}}]},{type:'table',columns:['列'],rows:[[{internal:'NOT_RAW'}]]}]}));
  assert.ok(result.issues.includes('invalid_component'));assert.equal(result.complete,false);assert.match(result.text,/资料：.*无法完整转换/u);assert.doesNotMatch(result.text,/NOT_RAW|"internal"/u);
});
test('nested layouts, tabs, timelines, steps and file trees retain their human-readable order', () => {
  const result = projectExternalOutput(fence({ title:'报告',items:[{type:'tabs',tabs:[{label:'一',items:[{type:'card',title:'条目',items:[{type:'timeline',items:[{time:'昨天',title:'开始',desc:'细节'}]},{type:'steps',steps:[{title:'准备',desc:'完成'}]}]}]},{label:'二',items:[{type:'file-tree',items:[{name:'目录',type:'dir',children:[{name:'文档.md',type:'file'}]}]}]}]}]}));
  assert.equal(result.text,'报告\n一\n条目\n昨天\n开始\n细节\n1. 准备\n完成\n二\n目录\n  文档.md'); assert.equal(result.complete,true);
});
test('json and code components deliberately showing source data remain readable code', () => {
  const result = projectExternalOutput(fence({items:[{type:'json',value:{meaning:'用户要求看的对象',count:2}},{type:'code',lang:'js',code:'const marker = "```";'}]}));
  assert.match(result.text,/```json\n\{\n  "meaning": "用户要求看的对象"/u);
  assert.match(result.text,/````js\nconst marker = "```";\n````/u); assert.equal(result.complete,true);
});
test('links and media expose only their visible labels and addresses without interpreting actions', () => {
  const result = projectExternalOutput(fence({items:[{type:'link',label:'资料',href:'https://example.invalid/no-fetch',action:'DO_NOT_RUN'},{type:'image',src:'https://example.invalid/no-fetch.png',alt:'形象',caption:'参考图'},{type:'button',label:'查看',action:'DO_NOT_RUN'}]}));
  assert.match(result.text,/资料\nhttps:\/\/example.invalid\/no-fetch\n形象\n参考图/u);
  assert.match(result.text,/交互控件.*不可操作/u); assert.doesNotMatch(result.text,/DO_NOT_RUN|"type"/u);
});
test('interactive choices show labels and selected values, without exposing action IDs or hidden answers', () => {
  const result = projectExternalOutput(fence({items:[{type:'radio',label:'选择',options:['甲','乙'],selected:1,answer:0,explanation:'HIDDEN_ANSWER',action:'INTERNAL_ACTION'},{type:'input',label:'称呼',value:'小续',id:'INTERNAL_ID'}]}));
  assert.match(result.text,/选择\n• 甲\n• 乙\n已选：乙/u); assert.match(result.text,/称呼：小续/u);
  assert.doesNotMatch(result.text,/HIDDEN_ANSWER|INTERNAL_ACTION|INTERNAL_ID/u);
});
test('chart data is readable, and graphical-only specs receive explicit display limitations', () => {
  const result = projectExternalOutput(fence({items:[{type:'chart',title:'统计',data:[{label:'甲',value:3},{label:'乙',value:0}]},{type:'svg',title:'图形',code:'<script>INTERNAL_CODE</script>'}]}));
  assert.match(result.text,/统计\n甲：3\n乙：0\n图形\n.*图形.*无法显示/u); assert.equal(result.complete,false);
  assert.deepEqual(result.issues,['graphical_component']); assert.doesNotMatch(result.text,/INTERNAL_CODE|script|"code"/u);
});
test('unknown components retain declared human text and flag unsupported presentation without leaking metadata', () => {
  const result = projectExternalOutput(fence({items:[{type:'future',title:'标题',label:'标签',content:'正文',unknown:{secret:'INTERNAL_META'}}]}));
  assert.match(result.text,/标题\n标签\n正文\n.*无法完整转换/u); assert.doesNotMatch(result.text,/INTERNAL_META|unknown|"type"/u);
  assert.equal(result.complete,false); assert.deepEqual(result.issues,['unsupported_component']);
});
test('excessive component depth and count remain bounded and never fall back to raw UI JSON', () => {
  let item={type:'text',content:'TOO_DEEP'};for(let i=0;i<EXTERNAL_OUTPUT_LIMITS.depth+2;i++)item={type:'col',items:[item]};
  const depth=projectExternalOutput(fence({items:[item]})); assert.ok(depth.issues.includes('depth_capacity')); assert.doesNotMatch(depth.text,/TOO_DEEP|"items"/u);
  const count=projectExternalOutput(fence({items:Array.from({length:EXTERNAL_OUTPUT_LIMITS.nodes+1},()=>({type:'badge',label:'项'}))}));
  assert.ok(count.issues.includes('node_capacity')); assert.doesNotMatch(count.text,/"type"/u);
});
test('nested metadata is checked iteratively before rendering and invalid roots stay out of chat', () => {
  let metadata='UNRENDERED';for(let i=0;i<EXTERNAL_OUTPUT_LIMITS.structureDepth+2;i++)metadata={nested:metadata};
  const result=projectExternalOutput(fence({items:[],metadata})); assert.ok(result.issues.includes('structure_depth')); assert.doesNotMatch(result.text,/UNRENDERED|nested/u);
  for(const root of [null,[],42]){const value=projectExternalOutput(fence(root));assert.deepEqual(value.issues,['invalid_root']);assert.equal(value.complete,false);}
});
test('reply byte, card count and expanded display capacities are explicit', () => {
  assert.throws(()=>projectExternalOutput('x'.repeat(EXTERNAL_OUTPUT_LIMITS.inputBytes+1)),{code:'EXTERNAL_OUTPUT_CAPACITY'});
  const many=projectExternalOutput(Array.from({length:EXTERNAL_OUTPUT_LIMITS.cards+1},()=>fence({items:[{type:'text',content:'项'}]})).join('\n'));
  assert.ok(many.issues.includes('card_capacity'));assert.doesNotMatch(many.text,/"items"/u);
  const expanded=projectExternalOutput(fence({items:[{type:'text',content:'字'.repeat(EXTERNAL_OUTPUT_LIMITS.outputChars+1)}]}));
  assert.ok(expanded.issues.includes('output_capacity'));assert.match(expanded.text,/显示容量/u);assert.equal(expanded.complete,false);
});

test('legacy receipts recover the raw message actually sent, without rewriting its old UI JSON', () => {
  const source=fence(card([{type:'text',content:'历史卡片'}])), hash=createHash('sha256').update(source).digest('hex');
  const receipt={textHash:hash}, saved=structuredClone(receipt);
  const recovered=resolveExternalOutput(source,receipt);
  assert.equal(recovered.text,source);assert.equal(recovered.converted,false);assert.equal(recovered.formatVersion,undefined);
  assert.deepEqual(receipt,saved);assert.equal(resolveExternalOutput(source+'变动',receipt),null);
});
test('current receipts recover the exact readable delivery using source and delivery hashes', () => {
  const source='前\n'+fence(card([{type:'text',content:'当前卡片'}])), projection=projectExternalOutput(source);
  const receipt={formatVersion:EXTERNAL_OUTPUT_FORMAT,sourceTextHash:projection.sourceTextHash,textHash:projection.deliveryTextHash};
  assert.deepEqual(resolveExternalOutput(source,receipt),projection);
  assert.deepEqual(resolveExternalOutput(source,{...receipt,deliveryTextHash:projection.deliveryTextHash}),projection);
});
test('unknown versions, missing hashes and every conflicting hash refuse recovery', () => {
  const source=fence({items:[{type:'text',content:'一致'}]}), p=projectExternalOutput(source), wrong='0'.repeat(64);
  const valid={formatVersion:EXTERNAL_OUTPUT_FORMAT,sourceTextHash:p.sourceTextHash,textHash:p.deliveryTextHash};
  for(const receipt of [null,{}, {textHash:wrong},{textHash:p.sourceTextHash,sourceTextHash:wrong},{textHash:p.sourceTextHash,deliveryTextHash:wrong},
    {...valid,formatVersion:'future/2'},{...valid,formatVersion:null},{...valid,sourceTextHash:wrong},{...valid,textHash:wrong},{...valid,deliveryTextHash:wrong},
    {formatVersion:EXTERNAL_OUTPUT_FORMAT,textHash:p.deliveryTextHash},{formatVersion:EXTERNAL_OUTPUT_FORMAT,sourceTextHash:p.sourceTextHash}])assert.equal(resolveExternalOutput(source,receipt),null);
  assert.equal(resolveExternalOutput(source+'changed',valid),null);
});
test('display degradation is also versioned and reproducible, with the raw source left untouched', () => {
  const source='前\n```dsh-ui\nBROKEN\n```\n后', original=source, p=projectExternalOutput(source);
  const receipt={formatVersion:EXTERNAL_OUTPUT_FORMAT,sourceTextHash:p.sourceTextHash,textHash:p.deliveryTextHash};
  const recovered=resolveExternalOutput(source,receipt);
  assert.equal(recovered.text,p.text);assert.equal(recovered.complete,false);assert.deepEqual(recovered.issues,['invalid_json']);assert.equal(source,original);
});
