import crypto from "node:crypto";
import path from "node:path";
import express, { NextFunction, Request, Response } from "express";
import cookieSession from "cookie-session";
import helmet from "helmet";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { bot } from "./bot.js";
import { config } from "./config.js";
import { db, ensureDefaultEconomySystem, ensureDefaultSystem, settingsFor, xpForLevel } from "./db.js";
import "./types.js";

import { moderationSettings, moderationCases, validateWarningRules } from "./moderation.js";

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(cookieSession({ name: "crazyland", keys: [config.sessionSecret], httpOnly: true, sameSite: "lax", secure: config.redirectUri.startsWith("https://"), maxAge: 7 * 864e5 }));
app.use(express.static("public"));
app.get("/assets/emoji-data.json", (_req, res) => res.sendFile(path.resolve("node_modules/@emoji-mart/data/sets/15/native.json")));
app.use("/assets/emoji-twitter", express.static(path.resolve("node_modules/emoji-datasource-twitter/img/twitter/64"), { immutable: true, maxAge: "30d" }));

const requireUser = (req: Request, res: Response, next: NextFunction) => req.session?.user ? next() : res.status(401).json({ error: "Sign in required" });
const isSingleUnicodeEmoji = (value: string) => {
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)];
  return graphemes.length === 1 && /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(value);
};
const api = async (url: string, token: string, retry = true): Promise<unknown> => {
  const response = await fetch(`https://discord.com/api/v10${url}`, { headers: { Authorization: `Bearer ${token}` } });
  if (response.status === 429 && retry) {
    const body = await response.json().catch(() => ({})) as { retry_after?: number };
    const waitMs = Math.min(10_000, Math.max(250, Math.ceil((body.retry_after ?? 1) * 1000)));
    await new Promise(resolve => setTimeout(resolve, waitMs));
    return api(url, token, false);
  }
  if (!response.ok) throw new Error(`Discord API returned ${response.status}`);
  return response.json();
};

type DiscordGuild = { id: string; name: string; icon: string | null; permissions: string };
const guildCache = new Map<string, { expiresAt: number; value: Promise<DiscordGuild[]> }>();
const leaderboardProfileCache = new Map<string, { expiresAt: number; value: Promise<import("discord.js").User | null> }>();
function userGuilds(userId: string, token: string) {
  const cached = guildCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = api("/users/@me/guilds", token).then(result => result as DiscordGuild[]).catch(error => {
    guildCache.delete(userId);
    throw error;
  });
  guildCache.set(userId, { expiresAt: Date.now() + 60_000, value });
  return value;
}

function leaderboardProfile(userId: string) {
  const cached = leaderboardProfileCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = bot.users.fetch(userId, { force: true }).catch(() => null);
  leaderboardProfileCache.set(userId, { expiresAt: Date.now() + 5 * 60_000, value });
  return value;
}

app.get("/auth/discord", (req, res) => {
  const state = crypto.randomBytes(24).toString("hex");
  req.session!.oauthState = state;
  const query = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: "code", scope: "identify guilds", state });
  res.redirect(`https://discord.com/oauth2/authorize?${query}`);
});

app.get("/auth/discord/callback", async (req, res) => {
  if (!req.query.code || req.query.state !== req.session?.oauthState) return res.status(400).send("Invalid OAuth state");
  const body = new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, grant_type: "authorization_code", code: String(req.query.code), redirect_uri: config.redirectUri });
  const tokenResponse = await fetch("https://discord.com/api/v10/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!tokenResponse.ok) return res.status(502).send("Discord sign-in failed");
  const token = await tokenResponse.json() as { access_token: string };
  const user = await api("/users/@me", token.access_token) as { id: string; username: string; avatar: string | null };
  req.session!.user = { ...user, accessToken: token.access_token };
  delete req.session!.oauthState;
  res.redirect("/dashboard.html");
});

app.post("/auth/logout", (req, res) => { if (req.session?.user) guildCache.delete(req.session.user.id); req.session = null; res.status(204).end(); });
app.get("/api/meta", (_req, res) => res.json({ clientId: config.clientId }));
app.get("/api/me", requireUser, (req, res) => res.json({ id: req.session!.user!.id, username: req.session!.user!.username, avatar: req.session!.user!.avatar }));

app.get("/api/guilds", requireUser, async (req, res) => {
  const user = req.session!.user!;
  const guilds = await userGuilds(user.id, user.accessToken);
  const manageable = guilds.filter(g => (BigInt(g.permissions) & PermissionFlagsBits.ManageGuild) === PermissionFlagsBits.ManageGuild);
  res.json(manageable.map(g => ({ ...g, installed: bot.guilds.cache.has(g.id) })));
});

function canManage(req: Request, res: Response, next: NextFunction) {
  const guild = bot.guilds.cache.get(String(req.params.guildId));
  if (!guild) return res.status(404).json({ error: "Bot is not in this server" });
  const user = req.session!.user!;
  userGuilds(user.id, user.accessToken).then(guilds => {
    const match = guilds.find(g => g.id === guild.id);
    if (!match || (BigInt(match.permissions) & PermissionFlagsBits.ManageGuild) !== PermissionFlagsBits.ManageGuild) return res.status(403).json({ error: "Manage Server permission required" });
    next();
  }).catch(next);
}

app.get("/api/guilds/:guildId/moderation", requireUser, canManage, (req, res) => {
  const guildId = String(req.params.guildId);
  res.json({ settings: moderationSettings(guildId), cases: moderationCases(guildId) });
});
app.put("/api/guilds/:guildId/moderation", requireUser, canManage, async (req, res, next) => {
  try {
    const guild = bot.guilds.cache.get(String(req.params.guildId))!;
    const channelId = String(req.body.logChannelId || "");
    const current = moderationSettings(guild.id);
    const adminRoleId = String(req.body.adminRoleId ?? current.admin_role_id ?? "");
    const moderatorRoleId = String(req.body.moderatorRoleId ?? current.moderator_role_id ?? "");
    for (const id of [adminRoleId, moderatorRoleId]) {
      if (!id) continue;
      const role = guild.roles.cache.get(id);
      if (!role || role.id === guild.id || role.managed) return res.status(400).json({ error: "Choose an available server role" });
    }
    let rules;
    try { rules = validateWarningRules(req.body.warningRules ?? JSON.parse(moderationSettings(guild.id).warning_rules || "[]")); }
    catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : "Invalid warning rules" }); }
    if (typeof req.body.enabled !== "boolean") return res.status(400).json({ error: "Enabled must be a boolean" });
    if (channelId) {
      const channel = await guild.channels.fetch(channelId).catch(() => null);
      const me = await guild.members.fetchMe();
      if (!channel?.isSendable() || !("permissionsFor" in channel) || !channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) return res.status(400).json({ error: "Choose a channel the bot can view and send messages in" });
    }
    moderationSettings(guild.id);
    db.prepare("UPDATE moderation_settings SET enabled=?,log_channel_id=?,warning_rules=?,admin_role_id=?,moderator_role_id=? WHERE guild_id=?").run(req.body.enabled ? 1 : 0, channelId || null, JSON.stringify(rules), adminRoleId || null, moderatorRoleId || null, guild.id);
    res.json({ settings: moderationSettings(guild.id), cases: moderationCases(guild.id) });
  } catch (error) { next(error); }
});

app.get("/api/guilds/:guildId/settings", requireUser, canManage, (req, res) => {
  const guild = bot.guilds.cache.get(String(req.params.guildId))!;
  ensureDefaultSystem(guild.id);
  const systems = db.prepare("SELECT * FROM leveling_systems WHERE guild_id = ? ORDER BY id").all(guild.id) as Array<Record<string, unknown> & { id: number }>;
  const detailedSystems = systems.map(system => ({
    ...system,
    content_type: system.content_filter || system.content_type,
    rewards: db.prepare("SELECT level, role_id FROM system_roles WHERE system_id = ? ORDER BY level").all(system.id),
    channelRules: db.prepare("SELECT channel_id, mode FROM system_channels WHERE system_id = ?").all(system.id),
    roleRules: db.prepare("SELECT role_id, mode FROM system_role_filters WHERE system_id = ?").all(system.id)
  }));
  const channels = guild.channels.cache.filter(c => c.isTextBased() && !c.isThread()).map(c => ({ id: c.id, name: c.name }));
  const ruleChannels = guild.channels.cache
    .filter(channel => channel.type === ChannelType.GuildCategory || (channel.isTextBased() && !channel.isThread()))
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .map(channel => ({ id: channel.id, name: channel.name, category: channel.type === ChannelType.GuildCategory, parentId: "parentId" in channel ? channel.parentId : null }));
  const roles = guild.roles.cache.filter(r => !r.managed && r.id !== guild.id).sort((a, b) => b.position - a.position).map(r => ({ id: r.id, name: r.name, color: r.hexColor }));
  const emojis = guild.emojis.cache.map(emoji => ({ id: emoji.id, name: emoji.name, animated: emoji.animated, url: emoji.imageURL() }));
  const guildSettings = settingsFor(guild.id);
  ensureDefaultEconomySystem(guild.id);
  let economyConfig: Record<string, unknown> = {};
  try { economyConfig = JSON.parse(guildSettings.economy_config || "{}"); } catch {}
  const economySharedNames = Object.fromEntries(["shopName", "inventoryName", "leaderboardName"].filter(key => economyConfig[key] !== undefined).map(key => [key, economyConfig[key]]));
  const economySystems = db.prepare("SELECT * FROM economy_systems WHERE guild_id=? AND deleted=0 ORDER BY id").all(guild.id) as Array<any>;
  const economy = { systemId: economySystems[0]?.id, currencySymbol: guildSettings.currency_symbol, startingBalance: guildSettings.starting_balance, maxCashBalance: guildSettings.max_cash_balance, maxBankBalance: guildSettings.max_bank_balance, moneyAuditChannelId: guildSettings.money_audit_channel_id, config: economyConfig };
  const shopItems = (db.prepare("SELECT * FROM economy_shop_items WHERE guild_id=? ORDER BY id DESC").all(guild.id) as Array<any>).map(item => ({
    ...item,
    prices: db.prepare(`SELECT p.id,p.system_id AS systemId,p.amount,p.join_operator AS operator,s.name,s.currency_symbol AS currencySymbol,s.enabled AS systemEnabled,s.deleted AS systemDeleted
      FROM economy_shop_prices p JOIN economy_systems s ON s.id=p.system_id WHERE p.item_id=? ORDER BY p.id`).all(item.id)
  }));
  res.json({ systems: detailedSystems, economySystems: economySystems.map(system => ({ ...system, config: JSON.parse(system.config_json || "{}") })), economySharedNames, channels, ruleChannels, roles, emojis, economy, shopItems, memberCount: guild.memberCount });
});

app.put("/api/guilds/:guildId/economy", requireUser, canManage, (req, res) => {
  const guildId = String(req.params.guildId);
  const guild = bot.guilds.cache.get(guildId)!;
  const applicationEmojis = new Map([["1553368966850813963", "crazygears"], ["1553368950082113536", "alonecrazygears"]]);
  const submittedSymbol = String(req.body?.currencySymbol || "").trim();
  const submittedId = String(req.body?.emojiId || "") || submittedSymbol.match(/^<a?:[^:]+:(\d+)>$/)?.[1] || "";
  const emoji = submittedId ? guild.emojis.cache.get(submittedId) : null;
  const applicationEmojiName = applicationEmojis.get(submittedId);
  const currencySymbol = emoji ? `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>` : applicationEmojiName ? `<:${applicationEmojiName}:${submittedId}>` : isSingleUnicodeEmoji(submittedSymbol) ? submittedSymbol : "";
  if (!currencySymbol) return res.status(400).json({ error: "Choose a standard, server, or global application emoji" });
  const safeAmount = (value: unknown, fallback: number) => { const amount = Math.floor(Number(value)); return Number.isFinite(amount) ? Math.max(0, Math.min(9_000_000_000_000_000, amount)) : fallback; };
  const startingBalance = safeAmount(req.body?.startingBalance, 0);
  const maxCashBalance = safeAmount(req.body?.maxCashBalance, 1_000_000);
  const maxBankBalance = safeAmount(req.body?.maxBankBalance, 1_000_000);
  const requestedAuditChannel = String(req.body?.moneyAuditChannelId || "");
  const moneyAuditChannelId = guild.channels.cache.has(requestedAuditChannel) && guild.channels.cache.get(requestedAuditChannel)?.isTextBased() ? requestedAuditChannel : null;
  const rawConfig = req.body?.config && typeof req.body.config === "object" && !Array.isArray(req.body.config) ? req.body.config : {};
  const economyConfig = JSON.stringify(Object.fromEntries(Object.entries(rawConfig).slice(0, 100).map(([key, value]) => [key.slice(0, 64), Array.isArray(value) ? value.map(String).slice(0, 100) : typeof value === "boolean" ? value : String(value).slice(0, 500)])));
  settingsFor(guildId);
  db.prepare("UPDATE guild_settings SET currency_symbol=?, starting_balance=?, max_cash_balance=?, max_bank_balance=?, money_audit_channel_id=?, economy_config=?, updated_at=CURRENT_TIMESTAMP WHERE guild_id=?").run(currencySymbol, startingBalance, maxCashBalance, maxBankBalance, moneyAuditChannelId, economyConfig, guildId);
  const systemId = Number(req.body?.systemId) || ensureDefaultEconomySystem(guildId);
  const system = db.prepare("SELECT id FROM economy_systems WHERE id=? AND guild_id=?").get(systemId, guildId);
  if (system) db.prepare("UPDATE economy_systems SET currency_symbol=?,starting_balance=?,max_cash_balance=?,max_bank_balance=?,config_json=? WHERE id=? AND guild_id=?").run(currencySymbol, startingBalance, maxCashBalance, maxBankBalance, economyConfig, systemId, guildId);
  res.json({ systemId, currencySymbol, startingBalance, maxCashBalance, maxBankBalance, moneyAuditChannelId, config: JSON.parse(economyConfig) });
});

app.post("/api/guilds/:guildId/economy/shop-items", requireUser, canManage, (req, res) => {
  const guildId = String(req.params.guildId), guild = bot.guilds.cache.get(guildId)!, body = req.body || {};
  const name = String(body.name || "").trim().slice(0, 100);
  if (name.length < 3) return res.status(400).json({ error: "Item name must be at least 3 characters" });
  const price = Math.max(0, Math.min(9_000_000_000_000_000, Math.floor(Number(body.price) || 0)));
  const allowedApplicationEmojis = new Set(["1553368966850813963", "1553368950082113536"]);
  const submittedEmoji = String(body.emojiId || "");
  const emojiId = guild.emojis.cache.has(submittedEmoji) || allowedApplicationEmojis.has(submittedEmoji) || isSingleUnicodeEmoji(submittedEmoji) ? submittedEmoji : null;
  const result = db.prepare(`INSERT INTO economy_shop_items (guild_id,name,price,category,description,emoji_id,unlimited_stock,stock,listed,inventory_item,usable,sellable,expires_at,requirements_json,actions_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(guildId, name, price, String(body.category || "").slice(0, 50), String(body.description || "").slice(0, 1000), emojiId, body.unlimitedStock ? 1 : 0, Math.max(0, Math.floor(Number(body.stock) || 0)), body.listed ? 1 : 0, body.inventoryItem ? 1 : 0, body.usable ? 1 : 0, body.sellable ? 1 : 0, body.expiresAt ? String(body.expiresAt) : null, JSON.stringify(Array.isArray(body.requirements) ? body.requirements.slice(0, 3) : []), JSON.stringify(Array.isArray(body.actions) ? body.actions.slice(0, 3) : []));
  const itemId = Number(result.lastInsertRowid);
  const validSystems = new Set((db.prepare("SELECT id FROM economy_systems WHERE guild_id=? AND deleted=0").all(guildId) as Array<{ id: number }>).map(system => system.id));
  const submittedPrices = Array.isArray(body.prices) ? body.prices : [];
  const prices = submittedPrices.map((entry: any, index: number) => ({ systemId: Number(entry.systemId), amount: Math.max(0, Math.min(9_000_000_000_000_000, Math.floor(Number(entry.amount) || 0))), operator: index > 0 && String(entry.operator).toLowerCase() === "and" ? "and" : "or" })).filter((entry: any) => validSystems.has(entry.systemId)).slice(0, 20) as Array<{ systemId: number; amount: number; operator: "and" | "or" }>;
  if (new Set(prices.map(entry => entry.systemId)).size !== prices.length) return res.status(400).json({ error: "An economy system cannot be used more than once in the same price" });
  const fallbackSystemId = ensureDefaultEconomySystem(guildId);
  for (const entry of prices.length ? prices : [{ systemId: fallbackSystemId, amount: price, operator: "or" }]) db.prepare("INSERT INTO economy_shop_prices (item_id,system_id,amount,join_operator) VALUES (?,?,?,?)").run(itemId, entry.systemId, entry.amount, entry.operator);
  const item = db.prepare("SELECT * FROM economy_shop_items WHERE id=? AND guild_id=?").get(itemId, guildId) as any;
  item.prices = db.prepare(`SELECT p.id,p.system_id AS systemId,p.amount,p.join_operator AS operator,s.name,s.currency_symbol AS currencySymbol,s.enabled AS systemEnabled,s.deleted AS systemDeleted FROM economy_shop_prices p JOIN economy_systems s ON s.id=p.system_id WHERE p.item_id=? ORDER BY p.id`).all(itemId);
  res.status(201).json(item);
});

app.post("/api/guilds/:guildId/economy/systems", requireUser, canManage, (req, res) => {
  const guildId = String(req.params.guildId);
  ensureDefaultEconomySystem(guildId);
  const count = Number((db.prepare("SELECT COUNT(*) AS count FROM economy_systems WHERE guild_id=? AND deleted=0").get(guildId) as { count: number }).count);
  if (count >= 10) return res.status(400).json({ error: "A server can have up to 10 economy systems" });
  const name = String(req.body?.name || `Currency ${count + 1}`).trim().slice(0, 50) || `Currency ${count + 1}`;
  const result = db.prepare("INSERT INTO economy_systems (guild_id,name) VALUES (?,?)").run(guildId, name);
  const system = db.prepare("SELECT * FROM economy_systems WHERE id=?").get(Number(result.lastInsertRowid));
  res.status(201).json(system);
});

app.delete("/api/guilds/:guildId/economy/systems/:systemId", requireUser, canManage, (req, res) => {
  const guildId = String(req.params.guildId);
  const count = Number((db.prepare("SELECT COUNT(*) AS count FROM economy_systems WHERE guild_id=? AND deleted=0").get(guildId) as { count: number }).count);
  if (count <= 1) return res.status(400).json({ error: "At least one currency is required" });
  const systemId = Number(req.params.systemId);
  const deletedSystem = db.prepare("SELECT name FROM economy_systems WHERE id=? AND guild_id=?").get(systemId, guildId) as { name: string } | undefined;
  db.prepare(`UPDATE economy_shop_items SET listed=0,deactivation_reason=? WHERE guild_id=? AND id IN (SELECT item_id FROM economy_shop_prices WHERE system_id=?)`).run(`The connected economy system “${deletedSystem?.name || "Unknown system"}” was deleted.`, guildId, systemId);
  db.prepare("UPDATE economy_systems SET enabled=0,deleted=1 WHERE id=? AND guild_id=?").run(systemId, guildId);
  res.status(204).end();
});

app.patch("/api/guilds/:guildId/economy/systems/:systemId", requireUser, canManage, (req, res) => {
  const guildId = String(req.params.guildId), systemId = Number(req.params.systemId);
  const existing = db.prepare("SELECT * FROM economy_systems WHERE id=? AND guild_id=? AND deleted=0").get(systemId, guildId);
  if (!existing) return res.status(404).json({ error: "Economy system not found" });
  const name = String(req.body?.name || "").trim().slice(0, 50);
  if (!name) return res.status(400).json({ error: "System name is required" });
  const enabled = req.body?.enabled === false ? 0 : 1;
  const affectedItems = enabled ? [] : (db.prepare("SELECT item_id FROM economy_shop_prices WHERE system_id=?").all(systemId) as Array<{ item_id: number }>).map(row => row.item_id);
  if (!enabled) db.prepare(`UPDATE economy_shop_items SET listed=0,deactivation_reason=? WHERE guild_id=? AND id IN (SELECT item_id FROM economy_shop_prices WHERE system_id=?)`).run(`The connected economy system “${(existing as any).name}” is disabled.`, guildId, systemId);
  db.prepare("UPDATE economy_systems SET name=?,enabled=? WHERE id=? AND guild_id=?").run(name, enabled, systemId, guildId);
  res.json({ ...(db.prepare("SELECT * FROM economy_systems WHERE id=?").get(systemId) as object), deactivatedShopItemIds: affectedItems });
});

app.post("/api/guilds/:guildId/economy/systems/:systemId/apply-template", requireUser, canManage, (req, res) => {
  const guildId = String(req.params.guildId), targetId = Number(req.params.systemId), sourceId = Number(req.body?.sourceSystemId);
  if (!sourceId || sourceId === targetId) return res.status(400).json({ error: "Choose a different economy system" });
  const source = db.prepare("SELECT * FROM economy_systems WHERE id=? AND guild_id=? AND deleted=0").get(sourceId, guildId) as any;
  const target = db.prepare("SELECT id FROM economy_systems WHERE id=? AND guild_id=? AND deleted=0").get(targetId, guildId);
  if (!source || !target) return res.status(404).json({ error: "Economy system not found" });
  if (!source.enabled) db.prepare(`UPDATE economy_shop_items SET listed=0,deactivation_reason=? WHERE guild_id=? AND id IN (SELECT item_id FROM economy_shop_prices WHERE system_id=?)`).run(`The connected economy system is disabled.`, guildId, targetId);
  db.prepare(`UPDATE economy_systems SET currency_symbol=?,starting_balance=?,max_cash_balance=?,max_bank_balance=?,config_json=?,enabled=? WHERE id=? AND guild_id=?`)
    .run(source.currency_symbol, source.starting_balance, source.max_cash_balance, source.max_bank_balance, source.config_json, source.enabled, targetId, guildId);
  res.json(db.prepare("SELECT * FROM economy_systems WHERE id=?").get(targetId));
});

app.put("/api/guilds/:guildId/economy/shop-items/:itemId", requireUser, canManage, (req, res) => {
  const guildId = String(req.params.guildId), itemId = Number(req.params.itemId), guild = bot.guilds.cache.get(guildId)!, body = req.body || {};
  const existing = db.prepare("SELECT id FROM economy_shop_items WHERE id=? AND guild_id=?").get(itemId, guildId);
  if (!existing) return res.status(404).json({ error: "Shop item not found" });
  const name = String(body.name || "").trim().slice(0, 100);
  if (name.length < 3) return res.status(400).json({ error: "Item name must be at least 3 characters" });
  const systems = db.prepare("SELECT id,enabled FROM economy_systems WHERE guild_id=?").all(guildId) as Array<{ id: number; enabled: number }>;
  const validSystems = new Set(systems.map(system => system.id));
  const prices = (Array.isArray(body.prices) ? body.prices : []).map((entry: any, index: number) => ({ systemId: Number(entry.systemId), amount: Math.max(0, Math.min(9_000_000_000_000_000, Math.floor(Number(entry.amount) || 0))), operator: index > 0 && String(entry.operator).toLowerCase() === "and" ? "and" : "or" })).filter((entry: any) => validSystems.has(entry.systemId)).slice(0, 20) as Array<{ systemId: number; amount: number; operator: "and" | "or" }>;
  if (!prices.length) return res.status(400).json({ error: "Add at least one valid price" });
  if (new Set(prices.map(entry => entry.systemId)).size !== prices.length) return res.status(400).json({ error: "An economy system cannot be used more than once in the same price" });
  const listed = !!body.listed;
  if (listed && prices.some(price => !systems.find(system => system.id === price.systemId)?.enabled)) return res.status(400).json({ error: "Enable every connected economy system before listing this item" });
  const allowedApplicationEmojis = new Set(["1553368966850813963", "1553368950082113536"]);
  const submittedEmoji = String(body.emojiId || "");
  const emojiId = guild.emojis.cache.has(submittedEmoji) || allowedApplicationEmojis.has(submittedEmoji) || isSingleUnicodeEmoji(submittedEmoji) ? submittedEmoji : null;
  db.exec("BEGIN");
  try {
    db.prepare(`UPDATE economy_shop_items SET name=?,price=?,category=?,description=?,emoji_id=?,unlimited_stock=?,stock=?,listed=?,inventory_item=?,usable=?,sellable=?,expires_at=?,requirements_json=?,actions_json=?,deactivation_reason=NULL WHERE id=? AND guild_id=?`).run(name, prices[0].amount, String(body.category || "").slice(0, 50), String(body.description || "").slice(0, 1000), emojiId, body.unlimitedStock ? 1 : 0, Math.max(0, Math.floor(Number(body.stock) || 0)), listed ? 1 : 0, body.inventoryItem ? 1 : 0, body.usable ? 1 : 0, body.sellable ? 1 : 0, body.expiresAt ? String(body.expiresAt) : null, JSON.stringify(Array.isArray(body.requirements) ? body.requirements.slice(0, 3) : []), JSON.stringify(Array.isArray(body.actions) ? body.actions.slice(0, 3) : []), itemId, guildId);
    db.prepare("DELETE FROM economy_shop_prices WHERE item_id=?").run(itemId);
    for (const price of prices) db.prepare("INSERT INTO economy_shop_prices (item_id,system_id,amount,join_operator) VALUES (?,?,?,?)").run(itemId, price.systemId, price.amount, price.operator);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  const item = db.prepare("SELECT * FROM economy_shop_items WHERE id=?").get(itemId) as any;
  item.prices = db.prepare(`SELECT p.id,p.system_id AS systemId,p.amount,p.join_operator AS operator,s.name,s.currency_symbol AS currencySymbol,s.enabled AS systemEnabled,s.deleted AS systemDeleted FROM economy_shop_prices p JOIN economy_systems s ON s.id=p.system_id WHERE p.item_id=? ORDER BY p.id`).all(itemId);
  res.json(item);
});

app.delete("/api/guilds/:guildId/economy/shop-items/:itemId", requireUser, canManage, (req, res) => {
  db.prepare("DELETE FROM economy_shop_items WHERE id=? AND guild_id=?").run(Number(req.params.itemId), String(req.params.guildId));
  res.status(204).end();
});

app.post("/api/guilds/:guildId/systems", requireUser, canManage, (req, res) => {
  const guildId = String(req.params.guildId);
  ensureDefaultSystem(guildId);
  const count = (db.prepare("SELECT COUNT(*) AS count FROM leveling_systems WHERE guild_id = ?").get(guildId) as { count: number }).count;
  if (count >= 10) return res.status(400).json({ error: "A server can have up to 10 leveling systems" });
  const name = String(req.body?.name || `Leveling system ${count + 1}`).trim().slice(0, 50);
  const result = db.prepare("INSERT INTO leveling_systems (guild_id, name) VALUES (?, ?)").run(guildId, name || `Leveling system ${count + 1}`);
  res.status(201).json({ id: Number(result.lastInsertRowid) });
});

app.delete("/api/guilds/:guildId/systems/:systemId", requireUser, canManage, (req, res) => {
  const guildId = String(req.params.guildId);
  const count = (db.prepare("SELECT COUNT(*) AS count FROM leveling_systems WHERE guild_id = ?").get(guildId) as { count: number }).count;
  if (count <= 1) return res.status(400).json({ error: "At least one leveling system is required" });
  db.prepare("DELETE FROM leveling_systems WHERE id = ? AND guild_id = ?").run(Number(req.params.systemId), guildId);
  res.status(204).end();
});

app.post("/api/guilds/:guildId/systems/:systemId/apply-template", requireUser, canManage, (req, res) => {
  const guildId = String(req.params.guildId);
  const targetId = Number(req.params.systemId);
  const sourceId = Number(req.body?.sourceSystemId);
  if (!sourceId || sourceId === targetId) return res.status(400).json({ error: "Choose a different leveling system" });
  const source = db.prepare("SELECT * FROM leveling_systems WHERE id=? AND guild_id=?").get(sourceId, guildId) as any;
  const target = db.prepare("SELECT id FROM leveling_systems WHERE id=? AND guild_id=?").get(targetId, guildId);
  if (!source || !target) return res.status(404).json({ error: "Leveling system not found" });
  db.exec("BEGIN");
  try {
    db.prepare(`UPDATE leveling_systems SET min_xp=?, max_xp=?, min_xp_values=?, max_xp_values=?, specific_words=?, cooldown_seconds=?, content_type=?, content_filter=?, announce_destination=?, announce_channel_id=?, announce_message=? WHERE id=?`)
      .run(source.min_xp, source.max_xp, source.min_xp_values, source.max_xp_values, source.specific_words, source.cooldown_seconds, source.content_type, source.content_filter, source.announce_destination, source.announce_channel_id, source.announce_message, targetId);
    db.prepare("DELETE FROM system_channels WHERE system_id=?").run(targetId);
    db.prepare("INSERT INTO system_channels (system_id, channel_id, mode) SELECT ?, channel_id, mode FROM system_channels WHERE system_id=?").run(targetId, sourceId);
    db.prepare("DELETE FROM system_role_filters WHERE system_id=?").run(targetId);
    db.prepare("INSERT INTO system_role_filters (system_id, role_id, mode) SELECT ?, role_id, mode FROM system_role_filters WHERE system_id=?").run(targetId, sourceId);
    db.prepare("DELETE FROM system_roles WHERE system_id=?").run(targetId);
    db.prepare("INSERT INTO system_roles (system_id, level, role_id) SELECT ?, level, role_id FROM system_roles WHERE system_id=?").run(targetId, sourceId);
    db.exec("COMMIT");
    res.json({ ok: true });
  } catch (error) { db.exec("ROLLBACK"); throw error; }
});

app.put("/api/guilds/:guildId/settings", requireUser, canManage, (req, res) => {
  const b = req.body;
  const guildId = String(req.params.guildId);
  const guild = bot.guilds.cache.get(guildId)!;
  const systemId = Number(b.systemId);
  const ownsSystem = db.prepare("SELECT id FROM leveling_systems WHERE id = ? AND guild_id = ?").get(systemId, guildId);
  if (!ownsSystem) return res.status(404).json({ error: "Leveling system not found" });
  const min = Math.max(1, Math.min(1000, Number(String(b.minXp ?? "15").split(",")[0].trim()) || 15));
  const max = Math.max(min, Math.min(1000, Number(String(b.maxXp ?? "25").split(",")[0].trim()) || 25));
  const cooldown = Math.max(5, Math.min(3600, Number(b.cooldownSeconds)));
  const message = String(b.announceMessage ?? "").slice(0, 500);
  const contentFilters = ["any", "text", "image", "video", "link", "file", "embed", "sound", "poll", "sticker", "forward", "word"];
  const selectedContentFilters = String(b.contentType || "any").split(",").filter(value => contentFilters.includes(value));
  const contentFilter = [...new Set(selectedContentFilters)].join(",") || "any";
  const valueCount = contentFilter.split(",").length;
  const xpText = (value: unknown) => String(value ?? "").split(",").map(item => item.trim()).filter(Boolean).slice(0, valueCount).join(",");
  const minXpText = xpText(b.minXpValues ?? b.minXp), maxXpText = xpText(b.maxXpValues ?? b.maxXp);
  const xpValues = (value: string) => { const values = value.split(",").filter(Boolean).map(item => Math.max(0, Math.min(1000, Math.floor(Number(item)) || 0))); while (values.length < valueCount) values.push(0); return values; };
  const minValues = xpValues(minXpText);
  const maxValues = xpValues(maxXpText).map((value, index) => Math.max(minValues[index], value));
  const legacyContentType = selectedContentFilters.length === 1 && ["any", "text"].includes(selectedContentFilters[0]) ? selectedContentFilters[0] : "any";
  const announceDestination = ["none", "current", "dm", "channel"].includes(b.announceDestination) ? b.announceDestination : "current";
  const specificWords = [...new Set(String(b.specificWords || "").split(",").map(value => value.trim()).filter(Boolean))].slice(0, 50).join(", ").slice(0, 500);
  const name = String(b.name || "Leveling system").trim().slice(0, 50) || "Leveling system";
  const chosenChannel = announceDestination === "channel" && guild.channels.cache.has(String(b.announceChannelId)) ? String(b.announceChannelId) : null;
  db.prepare(`UPDATE leveling_systems SET name=?, enabled=?, min_xp=?, max_xp=?, min_xp_values=?, max_xp_values=?, specific_words=?, cooldown_seconds=?, content_type=?, content_filter=?, announce_destination=?, announce_channel_id=?, announce_message=? WHERE id=? AND guild_id=?`)
    .run(name, b.enabled ? 1 : 0, minValues[0] ?? 0, maxValues[0] ?? 0, minXpText, maxXpText, specificWords, cooldown, legacyContentType, contentFilter, announceDestination, chosenChannel, message, systemId, guildId);
  const replace = (items: any[]) => {
    db.exec("BEGIN");
    try {
    db.prepare("DELETE FROM system_roles WHERE system_id = ?").run(systemId);
    const insert = db.prepare("INSERT INTO system_roles (system_id, level, role_id) VALUES (?, ?, ?)");
    const seen = new Set<number>();
    for (const item of items.slice(0, 50)) {
      const level = Math.floor(Number(item.level));
      const roleId = String(item.roleId);
      if (level > 0 && !seen.has(level) && guild.roles.cache.has(roleId)) {
        insert.run(systemId, level, roleId);
        seen.add(level);
      }
    }
    db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  replace(Array.isArray(b.rewards) ? b.rewards : []);
  const replaceChannelRules = (mode: "allow" | "deny", ids: unknown) => {
    const available = new Set(guild.channels.cache.filter(channel => channel.isTextBased() && !channel.isThread()).map(channel => channel.id));
    const uniqueIds = [...new Set(Array.isArray(ids) ? ids.map(String) : [])].filter(id => available.has(id)).slice(0, 100);
    db.prepare("DELETE FROM system_channels WHERE system_id = ? AND mode = ?").run(systemId, mode);
    const insert = db.prepare("INSERT INTO system_channels (system_id, channel_id, mode) VALUES (?, ?, ?)");
    for (const id of uniqueIds) insert.run(systemId, id, mode);
  };
  db.exec("BEGIN");
  try {
    replaceChannelRules("allow", b.allowedChannelIds);
    replaceChannelRules("deny", b.deniedChannelIds);
    const availableRoles = new Set(guild.roles.cache.filter(role => !role.managed && role.id !== guild.id).map(role => role.id));
    const replaceRoleRules = (mode: "allow" | "deny", ids: unknown) => {
      const uniqueIds = [...new Set(Array.isArray(ids) ? ids.map(String) : [])].filter(id => availableRoles.has(id)).slice(0, 100);
      db.prepare("DELETE FROM system_role_filters WHERE system_id = ? AND mode = ?").run(systemId, mode);
      const insert = db.prepare("INSERT INTO system_role_filters (system_id, role_id, mode) VALUES (?, ?, ?)");
      for (const id of uniqueIds) insert.run(systemId, id, mode);
    };
    replaceRoleRules("allow", b.allowedRoleIds);
    replaceRoleRules("deny", b.deniedRoleIds);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  res.json({ ok: true });
});

app.get("/api/guilds/:guildId/leaderboard", requireUser, canManage, async (req, res) => {
  const guildId = String(req.params.guildId);
  const systemId = Number(req.query.systemId || ensureDefaultSystem(guildId));
  const requestedPage = Math.max(1, Number.parseInt(String(req.query.page ?? "1"), 10) || 1);
  const search = String(req.query.search ?? "").trim().slice(0, 32);
  const pageSize = 10;
  const belongs = db.prepare("SELECT id FROM leveling_systems WHERE id=? AND guild_id=?").get(systemId, guildId);
  if (!belongs) return res.status(404).json({ error: "Leveling system not found" });
  const guild = bot.guilds.cache.get(guildId);
  if (search && guild) {
    const missing = db.prepare("SELECT user_id FROM system_progress WHERE system_id=? AND username IS NULL").all(systemId) as Array<{ user_id: string }>;
    const updateUsername = db.prepare("UPDATE system_progress SET username=? WHERE system_id=? AND user_id=?");
    for (const row of missing) {
      const username = guild.members.cache.get(row.user_id)?.user.username ?? bot.users.cache.get(row.user_id)?.username;
      if (username) updateUsername.run(username, systemId, row.user_id);
    }
  }
  const where = search ? "system_id=? AND username LIKE ? COLLATE NOCASE" : "system_id=?";
  const parameters = search ? [systemId, `%${search}%`] : [systemId];
  const total = Number((db.prepare(`SELECT COUNT(*) AS total FROM system_progress WHERE ${where}`).get(...parameters) as { total: number }).total);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const rows = db.prepare(`SELECT user_id, username, xp, level,
    (SELECT COUNT(*) + 1 FROM system_progress higher WHERE higher.system_id=progress.system_id AND higher.xp>progress.xp) AS rank
    FROM system_progress progress WHERE ${where} ORDER BY xp DESC, user_id ASC LIMIT ? OFFSET ?`)
    .all(...parameters, pageSize, (page - 1) * pageSize) as any[];
  const leaders = await Promise.all(rows.map(async (row, index) => {
    const cachedUser = guild?.members.cache.get(row.user_id)?.user ?? bot.users.cache.get(row.user_id);
    const profileUser = await leaderboardProfile(row.user_id);
    const user = profileUser ?? cachedUser;
    const nameplate = user?.collectibles?.nameplate;
    if (user && row.username !== user.username) db.prepare("UPDATE system_progress SET username=? WHERE system_id=? AND user_id=?").run(user.username, systemId, row.user_id);
    return {
      ...row,
      username: user?.username ?? "Unknown user",
      avatarUrl: user?.displayAvatarURL({ extension: "webp", size: 64 }) ?? null,
      avatarDecorationUrl: user?.avatarDecorationURL({ extension: "webp", size: 64 }) ?? null,
      nameplateUrl: nameplate ? `https://cdn.discordapp.com/assets/collectibles/${nameplate.asset}static.png` : null,
      animatedNameplateUrl: nameplate ? `https://cdn.discordapp.com/assets/collectibles/${nameplate.asset}asset.webm` : null,
      nameplatePalette: nameplate?.palette ?? null,
      bannerColor: user?.accentColor != null ? `#${user.accentColor.toString(16).padStart(6, "0")}` : null,
      rank: Number(row.rank),
      nextLevelXp: xpForLevel(row.level + 1)
    };
  }));
  res.json({ items: leaders, page, totalPages, total });
});

app.get("/api/guilds/:guildId/economy/leaderboard", requireUser, canManage, async (req, res) => {
  const guildId = String(req.params.guildId);
  const guild = bot.guilds.cache.get(guildId)!;
  const metric = ["cash", "bank", "total"].includes(String(req.query.metric)) ? String(req.query.metric) : "total";
  const order = metric === "cash" ? "cash" : metric === "bank" ? "bank" : "cash + bank";
  const search = String(req.query.search || "").trim().slice(0, 32);
  const requestedPage = Math.max(1, Number.parseInt(String(req.query.page || "1"), 10) || 1);
  const pageSize = 10;
  const requestedSystemId = Number(req.query.systemId) || ensureDefaultEconomySystem(guildId);
  const ownedSystem = db.prepare("SELECT id FROM economy_systems WHERE id=? AND guild_id=?").get(requestedSystemId, guildId) as { id: number } | undefined;
  const systemId = ownedSystem?.id ?? ensureDefaultEconomySystem(guildId);
  const where = search ? "system_id=? AND username LIKE ? COLLATE NOCASE" : "system_id=?";
  const parameters = search ? [systemId, `%${search}%`] : [systemId];
  const total = Number((db.prepare(`SELECT COUNT(*) AS total FROM economy_balances WHERE ${where}`).get(...parameters) as { total: number }).total);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const rows = db.prepare(`SELECT user_id, username, cash, bank, cash + bank AS total FROM economy_balances WHERE ${where} ORDER BY ${order} DESC, user_id ASC LIMIT ? OFFSET ?`).all(...parameters, pageSize, (page - 1) * pageSize) as Array<{ user_id: string; username: string | null; cash: number; bank: number; total: number }>;
  const items = await Promise.all(rows.map(async (row, index) => {
    const cachedUser = guild.members.cache.get(row.user_id)?.user ?? bot.users.cache.get(row.user_id);
    const profileUser = await leaderboardProfile(row.user_id);
    const user = profileUser ?? cachedUser;
    const nameplate = user?.collectibles?.nameplate;
    if (user && row.username !== user.username) db.prepare("UPDATE economy_balances SET username=? WHERE system_id=? AND user_id=?").run(user.username, systemId, row.user_id);
    return {
      ...row,
      username: user?.username ?? row.username ?? "Unknown user",
      avatarUrl: user?.displayAvatarURL({ extension: "webp", size: 64 }) ?? null,
      avatarDecorationUrl: user?.avatarDecorationURL({ extension: "webp", size: 64 }) ?? null,
      nameplateUrl: nameplate ? `https://cdn.discordapp.com/assets/collectibles/${nameplate.asset}static.png` : null,
      animatedNameplateUrl: nameplate ? `https://cdn.discordapp.com/assets/collectibles/${nameplate.asset}asset.webm` : null,
      nameplatePalette: nameplate?.palette ?? null,
      bannerColor: user?.accentColor != null ? `#${user.accentColor.toString(16).padStart(6, "0")}` : null,
      rank: (page - 1) * pageSize + index + 1
    };
  }));
  res.json({ items, page, totalPages, total });
});

app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => { console.error(error); res.status(500).json({ error: "Something went wrong" }); });
export const startWeb = () => app.listen(config.port, () => console.log(`Dashboard running at http://localhost:${config.port}`));
