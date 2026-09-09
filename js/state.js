/**
 * state.js
 * プロジェクト状態管理 & LocalStorage 自動保存
 * - 地点ベース通し番号 (開始地点 #S、以降 #1, #2...、一時停止終了は #S', #1'...)
 * - 最大10世代の Undo / Redo 履歴管理
 * - 一時停止区間の作成・同期・スマート削除連携 (開始削除で両方削除 / 終了削除で通常キーフレーム復旧)
 * - 一時停止作成中の自動保存保留と完了時の即時保存
 */

export const APP_VERSION = '1.01e';
const STORAGE_KEY = 'vrm_draft_project_v1';

class ProjectState {
    constructor() {
        this.projectName = 'minimap-project';
        this.fps = 30; // タイムラインFPSは30固定
        this.videoDuration = 0;
        this.videoFileName = '';
        this.currentTime = 0;
        this.previewQuality = 'low'; // 'low' (軽量・リサイズ) | 'high' (オリジナル)

        // キーフレーム配列: { id, time, lat, lng, zoom, type, pairId }
        // type: "normal" | "pause_start" | "pause_end"
        this.keyframes = [];

        // 選択中のキーフレームIDセット
        this.selectedIds = new Set();

        // 現在の一時停止記録状態
        this.isPausing = false;
        this.pendingPauseStartId = null;

        // エクスポート設定
        this.exportSettings = {
            width: 720,
            height: 720,
            fps: 15,                // 出力動画フレームレート (1-30、デフォルト: 15)
            shape: 'circle',        // "circle" | "square"
            chromaColor: '#00FF00', // クロマキー背景色
            showScale: true,        // 縮尺スケールバー表示
            showRoute: true,        // ルート軌跡表示
            showPins: true,         // 通過地点（ピン）の動画内描画表示
            markerColor: '#2563eb', // 現在地マーカー色
            mapScale: 2,            // 地図スケール: 1 (100%), 1.5 (150%), 2 (200% - デフォルト)
            zoom: null              // 固定ズームレベル (null時は編集画面のズームを自動適用)
        };

        // Undo / Redo スタック (最大10回)
        this.undoStack = [];
        this.redoStack = [];
        this.maxHistory = 10;

        // リスナーコールバック
        this.listeners = new Set();

        // 自動保存タイマー (デバウンス)
        this.saveTimer = null;
    }

    /** 状態変更を通知 */
    notify(eventType, payload) {
        this.listeners.forEach(fn => fn(eventType, payload));
        this.scheduleAutoSave();
    }

    subscribe(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    /** 履歴スナップショットの保存 (最大10回まで) */
    pushHistory() {
        const snapshot = JSON.stringify({
            keyframes: this.keyframes,
            projectName: this.projectName,
            fps: this.fps,
            exportSettings: this.exportSettings,
            previewQuality: this.previewQuality
        });
        this.undoStack.push(snapshot);
        if (this.undoStack.length > this.maxHistory) {
            this.undoStack.shift();
        }
        this.redoStack = []; // 新規操作でRedoスタックをクリア
        this.notify('history_change', { canUndo: this.canUndo(), canRedo: this.canRedo() });
    }

    canUndo() { return this.undoStack.length > 0; }
    canRedo() { return this.redoStack.length > 0; }

    undo() {
        if (!this.canUndo()) return;
        const currentSnapshot = JSON.stringify({
            keyframes: this.keyframes,
            projectName: this.projectName,
            fps: this.fps,
            exportSettings: this.exportSettings,
            previewQuality: this.previewQuality
        });
        this.redoStack.push(currentSnapshot);

        const prevState = JSON.parse(this.undoStack.pop());
        this.keyframes = prevState.keyframes;
        this.projectName = prevState.projectName;
        this.fps = prevState.fps;
        this.exportSettings = prevState.exportSettings;
        this.previewQuality = prevState.previewQuality || 'low';

        this.notify('keyframes_updated');
        this.notify('history_change', { canUndo: this.canUndo(), canRedo: this.canRedo() });
    }

    redo() {
        if (!this.canRedo()) return;
        const currentSnapshot = JSON.stringify({
            keyframes: this.keyframes,
            projectName: this.projectName,
            fps: this.fps,
            exportSettings: this.exportSettings,
            previewQuality: this.previewQuality
        });
        this.undoStack.push(currentSnapshot);

        const nextState = JSON.parse(this.redoStack.pop());
        this.keyframes = nextState.keyframes;
        this.projectName = nextState.projectName;
        this.fps = nextState.fps;
        this.exportSettings = nextState.exportSettings;
        this.previewQuality = nextState.previewQuality || 'low';

        this.notify('keyframes_updated');
        this.notify('history_change', { canUndo: this.canUndo(), canRedo: this.canRedo() });
    }

    // ============================================================
    // キーフレーム & 通し番号管理
    // ============================================================

    /**
     * 地点ベースの通し番号情報を算出
     * 一時停止区間（pause_start と pause_end）は同一の地点番号を持ち、終了側は 2' のように表記
     * @returns {{ num: number, label: string, isPrime: boolean }}
     */
    getKeyframeNumberInfo(id) {
        let spotCount = 0; // 地点カウント: 0番目=S, 1番目=1, 2番目=2, ...
        const labelMap = new Map();

        for (let i = 0; i < this.keyframes.length; i++) {
            const kf = this.keyframes[i];
            if (kf.type === 'pause_end' && kf.pairId) {
                // ペアとなる開始キーフレームの番号を取得
                const startKf = this.keyframes.find(k => k.id === kf.pairId);
                const baseInfo = startKf ? labelMap.get(startKf.id) : null;
                const baseNum = baseInfo ? baseInfo.num : (spotCount === 0 ? 'S' : `${spotCount}`);
                labelMap.set(kf.id, {
                    num: baseNum,
                    label: `${baseNum}'`,
                    isPrime: true
                });
            } else {
                const currentLabel = (spotCount === 0) ? 'S' : `${spotCount}`;
                labelMap.set(kf.id, {
                    num: currentLabel,
                    label: currentLabel,
                    isPrime: false
                });
                spotCount++;
            }
        }

        return labelMap.get(id) || { num: 'S', label: 'S', isPrime: false };
    }

    /** 指定時刻が既存の一時停止区間（内部）に含まれているか判定 */
    isTimeInsidePauseInterval(time) {
        for (const kf of this.keyframes) {
            if (kf.type === 'pause_start' && kf.pairId) {
                const endKf = this.keyframes.find(k => k.id === kf.pairId);
                if (endKf) {
                    const startT = Math.min(kf.time, endKf.time);
                    const endT = Math.max(kf.time, endKf.time);
                    if (time > startT + 0.05 && time < endT - 0.05) {
                        return { inside: true, startKf: kf, endKf };
                    }
                }
            }
        }
        return { inside: false };
    }

    /** キーフレームの追加 (一時停止区間内ガード付き) */
    addKeyframe(time, lat, lng, zoom = 16, type = 'normal', pairId = null) {
        if (type === 'normal') {
            const pauseCheck = this.isTimeInsidePauseInterval(time);
            if (pauseCheck.inside) {
                this.notify('toast_warning', {
                    message: `一時停止区間内 (${pauseCheck.startKf.time.toFixed(1)}s 〜 ${pauseCheck.endKf.time.toFixed(1)}s) にはキーフレームを配置できません。`
                });
                return null;
            }
        }

        this.pushHistory();

        const id = 'kf_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
        const kf = {
            id,
            time: Math.max(0, Math.min(this.videoDuration || 999999, time)),
            lat,
            lng,
            zoom,
            type,
            pairId
        };

        this.keyframes.push(kf);
        this.sortKeyframes();

        // キーフレーム新規追加時は未選択状態を維持 (タイムライン選択時のみポップアップ対象)
        this.selectedIds.clear();

        this.notify('keyframes_updated', { addedId: id });
        return kf;
    }

    /** キーフレームを時間順にソート */
    sortKeyframes() {
        this.keyframes.sort((a, b) => a.time - b.time);
    }

    /** 指定時刻付近（閾値以内）のキーフレームを検索 */
    findKeyframeNearTime(time, threshold = 0.08) {
        return this.keyframes.find(k => Math.abs(k.time - time) <= threshold);
    }

    /** 現在時刻より前の最も近いキーフレームを取得 */
    getPrevKeyframe(currentTime) {
        let prev = null;
        for (let i = this.keyframes.length - 1; i >= 0; i--) {
            if (this.keyframes[i].time < currentTime - 0.05) {
                prev = this.keyframes[i];
                break;
            }
        }
        return prev;
    }

    /** 現在時刻より後の最も近いキーフレームを取得 */
    getNextKeyframe(currentTime) {
        let next = null;
        for (let i = 0; i < this.keyframes.length; i++) {
            if (this.keyframes[i].time > currentTime + 0.05) {
                next = this.keyframes[i];
                break;
            }
        }
        return next;
    }

    /**
     * キーフレームの更新
     * 一時停止区間（pause_start または pause_end）の座標変更時、ペアも自動同期！
     */
    updateKeyframe(id, updates) {
        const kf = this.keyframes.find(k => k.id === id);
        if (!kf) return;

        this.pushHistory();
        Object.assign(kf, updates);

        // 一時停止ペアの座標自動同期
        if ((kf.type === 'pause_start' || kf.type === 'pause_end') && kf.pairId) {
            const pairKf = this.keyframes.find(k => k.id === kf.pairId);
            if (pairKf) {
                if (updates.lat !== undefined) pairKf.lat = updates.lat;
                if (updates.lng !== undefined) pairKf.lng = updates.lng;
                if (updates.zoom !== undefined) pairKf.zoom = updates.zoom;
            }
        }

        if (updates.time !== undefined) {
            this.sortKeyframes();
        }
        this.notify('keyframes_updated', { updatedId: id });
    }

    /** 指定IDのキーフレームを削除 */
    deleteKeyframes(ids) {
        if (!ids || ids.length === 0) return;
        this.pushHistory();

        const toDeleteIds = new Set(ids);

        // 一時停止ペアの整合性処理:
        // - 開始地点を削除した場合は終了地点も同時に削除
        // - 終了地点を削除した場合は一時停止区間を解除して開始地点を通常のキーフレームに戻す
        ids.forEach(id => {
            const kf = this.keyframes.find(k => k.id === id);
            if (!kf) return;

            if (kf.type === 'pause_start' && kf.pairId) {
                toDeleteIds.add(kf.pairId);
            } else if (kf.type === 'pause_end' && kf.pairId) {
                if (!toDeleteIds.has(kf.pairId)) {
                    const startKf = this.keyframes.find(k => k.id === kf.pairId);
                    if (startKf) {
                        startKf.type = 'normal';
                        startKf.pairId = null;
                    }
                }
            }
        });

        this.keyframes = this.keyframes.filter(k => !toDeleteIds.has(k.id));
        toDeleteIds.forEach(id => this.selectedIds.delete(id));

        // 一時停止作成中のキーフレームが削除された場合はモード解除
        if (this.isPausing && this.pendingPauseStartId && toDeleteIds.has(this.pendingPauseStartId)) {
            this.isPausing = false;
            this.pendingPauseStartId = null;
            this.notify('pause_state_change', { isPausing: false });
        }

        this.notify('keyframes_updated', { deletedIds: Array.from(toDeleteIds) });
        this.scheduleAutoSave();
    }

    /** 選択キーフレームの一括時間シフト (ドラッグ移動) */
    shiftSelectedKeyframes(deltaTime) {
        if (this.selectedIds.size === 0 || deltaTime === 0) return;
        this.pushHistory();

        this.keyframes.forEach(kf => {
            if (this.selectedIds.has(kf.id)) {
                kf.time = Math.max(0, Math.min(this.videoDuration || 999999, kf.time + deltaTime));
            }
        });
        this.sortKeyframes();
        this.notify('keyframes_updated');
    }

    // ============================================================
    // 一時停止（信号待ち）機能
    // ============================================================

    /**
     * 既存の通常キーフレームを一時停止開始 (pause_start) に変更
     */
    convertToPauseStart(kfId) {
        const kf = this.keyframes.find(k => k.id === kfId);
        if (!kf) return null;
        if (kf.type === 'pause_start' || kf.type === 'pause_end') return null;

        this.pushHistory();
        kf.type = 'pause_start';
        this.isPausing = true;
        this.pendingPauseStartId = kf.id;

        // 一時停止作成中は自動保存を停止（待機タイマーを解除）
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }

        this.notify('pause_state_change', { isPausing: true, startId: kf.id });
        this.notify('keyframes_updated');
        this.notify('toast_warning', { message: '一時停止を作成中: 終了時刻までシークして「一時停止を終了」を押してください' });
        return kf;
    }

    startPause(time, lat, lng, zoom = 16) {
        this.pushHistory();
        const kf = this.addKeyframe(time, lat, lng, zoom, 'pause_start');
        this.isPausing = true;
        this.pendingPauseStartId = kf.id;
        this.notify('pause_state_change', { isPausing: true, startId: kf.id });
        return kf;
    }

    endPause(time) {
        if (!this.isPausing || !this.pendingPauseStartId) return;
        this.pushHistory();

        const startKf = this.keyframes.find(k => k.id === this.pendingPauseStartId);
        if (!startKf) {
            this.isPausing = false;
            this.pendingPauseStartId = null;
            this.notify('pause_state_change', { isPausing: false });
            return;
        }

        // 時刻が開始地点とほぼ同じ (0.05秒未満) の場合は一時停止をキャンセルして通常キーフレームに戻す
        if (Math.abs(time - startKf.time) < 0.05) {
            startKf.type = 'normal';
            this.isPausing = false;
            this.pendingPauseStartId = null;
            this.notify('pause_state_change', { isPausing: false });
            this.notify('keyframes_updated');
            this.scheduleAutoSave(); // 自動保存を再開・実行
            return null;
        }

        const endKf = this.addKeyframe(
            Math.max(startKf.time + 0.1, time),
            startKf.lat,
            startKf.lng,
            startKf.zoom,
            'pause_end',
            startKf.id
        );
        startKf.pairId = endKf.id;

        this.isPausing = false;
        this.pendingPauseStartId = null;
        this.notify('pause_state_change', { isPausing: false });
        this.notify('keyframes_updated');
        this.scheduleAutoSave(); // 一時停止終了時に最新状態を自動保存！
        return endKf;
    }

    // ============================================================
    // 選択ツール操作
    // ============================================================

    selectSingle(id) {
        this.selectedIds.clear();
        if (id) this.selectedIds.add(id);
        this.notify('selection_changed');
    }

    toggleSelect(id) {
        if (this.selectedIds.has(id)) {
            this.selectedIds.delete(id);
        } else {
            this.selectedIds.add(id);
        }
        this.notify('selection_changed');
    }

    selectForward(fromTime) {
        this.selectedIds.clear();
        this.keyframes.forEach(kf => {
            if (kf.time >= fromTime - 0.001) {
                this.selectedIds.add(kf.id);
            }
        });
        this.notify('selection_changed');
    }

    selectBackward(fromTime) {
        this.selectedIds.clear();
        this.keyframes.forEach(kf => {
            if (kf.time <= fromTime + 0.001) {
                this.selectedIds.add(kf.id);
            }
        });
        this.notify('selection_changed');
    }

    selectRange(startTime, endTime) {
        const minT = Math.min(startTime, endTime);
        const maxT = Math.max(startTime, endTime);
        this.selectedIds.clear();
        this.keyframes.forEach(kf => {
            if (kf.time >= minT && kf.time <= maxT) {
                this.selectedIds.add(kf.id);
            }
        });
        this.notify('selection_changed');
    }

    clearSelection() {
        this.selectedIds.clear();
        this.notify('selection_changed');
    }

    // ============================================================
    // LocalStorage 自動保存 & クラッシュ保護
    // ============================================================

    scheduleAutoSave() {
        if (this.isPausing) return; // 一時停止作成中は自動保存を停止
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => {
            if (this.isPausing) return;
            this.saveToLocalStorage();
        }, 600);
    }

    saveToLocalStorage() {
        if (this.isPausing) return; // 一時停止作成中は自動保存しない
        try {
            const data = {
                projectName: this.projectName,
                fps: this.fps,
                videoFileName: this.videoFileName,
                videoDuration: this.videoDuration,
                keyframes: this.keyframes,
                exportSettings: this.exportSettings,
                previewQuality: this.previewQuality,
                isPausing: this.isPausing,
                pendingPauseStartId: this.pendingPauseStartId,
                timestamp: Date.now()
            };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
            this.notify('auto_saved');
        } catch (e) {
            console.warn('LocalStorage save failed:', e);
        }
    }

    static getDraft() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return null;
            return JSON.parse(raw);
        } catch (e) {
            return null;
        }
    }

    restoreDraft(draft) {
        if (!draft) return;
        if (typeof draft === 'string') {
            try {
                draft = JSON.parse(draft);
            } catch (e) {
                console.error('Failed to parse draft string:', e);
                return;
            }
        }
        this.projectName = draft.projectName || 'minimap-project';
        this.fps = 30; // タイムラインFPSは30固定
        this.videoFileName = draft.videoFileName || '';
        this.videoDuration = Number(draft.videoDuration) || 0;
        this.currentTime = 0;
        this.selectedIds.clear();

        // キーフレーム配列の型・値の安全な正規化
        this.keyframes = Array.isArray(draft.keyframes) ? draft.keyframes.map(k => ({
            ...k,
            time: Number(k.time) || 0,
            lat: Number(k.lat) || 0,
            lng: Number(k.lng) || 0,
            zoom: Number(k.zoom) || 16
        })) : [];

        this.exportSettings = {
            ...this.exportSettings,
            ...(draft.exportSettings || {})
        };
        // 未設定時のフォールバック
        if (this.exportSettings.fps === undefined || this.exportSettings.fps === null) {
            this.exportSettings.fps = 15;
        }
        if (!this.exportSettings.markerColor) this.exportSettings.markerColor = '#2563eb';
        if (this.exportSettings.showPins === undefined) this.exportSettings.showPins = true;
        this.previewQuality = draft.previewQuality || 'low';
        this.isPausing = draft.isPausing || false;
        this.pendingPauseStartId = draft.pendingPauseStartId || null;
        this.undoStack = [];
        this.redoStack = [];

        this.sortKeyframes();
        this.notify('keyframes_updated');
        this.notify('project_restored');
    }

    resetProject() {
        this.projectName = 'minimap-project';
        this.keyframes = [];
        this.selectedIds.clear();
        this.isPausing = false;
        this.pendingPauseStartId = null;
        this.undoStack = [];
        this.redoStack = [];

        try {
            localStorage.removeItem(STORAGE_KEY);
        } catch (e) {}

        this.notify('keyframes_updated');
        this.notify('project_reset');
    }
}

export const state = new ProjectState();
