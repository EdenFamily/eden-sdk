/**
 * Launch metadata rules, the same as the website's Create page (eden-web/src/pages/Create.tsx), plus the image rules
 * of POST /tx/launch. See README "Launch metadata and logos".
 */
import { getAddress, isAddress, type Address } from "viem";
import { ValidationError } from "./errors.ts";
import type { Socials } from "./types.ts";

export const NAME_MAX = 32;
export const SYMBOL_MAX = 10;
export const DESCRIPTION_MAX = 256;
export const SOCIAL_URL_MAX = 256;
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
/** POST /uploads/image (local mode) takes at most 4 MB and pins the bytes unchanged. */
export const UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
export const LOGO_SIDE = 1024;
/** The creator fees the website offers, in bps (0%, 1%, 2%, 3%, 5%, 10%). Any whole bps from 0 to MAX_CREATOR_FEE_BPS is valid on chain. */
export const CREATOR_FEE_BPS_OPTIONS = [0, 100, 200, 300, 500, 1000] as const;
export const DEFAULT_CREATOR_FEE_BPS = 100;
/** The factory's maxCreatorTaxBps at deployment (10%), also the contract's hard ceiling. */
export const MAX_CREATOR_FEE_BPS = 1000;
/** Snipe-tax exemptions: launchToken takes up to 32; launchAndBuy exempts the buy's recipient itself and takes 31 more. */
export const MAX_BUNDLE_WALLETS = 32;
export const MAX_BUNDLE_WALLETS_WITH_BUY = 31;

export type ImageType = "image/png" | "image/jpeg" | "image/gif";
export type ImageInfo = { type: ImageType; bytes: number; width: number; height: number; square: boolean };

export type NormalizedMetadata = {
  name: string;
  symbol: string;
  description: string;
  /** The contract's socials struct: x goes in `twitter`; discord and farcaster stay empty, as on the website. */
  socials: { twitter: string; telegram: string; discord: string; website: string; farcaster: string };
  creatorFeeBps: number;
  buyback: boolean;
  bundleWallets: Address[];
  image?: ImageInfo;
  /** Non-fatal notes, e.g. "the image is 1600×900 and will be centre-cropped to 900×900". */
  warnings: string[];
};

/** Sniffs PNG, JPEG or GIF from the file's own bytes (as the server does). */
export function sniffImage(b: Uint8Array): ImageType | undefined {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 6) {
    const head = String.fromCharCode(...b.subarray(0, 6));
    if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  }
  return undefined;
}

/** Width and height from the image header (PNG IHDR, GIF screen descriptor, JPEG SOFn). */
export function imageSize(b: Uint8Array, type: ImageType): { width: number; height: number } | undefined {
  const be16 = (i: number) => ((b[i]! << 8) | b[i + 1]!) >>> 0;
  if (type === "image/png" && b.length >= 24) {
    const be32 = (i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
    return { width: be32(16), height: be32(20) };
  }
  if (type === "image/gif" && b.length >= 10) return { width: b[6]! | (b[7]! << 8), height: b[8]! | (b[9]! << 8) };
  if (type === "image/jpeg") {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i += 1; continue; }
      const marker = b[i + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = be16(i + 2);
      if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: be16(i + 5), width: be16(i + 7) };
      }
      i += 2 + len;
    }
  }
  return undefined;
}

/** Checks image bytes: PNG, JPEG or GIF, at most `maxBytes`, readable dimensions. */
export function inspectImage(bytes: Uint8Array, maxBytes = IMAGE_MAX_BYTES): ImageInfo {
  const type = sniffImage(bytes);
  if (!type) throw new ValidationError("image", "The image must be a PNG, JPEG or GIF (checked from the file's bytes).");
  if (bytes.length > maxBytes) throw new ValidationError("image", `The image is ${(bytes.length / 1048576).toFixed(1)} MB; the limit is ${maxBytes / 1048576} MB.`);
  const size = imageSize(bytes, type);
  if (!size || size.width === 0 || size.height === 0) throw new ValidationError("image", "Could not read the image's dimensions; the file may be corrupt.");
  return { type, bytes: bytes.length, ...size, square: size.width === size.height };
}

/** data:image/...;base64,... → bytes. */
export function dataUriBytes(uri: string): Uint8Array {
  const m = /^data:([a-z/+.-]+)?(;base64)?,(.*)$/is.exec(uri);
  if (!m || !m[2]) throw new ValidationError("image", "A data: URI image must be base64-encoded (data:image/png;base64,...).");
  return Uint8Array.from(Buffer.from(m[3]!, "base64"));
}

export function bytesToDataUri(bytes: Uint8Array, type: ImageType): string {
  return `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
}

const X_HANDLE = /^@?([A-Za-z0-9_]{1,15})$/;
const TG_HANDLE = /^@?([A-Za-z0-9_]{5,32})$/;

function httpsUrl(value: string, field: string, hosts?: string[]): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new ValidationError(field, `${field} must be a full URL starting with https:// (got "${value}").`); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ValidationError(field, `${field} must be an http(s) URL.`);
  if (!url.hostname.includes(".")) throw new ValidationError(field, `${field} has no valid host.`);
  if (hosts && !hosts.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`))) {
    throw new ValidationError(field, `${field} must be a link on ${hosts.join(" or ")}.`);
  }
  if (value.length > SOCIAL_URL_MAX) throw new ValidationError(field, `${field} is longer than ${SOCIAL_URL_MAX} characters.`);
  return value;
}

/**
 * Socials: full URLs. X also takes a handle ("@name" or "name": 1–15 letters, digits or _) and Telegram a username
 * (5–32 of the same), both turned into URLs. Empty strings mean "none".
 */
export function normalizeSocials(s: Socials = {}): { twitter: string; telegram: string; website: string } {
  const x = (s.x ?? "").trim(), tg = (s.telegram ?? "").trim(), web = (s.website ?? "").trim();
  let twitter = "";
  if (x) {
    const h = X_HANDLE.exec(x);
    twitter = h ? `https://x.com/${h[1]}` : httpsUrl(x, "socials.x", ["x.com", "twitter.com"]);
  }
  let telegram = "";
  if (tg) {
    const h = TG_HANDLE.exec(tg);
    telegram = h ? `https://t.me/${h[1]}` : httpsUrl(tg, "socials.telegram", ["t.me", "telegram.me"]);
  }
  const website = web ? httpsUrl(web, "socials.website") : "";
  return { twitter, telegram, website };
}

export type MetadataInput = {
  name: string;
  symbol: string;
  description?: string;
  socials?: Socials;
  creatorFeeBps?: number;
  buyback?: boolean;
  bundleWallets?: readonly string[];
  /** Raw bytes or a data: URI are inspected; an https URL is passed to the server as is. */
  image?: string | Uint8Array;
  /** With an initial buy, at most 31 bundle wallets (launchAndBuy exempts the recipient itself). */
  initialBuy?: bigint;
};

/**
 * Validates and normalizes launch metadata with the website's rules. Throws ValidationError naming the field.
 *   name         required, trimmed, at most 32 characters
 *   symbol       required, upper-cased, 1–10 letters A–Z or digits 0–9 (no $, spaces or other characters)
 *   description  optional, trimmed, at most 256 characters
 *   socials      optional full URLs (X, Telegram, website), or an X / Telegram handle
 *   creator fee  whole bps from 0 to 1000 (0–10 %), default 100 (1 %); the website offers 0, 1, 2, 3, 5 and 10 %
 *   bundle       wallets exempt from the snipe tax: at most 32, or 31 with an initial buy
 *   image        PNG, JPEG or GIF, at most 8 MB; any aspect ratio is centre-cropped to a square (1024×1024 PNG)
 */
export function validateLaunchMetadata(input: MetadataInput): NormalizedMetadata {
  const warnings: string[] = [];
  const name = (input.name ?? "").trim();
  if (!name) throw new ValidationError("name", "Give your token a name.");
  if (name.length > NAME_MAX) throw new ValidationError("name", `The name is ${name.length} characters; the limit is ${NAME_MAX}.`);
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new ValidationError("name", "The name may not contain control characters.");

  const symbol = (input.symbol ?? "").trim().toUpperCase();
  if (!symbol) throw new ValidationError("symbol", "Add a ticker: up to 10 letters or digits.");
  if (!/^[A-Z0-9]+$/.test(symbol)) throw new ValidationError("symbol", `The ticker may only use letters A–Z and digits 0–9 (got "${input.symbol}"). Leave out the $.`);
  if (symbol.length > SYMBOL_MAX) throw new ValidationError("symbol", `The ticker is ${symbol.length} characters; the limit is ${SYMBOL_MAX}.`);

  const description = (input.description ?? "").trim();
  if (description.length > DESCRIPTION_MAX) throw new ValidationError("description", `The description is ${description.length} characters; the limit is ${DESCRIPTION_MAX}.`);
  if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(description)) throw new ValidationError("description", "The description may not contain control characters (line breaks are fine).");

  const s = normalizeSocials(input.socials);

  const creatorFeeBps = input.creatorFeeBps ?? DEFAULT_CREATOR_FEE_BPS;
  if (!Number.isInteger(creatorFeeBps) || creatorFeeBps < 0 || creatorFeeBps > MAX_CREATOR_FEE_BPS) {
    throw new ValidationError("creatorFeeBps", `The creator fee must be whole bps from 0 to ${MAX_CREATOR_FEE_BPS} (0–10%), got ${creatorFeeBps}.`);
  }

  const bundle = (input.bundleWallets ?? []).map((a) => a.trim()).filter(Boolean);
  const maxBundle = (input.initialBuy ?? 0n) > 0n ? MAX_BUNDLE_WALLETS_WITH_BUY : MAX_BUNDLE_WALLETS;
  if (bundle.length > maxBundle) throw new ValidationError("bundleWallets", `Up to ${maxBundle} bundle wallets${maxBundle === 31 ? " with an initial buy (its recipient is exempt too)" : ""} (got ${bundle.length}).`);
  const bad = bundle.find((a) => !isAddress(a, { strict: false }));
  if (bad) throw new ValidationError("bundleWallets", `Not an address: ${bad}`);

  let image: ImageInfo | undefined;
  if (input.image !== undefined) {
    if (typeof input.image === "string") {
      if (input.image.startsWith("data:")) image = inspectImage(dataUriBytes(input.image));
      else if (!/^https:\/\//i.test(input.image)) throw new ValidationError("image", "The image must be raw bytes, a data: URI, or an https:// URL.");
    } else {
      image = inspectImage(input.image);
    }
    if (image && !image.square) {
      const side = Math.min(image.width, image.height);
      warnings.push(`The image is ${image.width}×${image.height}; Eden keeps the centred ${side}×${side} square (scaled to at most ${LOGO_SIDE}×${LOGO_SIDE}). Keep the subject in the centre.`);
    }
    if (image && image.type === "image/gif") warnings.push("GIF logos are cropped to a square PNG: only the first frame is kept.");
  }

  return { name, symbol, description, socials: { twitter: s.twitter, telegram: s.telegram, discord: "", website: s.website, farcaster: "" },
    creatorFeeBps, buyback: input.buyback ?? true, bundleWallets: bundle.map((a) => getAddress(a)), image, warnings };
}

/** ipfs://<CIDv0 or CIDv1> */
export const IPFS_LOGO = /^ipfs:\/\/(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,}|z[1-9A-HJ-NP-Za-km-z]{20,})$/;
