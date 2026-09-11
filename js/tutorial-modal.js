/**
 * tutorial-modal.js
 * かんたんミニマップメーカー 操作ガイド（チュートリアルモーダル）
 */

export const TUTORIAL_STEPS = [
    {
        tag: 'STEP 1',
        title: '動画ファイルを読み込む',
        desc: 'スタート画面のファイル選択エリアに、街歩きやドライブの動画（MP4, MOV, WebM）をドラッグ＆ドロップまたはファイル選択で指定します。動画データは外部サーバーへ送信されず、端末内（ブラウザ）でのみ安全に処理されます。',
        image: 'img/tutorial/tutorial-step1-load.png',
        alt: '動画ファイルをドラッグ＆ドロップして読み込む様子'
    },
    {
        tag: 'STEP 2',
        title: '地図検索で目的地へ素早く移動',
        desc: '広域地図からスタート地点を探す際は、地図右上の検索バーに駅名・地名・住所やGoogleマップの共有URLを入力します。サジェスト候補を選択するだけで一瞬で目的のエリアへジャンプできます。',
        image: 'img/tutorial/tutorial-sub-search.png',
        alt: '地図右上の検索バーで駅名や地名を検索している様子'
    },
    {
        tag: 'STEP 3',
        title: '動画を進めて通過ポイントを探す',
        desc: '動画プレイヤー下の操作ハンドルや、ステップ送りボタン（+1s, +1f）などを使って、交差点を曲がる瞬間や目印となるポイントへ再生ヘッドを正確に合わせます。',
        image: 'img/tutorial/tutorial-step2-seek.png',
        alt: 'ジョグスクラバーやステップ操作で動画を進めている様子'
    },
    {
        tag: 'STEP 4',
        title: '地図上をクリックして地点を追加',
        desc: '動画の現在位置に対応する交差点や建物の前を地図上でクリック/タップします。地点ピン（#S, #1, #2...）が配置され、前の地点からの移動ルートと現在地マーカーが自動的に滑らかに補間されます。',
        image: 'img/tutorial/tutorial-step3-add-pin.png',
        alt: '地図をクリックしてキーフレーム地点を追加した様子'
    },
    {
        tag: 'STEP 5',
        title: '信号待ちや立ち止まりを「一時停止」で記録',
        desc: '赤信号や寄り道で止まる地点のキーフレームを選び「一時停止を開始」をタップ。動画を進めて動き出した瞬間に「一時停止を終了」を押すと、現在地がその場に留まる一時停止区間（斜線帯）が作成されます。',
        image: 'img/tutorial/tutorial-step4-pause.png',
        alt: 'タイムライン上に一時停止区間帯を作成した様子'
    },
    {
        tag: 'STEP 6',
        title: 'タイムラインでタイミングを調整',
        desc: 'タイムライン上のキーフレームマーカーを左右にドラッグしてタイミングを微調整したり、範囲選択ツールで複数地点を一括移動できます。前後のキーフレーム移動ボタン（↑/↓）や取り消し/やり直しも完備しています。',
        image: 'img/tutorial/tutorial-step5-timeline.png',
        alt: 'タイムライン上でキーフレームを選択・微調整している様子'
    },
    {
        tag: 'STEP 7',
        title: 'クロマキー動画をエクスポート',
        desc: 'ヘッダーの「エクスポート」から、動画フレームレート、ワイプ形状（円形/正方形）、文字・地図スケール（200%/150%）などを選択し、「エクスポート開始」を実行します。GPXやプロジェクトデータも同時に生成されます。',
        image: 'img/tutorial/tutorial-step6-export.png',
        alt: 'エクスポートモーダルで設定を行い書き出しを開始する様子'
    },
    {
        tag: 'STEP 8',
        title: '動画編集ソフトで合成して完成',
        desc: 'ダウンロードしたZIP内のMP4動画を Adobe Premiere Pro等のタイムラインに配置し、「Ultra キー」などのエフェクトで背景色を抜くだけで、元動画にピッタリ連動する現在地ミニマップ動画が完成します。',
        image: 'img/tutorial/tutorial-sub-composite.png',
        alt: 'Premiere Proでミニマップ動画をUltraキー合成した完成例'
    }
];

export class TutorialModal {
    constructor() {
        this.modal = document.getElementById('tutorialModal');
        this.btnClose = document.getElementById('btnCloseTutorialModal');
        this.btnPrev = document.getElementById('btnTutorialPrev');
        this.btnNext = document.getElementById('btnTutorialNext');
        this.dotsContainer = document.getElementById('tutorialDots');

        this.imgEl = document.getElementById('tutorialStepImg');
        this.tagEl = document.getElementById('tutorialStepTag');
        this.titleEl = document.getElementById('tutorialStepTitle');
        this.descEl = document.getElementById('tutorialStepDesc');
        this.pageCounterEl = document.getElementById('tutorialPageCounter');

        this.currentIndex = 0;
        this.steps = TUTORIAL_STEPS;

        this.init();
    }

    init() {
        if (!this.modal) return;

        this.btnClose?.addEventListener('click', () => this.close());
        this.modal.addEventListener('click', (e) => {
            if (e.target === this.modal) this.close();
        });

        this.btnPrev?.addEventListener('click', () => this.prev());
        this.btnNext?.addEventListener('click', () => this.next());

        // ドットの生成
        if (this.dotsContainer) {
            this.dotsContainer.innerHTML = '';
            this.steps.forEach((_, idx) => {
                const dot = document.createElement('button');
                dot.type = 'button';
                dot.className = `tutorial-dot ${idx === 0 ? 'active' : ''}`;
                dot.title = `ステップ ${idx + 1} へ移動`;
                dot.setAttribute('aria-label', `ステップ ${idx + 1}`);
                dot.addEventListener('click', () => this.goToStep(idx));
                this.dotsContainer.appendChild(dot);
            });
        }

        // キーボードショートカット
        window.addEventListener('keydown', (e) => {
            if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;

            // モーダル表示中
            if (this.isOpen()) {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    this.close();
                } else if (e.key === 'ArrowLeft') {
                    e.preventDefault();
                    this.prev();
                } else if (e.key === 'ArrowRight') {
                    e.preventDefault();
                    this.next();
                }
            } else {
                // Shift + ? でモーダルを開く
                if (e.key === '?') {
                    e.preventDefault();
                    this.open();
                }
            }
        });
    }

    isOpen() {
        return this.modal && this.modal.classList.contains('open');
    }

    open(stepIndex = 0) {
        if (!this.modal) return;
        this.modal.classList.add('open');
        this.goToStep(stepIndex);
    }

    close() {
        if (!this.modal) return;
        this.modal.classList.remove('open');
    }

    goToStep(index) {
        if (index < 0) index = 0;
        if (index >= this.steps.length) index = this.steps.length - 1;
        this.currentIndex = index;

        const step = this.steps[index];
        if (this.imgEl) {
            this.imgEl.src = step.image;
            this.imgEl.alt = step.alt;
        }
        if (this.tagEl) this.tagEl.textContent = step.tag;
        if (this.titleEl) this.titleEl.textContent = step.title;
        if (this.descEl) this.descEl.textContent = step.desc;
        if (this.pageCounterEl) this.pageCounterEl.textContent = `${index + 1} / ${this.steps.length}`;

        // ナビゲーションボタンの状態
        if (this.btnPrev) {
            this.btnPrev.disabled = (index === 0);
        }
        if (this.btnNext) {
            if (index === this.steps.length - 1) {
                this.btnNext.innerHTML = `
                    <span>完了</span>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                `;
            } else {
                this.btnNext.innerHTML = `
                    <span>次へ</span>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="9 18 15 12 9 6"></polyline>
                    </svg>
                `;
            }
        }

        // ドットのアクティブ更新
        if (this.dotsContainer) {
            const dots = this.dotsContainer.querySelectorAll('.tutorial-dot');
            dots.forEach((dot, idx) => {
                dot.classList.toggle('active', idx === index);
            });
        }
    }

    next() {
        if (this.currentIndex < this.steps.length - 1) {
            this.goToStep(this.currentIndex + 1);
        } else {
            this.close();
        }
    }

    prev() {
        if (this.currentIndex > 0) {
            this.goToStep(this.currentIndex - 1);
        }
    }
}
