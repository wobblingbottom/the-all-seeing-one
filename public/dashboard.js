const $ = selector => document.querySelector(selector);
let state = { guildId: null, data: null, systemId: null, economySystemId: null };
let serverSwitchPending = false;
let saveTimer;
let economySaveTimer;
let toastTimer;
let leaderboardSearchTimer;
let economyLeaderboardSearchTimer;
let editingShopItemId=null;
let leaderboardRequestId=0;
const globalEmojis=[
  {id:'1553368966850813963',name:'crazygears',animated:false,global:true,url:'https://cdn.discordapp.com/emojis/1553368966850813963.webp?size=64&quality=lossless'},
  {id:'1553368950082113536',name:'alonecrazygears',animated:false,global:true,url:'https://cdn.discordapp.com/emojis/1553368950082113536.webp?size=64&quality=lossless'}
];
let unicodeEmojiGroups={};
const emojiCategoryIcons={people:'😀',nature:'🌿',foods:'🍕',activity:'⚽',places:'🚀',objects:'💎',symbols:'❤️',flags:'🏳️'};
const excludedUnicodeEmojiIds=new Set(['rightwards_hand','leftwards_hand','palm_down_hand','palm_up_hand']);
const availableCurrencyEmojis=()=>[...globalEmojis,...(state.data?.emojis||[])];
async function request(url, options) {const economySave=options?.method==='PUT'&&/\/economy$/.test(url)&&options.body&&state.economySystemId;if(economySave){const body=JSON.parse(options.body);body.systemId=state.economySystemId;options={...options,body:JSON.stringify(body)}} const response = await fetch(url, options); if (response.status === 401) location.href = '/auth/discord'; if (response.status === 204) return null; const json = await response.json(); if (!response.ok) throw new Error(json.error);if(economySave){const system=state.data?.economySystems?.find(entry=>entry.id===state.economySystemId);if(system)Object.assign(system,{currency_symbol:json.currencySymbol,starting_balance:json.startingBalance,max_cash_balance:json.maxCashBalance,max_bank_balance:json.maxBankBalance,config:json.config})} return json; }
async function boot() { try { const [me,guilds,meta,emojiData]=await Promise.all([request('/api/me'),request('/api/guilds'),request('/api/meta'),request('/assets/emoji-data.json')]); unicodeEmojiGroups=Object.fromEntries(emojiData.categories.map(category=>[category.id,category.emojis.filter(id=>!excludedUnicodeEmojiIds.has(id)).map(id=>emojiData.emojis[id]).filter(Boolean).map(item=>({emoji:item.skins[0].native,unified:item.skins[0].unified.toLowerCase(),name:item.name,keywords:item.keywords||[]}))]));renderEmojiCategoryNav(); $('#username').textContent=me.username; $('#avatar').textContent=me.username[0].toUpperCase(); if(me.avatar) $('#avatar').style.backgroundImage=`url(https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png)`; const installed=guilds.filter(g=>g.installed); renderServerRail(installed,meta.clientId); if(!installed.length){$('#loading').innerHTML=`No manageable server has this bot installed yet.<br><a class="button" href="https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(meta.clientId)}&permissions=268504064&scope=bot">Add it to a server</a>`;return} const returnGuild=new URLSearchParams(location.search).get("guild"); await loadGuild(installed.some(g=>g.id===returnGuild)?returnGuild:installed[0].id); await finishPremiumCheckout(); } catch(error){$('#loading').textContent=error.message} }
async function loadGuild(id,preferredId){ $('#loading').classList.remove('hidden'); document.querySelectorAll('.panel').forEach(p=>p.classList.add('hidden')); state.guildId=id; syncServerRail(); state.data=await request(`/api/guilds/${id}/settings`); state.systemId=preferredId&&state.data.systems.some(s=>s.id===preferredId)?preferredId:state.data.systems[0].id; $('#member-count').textContent=state.data.memberCount.toLocaleString(); const options=state.data.channels.map(c=>`<option value="${c.id}"># ${escapeHtml(c.name)}</option>`).join(''); const roleOptions=state.data.roles.map(r=>`<option value="${r.id}">@ ${escapeHtml(r.name)}</option>`).join(''); $('#channel').innerHTML='<option value="">Select a channel</option>'+options; $('#allowed-channels').innerHTML=options; $('#denied-channels').innerHTML=options; $('#allowed-roles').innerHTML=roleOptions; $('#denied-roles').innerHTML=roleOptions; renderPremium(); renderSystemSelect(); await selectSystem(state.systemId); $('#loading').classList.add('hidden'); $('#level-tabs').classList.remove('hidden'); $('#system-toolbar').classList.remove('hidden'); showSection(document.querySelector('.tab.active')?.dataset.section||'levels');$('#economy-system-toolbar')?.classList.toggle('hidden',document.querySelector('.tab.active')?.dataset.section!=='economy'); }
function renderSystemSelect(){ $('#system-select').innerHTML=state.data.systems.map(s=>`<option value="${s.id}" ${s.id===state.systemId?'selected':''}>${escapeHtml(s.name)}</option>`).join(''); $('#modal-delete-system').disabled=state.data.systems.length===1;$('#new-system').disabled=state.data.systems.length>=(state.data.premium?.systemLimit||2);$('#new-system').title=$('#new-system').disabled?`Limit of ${state.data.premium?.systemLimit||2} leveling systems reached`:''; }
function renderEconomy(){const economy=state.data.economy||{},savedSymbol=economy.currencySymbol||'',emojiMatch=savedSymbol.match(/^<a?:[^:]+:(\d+)>$/),emoji=emojiMatch&&availableCurrencyEmojis().find(e=>e.id===emojiMatch[1]),selected=emoji||(!savedSymbol?globalEmojis[1]:null),symbol=selected?`<${selected.animated?'a':''}:${selected.name}:${selected.id}>`:savedSymbol;$('#currency-symbol').value=symbol;$('#currency-symbol').dataset.emojiId=selected?.id||'';$('#starting-balance').value=String(economy.startingBalance??0);$('#max-cash-balance').value=String(economy.maxCashBalance??1000000);$('#max-bank-balance').value=String(economy.maxBankBalance??1000000);$('#money-audit-channel').innerHTML='<option value="">Disabled</option>'+state.data.channels.map(c=>`<option value="${c.id}"># ${escapeHtml(c.name)}</option>`).join('');$('#money-audit-channel').value=economy.moneyAuditChannelId||'';document.querySelectorAll('[data-options]').forEach(select=>{const items=select.dataset.options==='roles'?state.data.roles:state.data.channels,prefix=select.dataset.options==='roles'?'@ ':'# ',first=select.options[0]?.outerHTML||'';select.innerHTML=first+items.map(item=>`<option value="${item.id}">${prefix}${escapeHtml(item.name)}</option>`).join('')});document.querySelectorAll('[data-economy-key]').forEach(field=>{const value=economy.config?.[field.dataset.economyKey];if(value!==undefined)field.value=String(value)});$('#emoji-search').value='';renderEmojiGrid();updateCurrencyPreview()}
function showEconomyPage(name){document.querySelectorAll('.economy-page').forEach(page=>page.classList.toggle('hidden',page.dataset.economyPage!==name));document.querySelectorAll('.economy-child').forEach(button=>button.classList.toggle('active',button.dataset.economyPage===name));const active=[...document.querySelectorAll('.economy-child')].find(button=>button.dataset.economyPage===name);$('#title').textContent=active?.textContent||'Economy';$('#crumb').textContent='DASHBOARD / ECONOMY / '+(active?.textContent||name).toUpperCase();if(name==='general')loadEconomyLeaderboard(1)}
function renderEmojiCategoryNav(){const nav=$('#emoji-categories');if(!nav)return;nav.innerHTML='<button type="button" data-category="custom" title="Server and global emojis">⭐</button>'+Object.keys(unicodeEmojiGroups).map(name=>`<button type="button" data-category="${name}" title="${name}">${emojiCategoryIcons[name]||'•'}</button>`).join('')}
function renderEmojiGrid(){const query=$('#emoji-search').value.trim().toLowerCase(),custom=availableCurrencyEmojis().filter(e=>!query||e.name.toLowerCase().includes(query)),groups=Object.entries(unicodeEmojiGroups).map(([name,items])=>[name,query?items.filter(item=>item.name.toLowerCase().includes(query)||item.keywords.some(keyword=>keyword.includes(query))):items]).filter(([,items])=>items.length);$('.emoji-picker-title').classList.add('hidden');const customHtml=custom.length?`<section class="emoji-group" id="emoji-group-custom"><h4>SERVER & GLOBAL EMOJIS</h4><div class="emoji-group-grid">${custom.map(e=>`<button type="button" data-id="${e.id}" title="${e.global?'Global emoji ':''}:${escapeHtml(e.name)}:"><img src="${escapeHtml(e.url)}" alt=":${escapeHtml(e.name)}:" loading="lazy"></button>`).join('')}</div></section>`:'',unicodeHtml=groups.map(([name,items])=>`<section class="emoji-group" id="emoji-group-${name}"><h4>${name.toUpperCase()}</h4><div class="emoji-group-grid">${items.map(item=>`<button type="button" data-unicode="${item.emoji}" title="${escapeHtml(item.name)}"><img src="/assets/emoji-twitter/${item.unified}.png" alt="${item.emoji}" loading="lazy"></button>`).join('')}</div></section>`).join('');$('#emoji-grid').innerHTML=customHtml+unicodeHtml;$('#emoji-empty').classList.toggle('hidden',custom.length+groups.length>0)}
function currencyEmoji(symbol,selectedId=''){const match=symbol.match(/^<(a?):([^:]+):(\d+)>$/),id=selectedId||match?.[3],knownEmoji=id&&availableCurrencyEmojis().find(e=>e.id===id);if(knownEmoji)return knownEmoji;if(match)return{id:match[3],name:match[2],url:`https://cdn.discordapp.com/emojis/${match[3]}.${match[1]?'gif':'webp'}?size=64&quality=lossless`};const unicode=Object.values(unicodeEmojiGroups).flat().find(item=>item.emoji===symbol);return unicode?{name:unicode.name,url:`/assets/emoji-twitter/${unicode.unified}.png`}:null}
function updateCurrencyPreview(){const symbol=$('#currency-symbol').value.trim()||'$',emoji=currencyEmoji(symbol,$('#currency-symbol').dataset.emojiId),pickerButton=$('#open-emoji-picker'),display=$('#currency-symbol-display');pickerButton.innerHTML='<span aria-hidden="true">▾</span>';if(display)display.innerHTML=emoji?`<img src="${escapeHtml(emoji.url)}" alt=":${escapeHtml(emoji.name)}:">`:`<span>${escapeHtml(symbol)}</span>`;$('#currency-preview').innerHTML=emoji?`<img src="${escapeHtml(emoji.url)}" alt=":${escapeHtml(emoji.name)}:"><span>1,000</span>`:`<strong>${escapeHtml(symbol)}</strong><span>1,000</span>`;updateEconomyCustomizationPreview()}
function updateEconomyCustomizationPreview(){const output=$('#economy-customization-preview');if(!output)return;const value=(key,fallback)=>document.querySelector(`[data-economy-key="${key}"]`)?.value.trim()||fallback,symbol=$('#currency-symbol').value.trim()||'$',emoji=currencyEmoji(symbol,$('#currency-symbol').dataset.emojiId),currency=emoji?`<img src="${escapeHtml(emoji.url)}" alt=":${escapeHtml(emoji.name)}:">`:escapeHtml(symbol);output.innerHTML=`A member carries <strong>${currency} 1,000</strong>, shown as <strong>${escapeHtml(value('cashName','Cash'))}</strong>, and can store it in <strong>${escapeHtml(value('bankName','Bank'))}</strong>. Their combined balance is called <strong>${escapeHtml(value('wealthName','Total'))}</strong>. The shop is named <strong>${escapeHtml(value('shopName','Server shop'))}</strong>, the inventory is named <strong>${escapeHtml(value('inventoryName','Your inventory'))}</strong>, and the leaderboard is named <strong>${escapeHtml(value('leaderboardName','Richest members'))}</strong>.`}
function currencyMarkup(){const symbol=state.data.economy?.currencySymbol||'$',emoji=currencyEmoji(symbol);return emoji?`<img src="${escapeHtml(emoji.url)}" alt=":${escapeHtml(emoji.name)}:">`:escapeHtml(symbol)}
function priceMarkup(price,index=0){const system=(state.data.economySystems||[]).find(entry=>entry.id===Number(price.systemId)),symbol=price.currencySymbol||system?.currency_symbol||'$',emoji=currencyEmoji(symbol),value=`${emoji?`<img src="${escapeHtml(emoji.url)}" alt=":${escapeHtml(emoji.name)}:">`:escapeHtml(symbol)} ${Number(price.amount||0).toLocaleString()}`;return index?`<span class="joined-price"><small>${String(price.operator||'or').toUpperCase()}</small> ${value}</span>`:value}
function renderShopItems(){const allItems=state.data.shopItems||[],query=$('#shop-item-search').value.trim().toLowerCase(),category=$('#shop-category-filter').value,categories=[...new Set(allItems.map(item=>item.category).filter(Boolean))].sort();const currentCategory=$('#shop-category-filter').value;$('#shop-category-filter').innerHTML='<option value="">All categories</option>'+categories.map(name=>`<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');$('#shop-category-filter').value=categories.includes(currentCategory)?currentCategory:'';const items=allItems.filter(item=>(!query||item.name.toLowerCase().includes(query)||String(item.description||'').toLowerCase().includes(query))&&(!category||item.category===category));$('#shop-item-count').textContent=`${allItems.length} item${allItems.length===1?'':'s'}`;$('#no-shop-items').classList.toggle('hidden',items.length>0);const createTile='<button id="add-shop-item" class="shop-item-tile create-shop-item" type="button"><span>+</span><b>Create<br>item</b></button>';$('#shop-items').innerHTML=createTile+items.map(item=>{const emoji=state.data.emojis.find(e=>e.id===item.emoji_id),prices=item.prices?.length?item.prices:[{amount:item.price,currencySymbol:state.data.economy?.currencySymbol}];return `<article class="shop-item-tile" data-id="${item.id}"><div class="shop-tile-icon">${emoji?`<img src="${escapeHtml(emoji.url)}" alt=":${escapeHtml(emoji.name)}:">`:'?'}</div><h3 title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</h3><div class="shop-tile-price">${prices.map(priceMarkup).join(' <small>OR</small> ')}</div><button class="remove-shop-item" type="button" title="Delete item">×</button></article>`}).join('')}
function shopRequirementRow(){return `<div class="shop-builder-row requirement-row"><select class="shop-requirement-type"><option value="role">Role</option></select><select class="shop-requirement-role"><option value="">Select a role</option>${state.data.roles.map(r=>`<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('')}</select><select class="shop-requirement-event"><option value="buy">Item buy</option><option value="use">Item use</option><option value="both">Buy and use</option></select><button class="remove" type="button">×</button></div>`}
function shopActionRow(){return `<div class="shop-builder-row action-row"><select class="shop-action-type"><option value="message">Send message</option><option value="role">Give role</option></select><select class="shop-action-event"><option value="buy">Item buy</option><option value="use">Item use</option><option value="both">Buy and use</option></select><input class="shop-action-value" maxlength="2000" placeholder="Message or role ID"><button class="remove" type="button">×</button></div>`}
const nameplatePaletteColors={crimson:'#900007',berry:'#893a99',sky:'#0080b7',teal:'#086460',forest:'#2d5401',bubble_gum:'#dc3e97',violet:'#730bc8',cobalt:'#0131c2',clover:'#047b20',lemon:'#f6cd12',white:'#ffffff'};
function nameplateColor(user){return nameplatePaletteColors[user.nameplatePalette]||user.bannerColor||'#313338'}
function leaderboardNameplate(user,mirrored=false){if(!user.nameplateUrl)return '<span class="leaderboard-nameplate-empty"></span>';return `<span class="leaderboard-nameplate${mirrored?' leaderboard-nameplate-left':''}"><video autoplay loop muted playsinline disablepictureinpicture controlslist="nodownload noplaybackrate nopictureinpicture" preload="metadata" poster="${escapeHtml(user.nameplateUrl)}" aria-hidden="true"><source src="${escapeHtml(user.animatedNameplateUrl)}" type="video/webm"><img src="${escapeHtml(user.nameplateUrl)}" alt=""></video></span>`}
function renderLeaderboard(items){$('#leaderboard').innerHTML=items.length?items.map(x=>`<div style="--nameplate-color:${nameplateColor(x)}">${leaderboardNameplate(x,true)}<b>#${x.rank}</b><span class="leaderboard-user">${x.avatarUrl?`<span class="leaderboard-avatar"><img class="leaderboard-avatar-image" src="${escapeHtml(x.avatarUrl)}" alt="" loading="lazy">${x.avatarDecorationUrl?`<img class="leaderboard-avatar-decoration" src="${escapeHtml(x.avatarDecorationUrl)}" alt="">`:''}</span>`:''}<span class="leaderboard-username">${escapeHtml(x.username)}</span></span><strong>Level ${x.level}</strong><small>${x.xp.toLocaleString()} XP</small>${leaderboardNameplate(x)}</div>`).join(''):'<div class="empty compact">No matching members found.</div>'}
async function loadLeaderboard(page=1){const requestId=++leaderboardRequestId,search=$('#leaderboard-search').value.trim();const result=await request(`/api/guilds/${state.guildId}/leaderboard?systemId=${state.systemId}&page=${page}&search=${encodeURIComponent(search)}`);if(requestId!==leaderboardRequestId)return;renderLeaderboard(result.items);$('#leaderboard-page').textContent=`Page ${result.page} of ${result.totalPages}`;$('#leaderboard-prev').disabled=result.page<=1;$('#leaderboard-next').disabled=result.page>=result.totalPages;$('#leaderboard-pagination').dataset.page=String(result.page)}
function renderEconomyLeaderboard(items){$('#economy-leaderboard').innerHTML=items.length?items.map(x=>`<div style="--nameplate-color:${nameplateColor(x)}">${leaderboardNameplate(x,true)}<b>#${x.rank}</b><span class="leaderboard-user">${x.avatarUrl?`<span class="leaderboard-avatar"><img class="leaderboard-avatar-image" src="${escapeHtml(x.avatarUrl)}" alt="" loading="lazy">${x.avatarDecorationUrl?`<img class="leaderboard-avatar-decoration" src="${escapeHtml(x.avatarDecorationUrl)}" alt="">`:''}</span>`:''}<span class="leaderboard-username">${escapeHtml(x.username)}</span></span><strong>${currencyMarkup()} ${Number(x.cash).toLocaleString()}</strong><small>${currencyMarkup()} ${Number(x.bank).toLocaleString()}</small>${leaderboardNameplate(x)}</div>`).join(''):'<div class="empty compact">No matching members found.</div>'}
async function loadEconomyLeaderboard(page=1){if(!state.guildId)return;const search=$('#economy-leaderboard-search').value.trim(),metric=$('#economy-leaderboard-metric').value;const result=await request(`/api/guilds/${state.guildId}/economy/leaderboard?page=${page}&metric=${metric}&systemId=${state.economySystemId||''}&search=${encodeURIComponent(search)}`);renderEconomyLeaderboard(result.items);$('#economy-leaderboard-page').textContent=`Page ${result.page} of ${result.totalPages}`;$('#economy-leaderboard-prev').disabled=result.page<=1;$('#economy-leaderboard-next').disabled=result.page>=result.totalPages;$('#economy-leaderboard-pagination').dataset.page=String(result.page)}
async function selectSystem(id){ state.systemId=Number(id); const s=state.data.systems.find(x=>x.id===state.systemId); $('#system-select').value=String(s.id); $('#system-name').value=s.name; $('#enabled').checked=!!s.enabled; $('#content-type').value=s.content_type; $('#specific-words').value=s.specific_words||''; $('#min-xp').value=s.min_xp_values||s.min_xp; $('#max-xp').value=s.max_xp_values||s.max_xp; $('#cooldown').value=s.cooldown_seconds; $('#message').value=s.announce_message; $('#announce-destination').value=s.announce_destination||'current'; $('#channel').value=s.announce_channel_id||''; updateDestinationFields(); const allowed=new Set(s.channelRules.filter(r=>r.mode==='allow').map(r=>r.channel_id)),denied=new Set(s.channelRules.filter(r=>r.mode==='deny').map(r=>r.channel_id)),allowedRoles=new Set(s.roleRules.filter(r=>r.mode==='allow').map(r=>r.role_id)),deniedRoles=new Set(s.roleRules.filter(r=>r.mode==='deny').map(r=>r.role_id)); [...$('#allowed-channels').options].forEach(o=>o.selected=allowed.has(o.value)); [...$('#denied-channels').options].forEach(o=>o.selected=denied.has(o.value)); [...$('#allowed-roles').options].forEach(o=>o.selected=allowedRoles.has(o.value)); [...$('#denied-roles').options].forEach(o=>o.selected=deniedRoles.has(o.value)); $('#channel-rule-mode').value=denied.size?'deny':allowed.size?'allow':'deny'; $('#role-rule-mode').value=deniedRoles.size?'deny':allowedRoles.size?'allow':'deny'; renderRulePicker('channel'); renderRulePicker('role'); renderRewards(s.rewards); $('#reward-count').textContent=s.rewards.length; $('#status').textContent=s.enabled?'Active':'Paused'; $('#leaderboard-search').value=''; await loadLeaderboard(1); }
function roleTint(role){return /^#[0-9a-f]{6}$/i.test(role?.color||'')&&role.color!=='#000000'?role.color:'var(--discord-muted)'}
function syncRewardRoleTint(select){const role=state.data.roles.find(item=>item.id===select.value);select.style.color=roleTint(role)}
function renderRewards(items){$('#reward-list').innerHTML=items.map(r=>rewardRow(r.level,r.role_id)).join('');document.querySelectorAll('.reward-role').forEach(syncRewardRoleTint);$('#no-rewards').classList.toggle('hidden',items.length>0)}
function rewardRow(level=10,roleId=''){const options=state.data.roles.map(r=>`<option value="${r.id}" data-role-color="${roleTint(r)}" ${r.id===roleId?'selected':''}>@ ${escapeHtml(r.name)}</option>`).join('');return `<div class="reward-row"><input class="reward-level" type="number" min="1" value="${level}" aria-label="Level"><span class="arrow">→</span><select class="reward-role" aria-label="Discord role"><option value="">Select a role</option>${options}</select><button class="remove" title="Remove">×</button></div>`}
function showTab(name){document.querySelectorAll('.panel').forEach(p=>p.classList.add('hidden'));document.querySelectorAll('#level-tabs .level-tab').forEach(b=>b.classList.toggle('active',b.dataset.tab===name));$('#'+name).classList.remove('hidden');$('#title').textContent=name==='overview'?'Levels overview':name==='leveling'?'Leveling settings':'Role rewards';$('#crumb').textContent='DASHBOARD / LEVELS / '+name.toUpperCase()}
function showSection(section){
  if(section!=='moderation')flushModerationSave();
  const economy=section==='economy',levels=section==='levels';
  document.querySelectorAll('.tab').forEach(tab=>tab.classList.toggle('active',tab.dataset.section===section));
  $('#level-tabs').classList.toggle('hidden',!levels);
  $('#economy-tabs').classList.toggle('hidden',!economy);
  $('#moderation-tabs').classList.toggle('hidden',section!=='moderation');
  $('#system-toolbar').classList.toggle('hidden',!levels);
  $('#economy-system-toolbar')?.classList.toggle('hidden',!economy);
  document.querySelectorAll('.panel').forEach(panel=>panel.classList.add('hidden'));
  if(economy){renderEconomy();renderEconomyRules();renderShopItems();$('#economy').classList.remove('hidden');showEconomyPage(document.querySelector('.economy-child.active')?.dataset.economyPage||'general')}
  else if(levels)showTab(document.querySelector('#level-tabs .level-tab.active')?.dataset.tab||'overview');
  else if(section==='premium'){$('#premium').classList.remove('hidden');$('#title').textContent='Premium';$('#crumb').textContent='DASHBOARD / PREMIUM';renderPremium()}
  else if(section==='moderation'){$('#moderation').classList.remove('hidden');showModerationPage(document.querySelector('.moderation-child.active')?.dataset.moderationPage||'overview');loadModeration()}
}
document.querySelectorAll('.tab').forEach(button=>button.onclick=()=>showSection(button.dataset.section));
document.querySelectorAll('#level-tabs .level-tab').forEach(b=>b.onclick=()=>showTab(b.dataset.tab));
function showModerationPage(page){
  document.querySelectorAll('.moderation-child').forEach(button=>button.classList.toggle('active',button.dataset.moderationPage===page));
  document.querySelectorAll('[data-moderation-content]').forEach(content=>content.classList.toggle('hidden',content.dataset.moderationContent!==page));
  $('#title').textContent=page==='honeypot'?'Honeypot':'Moderation overview';
  $('#crumb').textContent='DASHBOARD / MODERATION / '+page.toUpperCase();
}
document.querySelectorAll('.moderation-child').forEach(button=>button.onclick=()=>showModerationPage(button.dataset.moderationPage));
document.querySelectorAll('.economy-child').forEach(button=>button.onclick=()=>showEconomyPage(button.dataset.economyPage));
$('#currency-symbol').oninput=()=>{$('#currency-symbol').dataset.emojiId='';updateCurrencyPreview()};
$('#currency-symbol').readOnly=true;
$('#currency-symbol').insertAdjacentHTML('afterend','<span id="currency-symbol-display" class="currency-symbol-display" aria-hidden="true"></span>');
$('#currency-symbol').onclick=()=>$('#open-emoji-picker').click();
$('#currency-symbol-display').onclick=()=>$('#open-emoji-picker').click();
$('#currency-symbol').closest('label').querySelector('small').textContent='Choose a standard, server, or global application emoji.';
const emojiSearchTools=document.createElement('div');emojiSearchTools.className='select-popup-tools search-only';$('#emoji-search').before(emojiSearchTools);emojiSearchTools.append($('#emoji-search'));
const singularCurrencyName=document.querySelector('[data-economy-key="cashName"]'),pluralCurrencyName=document.querySelector('[data-economy-key="cashNamePlural"]');
function syncCurrencyNamePlaceholder(){if(!singularCurrencyName||!pluralCurrencyName)return;const singular=singularCurrencyName.value.trim();pluralCurrencyName.placeholder=singular?`${singular}s`:'Plural, e.g. Candies'}
if(pluralCurrencyName?.value==='Cash')pluralCurrencyName.value='';
const renderEconomyWithUnsyncedCurrencyNames=renderEconomy;
renderEconomy=function(){renderEconomyWithUnsyncedCurrencyNames();syncCurrencyNamePlaceholder()};
singularCurrencyName?.addEventListener('input',syncCurrencyNamePlaceholder);
pluralCurrencyName?.addEventListener('focus',syncCurrencyNamePlaceholder);
syncCurrencyNamePlaceholder();
document.querySelectorAll('[data-economy-key="cashName"],[data-economy-key="cashNamePlural"],[data-economy-key="bankName"],[data-economy-key="wealthName"],[data-economy-key="shopName"],[data-economy-key="inventoryName"],[data-economy-key="leaderboardName"]').forEach(field=>field.addEventListener('input',updateEconomyCustomizationPreview));
$('#economy-customization-preview')?.closest('.card')?.insertAdjacentHTML('afterbegin','<div class="cardhead"><div><h2>Preview</h2><p>See how your customized economy names and currency will appear together.</p></div></div>');
$('#open-emoji-picker').onclick=event=>{event.stopPropagation();const picker=$('#emoji-picker'),opening=picker.classList.contains('hidden');picker.classList.toggle('hidden',!opening);$('#open-emoji-picker').setAttribute('aria-expanded',String(opening));if(opening)$('#emoji-search').focus()};
$('#emoji-search').oninput=renderEmojiGrid;
$('#emoji-grid').addEventListener('error',event=>event.target.closest('button')?.remove(),true);
$('#emoji-grid').onclick=event=>{const button=event.target.closest('button');if(!button)return;const unicode=button.dataset.unicode,emoji=availableCurrencyEmojis().find(e=>e.id===button.dataset.id);if(!unicode&&!emoji)return;$('#currency-symbol').value=unicode||`<${emoji.animated?'a':''}:${emoji.name}:${emoji.id}>`;$('#currency-symbol').dataset.emojiId=emoji?.id||'';$('#emoji-picker').classList.add('hidden');$('#open-emoji-picker').setAttribute('aria-expanded','false');updateCurrencyPreview();scheduleEconomySave()};
document.addEventListener('click',event=>{if(!event.target.closest('.economy-fields')){$('#emoji-picker').classList.add('hidden');$('#open-emoji-picker').setAttribute('aria-expanded','false')}});
async function saveEconomy(){if(!state.guildId||!state.economySystemId)return;try{const config={},selected=id=>[...$(id).selectedOptions].map(option=>option.value);document.querySelectorAll('[data-economy-key]').forEach(field=>config[field.dataset.economyKey]=field.value);config.messageAllowedChannelIds=$('#economy-channel-rule-mode').value==='allow'?selected('#economy-allowed-channels'):[];config.messageDeniedChannelIds=$('#economy-channel-rule-mode').value==='deny'?selected('#economy-denied-channels'):[];config.messageAllowedRoleIds=$('#economy-role-rule-mode').value==='allow'?selected('#economy-allowed-roles'):[];config.messageDeniedRoleIds=$('#economy-role-rule-mode').value==='deny'?selected('#economy-denied-roles'):[];const result=await request(`/api/guilds/${state.guildId}/economy`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({systemId:state.economySystemId,currencySymbol:$('#currency-symbol').value,emojiId:$('#currency-symbol').dataset.emojiId,startingBalance:+$('#starting-balance').value,maxCashBalance:+$('#max-cash-balance').value,maxBankBalance:+$('#max-bank-balance').value,moneyAuditChannelId:$('#money-audit-channel').value,config})});state.data.economy=result;state.data.economySharedNames={shopName:config.shopName,inventoryName:config.inventoryName,leaderboardName:config.leaderboardName};const system=state.data.economySystems.find(entry=>entry.id===state.economySystemId);if(system)Object.assign(system,{currency_symbol:result.currencySymbol,starting_balance:result.startingBalance,max_cash_balance:result.maxCashBalance,max_bank_balance:result.maxBankBalance,config:{...config}});showSaveToast('Economy saved')}catch(error){showSaveToast(error.message,true)}}
function scheduleEconomySave(){clearTimeout(economySaveTimer);economySaveTimer=setTimeout(()=>{economySaveTimer=null;saveEconomy()},650)}
async function flushEconomySave(){if(!economySaveTimer)return;clearTimeout(economySaveTimer);economySaveTimer=null;await saveEconomy()}
$('#save-economy').onclick=()=>{clearTimeout(economySaveTimer);economySaveTimer=null;saveEconomy()};
$('#economy').addEventListener('input',event=>{if(event.target.matches('[data-economy-key], #starting-balance, #max-cash-balance, #max-bank-balance'))scheduleEconomySave()});
$('#economy').addEventListener('change',event=>{if(event.target.matches('[data-economy-key], #starting-balance, #max-cash-balance, #max-bank-balance, #money-audit-channel, #economy-channel-rule-mode, #economy-role-rule-mode'))scheduleEconomySave()});
function closeShopItemModal(){$('#shop-item-modal').classList.add('hidden');editingShopItemId=null}
function syncShopPriceRows(){const systems=state.data.economySystems||[],seen=new Set();[...document.querySelectorAll('.shop-price-row')].forEach(row=>{const id=String(row.querySelector('.shop-price-system').value);if(seen.has(id))row.remove();else seen.add(id)});const rows=[...document.querySelectorAll('.shop-price-row')],chosen=new Set(rows.map(row=>String(row.querySelector('.shop-price-system').value)));rows.forEach((row,index)=>{const select=row.querySelector('.shop-price-system'),current=String(select.value),system=systems.find(entry=>String(entry.id)===current),missing=!system;select.innerHTML=(missing?`<option value="${escapeHtml(current)}" disabled>Missing system — replace or remove</option>`:'')+systems.filter(entry=>String(entry.id)===current||!chosen.has(String(entry.id))).map(entry=>`<option value="${entry.id}">${escapeHtml(entry.name)}</option>`).join('');select.value=current;const emoji=system&&currencyEmoji(system.currency_symbol),icon=row.querySelector('.shop-price-currency-icon');icon.innerHTML=emoji?`<img src="${escapeHtml(emoji.url)}" alt=":${escapeHtml(emoji.name)}:">`:`<span>!</span>`;row.classList.toggle('missing-system',missing);row.classList.toggle('first-price',index===0);row.classList.toggle('only-price',rows.length===1);row.querySelector('.shop-price-operator').classList.toggle('hidden',index===0);row.querySelector('.remove-shop-price').classList.toggle('hidden',rows.length===1)});const add=$('#add-shop-price'),activeChosen=[...chosen].filter(id=>systems.some(system=>String(system.id)===id));if(add){add.disabled=activeChosen.length>=systems.length;add.title=add.disabled?'Every economy system is already used':''}}
function addShopPriceRow(systemId='',amount='',operator='or'){const systems=state.data.economySystems||[],requested=String(systemId||''),missing=!!requested&&!systems.some(system=>String(system.id)===requested),used=new Set([...document.querySelectorAll('.shop-price-system')].map(select=>String(select.value))),available=systems.filter(system=>!used.has(String(system.id)));if(!available.length&&!missing){syncShopPriceRows();return}const selected=missing?{id:requested}:systems.find(system=>String(system.id)===requested&&!used.has(String(system.id)))||available[0],row=document.createElement('div'),displayAmount=Number(amount)>0?Number(amount):'';row.className='shop-price-row';row.innerHTML=`<button type="button" class="shop-price-drag" aria-label="Drag to reorder" title="Drag to reorder"><span></span></button><select class="shop-price-operator" aria-label="Combine this price"><option value="or">OR</option><option value="and">AND</option></select><div class="shop-price-currency"><span class="shop-price-currency-icon"></span><select class="shop-price-system"></select></div><input class="shop-price-amount" type="number" min="0" placeholder="PRICE" value="${displayAmount}"><button type="button" class="remove-shop-price" aria-label="Remove price">×</button>`;const select=row.querySelector('.shop-price-system');select.innerHTML=(missing?`<option value="${escapeHtml(requested)}" disabled>Missing system — replace or remove</option>`:'')+available.map(system=>`<option value="${system.id}">${escapeHtml(system.name)}</option>`).join('');select.value=String(selected.id);row.querySelector('.shop-price-operator').value=operator==='and'?'and':'or';select.onchange=syncShopPriceRows;row.querySelector('.remove-shop-price').onclick=()=>{if(document.querySelectorAll('.shop-price-row').length>1){row.remove();syncShopPriceRows()}};$('#shop-item-prices').append(row);syncShopPriceRows()}
function ensureShopPriceEditor(){const legacy=$('#shop-item-price');if($('#shop-item-prices'))return;const field=document.createElement('div');field.className='shop-prices-field';field.innerHTML='<b>PRICES</b><small>Use OR for alternative prices, or AND when all connected currencies are required.</small><div id="shop-item-prices"></div><button id="add-shop-price" class="outline" type="button">+ Add price option</button>';legacy.closest('label').replaceWith(field);$('#add-shop-price').onclick=()=>addShopPriceRow()}
function openShopItemModal(item=null){ensureShopPriceEditor();editingShopItemId=item?.id||null;$('#shop-item-modal-title').textContent=item?'Edit item':'Create item';$('#create-shop-item').textContent=item?'Save changes':'Create item';$('#shop-item-name').value=item?.name||'';$('#shop-item-prices').innerHTML='';const prices=item?.prices?.length?item.prices:null;(prices||[{}]).forEach((price,index)=>addShopPriceRow(price.systemId,price.amount??0,index?price.operator:'or'));$('#shop-item-category').value=item?.category||'';$('#shop-item-description').value=item?.description||'';$('#shop-item-emoji').innerHTML='<option value="">No icon</option>'+state.data.emojis.map(e=>`<option value="${e.id}">${escapeHtml(e.name)}</option>`).join('');$('#shop-item-emoji').value=item?.emoji_id||'';const emoji=state.data.emojis.find(entry=>entry.id===item?.emoji_id);$('#shop-item-icon-preview').innerHTML=emoji?`<img src="${escapeHtml(emoji.url)}" alt=":${escapeHtml(emoji.name)}:">`:'?';$('#shop-item-unlimited').checked=item?!!item.unlimited_stock:true;$('#shop-item-listed').checked=item?!!item.listed:true;$('#shop-item-inventory').checked=item?!!item.inventory_item:true;$('#shop-item-usable').checked=item?!!item.usable:true;$('#shop-item-sellable').checked=item?!!item.sellable:true;$('#shop-item-stock').value=String(item?.stock??0);$('#shop-stock-field').classList.toggle('hidden',$('#shop-item-unlimited').checked);$('#shop-item-expiry').value=item?.expires_at?String(item.expires_at).slice(0,16):'';$('#shop-requirements').innerHTML='';$('#shop-actions').innerHTML='';let requirements=[],actions=[];try{requirements=JSON.parse(item?.requirements_json||'[]')}catch{}try{actions=JSON.parse(item?.actions_json||'[]')}catch{}requirements.forEach(requirement=>{$('#shop-requirements').insertAdjacentHTML('beforeend',shopRequirementRow());const row=$('#shop-requirements').lastElementChild;row.querySelector('.shop-requirement-type').value=requirement.type||'role';row.querySelector('.shop-requirement-role').value=requirement.roleId||requirement.value||'';row.querySelector('.shop-requirement-event').value=requirement.event||'buy'});actions.forEach(action=>{$('#shop-actions').insertAdjacentHTML('beforeend',shopActionRow());const row=$('#shop-actions').lastElementChild;row.querySelector('.shop-action-type').value=action.type||'message';row.querySelector('.shop-action-event').value=action.event||'buy';row.querySelector('.shop-action-value').value=action.value||''});$('#shop-item-modal').classList.remove('hidden');$('#shop-item-name').focus()}
const shopEmojiSelect=$('#shop-item-emoji'),shopEmojiControl=document.createElement('div');
shopEmojiControl.className='shop-emoji-control';
shopEmojiSelect.before(shopEmojiControl);shopEmojiControl.append(shopEmojiSelect);
shopEmojiControl.insertAdjacentHTML('beforeend','<button id="open-shop-emoji-picker" type="button" aria-expanded="false"><span id="shop-emoji-selection">No icon</span><span aria-hidden="true">▾</span></button><div id="shop-emoji-picker" class="emoji-picker hidden"><input id="shop-emoji-search" type="search" placeholder="Search emojis…" autocomplete="off"><button class="shop-emoji-none" type="button" data-id="">No icon</button><div id="shop-emoji-grid" class="emoji-grid"></div><div id="shop-emoji-empty" class="emoji-empty hidden">No matching emojis</div></div>');
function shopItemEmoji(value){const custom=availableCurrencyEmojis().find(entry=>entry.id===value);if(custom)return custom;const unicode=Object.values(unicodeEmojiGroups).flat().find(entry=>entry.emoji===value);return unicode?{name:unicode.name,emoji:unicode.emoji,url:`/assets/emoji-twitter/${unicode.unified}.png`}:null}
function syncShopEmojiControl(){const emoji=shopItemEmoji(shopEmojiSelect.value);$('#shop-emoji-selection').innerHTML=emoji?`<img src="${escapeHtml(emoji.url)}" alt="${escapeHtml(emoji.emoji||`:${emoji.name}:`)}"><span>${escapeHtml(emoji.name)}</span>`:'<span>No icon</span>'}
function renderShopEmojiPicker(){const query=$('#shop-emoji-search').value.trim().toLowerCase(),custom=availableCurrencyEmojis().filter(emoji=>!query||emoji.name.toLowerCase().includes(query)),groups=Object.entries(unicodeEmojiGroups).map(([name,items])=>[name,query?items.filter(item=>item.name.toLowerCase().includes(query)||item.keywords.some(keyword=>keyword.includes(query))):items]).filter(([,items])=>items.length);const customHtml=custom.length?`<section class="emoji-group"><h4>SERVER & GLOBAL EMOJIS</h4><div class="emoji-group-grid">${custom.map(emoji=>`<button type="button" data-id="${emoji.id}" title=":${escapeHtml(emoji.name)}:"><img src="${escapeHtml(emoji.url)}" alt=":${escapeHtml(emoji.name)}:"></button>`).join('')}</div></section>`:'',unicodeHtml=groups.map(([name,items])=>`<section class="emoji-group"><h4>${name.toUpperCase()}</h4><div class="emoji-group-grid">${items.map(item=>`<button type="button" data-unicode="${item.emoji}" title="${escapeHtml(item.name)}"><img src="/assets/emoji-twitter/${item.unified}.png" alt="${item.emoji}"></button>`).join('')}</div></section>`).join('');$('#shop-emoji-grid').innerHTML=customHtml+unicodeHtml;$('#shop-emoji-empty').classList.toggle('hidden',custom.length+groups.length>0)}
const openShopItemModalWithoutEmojiPicker=openShopItemModal;
openShopItemModal=function(item=null){openShopItemModalWithoutEmojiPicker(item);if(item?.emoji_id&&![...shopEmojiSelect.options].some(option=>option.value===item.emoji_id)){const emoji=availableCurrencyEmojis().find(entry=>entry.id===item.emoji_id);shopEmojiSelect.add(new Option(emoji?.name||item.emoji_id,item.emoji_id));shopEmojiSelect.value=item.emoji_id;shopEmojiSelect.onchange?.()}$('#shop-emoji-search').value='';renderShopEmojiPicker();syncShopEmojiControl()};
$('#open-shop-emoji-picker').onclick=event=>{event.stopPropagation();const picker=$('#shop-emoji-picker'),opening=picker.classList.contains('hidden');picker.classList.toggle('hidden',!opening);event.currentTarget.setAttribute('aria-expanded',String(opening));if(opening)$('#shop-emoji-search').focus()};
$('#shop-emoji-search').oninput=renderShopEmojiPicker;
$('#shop-emoji-picker').onclick=event=>{event.stopPropagation();const button=event.target.closest('[data-id],[data-unicode]');if(!button)return;const value=button.dataset.unicode||button.dataset.id,emoji=shopItemEmoji(value);if(value&&![...shopEmojiSelect.options].some(option=>option.value===value))shopEmojiSelect.add(new Option(emoji?.name||value,value));shopEmojiSelect.value=value;shopEmojiSelect.onchange?.();syncShopEmojiControl();$('#shop-emoji-picker').classList.add('hidden');$('#open-shop-emoji-picker').setAttribute('aria-expanded','false')};
document.addEventListener('click',()=>{$('#shop-emoji-picker').classList.add('hidden');$('#open-shop-emoji-picker').setAttribute('aria-expanded','false')});
$('#close-shop-item-modal').onclick=closeShopItemModal;$('#cancel-shop-item').onclick=closeShopItemModal;$('#shop-item-modal .modal-backdrop').onclick=closeShopItemModal;
$('#shop-item-unlimited').onchange=()=>$('#shop-stock-field').classList.toggle('hidden',$('#shop-item-unlimited').checked);
$('#shop-item-emoji').onchange=()=>{const emoji=shopItemEmoji($('#shop-item-emoji').value);$('#shop-item-icon-preview').innerHTML=emoji?`<img src="${escapeHtml(emoji.url)}" alt="${escapeHtml(emoji.emoji||`:${emoji.name}:`)}">`:'?'};
$('#add-shop-requirement').onclick=()=>$('#shop-requirements').insertAdjacentHTML('beforeend',shopRequirementRow());
$('#add-shop-action').onclick=()=>$('#shop-actions').insertAdjacentHTML('beforeend',shopActionRow());
$('#shop-requirements').onclick=event=>{if(event.target.classList.contains('remove'))event.target.closest('.shop-builder-row').remove()};
$('#shop-actions').onclick=event=>{if(event.target.classList.contains('remove'))event.target.closest('.shop-builder-row').remove()};
$('#create-shop-item').onclick=async()=>{const requirements=[...document.querySelectorAll('.requirement-row')].map(row=>({type:row.querySelector('.shop-requirement-type').value,roleId:row.querySelector('.shop-requirement-role').value,event:row.querySelector('.shop-requirement-event').value})),actions=[...document.querySelectorAll('.action-row')].map(row=>({type:row.querySelector('.shop-action-type').value,event:row.querySelector('.shop-action-event').value,value:row.querySelector('.shop-action-value').value})),prices=[...document.querySelectorAll('.shop-price-row')].map((row,index)=>({systemId:+row.querySelector('.shop-price-system').value,amount:+row.querySelector('.shop-price-amount').value,operator:index?row.querySelector('.shop-price-operator').value:'or'})),payload={name:$('#shop-item-name').value,price:prices[0]?.amount||0,prices,category:$('#shop-item-category').value,description:$('#shop-item-description').value,emojiId:$('#shop-item-emoji').value,unlimitedStock:$('#shop-item-unlimited').checked,stock:+$('#shop-item-stock').value,listed:$('#shop-item-listed').checked,inventoryItem:$('#shop-item-inventory').checked,usable:$('#shop-item-usable').checked,sellable:$('#shop-item-sellable').checked,expiresAt:$('#shop-item-expiry').value,requirements,actions};try{const editing=editingShopItemId!==null,item=await request(`/api/guilds/${state.guildId}/economy/shop-items${editing?`/${editingShopItemId}`:''}`,{method:editing?'PUT':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});if(editing){const index=state.data.shopItems.findIndex(entry=>entry.id===editingShopItemId);if(index>=0)state.data.shopItems[index]=item}else state.data.shopItems.unshift(item);renderShopItems();renderEconomyIssues();closeShopItemModal();showSaveToast(editing?'Shop item updated':'Shop item created')}catch(error){showSaveToast(error.message,true)}};
$('#shop-item-search').oninput=renderShopItems;$('#shop-category-filter').onchange=renderShopItems;
$('#shop-items').onclick=async event=>{if(event.target.closest('#add-shop-item')){openShopItemModal();return}const tile=event.target.closest('.shop-item-tile');if(!tile)return;const id=Number(tile.dataset.id),button=event.target.closest('.remove-shop-item');if(!button){openShopItemModal(state.data.shopItems.find(entry=>entry.id===id));return}event.stopPropagation();if(button.dataset.confirming!=='true'){button.dataset.confirming='true';button.textContent='!';button.title='Click again to confirm deletion';return}await request(`/api/guilds/${state.guildId}/economy/shop-items/${id}`,{method:'DELETE'});state.data.shopItems=state.data.shopItems.filter(entry=>entry.id!==id);renderShopItems();renderEconomyIssues();showSaveToast('Shop item deleted')};
$('#system-select').onchange=async()=>{const id=$('#system-select').value;await flushSave();await selectSystem(id)};
function updateDestinationFields(){const specific=$('#announce-destination').value==='channel';$('#channel-field').classList.toggle('destination-disabled',!specific);$('#channel').disabled=!specific}
$('#announce-destination').onchange=updateDestinationFields;
$('#leaderboard-search').onfocus=event=>event.target.placeholder='';
$('#leaderboard-search').onblur=event=>event.target.placeholder='User';
$('#leaderboard-search').oninput=()=>{clearTimeout(leaderboardSearchTimer);leaderboardSearchTimer=setTimeout(()=>loadLeaderboard(1),300)};
$('#leaderboard-prev').onclick=()=>loadLeaderboard(Math.max(1,Number($('#leaderboard-pagination').dataset.page||1)-1));
$('#leaderboard-next').onclick=()=>loadLeaderboard(Number($('#leaderboard-pagination').dataset.page||1)+1);
$('#economy-leaderboard-search').oninput=()=>{clearTimeout(economyLeaderboardSearchTimer);economyLeaderboardSearchTimer=setTimeout(()=>loadEconomyLeaderboard(1),300)};
$('#economy-leaderboard-metric').onchange=()=>loadEconomyLeaderboard(1);
$('#economy-leaderboard-prev').onclick=()=>loadEconomyLeaderboard(Math.max(1,Number($('#economy-leaderboard-pagination').dataset.page||1)-1));
$('#economy-leaderboard-next').onclick=()=>loadEconomyLeaderboard(Number($('#economy-leaderboard-pagination').dataset.page||1)+1);
function ruleStorage(kind){const mode=$(`#${kind}-rule-mode`).value;return $(`#${mode==='allow'?'allowed':'denied'}-${kind}s`)}
function renderRulePicker(kind){const picker=$(`#${kind}-picker`),storage=ruleStorage(kind),selected=[...storage.selectedOptions];picker.querySelector('.picker-placeholder').classList.toggle('hidden',selected.length>0);picker.querySelector('.picker-tags').innerHTML=selected.map(o=>`<span class="picker-tag" data-value="${o.value}"><button type="button" title="Remove">×</button>${escapeHtml(o.textContent)}</span>`).join('');picker.querySelector('.picker-menu').innerHTML=[...storage.options].map(o=>`<button type="button" data-value="${o.value}" class="${o.selected?'selected':''}"><span>${o.selected?'✓':''}</span>${escapeHtml(o.textContent)}</button>`).join('')}
function setupRulePicker(kind){const picker=$(`#${kind}-picker`);$(`#${kind}-rule-mode`).onchange=()=>{[...$(`#allowed-${kind}s`).options,...$(`#denied-${kind}s`).options].forEach(o=>o.selected=false);picker.classList.remove('open');renderRulePicker(kind)};picker.querySelector('.picker-control').onclick=()=>picker.classList.toggle('open');picker.onclick=event=>{const tag=event.target.closest('.picker-tag button'),item=event.target.closest('.picker-menu button');if(tag){event.stopPropagation();const value=tag.parentElement.dataset.value;[...ruleStorage(kind).options].find(o=>o.value===value).selected=false;renderRulePicker(kind);scheduleSave()}else if(item){event.stopPropagation();const option=[...ruleStorage(kind).options].find(o=>o.value===item.dataset.value);option.selected=!option.selected;renderRulePicker(kind);picker.classList.add('open');scheduleSave()}}}
function economyRuleStorage(kind){const mode=$(`#economy-${kind}-rule-mode`).value;return $(`#economy-${mode==='allow'?'allowed':'denied'}-${kind}s`)}
function renderEconomyRulePicker(kind){const picker=$(`#economy-${kind}-picker`),storage=economyRuleStorage(kind),selected=[...storage.selectedOptions];picker.querySelector('.picker-placeholder').classList.toggle('hidden',selected.length>0);picker.querySelector('.picker-tags').innerHTML=selected.map(o=>`<span class="picker-tag" data-value="${o.value}"><button type="button" title="Remove">×</button>${escapeHtml(o.textContent)}</span>`).join('');picker.querySelector('.picker-menu').innerHTML=[...storage.options].map(o=>`<button type="button" data-value="${o.value}" class="${o.selected?'selected':''}"><span>${o.selected?'✓':''}</span>${escapeHtml(o.textContent)}</button>`).join('')}
function renderEconomyRules(){const config=state.data.economy?.config||{},channelOptions=(state.data.ruleChannels||state.data.channels).filter(c=>!c.category).map(c=>`<option value="${c.id}" data-parent-id="${c.parentId||''}"># ${escapeHtml(c.name)}</option>`).join(''),roleOptions=state.data.roles.map(r=>`<option value="${r.id}">@ ${escapeHtml(r.name)}</option>`).join('');$('#economy-allowed-channels').innerHTML=channelOptions;$('#economy-denied-channels').innerHTML=channelOptions;$('#economy-allowed-roles').innerHTML=roleOptions;$('#economy-denied-roles').innerHTML=roleOptions;const selectValues=(id,values)=>{const chosen=new Set(Array.isArray(values)?values:[]);[...$(id).options].forEach(option=>option.selected=chosen.has(option.value))};selectValues('#economy-allowed-channels',config.messageAllowedChannelIds);selectValues('#economy-denied-channels',config.messageDeniedChannelIds);selectValues('#economy-allowed-roles',config.messageAllowedRoleIds);selectValues('#economy-denied-roles',config.messageDeniedRoleIds);renderEconomyRulePicker('channel');renderEconomyRulePicker('role');renderCategoryPicker(true)}
function setupEconomyRulePicker(kind){const picker=$(`#economy-${kind}-picker`);$(`#economy-${kind}-rule-mode`).onchange=()=>{[...$(`#economy-allowed-${kind}s`).options,...$(`#economy-denied-${kind}s`).options].forEach(o=>o.selected=false);picker.classList.remove('open');renderEconomyRulePicker(kind);scheduleEconomySave()};picker.querySelector('.picker-control').onclick=()=>picker.classList.toggle('open');picker.onclick=event=>{const tag=event.target.closest('.picker-tag button'),item=event.target.closest('.picker-menu button');if(tag){event.stopPropagation();const option=[...economyRuleStorage(kind).options].find(o=>o.value===tag.parentElement.dataset.value);if(option)option.selected=false}else if(item){event.stopPropagation();const option=[...economyRuleStorage(kind).options].find(o=>o.value===item.dataset.value);if(option)option.selected=!option.selected}else return;renderEconomyRulePicker(kind);picker.classList.add('open');scheduleEconomySave()}}
setupRulePicker('channel');setupRulePicker('role');document.addEventListener('click',event=>{if(!event.target.closest('.tag-picker'))document.querySelectorAll('.tag-picker').forEach(p=>p.classList.remove('open'))});
setupEconomyRulePicker('channel');setupEconomyRulePicker('role');
$('#new-system').onclick=async()=>{const created=await request(`/api/guilds/${state.guildId}/systems`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:`Leveling system ${state.data.systems.length+1}`})});await loadGuild(state.guildId,created.id)};
function resetDeleteConfirmation(){$('#modal-delete-system').textContent='Delete system';$('#modal-delete-system').dataset.confirming='false'}
function closeSystemModal(){$('#system-modal').classList.add('hidden');resetDeleteConfirmation()}
$('#system-settings').onclick=()=>{const system=state.data.systems.find(s=>s.id===state.systemId),templates=state.data.systems.filter(s=>s.id!==state.systemId),templateSelect=$('#template-system');$('#modal-system-name').value=system.name;$('#modal-system-enabled').checked=!!system.enabled;templateSelect.innerHTML=templates.length?'<option value="">-</option>'+templates.map(s=>`<option value="${s.id}">${escapeHtml(s.name)}</option>`).join(''):'<option value="">No other systems available</option>';templateSelect.value='';templateSelect.classList.add('empty-selection');$('#template-placeholder').textContent=templates.length?'No system selected':'No other systems available';$('#template-placeholder').classList.remove('hidden');$('#apply-template').disabled=true;$('.template-warning').classList.add('hidden');resetDeleteConfirmation();$('#system-modal').classList.remove('hidden');$('#modal-system-name').focus()};
$('#close-system-modal').onclick=closeSystemModal;$('#system-modal .modal-backdrop').onclick=closeSystemModal;
$('#modal-system-name').oninput=()=>{$('#system-name').value=$('#modal-system-name').value;scheduleSave()};
$('#modal-system-enabled').onchange=()=>{$('#enabled').checked=$('#modal-system-enabled').checked;scheduleSave()};
$('#template-system').onchange=()=>{const selected=!!$('#template-system').value;$('#template-system').classList.toggle('empty-selection',!selected);$('#template-placeholder').classList.toggle('hidden',selected);$('#apply-template').disabled=!selected;$('.template-warning').classList.toggle('hidden',!selected)};
$('#apply-template').onclick=async()=>{const sourceSystemId=Number($('#template-system').value);if(!sourceSystemId)return;await flushSave();await request(`/api/guilds/${state.guildId}/systems/${state.systemId}/apply-template`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sourceSystemId})});closeSystemModal();await loadGuild(state.guildId,state.systemId);showSaveToast('Template applied')};
$('#modal-delete-system').onclick=async()=>{const button=$('#modal-delete-system');if(button.dataset.confirming!=='true'){button.dataset.confirming='true';button.textContent='Are you sure?';return}clearTimeout(saveTimer);saveTimer=null;await request(`/api/guilds/${state.guildId}/systems/${state.systemId}`,{method:'DELETE'});closeSystemModal();await loadGuild(state.guildId);showSaveToast('Leveling system deleted')};
$('#add-reward').onclick=()=>{$('#reward-list').insertAdjacentHTML('beforeend',rewardRow());$('#no-rewards').classList.add('hidden');scheduleSave()}; $('#reward-list').onclick=e=>{if(e.target.classList.contains('remove')){e.target.closest('.reward-row').remove();$('#no-rewards').classList.toggle('hidden',!!document.querySelector('.reward-row'));scheduleSave()}};
function scheduleSave(){clearTimeout(saveTimer);saveTimer=setTimeout(()=>{saveTimer=null;save()},650)}
async function flushSave(){if(!saveTimer)return;clearTimeout(saveTimer);saveTimer=null;await save()}
function showSaveToast(message,error=false){const toast=$('#save-state');clearTimeout(toastTimer);toast.textContent=message;toast.classList.toggle('error',error);toast.classList.remove('hidden');toastTimer=setTimeout(()=>toast.classList.add('hidden'),2200)}
$('#leveling').addEventListener('input',scheduleSave);$('#leveling').addEventListener('change',scheduleSave);$('#rewards').addEventListener('input',scheduleSave);$('#rewards').addEventListener('change',scheduleSave);
$('#reward-list').addEventListener('change',event=>{if(event.target.classList.contains('reward-role'))syncRewardRoleTint(event.target)});
async function save(){if(!state.systemId)return;const rewards=[...document.querySelectorAll('.reward-row')].map(r=>({level:+r.querySelector('.reward-level').value,roleId:r.querySelector('.reward-role').value})).filter(r=>r.roleId),selected=q=>[...$(q).selectedOptions].map(o=>o.value),channelMode=$('#channel-rule-mode').value,roleMode=$('#role-rule-mode').value;try{await request(`/api/guilds/${state.guildId}/settings`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({systemId:state.systemId,name:$('#system-name').value,contentType:$('#content-type').value,specificWords:$('#specific-words').value,enabled:$('#enabled').checked,minXp:$('#min-xp').value,maxXp:$('#max-xp').value,minXpValues:$('#min-xp').value,maxXpValues:$('#max-xp').value,cooldownSeconds:+$('#cooldown').value,announceDestination:$('#announce-destination').value,announceChannelId:$('#channel').value,announceMessage:$('#message').value,rewards,allowedChannelIds:channelMode==='allow'?selected('#allowed-channels'):[],deniedChannelIds:channelMode==='deny'?selected('#denied-channels'):[],allowedRoleIds:roleMode==='allow'?selected('#allowed-roles'):[],deniedRoleIds:roleMode==='deny'?selected('#denied-roles'):[]})});const system=state.data.systems.find(s=>s.id===state.systemId);if(system){system.name=$('#system-name').value;system.enabled=$('#enabled').checked?1:0;system.specific_words=$('#specific-words').value;system.min_xp_values=$('#min-xp').value;system.max_xp_values=$('#max-xp').value;system.rewards=rewards}renderSystemSelect();$('#reward-count').textContent=rewards.length;$('#status').textContent=$('#enabled').checked?'Active':'Paused';showSaveToast('Changes saved')}catch(error){showSaveToast(error.message,true)}}
$('#logout').onclick=async()=>{await fetch('/auth/logout',{method:'POST'});location.href='/'};function escapeHtml(value){const e=document.createElement('div');e.textContent=value;return e.innerHTML}

let activeSelectPopup=null;
function closeSelectPopup(){
  if(!activeSelectPopup)return;
  activeSelectPopup.select.setAttribute('aria-expanded','false');
  activeSelectPopup.select.classList.remove('popup-open');
  activeSelectPopup.menu.remove();
  activeSelectPopup=null;
}
function addSelectPopupTools(menu,onClear){
  const tools=document.createElement('div');
  tools.className='select-popup-tools';
  tools.classList.toggle('search-only',!onClear);
  const empty=document.createElement('div');
  empty.className='select-popup-empty hidden';
  empty.textContent='No items found';
  const search=document.createElement('input');
  search.type='search';
  search.placeholder='Search…';
  search.setAttribute('aria-label','Search options');
  search.oninput=()=>{
    const query=search.value.trim().toLowerCase();
    let matches=0;
    menu.querySelectorAll('.select-popup-option').forEach(item=>{const match=(!query||!item.classList.contains('search-default-option'))&&item.textContent.toLowerCase().includes(query);item.classList.toggle('search-hidden',!match);if(match)matches++});
    empty.classList.toggle('hidden',matches>0);
  };
  tools.appendChild(search);
  if(onClear){
    const clear=document.createElement('button');
    clear.type='button';
    clear.className='select-popup-clear';
    clear.textContent='Clear selections';
    clear.onclick=onClear;
    tools.appendChild(clear);
  }
  menu.append(tools,empty);
}
function selectionRange(length,index,lastIndex,shiftKey){
  if(!shiftKey||lastIndex===null)return [index];
  const start=Math.max(0,Math.min(index,lastIndex)),end=Math.min(length-1,Math.max(index,lastIndex));
  return Array.from({length:end-start+1},(_,offset)=>start+offset);
}
function openSelectPopup(select){
  if(activeSelectPopup?.select===select)return;
  closeSelectPopup();
  const menu=document.createElement('div');
  menu.className='select-popup';
  menu.setAttribute('role','listbox');
  const isContentType=select.id==='content-type'||select.id==='economy-content-type';
  const isEconomyContentType=select.id==='economy-content-type';
  const isBonusRole=select.dataset.economyKey==='bonusRole';
  const isModerationRole=['moderation-admin-role','moderation-moderator-role'].includes(select.id);
  const isRoleMulti=isBonusRole||isModerationRole;
  const isSearchable=select.id==='money-audit-channel'||isRoleMulti;
  const system=isContentType&&!isEconomyContentType&&state.data?.systems.find(item=>item.id===state.systemId);
  const storedValue=isEconomyContentType?state.data?.economy?.config?.messageContentFilter||'any':isContentType?system?.content_filter||system?.content_type||'any':isBonusRole?state.data?.economy?.config?.bonusRole||select.value:select.value;
  const selectedValues=new Set(String(storedValue||'').split(',').filter(Boolean));
  if(isContentType||isRoleMulti)menu.setAttribute('aria-multiselectable','true');
  if(isSearchable)addSelectPopupTools(menu,isRoleMulti?()=>{selectedValues.clear();if(isBonusRole)state.data.economy.config.bonusRole='';syncBonusRoleSelect(select,'');select.dispatchEvent(new Event('change',{bubbles:true}));menu.querySelectorAll('.select-popup-option').forEach(item=>{item.classList.remove('selected');item.setAttribute('aria-selected','false')})}:null);
  const popupOptions=[...select.options].filter(option=>!option.dataset.summary&&!(isRoleMulti&&option.value===''));
  let lastSelectedIndex=null;
  popupOptions.forEach((option,optionIndex)=>{
    const item=document.createElement('button');
    item.type='button';
    item.textContent=option.textContent;
    item.dataset.baseLabel=option.textContent;
    if(isEconomyContentType){const selectedIndex=[...selectedValues].indexOf(option.value),amounts=String($('[data-economy-key="messageReward"]').value||state.data.economy.config?.messageReward||'').split(',').map(value=>value.trim()||'0');setEconomyContentOptionLabel(item,option.textContent,selectedIndex<0?null:amounts[selectedIndex]||'0')}
    else if(isContentType){const selectedIndex=[...selectedValues].indexOf(option.value),mins=String($('#min-xp').value).split(',').map(value=>value.trim()),maxes=String($('#max-xp').value).split(',').map(value=>value.trim());setLevelContentOptionLabel(item,option.textContent,selectedIndex<0?null:`${mins[selectedIndex]||'0'}–${maxes[selectedIndex]||'0'}`)}
    item.dataset.value=option.value;
    item.classList.toggle('select-popup-option',isSearchable);
    item.classList.toggle('search-default-option',isSearchable&&option.value==='');
    item.classList.toggle('channel-child',!!option.dataset.parentId);
    item.classList.toggle('channel-category',option.dataset.category==='true');
    item.disabled=option.disabled;
    item.classList.toggle('selected',selectedValues.has(option.value));
    item.setAttribute('role','option');
    item.setAttribute('aria-selected',String(selectedValues.has(option.value)));
    item.onclick=event=>{
      if(isContentType){
        const previousValues=[...selectedValues],previousAmounts=isEconomyContentType?String($('[data-economy-key="messageReward"]').value||state.data.economy.config?.messageReward||'').split(',').map(value=>value.trim()||'0'):[],previousMins=!isEconomyContentType?$('#min-xp').value.split(',').map(value=>value.trim()||'0'):[],previousMaxes=!isEconomyContentType?$('#max-xp').value.split(',').map(value=>value.trim()||'0'):[];
        if(option.value==='any'){selectedValues.clear();selectedValues.add('any')}
        else{
          const shouldSelect=!selectedValues.has(option.value);
          selectedValues.delete('any');
          selectionRange(popupOptions.length,optionIndex,lastSelectedIndex,event.shiftKey).forEach(index=>{const value=popupOptions[index].value;if(value!=='any')selectedValues[shouldSelect?'add':'delete'](value)});
          if(!selectedValues.size)selectedValues.add('any');
        }
        lastSelectedIndex=optionIndex;
        if(isEconomyContentType){const amountByType=new Map(previousValues.map((value,index)=>[value,previousAmounts[index]||'0']));state.data.economy.config.messageContentFilter=[...selectedValues].join(',');state.data.economy.config.messageReward=[...selectedValues].map(value=>amountByType.get(value)||'0').join(', ');syncEconomyContentTypeSelect()}
        else{const minByType=new Map(previousValues.map((value,index)=>[value,previousMins[index]||''])),maxByType=new Map(previousValues.map((value,index)=>[value,previousMaxes[index]||'']));system.content_filter=[...selectedValues].join(',');system.min_xp_values=[...selectedValues].map(value=>minByType.get(value)||'').join(',').replace(/(?:,\s*)+$/,'');system.max_xp_values=[...selectedValues].map(value=>maxByType.get(value)||'').join(',').replace(/(?:,\s*)+$/,'');$('#min-xp').value=system.min_xp_values;$('#max-xp').value=system.max_xp_values;syncContentTypeSelect()}
        select.dispatchEvent(new Event('change',{bubbles:true}));
        menu.querySelectorAll('button').forEach(button=>{const selected=selectedValues.has(button.dataset.value);button.classList.toggle('selected',selected);button.setAttribute('aria-selected',String(selected))});
        if(isEconomyContentType)refreshEconomyContentPopupRewards();
        else refreshLevelContentPopupRewards();
        return;
      }
      if(isRoleMulti){
        const shouldSelect=!selectedValues.has(option.value);
        selectionRange(popupOptions.length,optionIndex,lastSelectedIndex,event.shiftKey).forEach(index=>selectedValues[shouldSelect?'add':'delete'](popupOptions[index].value));
        lastSelectedIndex=optionIndex;
        const value=[...selectedValues].join(',');
        if(isBonusRole)state.data.economy.config.bonusRole=value;
        syncBonusRoleSelect(select,value);
        select.dispatchEvent(new Event('change',{bubbles:true}));
        menu.querySelectorAll('.select-popup-option').forEach(button=>{const selected=selectedValues.has(button.dataset.value);button.classList.toggle('selected',selected);button.setAttribute('aria-selected',String(selected))});
        return;
      }
      if(select.value!==option.value){select.value=option.value;select.dispatchEvent(new Event('change',{bubbles:true}))}
      closeSelectPopup();
      select.focus();
    };
    menu.appendChild(item);
  });
  document.body.appendChild(menu);
  const rect=select.getBoundingClientRect(),gap=10,spaceAbove=rect.top-gap;
  const placement=spaceAbove>=menu.offsetHeight?'above':'below';
  positionSelectPopup(select,menu,placement);
  select.setAttribute('aria-expanded','true');
  activeSelectPopup={select,menu,placement,anchorRect:select.getBoundingClientRect(),originLeft:parseFloat(menu.style.left),originTop:parseFloat(menu.style.top)};
}
function positionSelectPopup(select,menu,placement){
  const rect=select.getBoundingClientRect(),gap=10;
  const width=Math.min(rect.width,innerWidth-10);
  menu.style.width=`${width}px`;
  menu.style.left=`${Math.max(5,Math.min(innerWidth-width-5,rect.left))}px`;
  const desiredTop=placement==='below'?rect.bottom+gap:rect.top-gap-menu.offsetHeight;
  menu.style.top=`${Math.max(5,Math.min(innerHeight-menu.offsetHeight-5,desiredTop))}px`;
}
function softlyAnchorSelectPopup(){
  if(!activeSelectPopup)return;
  const {select,menu,anchorRect,originLeft,originTop}=activeSelectPopup,current=select.getBoundingClientRect(),follow=.25;
  const left=originLeft+(current.left-anchorRect.left)*follow;
  const top=originTop+(current.top-anchorRect.top)*follow;
  menu.style.left=`${Math.max(5,Math.min(innerWidth-menu.offsetWidth-5,left))}px`;
  menu.style.top=`${Math.max(5,Math.min(innerHeight-menu.offsetHeight-5,top))}px`;
}
document.addEventListener('mousedown',event=>{
  const select=event.target.closest?.('select:not([multiple])');
  if(select&&!select.disabled){event.preventDefault();select.focus();openSelectPopup(select);return}
  if(activeSelectPopup?.select===event.target.closest?.('.picker-control'))return;
  if(!event.target.closest?.('.select-popup'))closeSelectPopup();
},true);
document.addEventListener('keydown',event=>{
  if(event.target.matches?.('select:not([multiple])')&&['Enter',' ','ArrowDown','ArrowUp'].includes(event.key)){
    event.preventDefault();
    openSelectPopup(event.target);
  }else if(event.key==='Escape')closeSelectPopup();
});
addEventListener('scroll',event=>{
  if(!event.target.closest?.('.select-popup'))softlyAnchorSelectPopup();
},true);
document.addEventListener('wheel',event=>{
  const menu=event.target.closest?.('.select-popup');
  if(!menu)return;
  const atTop=menu.scrollTop<=0,atBottom=menu.scrollTop+menu.clientHeight>=menu.scrollHeight-1;
  if((event.deltaY<0&&atTop)||(event.deltaY>0&&atBottom))event.preventDefault();
},{passive:false});
addEventListener('resize',softlyAnchorSelectPopup);
$('#content-type').innerHTML='<option value="any">All messages</option><option value="text">Text</option><option value="image">Image</option><option value="video">Video</option><option value="link">Link</option><option value="file">File</option><option value="embed">Embed</option><option value="sound">Sound</option><option value="poll">Poll</option><option value="sticker">Sticker</option><option value="forward">Forward</option><option value="word">Specific word</option>';
const specificWordField=document.createElement('label');specificWordField.id='specific-word-field';specificWordField.className='hidden';specificWordField.innerHTML='Specific words<input id="specific-words" maxlength="500" placeholder="hello, event, reward"><small>Separate words with commas. Matching is case-insensitive.</small>';$('#content-type').closest('label').after(specificWordField);
const messageDestinationLabel=$('#announce-destination').closest('label');messageDestinationLabel.classList.add('message-destination-field');messageDestinationLabel.insertAdjacentHTML('beforeend','<small>Choose where members receive level-up messages.</small>');
const levelMessageDivider=document.createElement('div');levelMessageDivider.className='level-message-divider';messageDestinationLabel.before(levelMessageDivider);
$('#money-audit-channel').options[0].textContent='None';
document.querySelector('[data-economy-key="bonusRole"]').parentElement.firstChild.textContent='Bonus roles';
const renderEconomyWithNone=renderEconomy;
renderEconomy=()=>{renderEconomyWithNone();const option=$('#money-audit-channel').options[0];if(option)option.textContent='None';syncBonusRoleSelect();syncEconomyContentTypeSelect()};
function syncBonusRoleSelect(select=document.querySelector('[data-economy-key="bonusRole"]'),raw=state.data?.economy?.config?.bonusRole||''){
  if(!select)return;
  select.querySelector('[data-summary]')?.remove();
  const values=String(raw).split(',').filter(Boolean),labels=values.map(value=>[...select.options].find(option=>option.value===value)?.textContent).filter(Boolean);
  if(!values.length)select.value='';
  else if(values.length===1)select.value=values[0];
  else{const summary=new Option(labels.join(', '),values.join(','),true,true);summary.dataset.summary='true';select.add(summary)}
}
function syncContentTypeSelect(){
  const select=$('#content-type'),system=state.data?.systems.find(item=>item.id===state.systemId);
  if(!system)return;
  select.querySelector('[data-summary]')?.remove();
  const values=String(system.content_filter||system.content_type||'any').split(','),labels=values.map(value=>[...select.options].find(option=>option.value===value)?.textContent).filter(Boolean);
  if(values.length===1&&[...select.options].some(option=>option.value===values[0]))select.value=values[0];
  else{const summary=new Option(labels.join(', '),values.join(','),true,true);summary.dataset.summary='true';select.add(summary)}
  const normalize=(input,stored)=>{const amounts=String(stored||'').split(',').map(value=>value.trim()).filter(value=>value&&Number(value)!==0).slice(0,values.length);input.value=amounts.join(', ');updateLevelXpHint(input);return input.value};
  system.min_xp_values=normalize($('#min-xp'),system.min_xp_values,system.min_xp);
  system.max_xp_values=normalize($('#max-xp'),system.max_xp_values,system.max_xp);
  $('#specific-word-field').classList.toggle('hidden',!values.includes('word'));
}
function setLevelContentOptionLabel(button,label,value){button.classList.add('economy-reward-option');button.textContent='';const name=document.createElement('span');name.textContent=label;button.append(name);if(value!==null){const amount=document.createElement('span');amount.className='economy-reward-value';amount.textContent=value;button.append(amount)}}
function refreshLevelContentPopupRewards(){if(activeSelectPopup?.select?.id!=='content-type')return;const system=state.data.systems.find(item=>item.id===state.systemId),selected=String(system?.content_filter||system?.content_type||'any').split(',').filter(Boolean),mins=$('#min-xp').value.split(',').map(value=>value.trim()||'0'),maxes=$('#max-xp').value.split(',').map(value=>value.trim()||'0');activeSelectPopup.menu.querySelectorAll('button[data-value]').forEach(button=>{const index=selected.indexOf(button.dataset.value);setLevelContentOptionLabel(button,button.dataset.baseLabel,index<0?null:`${mins[index]||'0'}–${maxes[index]||'0'}`)})}
function levelMessageTypeCount(){const system=state.data?.systems.find(item=>item.id===state.systemId);return Math.max(1,String(system?.content_filter||system?.content_type||'any').split(',').filter(Boolean).length)}
function updateLevelXpHint(input){const hint=input.parentElement.querySelector('.xp-values-hint');if(!hint)return;const system=state.data?.systems.find(item=>item.id===state.systemId),types=String(system?.content_filter||system?.content_type||'any').split(',').filter(Boolean),raw=input.value,tokens=raw.split(/[,\s]+/).filter(value=>value&&Number(value)!==0).slice(0,types.length),trailing=tokens.length&&tokens.length<types.length&&/[,\s]$/.test(raw)?', ':'';input.value=tokens.join(', ')+trailing;const prefix=tokens.join(', '),missingLabels=types.slice(tokens.length).map(value=>[...$('#content-type').options].find(option=>option.value===value)?.textContent||value.toUpperCase());hint.querySelector('.xp-values-prefix').textContent=input.value;hint.querySelector('.xp-values-missing').textContent=missingLabels.length?(prefix&&!trailing?', ':'')+missingLabels.join(', '):''}
function sanitizeLevelXpInput(input,finalize=false){const max=levelMessageTypeCount(),raw=input.value.replace(/[^0-9,\s]/g,''),tokens=raw.split(/[,\s]+/).filter(value=>value&&Number(value)!==0).slice(0,max),canContinue=tokens.length<max,trailing=!finalize&&tokens.length>0&&canContinue?(raw.endsWith(', ')?', ':raw.endsWith(',')?',':''):'';input.value=tokens.join(', ')+trailing;updateLevelXpHint(input);refreshLevelContentPopupRewards()}
['min-xp','max-xp'].forEach(id=>{const input=$(`#${id}`),wrap=document.createElement('div'),hint=document.createElement('span');input.removeAttribute('placeholder');wrap.className='xp-values-wrap';hint.className='xp-values-hint';hint.innerHTML='<span class="xp-values-prefix"></span><span class="xp-values-missing"></span>';input.before(wrap);wrap.append(input,hint)});
['min-xp','max-xp'].forEach(id=>{const input=$(`#${id}`);input.addEventListener('input',()=>sanitizeLevelXpInput(input));input.addEventListener('blur',()=>sanitizeLevelXpInput(input,true));input.addEventListener('keydown',event=>{if(event.key!==' '&&event.key!==',')return;const start=input.selectionStart??input.value.length,end=input.selectionEnd??start,before=input.value.slice(0,start).replace(/\s+$/,''),after=input.value.slice(end).replace(/^\s+/, '');if(!/\d$/.test(before)){event.preventDefault();return}event.preventDefault();input.value=after.startsWith(',')?`${before}${after}`:`${before}, ${after}`;const caret=before.length+(after.startsWith(',')?Math.min(2,after.length):2);input.setSelectionRange(caret,caret);input.dispatchEvent(new Event('input',{bubbles:true}))})});
function syncEconomyContentTypeSelect(){
  const select=$('#economy-content-type');
  if(!select||!state.data?.economy)return;
  select.querySelector('[data-summary]')?.remove();
  const values=String(state.data.economy.config?.messageContentFilter||'any').split(','),labels=values.map(value=>[...select.options].find(option=>option.value===value)?.textContent).filter(Boolean);
  if(values.length===1&&[...select.options].some(option=>option.value===values[0]))select.value=values[0];
  else{const summary=new Option(labels.join(', '),values.join(','),true,true);summary.dataset.summary='true';select.add(summary)}
  const reward=$('[data-economy-key="messageReward"]'),configured=state.data.economy.config?.messageReward,amounts=configured===undefined?[]:String(configured).split(',').map(value=>value.trim()||'0');
  while(amounts.length<values.length)amounts.push('0');
  const normalized=amounts.slice(0,values.length),zeroHint=values.map(()=>'0').join(', ');
  reward.placeholder=zeroHint;
  reward.value=normalized.every(value=>Number(value)===0)?'':normalized.join(', ');
  state.data.economy.config.messageReward=normalized.join(', ')||'0';
}
const economyMessageRewardInput=$('[data-economy-key="messageReward"]');
function economyMessageTypeCount(){return Math.max(1,String(state.data?.economy?.config?.messageContentFilter||'any').split(',').filter(Boolean).length)}
function sanitizeEconomyMessageRewards(finalize=false){const input=economyMessageRewardInput,max=economyMessageTypeCount(),raw=input.value.replace(/[^0-9,\s]/g,''),tokens=raw.split(/[,\s]+/).filter(Boolean).slice(0,max),canContinue=tokens.length<max,trailing=!finalize&&canContinue?(raw.endsWith(', ')?', ':raw.endsWith(',')?',':''):'';input.value=tokens.join(', ')+trailing}
function setEconomyContentOptionLabel(button,label,amount){button.classList.add('economy-reward-option');button.textContent='';const name=document.createElement('span');name.textContent=label;button.append(name);if(amount!==null){const value=document.createElement('span');value.className='economy-reward-value';value.textContent=amount;button.append(value)}}
function refreshEconomyContentPopupRewards(){if(activeSelectPopup?.select?.id!=='economy-content-type')return;const selected=String(state.data.economy.config?.messageContentFilter||'any').split(',').filter(Boolean),amounts=String(economyMessageRewardInput.value||state.data.economy.config?.messageReward||'').split(',').map(value=>value.trim()||'0');activeSelectPopup.menu.querySelectorAll('button[data-value]').forEach(button=>{const index=selected.indexOf(button.dataset.value);setEconomyContentOptionLabel(button,button.dataset.baseLabel,index<0?null:amounts[index]||'0')})}
economyMessageRewardInput.addEventListener('input',()=>{sanitizeEconomyMessageRewards();refreshEconomyContentPopupRewards()});
economyMessageRewardInput.addEventListener('blur',()=>sanitizeEconomyMessageRewards(true));
economyMessageRewardInput.addEventListener('keydown',event=>{if(event.key!==' '&&event.key!==',')return;const input=event.currentTarget,start=input.selectionStart??input.value.length,end=input.selectionEnd??start,before=input.value.slice(0,start).replace(/\s+$/,''),after=input.value.slice(end).replace(/^\s+/, '');if(!/\d$/.test(before)){event.preventDefault();return}event.preventDefault();if(after.startsWith(',')){input.value=`${before}${after}`;input.setSelectionRange(before.length+Math.min(2,after.length),before.length+Math.min(2,after.length))}else{input.value=`${before}, ${after}`;const caret=before.length+2;input.setSelectionRange(caret,caret)}input.dispatchEvent(new Event('input',{bubbles:true}))});
function openRulePickerPopup(picker,kind,isEconomy){
  const control=picker.querySelector('.picker-control');
  if(activeSelectPopup?.select===control)return;
  closeSelectPopup();
  picker.classList.remove('open');
  const storage=isEconomy?economyRuleStorage(kind):ruleStorage(kind),selectedValues=new Set([...storage.selectedOptions].map(option=>option.value));
  const menu=document.createElement('div');
  menu.className='select-popup';
  menu.setAttribute('role','listbox');
  menu.setAttribute('aria-multiselectable','true');
  addSelectPopupTools(menu,()=>{
    [...storage.options].forEach(option=>option.selected=false);
    selectedValues.clear();
    isEconomy?renderEconomyRulePicker(kind):renderRulePicker(kind);
    if(kind==='channel')renderCategoryPicker(isEconomy);
    if(kind==='role')tintSelectedRoleNames();
    storage.dispatchEvent(new Event('change',{bubbles:true}));
    menu.querySelectorAll('.select-popup-option').forEach(item=>{item.classList.remove('selected');item.setAttribute('aria-selected','false')});
  });
  const storageOptions=[...storage.options];
  let lastSelectedIndex=null;
  storageOptions.forEach((option,optionIndex)=>{
    const item=document.createElement('button');
    item.type='button';
    item.className='select-popup-option';
    item.textContent=option.textContent;
    item.dataset.value=option.value;
    item.classList.toggle('channel-child',!!option.dataset.parentId);
    item.classList.toggle('channel-category',option.dataset.category==='true');
    item.classList.toggle('selected',selectedValues.has(option.value));
    item.setAttribute('role','option');
    item.setAttribute('aria-selected',String(selectedValues.has(option.value)));
    item.onclick=event=>{
      const shouldSelect=!option.selected;
      selectionRange(storageOptions.length,optionIndex,lastSelectedIndex,event.shiftKey).forEach(index=>{storageOptions[index].selected=shouldSelect;selectedValues[shouldSelect?'add':'delete'](storageOptions[index].value)});
      lastSelectedIndex=optionIndex;
      menu.querySelectorAll('.select-popup-option').forEach((button,index)=>{button.classList.toggle('selected',storageOptions[index].selected);button.setAttribute('aria-selected',String(storageOptions[index].selected))});
      isEconomy?renderEconomyRulePicker(kind):renderRulePicker(kind);
      if(kind==='role')tintSelectedRoleNames();
      if(kind==='channel')renderCategoryPicker(isEconomy);
      storage.dispatchEvent(new Event('change',{bubbles:true}));
      if(isEconomy)scheduleEconomySave();else scheduleSave();
    };
    menu.appendChild(item);
  });
  document.body.appendChild(menu);
  const rect=control.getBoundingClientRect(),gap=10,spaceAbove=rect.top-gap,placement=spaceAbove>=menu.offsetHeight?'above':'below';
  positionSelectPopup(control,menu,placement);
  control.setAttribute('aria-expanded','true');
  control.classList.add('popup-open');
  activeSelectPopup={select:control,menu,placement,anchorRect:control.getBoundingClientRect(),originLeft:parseFloat(menu.style.left),originTop:parseFloat(menu.style.top)};
}
document.querySelectorAll('.tag-picker').forEach(picker=>{
  const match=picker.id.match(/^(economy-)?(channel|role)-picker$/);
  if(!match)return;
  picker.querySelector('.picker-control').onclick=event=>{
    event.stopPropagation();
    openRulePickerPopup(picker,match[2],!!match[1]);
  };
});
function syncRuleChannelOptions(){
  if(!state.data?.ruleChannels)return;
  const options=state.data.ruleChannels.filter(channel=>!channel.category).map(channel=>`<option value="${channel.id}" data-parent-id="${channel.parentId||''}"># ${escapeHtml(channel.name)}</option>`).join('');
  const system=state.data.systems.find(item=>item.id===state.systemId),allowed=new Set(system?.channelRules.filter(rule=>rule.mode==='allow').map(rule=>rule.channel_id)),denied=new Set(system?.channelRules.filter(rule=>rule.mode==='deny').map(rule=>rule.channel_id));
  $('#allowed-channels').innerHTML=options;
  $('#denied-channels').innerHTML=options;
  [...$('#allowed-channels').options].forEach(option=>option.selected=allowed.has(option.value));
  [...$('#denied-channels').options].forEach(option=>option.selected=denied.has(option.value));
  renderRulePicker('channel');
  renderCategoryPicker();
}
function tintSelectedRoleNames(){
  document.querySelectorAll('#role-picker .picker-tag, #economy-role-picker .picker-tag').forEach(tag=>{
    const role=state.data?.roles.find(item=>item.id===tag.dataset.value);
    tag.style.color=role?.color&&role.color!=='#000000'?role.color:'var(--discord-muted)';
  });
}
function categorySelectionState(isEconomy=false){
  const storage=isEconomy?economyRuleStorage('channel'):ruleStorage('channel'),selected=new Set([...storage.selectedOptions].map(option=>option.value));
  return (state.data?.ruleChannels||[]).filter(channel=>channel.category).map(category=>{
    const children=state.data.ruleChannels.filter(channel=>!channel.category&&channel.parentId===category.id);
    return {...category,children,selected:children.length>0&&children.every(channel=>selected.has(channel.id))};
  });
}
function renderCategoryPicker(isEconomy=false){
  const picker=$(isEconomy?'#economy-category-picker':'#category-picker');
  if(!picker)return;
  const selected=categorySelectionState(isEconomy).filter(category=>category.selected);
  const placeholder=picker.querySelector('.picker-placeholder');
  placeholder.replaceChildren();
  if(selected.length)selected.forEach(category=>{const name=document.createElement('span');name.className='category-selection';name.textContent=category.name;placeholder.appendChild(name)});
  else placeholder.textContent='Select categories…';
  placeholder.classList.toggle('has-selection',selected.length>0);
}
function openCategoryPickerPopup(isEconomy=false){
  const picker=$(isEconomy?'#economy-category-picker':'#category-picker'),control=picker.querySelector('.picker-control');
  if(activeSelectPopup?.select===control)return;
  closeSelectPopup();
  const menu=document.createElement('div');
  menu.className='select-popup';
  menu.setAttribute('role','listbox');
  menu.setAttribute('aria-multiselectable','true');
  addSelectPopupTools(menu,null);
  const categories=categorySelectionState(isEconomy);
  let lastSelectedIndex=null;
  categories.forEach((category,categoryIndex)=>{
    const item=document.createElement('button');
    item.type='button';
    item.className='select-popup-option';
    item.textContent=category.name;
    item.classList.toggle('selected',category.selected);
    item.setAttribute('role','option');
    item.setAttribute('aria-selected',String(category.selected));
    item.onclick=event=>{
      const storage=isEconomy?economyRuleStorage('channel'):ruleStorage('channel'),selectChildren=!category.children.every(channel=>[...storage.options].find(option=>option.value===channel.id)?.selected);
      selectionRange(categories.length,categoryIndex,lastSelectedIndex,event.shiftKey).forEach(index=>categories[index].children.forEach(channel=>{const option=[...storage.options].find(candidate=>candidate.value===channel.id);if(option)option.selected=selectChildren}));
      lastSelectedIndex=categoryIndex;
      renderRulePicker('channel');
      renderCategoryPicker(isEconomy);
      storage.dispatchEvent(new Event('change',{bubbles:true}));
      const states=categorySelectionState(isEconomy);
      menu.querySelectorAll('button').forEach((button,index)=>{button.classList.toggle('selected',states[index].selected);button.setAttribute('aria-selected',String(states[index].selected))});
    };
    menu.appendChild(item);
  });
  document.body.appendChild(menu);
  const rect=control.getBoundingClientRect(),gap=10,spaceAbove=rect.top-gap,placement=spaceAbove>=menu.offsetHeight?'above':'below';
  positionSelectPopup(control,menu,placement);
  control.setAttribute('aria-expanded','true');
  control.classList.add('popup-open');
  activeSelectPopup={select:control,menu,placement,anchorRect:control.getBoundingClientRect(),originLeft:parseFloat(menu.style.left),originTop:parseFloat(menu.style.top)};
}
const categoryPicker=document.createElement('div');
categoryPicker.id='category-picker';
categoryPicker.className='tag-picker category-picker';
categoryPicker.innerHTML='<button type="button" class="picker-control" aria-expanded="false"><span class="picker-placeholder">Select categories…</span><span class="picker-arrow">▾</span></button>';
$('#channel-picker').before(categoryPicker);
$('#channel-picker').closest('.filter-row').classList.add('channel-filter-row');
categoryPicker.querySelector('.picker-control').onclick=event=>{event.stopPropagation();openCategoryPickerPopup()};
const economyCategoryPicker=categoryPicker.cloneNode(true);
economyCategoryPicker.id='economy-category-picker';
$('#economy-channel-picker').before(economyCategoryPicker);
$('#economy-channel-picker').closest('.filter-row').classList.add('channel-filter-row');
economyCategoryPicker.querySelector('.picker-control').onclick=event=>{event.stopPropagation();openCategoryPickerPopup(true)};
function preserveRuleSelections(kind,isEconomy=false){
  const prefix=isEconomy?'economy-':'',modeSelect=$(`#${prefix}${kind}-rule-mode`);
  modeSelect.onchange=()=>{
    const targetMode=modeSelect.value,sourceMode=targetMode==='allow'?'deny':'allow';
    const source=$(`#${prefix}${sourceMode}-${kind}s`),target=$(`#${prefix}${targetMode}-${kind}s`);
    const selected=new Set([...source.selectedOptions].map(option=>option.value));
    [...source.options].forEach(option=>option.selected=false);
    [...target.options].forEach(option=>option.selected=selected.has(option.value));
    isEconomy?renderEconomyRulePicker(kind):renderRulePicker(kind);
    if(kind==='channel')renderCategoryPicker(isEconomy);
    if(kind==='role')tintSelectedRoleNames();
    isEconomy?scheduleEconomySave():scheduleSave();
  };
}
preserveRuleSelections('channel');
preserveRuleSelections('role');
preserveRuleSelections('channel',true);
preserveRuleSelections('role',true);
function switchLevelRuleMode(targetMode,changedKind){
  ['channel','role'].forEach(kind=>{
    const modeSelect=$(`#${kind}-rule-mode`),sourceMode=kind===changedKind?(targetMode==='allow'?'deny':'allow'):modeSelect.value;
    const source=$(`#${sourceMode}-${kind}s`),target=$(`#${targetMode}-${kind}s`),selected=new Set([...source.selectedOptions].map(option=>option.value));
    modeSelect.value=targetMode;
    if(sourceMode!==targetMode){
      [...source.options].forEach(option=>option.selected=false);
      [...target.options].forEach(option=>option.selected=selected.has(option.value));
    }
    renderRulePicker(kind);
  });
  tintSelectedRoleNames();
  scheduleSave();
}
$('#channel-rule-mode').onchange=event=>switchLevelRuleMode(event.target.value,'channel');
$('#role-rule-mode').onchange=event=>switchLevelRuleMode(event.target.value,'role');
const loadGuildWithoutCategories=loadGuild;
loadGuild=async(...args)=>{await loadGuildWithoutCategories(...args);syncRuleChannelOptions()};
const selectSingleSystem=selectSystem;
selectSystem=async id=>{await selectSingleSystem(id);syncContentTypeSelect();renderCategoryPicker();tintSelectedRoleNames()};
function disableSavedInfo(root=document){root.querySelectorAll('input, textarea').forEach(field=>{field.setAttribute('autocomplete','off');field.setAttribute('data-1p-ignore','true');field.setAttribute('data-lpignore','true');field.setAttribute('data-form-type','other')})}
disableSavedInfo();
new MutationObserver(records=>records.forEach(record=>record.addedNodes.forEach(node=>{if(node.nodeType===1){if(node.matches?.('input, textarea'))disableSavedInfo(node.parentElement||document);else disableSavedInfo(node)}}))).observe(document.body,{childList:true,subtree:true});
const renderShopItemsWithoutIssueBadges=renderShopItems;
function syncAndPriceGroups(){const allRows=[...document.querySelectorAll('.shop-price-row')],rows=allRows.filter(row=>!row.classList.contains('dragging'));allRows.filter(row=>row.classList.contains('dragging')).forEach(row=>row.classList.remove('and-group','and-group-start','and-group-middle','and-group-end'));rows.forEach((row,index)=>{const connectedBefore=index>0&&row.querySelector('.shop-price-operator').value==='and',connectedAfter=index<rows.length-1&&rows[index+1].querySelector('.shop-price-operator').value==='and';row.classList.toggle('and-group',connectedBefore||connectedAfter);row.classList.toggle('and-group-start',!connectedBefore&&connectedAfter);row.classList.toggle('and-group-middle',connectedBefore&&connectedAfter);row.classList.toggle('and-group-end',connectedBefore&&!connectedAfter)})}
const syncShopPriceRowsWithoutGroups=syncShopPriceRows;
syncShopPriceRows=()=>{syncShopPriceRowsWithoutGroups();syncAndPriceGroups()};
document.addEventListener('change',event=>{if(event.target.classList.contains('shop-price-operator'))syncAndPriceGroups()});
let shopPriceDrag=null;
document.addEventListener('pointerdown',event=>{const handle=event.target.closest?.('.shop-price-drag');if(!handle||event.button!==0)return;event.preventDefault();const row=handle.closest('.shop-price-row'),rect=row.getBoundingClientRect(),placeholder=document.createElement('div');placeholder.className='shop-price-placeholder';placeholder.style.height=`${rect.height}px`;row.before(placeholder);row.classList.add('dragging');syncAndPriceGroups();Object.assign(row.style,{position:'fixed',zIndex:'10000',left:`${rect.left}px`,top:`${rect.top}px`,width:`${rect.width}px`,height:`${rect.height}px`,margin:'0'});handle.setPointerCapture?.(event.pointerId);shopPriceDrag={row,handle,placeholder,pointerId:event.pointerId,offsetY:event.clientY-rect.top}});
document.addEventListener('pointermove',event=>{if(!shopPriceDrag||event.pointerId!==shopPriceDrag.pointerId)return;event.preventDefault();const {row,placeholder,offsetY}=shopPriceDrag,container=$('#shop-item-prices'),rows=[...container.querySelectorAll('.shop-price-row')].filter(item=>item!==row);row.style.top=`${event.clientY-offsetY}px`;const target=rows.find(item=>event.clientY<item.getBoundingClientRect().top+item.getBoundingClientRect().height/2);container.insertBefore(placeholder,target||null)});
function finishShopPriceDrag(event){if(!shopPriceDrag||event.pointerId!==shopPriceDrag.pointerId)return;const {row,handle,placeholder}=shopPriceDrag;handle.releasePointerCapture?.(event.pointerId);placeholder.replaceWith(row);row.classList.remove('dragging');['position','zIndex','left','top','width','height','margin'].forEach(property=>row.style[property]='');shopPriceDrag=null;syncShopPriceRows()}
document.addEventListener('pointerup',finishShopPriceDrag);
document.addEventListener('pointercancel',finishShopPriceDrag);
function compactShopPrice(price,index){const system=(state.data.economySystems||[]).find(entry=>Number(entry.id)===Number(price.systemId)),symbol=price.currencySymbol||system?.currency_symbol||'',emoji=currencyEmoji(symbol),operator=index?String(price.operator||'or').toUpperCase():'';return `<span class="compact-price-row">${operator?`<small>${operator}</small>`:''}${emoji?`<img src="${escapeHtml(emoji.url)}" alt="">`:`<b>${escapeHtml(symbol||'!')}</b>`}<strong>${Number(price.amount||0).toLocaleString()}</strong></span>`}
renderShopItems=()=>{renderShopItemsWithoutIssueBadges();(state.data?.shopItems||[]).forEach(item=>{const issueCount=item.deactivation_reason?1:0,tile=document.querySelector(`.shop-item-tile[data-id="${item.id}"]`);if(!tile)return;const prices=item.prices?.length?item.prices:[{amount:item.price,currencySymbol:state.data.economy?.currencySymbol,name:'Main economy'}],visible=prices.slice(0,2),priceBox=tile.querySelector('.shop-tile-price');priceBox.innerHTML=visible.map(compactShopPrice).join('')+(prices.length>2?`<span class="more-prices">+${prices.length-2} more</span>`:'');if(issueCount){tile.classList.add('has-issue');tile.insertAdjacentHTML('beforeend',`<span class="shop-item-issue-badge" title="${escapeHtml(item.deactivation_reason)}">${issueCount}</span>`)}})};
const economyToolbar=document.createElement('section');
economyToolbar.id='economy-system-toolbar';economyToolbar.className='system-toolbar hidden';
economyToolbar.innerHTML='<label>ECONOMY SYSTEM<select id="economy-system-select"></select></label><button id="new-economy-system" class="outline">+ New system</button><button id="economy-issues" class="gear-button economy-issues hidden" title="Economy issues" aria-label="Economy issues"><b>!</b><span class="issue-count"></span></button><button id="economy-system-settings" class="gear-button" title="Economy system settings" aria-label="Economy system settings"><img src="/images/gears.png" alt=""></button>';
$('#economy').before(economyToolbar);
document.body.insertAdjacentHTML('beforeend','<div id="economy-issues-modal" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="economy-issues-title"><button class="modal-backdrop" aria-label="Close"></button><div class="modal-card"><div class="modal-head"><div><small>ECONOMY</small><h2 id="economy-issues-title">Needs attention</h2></div><button id="close-economy-issues" class="modal-close" type="button" aria-label="Close">×</button></div><div id="economy-issues-list" class="economy-issues-list"></div><div class="shop-modal-actions"><button id="view-affected-shop-items" class="button" type="button">View shop items</button></div></div></div>');
document.body.insertAdjacentHTML('beforeend','<div id="economy-system-modal" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="economy-system-modal-title"><button class="modal-backdrop" aria-label="Close"></button><div class="modal-card"><div class="modal-head"><div><small>ECONOMY SYSTEM</small><h2 id="economy-system-modal-title">System settings</h2></div><button id="close-economy-system-modal" class="modal-close" type="button" aria-label="Close">×</button></div><label>System name<input id="economy-system-name" maxlength="50" autocomplete="off"></label><div class="modal-toggle"><div><b>System enabled</b><small>Members can use and earn this currency.</small></div><label class="switch"><input id="economy-system-enabled" type="checkbox"><span></span></label></div><div class="template-zone"><div><b>Use another system as template</b><small>Copies currency settings without copying member balances or shop items.</small></div><div class="template-controls"><div class="template-select-wrap"><select id="economy-template-system"></select><span id="economy-template-placeholder">No system selected</span></div><button id="apply-economy-template" type="button" disabled>Apply template</button></div><p id="economy-template-warning" class="template-warning hidden">Applying replaces this system\'s currency, limits, earning settings, access rules, and custom names. Member balances are kept.</p></div><div class="danger-zone"><div><b>Delete economy system</b><small>This permanently removes its currency balances and settings.</small></div><button id="delete-economy-system" type="button">Delete system</button></div></div></div>');
function switchEconomySystem(id){const system=(state.data.economySystems||[]).find(entry=>entry.id===Number(id));if(!system)return;state.economySystemId=system.id;state.data.economy={...state.data.economy,systemId:system.id,currencySymbol:system.currency_symbol,startingBalance:system.starting_balance,maxCashBalance:system.max_cash_balance,maxBankBalance:system.max_bank_balance,config:{...(system.config||{}),...(state.data.economySharedNames||{})}};renderEconomy();renderEconomyRules();renderShopItems();loadEconomyLeaderboard(1)}
function renderEconomySystemSelect(){const select=$('#economy-system-select'),systems=state.data?.economySystems||[];if(!state.economySystemId||!systems.some(system=>system.id===state.economySystemId))state.economySystemId=systems[0]?.id||null;select.innerHTML=systems.map(system=>`<option value="${system.id}">${escapeHtml(system.name)}</option>`).join('');select.value=String(state.economySystemId||'');$('#new-economy-system').disabled=systems.length>=(state.data.premium?.systemLimit||2);$('#new-economy-system').title=$('#new-economy-system').disabled?`Limit of ${state.data.premium?.systemLimit||2} economy systems reached`:''}
$('#economy-system-select').onchange=async event=>{await flushEconomySave();switchEconomySystem(event.target.value)};
$('#new-economy-system').onclick=async()=>{try{const system=await request(`/api/guilds/${state.guildId}/economy/systems`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});system.config={};state.data.economySystems.push(system);renderEconomySystemSelect();switchEconomySystem(system.id);showSaveToast('Economy system created')}catch(error){showSaveToast(error.message,true)}};
function closeEconomySystemModal(){$('#economy-system-modal').classList.add('hidden');$('#delete-economy-system').dataset.confirming='false';$('#delete-economy-system').textContent='Delete system'}
$('#economy-system-settings').onclick=()=>{const system=state.data.economySystems.find(entry=>entry.id===state.economySystemId),templates=state.data.economySystems.filter(entry=>entry.id!==state.economySystemId);if(!system)return;$('#economy-system-name').value=system.name;$('#economy-system-enabled').checked=system.enabled!==0;$('#economy-template-system').innerHTML=templates.length?'<option value="">-</option>'+templates.map(entry=>`<option value="${entry.id}">${escapeHtml(entry.name)}</option>`).join(''):'<option value="">No other systems available</option>';$('#economy-template-system').value='';$('#economy-template-placeholder').textContent=templates.length?'No system selected':'No other systems available';$('#economy-template-placeholder').classList.remove('hidden');$('#apply-economy-template').disabled=true;$('#economy-template-warning').classList.add('hidden');$('#delete-economy-system').disabled=state.data.economySystems.length===1;$('#economy-system-modal').classList.remove('hidden');$('#economy-system-name').focus()};
$('#close-economy-system-modal').onclick=closeEconomySystemModal;$('#economy-system-modal .modal-backdrop').onclick=closeEconomySystemModal;
let economySystemSettingsTimer;
async function saveEconomySystemSettings(){clearTimeout(economySystemSettingsTimer);economySystemSettingsTimer=null;try{const updated=await request(`/api/guilds/${state.guildId}/economy/systems/${state.economySystemId}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:$('#economy-system-name').value,enabled:$('#economy-system-enabled').checked})}),system=state.data.economySystems.find(entry=>entry.id===state.economySystemId);Object.assign(system,updated);const affected=new Set(updated.deactivatedShopItemIds||[]);state.data.shopItems.forEach(item=>{if(affected.has(item.id)){item.listed=0;item.deactivation_reason=`The connected economy system “${system.name}” is disabled.`}});renderEconomySystemSelect();renderShopItems();renderEconomyIssues();showSaveToast(affected.size?`System saved · ${affected.size} shop item${affected.size===1?'':'s'} deactivated`:'System settings saved')}catch(error){showSaveToast(error.message,true)}}
function scheduleEconomySystemSettingsSave(){clearTimeout(economySystemSettingsTimer);economySystemSettingsTimer=setTimeout(saveEconomySystemSettings,650)}
$('#economy-system-name').oninput=scheduleEconomySystemSettingsSave;$('#economy-system-enabled').onchange=scheduleEconomySystemSettingsSave;
$('#economy-template-system').onchange=()=>{const selected=!!$('#economy-template-system').value;$('#economy-template-placeholder').classList.toggle('hidden',selected);$('#apply-economy-template').disabled=!selected;$('#economy-template-warning').classList.toggle('hidden',!selected)};
$('#apply-economy-template').onclick=async()=>{const sourceSystemId=Number($('#economy-template-system').value);if(!sourceSystemId)return;try{clearTimeout(economySystemSettingsTimer);await flushEconomySave();const updated=await request(`/api/guilds/${state.guildId}/economy/systems/${state.economySystemId}/apply-template`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sourceSystemId})}),system=state.data.economySystems.find(entry=>entry.id===state.economySystemId);Object.assign(system,updated,{config:JSON.parse(updated.config_json||'{}')});switchEconomySystem(state.economySystemId);closeEconomySystemModal();showSaveToast('Template applied')}catch(error){showSaveToast(error.message,true)}};
$('#delete-economy-system').onclick=async event=>{const button=event.currentTarget;if(button.disabled)return;if(button.dataset.confirming!=='true'){button.dataset.confirming='true';button.textContent='Are you sure?';return}try{clearTimeout(economySaveTimer);clearTimeout(economySystemSettingsTimer);economySaveTimer=null;economySystemSettingsTimer=null;const deletedId=state.economySystemId,deletedSystem=state.data.economySystems.find(entry=>entry.id===deletedId),affected=state.data.shopItems.filter(item=>(item.prices||[]).some(price=>Number(price.systemId)===deletedId));await request(`/api/guilds/${state.guildId}/economy/systems/${deletedId}`,{method:'DELETE'});affected.forEach(item=>{item.listed=0;item.deactivation_reason=`The connected economy system “${deletedSystem?.name||'Unknown system'}” was deleted.`});state.data.economySystems=state.data.economySystems.filter(entry=>entry.id!==deletedId);state.economySystemId=state.data.economySystems[0].id;renderEconomySystemSelect();switchEconomySystem(state.economySystemId);renderEconomyIssues();closeEconomySystemModal();showSaveToast(`Economy system deleted${affected.length?` · ${affected.length} shop item${affected.length===1?'':'s'} deactivated`:''}`)}catch(error){showSaveToast(error.message,true)}};
function economyIssues(){return (state.data?.shopItems||[]).filter(item=>item.deactivation_reason)}
function renderEconomyIssues(){const issues=economyIssues(),button=$('#economy-issues');button.classList.toggle('hidden',!issues.length);button.querySelector('.issue-count').textContent=issues.length?String(issues.length):'';$('#economy-issues-list').innerHTML=issues.length?issues.map(item=>`<article><b>${escapeHtml(item.name)}</b><p>${escapeHtml(item.deactivation_reason)}</p></article>`).join(''):'<div class="empty compact">No economy issues.</div>'}
function closeEconomyIssues(){$('#economy-issues-modal').classList.add('hidden')}
$('#economy-issues').onclick=()=>{renderEconomyIssues();$('#economy-issues-modal').classList.remove('hidden')};$('#close-economy-issues').onclick=closeEconomyIssues;$('#economy-issues-modal .modal-backdrop').onclick=closeEconomyIssues;
$('#view-affected-shop-items').onclick=()=>{closeEconomyIssues();showEconomyPage('shop')};
document.querySelectorAll('.tab').forEach(tab=>tab.addEventListener('click',()=>{const economy=tab.dataset.section==='economy';economyToolbar.classList.toggle('hidden',!economy);if(economy){renderEconomySystemSelect();switchEconomySystem(state.economySystemId||state.data.economySystems?.[0]?.id);renderEconomyIssues()}}));

let moderationRequestId=0;
let moderationLoadedGuild=null;
let moderationSaveTimer;
let moderationPendingSave=null;
let moderationSaveQueue=Promise.resolve();
let moderationEditVersion=0;
function scheduleModerationSave(){
  if(moderationLoadedGuild!==state.guildId)return;
  clearTimeout(moderationSaveTimer);moderationSaveTimer=null;
  const version=++moderationEditVersion;
  try{
    moderationPendingSave={guildId:state.guildId,version,body:{enabled:$('#moderation-enabled').checked,logChannelId:$('#moderation-log-channel').value,honeypotChannelId:$('#honeypot-channel').value,adminRoleId:$('#moderation-admin-role').value,moderatorRoleId:$('#moderation-moderator-role').value,warningRules:collectWarningRules()}};
    moderationSaveTimer=setTimeout(flushModerationSave,650);
  }catch(error){moderationPendingSave=null;showSaveToast(error.message,true)}
}
function flushModerationSave(){
  clearTimeout(moderationSaveTimer);moderationSaveTimer=null;
  const pending=moderationPendingSave;moderationPendingSave=null;
  if(pending)moderationSaveQueue=moderationSaveQueue.then(async()=>{
    try{
      await request(`/api/guilds/${pending.guildId}/moderation`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(pending.body)});
      if(state.guildId===pending.guildId&&moderationEditVersion===pending.version)showSaveToast('Moderation saved');
    }catch(error){if(state.guildId===pending.guildId&&moderationEditVersion===pending.version)showSaveToast(error.message,true)}
  });
  return moderationSaveQueue;
}
function moderationMessageLinks(entry){
  let links=[];try{links=JSON.parse(entry.message_links||'[]')}catch{}
  if(!Array.isArray(links))return '';
  return links.filter(link=>typeof link==='string'&&/^https:\/\/(?:discord(?:app)?\.com|canary\.discord\.com|ptb\.discord\.com)\/channels\/\d+\/\d+\/\d+(?:[?#].*)?$/.test(link)).map((link,index)=>`<a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">Message ${index+1}</a>`).join(' - ');
}
function syncWarningRules(){
  $('#warning-rules-empty').classList.toggle('hidden',!!$('#warning-rules').children.length);
  $('#add-warning-rule').disabled=$('#warning-rules').children.length>=20;
}
function addWarningRule(rule={}){
  if($('#warning-rules').children.length>=20)return;
  const used=[...document.querySelectorAll('.warning-rule-count')].map(input=>Number(input.value));
  const count=rule.warnings||Math.max(1,...used)+1;
  const row=document.createElement('div');row.className='warning-rule-row';
  row.innerHTML='<label>Warning number<input class="warning-rule-count" type="number" min="1" max="100" required></label><label>Punishment<select class="warning-rule-action"><option value="timeout">Timeout</option><option value="kick">Kick</option><option value="ban">Ban</option></select></label><label class="warning-rule-duration">Minutes<input class="warning-rule-minutes" type="number" min="1" max="40320" value="60"></label><button type="button" class="outline warning-rule-remove" aria-label="Remove punishment">Remove</button>';
  row.querySelector('.warning-rule-count').value=count;row.querySelector('.warning-rule-action').value=rule.action||'kick';row.querySelector('.warning-rule-minutes').value=rule.minutes||60;
  const sync=()=>row.querySelector('.warning-rule-duration').classList.toggle('hidden',row.querySelector('.warning-rule-action').value!=='timeout');
  row.querySelector('.warning-rule-action').onchange=sync;row.querySelector('.warning-rule-remove').onclick=()=>{row.remove();syncWarningRules();scheduleModerationSave()};sync();$('#warning-rules').append(row);syncWarningRules();
}
function collectWarningRules(){
  const seen=new Set();
  return [...document.querySelectorAll('.warning-rule-row')].map(row=>{
    const warnings=Number(row.querySelector('.warning-rule-count').value),action=row.querySelector('.warning-rule-action').value,minutes=Number(row.querySelector('.warning-rule-minutes').value);
    if(!Number.isInteger(warnings)||warnings<1||warnings>100||seen.has(warnings))throw new Error('Use unique warning numbers between 1 and 100.');
    if(action==='timeout'&&(!Number.isInteger(minutes)||minutes<1||minutes>40320))throw new Error('Timeout duration must be 1-40,320 whole minutes.');
    seen.add(warnings);return {warnings,action,...(action==='timeout'?{minutes}:{})};
  });
}
$('#add-warning-rule').onclick=()=>{addWarningRule();scheduleModerationSave()};
$('#moderation-enabled').onchange=scheduleModerationSave;
$('#honeypot-channel').onchange=scheduleModerationSave;
$('#moderation-log-channel').onchange=scheduleModerationSave;
$('#moderation-admin-role').onchange=scheduleModerationSave;
$('#moderation-moderator-role').onchange=scheduleModerationSave;
$('#warning-rules').addEventListener('input',scheduleModerationSave);
$('#warning-rules').addEventListener('change',scheduleModerationSave);
function renderModeration(data){
  
  for(const [selector,key] of [['#moderation-admin-role','admin_role_id'],['#moderation-moderator-role','moderator_role_id']]){
    const select=$(selector);select.innerHTML='<option value="">Not set</option>'+state.data.roles.map(role=>`<option value="${role.id}">@ ${escapeHtml(role.name)}</option>`).join('');syncBonusRoleSelect(select,data.settings[key]||'');
  }
  $('#moderation-enabled').checked=!!data.settings.enabled;
  $('#warning-rules').innerHTML='';let rules=[];try{rules=JSON.parse(data.settings.warning_rules||'[]')}catch{};rules.forEach(addWarningRule);syncWarningRules();
  $('#moderation-log-channel').innerHTML='<option value="">Disabled</option>'+state.data.channels.map(channel=>`<option value="${channel.id}"># ${escapeHtml(channel.name)}</option>`).join('');
  $('#moderation-log-channel').value=data.settings.log_channel_id||'';
  $('#honeypot-channel').innerHTML=$('#moderation-log-channel').innerHTML;
  $('#honeypot-channel').value=data.settings.honeypot_channel_id||'';
  $('#moderation-cases').innerHTML=data.cases.length?data.cases.map(entry=>`<article class="moderation-case"><div><b>#${entry.id} - ${escapeHtml(entry.action)}${entry.cleared?' - Cleared':''}</b><small>${escapeHtml(new Date(entry.created_at).toLocaleString())}</small></div><p>Member: ${escapeHtml(entry.user_id||'N/A')} - Moderator: ${escapeHtml(entry.moderator_id)}</p><p>${escapeHtml(entry.reason)}</p>${moderationMessageLinks(entry)?`<p>${moderationMessageLinks(entry)}</p>`:''}</article>`).join(''):'<div class="empty compact">No moderation cases yet.</div>';
}
async function loadModeration(){
  if(!state.guildId||!state.data)return;
  const guildId=state.guildId,requestId=++moderationRequestId;
  moderationLoadedGuild=null;
  const controls=()=>document.querySelectorAll('#moderation input,#moderation select,#moderation .warning-rule-remove,#add-warning-rule');
  controls().forEach(control=>control.disabled=true);
  await flushModerationSave();
  if(guildId!==state.guildId||requestId!==moderationRequestId)return;
  try{
    const data=await request(`/api/guilds/${guildId}/moderation`);
    if(guildId!==state.guildId||requestId!==moderationRequestId)return;
    renderModeration(data);moderationLoadedGuild=guildId;
    controls().forEach(control=>control.disabled=false);syncWarningRules();
  }catch(error){if(guildId===state.guildId&&requestId===moderationRequestId)showSaveToast(error.message,true)}
  finally{if(guildId===state.guildId&&requestId===moderationRequestId){controls().forEach(control=>control.disabled=false);syncWarningRules()}}
}
$('#refresh-moderation').onclick=loadModeration;

const premiumPanel=document.createElement('section');
premiumPanel.className='premium-panel hidden';
premiumPanel.innerHTML='<div><b id="premium-label">Server premium</b><p id="premium-details"></p></div><button id="buy-premium" class="outline" type="button">Buy with PayPal</button><a id="manage-premium" class="outline hidden" href="https://www.paypal.com/" target="_blank" rel="noopener noreferrer">Manage in PayPal</a><button id="retry-premium" class="outline hidden" type="button">Verify subscription</button>';
$('#premium').append(premiumPanel);
function renderPremium(){
  const premium=state.data?.premium;if(!premium)return;
  premiumPanel.classList.remove('hidden');
  $('#premium-label').textContent=premium.active?'Premium active':'Free plan';
  $('#premium-details').textContent=premium.active?'Up to 10 leveling and 10 economy systems. Manage or cancel recurring billing in PayPal.':'Up to 2 leveling and 2 economy systems. Premium unlocks 10 of each while subscribed. Extra systems pause when premium ends; their data is kept.';
  $('#buy-premium').classList.toggle('hidden',premium.active);
  $('#manage-premium').classList.toggle('hidden',!premium.active);
  $('#buy-premium').disabled=!premium.checkoutAvailable;
  $('#buy-premium').textContent=premium.checkoutAvailable?'Subscribe with PayPal':'Premium checkout unavailable';
}
$('#buy-premium').onclick=async()=>{
  const guildId=state.guildId;$('#buy-premium').disabled=true;
  try{await flushSave();await flushEconomySave();const order=await request('/api/guilds/'+guildId+'/premium/subscriptions',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});location.assign(order.approvalUrl)}
  catch(error){showSaveToast(error.message,true);renderPremium()}
};
async function finishPremiumCheckout(){
  const query=new URLSearchParams(location.search);
  if(query.has('premium'))showSection('premium');
  if(query.get('premium')==='cancel'){history.replaceState({},'',location.pathname);showSaveToast('PayPal checkout cancelled');return}
  if(query.get('premium')!=='return')return;
  const guildId=query.get('guild');if(state.guildId!==guildId)return;
  const retry=$('#retry-premium');retry.disabled=true;
  try{const premium=await request('/api/guilds/'+guildId+'/premium/activate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriptionId:query.get('subscription_id')||''})});if(state.guildId!==guildId)return;state.data.premium=premium;history.replaceState({},'',location.pathname);retry.classList.add('hidden');renderPremium();renderSystemSelect();renderEconomySystemSelect();showSaveToast('Premium activated')}
  catch(error){retry.classList.remove('hidden');showSaveToast(error.message,true)}finally{retry.disabled=false}
}
$('#retry-premium').onclick=finishPremiumCheckout;
boot();

async function switchServer(guildId){
  if(serverSwitchPending||state.guildId===guildId)return;
  serverSwitchPending=true;
  try{
    await flushSave();
    await flushEconomySave();
    await flushModerationSave();
    await loadGuild(guildId);
  }catch(error){showSaveToast(error.message,true);}
  finally{serverSwitchPending=false;}
}
function syncServerRail(){
  document.querySelectorAll('[data-server-id]').forEach(button=>{
    const active=button.dataset.serverId===state.guildId;
    button.classList.toggle('active',active);
    if(active)button.setAttribute('aria-current','true');else button.removeAttribute('aria-current');
  });
}
function renderServerRail(guilds,clientId){
  const list=$('#server-rail-list');list.replaceChildren();
  for(const guild of guilds){
    const button=document.createElement('button');button.type='button';button.className='server-rail-button';button.dataset.serverId=guild.id;button.title=guild.name;button.setAttribute('aria-label',guild.name);
    if(guild.icon&&/^\d+$/.test(guild.id)&&/^[a-zA-Z0-9_]+$/.test(guild.icon)){
      const image=document.createElement('img');image.src='https://cdn.discordapp.com/icons/'+guild.id+'/'+guild.icon+'.png?size=80';image.alt='';image.addEventListener('error',()=>{button.textContent=guild.name.slice(0,1).toUpperCase();});button.append(image);
    }else button.textContent=guild.name.slice(0,1).toUpperCase();
    button.onclick=()=>switchServer(guild.id);list.append(button);
  }
  const invite=$('#server-rail-invite');invite.href='https://discord.com/oauth2/authorize?client_id='+encodeURIComponent(clientId)+'&permissions=268504064&scope=bot';invite.classList.remove('hidden');syncServerRail();
}
