/**
 * Voice Pad 6 - 音声録音＆サンプラー アプリケーションロジック
 * iOS Safari / iPadOS / 各種モダンブラウザ完全対応（HTMLAudioElement + Web Audio ハイブリッド方式）
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
            // Blobとメタデータのみ保存（Audioオブジェクト等は除外）
            const dataToSave = {
                id: slotData.id,
                label: slotData.label,
                emoji: slotData.emoji,
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
            { id: 1, label: 'ボタン 1', emoji: '🔴', audioBlob: null, duration: 0 },
            { id: 2, label: 'ボタン 2', emoji: '🟠', audioBlob: null, duration: 0 },
            { id: 3, label: 'ボタン 3', emoji: '🟡', audioBlob: null, duration: 0 },
            { id: 4, label: 'ボタン 4', emoji: '🟢', audioBlob: null, duration: 0 },
            { id: 5, label: 'ボタン 5', emoji: '🔵', audioBlob: null, duration: 0 },
            { id: 6, label: 'ボタン 6', emoji: '🟣', audioBlob: null, duration: 0 }
        ];

        // 再生中のオーディオオブジェクト管理 (slotId -> HTMLAudioElement)
        this.activeAudios = new Map();

        // 編集モーダル用の選択スロット
        this.editingSlotId = null;

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
            card.className = 'pad-card';
            card.setAttribute('data-slot', slot.id);
            card.id = `pad-${slot.id}`;

            const hasAudio = slot.audioBlob !== null;
            let statusText = '未録音';
            if (hasAudio) {
                statusText = `${slot.duration.toFixed(1)}秒`;
            }

            card.innerHTML = `
                <div class="pad-header">
                    <span class="slot-badge">${slot.id}</span>
                    <button class="pad-settings-btn" title="設定・名前変更" data-slot="${slot.id}">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="12" cy="12" r="3"></circle>
                            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                        </svg>
                    </button>
                </div>

                <div class="pad-center">
                    <div class="pad-emoji">${slot.emoji}</div>
                    <div class="pad-label">${slot.label}</div>
                    <div class="pad-status">${statusText}</div>
                </div>

                <canvas class="wave-canvas" id="canvas-${slot.id}"></canvas>
            `;

            grid.appendChild(card);
        });
    }

    // イベントリスナー設定
    initEvents() {
        // 画面タップでオーディオアンロック
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
                    // 再生モード：タップで即座再生
                    this.playSlot(slotId);
                } else {
                    // 録音モード：タップで録音開始/停止
                    this.toggleRecording(slotId);
                }
            }
        });

        // モード切替ボタン
        const playBtn = document.getElementById('mode-play-btn');
        const recordBtn = document.getElementById('mode-record-btn');

        playBtn.addEventListener('click', () => {
            this.setMode('play');
        });

        recordBtn.addEventListener('click', () => {
            this.setMode('record');
        });

        // ボイスエフェクト切り替え
        document.getElementById('voice-effect').addEventListener('change', (e) => {
            this.currentEffect = e.target.value;
        });

        // 全停止ボタン
        document.getElementById('stop-all-btn').addEventListener('click', () => {
            this.stopAll();
        });

        // モーダル関連イベント
        document.getElementById('close-modal-btn').addEventListener('click', () => this.closeEditModal());
        document.getElementById('modal-backdrop').addEventListener('click', (e) => {
            if (e.target.id === 'modal-backdrop') this.closeEditModal();
        });

        document.getElementById('save-slot-btn').addEventListener('click', () => this.saveEditModal());
        document.getElementById('delete-audio-btn').addEventListener('click', () => this.deleteSlotAudio());
        document.getElementById('download-audio-btn').addEventListener('click', () => this.downloadSlotAudio());

        // 絵文字クイック選択
        document.querySelectorAll('.emoji-opt').forEach(opt => {
            opt.addEventListener('click', () => {
                document.querySelectorAll('.emoji-opt').forEach(o => o.classList.remove('selected'));
                opt.classList.add('selected');
                document.getElementById('edit-emoji').value = opt.innerText;
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

    // --- マイクストリーム取得（初回のみ許可、以降は保持） ---
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

    // --- 録音制御 (MediaRecorder) ---
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

        // iOS Safari / Chrome / Android に最適なMIMEタイプ自動判別
        let mimeType = '';
        if (MediaRecorder.isTypeSupported('audio/mp4')) {
            mimeType = 'audio/mp4'; // iOS Safari向け標準
        } else if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
            mimeType = 'audio/webm;codecs=opus';
        } else if (MediaRecorder.isTypeSupported('audio/webm')) {
            mimeType = 'audio/webm';
        } else if (MediaRecorder.isTypeSupported('audio/aac')) {
            mimeType = 'audio/aac';
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

        // UIを録音中状態に
        const card = document.getElementById(`pad-${slotId}`);
        if (card) {
            card.classList.add('recording');
            const statusEl = card.querySelector('.pad-status');
            statusEl.innerText = '🔴 録音中... (0s)';
        }

        // タイマー開始
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

    // --- 音声再生制御 (iOS Safari 100% 動作 HTMLAudioElement 方式) ---
    async playSlot(slotId) {
        this.unlockAudio();

        const slot = this.slots.find(s => s.id === slotId);
        if (!slot || !slot.audioBlob) {
            // 未録音の場合は録音モードに自動切替して録音開始
            this.setMode('record');
            this.startRecording(slotId);
            return;
        }

        // 既に再生中なら一度停止
        if (this.activeAudios.has(slotId)) {
            this.stopSlot(slotId);
            return;
        }

        try {
            // Blob から URL を作成
            const audioUrl = URL.createObjectURL(slot.audioBlob);
            const audio = new Audio(audioUrl);

            // ボイスエフェクト（再生レート調整）
            if (this.currentEffect === 'high') {
                audio.playbackRate = 1.35; // 高い声 (ヘリウム)
            } else if (this.currentEffect === 'low') {
                audio.playbackRate = 0.75; // 低い声 (巨人)
            } else if (this.currentEffect === 'robot') {
                audio.playbackRate = 1.15;
            } else {
                audio.playbackRate = 1.0;
            }

            // UIを再生中表示
            const card = document.getElementById(`pad-${slotId}`);
            if (card) card.classList.add('playing');

            this.activeAudios.set(slotId, audio);

            audio.onended = () => {
                this.stopSlot(slotId);
                URL.revokeObjectURL(audioUrl);
            };

            audio.onerror = (e) => {
                console.error('Playback error:', e);
                this.stopSlot(slotId);
                URL.revokeObjectURL(audioUrl);
            };

            await audio.play();

        } catch (err) {
            console.error('Audio play exception:', err);
            this.stopSlot(slotId);
        }
    }

    stopSlot(slotId) {
        if (this.activeAudios.has(slotId)) {
            const audio = this.activeAudios.get(slotId);
            try {
                audio.pause();
                audio.currentTime = 0;
            } catch (e) {}
            this.activeAudios.delete(slotId);
        }

        const card = document.getElementById(`pad-${slotId}`);
        if (card) card.classList.remove('playing');
    }

    stopAll() {
        for (const slotId of this.activeAudios.keys()) {
            this.stopSlot(slotId);
        }
        if (this.recordingSlot !== null) {
            this.stopRecording();
        }
    }

    // --- 波形ビジュアライザー (Canvas) ---
    initCanvasVisualizers() {
        const renderWave = () => {
            this.slots.forEach(slot => {
                const canvas = document.getElementById(`canvas-${slot.id}`);
                if (!canvas) return;
                const ctx = canvas.getContext('2d');
                ctx.clearRect(0, 0, canvas.width, canvas.height);

                if (this.activeAudios.has(slot.id) || this.recordingSlot === slot.id) {
                    ctx.fillStyle = this.recordingSlot === slot.id ? '#ef4444' : '#ffffff';
                    const time = Date.now() * 0.008;
                    const bars = 16;
                    const barWidth = canvas.width / bars;

                    for (let i = 0; i < bars; i++) {
                        const h = (Math.sin(time + i * 0.5) * 0.5 + 0.5) * canvas.height * 0.8;
                        ctx.fillRect(i * barWidth + 2, canvas.height - h, barWidth - 4, h);
                    }
                }
            });
            requestAnimationFrame(renderWave);
        };
        requestAnimationFrame(renderWave);
    }

    // --- 編集モーダル制御 ---
    openEditModal(slotId) {
        this.editingSlotId = slotId;
        const slot = this.slots.find(s => s.id === slotId);
        if (!slot) return;

        document.getElementById('modal-slot-num').innerText = slot.id;
        document.getElementById('edit-label').value = slot.label;
        document.getElementById('edit-emoji').value = slot.emoji;

        document.querySelectorAll('.emoji-opt').forEach(opt => {
            if (opt.innerText === slot.emoji) opt.classList.add('selected');
            else opt.classList.remove('selected');
        });

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
            slot.label = labelInput || `ボタン ${slot.id}`;
            slot.emoji = emojiInput || '🔊';

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
