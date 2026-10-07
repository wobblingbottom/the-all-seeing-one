import crypto from "node:crypto";
import { config } from "./config.js";
import { db } from "./db.js";

db.exec(`CREATE TABLE IF NOT EXISTS premium_subscriptions (
  subscription_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
  plan_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'APPROVAL_PENDING',
  approval_url TEXT NOT NULL, valid_until INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
); CREATE INDEX IF NOT EXISTS premium_subscriptions_guild ON premium_subscriptions(guild_id,status);`);

export function systemAvailable(guildId: string, kind: 'leveling' | 'economy', systemId: number) {
  const table=kind==='leveling'?'leveling_systems':'economy_systems';
  const rows=db.prepare('SELECT id FROM '+table+' WHERE guild_id=?'+(kind==='economy'?' AND deleted=0':'')+' ORDER BY id LIMIT ?').all(guildId,premiumStatus(guildId).systemLimit) as Array<{id:number}>;
  return rows.some(row=>row.id===systemId);
}
export function checkoutAvailable() {
  const p=config.paypal;
  return !!(p.clientId && p.clientSecret && p.webhookId && /^(sandbox|live)$/.test(p.environment) && /^P-[A-Z0-9]+$/.test(p.planId));
}
export function premiumStatus(guildId: string) {
  const active=!!db.prepare("SELECT 1 FROM premium_subscriptions WHERE guild_id=? AND status='ACTIVE' AND valid_until>? LIMIT 1").get(guildId,Date.now());
  return { active, systemLimit: active ? 10 : 2, checkoutAvailable: checkoutAvailable() };
}

async function paypal(path: string, method = "GET", body?: unknown, requestId?: string): Promise<any> {
  const p = config.paypal;
  if (!checkoutAvailable()) throw new Error("PayPal checkout is not configured");
  const base = p.environment === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
  const tokenResponse = await fetch(`${base}/v1/oauth2/token`, {
    method: "POST", headers: { Authorization: `Basic ${Buffer.from(`${p.clientId}:${p.clientSecret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials", signal: AbortSignal.timeout(15000)
  });
  if (!tokenResponse.ok) throw new Error("PayPal authentication failed");
  const token = await tokenResponse.json() as { access_token: string };
  const response = await fetch(`${base}${path}`, {
    method, headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json", ...(requestId ? { "PayPal-Request-Id": requestId } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error("PayPal request failed");
  return response.json();
}


const locks = new Map<string, Promise<unknown>>();
async function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous=locks.get(key) || Promise.resolve();
  const current=previous.catch(()=>{}).then(task);
  locks.set(key,current);
  try { return await current; } finally { if(locks.get(key)===current)locks.delete(key); }
}
export async function createPremiumSubscription(guildId: string, userId: string, origin: string) {
  return serialized(guildId,async()=>{
    if(premiumStatus(guildId).active)throw new Error("This server already has premium");
    const existing=db.prepare("SELECT * FROM premium_subscriptions WHERE guild_id=? AND status IN ('ACTIVE','APPROVAL_PENDING','APPROVED','SUSPENDED') ORDER BY created_at DESC LIMIT 1").get(guildId) as any;
    if(existing){
      await syncSubscription(existing.subscription_id);
      const updated=db.prepare("SELECT status FROM premium_subscriptions WHERE subscription_id=?").get(existing.subscription_id) as any;
      if(updated.status==='APPROVAL_PENDING' && existing.user_id===userId)return {subscriptionId:existing.subscription_id,approvalUrl:existing.approval_url};
      if(!['CANCELLED','EXPIRED'].includes(updated.status))throw new Error("A subscription already exists for this server");
    }
    const result=await paypal("/v1/billing/subscriptions","POST",{
      plan_id:config.paypal.planId,custom_id:guildId,
      application_context:{shipping_preference:"NO_SHIPPING",user_action:"SUBSCRIBE_NOW",return_url:origin+"/dashboard.html?premium=return&guild="+guildId,cancel_url:origin+"/dashboard.html?premium=cancel&guild="+guildId}
    },crypto.randomUUID());
    const approvalUrl=result.links?.find((link:any)=>link.rel==='approve')?.href;
    const approval=new URL(approvalUrl);
    if(!/^I-[A-Z0-9]+$/.test(result.id)||approval.protocol!=="https:"||!["www.paypal.com","www.sandbox.paypal.com"].includes(approval.hostname))throw new Error("Invalid PayPal response");
    db.prepare("INSERT INTO premium_subscriptions(subscription_id,guild_id,user_id,plan_id,approval_url) VALUES(?,?,?,?,?)").run(result.id,guildId,userId,config.paypal.planId,approvalUrl);
    return {subscriptionId:result.id,approvalUrl};
  });
}
export async function syncSubscription(subscriptionId: string) {
  const stored=db.prepare("SELECT * FROM premium_subscriptions WHERE subscription_id=?").get(subscriptionId) as any;
  if(!stored)return;
  const result=await paypal("/v1/billing/subscriptions/"+encodeURIComponent(subscriptionId));
  if(result.id!==subscriptionId||result.plan_id!==stored.plan_id||result.custom_id!==stored.guild_id)throw new Error("Subscription mismatch");
  const nextBilling=Date.parse(result.billing_info?.next_billing_time || "");
  // Access expires at the verified billing boundary unless renewal is confirmed.
  const validUntil=result.status==='ACTIVE' && Number.isFinite(nextBilling)?nextBilling:0;
  db.prepare("UPDATE premium_subscriptions SET status=?,valid_until=? WHERE subscription_id=?").run(result.status,validUntil,subscriptionId);
}
export async function activatePremiumSubscription(subscriptionId: string,guildId: string,userId: string) {
  if(!subscriptionId){
    const pending=db.prepare("SELECT subscription_id FROM premium_subscriptions WHERE guild_id=? AND user_id=? ORDER BY created_at DESC LIMIT 1").get(guildId,userId) as any;
    subscriptionId=pending?.subscription_id || "";
  }
  const stored=db.prepare("SELECT 1 FROM premium_subscriptions WHERE subscription_id=? AND guild_id=? AND user_id=?").get(subscriptionId,guildId,userId);
  if(!stored||!/^I-[A-Z0-9]+$/.test(subscriptionId))throw new Error("Subscription not found");
  await serialized(guildId,()=>syncSubscription(subscriptionId));
  const status=premiumStatus(guildId);
  if(!status.active)throw new Error("Subscription is not active");
  return status;
}
export async function handlePayPalWebhook(headers: Record<string,unknown>,event: any) {
  const verification=await paypal("/v1/notifications/verify-webhook-signature","POST",{
    auth_algo:headers["paypal-auth-algo"],cert_url:headers["paypal-cert-url"],transmission_id:headers["paypal-transmission-id"],transmission_sig:headers["paypal-transmission-sig"],transmission_time:headers["paypal-transmission-time"],webhook_id:config.paypal.webhookId,webhook_event:event
  });
  if(verification.verification_status!=="SUCCESS")throw new Error("Invalid webhook");
  const subscriptionId=event.event_type?.startsWith("BILLING.SUBSCRIPTION.")?event.resource?.id:event.resource?.billing_agreement_id;
  if(subscriptionId && /^I-[A-Z0-9]+$/.test(subscriptionId)){
    const stored=db.prepare("SELECT guild_id FROM premium_subscriptions WHERE subscription_id=?").get(subscriptionId) as any;
    if(stored)await serialized(stored.guild_id,()=>syncSubscription(subscriptionId));
  }
}
export function startPremiumSync() {
  let running=false;
  const sync=async()=>{
    if(running||!checkoutAvailable())return;
    running=true;
    try {
      const rows=db.prepare("SELECT subscription_id,guild_id FROM premium_subscriptions WHERE status IN ('ACTIVE','APPROVED','SUSPENDED','APPROVAL_PENDING')").all() as Array<{subscription_id:string;guild_id:string}>;
      for(const row of rows)try{await serialized(row.guild_id,()=>syncSubscription(row.subscription_id));}catch{console.error("PayPal subscription reconciliation failed");}
    } finally {running=false;}
  };
  void sync();setInterval(()=>void sync(),5*60*1000).unref();
}
