import { readFileSync } from "node:fs";
import { type Guild, type MessageCreateOptions, type WebhookMessageCreateOptions } from "discord.js";
import { db } from "./db.js";

export type LogKind = "moderation" | "economy";
db.exec("CREATE TABLE IF NOT EXISTS log_identities (guild_id TEXT NOT NULL, kind TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL, avatar_url TEXT NOT NULL DEFAULT '', PRIMARY KEY(guild_id,kind))");
export function logIdentity(guildId: string, kind: LogKind) {
  return (db.prepare("SELECT enabled,name,avatar_url FROM log_identities WHERE guild_id=? AND kind=?").get(guildId, kind) as { enabled: number; name: string; avatar_url: string } | undefined)
    || { enabled: 0, name: kind === "moderation" ? "Crazyland Moderation" : "Crazyland Economy", avatar_url: "" };
}
const moderationAvatar = readFileSync("public/assets/modlogs.png");
const avatarApplied = new Set<string>();
const pending = new Map<string, Promise<any>>();
export async function sendLog(guild: Guild, channel: any, kind: LogKind, payload: MessageCreateOptions) {
  const identity = logIdentity(guild.id, kind);
  if (!identity.enabled) return channel.send(payload);
  try {
    if (!channel.fetchWebhooks || !channel.createWebhook) throw new Error("This log channel does not support webhooks");
    const key = channel.id + ":" + kind;
    let lookup = pending.get(key);
    if (!lookup) {
      lookup = (async () => {
        const hooks = await channel.fetchWebhooks();
        const existing = hooks.find((hook: any) => hook.owner?.id === guild.client.user.id && hook.name === "Crazyland " + kind + " logs" && hook.token);
        const hook = existing || await channel.createWebhook({ name: "Crazyland " + kind + " logs", ...(kind === "moderation" ? { avatar: moderationAvatar } : {}), reason: "Separate log identity" });
        if (kind === "moderation" && !avatarApplied.has(hook.id)) {
          if (existing) await hook.edit({ avatar: moderationAvatar, reason: "Moderation log avatar" });
          avatarApplied.add(hook.id);
        }
        return hook;
      })();
      pending.set(key, lookup);
    }
    let hook;
    try { hook = await lookup; } finally { if (pending.get(key) === lookup) pending.delete(key); }
    return await hook.send({ ...payload, withComponents: true, username: identity.name, avatarURL: identity.avatar_url || (kind === "moderation" ? undefined : guild.client.user.displayAvatarURL()), allowedMentions: { parse: [] } } as WebhookMessageCreateOptions);
  } catch (error) {
    console.error("Webhook log failed; sending as bot", error);
    return channel.send(payload);
  }
}
