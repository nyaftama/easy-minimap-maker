/**
 * zip-exporter.js
 * GPX / GeoJSON / JSON 生成 & JSZip による一括ダウンロード
 */

import { RouteInterpolator } from './interpolator.js?v=1.00d';

export class ZipExporter {
    /**
     * GPX (GPS Exchange Format) 文字列の生成
     * 1秒ごとに補間された高精度トラックポイントを出力
     */
    static generateGPX(keyframes, duration, projectName = 'minimap-project') {
        const baseDate = new Date();
        let trkpts = '';

        const totalSeconds = Math.ceil(duration || (keyframes[keyframes.length - 1]?.time || 60));
        for (let s = 0; s <= totalSeconds; s++) {
            const pos = RouteInterpolator.interpolate(keyframes, s);
            if (pos) {
                const pointTime = new Date(baseDate.getTime() + s * 1000).toISOString();
                trkpts += `      <trkpt lat="${pos.lat.toFixed(6)}" lon="${pos.lng.toFixed(6)}">\n`;
                trkpts += `        <time>${pointTime}</time>\n`;
                trkpts += `      </trkpt>\n`;
            }
        }

        return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="easy-minimap-maker (https://nyaftama.github.io/easy-minimap-maker/)" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${projectName}</name>
    <time>${baseDate.toISOString()}</time>
  </metadata>
  <trk>
    <name>${projectName}</name>
    <trkseg>
${trkpts}    </trkseg>
  </trk>
</gpx>`;
    }

    /**
     * GeoJSON 文字列の生成
     */
    static generateGeoJSON(keyframes, duration, projectName = 'minimap-project') {
        const totalSeconds = Math.ceil(duration || (keyframes[keyframes.length - 1]?.time || 60));
        const coordinates = [];

        for (let s = 0; s <= totalSeconds; s++) {
            const pos = RouteInterpolator.interpolate(keyframes, s);
            if (pos) {
                coordinates.push([Number(pos.lng.toFixed(6)), Number(pos.lat.toFixed(6))]);
            }
        }

        const features = [
            {
                type: "Feature",
                properties: { name: projectName, type: "interpolated_route" },
                geometry: {
                    type: "LineString",
                    coordinates
                }
            },
            ...keyframes.map((kf, i) => ({
                type: "Feature",
                properties: {
                    id: kf.id,
                    index: i,
                    time: kf.time,
                    type: kf.type
                },
                geometry: {
                    type: "Point",
                    coordinates: [Number(kf.lng.toFixed(6)), Number(kf.lat.toFixed(6))]
                }
            }))
        ];

        return JSON.stringify({
            type: "FeatureCollection",
            features
        }, null, 2);
    }

    /**
     * Premiere Pro 向け README ガイドテキスト
     */
    static generateReadme(projectName) {
        return `================================================================
かんたんミニマップメーカー (Easy Minimap Maker) エクスポート素材
プロジェクト名: ${projectName}
URL: https://nyaftama.github.io/easy-minimap-maker/
================================================================

【収録内容】
1. chromakey_map.mp4 : 720x720 現在地マップ動画素材 (クロマキー背景付き)
2. route.gpx        : GPSトラックデータ (GPX 1.1)
3. route.geojson    : ルートおよびキーフレームデータ (GeoJSON)
4. project.json     : 本ツール再読み込み用プロジェクトデータ

【Adobe Premiere Pro での Ultraキー（クロマキー）合成手順】
1. 本動画素材（chromakey_map.mp4）をタイムラインの元動画の上に配置します。
2. 「エフェクト」パネルから「Ultraキー」を検索し、配置したマップ動画クリップに適用します。
3. 「エフェクトコントロール」パネルの「キーカラー」のスポイトで、動画の背景色（グリーン/ブルー）をクリックします。
4. 背景が瞬時に透過され、地図ワイプのみが表示されます。
5. 「モーション」の「位置」と「スケール」を調整し、画面の四隅などお好みの位置に配置してください。

【クレジット表示について】
地図データは OpenStreetMap の著作物です。
動画の説明欄やクレジット等に以下の表記をお願いいたします：
「地図データ: © OpenStreetMap contributors (https://www.openstreetmap.org/copyright)」
`;
    }

    /**
     * ZIP パッケージの作成 & ダウンロード実行
     */
    static async downloadZipPackage(videoBlob, keyframes, duration, settings, projectName = 'minimap-project') {
        if (!window.JSZip) {
            const msg = 'JSZipライブラリが読み込まれていません。個別のダウンロードをご利用ください。';
            if (window.app && window.app.constructor.showModalAlert) {
                window.app.constructor.showModalAlert(msg, 'ライブラリ未読み込み', 'warning');
            } else {
                alert(msg);
            }
            return;
        }

        const zip = new window.JSZip();

        // 1. 動画ファイル
        const videoExt = videoBlob.type.includes('mp4') ? 'mp4' : 'webm';
        zip.file(`chromakey_map.${videoExt}`, videoBlob);

        // 2. GPX ファイル
        const gpxData = this.generateGPX(keyframes, duration, projectName);
        zip.file('route.gpx', gpxData);

        // 3. GeoJSON ファイル
        const geojsonData = this.generateGeoJSON(keyframes, duration, projectName);
        zip.file('route.geojson', geojsonData);

        // 4. プロジェクト JSON
        const projectData = JSON.stringify({
            version: '0.90',
            projectName,
            duration,
            settings,
            keyframes,
            exportedAt: new Date().toISOString()
        }, null, 2);
        zip.file('project.json', projectData);

        // 5. README.txt
        const readmeData = this.generateReadme(projectName);
        zip.file('README.txt', readmeData);

        // ZIP 生成 & ダウンロード
        const zipBlob = await zip.generateAsync({ type: 'blob' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(zipBlob);
        a.download = `${projectName}_assets.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
    }
}
