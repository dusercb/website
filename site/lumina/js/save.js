// Saving the finished photo. Inside a Claude artifact the page asks the viewer through the
// `downloads` capability (the share sheet on iPhone, a download elsewhere). On an ordinary
// website it uses the phone's share sheet, then a normal download link.

let downloadsP = null;

export function prepareSaving() {
  if (window.claude?.use && !downloadsP) {
    downloadsP = window.claude.use('downloads').catch(() => null);
  }
}

// True when the page runs inside a viewer that blocks plain downloads.
export const framedByClaude = () => Boolean(window.claude?.use);

// Resolves 'saved' | 'shared' | 'downloaded' | 'declined' | 'busy' | 'manual'.
// 'manual' means no save route exists here; the caller shows the image to press and hold.
export async function saveBlob(blob, filename) {
  const dl = downloadsP ? await downloadsP : null;
  if (dl) {
    try {
      await dl.save({ filename, data: blob });
      return 'saved';
    } catch (e) {
      if (e?.code === 'declined') return 'declined';
      if (e?.code === 'rate_limited') return 'busy';
      return 'manual';
    }
  }
  if (framedByClaude()) return 'manual';

  const file = new File([blob], filename, { type: blob.type });
  const touch = matchMedia('(pointer: coarse)').matches;
  if (touch && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return 'shared';
    } catch (e) {
      if (e?.name === 'AbortError') return 'declined';
    }
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return 'downloaded';
}
