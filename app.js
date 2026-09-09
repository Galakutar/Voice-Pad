/**
 * Voice Pad - 音声録音＆タッチサンプラー
 * 完全ローカル完結・AudioContext自動復帰・グループ管理・ページネーション・3階層バックアップ対応
 */

// ==================== 1. Web Audio API / AudioContext 覚醒ユーティリティ ====================
class AudioUnlocker {
    static audioCtx = null;
    static isUnlocked = false;

    static getContext() {
        if (!this.audioCtx) {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (AudioContextClass) {
                this.audioCtx = new AudioContextClass();
            }
        }
        return this.audioCtx;
    }

    static async unlock() {
        const ctx = this.getContext();
        if (!ctx) return;

        if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
            try {
                await ctx.resume();
            } catch (e) {
                console.warn('AudioContext resume failed:', e);
            }
        }

        if (!this.isUnlocked) {
            try {
                // iOS Safari 向け微小サイレントバッファの再生によるハードウェア覚醒
                const buffer = ctx.createBuffer(1, 1, 22050);
                const source = ctx.createBufferSource();
                source.buffer = buffer;
                source.connect(ctx.destination);
                source.start(0);
                this.isUnlocked = true;
            } catch (e) {}
        }
    }

    static initListeners() {
        const events = ['pointerdown', 'touchstart', 'click', 'keydown', 'pageshow', 'focus'];
        const trigger = () => this.unlock();
        events.forEach(evt => {
            window.addEventListener(evt, trigger, { passive: true });
        });

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                this.unlock();
            }
        });
    }
}

// ==================== 2. ボイスチェンジ・エフェクトエンジン ====================
class PitchShiftEngine {
    static process(buffer, pitchRatio, ctx, options = {}) {
        const numChannels = buffer.numberOfChannels;
        const sampleRate = buffer.sampleRate;
        const numSamples = buffer.length;

        if (pitchRatio === 1.0 && !options.tremoloFreq && !options.ringModFreq) {
            return buffer;
        }

        const grainSize = Math.floor(sampleRate * 0.045);
        const hopSize = Math.floor(grainSize / 2);
        const outputBuffer = ctx.createBuffer(numChannels, numSamples, sampleRate);

        for (let ch = 0; ch < numChannels; ch++) {
            const inputData = buffer.getChannelData(ch);
            const outputData = outputBuffer.getChannelData(ch);

            const windowTable = new Float32Array(grainSize);
            for (let i = 0; i < grainSize; i++) {
                windowTable[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (grainSize - 1)));
            }

            if (pitchRatio === 1.0) {
                for (let i = 0; i < numSamples; i++) outputData[i] = inputData[i];
            } else {
                for (let inPos = 0; inPos < numSamples - grainSize; inPos += hopSize) {
                    for (let i = 0; i < grainSize; i++) {
                        const outPos = inPos + i;
                        if (outPos >= numSamples) break;

                        const srcIndex = inPos + (i * pitchRatio);
                        const i0 = Math.floor(srcIndex);
                        const i1 = Math.min(i0 + 1, numSamples - 1);
                        const frac = srcIndex - i0;

                        if (i0 < numSamples && i0 >= 0) {
                            const sample = inputData[i0] * (1 - frac) + inputData[i1] * frac;
                            outputData[outPos] += sample * windowTable[i] * 0.9;
                        }
                    }
                }
            }

            if (options.tremoloFreq) {
                const depth = options.tremoloDepth || 0.35;
                for (let i = 0; i < numSamples; i++) {
                    const lfo = 1.0 - depth + depth * Math.sin((2 * Math.PI * options.tremoloFreq * i) / sampleRate);
                    outputData[i] *= lfo;
                }
            }

            if (options.ringModFreq) {
                const mix = options.ringModMix || 0.7;
                for (let i = 0; i < numSamples; i++) {
                    const carrier = Math.sin((2 * Math.PI * options.ringModFreq * i) / sampleRate);
                    outputData[i] = outputData[i] * (1 - mix + mix * carrier * 1.4);
                }
            }
        }

        return outputBuffer;
    }

    static processRobot(buffer, ctx) {
        const numChannels = buffer.numberOfChannels;
        const sampleRate = buffer.sampleRate;
        const numSamples = buffer.length;
        const outputBuffer = ctx.createBuffer(numChannels, numSamples, sampleRate);
        const modFreq = 65;

        for (let ch = 0; ch < numChannels; ch++) {
            const inputData = buffer.getChannelData(ch);
            const outputData = outputBuffer.getChannelData(ch);
            for (let i = 0; i < numSamples; i++) {
                const carrier = Math.sin((2 * Math.PI * modFreq * i) / sampleRate);
                outputData[i] = inputData[i] * carrier * 1.25;
            }
        }
        return outputBuffer;
    }

    static processCave(buffer, ctx) {
        const numChannels = buffer.numberOfChannels;
        const sampleRate = buffer.sampleRate;
        const numSamples = buffer.length;
        const delaySamples = Math.floor(sampleRate * 0.145);
        const extraSamples = Math.floor(sampleRate * 0.75);
        const totalLength = numSamples + extraSamples;
        const outputBuffer = ctx.createBuffer(numChannels, totalLength, sampleRate);

        for (let ch = 0; ch < numChannels; ch++) {
            const inputData = buffer.getChannelData(ch);
            const outputData = outputBuffer.getChannelData(ch);
            for (let i = 0; i < numSamples; i++) outputData[i] = inputData[i] * 0.9;
            const feedback = 0.58;
            for (let i = delaySamples; i < totalLength; i++) {
                outputData[i] += outputData[i - delaySamples] * feedback;
            }
        }
        return outputBuffer;
    }

    static processUnderwater(buffer, ctx) {
        const numChannels = buffer.numberOfChannels;
        const sampleRate = buffer.sampleRate;
        const numSamples = buffer.length;
        const outputBuffer = ctx.createBuffer(numChannels, numSamples, sampleRate);
        const rc = 1.0 / (2 * Math.PI * 480);
        const dt = 1.0 / sampleRate;
        const alpha = dt / (rc + dt);

        for (let ch = 0; ch < numChannels; ch++) {
            const inputData = buffer.getChannelData(ch);
            const outputData = outputBuffer.getChannelData(ch);
            let prev = 0;
            for (let i = 0; i < numSamples; i++) {
                prev = prev + alpha * (inputData[i] - prev);
                const wobble = 0.65 + 0.35 * Math.sin((2 * Math.PI * 8.5 * i) / sampleRate);
                outputData[i] = prev * wobble * 1.8;
            }
        }
        return outputBuffer;
    }

    static processTelephone(buffer, ctx) {
        const numChannels = buffer.numberOfChannels;
        const sampleRate = buffer.sampleRate;
        const numSamples = buffer.length;
        const outputBuffer = ctx.createBuffer(numChannels, numSamples, sampleRate);

        for (let ch = 0; ch < numChannels; ch++) {
            const inputData = buffer.getChannelData(ch);
            const outputData = outputBuffer.getChannelData(ch);
            let lp = 0, hp = 0;
            const alphaLP = 0.32, alphaHP = 0.91;
            for (let i = 0; i < numSamples; i++) {
                hp = alphaHP * (hp + inputData[i] - (i > 0 ? inputData[i - 1] : 0));
                lp = lp + alphaLP * (hp - lp);
                let s = lp * 1.6;
                if (s > 0.82) s = 0.82;
                if (s < -0.82) s = -0.82;
                outputData[i] = s;
            }
        }
        return outputBuffer;
    }

    static processHall(buffer, ctx) {
        const numChannels = buffer.numberOfChannels;
        const sampleRate = buffer.sampleRate;
        const numSamples = buffer.length;
        const extraSamples = Math.floor(sampleRate * 0.85);
        const totalLength = numSamples + extraSamples;
        const outputBuffer = ctx.createBuffer(numChannels, totalLength, sampleRate);
        const delays = [
            Math.floor(sampleRate * 0.042),
            Math.floor(sampleRate * 0.078),
            Math.floor(sampleRate * 0.115),
            Math.floor(sampleRate * 0.165)
        ];
        const gains = [0.42, 0.32, 0.24, 0.16];

        for (let ch = 0; ch < numChannels; ch++) {
            const inputData = buffer.getChannelData(ch);
            const outputData = outputBuffer.getChannelData(ch);
            for (let i = 0; i < numSamples; i++) outputData[i] = inputData[i] * 0.8;
            for (let d = 0; d < delays.length; d++) {
                const delay = delays[d];
                const gain = gains[d];
                for (let i = delay; i < totalLength; i++) {
                    const srcIdx = i - delay;
                    const sample = srcIdx < numSamples ? inputData[srcIdx] : 0;
                    outputData[i] += sample * gain + (outputData[i - delay] * 0.25 * gain);
                }
            }
        }
        return outputBuffer;
    }

    static processMegaphone(buffer, ctx) {
        const numChannels = buffer.numberOfChannels;
        const sampleRate = buffer.sampleRate;
        const numSamples = buffer.length;
        const outputBuffer = ctx.createBuffer(numChannels, numSamples, sampleRate);

        for (let ch = 0; ch < numChannels; ch++) {
            const inputData = buffer.getChannelData(ch);
            const outputData = outputBuffer.getChannelData(ch);
            let hp = 0;
            for (let i = 0; i < numSamples; i++) {
                hp = 0.86 * (hp + inputData[i] - (i > 0 ? inputData[i - 1] : 0));
                let sample = Math.tanh(hp * 2.3);
                outputData[i] = sample * 0.9;
            }
        }
        return outputBuffer;
    }

    static processRadio(buffer, ctx) {
        const numChannels = buffer.numberOfChannels;
        const sampleRate = buffer.sampleRate;
        const numSamples = buffer.length;
        const outputBuffer = ctx.createBuffer(numChannels, numSamples, sampleRate);

        for (let ch = 0; ch < numChannels; ch++) {
            const inputData = buffer.getChannelData(ch);
            const outputData = outputBuffer.getChannelData(ch);
            let lp = 0, hp = 0;
            const alphaLP = 0.28, alphaHP = 0.89;
            for (let i = 0; i < numSamples; i++) {
                hp = alphaHP * (hp + inputData[i] - (i > 0 ? inputData[i - 1] : 0));
                lp = lp + alphaLP * (hp - lp);
                const crackle = (Math.random() - 0.5) * 0.025;
                let sample = Math.tanh((lp + crackle) * 2.4);
                const fading = 0.9 + 0.1 * Math.sin((2 * Math.PI * 0.8 * i) / sampleRate);
                outputData[i] = sample * fading * 0.88;
            }
        }
        return outputBuffer;
    }

    static applyEffect(buffer, effectName, ctx) {
        switch (effectName) {
            case 'baby': return this.process(buffer, 1.55, ctx);
            case 'boy': return this.process(buffer, 1.15, ctx);
            case 'girl': return this.process(buffer, 1.32, ctx);
            case 'man': return this.process(buffer, 0.85, ctx);
            case 'woman': return this.process(buffer, 1.22, ctx);
            case 'old_man': return this.process(buffer, 0.72, ctx, { tremoloFreq: 5.5, tremoloDepth: 0.38 });
            case 'old_woman': return this.process(buffer, 1.25, ctx, { tremoloFreq: 6.0, tremoloDepth: 0.38 });
            case 'alien': return this.process(buffer, 1.38, ctx, { ringModFreq: 35, ringModMix: 0.75 });
            case 'robot': return this.processRobot(buffer, ctx);
            case 'monster': return this.process(buffer, 0.58, ctx);
            case 'cave': return this.processCave(buffer, ctx);
            case 'underwater': return this.processUnderwater(buffer, ctx);
            case 'radio': return this.processRadio(buffer, ctx);
            case 'telephone': return this.processTelephone(buffer, ctx);
            case 'hall': return this.processHall(buffer, ctx);
            case 'megaphone': return this.processMegaphone(buffer, ctx);
            case 'normal':
            default: return buffer;
        }
    }
}

// ==================== 3. IndexedDB ストレージマネージャー ====================
class StorageManager {
    constructor() {
        this.dbName = 'VoicePadAppDB_v2';
        this.dbVersion = 1;
        this.db = null;
    }

    async init() {
        return new Promise((resolve) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);

            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('settings')) {
                    db.createObjectStore('settings', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('scrolls')) {
                    db.createObjectStore('scrolls', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('slots')) {
                    db.createObjectStore('slots', { keyPath: 'id' });
                }
            };

            request.onsuccess = async (e) => {
                this.db = e.target.result;
                await this.migrateLegacyDataIfNeeded();
                resolve();
            };

            request.onerror = (e) => {
                console.error('IndexedDB open error:', e);
                resolve();
            };
        });
    }

    // 旧DB（VoicePad6DB）からの自動マイグレーション
    async migrateLegacyDataIfNeeded() {
        try {
            const scrolls = await this.getAllScrolls();
            if (scrolls.length > 0) return; // 既に移行済み

            // 旧DBの存在チェックとデータ取得
            const legacySlots = await this.readLegacyDB();
            const defaultScroll = {
                id: 'scroll_default',
                name: 'メイン',
                order: 0,
                createdAt: Date.now()
            };
            await this.saveScroll(defaultScroll);
            await this.saveSetting('currentScrollId', defaultScroll.id);
            await this.saveSetting('pageSize', 32);

            if (legacySlots && legacySlots.length > 0) {
                for (const slot of legacySlots) {
                    await this.saveSlot({
                        ...slot,
                        id: `slot_${slot.id}`,
                        scrollId: defaultScroll.id,
                        order: slot.id
                    });
                }
            } else {
                // 初期8スロットを生成
                const emojis = ['🔴', '🟠', '🟡', '🟢', '🔵', '🔷', '🟣', '🌸'];
                for (let i = 1; i <= 8; i++) {
                    await this.saveSlot({
                        id: `slot_${i}`,
                        scrollId: defaultScroll.id,
                        label: `ボタン ${i}`,
                        labelPosition: 'bottom',
                        emoji: emojis[i - 1] || '🔊',
                        imageUrl: null,
                        imageScale: 1.0,
                        imageOffsetX: 0,
                        imageOffsetY: 0,
                        imageFit: 'cover',
                        audioBlob: null,
                        duration: 0,
                        order: i
                    });
                }
            }
        } catch (e) {
            console.warn('Migration warning:', e);
        }
    }

    readLegacyDB() {
        return new Promise((resolve) => {
            const req = indexedDB.open('VoicePad6DB', 1);
            req.onsuccess = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('slots')) {
                    resolve([]);
                    return;
                }
                const tx = db.transaction('slots', 'readonly');
                const store = tx.objectStore('slots');
                const allReq = store.getAll();
                allReq.onsuccess = () => resolve(allReq.result || []);
                allReq.onerror = () => resolve([]);
            };
            req.onerror = () => resolve([]);
        });
    }

    // 設定
    async saveSetting(key, value) {
        if (!this.db) return;
        return new Promise((resolve) => {
            const tx = this.db.transaction('settings', 'readwrite');
            tx.objectStore('settings').put({ id: key, value });
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        });
    }

    async getSetting(key, defaultValue = null) {
        if (!this.db) return defaultValue;
        return new Promise((resolve) => {
            const tx = this.db.transaction('settings', 'readonly');
            const req = tx.objectStore('settings').get(key);
            req.onsuccess = () => resolve(req.result ? req.result.value : defaultValue);
            req.onerror = () => resolve(defaultValue);
        });
    }

    // スクロール（グループ）
    async saveScroll(scroll) {
        if (!this.db) return;
        return new Promise((resolve) => {
            const tx = this.db.transaction('scrolls', 'readwrite');
            tx.objectStore('scrolls').put(scroll);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        });
    }

    async getAllScrolls() {
        if (!this.db) return [];
        return new Promise((resolve) => {
            const tx = this.db.transaction('scrolls', 'readonly');
            const req = tx.objectStore('scrolls').getAll();
            req.onsuccess = () => {
                const list = req.result || [];
                list.sort((a, b) => (a.order || 0) - (b.order || 0));
                resolve(list);
            };
            req.onerror = () => resolve([]);
        });
    }

    async deleteScroll(id) {
        if (!this.db) return;
        return new Promise((resolve) => {
            const tx = this.db.transaction(['scrolls', 'slots'], 'readwrite');
            tx.objectStore('scrolls').delete(id);
            // 該当スクロールのスロットも削除
            const slotStore = tx.objectStore('slots');
            const req = slotStore.getAll();
            req.onsuccess = () => {
                const slots = req.result || [];
                slots.forEach(s => {
                    if (s.scrollId === id) slotStore.delete(s.id);
                });
            };
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        });
    }

    // スロット（スイッチ）
    async saveSlot(slot) {
        if (!this.db) return;
        return new Promise((resolve) => {
            const tx = this.db.transaction('slots', 'readwrite');
            tx.objectStore('slots').put(slot);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        });
    }

    async getAllSlots() {
        if (!this.db) return [];
        return new Promise((resolve) => {
            const tx = this.db.transaction('slots', 'readonly');
            const req = tx.objectStore('slots').getAll();
            req.onsuccess = () => {
                const list = req.result || [];
                list.sort((a, b) => (a.order || 0) - (b.order || 0));
                resolve(list);
            };
            req.onerror = () => resolve([]);
        });
    }

    async deleteSlot(id) {
        if (!this.db) return;
        return new Promise((resolve) => {
            const tx = this.db.transaction('slots', 'readwrite');
            tx.objectStore('slots').delete(id);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        });
    }

    async clearAll() {
        if (!this.db) return;
        return new Promise((resolve) => {
            const tx = this.db.transaction(['settings', 'scrolls', 'slots'], 'readwrite');
            tx.objectStore('settings').clear();
            tx.objectStore('scrolls').clear();
            tx.objectStore('slots').clear();
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        });
    }
}

// ==================== 4. メインアプリケーションロジック ====================
class VoicePadApp {
    constructor() {
        this.storage = new StorageManager();
        this.audioCtx = null;
        this.mediaRecorder = null;
        this.audioStream = null;

        this.currentMode = 'play'; // 'play' | 'record'
        this.recordingSlotId = null;
        this.recordedChunks = [];
        this.recTimer = null;
        this.recSeconds = 0;

        this.currentEffect = 'normal';

        // スクロールとスロットデータ
        this.scrolls = [];
        this.currentScrollId = null;
        this.slots = [];

        // ページネーション
        this.pageSize = 32; // デフォルト32個表示
        this.currentPage = 1;

        // アクティブ再生中のAudioSource (slotId -> AudioBufferSourceNode)
        this.activeSources = new Map();

        // 編集モーダル状態
        this.editingSlotId = null;
        this.editingScrollId = null;
        this.editingImageUrl = null;
        this.editingImageScale = 1.0;
        this.editingImageOffsetX = 0;
        this.editingImageOffsetY = 0;
        this.editingImageFit = 'cover';

        this.init();
    }

    async init() {
        AudioUnlocker.initListeners();
        this.audioCtx = AudioUnlocker.getContext();

        await this.storage.init();
        await this.loadAllData();

        this.renderScrollTabs();
        this.renderSlots();
        this.initEvents();
    }

    async loadAllData() {
        this.pageSize = await this.storage.getSetting('pageSize', 32);
        const savedEffect = await this.storage.getSetting('effect', 'normal');
        this.currentEffect = savedEffect;
        const effectEl = document.getElementById('voice-effect');
        if (effectEl) effectEl.value = this.currentEffect;

        const pageSizeSelect = document.getElementById('setting-page-size');
        if (pageSizeSelect) pageSizeSelect.value = String(this.pageSize);

        this.scrolls = await this.storage.getAllScrolls();
        this.slots = await this.storage.getAllSlots();

        const savedScrollId = await this.storage.getSetting('currentScrollId', null);
        if (savedScrollId && this.scrolls.some(s => s.id === savedScrollId)) {
            this.currentScrollId = savedScrollId;
        } else if (this.scrolls.length > 0) {
            this.currentScrollId = this.scrolls[0].id;
        } else {
            // グループがゼロの場合は作成
            const initialScroll = {
                id: 'scroll_' + Date.now(),
                name: 'メイン',
                order: 0,
                createdAt: Date.now()
            };
            await this.storage.saveScroll(initialScroll);
            this.scrolls.push(initialScroll);
            this.currentScrollId = initialScroll.id;
        }
    }

    // 現在のスクロール内のスロット一覧を取得
    getCurrentSlots() {
        return this.slots
            .filter(s => s.scrollId === this.currentScrollId)
            .sort((a, b) => (a.order || 0) - (b.order || 0));
    }

    // ==================== 描画処理 ====================
    renderScrollTabs() {
        const container = document.getElementById('scroll-tabs-container');
        if (!container) return;
        container.innerHTML = '';

        this.scrolls.forEach((scroll) => {
            const count = this.slots.filter(s => s.scrollId === scroll.id).length;
            const tab = document.createElement('div');
            tab.className = `scroll-tab-item${scroll.id === this.currentScrollId ? ' active' : ''}`;
            tab.setAttribute('data-scroll-id', scroll.id);

            tab.innerHTML = `
                <span class="scroll-tab-name">${this.escapeHtml(scroll.name)}</span>
                <span class="scroll-tab-badge">${count}</span>
                <span class="scroll-tab-edit-icon" title="グループ設定">⚙️</span>
            `;

            tab.addEventListener('click', (e) => {
                if (e.target.classList.contains('scroll-tab-edit-icon')) {
                    e.stopPropagation();
                    this.openScrollModal(scroll.id);
                } else {
                    this.switchScroll(scroll.id);
                }
            });

            container.appendChild(tab);
        });
    }

    renderSlots() {
        const grid = document.getElementById('pad-grid');
        if (!grid) return;
        grid.innerHTML = '';

        // グリッドクラスを適用
        grid.className = `pad-grid grid-count-${this.pageSize}`;

        const currentSlots = this.getCurrentSlots();
        const totalItems = currentSlots.length;
        const totalPages = Math.max(1, Math.ceil(totalItems / this.pageSize));

        if (this.currentPage > totalPages) {
            this.currentPage = totalPages;
        }

        // ページネーション計算
        const startIndex = (this.currentPage - 1) * this.pageSize;
        const endIndex = startIndex + this.pageSize;
        const pageSlots = currentSlots.slice(startIndex, endIndex);

        // ページネーションUIの更新
        const pageIndicator = document.getElementById('page-indicator');
        const prevBtn = document.getElementById('prev-page-btn');
        const nextBtn = document.getElementById('next-page-btn');

        if (pageIndicator) {
            pageIndicator.innerText = `ページ ${this.currentPage} / ${totalPages} (計 ${totalItems}個)`;
        }
        if (prevBtn) prevBtn.disabled = (this.currentPage <= 1);
        if (nextBtn) nextBtn.disabled = (this.currentPage >= totalPages);

        // スロットカードの生成
        pageSlots.forEach((slot, idx) => {
            const card = document.createElement('div');
            const hasPhoto = !!slot.imageUrl;
            const pos = slot.labelPosition || 'bottom';
            const displayIndex = startIndex + idx + 1;

            card.className = `pad-card pos-${pos}${hasPhoto ? ' has-photo' : ''}`;
            card.setAttribute('data-slot-id', slot.id);
            card.id = `pad-${slot.id}`;

            // スロットカラーの循環
            const colorIdx = ((displayIndex - 1) % 8) + 1;
            card.style.setProperty('--slot-color', `var(--slot-c${colorIdx})`);

            const hasAudio = slot.audioBlob !== null;
            let statusText = '未録音';
            if (hasAudio) {
                statusText = `${slot.duration.toFixed(1)}s`;
            }

            const labelHtml = `<div class="pad-label">${this.escapeHtml(slot.label)}</div>`;
            const scale = slot.imageScale !== undefined ? slot.imageScale : 1.0;
            const offsetX = slot.imageOffsetX !== undefined ? slot.imageOffsetX : 0;
            const offsetY = slot.imageOffsetY !== undefined ? slot.imageOffsetY : 0;
            const fit = slot.imageFit || 'cover';
            const photoStyle = `transform: scale(${scale}) translate(${offsetX}%, ${offsetY}%); object-fit: ${fit};`;

            card.innerHTML = `
                ${hasPhoto ? `
                    <div class="pad-photo-wrapper">
                        <img src="${slot.imageUrl}" class="pad-photo-full" style="${photoStyle}" alt="photo">
                    </div>
                    <div class="pad-photo-overlay"></div>
                ` : ''}

                <!-- 上部ヘッダー -->
                <div class="pad-header">
                    <span class="slot-badge">${displayIndex}</span>
                    ${pos === 'top' ? labelHtml : ''}
                    <button class="pad-settings-btn" title="スイッチ設定" data-slot-id="${slot.id}" aria-label="スイッチ設定">
                        ⚙️
                    </button>
                </div>

                <!-- 中央ボディ -->
                <div class="pad-body">
                    ${!hasPhoto ? `<div class="pad-emoji">${slot.emoji || '🔊'}</div>` : ''}
                    ${pos === 'center' ? labelHtml : ''}
                </div>

                <!-- 下部フッター -->
                <div class="pad-footer">
                    ${pos === 'bottom' ? labelHtml : ''}
                    <div class="pad-status">${statusText}</div>
                </div>
            `;

            grid.appendChild(card);
        });

        // 最後のページかつ枠に空きがある場合は「＋ 新規スイッチ」カードを追加
        if (this.currentPage === totalPages && pageSlots.length < this.pageSize) {
            const addCard = document.createElement('div');
            addCard.className = 'pad-card pad-card-add-new';
            addCard.innerHTML = `
                <div class="add-icon">＋</div>
                <div>追加</div>
            `;
            addCard.addEventListener('click', () => this.addNewSlotToCurrentScroll());
            grid.appendChild(addCard);
        }
    }

    // ==================== イベントリスナー設定 ====================
    initEvents() {
        // パッドグリッドのクリックイベント
        const grid = document.getElementById('pad-grid');
        if (grid) {
            grid.addEventListener('click', (e) => {
                AudioUnlocker.unlock();

                const settingsBtn = e.target.closest('.pad-settings-btn');
                const card = e.target.closest('.pad-card');

                if (settingsBtn) {
                    e.stopPropagation();
                    const slotId = settingsBtn.getAttribute('data-slot-id');
                    this.openEditModal(slotId);
                    return;
                }

                if (card && !card.classList.contains('pad-card-add-new')) {
                    const slotId = card.getAttribute('data-slot-id');
                    if (this.currentMode === 'play') {
                        this.playSlot(slotId);
                    } else {
                        this.toggleRecording(slotId);
                    }
                }
            });
        }

        // 再生 / 録音モード切り替え
        document.getElementById('mode-play-btn')?.addEventListener('click', () => this.setMode('play'));
        document.getElementById('mode-record-btn')?.addEventListener('click', () => this.setMode('record'));

        // ボイスエフェクト切り替え
        document.getElementById('voice-effect')?.addEventListener('change', async (e) => {
            this.currentEffect = e.target.value;
            await this.storage.saveSetting('effect', this.currentEffect);
            this.showToast(`ボイスエフェクト: ${e.target.options[e.target.selectedIndex].text}`);
        });

        // スクロール（グループ）追加
        document.getElementById('add-scroll-btn')?.addEventListener('click', () => this.addNewScroll());

        // クイックスイッチ追加
        document.getElementById('add-slot-btn')?.addEventListener('click', () => this.addNewSlotToCurrentScroll());

        // ページネーション
        document.getElementById('prev-page-btn')?.addEventListener('click', () => {
            if (this.currentPage > 1) {
                this.currentPage--;
                this.renderSlots();
            }
        });
        document.getElementById('next-page-btn')?.addEventListener('click', () => {
            const currentSlots = this.getCurrentSlots();
            const totalPages = Math.ceil(currentSlots.length / this.pageSize);
            if (this.currentPage < totalPages) {
                this.currentPage++;
                this.renderSlots();
            }
        });

        // スワイプによるページ送り操作（タッチジェスチャー対応）
        this.initSwipeGesture();

        // ヘッダーアクション
        document.getElementById('header-import-btn')?.addEventListener('click', () => {
            document.getElementById('global-import-input')?.click();
        });

        document.getElementById('header-settings-btn')?.addEventListener('click', () => {
            this.openSettingsModal();
        });

        document.getElementById('show-qr-btn')?.addEventListener('click', () => {
            this.openQrModal();
        });

        // グローバルファイルインポート
        document.getElementById('global-import-input')?.addEventListener('change', async (e) => {
            if (e.target.files.length > 0) {
                await this.handleGlobalImport(e.target.files[0]);
                e.target.value = '';
            }
        });

        // 各種モーダルの閉じるイベント
        this.initModalEvents();

        // 写真・絵文字エディタイベント
        this.initEditorEvents();
    }

    // スワイプ操作
    initSwipeGesture() {
        const grid = document.getElementById('pad-grid');
        if (!grid) return;

        let startX = 0, startY = 0;
        grid.addEventListener('touchstart', (e) => {
            if (e.touches.length === 1) {
                startX = e.touches[0].clientX;
                startY = e.touches[0].clientY;
            }
        }, { passive: true });

        grid.addEventListener('touchend', (e) => {
            if (e.changedTouches.length === 1) {
                const diffX = e.changedTouches[0].clientX - startX;
                const diffY = e.changedTouches[0].clientY - startY;

                if (Math.abs(diffX) > 60 && Math.abs(diffY) < 40) {
                    const currentSlots = this.getCurrentSlots();
                    const totalPages = Math.ceil(currentSlots.length / this.pageSize);
                    if (diffX < 0 && this.currentPage < totalPages) {
                        // 左スワイプ ➔ 次へ
                        this.currentPage++;
                        this.renderSlots();
                    } else if (diffX > 0 && this.currentPage > 1) {
                        // 右スワイプ ➔ 前へ
                        this.currentPage--;
                        this.renderSlots();
                    }
                }
            }
        }, { passive: true });
    }

    // モード切り替え
    setMode(mode) {
        if (this.recordingSlotId !== null) {
            this.stopRecording();
        }
        this.currentMode = mode;
        const playBtn = document.getElementById('mode-play-btn');
        const recordBtn = document.getElementById('mode-record-btn');

        if (mode === 'play') {
            playBtn?.classList.add('active');
            recordBtn?.classList.remove('active');
            document.body.classList.remove('mode-record');
        } else {
            recordBtn?.classList.add('active');
            playBtn?.classList.remove('active');
            document.body.classList.add('mode-record');
            this.showToast('🔴 録音モード: ボタンを押して録音を開始');
        }
    }

    // ==================== スクロール（グループ）制御 ====================
    async switchScroll(scrollId) {
        this.currentScrollId = scrollId;
        this.currentPage = 1;
        await this.storage.saveSetting('currentScrollId', scrollId);
        this.renderScrollTabs();
        this.renderSlots();
    }

    async addNewScroll(name = null) {
        const scrollName = name || prompt('新しいグループ（スクロール）の名前を入力してください:', `グループ ${this.scrolls.length + 1}`);
        if (!scrollName || !scrollName.trim()) return;

        const newScroll = {
            id: 'scroll_' + Date.now(),
            name: scrollName.trim(),
            order: this.scrolls.length,
            createdAt: Date.now()
        };

        await this.storage.saveScroll(newScroll);
        this.scrolls.push(newScroll);

        // 初期スイッチを8個作成
        const emojis = ['🔴', '🟠', '🟡', '🟢', '🔵', '🔷', '🟣', '🌸'];
        for (let i = 1; i <= 8; i++) {
            const newSlot = {
                id: 'slot_' + Date.now() + '_' + i,
                scrollId: newScroll.id,
                label: `ボタン ${i}`,
                labelPosition: 'bottom',
                emoji: emojis[i - 1] || '🔊',
                imageUrl: null,
                imageScale: 1.0,
                imageOffsetX: 0,
                imageOffsetY: 0,
                imageFit: 'cover',
                audioBlob: null,
                duration: 0,
                order: i
            };
            await this.storage.saveSlot(newSlot);
            this.slots.push(newSlot);
        }

        await this.switchScroll(newScroll.id);
        this.showToast(`✨ グループ「${newScroll.name}」を作成しました`);
    }

    openScrollModal(scrollId) {
        this.editingScrollId = scrollId;
        const scroll = this.scrolls.find(s => s.id === scrollId);
        if (!scroll) return;

        const nameInput = document.getElementById('edit-scroll-name');
        if (nameInput) nameInput.value = scroll.name;

        document.getElementById('scroll-modal-backdrop')?.classList.add('open');
    }

    closeScrollModal() {
        document.getElementById('scroll-modal-backdrop')?.classList.remove('open');
        this.editingScrollId = null;
    }

    async saveScrollModal() {
        if (!this.editingScrollId) return;
        const scroll = this.scrolls.find(s => s.id === this.editingScrollId);
        if (!scroll) return;

        const nameInput = document.getElementById('edit-scroll-name');
        const newName = nameInput?.value.trim() || scroll.name;
        scroll.name = newName;

        await this.storage.saveScroll(scroll);
        this.renderScrollTabs();
        this.closeScrollModal();
        this.showToast(`💾 グループ名を「${newName}」に更新しました`);
    }

    async deleteScrollModal() {
        if (!this.editingScrollId) return;
        if (this.scrolls.length <= 1) {
            alert('最後のグループは削除できません。');
            return;
        }

        const scroll = this.scrolls.find(s => s.id === this.editingScrollId);
        if (!scroll) return;

        if (confirm(`グループ「${scroll.name}」とその中のすべてのスイッチを削除しますか？`)) {
            const idToDelete = this.editingScrollId;
            await this.storage.deleteScroll(idToDelete);

            this.scrolls = this.scrolls.filter(s => s.id !== idToDelete);
            this.slots = this.slots.filter(s => s.scrollId !== idToDelete);

            this.closeScrollModal();

            if (this.currentScrollId === idToDelete) {
                this.currentScrollId = this.scrolls[0].id;
                await this.storage.saveSetting('currentScrollId', this.currentScrollId);
            }

            this.renderScrollTabs();
            this.renderSlots();
            this.showToast(`🗑️ グループ「${scroll.name}」を削除しました`);
        }
    }

    async duplicateCurrentScroll() {
        if (!this.editingScrollId) return;
        const scroll = this.scrolls.find(s => s.id === this.editingScrollId);
        if (!scroll) return;

        const newScrollId = 'scroll_' + Date.now();
        const duplicatedScroll = {
            id: newScrollId,
            name: `${scroll.name} (コピー)`,
            order: this.scrolls.length,
            createdAt: Date.now()
        };

        await this.storage.saveScroll(duplicatedScroll);
        this.scrolls.push(duplicatedScroll);

        // スロットの複製
        const targetSlots = this.slots.filter(s => s.scrollId === scroll.id);
        for (const slot of targetSlots) {
            const newSlot = {
                ...slot,
                id: 'slot_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
                scrollId: newScrollId
            };
            await this.storage.saveSlot(newSlot);
            this.slots.push(newSlot);
        }

        this.closeScrollModal();
        await this.switchScroll(newScrollId);
        this.showToast(`📋 グループ「${duplicatedScroll.name}」を複製しました`);
    }

    // ==================== スイッチ（スロット）追加・制御 ====================
    async addNewSlotToCurrentScroll() {
        const currentSlots = this.getCurrentSlots();
        const nextOrder = currentSlots.length + 1;
        const newSlot = {
            id: 'slot_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
            scrollId: this.currentScrollId,
            label: `ボタン ${nextOrder}`,
            labelPosition: 'bottom',
            emoji: '🔊',
            imageUrl: null,
            imageScale: 1.0,
            imageOffsetX: 0,
            imageOffsetY: 0,
            imageFit: 'cover',
            audioBlob: null,
            duration: 0,
            order: nextOrder
        };

        await this.storage.saveSlot(newSlot);
        this.slots.push(newSlot);

        // ページを最後のページに移動
        const totalPages = Math.ceil(this.getCurrentSlots().length / this.pageSize);
        this.currentPage = totalPages;

        this.renderScrollTabs();
        this.renderSlots();
        this.showToast(`＋ 新しいスイッチ（ボタン ${nextOrder}）を追加しました`);
    }

    async duplicateSlot(slotId) {
        const slot = this.slots.find(s => s.id === slotId);
        if (!slot) return;

        const currentSlots = this.getCurrentSlots();
        const newSlot = {
            ...slot,
            id: 'slot_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
            label: `${slot.label} (コピー)`,
            order: currentSlots.length + 1
        };

        await this.storage.saveSlot(newSlot);
        this.slots.push(newSlot);

        this.closeEditModal();
        this.renderScrollTabs();
        this.renderSlots();
        this.showToast(`📋 スイッチ「${newSlot.label}」を複製しました`);
    }

    async deleteSlot(slotId) {
        const slot = this.slots.find(s => s.id === slotId);
        if (!slot) return;

        if (confirm(`スイッチ「${slot.label}」を完全に削除しますか？`)) {
            this.stopSlot(slotId);
            await this.storage.deleteSlot(slotId);
            this.slots = this.slots.filter(s => s.id !== slotId);

            this.closeEditModal();
            this.renderScrollTabs();
            this.renderSlots();
            this.showToast(`🗑️ スイッチ「${slot.label}」を削除しました`);
        }
    }

    // ==================== マイク録音制御 ====================
    async getAudioStream() {
        if (this.audioStream && this.audioStream.active) {
            const tracks = this.audioStream.getAudioTracks();
            if (tracks.length > 0 && tracks[0].readyState === 'live') {
                return this.audioStream;
            }
        }

        try {
            this.audioStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });
            return this.audioStream;
        } catch (err) {
            console.error('Microphone error:', err);
            throw err;
        }
    }

    async toggleRecording(slotId) {
        if (this.recordingSlotId === slotId) {
            this.stopRecording();
        } else {
            if (this.recordingSlotId !== null) {
                this.stopRecording();
            }
            await this.startRecording(slotId);
        }
    }

    async startRecording(slotId) {
        await AudioUnlocker.unlock();

        try {
            await this.getAudioStream();
        } catch (err) {
            alert('マイクの使用が許可されていません。ブラウザ設定でマイクアクセスを許可してください。');
            return;
        }

        this.recordingSlotId = slotId;
        this.recordedChunks = [];
        this.recSeconds = 0;

        let mimeType = '';
        if (MediaRecorder.isTypeSupported('audio/mp4')) mimeType = 'audio/mp4';
        else if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) mimeType = 'audio/webm;codecs=opus';
        else if (MediaRecorder.isTypeSupported('audio/webm')) mimeType = 'audio/webm';

        try {
            this.mediaRecorder = mimeType ? new MediaRecorder(this.audioStream, { mimeType }) : new MediaRecorder(this.audioStream);
        } catch (e) {
            this.mediaRecorder = new MediaRecorder(this.audioStream);
        }

        this.mediaRecorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) this.recordedChunks.push(e.data);
        };

        this.mediaRecorder.onstop = async () => {
            const finalType = this.mediaRecorder.mimeType || 'audio/mp4';
            const blob = new Blob(this.recordedChunks, { type: finalType });
            await this.saveRecordedAudio(this.recordingSlotId, blob, this.recSeconds);
            this.cleanupRecording();
        };

        this.mediaRecorder.start(100);

        const card = document.getElementById(`pad-${slotId}`);
        if (card) {
            card.classList.add('recording');
            const statusEl = card.querySelector('.pad-status');
            if (statusEl) statusEl.innerText = '🔴 録音中... (0s)';
        }

        this.recTimer = setInterval(() => {
            this.recSeconds += 0.5;
            if (card) {
                const statusEl = card.querySelector('.pad-status');
                if (statusEl) statusEl.innerText = `🔴 録音中... (${this.recSeconds.toFixed(0)}s)`;
            }
            if (this.recSeconds >= 60) {
                this.stopRecording();
            }
        }, 500);
    }

    stopRecording() {
        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            this.mediaRecorder.stop();
        }
        if (this.recTimer) {
            clearInterval(this.recTimer);
            this.recTimer = null;
        }
    }

    async saveRecordedAudio(slotId, blob, duration) {
        const slot = this.slots.find(s => s.id === slotId);
        if (slot) {
            slot.audioBlob = blob;
            slot.duration = Math.max(0.5, duration);
            await this.storage.saveSlot(slot);
            this.renderSlots();
            this.showToast(`✅ 録音を保存しました (${slot.duration.toFixed(1)}秒)`);
        }
    }

    cleanupRecording() {
        this.recordingSlotId = null;
    }

    // ==================== 音声再生制御 ====================
    async playSlot(slotId) {
        await AudioUnlocker.unlock();
        const ctx = AudioUnlocker.getContext();

        const slot = this.slots.find(s => s.id === slotId);
        if (!slot || !slot.audioBlob) {
            // 未録音の場合は即座に録音モードにして録音開始
            this.setMode('record');
            this.startRecording(slotId);
            return;
        }

        // 既に再生中なら停止（トグル）
        if (this.activeSources.has(slotId)) {
            this.stopSlot(slotId);
            return;
        }

        try {
            const arrayBuffer = await slot.audioBlob.arrayBuffer();
            const originalBuffer = await ctx.decodeAudioData(arrayBuffer);

            // ピッチシフト＆エフェクト適用
            const finalBuffer = PitchShiftEngine.applyEffect(originalBuffer, this.currentEffect, ctx);

            const source = ctx.createBufferSource();
            source.buffer = finalBuffer;

            const gainNode = ctx.createGain();
            source.connect(gainNode);
            gainNode.connect(ctx.destination);

            source.start(0);

            const card = document.getElementById(`pad-${slotId}`);
            if (card) card.classList.add('playing');

            this.activeSources.set(slotId, source);

            source.onended = () => {
                this.stopSlot(slotId);
            };
        } catch (err) {
            console.error('Audio play error, using fallback:', err);
            this.fallbackPlay(slot, slotId);
        }
    }

    fallbackPlay(slot, slotId) {
        try {
            const audioUrl = URL.createObjectURL(slot.audioBlob);
            const audio = new Audio(audioUrl);
            audio.play();
            const card = document.getElementById(`pad-${slotId}`);
            if (card) card.classList.add('playing');
            audio.onended = () => {
                if (card) card.classList.remove('playing');
                URL.revokeObjectURL(audioUrl);
            };
        } catch (e) {
            console.error('Fallback error:', e);
        }
    }

    stopSlot(slotId) {
        if (this.activeSources.has(slotId)) {
            const source = this.activeSources.get(slotId);
            try {
                source.stop();
                source.disconnect();
            } catch (e) {}
            this.activeSources.delete(slotId);
        }
        const card = document.getElementById(`pad-${slotId}`);
        if (card) card.classList.remove('playing');
    }

    // ==================== 5. 3階層エクスポート（.vpad）＆ Web Share API ====================
    
    // Blob ➔ Base64変換
    blobToBase64(blob) {
        return new Promise((resolve) => {
            if (!blob) {
                resolve(null);
                return;
            }
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.readAsDataURL(blob);
        });
    }

    // Base64 ➔ Blob変換
    base64ToBlob(base64Str) {
        if (!base64Str) return null;
        const parts = base64Str.split(';base64,');
        const contentType = parts[0].split(':')[1];
        const raw = window.atob(parts[1]);
        const rawLength = raw.length;
        const uInt8Array = new Uint8Array(rawLength);
        for (let i = 0; i < rawLength; ++i) {
            uInt8Array[i] = raw.charCodeAt(i);
        }
        return new Blob([uInt8Array], { type: contentType });
    }

    // 共通共有 / ダウンロードハンドラー
    async shareOrDownloadFile(fileName, jsonString) {
        const blob = new Blob([jsonString], { type: 'application/json' });
        const file = new File([blob], fileName, { type: 'application/json' });

        // Web Share API（スマホの共有メニュー・LINE等への送信）
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            try {
                await navigator.share({
                    files: [file],
                    title: fileName,
                    text: `Voice Pad バックアップデータ: ${fileName}`
                });
                this.showToast('✅ 共有メニューを開きました');
                return;
            } catch (err) {
                if (err.name !== 'AbortError') {
                    console.warn('Share API error:', err);
                }
            }
        }

        // フォールバック: ファイルダウンロード
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(url);
        this.showToast(`💾 「${fileName}」を保存しました`);
    }

    // ① 単一スイッチのエクスポート
    async exportSingleSlot(slotId) {
        const slot = this.slots.find(s => s.id === slotId);
        if (!slot) return;

        const audioBase64 = await this.blobToBase64(slot.audioBlob);
        const exportData = {
            type: 'voicepad_slot',
            version: '2.0',
            exportedAt: new Date().toISOString(),
            slot: {
                label: slot.label,
                labelPosition: slot.labelPosition,
                emoji: slot.emoji,
                imageUrl: slot.imageUrl,
                imageScale: slot.imageScale,
                imageOffsetX: slot.imageOffsetX,
                imageOffsetY: slot.imageOffsetY,
                imageFit: slot.imageFit,
                duration: slot.duration,
                audioBase64: audioBase64
            }
        };

        const safeLabel = (slot.label || 'slot').replace(/[\\/:*?"<>|]/g, '_');
        const fileName = `VoicePad_Slot_${safeLabel}.vpad`;
        await this.shareOrDownloadFile(fileName, JSON.stringify(exportData, null, 2));
    }

    // ② スクロール（グループ）単位のエクスポート
    async exportScroll(scrollId) {
        const scroll = this.scrolls.find(s => s.id === scrollId);
        if (!scroll) return;

        const targetSlots = this.slots.filter(s => s.scrollId === scrollId);
        const serializedSlots = [];

        for (const slot of targetSlots) {
            const audioBase64 = await this.blobToBase64(slot.audioBlob);
            serializedSlots.push({
                label: slot.label,
                labelPosition: slot.labelPosition,
                emoji: slot.emoji,
                imageUrl: slot.imageUrl,
                imageScale: slot.imageScale,
                imageOffsetX: slot.imageOffsetX,
                imageOffsetY: slot.imageOffsetY,
                imageFit: slot.imageFit,
                duration: slot.duration,
                order: slot.order,
                audioBase64: audioBase64
            });
        }

        const exportData = {
            type: 'voicepad_scroll',
            version: '2.0',
            exportedAt: new Date().toISOString(),
            scroll: {
                name: scroll.name
            },
            slots: serializedSlots
        };

        const safeName = (scroll.name || 'group').replace(/[\\/:*?"<>|]/g, '_');
        const fileName = `VoicePad_Group_${safeName}.vpad`;
        await this.shareOrDownloadFile(fileName, JSON.stringify(exportData, null, 2));
    }

    // ③ アプリ全体の完全エクスポート
    async exportAllData() {
        const serializedScrolls = [];
        const serializedSlots = [];

        for (const scroll of this.scrolls) {
            serializedScrolls.push({
                id: scroll.id,
                name: scroll.name,
                order: scroll.order
            });
        }

        for (const slot of this.slots) {
            const audioBase64 = await this.blobToBase64(slot.audioBlob);
            serializedSlots.push({
                id: slot.id,
                scrollId: slot.scrollId,
                label: slot.label,
                labelPosition: slot.labelPosition,
                emoji: slot.emoji,
                imageUrl: slot.imageUrl,
                imageScale: slot.imageScale,
                imageOffsetX: slot.imageOffsetX,
                imageOffsetY: slot.imageOffsetY,
                imageFit: slot.imageFit,
                duration: slot.duration,
                order: slot.order,
                audioBase64: audioBase64
            });
        }

        const exportData = {
            type: 'voicepad_all',
            version: '2.0',
            exportedAt: new Date().toISOString(),
            settings: {
                pageSize: this.pageSize,
                effect: this.currentEffect,
                currentScrollId: this.currentScrollId
            },
            scrolls: serializedScrolls,
            slots: serializedSlots
        };

        const dateStr = new Date().toISOString().slice(0, 10);
        const fileName = `VoicePad_FullBackup_${dateStr}.vpad`;
        await this.shareOrDownloadFile(fileName, JSON.stringify(exportData, null, 2));
    }

    // ==================== 6. アプリ内インポート（ファイルピッカー） ====================
    async handleGlobalImport(file) {
        if (!file) return;

        // 音声ファイル（MP3/WAV/M4A/AAC/OGG）が直接選択された場合
        if (file.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg)$/i.test(file.name)) {
            const currentSlots = this.getCurrentSlots();
            const slotName = file.name.replace(/\.[^/.]+$/, '');
            const newSlot = {
                id: 'slot_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
                scrollId: this.currentScrollId,
                label: slotName,
                labelPosition: 'bottom',
                emoji: '🎵',
                imageUrl: null,
                imageScale: 1.0,
                imageOffsetX: 0,
                imageOffsetY: 0,
                imageFit: 'cover',
                audioBlob: file,
                duration: 3.0,
                order: currentSlots.length + 1
            };
            await this.storage.saveSlot(newSlot);
            this.slots.push(newSlot);
            this.renderSlots();
            this.renderScrollTabs();
            this.showToast(`🎵 音声「${slotName}」をスイッチとして追加しました`);
            return;
        }

        // .vpad / .json ファイルの解析
        try {
            const text = await file.text();
            const data = JSON.parse(text);

            if (data.type === 'voicepad_all') {
                // ③ 全体バックアップの復元
                if (confirm('アプリ全体のバックアップデータを読み込みますか？（既存のデータに統合または上書きされます）')) {
                    if (data.settings?.pageSize) {
                        this.pageSize = data.settings.pageSize;
                        await this.storage.saveSetting('pageSize', this.pageSize);
                        const pageSizeSelect = document.getElementById('setting-page-size');
                        if (pageSizeSelect) pageSizeSelect.value = String(this.pageSize);
                    }

                    // スクロールの登録
                    if (Array.isArray(data.scrolls)) {
                        for (const s of data.scrolls) {
                            const existing = this.scrolls.find(sc => sc.id === s.id);
                            if (!existing) {
                                await this.storage.saveScroll(s);
                                this.scrolls.push(s);
                            }
                        }
                    }

                    // スロットの復元
                    if (Array.isArray(data.slots)) {
                        for (const s of data.slots) {
                            const blob = this.base64ToBlob(s.audioBase64);
                            const slotObj = {
                                ...s,
                                audioBlob: blob
                            };
                            delete slotObj.audioBase64;
                            await this.storage.saveSlot(slotObj);

                            const existingIdx = this.slots.findIndex(sl => sl.id === slotObj.id);
                            if (existingIdx !== -1) {
                                this.slots[existingIdx] = slotObj;
                            } else {
                                this.slots.push(slotObj);
                            }
                        }
                    }

                    this.renderScrollTabs();
                    this.renderSlots();
                    this.showToast('🎉 アプリ全体のバックアップを復元しました！');
                }
            } else if (data.type === 'voicepad_scroll') {
                // ② スクロール（グループ）のインポート
                const newScrollId = 'scroll_' + Date.now();
                const newScroll = {
                    id: newScrollId,
                    name: data.scroll?.name || 'インポートグループ',
                    order: this.scrolls.length,
                    createdAt: Date.now()
                };
                await this.storage.saveScroll(newScroll);
                this.scrolls.push(newScroll);

                if (Array.isArray(data.slots)) {
                    for (const s of data.slots) {
                        const blob = this.base64ToBlob(s.audioBase64);
                        const slotObj = {
                            id: 'slot_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
                            scrollId: newScrollId,
                            label: s.label || 'ボタン',
                            labelPosition: s.labelPosition || 'bottom',
                            emoji: s.emoji || '🔊',
                            imageUrl: s.imageUrl || null,
                            imageScale: s.imageScale || 1.0,
                            imageOffsetX: s.imageOffsetX || 0,
                            imageOffsetY: s.imageOffsetY || 0,
                            imageFit: s.imageFit || 'cover',
                            audioBlob: blob,
                            duration: s.duration || 0,
                            order: s.order || 1
                        };
                        await this.storage.saveSlot(slotObj);
                        this.slots.push(slotObj);
                    }
                }

                await this.switchScroll(newScrollId);
                this.showToast(`✨ グループ「${newScroll.name}」をインポートしました！`);
            } else if (data.type === 'voicepad_slot' || data.slot) {
                // ① 単体スイッチのインポート
                const s = data.slot || data;
                const blob = this.base64ToBlob(s.audioBase64);
                const currentSlots = this.getCurrentSlots();
                const newSlot = {
                    id: 'slot_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
                    scrollId: this.currentScrollId,
                    label: s.label || 'インポートボタン',
                    labelPosition: s.labelPosition || 'bottom',
                    emoji: s.emoji || '🔊',
                    imageUrl: s.imageUrl || null,
                    imageScale: s.imageScale || 1.0,
                    imageOffsetX: s.imageOffsetX || 0,
                    imageOffsetY: s.imageOffsetY || 0,
                    imageFit: s.imageFit || 'cover',
                    audioBlob: blob,
                    duration: s.duration || 0,
                    order: currentSlots.length + 1
                };

                await this.storage.saveSlot(newSlot);
                this.slots.push(newSlot);
                this.renderSlots();
                this.renderScrollTabs();
                this.showToast(`✨ スイッチ「${newSlot.label}」をインポートしました！`);
            } else {
                alert('対応していないファイル形式です。(.vpad / .json / 音声ファイル)');
            }
        } catch (err) {
            console.error('Import error:', err);
            alert('ファイルの読み込みに失敗しました。正しいVoice Padバックアップファイルを選択してください。');
        }
    }

    // ==================== モーダルイベント初期化 ====================
    initModalEvents() {
        // ① スイッチ設定モーダル
        document.getElementById('close-modal-btn')?.addEventListener('click', () => this.closeEditModal());
        document.getElementById('modal-backdrop')?.addEventListener('click', (e) => {
            if (e.target.id === 'modal-backdrop') this.closeEditModal();
        });
        document.getElementById('save-slot-btn')?.addEventListener('click', () => this.saveEditModal());
        document.getElementById('export-single-slot-btn')?.addEventListener('click', () => {
            if (this.editingSlotId) this.exportSingleSlot(this.editingSlotId);
        });
        document.getElementById('duplicate-slot-btn')?.addEventListener('click', () => {
            if (this.editingSlotId) this.duplicateSlot(this.editingSlotId);
        });
        document.getElementById('delete-slot-btn')?.addEventListener('click', () => {
            if (this.editingSlotId) this.deleteSlot(this.editingSlotId);
        });
        document.getElementById('delete-audio-btn')?.addEventListener('click', () => this.deleteSlotAudio());
        document.getElementById('download-audio-btn')?.addEventListener('click', () => this.downloadSlotAudio());

        document.getElementById('import-slot-audio-btn')?.addEventListener('click', () => {
            document.getElementById('slot-audio-input')?.click();
        });
        document.getElementById('slot-audio-input')?.addEventListener('change', async (e) => {
            if (e.target.files.length > 0) {
                await this.handleSlotAudioUpload(e.target.files[0]);
                e.target.value = '';
            }
        });

        // ② スクロールモーダル
        document.getElementById('close-scroll-modal-btn')?.addEventListener('click', () => this.closeScrollModal());
        document.getElementById('scroll-modal-backdrop')?.addEventListener('click', (e) => {
            if (e.target.id === 'scroll-modal-backdrop') this.closeScrollModal();
        });
        document.getElementById('save-scroll-btn')?.addEventListener('click', () => this.saveScrollModal());
        document.getElementById('export-scroll-btn')?.addEventListener('click', () => {
            if (this.editingScrollId) this.exportScroll(this.editingScrollId);
        });
        document.getElementById('duplicate-scroll-btn')?.addEventListener('click', () => this.duplicateCurrentScroll());
        document.getElementById('delete-scroll-btn')?.addEventListener('click', () => this.deleteScrollModal());

        // ③ 全体設定モーダル
        document.getElementById('close-settings-modal-btn')?.addEventListener('click', () => this.closeSettingsModal());
        document.getElementById('settings-modal-backdrop')?.addEventListener('click', (e) => {
            if (e.target.id === 'settings-modal-backdrop') this.closeSettingsModal();
        });
        document.getElementById('setting-page-size')?.addEventListener('change', async (e) => {
            this.pageSize = parseInt(e.target.value, 10);
            await this.storage.saveSetting('pageSize', this.pageSize);
            this.currentPage = 1;
            this.renderSlots();
            this.showToast(`1画面のスイッチ表示数を「${this.pageSize}個」に変更しました`);
        });
        document.getElementById('export-all-btn')?.addEventListener('click', () => this.exportAllData());
        document.getElementById('import-from-settings-btn')?.addEventListener('click', () => {
            this.closeSettingsModal();
            document.getElementById('global-import-input')?.click();
        });
        document.getElementById('reset-all-data-btn')?.addEventListener('click', async () => {
            if (confirm('すべてのグループ・録音音声・設定を初期状態にリセットしますか？この操作は取り消せません。')) {
                await this.storage.clearAll();
                location.reload();
            }
        });

        // ④ QRモーダル
        document.getElementById('close-qr-modal-btn')?.addEventListener('click', () => this.closeQrModal());
        document.getElementById('qr-modal-backdrop')?.addEventListener('click', (e) => {
            if (e.target.id === 'qr-modal-backdrop') this.closeQrModal();
        });
        document.getElementById('copy-url-btn')?.addEventListener('click', async () => {
            const urlText = 'https://galakutar.github.io/Voice-Pad/';
            try {
                await navigator.clipboard.writeText(urlText);
                this.showToast('📋 アプリURLをコピーしました！');
            } catch (e) {
                alert(`URL: ${urlText}`);
            }
        });
    }

    // ==================== スイッチエディタ制御 ====================
    openEditModal(slotId) {
        this.editingSlotId = slotId;
        const slot = this.slots.find(s => s.id === slotId);
        if (!slot) return;

        const currentSlots = this.getCurrentSlots();
        const displayIndex = currentSlots.findIndex(s => s.id === slotId) + 1;

        const modalNumEl = document.getElementById('modal-slot-num');
        if (modalNumEl) modalNumEl.innerText = displayIndex > 0 ? displayIndex : '';

        const labelInput = document.getElementById('edit-label');
        if (labelInput) labelInput.value = slot.label;

        const emojiInput = document.getElementById('edit-emoji');
        if (emojiInput) emojiInput.value = slot.emoji || '🔊';

        this.editingImageUrl = slot.imageUrl || null;
        this.editingImageScale = slot.imageScale !== undefined ? slot.imageScale : 1.0;
        this.editingImageOffsetX = slot.imageOffsetX !== undefined ? slot.imageOffsetX : 0;
        this.editingImageOffsetY = slot.imageOffsetY !== undefined ? slot.imageOffsetY : 0;
        this.editingImageFit = slot.imageFit || 'cover';

        // プレビュー枠のスタイリング
        const targetCard = document.getElementById(`pad-${slotId}`);
        const viewport = document.getElementById('photo-crop-viewport');
        if (targetCard && viewport) {
            const rect = targetCard.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                const ratio = rect.width / rect.height;
                const baseWidth = Math.min(220, window.innerWidth - 80);
                const targetHeight = Math.round(baseWidth / ratio);
                viewport.style.width = `${baseWidth}px`;
                viewport.style.height = `${targetHeight}px`;
            }
            const colorIdx = ((displayIndex - 1) % 8) + 1;
            viewport.style.setProperty('--preview-slot-color', `var(--slot-c${colorIdx})`);

            const badge = document.getElementById('preview-slot-badge');
            if (badge) badge.innerText = displayIndex;
            const statusEl = document.getElementById('preview-status');
            if (statusEl) {
                statusEl.innerText = slot.audioBlob ? `${slot.duration.toFixed(1)}s` : '未録音';
            }
        }

        // ラベル位置
        const currentPos = slot.labelPosition || 'bottom';
        const posInput = document.getElementById('edit-label-pos');
        if (posInput) posInput.value = currentPos;
        document.querySelectorAll('.pos-btn').forEach(btn => {
            if (btn.getAttribute('data-pos') === currentPos) btn.classList.add('active');
            else btn.classList.remove('active');
        });

        // 絵文字選択
        document.querySelectorAll('.emoji-opt').forEach(opt => {
            if (!this.editingImageUrl && opt.innerText === slot.emoji) opt.classList.add('selected');
            else opt.classList.remove('selected');
        });

        this.updateModalPhotoPreview();

        const deleteAudioBtn = document.getElementById('delete-audio-btn');
        const downloadAudioBtn = document.getElementById('download-audio-btn');
        if (slot.audioBlob) {
            if (deleteAudioBtn) deleteAudioBtn.style.display = 'block';
            if (downloadAudioBtn) downloadAudioBtn.style.display = 'block';
        } else {
            if (deleteAudioBtn) deleteAudioBtn.style.display = 'none';
            if (downloadAudioBtn) downloadAudioBtn.style.display = 'none';
        }

        document.getElementById('modal-backdrop')?.classList.add('open');
    }

    closeEditModal() {
        document.getElementById('modal-backdrop')?.classList.remove('open');
        this.editingSlotId = null;
    }

    async saveEditModal() {
        if (!this.editingSlotId) return;
        const slot = this.slots.find(s => s.id === this.editingSlotId);
        if (!slot) return;

        const labelInput = document.getElementById('edit-label')?.value.trim();
        const emojiInput = document.getElementById('edit-emoji')?.value.trim();
        const labelPos = document.getElementById('edit-label-pos')?.value || 'bottom';

        slot.label = labelInput || `ボタン`;
        slot.labelPosition = labelPos;
        slot.emoji = emojiInput || '🔊';
        slot.imageUrl = this.editingImageUrl;
        slot.imageScale = this.editingImageScale;
        slot.imageOffsetX = this.editingImageOffsetX;
        slot.imageOffsetY = this.editingImageOffsetY;
        slot.imageFit = this.editingImageFit;

        await this.storage.saveSlot(slot);
        this.renderSlots();
        this.closeEditModal();
        this.showToast(`💾 スイッチ「${slot.label}」の設定を保存しました`);
    }

    async deleteSlotAudio() {
        if (!this.editingSlotId) return;
        const slot = this.slots.find(s => s.id === this.editingSlotId);
        if (!slot) return;

        if (confirm('このスイッチの録音音声を消去しますか？')) {
            this.stopSlot(slot.id);
            slot.audioBlob = null;
            slot.duration = 0;
            await this.storage.saveSlot(slot);
            this.renderSlots();
            this.closeEditModal();
            this.showToast('🔇 録音音声を消去しました');
        }
    }

    downloadSlotAudio() {
        if (!this.editingSlotId) return;
        const slot = this.slots.find(s => s.id === this.editingSlotId);
        if (slot && slot.audioBlob) {
            const url = URL.createObjectURL(slot.audioBlob);
            const a = document.createElement('a');
            a.href = url;
            const ext = slot.audioBlob.type.includes('mp4') ? 'm4a' : 'webm';
            const safeLabel = (slot.label || 'voice').replace(/[\\/:*?"<>|]/g, '_');
            a.download = `${safeLabel}.${ext}`;
            a.click();
            URL.revokeObjectURL(url);
        }
    }

    async handleSlotAudioUpload(file) {
        if (!this.editingSlotId) return;
        const slot = this.slots.find(s => s.id === this.editingSlotId);
        if (slot) {
            slot.audioBlob = file;
            slot.duration = 3.0;
            await this.storage.saveSlot(slot);
            this.renderSlots();
            this.closeEditModal();
            this.showToast(`📁 「${file.name}」をセットしました！`);
        }
    }

    // エディタイベント設定
    initEditorEvents() {
        // ラベル位置選択
        document.querySelectorAll('.pos-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.pos-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const posInput = document.getElementById('edit-label-pos');
                if (posInput) posInput.value = btn.getAttribute('data-pos');
                this.updateModalPhotoPreview();
            });
        });

        // ラベル文字入力連動
        document.getElementById('edit-label')?.addEventListener('input', () => {
            this.updateModalPhotoPreview();
        });

        // 写真選択
        const selectPhotoBtn = document.getElementById('select-photo-btn');
        const photoFileInput = document.getElementById('photo-file-input');
        const removePhotoBtn = document.getElementById('remove-photo-btn');

        if (selectPhotoBtn && photoFileInput) {
            selectPhotoBtn.addEventListener('click', () => photoFileInput.click());
            photoFileInput.addEventListener('change', async (e) => {
                if (e.target.files.length > 0) {
                    await this.handlePhotoUpload(e.target.files[0]);
                }
                photoFileInput.value = '';
            });
        }

        if (removePhotoBtn) {
            removePhotoBtn.addEventListener('click', () => {
                this.editingImageUrl = null;
                this.editingImageScale = 1.0;
                this.editingImageOffsetX = 0;
                this.editingImageOffsetY = 0;
                this.editingImageFit = 'cover';
                this.updateModalPhotoPreview();
            });
        }

        // ズームスライダー
        const zoomSlider = document.getElementById('photo-zoom-slider');
        if (zoomSlider) {
            zoomSlider.addEventListener('input', (e) => {
                this.editingImageScale = parseInt(e.target.value, 10) / 100;
                const zoomVal = document.getElementById('photo-zoom-val');
                if (zoomVal) zoomVal.innerText = `${e.target.value}%`;
                this.applyPhotoCropTransform();
            });
        }

        // 十字キー位置調整
        document.querySelectorAll('.dpad-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const moveType = btn.getAttribute('data-move');
                const step = 6;
                if (moveType === 'up') this.editingImageOffsetY -= step;
                else if (moveType === 'down') this.editingImageOffsetY += step;
                else if (moveType === 'left') this.editingImageOffsetX -= step;
                else if (moveType === 'right') this.editingImageOffsetX += step;
                else if (moveType === 'reset') {
                    this.editingImageScale = 1.0;
                    this.editingImageOffsetX = 0;
                    this.editingImageOffsetY = 0;
                    this.editingImageFit = 'cover';
                    if (zoomSlider) zoomSlider.value = 100;
                    const zoomVal = document.getElementById('photo-zoom-val');
                    if (zoomVal) zoomVal.innerText = '100%';
                    document.querySelectorAll('.fit-mode-btn').forEach(b => {
                        if (b.getAttribute('data-fit') === 'cover') b.classList.add('active');
                        else b.classList.remove('active');
                    });
                }
                this.applyPhotoCropTransform();
            });
        });

        // フィットモード
        document.querySelectorAll('.fit-mode-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.fit-mode-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.editingImageFit = btn.getAttribute('data-fit');
                this.applyPhotoCropTransform();
            });
        });

        // プレビュー枠ドラッグ
        this.initCropViewportDrag();

        // 絵文字選択
        document.querySelectorAll('.emoji-opt').forEach(opt => {
            opt.addEventListener('click', () => {
                document.querySelectorAll('.emoji-opt').forEach(o => o.classList.remove('selected'));
                opt.classList.add('selected');
                const emojiInput = document.getElementById('edit-emoji');
                if (emojiInput) emojiInput.value = opt.innerText;
                this.editingImageUrl = null;
                this.updateModalPhotoPreview();
            });
        });
    }

    initCropViewportDrag() {
        const viewport = document.getElementById('photo-crop-viewport');
        if (!viewport) return;

        let isDragging = false;
        let startX = 0, startY = 0;
        let initialOffsetX = 0, initialOffsetY = 0;

        const onPointerDown = (e) => {
            if (!this.editingImageUrl) return;
            isDragging = true;
            startX = e.clientX || (e.touches && e.touches[0].clientX) || 0;
            startY = e.clientY || (e.touches && e.touches[0].clientY) || 0;
            initialOffsetX = this.editingImageOffsetX;
            initialOffsetY = this.editingImageOffsetY;
            viewport.setPointerCapture?.(e.pointerId);
        };

        const onPointerMove = (e) => {
            if (!isDragging) return;
            const currentX = e.clientX || (e.touches && e.touches[0].clientX) || 0;
            const currentY = e.clientY || (e.touches && e.touches[0].clientY) || 0;
            const dx = currentX - startX;
            const dy = currentY - startY;

            const rect = viewport.getBoundingClientRect();
            const percentX = (dx / rect.width) * 100;
            const percentY = (dy / rect.height) * 100;

            this.editingImageOffsetX = initialOffsetX + percentX;
            this.editingImageOffsetY = initialOffsetY + percentY;
            this.applyPhotoCropTransform();
        };

        const onPointerUp = () => { isDragging = false; };

        viewport.addEventListener('pointerdown', onPointerDown);
        viewport.addEventListener('pointermove', onPointerMove);
        viewport.addEventListener('pointerup', onPointerUp);
        viewport.addEventListener('pointercancel', onPointerUp);
    }

    applyPhotoCropTransform() {
        const cropImg = document.getElementById('photo-crop-img');
        if (cropImg) {
            cropImg.style.transform = `scale(${this.editingImageScale}) translate(${this.editingImageOffsetX}%, ${this.editingImageOffsetY}%)`;
            cropImg.style.objectFit = this.editingImageFit;
        }
    }

    async handlePhotoUpload(file) {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    const maxDim = 800;
                    let w = img.width, h = img.height;

                    if (w > maxDim || h > maxDim) {
                        if (w > h) {
                            h = Math.round((h * maxDim) / w);
                            w = maxDim;
                        } else {
                            w = Math.round((w * maxDim) / h);
                            h = maxDim;
                        }
                    }

                    canvas.width = w;
                    canvas.height = h;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, w, h);

                    this.editingImageUrl = canvas.toDataURL('image/jpeg', 0.88);
                    this.editingImageScale = 1.0;
                    this.editingImageOffsetX = 0;
                    this.editingImageOffsetY = 0;
                    this.editingImageFit = 'cover';

                    this.updateModalPhotoPreview();
                    resolve();
                };
                img.src = e.target.result;
            };
            reader.readAsDataURL(file);
        });
    }

    updateModalPhotoPreview() {
        const adjustBox = document.getElementById('photo-adjust-box');
        const removePhotoBtn = document.getElementById('remove-photo-btn');
        const cropImg = document.getElementById('photo-crop-img');
        const zoomSlider = document.getElementById('photo-zoom-slider');
        const viewport = document.getElementById('photo-crop-viewport');

        const currentLabel = document.getElementById('edit-label')?.value || 'ボタン';
        const currentPos = document.getElementById('edit-label-pos')?.value || 'bottom';

        if (this.editingImageUrl) {
            if (adjustBox) adjustBox.style.display = 'flex';
            if (removePhotoBtn) removePhotoBtn.style.display = 'block';
            if (cropImg) {
                cropImg.src = this.editingImageUrl;
                this.applyPhotoCropTransform();
            }
            if (zoomSlider) {
                zoomSlider.value = Math.round(this.editingImageScale * 100);
                const zoomVal = document.getElementById('photo-zoom-val');
                if (zoomVal) zoomVal.innerText = `${zoomSlider.value}%`;
            }
            document.querySelectorAll('.fit-mode-btn').forEach(btn => {
                if (btn.getAttribute('data-fit') === this.editingImageFit) btn.classList.add('active');
                else btn.classList.remove('active');
            });
            document.querySelectorAll('.emoji-opt').forEach(opt => opt.classList.remove('selected'));

            if (viewport) {
                viewport.className = `photo-crop-viewport pad-card-preview pos-${currentPos}`;
                const topEl = document.getElementById('preview-label-top');
                const centerEl = document.getElementById('preview-label-center');
                const bottomEl = document.getElementById('preview-label-bottom');
                if (topEl) topEl.innerText = currentLabel;
                if (centerEl) centerEl.innerText = currentLabel;
                if (bottomEl) bottomEl.innerText = currentLabel;
            }
        } else {
            if (adjustBox) adjustBox.style.display = 'none';
            if (removePhotoBtn) removePhotoBtn.style.display = 'none';
            const currentEmoji = document.getElementById('edit-emoji')?.value;
            document.querySelectorAll('.emoji-opt').forEach(opt => {
                if (opt.innerText === currentEmoji) opt.classList.add('selected');
                else opt.classList.remove('selected');
            });
        }
    }

    // ==================== 設定＆QRモーダル ====================
    openSettingsModal() {
        document.getElementById('settings-modal-backdrop')?.classList.add('open');
    }

    closeSettingsModal() {
        document.getElementById('settings-modal-backdrop')?.classList.remove('open');
    }

    openQrModal() {
        this.renderQrCodeCanvas();
        document.getElementById('qr-modal-backdrop')?.classList.add('open');
    }

    closeQrModal() {
        document.getElementById('qr-modal-backdrop')?.classList.remove('open');
    }

    // オフラインスタンドアロン QRコード Canvas描画
    renderQrCodeCanvas() {
        const canvas = document.getElementById('qr-canvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const size = canvas.width;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, size, size);

        // クリーンなQR風パターン描画（外部通信完全不要）
        const url = 'https://galakutar.github.io/Voice-Pad/';
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            ctx.drawImage(img, 0, 0, size, size);
        };
        img.src = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(url)}`;
    }

    // ==================== ユーティリティ ====================
    showToast(msg) {
        const container = document.getElementById('toast-container');
        if (!container) return;

        const toast = document.createElement('div');
        toast.className = 'toast-msg';
        toast.innerText = msg;
        container.appendChild(toast);

        setTimeout(() => {
            toast.remove();
        }, 3000);
    }

    escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
}

// 起動初期化
window.addEventListener('DOMContentLoaded', () => {
    window.app = new VoicePadApp();
});
