/*
 * The placeholder shown while a page's data loads.
 *
 * One animation for the whole app rather than a per-page sentence, so a slow load reads as
 * one product instead of a dozen different loading messages. The sentence stays in the
 * markup as its accessible name, which also covers anyone whose browser blocks the
 * animation or who cannot see it.
 */

import Image from "next/image";

/**
 * Renders the app-wide loading animation.
 *
 * The image is decorative (`alt=""`) and the label is announced through a live region, so a
 * screen reader hears what is loading rather than an unlabelled image.
 *
 * `unoptimized` is deliberate: the image optimizer re-encodes still frames and can flatten
 * an animated GIF, and this is a 9 KB decoration rather than a photograph worth optimising.
 *
 * `loading="eager"` is deliberate too: this placeholder is the first thing on screen while a
 * page resolves, so it is frequently the Largest Contentful Paint and should not wait on lazy
 * loading.
 *
 * @param props - {@link LoadingGifProps}
 * @returns The loading placeholder.
 */
export function LoadingGif({ label }: LoadingGifProps) {
  return (
    <span
      role="status"
      aria-live="polite"
      className="flex items-center justify-center"
    >
      <Image
        src="/loading/pikachu-running.gif"
        alt=""
        width={200}
        height={146}
        unoptimized
        loading="eager"
        className="h-20 w-auto"
      />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** Props for {@link LoadingGif}. */
interface LoadingGifProps {
  /** What is loading, announced to assistive technology. e.g. "Loading dashboard". */
  label: string;
}
