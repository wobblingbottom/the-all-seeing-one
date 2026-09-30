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
  // Discord nameplates are only 672×126. A 1008×189 card keeps their exact
  // 5.33:1 ratio while limiting enlargement to 1.5× to avoid visible blur.
  const width = 1008;
  const height = 189;
  const scale = 1;
  const canvas = createCanvas(width * scale, height * scale);
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  ctx.imageSmoothingEnabled = true;

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
    // The source and card have the same aspect ratio: no crop and no distortion.
    ctx.drawImage(nameplate, 0, 0, width, height);
  } else {
    const fallback = ctx.createLinearGradient(0, 0, width, height);
    fallback.addColorStop(0, "#313338");
    fallback.addColorStop(0.65, "#2b2d31");
    fallback.addColorStop(1, profileColor);
    ctx.fillStyle = fallback;
    ctx.fillRect(0, 0, width, height);
  }
  const shade = ctx.createLinearGradient(0, 0, width, 0);
  shade.addColorStop(0, "#0e0f0d40");
  shade.addColorStop(0.55, "#0e0f0d20");
  shade.addColorStop(1, "#0e0f0d00");
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
  ctx.font = "700 11px sans-serif";
  ctx.fillText(data.systemName.toUpperCase(), 180, 34);
  ctx.fillStyle = profileColor;
  ctx.font = hasBatmosFont ? "31px Batmos" : "700 31px sans-serif";
  const capitalizedUsername = data.username.charAt(0).toUpperCase() + data.username.slice(1);
  const displayName = capitalizedUsername.length > 24 ? `${capitalizedUsername.slice(0, 23)}…` : capitalizedUsername;
  ctx.fillText(displayName, 180, 75);
  ctx.shadowBlur = 0;

  ctx.fillStyle = "#ffffff";
  ctx.font = "700 17px sans-serif";
  ctx.fillText(`LEVEL ${data.level}`, 180, 110);
  ctx.fillText(`RANK #${data.rank}`, 338, 110);

  const progress = data.levelXpRequired ? Math.min(1, Math.max(0, data.levelXp / data.levelXpRequired)) : 0;
  roundedRect(ctx, 180, 126, 690, 14, 7);
  ctx.fillStyle = "#11120fd6";
  ctx.fill();
  if (progress > 0) {
    roundedRect(ctx, 180, 126, Math.max(14, 690 * progress), 14, 7);
    const bar = ctx.createLinearGradient(180, 0, 870, 0);
    bar.addColorStop(0, profileColor);
    bar.addColorStop(1, "#ffffff");
    ctx.fillStyle = bar;
    ctx.fill();
  }
  ctx.fillStyle = "#f1f1ec";
  ctx.font = "600 11px sans-serif";
  ctx.fillText(`${compact(data.levelXp)} / ${compact(data.levelXpRequired)} XP`, 180, 164);
  ctx.fillText(`${compact(Math.round(data.averageXpPerMinute ?? 0))} AVG XP/MIN`, 338, 164);

  return canvas.encode("png");
}
