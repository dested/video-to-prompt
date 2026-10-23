/** These strings end up in filenames and in the report, so every producer and
 *  reader of the format has to agree with them character for character. */
/** Two-digit zero pad. Every number that lands in a filename goes through this. */
export const pad2 = (n) => String(n).padStart(2, '0');
const pad = pad2;
/** rec-01 — the folder one take lives in. Builder and report must agree. */
export function recDirName(index) {
    return `rec-${pad2(index)}`;
}
export function dateTime(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function hhmm(ts) {
    const d = new Date(ts);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** 4:32 — elapsed time inside a recording. */
export function mmss(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(total / 60)}:${pad(total % 60)}`;
}
/** 0432 — mmss without the colon, for filenames. */
export function mmssFile(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    return `${pad(Math.floor(total / 60))}${pad(total % 60)}`;
}
