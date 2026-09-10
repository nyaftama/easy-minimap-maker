/**
 * timeline-editor.js
 * 横長タイムラインエディタ
 * - 時間ルーラー & 再生ヘッドスクラブ
 * - 地点通し番号 (#S, #1, #2...) & 一時停止区間帯ハイライト
 * - 一時停止作成時の一括操作ロック
 * - 4種類の選択ツール & キーフレーム時間シフト
 * - 最大10世代の Undo / Redo
 */

import { state } from './state.js?v=1.01f';

export class TimelineEditor {
    constructor(videoController) {
        this.videoController = videoController;
        this.pxPerSec = 80;
        this.currentTool = 'select';

        this.viewport = document.getElementById('timelineViewport');
        this.content = document.getElementById('timelineContent');
        this.ruler = document.getElementById('timelineRuler');
        this.rulerCanvas = document.getElementById('rulerCanvas');
        this.trackLane = document.getElementById('timelineTrack');
        this.trackGridCanvas = document.getElementById('trackGridCanvas');
        this.playheadContainer = document.getElementById('playheadContainer');
        this.playheadHandle = document.getElementById('playheadHandle');
        this.marqueeBox = document.getElementById('timelineMarquee');
        this.zoomSlider = document.getElementById('timelineZoomSlider');

        this.btnToolSelect = document.getElementById('toolSelect');
        this.btnToolForward = document.getElementById('toolSelectForward');
        this.btnToolBackward = document.getElementById('toolSelectBackward');
        this.btnToolMarquee = document.getElementById('toolSelectMarquee');
        this.btnDeleteKeyframe = document.getElementById('btnDeleteKeyframe');
        this.btnTogglePause = document.getElementById('btnTogglePause');
        this.pauseBtnLabel = document.getElementById('pauseBtnLabel');
        this.btnAddKeyframe = document.getElementById('btnAddKeyframe');
        this.btnUndo = document.getElementById('btnUndo');
        this.btnRedo = document.getElementById('btnRedo');
        this.btnPrevKeyframe = document.getElementById('btnPrevKeyframe');
        this.btnNextKeyframe = document.getElementById('btnNextKeyframe');

        this.isDraggingPlayhead = false;
        this.isDraggingKeyframes = false;
        this.isMarqueeSelecting = false;

        this.init();
    }

    init() {
        this.initTools();
        this.initDeleteButton();
        this.initPlayheadScrub();
        this.initTrackInteraction();
        this.initZoom();
        this.initKeyframeControls();
        this.initUndoRedo();
        this.initScrollAndResize();
        this.bindState();
        this.updateDimensions();
        this.drawRuler();
        this.updatePauseButtonState();
    }

    initScrollAndResize() {
        let rafPending = false;
        this.viewport.addEventListener('scroll', () => {
            if (!rafPending) {
                rafPending = true;
                requestAnimationFrame(() => {
                    rafPending = false;
                    this.drawRuler();
                });
            }
        }, { passive: true });

        window.addEventListener('resize', () => {
            this.updateDimensions();
            this.drawRuler();
        });


    }

    bindState() {
        state.subscribe((eventType, payload) => {
            if (eventType === 'time_updated') {
                this.updatePlayheadPosition();
            } else if (eventType === 'video_loaded' || eventType === 'keyframes_updated' || eventType === 'project_restored') {
                this.updateDimensions();
                this.drawRuler();
                this.renderTrackItems();
                this.updatePlayheadPosition();
                this.updateDeleteButton();
                this.updatePauseButtonState();
            } else if (eventType === 'selection_changed') {
                this.updateSelectionVisuals();
                this.updateDeleteButton();
                this.updatePauseButtonState();
            } else if (eventType === 'pause_state_change') {
                this.updatePauseButtonState();
            } else if (eventType === 'history_change') {
                if (this.btnUndo) this.btnUndo.disabled = !payload.canUndo;
                if (this.btnRedo) this.btnRedo.disabled = !payload.canRedo;
            }
        });
    }

    updateDimensions() {
        const totalDuration = Math.max(state.videoDuration || 60, (state.keyframes[state.keyframes.length - 1]?.time || 0) + 10);
        const totalWidth = Math.max(this.viewport.clientWidth, Math.ceil(totalDuration * this.pxPerSec) + 140);

        this.content.style.width = `${totalWidth}px`;

        const viewportWidth = this.viewport.clientWidth || 800;
        if (this.rulerCanvas) {
            this.rulerCanvas.width = viewportWidth;
            this.rulerCanvas.height = 28;
            this.rulerCanvas.style.width = `${viewportWidth}px`;
        }
        if (this.trackGridCanvas) {
            this.trackGridCanvas.width = 1;
            this.trackGridCanvas.height = 1;
        }
    }

    drawRuler() {
        if (!this.rulerCanvas) return;
        const viewportWidth = this.viewport.clientWidth || 800;
        if (this.rulerCanvas.width !== viewportWidth) {
            this.rulerCanvas.width = viewportWidth;
            this.rulerCanvas.style.width = `${viewportWidth}px`;
        }

        const ctx = this.rulerCanvas.getContext('2d');
        const width = this.rulerCanvas.width;
        const height = this.rulerCanvas.height;
        const scrollLeft = this.viewport.scrollLeft || 0;

        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = '#8e95a5';
        ctx.strokeStyle = '#383f4f';
        ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.lineWidth = 1;

        let stepSec = 1;
        if (this.pxPerSec < 40) stepSec = 5;
        if (this.pxPerSec < 20) stepSec = 10;
        if (this.pxPerSec >= 150) stepSec = 0.5;

        // ビューポート内に見えている秒数範囲を計算（前後にマージンを持たせる）
        const startSec = Math.max(0, Math.floor((scrollLeft - 100) / this.pxPerSec / stepSec) * stepSec);
        const endSec = (scrollLeft + width + 100) / this.pxPerSec;

        ctx.beginPath();
        for (let sec = startSec; sec <= endSec; sec += stepSec) {
            const curSec = Math.round(sec / stepSec) * stepSec;
            const x = Math.round(curSec * this.pxPerSec - scrollLeft);

            const isMajor = (Math.round(curSec / stepSec) % 5 === 0) || curSec === 0;

            if (isMajor) {
                ctx.moveTo(x + 0.5, height - 12);
                ctx.lineTo(x + 0.5, height);

                const m = Math.floor(curSec / 60);
                const s = Math.floor(curSec % 60);
                const ms = Math.floor((curSec % 1) * 10);
                const text = stepSec < 1
                    ? `${m}:${String(s).padStart(2, '0')}.${ms}`
                    : `${m}:${String(s).padStart(2, '0')}`;
                ctx.fillText(text, x + 4, height - 14);
            } else {
                ctx.moveTo(x + 0.5, height - 6);
                ctx.lineTo(x + 0.5, height);
            }
        }
        ctx.stroke();
    }

    updatePlayheadPosition() {
        if (!this.playheadContainer) return;
        const x = state.currentTime * this.pxPerSec;
        this.playheadContainer.style.transform = `translateX(${x}px)`;

        if (this.isDraggingPlayhead || this.isDraggingKeyframes) return;

        if (this.videoController.isPlaying) {
            const scrollLeft = this.viewport.scrollLeft;
            const clientWidth = this.viewport.clientWidth;
            const margin = 16; // ページ送り後の左端視認マージン

            // 再生ヘッドが現在の表示範囲の右端に達したら、次のページへページ送り
            // (ヘッドが画面左端付近に現れ、右へ向かって進む)
            if (x >= scrollLeft + clientWidth) {
                this.viewport.scrollLeft = Math.max(0, x - margin);
            } else if (x < scrollLeft) {
                // シークやループ再生等で現在の表示範囲より前に戻った場合
                this.viewport.scrollLeft = Math.max(0, x - margin);
            }
        } else {
            // 動画停止中のステップ操作やジャンプ移動時に、再生ヘッドが画面内に収まるよう自動スクロール
            this.ensurePlayheadVisible();
        }
    }

    /**
     * 再生ヘッドが表示領域内に収まるようスクロールを調整
     * @param {boolean} forceCenter trueの場合は表示範囲内であっても中央にスクロール
     */
    ensurePlayheadVisible(forceCenter = false) {
        if (!this.viewport || this.isDraggingPlayhead || this.isDraggingKeyframes) return;
        const clientWidth = this.viewport.clientWidth;
        if (clientWidth <= 0) return;

        const x = state.currentTime * this.pxPerSec;
        const scrollLeft = this.viewport.scrollLeft;
        // 画面端からの視認マージン (画面幅の10%、最小32px、最大80px)
        const margin = Math.min(80, Math.max(32, clientWidth * 0.1));

        const isVisible = (x >= scrollLeft + margin && x <= scrollLeft + clientWidth - margin);

        if (forceCenter || !isVisible) {
            const maxScroll = Math.max(0, this.viewport.scrollWidth - clientWidth);
            const targetScrollLeft = Math.max(0, Math.min(maxScroll, Math.round(x - clientWidth / 2)));
            if (Math.abs(this.viewport.scrollLeft - targetScrollLeft) > 1) {
                this.viewport.scrollLeft = targetScrollLeft;
                this.drawRuler();
            }
        }
    }

    initPlayheadScrub() {
        let isDragging = false;

        const seekFromClientX = (clientX) => {
            const rect = this.content.getBoundingClientRect();
            const x = Math.max(0, clientX - rect.left);
            const targetTime = x / this.pxPerSec;
            this.videoController.seekTo(targetTime);
        };

        const onPointerMove = (e) => {
            if (!isDragging) return;
            const clientX = e.clientX || (e.touches && e.touches[0].clientX) || 0;
            seekFromClientX(clientX);
        };

        const onPointerUp = () => {
            if (isDragging) {
                isDragging = false;
                this.isDraggingPlayhead = false;
                window.removeEventListener('pointermove', onPointerMove);
                window.removeEventListener('pointerup', onPointerUp);
                window.removeEventListener('pointercancel', onPointerUp);
            }
        };

        const onPointerDown = (e) => {
            if (e.button !== undefined && e.button !== 0) return;
            isDragging = true;
            this.isDraggingPlayhead = true;
            this.videoController.video.pause();

            const clientX = e.clientX || (e.touches && e.touches[0].clientX) || 0;
            seekFromClientX(clientX);

            window.addEventListener('pointermove', onPointerMove, { passive: true });
            window.addEventListener('pointerup', onPointerUp);
            window.addEventListener('pointercancel', onPointerUp);
        };

        // 再生ヘッドの移動はタイムライン上部 (ルーラーおよびツマミ) のみで実行
        this.ruler.addEventListener('pointerdown', onPointerDown);
        this.playheadHandle.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            onPointerDown(e);
        });
    }

    initTools() {
        const setTool = (tool) => {
            if (state.isPausing) return; // 一時停止作成中はツール変更を無効化
            this.currentTool = tool;
            [this.btnToolSelect, this.btnToolForward, this.btnToolBackward, this.btnToolMarquee].forEach(btn => {
                btn?.classList.remove('active');
            });
            if (tool === 'select') this.btnToolSelect?.classList.add('active');
            if (tool === 'forward') this.btnToolForward?.classList.add('active');
            if (tool === 'backward') this.btnToolBackward?.classList.add('active');
            if (tool === 'marquee') this.btnToolMarquee?.classList.add('active');
        };

        this.btnToolSelect?.addEventListener('click', () => setTool('select'));
        this.btnToolForward?.addEventListener('click', () => setTool('forward'));
        this.btnToolBackward?.addEventListener('click', () => setTool('backward'));
        this.btnToolMarquee?.addEventListener('click', () => setTool('marquee'));

        window.addEventListener('keydown', (e) => {
            if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
            if (state.isPausing) return; // 一時停止作成中はショートカットを無効化
            if (e.key === 'v' || e.key === 'V') setTool('select');
            if (e.key === 'a' || e.key === 'A') setTool('forward');
            if (e.key === 'y' || e.key === 'Y') setTool('backward');
            if (e.key === 'b' || e.key === 'B') setTool('marquee');
        });
    }

    initZoom() {
        if (this.zoomSlider) {
            this.zoomSlider.addEventListener('input', (e) => {
                this.setZoom(Number(e.target.value));
            });
        }

        // スマホ等のタッチ操作によるタイムラインピンチズーム
        let initialPinchDist = null;
        let initialZoom = this.pxPerSec;

        this.viewport.addEventListener('touchstart', (e) => {
            if (e.touches.length === 2) {
                const t1 = e.touches[0];
                const t2 = e.touches[1];
                initialPinchDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
                initialZoom = this.pxPerSec;
            }
        }, { passive: true });

        this.viewport.addEventListener('touchmove', (e) => {
            if (e.touches.length === 2 && initialPinchDist) {
                e.preventDefault(); // ページ全体のズームを防止
                const t1 = e.touches[0];
                const t2 = e.touches[1];
                const currentDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
                const scale = currentDist / initialPinchDist;
                const newZoom = Math.round(initialZoom * scale);
                this.setZoom(newZoom);
            }
        }, { passive: false });

        this.viewport.addEventListener('touchend', (e) => {
            if (e.touches.length < 2) {
                initialPinchDist = null;
            }
        });
    }

    setZoom(val) {
        this.pxPerSec = Math.max(20, Math.min(250, val));
        if (this.zoomSlider) this.zoomSlider.value = this.pxPerSec;
        this.updateDimensions();
        this.drawRuler();
        this.renderTrackItems();
        this.updatePlayheadPosition();
    }

    /** トラック上のアイテム描画 (地点ベース通し番号付き) */
    renderTrackItems() {
        if (!this.trackLane) return;

        const existingItems = this.trackLane.querySelectorAll('.kf-marker, .timeline-pause-band');
        existingItems.forEach(el => el.remove());

        // 1. 一時停止区間帯 (Pause Band)
        const renderedPairs = new Set();
        state.keyframes.forEach(kf => {
            if (kf.type === 'pause_start' && kf.pairId && !renderedPairs.has(kf.id)) {
                const endKf = state.keyframes.find(k => k.id === kf.pairId);
                if (endKf) {
                    renderedPairs.add(kf.id);
                    renderedPairs.add(endKf.id);

                    const startX = kf.time * this.pxPerSec;
                    const endX = endKf.time * this.pxPerSec;
                    const bandWidth = Math.max(12, endX - startX);
                    const numInfo = state.getKeyframeNumberInfo(kf.id);

                    const bandEl = document.createElement('div');
                    bandEl.className = 'timeline-pause-band';
                    bandEl.style.left = `${startX}px`;
                    bandEl.style.width = `${bandWidth}px`;
                    bandEl.textContent = `地点 #${numInfo.num} 停止 (${(endKf.time - kf.time).toFixed(1)}s)`;
                    bandEl.title = `一時停止区間: ${kf.time.toFixed(1)}s 〜 ${endKf.time.toFixed(1)}s`;

                    bandEl.addEventListener('click', (e) => {
                        e.stopPropagation();
                        if (state.isPausing) return; // 一時停止作成中は選択切り替えを無効化
                        state.selectedIds.clear();
                        state.selectedIds.add(kf.id);
                        state.selectedIds.add(endKf.id);
                        state.notify('selection_changed');
                        this.videoController.seekTo(kf.time);
                    });

                    this.trackLane.appendChild(bandEl);
                }
            }
        });

        // 2. キーフレームマーカー
        state.keyframes.forEach(kf => {
            const x = kf.time * this.pxPerSec;
            const marker = document.createElement('div');
            const isPause = kf.type === 'pause_start' || kf.type === 'pause_end';
            const isSelected = state.selectedIds.has(kf.id);
            const numInfo = state.getKeyframeNumberInfo(kf.id);

            marker.className = `kf-marker ${isPause ? 'pause-marker' : ''} ${isSelected ? 'selected' : ''}`;
            marker.style.left = `${x}px`;
            marker.dataset.id = kf.id;
            marker.title = `地点 #${numInfo.label} (${kf.time.toFixed(2)}s)`;

            const labelEl = document.createElement('span');
            labelEl.className = 'kf-marker-label';
            labelEl.textContent = `#${numInfo.label}`;
            marker.appendChild(labelEl);

            marker.addEventListener('pointerdown', (e) => {
                e.stopPropagation();
                this.handleMarkerPointerDown(e, kf);
            });

            this.trackLane.appendChild(marker);
        });
    }

    /**
     * マーカーのクリック & ドラッグ時間移動
     * ドラッグ中は再生ヘッドを動かさず、クリック時のみシーク！
     */
    handleMarkerPointerDown(e, kf) {
        if (state.isPausing) return; // 一時停止作成中はキーフレーム操作を無効化
        if (this.currentTool === 'select') {
            if (e.shiftKey) {
                state.toggleSelect(kf.id);
            } else if (!state.selectedIds.has(kf.id)) {
                state.selectSingle(kf.id);
            }
            this.startKeyframeDrag(e, kf);
        } else if (this.currentTool === 'forward') {
            state.selectForward(kf.time);
            this.startKeyframeDrag(e, kf);
        } else if (this.currentTool === 'backward') {
            state.selectBackward(kf.time);
            this.startKeyframeDrag(e, kf);
        }
    }

    /**
     * キーフレームドラッグ移動
     * - ドラッグ中は再生ヘッド（Playhead）を固定
     * - 移動量が微小 (3px未満) で離された場合は「クリック」とみなし、その時刻へシーク
     */
    startKeyframeDrag(e, targetKf) {
        this.isDraggingKeyframes = true;
        const startX = e.clientX || (e.touches && e.touches[0].clientX) || 0;
        let lastShift = 0;
        let hasMoved = false;

        const onMove = (ev) => {
            if (!this.isDraggingKeyframes) return;
            const currentX = ev.clientX || (ev.touches && ev.touches[0].clientX) || 0;
            const deltaX = currentX - startX;

            if (Math.abs(deltaX) > 3) {
                hasMoved = true;
            }

            const deltaTime = deltaX / this.pxPerSec;
            const snappedDelta = Math.round(deltaTime * 20) / 20;
            const stepShift = snappedDelta - lastShift;

            if (stepShift !== 0) {
                state.shiftSelectedKeyframes(stepShift);
                lastShift = snappedDelta;
                // ※ ここで videoController.seekTo は呼ばないため、再生ヘッドは動かない！
            }
        };

        const onUp = () => {
            this.isDraggingKeyframes = false;
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);

            // ドラッグせずにクリックされた場合のみ、そのキーフレーム時刻へヘッドをシーク
            if (!hasMoved && targetKf) {
                this.videoController.seekTo(targetKf.time);
            }
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
    }

    initTrackInteraction() {
        this.trackLane.addEventListener('pointerdown', (e) => {
            if (state.isPausing) return; // 一時停止作成中はトラック操作を無効化
            if (e.target !== this.trackLane && e.target !== this.trackGridCanvas) return;

            const rect = this.content.getBoundingClientRect();
            const startX = e.clientX - rect.left;
            const startTime = startX / this.pxPerSec;

            if (this.currentTool === 'marquee') {
                this.startMarqueeSelection(e, startX, startTime);
            } else if (this.currentTool === 'forward') {
                state.selectForward(startTime);
                this.videoController.seekTo(startTime);
            } else if (this.currentTool === 'backward') {
                state.selectBackward(startTime);
                this.videoController.seekTo(startTime);
            } else {
                // 空領域タップ時: 選択解除のみ (再生ヘッドは動かさない)
                state.clearSelection();
            }
        });
    }

    startMarqueeSelection(e, startX, startTime) {
        if (state.isPausing) return; // 一時停止作成中は範囲選択を無効化
        this.isMarqueeSelecting = true;
        this.marqueeBox.style.display = 'block';
        this.marqueeBox.style.left = `${startX}px`;
        this.marqueeBox.style.top = '10px';
        this.marqueeBox.style.height = `${this.trackLane.clientHeight - 20}px`;
        this.marqueeBox.style.width = '0px';

        const onMove = (ev) => {
            if (!this.isMarqueeSelecting) return;
            const rect = this.content.getBoundingClientRect();
            const currentX = ev.clientX - rect.left;
            const left = Math.min(startX, currentX);
            const width = Math.abs(currentX - startX);

            this.marqueeBox.style.left = `${left}px`;
            this.marqueeBox.style.width = `${width}px`;

            const endTime = currentX / this.pxPerSec;
            state.selectRange(startTime, endTime);
        };

        const onUp = () => {
            this.isMarqueeSelecting = false;
            this.marqueeBox.style.display = 'none';
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
    }

    updateSelectionVisuals() {
        const markers = this.trackLane.querySelectorAll('.kf-marker');
        markers.forEach(m => {
            const id = m.dataset.id;
            if (state.selectedIds.has(id)) {
                m.classList.add('selected');
            } else {
                m.classList.remove('selected');
            }
        });
        this.updateDeleteButton();
    }

    initKeyframeControls() {
        const addKfAtCurrent = () => {
            if (state.isPausing) return; // 一時停止作成中は追加を無効化
            const currentPos = state.keyframes[state.keyframes.length - 1] || { lat: 35.681236, lng: 139.767125, zoom: 16 };
            state.addKeyframe(state.currentTime, currentPos.lat, currentPos.lng, currentPos.zoom);
        };

        // 前／次のキーフレームへ移動ボタン (↑/↓)
        this.btnPrevKeyframe?.addEventListener('click', () => {
            if (state.isPausing) return;
            this.videoController.seekToPrevKeyframe();
        });

        this.btnNextKeyframe?.addEventListener('click', () => {
            if (state.isPausing) return;
            this.videoController.seekToNextKeyframe();
        });

        window.addEventListener('keydown', (e) => {
            if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
            if (state.isPausing) return;
            if (e.key === 'k' || e.key === 'K') addKfAtCurrent();
        });

        this.btnTogglePause?.addEventListener('click', () => {
            if (!state.isPausing) {
                if (state.selectedIds.size === 1) {
                    const selectedId = Array.from(state.selectedIds)[0];
                    state.convertToPauseStart(selectedId);
                }
            } else {
                state.endPause(state.currentTime);
            }
        });
    }

    updatePauseButtonState() {
        if (!this.btnTogglePause) return;

        if (state.isPausing) {
            this.btnTogglePause.disabled = false;
            this.btnTogglePause.classList.add('active-pausing');
            if (this.pauseBtnLabel) this.pauseBtnLabel.textContent = '一時停止を終了';
            this.btnTogglePause.title = '現在の再生時刻で一時停止を終了';

            // 一時停止作成中はタイムライン関連の他の操作を一括無効化
            this.setTimelineControlsDisabled(true);
            return;
        }

        // 通常操作の復旧
        this.setTimelineControlsDisabled(false);

        this.btnTogglePause.classList.remove('active-pausing');
        if (this.pauseBtnLabel) this.pauseBtnLabel.textContent = '一時停止を開始';

        if (state.selectedIds.size === 1) {
            const selectedId = Array.from(state.selectedIds)[0];
            const kf = state.keyframes.find(k => k.id === selectedId);
            if (kf && kf.type !== 'pause_start' && kf.type !== 'pause_end') {
                this.btnTogglePause.disabled = false;
                this.btnTogglePause.title = '選択中のキーフレームを一時停止開始に設定';
                return;
            }
        }

        this.btnTogglePause.disabled = true;
        this.btnTogglePause.title = 'キーフレーム（単一）を選択すると一時停止を開始できます';
    }

    /**
     * 一時停止作成中にタイムライン関連の操作を一括無効化 / 復元
     */
    setTimelineControlsDisabled(disabled) {
        // ツールボタン (選択 / 範囲選択 / 前方 / 後方)
        [this.btnToolSelect, this.btnToolForward, this.btnToolBackward, this.btnToolMarquee].forEach(btn => {
            if (btn) btn.disabled = disabled;
        });

        // 削除ボタン
        if (this.btnDeleteKeyframe) {
            if (disabled) {
                this.btnDeleteKeyframe.disabled = true;
            } else {
                this.updateDeleteButton();
            }
        }

        // Undo / Redo ボタン
        if (this.btnUndo) {
            this.btnUndo.disabled = disabled ? true : !state.canUndo();
        }
        if (this.btnRedo) {
            this.btnRedo.disabled = disabled ? true : !state.canRedo();
        }

        // キーフレーム移動ナビ
        if (this.btnPrevKeyframe) this.btnPrevKeyframe.disabled = disabled;
        if (this.btnNextKeyframe) this.btnNextKeyframe.disabled = disabled;

        // タイムライントラック要素に操作ロッククラスを付与
        if (this.trackLane) {
            this.trackLane.classList.toggle('pausing-locked', disabled);
        }
    }


    initDeleteButton() {
        this.btnDeleteKeyframe?.addEventListener('click', () => {
            if (state.isPausing) return; // 一時停止作成中は削除を無効化
            if (state.selectedIds.size > 0) {
                state.deleteKeyframes(Array.from(state.selectedIds));
            }
        });

        // Delete / Backspace キーでの削除 & Escape での選択解除
        window.addEventListener('keydown', (e) => {
            if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
            if (state.isPausing) return; // 一時停止作成中は削除を無効化
            if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedIds.size > 0) {
                state.deleteKeyframes(Array.from(state.selectedIds));
            }
            if (e.key === 'Escape' && state.selectedIds.size > 0) {
                state.clearSelection();
            }
        });
    }

    updateDeleteButton() {
        if (!this.btnDeleteKeyframe) return;
        if (state.isPausing) {
            this.btnDeleteKeyframe.disabled = true;
            return;
        }
        const count = state.selectedIds.size;
        this.btnDeleteKeyframe.disabled = count === 0;
        const span = this.btnDeleteKeyframe.querySelector('span');
        if (span) {
            span.textContent = count > 1 ? `削除 (${count})` : '削除';
        }
    }

    /** Undo / Redo ボタン & 各種ショートカット (10回履歴) */
    initUndoRedo() {
        this.btnUndo?.addEventListener('click', () => {
            if (state.isPausing) return;
            state.undo();
        });
        this.btnRedo?.addEventListener('click', () => {
            if (state.isPausing) return;
            state.redo();
        });

        window.addEventListener('keydown', (e) => {
            if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
            if (state.isPausing) return; // 一時停止作成中はUndo/Redoを無効化

            const isCtrlOrCmd = e.ctrlKey || e.metaKey;

            // Undo: Ctrl+Z / Cmd+Z (Shiftなし)
            if (isCtrlOrCmd && e.key.toLowerCase() === 'z' && !e.shiftKey) {
                e.preventDefault();
                state.undo();
            }
            // Redo: Shift+Ctrl+Z / Shift+Cmd+Z
            else if (isCtrlOrCmd && e.key.toLowerCase() === 'z' && e.shiftKey) {
                e.preventDefault();
                state.redo();
            }
            // Redo: Ctrl+Y / Cmd+Y
            else if (isCtrlOrCmd && e.key.toLowerCase() === 'y') {
                e.preventDefault();
                state.redo();
            }
        });
    }
}
