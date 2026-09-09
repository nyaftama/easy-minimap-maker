/**
 * map-search.js
 * OpenStreetMap (Leaflet) 向けハイブリッド検索モジュール
 * 1. GoogleマップURL / 緯度経度の自動検出・即座抽出
 * 2. 国土地理院 ジオコーダー API (国内の地名・駅名・住所・交差点)
 * 3. OSM Photon API (施設名・海外地名・インクリメンタル補完)
 */

import { getMunicipalityName } from './muni-data.js?v=1.00g';

/**
 * 日本の住所文字列から「都道府県＋市区町村」と「町名・詳細」を分離
 * @param {string} fullAddress 例: "新潟県長岡市中央公園", "東京都中央区八重洲一丁目"
 */
function parseAddressParts(fullAddress) {
    if (!fullAddress || typeof fullAddress !== 'string') return null;
    const str = fullAddress.trim();

    // 1. 都道府県の検出 (1都1道2府43県)
    const prefMatch = str.match(/^(東京都|北海道|(?:京都|大阪)府|.{2,3}県)/);
    if (!prefMatch) return null;

    const pref = prefMatch[1];
    const restAfterPref = str.slice(pref.length);

    // 2. 市区町村の検出
    // パターン1: 郡 + 町村 (例: 西多摩郡日の出町)
    // パターン2: 市 + 区 (政令指定都市 例: 札幌市中央区, 横浜市中区)
    // パターン3: 単独の 市 / 区 / 町 / 村
    let city = '';
    let town = '';

    const gunMatch = restAfterPref.match(/^(.+?郡.+?[町村])/);
    const seireiMatch = restAfterPref.match(/^(.+?市.+?区)/);
    const normalMatch = restAfterPref.match(/^(.+?[市区町村])/);

    if (gunMatch) {
        city = gunMatch[1];
        town = restAfterPref.slice(city.length);
    } else if (seireiMatch) {
        city = seireiMatch[1];
        town = restAfterPref.slice(city.length);
    } else if (normalMatch) {
        city = normalMatch[1];
        town = restAfterPref.slice(city.length);
    } else {
        town = restAfterPref;
    }

    return {
        pref,
        city,
        municipality: `${pref}${city}`,
        town: town || fullAddress
    };
}

export class MapSearch {
    constructor(options = {}) {
        this.container = options.container || document.getElementById('mapSearchBar');
        this.input = options.input || document.getElementById('mapSearchInput');
        this.clearBtn = options.clearBtn || document.getElementById('mapSearchClear');
        this.resultsContainer = options.resultsContainer || document.getElementById('mapSearchResults');
        this.spinner = options.spinner || document.getElementById('mapSearchSpinner');
        this.onSelect = options.onSelect || (() => {});

        this.debounceTimer = null;
        this.currentResults = [];
        this.activeAbortController = null;

        this.init();
    }

    init() {
        if (!this.input || !this.resultsContainer) return;

        // IME入力・変換状態のトラッキング (Safari/iOS/Chrome等のブラウザ差を完全吸収)
        let isComposing = false;
        this.input.addEventListener('compositionstart', () => {
            isComposing = true;
        });
        this.input.addEventListener('compositionend', () => {
            // compositionend直後にkeydown(Enter)が発火する環境があるため微小遅延で解除
            setTimeout(() => {
                isComposing = false;
            }, 20);
        });

        // 入力イベント (デバウンス検索)
        this.input.addEventListener('input', (e) => {
            const query = e.target.value.trim();
            this.updateClearButton();

            if (!query) {
                this.clearResults();
                return;
            }

            // 1. GoogleマップURL または 緯度経度の即時判定
            const directCoord = this.parseCoordinateOrUrl(query);
            if (directCoord) {
                this.currentResults = [directCoord];
                this.renderResults(this.currentResults);
                return;
            }

            // 2. キーワード検索 (国土地理院 + OSM Photon)
            clearTimeout(this.debounceTimer);
            this.debounceTimer = setTimeout(() => {
                this.searchHybrid(query);
            }, 300);
        });

        // キーボード操作 (Enter で先頭決定, Esc で閉じる)
        this.input.addEventListener('keydown', (e) => {
            // 日本語変換確定時のEnterキー押下は無視
            if (e.isComposing || isComposing || e.keyCode === 229) {
                return;
            }

            if (e.key === 'Enter') {
                e.preventDefault();
                if (this.currentResults.length > 0) {
                    this.selectItem(this.currentResults[0]);
                } else if (this.input.value.trim()) {
                    // 入力確定時に即時検索
                    clearTimeout(this.debounceTimer);
                    this.searchHybrid(this.input.value.trim(), true);
                }
            } else if (e.key === 'Escape') {
                this.clearResults();
                this.input.blur();
            }
        });

        // クリアボタン
        this.clearBtn?.addEventListener('click', () => {
            this.input.value = '';
            this.updateClearButton();
            this.clearResults();
            this.input.focus();
        });

        // 外部クリックでドロップダウンを閉じる
        document.addEventListener('click', (e) => {
            if (this.container && !this.container.contains(e.target)) {
                this.clearResults();
            }
        });

        // フォーカス時に入力があれば再表示
        this.input.addEventListener('focus', () => {
            if (this.currentResults.length > 0) {
                this.resultsContainer.classList.add('show');
            }
        });

        // 検索候補のスクロールが背面のLeaflet地図に伝播して地図がズーム・移動するのを防止
        this.resultsContainer.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
        this.resultsContainer.addEventListener('touchmove', (e) => e.stopPropagation(), { passive: true });
        this.resultsContainer.addEventListener('pointerdown', (e) => e.stopPropagation());
    }

    updateClearButton() {
        if (!this.clearBtn) return;
        this.clearBtn.style.display = this.input.value.trim() ? 'flex' : 'none';
    }

    showSpinner(visible) {
        if (!this.spinner) return;
        this.spinner.style.display = visible ? 'flex' : 'none';
    }

    clearResults() {
        this.currentResults = [];
        if (this.resultsContainer) {
            this.resultsContainer.innerHTML = '';
            this.resultsContainer.classList.remove('show');
        }
        this.showSpinner(false);
    }

    /**
     * 緯度経度またはGoogleマップURLを正規表現で解析
     */
    parseCoordinateOrUrl(text) {
        if (!text) return null;
        const clean = text.trim();

        // 1. GoogleマップURL内の @lat,lng パターン
        const atMatch = clean.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
        if (atMatch) {
            const lat = parseFloat(atMatch[1]);
            const lng = parseFloat(atMatch[2]);
            if (this.isValidLatLng(lat, lng)) {
                return {
                    name: `Googleマップ指定地点 (${lat.toFixed(5)}, ${lng.toFixed(5)})`,
                    subtext: 'GoogleマップURLから座標を抽出',
                    lat,
                    lng,
                    source: 'coord'
                };
            }
        }

        // 2. GoogleマップURLクエリ内の ?q=lat,lng または ?ll=lat,lng パターン
        const queryMatch = clean.match(/[?&](?:q|ll)=(-?\d+\.\d+),(-?\d+\.\d+)/);
        if (queryMatch) {
            const lat = parseFloat(queryMatch[1]);
            const lng = parseFloat(queryMatch[2]);
            if (this.isValidLatLng(lat, lng)) {
                return {
                    name: `Googleマップ検索地点 (${lat.toFixed(5)}, ${lng.toFixed(5)})`,
                    subtext: 'GoogleマップURLから座標を抽出',
                    lat,
                    lng,
                    source: 'coord'
                };
            }
        }

        // 3. 純粋な緯度経度表記 (例: "35.681236, 139.767125" または "35.681236 139.767125")
        const coordMatch = clean.match(/^([+-]?\d+(?:\.\d+)?)[,\s]+([+-]?\d+(?:\.\d+)?)$/);
        if (coordMatch) {
            const lat = parseFloat(coordMatch[1]);
            const lng = parseFloat(coordMatch[2]);
            if (this.isValidLatLng(lat, lng)) {
                return {
                    name: `直接入力座標 (${lat.toFixed(5)}, ${lng.toFixed(5)})`,
                    subtext: '緯度・経度直接指定',
                    lat,
                    lng,
                    source: 'coord'
                };
            }
        }

        return null;
    }

    isValidLatLng(lat, lng) {
        return !isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
    }

    /**
     * ハイブリッド検索 (国土地理院 ジオコーダー + OSM Photon)
     */
    async searchHybrid(query, autoSelectFirst = false) {
        if (this.activeAbortController) {
            this.activeAbortController.abort();
        }
        this.activeAbortController = new AbortController();
        const signal = this.activeAbortController.signal;

        this.showSpinner(true);

        try {
            // 国土地理院API と OSM Photon API を並行実行
            const [gsiResults, photonResults] = await Promise.allSettled([
                this.searchGsi(query, signal),
                this.searchPhoton(query, signal)
            ]);

            const listA = gsiResults.status === 'fulfilled' ? gsiResults.value : [];
            const listB = photonResults.status === 'fulfilled' ? photonResults.value : [];

            // スコアリング・重複除外・並び替え
            const merged = this.mergeResults(listA, listB, query);

            this.showSpinner(false);
            this.currentResults = merged;

            if (autoSelectFirst && merged.length > 0) {
                this.selectItem(merged[0]);
            } else {
                this.renderResults(merged);
            }
        } catch (err) {
            if (err.name !== 'AbortError') {
                console.warn('Map search error:', err);
                this.showSpinner(false);
            }
        }
    }

    /**
     * 国土地理院 ジオコーダー API (AddressSearch)
     * - 全国住所コード順（北海道〜）で返るため、クエリ含有チェックとスコアリングを実施
     */
    async searchGsi(query, signal) {
        try {
            const url = `https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(query)}`;
            const res = await fetch(url, { signal });
            if (!res.ok) return [];
            const data = await res.json();
            if (!Array.isArray(data)) return [];

            const qLower = query.trim().toLowerCase();
            // クエリ文字列を名前に含むものを優先抽出
            const hasExactOrContains = data.some(item => (item.properties?.title || '').toLowerCase().includes(qLower));
            const filteredData = hasExactOrContains
                ? data.filter(item => (item.properties?.title || '').toLowerCase().includes(qLower))
                : data.slice(0, 30);

            return filteredData.map(item => {
                const [lng, lat] = item.geometry.coordinates;
                const title = item.properties?.title || '';
                const code = item.properties?.addressCode || '';

                let name = title;
                let subtext = '';

                // 1. addressCode（JISコード）から都道府県・市区町村名を取得
                const muniFromCode = getMunicipalityName(code);

                // 2. title から都道府県・市区町村・町名をパース
                const parsed = parseAddressParts(title);

                if (parsed && parsed.municipality) {
                    subtext = parsed.municipality;
                    if (parsed.town && parsed.town !== title) {
                        name = parsed.town;
                    }
                } else if (muniFromCode) {
                    subtext = muniFromCode;
                    name = title;
                } else {
                    subtext = '日本';
                }

                return {
                    name,
                    subtext, // 都道府県と市区町村名を表示
                    lat,
                    lng,
                    source: 'gsi',
                    rawTitle: title
                };
            });
        } catch (e) {
            return [];
        }
    }

    /**
     * OSM Photon API (施設名・海外地名)
     * - lang パラメータは ja 非対応のため省略 (クエリ文字列でそのまま検索)
     */
    async searchPhoton(query, signal) {
        try {
            const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=8`;
            const res = await fetch(url, { signal });
            if (!res.ok) return [];
            const data = await res.json();
            if (!data || !Array.isArray(data.features)) return [];

            return data.features.map(f => {
                const [lng, lat] = f.geometry.coordinates;
                const p = f.properties;

                let subtext = '';
                if (p.countrycode === 'JP' || p.country === '日本') {
                    // 日本国内: 都道府県 → 市区町村 の順で構築
                    const parts = [];
                    if (p.state) parts.push(p.state);
                    if (p.city && !parts.includes(p.city)) parts.push(p.city);
                    if (p.district && !parts.includes(p.district)) parts.push(p.district);
                    if (p.locality && !parts.includes(p.locality)) parts.push(p.locality);
                    subtext = parts.join(' ') || p.country || '日本';
                } else {
                    // 海外: 都市, 州, 国
                    const parts = [p.city, p.state, p.country].filter(Boolean);
                    subtext = parts.join(', ') || '海外';
                }

                return {
                    name: p.name || p.street || '名称未設定',
                    subtext, // 都道府県と市区町村名を表示
                    lat,
                    lng,
                    source: 'osm'
                };
            });
        } catch (e) {
            return [];
        }
    }

    /**
     * 複数検索結果のスコアリング・マージ・近接重複除外
     */
    mergeResults(gsiList, osmList, query) {
        const qLower = query.trim().toLowerCase();
        const allItems = [...gsiList, ...osmList];

        // 1. スコアリング
        allItems.forEach(item => {
            const nameLower = (item.name || '').toLowerCase();
            let score = 0;

            if (nameLower === qLower) {
                score = 1000;
            } else if (nameLower.startsWith(qLower)) {
                score = 800 - nameLower.length;
            } else if (nameLower.includes(qLower)) {
                score = 500 - nameLower.length;
            } else {
                score = 100;
            }

            // 国土地理院（公式データ）に優先ボーナス
            if (item.source === 'gsi') {
                score += 15;
            }

            item.score = score;
        });

        // スコア降順ソート
        allItems.sort((a, b) => b.score - a.score);

        // 2. 近接重複除外 (同一名称で約1.5km以内、または同一座標)
        const results = [];
        const seenCoords = new Set();

        for (const item of allItems) {
            const coordKey = `${item.lat.toFixed(3)}_${item.lng.toFixed(3)}`;
            if (seenCoords.has(coordKey)) continue;

            const isDuplicateNearby = results.some(existing => {
                const sameName = (existing.name === item.name) ||
                    (existing.rawTitle && existing.rawTitle.includes(item.name)) ||
                    (item.rawTitle && item.rawTitle.includes(existing.name));
                const dLat = Math.abs(existing.lat - item.lat);
                const dLng = Math.abs(existing.lng - item.lng);
                return (sameName && dLat < 0.015 && dLng < 0.015) || (dLat < 0.003 && dLng < 0.003);
            });

            if (isDuplicateNearby) continue;

            seenCoords.add(coordKey);
            results.push(item);
            if (results.length >= 8) break;
        }

        return results;
    }

    /**
     * 検索結果ドロップダウンリストの描画
     */
    renderResults(items) {
        if (!this.resultsContainer) return;
        this.resultsContainer.innerHTML = '';

        if (!items || items.length === 0) {
            const emptyEl = document.createElement('div');
            emptyEl.className = 'map-search-empty';
            emptyEl.textContent = '一致する場所が見つかりませんでした';
            this.resultsContainer.appendChild(emptyEl);
            this.resultsContainer.classList.add('show');
            return;
        }

        items.forEach(item => {
            const el = document.createElement('div');
            el.className = 'map-search-item';

            // バッジ情報
            let badgeText = '地名';
            let badgeClass = 'badge-gsi';
            if (item.source === 'coord') {
                badgeText = '座標';
                badgeClass = 'badge-coord';
            } else if (item.source === 'osm') {
                badgeText = 'OSM';
                badgeClass = 'badge-osm';
            }

            el.innerHTML = `
                <div class="search-item-main">
                    <span class="search-item-name">${this.escapeHtml(item.name)}</span>
                    <span class="search-item-badge ${badgeClass}">${badgeText}</span>
                </div>
                <div class="search-item-sub">${this.escapeHtml(item.subtext)}</div>
            `;

            el.addEventListener('click', () => {
                this.selectItem(item);
            });

            this.resultsContainer.appendChild(el);
        });

        this.resultsContainer.classList.add('show');
    }

    selectItem(item) {
        this.input.value = item.name;
        this.updateClearButton();
        this.clearResults();
        if (typeof this.onSelect === 'function') {
            this.onSelect(item);
        }
    }

    escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
}
