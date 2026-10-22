/**
 * What to call the take's raw file, and what to declare it as. A live
 * MediaRecorder only ever hands over webm; an OS screen recorder writes
 * whatever it likes, and the report, the MANIFEST and any uploader all read
 * the name from one place — so it has to be the container that actually
 * arrived.
 */
export function containerFor(type, hasVideo) {
    const mime = (type.split(';')[0] ?? '').trim().toLowerCase();
    switch (mime) {
        case 'video/mp4':
            return { videoFile: 'walkthrough.mp4', contentType: 'video/mp4' };
        case 'video/webm':
            return { videoFile: 'walkthrough.webm', contentType: 'video/webm' };
        case 'video/quicktime':
            return { videoFile: 'walkthrough.mov', contentType: 'video/quicktime' };
        case 'audio/mp4':
        case 'audio/x-m4a':
        case 'audio/aac':
            // One name for the whole m4a family; x-m4a and aac are not content types storage should learn.
            return { videoFile: 'walkthrough.m4a', contentType: 'audio/mp4' };
        case 'audio/webm':
            return { videoFile: 'walkthrough.webm', contentType: 'audio/webm' };
        case 'audio/mpeg':
            return { videoFile: 'walkthrough.mp3', contentType: 'audio/mpeg' };
    }
    if (mime.startsWith('video/'))
        return { videoFile: 'walkthrough.mp4', contentType: mime };
    if (mime.startsWith('audio/'))
        return { videoFile: 'walkthrough.m4a', contentType: mime };
    // Some Android pickers hand over a file with no type at all; the probe already
    // knows whether there were pixels in it.
    return hasVideo
        ? { videoFile: 'walkthrough.mp4', contentType: 'video/mp4' }
        : { videoFile: 'walkthrough.m4a', contentType: 'audio/mp4' };
}
/** Same table wherever a file of the set is declared, so every producer agrees. */
const CONTENT_TYPES = {
    md: 'text/markdown',
    txt: 'text/plain',
    json: 'application/json',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webm: 'video/webm',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    m4a: 'audio/mp4',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
};
export function contentTypeFor(path) {
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}
