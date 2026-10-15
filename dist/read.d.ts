import type { Recording, Session } from './types.js';
/**
 * recording.json back into the recording shapes, so a reader that only holds
 * the files (a server, a CLI) can run the same report writers. Pure; no DOM.
 *
 * Tolerant on purpose: it reads every recording.json this format has produced,
 * format 1 included, from the library, Handback's web pipeline and its
 * extension. A field that is missing or the wrong type is dropped, never
 * guessed. Only a file with no `recording` object at all is refused.
 *
 * Round trip: buildRecordingJson → readRecordingJson → buildReport gives the
 * report the original produced. Spoken lengths come back from each line's
 * `endMs`, and event times from `tMs`, or from their m:ss stamps on files
 * older than that.
 */
/** One take as its recording.json describes it. */
export interface ReadTake {
    /**
     * The walkthrough as this take's file names it. A host with its own record
     * (a renamed title, a database id) should build the Session from that instead.
     */
    session: Session;
    recording: Recording;
    /** The walkthrough's URL, when the file carries one. */
    url?: string;
}
/**
 * Parse one take's recording.json (its text, or the value already parsed).
 * Null when it isn't JSON or carries no `recording` object.
 */
export declare function readRecordingJson(input: unknown): ReadTake | null;
