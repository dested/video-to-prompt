/** The fields judged; anything else on a segment rides along untouched. */
export interface TimedLine {
    t: number;
    d?: number;
    text: string;
}
/**
 * `segments` without the lines nobody said. `audio` is the mono PCM the
 * engine heard (segment times are ms into it), `sampleRate` its rate.
 */
export declare function dropUnheard<S extends TimedLine>(segments: S[], audio: Float32Array, sampleRate?: number): S[];
