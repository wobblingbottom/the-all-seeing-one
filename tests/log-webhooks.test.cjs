const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const source = ts.transpileModule(fs.readFileSync('src/log-webhooks.ts','utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function harness(identity) {
  const db = { exec() {}, prepare() { return { get() { return identity; } }; } };
  const context = { exports: {}, require: name => name === 'node:fs' ? fs : ({ db }), console: { error() {} } };
  vm.runInNewContext(source, context);
  return context.exports;
}
test('disabled log identities post directly as the bot', async () => {
  const api=harness({enabled:0}),payload={embeds:[]};let received;
  await api.sendLog({}, {send:async value=>{received=value;}}, 'moderation', payload);
  assert.equal(received,payload);
});
test('concurrent logs share webhook creation and apply their identity', async () => {
  const api=harness({enabled:1,name:'Moderation',avatar_url:'https://example.com/avatar.png'});
  let created=0;const sent=[];
  const guild={client:{user:{id:'bot',displayAvatarURL:()=> 'bot-avatar'}}};
  const channel={id:'channel',fetchWebhooks:async()=>({find:()=>undefined}),createWebhook:async()=>{created++;return {send:async payload=>sent.push(payload)};},send:async()=>assert.fail('unexpected fallback')};
  await Promise.all([api.sendLog(guild,channel,'moderation',{embeds:[]}),api.sendLog(guild,channel,'moderation',{embeds:[]})]);
  assert.equal(created,1);assert.equal(sent.length,2);assert.equal(sent[0].username,'Moderation');assert.equal(sent[0].avatarURL,'https://example.com/avatar.png');assert.equal(sent[0].allowedMentions.parse.length,0);
});
test('existing owned webhooks are reused, with the bot avatar as default', async () => {
  const api=harness({enabled:1,name:'Economy',avatar_url:''});let sent;
  const guild={client:{user:{id:'bot',displayAvatarURL:()=> 'bot-avatar'}}};
  const hook={owner:{id:'bot'},name:'Crazyland economy logs',token:'private',send:async payload=>{sent=payload;}};
  const channel={id:'channel',fetchWebhooks:async()=>({find:predicate=>predicate(hook)?hook:undefined}),createWebhook:async()=>assert.fail('should reuse'),send:async()=>assert.fail('unexpected fallback')};
  await api.sendLog(guild,channel,'economy',{});assert.equal(sent.avatarURL,'bot-avatar');
});
test('webhook failures fall back to bot delivery', async () => {
  const api=harness({enabled:1,name:'Logs',avatar_url:''}),payload={embeds:[]};let received;
  const channel={id:'channel',fetchWebhooks:async()=>{throw Error('Missing permissions');},createWebhook:async()=>{},send:async value=>{received=value;}};
  await api.sendLog({},channel,'moderation',payload);assert.equal(received,payload);
});

test('moderation uses the supplied image as the webhook avatar', async () => {
  const api=harness({enabled:1,name:'Moderation',avatar_url:''});let edited,sent;
  const guild={client:{user:{id:'bot'}}};
  const hook={id:'mod-hook',owner:{id:'bot'},name:'Crazyland moderation logs',token:'private',edit:async value=>{edited=value;},send:async value=>{sent=value;}};
  const channel={id:'mod-channel',fetchWebhooks:async()=>({find:predicate=>predicate(hook)?hook:undefined}),createWebhook:async()=>assert.fail('should reuse'),send:async()=>assert.fail('unexpected fallback')};
  await api.sendLog(guild,channel,'moderation',{});
  assert.deepEqual(edited.avatar,fs.readFileSync('public/assets/modlogs.png'));
  assert.equal(sent.avatarURL,undefined);
});

test('moderation defaults to webhook delivery while saved choices take precedence', () => {
  const api=harness(undefined);
  assert.equal(api.logIdentity('guild','moderation').enabled,1);
  assert.equal(api.logIdentity('guild','economy').enabled,0);
  assert.equal(harness({enabled:0,name:'Disabled',avatar_url:''}).logIdentity('guild','moderation').enabled,0);
});
