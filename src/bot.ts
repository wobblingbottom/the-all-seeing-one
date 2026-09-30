import { AttachmentBuilder, Client, Events, GatewayIntentBits, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { config } from "./config.js";
import { db, ensureDefaultSystem, levelFromXp, xpForLevel } from "./db.js";
import { renderLevelCard } from "./level-card.js";
import { economyCommands, handleEconomyCommand, rewardEconomyMessage } from "./economy.js";

export const bot = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers]
});

const memberRow = db.prepare("SELECT xp, level, last_xp_at FROM system_progress WHERE system_id = ? AND user_id = ?");
const addXp = db.prepare(`
  INSERT INTO system_progress (system_id, user_id, username, xp, level, last_xp_at) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(system_id, user_id) DO UPDATE SET username = excluded.username, xp = excluded.xp, level = excluded.level, last_xp_at = excluded.last_xp_at
`);
const recordXpEvent = db.prepare("INSERT INTO xp_events (system_id, user_id, xp, earned_at) VALUES (?, ?, ?, ?)");
const xpChannelRules = db.prepare("SELECT channel_id, mode FROM system_channels WHERE system_id = ?");
const xpRoleRules = db.prepare("SELECT role_id, mode FROM system_role_filters WHERE system_id = ?");

type ContentFilter = "any" | "text" | "image" | "video" | "link" | "file" | "embed" | "sound" | "poll" | "sticker" | "forward" | "word";
type LevelingSystem = { id: number; name: string; enabled: number; min_xp: number; max_xp: number; min_xp_values: string; max_xp_values: string; specific_words: string; cooldown_seconds: number; content_filter: string; announce_destination: "none" | "current" | "dm" | "channel"; announce_channel_id: string | null; announce_message: string };

bot.on(Events.MessageCreate, async message => {
  if (!message.guild || message.author.bot || !message.member) return;
  await rewardEconomyMessage(message);
  ensureDefaultSystem(message.guild.id);
  const systems = db.prepare("SELECT * FROM leveling_systems WHERE guild_id = ? AND enabled = 1").all(message.guild.id) as LevelingSystem[];
  for (const settings of systems) await processSystem(settings, message);
});

async function processSystem(settings: LevelingSystem, message: import("discord.js").Message) {
  if (message.author.bot || message.webhookId) return;
  const guild = message.guild;
  if (!guild) return;
  const rules = xpChannelRules.all(settings.id) as Array<{ channel_id: string; mode: "allow" | "deny" }>;
  const allowed = new Set(rules.filter(rule => rule.mode === "allow").map(rule => rule.channel_id));
  const denied = new Set(rules.filter(rule => rule.mode === "deny").map(rule => rule.channel_id));
  const channelIds = new Set<string>([message.channelId]);
  if ("parentId" in message.channel && message.channel.parentId) {
    channelIds.add(message.channel.parentId);
    const parent = guild.channels.cache.get(message.channel.parentId);
    if (parent && "parentId" in parent && parent.parentId) channelIds.add(parent.parentId);
  }
  if ([...channelIds].some(id => denied.has(id)) || (allowed.size > 0 && ![...channelIds].some(id => allowed.has(id)))) return;
  const roleRules = xpRoleRules.all(settings.id) as Array<{ role_id: string; mode: "allow" | "deny" }>;
  const allowedRoles = new Set(roleRules.filter(rule => rule.mode === "allow").map(rule => rule.role_id));
  const deniedRoles = new Set(roleRules.filter(rule => rule.mode === "deny").map(rule => rule.role_id));
  const memberRoleIds = message.member?.roles.cache.map(role => role.id) ?? [];
  if (memberRoleIds.some(id => deniedRoles.has(id)) || (allowedRoles.size > 0 && !memberRoleIds.some(id => allowedRoles.has(id)))) return;
  const hasImage = message.attachments.some(file => file.contentType?.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(file.name ?? ""));
  const hasVideo = message.attachments.some(file => file.contentType?.startsWith("video/") || /\.(mp4|webm|mov|mkv|avi)$/i.test(file.name ?? ""));
  const hasAudio = message.attachments.some(file => file.contentType?.startsWith("audio/") || /\.(mp3|wav|ogg|m4a|flac|aac)$/i.test(file.name ?? ""));
  const hasText = message.content.trim().length > 0;
  const messageWords = new Set(message.content.toLocaleLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean));
  const specificWords = String(settings.specific_words || "").split(",").map(value => value.trim().toLocaleLowerCase()).filter(Boolean);
  const matchesFilter: Record<ContentFilter, boolean> = {
    any: true,
    text: hasText && message.attachments.size === 0 && message.stickers.size === 0,
    image: hasImage,
    video: hasVideo,
    link: /https?:\/\/\S+/i.test(message.content),
    file: message.attachments.size > 0 && !hasImage && !hasVideo && !hasAudio,
    embed: message.embeds.length > 0,
    sound: hasAudio || message.flags.has("IsVoiceMessage"),
    poll: message.poll !== null,
    sticker: message.stickers.size > 0,
    forward: message.messageSnapshots.size > 0,
    word: specificWords.some(word => messageWords.has(word))
  };
  const selectedFilters = settings.content_filter.split(",").filter((filter): filter is ContentFilter => filter in matchesFilter);
  const matchedIndex = selectedFilters.findIndex(filter => matchesFilter[filter]);
  if (matchedIndex < 0) return;

  const now = Date.now();
  const current = memberRow.get(settings.id, message.author.id) as { xp: number; level: number; last_xp_at: number } | undefined;
  if (current && now - current.last_xp_at < settings.cooldown_seconds * 1000) return;
  const minimums = String(settings.min_xp_values || "").split(",").filter(Boolean).map(value => Math.max(0, Math.floor(Number(value)) || 0));
  const maximums = String(settings.max_xp_values || "").split(",").filter(Boolean).map(value => Math.max(0, Math.floor(Number(value)) || 0));
  const minimum = minimums[matchedIndex] ?? 0;
  const maximum = Math.max(minimum, maximums[matchedIndex] ?? 0);
  if (!maximum) return;
  const gained = Math.floor(Math.random() * (maximum - minimum + 1)) + minimum;
  const xp = (current?.xp ?? 0) + gained;
  const previousLevel = current?.level ?? 0;
  const level = levelFromXp(xp);
  addXp.run(settings.id, message.author.id, message.author.username, xp, level, now);
  recordXpEvent.run(settings.id, message.author.id, gained, now);
  if (level <= previousLevel || !message.member) return;

  const rewards = db.prepare("SELECT role_id FROM system_roles WHERE system_id = ? AND level <= ? ORDER BY level").all(settings.id, level) as { role_id: string }[];
  const awardedRoles: Array<{ id: string; name: string }> = [];
  const me = guild.members.me;
  if (me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    for (const reward of rewards) {
      const role = guild.roles.cache.get(reward.role_id);
      if (role && role.position < me.roles.highest.position && !message.member.roles.cache.has(role.id)) {
        const awarded = await message.member.roles.add(role).then(() => true).catch(error => { console.error(error); return false; });
        if (awarded) awardedRoles.push({ id: role.id, name: role.name });
      }
    }
  }

  const nextLevelXp = xpForLevel(level + 1);
  const variables: Record<string, string> = {
    user: message.member.displayName,
    username: message.author.username,
    display_name: message.member.displayName,
    user_id: message.author.id,
    level: String(level),
    xp: String(xp),
    next_level: String(level + 1),
    next_level_xp: String(nextLevelXp),
    xp_needed: String(Math.max(0, nextLevelXp - xp)),
    system: settings.name,
    server: guild.name,
    server_id: guild.id,
    member_count: String(guild.memberCount),
    channel: `<#${message.channelId}>`,
    channel_name: guild.channels.cache.get(message.channelId)?.name ?? "unknown-channel",
    role: awardedRoles.length ? awardedRoles.map(role => role.name).join(", ") : "No role reward",
    role_name: awardedRoles.length ? awardedRoles.map(role => role.name).join(", ") : "No role reward"
  };
  const text = Object.entries(variables).reduce((result, [key, value]) => result.replaceAll(`{${key}}`, value), settings.announce_message).slice(0, 2000);
  if (settings.announce_destination === "none") return;
  if (settings.announce_destination === "dm") {
    await message.author.send({ content: text, allowedMentions: { parse: [] } }).catch(console.error);
    return;
  }
  const destination = settings.announce_destination === "channel" && settings.announce_channel_id
    ? guild.channels.cache.get(settings.announce_channel_id)
    : message.channel;
  if (destination?.isSendable()) await destination.send({ content: text, allowedMentions: { parse: [] } }).catch(console.error);
}

const levelCommand = new SlashCommandBuilder()
  .setName("level")
  .setDescription("Show a member's level and XP progress")
  .addUserOption(option => option.setName("member").setDescription("Member to view (defaults to you)"))
  .addStringOption(option => option.setName("system").setDescription("Leveling system to view").setAutocomplete(true));

bot.on(Events.InteractionCreate, async interaction => {
  try {
  if (interaction.isAutocomplete() && interaction.commandName === "level") {
    if (!interaction.guildId) return interaction.respond([]);
    ensureDefaultSystem(interaction.guildId);
    const query = interaction.options.getFocused().toLowerCase();
    const systems = db.prepare("SELECT id, name FROM leveling_systems WHERE guild_id=? ORDER BY id").all(interaction.guildId) as Array<{ id: number; name: string }>;
    await interaction.respond(systems.filter(system => system.name.toLowerCase().includes(query)).slice(0, 25).map(system => ({ name: system.name, value: String(system.id) })));
    return;
  }
  if (interaction.isModalSubmit()) {
    await handleEconomyCommand(interaction);
    return;
  }
  if (interaction.isStringSelectMenu() && await handleEconomyCommand(interaction)) return;
  if (!interaction.isChatInputCommand() || !interaction.guild) return;
  if (await handleEconomyCommand(interaction)) return;
  if (interaction.commandName !== "level") return;
  await interaction.deferReply();
  ensureDefaultSystem(interaction.guild.id);
  const requestedId = Number(interaction.options.getString("system"));
  const system = (Number.isFinite(requestedId) && requestedId > 0
    ? db.prepare("SELECT id, name FROM leveling_systems WHERE id=? AND guild_id=?").get(requestedId, interaction.guild.id)
    : db.prepare("SELECT id, name FROM leveling_systems WHERE guild_id=? ORDER BY id LIMIT 1").get(interaction.guild.id)) as { id: number; name: string } | undefined;
  if (!system) return interaction.editReply("That leveling system no longer exists.");
  const user = interaction.options.getUser("member") ?? interaction.user;
  const profileUser = await user.fetch(true).catch(() => user);
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  const nameplate = member?.collectibles?.nameplate ?? profileUser.collectibles?.nameplate;
  const progress = db.prepare("SELECT xp, level FROM system_progress WHERE system_id=? AND user_id=?").get(system.id, user.id) as { xp: number; level: number } | undefined;
  const xp = progress?.xp ?? 0;
  const level = progress?.level ?? 0;
  const currentThreshold = xpForLevel(level);
  const nextThreshold = xpForLevel(level + 1);
  const rank = Number((db.prepare("SELECT COUNT(*) + 1 AS rank FROM system_progress WHERE system_id=? AND xp>?").get(system.id, xp) as { rank: number }).rank);
  const speed = db.prepare("SELECT COALESCE(SUM(xp), 0) AS xp, MIN(earned_at) AS first_at FROM xp_events WHERE system_id=? AND user_id=?").get(system.id, user.id) as { xp: number; first_at: number | null };
  const measuredMinutes = speed.first_at ? Math.max(1, (Date.now() - speed.first_at) / 60_000) : 1;
  const averageXpPerMinute = speed.xp / measuredMinutes;
  const cardData = {
    username: profileUser.username,
    avatarUrl: profileUser.displayAvatarURL({ extension: "png", size: 256 }),
    avatarDecorationUrl: member?.avatarDecorationURL() ?? profileUser.avatarDecorationURL({ size: 256 }),
    nameplateUrl: nameplate ? `https://cdn.discordapp.com/assets/collectibles/${nameplate.asset}static.png` : null,
    nameplatePalette: nameplate?.palette,
    accentColor: profileUser.accentColor,
    bannerUrl: profileUser.bannerURL({ extension: "png", size: 512 }),
    systemName: system.name,
    level,
    rank,
    totalXp: xp,
    levelXp: xp - currentThreshold,
    levelXpRequired: nextThreshold - currentThreshold,
    xpNeeded: Math.max(0, nextThreshold - xp),
    averageXpPerMinute
  };
  const image = await renderLevelCard(cardData);
  await interaction.editReply({ files: [new AttachmentBuilder(image, { name: `level-${user.id}.png` })] });
  } catch (error) {
    console.error("Interaction failed", error);
    if (!interaction.isRepliable()) return;
    const message = { content: "Something went wrong while processing that command.", ephemeral: true } as const;
    if (interaction.deferred || interaction.replied) await interaction.followUp(message).catch(console.error);
    else await interaction.reply(message).catch(console.error);
  }
});

bot.once(Events.ClientReady, async client => {
  await client.application.commands.set([levelCommand.toJSON(), ...economyCommands.map(command => command.toJSON())]);
  console.log(`Discord bot ready as ${client.user.tag}`);
});
export const startBot = () => bot.login(config.token);
