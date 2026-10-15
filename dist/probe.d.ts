export interface ClipProbe {
    durationMs: number;
    width: number;
    height: number;
    hasVideo: boolean;
    /** An objectURL the caller owns and must revoke. Null for audio-only clips. */
    posterUrl: string | null;
}
export interface ProbeOptions {
    /** Make the poster still. Default true; a pipeline that never shows one should say false. */
    poster?: boolean;
    signal?: AbortSignal;
}
export declare function probeClip(file: File, opts?: ProbeOptions): Promise<ClipProbe>;
