const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const ts = require('typescript');
const discord = require('discord.js');
test('honeypot validation accepts text and announcement channels and refreshes permissions', async () => {
  const web = fs.readFileSync('src/web.ts', 'utf8');
  const validation = web.slice(web.indexOf('    const honeypotChannelId ='), web.indexOf('    if (channelId) {', web.indexOf('    const honeypotChannelId =')));
  for (const [type, visible, expected, extra = {}] of [
    [discord.ChannelType.GuildText, true, null],
    [discord.ChannelType.GuildAnnouncement, true, null],
    [discord.ChannelType.GuildText, false, 'The bot needs View Channel permission in the honeypot channel'],
    [discord.ChannelType.GuildForum, true, 'Choose a text or announcement channel'],
    [discord.ChannelType.GuildText, true, null, { unchanged: true }],
    [discord.ChannelType.GuildText, true, 'Could not allow everyone to post. The bot needs Manage Roles permission in the honeypot channel.', { permissionsFail: true }],
    [discord.ChannelType.GuildText, true, 'The bot needs Send Messages permission to post the honeypot warning', { sendDenied: true }],
    [discord.ChannelType.GuildText, true, "Could not post the honeypot warning. Check the bot's channel permissions and try again.", { sendFails: true }],
  ]) {
    let error = null;
    const sent = [];
    const edits = [];
    const me = { permissions: { has: () => true } };
    const context = {
      req: { body: { honeypotChannelId: 'trap' } }, current: { honeypot_channel_id: extra.unchanged ? 'trap' : null }, channelId: 'log',
      ChannelType: discord.ChannelType, PermissionFlagsBits: discord.PermissionFlagsBits,
      ContainerBuilder: discord.ContainerBuilder, TextDisplayBuilder: discord.TextDisplayBuilder,
      SeparatorBuilder: discord.SeparatorBuilder, MessageFlags: discord.MessageFlags,
      guild: {
        id: 'guild',
        channels: { fetch: async (id, options) => {
          assert.equal(id, 'trap'); assert.equal(options.force, true);
          return { type, permissionsFor: member => { assert.equal(member, me); return { has: permission => permission === discord.PermissionFlagsBits.SendMessages ? !extra.sendDenied : visible }; },
            permissionOverwrites: {
              cache: new Map([
                ['role', { id: 'role', deny: new discord.PermissionsBitField([discord.PermissionFlagsBits.ViewChannel, discord.PermissionFlagsBits.SendMessages]) }],
                ['member', { id: 'member', deny: new discord.PermissionsBitField([discord.PermissionFlagsBits.SendMessages]) }],
                ['other', { id: 'other', deny: new discord.PermissionsBitField([discord.PermissionFlagsBits.ManageMessages]) }],
              ]),
              edit: async (id, permissions) => { if (extra.permissionsFail) throw Error('Forbidden'); edits.push([id, { ...permissions }]); },
            },
            send: async payload => { if (extra.sendFails) throw Error('Forbidden'); sent.push(payload); } };
        } },
        members: { fetchMe: async options => { assert.equal(options.force, true); return me; } },
      },
      res: { status: code => { assert.equal(code, 400); return { json: body => { error = body.error; } }; } },
    };
    const script = ts.transpileModule(`(async () => { ${validation} })()`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    await vm.runInNewContext(script, context);
    assert.equal(error, expected);
    assert.equal(sent.length, !expected && !extra.unchanged ? 1 : 0);
    if (visible && type !== discord.ChannelType.GuildForum && !extra.permissionsFail) {
      assert.deepEqual(edits, [
        ['guild', { ViewChannel: true, SendMessages: true }],
        ['role', { ViewChannel: null, SendMessages: null }],
        ['member', { SendMessages: null }],
      ]);
    } else assert.equal(edits.length, 0);
    if (sent.length) {
      assert.equal(sent[0].flags, discord.MessageFlags.IsComponentsV2);
      const container = sent[0].components[0].toJSON();
      assert.equal(container.components[0].content, '**Honeypot channel**');
      assert.equal(container.components[1].type, discord.ComponentType.Separator);
      assert(container.components[2].content.includes('Do not post here.'));
    }
  }
});
const source = ts.transpileModule(fs.readFileSync('src/moderation.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function setup() {
  const db = new DatabaseSync(':memory:');
  const context = { exports: {}, require: name => name === 'discord.js' ? discord : name === './log-webhooks.js' ? { sendLog: (_guild, channel, _kind, payload) => channel.send(payload) } : { db }, URL, console: { error() {} } };
  vm.createContext(context); vm.runInContext(source, context);
  const events = [], responses = [];
  let actorAllowed = true, botAllowed = true, dmFails = false, targetError = null, higherRole = false;
  const user = { id: '222222222222222222', username: 'Member', send: async payload => { if (dmFails) throw Error('Closed DM'); events.push(['dm', payload]); } };
  const actor = { id: '111111111111111111', user: { username: 'Moderator' }, permissions: { has: () => actorAllowed }, roles: { highest: { comparePositionTo: () => higherRole ? -1 : 1 } } };
  const target = { roles: { highest: {} }, moderatable: true, kickable: true, bannable: true, timeout: async value => events.push(['timeout', value]), kick: async () => events.push(['kick']) };
  const me = { id: '333333333333333333', permissions: { has: () => botAllowed }, roles: { highest: { comparePositionTo: () => 1 } } };
  const guild = { id: '444444444444444444', name: 'Server', ownerId: '555555555555555555', members: { fetch: async id => { if (id === actor.id) return actor; if (targetError) throw targetError; return target; }, fetchMe: async () => me, ban: async () => events.push(['ban']) }, bans: { remove: async () => events.push(['unban']) }, channels: { fetch: async () => ({ isSendable: () => true, send: async payload => events.push(['log', payload]) }) } };
  function interaction(action, fields = {}, type = 'modal') {
    return { commandName: 'mod', customId: `moderation:${action}:${actor.id}`, guild, guildId: guild.id, user: { id: actor.id, tag: 'Moderator' }, memberPermissions: actor.permissions, deferred: false,
      isButton: () => type === 'button', isStringSelectMenu: () => type === 'select', isModalSubmit: () => type === 'modal',
      options: { getString: () => action }, fields: { getSelectedUsers: () => ({ first: () => user }), getTextInputValue: name => fields[name] ?? (name === 'reason' ? 'Rule violation' : '') },
      client: { users: { fetch: async id => id === user.id ? user : { username: 'Moderator' } } },
      deferReply: async function () { this.deferred = true; }, deferUpdate: async function () { this.deferred = true; events.push(['defer']); },
      reply: async payload => responses.push(payload), editReply: async payload => responses.push(payload), showModal: async modal => events.push(['modal', modal.toJSON()]),
      channelId: 'channel', channel: { permissionsFor: () => ({ has: () => true }), bulkDelete: async amount => { events.push(['purge', amount]); return { size: amount }; } }
    };
  }
  context.exports.moderationSettings(guild.id);
  return { db, api: context.exports, events, responses, interaction, actor, user, guild, setActor: v => actorAllowed = v, setBot: v => botAllowed = v, failDM: () => dmFails = true, targetError: v => targetError = v, higherRole: () => higherRole = true };
}
const content = payload => payload.components ? payload.components.flatMap(c => c.toJSON().components.filter(v => v.type === 10).map(v => v.content)).join('\n') : payload.embeds.map(e => e.toJSON().description).join('\n');
test('warn -> escalation -> clear one -> separate histories; no errors leak into DMs', async () => {
  const h = setup();
  h.db.prepare('UPDATE moderation_settings SET log_channel_id=?,warning_rules=?').run('log', JSON.stringify([{ warnings: 2, action: 'kick' }, { warnings: 3, action: 'ban' }]));
  await h.api.handleModerationCommand(h.interaction('warn'));
  await h.api.handleModerationCommand(h.interaction('warn'));
  assert.equal(h.events.filter(e => e[0] === 'kick').length, 1);
  h.setBot(false);
  await h.api.handleModerationCommand(h.interaction('warn'));
  const lastDM = h.events.filter(e => e[0] === 'dm').at(-1)[1];
  assert(!content(lastDM).includes('failed'));
  assert(content(h.events.filter(e => e[0] === 'log').at(-1)[1]).includes('Bot lacks'));
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM moderation_cases WHERE action='warn' AND cleared=0").get().n, 3);
  await h.api.handleModerationCommand(h.interaction('clearwarnings', { 'case-number': '1' }));
  assert.equal(content(h.events.filter(e => e[0] === 'dm').at(-1)[1]), "Warning 'Rule violation' has been cleared from you");
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM moderation_cases WHERE action='warn' AND cleared=0").get().n, 2);
  await h.api.handleModerationCommand(h.interaction('warnings'));
  assert(content(h.responses.at(-1)).startsWith('**Modlogs'));
  assert(!content(h.responses.at(-1)).includes('Case 1 - Warn'));
  assert(content(h.responses.at(-1)).includes('Kick'));
  const cleared = h.interaction('warnings', {}, 'button'); cleared.customId = `mod-tools:cleared:${h.actor.id}:${h.user.id}`;
  await h.api.handleModerationCommand(cleared);
  assert(content(h.responses.at(-1)).includes('Case 1 - Warn (cleared)'));
  assert(!content(h.responses.at(-1)).includes('~~'));
  assert(h.responses.at(-1).components[0].toJSON().components.at(-1).components.every(b => b.style === 2));
  h.db.close();
});
test('all direct punishments, reversals, purge, form validation, and protected clear records', async () => {
  const h = setup();
  for (const action of ['timeout', 'untimeout', 'kick', 'ban', 'unban', 'purge']) await h.api.handleModerationCommand(h.interaction(action, { minutes: '10', amount: '5', 'user-id': h.user.id }));
  assert(h.events.some(e => e[0] === 'timeout' && e[1] === 600000));
  assert(h.events.some(e => e[0] === 'timeout' && e[1] === null));
  assert(h.events.some(e => e[0] === 'unban'));
  assert(h.events.some(e => e[0] === 'purge' && e[1] === 5));
  for (const action of ['unban', 'untimeout']) {
    const row = h.db.prepare('SELECT id FROM moderation_cases WHERE action=?').get(action);
    await h.api.handleModerationCommand(h.interaction('clearwarnings', { 'case-number': String(row.id) }));
    assert(content(h.responses.at(-1)).includes('cannot be cleared'));
  }
  const before = h.db.prepare('SELECT COUNT(*) n FROM moderation_cases').get().n;
  await h.api.handleModerationCommand(h.interaction('timeout', { minutes: '40321' }));
  await h.api.handleModerationCommand(h.interaction('purge', { amount: '101' }));
  assert.equal(h.db.prepare('SELECT COUNT(*) n FROM moderation_cases').get().n, before);
  for (const action of ['warn','warnings','clearwarnings','timeout','untimeout','kick','ban','unban','purge']) assert(h.api.moderationModal(action,h.actor.id).toJSON().components.length <= 5);
  assert.throws(() => h.api.validateWarningRules([{ warnings: 2, action: 'ban' }, { warnings: 2, action: 'kick' }]));
  h.db.close();
});
test('permission, role, lookup failure, closed DM, and interaction ownership protections', async () => {
  const h = setup(); h.setActor(false);
  await h.api.handleModerationCommand(h.interaction('warn')); assert.equal(h.events.length, 0);
  h.setActor(true); h.higherRole(); await h.api.handleModerationCommand(h.interaction('kick')); assert(!h.events.some(e => e[0] === 'kick'));
  const h2 = setup(); h2.targetError(Object.assign(Error('Forbidden'), { code: 50013 }));
  await h2.api.handleModerationCommand(h2.interaction('ban')); assert(!h2.events.some(e => e[0] === 'ban'));
  h2.targetError(null); h2.failDM(); await h2.api.handleModerationCommand(h2.interaction('warn'));
  assert.equal(h2.db.prepare("SELECT COUNT(*) n FROM moderation_cases WHERE action='warn'").get().n, 1);
  assert(content(h2.responses.at(-1)).includes('DM could not'));
  const click = h2.interaction('warn', {}, 'button'); click.customId = `mod-tools:logs:other:${h2.user.id}`;
  await h2.api.handleModerationCommand(click); assert(content(h2.responses.at(-1)).includes('own /mod'));
  h.db.close(); h2.db.close();
});

test('pagination acknowledgements, empty history, and modal opening without member lookup', async () => {
  const h = setup();
  h.targetError(Error('Slow member lookup'));
  await h.api.handleModerationCommand(h.interaction('timeout', {}, 'command'));
  assert(h.events.some(e => e[0] === 'modal'));
  h.targetError(null);
  const insert = h.db.prepare('INSERT INTO moderation_cases (guild_id,user_id,moderator_id,action,reason,created_at) VALUES (?,?,?,?,?,?)');
  for (let n = 0; n < 9; n++) insert.run(h.guild.id,h.user.id,h.actor.id,'warn','Reason '+n,'2026-10-07T12:00:00Z');
  const click = h.interaction('warnings', {}, 'button');
  click.customId = 'mod-tools:logs-page:'+h.actor.id+':'+h.user.id+':999';
  await h.api.handleModerationCommand(click);
  assert(h.events.some(e => e[0] === 'defer'));
  const last = h.responses.at(-1).components[0].toJSON();
  assert(content(h.responses.at(-1)).includes('Page 3/3'));
  assert.equal(last.components.at(-1).components[1].disabled,true);
  h.db.exec('DELETE FROM moderation_cases');
  await h.api.handleModerationCommand(h.interaction('warnings'));
  assert(!content(h.responses.at(-1)).includes('Page '));
  h.db.close();
});

test('configured admin and moderator roles grant only their intended actions', async () => {
  const h=setup();h.setActor(false);
  h.db.prepare('UPDATE moderation_settings SET admin_role_id=?,moderator_role_id=?').run('first-admin,admin-role','first-mod,mod-role');
  const moderator=h.interaction('warn',{},'command');moderator.member={roles:['mod-role']};
  await h.api.handleModerationCommand(moderator);assert(h.events.some(e=>e[0]==='modal'));
  const ban=h.interaction('ban',{},'command');ban.member={roles:['mod-role']};
  await h.api.handleModerationCommand(ban);assert(content(h.responses.at(-1)).includes('permission'));
  const admin=h.interaction('ban',{},'command');admin.member={roles:['admin-role']};
  const before=h.events.length;await h.api.handleModerationCommand(admin);assert.equal(h.events.length,before+1);assert.equal(h.events.at(-1)[0],'modal');
  h.db.close();
});

test('honeypot softbans once, skips exempt accounts, and records failed unban as ban', async () => {
  const h = setup();
  h.db.prepare('UPDATE moderation_settings SET honeypot_channel_id=?,log_channel_id=?').run('trap', 'log');
  const member = await h.guild.members.fetch(h.user.id);
  member.id = h.user.id;
  member.permissions = { has: () => false };
  member.roles.cache = new Map();
  const message = { guild: h.guild, author: h.user, channelId: 'trap', url: 'https://discord.com/channels/guild/trap/message', client: { user: { username: 'Bot' } } };
  assert.equal(await h.api.handleHoneypotMessage({ ...message, channelId: 'other' }), false);
  assert.equal(await h.api.handleHoneypotMessage({ ...message, author: { ...h.user, bot: true } }), false);
  assert.equal(await h.api.handleHoneypotMessage({ ...message, webhookId: 'webhook' }), false);
  assert.equal(h.events.filter(e => e[0] === 'dm').length, 0);
  await Promise.all([h.api.handleHoneypotMessage(message), h.api.handleHoneypotMessage(message)]);
  assert.deepEqual(h.events.filter(e => ['dm','ban','unban'].includes(e[0])).map(e => e[0]), ['dm','ban','unban']);
  const dm = h.events.find(e => e[0] === 'dm')[1];
  assert.equal(dm.flags, discord.MessageFlags.IsComponentsV2);
  assert.equal(dm.components[0].toJSON().accent_color, 0xf45f77);
  assert.equal(content(dm), 'You were banned from Server for posting in a honeypot channel.');
  assert.deepEqual(h.events.filter(e => ['ban','unban'].includes(e[0])).map(e => e[0]), ['ban','unban']);
  assert.equal(h.db.prepare('SELECT action FROM moderation_cases').get().action, 'softban');
  h.guild.bans.remove = async () => { throw Error('Network failure'); };
  await h.api.handleHoneypotMessage(message);
  assert.equal(h.db.prepare('SELECT action FROM moderation_cases ORDER BY id DESC LIMIT 1').get().action, 'ban');
  assert(content(h.events.filter(e => e[0] === 'log').at(-1)[1]).includes('remains banned'));
  h.failDM();
  await h.api.handleHoneypotMessage(message);
  assert.equal(h.events.filter(e => e[0] === 'ban').length, 3);
  assert(content(h.events.filter(e => e[0] === 'log').at(-1)[1]).includes('Could not DM member.'));
  assert(content(h.events.filter(e => e[0] === 'log').at(-1)[1]).includes('remains banned'));
  member.permissions.has = () => true;
  assert.equal(await h.api.handleHoneypotMessage(message), false);
  h.db.close();
});
