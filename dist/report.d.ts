import type { FrameBox, Recording, RecordingFrame, RecordingMeta, Session } from './types.js';
/**
 * The walkthrough's prose, its per-take JSON and its listing. Written for a
 * coding agent first and a human second.
 *
 * Format 2 rewrote report.md for readers like Opus 5.5, which need orienting,
 * not instructing: a short paragraph on what this is and how far to trust the
 * words, a ranked handful of frames to open first, the contact sheets, then
 * one timeline where every frame is a line saying what changed and where, and
 * every spoken line names the frame that best shows it. Every image path is
 * relative, so the file set can move.
 *
 * Product wording (who recorded it, where the files resolve, whether the text
 * lines are speech or a tool's action log) comes in through `ReportOptions`;
 * the format itself carries no brand.
 */
/** Everything a consumer may want to say about itself inside the report. All optional. */
export interface ReportOptions {
    /** Where this walkthrough lives — a URL an agent can act on. Omitted = no link is printed. */
    url?: string;
    /** Continues the url line: how to pull the referenced files given that URL (e.g. "pull them with the `get_walkthrough` MCP tool"). */
    urlHint?: string;
    /** Names the producer in the report footer and the MANIFEST `source:` line. */
    source?: string;
    /** Where the relative paths resolve for this reader. Default: the folder, if downloaded. */
    pathsHint?: string;
    /** Who rewrote the transcript wording when a polish pass ran (e.g. "Claude"). */
    polishedBy?: string;
    /**
     * What the text lines are. 'speech' (default): a person narrating, transcribed.
     * 'log': a tool's own action log, exact. Changes every word the report uses
     * for them.
     */
    narration?: 'speech' | 'log';
    /** Who wrote the action log, for narration 'log' (e.g. "bx"). */
    narrationBy?: string;
    /** Replaces the report's opening sentence (what this recording is). */
    intro?: string;
    /** Where a take's video lives, when it isn't `rec-NN/<videoFile>`. */
    videoPath?: (part: number, videoFile: string) => string;
    /**
     * Stretches the host removed after recording (a reviewer's cut). Frames,
     * lines and errors inside them are left out, and the timeline marks each gap.
     * The video and the contact sheets can't be redrawn, so they still show it.
     */
    cuts?: ReportCut[];
    /**
     * One-sentence captions of frames, by walkthrough-relative path, written by a
     * model that looked at them. Printed beside the frame as `shows:`, labelled as
     * a model's reading.
     */
    captions?: Record<string, string>;
}
/** A stretch of the walkthrough's axis, in ms from its start, that no longer counts. */
export interface ReportCut {
    fromMs: number;
    toMs: number;
    /** Why, in a few words ("false start"). Printed in the timeline. */
    reason?: string;
}
/**
 * Paths inside a take are stored take-relative; the report reads from the
 * walkthrough root. Exported because a consumer's uploader has to send this
 * exact path — the citation and the upload are built by one function so they
 * cannot drift.
 */
export declare function sheetFile(n: number, prefix?: string): string;
/** "top-right", "across the bottom", "center": where on screen a box sits. */
export declare function whereOnScreen(box: FrameBox): string;
export interface RankedFrame {
    /** Walkthrough-relative path: `rec-01/frames/03-0005.jpg`. */
    path: string;
    /** Position on the walkthrough's axis, ms. */
    pos: number;
    part: number;
    frame: RecordingFrame;
    score: number;
    /** What the frame shows, in words. */
    what: string;
    /** The line it best illustrates, if any. */
    line?: string;
    /** The captured error nearest it (within 3 s), if any. */
    error?: string;
}
/**
 * The frames that carry the most evidence, in time order: 3–6 of them, more
 * for longer walkthroughs. The report's "Start here" list; exported so a host
 * that hands an agent images directly (an MCP tool) sends the same ones.
 */
export declare function rankFrames(recordings: Recording[], options?: Pick<ReportOptions, 'cuts'>): RankedFrame[];
/** What the recording holds at one moment: the line said there, the frame that shows it, an error beside it. */
export interface Evidence {
    line?: {
        text: string;
        pos: number;
        end: number;
        speaker?: number;
    };
    frame?: {
        path: string;
        pos: number;
        what: string;
    };
    error?: {
        message: string;
        pos: number;
    };
}
/**
 * The evidence for a moment on the walkthrough's axis, such as a point a
 * summary pinned to "1:42": the spoken line there (or nearest), the frame that
 * best shows that line, and a captured error within 3 s of the frame. With no
 * line nearby, the frame on screen at that moment.
 */
export declare function evidenceAt(recordings: Recording[], posMs: number, options?: Pick<ReportOptions, 'cuts'>): Evidence;
/** One report for the whole walkthrough, in axis order. */
export declare function buildReport(session: Session, recordings: Recording[], options?: ReportOptions): string;
export declare function buildTranscriptTxt(rec: RecordingMeta): string;
/**
 * One take, machine-readable. The shape is the format's contract: a viewer, an
 * uploader or a re-push tool can re-derive a walkthrough's takes from these
 * files alone. Format 2 only adds fields.
 */
export declare function buildRecordingJson(session: Session, recording: Recording, url?: string): string;
/** Stats up top, transcripts inline — the whole walkthrough's file set, listed. */
export declare function buildManifestTxt(session: Session, recordings: Recording[], options?: ReportOptions): string;
