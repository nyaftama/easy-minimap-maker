/**
 * video-controller.js
 * 動画再生制御・フレーム移動・ジョグスクラバー・軽量プレビューレンダリング
 */

import { state } from './state.js?v=1.01a';

export class VideoController {
    constructor(videoEl, options = {}) {
        this.video = videoEl;
        this.options = options;
        this.isPlaying = false;
        this.rvfcId = null;

        // UI要素
        this.currentTimeDisplay = document.getElementById('currentTimecode');
        this.totalTimeDisplay = document.getElementById('totalTimecode');
        this.btnPlayPause = document.getElementById('btnPlayPause');
        this.playIcon = document.getElementById('playIcon');
        this.pauseIcon = document.getElementById('pauseIcon');
        this.jogShuttle = document.getElementById('jogShuttle');
        this.videoContainer = document.querySelector('.video-container');

        // 軽量プレビュー用 Canvas の初期化
        this.previewCanvas = document.createElement('canvas');
        this.previewCanvas.id = 'videoPreviewCanvas';
        this.previewCanvas.style.maxWidth = '100%';
        this.previewCanvas.style.maxHeight = '100%';
        this.previewCanvas.style.objectFit = 'contain';
        this.previewCanvas.style.display = 'none'; // 初期はvideo直接、lowモード時に表示
        this.previewCtx = this.previewCanvas.getContext('2d');
        if (this.videoContainer) {
            this.videoContainer.appendChild(this.previewCanvas);
        }

        // 画質切替バッジ
        this.initQualityBadge();

        this.initEvents();
        this.initKeyboardShortcuts();
    }

    initQualityBadge() {
        if (!this.videoContainer) return;
        this.qualityBadge = document.createElement('div');
        this.qualityBadge.className = 'preview-quality-badge';
        this.qualityBadge.title = 'クリックでプレビュー画質を切替 (軽量 ⇔ 高画質)';
        this.updateQualityBadgeText();

        this.qualityBadge.addEventListener('click', () => {
            state.previewQuality = (state.previewQuality === 'low') ? 'high' : 'low';
            this.updateQualityBadgeText();
            this.applyQualityMode();
            this.drawPreviewFrame();
        });

        this.videoContainer.appendChild(this.qualityBadge);
    }

    updateQualityBadgeText() {
        if (!this.qualityBadge) return;
        const isLow = state.previewQuality === 'low';
        this.qualityBadge.textContent = isLow ? 'プレビュー: 軽量' : 'プレビュー: 高画質';
        this.qualityBadge.style.background = isLow ? 'rgba(37, 99, 235, 0.8)' : 'rgba(0, 0, 0, 0.65)';
    }

    applyQualityMode() {
        if (state.previewQuality === 'low') {
            this.video.style.display = 'none';
            this.previewCanvas.style.display = 'block';
        } else {
            this.video.style.display = 'block';
            this.previewCanvas.style.display = 'none';
        }
    }

    drawPreviewFrame() {
        if (state.previewQuality !== 'low' || !this.video.videoWidth) return;
        // 低解像度ダウンサンプリング (幅 640px)
        const targetWidth = 640;
        const targetHeight = Math.round(targetWidth * (this.video.videoHeight / this.video.videoWidth));

        if (this.previewCanvas.width !== targetWidth || this.previewCanvas.height !== targetHeight) {
            this.previewCanvas.width = targetWidth;
            this.previewCanvas.height = targetHeight;
        }

        this.previewCtx.drawImage(this.video, 0, 0, targetWidth, targetHeight);
    }

    initEvents() {
        // メタデータ読み込み完了
        this.video.addEventListener('loadedmetadata', () => {
            state.videoDuration = this.video.duration;
            this.updateTimeDisplay();
            this.applyQualityMode();
            this.drawPreviewFrame();
            state.notify('video_loaded', { duration: this.video.duration });
        });

        // 再生 / 一時停止状態
        this.video.addEventListener('play', () => {
            this.isPlaying = true;
            this.updatePlayBtn();
            this.startFrameLoop();
        });

        this.video.addEventListener('pause', () => {
            this.isPlaying = false;
            this.updatePlayBtn();
            this.stopFrameLoop();
            this.drawPreviewFrame();
        });

        // タイムアップデート
        this.video.addEventListener('timeupdate', () => {
            state.currentTime = this.video.currentTime;
            this.updateTimeDisplay();
            this.drawPreviewFrame();
            state.notify('time_updated', { currentTime: this.video.currentTime });
        });

        // 再生・一時停止ボタン
        if (this.btnPlayPause) {
            this.btnPlayPause.addEventListener('click', () => this.togglePlay());
        }

        // ステップ操作ボタン
        document.getElementById('btnStepBack5s')?.addEventListener('click', () => this.stepSeconds(-5));
        document.getElementById('btnStepBack1s')?.addEventListener('click', () => this.stepSeconds(-1));
        document.getElementById('btnStepBack1f')?.addEventListener('click', () => this.stepFrames(-1));
        document.getElementById('btnStepForward1f')?.addEventListener('click', () => this.stepFrames(1));
        document.getElementById('btnStepForward1s')?.addEventListener('click', () => this.stepSeconds(1));
        document.getElementById('btnStepForward5s')?.addEventListener('click', () => this.stepSeconds(5));

        // ジョグダイヤル・スクラバー (マウス & タッチ対応)
        this.initJogScrubber();
    }

    /** キーボードショートカットの全面強化 */
    initKeyboardShortcuts() {
        window.addEventListener('keydown', (e) => {
            // 入力要素フォーカス時は無効化
            if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;

            // Space: 再生 / 一時停止
            if (e.code === 'Space') {
                e.preventDefault();
                this.togglePlay();
            }
            // 矢印キー左: 1フレーム戻る (Shift時は1秒戻る)
            else if (e.code === 'ArrowLeft') {
                e.preventDefault();
                if (e.shiftKey) {
                    this.stepSeconds(-1);
                } else {
                    this.stepFrames(-1);
                }
            }
            // 矢印キー右: 1フレーム進む (Shift時は1秒進む)
            else if (e.code === 'ArrowRight') {
                e.preventDefault();
                if (e.shiftKey) {
                    this.stepSeconds(1);
                } else {
                    this.stepFrames(1);
                }
            }
            // 矢印キー上: 前のキーフレームに移動
            else if (e.code === 'ArrowUp') {
                e.preventDefault();
                this.seekToPrevKeyframe();
            }
            // 矢印キー下: 次のキーフレームに移動
            else if (e.code === 'ArrowDown') {
                e.preventDefault();
                this.seekToNextKeyframe();
            }
            // Delete / Backspace: 選択中キーフレームの削除
            else if (e.code === 'Delete' || e.code === 'Backspace') {
                if (state.selectedIds.size > 0) {
                    e.preventDefault();
                    state.deleteKeyframes(Array.from(state.selectedIds));
                }
            }
        });
    }

    /** 前のキーフレームへ移動 */
    seekToPrevKeyframe() {
        const prevKf = state.getPrevKeyframe(state.currentTime);
        if (prevKf) {
            this.seekTo(prevKf.time);
            state.selectSingle(prevKf.id);
        }
    }

    /** 次のキーフレームへ移動 */
    seekToNextKeyframe() {
        const nextKf = state.getNextKeyframe(state.currentTime);
        if (nextKf) {
            this.seekTo(nextKf.time);
            state.selectSingle(nextKf.id);
        }
    }

    loadSource(fileOrUrl) {
        if (fileOrUrl instanceof File) {
            state.videoFileName = fileOrUrl.name;
            const url = URL.createObjectURL(fileOrUrl);
            this.video.src = url;
        } else if (typeof fileOrUrl === 'string') {
            this.video.src = fileOrUrl;
        }
        this.video.load();
    }

    togglePlay() {
        if (this.video.paused) {
            this.video.play().catch(e => console.warn('Play interrupted:', e));
        } else {
            this.video.pause();
        }
    }

    seekTo(time) {
        const target = Math.max(0, Math.min(this.video.duration || 0, time));
        this.video.currentTime = target;
        state.currentTime = target;
        this.updateTimeDisplay();
        this.drawPreviewFrame();
        state.notify('time_updated', { currentTime: target });
    }

    stepFrames(deltaFrames) {
        this.video.pause();
        const frameTime = 1 / (state.fps || 30);
        this.seekTo(this.video.currentTime + deltaFrames * frameTime);
    }

    stepSeconds(deltaSec) {
        this.video.pause();
        this.seekTo(this.video.currentTime + deltaSec);
    }

    startFrameLoop() {
        const loop = () => {
            if (!this.isPlaying) return;
            state.currentTime = this.video.currentTime;
            this.updateTimeDisplay();
            this.drawPreviewFrame();
            state.notify('time_updated', { currentTime: this.video.currentTime });

            if ('requestVideoFrameCallback' in this.video) {
                this.rvfcId = this.video.requestVideoFrameCallback(loop);
            } else {
                this.rvfcId = requestAnimationFrame(loop);
            }
        };

        if ('requestVideoFrameCallback' in this.video) {
            this.rvfcId = this.video.requestVideoFrameCallback(loop);
        } else {
            this.rvfcId = requestAnimationFrame(loop);
        }
    }

    stopFrameLoop() {
        if (this.rvfcId) {
            if ('cancelVideoFrameCallback' in this.video) {
                this.video.cancelVideoFrameCallback(this.rvfcId);
            } else {
                cancelAnimationFrame(this.rvfcId);
            }
            this.rvfcId = null;
        }
    }

    updatePlayBtn() {
        if (!this.playIcon || !this.pauseIcon) return;
        if (this.isPlaying) {
            this.playIcon.style.display = 'none';
            this.pauseIcon.style.display = 'block';
        } else {
            this.playIcon.style.display = 'block';
            this.pauseIcon.style.display = 'none';
        }
    }

    updateTimeDisplay() {
        if (this.currentTimeDisplay) {
            this.currentTimeDisplay.textContent = this.formatTimecode(state.currentTime);
        }
        if (this.totalTimeDisplay) {
            this.totalTimeDisplay.textContent = ' / ' + this.formatTimecode(state.videoDuration);
        }
    }

    /** タイムコードフォーマット: HH:MM:SS.ff (フレーム番号) */
    formatTimecode(seconds) {
        if (isNaN(seconds) || seconds < 0) seconds = 0;
        const fps = state.fps || 30;
        const totalFrames = Math.floor(seconds * fps);
        const f = totalFrames % Math.round(fps);
        const s = Math.floor(seconds) % 60;
        const m = Math.floor(seconds / 60) % 60;
        const h = Math.floor(seconds / 3600);

        const pad = n => String(n).padStart(2, '0');
        return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(f)}`;
    }

    /** ジョグダイヤル・スクラバーのインタラクション */
    initJogScrubber() {
        if (!this.jogShuttle) return;

        let isDragging = false;
        let startX = 0;
        let lastTime = 0;

        const onPointerDown = (e) => {
            isDragging = true;
            startX = e.clientX || (e.touches && e.touches[0].clientX) || 0;
            lastTime = this.video.currentTime;
            this.video.pause();
            this.jogShuttle.style.background = '#222834';
            window.addEventListener('pointermove', onPointerMove);
            window.addEventListener('pointerup', onPointerUp);
            window.addEventListener('touchmove', onPointerMove);
            window.addEventListener('touchend', onPointerUp);
            e.preventDefault();
        };

        const onPointerMove = (e) => {
            if (!isDragging) return;
            const currentX = e.clientX || (e.touches && e.touches[0].clientX) || 0;
            const deltaX = currentX - startX;
            const frameTime = 1 / (state.fps || 30);
            const framesDelta = deltaX / 10;
            this.seekTo(lastTime + framesDelta * frameTime);
        };

        const onPointerUp = () => {
            isDragging = false;
            this.jogShuttle.style.background = '';
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', onPointerUp);
            window.removeEventListener('touchmove', onPointerMove);
            window.removeEventListener('touchend', onPointerUp);
        };

        this.jogShuttle.addEventListener('pointerdown', onPointerDown);
        this.jogShuttle.addEventListener('touchstart', onPointerDown, { passive: false });
    }
}
