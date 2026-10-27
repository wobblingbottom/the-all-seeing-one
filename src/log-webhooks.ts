import { readFileSync } from "node:fs";
import { PermissionFlagsBits, type Guild, type MessageCreateOptions, type WebhookMessageCreateOptions } from "discord.js";

export type LogKind = "moderation" | "economy";
const moderationAvatar = readFileSync("public/assets/modlogs.png");
const avatarApplied = new Set<string>();
const pending = new Map<string, Promise<any>>();
export async function ensureLogWebhook(guild: Guild, channel: any, kind: LogKind) {
    if (!channel.fetchWebhooks || !channel.createWebhook) throw new Error("This log channel does not support webhooks");
    if (channel.permissionsFor) {
      const me = await guild.members.fetchMe();
      if (!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageWebhooks])) throw new Error("The bot needs View Channel and Manage Webhooks in the log channel.");
    }
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
    try { return await lookup; } finally { if (pending.get(key) === lookup) pending.delete(key); }
}
export async function sendLog(guild: Guild, channel: any, kind: LogKind, payload: MessageCreateOptions) {
  try {
    const hook = await ensureLogWebhook(guild, channel, kind);
    return await hook.send({ ...payload, withComponents: true, username: kind === "moderation" ? "Crazyland Moderation" : "Crazyland Economy", avatarURL: kind === "moderation" ? undefined : guild.client.user.displayAvatarURL(), allowedMentions: { parse: [] } } as WebhookMessageCreateOptions);
  } catch (error) {
    console.error("Webhook log failed; sending as bot", error);
    return channel.send(payload);
  }
}
