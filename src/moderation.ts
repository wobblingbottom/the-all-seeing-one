import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ButtonInteraction, StringSelectMenuBuilder, StringSelectMenuInteraction, ChatInputCommandInteraction, ModalSubmitInteraction, ModalBuilder, LabelBuilder, UserSelectMenuBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder, ContainerBuilder, SeparatorBuilder, MessageFlags, PermissionFlagsBits as P, SlashCommandBuilder, TextDisplayBuilder } from "discord.js";
import { db } from "./db.js";

db.exec(`CREATE TABLE IF NOT EXISTS moderation_settings (guild_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, log_channel_id TEXT);
CREATE TABLE IF NOT EXISTS moderation_cases (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, user_id TEXT, moderator_id TEXT NOT NULL, action TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL, cleared INTEGER NOT NULL DEFAULT 0);`);
if (!(db.prepare("PRAGMA table_info(moderation_cases)").all() as Array<{ name: string }>).some(column => column.name === "message_links")) {
  db.exec("ALTER TABLE moderation_cases ADD COLUMN message_links TEXT NOT NULL DEFAULT '[]'");
}
export type WarningRule = { warnings: number; action: "timeout" | "kick" | "ban"; minutes?: number };
if (!(db.prepare("PRAGMA table_info(moderation_settings)").all() as Array<{ name: string }>).some(column => column.name === "warning_rules")) {
  db.exec("ALTER TABLE moderation_settings ADD COLUMN warning_rules TEXT NOT NULL DEFAULT '[]'");
}
for (const column of ["admin_role_id", "moderator_role_id", "honeypot_channel_id"]) {
  if (!(db.prepare("PRAGMA table_info(moderation_settings)").all() as Array<{ name: string }>).some(entry => entry.name === column)) db.exec(`ALTER TABLE moderation_settings ADD COLUMN ${column} TEXT`);
}
export function validateWarningRules(value: unknown): WarningRule[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error("Use up to 20 warning rules.");
  const seen = new Set<number>();
  return value.map(rule => {
    if (!rule || !Number.isInteger(rule.warnings) || rule.warnings < 1 || rule.warnings > 100 || seen.has(rule.warnings)) throw new Error("Each rule needs a unique warning count between 1 and 100.");
    if (!["timeout", "kick", "ban"].includes(rule.action)) throw new Error("Choose timeout, kick, or ban.");
    if (rule.action === "timeout" && (!Number.isInteger(rule.minutes) || rule.minutes < 1 || rule.minutes > 40320)) throw new Error("Timeout rules need 1-40,320 whole minutes.");
    seen.add(rule.warnings);
    return { warnings: rule.warnings, action: rule.action, ...(rule.action === "timeout" ? { minutes: rule.minutes } : {}) } as WarningRule;
  }).sort((a, b) => a.warnings - b.warnings);
}
export function warningRules(settings: { warning_rules: string }): WarningRule[] {
  try { return validateWarningRules(JSON.parse(settings.warning_rules || "[]")); } catch { return []; }
}
function activeWarningCount(guildId: string, userId: string) {
  return (db.prepare("SELECT COUNT(*) AS count FROM moderation_cases WHERE guild_id=? AND user_id=? AND action='warn' AND cleared=0").get(guildId, userId) as { count: number }).count;
}
export function moderationSettings(guildId: string) {
  db.prepare("INSERT OR IGNORE INTO moderation_settings (guild_id) VALUES (?)").run(guildId);
  return db.prepare("SELECT * FROM moderation_settings WHERE guild_id=?").get(guildId) as { enabled: number; honeypot_channel_id: string | null; log_channel_id: string | null; warning_rules: string; admin_role_id: string | null; moderator_role_id: string | null };
}
const honeypotInFlight = new Set<string>();
export async function handleHoneypotMessage(message: import("discord.js").Message): Promise<boolean> {
  const guild = message.guild;
  if (!guild || message.author.bot || message.webhookId) return false;
  const settings = moderationSettings(guild.id);
  if (!settings.enabled || settings.honeypot_channel_id !== message.channelId) return false;
  const key = `${guild.id}:${message.author.id}`;
  if (honeypotInFlight.has(key)) return true;
  honeypotInFlight.add(key);
  let outcome = "Honeypot failed", failure = "";
  try {
    const member = await guild.members.fetch(message.author.id);
    if (member.id === guild.ownerId || member.permissions.has(P.Administrator) || member.permissions.has(P.BanMembers)
      || [settings.admin_role_id, settings.moderator_role_id].some(id => id && member.roles.cache.has(id))) return false;
    const me = await guild.members.fetchMe();
    if (!me.permissions.has(P.BanMembers) || !member.bannable) throw new Error("Check bot Ban Members permission and role order.");
    try {
      await message.author.send({
        components: [new ContainerBuilder().setAccentColor(0xf45f77).addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`You were banned from ${guild.name} for posting in a honeypot channel.`)
        )],
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { parse: [] }
      });
    } catch { failure = "Could not DM member."; }
    await guild.members.ban(message.author.id, { deleteMessageSeconds: 86400, reason: "Honeypot channel message" });
    outcome = "Ban";
    try {
      await guild.bans.remove(message.author.id, "Honeypot softban: allow rejoining");
      outcome = "Softban";
    } catch { failure = [failure, "Unban failed; member remains banned. Unban them manually."].filter(Boolean).join("\n"); }
    db.prepare("INSERT INTO moderation_cases (guild_id,user_id,moderator_id,action,reason,created_at,message_links) VALUES (?,?,?,?,?,?,?)")
      .run(guild.id, message.author.id, me.id, outcome.toLowerCase(), "Honeypot channel message", new Date().toISOString(), JSON.stringify([message.url]));
  } catch (error) {
    failure = [failure, error instanceof Error ? error.message : "Could not softban member."].filter(Boolean).join("\n");
  } finally { honeypotInFlight.delete(key); }
  if (failure) console.error(`Honeypot ${guild.id}/${message.author.id}: ${failure}`);
  if (settings.log_channel_id) {
    try {
      const channel = await guild.channels.fetch(settings.log_channel_id);
      if (!channel?.isSendable()) throw new Error("Moderation log channel unavailable");
      await channel.send({ embeds: [new EmbedBuilder().setColor(0xf45f77).setDescription(
        `${outcome}: ${message.author.username}\nMod: ${message.client.user?.username || "Bot"}\nReason: Honeypot channel message\n${message.url}${failure ? `\n${failure}` : ""}`
      )], allowedMentions: { parse: [] } });
    } catch (error) { console.error("Honeypot log failed", error); }
  }
  return true;
}
export function moderationCases(guildId: string) {
  return db.prepare("SELECT * FROM moderation_cases WHERE guild_id=? ORDER BY id DESC LIMIT 50").all(guildId);
}
const permissions: Record<string, bigint> = { warn: P.ModerateMembers, warnings: P.ModerateMembers, clearwarnings: P.ModerateMembers, timeout: P.ModerateMembers, untimeout: P.ModerateMembers, kick: P.KickMembers, ban: P.BanMembers, unban: P.BanMembers, purge: P.ManageMessages };
const actionNames: Record<string, string> = { warn: "Warn member", warnings: "Modlogs", clearwarnings: "Clear case", timeout: "Timeout member", untimeout: "Remove timeout", kick: "Kick member", ban: "Ban member", unban: "Unban user", purge: "Purge messages" };
export const moderationCommands = [new SlashCommandBuilder()
  .setName("mod").setDescription("Use server moderation tools").setDMPermission(false)
  .addStringOption(option => option.setName("action").setDescription("Choose a moderation action").setRequired(true)
    .addChoices(...Object.entries(actionNames).map(([value, name]) => ({ name, value }))))];

function canModerate(interaction: ChatInputCommandInteraction | ModalSubmitInteraction | ButtonInteraction | StringSelectMenuInteraction, action: string, allowDiscordPermission = true) {
  if (allowDiscordPermission && interaction.memberPermissions?.has(permissions[action])) return true;
  const settings = moderationSettings(interaction.guildId!);
  const member = interaction.member;
  const roles = member?.roles;
  const hasRole = (id: string | null) => !!id && !!roles && (Array.isArray(roles) ? roles.includes(id) : roles.cache.has(id));
  return hasRole(settings.admin_role_id) || (!["ban", "unban"].includes(action) && hasRole(settings.moderator_role_id));
}

export function moderationModal(action: string, ownerId: string, targetId?: string) {
  const modal = new ModalBuilder().setCustomId(`moderation:${action}:${ownerId}`).setTitle(actionNames[action]);
  const input = (id: string, name: string, required = true, maxLength = 400) => modal.addLabelComponents(new LabelBuilder().setLabel(name)
    .setTextInputComponent(new TextInputBuilder().setCustomId(id).setStyle(TextInputStyle.Short).setRequired(required).setMaxLength(maxLength)));
  if (action === "purge") input("amount", "Number of recent messages (1-100)", true, 3);
  else if (action === "unban") input("user-id", "Discord ID of the banned user", true, 20);
  else {
    const memberSelect = new UserSelectMenuBuilder().setCustomId("member").setMinValues(1).setMaxValues(1);
    if (targetId) memberSelect.setDefaultUsers(targetId);
    modal.addLabelComponents(new LabelBuilder().setLabel("Member").setUserSelectMenuComponent(memberSelect));
  }
  if (action === "clearwarnings") input("case-number", "Warning case number to clear", true, 16);
  if (action === "timeout") input("minutes", "Timeout duration in minutes (1-40,320)", true, 5);
  if (action !== "warnings") input("reason", "Reason", action === "warn");
  if (action !== "warnings" && action !== "clearwarnings" && action !== "purge" && action !== "unban" && action !== "untimeout") modal.addLabelComponents(new LabelBuilder().setLabel("Message link (optional)")
    .setDescription("Paste one link using Discord's Copy Message Link.")
    .setTextInputComponent(new TextInputBuilder().setCustomId("message-links").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(1000)));
  return modal;
}
function moderationReply(title: string, body: string) {
  return new ContainerBuilder().setAccentColor(0xf45f77)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`<:exmark:1553453281022582824> **${title}**`))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(body));
}

async function memberModlogs(interaction: ButtonInteraction | ModalSubmitInteraction, targetId: string, ownerId: string, requestedPage = 0, warningsOnly = false, clearedOnly = false) {
  const guildId = interaction.guildId!;
  const pageSize = 4;
  const filter = clearedOnly ? " AND action='warn' AND cleared=1" : warningsOnly ? " AND action='warn' AND cleared=0" : " AND NOT (action='warn' AND cleared=1)";
  const pageTool = clearedOnly ? "cleared-page" : warningsOnly ? "warnings-page" : "logs-page";
  const total = (db.prepare(`SELECT COUNT(*) AS count FROM moderation_cases WHERE guild_id=? AND user_id=?${filter}`).get(guildId, targetId) as { count: number }).count;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.max(0, Math.min(pages - 1, Number.isSafeInteger(requestedPage) ? requestedPage : 0));
  const rows = db.prepare(`SELECT id,action,moderator_id,reason,created_at,cleared FROM moderation_cases WHERE guild_id=? AND user_id=?${filter} ORDER BY id DESC LIMIT ? OFFSET ?`).all(guildId, targetId, pageSize, page * pageSize) as Array<{ id: number; action: string; moderator_id: string; reason: string; created_at: string; cleared: number }>;
  const ids = [...new Set([targetId, ...rows.map(row => row.moderator_id)])];
  const users = new Map(await Promise.all(ids.map(async id => [id, await interaction.client.users.fetch(id).catch(() => null)] as const)));
  const container = new ContainerBuilder().setAccentColor(0xf45f77)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${clearedOnly ? "Cleared warnings" : warningsOnly ? "Warnings" : "Modlogs"} for ${users.get(targetId)?.username || targetId}**`))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true));
  const labels: Record<string, string> = { warn: "Warn", kick: "Kick", ban: "Ban", unban: "Unban", timeout: "Timeout", untimeout: "Timeout removed", clearwarnings: "Warnings cleared", purge: "Purge" };
  for (const row of rows) {
    const duration = row.action === "timeout" ? row.reason.match(/\s*[\u00b7?-]\s*(\d+) minutes$/) : null;
    const reason = duration ? row.reason.slice(0, duration.index) : row.reason;
    const seconds = Math.floor(new Date(row.created_at).getTime() / 1000);
    if (row !== rows[0]) container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    const entry = `**Case ${row.id} - ${labels[row.action] || row.action}${row.cleared ? " (cleared)" : ""}**\n**Mod:** ${users.get(row.moderator_id)?.username || row.moderator_id}${duration ? `\n**Length:** ${duration[1]} minutes` : ""}\n**Reason:** ${reason}\n<t:${seconds}:F>`;
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(entry));
  }
  if (!rows.length) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(clearedOnly ? "This member has no cleared warnings." : warningsOnly ? "This member has no active warnings." : "No moderation history for this member."));
  if (total > 0) {
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`Page ${page + 1}/${pages} (${total} ${clearedOnly ? "cleared warnings" : warningsOnly ? "active warnings" : "logs"})`));
  }
  const navigation = new ActionRowBuilder<ButtonBuilder>();
  if (pages > 1) navigation.addComponents(
    new ButtonBuilder().setCustomId(`mod-tools:${pageTool}:${ownerId}:${targetId}:${page - 1}`).setLabel("Previous").setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(`mod-tools:${pageTool}:${ownerId}:${targetId}:${page + 1}`).setLabel("Next").setStyle(ButtonStyle.Secondary).setDisabled(page === pages - 1)
  );
  navigation.addComponents(new ButtonBuilder().setCustomId(`mod-tools:${clearedOnly ? "logs-page" : "cleared-page"}:${ownerId}:${targetId}:0`).setLabel(clearedOnly ? "View modlogs" : "Cleared warnings").setStyle(ButtonStyle.Secondary));
  container.addActionRowComponents(navigation);
  return container;
}

async function fetchModerationTarget(interaction: ModalSubmitInteraction, userId: string) {
  try { return await interaction.guild!.members.fetch(userId); }
  catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 10007) return null;
    throw error;
  }
}

export async function handleModerationCommand(interaction: ChatInputCommandInteraction | ModalSubmitInteraction | ButtonInteraction | StringSelectMenuInteraction) {
  if (interaction.isButton() || interaction.isStringSelectMenu()) {
    if (!interaction.customId.startsWith("mod-tools:")) return false;
    if (!interaction.guild) return false;
    const [, tool, ownerId, targetId] = interaction.customId.split(":");
    const deny = async (message: string) => { await (interaction.deferred ? interaction.editReply.bind(interaction) : interaction.reply.bind(interaction))({ components: [moderationReply("Moderation", message)], flags: interaction.deferred ? MessageFlags.IsComponentsV2 : MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, allowedMentions: { parse: [] } }); return true; };
    if (ownerId !== interaction.user.id) return deny("Use your own /mod command to manage this member.");
    if (interaction.isButton()) {
      if (["logs-page", "warnings-page", "cleared-page"].includes(tool)) await interaction.deferUpdate();
      else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }
    if (!moderationSettings(interaction.guild.id).enabled) return deny("Moderation is disabled for this server.");
    if (interaction.isStringSelectMenu()) {
      const selected = interaction.values[0];
      if (tool !== "choose" || !["ban", "kick", "timeout"].includes(selected)) return false;
      if (!canModerate(interaction, selected)) return deny("You do not have permission for this action.");
      await interaction.showModal(moderationModal(selected, ownerId, targetId));
      return true;
    }
    if (tool === "logs" || tool === "logs-page" || tool === "warnings-page" || tool === "cleared" || tool === "cleared-page") {
      if (!canModerate(interaction, "warnings")) return deny("You need Moderate Members permission to view modlogs.");
      const requestedPage = tool.endsWith("-page") ? Number(interaction.customId.split(":")[4]) : 0;
      const container = await memberModlogs(interaction, targetId, ownerId, requestedPage, tool === "warnings-page", tool === "cleared" || tool === "cleared-page");
      await interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } });
      return true;
    }
    if (tool === "action") {
      const choices = ["ban", "kick", "timeout"].filter(action => canModerate(interaction, action));
      if (!choices.length) return deny("You do not have permission to ban, kick, or timeout members.");
      const menu = new StringSelectMenuBuilder().setCustomId(`mod-tools:choose:${ownerId}:${targetId}`).setPlaceholder("Choose an action").addOptions(choices.map(value => ({ label: actionNames[value], value })));
      const container = moderationReply("Take action", "Choose a punishment, then provide its details.").addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
      await interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } });
      return true;
    }
    return false;
  }
  const isModal = interaction.isModalSubmit();
  if (isModal ? !interaction.customId.startsWith("moderation:") : interaction.commandName !== "mod") return false;
  if (!interaction.guild) return false;
  const action = isModal ? interaction.customId.split(":")[1] : interaction.options.getString("action", true);
  const permission = permissions[action];
  if (!permission) return false;
  if (isModal && interaction.customId.split(":")[2] !== interaction.user.id) {
    await interaction.reply({ components: [moderationReply("Moderation", "Open your own moderation command to use this form.")], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return true;
  }
  if (!isModal) {
    if (!moderationSettings(interaction.guild.id).enabled || !canModerate(interaction, action)) {
      await interaction.reply({ components: [moderationReply("Moderation", "Moderation is disabled or you do not have permission for this action.")], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return true;
    }
    await interaction.showModal(moderationModal(action, interaction.user.id));
    return true;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const respond = async (text: string) => { await interaction.editReply({ components: [moderationReply(actionNames[action], text)], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } }); return true; };
  const field = (id: string) => interaction.fields.getTextInputValue(id).trim();
  const warningCaseId = action === "clearwarnings" ? Number(field("case-number")) : 0;
  if (action === "clearwarnings" && (!Number.isSafeInteger(warningCaseId) || warningCaseId < 1)) return respond("Enter a valid warning case number.");
  let clearedWarningReason = "";
  const amount = action === "purge" ? Number(field("amount")) : 0;
  const minutes = action === "timeout" ? Number(field("minutes")) : 0;
  if (action === "purge" && (!Number.isInteger(amount) || amount < 1 || amount > 100)) return respond("Enter a whole number of messages between 1 and 100.");
  if (action === "timeout" && (!Number.isInteger(minutes) || minutes < 1 || minutes > 40320)) return respond("Enter a whole number of minutes between 1 and 40,320.");
  const guild = interaction.guild, settings = moderationSettings(guild.id);
  if (!settings.enabled) return respond("Moderation is disabled for this server.");
  const actor = await guild.members.fetch(interaction.user.id);
  if (!canModerate(interaction, action)) return respond("You do not have permission to use this command.");
  const me = await guild.members.fetchMe();
  const user = action === "purge" || action === "unban" ? null : interaction.fields.getSelectedUsers("member", true).first();
  const userId = user?.id || (action === "unban" ? field("user-id") : null);
  const reason = (action === "warnings" ? "" : field("reason")) || "No reason provided";
  if (action === "warn" && !field("reason")) return respond("Enter a reason for this warning.");
  if (action !== "purge" && !userId) return respond("Choose a member or enter a user ID.");
  const rawLink = action === "warnings" || action === "clearwarnings" || action === "purge" || action === "unban" || action === "untimeout" ? "" : field("message-links");
  const messageLinks = rawLink ? [rawLink.replace(/^<(.+)>$/, "$1")] : [];
  if (messageLinks.length) {
    let url: URL;
    try { url = new URL(messageLinks[0]); }
    catch { return respond("Paste a Discord message link using Copy Message Link, or leave the field empty."); }
    const path = url.pathname.match(/^\/channels\/(\d+)\/(\d+)\/(\d+)\/?$/);
    if (url.protocol !== "https:" || !["discord.com", "discordapp.com", "canary.discord.com", "ptb.discord.com"].includes(url.hostname) || url.port || url.username || url.password || !path || /\s/.test(messageLinks[0])) return respond("Paste one Discord message link using Copy Message Link, or leave the field empty.");
    if (path[1] !== guild.id) return respond("That message link belongs to a different server. Copy a message link from this server, or leave the field empty.");
  }
  const auditReason = `${interaction.user.tag}: ${reason}`.slice(0, 512);
  try {
    if (action === "warnings") {
      const container = await memberModlogs(interaction, userId!, actor.id);
      await interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } });
      return true;
    }
    if (userId) {
      if (userId === actor.id || userId === me.id || userId === guild.ownerId) return respond("You cannot moderate yourself, this bot, or the server owner.");
      const target = await fetchModerationTarget(interaction, userId);
      if (target && actor.id !== guild.ownerId && actor.roles.highest.comparePositionTo(target.roles.highest) <= 0) return respond("Your highest role must be above the member's highest role.");
      if (["warn", "timeout", "untimeout", "kick", "ban"].includes(action) && target && me.roles.highest.comparePositionTo(target.roles.highest) <= 0) return respond("The bot's highest role must be above the member's highest role.");
      if ((["timeout", "untimeout", "kick"].includes(action) || (action === "warn" && !activeWarningCount(guild.id, userId))) && !target) return respond("That user is not a member of this server.");
      if (action === "timeout" || action === "untimeout") {
        if (!me.permissions.has(permission) || !target!.moderatable) return respond("The bot cannot timeout this member. Check its permissions and the member's roles.");
        await target!.timeout(action === "timeout" ? minutes * 60000 : null, auditReason);
      } else if (action === "kick") {
        if (!me.permissions.has(permission) || !target!.kickable) return respond("The bot cannot kick this member. Check its permissions and roles.");
        await target!.kick(auditReason);
      } else if (action === "ban") {
        if (!me.permissions.has(permission) || (target && !target.bannable)) return respond("The bot cannot ban this member. Check its permissions and roles.");
        await guild.members.ban(userId, { reason: auditReason });
      } else if (action === "unban") {
        if (!/^\d{17,20}$/.test(userId)) return respond("Enter a valid Discord user ID.");
        if (!me.permissions.has(permission)) return respond("The bot needs Ban Members permission.");
        await guild.bans.remove(userId, auditReason);
      } else if (action === "clearwarnings") {
        const selectedCase = db.prepare("SELECT action FROM moderation_cases WHERE id=? AND guild_id=? AND user_id=?").get(warningCaseId, guild.id, userId) as { action: string } | undefined;
        if (selectedCase && ["unban", "untimeout", "clearwarnings"].includes(selectedCase.action)) return respond("Unban, remove-timeout, and clear-case records cannot be cleared.");
        const warning = db.prepare("SELECT reason FROM moderation_cases WHERE id=? AND guild_id=? AND user_id=? AND action='warn' AND cleared=0").get(warningCaseId, guild.id, userId) as { reason: string } | undefined;
        if (!warning) return respond("That case is not an active warning for the selected member in this server.");
        const updated = db.prepare("UPDATE moderation_cases SET cleared=1 WHERE id=? AND guild_id=? AND user_id=? AND action='warn' AND cleared=0").run(warningCaseId, guild.id, userId);
        if (!updated.changes) return respond("That warning has already been cleared.");
        clearedWarningReason = warning.reason;
      }
    }
    let result = `${action} completed${userId ? ` for user ${userId}` : ""}.`;
    if (action === "purge") {
      const channel = interaction.channel;
      if (!channel || !("bulkDelete" in channel) || !("permissionsFor" in channel)) return respond("Use purge in a server text channel.");
      if (!channel.permissionsFor(actor)?.has(P.ManageMessages) && !canModerate(interaction, "purge", false)) return respond("You need Manage Messages permission in this channel.");
      if (!channel.permissionsFor(me)?.has([P.ManageMessages, P.ReadMessageHistory, P.ViewChannel])) return respond("The bot needs View Channel, Read Message History, and Manage Messages here.");
      const deleted = await channel.bulkDelete(amount, true);
      result = `Deleted ${deleted.size} message(s). Messages older than 14 days were skipped.`;
    }
    if (action === "clearwarnings") result = `Warning case #${warningCaseId} cleared for ${user?.username || userId}.`;
    const recordedReason = action === "clearwarnings" ? `Cleared warning case #${warningCaseId}: ${clearedWarningReason}. Clearing reason: ${reason}` : action === "timeout" ? `${reason} · ${minutes} minutes` : action === "purge" ? `${reason} · ${result} · channel ${interaction.channelId}` : reason;
    const record = db.prepare("INSERT INTO moderation_cases (guild_id,user_id,moderator_id,action,reason,created_at,message_links) VALUES (?,?,?,?,?,?,?)").run(guild.id, userId, actor.id, action, recordedReason, new Date().toISOString(), JSON.stringify(messageLinks));
    const caseId = String(record.lastInsertRowid);
    let escalationStatus = "";
    let memberEscalationStatus = "";
    if (action === "warn" && userId) {
      const count = activeWarningCount(guild.id, userId);
      const rule = warningRules(settings).find(entry => entry.warnings === count);
      escalationStatus = `Active warnings: ${count}.`;
      memberEscalationStatus = `Active warnings: ${count}.`;
      if (rule) {
        try {
          const target = await guild.members.fetch(userId).catch(() => null);
          const currentActor = await guild.members.fetch(actor.id);
          const currentBot = await guild.members.fetchMe();
          if (userId === guild.ownerId || userId === currentActor.id || userId === currentBot.id) throw new Error("This member is protected");
          if (target && currentActor.id !== guild.ownerId && currentActor.roles.highest.comparePositionTo(target.roles.highest) <= 0) throw new Error("Moderator role must be above the member");
          if (!currentBot.permissions.has(permissions[rule.action])) throw new Error(`Bot lacks permission to ${rule.action}`);
          if (target && currentBot.roles.highest.comparePositionTo(target.roles.highest) <= 0) throw new Error("Bot role must be above the member");
          const escalationReason = `Automatic ${rule.action} at warning ${count}: ${auditReason}`.slice(0, 512);
          if (rule.action === "ban") {
            if (target && !target.bannable) throw new Error("Member cannot be banned");
            await guild.members.ban(userId, { reason: escalationReason });
          } else if (rule.action === "kick") {
            if (!target?.kickable) throw new Error("Member is absent or cannot be kicked");
            await target.kick(escalationReason);
          } else {
            if (!target?.moderatable) throw new Error("Member is absent or cannot be timed out");
            await target.timeout(rule.minutes! * 60000, escalationReason);
          }
          const punishment = db.prepare("INSERT INTO moderation_cases (guild_id,user_id,moderator_id,action,reason,created_at,message_links) VALUES (?,?,?,?,?,?,?)")
            .run(guild.id, userId, actor.id, rule.action, `Automatic at warning ${count} (warning case #${caseId}): ${recordedReason}${rule.action === "timeout" ? ` - ${rule.minutes} minutes` : ""}`, new Date().toISOString(), JSON.stringify(messageLinks));
          memberEscalationStatus += ` Punishment: ${rule.action}${rule.action === "timeout" ? ` for ${rule.minutes} minutes` : ""}.`;
          escalationStatus += ` Automatic punishment: ${rule.action}${rule.action === "timeout" ? ` for ${rule.minutes} minutes` : ""} completed (case #${punishment.lastInsertRowid}).`;
        } catch (error) {
          escalationStatus += ` Automatic ${rule.action} failed: ${error instanceof Error ? error.message : "Discord rejected the action"}. The warning is still recorded.`;
        }
      }
    }
    const escalationText = escalationStatus ? `\n${escalationStatus}` : "";
    const linksText = messageLinks.length ? `\n**Message links**\n${messageLinks.join("\n")}` : "";
    const notificationLabels: Record<string, string> = { warn: "Warning", timeout: "Timeout", untimeout: "Timeout removed", kick: "Kicked", ban: "Banned", unban: "Ban removed", clearwarnings: "Warnings cleared" };
    let dmStatus = "";
    if (userId) {
      try {
        const recipient = user || await interaction.client.users.fetch(userId);
        if (action === "clearwarnings") {
          const embed = new EmbedBuilder().setColor(0xf45f77).setDescription(`Warning '${clearedWarningReason}' has been cleared from you`);
          await recipient.send({ embeds: [embed], allowedMentions: { parse: [] } });
        } else if (action === "warn") {
          const embed = new EmbedBuilder().setColor(0xf45f77)
            .setDescription(`You were warned in ${guild.name} for ${reason}${messageLinks.length ? `\n\n${messageLinks.join("\n")}` : ""}`);
          await recipient.send({ embeds: [embed], allowedMentions: { parse: [] } });
        } else {
          const embed = new EmbedBuilder().setColor(0xf45f77)
            .setDescription(`${notificationLabels[action]} in ${guild.name}.\nReason: ${recordedReason}${linksText}${memberEscalationStatus ? `\n${memberEscalationStatus}` : ""}`);
          await recipient.send({ embeds: [embed], allowedMentions: { parse: [] } });
        }
        dmStatus = "";
      } catch (error) {
        console.error("Moderation DM failed", error);
        dmStatus = "DM could not be delivered (the user may have DMs disabled).";
      }
    }
    let logStatus = "";
    if (settings.log_channel_id) {
      try {
        const channel = await guild.channels.fetch(settings.log_channel_id);
        if (!channel?.isSendable()) throw new Error("Log channel unavailable");
        const memberName = user?.username || (userId ? (await interaction.client.users.fetch(userId).catch(() => null))?.username || userId : "N/A");
        const logLabels: Record<string, string> = { warn: "Warn", timeout: "Timeout", kick: "Kick", ban: "Ban", unban: "Unban", untimeout: "Timeout removed", clearwarnings: "Case cleared", purge: "Purge" };
        const logReason = action === "clearwarnings" ? `Case #${warningCaseId}: ${clearedWarningReason}` : reason;
        const logDetails = [escalationStatus.includes("Automatic") ? escalationStatus.replace(/^Active warnings: \d+\.\s*/, "") : "", dmStatus].filter(Boolean).join("\n");
        const embed = new EmbedBuilder().setColor(0xf45f77)
          .setDescription(`${logLabels[action] || action}: ${memberName}\nMod: ${actor.user.username}${action === "timeout" ? `\nLength: ${minutes} min` : ""}\nReason: ${logReason}${action === "purge" ? `\n${result}` : ""}${linksText}${logDetails ? `\n${logDetails}` : ""}`);
        await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
        logStatus = "";
      } catch (error) {
        console.error("Moderation log failed", error);
        logStatus = "Log could not be delivered. Check the configured channel and bot permissions.";
      }
    }
    if (["warn", "timeout", "kick", "ban"].includes(action) && userId) {
      const total = activeWarningCount(guild.id, userId);
      const summaryLabels: Record<string, string> = { warn: "Warned user", timeout: "Timed out user", kick: "Kicked user", ban: "Banned user" };
      const duration = action === "timeout" ? `\nLength: ${minutes} minutes` : "";
      const container = moderationReply(actionNames[action], `${summaryLabels[action]} ${user?.username || userId}.${duration}\nTotal warnings: ${total}`)
        .addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`mod-tools:logs:${actor.id}:${userId}`).setLabel("View modlogs").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`mod-tools:action:${actor.id}:${userId}`).setLabel("Take action").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`mod-tools:cleared:${actor.id}:${userId}`).setLabel("Cleared warnings").setStyle(ButtonStyle.Secondary)
        ));
      const adminDetails = [escalationStatus.includes("Automatic") ? escalationStatus : "", dmStatus.startsWith("DM could not") ? dmStatus : "", logStatus.startsWith("Log could not") ? logStatus : ""].filter(Boolean).join("\n");
      if (adminDetails) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(adminDetails));
      await interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } });
    } else await respond(`Case #${caseId}: ${result}${escalationText}\n${[dmStatus, logStatus].filter(Boolean).join("\n")}`);
    return true;
  } catch (error) {
    console.error("Moderation action failed", error);
    return respond("The action could not be completed. Check the member, bot permissions, and role order, then try again.");
  }
}
