/**
 * interpolator.js
 * キーフレーム線形補間・一時停止区間計算・Web Mercator座標変換・縮尺計算
 */

export class RouteInterpolator {
    /**
     * 指定時刻 t における位置・ズーム情報を算出
     * @param {Array} keyframes - ソート済みキーフレーム配列
     * @param {number} t - 時刻（秒）
     * @returns {Object|null} { lat, lng, zoom, segmentIndex, isPaused }
     */
    static interpolate(keyframes, t) {
        if (!keyframes || keyframes.length === 0) return null;

        // キーフレームが1点のみの場合
        if (keyframes.length === 1) {
            return {
                lat: keyframes[0].lat,
                lng: keyframes[0].lng,
                zoom: keyframes[0].zoom || 16,
                isPaused: false
            };
        }

        // 時刻が最初のキーフレームより前
        if (t <= keyframes[0].time) {
            return {
                lat: keyframes[0].lat,
                lng: keyframes[0].lng,
                zoom: keyframes[0].zoom || 16,
                isPaused: false
            };
        }

        // 時刻が最後のキーフレーム以降
        const last = keyframes[keyframes.length - 1];
        if (t >= last.time) {
            return {
                lat: last.lat,
                lng: last.lng,
                zoom: last.zoom || 16,
                isPaused: false
            };
        }

        // 該当する区間 (k0 <= t <= k1) を探索
        let k0 = keyframes[0];
        let k1 = keyframes[1];

        for (let i = 0; i < keyframes.length - 1; i++) {
            if (keyframes[i].time <= t && t <= keyframes[i + 1].time) {
                k0 = keyframes[i];
                k1 = keyframes[i + 1];
                break;
            }
        }

        // 一時停止区間（pause_start と pause_end のペア）判定
        const isPauseInterval = (k0.type === 'pause_start' && k1.type === 'pause_end') ||
                                (k0.lat === k1.lat && k0.lng === k1.lng);

        if (isPauseInterval) {
            return {
                lat: k0.lat,
                lng: k0.lng,
                zoom: k0.zoom || 16,
                isPaused: true
            };
        }

        // 線形補間進行率 alpha (0.0 〜 1.0)
        const timeDiff = k1.time - k0.time;
        const alpha = timeDiff > 0 ? (t - k0.time) / timeDiff : 0;

        const lat = k0.lat + alpha * (k1.lat - k0.lat);
        const lng = k0.lng + alpha * (k1.lng - k0.lng);
        const zoom = (k0.zoom || 16) + alpha * ((k1.zoom || 16) - (k0.zoom || 16));

        return { lat, lng, zoom, isPaused: false };
    }

    // ============================================================
    // Web Mercator 座標変換 (EPSG:3857)
    // ============================================================

    /** 緯度経度からグローバルピクセル座標（指定ズーム時）を計算 */
    static latLngToWorldPixel(lat, lng, zoom) {
        const sinLat = Math.sin(lat * Math.PI / 180);
        const x = ((lng + 180) / 360) * 256 * Math.pow(2, zoom);
        const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * 256 * Math.pow(2, zoom);
        return { x, y };
    }

    /** グローバルピクセル座標から緯度経度へ逆変換 */
    static worldPixelToLatLng(pixelX, pixelY, zoom) {
        const mapSize = 256 * Math.pow(2, zoom);
        const lng = (pixelX / mapSize) * 360 - 180;
        const y2 = 180 - (pixelY / mapSize) * 360;
        const lat = 360 / Math.PI * Math.atan(Math.exp(y2 * Math.PI / 180)) - 90;
        return { lat, lng };
    }

    /** 緯度経度からタイル座標 (tileX, tileY) とタイル内ピクセルオフセットを計算 */
    static latLngToTileCoords(lat, lng, zoom) {
        const wp = this.latLngToWorldPixel(lat, lng, zoom);
        const tileX = Math.floor(wp.x / 256);
        const tileY = Math.floor(wp.y / 256);
        const offsetX = wp.x % 256;
        const offsetY = wp.y % 256;
        return { tileX, tileY, offsetX, offsetY, worldX: wp.x, worldY: wp.y };
    }

    // ============================================================
    // 縮尺スケールバー計算
    // ============================================================

    /**
     * 現在の緯度とズームにおける 1ピクセルあたりの実距離（メートル）
     * Earth circumference at equator = 40075016.686 meters
     */
    static getMetersPerPixel(lat, zoom) {
        return (156543.03392 * Math.cos(lat * Math.PI / 180)) / Math.pow(2, zoom);
    }

    /**
     * 720px画面向けに適切な縮尺スケールバー情報（バーのピクセル幅と単位付きラベル）を算出
     * 目安: バーの幅が 70〜140px 程度に収まるように「丸い数値（10m, 20m, 50m, 100m, 200m, 500m, 1km, 2km...）」を選択
     */
    /**
     * 720px画面向けに適切な縮尺スケールバー情報（バーのピクセル幅と単位付きラベル）を算出
     * @param {number} lat - 緯度
     * @param {number} zoom - ズームレベル
     * @param {number} maxBarWidthPx - バーの最大目標ピクセル幅
     * @param {number} mapScale - 地図の拡大倍率 (1.0, 1.5, 2.0 など)
     */
    static calculateScaleBar(lat, zoom, maxBarWidthPx = 120, mapScale = 1.0) {
        // 地図が mapScale 倍に拡大されている場合、画面上の 1px あたりの実距離は 1/mapScale になる
        const metersPerPixel = this.getMetersPerPixel(lat, zoom) / (mapScale || 1.0);
        const maxMeters = maxBarWidthPx * metersPerPixel;

        // 丸い数値の基準リスト（メートル）
        const candidateMeters = [
            10, 20, 50, 100, 200, 500,
            1000, 2000, 5000, 10000, 20000, 50000
        ];

        let targetMeters = candidateMeters[0];
        for (const m of candidateMeters) {
            if (m <= maxMeters) {
                targetMeters = m;
            } else {
                break;
            }
        }

        const barWidthPx = Math.round(targetMeters / metersPerPixel);
        const label = targetMeters >= 1000
            ? `${(targetMeters / 1000).toLocaleString()} km`
            : `${targetMeters} m`;

        return { barWidthPx, targetMeters, label };
    }

    // ============================================================
    // 距離計算 (Haversine Formula)
    // ============================================================

    /** 2点間の球面距離（メートル） */
    static getDistanceMeters(lat1, lon1, lat2, lon2) {
        const R = 6371000; // 地球の半径 (m)
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                  Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                  Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }
}
