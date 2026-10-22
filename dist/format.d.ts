/** These strings end up in filenames and in the report, so every producer and
 *  reader of the format has to agree with them character for character. */
/** Two-digit zero pad. Every number that lands in a filename goes through this. */
export declare const pad2: (n: number) => string;
/** rec-01 — the folder one take lives in. Builder and report must agree. */
export declare function recDirName(index: number): string;
export declare function dateTime(ts: number): string;
export declare function hhmm(ts: number): string;
/** 4:32 — elapsed time inside a recording. */
export declare function mmss(ms: number): string;
/** 0432 — mmss without the colon, for filenames. */
export declare function mmssFile(ms: number): string;
