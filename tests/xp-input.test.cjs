const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

test('XP hints allow backspacing through a separator and the preceding number',()=>{
  const source=fs.readFileSync('public/dashboard.js','utf8');
  const helpers=source.slice(source.indexOf('function levelMessageTypeCount('),source.indexOf("['min-xp','max-xp'].forEach"));
  const prefix={},missing={};
  const hint={querySelector:selector=>selector==='.xp-values-prefix'?prefix:missing};
  const input={value:'2, ',parentElement:{querySelector:()=>hint}};
  const context={state:{systemId:1,data:{systems:[{id:1,content_filter:'text,images,links'}]}},$:()=>({options:[{value:'text',textContent:'Text'},{value:'images',textContent:'File'},{value:'links',textContent:'Link'}]}),refreshLevelContentPopupRewards:()=>{}};
  vm.createContext(context);
  vm.runInContext(helpers,context);
  context.updateLevelXpHint(input);
  assert.equal(input.value,'2, ');
  for(const expected of ['2,','2','']){
    input.value=input.value.slice(0,-1);
    context.sanitizeLevelXpInput(input);
    assert.equal(input.value,expected);
    assert.equal(prefix.textContent,expected);
  }
  assert.equal(missing.textContent,'Text, File, Link');
  // Mobile keyboards may emit input without the desktop keydown handler.
  input.value='2 ';
  context.sanitizeLevelXpInput(input);
  assert.equal(input.value,'2 ');
  input.value+='4';
  context.sanitizeLevelXpInput(input);
  assert.equal(input.value,'2, 4');
  input.value+=' ';
  context.sanitizeLevelXpInput(input);
  assert.equal(input.value,'2, 4 ');
  input.value+='6';
  context.sanitizeLevelXpInput(input);
  assert.equal(input.value,'2, 4, 6');
  input.value='2 ';
  context.sanitizeLevelXpInput(input,true);
  assert.equal(input.value,'2');
});
