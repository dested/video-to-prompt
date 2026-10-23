/**
 * The clip's narration, decoded once for the transcriber: 16 kHz mono Float32.
 *
 * Two paths. The container is demuxed first (mediabunny) and only the audio
 * track's packets are read and decoded through WebCodecs, resampled in
 * half-minute chunks as they arrive: memory is the 16 kHz output and one chunk,
 * whatever the size of the video around it. The fallback is
 * `decodeAudioData` on the whole file in an OfflineAudioContext. It is simple
 * and universal, and it holds the entire file as one ArrayBuffer, which is what
 * kills a phone tab on a long screen recording.
 */
export declare const SAMPLE_RATE = 16000;
export interface DecodeOptions {
    signal?: AbortSignal;
}
/** Mixdown to mono at 16 kHz. Null when there's no decodable audio, or it's silent. */
export declare function decodeMono(file: Blob, opts?: DecodeOptions): Promise<Float32Array | null>;
/**
 * Float32 mono → a 16-bit PCM WAV blob at SAMPLE_RATE — the one container every
 * speech API accepts without a codec. Hand-rolled because the platform has no
 * encoder and the format's 44-byte header is shorter than any dependency.
 */
export declare function encodeWav(samples: Float32Array): Blob;
