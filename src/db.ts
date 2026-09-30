import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
export const db = new DatabaseSync(config.databasePath);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

db.exec(`
  CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1,
    min_xp INTEGER NOT NULL DEFAULT 15,
    max_xp INTEGER NOT NULL DEFAULT 25,
    cooldown_seconds INTEGER NOT NULL DEFAULT 60,
    announce_channel_id TEXT,
    announce_message TEXT NOT NULL DEFAULT '🎉 {user} reached level **{level}**!',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS members (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    xp INTEGER NOT NULL DEFAULT 0,
    level INTEGER NOT NULL DEFAULT 0,
    last_xp_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS level_roles (
    guild_id TEXT NOT NULL,
    level INTEGER NOT NULL,
    role_id TEXT NOT NULL,
    PRIMARY KEY (guild_id, level)
  );
  CREATE TABLE IF NOT EXISTS xp_channels (
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('allow', 'deny')),
    PRIMARY KEY (guild_id, channel_id, mode)
  );
  CREATE INDEX IF NOT EXISTS members_leaderboard ON members(guild_id, xp DESC);
  CREATE INDEX IF NOT EXISTS xp_channels_guild ON xp_channels(guild_id, mode);
  CREATE TABLE IF NOT EXISTS leveling_systems (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    min_xp INTEGER NOT NULL DEFAULT 15,
    max_xp INTEGER NOT NULL DEFAULT 25,
    cooldown_seconds INTEGER NOT NULL DEFAULT 60,
    content_type TEXT NOT NULL DEFAULT 'any' CHECK(content_type IN ('any', 'text', 'images')),
    announce_destination TEXT NOT NULL DEFAULT 'current' CHECK(announce_destination IN ('none', 'current', 'dm', 'channel')),
    announce_channel_id TEXT,
    announce_message TEXT NOT NULL DEFAULT '🎉 {user} reached level **{level}** in {system}!',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS system_progress (
    system_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    username TEXT,
    xp INTEGER NOT NULL DEFAULT 0,
    level INTEGER NOT NULL DEFAULT 0,
    last_xp_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (system_id, user_id),
    FOREIGN KEY (system_id) REFERENCES leveling_systems(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS xp_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    system_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    xp INTEGER NOT NULL,
    earned_at INTEGER NOT NULL,
    FOREIGN KEY (system_id) REFERENCES leveling_systems(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS system_channels (
    system_id INTEGER NOT NULL,
    channel_id TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('allow', 'deny')),
    PRIMARY KEY (system_id, channel_id, mode),
    FOREIGN KEY (system_id) REFERENCES leveling_systems(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS system_roles (
    system_id INTEGER NOT NULL,
    level INTEGER NOT NULL,
    role_id TEXT NOT NULL,
    PRIMARY KEY (system_id, level),
    FOREIGN KEY (system_id) REFERENCES leveling_systems(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS system_role_filters (
    system_id INTEGER NOT NULL,
    role_id TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('allow', 'deny')),
    PRIMARY KEY (system_id, role_id, mode),
    FOREIGN KEY (system_id) REFERENCES leveling_systems(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS economy_accounts (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    username TEXT,
    cash INTEGER NOT NULL DEFAULT 0,
    bank INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS economy_accounts_leaderboard ON economy_accounts(guild_id, cash DESC, bank DESC);
  CREATE TABLE IF NOT EXISTS economy_systems (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    name TEXT NOT NULL,
    currency_symbol TEXT NOT NULL DEFAULT '<:alonecrazygears:1553368950082113536>',
    starting_balance INTEGER NOT NULL DEFAULT 0,
    max_cash_balance INTEGER NOT NULL DEFAULT 1000000,
    max_bank_balance INTEGER NOT NULL DEFAULT 1000000,
    config_json TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS economy_systems_guild ON economy_systems(guild_id, id);
  CREATE TABLE IF NOT EXISTS economy_balances (
    system_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    username TEXT,
    cash INTEGER NOT NULL DEFAULT 0,
    bank INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (system_id, user_id),
    FOREIGN KEY (system_id) REFERENCES economy_systems(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS economy_balances_leaderboard ON economy_balances(system_id, cash DESC, bank DESC);
  CREATE TABLE IF NOT EXISTS economy_shop_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    name TEXT NOT NULL,
    price INTEGER NOT NULL DEFAULT 0,
    category TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    emoji_id TEXT,
    unlimited_stock INTEGER NOT NULL DEFAULT 1,
    stock INTEGER NOT NULL DEFAULT 0,
    listed INTEGER NOT NULL DEFAULT 1,
    inventory_item INTEGER NOT NULL DEFAULT 1,
    usable INTEGER NOT NULL DEFAULT 1,
    sellable INTEGER NOT NULL DEFAULT 1,
    expires_at TEXT,
    requirements_json TEXT NOT NULL DEFAULT '[]',
    actions_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS economy_shop_items_guild ON economy_shop_items(guild_id, id);
  CREATE TABLE IF NOT EXISTS economy_shop_prices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL,
    system_id INTEGER NOT NULL,
    amount INTEGER NOT NULL DEFAULT 0,
    join_operator TEXT NOT NULL DEFAULT 'or' CHECK(join_operator IN ('and','or')),
    UNIQUE(item_id, system_id),
    FOREIGN KEY (item_id) REFERENCES economy_shop_items(id) ON DELETE CASCADE,
    FOREIGN KEY (system_id) REFERENCES economy_systems(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS economy_cooldowns (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    action TEXT NOT NULL,
    available_at INTEGER NOT NULL DEFAULT 0,
    streak INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id, action)
  );
  CREATE TABLE IF NOT EXISTS economy_inventory (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    item_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id, item_id),
    FOREIGN KEY (item_id) REFERENCES economy_shop_items(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS economy_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    other_user_id TEXT,
    action TEXT NOT NULL,
    amount INTEGER NOT NULL DEFAULT 0,
    details TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS economy_transactions_member ON economy_transactions(guild_id, user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS leveling_systems_guild ON leveling_systems(guild_id);
  CREATE INDEX IF NOT EXISTS system_progress_leaderboard ON system_progress(system_id, xp DESC);
  CREATE INDEX IF NOT EXISTS xp_events_member_time ON xp_events(system_id, user_id, earned_at);
`);

// Store expanded message filters separately so existing constrained databases
// can migrate without rebuilding the leveling systems table.
const levelingColumns = db.prepare("PRAGMA table_info(leveling_systems)").all() as Array<{ name: string }>;
if (!levelingColumns.some(column => column.name === "content_filter")) {
  db.exec("ALTER TABLE leveling_systems ADD COLUMN content_filter TEXT NOT NULL DEFAULT 'any'");
  db.exec("UPDATE leveling_systems SET content_filter = content_type");
}
if (!levelingColumns.some(column => column.name === "min_xp_values")) {
  db.exec("ALTER TABLE leveling_systems ADD COLUMN min_xp_values TEXT NOT NULL DEFAULT ''");
}
if (!levelingColumns.some(column => column.name === "max_xp_values")) {
  db.exec("ALTER TABLE leveling_systems ADD COLUMN max_xp_values TEXT NOT NULL DEFAULT ''");
}
if (!levelingColumns.some(column => column.name === "specific_words")) {
  db.exec("ALTER TABLE leveling_systems ADD COLUMN specific_words TEXT NOT NULL DEFAULT ''");
}
db.exec(`UPDATE leveling_systems SET content_filter = CASE content_filter
  WHEN 'images' THEN 'image'
  WHEN 'attachments' THEN 'file'
  WHEN 'links' THEN 'link'
  WHEN 'videos' THEN 'video'
  WHEN 'audio' THEN 'sound'
  ELSE content_filter END`);

const systemColumns = db.prepare("PRAGMA table_info(leveling_systems)").all() as Array<{ name: string }>;
if (!systemColumns.some(column => column.name === "announce_destination")) {
  db.exec("ALTER TABLE leveling_systems ADD COLUMN announce_destination TEXT NOT NULL DEFAULT 'current'");
}

const guildSettingColumns = db.prepare("PRAGMA table_info(guild_settings)").all() as Array<{ name: string }>;
if (!guildSettingColumns.some(column => column.name === "currency_symbol")) {
  db.exec("ALTER TABLE guild_settings ADD COLUMN currency_symbol TEXT NOT NULL DEFAULT '<:alonecrazygears:1553368950082113536>'");
}
if (!guildSettingColumns.some(column => column.name === "starting_balance")) {
  db.exec("ALTER TABLE guild_settings ADD COLUMN starting_balance INTEGER NOT NULL DEFAULT 0");
}
if (!guildSettingColumns.some(column => column.name === "max_cash_balance")) {
  db.exec("ALTER TABLE guild_settings ADD COLUMN max_cash_balance INTEGER NOT NULL DEFAULT 1000000");
}
if (!guildSettingColumns.some(column => column.name === "max_bank_balance")) {
  db.exec("ALTER TABLE guild_settings ADD COLUMN max_bank_balance INTEGER NOT NULL DEFAULT 1000000");
}
if (!guildSettingColumns.some(column => column.name === "money_audit_channel_id")) {
  db.exec("ALTER TABLE guild_settings ADD COLUMN money_audit_channel_id TEXT");
}
if (!guildSettingColumns.some(column => column.name === "economy_config")) {
  db.exec("ALTER TABLE guild_settings ADD COLUMN economy_config TEXT NOT NULL DEFAULT '{}'");
}

db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
const currencyEmojiMigration = "economy_application_currency_1553368950082113536";
if (!db.prepare("SELECT 1 FROM schema_migrations WHERE name=?").get(currencyEmojiMigration)) {
  db.prepare("UPDATE guild_settings SET currency_symbol=? WHERE currency_symbol IN ('$','<:currency:1553366127688556544>','<:currency:1553368248681242715>')").run("<:alonecrazygears:1553368950082113536>");
  db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(currencyEmojiMigration);
}

const progressColumns = db.prepare("PRAGMA table_info(system_progress)").all() as Array<{ name: string }>;
if (!progressColumns.some(column => column.name === "username")) {
  db.exec("ALTER TABLE system_progress ADD COLUMN username TEXT");
}

const shopPriceColumns = db.prepare("PRAGMA table_info(economy_shop_prices)").all() as Array<{ name: string }>;
if (!shopPriceColumns.some(column => column.name === "join_operator")) {
  db.exec("ALTER TABLE economy_shop_prices ADD COLUMN join_operator TEXT NOT NULL DEFAULT 'or'");
}

const shopItemColumns = db.prepare("PRAGMA table_info(economy_shop_items)").all() as Array<{ name: string }>;
if (!shopItemColumns.some(column => column.name === "deactivation_reason")) {
  db.exec("ALTER TABLE economy_shop_items ADD COLUMN deactivation_reason TEXT");
}

const economySystemColumns = db.prepare("PRAGMA table_info(economy_systems)").all() as Array<{ name: string }>;
if (!economySystemColumns.some(column => column.name === "deleted")) {
  db.exec("ALTER TABLE economy_systems ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0");
}

export type GuildSettings = {
  guild_id: string; enabled: number; min_xp: number; max_xp: number;
  cooldown_seconds: number; announce_channel_id: string | null; announce_message: string; currency_symbol: string;
  starting_balance: number; max_cash_balance: number; max_bank_balance: number; money_audit_channel_id: string | null;
  economy_config: string;
};

export function settingsFor(guildId: string): GuildSettings {
  db.prepare("INSERT OR IGNORE INTO guild_settings (guild_id) VALUES (?)").run(guildId);
  return db.prepare("SELECT * FROM guild_settings WHERE guild_id = ?").get(guildId) as GuildSettings;
}

export function levelFromXp(xp: number) {
  return Math.floor(Math.sqrt(xp / 100));
}

export function xpForLevel(level: number) {
  return level * level * 100;
}

export function ensureDefaultSystem(guildId: string): number {
  const existing = db.prepare("SELECT id FROM leveling_systems WHERE guild_id = ? ORDER BY id LIMIT 1").get(guildId) as { id: number } | undefined;
  if (existing) return existing.id;
  const old = settingsFor(guildId);
  db.exec("BEGIN");
  try {
    const created = db.prepare(`INSERT INTO leveling_systems (guild_id, name, enabled, min_xp, max_xp, cooldown_seconds, announce_channel_id, announce_message) VALUES (?, 'Main leveling', ?, ?, ?, ?, ?, ?)`)
      .run(guildId, old.enabled, old.min_xp, old.max_xp, old.cooldown_seconds, old.announce_channel_id, old.announce_message);
    const id = Number(created.lastInsertRowid);
    db.prepare("INSERT INTO system_progress (system_id, user_id, xp, level, last_xp_at) SELECT ?, user_id, xp, level, last_xp_at FROM members WHERE guild_id = ?").run(id, guildId);
    db.prepare("INSERT INTO system_roles (system_id, level, role_id) SELECT ?, level, role_id FROM level_roles WHERE guild_id = ?").run(id, guildId);
    db.prepare("INSERT INTO system_channels (system_id, channel_id, mode) SELECT ?, channel_id, mode FROM xp_channels WHERE guild_id = ?").run(id, guildId);
    db.exec("COMMIT");
    return id;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function ensureDefaultEconomySystem(guildId: string): number {
  const existing = db.prepare("SELECT id FROM economy_systems WHERE guild_id=? AND deleted=0 ORDER BY id LIMIT 1").get(guildId) as { id: number } | undefined;
  if (existing) return existing.id;
  const old = settingsFor(guildId);
  db.exec("BEGIN");
  try {
    const created = db.prepare(`INSERT INTO economy_systems
      (guild_id,name,currency_symbol,starting_balance,max_cash_balance,max_bank_balance,config_json)
      VALUES (?,'Main economy',?,?,?,?,?)`).run(guildId, old.currency_symbol, old.starting_balance, old.max_cash_balance, old.max_bank_balance, old.economy_config);
    const id = Number(created.lastInsertRowid);
    db.prepare(`INSERT OR IGNORE INTO economy_balances (system_id,user_id,username,cash,bank,created_at)
      SELECT ?,user_id,username,cash,bank,created_at FROM economy_accounts WHERE guild_id=?`).run(id, guildId);
    db.prepare(`INSERT OR IGNORE INTO economy_shop_prices (item_id,system_id,amount)
      SELECT id,?,price FROM economy_shop_items WHERE guild_id=?`).run(id, guildId);
    db.exec("COMMIT");
    return id;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
