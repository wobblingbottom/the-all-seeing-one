# Crazyland All-Seeing Bot

A Discord community bot with chat-based XP, automatic level roles, a configurable economy and shop, leaderboards, and a web dashboard.

XP can be restricted with allowed and denied channel lists. If the allowed list is empty, all text channels are eligible except channels on the denied list. A denied channel always takes precedence.

Level-up announcements support member, level, XP, next-level, server, channel, and awarded-role variables. The full variable reference is shown next to the message editor in the dashboard.

Each server can create up to 20 independent leveling systems. A system has its own member XP, leaderboard, XP rate, cooldown, channel rules, content filter, announcement, and role rewards. Content filters can count every message, text-only messages, or messages containing image attachments.

Use `/level` to generate a PNG progress card for yourself. The optional `member` and `system` arguments show another member or a different leveling system. Cards include the member's server display name, avatar, level, rank, total XP, progress, and XP required for the next level.

The economy supports message rewards and a single `/economy` command with an action selector for `daily`, `work`, `balance`, `deposit`, `withdraw`, `pay`, `shop`, `buy`, `inventory`, `use`, and `leaderboard`. Currency, limits, fees, channel and role filters, reward ranges, shop inventory, and audit channels are configured from the Economy dashboard.

## Run locally

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications).
2. On **Bot**, create a bot and enable **Server Members Intent** and **Message Content Intent**.
3. On **OAuth2**, add `http://localhost:3000/auth/discord/callback` as a redirect URL.
4. Copy `.env.example` to `.env` and fill in the bot token, application ID, client secret, and a long random session secret.
5. Install dependencies and start:

   ```sh
   npm install
   npm run dev
   ```

6. Invite the bot with the `bot` scope and these permissions: View Channels, Send Messages, Read Message History, and Manage Roles. Put its Discord role above every reward role it should grant.
7. Open `http://localhost:3000`, sign in with Discord, select your server, and configure leveling.

## Level curve

Level `n` requires `n² × 100` total XP. By default, a qualifying message earns 15–25 XP, at most once every 60 seconds. Bot messages are ignored.

## Production notes

- Use HTTPS and set `DISCORD_REDIRECT_URI` to the exact public callback URL.
- Persist the `data/` directory, or replace SQLite with a hosted database before horizontal scaling.
- Keep `DISCORD_TOKEN`, `DISCORD_CLIENT_SECRET`, and `SESSION_SECRET` out of source control.
