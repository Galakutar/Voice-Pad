/**
 * Voice Pad 6 - 音声録音＆サンプラー アプリケーションロジック
 * iOS Safari / iPadOS / 各種モダンブラウザ対応
 */

// --- IndexedDB ストレージマネージャー ---
class StorageManager {
    constructor() {
        this.dbName = 'VoicePad6DB';
        this.dbVersion = 1;
        this.db = null;
    }

    async init() {
        return new Promise((resolve, reject) => {
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
                resolve(); // エラー時も動作継続
            };
        });
    }

    async saveSlot(slotData) {
        if (!this.db) return;
        return new Promise((resolve) => {
            const tx = this.db.transaction('slots', 'readwrite');
            const store = tx.objectStore('slots');
            store.put(slotData);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        });
    }

    async getSlot(id) {
        if (!this.db) return null;
        return new Promise((resolve) => {
            const tx = this.db.transaction('slots', 'readonly');
            const store = tx.objectStore('slots');
            const req = store.get(id);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
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

    async deleteSlot(id) {
        if (!this.db) return;
        return new Promise((resolve) => {
            const tx = this.db.transaction('slots', 'readwrite');
            const store = tx.objectStore('slots');
            store.delete(id);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
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
        
        this.recordingSlot = null;
        this.recordedChunks = [];
        this.recTimer = null;
        this.recSeconds = 0;

        this.currentEffect = 'normal'; // normal, high, low, robot, echo
        this.analyser = null;

        // 6つのスロットの初期データ定義
        this.slots = [
            { id: 1, label: 'ボタン 1', emoji: '🔴', audioBlob: null, duration: 0, loop: false },
            { id: 2, label: 'ボタン 2', emoji: '🟠', audioBlob: null, duration: 0, loop: false },
            { id: 3, label: 'ボタン 3', emoji: '🟡', audioBlob: null, duration: 0, loop: false },
            { id: 4, label: 'ボタン 4', emoji: '🟢', audioBlob: null, duration: 0, loop: false },
            { id: 5, label: 'ボタン 5', emoji: '🔵', audioBlob: null, duration: 0, loop: false },
            { id: 6, label: 'ボタン 6', emoji: '🟣', audioBlob: null, duration: 0, loop: false }
        ];

        // 再生中のオーディオソース管理 (slotId -> { source, gain, loop })
        this.activeSources = new Map();

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

    // AudioContext の初期化 (iOS対応: ユーザー操作でアンロック)
    ensureAudioContext() {
        if (!this.audioCtx) {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            this.audioCtx = new AudioContextClass();
        }
        if (this.audioCtx.state === 'suspended') {
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
            const durationText = hasAudio ? `${slot.duration.toFixed(1)}s` : '未録音';

            card.innerHTML = `
                <div class="pad-header">
                    <span class="slot-badge">PAD ${slot.id}</span>
                    <button class="pad-settings-btn" title="設定・名前変更" data-slot="${slot.id}">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="12" cy="12" r="3"></circle>
                            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                        </svg>
                    </button>
                </div>

                <div class="pad-center" data-slot="${slot.id}">
                    <div class="pad-emoji">${slot.emoji}</div>
                    <div class="pad-label">${slot.label}</div>
                    <div class="pad-status">${durationText}</div>
                </div>

                <div class="pad-footer">
                    <button class="rec-btn" data-slot="${slot.id}" title="録音開始/停止">
                        <span class="rec-dot"></span>
                        <span class="rec-text">録音</span>
                    </button>
                    <button class="loop-toggle-btn ${slot.loop ? 'active' : ''}" data-slot="${slot.id}" title="ループ再生切り替え">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M17 1l4 4-4 4"></path>
                            <path d="M3 11V9a4 4 0 0 1 4-4h14"></path>
                            <path d="M7 23l-4-4 4-4"></path>
                            <path d="M21 13v2a4 4 0 0 1-4 4H3"></path>
                        </svg>
                    </button>
                </div>

                <canvas class="wave-canvas" id="canvas-${slot.id}"></canvas>
            `;

            grid.appendChild(card);
        });
    }

    // イベントリスナー設定
    initEvents() {
        const grid = document.getElementById('pad-grid');

        // パッドクリックイベント
        grid.addEventListener('click', (e) => {
            const settingsBtn = e.target.closest('.pad-settings-btn');
            const recBtn = e.target.closest('.rec-btn');
            const loopBtn = e.target.closest('.loop-toggle-btn');
            const centerArea = e.target.closest('.pad-center');
            const card = e.target.closest('.pad-card');

            if (settingsBtn) {
                e.stopPropagation();
                const slotId = parseInt(settingsBtn.getAttribute('data-slot'), 10);
                this.openEditModal(slotId);
            } else if (recBtn) {
                e.stopPropagation();
                const slotId = parseInt(recBtn.getAttribute('data-slot'), 10);
                this.toggleRecording(slotId);
            } else if (loopBtn) {
                e.stopPropagation();
                const slotId = parseInt(loopBtn.getAttribute('data-slot'), 10);
                this.toggleLoop(slotId);
            } else if (centerArea || card) {
                const target = centerArea || card;
                const slotId = parseInt(target.getAttribute('data-slot'), 10);
                this.playSlot(slotId);
            }
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

    // --- マイクストリーム取得（初回のみ許可を求め、以降は再利用） ---
    async getAudioStream() {
        // 既にアクティブなストリームがあれば再利用
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
            // 録音停止
            this.stopRecording();
        } else {
            // 他で録音中なら止める
            if (this.recordingSlot !== null) {
                this.stopRecording();
            }
            // 新規録音開始
            await this.startRecording(slotId);
        }
    }

    async startRecording(slotId) {
        this.ensureAudioContext();

        try {
            // 既存のマイクストリームを使い回すため、2回目以降は許可ポップアップが出ません
            await this.getAudioStream();
        } catch (err) {
            alert('マイクの使用が許可されていません。ブラウザの設定でマイクへのアクセスを「許可」してください。');
            return;
        }

        this.recordingSlot = slotId;
        this.recordedChunks = [];
        this.recSeconds = 0;

        // 最適なMIMEタイプの選定 (iOS Safari / Chrome / Firefox)
        let mimeType = 'audio/webm';
        if (MediaRecorder.isTypeSupported('audio/mp4')) {
            mimeType = 'audio/mp4'; // iOS Safari向け
        } else if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
            mimeType = 'audio/webm;codecs=opus';
        } else if (MediaRecorder.isTypeSupported('audio/aac')) {
            mimeType = 'audio/aac';
        }

        try {
            this.mediaRecorder = new MediaRecorder(this.audioStream, { mimeType });
        } catch (e) {
            this.mediaRecorder = new MediaRecorder(this.audioStream);
        }

        this.mediaRecorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) {
                this.recordedChunks.push(e.data);
            }
        };

        this.mediaRecorder.onstop = async () => {
            const blob = new Blob(this.recordedChunks, { type: this.mediaRecorder.mimeType || 'audio/webm' });
            await this.saveRecordedAudio(this.recordingSlot, blob, this.recSeconds);
            this.cleanupRecording();
        };

        this.mediaRecorder.start(100);

        // UIを録音中状態に
        const card = document.getElementById(`pad-${slotId}`);
        if (card) {
            card.classList.add('recording');
            const recBtn = card.querySelector('.rec-btn');
            recBtn.querySelector('.rec-text').innerText = '停止 (0s)';
        }

        // タイマー開始
        this.recTimer = setInterval(() => {
            this.recSeconds += 0.5;
            if (card) {
                const recBtn = card.querySelector('.rec-btn');
                recBtn.querySelector('.rec-text').innerText = `停止 (${this.recSeconds.toFixed(0)}s)`;
            }
            if (this.recSeconds >= 60) { // 最大60秒
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
        // マイクストリームは閉じずに保持（次回録音時に許可ダイアログを再表示させないため）
        this.recordingSlot = null;
    }

    // --- 音声再生制御 (Web Audio API & ボイスエフェクト) ---
    async playSlot(slotId) {
        this.ensureAudioContext();

        const slot = this.slots.find(s => s.id === slotId);
        if (!slot || !slot.audioBlob) {
            // 未録音の場合は即座に録音を開始
            this.startRecording(slotId);
            return;
        }

        // 既に再生中なら一度停止
        if (this.activeSources.has(slotId)) {
            this.stopSlot(slotId);
            if (!slot.loop) return; // 単発再生の場合はトグル停止
        }

        try {
            const arrayBuffer = await slot.audioBlob.arrayBuffer();
            const audioBuffer = await this.audioCtx.decodeAudioData(arrayBuffer);

            const source = this.audioCtx.createBufferSource();
            source.buffer = audioBuffer;
            source.loop = slot.loop;

            // ボイスエフェクトの適用
            const gainNode = this.audioCtx.createGain();
            let lastNode = source;

            if (this.currentEffect === 'high') {
                // 高音（ヘリウム声）
                source.playbackRate.value = 1.35;
            } else if (this.currentEffect === 'low') {
                // 低音（巨人・モンスター）
                source.playbackRate.value = 0.75;
            } else if (this.currentEffect === 'robot') {
                // ロボット声 (バンドパスフィルター + 変調)
                const filter = this.audioCtx.createBiquadFilter();
                filter.type = 'bandpass';
                filter.frequency.value = 1000;
                filter.Q.value = 5.0;
                lastNode.connect(filter);
                lastNode = filter;
            } else if (this.currentEffect === 'echo') {
                // エコー効果
                const delay = this.audioCtx.createDelay();
                delay.delayTime.value = 0.25;
                const feedback = this.audioCtx.createGain();
                feedback.gain.value = 0.4;
                lastNode.connect(delay);
                delay.connect(feedback);
                feedback.connect(delay);
                delay.connect(gainNode);
            }

            lastNode.connect(gainNode);
            gainNode.connect(this.audioCtx.destination);

            source.start(0);

            // UIを再生中表示
            const card = document.getElementById(`pad-${slotId}`);
            if (card) card.classList.add('playing');

            this.activeSources.set(slotId, { source, gainNode, loop: slot.loop });

            source.onended = () => {
                if (!slot.loop) {
                    this.stopSlot(slotId);
                }
            };

        } catch (err) {
            console.error('Audio playback error:', err);
        }
    }

    stopSlot(slotId) {
        if (this.activeSources.has(slotId)) {
            const { source } = this.activeSources.get(slotId);
            try {
                source.stop();
                source.disconnect();
            } catch (e) {}
            this.activeSources.delete(slotId);
        }

        const card = document.getElementById(`pad-${slotId}`);
        if (card) card.classList.remove('playing');
    }

    stopAll() {
        for (const slotId of this.activeSources.keys()) {
            this.stopSlot(slotId);
        }
    }

    async toggleLoop(slotId) {
        const slot = this.slots.find(s => s.id === slotId);
        if (slot) {
            slot.loop = !slot.loop;
            await this.storage.saveSlot(slot);

            const card = document.getElementById(`pad-${slotId}`);
            if (card) {
                const loopBtn = card.querySelector('.loop-toggle-btn');
                if (slot.loop) loopBtn.classList.add('active');
                else loopBtn.classList.remove('active');
            }

            // 再生中ならループプロパティをリアルタイム反映
            if (this.activeSources.has(slotId)) {
                this.activeSources.get(slotId).source.loop = slot.loop;
            }
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

                if (this.activeSources.has(slot.id) || this.recordingSlot === slot.id) {
                    // アニメーション波形描画
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
            deleteBtn.style.display = 'flex';
            downloadBtn.style.display = 'flex';
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
            a.download = `${slot.label || `voice_slot_${slot.id}`}.webm`;
            a.click();
            URL.revokeObjectURL(url);
        }
    }

    async handleFileImport(file) {
        if (this.editingSlotId === null) return;
        const slot = this.slots.find(s => s.id === this.editingSlotId);
        if (slot) {
            slot.audioBlob = file;
            slot.duration = 3.0; // 概算
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
