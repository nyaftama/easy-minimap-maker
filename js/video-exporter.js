/**
 * video-exporter.js
 * WebCodecs API (VideoEncoder) + mp4-muxer による超高速 720x720 MP4 エクスポート
 * (Safari/iOS対応 & 非対応環境向け MediaRecorder フォールバック付き)
 */

import { RouteInterpolator } from './interpolator.js?v=1.02a';

export class VideoExporter {
    constructor(renderEngine) {
        this.renderEngine = renderEngine;
        this.isExporting = false;
        this.abortController = null;
    }

    /**
     * 動画エクスポート処理の実行
     * @param {Array} keyframes - 全キーフレーム
     * @param {number} duration - 動画時間長（秒）
     * @param {number} fps - 出力フレームレート (例: 2, 10, 15)
     * @param {Object} settings - { shape, chromaColor, showScale, showRoute, showPins, markerColor, mapScale, zoom }
     * @param {Function} onProgress - (percent, statusText) => void
     * @returns {Promise<Blob>} 出力動画Blob (MP4 / WebM)
     */
    async exportVideo(keyframes, duration, fps, settings, onProgress = null) {
        this.isExporting = true;
        this.abortController = new AbortController();

        const totalFrames = Math.max(1, Math.ceil(duration * fps));
        const width = 720;
        const height = 720;

        // エクスポート全体の固定ズームレベルを決定
        const exportZoom = Math.round((settings.zoom !== undefined && settings.zoom !== null) ? settings.zoom : (keyframes[0]?.zoom || 16));
        settings.zoom = exportZoom;

        // エクスポートパラメータのロギング
        console.log('[VRM VideoExporter] Export started:', {
            zoom: exportZoom,
            markerColor: settings.markerColor,
            mapScale: settings.mapScale,
            shape: settings.shape,
            showPins: settings.showPins
        });

        // 現在地マーカー画像 & ピン画像の事前生成 (編集画面と同一のSVGスタンプを生成)
        const currentMarkerColor = settings.markerColor || '#2563eb';
        await this.renderEngine.prepareMarker(currentMarkerColor);

        if (settings.showPins !== false) {
            await this.renderEngine.preparePins(keyframes, settings.mapScale || 2.0);
        }

        // タイルの事前ロード（固定ズーム & mapScale の全ルート通過範囲タイルを確実にキャッシュ）
        if (onProgress) onProgress(0, '地図タイルを事前ダウンロード中...');
        await this.renderEngine.preloadTiles(keyframes, exportZoom, settings.mapScale || 2.0, (percent, text) => {
            if (onProgress) onProgress(Math.round(percent * 0.2), text);
        });

        // WebCodecs による MP4 エンコードを試行
        if ('VideoEncoder' in window) {
            try {
                return await this.exportWithWebCodecs(keyframes, duration, fps, settings, onProgress);
            } catch (err) {
                console.warn('[VideoExporter] WebCodecs export failed, falling back to MediaRecorder:', err);
            }
        }

        // フォールバック: MediaRecorder
        return await this.exportWithMediaRecorder(keyframes, duration, fps, settings, onProgress);
    }

    /** WebCodecs + mp4-muxer による高速書き出し (Safari/Chrome双方に対応) */
    async exportWithWebCodecs(keyframes, duration, fps, settings, onProgress) {
        // mp4-muxer の動的インポート
        let Mp4MuxerModule;
        try {
            Mp4MuxerModule = await import('https://cdn.jsdelivr.net/npm/mp4-muxer@5.1.4/build/mp4-muxer.mjs');
        } catch (e) {
            throw new Error('mp4-muxer load failed: ' + e.message);
        }

        const { Muxer, ArrayBufferTarget } = Mp4MuxerModule;
        const muxerTarget = new ArrayBufferTarget();
        const muxer = new Muxer({
            target: muxerTarget,
            video: {
                codec: 'avc',
                width: 720,
                height: 720
            },
            fastStart: 'in-memory'
        });

        let encoderError = null;
        const defaultDurationUs = Math.round(1_000_000 / fps);
        let cachedDecoderConfig = null;

        const encoder = new VideoEncoder({
            output: (chunk, meta) => {
                try {
                    // Safari互換性対策:
                    // 1. Safariでは初回チャンク以外metaが来ない。またcolorSpaceが未定義の場合があるため補完
                    let activeMeta = meta;
                    if (meta && meta.decoderConfig) {
                        cachedDecoderConfig = meta.decoderConfig;
                    } else if (cachedDecoderConfig) {
                        activeMeta = { ...meta, decoderConfig: cachedDecoderConfig };
                    }

                    if (activeMeta && activeMeta.decoderConfig && !activeMeta.decoderConfig.colorSpace) {
                        activeMeta.decoderConfig.colorSpace = {
                            primaries: 'bt709',
                            transfer: 'bt709',
                            matrix: 'bt709',
                            fullRange: false
                        };
                    }

                    // 2. SafariのVideoEncoderはchunk.durationを返さない(null/undefined)。
                    //    mp4-muxerのaddVideoChunkRawに明示的な1フレームの長さ(マイクロ秒)を渡す。
                    const rawData = new Uint8Array(chunk.byteLength);
                    chunk.copyTo(rawData);

                    const durationUs = (Number.isFinite(chunk.duration) && chunk.duration >= 0)
                        ? chunk.duration
                        : defaultDurationUs;

                    muxer.addVideoChunkRaw(
                        rawData,
                        chunk.type,
                        chunk.timestamp,
                        durationUs,
                        activeMeta
                    );
                } catch (muxErr) {
                    console.error('[VideoExporter] mp4-muxer error:', muxErr);
                    encoderError = muxErr;
                }
            },
            error: (e) => {
                console.error('[VideoEncoder] Encoder error callback:', e);
                encoderError = e;
            }
        });

        // 複数のコーデック候補（Safari/Chromium双方の互換性を考慮）
        const candidateCodecs = [
            'avc1.42001f', // Baseline Profile Level 3.1
            'avc1.4d001f', // Main Profile Level 3.1
            'avc1.64001f'  // High Profile Level 3.1
        ];

        let chosenCodec = 'avc1.42001f';
        if (typeof VideoEncoder.isConfigSupported === 'function') {
            for (const c of candidateCodecs) {
                try {
                    const testConf = {
                        codec: c,
                        width: 720,
                        height: 720,
                        bitrate: 3_500_000,
                        framerate: fps
                    };
                    const res = await VideoEncoder.isConfigSupported(testConf);
                    if (res && res.supported) {
                        chosenCodec = c;
                        break;
                    }
                } catch (e) {
                    console.warn('[VideoExporter] isConfigSupported check failed for ' + c, e);
                }
            }
        }

        const encoderConfig = {
            codec: chosenCodec,
            width: 720,
            height: 720,
            bitrate: 3_500_000,
            framerate: fps,
            hardwareAcceleration: 'prefer-hardware',
            latencyMode: 'quality'
        };

        try {
            encoder.configure(encoderConfig);
        } catch (err) {
            console.warn('[VideoExporter] Hardware acceleration configuration failed, fallback to software:', err);
            delete encoderConfig.hardwareAcceleration;
            delete encoderConfig.latencyMode;
            encoder.configure(encoderConfig);
        }

        const totalFrames = Math.ceil(duration * fps);

        for (let i = 0; i < totalFrames; i++) {
            if (encoderError) {
                throw new Error('VideoEncoder failed during encoding: ' + (encoderError.message || encoderError));
            }

            const t = i / fps;
            const currentPos = RouteInterpolator.interpolate(keyframes, t) || keyframes[0];
            const canvas = this.renderEngine.renderFrame(currentPos, keyframes, t, settings);

            const timestampUs = Math.round(t * 1_000_000);
            const videoFrame = new VideoFrame(canvas, { timestamp: timestampUs });

            const keyframeInterval = Math.max(1, Math.round(fps * 2));
            const isKeyframe = (i % keyframeInterval === 0);
            encoder.encode(videoFrame, { keyFrame: isKeyframe });
            videoFrame.close();

            // キューが溜まった場合は dequeue イベントまたは短縮タイマーで効率的に待機
            if (encoder.encodeQueueSize > 8) {
                await new Promise(resolve => {
                    let done = false;
                    const timer = setTimeout(() => {
                        if (!done) {
                            done = true;
                            encoder.ondequeue = null;
                            resolve();
                        }
                    }, 20);
                    encoder.ondequeue = () => {
                        if (!done) {
                            done = true;
                            clearTimeout(timer);
                            encoder.ondequeue = null;
                            resolve();
                        }
                    };
                });
            } else {
                const yieldStep = Math.max(1, Math.min(6, Math.floor(totalFrames / 20)));
                if (i % yieldStep === 0) {
                    // UI描画（進捗バー）更新とイベントループの解放
                    await new Promise(r => setTimeout(r, 0));
                }
            }

            const progressStep = Math.max(1, Math.min(3, Math.floor(totalFrames / 50)));
            if (onProgress && (i % progressStep === 0 || i === totalFrames - 1)) {
                const percent = 20 + Math.round(((i + 1) / totalFrames) * 75);
                onProgress(percent, );
            }
        }

        await encoder.flush();
        encoder.close();
        muxer.finalize();

        if (onProgress) onProgress(100, 'エクスポート完了！');
        return new Blob([muxerTarget.buffer], { type: 'video/mp4' });
    }

    /** フォールバック: MediaRecorder によるリアルタイムキャプチャ */
    async exportWithMediaRecorder(keyframes, duration, fps, settings, onProgress) {
        const canvas = this.renderEngine.canvas;
        const stream = canvas.captureStream(fps);

        const mimeTypes = ['video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
        const selectedMime = mimeTypes.find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm';

        const recorder = new MediaRecorder(stream, {
            mimeType: selectedMime,
            videoBitsPerSecond: 4_000_000
        });

        const chunks = [];
        recorder.ondataavailable = (e) => {
            if (e.data.size > 0) chunks.push(e.data);
        };

        return new Promise((resolve) => {
            recorder.onstop = () => {
                const blob = new Blob(chunks, { type: selectedMime });
                if (onProgress) onProgress(100, 'エクスポート完了！');
                resolve(blob);
            };

            recorder.start();

            const totalFrames = Math.ceil(duration * fps);
            let currentFrame = 0;
            const interval = 1000 / fps;

            const timer = setInterval(() => {
                const t = currentFrame / fps;
                const currentPos = RouteInterpolator.interpolate(keyframes, t) || keyframes[0];
                this.renderEngine.renderFrame(currentPos, keyframes, t, settings);

                currentFrame++;
                if (onProgress && currentFrame % 10 === 0) {
                    const percent = 20 + Math.round((currentFrame / totalFrames) * 75);
                    onProgress(percent, );
                }

                if (currentFrame >= totalFrames) {
                    clearInterval(timer);
                    recorder.stop();
                }
            }, interval);
        });
    }
}
