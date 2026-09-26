#!/usr/bin/env node
// url-guard — shared URL safety rule set for gate scripts (zero-dep, node:net only)
//   rule set aligned with skills/web-research-fanout/scripts/fetch-hard.mjs, minus its
//   DNS lookup: this guard is pure string/IP-literal classification, no DNS, no network.
//   Anything we cannot positively classify as a public http(s) target is unsafe.
import net from "node:net";

const RESERVED_HOST = /(^|\.)(localhost|local|internal|home\.arpa)$/i;

function isPrivateV4(ip) {
  const p = ip.split(".").map((n) => Number(n));
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isUnsafeV6(ip) {
  const h = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "::" || h === "::1") return true;
  if (/^f[cd]/.test(h)) return true; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(h)) return true; // fe80::/10 link-local
  if (h.startsWith("::ffff:")) return isPrivateV4(h.slice(7)); // IPv4-mapped
  return false;
}

export function isSafePublicUrl(urlString) {
  let u;
  try {
    u = new URL(urlString);
  } catch {
    return { ok: false, reason: "invalid URL" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, reason: `blocked scheme '${u.protocol}'` };
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host) return { ok: false, reason: "missing host" };
  const literal = net.isIP(host);
  if (literal === 4 && isPrivateV4(host)) return { ok: false, reason: `blocked private/loopback address: ${host}` };
  if (literal === 6 && isUnsafeV6(host)) return { ok: false, reason: `blocked private/loopback address: ${host}` };
  if (literal === 0 && RESERVED_HOST.test(host)) return { ok: false, reason: `blocked host: ${host}` };
  return { ok: true };
}