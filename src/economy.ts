import { systemAvailable } from "./premium.js";
import { ActionRowBuilder, ButtonBuilder, ButtonInteraction, ButtonStyle, ChatInputCommandInteraction, ContainerBuilder, GuildMember, LabelBuilder, Message, MessageFlags, ModalBuilder, ModalSubmitInteraction, RepliableInteraction, SeparatorBuilder, SlashCommandBuilder, StringSelectMenuBuilder, StringSelectMenuInteraction, TextDisplayBuilder, TextInputBuilder, TextInputStyle, UserSelectMenuBuilder } from "discord.js";
import { db, ensureDefaultEconomySystem, settingsFor } from "./db.js";

type EconomyConfig = Record<string, string | string[] | boolean>;
type Account = { cash: number; bank: number };
type ShopItem = { id: number; name: string; price: number; description: string; emoji_id: string | null; stock: number; unlimited_stock: number; inventory_item: number; usable: number; requirements_json: string; actions_json: string };
type EconomySystem = { id: number; name: string; currency_symbol: string; starting_balance: number; max_cash_balance: number; max_bank_balance: number; config_json: string };
type ShopPrice = { system_id: number; amount: number; name: string; currency_symbol: string; config_json: string; join_operator: "and" | "or" };

const account = db.prepare("SELECT cash, bank FROM economy_accounts WHERE guild_id=? AND user_id=?");
const createAccount = db.prepare("INSERT OR IGNORE INTO economy_accounts (guild_id,user_id,username,cash) VALUES (?,?,?,?)");
const setAccount = db.prepare("UPDATE economy_accounts SET username=?, cash=?, bank=? WHERE guild_id=? AND user_id=?");
const addInventory = db.prepare(`INSERT INTO economy_inventory (guild_id,user_id,item_id,quantity) VALUES (?,?,?,1)
  ON CONFLICT(guild_id,user_id,item_id) DO UPDATE SET quantity=quantity+1`);
const recordTransaction = db.prepare("INSERT INTO economy_transactions (guild_id,user_id,other_user_id,action,amount,details,created_at) VALUES (?,?,?,?,?,?,?)");
const economyEmoji = "<:crazygears:1553368966850813963>";
const cartEmoji = "<:cart:1554529987061616720>";

function configFor(guildId: string) {
  try { return JSON.parse(settingsFor(guildId).economy_config) as EconomyConfig; } catch { return {}; }
}
function systemConfig(system?: EconomySystem) {
  if (!system) return {};
  try { return JSON.parse(system.config_json || "{}") as EconomyConfig; } catch { return {}; }
}
function activeConfig(guildId: string): EconomyConfig {
  const local = systemConfig(systemsFor(guildId)[0]);
  return { ...configFor(guildId), ...local, messageReward: local.messageReward ?? "0" } as EconomyConfig;
}
function numberSetting(config: EconomyConfig, key: string, fallback: number) {
  const value = Number(config[key]);
  return Number.isFinite(value) ? value : fallback;
}
function enabled(config: EconomyConfig, key: string, fallback = true) {
  const value = config[key];
  return value === undefined ? fallback : value === true || value === "true";
}
function label(config: EconomyConfig, key: string, fallback: string) {
  const value = String(config[key] ?? "").trim();
  return value ? value.slice(0, 32) : fallback;
}
function getAccount(guildId: string, userId: string, username: string): Account {
  const system = systemsFor(guildId)[0];
  if (!system) throw new Error("No enabled economy system");
  db.prepare("INSERT OR IGNORE INTO economy_balances (system_id,user_id,username,cash) VALUES (?,?,?,?)").run(system.id, userId, username, Math.max(0, system.starting_balance));
  return db.prepare("SELECT cash,bank FROM economy_balances WHERE system_id=? AND user_id=?").get(system.id, userId) as Account;
}
function saveAccount(guildId: string, userId: string, username: string, value: Account) {
  const system = systemsFor(guildId)[0];
  if (!system) return;
  db.prepare("UPDATE economy_balances SET username=?,cash=?,bank=? WHERE system_id=? AND user_id=?").run(username, Math.floor(value.cash), Math.floor(value.bank), system.id, userId);
}
function money(guildId: string, amount: number) {
  const system = systemsFor(guildId)[0];
  return `${system?.currency_symbol || ""} ${Math.floor(amount).toLocaleString()}`.trim();
}
function systemsFor(guildId: string) {
  ensureDefaultEconomySystem(guildId);
  return (db.prepare("SELECT * FROM economy_systems WHERE guild_id=? AND enabled=1 AND deleted=0 ORDER BY id").all(guildId) as EconomySystem[]).filter(system=>systemAvailable(guildId,"economy",system.id));
}
function accountForSystem(system: EconomySystem, userId: string, username: string) {
  db.prepare("INSERT OR IGNORE INTO economy_balances (system_id,user_id,username,cash) VALUES (?,?,?,?)").run(system.id, userId, username, Math.max(0, system.starting_balance));
  return db.prepare("SELECT cash,bank FROM economy_balances WHERE system_id=? AND user_id=?").get(system.id, userId) as Account;
}
function pricesFor(itemId: number) {
  const linked=db.prepare("SELECT s.id,s.guild_id FROM economy_shop_prices p JOIN economy_systems s ON s.id=p.system_id WHERE p.item_id=?").all(itemId) as Array<{id:number;guild_id:string}>;
  if(linked.some(system=>!systemAvailable(system.guild_id,"economy",system.id)))return [];
  return db.prepare(`SELECT p.system_id,p.amount,p.join_operator,s.name,s.currency_symbol,s.config_json FROM economy_shop_prices p JOIN economy_systems s ON s.id=p.system_id WHERE p.item_id=? AND s.enabled=1 AND s.deleted=0 ORDER BY p.id`).all(itemId) as ShopPrice[];
}
function priceGroups(prices: ShopPrice[]) {
  return prices.reduce<ShopPrice[][]>((groups, price, index) => {
    if (!index || price.join_operator === "or") groups.push([price]); else groups.at(-1)!.push(price);
    return groups;
  }, []);
}
function selectEmoji(symbol: string) {
  const custom = symbol.trim().match(/^<(a?):([A-Za-z0-9_]+):(\d+)>$/);
  if (custom) return { animated: custom[1] === "a", name: custom[2], id: custom[3] };
  const unicode = symbol.trim();
  return unicode && !unicode.includes("<") ? { name: unicode } : undefined;
}
function itemSelectEmoji(value: string | null) {
  return value ? /^\d+$/.test(value) ? { id: value } : { name: value } : undefined;
}
function itemIcon(value: string | null, interaction: EconomyInteraction) {
  if (!value) return "";
  if (!/^\d+$/.test(value)) return value;
  const guildEmoji = interaction.guild?.emojis.cache.get(value);
  if (guildEmoji) return guildEmoji.toString();
  const applicationNames: Record<string, string> = { "1553368966850813963": "crazygears", "1553368950082113536": "alonecrazygears" };
  return applicationNames[value] ? `<:${applicationNames[value]}:${value}>` : "";
}
function priceCurrencyName(price: ShopPrice) {
  try {
    const config = JSON.parse(price.config_json || "{}") as EconomyConfig;
    const singular = label(config, "cashName", price.name);
    return price.amount === 1 ? singular : label(config, "cashNamePlural", `${singular}s`);
  }
  catch { return price.name; }
}
function replyV2(interaction: RepliableInteraction, title: string, body: string, ephemeral = false, separated = true) {
  const container = new ContainerBuilder().setAccentColor(0xf45f77);
  container
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`${economyEmoji} **${title}**`))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(body));
  return interaction.reply({
    components: [container],
    allowedMentions: { parse: [] },
    flags: ephemeral ? MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral : MessageFlags.IsComponentsV2
  });
}
function parseAmount(raw: string, available: number) {
  if (raw.toLowerCase() === "all") return available;
  const value = Number(raw.replaceAll(",", ""));
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}
function cooldown(guildId: string, userId: string, action: string) {
  return db.prepare("SELECT available_at, streak FROM economy_cooldowns WHERE guild_id=? AND user_id=? AND action=?").get(guildId, userId, action) as { available_at: number; streak: number } | undefined;
}
function setCooldown(guildId: string, userId: string, action: string, availableAt: number, streak = 0) {
  db.prepare(`INSERT INTO economy_cooldowns (guild_id,user_id,action,available_at,streak) VALUES (?,?,?,?,?)
    ON CONFLICT(guild_id,user_id,action) DO UPDATE SET available_at=excluded.available_at,streak=excluded.streak`).run(guildId, userId, action, availableAt, streak);
}
function channelsFrom(config: EconomyConfig, key: string) {
  const value = config[key];
  return new Set(Array.isArray(value) ? value.map(String) : []);
}
function economyMessageFilterMatch(message: Message, configured: unknown) {
  const hasImage = message.attachments.some(file => file.contentType?.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(file.name ?? ""));
  const hasVideo = message.attachments.some(file => file.contentType?.startsWith("video/") || /\.(mp4|webm|mov|mkv|avi)$/i.test(file.name ?? ""));
  const hasAudio = message.attachments.some(file => file.contentType?.startsWith("audio/") || /\.(mp3|wav|ogg|m4a|flac|aac)$/i.test(file.name ?? ""));
  const matches: Record<string, boolean> = {
    any: true,
    text: message.content.trim().length > 0 && message.attachments.size === 0 && message.stickers.size === 0,
    image: hasImage,
    video: hasVideo,
    link: /https?:\/\/\S+/i.test(message.content),
    file: message.attachments.size > 0 && !hasImage && !hasVideo && !hasAudio,
    embed: message.embeds.length > 0,
    sound: hasAudio || message.flags.has("IsVoiceMessage"),
    poll: message.poll !== null,
    sticker: message.stickers.size > 0,
    forward: message.messageSnapshots.size > 0
  };
  const selected = String(configured || "any").split(",").filter(value => value in matches);
  const filters = selected.length ? selected : ["any"];
  const index = filters.findIndex(value => matches[value]);
  return index < 0 ? null : { index, type: filters[index] };
}

export async function rewardEconomyMessage(message: Message) {
  if (!message.guild || !message.member || message.author.bot || message.webhookId) return;
  const systems = systemsFor(message.guild.id);
  const sharedConfig = configFor(message.guild.id);
  const channelIds = new Set([message.channelId, ...(message.channel.isThread() && message.channel.parentId ? [message.channel.parentId] : [])]);
  const roles = new Set(message.member.roles.cache.keys());
  const now = Date.now();
  for (const system of systems) {
    const local = systemConfig(system);
    const config = { ...sharedConfig, ...local, messageReward: local.messageReward ?? "0" } as EconomyConfig;
    const match = economyMessageFilterMatch(message, config.messageContentFilter);
    if (!match) continue;
    const rewardAmounts = String(config.messageReward ?? "0").split(",").map(value => { const amount = Number(value.trim()); return Number.isFinite(amount) ? Math.max(0, Math.floor(amount)) : 0; });
    const reward = rewardAmounts[match.index] ?? (rewardAmounts.length === 1 ? rewardAmounts[0] : 0);
    if (!reward) continue;
    const allowedChannels = channelsFrom(config, "messageAllowedChannelIds");
    const deniedChannels = channelsFrom(config, "messageDeniedChannelIds");
    if ([...channelIds].some(id => deniedChannels.has(id)) || (allowedChannels.size && ![...channelIds].some(id => allowedChannels.has(id)))) continue;
    const allowedRoles = channelsFrom(config, "messageAllowedRoleIds");
    const deniedRoles = channelsFrom(config, "messageDeniedRoleIds");
    if ([...roles].some(id => deniedRoles.has(id)) || (allowedRoles.size && ![...roles].some(id => allowedRoles.has(id)))) continue;
    const minimumAge = numberSetting(config, "minimumAccountAge", 0) * 86_400_000;
    if (minimumAge && now - message.author.createdTimestamp < minimumAge) continue;
    const wait = Math.max(5, numberSetting(config, "messageCooldown", 60)) * 1000;
    const cooldownAction = `message:${system.id}`;
    const currentCooldown = cooldown(message.guild.id, message.author.id, cooldownAction);
    if (currentCooldown && currentCooldown.available_at > now) continue;
    const dailyLimit = Math.max(0, numberSetting(config, "dailyEarningLimit", 0));
    const transactionMarker = `[currency:${system.id}]`;
    const earned = Number((db.prepare("SELECT COALESCE(SUM(amount),0) AS total FROM economy_transactions WHERE guild_id=? AND user_id=? AND action='message' AND amount>0 AND created_at>=? AND details LIKE ?").get(message.guild.id, message.author.id, now - 86_400_000, `%${transactionMarker}%`) as { total: number }).total);
    const bonusRole = String(config.bonusRole || "");
    const bonus = bonusRole && roles.has(bonusRole) ? numberSetting(config, "roleBonus", 0) : 0;
    const amount = Math.min(Math.floor(reward * (1 + bonus / 100)), dailyLimit ? Math.max(0, dailyLimit - earned) : Number.MAX_SAFE_INTEGER);
    if (!amount) continue;
    const value = accountForSystem(system, message.author.id, message.author.username);
    const credited = Math.min(amount, Math.max(0, system.max_cash_balance - value.cash));
    if (!credited) continue;
    value.cash += credited;
    db.prepare("UPDATE economy_balances SET username=?,cash=?,bank=? WHERE system_id=? AND user_id=?").run(message.author.username, Math.floor(value.cash), Math.floor(value.bank), system.id, message.author.id);
    setCooldown(message.guild.id, message.author.id, cooldownAction, now + wait);
    recordTransaction.run(message.guild.id, message.author.id, null, "message", credited, `${message.channelId} ${transactionMarker}`, now);
  }
}

export const economyCommands = [new SlashCommandBuilder()
  .setName("eco")
  .setDescription("Use the server economy")
  .addStringOption(option => option.setName("action").setDescription("Choose an economy action").setRequired(true).addChoices(
    { name: "Balance", value: "balance" },
    { name: "Daily reward", value: "daily" },
    { name: "Work", value: "work" },
    { name: "Deposit", value: "deposit" },
    { name: "Withdraw", value: "withdraw" },
    { name: "Pay member", value: "pay" },
    { name: "View shop", value: "shop" },
    { name: "Buy item", value: "buy" },
    { name: "Inventory", value: "inventory" },
    { name: "Use item", value: "use" },
    { name: "Leaderboard", value: "leaderboard" }
  ))];

export function economyModal(action: string, userId: string, config: EconomyConfig = {}, guildId?: string) {
  const bankName = label(config, "bankName", "Bank");
  const title = action === "deposit" ? `Deposit into ${bankName}` : action === "withdraw" ? `Withdraw from ${bankName}` : `Economy — ${action}`;
  const modal = new ModalBuilder().setCustomId(`economy:${action}:${userId}`).setTitle(title.slice(0, 45));
  if (action === "pay") {
    modal.addLabelComponents(new LabelBuilder()
      .setLabel("Member to pay")
      .setDescription("Choose who receives the payment.")
      .setUserSelectMenuComponent(new UserSelectMenuBuilder().setCustomId("member").setMinValues(1).setMaxValues(1)));
  }
  if (action === "deposit" || action === "withdraw" || action === "pay") {
    modal.addLabelComponents(new LabelBuilder()
      .setLabel("Amount")
      .setDescription(action === "pay" ? "Enter a whole number." : "Enter a whole number or all.")
      .setTextInputComponent(new TextInputBuilder().setCustomId("amount").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder(action === "pay" ? "100" : "100 or all")));
  }
  if (action === "use" && guildId) {
    const items = db.prepare(`SELECT s.id,s.name,s.description,s.emoji_id,i.quantity FROM economy_inventory i JOIN economy_shop_items s ON s.id=i.item_id WHERE i.guild_id=? AND i.user_id=? AND i.quantity>0 AND s.usable=1 ORDER BY s.name LIMIT 25`).all(guildId, userId) as Array<{ id: number; name: string; description: string; emoji_id: string | null; quantity: number }>;
    modal.addLabelComponents(new LabelBuilder()
      .setLabel("Item")
      .setDescription("Choose an item from your inventory.")
      .setStringSelectMenuComponent(new StringSelectMenuBuilder()
        .setCustomId("item")
        .setPlaceholder("Choose an item")
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(items.map(item => ({
          label: item.name.slice(0, 100),
          description: `Owned: ${item.quantity}${item.description ? ` · ${item.description}` : ""}`.slice(0, 100),
          value: String(item.id),
          ...(itemSelectEmoji(item.emoji_id) ? { emoji: itemSelectEmoji(item.emoji_id) } : {})
        })))));
  }
  if (action === "buy" && guildId) {
    const items = db.prepare("SELECT id,name,description,emoji_id FROM economy_shop_items WHERE guild_id=? AND listed=1 AND (expires_at IS NULL OR expires_at>?) AND (unlimited_stock=1 OR stock>0) ORDER BY name LIMIT 25").all(guildId, new Date().toISOString()) as Array<{ id: number; name: string; description: string; emoji_id: string | null }>;
    modal.addLabelComponents(new LabelBuilder()
      .setLabel("Item")
      .setDescription("Choose the shop item you want to buy.")
      .setStringSelectMenuComponent(new StringSelectMenuBuilder()
        .setCustomId("item")
        .setPlaceholder("Choose an item")
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(items.map(item => ({
          label: item.name.slice(0, 100),
          description: (item.description || "No description").slice(0, 100),
          value: String(item.id),
          ...(itemSelectEmoji(item.emoji_id) ? { emoji: itemSelectEmoji(item.emoji_id) } : {})
        })))));
  }
  return modal;
}

type EconomyInteraction = ChatInputCommandInteraction | ModalSubmitInteraction | StringSelectMenuInteraction | ButtonInteraction;

async function audit(interaction: EconomyInteraction, title: string, text: string, icon = economyEmoji) {
  const id = settingsFor(interaction.guildId!).money_audit_channel_id;
  if (!id) return;
  const channel = interaction.guild?.channels.cache.get(id);
  if (!channel?.isSendable()) return;
  const container = new ContainerBuilder()
    .setAccentColor(0xf45f77)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`${icon} **${title}**`))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(text))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`<t:${Math.floor(Date.now() / 1000)}:f>`));
  await channel.send({ components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } }).catch(console.error);
}
async function auditPurchase(interaction: EconomyInteraction, item: ShopItem, paid: string) {
  const id = settingsFor(interaction.guildId!).money_audit_channel_id;
  if (!id) return;
  const channel = interaction.guild?.channels.cache.get(id);
  if (!channel?.isSendable()) return;
  const container = new ContainerBuilder()
    .setAccentColor(0xf45f77)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`${cartEmoji} **Purchase**`))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${interaction.user.username}** bought ${itemIcon(item.emoji_id, interaction)} **${item.name}** for **${paid}**.`))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`<t:${Math.floor(Date.now() / 1000)}:f>`));
  await channel.send({ components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } }).catch(console.error);
}

async function purchaseItem(interaction: EconomyInteraction, itemId: number, groupIndex: number) {
  const guildId = interaction.guildId!;
  const config = activeConfig(guildId);
  const respond = async (title: string, body: string, ephemeral = false) => {
    if (interaction.isStringSelectMenu()) {
      const container = new ContainerBuilder()
        .setAccentColor(0xf45f77)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`${economyEmoji} **${title}**`))
        .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(body));
      await interaction.update({ components: [container], allowedMentions: { parse: [] } });
      return;
    }
    await replyV2(interaction, title, body, ephemeral);
  };
  if (!enabled(config, "shopEnabled")) return respond("Shop unavailable", "The shop is disabled.", true);
  const item = db.prepare("SELECT * FROM economy_shop_items WHERE guild_id=? AND id=? AND listed=1 AND (expires_at IS NULL OR expires_at>?)").get(guildId, itemId, new Date().toISOString()) as ShopItem | undefined;
  if (!item || (!item.unlimited_stock && item.stock < 1)) return respond("Item unavailable", "That item is unavailable.", true);
  const requirements = JSON.parse(item.requirements_json || "[]") as Array<{ type?: string; roleId?: string; value?: string; event?: string }>;
  const member = interaction.member as GuildMember;
  const requiredRoles = requirements.filter(r => (!r.event || r.event === "buy" || r.event === "both") && r.type === "role").map(r => r.roleId || r.value).filter(Boolean) as string[];
  if (requiredRoles.some(role => !member.roles.cache.has(role))) return respond("Requirements not met", "You do not meet this item's role requirements.", true);
  const selectedGroup = priceGroups(pricesFor(item.id))[groupIndex];
  if (!selectedGroup) return respond("Price unavailable", "That price option is no longer available.", true);
  const systems = systemsFor(guildId);
  const charges = selectedGroup.map(price => ({ price, system: systems.find(entry => entry.id === price.system_id) })).filter((charge): charge is { price: ShopPrice; system: EconomySystem } => Boolean(charge.system)).map(charge => ({ ...charge, value: accountForSystem(charge.system, interaction.user.id, interaction.user.username) }));
  if (charges.length !== selectedGroup.length) return respond("Price unavailable", "One of this item's currencies is no longer available.", true);
  const missing = charges.find(charge => charge.value.cash < charge.price.amount);
  if (missing) {
    const cashName = label(systemConfig(missing.system), "cashName", "Cash");
    return respond(`Insufficient ${cashName.toLowerCase()}`, `You do not have enough ${missing.system.name}.`, true);
  }
  for (const charge of charges) db.prepare("UPDATE economy_balances SET username=?,cash=?,bank=? WHERE system_id=? AND user_id=?").run(interaction.user.username, charge.value.cash - charge.price.amount, charge.value.bank, charge.system.id, interaction.user.id);
  if (item.inventory_item) addInventory.run(guildId, interaction.user.id, item.id);
  if (!item.unlimited_stock) db.prepare("UPDATE economy_shop_items SET stock=stock-1 WHERE guild_id=? AND id=? AND stock>0").run(guildId, item.id);
  for (const charge of charges) recordTransaction.run(guildId, interaction.user.id, null, "buy", -charge.price.amount, `${item.name} [currency:${charge.system.id}]`, Date.now());
  const actions = JSON.parse(item.actions_json || "[]") as Array<{ type?: string; value?: string; event?: string }>;
  for (const action of actions.filter(a => !a.event || a.event === "buy" || a.event === "both")) {
    if (action.type === "role" && action.value) await member.roles.add(action.value).catch(console.error);
    if (action.type === "message" && action.value && interaction.channel?.isSendable()) await interaction.channel.send({ content: action.value.slice(0, 2000), allowedMentions: { parse: [] } }).catch(console.error);
  }
  const paid = charges.map(charge => `${charge.system.currency_symbol} ${charge.price.amount.toLocaleString()}`).join(" and ");
  await respond("Purchase complete", `You bought **${item.name}** for **${paid}**.`);
  await auditPurchase(interaction, item, paid);
}
async function rewardCommand(interaction: ChatInputCommandInteraction | ModalSubmitInteraction, action: "daily" | "work") {
  const guildId = interaction.guildId!;
  const config = activeConfig(guildId);
  const previous = cooldown(guildId, interaction.user.id, action);
  const now = Date.now();
  if (previous && previous.available_at > now) return replyV2(interaction, "Reward on cooldown", `You can claim this reward again <t:${Math.ceil(previous.available_at / 1000)}:R>.`, true);
  const min = Math.max(0, numberSetting(config, `${action}Min`, action === "daily" ? 100 : 25));
  const max = Math.max(min, numberSetting(config, `${action}Max`, action === "daily" ? 200 : 100));
  const streak = action === "daily" && previous && now - previous.available_at < 86_400_000 ? previous.streak + 1 : action === "daily" ? 1 : 0;
  const member = interaction.member as GuildMember;
  const bonusRole = String(config.bonusRole || "");
  const bonus = bonusRole && member.roles.cache.has(bonusRole) ? numberSetting(config, "roleBonus", 0) : 0;
  const baseAmount = Math.floor(Math.random() * (max - min + 1)) + min + (action === "daily" ? Math.max(0, streak - 1) * numberSetting(config, "streakBonus", 10) : 0);
  const dailyLimit = Math.max(0, numberSetting(config, "dailyEarningLimit", 0));
  const earned = Number((db.prepare("SELECT COALESCE(SUM(amount),0) AS total FROM economy_transactions WHERE guild_id=? AND user_id=? AND amount>0 AND created_at>=?").get(guildId, interaction.user.id, now - 86_400_000) as { total: number }).total);
  const amount = Math.min(Math.floor(baseAmount * (1 + bonus / 100)), dailyLimit ? Math.max(0, dailyLimit - earned) : Number.MAX_SAFE_INTEGER);
  if (!amount) return replyV2(interaction, "Daily limit reached", "You have reached the daily earning limit.", true);
  const value = getAccount(guildId, interaction.user.id, interaction.user.username);
  const credited = Math.min(amount, Math.max(0, settingsFor(guildId).max_cash_balance - value.cash));
  if (!credited) return replyV2(interaction, "Balance full", `Your ${label(config, "cashName", "Cash").toLowerCase()} balance is already at its maximum.`, true);
  value.cash += credited;
  saveAccount(guildId, interaction.user.id, interaction.user.username, value);
  setCooldown(guildId, interaction.user.id, action, now + (action === "daily" ? 86_400_000 : 3_600_000), streak);
  recordTransaction.run(guildId, interaction.user.id, null, action, credited, "", now);
  await replyV2(interaction, action === "daily" ? "Daily reward" : "Work complete", `You earned **${money(guildId, credited)}**${action === "daily" ? `\nDaily streak: **${streak}**` : ""}.`);
}

const shopPageSize = 7;
function shopPage(interaction: EconomyInteraction, requestedPage = 0, ownerId = interaction.user.id) {
  const guildId = interaction.guildId!;
  const now = new Date().toISOString();
  const filter = "guild_id=? AND listed=1 AND (expires_at IS NULL OR expires_at>?)";
  const total = (db.prepare(`SELECT COUNT(*) AS total FROM economy_shop_items WHERE ${filter}`).get(guildId, now) as { total: number }).total;
  const pages = Math.max(1, Math.ceil(total / shopPageSize));
  const page = Math.max(0, Math.min(pages - 1, Number.isSafeInteger(requestedPage) ? requestedPage : 0));
  const items = db.prepare(`SELECT id,name,price,description,emoji_id,stock,unlimited_stock FROM economy_shop_items WHERE ${filter} ORDER BY id LIMIT ? OFFSET ?`).all(guildId, now, shopPageSize, page * shopPageSize) as ShopItem[];
  const title = label(configFor(guildId), "shopName", "Server shop");
  const container = new ContainerBuilder().setAccentColor(0xf45f77)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`${economyEmoji} **${title}**`))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true));
  for (const item of items) {
    const prices = pricesFor(item.id);
    const display = prices.length ? prices.map((price, index) => `${index ? ` **${price.join_operator}** ` : ""}${price.currency_symbol} ${price.amount.toLocaleString()}`).join("") : money(guildId, item.price);
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${itemIcon(item.emoji_id, interaction)} ${item.name}** ? ${display}${item.unlimited_stock || item.stock > 0 ? "" : " *(sold out)*"}\n${item.description || "No description"}`.trim().slice(0, 4000)));
  }
  if (!items.length) container.addTextDisplayComponents(new TextDisplayBuilder().setContent("The shop has no listed items."));
  if (pages > 1) {
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`Page ${page + 1} of ${pages}`))
      .addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`economy:shop-page:${ownerId}:${page - 1}`).setLabel("Previous").setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
        new ButtonBuilder().setCustomId(`economy:shop-page:${ownerId}:${page + 1}`).setLabel("Next").setStyle(ButtonStyle.Secondary).setDisabled(page === pages - 1)
      ));
  }
  return container;
}

export async function handleEconomyCommand(interaction: EconomyInteraction) {
  if (!interaction.guildId || !interaction.guild) return false;
  if (interaction.isButton()) {
    if (!interaction.customId.startsWith("economy:shop-page:")) return false;
    const [, , ownerId, rawPage] = interaction.customId.split(":");
    if (ownerId !== interaction.user.id) {
      await interaction.reply({ content: "Open your own shop to browse its pages.", flags: MessageFlags.Ephemeral });
      return true;
    }
    if (!systemsFor(interaction.guildId).length || !enabled(activeConfig(interaction.guildId), "shopEnabled")) {
      await interaction.reply({ content: "The shop is unavailable.", flags: MessageFlags.Ephemeral });
      return true;
    }
    await interaction.update({ components: [shopPage(interaction, Number(rawPage), ownerId)], allowedMentions: { parse: [] } });
    return true;
  }
  if (interaction.isStringSelectMenu()) {
    if (!interaction.customId.startsWith("economy:buy-price:")) return false;
    const [, , ownerId, rawItemId] = interaction.customId.split(":");
    if (ownerId !== interaction.user.id) {
      await interaction.reply({ content: "Only the member who started this purchase can choose its price.", flags: MessageFlags.Ephemeral });
      return true;
    }
    await purchaseItem(interaction, Number(rawItemId), Number(interaction.values[0]));
    return true;
  }
  const isModal = interaction.isModalSubmit();
  if (!isModal && interaction.commandName !== "eco") return false;
  if (isModal && !interaction.customId.startsWith("economy:")) return false;
  if (!systemsFor(interaction.guildId).length) {
    await replyV2(interaction, "Economy unavailable", "Every economy system is currently disabled.", true);
    return true;
  }
  const name = isModal ? interaction.customId.split(":")[1] : interaction.options.getString("action", true);
  if (isModal && interaction.customId.split(":")[2] !== interaction.user.id) return false;
  if (!isModal && ["deposit", "withdraw", "pay", "buy", "use"].includes(name)) {
    if (name === "buy") {
      const available = db.prepare("SELECT 1 FROM economy_shop_items WHERE guild_id=? AND listed=1 AND (expires_at IS NULL OR expires_at>?) AND (unlimited_stock=1 OR stock>0) LIMIT 1").get(interaction.guildId, new Date().toISOString());
      if (!available) {
        await replyV2(interaction, "Shop empty", "There are no available items to buy.", true);
        return true;
      }
    }
    if (name === "use") {
      const available = db.prepare(`SELECT 1 FROM economy_inventory i JOIN economy_shop_items s ON s.id=i.item_id WHERE i.guild_id=? AND i.user_id=? AND i.quantity>0 AND s.usable=1 LIMIT 1`).get(interaction.guildId, interaction.user.id);
      if (!available) {
        await replyV2(interaction, "No usable items", "Your inventory has no items that can be used.", true);
        return true;
      }
    }
    await interaction.showModal(economyModal(name, interaction.user.id, activeConfig(interaction.guildId), interaction.guildId));
    return true;
  }
  const guildId = interaction.guildId;
  const sharedConfig = configFor(guildId);
  const config = activeConfig(guildId);
  const selectedMember = isModal && name === "balance"
    ? interaction.fields.getSelectedUsers("member", false)?.first() ?? null
    : isModal && name === "pay" ? interaction.fields.getSelectedUsers("member", true).first() ?? null : null;
  const submittedAmount = isModal && (name === "deposit" || name === "withdraw" || name === "pay") ? interaction.fields.getTextInputValue("amount") : null;
  const submittedItem = isModal && name === "buy"
    ? Number(interaction.fields.getStringSelectValues("item")[0])
    : isModal && name === "use" ? Number(interaction.fields.getStringSelectValues("item")[0]) : null;
  if (name === "balance") {
    const user = selectedMember ?? interaction.user;
    const wallet = systemsFor(guildId).map(system => {
      const value = accountForSystem(system, user.id, user.username);
      const names = { ...config, ...systemConfig(system) };
      return {
        name: system.name.slice(0, 256),
        value: `${label(names, "wealthName", "Total")}: ${system.currency_symbol} ${(value.cash + value.bank).toLocaleString()}\n${label(names, "cashName", "Cash")}: ${value.cash.toLocaleString()} · ${label(names, "bankName", "Bank")}: ${value.bank.toLocaleString()}`.slice(0, 1024),
        inline: true
      };
    });
    const container = new ContainerBuilder().setAccentColor(0xf45f77)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`${economyEmoji} **${user.username}'s wallet**`))
      .addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    if (wallet.length) {
      for (const currency of wallet) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${currency.name}**\n${currency.value}`));
    } else container.addTextDisplayComponents(new TextDisplayBuilder().setContent("This wallet has no currencies."));
    await interaction.reply({ components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } });
  } else if (name === "daily" || name === "work") await rewardCommand(interaction, name);
  else if (name === "deposit" || name === "withdraw") {
    const value = getAccount(guildId, interaction.user.id, interaction.user.username);
    const source = name === "deposit" ? value.cash : value.bank;
    const rawAmount = submittedAmount;
    if (!rawAmount) return void await replyV2(interaction, "Amount required", `Choose the amount option when using ${name}.`, true);
    const amount = parseAmount(rawAmount, source);
    if (!amount || amount > source) return void await replyV2(interaction, "Invalid amount", "Enter a valid amount that you currently have, or `all`.", true);
    const feeRate = name === "withdraw" ? Math.min(100, Math.max(0, numberSetting(config, "withdrawalFee", 0))) : 0;
    const received = Math.floor(amount * (1 - feeRate / 100));
    const bankName = label(config, "bankName", "Bank");
    const cashName = label(config, "cashName", "Cash");
    if (name === "deposit" && value.bank + amount > settingsFor(guildId).max_bank_balance) return void await replyV2(interaction, `${bankName} limit exceeded`, `That deposit would exceed the maximum ${bankName.toLowerCase()} balance.`, true);
    if (name === "withdraw" && value.cash + received > settingsFor(guildId).max_cash_balance) return void await replyV2(interaction, `${cashName} limit exceeded`, `That withdrawal would exceed the maximum ${cashName.toLowerCase()} balance.`, true);
    if (name === "deposit") { value.cash -= amount; value.bank += amount; } else { value.bank -= amount; value.cash += received; }
    saveAccount(guildId, interaction.user.id, interaction.user.username, value);
    recordTransaction.run(guildId, interaction.user.id, null, name, name === "deposit" ? amount : received, "", Date.now());
    await replyV2(interaction, name === "deposit" ? "Deposit complete" : "Withdrawal complete", `${name === "deposit" ? `Deposited **${money(guildId, amount)}** into ${bankName}` : `Withdrew **${money(guildId, received)}** from ${bankName}`}.`);
  } else if (name === "pay") {
    if (!enabled(config, "paymentsEnabled")) return void await replyV2(interaction, "Payments disabled", "Member payments are disabled.", true);
    const recipient = selectedMember;
    const rawAmount = submittedAmount;
    if (!recipient || !rawAmount) return void await replyV2(interaction, "Details required", "Choose both the member and amount options when using Pay member.", true);
    const amount = Number(rawAmount.replaceAll(",", ""));
    if (!Number.isSafeInteger(amount) || amount <= 0) return void await replyV2(interaction, "Invalid amount", "Enter a whole number greater than zero.", true);
    if (recipient.bot || recipient.id === interaction.user.id) return void await replyV2(interaction, "Invalid recipient", "Choose another non-bot member.", true);
    const minimum = Math.max(1, numberSetting(config, "minimumTransfer", 1));
    if (amount < minimum) return void await replyV2(interaction, "Payment too small", `The minimum payment is ${money(guildId, minimum)}.`, true);
    const paymentCooldown = cooldown(guildId, interaction.user.id, "pay");
    if (paymentCooldown && paymentCooldown.available_at > Date.now()) return void await replyV2(interaction, "Payment cooldown", `You can pay again <t:${Math.ceil(paymentCooldown.available_at / 1000)}:R>.`, true);
    const transferLimit = Math.max(0, numberSetting(config, "transferLimit", 10_000));
    const sentToday = -Number((db.prepare("SELECT COALESCE(SUM(amount),0) AS total FROM economy_transactions WHERE guild_id=? AND user_id=? AND action='pay' AND created_at>=?").get(guildId, interaction.user.id, Date.now() - 86_400_000) as { total: number }).total);
    if (transferLimit && sentToday + amount > transferLimit) return void await replyV2(interaction, "Transfer limit exceeded", `That would exceed your daily transfer limit of ${money(guildId, transferLimit)}.`, true);
    const payer = getAccount(guildId, interaction.user.id, interaction.user.username);
    const receiver = getAccount(guildId, recipient.id, recipient.username);
    const fee = Math.floor(amount * Math.min(100, Math.max(0, numberSetting(config, "transferFee", 0))) / 100);
    const cashName = label(config, "cashName", "Cash");
    if (payer.cash < amount + fee) return void await replyV2(interaction, `Insufficient ${cashName.toLowerCase()}`, `You do not have enough ${cashName.toLowerCase()} for that payment and its fee.`, true);
    if (receiver.cash + amount > settingsFor(guildId).max_cash_balance) return void await replyV2(interaction, "Recipient balance full", `That member cannot hold this much ${cashName.toLowerCase()}.`, true);
    payer.cash -= amount + fee; receiver.cash += amount;
    saveAccount(guildId, interaction.user.id, interaction.user.username, payer); saveAccount(guildId, recipient.id, recipient.username, receiver);
    recordTransaction.run(guildId, interaction.user.id, recipient.id, "pay", -amount - fee, "", Date.now());
    recordTransaction.run(guildId, recipient.id, interaction.user.id, "payment", amount, "", Date.now());
    setCooldown(guildId, interaction.user.id, "pay", Date.now() + Math.max(0, numberSetting(config, "transactionCooldown", 5)) * 1000);
    await replyV2(interaction, "Payment sent", `**${interaction.user.username}** paid **${recipient.username}** ${money(guildId, amount)}${fee ? `\nFee: **${money(guildId, fee)}**` : ""}.`);
    await audit(interaction, "Payment", `**${interaction.user.username}** paid **${recipient.username}** **${money(guildId, amount)}**${fee ? ` with a **${money(guildId, fee)}** fee` : ""}.`, "💸");
  } else if (name === "shop") {
    if (!enabled(config, "shopEnabled")) return void await replyV2(interaction, "Shop unavailable", "The shop is disabled.", true);
    await interaction.reply({ components: [shopPage(interaction)], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } });
  } else if (name === "buy") {
    if (!enabled(config, "shopEnabled")) return void await replyV2(interaction, "Shop unavailable", "The shop is disabled.", true);
    const id = submittedItem;
    if (!id) return void await replyV2(interaction, "Item required", "Choose an item from the shop.", true);
    const item = db.prepare("SELECT * FROM economy_shop_items WHERE guild_id=? AND id=? AND listed=1 AND (expires_at IS NULL OR expires_at>?)").get(guildId, id, new Date().toISOString()) as ShopItem | undefined;
    if (!item || (!item.unlimited_stock && item.stock < 1)) return void await replyV2(interaction, "Item unavailable", "That item is unavailable.", true);
    const requirements = JSON.parse(item.requirements_json || "[]") as Array<{ type?: string; roleId?: string; value?: string; event?: string }>;
    const member = interaction.member as GuildMember;
    const requiredRoles = requirements.filter(r => (!r.event || r.event === "buy" || r.event === "both") && r.type === "role").map(r => r.roleId || r.value).filter(Boolean) as string[];
    if (requiredRoles.some(role => !member.roles.cache.has(role))) return void await replyV2(interaction, "Requirements not met", "You do not meet this item's role requirements.", true);
    const groups = priceGroups(pricesFor(item.id));
    if (!groups.length) return void await replyV2(interaction, "Item unavailable", "That item has no available price.", true);
    if (groups.length === 1) {
      await purchaseItem(interaction, item.id, 0);
      return true;
    }
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`economy:buy-price:${interaction.user.id}:${item.id}`)
      .setPlaceholder("Choose how to pay")
      .addOptions(groups.slice(0, 25).map((group, index) => {
        const emoji = selectEmoji(group[0].currency_symbol);
        return {
          label: group.map(price => `${priceCurrencyName(price)}: ${price.amount.toLocaleString()}`).join(" + ").slice(0, 100),
          description: group.length > 1 ? `Requires all ${group.length} currencies` : group[0].name.slice(0, 100),
          value: String(index),
          ...(emoji ? { emoji } : {})
        };
      }));
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
    const priceSummary = groups.map(group => `- ${group.map(price => `${price.currency_symbol} **${price.amount.toLocaleString()} ${priceCurrencyName(price)}**`).join(" + ")}`).join("\n");
    const container = new ContainerBuilder()
      .setAccentColor(0xf45f77)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${itemIcon(item.emoji_id, interaction)} ${item.name}**`.slice(0, 4000)))
      .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`${item.description || "No description"}\n\n**Available prices**\n${priceSummary}\n\nChoose how you want to pay.`.slice(0, 4000)))
      .addActionRowComponents(row);
    await interaction.reply({ components: [container], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  } else if (name === "inventory") {
    const items = db.prepare(`SELECT s.id,s.name,s.description,s.emoji_id,i.quantity FROM economy_inventory i JOIN economy_shop_items s ON s.id=i.item_id WHERE i.guild_id=? AND i.user_id=? AND i.quantity>0 ORDER BY s.name`).all(guildId, interaction.user.id) as Array<{ id: number; name: string; description: string; emoji_id: string | null; quantity: number }>;
    const inventoryName = label(sharedConfig, "inventoryName", "Your inventory");
    await replyV2(interaction, inventoryName, items.length ? items.map(item => `**${item.quantity} - ${itemIcon(item.emoji_id, interaction)} ${item.name}**\n${item.description || "No description"}`.replace("-  ", "- ")).join("\n\n") : `${inventoryName} is empty.`, true, true);
  } else if (name === "use") {
    const id = submittedItem;
    if (!id) return void await replyV2(interaction, "Item required", "Choose an item from your inventory.", true);
    const item = db.prepare(`SELECT s.* FROM economy_inventory i JOIN economy_shop_items s ON s.id=i.item_id WHERE i.guild_id=? AND i.user_id=? AND i.item_id=? AND i.quantity>0 AND s.usable=1`).get(guildId, interaction.user.id, id) as ShopItem | undefined;
    if (!item) return void await replyV2(interaction, "Item unavailable", "You do not have a usable copy of that item.", true);
    const requirements = JSON.parse(item.requirements_json || "[]") as Array<{ type?: string; roleId?: string; value?: string; event?: string }>;
    const member = interaction.member as GuildMember;
    const requiredRoles = requirements.filter(r => (!r.event || r.event === "use" || r.event === "both") && r.type === "role").map(r => r.roleId || r.value).filter(Boolean) as string[];
    if (requiredRoles.some(role => !member.roles.cache.has(role))) return void await replyV2(interaction, "Requirements not met", "You do not meet this item's role requirements.", true);
    const actions = JSON.parse(item.actions_json || "[]") as Array<{ type?: string; value?: string; event?: string }>;
    for (const action of actions.filter(a => !a.event || a.event === "use" || a.event === "both")) {
      if (action.type === "role" && action.value) await member.roles.add(action.value).catch(console.error);
      if (action.type === "message" && action.value && interaction.channel?.isSendable()) await interaction.channel.send({ content: action.value.slice(0, 2000), allowedMentions: { parse: [] } }).catch(console.error);
    }
    db.prepare("UPDATE economy_inventory SET quantity=quantity-1 WHERE guild_id=? AND user_id=? AND item_id=? AND quantity>0").run(guildId, interaction.user.id, id);
    recordTransaction.run(guildId, interaction.user.id, null, "use", 0, item.name, Date.now());
    await replyV2(interaction, "Item used", `You used **${item.name}**.`, true);
  } else if (name === "leaderboard") {
    if (!enabled(config, "leaderboardEnabled")) return void await replyV2(interaction, "Leaderboard hidden", "The economy leaderboard is hidden.", true);
    const rows = db.prepare("SELECT user_id,username,cash,bank,cash+bank AS total FROM economy_accounts WHERE guild_id=? ORDER BY total DESC LIMIT 10").all(guildId) as Array<{ user_id: string; username: string | null; cash: number; bank: number; total: number }>;
    await replyV2(interaction, label(sharedConfig, "leaderboardName", "Richest members"), rows.length ? rows.map((row, index) => `**${index + 1}.** ${row.username || `User ${row.user_id}`} — ${money(guildId, row.total)}`).join("\n") : "No economy accounts exist yet.");
  }
  return true;
}
