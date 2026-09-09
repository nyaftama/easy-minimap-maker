/**
 * download-helper.js
 * ユーザーエージェント(navigator.userAgentData)に基づくデスクトップ/モバイル判定と、
 * デスクトップ時の直接ダウンロード ＆ モバイル/タブレット時の共有メニュー (Web Share API) 連携
 */

/**
 * デスクトップ端末か、スマートフォン/タブレット端末かを判定
 * @returns {boolean} モバイルまたはタブレットなら true
 */
export function isMobileOrTablet() {
    // 1. Client Hints API (Chromium系デスクトップ/モバイル)
    if (typeof navigator.userAgentData !== 'undefined' && typeof navigator.userAgentData.mobile === 'boolean') {
        return navigator.userAgentData.mobile;
    }

    // 2. Safari / iOS / iPadOS / Firefox 向けのフォールバック判定
    const ua = navigator.userAgent || '';
    const platform = navigator.platform || '';
    const maxTouchPoints = navigator.maxTouchPoints || 0;

    // iPadOS 13+ (MacIntel かつ マルチタッチ対応)
    const isIPad = platform === 'MacIntel' && maxTouchPoints > 1;
    const isMobileUA = /iPhone|iPod|iPad|Android|Mobile|Silk|Kindle|BlackBerry|Opera Mini|IEMobile/i.test(ua);

    return isIPad || isMobileUA;
}

/**
 * ファイルの保存または共有 (モバイル/タブレットは Web Share API、デスクトップは直接ダウンロード)
 * @param {Blob} blob - 保存・共有対象のBlob
 * @param {string} filename - 保存時のファイル名
 * @param {string} [title] - 共有メニュー用タイトル
 */
export async function saveOrShareFile(blob, filename, title = '') {
    const mobile = isMobileOrTablet();

    // 通常のアンカータグ (<a download>) によるダウンロード
    const downloadDirectly = () => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    };

    // スマートフォンまたはタブレット環境で Web Share API (ファイル共有) が利用可能な場合
    if (mobile && typeof navigator.share === 'function') {
        try {
            const mimeType = blob.type || (filename.endsWith('.mp4') ? 'video/mp4' : (filename.endsWith('.zip') ? 'application/zip' : 'application/octet-stream'));
            const file = new File([blob], filename, { type: mimeType });

            if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
                await navigator.share({
                    files: [file],
                    title: title || filename
                });
                return;
            }
        } catch (err) {
            // ユーザーが共有シートをキャンセルした場合は通常ダウンロードを発火させない
            if (err.name === 'AbortError') {
                return;
            }
            console.warn('[DownloadHelper] Web Share failed, falling back to direct download:', err);
        }
    }

    // デスクトップ、または共有非対応/失敗時のフォールバック
    downloadDirectly();
}
