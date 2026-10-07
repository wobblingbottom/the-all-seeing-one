import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const config = {
  token: required("DISCORD_TOKEN"),
  clientId: required("DISCORD_CLIENT_ID"),
  clientSecret: required("DISCORD_CLIENT_SECRET"),
  redirectUri: process.env.DISCORD_REDIRECT_URI ?? "http://localhost:3000/auth/discord/callback",
  sessionSecret: required("SESSION_SECRET"),
  port: Number(process.env.PORT ?? 3000),
  databasePath: process.env.DATABASE_PATH ?? "./data/crazyland.db",
  paypal: {
    clientId: process.env.PAYPAL_CLIENT_ID ?? "",
    clientSecret: process.env.PAYPAL_CLIENT_SECRET ?? "",
    environment: process.env.PAYPAL_ENVIRONMENT ?? "sandbox",
    planId: process.env.PAYPAL_PLAN_ID ?? "",
    webhookId: process.env.PAYPAL_WEBHOOK_ID ?? ""
  }
};
