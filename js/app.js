/**
 * app.js
 * メインアプリケーション初期化 & UI連携
 * - 画面遷移 & レスポンシブレイアウト管理
 * - 設定 & エクスポートモーダル管理
 * - 自動保存フィードバック & トースト通知
 * - モバイル端末でのボタン状態リセット
 */

import { state } from './state.js?v=1.00b';
import { VideoController } from './video-controller.js?v=1.00b';
import { MapController } from './map-controller.js?v=1.00b';
import { TimelineEditor } from './timeline-editor.js?v=1.00b';
import { RenderEngine } from './render-engine.js?v=1.00b';
import { VideoExporter } from './video-exporter.js?v=1.00b';
import { ZipExporter } from './zip-exporter.js?v=1.00b';
import { CloudStorage } from './cloud-storage.js?v=1.00b';

class App {
    constructor() {
        this.startScreen = document.getElementById('startScreen');
        this.workspaceScreen = document.getElementById('workspaceScreen');
        this.mainVideo = document.getElementById('mainVideo');

        // コントローラー群
        this.videoController = new VideoController(this.mainVideo);
        this.mapController = new MapController('leafletMap');
        this.timelineEditor = new TimelineEditor(this.videoController);
        this.renderEngine = new RenderEngine();
        this.videoExporter = new VideoExporter(this.renderEngine);

        // エクスポート済みキャッシュ
        this.lastExportedBlob = null;

        // トーストタイマー
        this.toastTimer = null;

        // 動画ファイルおよび位置情報キャッシュ
        this.currentVideoFile = null;

        // クラウドストレージ (Supabase)
        this.cloudStorage = new CloudStorage();

        this.init();
    }

    init() {
        this.initAppHeight();
        this.initResponsiveLayout();
        this.initStartScreen();
        this.initOpenProjectModal();
        this.initWorkspacePlaceholder();
        this.initWorkspaceHeader();
        this.initMobileMenu();
        this.initSettingsModal();
        this.initExportModal();
        this.initAuth();
        this.initCloudProjects();
        this.checkSavedDraft();
        this.initAutoSaveFeedback();
        this.initToastListener();
        this.initMobileButtonActiveFix();
    }

    // ============================================================
    // 画面切り替え & スタート画面
    // ============================================================

    showStartScreen() {
        this.workspaceScreen.style.display = 'none';
        this.startScreen.style.display = 'flex';
        this.checkSavedDraft();
    }

    showWorkspaceScreen() {
        this.startScreen.style.display = 'none';
        this.workspaceScreen.style.display = 'flex';

        // 動画がまだ読み込まれていない場合はプレースホルダーオーバーレイを表示
        this.updatePlaceholderVisibility();

        // 地図とタイムラインの描画領域を強制再計算
        setTimeout(() => {
            if (this.mapController && this.mapController.map) {
                this.mapController.map.invalidateSize();
                this.mapController.fitBounds();
            }
            this.timelineEditor.updateDimensions();
            this.timelineEditor.drawRuler();
            this.timelineEditor.renderTrackItems();
        }, 150);
    }

    initStartScreen() {
        const dropzone = document.getElementById('videoDropzone');
        const fileInput = document.getElementById('videoFileInput');
        const btnSelect = document.getElementById('btnSelectVideo');

        btnSelect?.addEventListener('click', () => fileInput?.click());
        dropzone?.addEventListener('click', (e) => {
            if (e.target !== btnSelect && !btnSelect?.contains(e.target)) {
                fileInput?.click();
            }
        });

        fileInput?.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (file) {
                this.loadVideoFile(file);
            }
        });

        // ドラッグ＆ドロップ
        ['dragenter', 'dragover'].forEach(name => {
            dropzone?.addEventListener(name, (e) => {
                e.preventDefault();
                dropzone.classList.add('dragover');
            });
        });
        ['dragleave', 'drop'].forEach(name => {
            dropzone?.addEventListener(name, (e) => {
                e.preventDefault();
                dropzone.classList.remove('dragover');
            });
        });
        dropzone?.addEventListener('drop', (e) => {
            const file = e.dataTransfer?.files?.[0];
            if (file && file.type.startsWith('video/')) {
                this.loadVideoFile(file);
            }
        });
    }

    /** ワークスペース内の動画プレビュードロップエリア (復元時対応) */
    initWorkspacePlaceholder() {
        const overlay = document.getElementById('videoPlaceholderOverlay');
        const dropzone = document.getElementById('workspaceDropzone');
        const fileInput = document.getElementById('workspaceVideoFileInput');
        const btnSelect = document.getElementById('btnWorkspaceSelectVideo');

        btnSelect?.addEventListener('click', (e) => {
            e.stopPropagation();
            fileInput?.click();
        });

        dropzone?.addEventListener('click', () => {
            fileInput?.click();
        });

        fileInput?.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (file) {
                this.loadVideoFile(file);
            }
        });

        // ドラッグ＆ドロップ
        ['dragenter', 'dragover'].forEach(name => {
            dropzone?.addEventListener(name, (e) => {
                e.preventDefault();
                e.stopPropagation();
                dropzone.classList.add('dragover');
            });
        });
        ['dragleave', 'drop'].forEach(name => {
            dropzone?.addEventListener(name, (e) => {
                e.preventDefault();
                e.stopPropagation();
                dropzone.classList.remove('dragover');
            });
        });
        dropzone?.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzone.classList.remove('dragover');
            const file = e.dataTransfer?.files?.[0];
            if (file && file.type.startsWith('video/')) {
                this.loadVideoFile(file);
            }
        });
    }

    updatePlaceholderVisibility() {
        const overlay = document.getElementById('videoPlaceholderOverlay');
        const prevNameEl = document.getElementById('videoPlaceholderPrevName');
        if (!overlay) return;

        // 動画がまだロードされていない場合 (src が空)
        if (!this.mainVideo.src || this.mainVideo.readyState === 0) {
            overlay.style.display = 'flex';
            if (state.videoFileName && prevNameEl) {
                prevNameEl.style.display = 'block';
                prevNameEl.textContent = `前回の動画ファイル: ${state.videoFileName}`;
            } else if (prevNameEl) {
                prevNameEl.style.display = 'none';
            }
        } else {
            overlay.style.display = 'none';
        }
    }

    loadVideoFile(file) {
        this.currentVideoFile = file;

        this.videoController.loadSource(file);

        // プロジェクト名のデフォルト値を動画ファイル名（拡張子なし）に設定
        if (file && file.name) {
            const baseName = file.name.replace(/\.[^/.]+$/, "");
            if (baseName) {
                // プロジェクト名がデフォルトのまま、あるいは未設定の場合は動画ファイル名を採用
                if (state.projectName === "video-route-project" || state.projectName === "minimap-project" || !state.projectName) {
                    state.projectName = baseName;
                }
                const nameDisplay = document.getElementById("projectNameDisplay");
                if (nameDisplay) nameDisplay.textContent = state.projectName;
            }
        }

        this.showWorkspaceScreen();

        // プレースホルダーを即座に非表示
        const overlay = document.getElementById("videoPlaceholderOverlay");
        if (overlay) overlay.style.display = "none";
    }

    // ============================================================
    // LocalStorage 自動保存 & ドラフト復元
    // ============================================================

    checkSavedDraft() {
        const draft = state.constructor.getDraft();
        const banner = document.getElementById('restoreBanner');
        const countSpan = document.getElementById('restoreCount');
        const btnRestore = document.getElementById('btnRestoreProject');
        const btnDiscard = document.getElementById('btnDiscardDraft');

        if (draft && draft.keyframes && draft.keyframes.length > 0) {
            if (banner) banner.style.display = 'flex';
            const nameEl = document.getElementById('restoreProjectName');
            if (nameEl) nameEl.textContent = draft.projectName || '未保存のプロジェクト';
            if (countSpan) countSpan.textContent = draft.keyframes.length;

            btnRestore.onclick = () => {
                state.restoreDraft(draft);
                const nameDisplay = document.getElementById('projectNameDisplay');
                if (nameDisplay) nameDisplay.textContent = state.projectName;
                this.showWorkspaceScreen();
            };

            btnDiscard.onclick = () => {
                state.resetProject();
                if (banner) banner.style.display = 'none';
            };
        } else {
            if (banner) banner.style.display = 'none';
        }
    }

    initAutoSaveFeedback() {
        const indicatorText = document.getElementById('autoSaveText');
        const autoSaveDot = document.querySelector('.auto-save-dot');

        const updateStatus = (text, color) => {
            if (indicatorText) {
                indicatorText.textContent = text;
                indicatorText.style.color = color;
            }
            if (autoSaveDot) {
                autoSaveDot.style.backgroundColor = color;
            }
        };

        // 初期状態: 保存データがある場合は緑、未保存時は autoSaveText と同じ色 (グレー)
        const hasDraft = !!localStorage.getItem('vrm_draft_project_v1');
        if (hasDraft) {
            updateStatus('自動保存済み', '#10b981');
        } else {
            updateStatus('未保存', '#8e95a5');
        }

        state.subscribe((eventType) => {
            if (eventType === 'auto_saved') {
                updateStatus('自動保存済み', '#10b981');
            } else if (eventType === 'keyframes_updated') {
                updateStatus('保存中...', '#f59e0b');
            } else if (eventType === 'project_restored' || eventType === 'video_loaded') {
                updateStatus('自動保存済み', '#10b981');
            }
        });
    }

    /** 警告トースト通知 */
    initToastListener() {
        const toast = document.getElementById('vrmToast');
        const toastText = document.getElementById('vrmToastText');

        state.subscribe((eventType, payload) => {
            if (eventType === 'toast_warning' && toast && toastText) {
                toastText.textContent = payload.message || '警告';
                toast.classList.add('show');
                if (this.toastTimer) clearTimeout(this.toastTimer);
                this.toastTimer = setTimeout(() => {
                    toast.classList.remove('show');
                }, 3000);
            }
        });
    }


    // ============================================================
    // プロジェクトを開くモーダル管理 (クラウド / JSON)
    // ============================================================

    initOpenProjectModal() {
        const btnOpen = document.getElementById('btnStartOpenProjectModal');
        const modal = document.getElementById('openProjectModal');
        const btnClose = document.getElementById('btnCloseOpenProjectModal');
        const btnOpenCloud = document.getElementById('btnStartOpenCloud');
        const btnImportJson = document.getElementById('btnStartImportJson');
        const fileInput = document.getElementById('startInputImportJson');

        const openModal = () => modal?.classList.add('open');
        const closeModal = () => modal?.classList.remove('open');

        btnOpen?.addEventListener('click', openModal);
        btnClose?.addEventListener('click', closeModal);
        modal?.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
        });

        // クラウドから開く
        btnOpenCloud?.addEventListener('click', () => {
            closeModal();
            this.openCloudModal('open');
        });

        // JSONファイルから開く
        btnImportJson?.addEventListener('click', () => {
            fileInput?.click();
        });

        fileInput?.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                try {
                    const parsed = JSON.parse(ev.target.result);
                    state.restoreDraft(parsed);
                    const nameDisplay = document.getElementById('projectNameDisplay');
                    if (nameDisplay) nameDisplay.textContent = state.projectName;
                    closeModal();
                    this.showWorkspaceScreen();
                } catch (err) {
                    App.showModalAlert('JSONファイルの読み込みに失敗しました: ' + err.message, 'エラー', 'warning');
                }
            };
            reader.readAsText(file);
        });
    }

    // ============================================================
    // スマートフォン用ハンバーガーメニュー ＆ 認証インジケーター
    // ============================================================

    initMobileMenu() {
        const toggleBtn = document.getElementById('btnWsMobileMenuToggle');
        const dropdown = document.getElementById('wsMobileDropdown');
        const backdrop = document.getElementById('wsMobileDropdownBackdrop');
        const authStatusBtn = document.getElementById('btnWsMobileAuthStatus');

        const openMenu = () => dropdown?.classList.add('open');
        const closeMenu = () => dropdown?.classList.remove('open');

        toggleBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (dropdown?.classList.contains('open')) {
                closeMenu();
            } else {
                openMenu();
            }
        });

        backdrop?.addEventListener('click', closeMenu);

        // 各メニュー項目の配線
        document.getElementById('btnMobileExport')?.addEventListener('click', () => {
            closeMenu();
            document.getElementById('btnOpenExport')?.click();
        });

        document.getElementById('btnMobileCloudSave')?.addEventListener('click', () => {
            closeMenu();
            this.openCloudModal('save');
        });

        document.getElementById('btnMobileCloudProjects')?.addEventListener('click', () => {
            closeMenu();
            this.openCloudModal('open');
        });

        document.getElementById('btnMobileSettings')?.addEventListener('click', () => {
            closeMenu();
            document.getElementById('btnOpenSettings')?.click();
        });

        document.getElementById('btnMobileNewProject')?.addEventListener('click', () => {
            closeMenu();
            document.getElementById('btnNewProject')?.click();
        });

        // ログイン / ログアウト操作
        const handleAuthAction = async () => {
            closeMenu();
            if (this.cloudStorage.currentUser) {
                const confirmed = await App.showModalConfirm(
                    `「${this.cloudStorage.currentUser.email}」としてログイン中です。\nログアウトしますか？`,
                    'ログアウト確認',
                    'ログアウト',
                    'キャンセル'
                );
                if (confirmed) {
                    await this.cloudStorage.signOut();
                }
            } else {
                const authModal = document.getElementById('authModal');
                authModal?.classList.add('open');
            }
        };

        document.getElementById('btnMobileAuthAction')?.addEventListener('click', handleAuthAction);
        authStatusBtn?.addEventListener('click', handleAuthAction);
        document.getElementById('btnWsAuthStatus')?.addEventListener('click', handleAuthAction);
    }

    // ============================================================
    // ワークスペース ヘッダー
    // ============================================================

    initWorkspaceHeader() {
        document.getElementById('btnBackToStart')?.addEventListener('click', () => {
            this.showStartScreen();
        });

        document.getElementById('btnNewProject')?.addEventListener('click', async () => {
            const confirmed = await App.showModalConfirm(
                '現在のプロジェクトを初期化し、新規プロジェクトを開始しますか？\n（自動保存データもリセットされます）',
                '新規プロジェクトの開始',
                '新規作成',
                'キャンセル',
                true
            );
            if (confirmed) {
                state.resetProject();
                this.showStartScreen();
            }
        });
    }

    // ============================================================
    // 設定モーダル
    // ============================================================

    initSettingsModal() {
        const modal = document.getElementById('settingsModal');
        const btnOpen = document.getElementById('btnOpenSettings');
        const btnClose = document.getElementById('btnCloseSettingsModal');
        const btnSave = document.getElementById('btnSaveSettings');
        const nameInput = document.getElementById('settingProjectName');
        const fpsSelect = document.getElementById('settingFps');
        const qualitySelect = document.getElementById('settingPreviewQuality');
        const nameDisplay = document.getElementById('projectNameDisplay');

        btnOpen?.addEventListener('click', () => {
            if (nameInput) nameInput.value = state.projectName;
            if (fpsSelect) {
                if (!['15', '10'].includes(String(state.fps))) {
                    state.fps = 15;
                }
                fpsSelect.value = String(state.fps);
            }
            if (qualitySelect) qualitySelect.value = state.previewQuality || 'low';
            modal?.classList.add('open');
        });

        btnClose?.addEventListener('click', () => modal?.classList.remove('open'));
        modal?.addEventListener('click', (e) => {
            if (e.target === modal) modal.classList.remove('open');
        });

        btnSave?.addEventListener('click', () => {
            if (nameInput) {
                state.projectName = nameInput.value.trim() || 'minimap-project';
                if (nameDisplay) nameDisplay.textContent = state.projectName;
            }
            if (fpsSelect) {
                state.fps = Number(fpsSelect.value);
            }
            if (qualitySelect) {
                state.previewQuality = qualitySelect.value;
                this.videoController.updateQualityBadgeText();
                this.videoController.applyQualityMode();
                this.videoController.drawPreviewFrame();
            }
            state.pushHistory();
            modal?.classList.remove('open');
        });

        // JSON エクスポート
        document.getElementById('btnExportJson')?.addEventListener('click', () => {
            const data = {
                projectName: state.projectName,
                fps: state.fps,
                videoDuration: state.videoDuration,
                keyframes: state.keyframes,
                exportSettings: state.exportSettings,
                previewQuality: state.previewQuality
            };
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `${state.projectName}_data.json`;
            a.click();
            URL.revokeObjectURL(a.href);
        });

        // JSON インポート
        document.getElementById('inputImportJson')?.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                try {
                    const parsed = JSON.parse(ev.target.result);
                    state.restoreDraft(parsed);
                    if (nameDisplay) nameDisplay.textContent = state.projectName;
                    modal?.classList.remove('open');
                    this.updatePlaceholderVisibility();
                } catch (err) {
                    App.showModalAlert('JSONファイルの読み込みに失敗しました: ' + err.message, 'エラー', 'warning');
                }
            };
            reader.readAsText(file);
        });
    }

    // ============================================================
    // エクスポートモーダル (720x720 クロマキー / ZIP)
    // ============================================================

    initExportModal() {
        const modal = document.getElementById('exportModal');
        const btnOpen = document.getElementById('btnOpenExport');
        const btnClose = document.getElementById('btnCloseExportModal');
        const btnStart = document.getElementById('btnStartExport');
        const btnZip = document.getElementById('btnDownloadZip');
        const btnVideoOnly = document.getElementById('btnDownloadVideoOnly');
        const etaText = document.getElementById('exportEtaText');
        const exportSettingsContainer = document.getElementById('exportSettingsContainer');

        const shapeSelect = document.getElementById('exportWipeShape');
        const chromaSelect = document.getElementById('exportChromaColor');
        const mapScaleSelect = document.getElementById('exportMapScale');
        const exportZoomSelect = document.getElementById('exportZoom');
        const markerColorSelect = document.getElementById('exportMarkerColor');
        const markerColorPicker = document.getElementById('exportMarkerColorPicker');
        const checkPins = document.getElementById('exportShowPins');
        const checkScale = document.getElementById('exportShowScale');
        const checkRoute = document.getElementById('exportShowRoute');

        const progressContainer = document.getElementById('exportProgressContainer');
        const progressBar = document.getElementById('exportProgressBar');
        const statusText = document.getElementById('exportStatusText');
        const percentText = document.getElementById('exportPercentText');

        // マーカー色のプリセット同期処理
        const syncMarkerColor = (color) => {
            if (!color) return;
            const normColor = color.toLowerCase();
            let matched = false;
            if (markerColorSelect) {
                for (let i = 0; i < markerColorSelect.options.length; i++) {
                    if (markerColorSelect.options[i].value.toLowerCase() === normColor) {
                        markerColorSelect.selectedIndex = i;
                        matched = true;
                        break;
                    }
                }
                if (!matched) {
                    markerColorSelect.value = 'custom';
                }
            }
            if (markerColorPicker) {
                markerColorPicker.value = color;
            }
        };

        markerColorSelect?.addEventListener('change', (e) => {
            const val = e.target.value;
            if (val === 'custom') {
                markerColorPicker?.click();
            } else {
                if (markerColorPicker) markerColorPicker.value = val;
                state.exportSettings.markerColor = val;
            }
        });

        markerColorPicker?.addEventListener('input', (e) => {
            const val = e.target.value;
            syncMarkerColor(val);
            state.exportSettings.markerColor = val;
        });

        checkPins?.addEventListener('change', (e) => {
            state.exportSettings.showPins = e.target.checked;
        });

        btnOpen?.addEventListener('click', () => {
            if (state.keyframes.length === 0) {
                App.showModalAlert('キーフレームが登録されていません。地図上をタップして地点を登録してください。', 'エクスポート不可', 'warning');
                return;
            }
            modal?.classList.add('open');
            if (mapScaleSelect && state.exportSettings.mapScale) {
                mapScaleSelect.value = String(state.exportSettings.mapScale);
            }
            if (exportZoomSelect) {
                // デフォルトは現在の編集画面マップのズームレベル
                const currentMapZoom = this.mapController?.map ? Math.round(this.mapController.map.getZoom()) : 16;
                const targetZoom = (state.exportSettings.zoom !== undefined && state.exportSettings.zoom !== null)
                    ? state.exportSettings.zoom
                    : currentMapZoom;
                const clampedZoom = Math.max(14, Math.min(18, targetZoom));
                exportZoomSelect.value = String(clampedZoom);
            }
            if (state.exportSettings.markerColor) {
                syncMarkerColor(state.exportSettings.markerColor);
            }
            if (checkPins) {
                checkPins.checked = state.exportSettings.showPins !== false;
            }
            if (exportSettingsContainer) exportSettingsContainer.style.display = 'block';
            if (progressContainer) progressContainer.style.display = 'none';
            if (btnZip) btnZip.style.display = 'none';
            if (btnVideoOnly) btnVideoOnly.style.display = 'none';
            if (etaText) etaText.textContent = '';
            if (btnStart) {
                btnStart.disabled = false;
                btnStart.style.display = 'inline-flex';
                btnStart.innerHTML = `
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                        stroke-linecap="round" stroke-linejoin="round">
                        <polygon points="5 3 19 12 5 21 5 3"></polygon>
                    </svg>
                    <span>エクスポート開始</span>
                `;
            }
        });

        btnClose?.addEventListener('click', () => modal?.classList.remove('open'));
        modal?.addEventListener('click', (e) => {
            if (e.target === modal) modal.classList.remove('open');
        });

        btnStart?.addEventListener('click', async () => {
            const duration = state.videoDuration || (state.keyframes[state.keyframes.length - 1]?.time || 60);
            const fps = state.fps || 15;
            let currentMarkerColor = '#2563eb';
            if (markerColorSelect && markerColorSelect.value !== 'custom') {
                currentMarkerColor = markerColorSelect.value;
            } else if (markerColorPicker && markerColorPicker.value) {
                currentMarkerColor = markerColorPicker.value;
            }
            if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(currentMarkerColor)) {
                currentMarkerColor = '#2563eb';
            }

            const chosenZoom = exportZoomSelect ? parseInt(exportZoomSelect.value, 10) : 16;
            console.log('[VRM App] Starting export with markerColor:', currentMarkerColor, 'zoom:', chosenZoom);
            const settings = {
                shape: shapeSelect?.value || 'circle',
                chromaColor: chromaSelect?.value || '#00FF00',
                showScale: checkScale ? checkScale.checked : true,
                showRoute: checkRoute ? checkRoute.checked : true,
                showPins: checkPins ? checkPins.checked : true,
                markerColor: currentMarkerColor,
                mapScale: mapScaleSelect ? parseFloat(mapScaleSelect.value) : 2,
                zoom: chosenZoom
            };
            state.exportSettings = { ...state.exportSettings, ...settings };

            // エクスポート中は設定変更を防ぐため設定コンテナを非表示化
            if (exportSettingsContainer) exportSettingsContainer.style.display = 'none';

            // ボタン無効化 & 処理中表示
            btnStart.disabled = true;
            btnStart.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                    stroke-linecap="round" stroke-linejoin="round" class="animate-spin">
                    <line x1="12" y1="2" x2="12" y2="6"></line>
                    <line x1="12" y1="18" x2="12" y2="22"></line>
                    <line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line>
                    <line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line>
                    <line x1="2" y1="12" x2="6" y2="12"></line>
                    <line x1="18" y1="12" x2="22" y2="12"></line>
                    <line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line>
                    <line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line>
                </svg>
                <span>エクスポート中...</span>
            `;

            if (progressContainer) progressContainer.style.display = 'block';
            if (progressBar) progressBar.style.width = '0%';
            if (etaText) etaText.textContent = '計算中...';

            const exportStartTime = Date.now();

            try {
                const videoBlob = await this.videoExporter.exportVideo(
                    state.keyframes,
                    duration,
                    fps,
                    settings,
                    (percent, text) => {
                        if (progressBar) progressBar.style.width = `${percent}%`;
                        if (percentText) percentText.textContent = `${percent}%`;
                        if (statusText) statusText.textContent = text;

                        // 大まかな残り時間（ETA）の算出と表示
                        if (percent >= 5 && percent < 100) {
                            const elapsedSec = (Date.now() - exportStartTime) / 1000;
                            const estimatedTotalSec = elapsedSec / (percent / 100);
                            const remainingSec = Math.max(1, Math.ceil(estimatedTotalSec - elapsedSec));
                            if (etaText) {
                                if (remainingSec < 60) {
                                    etaText.textContent = `残り約 ${remainingSec} 秒`;
                                } else {
                                    const min = Math.ceil(remainingSec / 60);
                                    etaText.textContent = `残り約 ${min} 分`;
                                }
                            }
                        } else if (percent >= 100 && etaText) {
                            etaText.textContent = '';
                        }
                    }
                );

                this.lastExportedBlob = videoBlob;

                // 完了時: ボタン切り替え（動画のみ保存 + ZIPでまとめて保存）
                if (btnStart) btnStart.style.display = 'none';
                if (etaText) etaText.textContent = '';

                // (1) 動画のみ保存 (btn-secondary)
                if (btnVideoOnly) {
                    btnVideoOnly.style.display = 'inline-flex';
                    btnVideoOnly.onclick = () => {
                        const baseName = (state.projectName || 'minimap-project').trim().replace(/[/\\?%*:|"<>]/g, '_');
                        const ext = videoBlob.type.includes('mp4') ? 'mp4' : 'webm';
                        const filename = `${baseName}-wipe.${ext}`;
                        const url = URL.createObjectURL(videoBlob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = filename;
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                        setTimeout(() => URL.revokeObjectURL(url), 10000);
                    };
                }

                // (2) ZIPでまとめて保存 (btn-accent / メイン)
                if (btnZip) {
                    btnZip.style.display = 'inline-flex';
                    btnZip.onclick = () => {
                        ZipExporter.downloadZipPackage(
                            this.lastExportedBlob,
                            state.keyframes,
                            duration,
                            settings,
                            state.projectName
                        );
                    };
                }
            } catch (err) {
                App.showModalAlert('エクスポート中にエラーが発生しました: ' + err.message, 'エラー', 'warning');
                if (exportSettingsContainer) exportSettingsContainer.style.display = 'block';
                btnStart.disabled = false;
                btnStart.innerHTML = `
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                        stroke-linecap="round" stroke-linejoin="round">
                        <polygon points="5 3 19 12 5 21 5 3"></polygon>
                    </svg>
                    <span>エクスポート開始</span>
                `;
                if (etaText) etaText.textContent = '';
            }
        });
    }
    // ============================================================
    // レスポンシブレイアウト & ビューポート高さ管理 (iOS Safari対応)
    // ============================================================

    initAppHeight() {
        const updateAppHeight = () => {
            const h = window.innerHeight;
            document.documentElement.style.setProperty('--app-height', h + 'px');
        };
        window.addEventListener('resize', updateAppHeight);
        window.addEventListener('orientationchange', () => {
            setTimeout(updateAppHeight, 150);
        });
        updateAppHeight();
    }

    initResponsiveLayout() {
        const videoControlBar = document.querySelector('.video-control-bar');
        const videoPane = document.querySelector('.video-pane');
        const workspaceBottom = document.querySelector('.workspace-bottom');
        const timelineToolbar = document.querySelector('.timeline-toolbar');

        if (!videoControlBar || !videoPane || !workspaceBottom || !timelineToolbar) return;

        const mql = window.matchMedia('(max-width: 768px)');
        const handleLayoutChange = (e) => {
            if (e.matches) {
                // スマートフォンの場合: .video-control-bar を .timeline-toolbar の直前に移動
                if (videoControlBar.parentElement !== workspaceBottom) {
                    workspaceBottom.insertBefore(videoControlBar, timelineToolbar);
                }
            } else {
                // デスクトップの場合: .video-control-bar を .video-pane の末尾に復帰
                if (videoControlBar.parentElement !== videoPane) {
                    videoPane.appendChild(videoControlBar);
                }
            }

            // 地図サイズの再計算
            if (this.mapController && this.mapController.map) {
                setTimeout(() => {
                    this.mapController.map.invalidateSize();
                }, 100);
            }
        };

        if (mql.addEventListener) {
            mql.addEventListener('change', handleLayoutChange);
        } else if (mql.addListener) {
            mql.addListener(handleLayoutChange);
        }
        handleLayoutChange(mql);
    }

    /**
     * モバイル・タッチ端末でボタン押下後に :active や :focus が残留して無効化に見える問題の対策
     */
    initMobileButtonActiveFix() {
        const clearButtonState = (target) => {
            const btn = target?.closest?.('button, .btn, .btn-ctrl, .btn-tool, .btn-kf-nav, .btn-pause-mode, .btn-delete-kf, .btn-close, [role="button"]');
            if (btn) {
                btn.blur();
                setTimeout(() => {
                    try {
                        btn.blur();
                    } catch (err) {}
                }, 40);
            }
        };

        document.addEventListener('touchend', (e) => clearButtonState(e.target), { passive: true });
        document.addEventListener('touchcancel', (e) => clearButtonState(e.target), { passive: true });
        document.addEventListener('click', (e) => {
            if (window.matchMedia('(hover: none) and (pointer: coarse), (max-width: 768px)').matches) {
                clearButtonState(e.target);
            }
        }, { passive: true });
    }


    // ============================================================
    // Supabase 認証管理 (メール/パスワード + OAuth)
    // ============================================================

    initAuth() {
        const modal = document.getElementById('authModal');
        const btnClose = document.getElementById('btnCloseAuthModal');
        const btnStartLogin = document.getElementById('btnStartLogin');
        const btnWsLogin = document.getElementById('btnWsLogin');
        const btnStartLogout = document.getElementById('btnStartLogout');
        const btnWsLogout = document.getElementById('btnWsLogout');
        const tabLogin = document.getElementById('tabAuthLogin');
        const tabRegister = document.getElementById('tabAuthRegister');
        const form = document.getElementById('authForm');
        const emailInput = document.getElementById('authEmail');
        const passwordInput = document.getElementById('authPassword');
        const submitBtn = document.getElementById('btnAuthSubmit');
        const errorMsg = document.getElementById('authErrorMsg');
        const successMsg = document.getElementById('authSuccessMsg');
        const btnGoogle = document.getElementById('btnAuthGoogle');
        // GitHub login removed

        let isLoginMode = true;

        const openAuthModal = (loginMode = true) => {
            isLoginMode = loginMode;
            if (tabLogin && tabRegister) {
                tabLogin.classList.toggle('active', isLoginMode);
                tabRegister.classList.toggle('active', !isLoginMode);
            }
            if (submitBtn) {
                const label = submitBtn.querySelector('span') || submitBtn;
                label.textContent = isLoginMode ? 'ログイン' : 'アカウント作成';
            }
            if (errorMsg) errorMsg.style.display = 'none';
            if (successMsg) successMsg.style.display = 'none';

            // モーダルを開いた時だけ入力を活性化
            if (emailInput) {
                emailInput.disabled = false;
                emailInput.value = '';
            }
            if (passwordInput) {
                passwordInput.disabled = false;
                passwordInput.value = '';
                passwordInput.autocomplete = isLoginMode ? 'current-password' : 'new-password';
            }
            modal?.classList.add('open');
            setTimeout(() => emailInput?.focus(), 50);
        };

        const closeAuthModal = () => {
            modal?.classList.remove('open');
            // 入力フィールドをクリア＆非活性化してブラウザのオートフィル保留キャッシュから切り離す
            if (emailInput) {
                emailInput.value = '';
                emailInput.disabled = true;
            }
            if (passwordInput) {
                passwordInput.value = '';
                passwordInput.disabled = true;
            }
            form?.reset();
        };

        btnStartLogin?.addEventListener('click', () => openAuthModal(true));
        btnWsLogin?.addEventListener('click', () => openAuthModal(true));
        btnClose?.addEventListener('click', closeAuthModal);
        modal?.addEventListener('click', (e) => {
            if (e.target === modal) closeAuthModal();
        });

        // ログアウト処理
        const handleLogout = async () => {
            const confirmed = await App.showModalConfirm(
                'ログアウトしますか？\n（ローカルの編集データは保持されます）',
                'ログアウトの確認',
                'ログアウト',
                'キャンセル'
            );
            if (confirmed) {
                try {
                    await this.cloudStorage.signOut();
                } catch (err) {
                    App.showModalAlert('ログアウトに失敗しました: ' + err.message, 'エラー', 'warning');
                }
            }
        };
        btnStartLogout?.addEventListener('click', handleLogout);
        btnWsLogout?.addEventListener('click', handleLogout);

        // タブ切り替え
        tabLogin?.addEventListener('click', () => {
            isLoginMode = true;
            tabLogin.classList.add('active');
            tabRegister?.classList.remove('active');
            if (submitBtn) {
                const label = submitBtn.querySelector('span') || submitBtn;
                label.textContent = 'ログイン';
            }
            if (errorMsg) errorMsg.style.display = 'none';
            if (successMsg) successMsg.style.display = 'none';
        });

        tabRegister?.addEventListener('click', () => {
            isLoginMode = false;
            tabRegister.classList.add('active');
            tabLogin?.classList.remove('active');
            if (submitBtn) {
                const label = submitBtn.querySelector('span') || submitBtn;
                label.textContent = 'アカウント作成';
            }
            if (errorMsg) errorMsg.style.display = 'none';
            if (successMsg) successMsg.style.display = 'none';
        });

        // フォーム送信
        form?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = emailInput?.value.trim();
            const password = passwordInput?.value;

            if (!email || !password) return;

            if (errorMsg) errorMsg.style.display = 'none';
            if (successMsg) successMsg.style.display = 'none';
            if (submitBtn) submitBtn.disabled = true;

            try {
                if (isLoginMode) {
                    await this.cloudStorage.signInWithPassword(email, password);
                    // ログイン成功時にパスワード保存ダイアログをその場で表示させる
                    if (window.PasswordCredential && navigator.credentials?.store) {
                        try {
                            const cred = new PasswordCredential({
                                id: email,
                                password: password,
                                name: email
                            });
                            await navigator.credentials.store(cred);
                        } catch (credErr) {
                            // 環境依存の制限は無視
                        }
                    }
                    closeAuthModal();
                } else {
                    const res = await this.cloudStorage.signUpWithPassword(email, password);
                    if (res?.user && (!res?.session)) {
                        if (successMsg) {
                            successMsg.textContent = '登録確認メールを送信しました。メール内のリンクを開いて登録を完了してください。';
                            successMsg.style.display = 'block';
                        }
                    } else {
                        if (window.PasswordCredential && navigator.credentials?.store) {
                            try {
                                const cred = new PasswordCredential({
                                    id: email,
                                    password: password,
                                    name: email
                                });
                                await navigator.credentials.store(cred);
                            } catch (credErr) {
                                // 環境依存の制限は無視
                            }
                        }
                        closeAuthModal();
                    }
                }
            } catch (err) {
                if (errorMsg) {
                    let msg = err.message || '認証に失敗しました';
                    if (msg.includes('Invalid login credentials')) {
                        msg = 'メールアドレスまたはパスワードが正しくありません。';
                    } else if (msg.includes('User already registered')) {
                        msg = 'このメールアドレスは既に登録されています。ログインをお試しください。';
                    } else if (msg.includes('Password should be at least')) {
                        msg = 'パスワードは6文字以上で設定してください。';
                    }
                    errorMsg.textContent = msg;
                    errorMsg.style.display = 'block';
                }
            } finally {
                if (submitBtn) submitBtn.disabled = false;
            }
        });

        // ソーシャルログイン (Google / GitHub)
        btnGoogle?.addEventListener('click', async () => {
            try {
                if (errorMsg) errorMsg.style.display = 'none';
                await this.cloudStorage.signInWithOAuth('google');
            } catch (err) {
                if (errorMsg) {
                    errorMsg.textContent = 'Googleログインに失敗しました: ' + (err.message || '');
                    errorMsg.style.display = 'block';
                }
            }
        });



        // ユーザー変更リスナー
        this.cloudStorage.onUserChange((user) => {
            this.renderAuthUI(user);
        });
    }

    renderAuthUI(user) {
        // スタート画面
        const startTopAuthBar = document.getElementById('startTopAuthBar');
        const startAuthUser = document.getElementById('startAuthUser');
        const startUserEmail = document.getElementById('startUserEmail');
        const btnStartLogout = document.getElementById('btnStartLogout');
        const btnStartLogin = document.getElementById('btnStartLogin');

        // デスクトップ認証インジケーター (ユーザーアイコン + 緑チェック / 赤X)
        const wsAuthCheck = document.getElementById('wsAuthCheck');
        const wsAuthCross = document.getElementById('wsAuthCross');

        // モバイルインジケーター (ユーザーアイコン + 緑チェック / 赤X)
        const wsMobileAuthCheck = document.getElementById('wsMobileAuthCheck');
        const wsMobileAuthCross = document.getElementById('wsMobileAuthCross');

        // モバイルドロップダウンメニュー内
        const wsMobileUserHeader = document.getElementById('wsMobileUserHeader');
        const wsMobileUserEmail = document.getElementById('wsMobileUserEmail');
        const iconMobileAuthLogin = document.getElementById('iconMobileAuthLogin');
        const iconMobileAuthLogout = document.getElementById('iconMobileAuthLogout');
        const textMobileAuthAction = document.getElementById('textMobileAuthAction');

        // 最上部アカウントバーは常時中央に表示
        if (startTopAuthBar) startTopAuthBar.style.display = 'flex';

        if (user) {
            const email = user.email || 'ユーザー';

            // スタート画面: ユーザー情報とログアウトボタンを表示、ログインボタン非表示
            if (startAuthUser) startAuthUser.style.display = 'inline-flex';
            if (startUserEmail) startUserEmail.textContent = email;
            if (btnStartLogout) btnStartLogout.style.display = 'inline-flex';
            if (btnStartLogin) btnStartLogin.style.display = 'none';

            // デスクトップヘッダーインジケーター: 緑チェック表示
            if (wsAuthCheck) wsAuthCheck.style.display = 'flex';
            if (wsAuthCross) wsAuthCross.style.display = 'none';

            // モバイルヘッダーインジケーター: 緑チェック表示
            if (wsMobileAuthCheck) wsMobileAuthCheck.style.display = 'flex';
            if (wsMobileAuthCross) wsMobileAuthCross.style.display = 'none';

            // モバイルメニュー内
            if (wsMobileUserHeader) wsMobileUserHeader.style.display = 'flex';
            if (wsMobileUserEmail) wsMobileUserEmail.textContent = email;
            if (iconMobileAuthLogin) iconMobileAuthLogin.style.display = 'none';
            if (iconMobileAuthLogout) iconMobileAuthLogout.style.display = 'inline';
            if (textMobileAuthAction) textMobileAuthAction.textContent = 'ログアウト';
        } else {
            // スタート画面: ログインボタンのみ表示
            if (startAuthUser) startAuthUser.style.display = 'none';
            if (btnStartLogout) btnStartLogout.style.display = 'none';
            if (btnStartLogin) btnStartLogin.style.display = 'inline-flex';

            // デスクトップヘッダーインジケーター: 赤X表示
            if (wsAuthCheck) wsAuthCheck.style.display = 'none';
            if (wsAuthCross) wsAuthCross.style.display = 'flex';

            // モバイルヘッダーインジケーター: 赤X表示
            if (wsMobileAuthCheck) wsMobileAuthCheck.style.display = 'none';
            if (wsMobileAuthCross) wsMobileAuthCross.style.display = 'flex';

            // モバイルメニュー内
            if (wsMobileUserHeader) wsMobileUserHeader.style.display = 'none';
            if (iconMobileAuthLogin) iconMobileAuthLogin.style.display = 'inline';
            if (iconMobileAuthLogout) iconMobileAuthLogout.style.display = 'none';
            if (textMobileAuthAction) textMobileAuthAction.textContent = 'ログイン';
        }
    }

    // ============================================================
    // クラウドプロジェクト管理 (Supabase JSONB 保存・復元)
    // ============================================================

    /**
     * クラウドプロジェクトモーダルを開く
     * @param {'open' | 'save' | 'manage'} mode 
     *   - 'open': スタート画面「クラウドから開く」や編集画面「クラウド」時。保存セクションを非表示にして一覧のみ表示
     *   - 'save': 編集画面「クラウドに保存」(保存)時。保存済み一覧を非表示にして保存セクションのみ表示
     *   - 'manage': 全表示
     */
    async openCloudModal(mode = 'manage') {
        if (!this.cloudStorage.currentUser) {
            const wantLogin = await App.showModalConfirm(
                'クラウド機能を利用するにはログインが必要です。\nログイン画面を開きますか？',
                'ログインが必要です',
                'ログイン',
                'キャンセル'
            );
            if (wantLogin) {
                const authModal = document.getElementById('authModal');
                authModal?.classList.add('open');
            }
            return;
        }

        const saveNameInput = document.getElementById('cloudProjectSaveName');
        if (saveNameInput) {
            saveNameInput.value = state.projectName || 'minimap-project';
        }

        const cloudSaveSection = document.getElementById('cloudSaveSection');
        const cloudSaveDivider = document.getElementById('cloudSaveDivider');
        const cloudListSection = document.getElementById('cloudListSection');
        const titleText = document.getElementById('cloudModalTitleText');

        if (mode === 'open') {
            // 開く専用モード: 保存セクションを非表示、一覧を表示
            if (cloudSaveSection) cloudSaveSection.style.display = 'none';
            if (cloudSaveDivider) cloudSaveDivider.style.display = 'none';
            if (cloudListSection) cloudListSection.style.display = 'block';
            if (titleText) titleText.textContent = 'クラウドから開く';
            this.loadAndRenderCloudProjects();
        } else if (mode === 'save') {
            // 保存専用モード: 一覧を非表示、保存セクションを表示
            if (cloudSaveSection) cloudSaveSection.style.display = 'block';
            if (cloudSaveDivider) cloudSaveDivider.style.display = 'none';
            if (cloudListSection) cloudListSection.style.display = 'none';
            if (titleText) titleText.textContent = 'クラウドに保存';
        } else {
            // 通常管理モード: 全表示
            if (cloudSaveSection) cloudSaveSection.style.display = 'block';
            if (cloudSaveDivider) cloudSaveDivider.style.display = 'block';
            if (cloudListSection) cloudListSection.style.display = 'block';
            if (titleText) titleText.textContent = 'クラウドプロジェクト管理';
            this.loadAndRenderCloudProjects();
        }

        this.updateCloudStatusUI();
        const modal = document.getElementById('cloudProjectsModal');
        modal?.classList.add('open');
    }

    initCloudProjects() {
        const modal = document.getElementById('cloudProjectsModal');
        const btnClose = document.getElementById('btnCloseCloudModal');
        const btnCloseFooter = document.getElementById('btnCloseCloudModalFooter');
        const btnCloudProjects = document.getElementById('btnCloudProjects');
        const btnCloudSave = document.getElementById('btnCloudSave');
        const btnExecuteSave = document.getElementById('btnExecuteCloudSave');
        const btnExecuteSaveAsNew = document.getElementById('btnExecuteCloudSaveAsNew');
        const btnRefresh = document.getElementById('btnRefreshCloudList');

        const closeCloudModal = () => {
            modal?.classList.remove('open');
        };

        btnCloudProjects?.addEventListener('click', () => this.openCloudModal('open'));
        btnCloudSave?.addEventListener('click', () => this.openCloudModal('save'));
        btnClose?.addEventListener('click', closeCloudModal);
        btnCloseFooter?.addEventListener('click', closeCloudModal);
        modal?.addEventListener('click', (e) => {
            if (e.target === modal) closeCloudModal();
        });

        btnRefresh?.addEventListener('click', () => {
            this.loadAndRenderCloudProjects();
        });

        // クラウド保存（既存上書きまたは新規）
        btnExecuteSave?.addEventListener('click', async () => {
            await this.handleSaveProject(false);
        });

        // 別名で保存（新規作成）
        btnExecuteSaveAsNew?.addEventListener('click', async () => {
            await this.handleSaveProject(true);
        });
    }

    updateCloudStatusUI() {
        const statusEl = document.getElementById('cloudCurrentStatus');
        const idText = document.getElementById('cloudCurrentIdText');
        const btnSaveAsNew = document.getElementById('btnExecuteCloudSaveAsNew');

        if (this.cloudStorage.currentProjectId) {
            if (statusEl) statusEl.style.display = 'flex';
            if (idText) idText.textContent = `連携中ID: ${this.cloudStorage.currentProjectId.slice(0, 8)}...`;
            if (btnSaveAsNew) btnSaveAsNew.style.display = 'inline-flex';
        } else {
            if (statusEl) statusEl.style.display = 'none';
            if (btnSaveAsNew) btnSaveAsNew.style.display = 'none';
        }
    }

    async handleSaveProject(forceNew = false) {
        const saveNameInput = document.getElementById('cloudProjectSaveName');
        const name = saveNameInput?.value.trim() || state.projectName || 'minimap-project';
        const btnExecuteSave = document.getElementById('btnExecuteCloudSave');

        if (btnExecuteSave) btnExecuteSave.disabled = true;

        try {
            const projectData = {
                projectName: name,
                fps: state.fps,
                videoDuration: state.videoDuration,
                videoFileName: state.videoFileName,
                keyframes: state.keyframes,
                exportSettings: state.exportSettings,
                previewQuality: state.previewQuality
            };

            await this.cloudStorage.saveProject(name, projectData, null, forceNew);
            state.projectName = name;
            const nameDisplay = document.getElementById('projectNameDisplay');
            if (nameDisplay) nameDisplay.textContent = name;

            this.updateCloudStatusUI();
            // 保存完了後は保存済み一覧の非表示を解除して表示
            const cloudListSection = document.getElementById('cloudListSection');
            const cloudSaveDivider = document.getElementById('cloudSaveDivider');
            const titleText = document.getElementById('cloudModalTitleText');
            if (cloudListSection) cloudListSection.style.display = 'block';
            if (cloudSaveDivider) cloudSaveDivider.style.display = 'block';
            if (titleText) titleText.textContent = 'クラウドプロジェクト管理';
            await this.loadAndRenderCloudProjects();

            App.showModalAlert(
                `プロジェクト「${name}」をクラウドに保存しました。`,
                '保存完了',
                'info'
            );
        } catch (err) {
            console.error('[CloudStorage] Save error:', err);
            let msg = err.message || 'クラウド保存に失敗しました';
            if (msg.includes('relation "public.projects" does not exist') || msg.includes('does not exist')) {
                msg = 'Supabase 側に projects テーブルが作成されていません。\nSupabase ダッシュボードの SQL Editor でテーブル定義スクリプトを実行してください。';
            }
            App.showModalAlert(msg, '保存エラー', 'warning');
        } finally {
            if (btnExecuteSave) btnExecuteSave.disabled = false;
        }
    }

    async loadAndRenderCloudProjects() {
        if (this._isLoadingCloudProjects) return;
        this._isLoadingCloudProjects = true;

        const spinner = document.getElementById('cloudLoadingSpinner');
        const emptyEl = document.getElementById('cloudProjectsEmpty');
        const listEl = document.getElementById('cloudProjectsList');

        if (spinner) spinner.style.display = 'flex';
        if (emptyEl) emptyEl.style.display = 'none';
        if (listEl) listEl.innerHTML = '';

        try {
            const projects = await this.cloudStorage.listProjects();
            if (spinner) spinner.style.display = 'none';

            // レンダリング直前に再度リストを完全にクリア（重複描画防止）
            if (listEl) listEl.innerHTML = '';

            if (!projects || projects.length === 0) {
                if (emptyEl) emptyEl.style.display = 'block';
                return;
            }

            projects.forEach((proj) => {
                const card = document.createElement('div');
                card.className = 'cloud-project-card';
                const isCurrent = proj.id === this.cloudStorage.currentProjectId;
                if (isCurrent) {
                    card.classList.add('active-project');
                }

                const kfCount = proj.data?.keyframes?.length || 0;
                const dateStr = new Date(proj.updated_at || proj.created_at).toLocaleString('ja-JP', {
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit'
                });
                const videoName = proj.data?.videoFileName ? `動画: ${proj.data.videoFileName}` : '動画なし';

                card.innerHTML = `
                    <div class="cloud-project-info">
                        <div class="cloud-project-title-row">
                            <span class="cloud-project-name">${escapeHtml(proj.name)}</span>
                            ${isCurrent ? '<span class="cloud-badge-current">編集中</span>' : ''}
                        </div>
                        <div class="cloud-project-meta">
                            <span>更新: ${dateStr}</span>
                            <span>地点数: ${kfCount}</span>
                            <span>${escapeHtml(videoName)}</span>
                        </div>
                    </div>
                    <div class="cloud-project-actions">
                        <button type="button" class="btn btn-primary btn-sm btn-cloud-open" title="このプロジェクトを開く">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M5 12h14"></path>
                                <path d="m12 5 7 7-7 7"></path>
                            </svg>
                            <span>開く</span>
                        </button>
                        <button type="button" class="btn btn-secondary btn-sm btn-cloud-delete" title="プロジェクトを削除">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <polyline points="3 6 5 6 21 6"></polyline>
                                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                            </svg>
                        </button>
                    </div>
                `;

                // 開くボタン
                card.querySelector('.btn-cloud-open')?.addEventListener('click', async () => {
                    await this.loadCloudProject(proj.id);
                });

                // 削除ボタン
                card.querySelector('.btn-cloud-delete')?.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const confirmed = await App.showModalConfirm(
                        `プロジェクト「${proj.name}」を削除しますか？\nこの操作は取り消せません。`,
                        'プロジェクトの削除',
                        '削除',
                        'キャンセル',
                        true
                    );
                    if (confirmed) {
                        try {
                            await this.cloudStorage.deleteProject(proj.id);
                            this.updateCloudStatusUI();
                            await this.loadAndRenderCloudProjects();
                        } catch (err) {
                            App.showModalAlert('削除に失敗しました: ' + err.message, 'エラー', 'warning');
                        }
                    }
                });

                listEl.appendChild(card);
            });
        } catch (err) {
            console.error('[CloudStorage] List error:', err);
            if (spinner) spinner.style.display = 'none';
            let msg = err.message || '一覧の取得に失敗しました';
            if (msg.includes('relation "public.projects" does not exist') || msg.includes('does not exist')) {
                msg = 'Supabase 側に projects テーブルが作成されていません。\nSupabase ダッシュボードの SQL Editor でテーブル定義スクリプトを実行してください。';
            }
            if (emptyEl) {
                emptyEl.textContent = msg;
                emptyEl.style.display = 'block';
            }
        } finally {
            this._isLoadingCloudProjects = false;
        }
    }

    async loadCloudProject(projectId) {
        try {
            const project = await this.cloudStorage.loadProject(projectId);
            if (!project || !project.data) {
                throw new Error('プロジェクトデータが存在しません');
            }

            state.restoreDraft(project.data);
            const nameDisplay = document.getElementById('projectNameDisplay');
            if (nameDisplay) nameDisplay.textContent = state.projectName;

            const modal = document.getElementById('cloudProjectsModal');
            modal?.classList.remove('open');

            this.showWorkspaceScreen();

            // 動画がまだロードされていない場合は案内
            if (!this.mainVideo.src || this.mainVideo.readyState === 0) {
                const vName = project.data?.videoFileName ? `（元動画: ${project.data.videoFileName}）` : '';
                App.showModalAlert(
                    `クラウドプロジェクト「${project.name}」を読み込みました。\n編集を再開するには動画ファイル${vName}を選択してください。`,
                    'プロジェクト読み込み完了',
                    'info'
                );
            }
        } catch (err) {
            App.showModalAlert('プロジェクトの読み込みに失敗しました: ' + err.message, 'エラー', 'warning');
        }
    }

    // ============================================================
    // 汎用ダイアログモーダルシステム (alert / confirm の代替)
    // ============================================================

    static showModalAlert(message, title = 'お知らせ', type = 'info') {
        return new Promise((resolve) => {
            const modal = document.getElementById('dialogModal');
            const titleEl = document.getElementById('dialogTitleText');
            const messageEl = document.getElementById('dialogMessage');
            const iconInfo = document.getElementById('dialogIconInfo');
            const iconWarning = document.getElementById('dialogIconWarning');
            const btnClose = document.getElementById('btnDialogClose');
            const btnCancel = document.getElementById('btnDialogCancel');
            const btnOk = document.getElementById('btnDialogOk');

            if (!modal) {
                alert(message);
                resolve();
                return;
            }

            if (titleEl) titleEl.textContent = title;
            if (messageEl) messageEl.textContent = message;

            if (iconInfo) iconInfo.style.display = type === 'warning' ? 'none' : 'inline';
            if (iconWarning) iconWarning.style.display = type === 'warning' ? 'inline' : 'none';

            if (btnCancel) btnCancel.style.display = 'none';
            if (btnOk) {
                btnOk.className = 'btn btn-primary';
                btnOk.textContent = 'OK';
            }

            const cleanup = () => {
                modal.classList.remove('open');
                btnClose?.removeEventListener('click', onOk);
                btnOk?.removeEventListener('click', onOk);
            };

            const onOk = () => {
                cleanup();
                resolve();
            };

            btnClose?.addEventListener('click', onOk);
            btnOk?.addEventListener('click', onOk);

            modal.classList.add('open');
        });
    }

    static showModalConfirm(message, title = '確認', okText = 'OK', cancelText = 'キャンセル', isDanger = false) {
        return new Promise((resolve) => {
            const modal = document.getElementById('dialogModal');
            const titleEl = document.getElementById('dialogTitleText');
            const messageEl = document.getElementById('dialogMessage');
            const iconInfo = document.getElementById('dialogIconInfo');
            const iconWarning = document.getElementById('dialogIconWarning');
            const btnClose = document.getElementById('btnDialogClose');
            const btnCancel = document.getElementById('btnDialogCancel');
            const btnOk = document.getElementById('btnDialogOk');

            if (!modal) {
                const result = confirm(message);
                resolve(result);
                return;
            }

            if (titleEl) titleEl.textContent = title;
            if (messageEl) messageEl.textContent = message;

            if (iconInfo) iconInfo.style.display = isDanger ? 'none' : 'inline';
            if (iconWarning) iconWarning.style.display = isDanger ? 'inline' : 'none';

            if (btnCancel) {
                btnCancel.style.display = 'inline-flex';
                btnCancel.textContent = cancelText;
            }
            if (btnOk) {
                btnOk.className = isDanger ? 'btn btn-danger' : 'btn btn-primary';
                btnOk.textContent = okText;
            }

            const cleanup = () => {
                modal.classList.remove('open');
                btnClose?.removeEventListener('click', onCancel);
                btnCancel?.removeEventListener('click', onCancel);
                btnOk?.removeEventListener('click', onConfirm);
            };

            const onConfirm = () => {
                cleanup();
                resolve(true);
            };

            const onCancel = () => {
                cleanup();
                resolve(false);
            };

            btnClose?.addEventListener('click', onCancel);
            btnCancel?.addEventListener('click', onCancel);
            btnOk?.addEventListener('click', onConfirm);

            modal.classList.add('open');
        });
    }
}

// スマホでのページ全体の不要な拡大・縮小を禁止 (iOS Safari対応)
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('gesturechange', (e) => e.preventDefault());
document.addEventListener('gestureend', (e) => e.preventDefault());

// アプリ起動
window.addEventListener('DOMContentLoaded', () => {
    window.app = new App();
});


function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
