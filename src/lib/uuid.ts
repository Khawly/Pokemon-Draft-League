/*
 * UUID helper that also works outside a secure browser context.
 *
 * `crypto.randomUUID()` is only available on HTTPS and localhost, so a phone
 * opening the dev server over a LAN address could not save a draft pool. This
 * falls back to a standards-compliant version-4 UUID built from random bytes.
 */

/**
 * Creates a version-4 UUID.
 *
 * Prefers the native `crypto.randomUUID()` implementation. If that is missing
 * (for example on an insecure origin), it fills the UUID bytes with
 * `crypto.getRandomValues()` when available and otherwise falls back to
 * `Math.random`. The fallback is for identifier uniqueness, not secrecy.
 *
 * @returns A lowercase UUID string.
 */
export function createUuid(): string {
  const cryptoApi = globalThis.crypto;

  if (typeof cryptoApi?.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }

  const bytes = new Uint8Array(16);

  if (typeof cryptoApi?.getRandomValues === "function") {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  // Set the version (4) and variant (RFC 4122) bits.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
