/*
 * Shared client-side validation helpers.
 *
 * Pages collect values as strings from controlled inputs, then hand them to a
 * save handler. These helpers trim, parse, and range-check those values and throw
 * a user-facing Error when a value is not acceptable. Callers already render the
 * message in their error banner, so the same rule produces the same wording
 * across settings, schedule, pool, and profile forms.
 */

/** How many characters/megabytes a value may use where a caller asks for a cap. */
export const MAX_RULES_LENGTH = 50_000;

/** Largest CSV or rules file accepted by the client-side import controls. */
export const MAX_IMPORT_FILE_BYTES = 1_000_000;

/**
 * Trims a required text field and enforces an optional length cap.
 *
 * @param value - The raw input value.
 * @param label - Human name of the field, used in the error message.
 * @param maxLength - Maximum accepted length after trimming.
 * @returns The trimmed value.
 * @throws When the value is blank or longer than `maxLength`.
 */
export function requireText(
  value: string,
  label: string,
  maxLength?: number,
): string {
  const trimmed = value.trim();

  if (!trimmed) {
    throw new Error(`${label} is required.`);
  }

  if (maxLength != null && trimmed.length > maxLength) {
    throw new Error(`${label} must be ${maxLength} characters or fewer.`);
  }

  return trimmed;
}

/**
 * Trims an optional text field and enforces an optional length cap.
 *
 * @param value - The raw input value.
 * @param label - Human name of the field, used in the error message.
 * @param maxLength - Maximum accepted length after trimming.
 * @returns The trimmed value, or null when the field is blank.
 * @throws When the value is longer than `maxLength`.
 */
export function optionalText(
  value: string,
  label: string,
  maxLength?: number,
): string | null {
  const trimmed = value.trim();

  if (maxLength != null && trimmed.length > maxLength) {
    throw new Error(`${label} must be ${maxLength} characters or fewer.`);
  }

  return trimmed || null;
}

/**
 * Parses a required whole number and enforces an optional range.
 *
 * @param value - The raw input value, number, or numeric state.
 * @param label - Human name of the field, used in the error message.
 * @param min - Smallest accepted value.
 * @param max - Largest accepted value.
 * @returns The parsed integer.
 * @throws When the value is blank, not a whole number, or outside the range.
 */
export function requireInteger(
  value: string | number,
  label: string,
  min?: number,
  max?: number,
): number {
  const text = String(value).trim();

  if (!text) {
    throw new Error(`${label} is required.`);
  }

  const parsed = Number(text);

  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error(`${label} must be a whole number.`);
  }

  return checkIntegerRange(parsed, label, min, max);
}

/**
 * Parses an optional whole number and enforces an optional range.
 *
 * @param value - The raw input value, number, or numeric state.
 * @param label - Human name of the field, used in the error message.
 * @param min - Smallest accepted value.
 * @param max - Largest accepted value.
 * @returns The parsed integer, or null when the field is blank.
 * @throws When the value is not a whole number or outside the range.
 */
export function optionalInteger(
  value: string | number,
  label: string,
  min?: number,
  max?: number,
): number | null {
  const text = String(value).trim();

  if (!text) {
    return null;
  }

  const parsed = Number(text);

  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error(`${label} must be a whole number.`);
  }

  return checkIntegerRange(parsed, label, min, max);
}

/** Applies a min/max range to an already parsed integer. */
function checkIntegerRange(
  parsed: number,
  label: string,
  min?: number,
  max?: number,
): number {
  if (min != null && parsed < min) {
    throw new Error(`${label} must be at least ${min}.`);
  }

  if (max != null && parsed > max) {
    throw new Error(`${label} must be at most ${max}.`);
  }

  return parsed;
}

/**
 * Reports whether a value looks like an email address.
 *
 * The browser's `type="email"` check covers form submissions, but the password
 * reset action sits outside the form, so it needs the same rule in code.
 *
 * @param value - The raw input value.
 * @returns True when the trimmed value has the expected email shape.
 */
export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/**
 * Trims and validates a required email address.
 *
 * @param value - The raw input value.
 * @returns The trimmed email.
 * @throws When the value is blank or not a plausible email address.
 */
export function requireEmail(value: string): string {
  const trimmed = value.trim();

  if (!trimmed) {
    throw new Error("Email is required.");
  }

  if (!isValidEmail(trimmed)) {
    throw new Error("Enter a valid email address.");
  }

  return trimmed;
}

/**
 * Reports whether a value is a valid `http` or `https` URL.
 *
 * @param value - The raw input value.
 * @returns True when the value parses as an HTTP(S) URL.
 */
export function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Trims and validates an optional HTTP(S) URL.
 *
 * @param value - The raw input value.
 * @param label - Human name of the field, used in the error message.
 * @param allowedHosts - Optional host allowlist.
 * @returns The trimmed URL, or null when the field is blank.
 * @throws When the value is not a valid HTTP(S) URL or is off the allowlist.
 */
export function optionalHttpUrl(
  value: string,
  label: string,
  allowedHosts?: string[],
): string | null {
  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  let url: URL;

  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`${label} must be a full http:// or https:// link.`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must be a full http:// or https:// link.`);
  }

  if (allowedHosts && !allowedHosts.includes(url.hostname)) {
    throw new Error(
      `${label} must be on ${allowedHosts.join(" or ")}.`,
    );
  }

  return trimmed;
}

/**
 * Trims and validates a 24-hour clock value such as `18:00`.
 *
 * @param value - The raw input value.
 * @param label - Human name of the field, used in the error message.
 * @returns The trimmed `HH:MM` value.
 * @throws When the value is not a real 24-hour time.
 */
export function requireClock(value: string, label: string): string {
  const trimmed = value.trim();

  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(trimmed)) {
    throw new Error(`${label} must be a valid time like 18:00.`);
  }

  return trimmed;
}

/**
 * Reports whether a value is an IANA time zone the runtime understands.
 *
 * @param value - The candidate zone identifier.
 * @returns True when `Intl` accepts the zone.
 */
export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks an optional imported file's size and extension/type hints.
 *
 * The `accept` attribute is only a browser hint, so the same gate is repeated
 * after selection. The check is deliberately permissive about MIME types because
 * some browsers report an empty type for `.csv` and `.md` files.
 *
 * @param file - The selected file.
 * @param label - Human name of the field, used in the error message.
 * @param allowedExtensions - Lower-case extensions including the dot.
 * @param maxBytes - Largest accepted file size.
 * @throws When the file is too large or has an unexpected extension.
 */
export function requireImportFile(
  file: File,
  label: string,
  allowedExtensions: string[],
  maxBytes: number = MAX_IMPORT_FILE_BYTES,
): void {
  if (file.size > maxBytes) {
    throw new Error(
      `${label} must be ${Math.round(maxBytes / 1000)} KB or smaller.`,
    );
  }

  const lowerName = file.name.toLowerCase();

  if (!allowedExtensions.some((extension) => lowerName.endsWith(extension))) {
    throw new Error(
      `${label} must be a ${allowedExtensions.join(" or ")} file.`,
    );
  }
}
