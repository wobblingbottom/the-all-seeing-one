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

## Moderation

Use `/mod` and select an action, then fill in its form: `/mod - Warn member`, `/mod - Modlogs`, `/mod - Clear case`, `/mod - Timeout member`, `/mod - Remove timeout`, `/mod - Kick member`, `/mod - Ban member`, `/mod - Unban user`, and `/mod - Purge messages`. Warnings and completed actions are saved as moderation cases; clearing warnings preserves their history.

Use the Moderation dashboard to enable or disable commands, choose an optional log channel, and view the latest 50 cases. Moderators need Moderate Members for warnings and timeouts, Kick Members for kicks, Ban Members for bans and unbans, or Manage Messages for purge. The bot needs matching permissions for Discord actions, and its role must be above the member being moderated. Purge also needs View Channel and Read Message History in the current channel. Timeouts accept 1-40,320 minutes; purge accepts 1-100 messages and skips messages older than 14 days. Command replies are private to the moderator. Member actions send a direct message with the reason and optional message links. Completed actions are posted to the configured moderation log channel. Forms accept one optional Discord message link from the same server, saved with the case and shown in dashboard history. Failed DM or log delivery is reported to the moderator without undoing the action.

Moderation settings and warning streak rules save automatically after changes. Invalid rules show a validation message and are not saved. Warning streak rules are configured in Moderation settings. Assign an exact active-warning count to a timeout (with duration), kick, or ban. For example, configure warning 2 to kick and warning 3 to ban. No rules are enabled by default. Counts survive leaving and rejoining; clearing warnings resets the active count. Automatic punishments use the bot?s permissions and still respect the issuing moderator?s role hierarchy. A failed punishment leaves the warning recorded and reports the failure only in the moderator response and log.

## Level curve

Level `n` requires `n² × 100` total XP. By default, a qualifying message earns 15–25 XP, at most once every 60 seconds. Bot messages are ignored.

## Production notes

- Use HTTPS and set `DISCORD_REDIRECT_URI` to the exact public callback URL.
- Persist the `data/` directory, or replace SQLite with a hosted database before horizontal scaling.
- Keep `DISCORD_TOKEN`, `DISCORD_CLIENT_SECRET`, and `SESSION_SECRET` out of source control.

## Railway hosting

Deploy this GitHub repository as a Railway service. The Dockerfile provides Node 24 and runs `npm start`. Keep one replica and disable service sleeping for the Discord bot.

Attach a persistent volume at `/data` and set `DATABASE_PATH=/data/crazyland.db`. Set `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, and `SESSION_SECRET` in Railway Variables using your local values. Never commit `.env`. Railway supplies `PORT`.

The bot defaults to the Railway volume mount when `DATABASE_PATH` is unset and rejects paths outside that mount. A relative path such as `./data/crazyland.db` resolves under `/app`, outside the `/data` volume, and loses data when the container is replaced. Before correcting an existing deployment, back up its active SQLite database onto the volume using SQLite's backup API, then change the variable and redeploy.

Generate a public domain under service Settings > Networking. Set `DISCORD_REDIRECT_URI=https://YOUR-DOMAIN/auth/discord/callback` and add exactly the same URL to the Discord Developer Portal OAuth2 redirects. Deploy the variable changes, then sign in through the public domain.

A new volume starts with an empty database. To retain local data, transfer the SQLite database to the volume while the bot is stopped; do not run local and hosted instances simultaneously.

## PayPal premium subscriptions

Free servers can create two leveling systems and two economy systems. Premium allows 10 of each per server. On cancellation, suspension, or expiry, only the first two systems of each type operate; extra system data is retained. Shop items using an unavailable economy system cannot be purchased.

Create a PayPal REST app and an active recurring billing plan with your chosen price, currency, and interval (no trial is required). Set PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_PLAN_ID, PAYPAL_ENVIRONMENT (sandbox or live), and PAYPAL_WEBHOOK_ID. Credentials, plan, and webhook must belong to the same environment and app. Checkout remains disabled until these are configured. The actual recurring price and terms appear on PayPal before approval.

Register an HTTPS webhook at /api/paypal/webhook on your public domain. Subscribe to BILLING.SUBSCRIPTION.CREATED, BILLING.SUBSCRIPTION.ACTIVATED, BILLING.SUBSCRIPTION.UPDATED, BILLING.SUBSCRIPTION.CANCELLED, BILLING.SUBSCRIPTION.SUSPENDED, BILLING.SUBSCRIPTION.EXPIRED, BILLING.SUBSCRIPTION.PAYMENT.FAILED, PAYMENT.SALE.COMPLETED, PAYMENT.SALE.REFUNDED, and PAYMENT.SALE.REVERSED. Webhook signatures are verified with PayPal; current subscription details are fetched rather than trusting event status. A background check also reconciles subscriptions every five minutes. Access expires at the verified next billing time until renewal is confirmed. Cancellation or suspension removes premium immediately. Subscribers manage cancellation in their PayPal automatic payments settings.

Set DISCORD_REDIRECT_URI to the public site's exact OAuth callback URL; its origin is used for checkout redirects and request validation. Keep one app replica (SQLite and in-process subscription locks).

Before enabling live checkout, test sandbox approval, retry after a failed return, renewal, cancellation, suspension, and webhook delivery with a sandbox buyer. Automated mocked tests do not verify real PayPal account setup.

### Separate log identities

In the dashboard, open Moderation settings or Economy balance settings to enable a separate log identity, set its name and HTTPS avatar image URL, and click Save log identity. Each identity applies to that server and uses its existing log channel. Leave the avatar blank to use the supplied green Modlogs image for moderation or the bot avatar for economy. Moderation log embeds use #77F45F. The bot needs Manage Webhooks in the log channel and creates or reuses its own webhook automatically. If webhook delivery fails, it tries sending the log as the bot and records the failure in the console. The moderation identity is enabled by default; economy is opt-in. Explicit saved choices take precedence.
