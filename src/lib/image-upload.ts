/*
 * Browser-side image normalization for uploaded profile and league images.
 *
 * Both surfaces accept the same formats and enforce the same limits, so the
 * validation and WebP re-encoding live here rather than being duplicated in two
 * page components. The output is a small WebP file suitable for Supabase
 * Storage, which keeps uploads predictable regardless of the source image.
 */

/** File types accepted for an uploaded image. */
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

/** Largest source image accepted, in bytes. */
const MAX_IMAGE_SIZE_BYTES = 100 * 1024;

/** Longest edge of the stored image, in pixels. */
const MAX_IMAGE_DIMENSION = 512;

/** WebP quality used when re-encoding the image. */
const WEBP_QUALITY = 0.75;

/**
 * Reads a file as a data URL.
 *
 * @param file - The file to read.
 * @returns A promise resolving to the data URL.
 */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Failed to read image file."));
    reader.readAsDataURL(file);
  });
}

/**
 * Loads an image element from a data URL.
 *
 * @param dataUrl - The image data URL.
 * @returns A promise resolving to the loaded image.
 */
function loadImageFromDataUrl(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Invalid image file."));
    image.src = dataUrl;
  });
}

/**
 * Validates and compresses an uploaded image to WebP.
 *
 * Accepts PNG, JPG, and WebP up to 100 KB. The image is scaled down so its
 * longest edge is 512 pixels before being encoded at 75% quality, matching the
 * format used by profile avatars.
 *
 * @param file - The source image file.
 * @param namePrefix - Prefix for the generated file name, e.g. `"avatar"`.
 * @returns A promise resolving to the compressed WebP file.
 * @throws If the type or size is not allowed, or the browser cannot encode it.
 */
export async function compressImageFile(
  file: File,
  namePrefix: string,
): Promise<File> {
  if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
    throw new Error("Only PNG, JPG, and WebP images are allowed.");
  }

  if (file.size > MAX_IMAGE_SIZE_BYTES) {
    throw new Error("Image must be 100 KB or smaller.");
  }

  const dataUrl = await fileToDataUrl(file);
  const image = await loadImageFromDataUrl(dataUrl);
  let width = image.width;
  let height = image.height;

  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    const scale = Math.min(
      MAX_IMAGE_DIMENSION / width,
      MAX_IMAGE_DIMENSION / height,
      1,
    );
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Unable to process image data in this browser.");
  }

  context.drawImage(image, 0, 0, width, height);

  const compressedBlob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Image compression failed."));
          return;
        }
        resolve(blob);
      },
      "image/webp",
      WEBP_QUALITY,
    );
  });

  return new File([compressedBlob], `${namePrefix}-${Date.now()}.webp`, {
    type: "image/webp",
    lastModified: Date.now(),
  });
}
