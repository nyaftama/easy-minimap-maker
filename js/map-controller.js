/**
 * map-controller.js
 * Leaflet による OpenStreetMap 操作
 * - キーワード・GoogleマップURL・緯度経度ハイブリッド検索連携
 * - キーフレームピンのドラッグ微調整 & リアルタイムルート追従
 * - 地点通し番号 (#S, #1, #2...) のピン内表示
 * - 一時停止作成中の誤操作防止ガード
 * - ピン近傍ポップアップ (削除 / 現在時刻にコピー追加 / 時刻ジャンプ)
 */

import { state } from './state.js?v=1.00d';
import { RouteInterpolator } from './interpolator.js?v=1.00d';
import { MapSearch } from './map-search.js?v=1.00d';

export class MapController {
    constructor(containerId = 'leafletMap') {
        this.containerId = containerId;
        this.map = null;
        this.markersMap = new Map(); // kf.id -> L.Marker
        this.routePolyline = null;
        this.passedPolyline = null;
        this.currentPosMarker = null;
        this.isDraggingMarker = false;
        this.searchMarker = null;
        this.mapSearch = null;

        this.initMap();
        this.initEvents();
        this.initSearch();
    }

    initMap() {
        if (!window.L) {
            console.error('Leaflet is not loaded.');
            return;
        }

        // デフォルト東京駅周辺 (35.681236, 139.767125)
        this.map = L.map(this.containerId, {
            center: [35.681236, 139.767125],
            zoom: 16,
            zoomControl: true,
            rotate: false // 北上固定
        });

        // OpenStreetMap タイルレイヤー
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        }).addTo(this.map);

        // ルート表示ポリライン
        this.routePolyline = L.polyline([], {
            color: '#3b82f6',
            weight: 5,
            opacity: 0.65,
            lineCap: 'round',
            lineJoin: 'round'
        }).addTo(this.map);

        // 通過済みルート強調ポリライン
        this.passedPolyline = L.polyline([], {
            color: '#ef4444',
            weight: 6,
            opacity: 0.9,
            lineCap: 'round',
            lineJoin: 'round'
        }).addTo(this.map);

        // 現在地マーカー（パルス円）
        const pulseIcon = L.divIcon({
            className: 'current-pos-icon-wrapper',
            html: '<div class="current-pos-marker"></div>',
            iconSize: [20, 20],
            iconAnchor: [10, 10]
        });
        this.currentPosMarker = L.marker([35.681236, 139.767125], {
            icon: pulseIcon,
            zIndexOffset: 1000
        }).addTo(this.map);

        // ズーム変更表示
        this.map.on('zoomend', () => {
            const el = document.getElementById('mapZoomDisplay');
            if (el) el.textContent = `Zoom ${this.map.getZoom()}`;
        });

        // 地図クリック時: 同一タイムコードのキーフレームがあれば地点変更、なければ新規追加
        this.map.on('click', (e) => {
            // マーカーをドラッグ直後のマップクリックは無視
            if (this.isDraggingMarker) return;

            if (this.searchMarker) {
                this.map.removeLayer(this.searchMarker);
                this.searchMarker = null;
            }
            if (this.videoLocationMarker) {
                this.map.removeLayer(this.videoLocationMarker);
            }

            this.addKeyframeAtCoordinate(e.latlng.lat, e.latlng.lng);
        });
    }

    initEvents() {
        document.getElementById('btnFitBounds')?.addEventListener('click', () => this.fitBounds());
        document.getElementById('btnCenterCurrent')?.addEventListener('click', () => this.centerCurrent());

        // スマートフォン向けレイアウト切替（上下分割 / 左右分割）
        const btnToggleLayout = document.getElementById('btnToggleMobileLayout');
        const workspaceTop = document.querySelector('.workspace-top');

        // 保存されたレイアウト設定の復元
        try {
            const savedLayout = localStorage.getItem('vrm_mobile_layout');
            if (savedLayout === 'side-by-side' && workspaceTop) {
                workspaceTop.classList.add('mobile-side-by-side');
                if (btnToggleLayout) btnToggleLayout.title = '上下並びに切替';
            }
        } catch (e) {
            // ignore
        }

        btnToggleLayout?.addEventListener('click', () => {
            const isSideBySide = workspaceTop?.classList.toggle('mobile-side-by-side');
            if (btnToggleLayout) {
                btnToggleLayout.title = isSideBySide ? '上下並びに切替' : '左右並びに切替';
            }
            try {
                localStorage.setItem('vrm_mobile_layout', isSideBySide ? 'side-by-side' : 'stacked');
            } catch (e) {
                // ignore
            }

            // レイアウト切替時は一時検索バーを閉じる
            closeSideSearch();

            // 地図描画崩れ防止のリサイズ再計算
            requestAnimationFrame(() => {
                this.map?.invalidateSize();
            });
            setTimeout(() => {
                this.map?.invalidateSize();
            }, 150);
        });

        // 横並び表示時の検索ボタントグル ＆ 一時表示コントロール
        const btnToggleSearch = document.getElementById('btnToggleSideSearch');
        const searchBar = document.getElementById('mapSearchBar');
        const searchInput = document.getElementById('mapSearchInput');
        const btnSearchClose = document.getElementById('btnMapSearchClose');

        const openSideSearch = () => {
            if (!searchBar) return;
            searchBar.classList.add('temporary-open');
            setTimeout(() => {
                searchInput?.focus();
            }, 50);
        };

        const closeSideSearch = () => {
            if (!searchBar) return;
            searchBar.classList.remove('temporary-open');
            this.mapSearch?.clearResults();
            searchInput?.blur();
        };

        btnToggleSearch?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (searchBar?.classList.contains('temporary-open')) {
                closeSideSearch();
            } else {
                openSideSearch();
            }
        });

        btnSearchClose?.addEventListener('click', (e) => {
            e.stopPropagation();
            closeSideSearch();
        });

        // 検索結果選択時に一時検索バーを閉じる
        const originalHandleSearchResult = this.handleSearchResult.bind(this);
        this.handleSearchResult = (item) => {
            originalHandleSearchResult(item);
            closeSideSearch();
        };

        // ポップアップ内「この地点でキーフレームを追加」ボタンのクリック委任
        document.addEventListener('click', (e) => {
            const btn = e.target.closest('.btn-add-kf-from-popup');
            if (btn) {
                e.preventDefault();
                e.stopPropagation();
                const lat = parseFloat(btn.dataset.lat);
                const lng = parseFloat(btn.dataset.lng);
                if (!isNaN(lat) && !isNaN(lng)) {
                    this.addKeyframeAtCoordinate(lat, lng);
                    this.map?.closePopup();
                    if (this.searchMarker) {
                        this.map.removeLayer(this.searchMarker);
                        this.searchMarker = null;
                    }
                    if (this.videoLocationMarker) {
                        this.map.removeLayer(this.videoLocationMarker);
                    }
                }
            }
        });

        state.subscribe((eventType, payload) => {
            if (eventType === 'keyframes_updated' || eventType === 'project_restored' || eventType === 'project_reset') {
                this.renderKeyframeMarkers();
                this.updateRouteLines();
                this.updateCurrentPos();
            } else if (eventType === 'selection_changed') {
                this.updateMarkerSelectionStyles();
            } else if (eventType === 'time_updated') {
                this.updateCurrentPos();
            }
        });
    }

    /** キーフレームマーカーの描画・更新（ドラッグ対応 & 地点番号付き） */
    renderKeyframeMarkers() {
        if (!this.map) return;

        const currentIds = new Set(state.keyframes.map(k => k.id));

        // 不要になったマーカーを削除
        for (const [id, marker] of this.markersMap.entries()) {
            if (!currentIds.has(id)) {
                this.map.removeLayer(marker);
                this.markersMap.delete(id);
            }
        }

        // マーカーの追加・更新
        state.keyframes.forEach(kf => {
            let marker = this.markersMap.get(kf.id);
            const isPause = kf.type === 'pause_start' || kf.type === 'pause_end';
            const isSelected = state.selectedIds.has(kf.id);

            // 地点ベースの通し番号を取得 (一時停止の終了も開始と同一番号)
            const numInfo = state.getKeyframeNumberInfo(kf.id);
            const pinDisplayNum = numInfo.num;

            const iconHtml = `
                <div class="map-kf-pin ${isPause ? 'pause-pin' : ''} ${isSelected ? 'selected-pin' : ''}">
                    <span class="pin-number">${pinDisplayNum}</span>
                </div>
            `;
            const customIcon = L.divIcon({
                className: 'map-kf-icon-container',
                html: iconHtml,
                iconSize: [26, 26],
                iconAnchor: [13, 13]
            });

            if (!marker) {
                marker = L.marker([kf.lat, kf.lng], {
                    icon: customIcon,
                    draggable: true,
                    title: `地点 #${numInfo.label} (${kf.time.toFixed(2)}s)`
                }).addTo(this.map);

                // ドラッグ開始
                marker.on('dragstart', () => {
                    if (state.isPausing) {
                        marker.dragging.disable();
                        return;
                    }
                    this.isDraggingMarker = true;
                    marker.closePopup();
                });

                // ドラッグ中のリアルタイムルートライン追従
                marker.on('drag', (e) => {
                    const tempLatLng = e.target.getLatLng();
                    kf.lat = tempLatLng.lat;
                    kf.lng = tempLatLng.lng;

                    // ペアキーフレームも一時追従
                    if (kf.pairId) {
                        const pairKf = state.keyframes.find(k => k.id === kf.pairId);
                        if (pairKf) {
                            pairKf.lat = tempLatLng.lat;
                            pairKf.lng = tempLatLng.lng;
                            const pairMarker = this.markersMap.get(pairKf.id);
                            if (pairMarker) pairMarker.setLatLng(tempLatLng);
                        }
                    }

                    this.updateRouteLines();
                    this.updateCurrentPos();
                });

                // ドラッグ終了で正式にステート更新
                marker.on('dragend', (e) => {
                    const newLatLng = e.target.getLatLng();
                    state.updateKeyframe(kf.id, {
                        lat: newLatLng.lat,
                        lng: newLatLng.lng
                    });
                    setTimeout(() => {
                        this.isDraggingMarker = false;
                    }, 100);
                });

                // ポップアップ設定
                this.bindPinPopup(marker, kf, numInfo.label);

                this.markersMap.set(kf.id, marker);
            } else {
                marker.setLatLng([kf.lat, kf.lng]);
                marker.setIcon(customIcon);
                this.bindPinPopup(marker, kf, numInfo.label);
            }
        });
    }

    /** マップピンクリック時の確認ポップアップ */
    bindPinPopup(marker, kf, pinLabel) {
        const popupContent = document.createElement('div');
        popupContent.className = 'map-popup-card';
        popupContent.innerHTML = `
            <div class="map-popup-header">
                <span>地点 #${pinLabel}</span>
                <span>${kf.time.toFixed(2)}s</span>
            </div>
            <div class="map-popup-actions">
                <button type="button" class="map-popup-btn map-popup-btn-copy" id="popupBtnCopy_${kf.id}">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="12" y1="5" x2="12" y2="19"></line>
                        <line x1="5" y1="12" x2="19" y2="12"></line>
                    </svg>
                    <span>現在時刻にこの地点を追加</span>
                </button>
                <button type="button" class="map-popup-btn map-popup-btn-jump" id="popupBtnJump_${kf.id}">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polygon points="5 3 19 12 5 21 5 3"></polygon>
                    </svg>
                    <span>この時刻 (${kf.time.toFixed(1)}s) へ移動</span>
                </button>
                <button type="button" class="map-popup-btn map-popup-btn-delete" id="popupBtnDelete_${kf.id}">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="3 6 5 6 21 6"></polyline>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    </svg>
                    <span>この地点を削除</span>
                </button>
            </div>
        `;

        popupContent.querySelector(`#popupBtnCopy_${kf.id}`)?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (state.isPausing) return;
            marker.closePopup();
            state.addKeyframe(state.currentTime, kf.lat, kf.lng, kf.zoom);
        });

        popupContent.querySelector(`#popupBtnJump_${kf.id}`)?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (state.isPausing) return;
            marker.closePopup();
            state.selectSingle(kf.id);
            if (window.app && window.app.videoController) {
                window.app.videoController.seekTo(kf.time);
            }
        });

        popupContent.querySelector(`#popupBtnDelete_${kf.id}`)?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (state.isPausing) return;
            marker.closePopup();
            state.deleteKeyframes([kf.id]);
        });

        marker.bindPopup(popupContent, {
            offset: [0, -10],
            closeButton: true,
            autoPan: true
        });

        marker.on('click', () => {
            // マップ上のピンクリック時はタイムライン選択を行わず、ピン近傍ポップアップのみ表示
            state.clearSelection();
        });
    }

    /** 選択状態によるマッカースタイル更新 */
    updateMarkerSelectionStyles() {
        state.keyframes.forEach(kf => {
            const marker = this.markersMap.get(kf.id);
            if (!marker) return;

            const isPause = kf.type === 'pause_start' || kf.type === 'pause_end';
            const isSelected = state.selectedIds.has(kf.id);
            const numInfo = state.getKeyframeNumberInfo(kf.id);

            const iconHtml = `
                <div class="map-kf-pin ${isPause ? 'pause-pin' : ''} ${isSelected ? 'selected-pin' : ''}">
                    <span class="pin-number">${numInfo.num}</span>
                </div>
            `;
            marker.setIcon(L.divIcon({
                className: 'map-kf-icon-container',
                html: iconHtml,
                iconSize: [26, 26],
                iconAnchor: [13, 13]
            }));
        });
    }

    /** 全体ルートラインの更新 */
    updateRouteLines() {
        if (!this.routePolyline) return;

        if (state.keyframes.length < 2) {
            this.routePolyline.setLatLngs([]);
            this.passedPolyline.setLatLngs([]);
            return;
        }

        const points = state.keyframes.map(k => [k.lat, k.lng]);
        this.routePolyline.setLatLngs(points);
    }

    /** 現在時刻の位置更新・通過済みルート更新 */
    updateCurrentPos() {
        if (!this.map || !this.currentPosMarker) return;

        const currentPos = RouteInterpolator.interpolate(state.keyframes, state.currentTime);
        if (!currentPos) {
            this.currentPosMarker.setOpacity(0);
            this.passedPolyline?.setLatLngs([]);
            return;
        }

        this.currentPosMarker.setOpacity(1);
        this.currentPosMarker.setLatLng([currentPos.lat, currentPos.lng]);

        // 現在時刻と一致しているキーフレームピンを最前面にし、ドラッグしやすくする
        state.keyframes.forEach(kf => {
            const marker = this.markersMap.get(kf.id);
            if (marker) {
                const isCurrent = Math.abs(kf.time - state.currentTime) < 0.1;
                marker.setZIndexOffset(isCurrent ? 2500 : 0);
            }
        });

        if (state.keyframes.length >= 2) {
            const passedPoints = [];
            for (const kf of state.keyframes) {
                if (kf.time <= state.currentTime) {
                    passedPoints.push([kf.lat, kf.lng]);
                } else {
                    break;
                }
            }
            passedPoints.push([currentPos.lat, currentPos.lng]);
            this.passedPolyline?.setLatLngs(passedPoints);
        }
    }

    fitBounds() {
        if (state.keyframes.length === 0) return;
        if (state.keyframes.length === 1) {
            this.map.setView([state.keyframes[0].lat, state.keyframes[0].lng], state.keyframes[0].zoom || 16);
            return;
        }
        const bounds = L.latLngBounds(state.keyframes.map(k => [k.lat, k.lng]));
        this.map.fitBounds(bounds, { padding: [40, 40] });
    }

    centerCurrent() {
        const currentPos = RouteInterpolator.interpolate(state.keyframes, state.currentTime);
        if (currentPos) {
            this.map.panTo([currentPos.lat, currentPos.lng], { animate: true });
        }
    }

    /**
     * 指定した座標のマーカーが画面中央より下（検索バー等の被り防止）に表示されるよう、
     * 画面中心位置を上方にオフセットして flyTo を実行
     * @param {[number, number]} latlng - 目的地点の座標 [lat, lng]
     * @param {number} zoom - ズームレベル
     * @param {number} offsetY - ピクセル単位のオフセット (デフォルト -60: 中心を60px上に移動＝マーカーは60px下に表示)
     */
    flyToWithOffset(latlng, zoom, offsetY = -60) {
        if (!this.map) return;
        try {
            const targetPoint = this.map.project(latlng, zoom);
            const centerPoint = L.point(targetPoint.x, targetPoint.y + offsetY);
            const centerLatLng = this.map.unproject(centerPoint, zoom);
            this.map.flyTo(centerLatLng, zoom, { duration: 1.2 });
        } catch (e) {
            this.map.flyTo(latlng, zoom, { duration: 1.2 });
        }
    }

    initSearch() {
        this.mapSearch = new MapSearch({
            onSelect: (item) => this.handleSearchResult(item)
        });
    }

    handleSearchResult(item) {
        if (!this.map) return;
        const targetZoom = Math.max(this.map.getZoom(), 16);
        this.flyToWithOffset([item.lat, item.lng], targetZoom, -60);

        if (this.searchMarker) {
            this.map.removeLayer(this.searchMarker);
            this.searchMarker = null;
        }

        const searchIcon = L.divIcon({
            className: 'search-result-marker-icon',
            html: `
                <div class="search-result-pin">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="10" r="3"></circle>
                    </svg>
                </div>
            `,
            iconSize: [24, 24],
            iconAnchor: [12, 24],
            popupAnchor: [0, -26]
        });

        this.searchMarker = L.marker([item.lat, item.lng], {
            icon: searchIcon,
            zIndexOffset: 500
        }).addTo(this.map);

        this.searchMarker.bindPopup(`
            <div style="font-size: 12px; line-height: 1.4; padding: 2px 0; min-width: 170px;">
                <strong style="color: #ffffff; font-size: 13px; font-weight: 700; display: block;">${this.escapeHtml(item.name)}</strong>
                <div style="color: #94a3b8; font-size: 11px; margin-top: 3px;">${this.escapeHtml(item.subtext)}</div>
                <button type="button" class="btn-add-kf-from-popup" data-lat="${item.lat}" data-lng="${item.lng}">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="12" y1="5" x2="12" y2="19"></line>
                        <line x1="5" y1="12" x2="19" y2="12"></line>
                    </svg>
                    <span>この地点でキーフレームを追加</span>
                </button>
            </div>
        `).openPopup();
    }

    escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /** 指定座標にキーフレームを追加・更新 */
    addKeyframeAtCoordinate(lat, lng) {
        if (!this.map) return null;
        const currentZoom = this.map.getZoom();

        // 一時停止作成中はキーフレーム追加・変更を無効化
        if (state.isPausing) {
            state.notify('toast_warning', { message: '一時停止の作成中です。「一時停止を終了」を押してください' });
            return null;
        }

        // 現在時刻付近 (0.1秒以内) に既にキーフレームが存在するかチェック
        const existingKf = state.findKeyframeNearTime(state.currentTime, 0.1);
        if (existingKf) {
            state.updateKeyframe(existingKf.id, {
                lat,
                lng,
                zoom: currentZoom
            });
            state.selectSingle(existingKf.id);
            return existingKf;
        } else {
            const newKf = state.addKeyframe(state.currentTime, lat, lng, currentZoom);
            if (newKf) {
                state.selectSingle(newKf.id);
            }
            return newKf;
        }
    }

    /** 動画ファイルの位置情報へマップを移動 */

}
