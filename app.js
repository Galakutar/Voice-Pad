/**
 * Voice Pad 6 - 音声録音＆サンプラー アプリケーションロジック
 * スピード等倍・音程ピッチシフト対応 ＆ iOS Safari 完全対応
 */

// --- IndexedDB ストレージマネージャー ---
class StorageManager {
    constructor() {
        this.dbName = 'VoicePad6DB';
        this.dbVersion = 1;
        this.db = null;
    }

    async init() {
        return new Promise((resolve) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);

            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('slots')) {
                    db.createObjectStore('slots', { keyPath: 'id' });
                }
            };

            request.onsuccess = (e) => {
                this.db = e.target.result;
                resolve();
            };

            request.onerror = (e) => {
                console.error('IndexedDB open error:', e);
                resolve();
            };
        });
    }

    async saveSlot(slotData) {
        if (!this.db) return;
        return new Promise((resolve) => {
            const tx = this.db.transaction('slots', 'readwrite');
            const store = tx.objectStore('slots');
            const dataToSave = {
                id: slotData.id,
                label: slotData.label,
                labelPosition: slotData.labelPosition || 'bottom',
                emoji: slotData.emoji,
                imageUrl: slotData.imageUrl || null,
                imageScale: slotData.imageScale !== undefined ? slotData.imageScale : 1.0,
                imageOffsetX: slotData.imageOffsetX !== undefined ? slotData.imageOffsetX : 0,
                imageOffsetY: slotData.imageOffsetY !== undefined ? slotData.imageOffsetY : 0,
                imageFit: slotData.imageFit || 'cover',
                audioBlob: slotData.audioBlob,
                duration: slotData.duration
            };
            store.put(dataToSave);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        });
    }

    async getAllSlots() {
        if (!this.db) return [];
        return new Promise((resolve) => {
            const tx = this.db.transaction('slots', 'readonly');
            const store = tx.objectStore('slots');
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => resolve([]);
        });
    }
}

// --- 再生スピードを変えずに音程（声の高さ）や声質を変えるボイスチェンジエンジン ---
class PitchShiftEngine {
    /**
     * グラニュラー・オーバーラップ・アド法による高品質ピッチシフト＆エフェクト
     * @param {AudioBuffer} buffer - 元の音声バッファ
     * @param {number} pitchRatio - ピッチ倍率
     * @param {AudioContext} ctx - AudioContext
     * @param {Object} options - トレモロやリングモジュレーション等の追加効果
     * @returns {AudioBuffer} 変換後のバッファ（再生時間は元と同一＝スピード不変！）
     */
    static process(buffer, pitchRatio, ctx, options = {}) {
        const numChannels = buffer.numberOfChannels;
        const sampleRate = buffer.sampleRate;
        const numSamples = buffer.length;

        // ピッチも変えず追加エフェクトもない場合はそのまま返す
        if (pitchRatio === 1.0 && !options.tremoloFreq && !options.ringModFreq) {
            return buffer;
        }

        // グレインサイズ（約45ms）
        const grainSize = Math.floor(sampleRate * 0.045);
        const hopSize = Math.floor(grainSize / 2);

        const outputBuffer = ctx.createBuffer(numChannels, numSamples, sampleRate);

        for (let ch = 0; ch < numChannels; ch++) {
            const inputData = buffer.getChannelData(ch);
            const outputData = outputBuffer.getChannelData(ch);

            // ハン窓（Hann Window）の作成
            const windowTable = new Float32Array(grainSize);
            for (let i = 0; i < grainSize; i++) {
                windowTable[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (grainSize - 1)));
            }

            if (pitchRatio === 1.0) {
                // ピッチ変更なしの場合はそのままコピー
                for (let i = 0; i < numSamples; i++) {
                    outputData[i] = inputData[i];
                }
            } else {
                // ピッチシフト処理
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

            // オプション1: 声の震え（おじいさん・おばあさん向けビブラート・トレモロ効果）
            if (options.tremoloFreq) {
                const depth = options.tremoloDepth || 0.35;
                for (let i = 0; i < numSamples; i++) {
                    const lfo = 1.0 - depth + depth * Math.sin((2 * Math.PI * options.tremoloFreq * i) / sampleRate);
                    outputData[i] *= lfo;
                }
            }

            // オプション2: SFリングモジュレーション（宇宙人向けエフェクト）
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

    /**
     * ロボット声エフェクト（65Hz 金属的モジュレーション）
     */
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

    /**
     * 指定されたエフェクト名に応じたボイス変換を実行
     */
    static applyEffect(buffer, effectName, ctx) {
        switch (effectName) {
            case 'baby': // 👶 赤ちゃん（超高音）
                return this.process(buffer, 1.55, ctx);

            case 'boy': // 👦 男の子（元気な子供声）
                return this.process(buffer, 1.15, ctx);

            case 'girl': // 👧 女の子（澄んだ高音）
                return this.process(buffer, 1.32, ctx);

            case 'man': // 👨 男の人（落ち着いた大人の低音）
                return this.process(buffer, 0.85, ctx);

            case 'woman': // 👩 女の人（自然な女性声）
                return this.process(buffer, 1.22, ctx);

            case 'old_man': // 👴 おじいさん（低音 ＋ ゆっくりした声の震え）
                return this.process(buffer, 0.72, ctx, { tremoloFreq: 5.5, tremoloDepth: 0.38 });

            case 'old_woman': // 👵 おばあさん（高め ＋ 声の震え）
                return this.process(buffer, 1.25, ctx, { tremoloFreq: 6.0, tremoloDepth: 0.38 });

            case 'alien': // 👽 宇宙人（高音 ＋ SFワブルリングモジュレーション）
                return this.process(buffer, 1.38, ctx, { ringModFreq: 35, ringModMix: 0.75 });

            case 'robot': // 🤖 ロボット（金属的ロボットボイス）
                return this.processRobot(buffer, ctx);

            case 'monster': // 👹 怪獣（迫力の超重低音）
                return this.process(buffer, 0.58, ctx);

            case 'normal':
            default:
                return buffer;
        }
    }
}

// --- メインアプリクラス ---
class VoicePadApp {
    constructor() {
        this.storage = new StorageManager();
        this.audioCtx = null;
        this.mediaRecorder = null;
        this.audioStream = null;
        
        this.currentMode = 'play'; // 'play' | 'record'
        this.recordingSlot = null;
        this.recordedChunks = [];
        this.recTimer = null;
        this.recSeconds = 0;

        this.currentEffect = 'normal'; // 'normal', 'high', 'low', 'robot'

        // 6つのスロットの初期データ定義
        this.slots = [
            { id: 1, label: 'ボタン 1', labelPosition: 'bottom', emoji: '🔴', imageUrl: null, imageScale: 1.0, imageOffsetX: 0, imageOffsetY: 0, imageFit: 'cover', audioBlob: null, duration: 0 },
            { id: 2, label: 'ボタン 2', labelPosition: 'bottom', emoji: '🟠', imageUrl: null, imageScale: 1.0, imageOffsetX: 0, imageOffsetY: 0, imageFit: 'cover', audioBlob: null, duration: 0 },
            { id: 3, label: 'ボタン 3', labelPosition: 'bottom', emoji: '🟡', imageUrl: null, imageScale: 1.0, imageOffsetX: 0, imageOffsetY: 0, imageFit: 'cover', audioBlob: null, duration: 0 },
            { id: 4, label: 'ボタン 4', labelPosition: 'bottom', emoji: '🟢', imageUrl: null, imageScale: 1.0, imageOffsetX: 0, imageOffsetY: 0, imageFit: 'cover', audioBlob: null, duration: 0 },
            { id: 5, label: 'ボタン 5', labelPosition: 'bottom', emoji: '🔵', imageUrl: null, imageScale: 1.0, imageOffsetX: 0, imageOffsetY: 0, imageFit: 'cover', audioBlob: null, duration: 0 },
            { id: 6, label: 'ボタン 6', labelPosition: 'bottom', emoji: '🟣', imageUrl: null, imageScale: 1.0, imageOffsetX: 0, imageOffsetY: 0, imageFit: 'cover', audioBlob: null, duration: 0 }
        ];

        // 再生中のオーディオソース (slotId -> AudioBufferSourceNode)
        this.activeSources = new Map();

        // 編集モーダル用の一時状態
        this.editingSlotId = null;
        this.editingImageUrl = null;
        this.editingImageScale = 1.0;
        this.editingImageOffsetX = 0;
        this.editingImageOffsetY = 0;
        this.editingImageFit = 'cover';

        this.init();
    }

    async init() {
        await this.storage.init();
        await this.loadSavedSlots();
        this.renderSlots();
        this.initEvents();
        this.initCanvasVisualizers();
    }

    // iOS Safari 向けのオーディオアンロック
    unlockAudio() {
        if (!this.audioCtx) {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (AudioContextClass) {
                this.audioCtx = new AudioContextClass();
            }
        }
        if (this.audioCtx && this.audioCtx.state === 'suspended') {
            this.audioCtx.resume();
        }
    }

    // 保存データの読み込み
    async loadSavedSlots() {
        const saved = await this.storage.getAllSlots();
        for (const s of saved) {
            const idx = this.slots.findIndex(slot => slot.id === s.id);
            if (idx !== -1) {
                this.slots[idx] = { ...this.slots[idx], ...s };
            }
        }
    }

    // スロットの描画
    renderSlots() {
        const grid = document.getElementById('pad-grid');
        grid.innerHTML = '';

        this.slots.forEach(slot => {
            const card = document.createElement('div');
            const hasPhoto = !!slot.imageUrl;
            const pos = slot.labelPosition || 'bottom';
            card.className = `pad-card pos-${pos}${hasPhoto ? ' has-photo' : ''}`;
            card.setAttribute('data-slot', slot.id);
            card.id = `pad-${slot.id}`;

            const hasAudio = slot.audioBlob !== null;
            let statusText = '未録音';
            if (hasAudio) {
                statusText = `${slot.duration.toFixed(1)}秒`;
            }

            const labelHtml = `<div class="pad-label">${slot.label}</div>`;

            // 写真の位置・拡大率・フィットスタイルの生成
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

                <!-- 枠の一番上 (Top) -->
                <div class="pad-header">
                    <span class="slot-badge">${slot.id}</span>
                    ${pos === 'top' ? labelHtml : ''}
                    <button class="pad-settings-btn" title="設定・名前変更" data-slot="${slot.id}">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="12" cy="12" r="3"></circle>
                            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                        </svg>
                    </button>
                </div>

                <!-- 枠の真ん中 (Center) -->
                <div class="pad-body">
                    ${!hasPhoto ? `<div class="pad-emoji">${slot.emoji}</div>` : ''}
                    ${pos === 'center' ? labelHtml : ''}
                </div>

                <!-- 枠の一番下 (Bottom) -->
                <div class="pad-footer">
                    ${pos === 'bottom' ? labelHtml : ''}
                    <div class="pad-status">${statusText}</div>
                </div>
            `;

            grid.appendChild(card);
        });
    }

    // イベントリスナー設定
    initEvents() {
        window.addEventListener('click', () => this.unlockAudio(), { once: true });
        window.addEventListener('touchstart', () => this.unlockAudio(), { once: true });

        const grid = document.getElementById('pad-grid');

        // パッドクリックイベント
        grid.addEventListener('click', (e) => {
            this.unlockAudio();

            const settingsBtn = e.target.closest('.pad-settings-btn');
            const card = e.target.closest('.pad-card');

            if (settingsBtn) {
                e.stopPropagation();
                const slotId = parseInt(settingsBtn.getAttribute('data-slot'), 10);
                this.openEditModal(slotId);
                return;
            }

            if (card) {
                const slotId = parseInt(card.getAttribute('data-slot'), 10);
                if (this.currentMode === 'play') {
                    this.playSlot(slotId);
                } else {
                    this.toggleRecording(slotId);
                }
            }
        });

        // モード切替ボタン
        const playBtn = document.getElementById('mode-play-btn');
        const recordBtn = document.getElementById('mode-record-btn');

        playBtn.addEventListener('click', () => this.setMode('play'));
        recordBtn.addEventListener('click', () => this.setMode('record'));

        // ボイスエフェクト切り替え
        document.getElementById('voice-effect').addEventListener('change', (e) => {
            this.currentEffect = e.target.value;
        });

        // QRコードモーダル関連イベント
        const showQrBtn = document.getElementById('show-qr-btn');
        const qrModal = document.getElementById('qr-modal-backdrop');
        const closeQrBtn = document.getElementById('close-qr-modal-btn');
        const copyUrlBtn = document.getElementById('copy-url-btn');

        if (showQrBtn) {
            showQrBtn.addEventListener('click', () => qrModal.classList.add('open'));
        }

        if (closeQrBtn) {
            closeQrBtn.addEventListener('click', () => qrModal.classList.remove('open'));
        }

        if (qrModal) {
            qrModal.addEventListener('click', (e) => {
                if (e.target.id === 'qr-modal-backdrop') qrModal.classList.remove('open');
            });
        }

        if (copyUrlBtn) {
            copyUrlBtn.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText('https://galakutar.github.io/Voice-Pad/');
                    copyUrlBtn.innerText = '✅ コピーしました！';
                    setTimeout(() => {
                        copyUrlBtn.innerText = '🔗 URLをコピーする';
                    }, 2000);
                } catch (e) {
                    alert('URL: https://galakutar.github.io/Voice-Pad/');
                }
            });
        }

        // モーダル関連イベント
        document.getElementById('close-modal-btn').addEventListener('click', () => this.closeEditModal());
        document.getElementById('modal-backdrop').addEventListener('click', (e) => {
            if (e.target.id === 'modal-backdrop') this.closeEditModal();
        });

        document.getElementById('save-slot-btn').addEventListener('click', () => this.saveEditModal());
        document.getElementById('delete-audio-btn').addEventListener('click', () => this.deleteSlotAudio());
        document.getElementById('download-audio-btn').addEventListener('click', () => this.downloadSlotAudio());

        // 写真・絵文字・音声インポート等のエディタイベント初期化
        this.initEditorEvents();
    }

    setMode(mode) {
        if (this.recordingSlot !== null) {
            this.stopRecording();
        }
        this.currentMode = mode;
        const playBtn = document.getElementById('mode-play-btn');
        const recordBtn = document.getElementById('mode-record-btn');

        if (mode === 'play') {
            playBtn.classList.add('active');
            recordBtn.classList.remove('active');
            document.body.classList.remove('mode-record');
        } else {
            recordBtn.classList.add('active');
            playBtn.classList.remove('active');
            document.body.classList.add('mode-record');
        }
    }

    // --- マイクストリーム取得 ---
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

    // --- 録音制御 ---
    async toggleRecording(slotId) {
        if (this.recordingSlot === slotId) {
            this.stopRecording();
        } else {
            if (this.recordingSlot !== null) {
                this.stopRecording();
            }
            await this.startRecording(slotId);
        }
    }

    async startRecording(slotId) {
        this.unlockAudio();

        try {
            await this.getAudioStream();
        } catch (err) {
            alert('マイクの使用が許可されていません。Safariの設定でマイクアクセスを「許可」してください。');
            return;
        }

        this.recordingSlot = slotId;
        this.recordedChunks = [];
        this.recSeconds = 0;

        let mimeType = '';
        if (MediaRecorder.isTypeSupported('audio/mp4')) {
            mimeType = 'audio/mp4';
        } else if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
            mimeType = 'audio/webm;codecs=opus';
        } else if (MediaRecorder.isTypeSupported('audio/webm')) {
            mimeType = 'audio/webm';
        }

        try {
            this.mediaRecorder = mimeType ? new MediaRecorder(this.audioStream, { mimeType }) : new MediaRecorder(this.audioStream);
        } catch (e) {
            this.mediaRecorder = new MediaRecorder(this.audioStream);
        }

        this.mediaRecorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) {
                this.recordedChunks.push(e.data);
            }
        };

        this.mediaRecorder.onstop = async () => {
            const finalType = this.mediaRecorder.mimeType || 'audio/mp4';
            const blob = new Blob(this.recordedChunks, { type: finalType });
            await this.saveRecordedAudio(this.recordingSlot, blob, this.recSeconds);
            this.cleanupRecording();
        };

        this.mediaRecorder.start(100);

        const card = document.getElementById(`pad-${slotId}`);
        if (card) {
            card.classList.add('recording');
            const statusEl = card.querySelector('.pad-status');
            statusEl.innerText = '🔴 録音中... (0s)';
        }

        this.recTimer = setInterval(() => {
            this.recSeconds += 0.5;
            if (card) {
                const statusEl = card.querySelector('.pad-status');
                statusEl.innerText = `🔴 録音中... (${this.recSeconds.toFixed(0)}s)`;
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
        }
    }

    cleanupRecording() {
        this.recordingSlot = null;
    }

    // --- 音声再生制御（スピード等倍・声の高さのみ変更） ---
    async playSlot(slotId) {
        this.unlockAudio();

        const slot = this.slots.find(s => s.id === slotId);
        if (!slot || !slot.audioBlob) {
            this.setMode('record');
            this.startRecording(slotId);
            return;
        }

        // 既に再生中ならトグル停止
        if (this.activeSources.has(slotId)) {
            this.stopSlot(slotId);
            return;
        }

        try {
            const arrayBuffer = await slot.audioBlob.arrayBuffer();
            const originalBuffer = await this.audioCtx.decodeAudioData(arrayBuffer);

            // ボイスチェンジエフェクト適用（再生速度は1.0倍のまま、多彩な声質に変換！）
            const finalBuffer = PitchShiftEngine.applyEffect(originalBuffer, this.currentEffect, this.audioCtx);

            const source = this.audioCtx.createBufferSource();
            source.buffer = finalBuffer;

            const gainNode = this.audioCtx.createGain();
            source.connect(gainNode);
            gainNode.connect(this.audioCtx.destination);

            source.start(0);

            const card = document.getElementById(`pad-${slotId}`);
            if (card) card.classList.add('playing');

            this.activeSources.set(slotId, source);

            source.onended = () => {
                this.stopSlot(slotId);
            };

        } catch (err) {
            console.error('Audio play error:', err);
            // フォールバック再生
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

    // --- 写真選択・カメラ撮影関連イベント ---
    initEditorEvents() {
        // 位置選択ボタン（上・中・下）
        document.querySelectorAll('.pos-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.pos-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                document.getElementById('edit-label-pos').value = btn.getAttribute('data-pos');
            });
        });

        const selectPhotoBtn = document.getElementById('select-photo-btn');
        const photoFileInput = document.getElementById('photo-file-input');
        const removePhotoBtn = document.getElementById('remove-photo-btn');

        if (selectPhotoBtn && photoFileInput) {
            selectPhotoBtn.addEventListener('click', () => {
                photoFileInput.click();
            });

            photoFileInput.addEventListener('change', async (e) => {
                if (e.target.files.length > 0) {
                    await this.handlePhotoUpload(e.target.files[0]);
                }
                photoFileInput.value = ''; // リセット
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

        // ズームスライダーイベント
        const zoomSlider = document.getElementById('photo-zoom-slider');
        if (zoomSlider) {
            zoomSlider.addEventListener('input', (e) => {
                this.editingImageScale = parseInt(e.target.value, 10) / 100;
                document.getElementById('photo-zoom-val').innerText = `${e.target.value}%`;
                this.applyPhotoCropTransform();
            });
        }

        // 十字キー位置調整＆リセットボタン
        document.querySelectorAll('.dpad-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const moveType = btn.getAttribute('data-move');
                const step = 6; // 6%移動
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
                    document.getElementById('photo-zoom-val').innerText = '100%';
                    document.querySelectorAll('.fit-mode-btn').forEach(b => {
                        if (b.getAttribute('data-fit') === 'cover') b.classList.add('active');
                        else b.classList.remove('active');
                    });
                }
                this.applyPhotoCropTransform();
            });
        });

        // フィットモード切り替えボタン
        document.querySelectorAll('.fit-mode-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.fit-mode-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.editingImageFit = btn.getAttribute('data-fit');
                this.applyPhotoCropTransform();
            });
        });

        // プレビュー枠のインタラクティブ・ドラッグ＆スワイプ操作
        this.initCropViewportDrag();

        // 絵文字クイック選択
        document.querySelectorAll('.emoji-opt').forEach(opt => {
            opt.addEventListener('click', () => {
                document.querySelectorAll('.emoji-opt').forEach(o => o.classList.remove('selected'));
                opt.classList.add('selected');
                document.getElementById('edit-emoji').value = opt.innerText;
                this.editingImageUrl = null; // 絵文字を選んだら写真は解除
                this.updateModalPhotoPreview();
            });
        });

        // 外部オーディオファイルのインポート
        document.getElementById('import-file-btn').addEventListener('click', () => {
            document.getElementById('audio-file-input').click();
        });

        document.getElementById('audio-file-input').addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                this.handleFileImport(e.target.files[0]);
            }
        });
    }

    // プレビュー枠でのドラッグ＆タッチ操作（ポインターイベントで統一対応）
    initCropViewportDrag() {
        const viewport = document.getElementById('photo-crop-viewport');
        if (!viewport) return;

        let isDragging = false;
        let startX = 0;
        let startY = 0;
        let initialOffsetX = 0;
        let initialOffsetY = 0;

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

            // 枠のサイズに対する割合を計算してオフセットに加算
            const rect = viewport.getBoundingClientRect();
            const percentX = (dx / rect.width) * 100;
            const percentY = (dy / rect.height) * 100;

            this.editingImageOffsetX = initialOffsetX + percentX;
            this.editingImageOffsetY = initialOffsetY + percentY;

            this.applyPhotoCropTransform();
        };

        const onPointerUp = (e) => {
            isDragging = false;
        };

        viewport.addEventListener('pointerdown', onPointerDown);
        viewport.addEventListener('pointermove', onPointerMove);
        viewport.addEventListener('pointerup', onPointerUp);
        viewport.addEventListener('pointercancel', onPointerUp);
    }

    // プレビュー枠内のトランスフォーム適用
    applyPhotoCropTransform() {
        const cropImg = document.getElementById('photo-crop-img');
        if (cropImg) {
            cropImg.style.transform = `scale(${this.editingImageScale}) translate(${this.editingImageOffsetX}%, ${this.editingImageOffsetY}%)`;
            cropImg.style.objectFit = this.editingImageFit;
        }
    }

    // 画像ファイル読み込み ＆ 高精細リサイズ
    async handlePhotoUpload(file) {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    const maxDim = 800; // 高精細 800px 基準
                    let w = img.width;
                    let h = img.height;

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

    // モーダル内の写真プレビュー＆コントロール更新
    updateModalPhotoPreview() {
        const adjustBox = document.getElementById('photo-adjust-box');
        const removePhotoBtn = document.getElementById('remove-photo-btn');
        const cropImg = document.getElementById('photo-crop-img');
        const zoomSlider = document.getElementById('photo-zoom-slider');

        if (this.editingImageUrl) {
            if (adjustBox) adjustBox.style.display = 'flex';
            if (removePhotoBtn) removePhotoBtn.style.display = 'block';
            if (cropImg) {
                cropImg.src = this.editingImageUrl;
                this.applyPhotoCropTransform();
            }
            if (zoomSlider) {
                zoomSlider.value = Math.round(this.editingImageScale * 100);
                document.getElementById('photo-zoom-val').innerText = `${zoomSlider.value}%`;
            }
            document.querySelectorAll('.fit-mode-btn').forEach(btn => {
                if (btn.getAttribute('data-fit') === this.editingImageFit) btn.classList.add('active');
                else btn.classList.remove('active');
            });
            document.querySelectorAll('.emoji-opt').forEach(opt => opt.classList.remove('selected'));
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

    // --- 編集モーダル制御 ---
    openEditModal(slotId) {
        this.editingSlotId = slotId;
        const slot = this.slots.find(s => s.id === slotId);
        if (!slot) return;

        document.getElementById('modal-slot-num').innerText = slot.id;
        document.getElementById('edit-label').value = slot.label;
        document.getElementById('edit-emoji').value = slot.emoji;
        this.editingImageUrl = slot.imageUrl || null;
        this.editingImageScale = slot.imageScale !== undefined ? slot.imageScale : 1.0;
        this.editingImageOffsetX = slot.imageOffsetX !== undefined ? slot.imageOffsetX : 0;
        this.editingImageOffsetY = slot.imageOffsetY !== undefined ? slot.imageOffsetY : 0;
        this.editingImageFit = slot.imageFit || 'cover';

        // 名前位置ボタンの選択反映
        const currentPos = slot.labelPosition || 'bottom';
        document.getElementById('edit-label-pos').value = currentPos;
        document.querySelectorAll('.pos-btn').forEach(btn => {
            if (btn.getAttribute('data-pos') === currentPos) btn.classList.add('active');
            else btn.classList.remove('active');
        });

        document.querySelectorAll('.emoji-opt').forEach(opt => {
            if (!this.editingImageUrl && opt.innerText === slot.emoji) opt.classList.add('selected');
            else opt.classList.remove('selected');
        });

        this.updateModalPhotoPreview();

        const deleteBtn = document.getElementById('delete-audio-btn');
        const downloadBtn = document.getElementById('download-audio-btn');
        if (slot.audioBlob) {
            deleteBtn.style.display = 'block';
            downloadBtn.style.display = 'block';
        } else {
            deleteBtn.style.display = 'none';
            downloadBtn.style.display = 'none';
        }

        document.getElementById('modal-backdrop').classList.add('open');
    }

    closeEditModal() {
        document.getElementById('modal-backdrop').classList.remove('open');
        this.editingSlotId = null;
    }

    async saveEditModal() {
        if (this.editingSlotId === null) return;
        const slot = this.slots.find(s => s.id === this.editingSlotId);
        if (slot) {
            const labelInput = document.getElementById('edit-label').value.trim();
            const emojiInput = document.getElementById('edit-emoji').value.trim();
            const labelPos = document.getElementById('edit-label-pos').value || 'bottom';

            slot.label = labelInput || `ボタン ${slot.id}`;
            slot.labelPosition = labelPos;
            slot.emoji = emojiInput || '🔊';
            slot.imageUrl = this.editingImageUrl;
            slot.imageScale = this.editingImageScale;
            slot.imageOffsetX = this.editingImageOffsetX;
            slot.imageOffsetY = this.editingImageOffsetY;
            slot.imageFit = this.editingImageFit;

            await this.storage.saveSlot(slot);
            this.renderSlots();
        }
        this.closeEditModal();
    }

    async deleteSlotAudio() {
        if (this.editingSlotId === null) return;
        if (confirm('このボタンの録音音声を削除しますか？')) {
            const slot = this.slots.find(s => s.id === this.editingSlotId);
            if (slot) {
                this.stopSlot(slot.id);
                slot.audioBlob = null;
                slot.duration = 0;
                await this.storage.saveSlot(slot);
                this.renderSlots();
            }
            this.closeEditModal();
        }
    }

    downloadSlotAudio() {
        if (this.editingSlotId === null) return;
        const slot = this.slots.find(s => s.id === this.editingSlotId);
        if (slot && slot.audioBlob) {
            const url = URL.createObjectURL(slot.audioBlob);
            const a = document.createElement('a');
            a.href = url;
            const ext = slot.audioBlob.type.includes('mp4') ? 'm4a' : 'webm';
            a.download = `${slot.label || `voice_slot_${slot.id}`}.${ext}`;
            a.click();
            URL.revokeObjectURL(url);
        }
    }

    async handleFileImport(file) {
        if (this.editingSlotId === null) return;
        const slot = this.slots.find(s => s.id === this.editingSlotId);
        if (slot) {
            slot.audioBlob = file;
            slot.duration = 3.0;
            await this.storage.saveSlot(slot);
            this.renderSlots();
            this.closeEditModal();
            alert(`「${file.name}」をボタン ${slot.id} にセットしました！`);
        }
    }
}

// 起動初期化
window.addEventListener('DOMContentLoaded', () => {
    window.app = new VoicePadApp();
});
