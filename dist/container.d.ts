/**
 * What to call the take's raw file, and what to declare it as. A live
 * MediaRecorder only ever hands over webm; an OS screen recorder writes
 * whatever it likes, and the report, the MANIFEST and any uploader all read
 * the name from one place — so it has to be the container that actually
 * arrived.
 */
export interface ClipContainer {
    videoFile: string;
    contentType: string;
}
export declare function containerFor(type: string, hasVideo: boolean): ClipContainer;
export declare function contentTypeFor(path: string): string;
