/**
 * The bits of the DOM every stage of the pipeline needs: an offscreen video
 * element to read a picked file through, seeks that can't hang forever, and a
 * canvas→JPEG encoder. Nothing here touches the DOM at module scope, so the
 * whole library stays importable from an SSR render.
 */
/**
 * A seek that never lands means a container we can't step through. Give up
 * rather than wedge — but slowly: a phone decoder under memory pressure can take
 * well past ten seconds on a single seek, and a run that dies there loses the
 * clip for a reason that was only ever "the hardware is busy". The timer freezes
 * with the tab when the screen goes off and resumes with it, which is the
 * behaviour we want.
 */
export declare const SEEK_TIMEOUT_MS = 20000;
/** Metadata for a file already on the device is instant; this is only a wedge guard. */
export declare const LOAD_TIMEOUT_MS = 30000;
export declare const UNREADABLE = "that file can't be read as a recording in this browser";
/** Offscreen, muted, inline: the element is a decoder, never something anyone sees. */
export declare function hiddenVideo(src: string): HTMLVideoElement;
/**
 * Wait until the element can actually give us pixels. Three things beyond a
 * plain `loadeddata` wait, all of them iOS:
 *
 *  - `canplay` and `loadeddata` both mean "there is a frame"; WebKit does not
 *    always fire the one you asked for, so take whichever arrives first.
 *  - a blob-URL video that has never played will sit at `readyState` 1 forever
 *    and hand back blank canvas reads. A muted play/pause wakes the decoder.
 *  - the whole wait shares one `LOAD_TIMEOUT_MS` budget, so a file that stalls
 *    in two places still fails inside the timeout the caller was promised.
 */
export declare function readyVideo(video: HTMLVideoElement, message: string, signal?: AbortSignal): Promise<void>;
/** Drop the decoder as well as the node — a mobile browser has very few of them. */
export declare function releaseVideo(video: HTMLVideoElement): void;
/** Resolve on the first of `events`; reject on 'error', after `timeoutMs`, or the moment `signal` fires. */
export declare function waitFor(el: HTMLVideoElement, events: string[], timeoutMs: number, message: string, signal?: AbortSignal): Promise<void>;
/** Seek and wait for the picture. Throws `message` if the seek doesn't land in time. */
export declare function seekTo(video: HTMLVideoElement, timeSec: number, message: string, signal?: AbortSignal): Promise<void>;
export declare function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob>;
