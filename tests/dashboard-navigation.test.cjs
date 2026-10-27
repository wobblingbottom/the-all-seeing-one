const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const dashboard=fs.readFileSync('public/dashboard.js','utf8');
const helper=dashboard.slice(dashboard.indexOf('async function switchServer('),dashboard.indexOf('function syncServerRail('));
test('server switching waits for economy saves and prevents overlapping loads',async()=>{
 const calls=[];let release;const pending=new Promise(resolve=>{release=resolve;});
 const context={serverSwitchPending:false,state:{guildId:'old'},flushSave:async()=>calls.push('levels'),flushEconomySave:async()=>{calls.push('economy');await pending;},flushModerationSave:async()=>calls.push('moderation'),loadGuild:async id=>{calls.push(id);context.state.guildId=id;},showSaveToast:()=>assert.fail('unexpected error')};
 vm.createContext(context);vm.runInContext(helper,context);
 const switching=context.switchServer('new');await new Promise(resolve=>setImmediate(resolve));
 await context.switchServer('other');assert.deepEqual(calls,['levels','economy']);assert.equal(context.state.guildId,'old');
 release();await switching;assert.deepEqual(calls,['levels','economy','moderation','new']);assert.equal(context.serverSwitchPending,false);
});
test('server switching reports failures and allows retry',async()=>{
 let failed=true;const errors=[];
 const context={serverSwitchPending:false,state:{guildId:'old'},flushSave:async()=>{if(failed)throw Error('Save failed');},flushEconomySave:async()=>{},flushModerationSave:async()=>{},loadGuild:async id=>{context.state.guildId=id;},showSaveToast:message=>errors.push(message)};
 vm.createContext(context);vm.runInContext(helper,context);
 await context.switchServer('new');assert.deepEqual(errors,['Save failed']);assert.equal(context.state.guildId,'old');assert.equal(context.serverSwitchPending,false);
 failed=false;await context.switchServer('new');assert.equal(context.state.guildId,'new');
});
