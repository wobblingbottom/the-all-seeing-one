import { createCanvas, GlobalFonts, loadImage, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import { fileURLToPath } from "node:url";

const batmosFontPath = fileURLToPath(new URL("../public/fonts/BATMOS.TTF", import.meta.url));
const hasBatmosFont = Boolean(GlobalFonts.registerFromPath(batmosFontPath, "Batmos"));

export type LevelCardData = {
  username: string;
  avatarUrl: string;
  avatarDecorationUrl?: string | null;
  nameplateUrl?: string | null;
  nameplatePalette?: string | null;
  accentColor?: number | null;
  bannerUrl?: string | null;
  systemName: string;
  level: number;
  rank: number;
  totalXp: number;
  levelXp: number;
  levelXpRequired: number;
  xpNeeded: number;
  averageXpPerMinute?: number;
};

const collectibleCache = new Map<string, Promise<Image | null>>();

function cachedImage(url: string) {
  let image = collectibleCache.get(url);
  if (!image) {
    image = loadImage(url).catch(() => null);
    collectibleCache.set(url, image);
    if (collectibleCache.size > 100) collectibleCache.delete(collectibleCache.keys().next().value!);
  }
  return image;
}

function roundedRect(ctx: SKRSContext2D, x: number, y: number, width: number, height: number, radius: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  ctx.closePath();
}

function compact(value: number) {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function fittedText(ctx: SKRSContext2D, text: string, maxWidth: number) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  const characters = Array.from(text);
  while (characters.length && ctx.measureText(`${characters.join("")}…`).width > maxWidth) characters.pop();
  return `${characters.join("")}…`;
}

async function dominantColor(url?: string | null) {
  if (!url) return null;
  try {
    const image = await cachedImage(url);
    if (!image) return null;
    const sample = createCanvas(24, 24);
    const sampleCtx = sample.getContext("2d");
    sampleCtx.drawImage(image, 0, 0, 24, 24);
    const pixels = sampleCtx.getImageData(0, 0, 24, 24).data;
    let red = 0, green = 0, blue = 0, weight = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3] < 100) continue;
      const brightness = (pixels[index] + pixels[index + 1] + pixels[index + 2]) / 3;
      const pixelWeight = brightness < 20 ? 0.2 : 1;
      red += pixels[index] * pixelWeight;
      green += pixels[index + 1] * pixelWeight;
      blue += pixels[index + 2] * pixelWeight;
      weight += pixelWeight;
    }
    if (!weight) return null;
    return `rgb(${Math.round(red / weight)}, ${Math.round(green / weight)}, ${Math.round(blue / weight)})`;
  } catch { return null; }
}

function prominentColor(image: Image) {
  const sample = createCanvas(64, 12);
  const sampleCtx = sample.getContext("2d");
  sampleCtx.drawImage(image, 0, 0, 64, 12);
  const pixels = sampleCtx.getImageData(0, 0, 64, 12).data;
  const buckets = new Map<string, { count: number; red: number; green: number; blue: number; saturation: number }>();
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index + 3] < 100) continue;
    const red = pixels[index], green = pixels[index + 1], blue = pixels[index + 2];
    const maximum = Math.max(red, green, blue), minimum = Math.min(red, green, blue);
    const brightness = (maximum + minimum) / 2;
    const saturation = maximum - minimum;
    if (brightness < 24 || brightness > 242 || saturation < 12) continue;
    const key = `${red >> 5}-${green >> 5}-${blue >> 5}`;
    const bucket = buckets.get(key) ?? { count: 0, red: 0, green: 0, blue: 0, saturation: 0 };
    bucket.count += 1; bucket.red += red; bucket.green += green; bucket.blue += blue; bucket.saturation += saturation;
    buckets.set(key, bucket);
  }
  const winner = [...buckets.values()].sort((a, b) => (b.count * (1 + b.saturation / b.count / 255)) - (a.count * (1 + a.saturation / a.count / 255)))[0];
  if (!winner) return null;
  return `rgb(${Math.round(winner.red / winner.count)}, ${Math.round(winner.green / winner.count)}, ${Math.round(winner.blue / winner.count)})`;
}

export async function renderLevelCard(data: LevelCardData): Promise<Buffer> {
  // A taller, narrower card keeps the text readable in Discord's mobile preview.
  const width = 800;
  const height = 240;
  const scale = 1;
  const canvas = createCanvas(width * scale, height * scale);
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  ctx.imageSmoothingEnabled = true;
  ctx.letterSpacing = "2px";

  const nameplate = data.nameplateUrl ? await cachedImage(data.nameplateUrl) : null;
  const profileColor = (nameplate ? prominentColor(nameplate) : null)
    ?? (data.accentColor != null ? `#${data.accentColor.toString(16).padStart(6, "0")}` : null)
    ?? await dominantColor(data.bannerUrl)
    ?? "#d5ff38";
  roundedRect(ctx, 0, 0, width, height, 20);
  ctx.save();
  ctx.clip();
  // Nameplates contain transparent areas. Discord normally renders those over
  // its own surface, so establish that surface before drawing the artwork.
  ctx.fillStyle = "#313338";
  ctx.fillRect(0, 0, width, height);
  if (nameplate) {
    // Preserve the artwork's aspect ratio, keeping its decorated right edge.
    const artworkWidth = height * nameplate.width / nameplate.height;
    ctx.drawImage(nameplate, width - artworkWidth, 0, artworkWidth, height);
  } else {
    const fallback = ctx.createLinearGradient(0, 0, width, height);
    fallback.addColorStop(0, "#313338");
    fallback.addColorStop(0.65, "#2b2d31");
    fallback.addColorStop(1, profileColor);
    ctx.fillStyle = fallback;
    ctx.fillRect(0, 0, width, height);
  }
  const shade = ctx.createLinearGradient(0, 0, width, 0);
  shade.addColorStop(0, "#0e0f0d70");
  shade.addColorStop(0.75, "#0e0f0db0");
  shade.addColorStop(1, "#0e0f0d40");
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.arc(91, 92, 60, 0, Math.PI * 2);
  ctx.clip();
  try {
    const avatar = await loadImage(data.avatarUrl);
    ctx.drawImage(avatar, 31, 32, 120, 120);
  } catch {
    ctx.fillStyle = "#44463f";
    ctx.fillRect(31, 32, 120, 120);
  }
  ctx.restore();
  ctx.strokeStyle = profileColor;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(91, 92, 61, 0, Math.PI * 2);
  ctx.stroke();
  if (data.avatarDecorationUrl) {
    const decoration = await cachedImage(data.avatarDecorationUrl);
    if (decoration) ctx.drawImage(decoration, 15, 16, 152, 152);
  }

  ctx.shadowColor = "#000000dd";
  ctx.shadowBlur = 5;
  ctx.fillStyle = "#d7d8d1";
  ctx.font = "700 22px sans-serif";
  ctx.fillText(fittedText(ctx, data.systemName.toUpperCase(), 590), 180, 34);
  ctx.fillStyle = profileColor;
  ctx.font = hasBatmosFont ? "42px Batmos" : "700 42px sans-serif";
  const capitalizedUsername = data.username.charAt(0).toUpperCase() + data.username.slice(1);
  ctx.fillText(fittedText(ctx, capitalizedUsername, 590), 180, 85);
  ctx.shadowBlur = 0;

  ctx.fillStyle = "#ffffff";
  ctx.font = "700 30px sans-serif";
  ctx.fillText(fittedText(ctx, `LEVEL ${data.level}`, 280), 180, 130);
  ctx.fillText(fittedText(ctx, `RANK #${data.rank}`, 290), 480, 130);

  const progress = data.levelXpRequired ? Math.min(1, Math.max(0, data.levelXp / data.levelXpRequired)) : 0;
  roundedRect(ctx, 180, 150, 590, 18, 9);
  ctx.fillStyle = "#11120fd6";
  ctx.fill();
  if (progress > 0) {
    roundedRect(ctx, 180, 150, Math.max(18, 590 * progress), 18, 9);
    const bar = ctx.createLinearGradient(180, 0, 770, 0);
    bar.addColorStop(0, profileColor);
    bar.addColorStop(1, "#ffffff");
    ctx.fillStyle = bar;
    ctx.fill();
  }
  ctx.fillStyle = "#f1f1ec";
  ctx.font = "600 24px sans-serif";
  ctx.fillText(fittedText(ctx, `${compact(data.levelXp)} / ${compact(data.levelXpRequired)} XP`, 590), 180, 198);
  ctx.fillText(fittedText(ctx, `${compact(Math.round(data.averageXpPerMinute ?? 0))} AVG XP/MIN`, 590), 180, 228);

  return canvas.encode("png");
}

export type LeaderboardRow = Pick<LevelCardData, "username" | "avatarUrl" | "avatarDecorationUrl" | "nameplateUrl" | "accentColor"> & {
  rank: number;
  value: string;
};

/** Dashboard-style rows, using the same Discord artwork loader as /level. */
export async function renderLeaderboardCard(title: string, rows: LeaderboardRow[], currencyIconUrl?: string): Promise<Buffer> {
  const width = 900, rowHeight = 120, gap = 14, top = 90;
  const canvas = createCanvas(width, top + rows.length * (rowHeight + gap) + 6);
  const ctx = canvas.getContext("2d");
  ctx.letterSpacing = "2px";
  ctx.fillStyle = "#2b2d31";
  ctx.fillRect(0, 0, width, canvas.height);
  ctx.fillStyle = "#f2f3f5";
  ctx.font = "700 36px sans-serif";
  ctx.fillText(fittedText(ctx, title, width - 48), 24, 46);
  ctx.fillStyle = "#45474c";
  ctx.fillRect(24, 66, width - 48, 2);
  const icon = currencyIconUrl ? await cachedImage(currencyIconUrl) : null;
  const assets = await Promise.all(rows.map(async row => ({
    avatar: row.avatarUrl ? await cachedImage(row.avatarUrl) : null,
    decoration: row.avatarDecorationUrl ? await cachedImage(row.avatarDecorationUrl) : null,
    nameplate: row.nameplateUrl ? await cachedImage(row.nameplateUrl) : null
  })));
  rows.forEach((row, index) => {
    const y = top + index * (rowHeight + gap);
    const { avatar, decoration, nameplate } = assets[index];
    ctx.save();
    roundedRect(ctx, 16, y, width - 32, rowHeight, 6);
    ctx.clip();
    ctx.fillStyle = nameplate ? prominentColor(nameplate) ?? "#313338" : "#313338";
    ctx.fillRect(16, y, width - 32, rowHeight);
    ctx.fillStyle = "#2b2d31a0";
    ctx.fillRect(16, y, width - 32, rowHeight);
    if (nameplate) {
      // Preserve the original aspect ratio and mirror the outer artwork at left.
      const artWidth = rowHeight * nameplate.width / nameplate.height;
      ctx.drawImage(nameplate, width - 16 - artWidth, y, artWidth, rowHeight);
      ctx.save();
      ctx.translate(width, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(nameplate, width - 16 - artWidth, y, artWidth, rowHeight);
      ctx.restore();
    }
    ctx.restore();
    ctx.fillStyle = "#f2f3f5";
    ctx.font = "700 34px sans-serif";
    ctx.fillText(`#${row.rank}`, 40, y + 73);
    ctx.save();
    ctx.beginPath();
    ctx.arc(166, y + 60, 36, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = "#45474c";
    ctx.fillRect(130, y + 24, 72, 72);
    if (avatar) ctx.drawImage(avatar, 130, y + 24, 72, 72);
    ctx.restore();
    if (decoration) ctx.drawImage(decoration, 121, y + 15, 90, 90);
    ctx.font = "600 36px sans-serif";
    ctx.shadowColor = "#000000";
    ctx.shadowBlur = 6;
    ctx.fillText(fittedText(ctx, row.username, 630), 230, y + 49);
    ctx.font = "700 32px sans-serif";
    if (icon) ctx.drawImage(icon, 230, y + 68, 32, 32);
    ctx.fillText(fittedText(ctx, row.value, icon ? 586 : 630), icon ? 274 : 230, y + 96);
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#45474c";
    ctx.fillRect(16, y + rowHeight + 6, width - 32, 1);
  });
  return canvas.encode("png");
}
