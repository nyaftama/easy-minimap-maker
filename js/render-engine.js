/**
 * render-engine.js
 * 720x720 Canvas オフスクリーンレンダラー
 * - OSM タイル事前キャッシュ & Web Mercator描画
 * - 地図スケール（100% / 150% / 200%）による文字・縮尺マーカー拡大
 * - 円形 / 正方形ワイプクリッピング & クロマキー背景 (#00FF00等)
 * - 移動軌跡 (Polyline) & 現在地マーカー
 * - 縮尺スケールバー & OSM著作権表記
 */

import { RouteInterpolator } from './interpolator.js?v=1.00b';

/** HEXカラーを RGBA 文字列に変換 */
function hexToRgba(hex, alpha = 1) {
    if (!hex) return `rgba(37, 99, 235, ${alpha})`;
    let c = hex.replace('#', '');
    if (c.length === 3) c = c.split('').map(x => x + x).join('');
    const num = parseInt(c, 16);
    if (isNaN(num)) return `rgba(37, 99, 235, ${alpha})`;
    const r = (num >> 16) & 255;
    const g = (num >> 8) & 255;
    const b = num & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** 編集画面の Leaflet マーカーと100%同一の見た目を再現する SVG 文字列を生成 (案A) */
function generateMarkerSvg(markerColor = '#2563eb') {
    let color = '#2563eb';
    if (typeof markerColor === 'string') {
        const trimmed = markerColor.trim();
        if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(trimmed)) {
            color = trimmed;
        }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <defs>
    <filter id="marker-glow" x="-50%" y="-50%" width="200%" height="200%">
      <feDropShadow dx="0" dy="0" stdDeviation="2.5" flood-color="${color}" flood-opacity="0.85"/>
      <feDropShadow dx="0" dy="1" stdDeviation="2" flood-color="#000000" flood-opacity="0.35"/>
    </filter>
  </defs>
  <!-- 1. 外側の波紋リング & オーラ (半径16px, 直径32px相当) -->
  <circle cx="32" cy="32" r="16" fill="${color}" fill-opacity="0.18" stroke="${color}" stroke-width="1.8" stroke-opacity="0.6"/>
  <!-- 2. 白枠の土台円 (半径10px, 直径20px相当) ＋ グロー光彩 -->
  <circle cx="32" cy="32" r="10" fill="#ffffff" filter="url(#marker-glow)"/>
  <!-- 3. 中心の指定色円 (半径7px, 直径14px相当) -->
  <circle cx="32" cy="32" r="7" fill="${color}"/>
</svg>`;
}

/** 編集画面の Leaflet マーカーピン (.map-kf-pin) と100%同一の見た目を再現する SVG 文字列を生成 */
export function generatePinSvg(label, isPause = false, mapScale = 2.0) {
    const pinScale = mapScale >= 1.5 ? 1.25 : 1.0;
    const pinSize = Math.round(18 * pinScale);
    const radius = 2.5 * pinScale;
    const strokeWidth = Math.round(2 * pinScale);
    const shadowDy = 1.5 * pinScale;
    const shadowDev = 2.0 * pinScale;
    const fontSize = Math.round(10 * pinScale);
    const bgColor = isPause ? '#ef4444' : '#2563eb';

    // 48x48 の中心 (24, 24) に描画
    const boxSize = 48;
    const center = 24;
    const rectX = (boxSize - pinSize) / 2;
    const rectY = (boxSize - pinSize) / 2;

    const safeLabel = String(label).replace(/[<>&"]/g, '');

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${boxSize}" height="${boxSize}" viewBox="0 0 ${boxSize} ${boxSize}">
  <defs>
    <filter id="pin-shadow" x="-50%" y="-50%" width="200%" height="200%">
      <feDropShadow dx="0" dy="${shadowDy.toFixed(2)}" stdDeviation="${shadowDev.toFixed(2)}" flood-color="#000000" flood-opacity="0.45"/>
    </filter>
  </defs>
  <g filter="url(#pin-shadow)">
    <rect x="${rectX.toFixed(2)}" y="${rectY.toFixed(2)}" width="${pinSize}" height="${pinSize}" rx="${radius.toFixed(2)}" transform="rotate(45 ${center} ${center})" fill="${bgColor}" stroke="#ffffff" stroke-width="${strokeWidth}"/>
  </g>
  <text x="${center}" y="${(center + 0.6).toFixed(2)}" fill="#ffffff" font-size="${fontSize}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-weight="800" text-anchor="middle" dominant-baseline="central">${safeLabel}</text>
</svg>`;
}

export class RenderEngine {
    constructor() {
        this.width = 720;
        this.height = 720;
        this.canvas = document.createElement('canvas');
        this.canvas.width = this.width;
        this.canvas.height = this.height;
        this.ctx = this.canvas.getContext('2d', { alpha: false });

        // タイルキャッシュ: "z/x/y" -> ImageBitmap
        this.tileCache = new Map();

        // 現在地マーカーの事前レンダリングキャッシュ (案A: SVGスタンプ)
        this.markerCache = null;
        this.markerCacheColor = null;

        // キーフレームピンの事前レンダリングキャッシュ: cacheKey -> HTMLImageElement
        this.pinCache = new Map();
    }

    /**
     * 現在地マーカーSVGの事前準備（画像化 & キャッシュ）
     * @param {string} markerColor
     * @returns {Promise<ImageBitmap|HTMLImageElement>}
     */
    async prepareMarker(markerColor = '#2563eb') {
        const key = markerColor;
        if (this.markerCache && this.markerCacheColor === key) {
            return this.markerCache;
        }

        const svg = generateMarkerSvg(markerColor);
        const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(blob);

        return new Promise((resolve) => {
            const img = new Image();
            img.onload = async () => {
                URL.revokeObjectURL(url);
                try {
                    if ('createImageBitmap' in window) {
                        this.markerCache = await createImageBitmap(img);
                    } else {
                        this.markerCache = img;
                    }
                } catch (e) {
                    this.markerCache = img;
                }
                this.markerCacheColor = key;
                resolve(this.markerCache);
            };
            img.onerror = () => {
                URL.revokeObjectURL(url);
                this.markerCache = null;
                resolve(null);
            };
            img.src = url;
        });
    }

    /**
     * 全キーフレームのピン画像を事前ラスタライズしてキャッシュ
     * @param {Array} keyframes - 全キーフレーム
     * @param {number} mapScale - 地図スケール
     * @returns {Promise<void>}
     */
    async preparePins(keyframes, mapScale = 2.0) {
        this.pinCache = new Map();
        if (!keyframes || keyframes.length === 0) return;

        // 地点番号マップを生成 (一時停止ペアは同一番号)
        let spotCount = 0;
        const spotLabels = new Map();
        for (let i = 0; i < keyframes.length; i++) {
            const kf = keyframes[i];
            if (kf.type === 'pause_end' && kf.pairId) {
                const startLabel = spotLabels.get(kf.pairId) || (spotCount === 0 ? 'S' : `${spotCount}`);
                spotLabels.set(kf.id, startLabel);
            } else {
                const currentLabel = (spotCount === 0) ? 'S' : `${spotCount}`;
                spotLabels.set(kf.id, currentLabel);
                spotCount++;
            }
        }

        const promises = [];
        const preparedKeys = new Set();

        for (const kf of keyframes) {
            const isPause = kf.type === 'pause_start' || kf.type === 'pause_end';
            const label = spotLabels.get(kf.id) || 'S';
            const cacheKey = `${label}_${isPause ? 'pause' : 'normal'}_${mapScale}`;

            if (preparedKeys.has(cacheKey)) continue;
            preparedKeys.add(cacheKey);

            const svgStr = generatePinSvg(label, isPause, mapScale);
            const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const img = new Image();

            const p = new Promise((resolve) => {
                img.onload = () => {
                    this.pinCache.set(cacheKey, img);
                    URL.revokeObjectURL(url);
                    resolve();
                };
                img.onerror = (e) => {
                    console.warn('[VRM RenderEngine] Pin image failed to load for', cacheKey, e);
                    URL.revokeObjectURL(url);
                    resolve();
                };
                img.src = url;
            });
            promises.push(p);
        }

        await Promise.all(promises);
        console.log('[VRM RenderEngine] Prepared', this.pinCache.size, 'pin stamps');
    }

    /**
     * 必要なOSMタイルを事前にダウンロードしてキャッシュ
     * @param {Array} keyframes - 全キーフレーム
     * @param {number} zoom - レンダリングズーム
     * @param {Function} onProgress - (percent, statusText) => void
     */
    async preloadTiles(keyframes, zoom = 16, mapScale = 2.0, onProgress = null) {
        if (!keyframes || keyframes.length === 0) return;

        // 第3引数が関数の場合の互換性対応 (onProgress が第3引数に渡された場合)
        let actualScale = 2.0;
        let actualOnProgress = onProgress;
        if (typeof mapScale === 'function') {
            actualOnProgress = mapScale;
            actualScale = 2.0;
        } else if (mapScale !== undefined && mapScale !== null) {
            actualScale = Number(mapScale) || 2.0;
        }

        const w = this.width;
        const h = this.height;
        const cx = w / 2;
        const cy = h / 2;

        // 画面半径に対応するワールドピクセルサイズ（余白 +64px 付き）
        const halfWorldW = (cx / actualScale) + 64;
        const halfWorldH = (cy / actualScale) + 64;

        // ルート上の全フレームに必要なタイルキー (z/x/y) を収集する Set
        const neededTiles = new Set();

        const addCoordsAtLatLng = (lat, lng) => {
            const centerWorld = RouteInterpolator.latLngToWorldPixel(lat, lng, zoom);
            const startX = Math.floor((centerWorld.x - halfWorldW) / 256);
            const endX = Math.floor((centerWorld.x + halfWorldW) / 256);
            const startY = Math.floor((centerWorld.y - halfWorldH) / 256);
            const endY = Math.floor((centerWorld.y + halfWorldH) / 256);

            for (let tx = startX; tx <= endX; tx++) {
                for (let ty = startY; ty <= endY; ty++) {
                    neededTiles.add(`${zoom}/${tx}/${ty}`);
                }
            }
        };

        // 1. 各キーフレーム地点のタイルを追加
        keyframes.forEach(kf => addCoordsAtLatLng(kf.lat, kf.lng));

        // 2. 移動区間（キーフレーム間）を 0.25秒刻みでサンプリングして通過ルートの全タイルを網羅
        const duration = keyframes[keyframes.length - 1]?.time || 0;
        const sampleStep = 0.25;
        for (let t = 0; t <= duration; t += sampleStep) {
            const pos = RouteInterpolator.interpolate(keyframes, t);
            if (pos) {
                addCoordsAtLatLng(pos.lat, pos.lng);
            }
        }

        // キャッシュ未所持のタイルリストを作成
        const tileList = [];
        for (const key of neededTiles) {
            if (!this.tileCache.has(key)) {
                const parts = key.split('/');
                tileList.push({
                    z: parseInt(parts[0], 10),
                    x: parseInt(parts[1], 10),
                    y: parseInt(parts[2], 10),
                    key
                });
            }
        }

        const total = tileList.length;
        if (total === 0) {
            if (actualOnProgress) actualOnProgress(100, 'タイルキャッシュ完了');
            return;
        }

        let loaded = 0;
        const concurrency = 4; // 同時4並行フェッチ

        // 個別タイル取得（リトライ付き）
        const fetchTileWithRetry = async (item) => {
            const url = `https://tile.openstreetmap.org/${item.z}/${item.x}/${item.y}.png`;
            let attempts = 0;
            const maxAttempts = 3;
            while (attempts < maxAttempts) {
                attempts++;
                try {
                    const res = await fetch(url);
                    if (res.ok) {
                        const blob = await res.blob();
                        const bitmap = await createImageBitmap(blob);
                        this.tileCache.set(item.key, bitmap);
                        return;
                    }
                    if (res.status === 429 || res.status >= 500) {
                        await new Promise(r => setTimeout(r, attempts * 300));
                    }
                } catch (e) {
                    if (attempts < maxAttempts) {
                        await new Promise(r => setTimeout(r, attempts * 250));
                    }
                }
            }
            console.warn(`Tile fetch failed after retries: ${item.key}`);
        };

        let index = 0;
        const worker = async () => {
            while (index < tileList.length) {
                const currentItem = tileList[index++];
                await fetchTileWithRetry(currentItem);
                loaded++;
                if (actualOnProgress) {
                    const percent = Math.round((loaded / total) * 100);
                    actualOnProgress(percent, `地図タイル読み込み中... (${loaded}/${total})`);
                }
            }
        };

        const workers = [];
        for (let i = 0; i < Math.min(concurrency, tileList.length); i++) {
            workers.push(worker());
        }
        await Promise.all(workers);
    }

    /**
     * 1フレームの描画処理
     * @param {Object} currentPos - { lat, lng, zoom }
     * @param {Array} keyframes - 全キーフレーム
     * @param {number} currentTime - 現在時刻（秒）
     * @param {Object} settings - { shape, chromaColor, showScale, showRoute, showPins, markerColor, mapScale, zoom }
     * @returns {HTMLCanvasElement}
     */
    renderFrame(currentPos, keyframes, currentTime, settings) {
        const ctx = this.ctx;
        const w = this.width;
        const h = this.height;
        const cx = w / 2;
        const cy = h / 2;
        // 固定ズーム設定（未指定時は現在のキーフレームズームにフォールバック）
        const zoom = Math.round((settings.zoom !== undefined && settings.zoom !== null) ? settings.zoom : (currentPos.zoom || 16));
        const mapScale = Number(settings.mapScale) || 2.0;

        // 1. 背景をクロマキー色で全面塗りつぶし
        ctx.save();
        ctx.fillStyle = settings.chromaColor || '#00FF00';
        ctx.fillRect(0, 0, w, h);

        // 2. ワイプ形状のクリッピングパス作成
        ctx.beginPath();
        if (settings.shape === 'circle') {
            const radius = 330;
            ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        } else {
            // square: 680x680 角丸24px
            const size = 680;
            const r = 24;
            const x = (w - size) / 2;
            const y = (h - size) / 2;
            ctx.roundRect(x, y, size, size, r);
        }
        ctx.clip();

        // 3. OSM 地図タイルの描画 (mapScale による文字・地図拡大対応)
        const centerWorld = RouteInterpolator.latLngToWorldPixel(currentPos.lat, currentPos.lng, zoom);

        // 画面の半径 (cx, cy) に対応するワールドピクセル幅・高さを mapScale で除算
        const halfWorldW = cx / mapScale;
        const halfWorldH = cy / mapScale;

        const startWorldX = centerWorld.x - halfWorldW;
        const startWorldY = centerWorld.y - halfWorldH;
        const endWorldX = centerWorld.x + halfWorldW;
        const endWorldY = centerWorld.y + halfWorldH;

        const startTileX = Math.floor(startWorldX / 256);
        const endTileX = Math.floor(endWorldX / 256);
        const startTileY = Math.floor(startWorldY / 256);
        const endTileY = Math.floor(endWorldY / 256);

        // タイルの背景（フォールバック色）
        ctx.fillStyle = '#e5e3df';
        ctx.fillRect(0, 0, w, h);

        const drawnTileSize = 256 * mapScale;

        for (let tx = startTileX; tx <= endTileX; tx++) {
            for (let ty = startTileY; ty <= endTileY; ty++) {
                const key = `${zoom}/${tx}/${ty}`;
                const bitmap = this.tileCache.get(key);
                const tileScreenX = cx + (tx * 256 - centerWorld.x) * mapScale;
                const tileScreenY = cy + (ty * 256 - centerWorld.y) * mapScale;

                if (bitmap) {
                    ctx.drawImage(bitmap, tileScreenX, tileScreenY, drawnTileSize, drawnTileSize);
                } else {
                    // キャッシュなし時のプレースホルダー枠
                    ctx.strokeStyle = '#d0d7de';
                    ctx.strokeRect(tileScreenX, tileScreenY, drawnTileSize, drawnTileSize);
                }
            }
        }

        // 4. 移動軌跡 (Polyline) の描画
        if (settings.showRoute && keyframes.length >= 2) {
            const baseLineWidth = Math.round(6 * (mapScale >= 1.5 ? 1.25 : 1.0));

            // (A) 全体予定ルート (半透明ブルー)
            ctx.beginPath();
            keyframes.forEach((kf, idx) => {
                const wp = RouteInterpolator.latLngToWorldPixel(kf.lat, kf.lng, zoom);
                const sx = cx + (wp.x - centerWorld.x) * mapScale;
                const sy = cy + (wp.y - centerWorld.y) * mapScale;
                if (idx === 0) ctx.moveTo(sx, sy);
                else ctx.lineTo(sx, sy);
            });
            ctx.strokeStyle = 'rgba(37, 99, 235, 0.5)';
            ctx.lineWidth = baseLineWidth;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.stroke();

            // (B) 通過済みルート (鮮やかなレッド)
            ctx.beginPath();
            let hasPoint = false;
            for (const kf of keyframes) {
                if (kf.time <= currentTime) {
                    const wp = RouteInterpolator.latLngToWorldPixel(kf.lat, kf.lng, zoom);
                    const sx = cx + (wp.x - centerWorld.x) * mapScale;
                    const sy = cy + (wp.y - centerWorld.y) * mapScale;
                    if (!hasPoint) {
                        ctx.moveTo(sx, sy);
                        hasPoint = true;
                    } else {
                        ctx.lineTo(sx, sy);
                    }
                } else {
                    break;
                }
            }
            if (hasPoint) {
                ctx.lineTo(cx, cy);
                ctx.strokeStyle = '#ef4444';
                ctx.lineWidth = baseLineWidth + 1;
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                ctx.stroke();
            }
            ctx.beginPath(); // パスを確実にクリア
        }

        // 5. 通過地点（キーフレームピン）の描画 (settings.showPins !== false の場合)
        if (settings.showPins !== false && keyframes && keyframes.length > 0) {
            const pinScale = mapScale >= 1.5 ? 1.25 : 1.0;
            const pinSize = Math.round(18 * pinScale);
            const halfPin = pinSize / 2;

            // 地点番号マップを生成 (一時停止ペアは同一番号)
            let spotCount = 0;
            const spotLabels = new Map();
            for (let i = 0; i < keyframes.length; i++) {
                const kf = keyframes[i];
                if (kf.type === 'pause_end' && kf.pairId) {
                    const startLabel = spotLabels.get(kf.pairId) || (spotCount === 0 ? 'S' : `${spotCount}`);
                    spotLabels.set(kf.id, startLabel);
                } else {
                    const currentLabel = (spotCount === 0) ? 'S' : `${spotCount}`;
                    spotLabels.set(kf.id, currentLabel);
                    spotCount++;
                }
            }

            // 重複描画（一時停止開始・終了が同座標の場合）を防止するための描画済み座標セット
            const drawnSpots = new Set();

            keyframes.forEach(kf => {
                const coordKey = `${kf.lat.toFixed(6)},${kf.lng.toFixed(6)}`;
                if (drawnSpots.has(coordKey)) return;
                drawnSpots.add(coordKey);

                const wp = RouteInterpolator.latLngToWorldPixel(kf.lat, kf.lng, zoom);
                const sx = cx + (wp.x - centerWorld.x) * mapScale;
                const sy = cy + (wp.y - centerWorld.y) * mapScale;

                // 画面外（余白50px以上）なら描画スキップ
                if (sx < -50 || sx > w + 50 || sy < -50 || sy > h + 50) return;

                const isPause = kf.type === 'pause_start' || kf.type === 'pause_end';
                const label = spotLabels.get(kf.id) || 'S';
                const cacheKey = `${label}_${isPause ? 'pause' : 'normal'}_${mapScale}`;

                const pinStamp = this.pinCache?.get(cacheKey);
                if (pinStamp) {
                    // 事前ラスタライズ SVG スタンプによる確実なベタ塗り描画 (48x48 の中心 24, 24)
                    ctx.drawImage(
                        pinStamp,
                        Math.round(sx - 24),
                        Math.round(sy - 24),
                        48,
                        48
                    );
                } else {
                    // フォールバック: 直接 Canvas 描画（完全なシャドウ・パス分離）
                    ctx.save();
                    ctx.translate(sx, sy);
                    ctx.rotate(Math.PI / 4); // 45度回転でタイムライン・マップと同様の菱形に

                    // 1. 菱形背景 (一時停止は赤、通常は青) + ドロップシャドウ
                    ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
                    ctx.shadowBlur = Math.round(4 * pinScale);
                    ctx.shadowOffsetY = Math.round(1.5 * pinScale);
                    ctx.fillStyle = isPause ? '#ef4444' : '#2563eb';
                    ctx.beginPath();
                    ctx.roundRect(-halfPin, -halfPin, pinSize, pinSize, 2.5 * pinScale);
                    ctx.fill();

                    // 2. 白い外枠線 (シャドウを完全にゼロリセットして再描画)
                    ctx.shadowColor = 'transparent';
                    ctx.shadowBlur = 0;
                    ctx.shadowOffsetY = 0;
                    ctx.strokeStyle = '#ffffff';
                    ctx.lineWidth = Math.round(2 * pinScale);
                    ctx.beginPath();
                    ctx.roundRect(-halfPin, -halfPin, pinSize, pinSize, 2.5 * pinScale);
                    ctx.stroke();

                    // 3. テキスト（正立させるため -45度回転）
                    ctx.rotate(-Math.PI / 4);
                    ctx.fillStyle = '#ffffff';
                    ctx.font = `800 ${Math.round(10 * pinScale)}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(label, 0, 0);

                    ctx.restore();
                }
            });
        }

        // 6. 現在地マーカーの描画 (画面中心 cx, cy)
        // 案A: 編集画面のLeafletマーカーと100%同一デザインのSVGスタンプを描画 (青丸＋白枠＋グロー影＋外側リング)
        const markerScale = mapScale >= 1.5 ? 1.3 : 1.0;
        const drawSize = Math.round(64 * markerScale);
        const halfDraw = drawSize / 2;

        if (this.markerCache) {
            ctx.drawImage(
                this.markerCache,
                Math.round(cx - halfDraw),
                Math.round(cy - halfDraw),
                drawSize,
                drawSize
            );
        } else {
            // 万が一の同期フォールバック直接描画（SVGと同一比率の同心円）
            let markerColor = '#2563eb';
            if (typeof settings.markerColor === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(settings.markerColor.trim())) {
                markerColor = settings.markerColor.trim();
            }
            // 外側パルス波紋 (半径16px相当)
            ctx.beginPath();
            ctx.arc(cx, cy, Math.round(16 * markerScale), 0, Math.PI * 2);
            ctx.fillStyle = hexToRgba(markerColor, 0.18);
            ctx.fill();
            ctx.strokeStyle = hexToRgba(markerColor, 0.6);
            ctx.lineWidth = Math.round(1.8 * markerScale);
            ctx.stroke();

            // 白枠土台円 (半径10px相当 ＋ グロー影)
            ctx.save();
            ctx.shadowColor = markerColor;
            ctx.shadowBlur = Math.round(5 * markerScale);
            ctx.beginPath();
            ctx.arc(cx, cy, Math.round(10 * markerScale), 0, Math.PI * 2);
            ctx.fillStyle = '#ffffff';
            ctx.fill();
            ctx.restore();

            // 中心の指定色円 (半径7px相当)
            ctx.beginPath();
            ctx.arc(cx, cy, Math.round(7 * markerScale), 0, Math.PI * 2);
            ctx.fillStyle = markerColor;
            ctx.fill();
        }

        // 7. 縮尺スケールバーの描画 (mapScale に応じた文字・バー拡大)
        if (settings.showScale) {
            const uiScale = mapScale >= 1.5 ? (mapScale >= 2.0 ? 1.4 : 1.2) : 1.0;
            const targetMaxW = Math.round(120 * uiScale);
            const scaleInfo = RouteInterpolator.calculateScaleBar(currentPos.lat, zoom, targetMaxW, mapScale);
            const barW = scaleInfo.barWidthPx;
            const barH = Math.round(5 * uiScale);
            const padX = Math.round(12 * uiScale);
            const pillH = Math.round(34 * uiScale);
            const posX = cx + (settings.shape === 'circle' ? (mapScale >= 1.5 ? 60 : 90) : 140);
            const posY = cy + (settings.shape === 'circle' ? 240 : 265);

            // 背景ピル
            ctx.save();
            ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
            ctx.shadowColor = 'rgba(0, 0, 0, 0.25)';
            ctx.shadowBlur = 4;
            ctx.beginPath();
            ctx.roundRect(posX - padX, posY - Math.round(22 * uiScale), barW + padX * 2, pillH, 6 * uiScale);
            ctx.fill();
            ctx.restore();

            // スケール目盛りバー
            ctx.fillStyle = '#1e293b';
            ctx.fillRect(posX, posY, barW, barH);
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(posX, posY, barW / 2, barH); // 白黒ツートン

            ctx.strokeStyle = '#1e293b';
            ctx.lineWidth = 1;
            ctx.strokeRect(posX, posY, barW, barH);

            // スケールテキスト
            ctx.fillStyle = '#0f172a';
            const fontSize = Math.round(11 * uiScale);
            ctx.font = `bold ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
            ctx.textAlign = 'center';
            ctx.fillText(scaleInfo.label, posX + barW / 2, posY - Math.round(5 * uiScale));
        }

        // 8. OpenStreetMap 著作権表示 (文字拡大 & ダーク半透明ピル背景で高視認性化)
        const creditScale = mapScale >= 1.5 ? 1.15 : 1.0;
        const creditFontSize = Math.round(13 * creditScale);
        ctx.save();
        ctx.font = `bold ${creditFontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const creditText = '© OpenStreetMap contributors';
        const textMetrics = ctx.measureText(creditText);
        const textW = textMetrics.width;
        const pillW = textW + 20 * creditScale;
        const pillH = creditFontSize + 10 * creditScale;
        const creditY = settings.shape === 'circle' ? cy + 302 : cy + 318;

        // 背景の半透明ダークピル
        ctx.fillStyle = 'rgba(15, 23, 42, 0.72)';
        ctx.beginPath();
        ctx.roundRect(cx - pillW / 2, creditY - pillH / 2, pillW, pillH, 5 * creditScale);
        ctx.fill();

        // クッキリとした白色テキスト
        ctx.fillStyle = '#ffffff';
        ctx.fillText(creditText, cx, creditY);
        ctx.restore();

        // クリップ解除
        ctx.restore();

        // 8. ワイプの外枠線 (ボーダー) の描画
        ctx.save();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 5;
        ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
        ctx.shadowBlur = 10;
        ctx.beginPath();
        if (settings.shape === 'circle') {
            ctx.arc(cx, cy, 330, 0, Math.PI * 2);
        } else {
            const size = 680;
            const r = 24;
            const x = (w - size) / 2;
            const y = (h - size) / 2;
            ctx.roundRect(x, y, size, size, r);
        }
        ctx.stroke();
        ctx.restore();

        return this.canvas;
    }
}
