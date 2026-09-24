/**
 * Voice Pad - 音声録音＆タッチサンプラー
 * 完全ローカル完結・AudioContext自動復帰・スクロール管理・長押しドラッグ並び替え
 * 写真・ボイスチェンジャー・再生スピードの階層的個別設定＆完全エクスポート・インポート対応
 */

const APP_VERSION = '2026.09.25.0015';
window.APP_VERSION = APP_VERSION;

// ==================== 0.0 🌐 Blob URL ライフサイクル管理クラス（メモリリーク完全防止） ====================
class BlobUrlTracker {
    static activeUrls = new Map(); // url -> { category, createdAt }
    static categoryUrls = {
        playback: new Set(),
        preview: new Set(),
        download: new Set(),
        incoming: new Set(),
        general: new Set()
    };

    /**
     * Blob URL を生成し、カテゴリ別に登録して追跡
     * @param {Blob|File} blob
     * @param {'playback'|'preview'|'download'|'incoming'|'general'} category
     * @returns {string} url
     */
    static create(blob, category = 'general') {
        if (!blob) return '';
        try {
            const url = URL.createObjectURL(blob);
            this.activeUrls.set(url, { category, createdAt: Date.now() });
            if (!this.categoryUrls[category]) {
                this.categoryUrls[category] = new Set();
            }
            this.categoryUrls[category].add(url);
            return url;
        } catch (e) {
            console.warn('BlobUrlTracker create failed:', e);
            return '';
        }
    }

    /**
     * 特定の Blob URL を安全に解放
     * @param {string} url
     */
    static revoke(url) {
        if (!url || typeof url !== 'string') return;
        if (url.startsWith('blob:')) {
            try {
                URL.revokeObjectURL(url);
            } catch (e) {}
        }
        if (this.activeUrls.has(url)) {
            const info = this.activeUrls.get(url);
            if (info && info.category && this.categoryUrls[info.category]) {
                this.categoryUrls[info.category].delete(url);
            }
            this.activeUrls.delete(url);
        }
    }

    /**
     * 特定カテゴリに属する全 Blob URL を一括解放
     * @param {'playback'|'preview'|'download'|'incoming'|'general'} category
     */
    static revokeCategory(category) {
        const set = this.categoryUrls[category];
        if (set && set.size > 0) {
            for (const url of Array.from(set)) {
                this.revoke(url);
            }
            set.clear();
        }
    }

    /**
     * 全ての追跡中 Blob URL を一括解放
     */
    static revokeAll() {
        for (const url of Array.from(this.activeUrls.keys())) {
            this.revoke(url);
        }
        this.activeUrls.clear();
        for (const cat in this.categoryUrls) {
            this.categoryUrls[cat].clear();
        }
    }
}

// ==================== 0. 音声エンコード＆波形編集ユーティリティ ====================
class AudioUtils {
    /**
     * 高速・完全ローカルの 16-bit / 8-bit / 32-bit Float PCM WAV 直接パーサー
     * - ブラウザの decodeAudioData や WebKit コーデック制約に依存せず、確実に AudioBuffer を再構築
     */
    static decodeWavDirect(ctx, arrayBuffer) {
        if (!ctx || !arrayBuffer || arrayBuffer.byteLength < 44) return null;
        try {
            const view = new DataView(arrayBuffer);
            // Check RIFF header
            const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
            const wave = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
            if (riff !== 'RIFF' || wave !== 'WAVE') return null;

            let offset = 12;
            let format = 1;
            let numChannels = 1;
            let sampleRate = 44100;
            let bitsPerSample = 16;
            let dataOffset = -1;
            let dataLength = 0;

            while (offset < arrayBuffer.byteLength - 8) {
                const chunkId = String.fromCharCode(
                    view.getUint8(offset), view.getUint8(offset + 1),
                    view.getUint8(offset + 2), view.getUint8(offset + 3)
                );
                const chunkSize = view.getUint32(offset + 4, true);

                if (chunkId === 'fmt ') {
                    format = view.getUint16(offset + 8, true);
                    numChannels = view.getUint16(offset + 10, true);
                    sampleRate = view.getUint32(offset + 12, true);
                    bitsPerSample = view.getUint16(offset + 22, true);
                } else if (chunkId === 'data') {
                    dataOffset = offset + 8;
                    dataLength = chunkSize;
                    break;
                }
                offset += 8 + chunkSize;
            }

            if (dataOffset === -1 || (format !== 1 && format !== 3)) {
                return null;
            }

            const bytesPerSample = bitsPerSample / 8;
            const blockAlign = numChannels * bytesPerSample;
            if (blockAlign <= 0) return null;

            const numSamples = Math.floor(Math.min(dataLength, arrayBuffer.byteLength - dataOffset) / blockAlign);
            if (numSamples <= 0) return null;

            const audioBuffer = ctx.createBuffer(numChannels, numSamples, sampleRate);

            if (format === 1 && bitsPerSample === 16) {
                for (let ch = 0; ch < numChannels; ch++) {
                    const channelData = audioBuffer.getChannelData(ch);
                    let readOffset = dataOffset + ch * 2;
                    for (let i = 0; i < numSamples; i++) {
                        const sample = view.getInt16(readOffset, true);
                        channelData[i] = sample < 0 ? sample / 0x8000 : sample / 0x7FFF;
                        readOffset += blockAlign;
                    }
                }
                return audioBuffer;
            } else if (format === 1 && bitsPerSample === 8) {
                for (let ch = 0; ch < numChannels; ch++) {
                    const channelData = audioBuffer.getChannelData(ch);
                    let readOffset = dataOffset + ch;
                    for (let i = 0; i < numSamples; i++) {
                        const sample = view.getUint8(readOffset);
                        channelData[i] = (sample - 128) / 128;
                        readOffset += blockAlign;
                    }
                }
                return audioBuffer;
            } else if (format === 3 && bitsPerSample === 32) {
                for (let ch = 0; ch < numChannels; ch++) {
                    const channelData = audioBuffer.getChannelData(ch);
                    let readOffset = dataOffset + ch * 4;
                    for (let i = 0; i < numSamples; i++) {
                        channelData[i] = view.getFloat32(readOffset, true);
                        readOffset += blockAlign;
                    }
                }
                return audioBuffer;
            }
            return null;
        } catch (e) {
            console.warn('decodeWavDirect exception:', e);
            return null;
        }
    }

    /**
     * Safari / iOS 互換の安全な AudioContext.decodeAudioData
     * - WAV 形式は直接パーサーで瞬時にデコード（Safari WebKit の decodeAudioData デタッチ/遅延バグを完全回避）
     * - それ以外（MP3/AAC/M4A等）はネイティブ decodeAudioData で安全にデコード
     */
    static decodeAudioDataSafe(ctx, arrayBuffer) {
        return new Promise((resolve, reject) => {
            if (!ctx || !arrayBuffer || arrayBuffer.byteLength === 0) {
                reject(new Error('Invalid AudioContext or empty arrayBuffer'));
                return;
            }

            // ① WAV 形式の直接デコード（iOS Safari 互換性 100%）
            const directBuffer = AudioUtils.decodeWavDirect(ctx, arrayBuffer);
            if (directBuffer) {
                resolve(directBuffer);
                return;
            }

            // ② MP3 / AAC / M4A などのネイティブデコード
            const bufferCopy = arrayBuffer.slice(0);
            try {
                const res = ctx.decodeAudioData(
                    bufferCopy,
                    (decoded) => resolve(decoded),
                    (err) => reject(err || new Error('decodeAudioData failed'))
                );
                if (res && typeof res.then === 'function') {
                    res.then(resolve).catch(reject);
                }
            } catch (e) {
                reject(e);
            }
        });
    }

    /**
     * AudioBuffer を 16-bit PCM WAV Blob へ高速エンコード
     */
    static audioBufferToWav(buffer) {
        const numChannels = buffer.numberOfChannels;
        const sampleRate = buffer.sampleRate;
        const format = 1; // PCM
        const bitDepth = 16;
        
        const numSamples = buffer.length;
        const bytesPerSample = bitDepth / 8;
        const blockAlign = numChannels * bytesPerSample;
        const byteRate = sampleRate * blockAlign;
        const dataSize = numSamples * blockAlign;
        const headerSize = 44;
        const totalSize = headerSize + dataSize;
        
        const arrayBuffer = new ArrayBuffer(totalSize);
        const view = new DataView(arrayBuffer);
        
        function writeString(offset, string) {
            for (let i = 0; i < string.length; i++) {
                view.setUint8(offset + i, string.charCodeAt(i));
            }
        }
        
        writeString(0, 'RIFF');
        view.setUint32(4, 36 + dataSize, true);
        writeString(8, 'WAVE');
        writeString(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, format, true);
        view.setUint16(22, numChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, byteRate, true);
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, bitDepth, true);
        writeString(36, 'data');
        view.setUint32(40, dataSize, true);
        
        let offset = 44;
        for (let i = 0; i < numSamples; i++) {
            for (let ch = 0; ch < numChannels; ch++) {
                let sample = buffer.getChannelData(ch)[i];
                sample = Math.max(-1, Math.min(1, sample));
                const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
                view.setInt16(offset, intSample, true);
                offset += 2;
            }
        }
        
        return new Blob([arrayBuffer], { type: 'audio/wav' });
    }

    /**
     * 指定秒数範囲で AudioBuffer をスライス（トリミング）
     */
    static sliceAudioBuffer(ctx, buffer, startSec, endSec) {
        const sampleRate = buffer.sampleRate;
        const numChannels = buffer.numberOfChannels;
        const startSample = Math.max(0, Math.floor(startSec * sampleRate));
        const endSample = Math.min(buffer.length, Math.floor(endSec * sampleRate));
        const frameCount = Math.max(1, endSample - startSample);

        const slicedBuffer = ctx.createBuffer(numChannels, frameCount, sampleRate);
        for (let ch = 0; ch < numChannels; ch++) {
            const srcData = buffer.getChannelData(ch);
            const dstData = slicedBuffer.getChannelData(ch);
            for (let i = 0; i < frameCount; i++) {
                dstData[i] = srcData[startSample + i] || 0;
            }
        }
        return slicedBuffer;
    }

    /**
     * 音量ノーマライズ（ピークを0.98に最大化）
     */
    static normalizeAudioBuffer(buffer) {
        let maxPeak = 0;
        const numChannels = buffer.numberOfChannels;
        const length = buffer.length;

        for (let ch = 0; ch < numChannels; ch++) {
            const data = buffer.getChannelData(ch);
            for (let i = 0; i < length; i++) {
                const abs = Math.abs(data[i]);
                if (abs > maxPeak) maxPeak = abs;
            }
        }

        if (maxPeak > 0.001) {
            const gain = 0.98 / maxPeak;
            for (let ch = 0; ch < numChannels; ch++) {
                const data = buffer.getChannelData(ch);
                for (let i = 0; i < length; i++) {
                    data[i] *= gain;
                }
            }
        }
        return buffer;
    }

    /**
     * Web Audio API WaveShaper 用ソフトクリッピングカーブ生成（Math.tanh）
     */
    static getSoftClipCurve(samples = 4096) {
        if (!this._softClipCurve || this._softClipCurve.length !== samples) {
            const curve = new Float32Array(samples);
            for (let i = 0; i < samples; i++) {
                const x = (i * 2) / (samples - 1) - 1; // -1.0 〜 +1.0
                curve[i] = Math.tanh(x);
            }
            this._softClipCurve = curve;
        }
        return this._softClipCurve;
    }

    /**
     * 開始・終了に 0.05秒のリニアフェードを適用
     */
    static applyFade(buffer, fadeInSec = 0.05, fadeOutSec = 0.05) {
        const sampleRate = buffer.sampleRate;
        const numChannels = buffer.numberOfChannels;
        const length = buffer.length;
        const fadeInSamples = Math.min(Math.floor(fadeInSec * sampleRate), Math.floor(length / 2));
        const fadeOutSamples = Math.min(Math.floor(fadeOutSec * sampleRate), Math.floor(length / 2));

        for (let ch = 0; ch < numChannels; ch++) {
            const data = buffer.getChannelData(ch);
            for (let i = 0; i < fadeInSamples; i++) {
                data[i] *= (i / fadeInSamples);
            }
            for (let i = 0; i < fadeOutSamples; i++) {
                const idx = length - 1 - i;
                data[idx] *= (i / fadeOutSamples);
            }
        }
        return buffer;
    }
}

// ==================== 0.5 🎙️ Web Audio PCM 高精度レコーダー（iOS / iPadOS 100% 互換） ====================
class PcmAudioRecorder {
    constructor(audioCtx, stream) {
        this.ctx = audioCtx;
        this.stream = stream;
        this.source = null;
        this.processor = null;
        this.muteGain = null;
        this.buffers = [];
        this.totalSamples = 0;
        this.isRecording = false;
        this.sampleRate = this.ctx.sampleRate;
    }

    start() {
        this.buffers = [];
        this.totalSamples = 0;
        this.isRecording = true;

        this.source = this.ctx.createMediaStreamSource(this.stream);
        const bufferSize = 4096;
        if (this.ctx.createScriptProcessor) {
            this.processor = this.ctx.createScriptProcessor(bufferSize, 1, 1);
        } else if (this.ctx.createJavaScriptNode) {
            this.processor = this.ctx.createJavaScriptNode(bufferSize, 1, 1);
        }

        if (this.processor) {
            this.processor.onaudioprocess = (e) => {
                if (!this.isRecording) return;
                const inputData = e.inputBuffer.getChannelData(0);
                const copy = new Float32Array(inputData.length);
                copy.set(inputData);
                this.buffers.push(copy);
                this.totalSamples += copy.length;
            };

            this.source.connect(this.processor);
            this.muteGain = this.ctx.createGain();
            this.muteGain.gain.value = 0;
            this.processor.connect(this.muteGain);
            this.muteGain.connect(this.ctx.destination);
        }
    }

    stop() {
        this.isRecording = false;
        if (this.processor) {
            try {
                this.processor.disconnect();
                this.processor.onaudioprocess = null;
            } catch (e) {}
            this.processor = null;
        }
        if (this.source) {
            try {
                this.source.disconnect();
            } catch (e) {}
            this.source = null;
        }
        if (this.muteGain) {
            try {
                this.muteGain.disconnect();
            } catch (e) {}
            this.muteGain = null;
        }

        if (this.totalSamples === 0) {
            return null;
        }

        const finalBuffer = this.ctx.createBuffer(1, this.totalSamples, this.sampleRate);
        const channelData = finalBuffer.getChannelData(0);
        let offset = 0;
        for (const buf of this.buffers) {
            channelData.set(buf, offset);
            offset += buf.length;
        }

        const wavBlob = AudioUtils.audioBufferToWav(finalBuffer);
        return {
            buffer: finalBuffer,
            blob: wavBlob,
            duration: finalBuffer.duration
        };
    }
}

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
                const buffer = ctx.createBuffer(1, 1, 22050);
                const source = ctx.createBufferSource();
                source.buffer = buffer;
                source.connect(ctx.destination);
                source.onended = () => {
                    try { source.disconnect(); } catch (e) {}
                };
                source.start(0);

                // 📱 iOS / iPhone 向けメディアオーディオセッションの覚醒（マナーモード貫通＆スピーカー出力確保）
                const silentAudio = new Audio('data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=');
                silentAudio.volume = 0.01;
                const p = silentAudio.play();
                if (p !== undefined) {
                    p.then(() => {
                        silentAudio.pause();
                    }).catch(() => {});
                }

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

// ==================== 1.8 🌲 プロシージャル環境背景音 (Ambient Audio) エンジン ====================
class AmbientAudioEngine {
    /**
     * ctx, type, durationSec によるバッファ生成ヘルパー
     */
    static generateAmbientBuffer(ctx, type, durationSec) {
        if (!ctx || !type || type === 'none') return null;
        const sampleRate = ctx.sampleRate || 44100;
        return this.generateAmbientTrack(type, durationSec, sampleRate, ctx);
    }

    /**
     * サウンドタイプに応じたプロシージャル環境背景音の生成（完全ローカル・外部依存ゼロ）
     * @param {string} type - 'underwater'|'birds'|'forest'|'city'|'train'|'rain'|'cafe'|'cave_drip'|'cathedral'|'space'
     * @param {number} durationSec - 長さ（秒）
     * @param {number} sampleRate
     * @param {AudioContext} ctx
     */
    static generateAmbientTrack(type, durationSec, sampleRate, ctx) {
        if (!type || type === 'none') return null;
        const numSamples = Math.max(1, Math.floor(durationSec * sampleRate));
        const buffer = ctx ? ctx.createBuffer(1, numSamples, sampleRate) : null;
        if (!buffer) return null;
        const data = buffer.getChannelData(0);

        switch (type) {
            case 'underwater':
                this.synthesizeUnderwater(data, sampleRate, numSamples);
                break;
            case 'birds':
                this.synthesizeBirds(data, sampleRate, numSamples);
                break;
            case 'forest':
                this.synthesizeForest(data, sampleRate, numSamples);
                break;
            case 'city':
                this.synthesizeCity(data, sampleRate, numSamples);
                break;
            case 'train':
                this.synthesizeTrain(data, sampleRate, numSamples);
                break;
            case 'rain':
                this.synthesizeRain(data, sampleRate, numSamples);
                break;
            case 'cafe':
                this.synthesizeCafe(data, sampleRate, numSamples);
                break;
            case 'cave_drip':
                this.synthesizeCaveDrip(data, sampleRate, numSamples);
                break;
            case 'cathedral':
                this.synthesizeCathedral(data, sampleRate, numSamples);
                break;
            case 'space':
                this.synthesizeSpace(data, sampleRate, numSamples);
                break;
            default:
                break;
        }

        return buffer;
    }

    // 🫧 水の中: 深海のうねり低音 + ランダムな気泡のポコポコ音（FMサイン波＋周波数急上昇）
    static synthesizeUnderwater(data, sampleRate, numSamples) {
        let lp1 = 0, lp2 = 0;
        const dt = 1 / sampleRate;
        const alpha = (2 * Math.PI * 90 * dt) / (1 + 2 * Math.PI * 90 * dt);

        for (let i = 0; i < numSamples; i++) {
            const white = Math.random() * 2 - 1;
            lp1 += alpha * (white - lp1);
            lp2 += alpha * (lp1 - lp2);
            data[i] = lp2 * 0.45;
        }

        const bubbleCount = Math.max(2, Math.floor((numSamples / sampleRate) * 5.5));
        for (let b = 0; b < bubbleCount; b++) {
            const startIdx = Math.floor(Math.random() * (numSamples - sampleRate * 0.15));
            const bubbleLen = Math.floor(sampleRate * (0.04 + Math.random() * 0.08));
            const baseFreq = 320 + Math.random() * 550;
            const endFreq = baseFreq * (1.8 + Math.random() * 1.5);
            let phase = 0;

            for (let j = 0; j < bubbleLen && (startIdx + j) < numSamples; j++) {
                const progress = j / bubbleLen;
                const freq = baseFreq + (endFreq - baseFreq) * Math.pow(progress, 1.4);
                phase += (2 * Math.PI * freq) / sampleRate;
                const env = Math.sin(progress * Math.PI);
                const pop = Math.sin(phase) * env * 0.38;
                data[startIdx + j] += pop;
            }
        }
    }

    // 🐦 鳥の声: 穏やかな微風ノイズ + 複数の小鳥のさえずり（2.8kHz〜5.5kHz FMピッチスイープ＆トリル）
    static synthesizeBirds(data, sampleRate, numSamples) {
        let lp = 0;
        const dt = 1 / sampleRate;
        const alpha = (2 * Math.PI * 650 * dt) / (1 + 2 * Math.PI * 650 * dt);
        for (let i = 0; i < numSamples; i++) {
            const white = Math.random() * 2 - 1;
            lp += alpha * (white - lp);
            const breezeEnv = 0.04 + 0.03 * Math.sin((2 * Math.PI * 0.2 * i) / sampleRate);
            data[i] = lp * breezeEnv;
        }

        const birdCount = Math.max(2, Math.floor((numSamples / sampleRate) * 2.8));
        for (let b = 0; b < birdCount; b++) {
            const startIdx = Math.floor(Math.random() * (numSamples - sampleRate * 0.35));
            const chirpType = b % 3;
            const len = Math.floor(sampleRate * (0.18 + Math.random() * 0.15));
            let phase = 0;

            for (let j = 0; j < len && (startIdx + j) < numSamples; j++) {
                const t = j / sampleRate;
                let freq = 3200;
                let env = 0;

                if (chirpType === 0) {
                    freq = 4800 - 2000 * (j / len);
                    env = Math.sin((j / len) * Math.PI);
                } else if (chirpType === 1) {
                    freq = 3800 + 700 * Math.sin(2 * Math.PI * 32 * t);
                    env = Math.sin((j / len) * Math.PI);
                } else {
                    const u = (j / len) * 2 - 1;
                    freq = 3200 + 1600 * (u * u);
                    env = Math.sin((j / len) * Math.PI);
                }

                phase += (2 * Math.PI * freq) / sampleRate;
                const sample = Math.sin(phase) * env * 0.28;
                data[startIdx + j] += sample;
            }
        }
    }

    // 🌲 森の音: 木々のざわめき（2段階バンドパス変調） + 自然の風
    static synthesizeForest(data, sampleRate, numSamples) {
        let bp1 = 0, bp2 = 0;
        const dt = 1 / sampleRate;
        for (let i = 0; i < numSamples; i++) {
            const white = Math.random() * 2 - 1;
            const centerFreq = 800 + 400 * Math.sin((2 * Math.PI * 0.15 * i) / sampleRate) + 200 * Math.sin((2 * Math.PI * 0.4 * i) / sampleRate);
            const alpha = (2 * Math.PI * centerFreq * dt) / (1 + 2 * Math.PI * centerFreq * dt);
            bp1 += alpha * (white - bp1);
            bp2 += alpha * (bp1 - bp2);
            const gust = 0.08 + 0.06 * Math.sin((2 * Math.PI * 0.09 * i) / sampleRate);
            data[i] = (bp1 - bp2) * gust * 2.2;
        }
    }

    // 🏙️ 街の喧騒: 低周波の交通ノイズ (50-200Hz) + 通り過ぎる気配
    static synthesizeCity(data, sampleRate, numSamples) {
        let lp1 = 0, lp2 = 0;
        const dt = 1 / sampleRate;
        const alpha = (2 * Math.PI * 160 * dt) / (1 + 2 * Math.PI * 160 * dt);

        for (let i = 0; i < numSamples; i++) {
            const white = Math.random() * 2 - 1;
            lp1 += alpha * (white - lp1);
            lp2 += alpha * (lp1 - lp2);
            const carRumble = 0.12 + 0.08 * Math.sin((2 * Math.PI * 0.07 * i) / sampleRate);
            data[i] = lp2 * carRumble * 1.8;
        }
    }

    // 🚃 電車の中: ガタゴト線路音 (タ・タン・タ・タン周期パルス) + 110Hz モーター音
    static synthesizeTrain(data, sampleRate, numSamples) {
        const periodSec = 0.85;
        const periodSamples = Math.floor(sampleRate * periodSec);

        for (let i = 0; i < numSamples; i++) {
            const t = i / sampleRate;
            const motor = (0.035 * Math.sin(2 * Math.PI * 110 * t) + 0.015 * Math.sin(2 * Math.PI * 220 * t));
            const cycleSample = i % periodSamples;
            const cycleSec = cycleSample / sampleRate;

            let clatter = 0;
            const pulses = [0.0, 0.11, 0.35, 0.46];
            for (let p of pulses) {
                const diff = cycleSec - p;
                if (diff >= 0 && diff < 0.045) {
                    const env = Math.exp(-diff * 75);
                    const impact = (Math.random() * 2 - 1) * Math.sin(2 * Math.PI * 240 * diff) * env * 0.32;
                    clatter += impact;
                }
            }

            data[i] = motor + clatter;
        }
    }

    // 🌧️ 雨と雷: 密度の高い雨粒ノイズ (ピンクノイズ + 微細クリック) + 遠雷
    static synthesizeRain(data, sampleRate, numSamples) {
        let pink = 0;
        for (let i = 0; i < numSamples; i++) {
            const white = Math.random() * 2 - 1;
            pink = pink * 0.95 + white * 0.05;
            const drop = (Math.random() > 0.985) ? (Math.random() * 2 - 1) * 0.09 : 0;
            data[i] = pink * 0.22 + drop;
        }
    }

    // ☕ カフェ: 店内の心地よいざわめき + カップやスプーンが触れ合う高音のチンという響き
    static synthesizeCafe(data, sampleRate, numSamples) {
        let lp = 0;
        const dt = 1 / sampleRate;
        const alpha = (2 * Math.PI * 450 * dt) / (1 + 2 * Math.PI * 450 * dt);

        for (let i = 0; i < numSamples; i++) {
            const white = Math.random() * 2 - 1;
            lp += alpha * (white - lp);
            const murmur = 0.08 + 0.04 * Math.sin((2 * Math.PI * 0.3 * i) / sampleRate);
            data[i] = lp * murmur * 1.5;
        }

        const clinkCount = Math.max(1, Math.floor((numSamples / sampleRate) * 1.8));
        for (let c = 0; c < clinkCount; c++) {
            const startIdx = Math.floor(Math.random() * (numSamples - sampleRate * 0.1));
            const clinkLen = Math.floor(sampleRate * 0.07);
            const freq = 3400 + Math.random() * 1200;

            for (let j = 0; j < clinkLen && (startIdx + j) < numSamples; j++) {
                const t = j / sampleRate;
                const env = Math.exp(-t * 50);
                const ping = Math.sin(2 * Math.PI * freq * t) * env * 0.22;
                data[startIdx + j] += ping;
            }
        }
    }

    // ⛰️ 洞窟の滴: 低周波の空間共鳴 + 水滴が水面にポチャンと落ちる音
    static synthesizeCaveDrip(data, sampleRate, numSamples) {
        for (let i = 0; i < numSamples; i++) {
            const t = i / sampleRate;
            const caveHum = 0.03 * Math.sin(2 * Math.PI * 58 * t) + 0.015 * Math.sin(2 * Math.PI * 116 * t);
            data[i] = caveHum;
        }

        const dripCount = Math.max(1, Math.floor((numSamples / sampleRate) * 2.2));
        for (let d = 0; d < dripCount; d++) {
            const startIdx = Math.floor(Math.random() * (numSamples - sampleRate * 0.2));
            const dripLen = Math.floor(sampleRate * 0.12);
            let phase = 0;

            for (let j = 0; j < dripLen && (startIdx + j) < numSamples; j++) {
                const t = j / sampleRate;
                const freq = 850 + 750 * Math.exp(-t * 40);
                phase += (2 * Math.PI * freq) / sampleRate;
                const env = Math.exp(-t * 22);
                const drip = Math.sin(phase) * env * 0.36;
                data[startIdx + j] += drip;
            }
        }
    }

    // ⛪ 大聖堂のドローン: 荘厳な聖歌・パイプオルガン風コード和音ドローン (Cmaj)
    static synthesizeCathedral(data, sampleRate, numSamples) {
        for (let i = 0; i < numSamples; i++) {
            const t = i / sampleRate;
            const slowTremolo = 0.85 + 0.15 * Math.sin(2 * Math.PI * 0.25 * t);
            const chord = (
                0.045 * Math.sin(2 * Math.PI * 130.81 * t) +
                0.035 * Math.sin(2 * Math.PI * 196.00 * t) +
                0.030 * Math.sin(2 * Math.PI * 261.63 * t) +
                0.020 * Math.sin(2 * Math.PI * 329.63 * t)
            ) * slowTremolo;
            data[i] = chord;
        }
    }

    // 🌌 宇宙: 低周波サブベース (45Hz + 67Hz) + フランジャー風の周波数スイープ
    static synthesizeSpace(data, sampleRate, numSamples) {
        for (let i = 0; i < numSamples; i++) {
            const t = i / sampleRate;
            const sweep = 0.03 * Math.sin((2 * Math.PI * (50 + 20 * Math.sin(2 * Math.PI * 0.1 * t)) * t));
            const sub = 0.04 * Math.sin(2 * Math.PI * 45 * t);
            data[i] = (sub + sweep) * 1.5;
        }
    }
}

// ==================== 2. 完全クライアントサイド 2ステージ直列音声DSPエンジン ====================
class VoiceEngine {
    /**
     * 声質デフォルトパラメータ（中身）
     */
    static defaultVoiceParams() {
        return {
            pitchSemitones: 0,   // -12 〜 +12 半音 (速度不変)
            formantRatio: 1.0,   // 0.35x (極太/巨漢/モンスター) 〜 2.0x (妖精/子ども)
            roughness: 0         // 0% 〜 100% (倍音サチュレーション＋息ノイズ)
        };
    }

    /**
     * 環境デフォルトパラメータ（外側）
     */
    static defaultEnvParams() {
        return {
            reverb: 0,           // 0% 〜 100% (残響・やまびこエコーの深さ)
            filter: 0,           // 0% 〜 100% (こもり・電話・ラジオ・メガホン)
            modulation: 0,       // 0% 〜 100% (ロボット・宇宙人・リングモジュレーション)
            ambientSound: 'none',// 'none'|'underwater'|'birds'|'forest'|'city'|'train'|'rain'|'cafe'|'cave_drip'|'cathedral'|'space'
            ambientVolume: 35    // 0% 〜 100% (背景環境音の音量)
        };
    }

    /**
     * プリセット名から新パラメータへの変換（後方互換性＆クイック選択）
     */
    static presetToParams(presetName) {
        const voicePresets = {
            'normal': { pitchSemitones: 0, formantRatio: 1.0, roughness: 0 },
            'helium': { pitchSemitones: 9, formantRatio: 1.55, roughness: 0 },
            'baby': { pitchSemitones: 7, formantRatio: 1.5, roughness: 5 },
            'girl': { pitchSemitones: 4, formantRatio: 1.35, roughness: 5 },
            'boy': { pitchSemitones: 2, formantRatio: 1.15, roughness: 0 },
            'man': { pitchSemitones: -3, formantRatio: 0.72, roughness: 20 },
            'woman': { pitchSemitones: 3, formantRatio: 1.2, roughness: 10 },
            'old_man': { pitchSemitones: -4, formantRatio: 0.75, roughness: 55 },
            'old_woman': { pitchSemitones: 3, formantRatio: 1.12, roughness: 45 },
            'monster': { pitchSemitones: -8, formantRatio: 0.45, roughness: 75 }
        };

        const envPresets = {
            'none': { reverb: 0, filter: 0, modulation: 0, ambientSound: 'none', ambientVolume: 0 },
            'cathedral': { reverb: 95, filter: 0, modulation: 0, ambientSound: 'cathedral', ambientVolume: 40 },
            'cave': { reverb: 85, filter: 20, modulation: 0, ambientSound: 'cave_drip', ambientVolume: 45 },
            'bath': { reverb: 55, filter: 0, modulation: 0, ambientSound: 'none', ambientVolume: 0 },
            'hall': { reverb: 70, filter: 0, modulation: 0, ambientSound: 'none', ambientVolume: 0 },
            'underwater': { reverb: 40, filter: 48, modulation: 0, ambientSound: 'underwater', ambientVolume: 50 },
            'forest': { reverb: 25, filter: 5, modulation: 0, ambientSound: 'forest', ambientVolume: 45 },
            'birds': { reverb: 20, filter: 0, modulation: 0, ambientSound: 'birds', ambientVolume: 45 },
            'city': { reverb: 15, filter: 10, modulation: 0, ambientSound: 'city', ambientVolume: 40 },
            'train': { reverb: 20, filter: 25, modulation: 0, ambientSound: 'train', ambientVolume: 45 },
            'rain': { reverb: 35, filter: 15, modulation: 0, ambientSound: 'rain', ambientVolume: 45 },
            'cafe': { reverb: 25, filter: 10, modulation: 0, ambientSound: 'cafe', ambientVolume: 40 },
            'space': { reverb: 60, filter: 20, modulation: 50, ambientSound: 'space', ambientVolume: 45 },
            'telephone': { reverb: 0, filter: 85, modulation: 0, ambientSound: 'none', ambientVolume: 0 },
            'radio': { reverb: 0, filter: 68, modulation: 15, ambientSound: 'none', ambientVolume: 0 },
            'megaphone': { reverb: 5, filter: 95, modulation: 0, ambientSound: 'none', ambientVolume: 0 },
            'robot': { reverb: 10, filter: 0, modulation: 80, ambientSound: 'none', ambientVolume: 0 },
            'alien': { reverb: 45, filter: 15, modulation: 60, ambientSound: 'none', ambientVolume: 0 }
        };

        if (voicePresets[presetName]) {
            return { voice: { ...voicePresets[presetName] }, env: { ...envPresets.none } };
        }
        if (envPresets[presetName]) {
            return { voice: { ...voicePresets.normal }, env: { ...envPresets[presetName] } };
        }
        return { voice: { ...voicePresets.normal }, env: { ...envPresets.none } };
    }

    /**
     * 【ステージ1】声質パラメータ処理（ピッチシフト・フォルマントシフト・ざらつき）
     */
    static processVoiceStage(buffer, voiceParams, ctx) {
        if (!buffer || !ctx) return buffer;
        const params = { ...this.defaultVoiceParams(), ...(voiceParams || {}) };

        const pitchRatio = Math.pow(2, (params.pitchSemitones || 0) / 12);
        const formantRatio = Math.max(0.35, Math.min(2.2, params.formantRatio || 1.0));
        const roughness = Math.max(0, Math.min(100, params.roughness || 0));

        // パラメータ変更がない場合はそのまま返す
        if (params.pitchSemitones === 0 && Math.abs(formantRatio - 1.0) < 0.02 && roughness === 0) {
            return buffer;
        }

        let workingBuffer = buffer;

        // 1. フォルマントシフト（再生速度を100%厳密に保持）
        if (Math.abs(formantRatio - 1.0) >= 0.02) {
            workingBuffer = this.applyFormantShift(workingBuffer, formantRatio, ctx);
        }

        // 2. ピッチシフト（再生速度を100%厳密に保持）
        if (Math.abs(pitchRatio - 1.0) >= 0.005) {
            workingBuffer = this.applyGranularPitchShift(workingBuffer, pitchRatio, ctx);
        }

        // 3. 質感・ざらつき（サブハーモニクス＋ハスキーバンドパスノイズ＋多段サチュレーション）
        if (roughness > 0) {
            workingBuffer = this.applyRoughness(workingBuffer, roughness, ctx);
        }

        return workingBuffer;
    }

    /**
     * 高品質 OLA (Overlap-Add) タイムストレッチ
     * 音程（ピッチ）を変えずに、再生時間・サンプル数を targetLength に正確に伸縮
     */
    static timeStretch(buffer, targetLength, ctx) {
        if (!buffer || !ctx) return buffer;
        const numChannels = buffer.numberOfChannels;
        const sampleRate = buffer.sampleRate;
        const srcLength = buffer.length;
        if (srcLength <= 0 || targetLength <= 0) return buffer;
        if (srcLength === targetLength) return buffer;

        const outputBuffer = ctx.createBuffer(numChannels, targetLength, sampleRate);
        const stretchRatio = targetLength / srcLength;

        // 最適グレイン長: 約35ms〜40ms（声の自然なフォルマントを維持）
        const grainSize = Math.min(Math.floor(sampleRate * 0.038), Math.floor(srcLength / 2));
        if (grainSize <= 4) return buffer;
        const hopOut = Math.floor(grainSize / 2);
        const hopIn = Math.max(1, hopOut / stretchRatio);

        // Hann 窓テーブル
        const windowTable = new Float32Array(grainSize);
        for (let i = 0; i < grainSize; i++) {
            windowTable[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (grainSize - 1)));
        }

        // 正規化用オーバーラップ加算ウェイトテーブル
        const weightTable = new Float32Array(targetLength);

        for (let ch = 0; ch < numChannels; ch++) {
            const src = buffer.getChannelData(ch);
            const dst = outputBuffer.getChannelData(ch);

            let inPosFloat = 0;
            let outPos = 0;

            while (outPos + grainSize <= targetLength && inPosFloat + grainSize <= srcLength) {
                const inPosInt = Math.floor(inPosFloat);
                for (let i = 0; i < grainSize; i++) {
                    const srcIdx = inPosInt + i;
                    const oIdx = outPos + i;
                    if (srcIdx < srcLength && oIdx < targetLength) {
                        dst[oIdx] += src[srcIdx] * windowTable[i];
                        if (ch === 0) {
                            weightTable[oIdx] += windowTable[i];
                        }
                    }
                }
                inPosFloat += hopIn;
                outPos += hopOut;
            }

            // オーバーラップ正規化（振幅の平滑化）
            for (let i = 0; i < targetLength; i++) {
                if (weightTable[i] > 0.001) {
                    dst[i] /= weightTable[i];
                }
            }
        }
        return outputBuffer;
    }

    /**
     * 高精度ピッチシフター（リサンプリング＋OLAタイムストレッチにより長さ・速度を完全維持）
     */
    static applyGranularPitchShift(buffer, pitchRatio, ctx) {
        if (!buffer || !ctx || Math.abs(pitchRatio - 1.0) < 0.005) return buffer;
        const numChannels = buffer.numberOfChannels;
        const sampleRate = buffer.sampleRate;
        const origLength = buffer.length;

        // 1. リサンプリングで音程を変更（長さは 1 / pitchRatio 倍になる）
        const resampledLength = Math.max(1, Math.floor(origLength / pitchRatio));
        const resampledBuffer = ctx.createBuffer(numChannels, resampledLength, sampleRate);

        for (let ch = 0; ch < numChannels; ch++) {
            const src = buffer.getChannelData(ch);
            const dst = resampledBuffer.getChannelData(ch);
            for (let i = 0; i < resampledLength; i++) {
                const srcIdx = i * pitchRatio;
                const i0 = Math.floor(srcIdx);
                const i1 = Math.min(i0 + 1, origLength - 1);
                const frac = srcIdx - i0;
                if (i0 >= 0 && i0 < origLength) {
                    dst[i] = src[i0] * (1 - frac) + src[i1] * frac;
                }
            }
        }

        // 2. タイムストレッチで【元の厳密な長さ (origLength)】に復元（音程は変更後の高さを維持）
        return this.timeStretch(resampledBuffer, origLength, ctx);
    }

    /**
     * フォルマントシフトDSP（再生スピード・長さを100%厳密に保持）
     * 喉・声道・胸腔の共鳴周波数を伸縮させ、声の太さ・サイズ感をダイナミックに変化
     */
    static applyFormantShift(buffer, formantRatio, ctx) {
        if (!buffer || !ctx || Math.abs(formantRatio - 1.0) < 0.02) return buffer;
        const numChannels = buffer.numberOfChannels;
        const sampleRate = buffer.sampleRate;
        const origLength = buffer.length;

        // 1. リサンプリングでスペクトル包絡（共鳴周波数）を formantRatio 倍に伸縮
        const resampleFactor = formantRatio;
        const resampledLength = Math.max(1, Math.floor(origLength / resampleFactor));
        const resampledBuffer = ctx.createBuffer(numChannels, resampledLength, sampleRate);

        for (let ch = 0; ch < numChannels; ch++) {
            const src = buffer.getChannelData(ch);
            const dst = resampledBuffer.getChannelData(ch);
            for (let i = 0; i < resampledLength; i++) {
                const srcIdx = i * resampleFactor;
                const i0 = Math.floor(srcIdx);
                const i1 = Math.min(i0 + 1, origLength - 1);
                const frac = srcIdx - i0;
                if (i0 >= 0 && i0 < origLength) {
                    dst[i] = src[i0] * (1 - frac) + src[i1] * frac;
                }
            }
        }

        // 2. タイムストレッチで音声を元の長さ (origLength) に復元
        const stretchedBuffer = this.timeStretch(resampledBuffer, origLength, ctx);

        // 3. 変化してしまった音程を逆ピッチシフト（1 / formantRatio）で元の高さに復元
        const pitchRestored = this.applyGranularPitchShift(stretchedBuffer, 1.0 / formantRatio, ctx);

        // 4. 【極太・声道/胸腔共鳴エンハンサー】（formantRatio < 0.98 の時に低中域の胴鳴り・声帯の太さを大幅増強）
        if (formantRatio < 0.98) {
            const depthFactor = Math.min(1.0, (1.0 - formantRatio) / 0.65); // 0.0〜1.0
            // 喉・胸の共鳴ピーク（140Hz〜240Hz）をブーストし、音に芯と圧倒的な太さを付加
            const bodyFreq = 160 + (formantRatio * 70); // 160Hz〜230Hz
            const resonanceGain = 1.0 + (depthFactor * 1.7); // 最大 +8.5dB 相当の胴鳴り
            
            const enhancedBuffer = ctx.createBuffer(numChannels, origLength, sampleRate);
            for (let ch = 0; ch < numChannels; ch++) {
                const src = pitchRestored.getChannelData(ch);
                const dst = enhancedBuffer.getChannelData(ch);
                
                // 2次レゾナントバンドパス/ピーキングフィルター
                const omega = (2 * Math.PI * bodyFreq) / sampleRate;
                const sinOmega = Math.sin(omega);
                const cosOmega = Math.cos(omega);
                const alpha = sinOmega / (2 * 1.2); // Q = 1.2
                
                const b0 = 1 + alpha * resonanceGain;
                const b1 = -2 * cosOmega;
                const b2 = 1 - alpha * resonanceGain;
                const a0 = 1 + alpha;
                const a1 = -2 * cosOmega;
                const a2 = 1 - alpha;
                
                let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
                for (let i = 0; i < origLength; i++) {
                    const x0 = src[i];
                    const y0 = (b0/a0)*x0 + (b1/a0)*x1 + (b2/a0)*x2 - (a1/a0)*y1 - (a2/a0)*y2;
                    x2 = x1; x1 = x0;
                    y2 = y1; y1 = y0;
                    
                    // ソフトサチュレーション（音割れ防止＆温かみのある太さ）
                    const mixed = src[i] * (1.0 - depthFactor * 0.35) + y0 * (depthFactor * 0.65);
                    dst[i] = Math.tanh(mixed * 1.1) / 1.1;
                }
            }
            return enhancedBuffer;
        }

        return pitchRestored;
    }

    /**
     * 劇的に効果がわかる新・ざらつきDSP（3重ハイブリッド処理）
     * 1. サブハーモニクス・グロウル（声帯の粗いしゃがれ振動 42Hz〜60Hz）
     * 2. ハスキー・バンドパスブレスノイズ（2.8kHz中心 振幅エンベロープ追従）
     * 3. 多段非対称サチュレーション（Tube Drive＆倍音クランチ）
     */
    static applyRoughness(buffer, roughness, ctx) {
        if (!buffer || !ctx || roughness <= 0) return buffer;
        const numChannels = buffer.numberOfChannels;
        const sampleRate = buffer.sampleRate;
        const numSamples = buffer.length;
        const outputBuffer = ctx.createBuffer(numChannels, numSamples, sampleRate);

        const r = Math.max(0, Math.min(100, roughness)) / 100; // 0.0 〜 1.0

        for (let ch = 0; ch < numChannels; ch++) {
            const src = buffer.getChannelData(ch);
            const dst = outputBuffer.getChannelData(ch);

            let env = 0;
            const envAlpha = 0.015;

            // バンドパスフィルター用ステート（ハスキー息成分 2.8kHz）
            let bp1 = 0, bp2 = 0;
            const bpFreq = 2800;
            const omega = (2 * Math.PI * bpFreq) / sampleRate;
            const bpAlpha = Math.sin(omega) * 0.35;

            // サブハーモニクス（喉のガラガラ振動 42〜60Hz）
            let growlPhase = 0;
            const growlFreq = 42 + (r * 18);
            const growlStep = (2 * Math.PI * growlFreq) / sampleRate;

            for (let i = 0; i < numSamples; i++) {
                const s = src[i];
                const absS = Math.abs(s);
                
                // 振幅エンベロープ追従
                env = env + envAlpha * (absS - env);

                // ① 喉のガラガラ感（サブハーモニクス変調）
                growlPhase += growlStep;
                if (growlPhase > 2 * Math.PI) growlPhase -= 2 * Math.PI;
                const growlSine = Math.sin(growlPhase);
                const growlMod = 1.0 - (r * 0.45 * (0.5 + 0.5 * growlSine));

                const modulatedSample = s * growlMod;

                // ② ハスキー息成分（声帯の息漏れノイズ・バンドパス）
                const rawWhite = (Math.random() * 2 - 1);
                bp1 = bp1 + bpAlpha * (rawWhite - bp1);
                bp2 = bp2 + bpAlpha * (bp1 - bp2);
                const huskyNoise = (bp1 - bp2) * env * (r * 0.55);

                // ③ 多段非対称サチュレーション（Tube Drive / クランチ歪み）
                const drive = 1.0 + (r * 4.5);
                const driven = (modulatedSample + huskyNoise) * drive;
                
                // 偶数次歪み（しゃがれ感） ＋ 奇数次歪み（エッジ）
                let saturated = Math.tanh(driven) + (r * 0.22 * driven * Math.abs(driven));
                saturated = Math.max(-1.0, Math.min(1.0, saturated));

                // 音量バランス調整とブレンド
                const wetGain = 0.88 / (1.0 + r * 0.15);
                dst[i] = (s * (1.0 - r * 0.82) + saturated * r) * wetGain + (huskyNoise * 0.35);
            }
        }
        return outputBuffer;
    }

    /**
     * 【ステージ2】環境フィルターパラメータ処理（リバーブ・フィルター・モジュレーション・背景環境音）
     */
    static processEnvStage(buffer, envParams, ctx) {
        if (!buffer || !ctx) return buffer;
        const params = { ...this.defaultEnvParams(), ...(envParams || {}) };

        const reverbAmt = Math.max(0, Math.min(100, params.reverb || 0)) / 100;
        const filterAmt = Math.max(0, Math.min(100, params.filter || 0)) / 100;
        const modAmt = Math.max(0, Math.min(100, params.modulation || 0)) / 100;
        const hasAmbient = params.ambientSound && params.ambientSound !== 'none';

        if (reverbAmt === 0 && filterAmt === 0 && modAmt === 0 && !hasAmbient) {
            return buffer;
        }

        let workingBuffer = buffer;

        // 1. フィルター（こもり・電話・ラジオ・メガホン）
        if (filterAmt > 0) {
            workingBuffer = this.applyAcousticFilter(workingBuffer, filterAmt, ctx);
        }

        // 2. モジュレーション（ロボット・宇宙人・リングモジュレーション）
        if (modAmt > 0) {
            workingBuffer = this.applyModulation(workingBuffer, modAmt, ctx);
        }

        // 3. プロシージャル空間リバーブ＆やまびこマルチタップエコー
        if (reverbAmt > 0) {
            workingBuffer = this.applySchroederReverb(workingBuffer, reverbAmt, ctx);
        }

        // 4. プロシージャル背景環境音の合成・ミックス（水の中・鳥の声・森の音・街の喧騒・電車・雨・カフェ等）
        if (hasAmbient) {
            workingBuffer = this.mixAmbientSound(workingBuffer, params.ambientSound, params.ambientVolume ?? 35, ctx);
        }

        return workingBuffer;
    }

    /**
     * 背景環境音バッファの合成・ブレンド
     */
    static mixAmbientSound(buffer, soundType, volumePercent, ctx) {
        if (!buffer || !ctx || !soundType || soundType === 'none') return buffer;
        const numChannels = buffer.numberOfChannels;
        const sampleRate = buffer.sampleRate;
        const numSamples = buffer.length;
        const vol = Math.max(0, Math.min(100, volumePercent !== undefined ? volumePercent : 35)) / 100;
        if (vol <= 0) return buffer;

        const ambientBuffer = AmbientAudioEngine.generateAmbientBuffer(ctx, soundType, numSamples / sampleRate);
        if (!ambientBuffer) return buffer;

        const outputBuffer = ctx.createBuffer(numChannels, numSamples, sampleRate);
        const ambData = ambientBuffer.getChannelData(0);

        for (let ch = 0; ch < numChannels; ch++) {
            const src = buffer.getChannelData(ch);
            const dst = outputBuffer.getChannelData(ch);
            for (let i = 0; i < numSamples; i++) {
                const ambSample = (ambData[i] || 0) * vol * 0.7;
                dst[i] = Math.tanh(src[i] + ambSample);
            }
        }
        return outputBuffer;
    }

    /**
     * 高品質 音響・環境フィルターDSP
     * 0% -> 原音クリア
     * 1%〜50% -> こもり感・水中・壁の向こう（急峻な24dB/octローパスフィルター 8000Hz〜350Hz）
     * 51%〜100% -> レトロラジオ・電話・メガホン（バンドパス 450Hz-3.2kHz ＋ レゾナンス共鳴 ＋ ホーンサチュレーション）
     */
    static applyAcousticFilter(buffer, filterAmt, ctx) {
        if (!buffer || !ctx || filterAmt <= 0) return buffer;
        const numChannels = buffer.numberOfChannels;
        const sampleRate = buffer.sampleRate;
        const numSamples = buffer.length;
        const outputBuffer = ctx.createBuffer(numChannels, numSamples, sampleRate);

        const amt = Math.max(0, Math.min(100, filterAmt)) / 100;

        for (let ch = 0; ch < numChannels; ch++) {
            const src = buffer.getChannelData(ch);
            const dst = outputBuffer.getChannelData(ch);

            if (amt <= 0.5) {
                // ================== 【前半 0〜50%】: こもり感・水中・壁の向こう ==================
                // ローパスカットオフ: 8000Hz (amt=0) -> 350Hz (amt=0.5) へ指数関数的に絞り込み
                const progress = amt / 0.5; // 0.0 〜 1.0
                const cutoff = 8000 * Math.pow(350 / 8000, progress); // 8000Hz -> 350Hz
                
                // 4段カスケード 1次ローパス（24dB/oct の急峻なこもり感）
                const dt = 1.0 / sampleRate;
                const rc = 1.0 / (2 * Math.PI * cutoff);
                const alpha = dt / (rc + dt);

                let lp1 = 0, lp2 = 0, lp3 = 0, lp4 = 0;

                for (let i = 0; i < numSamples; i++) {
                    const s = src[i];
                    lp1 += alpha * (s - lp1);
                    lp2 += alpha * (lp1 - lp2);
                    lp3 += alpha * (lp2 - lp3);
                    lp4 += alpha * (lp3 - lp4);

                    // わずかな低音ブーストで「こもり感・水の中」の太さを強調
                    const muffled = lp4 * (1.0 + progress * 0.45);
                    // ドライ/ウェットブレンド
                    dst[i] = s * (1.0 - progress) + muffled * progress;
                }
            } else {
                // ================== 【後半 50〜100%】: レトロラジオ・電話・メガホン ==================
                const progress = (amt - 0.5) / 0.5; // 0.0 〜 1.0
                
                // バンドパス周波数設定: ハイパス 400Hz〜800Hz, ローパス 3500Hz〜2400Hz
                const hpFreq = 400 + progress * 400; // 400Hz -> 800Hz (低音全カット)
                const lpFreq = 3500 - progress * 1100; // 3500Hz -> 2400Hz (超高音カット)

                const dt = 1.0 / sampleRate;
                const alphaHP = 1.0 / (1.0 + (2 * Math.PI * hpFreq * dt));
                const alphaLP = (2 * Math.PI * lpFreq * dt) / (1.0 + (2 * Math.PI * lpFreq * dt));

                let hp1 = 0, hp2 = 0, lp1 = 0, lp2 = 0;
                let prevInput = 0;

                // メガホン用共鳴ピーク（1.8kHz Q=2.5）
                const resFreq = 1800;
                const w0 = (2 * Math.PI * resFreq) / sampleRate;
                const alphaRes = Math.sin(w0) / (2 * 2.5);
                const b0 = alphaRes;
                const a0 = 1 + alphaRes;
                const a1 = -2 * Math.cos(w0);
                const a2 = 1 - alphaRes;

                let rx1 = 0, rx2 = 0, ry1 = 0, ry2 = 0;

                for (let i = 0; i < numSamples; i++) {
                    const s = src[i];

                    // 2段ハイパス（低域カット）
                    hp1 = alphaHP * (hp1 + s - prevInput);
                    prevInput = s;
                    hp2 = alphaHP * (hp2 + hp1);

                    // 2段ローパス（高域カット）
                    lp1 += alphaLP * (hp2 - lp1);
                    lp2 += alphaLP * (lp1 - lp2);

                    // メガホン共鳴ピーク（ホーン効果）
                    const resOut = (b0 / a0) * (lp2 - rx2) - (a1 / a0) * ry1 - (a2 / a0) * ry2;
                    rx2 = rx1; rx1 = lp2;
                    ry2 = ry1; ry1 = resOut;

                    let filtered = lp2 + resOut * (0.8 + progress * 1.2);

                    // メガホン・スピーカー特有のソフトクリッピング歪み
                    const drive = 1.5 + progress * 2.5;
                    let driven = filtered * drive;
                    let distorted = Math.tanh(driven) * 0.9;

                    dst[i] = distorted;
                }
            }
        }
        return outputBuffer;
    }

    /**
     * モジュレーションDSP（リングモジュレーション/金属ロボット・宇宙人感）
     */
    static applyModulation(buffer, modAmt, ctx) {
        if (!buffer || !ctx || modAmt <= 0) return buffer;
        const numChannels = buffer.numberOfChannels;
        const sampleRate = buffer.sampleRate;
        const numSamples = buffer.length;
        const outputBuffer = ctx.createBuffer(numChannels, numSamples, sampleRate);

        const amt = Math.max(0, Math.min(100, modAmt)) / 100;
        // 搬送波周波数: amtに応じて 45Hz〜85Hz
        const carrierFreq = 45 + amt * 40;

        for (let ch = 0; ch < numChannels; ch++) {
            const src = buffer.getChannelData(ch);
            const dst = outputBuffer.getChannelData(ch);

            for (let i = 0; i < numSamples; i++) {
                const s = src[i];
                // サイン波キャリア ＋ 奇数倍音（矩形波成分）を少し混ぜてメタリックなロボット感を創出
                const phase = (2 * Math.PI * carrierFreq * i) / sampleRate;
                const carrier = 0.85 * Math.sin(phase) + 0.15 * Math.sin(3 * phase);
                const ringMod = s * carrier * 1.4;
                dst[i] = s * (1.0 - amt * 0.85) + ringMod * (amt * 0.85);
            }
        }
        return outputBuffer;
    }

    /**
     * 本格 Schroeder / Multi-Tap やまびこエコー ＆ 空間リバーブDSP
     * 1. 5段マルチタップ・ステレオディレイライン（明瞭なやまびこ・初期反射音）
     * 2. 8基の独立ダンピングLPFフィードバック・コムフィルター（豊かな残響密度）
     * 3. 4基の直列オールパス・ディフューザー（空間拡散）
     */
    static applySchroederReverb(buffer, reverbAmt, ctx) {
        if (!buffer || !ctx || reverbAmt <= 0) return buffer;
        const numChannels = buffer.numberOfChannels;
        const sampleRate = buffer.sampleRate;
        const numSamples = buffer.length;

        const amt = Math.max(0, Math.min(100, reverbAmt)) / 100; // 0.0 〜 1.0

        // 残響テイル時間の計算（最大2.5秒拡張）
        const tailSec = 0.5 + (amt * 2.0);
        const extraSamples = Math.floor(sampleRate * tailSec);
        const totalSamples = numSamples + extraSamples;
        const outputBuffer = ctx.createBuffer(numChannels, totalSamples, sampleRate);

        // コムフィルターの素数ディレイサンプル長（44.1kHz基準でスケーリング）
        const srScale = sampleRate / 44100;
        const combTuning = [
            Math.floor(1116 * srScale),
            Math.floor(1188 * srScale),
            Math.floor(1277 * srScale),
            Math.floor(1356 * srScale),
            Math.floor(1422 * srScale),
            Math.floor(1491 * srScale),
            Math.floor(1557 * srScale),
            Math.floor(1617 * srScale)
        ];

        // オールパスフィルターのディレイ長
        const allpassTuning = [
            Math.floor(556 * srScale),
            Math.floor(441 * srScale),
            Math.floor(341 * srScale),
            Math.floor(225 * srScale)
        ];

        // マルチタップ・やまびこエコーのディレイ長（秒 -> サンプル数）
        const echoTaps = [
            { delay: Math.floor(sampleRate * 0.085), gain: 0.45 * amt },
            { delay: Math.floor(sampleRate * 0.170), gain: 0.35 * amt },
            { delay: Math.floor(sampleRate * 0.260), gain: 0.28 * amt },
            { delay: Math.floor(sampleRate * 0.380), gain: 0.22 * amt },
            { delay: Math.floor(sampleRate * 0.520), gain: 0.18 * amt }
        ];
        const maxEchoDelay = Math.floor(sampleRate * 0.55);

        // フィードバック係数（0.72 〜 0.94：圧倒的に豊かなロング残響テイル）
        const feedback = 0.72 + (amt * 0.22);
        const damp = 0.26;

        for (let ch = 0; ch < numChannels; ch++) {
            const src = buffer.getChannelData(ch);
            const dst = outputBuffer.getChannelData(ch);

            // やまびこリングバッファ
            const echoBuffer = new Float32Array(maxEchoDelay);
            let echoIdx = 0;

            // コムフィルター用ディレイライン
            const combBuffers = combTuning.map(len => new Float32Array(len));
            const combIndices = new Int32Array(combTuning.length);
            const combFilterStore = new Float32Array(combTuning.length);

            // オールパス用ディレイライン
            const apBuffers = allpassTuning.map(len => new Float32Array(len));
            const apIndices = new Int32Array(allpassTuning.length);

            // ドライ・ウェット比率
            const wetGain = (0.45 + amt * 0.95) / Math.sqrt(combTuning.length);
            const dryGain = Math.max(0.1, 1.0 - (amt * 0.35));
            const echoGain = 0.65 * amt;

            for (let i = 0; i < totalSamples; i++) {
                const inSample = (i < numSamples) ? src[i] : 0;

                // ① マルチタップ・やまびこエコー処理
                let echoSum = 0;
                for (let t = 0; t < echoTaps.length; t++) {
                    const tap = echoTaps[t];
                    let rPos = echoIdx - tap.delay;
                    if (rPos < 0) rPos += maxEchoDelay;
                    echoSum += echoBuffer[rPos] * tap.gain;
                }
                echoBuffer[echoIdx] = inSample + echoSum * (0.35 * amt);
                echoIdx = (echoIdx + 1) % maxEchoDelay;

                // ② 8基のコムフィルター並列処理
                const combIn = inSample + echoSum * 0.5;
                let combOutSum = 0;
                for (let c = 0; c < combTuning.length; c++) {
                    const cBuf = combBuffers[c];
                    const cLen = combTuning[c];
                    const cIdx = combIndices[c];

                    const delayed = cBuf[cIdx];
                    combFilterStore[c] = (delayed * (1 - damp)) + (combFilterStore[c] * damp);
                    cBuf[cIdx] = combIn + (combFilterStore[c] * feedback);

                    combIndices[c] = (cIdx + 1) % cLen;
                    combOutSum += delayed;
                }

                // ③ 4基のオールパスフィルター直列処理（空間拡散・ディフュージョン）
                let apOut = combOutSum;
                for (let a = 0; a < allpassTuning.length; a++) {
                    const aBuf = apBuffers[a];
                    const aLen = allpassTuning[a];
                    const aIdx = apIndices[a];

                    const bufOut = aBuf[aIdx];
                    const apFeedback = 0.5;
                    const apIn = apOut;

                    apOut = -apIn + bufOut;
                    aBuf[aIdx] = apIn + (bufOut * apFeedback);

                    apIndices[a] = (aIdx + 1) % aLen;
                }

                // ④ 最終ミックス ＆ tanh サチュレーション（豊かな響きと音割れ防止）
                const mixed = (inSample * dryGain) + (echoSum * echoGain) + (apOut * wetGain);
                dst[i] = Math.tanh(mixed);
            }
        }
        return outputBuffer;
    }

    /**
     * 3バンドイコライザー（Bass / Mid / Treble）DSP
     * bass: -12dB 〜 +12dB (LowShelf 160Hz)
     * mid: -12dB 〜 +12dB (Peaking 1400Hz Q=1.2)
     * treble: -12dB 〜 +12dB (HighShelf 4800Hz)
     */
    static apply3BandEQ(buffer, eqParams, ctx) {
        if (!buffer || !ctx || !eqParams) return buffer;
        const bassGain = Math.max(-12, Math.min(12, eqParams.bass || 0));
        const midGain = Math.max(-12, Math.min(12, eqParams.mid || 0));
        const trebleGain = Math.max(-12, Math.min(12, eqParams.treble || 0));

        if (bassGain === 0 && midGain === 0 && trebleGain === 0) return buffer;

        const numChannels = buffer.numberOfChannels;
        const sampleRate = buffer.sampleRate;
        const numSamples = buffer.length;
        const outputBuffer = ctx.createBuffer(numChannels, numSamples, sampleRate);

        // ① LowShelf 係数計算 (160Hz)
        const f0_L = 160;
        const A_L = Math.pow(10, bassGain / 40);
        const w0_L = (2 * Math.PI * f0_L) / sampleRate;
        const cos_L = Math.cos(w0_L);
        const sin_L = Math.sin(w0_L);
        const alpha_L = (sin_L / 2) * Math.SQRT2;
        const b0_L = A_L * ((A_L + 1) - (A_L - 1) * cos_L + 2 * Math.sqrt(A_L) * alpha_L);
        const b1_L = 2 * A_L * ((A_L - 1) - (A_L + 1) * cos_L);
        const b2_L = A_L * ((A_L + 1) - (A_L - 1) * cos_L - 2 * Math.sqrt(A_L) * alpha_L);
        const a0_L = (A_L + 1) + (A_L - 1) * cos_L + 2 * Math.sqrt(A_L) * alpha_L;
        const a1_L = -2 * ((A_L - 1) + (A_L + 1) * cos_L);
        const a2_L = (A_L + 1) + (A_L - 1) * cos_L - 2 * Math.sqrt(A_L) * alpha_L;

        // ② Peaking 係数計算 (1400Hz, Q=1.2)
        const f0_M = 1400;
        const A_M = Math.pow(10, midGain / 40);
        const w0_M = (2 * Math.PI * f0_M) / sampleRate;
        const cos_M = Math.cos(w0_M);
        const sin_M = Math.sin(w0_M);
        const alpha_M = sin_M / (2 * 1.2);
        const b0_M = 1 + alpha_M * A_M;
        const b1_M = -2 * cos_M;
        const b2_M = 1 - alpha_M * A_M;
        const a0_M = 1 + alpha_M / A_M;
        const a1_M = -2 * cos_M;
        const a2_M = 1 - alpha_M / A_M;

        // ③ HighShelf 係数計算 (4800Hz)
        const f0_H = 4800;
        const A_H = Math.pow(10, trebleGain / 40);
        const w0_H = (2 * Math.PI * f0_H) / sampleRate;
        const cos_H = Math.cos(w0_H);
        const sin_H = Math.sin(w0_H);
        const alpha_H = (sin_H / 2) * Math.SQRT2;
        const b0_H = A_H * ((A_H + 1) + (A_H - 1) * cos_H + 2 * Math.sqrt(A_H) * alpha_H);
        const b1_H = -2 * A_H * ((A_H - 1) + (A_H + 1) * cos_H);
        const b2_H = A_H * ((A_H + 1) + (A_H - 1) * cos_H - 2 * Math.sqrt(A_H) * alpha_H);
        const a0_H = (A_H + 1) - (A_H - 1) * cos_H + 2 * Math.sqrt(A_H) * alpha_H;
        const a1_H = 2 * ((A_H - 1) - (A_H + 1) * cos_H);
        const a2_H = (A_H + 1) - (A_H - 1) * cos_H - 2 * Math.sqrt(A_H) * alpha_H;

        for (let ch = 0; ch < numChannels; ch++) {
            const src = buffer.getChannelData(ch);
            const dst = outputBuffer.getChannelData(ch);

            let x1_L = 0, x2_L = 0, y1_L = 0, y2_L = 0;
            let x1_M = 0, x2_M = 0, y1_M = 0, y2_M = 0;
            let x1_H = 0, x2_H = 0, y1_H = 0, y2_H = 0;

            for (let i = 0; i < numSamples; i++) {
                const x = src[i];

                // LowShelf
                const y_L = (b0_L / a0_L) * x + (b1_L / a0_L) * x1_L + (b2_L / a0_L) * x2_L - (a1_L / a0_L) * y1_L - (a2_L / a0_L) * y2_L;
                x2_L = x1_L; x1_L = x; y2_L = y1_L; y1_L = y_L;

                // Peaking
                const y_M = (b0_M / a0_M) * y_L + (b1_M / a0_M) * x1_M + (b2_M / a0_M) * x2_M - (a1_M / a0_M) * y1_M - (a2_M / a0_M) * y2_M;
                x2_M = x1_M; x1_M = y_L; y2_M = y1_M; y1_M = y_M;

                // HighShelf
                const y_H = (b0_H / a0_H) * y_M + (b1_H / a0_H) * x1_H + (b2_H / a0_H) * x2_H - (a1_H / a0_H) * y1_H - (a2_H / a0_H) * y2_H;
                x2_H = x1_H; x1_H = y_M; y2_H = y1_H; y1_H = y_H;

                dst[i] = y_H;
            }
        }
        return outputBuffer;
    }

    /**
     * 多重分身・コーラスDSP（Hive Mind / Chorus）
     * 複数のLFOディレイラインで大合唱・分身ボイスを生成
     */
    static applyChorus(buffer, chorusAmt, ctx) {
        if (!buffer || !ctx || chorusAmt <= 0) return buffer;
        const numChannels = buffer.numberOfChannels;
        const sampleRate = buffer.sampleRate;
        const numSamples = buffer.length;
        const outputBuffer = ctx.createBuffer(numChannels, numSamples, sampleRate);

        const amt = Math.max(0, Math.min(100, chorusAmt)) / 100;
        const maxDelaySamples = Math.floor(sampleRate * 0.045); // 最大45msディレイ

        // 3つのクローンボイス（異なるディレイ＆LFOレート）
        const voices = [
            { baseDelay: 0.016, depth: 0.0035, rate: 0.85, phase: 0 },
            { baseDelay: 0.024, depth: 0.0045, rate: 1.25, phase: Math.PI / 3 },
            { baseDelay: 0.032, depth: 0.0055, rate: 1.65, phase: Math.PI * 2 / 3 }
        ];

        for (let ch = 0; ch < numChannels; ch++) {
            const src = buffer.getChannelData(ch);
            const dst = outputBuffer.getChannelData(ch);

            const ringBuffer = new Float32Array(maxDelaySamples);
            let ringIdx = 0;

            for (let i = 0; i < numSamples; i++) {
                const s = src[i];
                ringBuffer[ringIdx] = s;

                let chorusSum = 0;
                for (let v = 0; v < voices.length; v++) {
                    const voice = voices[v];
                    const lfo = Math.sin((2 * Math.PI * voice.rate * i) / sampleRate + voice.phase);
                    const curDelaySec = voice.baseDelay + lfo * voice.depth;
                    const delaySamples = curDelaySec * sampleRate;

                    let readPos = ringIdx - delaySamples;
                    if (readPos < 0) readPos += maxDelaySamples;

                    const i0 = Math.floor(readPos);
                    const i1 = (i0 + 1) % maxDelaySamples;
                    const frac = readPos - i0;

                    const sample = ringBuffer[i0] * (1 - frac) + ringBuffer[i1] * frac;
                    chorusSum += sample;
                }

                ringIdx = (ringIdx + 1) % maxDelaySamples;

                const wetMix = (chorusSum / voices.length) * amt * 0.85;
                const dryMix = s * (1.0 - amt * 0.3);
                dst[i] = (dryMix + wetMix) * 0.95;
            }
        }
        return outputBuffer;
    }

    /**
     * 無線スケルチノイズ＆通信音DSP（Walkie-Talkie / FPS Radio）
     */
    static applyRadioNoise(buffer, radioAmt, ctx) {
        if (!buffer || !ctx || radioAmt <= 0) return buffer;
        const numChannels = buffer.numberOfChannels;
        const sampleRate = buffer.sampleRate;
        const numSamples = buffer.length;

        const amt = Math.max(0, Math.min(100, radioAmt)) / 100;
        // 開始クリック＋終了スケルチ（0.1秒拡張）
        const endNoiseSec = 0.12;
        const extraSamples = Math.floor(sampleRate * endNoiseSec);
        const totalSamples = numSamples + extraSamples;
        const outputBuffer = ctx.createBuffer(numChannels, totalSamples, sampleRate);

        const startBurstLen = Math.floor(sampleRate * 0.04);

        for (let ch = 0; ch < numChannels; ch++) {
            const src = buffer.getChannelData(ch);
            const dst = outputBuffer.getChannelData(ch);

            for (let i = 0; i < totalSamples; i++) {
                let sample = (i < numSamples) ? src[i] : 0;

                // ① 開始マイクONバースト（カチッ・プツッ）
                if (i < startBurstLen) {
                    const clickEnv = Math.sin((i / startBurstLen) * Math.PI);
                    const click = (Math.random() * 2 - 1) * clickEnv * 0.35 * amt;
                    sample += click;
                }

                // ② 通信中の微細なサーという無線キャリアノイズ
                if (i < numSamples) {
                    const carrierHiss = (Math.random() * 2 - 1) * 0.018 * amt;
                    sample += carrierHiss;
                }

                // ③ 終了時の無線スケルチノイズ（ザザッ…プツッ）
                if (i >= numSamples) {
                    const tailIdx = i - numSamples;
                    const tailEnv = Math.exp(-tailIdx / (sampleRate * 0.035));
                    const squelch = (Math.random() * 2 - 1) * tailEnv * 0.45 * amt;
                    sample += squelch;
                }

                dst[i] = sample;
            }
        }
        return outputBuffer;
    }

    /**
     * 音割れマイクDSP（Trash Mic / BitCrush & Extreme Hard Clip）
     */
    static applyTrashMic(buffer, trashAmt, ctx) {
        if (!buffer || !ctx || trashAmt <= 0) return buffer;
        const numChannels = buffer.numberOfChannels;
        const sampleRate = buffer.sampleRate;
        const numSamples = buffer.length;
        const outputBuffer = ctx.createBuffer(numChannels, numSamples, sampleRate);

        const amt = Math.max(0, Math.min(100, trashAmt)) / 100;
        // ビット深度を 4ビット〜8ビットに低減（量子化ノイズ）
        const bitDepth = 12 - (amt * 8);
        const steps = Math.pow(2, bitDepth);
        const drive = 1.0 + (amt * 8.0); // 激しいオーバードライブ

        for (let ch = 0; ch < numChannels; ch++) {
            const src = buffer.getChannelData(ch);
            const dst = outputBuffer.getChannelData(ch);

            for (let i = 0; i < numSamples; i++) {
                const s = src[i];
                let driven = s * drive;

                // ハードクリップ（音割れ）
                let clipped = Math.max(-0.85, Math.min(0.85, driven));

                // ビットクラッシュ
                let crushed = Math.round(clipped * steps) / steps;

                dst[i] = s * (1.0 - amt * 0.9) + crushed * (amt * 0.9);
            }
        }
        return outputBuffer;
    }

    /**
     * Voicemodスタイル 統合ボイスプリセット定義マスター（声質・キャラクター・機材）
     */
    static getVoicemodPresets() {
        return [
            // 🎙️ 通信・機材系
            {
                id: 'clean_mic',
                name: 'Clean Mic',
                category: 'device',
                icon: '🎙️',
                desc: '原音高音質化・マイク明瞭化',
                voice: { pitchSemitones: 0, formantRatio: 1.0, roughness: 0 },
                env: { reverb: 5, filter: 0, modulation: 0, ambientSound: 'none', ambientVolume: 0 },
                eq: { bass: 3, mid: 4, treble: 5 },
                special: { chorus: 0, radioNoise: 0, trash: 0 }
            },
            {
                id: 'megaphone',
                name: 'メガホン (拡声器)',
                category: 'device',
                icon: '📢',
                desc: 'ホーン共鳴＆過大入力歪み',
                voice: { pitchSemitones: 1, formantRatio: 1.05, roughness: 10 },
                env: { reverb: 5, filter: 95, modulation: 0, ambientSound: 'none', ambientVolume: 0 },
                eq: { bass: -8, mid: 8, treble: -3 },
                special: { chorus: 0, radioNoise: 0, trash: 0 }
            },
            {
                id: 'walkie_talkie',
                name: '無線トランシーバー',
                category: 'device',
                icon: '🪖',
                desc: 'FPS交信＆プツッザザッ通信音',
                voice: { pitchSemitones: 0, formantRatio: 1.0, roughness: 15 },
                env: { reverb: 0, filter: 88, modulation: 0, ambientSound: 'none', ambientVolume: 0 },
                eq: { bass: -10, mid: 6, treble: -6 },
                special: { chorus: 0, radioNoise: 90, trash: 0 }
            },
            {
                id: 'retro_radio',
                name: 'レトロラジオ',
                category: 'device',
                icon: '📻',
                desc: 'AM放送のノスタルジック帯域',
                voice: { pitchSemitones: 0, formantRatio: 1.0, roughness: 5 },
                env: { reverb: 0, filter: 68, modulation: 15, ambientSound: 'none', ambientVolume: 0 },
                eq: { bass: -6, mid: 5, treble: -8 },
                special: { chorus: 0, radioNoise: 20, trash: 0 }
            },
            {
                id: 'trash_mic',
                name: '音割れマイク',
                category: 'meme',
                icon: '🗑️',
                desc: '爆音・低品質ネットミームマイク',
                voice: { pitchSemitones: 0, formantRatio: 1.0, roughness: 60 },
                env: { reverb: 0, filter: 30, modulation: 0, ambientSound: 'none', ambientVolume: 0 },
                eq: { bass: 8, mid: 10, treble: -5 },
                special: { chorus: 0, radioNoise: 0, trash: 85 }
            },

            // 🎭 キャラクター系
            {
                id: 'helium_banana',
                name: 'ヘリウム / バナナ',
                category: 'character',
                icon: '🍌',
                desc: '甲高い超高音＆ミニオン風',
                voice: { pitchSemitones: 10, formantRatio: 1.62, roughness: 0 },
                env: { reverb: 5, filter: 0, modulation: 0, ambientSound: 'none', ambientVolume: 0 },
                eq: { bass: -4, mid: 2, treble: 6 },
                special: { chorus: 0, radioNoise: 0, trash: 0 }
            },
            {
                id: 'monster_titan',
                name: '怪獣 / タイタン',
                category: 'character',
                icon: '👹',
                desc: '巨体の咆哮＆重低音ガラガラ声',
                voice: { pitchSemitones: -9, formantRatio: 0.42, roughness: 80 },
                env: { reverb: 30, filter: 0, modulation: 0, ambientSound: 'none', ambientVolume: 0 },
                eq: { bass: 9, mid: 2, treble: -4 },
                special: { chorus: 0, radioNoise: 0, trash: 0 }
            },
            {
                id: 'baby',
                name: '赤ちゃん',
                category: 'character',
                icon: '👶',
                desc: '愛らしい高音トーン',
                voice: { pitchSemitones: 7, formantRatio: 1.5, roughness: 5 },
                env: { reverb: 5, filter: 0, modulation: 0, ambientSound: 'none', ambientVolume: 0 },
                eq: { bass: -2, mid: 3, treble: 4 },
                special: { chorus: 0, radioNoise: 0, trash: 0 }
            },
            {
                id: 'old_man',
                name: 'おじいさん',
                category: 'character',
                icon: '👴',
                desc: '深いしゃがれ＆かすれ声',
                voice: { pitchSemitones: -4, formantRatio: 0.82, roughness: 60 },
                env: { reverb: 10, filter: 10, modulation: 0, ambientSound: 'none', ambientVolume: 0 },
                eq: { bass: 2, mid: -2, treble: -3 },
                special: { chorus: 0, radioNoise: 0, trash: 0 }
            },

            // 👻 ホラー・SF系
            {
                id: 'lost_soul',
                name: '亡霊 (Lost Soul)',
                category: 'horror',
                icon: '💀',
                desc: '怨念のピッチダウン＆暗黒残響',
                voice: { pitchSemitones: -5, formantRatio: 0.75, roughness: 35 },
                env: { reverb: 90, filter: 25, modulation: 30, ambientSound: 'none', ambientVolume: 0 },
                eq: { bass: 6, mid: -4, treble: 3 },
                special: { chorus: 40, radioNoise: 0, trash: 0 }
            },
            {
                id: 'cyber_robot',
                name: 'サイバーロボット',
                category: 'horror',
                icon: '🤖',
                desc: '金属リング変調＆メカニカル音',
                voice: { pitchSemitones: -2, formantRatio: 0.9, roughness: 20 },
                env: { reverb: 15, filter: 0, modulation: 80, ambientSound: 'none', ambientVolume: 0 },
                eq: { bass: 0, mid: 6, treble: 4 },
                special: { chorus: 0, radioNoise: 0, trash: 0 }
            },
            {
                id: 'alien',
                name: '宇宙人 (Alien)',
                category: 'horror',
                icon: '👽',
                desc: '異星人の周波数うねり',
                voice: { pitchSemitones: 5, formantRatio: 1.25, roughness: 10 },
                env: { reverb: 50, filter: 15, modulation: 65, ambientSound: 'none', ambientVolume: 0 },
                eq: { bass: -3, mid: 2, treble: 5 },
                special: { chorus: 50, radioNoise: 0, trash: 0 }
            },
            {
                id: 'hive_mind',
                name: '分身・合唱 (Hive Mind)',
                category: 'music',
                icon: '👥',
                desc: '多重クローンボイスの大合唱',
                voice: { pitchSemitones: 0, formantRatio: 1.0, roughness: 0 },
                env: { reverb: 35, filter: 0, modulation: 0, ambientSound: 'none', ambientVolume: 0 },
                eq: { bass: 2, mid: 3, treble: 4 },
                special: { chorus: 90, radioNoise: 0, trash: 0 }
            }
        ];
    }

    /**
     * ⛰️ 環境・空間プリセット定義マスター（15種類の空間・自然・日常・特殊シーン）
     */
    static getEnvironmentPresets() {
        return [
            // 🏛️ 空間・反響系
            {
                id: 'cathedral',
                name: '大聖堂 (Cathedral)',
                category: 'spatial',
                icon: '⛪',
                desc: '神秘的で圧倒的な超ロング残響ドローン',
                env: { reverb: 95, filter: 0, modulation: 0, ambientSound: 'cathedral', ambientVolume: 40 }
            },
            {
                id: 'cave',
                name: '洞窟 (Cave)',
                category: 'spatial',
                icon: '⛰️',
                desc: '水滴が滴る岩肌のディープエコー',
                env: { reverb: 85, filter: 20, modulation: 0, ambientSound: 'cave_drip', ambientVolume: 45 }
            },
            {
                id: 'bath',
                name: 'お風呂 (Bath)',
                category: 'spatial',
                icon: '🛁',
                desc: 'タイルに反響する明るいエコー残響',
                env: { reverb: 55, filter: 0, modulation: 0, ambientSound: 'none', ambientVolume: 0 }
            },
            {
                id: 'hall',
                name: 'コンサートホール',
                category: 'spatial',
                icon: '🏛️',
                desc: '華やかで広大なホール空間残響',
                env: { reverb: 70, filter: 0, modulation: 0, ambientSound: 'none', ambientVolume: 0 }
            },

            // 🌿 自然・風景系
            {
                id: 'underwater',
                name: '水の中 (Underwater)',
                category: 'nature',
                icon: '🫧',
                desc: '深海の気泡音と極限こもり音響',
                env: { reverb: 40, filter: 48, modulation: 0, ambientSound: 'underwater', ambientVolume: 50 }
            },
            {
                id: 'forest',
                name: '森の音 (Forest)',
                category: 'nature',
                icon: '🌲',
                desc: '爽やかな木々のざわめきと風の静けさ',
                env: { reverb: 25, filter: 5, modulation: 0, ambientSound: 'forest', ambientVolume: 45 }
            },
            {
                id: 'birds',
                name: '鳥の声 (Birds)',
                category: 'nature',
                icon: '🐦',
                desc: '小鳥のさえずりと穏やかな自然の息吹',
                env: { reverb: 20, filter: 0, modulation: 0, ambientSound: 'birds', ambientVolume: 45 }
            },
            {
                id: 'rain',
                name: '雨と雷 (Rain & Thunder)',
                category: 'nature',
                icon: '🌧️',
                desc: 'しとしと降る雨音と遠雷の響き',
                env: { reverb: 35, filter: 15, modulation: 0, ambientSound: 'rain', ambientVolume: 45 }
            },

            // 🏙️ 日常・生活系
            {
                id: 'city',
                name: '街の喧騒 (City)',
                category: 'daily',
                icon: '🏙️',
                desc: '都市の雑踏・足音・車の走行音',
                env: { reverb: 15, filter: 10, modulation: 0, ambientSound: 'city', ambientVolume: 40 }
            },
            {
                id: 'train',
                name: '電車の中 (Train)',
                category: 'daily',
                icon: '🚃',
                desc: 'ガタゴト揺れる線路音とモーター音',
                env: { reverb: 20, filter: 25, modulation: 0, ambientSound: 'train', ambientVolume: 45 }
            },
            {
                id: 'cafe',
                name: 'カフェ (Cafe)',
                category: 'daily',
                icon: '☕',
                desc: '店内の話し声とカップの触れ合う音',
                env: { reverb: 25, filter: 10, modulation: 0, ambientSound: 'cafe', ambientVolume: 40 }
            },

            // 📡 機材・特殊系
            {
                id: 'space',
                name: '宇宙ステーション (Space)',
                category: 'special',
                icon: '🌌',
                desc: '無重力サブベースとSF空間うねり',
                env: { reverb: 60, filter: 20, modulation: 50, ambientSound: 'space', ambientVolume: 45 }
            },
            {
                id: 'megaphone_env',
                name: 'メガホン・広場 (Megaphone)',
                category: 'special',
                icon: '📢',
                desc: '屋外広場に響く拡声器の反響',
                env: { reverb: 45, filter: 95, modulation: 0, ambientSound: 'none', ambientVolume: 0 }
            },
            {
                id: 'radio_env',
                name: 'レトロラジオ環境 (Radio)',
                category: 'special',
                icon: '📻',
                desc: '昭和レトロなAM電波帯域フィルター',
                env: { reverb: 10, filter: 68, modulation: 15, ambientSound: 'none', ambientVolume: 0 }
            },
            {
                id: 'telephone_env',
                name: '黒電話・固定電話 (Telephone)',
                category: 'special',
                icon: '☎️',
                desc: '狭帯域な電話回線の音響特性',
                env: { reverb: 0, filter: 85, modulation: 0, ambientSound: 'none', ambientVolume: 0 }
            }
        ];
    }

    /**
     * 自然な日本語母音（「あー」）を音響モデル（声門波＋4バンド・フォルマント共鳴）で完全合成
     * 220Hz矩形波/正弦波ビープ音の不快音を完全撤廃し、温かみのある肉声サンプルを生成する
     */
    static generateNaturalVowelBuffer(ctx, duration = 1.0) {
        const sampleRate = ctx.sampleRate || 44100;
        const totalSamples = Math.floor(sampleRate * duration);
        const buffer = ctx.createBuffer(1, totalSamples, sampleRate);
        const out = buffer.getChannelData(0);

        // 基本周波数 F0 = 160Hz（自然な話し声基音）+ 5.5Hzビブラート + 微小な声門ジッター
        const baseF0 = 160.0;
        let phase = 0;
        const excitation = new Float32Array(totalSamples);

        for (let i = 0; i < totalSamples; i++) {
            const t = i / sampleRate;
            // 自然なピッチ輪郭（出だしの微小アクセント + 自然な5.5Hzビブラート）
            const pitchEnv = 1.0 + 0.03 * Math.exp(-t / 0.3) + 0.015 * Math.sin(2 * Math.PI * 5.5 * t);
            const currentF0 = baseF0 * pitchEnv;
            const periodSamples = sampleRate / currentF0;

            // 声門開放率 Oq = 0.65 (Rosenberg Glottal Flow Model)
            const posInPeriod = (phase % periodSamples) / periodSamples;
            let glottalPulse = 0;
            if (posInPeriod < 0.65) {
                const x = posInPeriod / 0.65;
                glottalPulse = (3 * x * x - 2 * x * x * x);
            }
            // 声門気流微分（-12dB/octの自然な声帯振動特性）+ 息成分ノイズ (1.5%)
            const breath = (Math.random() * 2 - 1) * 0.02;
            excitation[i] = (glottalPulse * 0.95 + breath);

            phase++;
        }

        // 日本語「あ」のフォルマント定義 (F1, F2, F3, F4)
        const formants = [
            { freq: 800, bw: 80, gain: 1.0 },    // F1: 咽頭腔
            { freq: 1250, bw: 90, gain: 0.7 },   // F2: 口腔
            { freq: 2600, bw: 120, gain: 0.35 }, // F3: 声道共鳴
            { freq: 3500, bw: 180, gain: 0.18 }  // F4: 高域シンガーズフォルマント
        ];

        // 4バンド並列共鳴フィルター (2nd Order Resonator Filter)
        const resOutputs = formants.map(() => new Float32Array(totalSamples));

        formants.forEach((f, fIdx) => {
            const R = Math.exp(-Math.PI * f.bw / sampleRate);
            const theta = 2 * Math.PI * f.freq / sampleRate;
            const a1 = -2 * R * Math.cos(theta);
            const a2 = R * R;
            const b0 = (1 - R) * Math.sqrt(1 - 2 * R * Math.cos(2 * theta) + R * R) * f.gain;

            let y1 = 0, y2 = 0;
            const resOut = resOutputs[fIdx];
            for (let i = 0; i < totalSamples; i++) {
                const x0 = excitation[i];
                const y0 = b0 * x0 - a1 * y1 - a2 * y2;
                resOut[i] = y0;
                y2 = y1;
                y1 = y0;
            }
        });

        // フォルマント合成 + 自然な発話音量エンベロープ（アタック0.06s、サステイン、ディケイ0.25s）
        for (let i = 0; i < totalSamples; i++) {
            const t = i / sampleRate;
            let sum = 0;
            for (let fIdx = 0; fIdx < formants.length; fIdx++) {
                sum += resOutputs[fIdx][i];
            }

            // 包絡線エンベロープ
            let env = 1.0;
            if (t < 0.06) {
                env = Math.sin((t / 0.06) * (Math.PI / 2));
            } else if (t > duration - 0.25) {
                const fadeT = (t - (duration - 0.25)) / 0.25;
                env = Math.cos(fadeT * (Math.PI / 2));
            }

            out[i] = sum * env * 2.2;
        }

        return buffer;
    }

    /**
     * 直列フルチェーン実行（声質 -> 環境 -> 3バンドEQ -> スペシャルエフェクト）
     */
    static processFull(buffer, ctx, voiceParams, envParams, speed = 1.0, eqParams = null, specialParams = null) {
        if (!buffer || !ctx) return buffer;

        // 1. ステージ1（声質: ピッチ・フォルマント・質感）
        let processed = this.processVoiceStage(buffer, voiceParams, ctx);

        // 2. ステージ2（環境: リバーブ・フィルター・モジュレーション）
        processed = this.processEnvStage(processed, envParams, ctx);

        // 3. 3バンドEQ（Bass / Mid / Treble）
        if (eqParams) {
            processed = this.apply3BandEQ(processed, eqParams, ctx);
        }

        // 4. スペシャルエフェクト（コーラス・無線ノイズ・音割れ）
        if (specialParams) {
            if (specialParams.chorus > 0) {
                processed = this.applyChorus(processed, specialParams.chorus, ctx);
            }
            if (specialParams.trash > 0) {
                processed = this.applyTrashMic(processed, specialParams.trash, ctx);
            }
            if (specialParams.radioNoise > 0) {
                processed = this.applyRadioNoise(processed, specialParams.radioNoise, ctx);
            }
        }

        return processed;
    }

    /**
     * 空間エフェクト（TTS発話時のWeb Audio APIハイブリッド重畳効果）
     */
    static playAcousticFilterOverlay(envParams) {
        const params = { ...this.defaultEnvParams(), ...(envParams || {}) };
        const ctx = AudioUnlocker.getContext();
        if (!ctx) return;

        try {
            if (params.modulation > 20) {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'sawtooth';
                osc.frequency.setValueAtTime(60, ctx.currentTime);
                gain.gain.setValueAtTime(0.03 * (params.modulation / 100), ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.5);
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.onended = () => {
                    try { osc.disconnect(); } catch (e) {}
                    try { gain.disconnect(); } catch (e) {}
                };
                osc.start();
                osc.stop(ctx.currentTime + 1.5);
            }
            if (params.reverb > 30) {
                const bufferSize = Math.floor(ctx.sampleRate * 0.4);
                const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
                const output = noiseBuffer.getChannelData(0);
                for (let i = 0; i < bufferSize; i++) {
                    output[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.12)) * (0.04 * (params.reverb / 100));
                }
                const whiteNoise = ctx.createBufferSource();
                whiteNoise.buffer = noiseBuffer;
                const filter = ctx.createBiquadFilter();
                filter.type = 'lowpass';
                filter.frequency.value = 750;
                whiteNoise.connect(filter);
                filter.connect(ctx.destination);
                whiteNoise.onended = () => {
                    try { whiteNoise.disconnect(); } catch (e) {}
                    try { filter.disconnect(); } catch (e) {}
                };
                whiteNoise.start();
                whiteNoise.stop(ctx.currentTime + 1.5);
            }
        } catch (e) {}
    }
}

// ==================== 2.5 🤖 Web Audio 音声合成 (TTS) エンジン ====================
class TtsEngine {
    /**
     * 日本語・英語・数字・記号を音声合成用ひらがな表記へ正規化
     */
    static textToKana(rawText) {
        if (!rawText) return '';
        let text = String(rawText);

        // 1. 一般的な頻出漢字・熟語・挨拶の読み替え辞書
        const words = [
            ['今日', 'きょう'], ['明日', 'あした'], ['昨日', 'きのう'],
            ['こんにちは', 'こんにちは'], ['有難う', 'ありがとう'], ['ありがとう', 'ありがとう'],
            ['おはよう', 'おはよう'], ['お早う', 'おはよう'], ['こんばんは', 'こんばんは'],
            ['今晩は', 'こんばんは'], ['よろしく', 'よろしく'], ['宜しく', 'よろしく'],
            ['さようなら', 'さようなら'], ['左様なら', 'さようなら'], ['ごめんなさい', 'ごめんなさい'],
            ['いただきます', 'いただきます'], ['ごちそうさま', 'ごちそうさま'],
            ['助けて', 'たすけて'], ['お願い', 'おねがい'], ['大丈夫', 'だいじょうぶ'],
            ['私', 'わたし'], ['僕', 'ぼく'], ['俺', 'おれ'], ['貴方', 'あなた'], ['あなた', 'あなた'],
            ['先生', 'せんせい'], ['友達', 'ともだち'], ['友だち', 'ともだち'],
            ['お父さん', 'おとうさん'], ['お母さん', 'おかあさん'], ['お兄さん', 'おにいさん'], ['お姉さん', 'おねえさん'],
            ['音声', 'おんせい'], ['録音', 'ろくおん'], ['再生', 'さいせい'], ['停止', 'ていし'],
            ['怪獣', 'かいじゅう'], ['大聖堂', 'だいせいどう'], ['洞窟', 'どうくつ'],
            ['宇宙人', 'うちゅうじん'], ['ロボット', 'ろぼっと'], ['電話', 'でんわ'],
            ['行くよ', 'いくよ'], ['いくよ', 'いくよ'], ['止まる', 'とまる'], ['とまる', 'とまる'],
            ['見て', 'みて'], ['聞いて', 'きいて'], ['嬉しい', 'うれしい'], ['楽しい', 'たのしい'],
            ['悲しい', 'かなしい'], ['面白い', 'おもしろい'], ['好き', 'すき'], ['嫌い', 'きらい'],
            ['疲れた', 'つかれた'], ['眠い', 'ねむい'], ['暑い', 'あつい'], ['寒い', 'さむい'],
            ['学校', 'がっこう'], ['家', 'いえ'], ['車', 'くるま'], ['電車', 'でんしゃ'],
            ['時間', 'じかん'], ['今', 'いま'], ['何', 'なに'], ['誰', 'だれ'], ['どこ', 'どこ'],
            ['はい', 'はい'], ['いいえ', 'いいえ'], ['いいね', 'いいね'], ['すごい', 'すごい'], ['やばい', 'やばい']
        ];

        for (const [k, v] of words) {
            text = text.split(k).join(v);
        }

        // 2. 数字（0〜9）の読み替え
        const numMap = {
            '0': 'ぜろ', '1': 'いち', '2': 'に', '3': 'さん', '4': 'よん',
            '5': 'ご', '6': 'ろく', '7': 'なな', '8': 'はち', '9': 'きゅう',
            '１': 'いち', '２': 'に', '３': 'さん', '４': 'よん', '５': 'ご',
            '６': 'ろく', '７': 'なな', '８': 'はち', '９': 'きゅう', '０': 'ぜろ'
        };
        text = text.replace(/[0-9０-９]/g, m => numMap[m] || m);

        // 3. 英語・アルファベット略称の読み替え
        const romajiMap = {
            'ok': 'おーけー', 'ai': 'えーあい', 'sos': 'えすおーえす',
            'voice': 'ぼいす', 'pad': 'ぱっど', 'yes': 'いえす', 'no': 'のー',
            'hello': 'はろー', 'bye': 'ばいばい', 'good': 'ぐっど'
        };
        text = text.replace(/\b[a-zA-Z]+\b/g, m => romajiMap[m.toLowerCase()] || m);

        // 4. カタカナ -> ひらがな変換
        let kana = '';
        for (let i = 0; i < text.length; i++) {
            const code = text.charCodeAt(i);
            if (code >= 0x30A1 && code <= 0x30F6) {
                kana += String.fromCharCode(code - 0x60);
            } else {
                kana += text[i];
            }
        }
        return kana;
    }

    /**
     * ひらがな文字列をモーラ（拍）および音響パラメータ配列へパース
     */
    static parseMorae(kanaText) {
        const map = {
            'あ': { v: 'a' }, 'い': { v: 'i' }, 'う': { v: 'u' }, 'え': { v: 'e' }, 'お': { v: 'o' },
            'か': { v: 'a', c: 'k' }, 'き': { v: 'i', c: 'k' }, 'く': { v: 'u', c: 'k' }, 'け': { v: 'e', c: 'k' }, 'こ': { v: 'o', c: 'k' },
            'さ': { v: 'a', c: 's' }, 'し': { v: 'i', c: 'sh' }, 'す': { v: 'u', c: 's' }, 'せ': { v: 'e', c: 's' }, 'そ': { v: 'o', c: 's' },
            'た': { v: 'a', c: 't' }, 'ち': { v: 'i', c: 'ch' }, 'つ': { v: 'u', c: 'ts' }, 'て': { v: 'e', c: 't' }, 'と': { v: 'o', c: 't' },
            'な': { v: 'a', c: 'n' }, 'に': { v: 'i', c: 'n' }, 'ぬ': { v: 'u', c: 'n' }, 'ね': { v: 'e', c: 'n' }, 'の': { v: 'o', c: 'n' },
            'は': { v: 'a', c: 'h' }, 'ひ': { v: 'i', c: 'h' }, 'ふ': { v: 'u', c: 'f' }, 'へ': { v: 'e', c: 'h' }, 'ほ': { v: 'o', c: 'h' },
            'ま': { v: 'a', c: 'm' }, 'み': { v: 'i', c: 'm' }, 'む': { v: 'u', c: 'm' }, 'め': { v: 'e', c: 'm' }, 'も': { v: 'o', c: 'm' },
            'や': { v: 'a', c: 'y' }, 'ゆ': { v: 'u', c: 'y' }, 'よ': { v: 'o', c: 'y' },
            'ら': { v: 'a', c: 'r' }, 'り': { v: 'i', c: 'r' }, 'る': { v: 'u', c: 'r' }, 'れ': { v: 'e', c: 'r' }, 'ろ': { v: 'o', c: 'r' },
            'わ': { v: 'a', c: 'w' }, 'を': { v: 'o', c: 'w' }, 'ん': { v: 'N' },
            'が': { v: 'a', c: 'g' }, 'ぎ': { v: 'i', c: 'g' }, 'ぐ': { v: 'u', c: 'g' }, 'げ': { v: 'e', c: 'g' }, 'ご': { v: 'o', c: 'g' },
            'ざ': { v: 'a', c: 'z' }, 'じ': { v: 'i', c: 'j' }, 'ず': { v: 'u', c: 'z' }, 'ぜ': { v: 'e', c: 'z' }, 'ぞ': { v: 'o', c: 'z' },
            'だ': { v: 'a', c: 'd' }, 'ぢ': { v: 'i', c: 'j' }, 'づ': { v: 'u', c: 'z' }, 'で': { v: 'e', c: 'd' }, 'ど': { v: 'o', c: 'd' },
            'ば': { v: 'a', c: 'b' }, 'び': { v: 'i', c: 'b' }, 'ぶ': { v: 'u', c: 'b' }, 'べ': { v: 'e', c: 'b' }, 'ぼ': { v: 'o', c: 'b' },
            'ぱ': { v: 'a', c: 'p' }, 'ぴ': { v: 'i', c: 'p' }, 'ぷ': { v: 'u', c: 'p' }, 'ぺ': { v: 'e', c: 'p' }, 'ぽ': { v: 'o', c: 'p' },
            'きゃ': { v: 'a', c: 'ky' }, 'きゅ': { v: 'u', c: 'ky' }, 'きょ': { v: 'o', c: 'ky' },
            'しゃ': { v: 'a', c: 'sh' }, 'しゅ': { v: 'u', c: 'sh' }, 'しょ': { v: 'o', c: 'sh' },
            'ちゃ': { v: 'a', c: 'ch' }, 'ちゅ': { v: 'u', c: 'ch' }, 'ちょ': { v: 'o', c: 'ch' },
            'にゃ': { v: 'a', c: 'ny' }, 'にゅ': { v: 'u', c: 'ny' }, 'にょ': { v: 'o', c: 'ny' },
            'ひゃ': { v: 'a', c: 'hy' }, 'ひゅ': { v: 'u', c: 'hy' }, 'ひょ': { v: 'o', c: 'hy' },
            'みゃ': { v: 'a', c: 'my' }, 'みゅ': { v: 'u', c: 'my' }, 'みょ': { v: 'o', c: 'my' },
            'りゃ': { v: 'a', c: 'ry' }, 'りゅ': { v: 'u', c: 'ry' }, 'りょ': { v: 'o', c: 'ry' },
            'ぎゃ': { v: 'a', c: 'gy' }, 'ぎゅ': { v: 'u', c: 'gy' }, 'ぎょ': { v: 'o', c: 'gy' },
            'じゃ': { v: 'a', c: 'j' }, 'じゅ': { v: 'u', c: 'j' }, 'じょ': { v: 'o', c: 'j' },
            'びゃ': { v: 'a', c: 'by' }, 'びゅ': { v: 'u', c: 'by' }, 'びょ': { v: 'o', c: 'by' },
            'ぴゃ': { v: 'a', c: 'py' }, 'ぴゅ': { v: 'u', c: 'py' }, 'ぴょ': { v: 'o', c: 'py' }
        };

        const morae = [];
        let i = 0;
        while (i < kanaText.length) {
            const c1 = kanaText[i];
            const c2 = kanaText[i + 1];
            const two = c1 + (c2 || '');

            if (c1 === '、' || c1 === '，' || c1 === ',' || c1 === ' ' || c1 === '　') {
                morae.push({ isPause: true, duration: 0.16 });
                i++;
            } else if (c1 === '。' || c1 === '．' || c1 === '.' || c1 === '！' || c1 === '!' || c1 === '？' || c1 === '?') {
                morae.push({ isPause: true, duration: 0.25 });
                i++;
            } else if (c1 === 'っ' || c1 === 'ッ') {
                morae.push({ isSokuon: true, duration: 0.08 });
                i++;
            } else if (c1 === 'ー') {
                if (morae.length > 0 && !morae[morae.length - 1].isPause) {
                    morae[morae.length - 1].duration = (morae[morae.length - 1].duration || 0.14) + 0.12;
                }
                i++;
            } else if (map[two]) {
                morae.push({ ...map[two], char: two, duration: 0.15 });
                i += 2;
            } else if (map[c1]) {
                morae.push({ ...map[c1], char: c1, duration: 0.14 });
                i++;
            } else {
                morae.push({ v: 'a', char: c1, duration: 0.13 });
                i++;
            }
        }
        return morae;
    }

    /**
     * テキストから Web Audio API AudioBuffer を直接生成
     */
    static synthesizeToBuffer(text, ctx, voiceType = 'girl', rate = 1.0, pitchMod = 1.0) {
        const sampleRate = ctx ? ctx.sampleRate : 44100;
        const kana = this.textToKana(text);
        const morae = this.parseMorae(kana);

        if (morae.length === 0) {
            return ctx.createBuffer(1, Math.floor(sampleRate * 0.1), sampleRate);
        }

        // 基本声質キャラクター設定 (5話者スイッチ対応: あゆみ, はるか, いちろう, さやか, Google)
        let basePitch = 220; // Hz
        let formantScale = 1.05;
        if (voiceType === 'ayumi' || voiceType === 'girl') { basePitch = 230; formantScale = 1.10; }
        else if (voiceType === 'haruka') { basePitch = 240; formantScale = 1.15; }
        else if (voiceType === 'ichiro' || voiceType === 'man' || voiceType === 'boy') { basePitch = 120; formantScale = 0.82; }
        else if (voiceType === 'sayaka') { basePitch = 220; formantScale = 1.08; }
        else if (voiceType === 'google' || voiceType === 'woman') { basePitch = 200; formantScale = 1.0; }

        basePitch *= Math.max(0.2, Math.min(3.0, pitchMod));
        const durScale = 1.0 / Math.max(0.5, Math.min(2.5, rate));

        let totalDur = 0.06;
        morae.forEach(m => {
            m.scaledDur = (m.duration || 0.14) * durScale;
            totalDur += m.scaledDur;
        });
        totalDur += 0.08;

        const totalSamples = Math.floor(sampleRate * totalDur);
        const buffer = ctx.createBuffer(1, totalSamples, sampleRate);
        const out = buffer.getChannelData(0);

        // フォルマント定義: [F1, F2, F3, F4]
        const formants = {
            'a': [800, 1250, 2600, 3500],
            'i': [300, 2300, 3000, 3700],
            'u': [360, 1250, 2400, 3500],
            'e': [500, 1900, 2600, 3600],
            'o': [500, 900,  2400, 3500],
            'N': [250, 1000, 2200, 3200]
        };

        let currentSample = Math.floor(sampleRate * 0.05);
        let phase = 0;

        morae.forEach((mora, mIdx) => {
            const moraSamples = Math.floor(mora.scaledDur * sampleRate);
            if (mora.isPause || mora.isSokuon) {
                currentSample += moraSamples;
                return;
            }

            const vowelF = formants[mora.v] || formants['a'];
            const f1 = vowelF[0] * formantScale;
            const f2 = vowelF[1] * formantScale;
            const f3 = vowelF[2] * formantScale;
            const f4 = vowelF[3] * formantScale;

            const consDur = mora.c ? Math.min(moraSamples * 0.45, sampleRate * 0.055) : 0;

            // イントネーション輪郭
            let pitchFactor = 1.0;
            if (mIdx === 0 && morae.length > 1) pitchFactor = 0.94;
            else if (mIdx === 1) pitchFactor = 1.05;
            else pitchFactor = 1.0 - (mIdx / morae.length) * 0.12;

            const moraF0 = basePitch * pitchFactor;

            for (let s = 0; s < moraSamples; s++) {
                const targetIdx = currentSample + s;
                if (targetIdx >= totalSamples) break;

                const tMora = s / moraSamples;
                phase += moraF0 / sampleRate;
                if (phase >= 1.0) phase -= 1.0;

                // 声帯パルス波形（Rosenbergパルスモデル）
                let glottal = 0;
                if (phase < 0.4) {
                    glottal = Math.sin(Math.PI * phase / 0.4);
                } else if (phase < 0.6) {
                    glottal = Math.cos(Math.PI * (phase - 0.4) / 0.4);
                } else {
                    glottal = 0;
                }

                // 4次フォルマント共鳴合成
                const tSec = targetIdx / sampleRate;
                const vRes = Math.sin(2 * Math.PI * f1 * tSec) * 0.45
                           + Math.sin(2 * Math.PI * f2 * tSec) * 0.28
                           + Math.sin(2 * Math.PI * f3 * tSec) * 0.16
                           + Math.sin(2 * Math.PI * f4 * tSec) * 0.08;

                let val = glottal * vRes;

                // 子音成分の重畳
                if (mora.c && s < consDur) {
                    const cEnv = Math.sin(Math.PI * s / consDur);
                    const noise = (Math.random() * 2 - 1);
                    if (mora.c === 's' || mora.c === 'sh' || mora.c === 'ts') {
                        val = val * 0.3 + noise * cEnv * 0.45;
                    } else if (mora.c === 'k' || mora.c === 't' || mora.c === 'p') {
                        val = (s < consDur * 0.4 ? 0 : val * 0.5 + noise * cEnv * 0.55);
                    } else if (mora.c === 'h' || mora.c === 'f') {
                        val = val * 0.6 + noise * cEnv * 0.3;
                    } else if (mora.c === 'm' || mora.c === 'n') {
                        val = val * 0.7 + Math.sin(2 * Math.PI * 250 * tSec) * 0.35 * cEnv;
                    }
                }

                // エンベロープ窓関数
                let moraEnv = 1.0;
                if (tMora < 0.1) moraEnv = tMora / 0.1;
                else if (tMora > 0.85) moraEnv = (1.0 - tMora) / 0.15;

                out[targetIdx] = (out[targetIdx] || 0) + val * moraEnv * 0.65;
            }
            currentSample += moraSamples;
        });

        return buffer;
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

    async migrateLegacyDataIfNeeded() {
        try {
            const scrolls = await this.getAllScrolls();
            if (scrolls.length > 0) return;

            const legacySlots = await this.readLegacyDB();
            const defaultScroll = {
                id: 'scroll_default',
                name: 'メイン',
                order: 0,
                voiceEffect: 'inherit',
                playbackSpeed: 'inherit',
                createdAt: Date.now()
            };
            await this.saveScroll(defaultScroll);
            await this.saveSetting('currentScrollId', defaultScroll.id);
            await this.saveSetting('pageSize', 32);
            await this.saveSetting('globalPlaybackSpeed', 1.0);
            await this.saveSetting('effect', 'normal');

            if (legacySlots && legacySlots.length > 0) {
                for (const slot of legacySlots) {
                    await this.saveSlot({
                        ...slot,
                        id: `slot_${slot.id}`,
                        scrollId: defaultScroll.id,
                        voiceEffect: 'inherit',
                        playbackSpeed: 'inherit',
                        order: slot.id
                    });
                }
            } else {
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
                        voiceEffect: 'inherit',
                        playbackSpeed: 'inherit',
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

    async saveScroll(scroll) {
        if (!this.db) return;
        return new Promise((resolve) => {
            const tx = this.db.transaction('scrolls', 'readwrite');
            tx.objectStore('scrolls').put(scroll);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        });
    }

    async saveAllScrolls(scrolls) {
        if (!this.db) return;
        return new Promise((resolve) => {
            const tx = this.db.transaction('scrolls', 'readwrite');
            const store = tx.objectStore('scrolls');
            scrolls.forEach(s => store.put(s));
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

// ==================== 3.5 📡 QRコード生成 ＆ カメラリーダーエンジン ====================
class QrEngine {
    static PAD0 = 0xEC;
    static PAD1 = 0x11;
    static EXP_TABLE = new Uint8Array(256);
    static LOG_TABLE = new Uint8Array(256);

    static _init = (() => {
        let x = 1;
        for (let i = 0; i < 255; i++) {
            QrEngine.EXP_TABLE[i] = x;
            QrEngine.LOG_TABLE[x] = i;
            x <<= 1;
            if (x & 256) x ^= 0x11d;
        }
        QrEngine.EXP_TABLE[255] = QrEngine.EXP_TABLE[0];
    })();

    static glog(n) { return QrEngine.LOG_TABLE[n]; }
    static gexp(n) {
        while (n < 0) n += 255;
        while (n >= 255) n -= 255;
        return QrEngine.EXP_TABLE[n];
    }

    static polyMul(p1, p2) {
        const res = new Uint8Array(p1.length + p2.length - 1);
        for (let i = 0; i < p1.length; i++) {
            for (let j = 0; j < p2.length; j++) {
                res[i + j] ^= QrEngine.gexp(QrEngine.glog(p1[i]) + QrEngine.glog(p2[j]));
            }
        }
        return res;
    }

    static getRsGen(count) {
        let p = new Uint8Array([1]);
        for (let i = 0; i < count; i++) {
            p = QrEngine.polyMul(p, new Uint8Array([1, QrEngine.gexp(i)]));
        }
        return p;
    }

    static rsCompute(data, count) {
        const gen = QrEngine.getRsGen(count);
        const res = new Uint8Array(data.length + count);
        res.set(data);
        for (let i = 0; i < data.length; i++) {
            const coef = res[i];
            if (coef !== 0) {
                const logCoef = QrEngine.glog(coef);
                for (let j = 0; j < gen.length; j++) {
                    res[i + j] ^= QrEngine.gexp(logCoef + QrEngine.glog(gen[j]));
                }
            }
        }
        return res.slice(data.length);
    }

    // ECC Level M (15% 誤り訂正) パラメータテーブル (Version 1 〜 30)
    static TABLE_M = [
        null,
        [26, 16, 10, 1, 16, 0, 0],
        [44, 28, 16, 1, 28, 0, 0],
        [70, 44, 26, 1, 44, 0, 0],
        [100, 64, 18, 2, 32, 0, 0],
        [134, 86, 24, 2, 43, 0, 0],
        [172, 108, 16, 4, 27, 0, 0],
        [196, 124, 18, 4, 31, 0, 0],
        [242, 154, 22, 2, 38, 2, 39],
        [292, 182, 22, 3, 36, 2, 37],
        [346, 216, 26, 4, 43, 1, 44],
        [404, 254, 30, 1, 50, 4, 51],
        [466, 290, 22, 6, 36, 2, 37],
        [532, 334, 22, 8, 37, 4, 38],
        [581, 365, 24, 4, 40, 5, 41],
        [655, 415, 24, 5, 41, 5, 42],
        [733, 453, 28, 7, 45, 3, 46],
        [815, 507, 28, 10, 46, 1, 47],
        [901, 563, 28, 9, 43, 4, 44],
        [991, 627, 26, 3, 44, 11, 45],
        [1085, 693, 26, 3, 41, 13, 42],
        [1156, 735, 26, 17, 42, 0, 0],
        [1258, 805, 28, 17, 47, 0, 0],
        [1364, 868, 28, 4, 45, 14, 46],
        [1474, 948, 28, 6, 47, 14, 48],
        [1588, 1024, 28, 8, 46, 13, 47],
        [1706, 1102, 28, 19, 46, 4, 47],
        [1828, 1184, 28, 22, 45, 3, 46],
        [1921, 1241, 28, 3, 45, 23, 46],
        [2051, 1327, 28, 21, 45, 7, 46],
        [2185, 1415, 28, 19, 47, 10, 48]
    ];

    static ALIGNMENT_PATTERN_POS = [
        [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
        [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
        [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66],
        [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78],
        [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90],
        [6, 28, 50, 72, 94], [6, 26, 50, 74, 98], [6, 30, 54, 78, 102],
        [6, 28, 54, 80, 106], [6, 32, 58, 84, 110], [6, 30, 58, 86, 114],
        [6, 34, 62, 90, 118], [6, 26, 50, 74, 98, 122], [6, 30, 54, 78, 102, 126],
        [6, 26, 52, 78, 104, 130]
    ];

    static FORMAT_INFO_M = [
        0x4544, 0x4093, 0x4c3a, 0x49e9, 0x57bc, 0x526b, 0x5e02, 0x5bd5
    ];

    /**
     * QRコードのマトリックスを生成
     */
    static encode(text) {
        const utf8 = new TextEncoder().encode(text);
        const len = utf8.length;
        let version = 1;
        while (version <= 30) {
            const table = QrEngine.TABLE_M[version];
            if (!table) break;
            const countBits = (version < 10) ? 8 : 16;
            const requiredBits = 4 + countBits + (len * 8);
            const requiredBytes = Math.ceil(requiredBits / 8);
            if (requiredBytes <= table[1]) break;
            version++;
        }
        if (version > 30) throw new Error("Text too large for QR: " + len + " bytes");

        const table = QrEngine.TABLE_M[version];
        const totalDataBytes = table[1];
        const ecPerBlock = table[2];
        const numG1 = table[3];
        const dataG1 = table[4];
        const numG2 = table[5];
        const dataG2 = table[6];

        const bits = [];
        const pushBits = (val, count) => {
            for (let i = count - 1; i >= 0; i--) bits.push((val >> i) & 1);
        };

        // 1. Mode: 8-bit Byte
        pushBits(0b0100, 4);
        pushBits(len, (version < 10) ? 8 : 16);
        for (let i = 0; i < len; i++) pushBits(utf8[i], 8);

        // 2. Terminator & padding
        const totalDataBits = totalDataBytes * 8;
        const termLen = Math.min(4, totalDataBits - bits.length);
        for (let i = 0; i < termLen; i++) bits.push(0);
        while (bits.length % 8 !== 0) bits.push(0);

        const dataBytes = new Uint8Array(totalDataBytes);
        for (let i = 0; i < bits.length; i += 8) {
            let b = 0;
            for (let j = 0; j < 8; j++) b = (b << 1) | (bits[i + j] || 0);
            dataBytes[i / 8] = b;
        }

        let padIdx = bits.length / 8;
        while (padIdx < totalDataBytes) {
            dataBytes[padIdx] = (padIdx % 2 === 0) ? QrEngine.PAD0 : QrEngine.PAD1;
            padIdx++;
        }

        // 3. Split & ECC
        const dataBlocks = [];
        const ecBlocks = [];
        let byteOffset = 0;
        for (let b = 0; b < numG1; b++) {
            const blk = dataBytes.slice(byteOffset, byteOffset + dataG1);
            byteOffset += dataG1;
            dataBlocks.push(blk);
            ecBlocks.push(QrEngine.rsCompute(blk, ecPerBlock));
        }
        for (let b = 0; b < numG2; b++) {
            const blk = dataBytes.slice(byteOffset, byteOffset + dataG2);
            byteOffset += dataG2;
            dataBlocks.push(blk);
            ecBlocks.push(QrEngine.rsCompute(blk, ecPerBlock));
        }

        const finalCodewords = [];
        const maxDataLen = Math.max(dataG1, dataG2 || 0);
        for (let i = 0; i < maxDataLen; i++) {
            for (let b = 0; b < dataBlocks.length; b++) {
                if (i < dataBlocks[b].length) finalCodewords.push(dataBlocks[b][i]);
            }
        }
        for (let i = 0; i < ecPerBlock; i++) {
            for (let b = 0; b < ecBlocks.length; b++) finalCodewords.push(ecBlocks[b][i]);
        }

        const size = 17 + 4 * version;
        const matrix = Array.from({ length: size }, () => new Int8Array(size).fill(-1));

        // 4. Finder patterns
        const placeFinder = (r, c) => {
            for (let dr = -1; dr <= 7; dr++) {
                for (let dc = -1; dc <= 7; dc++) {
                    const row = r + dr;
                    const col = c + dc;
                    if (row < 0 || row >= size || col < 0 || col >= size) continue;
                    if (dr === -1 || dr === 7 || dc === -1 || dc === 7) {
                        matrix[row][col] = 0;
                    } else if (dr === 0 || dr === 6 || dc === 0 || dc === 6) {
                        matrix[row][col] = 1;
                    } else if (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4) {
                        matrix[row][col] = 1;
                    } else {
                        matrix[row][col] = 0;
                    }
                }
            }
        };

        placeFinder(0, 0);
        placeFinder(0, size - 7);
        placeFinder(size - 7, 0);

        // 5. Alignment patterns
        const alignPos = QrEngine.ALIGNMENT_PATTERN_POS[version] || [];
        for (let r = 0; r < alignPos.length; r++) {
            for (let c = 0; c < alignPos.length; c++) {
                const pr = alignPos[r];
                const pc = alignPos[c];
                if ((pr <= 8 && pc <= 8) || (pr <= 8 && pc >= size - 8) || (pr >= size - 8 && pc <= 8)) continue;
                for (let dr = -2; dr <= 2; dr++) {
                    for (let dc = -2; dc <= 2; dc++) {
                        matrix[pr + dr][pc + dc] = (Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0)) ? 1 : 0;
                    }
                }
            }
        }

        // 6. Timing patterns
        for (let i = 8; i < size - 8; i++) {
            if (matrix[6][i] === -1) matrix[6][i] = (i % 2 === 0) ? 1 : 0;
            if (matrix[i][6] === -1) matrix[i][6] = (i % 2 === 0) ? 1 : 0;
        }

        // 7. Dark module
        matrix[4 * version + 9][8] = 1;

        // 8. Reserved format information cells
        for (let i = 0; i <= 8; i++) {
            if (matrix[8][i] === -1) matrix[8][i] = 0;
            if (matrix[i][8] === -1) matrix[i][8] = 0;
            if (matrix[8][size - 1 - i] === -1) matrix[8][size - 1 - i] = 0;
            if (matrix[size - 1 - i][8] === -1) matrix[size - 1 - i][8] = 0;
        }

        // 9. Place Data Codewords (Zig-Zag, Mask 0)
        const maskFn = (r, c) => ((r + c) % 2 === 0);
        let codewordIdx = 0;
        let bitIdx = 7;
        let upwards = true;

        for (let col = size - 1; col > 0; col -= 2) {
            if (col === 6) col--;
            const rows = [];
            if (upwards) {
                for (let r = size - 1; r >= 0; r--) rows.push(r);
            } else {
                for (let r = 0; r < size; r++) rows.push(r);
            }
            upwards = !upwards;

            for (const r of rows) {
                for (let c = col; c >= col - 1; c--) {
                    if (matrix[r][c] !== -1) continue;
                    let bit = 0;
                    if (codewordIdx < finalCodewords.length) {
                        bit = (finalCodewords[codewordIdx] >> bitIdx) & 1;
                        bitIdx--;
                        if (bitIdx < 0) {
                            bitIdx = 7;
                            codewordIdx++;
                        }
                    }
                    if (maskFn(r, c)) bit ^= 1;
                    matrix[r][c] = bit;
                }
            }
        }

        // 10. Write Format Info
        const formatBits = QrEngine.FORMAT_INFO_M[0];
        for (let i = 0; i < 15; i++) {
            const b = (formatBits >> (14 - i)) & 1;
            if (i < 6) matrix[8][i] = b;
            else if (i === 6) matrix[8][7] = b;
            else if (i === 7) matrix[8][8] = b;
            else if (i === 8) matrix[7][8] = b;
            else matrix[14 - i][8] = b;

            if (i < 8) matrix[size - 1 - i][8] = b;
            else matrix[8][size - 15 + i] = b;
        }

        return { size, matrix, version };
    }

    /**
     * Canvas要素へQRコードを高速・高精度描画 (QRCode.js / 純JavaScriptフォールバック)
     * カメラ・jsQR認識に必須のクワイエットゾーン（白枠余白）を確実に確保
     */
    static renderToCanvas(canvas, text, options = {}) {
        if (!canvas) return null;
        const size = options.size || canvas.width || 260;
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        const bgColor = options.bgColor || '#ffffff';
        const fgColor = options.fgColor || '#000000';

        // 必須のクワイエットゾーン（余白: QR規格で最低4モジュール、約16〜24px）
        const margin = options.margin !== undefined ? options.margin : Math.max(16, Math.floor(size * 0.08));
        const drawSize = size - margin * 2;

        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, size, size);

        // ① QRCode.js が利用可能な場合 (最優先・高精度)
        if (typeof window.QRCode !== 'undefined') {
            try {
                const tempContainer = document.createElement('div');
                const level = (window.QRCode && window.QRCode.CorrectLevel && window.QRCode.CorrectLevel.L !== undefined) 
                    ? window.QRCode.CorrectLevel.L : (window.QRCode?.CorrectLevel?.M || 0);
                new window.QRCode(tempContainer, {
                    text: String(text),
                    width: drawSize,
                    height: drawSize,
                    colorDark: fgColor,
                    colorLight: bgColor,
                    correctLevel: level
                });

                const srcCanvas = tempContainer.querySelector('canvas');
                if (srcCanvas) {
                    ctx.drawImage(srcCanvas, margin, margin, drawSize, drawSize);
                    return { size, version: 1 };
                }
                const img = tempContainer.querySelector('img');
                if (img) {
                    if (img.complete && img.naturalWidth > 0) {
                        ctx.drawImage(img, margin, margin, drawSize, drawSize);
                    } else {
                        img.onload = () => ctx.drawImage(img, margin, margin, drawSize, drawSize);
                    }
                    return { size, version: 1 };
                }
            } catch (err) {
                console.warn('QRCode.js render failed, fallback to internal engine:', err);
            }
        }

        // ② フォールバック：内蔵 QrEngine
        try {
            const qr = QrEngine.encode(text);
            const fullSize = qr.size + 8; // 4モジュールのマージン
            const moduleSize = size / fullSize;
            ctx.fillStyle = fgColor;

            for (let r = 0; r < qr.size; r++) {
                for (let c = 0; c < qr.size; c++) {
                    if (qr.matrix[r][c] === 1) {
                        const x = (c + 4) * moduleSize;
                        const y = (r + 4) * moduleSize;
                        ctx.fillRect(x, y, moduleSize + 0.35, moduleSize + 0.35);
                    }
                }
            }
            return qr;
        } catch (e) {
            console.error('QrEngine render failed:', e);
            return null;
        }
    }

    // カメラQRスキャナー管理
    static scannerStream = null;
    static scannerAnimId = null;
    static isScanning = false;

    /**
     * 🔊 QRコード認識成功時の快音ビープ音（880Hz -> 1760Hz 80ms）
     */
    static playSuccessBeep() {
        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return;
            const ctx = (typeof AudioUnlocker !== 'undefined' && AudioUnlocker.getContext) 
                ? AudioUnlocker.getContext() 
                : new AudioCtx();
            if (ctx.state === 'suspended') ctx.resume();

            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            const now = ctx.currentTime;
            osc.frequency.setValueAtTime(880, now);
            osc.frequency.exponentialRampToValueAtTime(1760, now + 0.07);
            gain.gain.setValueAtTime(0.25, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(now);
            osc.stop(now + 0.1);
        } catch (e) {}
    }

    /**
     * カメラ起動＆QRコードのリアルタイム検出 (iOS Safari / iPad / iPhone / Android 完全対応)
    /**
     * カメラ起動＆QRコードスキャン開始
     * iOS Safari (WebKit) / Android / PC 完全対応
     * BarcodeDetector (最速ネイティブ) + jsQR マルチスケール（中央高解像度クロップ ＆ 全体フレーム）
     */
    static async startCameraScanner(videoEl, canvasEl, onResult, onStatus) {
        // 既存のカメラセッションを完全停止＆iOSメディアパイプライン同期解放
        this.stopCameraScanner();

        this.isScanning = true;
        if (onStatus) onStatus('📷 カメラを起動中...');

        // マニュアル起動ボタンがあれば一旦非表示にする
        const manualBtns = document.querySelectorAll('.btn-manual-camera-start');
        manualBtns.forEach(btn => btn.style.display = 'none');

        let stream = null;
        // 4段階の即時フォールバックでカメラストリームを確実に取得（iOS Safariのユーザー操作トークンを逃さず即時実行）
        try {
            // 第1希望: 背面カメラ 720p
            stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: { ideal: 'environment' },
                    width: { ideal: 1280 },
                    height: { ideal: 720 }
                },
                audio: false
            });
        } catch (err1) {
            console.warn('Camera tier 1 failed, trying tier 2 (facingMode ideal environment):', err1);
            try {
                // 第2希望: 背面カメラ制約なし (ideal)
                stream = await navigator.mediaDevices.getUserMedia({
                    video: { facingMode: { ideal: 'environment' } },
                    audio: false
                });
            } catch (err2) {
                console.warn('Camera tier 2 failed, trying tier 3 (facingMode string):', err2);
                try {
                    // 第3希望: 背面カメラ文字列
                    stream = await navigator.mediaDevices.getUserMedia({
                        video: { facingMode: 'environment' },
                        audio: false
                    });
                } catch (err3) {
                    console.warn('Camera tier 3 failed, trying tier 4 (generic video):', err3);
                    try {
                        // 第4希望: 任意のカメラ (video: true)
                        stream = await navigator.mediaDevices.getUserMedia({
                            video: true,
                            audio: false
                        });
                    } catch (err4) {
                        console.error('All camera attempts failed:', err4);
                        this.stopCameraScanner();
                        if (onStatus) onStatus('⚠️ カメラの起動に失敗しました。下の「📷 カメラを起動する」ボタンを押してください。');
                        manualBtns.forEach(btn => btn.style.display = 'inline-flex');
                        throw err4;
                    }
                }
            }
        }

        try {
            this.scannerStream = stream;

            // iOS WebKit 必須プロパティ＆属性の設定
            videoEl.muted = true;
            videoEl.playsInline = true;
            videoEl.autoplay = true;
            videoEl.setAttribute('playsinline', 'true');
            videoEl.setAttribute('webkit-playsinline', 'true');
            videoEl.setAttribute('autoplay', 'true');
            videoEl.setAttribute('muted', 'true');
            videoEl.srcObject = stream;

            // iOS WebKit: メタデータ読み込みを待機してから再生
            await new Promise((resolve) => {
                if (videoEl.readyState >= 2) return resolve();
                const onMeta = () => {
                    videoEl.removeEventListener('loadedmetadata', onMeta);
                    resolve();
                };
                videoEl.addEventListener('loadedmetadata', onMeta);
                setTimeout(resolve, 300);
            });

            try {
                await videoEl.play();
            } catch (playErr) {
                console.warn('Initial video play error, attaching touch trigger:', playErr);
                manualBtns.forEach(btn => btn.style.display = 'inline-flex');
                const resumeTouch = () => {
                    videoEl.play().then(() => {
                        manualBtns.forEach(btn => btn.style.display = 'none');
                    }).catch(() => {});
                };
                videoEl.parentElement?.addEventListener('touchstart', resumeTouch, { once: true });
                videoEl.parentElement?.addEventListener('click', resumeTouch, { once: true });
            }

            if (onStatus) onStatus('🔍 QRコードを枠内に映してください...');

            const scanCanvas = canvasEl || document.createElement('canvas');
            const scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true });

            let lastScanTime = 0;
            const scanInterval = 45; // 45ms間隔（約22fps）で超高レスポンススキャン
            let frameCount = 0;

            const hasBarcodeDetector = ('BarcodeDetector' in window);
            let nativeDetector = null;
            if (hasBarcodeDetector) {
                try {
                    nativeDetector = new window.BarcodeDetector({ formats: ['qr_code'] });
                } catch (e) {
                    nativeDetector = null;
                }
            }

            const scanLoop = async () => {
                if (!this.isScanning) return;

                const now = performance.now();
                if (now - lastScanTime >= scanInterval && videoEl.readyState >= 2 && videoEl.videoWidth > 0) {
                    lastScanTime = now;
                    frameCount++;
                    let detected = false;
                    let detectedData = null;

                    // ① ネイティブ BarcodeDetector (iOS 17+ / Chrome / Edge 最速検出)
                    if (nativeDetector) {
                        try {
                            const barcodes = await nativeDetector.detect(videoEl);
                            if (barcodes && barcodes.length > 0 && barcodes[0].rawValue) {
                                detected = true;
                                detectedData = barcodes[0].rawValue;
                            }
                        } catch (bdErr) {}
                    }

                    // ② jsQR デュアルスケール（中央高解像度クロップ ＆ 全体フレーム）
                    if (!detected && typeof window.jsQR === 'function') {
                        try {
                            const vw = videoEl.videoWidth;
                            const vh = videoEl.videoHeight;

                            // パスA: 中央レティクル領域の高解像度クロップ（手ブレや距離に強い）
                            const cropSize = Math.min(vw, vh) * 0.75;
                            const sx = (vw - cropSize) / 2;
                            const sy = (vh - cropSize) / 2;
                            const cropTargetSize = 512;

                            if (scanCanvas.width !== cropTargetSize || scanCanvas.height !== cropTargetSize) {
                                scanCanvas.width = cropTargetSize;
                                scanCanvas.height = cropTargetSize;
                            }

                            scanCtx.drawImage(videoEl, sx, sy, cropSize, cropSize, 0, 0, cropTargetSize, cropTargetSize);
                            const cropImgData = scanCtx.getImageData(0, 0, cropTargetSize, cropTargetSize);
                            const cropCode = window.jsQR(cropImgData.data, cropTargetSize, cropTargetSize, {
                                inversionAttempts: 'attemptBoth'
                            });

                            if (cropCode && cropCode.data) {
                                detected = true;
                                detectedData = cropCode.data;
                            } else if (frameCount % 2 === 0) {
                                // パスB: 全体フレームスキャン（画面いっぱいに近づけた場合に対応）
                                const scale = Math.min(1, 640 / Math.max(vw, vh));
                                const sw = Math.round(vw * scale);
                                const sh = Math.round(vh * scale);
                                scanCanvas.width = sw;
                                scanCanvas.height = sh;
                                scanCtx.drawImage(videoEl, 0, 0, sw, sh);
                                const fullImgData = scanCtx.getImageData(0, 0, sw, sh);
                                const fullCode = window.jsQR(fullImgData.data, sw, sh, {
                                    inversionAttempts: 'attemptBoth'
                                });
                                if (fullCode && fullCode.data) {
                                    detected = true;
                                    detectedData = fullCode.data;
                                }
                            }
                        } catch (e) {}
                    }

                    if (detected && detectedData) {
                        this.playSuccessBeep();
                        try { navigator.vibrate?.([60, 40, 60]); } catch (v) {}
                        
                        // ファインダーのビジュアルフィードバック（緑色フラッシュ）
                        const reticle = videoEl.parentElement?.querySelector('.p2p-scan-reticle');
                        if (reticle) reticle.classList.add('detected');

                        onResult(detectedData);
                        return;
                    }
                }

                if (this.isScanning) {
                    this.scannerAnimId = requestAnimationFrame(scanLoop);
                }
            };

            this.scannerAnimId = requestAnimationFrame(scanLoop);
            return true;
        } catch (err) {
            console.error('Camera stream attachment failed:', err);
            this.stopCameraScanner();
            if (onStatus) onStatus('⚠️ カメラの起動に失敗しました。下の「📷 カメラを起動する」ボタンを押してください。');
            manualBtns.forEach(btn => btn.style.display = 'inline-flex');
            throw err;
        }
    }

    /**
     * カメラの完全停止とMediaStreamハードウェア占有の確実な解放
     * （iOS Safariでのモード切替時のカメラフリーズを完全防止）
     */
    static stopCameraScanner() {
        this.isScanning = false;
        if (this.scannerAnimId) {
            cancelAnimationFrame(this.scannerAnimId);
            this.scannerAnimId = null;
        }
        if (this.scannerStream) {
            this.scannerStream.getTracks().forEach(track => {
                try {
                    track.stop();
                } catch (e) {}
            });
            this.scannerStream = null;
        }

        // iOS Safari対応: 全スキャナー用video要素のsrcObjectをクリア＆pause＆load
        ['p2p-scanner-video', 'p2p-send-scanner-video'].forEach(id => {
            const v = document.getElementById(id);
            if (v) {
                try {
                    v.pause();
                    v.srcObject = null;
                    v.load();
                } catch (e) {}
            }
        });

        // レティクルの検出スタイルをリセット
        document.querySelectorAll('.p2p-scan-reticle.detected').forEach(r => r.classList.remove('detected'));
    }
}

// ==================== 3.6 🌐 WebRTC / P2P データ転送エンジン ====================
class WebRtcEngine {
    static RTC_CONFIG = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun.cloudflare.com:3478' }
        ],
        iceCandidatePoolSize: 2
    };

    /**
     * WebRTC SDP を超軽量・大粒QRコード格納用フォーマットに極限圧縮
     * （不要候補の完全除去 & FingerprintのバイナリBase64化によりQRドット数を激減）
     */
    static compressSdp(sdpStr, sdpType) {
        const ufrag = (sdpStr.match(/a=ice-ufrag:(.+)/) || [])[1] || '';
        const pwd = (sdpStr.match(/a=ice-pwd:(.+)/) || [])[1] || '';
        const fp = ((sdpStr.match(/a=fingerprint:sha-256 (.+)/) || [])[1] || '').replace(/:/g, '').trim();
        const setup = (sdpStr.match(/a=setup:(.+)/) || [])[1] || 'actpass';
        
        const cands = [];
        const seen = new Set();
        const candMatches = sdpStr.matchAll(/a=candidate:(\S+ \d+ (udp|TCP) \d+ (\S+) (\d+) typ (\S+)(?: raddr \S+ rport \d+)?)/gi);
        for (const m of candMatches) {
            const proto = (m[2] || '').toLowerCase();
            const ip = m[3];
            const port = parseInt(m[4], 10);
            const typ = (m[5] || '').toLowerCase();
            // Wi-FiローカルP2Pでは不要なTCP候補（ポート9）を除外
            if (proto === 'tcp') continue;
            const key = `${ip}:${port}`;
            if (!seen.has(key)) {
                seen.add(key);
                cands.push([ip, port, typ === 'srflx' ? 1 : 0]);
            }
        }

        // 64文字のHexフィンガープリントを32バイトBase64（44文字）に超圧縮
        let fpB64 = '';
        try {
            const bytes = new Uint8Array(32);
            for (let i = 0; i < 32; i++) {
                bytes[i] = parseInt(fp.substr(i * 2, 2), 16);
            }
            fpB64 = btoa(String.fromCharCode.apply(null, bytes));
        } catch (e) {
            fpB64 = fp;
        }

        const compactArr = [
            sdpType === 'offer' ? 'o' : 'a',
            ufrag.trim(),
            pwd.trim(),
            fpB64,
            setup === 'actpass' ? 'p' : 'a',
            cands
        ];

        return 'vpad_rtc_' + (sdpType === 'offer' ? 'o' : 'a') + ':' + btoa(JSON.stringify(compactArr));
    }

    /**
     * 圧縮された超軽量QRコード文字列から WebRTC SDP を完全復元
     */
    static decompressSdp(payload) {
        const isOffer = payload.startsWith('vpad_rtc_o:') || payload.startsWith('vpad_rtc_offer:');
        const prefix = payload.startsWith('vpad_rtc_o:') ? 'vpad_rtc_o:' :
                       payload.startsWith('vpad_rtc_a:') ? 'vpad_rtc_a:' :
                       payload.startsWith('vpad_rtc_offer:') ? 'vpad_rtc_offer:' : 'vpad_rtc_answer:';
        const b64 = payload.slice(prefix.length);
        const data = JSON.parse(atob(b64));

        let sdpType = 'offer';
        let u = '', p = '', fp = '', s = 'actpass';
        let cands = [];

        if (Array.isArray(data)) {
            // 超軽量配列フォーマット
            sdpType = data[0] === 'o' ? 'offer' : 'answer';
            u = data[1] || '';
            p = data[2] || '';
            const rawFpB64 = data[3] || '';
            if (rawFpB64.length === 44) {
                const bin = atob(rawFpB64);
                const hexArr = [];
                for (let i = 0; i < bin.length; i++) {
                    hexArr.push(('0' + bin.charCodeAt(i).toString(16).toUpperCase()).slice(-2));
                }
                fp = hexArr.join(':');
            } else {
                fp = rawFpB64;
            }
            s = data[4] === 'p' ? 'actpass' : 'active';
            const rawCands = data[5] || [];
            for (let i = 0; i < rawCands.length; i++) {
                const [cIp, cPort, cTypeFlag] = rawCands[i];
                const typ = cTypeFlag === 1 ? 'srflx' : 'host';
                const prio = typ === 'host' ? 2122260223 : 1686052607;
                cands.push(`1 1 udp ${prio} ${cIp} ${cPort} typ ${typ}`);
            }
        } else {
            // 後方互換オブジェクトフォーマット
            sdpType = data.t || (isOffer ? 'offer' : 'answer');
            u = data.u || '';
            p = data.p || '';
            const rawFp = data.f || '';
            let fpParts = [];
            for (let i = 0; i < rawFp.length; i += 2) {
                fpParts.push(rawFp.substr(i, 2));
            }
            fp = fpParts.join(':');
            s = data.s || (sdpType === 'offer' ? 'actpass' : 'active');
            cands = data.c || [];
        }

        const lines = [
            "v=0",
            "o=- " + Date.now() + " 2 IN IP4 127.0.0.1",
            "s=-",
            "t=0 0",
            "a=group:BUNDLE 0",
            "a=msid-semantic: WMS",
            "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
            "c=IN IP4 0.0.0.0"
        ];
        for (const cand of cands) {
            lines.push(cand.startsWith('a=candidate:') ? cand : `a=candidate:${cand}`);
        }
        lines.push(
            `a=ice-ufrag:${u}`,
            `a=ice-pwd:${p}`,
            "a=ice-options:trickle",
            `a=fingerprint:sha-256 ${fp}`,
            `a=setup:${s}`,
            "a=mid:0",
            "a=sctp-port:5000",
            "a=max-message-size:262144",
            ""
        );
        return { sdp: lines.join('\r\n'), type: sdpType };
    }

    static activeSender = null;
    static activeReceiver = null;

    /**
     * 生徒側：WebRTC 送信セッションの起動（SDP Offer 生成 & DataChannel 準備）
     * 16KBチャンク分割送信により大容量音声データも安全・確実に転送
     */
    static async startSenderSession(exportObj, onOfferReady, onStatus, onComplete) {
        this.stopSenderSession();

        const pc = new RTCPeerConnection(this.RTC_CONFIG);
        const dataChannel = pc.createDataChannel('vpad-channel', { ordered: true });

        const session = {
            pc,
            dataChannel,
            exportObj,
            offerPayload: '',
            isAnswerApplied: false,
            isComplete: false
        };

        dataChannel.onopen = async () => {
            if (onStatus) onStatus('⚡ WebRTC Wi-Fi接続完了！データを送信中...');
            try {
                const jsonPayload = JSON.stringify(exportObj);
                const CHUNK_SIZE = 16384; // 16KB (全ブラウザ安全サイズ)
                const totalChunks = Math.ceil(jsonPayload.length / CHUNK_SIZE);
                const msgId = 'msg_' + Date.now().toString(36);

                for (let i = 0; i < totalChunks; i++) {
                    const chunk = jsonPayload.substring(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
                    const packet = JSON.stringify({
                        type: 'vpad_rtc_chunk',
                        id: msgId,
                        idx: i,
                        tot: totalChunks,
                        data: chunk
                    });

                    while (dataChannel.bufferedAmount > 65536) {
                        await new Promise(r => setTimeout(r, 10));
                    }
                    dataChannel.send(packet);

                    if (onStatus && totalChunks > 1) {
                        onStatus(`⚡ 送信中: ${Math.round(((i + 1) / totalChunks) * 100)}%...`);
                    }
                }
            } catch (err) {
                console.error('DataChannel send error:', err);
                if (onStatus) onStatus(`⚠️ 送信エラー: ${err.message}`);
            }
        };

        dataChannel.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);
                if (msg.type === 'ack' && !session.isComplete) {
                    session.isComplete = true;
                    if (onComplete) onComplete(exportObj);
                }
            } catch (err) {}
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        // ICE candidate 収集待機
        await new Promise((resolve) => {
            if (pc.iceGatheringState === 'complete') resolve();
            else {
                const checkState = () => {
                    if (pc.iceGatheringState === 'complete') {
                        pc.removeEventListener('icegatheringstatechange', checkState);
                        resolve();
                    }
                };
                pc.addEventListener('icegatheringstatechange', checkState);
                setTimeout(() => {
                    pc.removeEventListener('icegatheringstatechange', checkState);
                    resolve();
                }, 1000);
            }
        });

        const offerPayload = this.compressSdp(pc.localDescription.sdp, 'offer');
        session.offerPayload = offerPayload;
        this.activeSender = session;

        if (onOfferReady) onOfferReady(offerPayload);
        return session;
    }

    /**
     * 生徒側：先生の Answer QR を適用して Wi-Fi DataChannel を開通
     */
    static async applyAnswerToSender(answerPayload, onStatus, onComplete) {
        if (!this.activeSender || !this.activeSender.pc) {
            throw new Error('送信セッションが初期化されていません');
        }
        if (this.activeSender.isAnswerApplied) return;

        this.activeSender.isAnswerApplied = true;
        if (onStatus) onStatus('⚡ 先生の応答を確認しました。Wi-Fi接続中...');

        const answerObj = this.decompressSdp(answerPayload);
        await this.activeSender.pc.setRemoteDescription(new RTCSessionDescription(answerObj));
    }

    static stopSenderSession() {
        if (this.activeSender) {
            try {
                if (this.activeSender.dataChannel) this.activeSender.dataChannel.close();
                if (this.activeSender.pc) this.activeSender.pc.close();
            } catch (e) {}
            this.activeSender = null;
        }
    }

    /**
     * 先生側：生徒の Offer QR を受け取り、Answer QR を生成して待機
     */
    static async handleOfferOnReceiver(offerPayload, onAnswerReady, onDataReceived, onStatus) {
        this.stopReceiverSession();

        const pc = new RTCPeerConnection(this.RTC_CONFIG);
        const session = {
            pc,
            dataChannel: null,
            isComplete: false,
            chunksBuffer: {}
        };

        pc.ondatachannel = (e) => {
            const channel = e.channel;
            session.dataChannel = channel;

            channel.onopen = () => {
                if (onStatus) onStatus('⚡ WebRTC Wi-Fi接続完了！データを受信しています...');
            };

            channel.onmessage = (msgEvt) => {
                try {
                    const packet = JSON.parse(msgEvt.data);
                    if (packet.type === 'vpad_rtc_chunk') {
                        if (!session.chunksBuffer[packet.id]) {
                            session.chunksBuffer[packet.id] = new Array(packet.tot);
                        }
                        session.chunksBuffer[packet.id][packet.idx] = packet.data;
                        const receivedCount = session.chunksBuffer[packet.id].filter(Boolean).length;

                        if (onStatus && packet.tot > 1) {
                            onStatus(`📥 受信中: ${Math.round((receivedCount / packet.tot) * 100)}%...`);
                        }

                        if (receivedCount === packet.tot) {
                            const fullJson = session.chunksBuffer[packet.id].join('');
                            delete session.chunksBuffer[packet.id];
                            const data = JSON.parse(fullJson);
                            try { channel.send(JSON.stringify({ type: 'ack', ok: true })); } catch (err) {}
                            if (!session.isComplete) {
                                session.isComplete = true;
                                if (onDataReceived) onDataReceived(data);
                            }
                        }
                    } else if (packet.slot || packet.type === 'voicepad_slot') {
                        try { channel.send(JSON.stringify({ type: 'ack', ok: true })); } catch (err) {}
                        if (!session.isComplete) {
                            session.isComplete = true;
                            if (onDataReceived) onDataReceived(packet);
                        }
                    }
                } catch (err) {
                    console.error('DataChannel message parse error:', err);
                }
            };
        };

        const offerObj = this.decompressSdp(offerPayload);
        await pc.setRemoteDescription(new RTCSessionDescription(offerObj));

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        // ICE candidate 収集待機
        await new Promise((resolve) => {
            if (pc.iceGatheringState === 'complete') resolve();
            else {
                const checkState = () => {
                    if (pc.iceGatheringState === 'complete') {
                        pc.removeEventListener('icegatheringstatechange', checkState);
                        resolve();
                    }
                };
                pc.addEventListener('icegatheringstatechange', checkState);
                setTimeout(() => {
                    pc.removeEventListener('icegatheringstatechange', checkState);
                    resolve();
                }, 1000);
            }
        });

        const answerPayload = this.compressSdp(pc.localDescription.sdp, 'answer');
        session.answerPayload = answerPayload;
        this.activeReceiver = session;

        if (onAnswerReady) onAnswerReady(answerPayload);
        return answerPayload;
    }

    static stopReceiverSession() {
        if (this.activeReceiver) {
            try {
                if (this.activeReceiver.dataChannel) this.activeReceiver.dataChannel.close();
                if (this.activeReceiver.pc) this.activeReceiver.pc.close();
            } catch (e) {}
            this.activeReceiver = null;
        }
    }
}

class P2PDataEngine {
    static activeSenderPeer = null;
    static activeSenderConn = null;
    static activeReceiverPeer = null;

    /**
     * 生徒側：Wi-Fi 直接送信ホストの起動
     * 画面には「1枚の静的QRコード（ルームID）」のみを表示し、
     * 先生が1回スキャンするだけでWebRTC DataChannel経由で音声・ボタン全データを直接高速転送
     */
    static async startWifiSender(exportObj, onQrReady, onStatus, onComplete) {
        this.stopWifiSession();

        const roomId = 'vpad_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 5);
        const qrPayload = `vpad_p2p:${roomId}`;

        if (onStatus) onStatus('📡 Wi-Fi待受中... 先生のカメラで読み取ってください');

        // QRコードは即座に1枚表示（ルームIDが確定しているため待機ゼロ）
        if (onQrReady) onQrReady(qrPayload);

        try {
            if (typeof Peer === 'undefined') {
                throw new Error('PeerJS ライブラリが読み込まれていません');
            }

            const peer = new Peer(roomId, {
                debug: 1,
                config: {
                    iceServers: [
                        { urls: 'stun:stun.l.google.com:19302' },
                        { urls: 'stun:stun1.l.google.com:19302' },
                        { urls: 'stun:stun.cloudflare.com:3478' }
                    ]
                }
            });
            this.activeSenderPeer = peer;

            peer.on('open', (id) => {
                console.log('[P2P Wi-Fi Sender] Room ready with ID:', id);
                if (onStatus) onStatus('先生のカメラからの読み取りを待っています... (QRコードは1枚のみ)');
            });

            peer.on('connection', (conn) => {
                this.activeSenderConn = conn;
                if (onStatus) onStatus('⚡ 接続確立！Wi-Fi経由でデータを送信中...');

                const sendData = () => {
                    try {
                        conn.send(exportObj);
                        console.log('[P2P Wi-Fi Sender] Data sent over DataChannel');
                    } catch (e) {
                        console.error('[P2P Wi-Fi Sender] Send error:', e);
                        if (onStatus) onStatus(`⚠️ 送信エラー: ${e.message}`);
                    }
                };

                if (conn.open) {
                    sendData();
                } else {
                    conn.on('open', sendData);
                }

                conn.on('data', (msg) => {
                    if (msg && msg.type === 'ack') {
                        console.log('[P2P Wi-Fi Sender] ACK received from receiver');
                        if (onStatus) onStatus('🎉 送信完了しました！');
                        if (onComplete) onComplete(exportObj);
                    }
                });

                conn.on('error', (err) => {
                    console.error('[P2P Wi-Fi Sender] Connection error:', err);
                });
            });

            peer.on('error', (err) => {
                console.warn('[P2P Wi-Fi Sender] Peer error:', err);
                if (onStatus && err.type !== 'peer-unavailable') {
                    onStatus(`⚠️ 通信ステータス: ${err.type || '待機中'}`);
                }
            });

            return { roomId, qrPayload };
        } catch (err) {
            console.error('[P2P Wi-Fi Sender] Init error:', err);
            if (onStatus) onStatus('⚠️ Wi-Fi初期化エラー');
            return { roomId, qrPayload };
        }
    }

    /**
     * 先生側：生徒のQRコード（1枚）をスキャンした時のWi-Fi直接受信処理
     * QRコードからルームIDを取り出し、WebRTC DataChannelで瞬時にデータを受信してACK返信
     */
    static async handleWifiReceiverScan(qrPayload, onStatus, onDataReceived) {
        if (!qrPayload || !qrPayload.startsWith('vpad_p2p:')) return false;
        const roomId = qrPayload.replace('vpad_p2p:', '').trim();
        if (!roomId) return false;

        if (this.activeReceiverPeer) {
            try { this.activeReceiverPeer.destroy(); } catch (e) {}
            this.activeReceiverPeer = null;
        }

        if (onStatus) onStatus('⚡ Wi-Fi接続を確立中...');

        return new Promise((resolve) => {
            if (typeof Peer === 'undefined') {
                if (onStatus) onStatus('⚠️ PeerJS ライブラリが見つかりません');
                resolve(false);
                return;
            }

            const rcvPeer = new Peer({
                debug: 1,
                config: {
                    iceServers: [
                        { urls: 'stun:stun.l.google.com:19302' },
                        { urls: 'stun:stun1.l.google.com:19302' },
                        { urls: 'stun:stun.cloudflare.com:3478' }
                    ]
                }
            });
            this.activeReceiverPeer = rcvPeer;

            let isCompleted = false;

            const timeoutId = setTimeout(() => {
                if (!isCompleted) {
                    if (onStatus) onStatus('⚠️ 接続待機中... もう一度生徒のQRコードをかざしてください');
                    resolve(false);
                }
            }, 18000);

            rcvPeer.on('open', () => {
                if (onStatus) onStatus('⚡ 送信者へWi-Fi接続中...');
                const conn = rcvPeer.connect(roomId, { reliable: true });

                conn.on('open', () => {
                    if (onStatus) onStatus('📥 ボタンデータを受信中...');
                });

                conn.on('data', (data) => {
                    if (!isCompleted && data && (data.slot || data.type === 'voicepad_slot' || data.type === 'voicepad_scroll' || data.label)) {
                        isCompleted = true;
                        clearTimeout(timeoutId);

                        // ACKを送信側に即時返信
                        try {
                            conn.send({ type: 'ack', ok: true });
                        } catch (e) {}

                        if (onStatus) onStatus('✅ 受信完了！データを保存しています...');
                        if (onDataReceived) onDataReceived(data);

                        setTimeout(() => {
                            try { rcvPeer.destroy(); } catch (e) {}
                            if (this.activeReceiverPeer === rcvPeer) {
                                this.activeReceiverPeer = null;
                            }
                        }, 1200);

                        resolve(true);
                    }
                });

                conn.on('error', (err) => {
                    console.error('[P2P Wi-Fi Receiver] Conn error:', err);
                });
            });

            rcvPeer.on('error', (err) => {
                console.warn('[P2P Wi-Fi Receiver] Peer error:', err);
                if (onStatus) onStatus(`⚠️ 接続エラー: ${err.type || '通信待機中'}`);
            });
        });
    }

    /**
     * Wi-Fi P2P 送信・受信セッションの完全終了
     */
    static stopWifiSession() {
        if (this.activeSenderConn) {
            try { this.activeSenderConn.close(); } catch (e) {}
            this.activeSenderConn = null;
        }
        if (this.activeSenderPeer) {
            try { this.activeSenderPeer.destroy(); } catch (e) {}
            this.activeSenderPeer = null;
        }
        if (this.activeReceiverPeer) {
            try { this.activeReceiverPeer.destroy(); } catch (e) {}
            this.activeReceiverPeer = null;
        }
    }

    /**
     * 単一直接QRコード (小さいデータ / オフライン) のデコード
     */
    static processDetectedPayload(qrString) {
        if (!qrString || typeof qrString !== 'string') return null;

        // ① 単一直接QRコード (vpad:direct:...)
        if (qrString.startsWith('vpad:direct:')) {
            try {
                const raw = decodeURIComponent(qrString.slice(12));
                const parsed = JSON.parse(raw);
                const label = parsed.slot?.label || parsed.label || 'ボタン';
                const fileName = `VoicePad_ボタン_${label.replace(/[\\/:*?"<>|]/g, '_')}.vpad-button`;
                return { complete: true, data: parsed, fileName };
            } catch (e) {
                console.error('Failed to parse direct QR payload:', e);
                return null;
            }
        }

        // ② 既存互換（生JSONまたはvpad://）
        if (qrString.startsWith('{') || qrString.startsWith('vpad://')) {
            try {
                const raw = qrString.startsWith('vpad://') ? decodeURIComponent(qrString.slice(7)) : qrString;
                const parsed = JSON.parse(raw);
                const btnData = (parsed.type === 'vpad_direct_btn' && parsed.data) ? parsed.data : parsed;
                const label = btnData.slot?.label || btnData.label || 'ボタン';
                const fileName = `VoicePad_ボタン_${label.replace(/[\\/:*?"<>|]/g, '_')}.vpad-button`;
                return { complete: true, data: btnData, fileName };
            } catch (e) {}
        }

        return null;
    }
}


// ==================== 4. メインアプリケーションロジック ====================
class VoicePadApp {
    constructor() {
        this.storage = new StorageManager();
        this.audioCtx = null;
        this.mediaRecorder = null;
        this.pcmRecorder = null;
        this.audioStream = null;

        this.currentMode = 'play';
        this.recordingSlotId = null;
        this.recordedChunks = [];
        this.recTimer = null;
        this.recStartTime = 0;
        this.recSeconds = 0;
        this.pcmRecorderHandled = false;

        // 🎙️ Voicemod / 2ステージ直列DSP & EQパラメータ（全体基本）
        this.globalVoiceParams = VoiceEngine.defaultVoiceParams();
        this.globalEnvParams = VoiceEngine.defaultEnvParams();
        this.globalEqParams = { bass: 0, mid: 0, treble: 0 };
        this.currentEffect = 'normal'; // 旧プリセット名（互換用）
        this.globalPlaybackSpeed = 1.0; // 全体基本再生スピード
        this.globalVolume = 1.0; // 🔊 全体マスター音量 (0.1〜3.0)
        this.globalSoftClip = true; // 🛡️ 音割れ防止（ソフトクリッピング）

        this.scrolls = [];
        this.currentScrollId = null;
        this.slots = [];

        this.pageSize = 32;
        this.currentPage = 1;

        this.activeSources = new Map();

        this.editingSlotId = null;
        this.editingScrollId = null;
        this.editingImageUrl = null;
        this.editingImageScale = 1.0;
        this.editingImageOffsetX = 0;
        this.editingImageOffsetY = 0;
        this.editingImageFit = 'cover';

        this.dragScrollId = null;
        this.dragTimer = null;
        this.isDraggingScroll = false;

        this.dragSlotId = null;
        this.padDragTimer = null;
        this.isDraggingPad = false;

        // 🎨 テーマ
        this.currentTheme = 'theme-dark';

        // 🤖 AI TTS
        this.ttsVoices = [];

        // ✂️ 波形エディター
        this.waveformAudioBuffer = null;
        this.trimStartSec = 0;
        this.trimEndSec = 0;
        this.waveformPreviewSource = null;
        this.waveformPlayheadAnim = null;

        // 🎹 AAC & MIDI
        this.aacScanActive = false;
        this.aacScanSpeed = 1.5;
        this.aacScanMode = 'auto';
        this.aacScanIndex = -1;
        this.aacScanTimer = null;
        this.midiAccess = null;

        // 📲 受信データ一時保持
        this.incomingData = null;
        this.incomingAudioPreviewNode = null;

        // プレビュー用音声ノード
        this.fxPreviewSource = null;

        // 🗂️ スクロールまとめ（マージ）モード
        this.isMergeMode = false;
        this.selectedScrollIdsForMerge = new Set();

        this.init();
    }

    async init() {
        AudioUnlocker.initListeners();
        this.audioCtx = AudioUnlocker.getContext();

        const badge = document.getElementById('app-version-badge');
        if (badge) badge.innerText = `v${APP_VERSION}`;

        await this.storage.init();
        await this.loadAllData();

        this.renderScrollTabs();
        this.renderSlots();
        this.initEvents();

        this.initTheme();
        this.initTTS();
        this.initGlobalAudioControls();
        this.initWaveformEvents();
        this.initKeyboardAndMidi();
        this.initAACScanController();
        this.initIncomingShareAndDropzone();
        this.initVoiceEngineUIEvents();
    }

    async loadAllData() {
        this.pageSize = await this.storage.getSetting('pageSize', 32);
        this.globalPlaybackSpeed = await this.storage.getSetting('globalPlaybackSpeed', 1.0);
        this.globalVolume = await this.storage.getSetting('globalVolume', 1.0);
        this.globalSoftClip = await this.storage.getSetting('globalSoftClip', true);
        this.updateGlobalAudioUI();
        
        // 全体ボイスパラメータのロード
        const savedVoiceParams = await this.storage.getSetting('globalVoiceParams', null);
        const savedEnvParams = await this.storage.getSetting('globalEnvParams', null);
        const savedEffect = await this.storage.getSetting('effect', 'normal');

        if (savedVoiceParams) {
            this.globalVoiceParams = savedVoiceParams;
        } else if (savedEffect && savedEffect !== 'normal') {
            const mapped = VoiceEngine.presetToParams(savedEffect);
            this.globalVoiceParams = mapped.voice;
        } else {
            this.globalVoiceParams = VoiceEngine.defaultVoiceParams();
        }

        if (savedEnvParams) {
            this.globalEnvParams = savedEnvParams;
        } else if (savedEffect && savedEffect !== 'normal') {
            const mapped = VoiceEngine.presetToParams(savedEffect);
            this.globalEnvParams = mapped.env;
        } else {
            this.globalEnvParams = VoiceEngine.defaultEnvParams();
        }

        const savedEqParams = await this.storage.getSetting('globalEqParams', null);
        this.globalEqParams = savedEqParams || { bass: 0, mid: 0, treble: 0 };

        this.currentEffect = savedEffect;
        this.currentTheme = await this.storage.getSetting('theme', 'theme-dark');
        this.applyTheme(this.currentTheme);

        this.aacScanActive = await this.storage.getSetting('aacScanActive', false);
        this.aacScanSpeed = await this.storage.getSetting('aacScanSpeed', 1.5);
        this.aacScanMode = await this.storage.getSetting('aacScanMode', 'auto');

        const effectEl = document.getElementById('voice-effect');
        if (effectEl) effectEl.value = this.currentEffect;

        const pageSizeSelect = document.getElementById('setting-page-size');
        if (pageSizeSelect) pageSizeSelect.value = String(this.pageSize);

        const globalSpeedSelect = document.getElementById('setting-global-speed');
        if (globalSpeedSelect) globalSpeedSelect.value = String(this.globalPlaybackSpeed);

        const themeSelect = document.getElementById('setting-theme-select');
        if (themeSelect) themeSelect.value = this.currentTheme;

        // 全体設定モーダルへのUI反映
        this.setFxParamsToUI('global', this.globalVoiceParams, this.globalEnvParams, this.globalEqParams);

        this.scrolls = await this.storage.getAllScrolls();
        this.slots = await this.storage.getAllSlots();

        const savedScrollId = await this.storage.getSetting('currentScrollId', null);
        if (savedScrollId && this.scrolls.some(s => s.id === savedScrollId)) {
            this.currentScrollId = savedScrollId;
        } else if (this.scrolls.length > 0) {
            this.currentScrollId = this.scrolls[0].id;
        } else {
            const initialScroll = {
                id: 'scroll_' + Date.now(),
                name: 'メイン',
                order: 0,
                voiceEffect: 'inherit',
                voiceEffectMode: 'inherit',
                voiceParams: VoiceEngine.defaultVoiceParams(),
                envParams: VoiceEngine.defaultEnvParams(),
                eqParams: { bass: 0, mid: 0, treble: 0 },
                specialParams: null,
                playbackSpeed: 'inherit',
                createdAt: Date.now()
            };
            await this.storage.saveScroll(initialScroll);
            this.scrolls.push(initialScroll);
            this.currentScrollId = initialScroll.id;
        }

        // 現在のスクロールにスロットが1つも無ければ、標準8個のスイッチを作成
        const currentScrollSlots = this.slots.filter(s => s.scrollId === this.currentScrollId);
        if (currentScrollSlots.length === 0) {
            const emojis = ['🔴', '🟠', '🟡', '🟢', '🔵', '🔷', '🟣', '🌸'];
            for (let i = 1; i <= 8; i++) {
                const initialSlot = {
                    id: 'slot_' + Date.now() + '_' + i,
                    scrollId: this.currentScrollId,
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
                    voiceEffect: 'inherit',
                    voiceEffectMode: 'inherit',
                    voiceParams: null,
                    envParams: null,
                    eqParams: null,
                    specialParams: null,
                    playbackSpeed: 'inherit',
                    order: i
                };
                await this.storage.saveSlot(initialSlot);
                this.slots.push(initialSlot);
            }
        }
    }

    applyTheme(themeName) {
        this.currentTheme = themeName || 'theme-dark';
        const themes = ['theme-dark', 'theme-neon', 'theme-pastel', 'theme-highcontrast', 'theme-mint'];
        themes.forEach(t => document.body.classList.remove(t));
        document.body.classList.add(this.currentTheme);

        const themeSelect = document.getElementById('setting-theme-select');
        if (themeSelect && themeSelect.value !== this.currentTheme) {
            themeSelect.value = this.currentTheme;
        }
    }

    initTheme() {
        const themeSelect = document.getElementById('setting-theme-select');
        if (themeSelect) {
            themeSelect.addEventListener('change', async (e) => {
                const selected = e.target.value;
                this.applyTheme(selected);
                await this.storage.saveSetting('theme', selected);
                this.showToast('🎨 テーマを適用しました');
            });
        }
        this.applyTheme(this.currentTheme);
    }

    // ==================== 🔊 グローバル音量＆ソフトクリッピング制御 ====================
    initGlobalAudioControls() {
        const slider = document.getElementById('global-volume-slider');
        const softClipToggle = document.getElementById('global-softclip-toggle');

        this.updateGlobalAudioUI();

        if (slider) {
            slider.addEventListener('input', async (e) => {
                const val = parseFloat(e.target.value);
                this.globalVolume = isNaN(val) ? 1.0 : Math.max(0.1, Math.min(3.0, val));
                this.updateGlobalAudioUI();
                await this.storage.saveSetting('globalVolume', this.globalVolume);
            });
        }

        if (softClipToggle) {
            softClipToggle.addEventListener('change', async (e) => {
                this.globalSoftClip = e.target.checked;
                await this.storage.saveSetting('globalSoftClip', this.globalSoftClip);
                this.showToast(this.globalSoftClip ? '🛡️ 音割れ防止（ソフトクリップ）をONにしました' : '⚠️ 音割れ防止をOFFにしました');
            });
        }
    }

    updateGlobalAudioUI() {
        const slider = document.getElementById('global-volume-slider');
        const valLabel = document.getElementById('global-volume-val');
        const softClipToggle = document.getElementById('global-softclip-toggle');

        const vol = (this.globalVolume !== undefined && this.globalVolume !== null) ? this.globalVolume : 1.0;
        if (slider && Math.abs(parseFloat(slider.value) - vol) > 0.001) {
            slider.value = vol;
        }
        if (valLabel) {
            valLabel.innerText = `${vol.toFixed(2)}x${vol > 1.0 ? ' 🚀' : ''}`;
        }
        if (softClipToggle) {
            softClipToggle.checked = (this.globalSoftClip !== undefined) ? this.globalSoftClip : true;
        }
    }

    getCurrentSlots() {
        return this.slots
            .filter(s => s.scrollId === this.currentScrollId)
            .sort((a, b) => (a.order || 0) - (b.order || 0));
    }

    // ==================== 階層的ボイスエフェクト＆再生スピード計算 ====================
    getEffectiveVoiceParams(slot) {
        // 1. スイッチ個別設定チェック
        if (slot) {
            if (slot.voiceEffectMode === 'custom' && slot.voiceParams) {
                return slot.voiceParams;
            }
            if (slot.voiceEffect && slot.voiceEffect !== 'inherit') {
                return VoiceEngine.presetToParams(slot.voiceEffect).voice;
            }
        }
        // 2. スクロール設定チェック
        const scroll = this.scrolls.find(s => s.id === (slot ? slot.scrollId : this.currentScrollId));
        if (scroll) {
            if (scroll.voiceEffectMode === 'custom' && scroll.voiceParams) {
                return scroll.voiceParams;
            }
            if (scroll.voiceEffect && scroll.voiceEffect !== 'inherit') {
                return VoiceEngine.presetToParams(scroll.voiceEffect).voice;
            }
        }
        // 3. 全体設定
        return this.globalVoiceParams || VoiceEngine.defaultVoiceParams();
    }

    getEffectiveEnvParams(slot) {
        // 1. スイッチ個別設定チェック
        if (slot) {
            if (slot.voiceEffectMode === 'custom' && slot.envParams) {
                return slot.envParams;
            }
            if (slot.voiceEffect && slot.voiceEffect !== 'inherit') {
                return VoiceEngine.presetToParams(slot.voiceEffect).env;
            }
        }
        // 2. スクロール設定チェック
        const scroll = this.scrolls.find(s => s.id === (slot ? slot.scrollId : this.currentScrollId));
        if (scroll) {
            if (scroll.voiceEffectMode === 'custom' && scroll.envParams) {
                return scroll.envParams;
            }
            if (scroll.voiceEffect && scroll.voiceEffect !== 'inherit') {
                return VoiceEngine.presetToParams(scroll.voiceEffect).env;
            }
        }
        // 3. 全体設定
        return this.globalEnvParams || VoiceEngine.defaultEnvParams();
    }

    getScrollEffectiveVoiceParams(scrollId) {
        const scroll = this.scrolls.find(s => s.id === scrollId);
        if (scroll) {
            if (scroll.voiceEffectMode === 'custom' && scroll.voiceParams) {
                return scroll.voiceParams;
            }
            if (scroll.voiceEffect && scroll.voiceEffect !== 'inherit') {
                return VoiceEngine.presetToParams(scroll.voiceEffect).voice;
            }
        }
        return this.globalVoiceParams || VoiceEngine.defaultVoiceParams();
    }

    getScrollEffectiveEnvParams(scrollId) {
        const scroll = this.scrolls.find(s => s.id === scrollId);
        if (scroll) {
            if (scroll.voiceEffectMode === 'custom' && scroll.envParams) {
                return scroll.envParams;
            }
            if (scroll.voiceEffect && scroll.voiceEffect !== 'inherit') {
                return VoiceEngine.presetToParams(scroll.voiceEffect).env;
            }
        }
        return this.globalEnvParams || VoiceEngine.defaultEnvParams();
    }

    getEffectiveEqParams(slot) {
        if (slot) {
            if (slot.voiceEffectMode === 'custom' && slot.eqParams) {
                return slot.eqParams;
            }
            if (slot.voiceEffect && slot.voiceEffect !== 'inherit') {
                return VoiceEngine.presetToParams(slot.voiceEffect).eq;
            }
        }
        const scroll = this.scrolls.find(s => s.id === (slot ? slot.scrollId : this.currentScrollId));
        if (scroll) {
            if (scroll.voiceEffectMode === 'custom' && scroll.eqParams) {
                return scroll.eqParams;
            }
            if (scroll.voiceEffect && scroll.voiceEffect !== 'inherit') {
                return VoiceEngine.presetToParams(scroll.voiceEffect).eq;
            }
        }
        return this.globalEqParams || { bass: 0, mid: 0, treble: 0 };
    }

    getEffectiveSpecialParams(slot) {
        if (slot) {
            if (slot.voiceEffectMode === 'custom' && slot.specialParams) {
                return slot.specialParams;
            }
            if (slot.voiceEffect && slot.voiceEffect !== 'inherit') {
                return VoiceEngine.presetToParams(slot.voiceEffect).special;
            }
        }
        const scroll = this.scrolls.find(s => s.id === (slot ? slot.scrollId : this.currentScrollId));
        if (scroll) {
            if (scroll.voiceEffectMode === 'custom' && scroll.specialParams) {
                return scroll.specialParams;
            }
            if (scroll.voiceEffect && scroll.voiceEffect !== 'inherit') {
                return VoiceEngine.presetToParams(scroll.voiceEffect).special;
            }
        }
        return null;
    }

    getScrollEffectiveEqParams(scrollId) {
        const scroll = this.scrolls.find(s => s.id === scrollId);
        if (scroll) {
            if (scroll.voiceEffectMode === 'custom' && scroll.eqParams) {
                return scroll.eqParams;
            }
            if (scroll.voiceEffect && scroll.voiceEffect !== 'inherit') {
                return VoiceEngine.presetToParams(scroll.voiceEffect).eq;
            }
        }
        return this.globalEqParams || { bass: 0, mid: 0, treble: 0 };
    }

    getScrollEffectiveSpecialParams(scrollId) {
        const scroll = this.scrolls.find(s => s.id === scrollId);
        if (scroll) {
            if (scroll.voiceEffectMode === 'custom' && scroll.specialParams) {
                return scroll.specialParams;
            }
            if (scroll.voiceEffect && scroll.voiceEffect !== 'inherit') {
                return VoiceEngine.presetToParams(scroll.voiceEffect).special;
            }
        }
        return null;
    }

    getEffectivePlaybackSpeed(slot) {
        // 1. スイッチ個別設定チェック
        if (slot && slot.playbackSpeed && slot.playbackSpeed !== 'inherit') {
            return parseFloat(slot.playbackSpeed);
        }
        // 2. スクロール設定チェック
        const scroll = this.scrolls.find(s => s.id === (slot ? slot.scrollId : this.currentScrollId));
        if (scroll && scroll.playbackSpeed && scroll.playbackSpeed !== 'inherit') {
            return parseFloat(scroll.playbackSpeed);
        }
        // 3. 全体設定
        return parseFloat(this.globalPlaybackSpeed) || 1.0;
    }

    getScrollEffectiveSpeed(scrollId) {
        const scroll = this.scrolls.find(s => s.id === scrollId);
        if (scroll && scroll.playbackSpeed && scroll.playbackSpeed !== 'inherit') {
            return parseFloat(scroll.playbackSpeed);
        }
        return parseFloat(this.globalPlaybackSpeed) || 1.0;
    }

    getEffectiveSlotVolume(slot) {
        if (slot && slot.volume !== undefined && slot.volume !== null && slot.volume !== '') {
            const parsed = parseFloat(slot.volume);
            return isNaN(parsed) ? 1.0 : Math.max(0.0, Math.min(3.0, parsed));
        }
        return 1.0;
    }

    getVoiceEffectLabel(effectVal) {
        const names = {
            'normal': '🎙️ 通常',
            'baby': '👶 赤ちゃん',
            'boy': '👦 男の子',
            'girl': '👧 女の子',
            'man': '👨 男の人',
            'woman': '👩 女の人',
            'old_man': '👴 おじいさん',
            'old_woman': '👵 おばあさん',
            'alien': '👽 宇宙人',
            'robot': '🤖 ロボット',
            'monster': '👹 怪獣',
            'cave': '⛰️ 洞窟',
            'underwater': '🫧 水の中',
            'radio': '📻 古いラジオ',
            'telephone': '📱 電話',
            'hall': '🏛️ 大ホール',
            'megaphone': '📢 メガホン'
        };
        return names[effectVal] || effectVal;
    }

    // ==================== 描画処理 ＆ スクロールまとめ機能 ====================
    renderScrollTabs() {
        const container = document.getElementById('scroll-tabs-container');
        if (!container) return;
        container.innerHTML = '';

        this.scrolls.forEach((scroll, index) => {
            const count = this.slots.filter(s => s.scrollId === scroll.id).length;
            const tab = document.createElement('div');
            const isLocked = !!scroll.isLocked;
            const isSelectedForMerge = this.isMergeMode && this.selectedScrollIdsForMerge.has(scroll.id);

            let tabClass = `scroll-tab-item${scroll.id === this.currentScrollId ? ' active' : ''}${isLocked ? ' is-locked' : ''}`;
            if (this.isMergeMode) {
                tabClass += ' is-merge-mode';
                if (isSelectedForMerge) tabClass += ' is-merge-selected';
            }
            tab.className = tabClass;
            tab.setAttribute('data-scroll-id', scroll.id);
            tab.setAttribute('data-index', index);

            let checkboxHtml = '';
            if (this.isMergeMode) {
                checkboxHtml = `<input type="checkbox" class="scroll-merge-checkbox" data-scroll-id="${scroll.id}" ${isSelectedForMerge ? 'checked' : ''} aria-label="まとめる対象に選択">`;
            }

            tab.innerHTML = `
                ${checkboxHtml}
                <span class="scroll-tab-name">${this.escapeHtml(scroll.name)}</span>
                <span class="scroll-tab-badge">${count}</span>
                ${!this.isMergeMode ? `<span class="scroll-tab-edit-icon ${isLocked ? 'is-locked' : ''}" title="${isLocked ? 'スクロールロック中 (長押しで解除)' : 'スクロール設定 (長押しでロック)'}">${isLocked ? '🔒' : '⚙️'}</span>` : ''}
            `;

            tab.addEventListener('click', (e) => {
                if (this.isDraggingScroll) return;
                if (this.isMergeMode) {
                    e.stopPropagation();
                    this.toggleScrollSelectionForMerge(scroll.id);
                    return;
                }
                if (e.target.closest('.scroll-tab-edit-icon')) {
                    // Handled by attachScrollTabLockListeners
                    return;
                }
                this.switchScroll(scroll.id);
            });

            if (!this.isMergeMode) {
                const editIcon = tab.querySelector('.scroll-tab-edit-icon');
                if (editIcon) {
                    this.attachScrollTabLockListeners(editIcon, scroll);
                }
                this.attachTabDragListeners(tab, scroll.id);
            }

            container.appendChild(tab);
        });
    }

    // ==================== 🗂️ スクロールまとめ（マージ）モード制御 ====================
    toggleScrollSelectionForMerge(scrollId) {
        if (this.selectedScrollIdsForMerge.has(scrollId)) {
            this.selectedScrollIdsForMerge.delete(scrollId);
        } else {
            this.selectedScrollIdsForMerge.add(scrollId);
        }
        this.updateMergeModeUI();
        this.renderScrollTabs();
    }

    toggleMergeMode(forceState) {
        this.isMergeMode = (forceState !== undefined) ? forceState : !this.isMergeMode;
        if (!this.isMergeMode) {
            this.selectedScrollIdsForMerge.clear();
        }
        this.updateMergeModeUI();
        this.renderScrollTabs();

        if (this.isMergeMode) {
            if (navigator.vibrate) navigator.vibrate([40, 30, 40]);
            this.showToast('🗂️ まとめモードに入りました。まとめたいスクロールにチェックを入れて【まとめる】を押してください');
        } else {
            this.showToast('まとめモードを終了しました');
        }
    }

    exitMergeMode() {
        if (this.isMergeMode) {
            this.toggleMergeMode(false);
        }
    }

    updateMergeModeUI() {
        const mergeBtn = document.getElementById('header-merge-btn');
        const banner = document.getElementById('merge-mode-banner');

        if (mergeBtn) {
            if (this.isMergeMode) {
                mergeBtn.classList.add('active-merge-mode');
                const count = this.selectedScrollIdsForMerge.size;
                mergeBtn.innerHTML = `✨ <span class="btn-text">まとめる${count > 0 ? ` (${count}件)` : ''}</span>`;
            } else {
                mergeBtn.classList.remove('active-merge-mode');
                mergeBtn.innerHTML = `🗂️ <span class="btn-text">まとめる</span>`;
            }
        }

        if (banner) {
            banner.style.display = this.isMergeMode ? 'flex' : 'none';
        }
    }

    attachMergeButtonListeners(btn) {
        if (!btn) return;
        let timer = null;
        let isLongPress = false;
        let startX = 0, startY = 0;

        const startPress = (e) => {
            isLongPress = false;
            startX = e.clientX || (e.touches && e.touches[0].clientX) || 0;
            startY = e.clientY || (e.touches && e.touches[0].clientY) || 0;
            btn.classList.add('is-pressing');

            timer = setTimeout(() => {
                isLongPress = true;
                btn.classList.remove('is-pressing');
                this.toggleMergeMode();
            }, 800);
        };

        const cancelPress = () => {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            btn.classList.remove('is-pressing');
        };

        const movePress = (e) => {
            const curX = e.clientX || (e.touches && e.touches[0].clientX) || 0;
            const curY = e.clientY || (e.touches && e.touches[0].clientY) || 0;
            if (Math.abs(curX - startX) > 10 || Math.abs(curY - startY) > 10) {
                cancelPress();
            }
        };

        btn.addEventListener('pointerdown', startPress);
        btn.addEventListener('pointermove', movePress);
        btn.addEventListener('pointerup', (e) => {
            cancelPress();
            if (!isLongPress) {
                e.stopPropagation();
                if (this.isMergeMode) {
                    this.triggerMergeAction();
                } else {
                    this.showToast('💡 【長押し】すると複数のスクロールをまとめる「まとめモード」になります');
                }
            }
        });
        btn.addEventListener('pointercancel', cancelPress);
        btn.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    triggerMergeAction() {
        if (this.selectedScrollIdsForMerge.size < 2) {
            this.showToast('⚠️ まとめたいスクロールを2つ以上チェックしてください');
            return;
        }
        this.openMergeConfirmModal();
    }

    openMergeConfirmModal() {
        const selectedScrolls = this.scrolls.filter(s => this.selectedScrollIdsForMerge.has(s.id));
        if (selectedScrolls.length === 0) return;

        let totalButtons = 0;
        const scrollNames = [];
        selectedScrolls.forEach(s => {
            const cnt = this.slots.filter(slot => slot.scrollId === s.id).length;
            totalButtons += cnt;
            scrollNames.push(s.name);
        });

        const summaryEl = document.getElementById('merge-target-summary');
        if (summaryEl) {
            summaryEl.innerHTML = `
                <div>選択されたスクロール: <strong>${selectedScrolls.length}個</strong>（合計 <strong>${totalButtons}個</strong> のボタン）</div>
                <div style="font-size: 11px; color: #94a3b8; margin-top: 3px;">対象: ${scrollNames.map(n => `「${this.escapeHtml(n)}」`).join(' ＋ ')}</div>
            `;
        }

        const nameInput = document.getElementById('merge-new-scroll-name');
        if (nameInput) {
            nameInput.value = `${scrollNames.slice(0, 2).join('・')} まとめ`;
        }

        document.getElementById('merge-confirm-modal-backdrop')?.classList.add('open');
    }

    closeMergeConfirmModal() {
        document.getElementById('merge-confirm-modal-backdrop')?.classList.remove('open');
    }

    async executeMergeScrolls() {
        const nameInput = document.getElementById('merge-new-scroll-name');
        const newName = nameInput ? nameInput.value.trim() || 'まとめ作品' : 'まとめ作品';
        const keepOriginal = document.getElementById('merge-keep-original-check')?.checked !== false;

        const selectedScrolls = this.scrolls.filter(s => this.selectedScrollIdsForMerge.has(s.id));
        if (selectedScrolls.length < 2) {
            this.showToast('⚠️ まとめるスクロールが選択されていません');
            return;
        }

        const newScrollId = 'scroll_' + Date.now();
        const newScroll = {
            id: newScrollId,
            name: newName,
            order: this.scrolls.length,
            voiceEffectMode: 'inherit',
            voiceParams: VoiceEngine.defaultVoiceParams(),
            envParams: VoiceEngine.defaultEnvParams(),
            playbackSpeed: 'inherit',
            createdAt: Date.now()
        };

        // 選択されたスクロール内の全スロットを順番通りに収集・複製
        let orderCounter = 1;
        const newSlotsToAdd = [];

        for (const scroll of selectedScrolls) {
            const scrollSlots = this.slots
                .filter(s => s.scrollId === scroll.id)
                .sort((a, b) => (a.order || 0) - (b.order || 0));

            for (const originalSlot of scrollSlots) {
                const uniqueSlotId = `slot_${Date.now()}_${Math.random().toString(36).substr(2, 6)}_${orderCounter}`;
                const clonedSlot = {
                    ...originalSlot,
                    id: uniqueSlotId,
                    scrollId: newScrollId,
                    order: orderCounter++
                };
                newSlotsToAdd.push(clonedSlot);
            }
        }

        // 元スクロールの削除（オプションがオフの場合）
        if (!keepOriginal) {
            for (const scroll of selectedScrolls) {
                await this.storage.deleteScroll(scroll.id);
                this.scrolls = this.scrolls.filter(s => s.id !== scroll.id);
                // 元スロット削除
                const slotsToDelete = this.slots.filter(s => s.scrollId === scroll.id);
                for (const slot of slotsToDelete) {
                    await this.storage.deleteSlot(slot.id);
                }
                this.slots = this.slots.filter(s => s.scrollId !== scroll.id);
            }
        }

        // 新スクロールとスロットをIndexedDBに保存
        await this.storage.saveScroll(newScroll);
        this.scrolls.push(newScroll);

        for (const slot of newSlotsToAdd) {
            await this.storage.saveSlot(slot);
            this.slots.push(slot);
        }

        this.currentScrollId = newScrollId;
        await this.storage.saveSetting('currentScrollId', newScrollId);

        this.closeMergeConfirmModal();
        this.exitMergeMode();

        this.renderScrollTabs();
        this.renderSlots();

        if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
        this.showToast(`🎉 「${newName}」に ${newSlotsToAdd.length} 個のボタンをまとめました！`);
    }

    attachScrollTabLockListeners(editIcon, scroll) {
        let timer = null;
        let isLongPress = false;
        let startX = 0, startY = 0;

        const startPress = (e) => {
            isLongPress = false;
            startX = e.clientX || (e.touches && e.touches[0].clientX) || 0;
            startY = e.clientY || (e.touches && e.touches[0].clientY) || 0;
            editIcon.classList.add('is-pressing');

            timer = setTimeout(async () => {
                isLongPress = true;
                editIcon.classList.remove('is-pressing');
                scroll.isLocked = !scroll.isLocked;
                await this.storage.saveScroll(scroll);
                if (navigator.vibrate) navigator.vibrate([40, 30, 40]);
                this.showToast(scroll.isLocked ? `🔒 スクロール「${scroll.name}」をロックしました` : `🔓 スクロール「${scroll.name}」のロックを解除しました`);
                this.renderScrollTabs();
            }, 900);
        };

        const cancelPress = () => {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            editIcon.classList.remove('is-pressing');
        };

        const movePress = (e) => {
            const curX = e.clientX || (e.touches && e.touches[0].clientX) || 0;
            const curY = e.clientY || (e.touches && e.touches[0].clientY) || 0;
            if (Math.abs(curX - startX) > 10 || Math.abs(curY - startY) > 10) {
                cancelPress();
            }
        };

        editIcon.addEventListener('pointerdown', startPress);
        editIcon.addEventListener('pointermove', movePress);
        editIcon.addEventListener('pointerup', (e) => {
            cancelPress();
            if (!isLongPress) {
                e.stopPropagation();
                if (scroll.isLocked) {
                    this.showToast(`🔒 スクロールがロックされています。解除するには⚙️/🔒を長押ししてください`);
                } else {
                    this.openScrollModal(scroll.id);
                }
            }
        });
        editIcon.addEventListener('pointercancel', cancelPress);
        editIcon.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    attachTabDragListeners(tab, scrollId) {
        let isLongPress = false;
        let startX = 0, startY = 0;
        let timer = null;
        let hoverTargetScrollId = null;

        const onPointerDown = (e) => {
            if (e.target.closest('.scroll-tab-edit-icon')) return;
            startX = e.clientX || (e.touches && e.touches[0].clientX) || 0;
            startY = e.clientY || (e.touches && e.touches[0].clientY) || 0;
            isLongPress = false;
            hoverTargetScrollId = null;

            clearTimeout(timer);
            timer = setTimeout(() => {
                isLongPress = true;
                this.isDraggingScroll = true;
                this.dragScrollId = scrollId;
                tab.classList.add('dragging');
                if (navigator.vibrate) navigator.vibrate(40);
            }, 240);

            const onPointerMove = (moveEvt) => {
                const currentX = moveEvt.clientX || (moveEvt.touches && moveEvt.touches[0].clientX) || 0;
                const currentY = moveEvt.clientY || (moveEvt.touches && moveEvt.touches[0].clientY) || 0;

                if (!isLongPress) {
                    if (Math.abs(currentX - startX) > 10 || Math.abs(currentY - startY) > 10) {
                        clearTimeout(timer);
                    }
                    return;
                }

                if (moveEvt.cancelable) moveEvt.preventDefault();

                // すべてのタブの水平中心座標とポインターの距離を計算して最も近いタブを検出
                const allTabs = Array.from(document.querySelectorAll('.scroll-tab-item'));
                let closestTab = null;
                let minDistance = Infinity;

                allTabs.forEach(t => {
                    if (t === tab) return;
                    const rect = t.getBoundingClientRect();
                    const centerX = rect.left + rect.width / 2;
                    const dist = Math.abs(currentX - centerX);
                    if (dist < minDistance) {
                        minDistance = dist;
                        closestTab = t;
                    }
                });

                allTabs.forEach(t => t.classList.remove('drag-over'));
                if (closestTab) {
                    closestTab.classList.add('drag-over');
                    hoverTargetScrollId = closestTab.getAttribute('data-scroll-id');
                } else {
                    hoverTargetScrollId = null;
                }
            };

            const onPointerUp = async (upEvt) => {
                clearTimeout(timer);
                window.removeEventListener('pointermove', onPointerMove);
                window.removeEventListener('pointerup', onPointerUp);
                window.removeEventListener('pointercancel', onPointerUp);

                const targetToSwap = hoverTargetScrollId;
                tab.classList.remove('dragging');
                document.querySelectorAll('.scroll-tab-item').forEach(t => t.classList.remove('drag-over'));

                if (isLongPress && this.dragScrollId && targetToSwap && targetToSwap !== scrollId) {
                    await this.reorderScrolls(this.dragScrollId, targetToSwap);
                }

                this.isDraggingScroll = false;
                this.dragScrollId = null;
                hoverTargetScrollId = null;
            };

            window.addEventListener('pointermove', onPointerMove, { passive: false });
            window.addEventListener('pointerup', onPointerUp);
            window.addEventListener('pointercancel', onPointerUp);
        };

        tab.addEventListener('pointerdown', onPointerDown);
    }

    async reorderScrolls(fromId, toId) {
        const fromIndex = this.scrolls.findIndex(s => s.id === fromId);
        const toIndex = this.scrolls.findIndex(s => s.id === toId);
        if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return;

        const [moved] = this.scrolls.splice(fromIndex, 1);
        this.scrolls.splice(toIndex, 0, moved);

        this.scrolls.forEach((s, idx) => {
            s.order = idx;
        });

        await this.storage.saveAllScrolls(this.scrolls);
        this.renderScrollTabs();
    }

    async moveScrollOrder(direction) {
        if (!this.editingScrollId) return;
        const currentIndex = this.scrolls.findIndex(s => s.id === this.editingScrollId);
        if (currentIndex === -1) return;

        const targetIndex = currentIndex + direction;
        if (targetIndex < 0 || targetIndex >= this.scrolls.length) return;

        const [moved] = this.scrolls.splice(currentIndex, 1);
        this.scrolls.splice(targetIndex, 0, moved);

        this.scrolls.forEach((s, idx) => {
            s.order = idx;
        });

        await this.storage.saveAllScrolls(this.scrolls);
        this.renderScrollTabs();
        this.showToast(direction < 0 ? '◀ 1つ左へ移動しました' : '1つ右へ移動しました ▶');
    }

    getTotalPages() {
        const totalItems = this.getCurrentSlots().length;
        // 常に「+追加」ボタンを含めて総ページ数を計算（満杯時は自動的に次ページが生まれる）
        return Math.max(1, Math.ceil((totalItems + 1) / this.pageSize));
    }

    renderSlots() {
        const grid = document.getElementById('pad-grid');
        if (!grid) return;
        grid.innerHTML = '';

        grid.className = `pad-grid grid-count-${this.pageSize}`;

        const currentSlots = this.getCurrentSlots();
        const totalItems = currentSlots.length;
        const totalPages = this.getTotalPages();

        if (this.currentPage > totalPages) {
            this.currentPage = totalPages;
        }

        const startIndex = (this.currentPage - 1) * this.pageSize;
        const endIndex = startIndex + this.pageSize;
        const pageSlots = currentSlots.slice(startIndex, endIndex);

        const pageIndicator = document.getElementById('page-indicator');
        const prevBtn = document.getElementById('prev-page-btn');
        const nextBtn = document.getElementById('next-page-btn');

        if (pageIndicator) {
            pageIndicator.innerText = `ページ ${this.currentPage} / ${totalPages} (計 ${totalItems}個)`;
        }
        if (prevBtn) prevBtn.disabled = (this.currentPage <= 1);
        if (nextBtn) nextBtn.disabled = (this.currentPage >= totalPages);

        pageSlots.forEach((slot, idx) => {
            const card = document.createElement('div');
            const hasPhoto = !!slot.imageUrl;
            const pos = slot.labelPosition || 'bottom';
            const displayIndex = startIndex + idx + 1;
            const isLocked = !!slot.isLocked;

            card.className = `pad-card pos-${pos}${hasPhoto ? ' has-photo' : ''}${isLocked ? ' is-locked' : ''}`;
            card.setAttribute('data-slot-id', slot.id);
            card.id = `pad-${slot.id}`;

            const colorIdx = ((displayIndex - 1) % 8) + 1;
            card.style.setProperty('--slot-color', `var(--slot-c${colorIdx})`);

            const hasAudio = (slot.audioBlob !== null) || (!!slot.ttsText);
            let statusText = '未録音';
            if (hasAudio) {
                const speed = this.getEffectivePlaybackSpeed(slot);
                const speedLabel = speed !== 1.0 ? ` (${speed}x)` : '';
                const vol = this.getEffectiveSlotVolume(slot);
                const volLabel = vol === 0 ? ' [消音]' : (vol !== 1.0 ? ` [${Math.round(vol * 100)}%]` : '');
                const tag = (slot.ttsText && !slot.audioBlob) ? '🤖 ' : '';
                statusText = `${tag}${(slot.duration || 1.0).toFixed(1)}s${speedLabel}${volLabel}`;
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

                <div class="pad-header">
                    <span class="slot-badge">${displayIndex}</span>
                    ${pos === 'top' ? labelHtml : ''}
                    <div class="pad-actions-group">
                        <button type="button" class="pad-action-btn btn-voice" title="声質設定" data-slot-id="${slot.id}" aria-label="声質設定">
                            🗣️
                        </button>
                        <button type="button" class="pad-action-btn btn-env" title="環境・エコー設定" data-slot-id="${slot.id}" aria-label="環境設定">
                            ⛰️
                        </button>
                        <button type="button" class="pad-action-btn btn-tts ${slot.ttsText ? 'has-tts' : ''}" title="AI音声合成 (TTS) 設定" data-slot-id="${slot.id}" aria-label="AI音声設定">
                            🤖
                        </button>
                        <button type="button" class="pad-action-btn btn-lock ${isLocked ? 'is-locked' : ''}" title="${isLocked ? 'ロック中 (長押しで解除)' : 'スイッチ設定 (長押しでロック)'}" data-slot-id="${slot.id}" aria-label="${isLocked ? 'ロック解除' : 'スイッチ設定'}">
                            ${isLocked ? '🔒' : '⚙️'}
                        </button>
                    </div>
                </div>

                <div class="pad-body">
                    ${!hasPhoto ? `<div class="pad-emoji">${slot.emoji || '🔊'}</div>` : ''}
                    ${pos === 'center' ? labelHtml : ''}
                </div>

                <div class="pad-footer">
                    ${pos === 'bottom' ? labelHtml : ''}
                    <div class="pad-status">${statusText}</div>
                </div>
            `;

            const btnVoice = card.querySelector('.btn-voice');
            if (btnVoice) {
                btnVoice.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (slot.isLocked) {
                        this.showToast(`🔒 ロックされています。解除するには⚙️/🔒を長押ししてください`);
                    } else {
                        this.openSlotVoiceModal(slot.id);
                    }
                });
            }

            const btnEnv = card.querySelector('.btn-env');
            if (btnEnv) {
                btnEnv.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (slot.isLocked) {
                        this.showToast(`🔒 ロックされています。解除するには⚙️/🔒を長押ししてください`);
                    } else {
                        this.openSlotEnvModal(slot.id);
                    }
                });
            }

            const btnTts = card.querySelector('.btn-tts');
            if (btnTts) {
                btnTts.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (slot.isLocked) {
                        this.showToast(`🔒 ロックされています。解除するには⚙️/🔒を長押ししてください`);
                    } else {
                        this.openSlotTtsModal(slot.id);
                    }
                });
            }

            const btnLock = card.querySelector('.btn-lock');
            if (btnLock) {
                this.attachButtonLockListeners(btnLock, slot);
            }

            this.attachPadDragListeners(card, slot.id);
            this.attachPadRippleListener(card);
            grid.appendChild(card);
        });

        // 最後のページであれば「＋ 追加」ボタンを描画する（ページが満杯のときは次ページに単独で描画される）
        if (this.currentPage === totalPages) {
            const addCard = document.createElement('div');
            addCard.className = 'pad-card pad-card-add-new';
            addCard.innerHTML = `
                <div class="add-icon">＋</div>
                <div>追加</div>
            `;
            addCard.addEventListener('click', () => this.addNewSlotToCurrentScroll());
            this.attachPadRippleListener(addCard);
            grid.appendChild(addCard);
        }

        // AACスキャン中のフォーカス復元
        if (this.aacScanActive && this.aacScanIndex >= 0) {
            this.updateAACScanFocusUI();
        }
    }

    attachButtonLockListeners(btnLock, slot) {
        let timer = null;
        let isLongPress = false;
        let startX = 0, startY = 0;

        const startPress = (e) => {
            isLongPress = false;
            startX = e.clientX || (e.touches && e.touches[0].clientX) || 0;
            startY = e.clientY || (e.touches && e.touches[0].clientY) || 0;
            btnLock.classList.add('is-pressing');

            timer = setTimeout(async () => {
                isLongPress = true;
                btnLock.classList.remove('is-pressing');
                slot.isLocked = !slot.isLocked;
                await this.storage.saveSlot(slot);
                if (navigator.vibrate) navigator.vibrate([40, 30, 40]);
                this.showToast(slot.isLocked ? `🔒 ボタン「${slot.label}」をロックしました` : `🔓 ボタン「${slot.label}」のロックを解除しました`);
                this.renderSlots();
            }, 850);
        };

        const cancelPress = () => {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            btnLock.classList.remove('is-pressing');
        };

        const movePress = (e) => {
            const curX = e.clientX || (e.touches && e.touches[0].clientX) || 0;
            const curY = e.clientY || (e.touches && e.touches[0].clientY) || 0;
            if (Math.abs(curX - startX) > 10 || Math.abs(curY - startY) > 10) {
                cancelPress();
            }
        };

        btnLock.addEventListener('pointerdown', startPress);
        btnLock.addEventListener('pointermove', movePress);
        btnLock.addEventListener('pointerup', (e) => {
            cancelPress();
            if (!isLongPress) {
                e.stopPropagation();
                if (slot.isLocked) {
                    this.showToast(`🔒 ロックされています。解除するには長押し（約1秒）してください`);
                } else {
                    this.openEditModal(slot.id);
                }
            }
        });
        btnLock.addEventListener('pointercancel', cancelPress);
        btnLock.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    attachPadRippleListener(card) {
        card.addEventListener('pointerdown', (e) => {
            if (e.target.closest('.pad-settings-btn') || e.target.closest('.pad-actions-group')) return;
            const rect = card.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            const ripple = document.createElement('span');
            ripple.className = 'pad-ripple';
            const size = Math.max(rect.width, rect.height);
            ripple.style.width = `${size}px`;
            ripple.style.height = `${size}px`;
            ripple.style.left = `${x - size / 2}px`;
            ripple.style.top = `${y - size / 2}px`;
            card.appendChild(ripple);
            setTimeout(() => ripple.remove(), 600);
        }, { passive: true });
    }

    // ==================== ボタンスイッチ長押しドラッグ＆ドロップ並び替え ====================
    attachPadDragListeners(card, slotId) {
        let isLongPress = false;
        let startX = 0, startY = 0;
        let timer = null;
        let hoverTargetSlotId = null;

        const onPointerDown = (e) => {
            if (e.target.closest('.pad-settings-btn') || e.target.closest('.pad-actions-group')) return;
            startX = e.clientX || (e.touches && e.touches[0].clientX) || 0;
            startY = e.clientY || (e.touches && e.touches[0].clientY) || 0;
            isLongPress = false;
            hoverTargetSlotId = null;

            clearTimeout(timer);
            timer = setTimeout(() => {
                isLongPress = true;
                this.isDraggingPad = true;
                this.dragSlotId = slotId;
                card.classList.add('dragging');
                if (navigator.vibrate) navigator.vibrate(40);
            }, 240);

            const onPointerMove = (moveEvt) => {
                const currentX = moveEvt.clientX || (moveEvt.touches && moveEvt.touches[0].clientX) || 0;
                const currentY = moveEvt.clientY || (moveEvt.touches && moveEvt.touches[0].clientY) || 0;

                if (!isLongPress) {
                    if (Math.abs(currentX - startX) > 12 || Math.abs(currentY - startY) > 12) {
                        clearTimeout(timer);
                    }
                    return;
                }

                if (moveEvt.cancelable) moveEvt.preventDefault();

                // すべてのスイッチカードの中心座標とポインターの2次元距離を計算
                const allCards = Array.from(document.querySelectorAll('.pad-card:not(.pad-card-add-new)'));
                let closestCard = null;
                let minDistance = Infinity;

                allCards.forEach(c => {
                    if (c === card) return;
                    const rect = c.getBoundingClientRect();
                    const centerX = rect.left + rect.width / 2;
                    const centerY = rect.top + rect.height / 2;
                    const dist = Math.hypot(currentX - centerX, currentY - centerY);
                    if (dist < minDistance) {
                        minDistance = dist;
                        closestCard = c;
                    }
                });

                allCards.forEach(c => c.classList.remove('drag-over'));
                if (closestCard) {
                    closestCard.classList.add('drag-over');
                    hoverTargetSlotId = closestCard.getAttribute('data-slot-id');
                } else {
                    hoverTargetSlotId = null;
                }
            };

            const onPointerUp = async (upEvt) => {
                clearTimeout(timer);
                window.removeEventListener('pointermove', onPointerMove);
                window.removeEventListener('pointerup', onPointerUp);
                window.removeEventListener('pointercancel', onPointerUp);

                const targetToSwap = hoverTargetSlotId;
                card.classList.remove('dragging');
                document.querySelectorAll('.pad-card').forEach(c => c.classList.remove('drag-over'));

                if (isLongPress && this.dragSlotId && targetToSwap && targetToSwap !== slotId) {
                    await this.reorderSlots(this.dragSlotId, targetToSwap);
                }

                this.isDraggingPad = false;
                this.dragSlotId = null;
                hoverTargetSlotId = null;
            };

            window.addEventListener('pointermove', onPointerMove, { passive: false });
            window.addEventListener('pointerup', onPointerUp);
            window.addEventListener('pointercancel', onPointerUp);
        };

        card.addEventListener('pointerdown', onPointerDown);
    }

    async reorderSlots(fromId, toId) {
        const currentScrollSlots = this.getCurrentSlots();
        const fromIndex = currentScrollSlots.findIndex(s => s.id === fromId);
        const toIndex = currentScrollSlots.findIndex(s => s.id === toId);
        if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return;

        const [movedSlot] = currentScrollSlots.splice(fromIndex, 1);
        currentScrollSlots.splice(toIndex, 0, movedSlot);

        for (let idx = 0; idx < currentScrollSlots.length; idx++) {
            const s = currentScrollSlots[idx];
            s.order = idx + 1;
            await this.storage.saveSlot(s);
        }

        this.renderSlots();
    }

    // ==================== イベントリスナー設定 ====================
    initEvents() {
        const grid = document.getElementById('pad-grid');
        if (grid) {
            grid.addEventListener('click', (e) => {
                if (this.isDraggingPad) return;
                if (e.target.closest('.pad-actions-group')) return;
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

        // 最上段タイトルロゴボタンスイッチ -> アプリ招待・QRコード画面を開く
        document.getElementById('header-logo-btn')?.addEventListener('click', () => {
            this.openQrModal();
        });

        document.getElementById('mode-play-btn')?.addEventListener('click', () => this.setMode('play'));
        document.getElementById('mode-record-btn')?.addEventListener('click', () => this.setMode('record'));

        // ヘッダーのボイスエフェクト変更
        document.getElementById('voice-effect')?.addEventListener('change', async (e) => {
            this.currentEffect = e.target.value;
            await this.storage.saveSetting('effect', this.currentEffect);
            const globalEffectSelect = document.getElementById('setting-global-effect');
            if (globalEffectSelect) globalEffectSelect.value = this.currentEffect;
            this.showToast(`全体のボイスエフェクト: ${this.getVoiceEffectLabel(this.currentEffect)}`);
        });

        document.getElementById('add-scroll-btn')?.addEventListener('click', () => this.addNewScroll());

        document.getElementById('prev-page-btn')?.addEventListener('click', () => {
            if (this.currentPage > 1) {
                this.currentPage--;
                this.renderSlots();
            }
        });
        document.getElementById('next-page-btn')?.addEventListener('click', () => {
            const totalPages = this.getTotalPages();
            if (this.currentPage < totalPages) {
                this.currentPage++;
                this.renderSlots();
            }
        });

        // 🗂️ まとめるボタンスイッチ
        const headerMergeBtn = document.getElementById('header-merge-btn');
        if (headerMergeBtn) {
            this.attachMergeButtonListeners(headerMergeBtn);
        }

        // まとめモードバナー解除ボタン
        document.getElementById('btn-cancel-merge-mode')?.addEventListener('click', () => {
            this.exitMergeMode();
        });

        // まとめ確認モーダル関連
        document.getElementById('close-merge-modal-btn')?.addEventListener('click', () => {
            this.closeMergeConfirmModal();
        });
        document.getElementById('btn-cancel-merge-modal')?.addEventListener('click', () => {
            this.closeMergeConfirmModal();
        });
        document.getElementById('btn-execute-merge')?.addEventListener('click', async () => {
            await this.executeMergeScrolls();
        });

        this.initSwipeGesture();

        document.getElementById('header-import-btn')?.addEventListener('click', () => {
            document.getElementById('global-import-input')?.click();
        });

        document.getElementById('header-settings-btn')?.addEventListener('click', () => {
            this.openSettingsModal();
        });

        document.getElementById('settings-open-qr-btn')?.addEventListener('click', () => {
            this.closeSettingsModal();
            this.openQrModal();
        });

        document.getElementById('check-update-btn')?.addEventListener('click', () => {
            this.openBackupConfirmModal();
        });

        document.getElementById('global-import-input')?.addEventListener('change', async (e) => {
            if (e.target.files.length > 0) {
                await this.handleGlobalImport(e.target.files[0]);
                e.target.value = '';
            }
        });

        this.initModalEvents();
        this.initEditorEvents();

        // 📱 初回タップ時のマイク＆AudioContext事前ウォームアップ（遅延・頭切れ防止）
        const handleFirstInteraction = () => {
            AudioUnlocker.unlock();
            this.prewarmMicrophone(false);
            window.removeEventListener('pointerdown', handleFirstInteraction);
            window.removeEventListener('touchstart', handleFirstInteraction);
            window.removeEventListener('click', handleFirstInteraction);
        };
        window.addEventListener('pointerdown', handleFirstInteraction, { once: true, passive: true });
        window.addEventListener('touchstart', handleFirstInteraction, { once: true, passive: true });
        window.addEventListener('click', handleFirstInteraction, { once: true, passive: true });
    }

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
                    const totalPages = this.getTotalPages();
                    if (diffX < 0 && this.currentPage < totalPages) {
                        this.currentPage++;
                        this.renderSlots();
                    } else if (diffX > 0 && this.currentPage > 1) {
                        this.currentPage--;
                        this.renderSlots();
                    }
                }
            }
        }, { passive: true });
    }

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

    // ==================== スクロール制御 ====================
    async switchScroll(scrollId) {
        this.stopAllAudioPlayback();
        this.currentScrollId = scrollId;
        this.currentPage = 1;
        await this.storage.saveSetting('currentScrollId', scrollId);
        this.renderScrollTabs();
        this.renderSlots();
    }

    async addNewScroll(name = null) {
        const scrollName = name || prompt('新しいスクロールの名前を入力してください:', `スクロール ${this.scrolls.length + 1}`);
        if (!scrollName || !scrollName.trim()) return;

        const newScroll = {
            id: 'scroll_' + Date.now(),
            name: scrollName.trim(),
            order: this.scrolls.length,
            voiceEffect: 'inherit',
            playbackSpeed: 'inherit',
            createdAt: Date.now()
        };

        await this.storage.saveScroll(newScroll);
        this.scrolls.push(newScroll);

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
                voiceEffect: 'inherit',
                playbackSpeed: 'inherit',
                volume: 1.0,
                order: i
            };
            await this.storage.saveSlot(newSlot);
            this.slots.push(newSlot);
        }

        await this.switchScroll(newScroll.id);
        this.showToast(`✨ スクロール「${newScroll.name}」を作成しました`);
    }

    openScrollModal(scrollId) {
        this.editingScrollId = scrollId;
        const scroll = this.scrolls.find(s => s.id === scrollId);
        if (!scroll) return;

        const nameInput = document.getElementById('edit-scroll-name');
        if (nameInput) nameInput.value = scroll.name;

        // ボイスエフェクトモード＆2ステージパラメータ同期
        const modeSelect = document.getElementById('edit-scroll-effect-mode');
        const panel = document.getElementById('scroll-fx-custom-panel');
        const isCustom = (scroll.voiceEffectMode === 'custom') || (scroll.voiceEffect && scroll.voiceEffect !== 'inherit');
        if (modeSelect) modeSelect.value = isCustom ? 'custom' : 'inherit';
        if (panel) panel.style.display = isCustom ? 'flex' : 'none';

        const initialVoice = scroll.voiceParams || (scroll.voiceEffect ? VoiceEngine.presetToParams(scroll.voiceEffect).voice : VoiceEngine.defaultVoiceParams());
        const initialEnv = scroll.envParams || (scroll.voiceEffect ? VoiceEngine.presetToParams(scroll.voiceEffect).env : VoiceEngine.defaultEnvParams());
        const initialEq = scroll.eqParams || (scroll.voiceEffect ? VoiceEngine.presetToParams(scroll.voiceEffect).eq : { bass: 0, mid: 0, treble: 0 });
        const initialSpecial = scroll.specialParams || (scroll.voiceEffect ? VoiceEngine.presetToParams(scroll.voiceEffect).special : null);
        const effectiveSpeed = this.getScrollEffectiveSpeed(scroll.id);
        const currentSpeed = (scroll.playbackSpeed && scroll.playbackSpeed !== 'inherit') ? parseFloat(scroll.playbackSpeed) : effectiveSpeed;
        this.setFxParamsToUI('scroll', initialVoice, initialEnv, initialEq, initialSpecial, currentSpeed);

        // スピード設定同期
        const speedSelect = document.getElementById('edit-scroll-speed');
        if (speedSelect) {
            speedSelect.value = scroll.playbackSpeed || 'inherit';
            speedSelect.options[0].text = `🔄 全体設定に従う (現在: ${this.globalPlaybackSpeed}x)`;
        }

        // Voicemod風 プリセットカード一覧を描画
        this.renderVoicemodPresetCards('scroll-voicemod-grid', 'all', 'scroll');
        document.querySelectorAll('#scroll-voicemod-tabs .vm-tab-btn').forEach(b => {
            if (b.getAttribute('data-category') === 'all') b.classList.add('active');
            else b.classList.remove('active');
        });

        document.getElementById('scroll-modal-backdrop')?.classList.add('open');
    }

    async previewScrollEffect() {
        if (!this.editingScrollId) return;
        const scroll = this.scrolls.find(s => s.id === this.editingScrollId);
        await AudioUnlocker.unlock();
        const ctx = AudioUnlocker.getContext();
        if (!ctx) return;

        this.stopFxPreview();
        const { voiceParams, envParams, eqParams, specialParams, speed } = this.getFxParamsFromUI('scroll');
        this.playTestVoicePreview(ctx, voiceParams, envParams, speed, eqParams, specialParams);
    }

    closeScrollModal() {
        this.stopFxPreview();
        BlobUrlTracker.revokeCategory('preview');
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

        const modeSelect = document.getElementById('edit-scroll-effect-mode');
        scroll.voiceEffectMode = modeSelect ? modeSelect.value : 'inherit';

        const speedSelect = document.getElementById('edit-scroll-speed');

        if (scroll.voiceEffectMode === 'custom') {
            const { voiceParams, envParams, eqParams, specialParams, speed } = this.getFxParamsFromUI('scroll');
            scroll.voiceParams = voiceParams;
            scroll.envParams = envParams;
            scroll.eqParams = eqParams;
            scroll.specialParams = specialParams;
            scroll.voiceEffect = 'custom';
            if (speedSelect && speedSelect.value !== 'inherit') {
                scroll.playbackSpeed = String(speed);
            }
        } else {
            scroll.voiceEffect = 'inherit';
        }

        if (speedSelect) {
            scroll.playbackSpeed = speedSelect.value;
        }

        await this.storage.saveScroll(scroll);
        this.renderScrollTabs();
        this.renderSlots();
        this.closeScrollModal();
        this.showToast(`💾 スクロール「${newName}」の設定を更新しました`);
    }

    async deleteScrollModal() {
        if (!this.editingScrollId) return;
        if (this.scrolls.length <= 1) {
            alert('最後のスクロールは削除できません。');
            return;
        }

        const scroll = this.scrolls.find(s => s.id === this.editingScrollId);
        if (!scroll) return;

        if (confirm(`スクロール「${scroll.name}」とその中のすべてのスイッチを削除しますか？`)) {
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
            this.showToast(`🗑️ スクロール「${scroll.name}」を削除しました`);
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
            voiceEffectMode: scroll.voiceEffectMode || 'inherit',
            voiceParams: scroll.voiceParams ? { ...scroll.voiceParams } : VoiceEngine.defaultVoiceParams(),
            envParams: scroll.envParams ? { ...scroll.envParams } : VoiceEngine.defaultEnvParams(),
            voiceEffect: scroll.voiceEffect || 'inherit',
            playbackSpeed: scroll.playbackSpeed || 'inherit',
            createdAt: Date.now()
        };

        await this.storage.saveScroll(duplicatedScroll);
        this.scrolls.push(duplicatedScroll);

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
        this.showToast(`📋 スクロール「${duplicatedScroll.name}」を複製しました`);
    }

    // ==================== スイッチ追加・制御 ====================
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
            voiceEffect: 'inherit',
            playbackSpeed: 'inherit',
            volume: 1.0,
            order: nextOrder
        };

        await this.storage.saveSlot(newSlot);
        this.slots.push(newSlot);

        this.currentPage = this.getTotalPages();

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

    // ==================== モード切り替え＆マイク事前ウォームアップ ====================
    async setMode(mode) {
        this.currentMode = mode;
        const playBtn = document.getElementById('mode-play-btn');
        const recBtn = document.getElementById('mode-record-btn');
        const grid = document.getElementById('pad-grid');

        if (mode === 'play') {
            playBtn?.classList.add('active');
            recBtn?.classList.remove('active');
            grid?.classList.remove('mode-record');
            // 🔊 再生モード時はマイク占有を完全解放して高品質メディア再生モードへ復帰
            this.releaseMicrophone();
        } else {
            recBtn?.classList.add('active');
            playBtn?.classList.remove('active');
            grid?.classList.add('mode-record');

            // 🔴 録音モードに切り替えた瞬間にマイクを事前起動（ウォームアップ）
            this.prewarmMicrophone(true);
        }
    }

    async prewarmMicrophone(showFeedback = false) {
        try {
            await this.getAudioStream();
            if (showFeedback) {
                this.showToast('🎙️ マイク準備完了！ボタンを押してすぐに録音できます');
            }
        } catch (e) {
            console.warn('Microphone prewarm warning:', e);
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
            window.localStream = this.audioStream;
            return this.audioStream;
        } catch (err) {
            console.error('Microphone error:', err);
            throw err;
        }
    }

    /**
     * 🎙️ マイクのハードウェア占有を完全に解放
     * - iOS / iPadOS / Android でスピーカーが通話用音量になるのを防ぎ、TTSや音声再生を大音量・高音質に保つ
     */
    releaseMicrophone() {
        if (this.audioStream) {
            try {
                this.audioStream.getTracks().forEach(track => {
                    track.stop();
                });
            } catch (e) {
                console.warn('Error releasing microphone tracks:', e);
            }
            this.audioStream = null;
        }
        if (window.localStream) {
            try {
                window.localStream.getTracks().forEach(track => track.stop());
            } catch (e) {}
            window.localStream = null;
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
        const ctx = AudioUnlocker.getContext();

        // 既存タイマーの二重起動防止
        if (this.recTimer) {
            clearInterval(this.recTimer);
            this.recTimer = null;
        }

        try {
            await this.getAudioStream();
        } catch (err) {
            alert('マイクの使用が許可されていません。ブラウザ設定でマイクアクセスを許可してください。');
            return;
        }

        this.recordingSlotId = slotId;
        this.recordedChunks = [];
        this.recStartTime = performance.now();
        this.recSeconds = 0;
        this.pcmRecorderHandled = false;

        // 🎙️ 高音質 PCM レコーダーの起動（Web Audio 直結・iOS / iPadOS 100% 互換＆劣化ゼロ）
        try {
            if (ctx && (ctx.createScriptProcessor || ctx.createJavaScriptNode)) {
                this.pcmRecorder = new PcmAudioRecorder(ctx, this.audioStream);
                this.pcmRecorder.start();
            }
        } catch (e) {
            console.warn('PcmAudioRecorder start error, fallback to MediaRecorder:', e);
            this.pcmRecorder = null;
        }

        // 🔄 フォールバック兼用の MediaRecorder（timeslice なしで起動して WebKit の MP4 破損バグを回避）
        let mimeType = '';
        if (typeof MediaRecorder !== 'undefined') {
            if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) mimeType = 'audio/webm;codecs=opus';
            else if (MediaRecorder.isTypeSupported('audio/webm')) mimeType = 'audio/webm';
            else if (MediaRecorder.isTypeSupported('audio/mp4')) mimeType = 'audio/mp4';

            try {
                this.mediaRecorder = mimeType ? new MediaRecorder(this.audioStream, { mimeType }) : new MediaRecorder(this.audioStream);
                this.mediaRecorder.ondataavailable = (e) => {
                    if (e.data && e.data.size > 0) this.recordedChunks.push(e.data);
                };
                this.mediaRecorder.onstop = async () => {
                    // PCM レコーダーで保存されなかった場合のみ MediaRecorder から保存
                    if (!this.pcmRecorderHandled && this.recordingSlotId !== null) {
                        const finalType = this.mediaRecorder.mimeType || 'audio/mp4';
                        const blob = new Blob(this.recordedChunks, { type: finalType });
                        const elapsed = this.recStartTime > 0 ? (performance.now() - this.recStartTime) / 1000 : 0.5;
                        await this.saveRecordedAudio(this.recordingSlotId, blob, elapsed);
                    }
                    this.cleanupRecording();
                };
                // timeslice 引数なしで起動（WebKit / Safari での 0.5秒破損を完全防止）
                this.mediaRecorder.start();
            } catch (e) {
                console.warn('MediaRecorder start failed:', e);
                this.mediaRecorder = null;
            }
        }

        const card = document.getElementById(`pad-${slotId}`);
        if (card) {
            card.classList.add('recording');
            const statusEl = card.querySelector('.pad-status');
            if (statusEl) statusEl.innerText = '🔴 録音中 0:00';
        }

        // ⏱️ 実時間 (performance.now) に基づく正確・標準的な1秒刻みタイマー（iOSボイスメモ準拠: 0:00, 0:01, 0:02...）
        this.recTimer = setInterval(() => {
            const elapsed = Math.max(0, (performance.now() - this.recStartTime) / 1000);
            this.recSeconds = elapsed;
            const totalSec = Math.floor(elapsed);
            const m = Math.floor(totalSec / 60);
            const s = totalSec % 60;
            const timeStr = `${m}:${s < 10 ? '0' : ''}${s}`;

            if (card) {
                const statusEl = card.querySelector('.pad-status');
                if (statusEl) statusEl.innerText = `🔴 録音中 ${timeStr}`;
            }
            if (elapsed >= 60) {
                this.stopRecording();
            }
        }, 200);
    }

    async stopRecording() {
        if (this.recTimer) {
            clearInterval(this.recTimer);
            this.recTimer = null;
        }

        const targetSlotId = this.recordingSlotId;

        // ① PCM レコーダーからの直接 WAV 保存（劣化ゼロ・iPad 100% 互換）
        if (this.pcmRecorder && targetSlotId !== null) {
            try {
                const pcmResult = this.pcmRecorder.stop();
                this.pcmRecorder = null;
                if (pcmResult && pcmResult.blob && pcmResult.duration > 0.05) {
                    this.pcmRecorderHandled = true;
                    await this.saveRecordedAudio(targetSlotId, pcmResult.blob, pcmResult.duration);
                }
            } catch (err) {
                console.error('PCM recorder stop error:', err);
            }
        }

        // ② MediaRecorder 停止
        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            try {
                this.mediaRecorder.stop();
            } catch (e) {}
        } else if (this.pcmRecorderHandled) {
            this.cleanupRecording();
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
        this.pcmRecorderHandled = false;
        this.recStartTime = 0;
        this.recSeconds = 0;
        // 🎙️ マイクのハードウェア占有を完全に解放（スピーカーの音量低下・TTS無音化を防止）
        this.releaseMicrophone();
    }

    // ==================== 音声再生制御（階層エフェクト＆スピード反映） ====================
    async playSlot(slotId) {
        await AudioUnlocker.unlock();
        const ctx = AudioUnlocker.getContext();

        const slot = this.slots.find(s => s.id === slotId);
        if (!slot) return;

        // 🔄 インポート時やストレージ復元時に audioBlob が未初期化または base64 文字列の場合の自動復旧
        if (!slot.audioBlob && slot.audioBase64) {
            slot.audioBlob = this.base64ToBlob(slot.audioBase64);
        } else if (typeof slot.audioBlob === 'string') {
            slot.audioBlob = this.base64ToBlob(slot.audioBlob);
        }

        if (!slot.audioBlob && !slot.ttsText) {
            this.setMode('record');
            this.startRecording(slotId);
            return;
        }

        if (this.activeSources.has(slotId)) {
            this.stopSlot(slotId);
            return;
        }

        // 実効ボイスパラメータ（声質＆環境＆EQ＆特殊FX）と再生スピードの取得
        const voiceParams = this.getEffectiveVoiceParams(slot);
        const envParams = this.getEffectiveEnvParams(slot);
        const eqParams = this.getEffectiveEqParams(slot);
        const specialParams = this.getEffectiveSpecialParams(slot);
        const effectiveSpeed = this.getEffectivePlaybackSpeed(slot);

        // ① AI音声合成 (TTS) スロットの場合：HTML5 Audio / Web Speech API で確実に発話
        if (slot.ttsText) {
            this.playTtsSlot(slot, voiceParams, envParams, effectiveSpeed);
            return;
        }

        // ② 録音・取り込み音声の場合
        try {
            if (!slot.audioBlob) return;
            const arrayBuffer = await slot.audioBlob.arrayBuffer();
            const originalBuffer = await AudioUtils.decodeAudioDataSafe(ctx, arrayBuffer);

            // フルDSPエフェクト適用（声質 -> 環境 -> 3-Band EQ -> Special FX）
            const finalBuffer = VoiceEngine.processFull(originalBuffer, ctx, voiceParams, envParams, effectiveSpeed, eqParams, specialParams);

            const card = document.getElementById(`pad-${slotId}`);
            if (card) {
                card.classList.add('playing');
                card.classList.add('is-playing');
            }

            // 📱 iPhone / iPad / 全ブラウザ互換の HTML5 Audio ハイブリッド再生
            // （iPhoneのマナーモード/消音スイッチ時でも本体スピーカーからクリアかつ大音量で確実に再生）
            const slotVol = this.getEffectiveSlotVolume(slot);
            const controller = this.playBufferViaHtmlAudio(
                finalBuffer,
                effectiveSpeed,
                () => {
                    this.stopSlot(slotId);
                },
                (err) => {
                    console.error('Audio playback error, trying fallback:', err);
                    this.stopSlot(slotId);
                },
                slotVol
            );

            if (controller) {
                this.activeSources.set(slotId, controller);
            } else {
                this.stopSlot(slotId);
            }
        } catch (err) {
            console.error('Audio play error, using fallback:', err);
            this.fallbackPlay(slot, slotId, effectiveSpeed);
        }
    }

    async playTtsSlot(slot, voiceParams, envParams, speed = 1.0) {
        await AudioUnlocker.unlock();

        this.stopSlot(slot.id);

        const card = document.getElementById(`pad-${slot.id}`);
        if (card) {
            card.classList.add('playing');
            card.classList.add('is-playing');
        }

        // ① ブラウザの高品質な日本語音声合成（SpeechSynthesis）を最優先
        if ('speechSynthesis' in window) {
            this.legacyPlayTts(slot, voiceParams, envParams, speed);
            return;
        }

        // ② SpeechSynthesis 非対応時、またはフォールバック：
        // Web Audio 合成 ➜ WAV Blob ➜ HTML5 Audio (new Audio) で iPad/Safari の音量抑制・ダッキングを完全回避
        const ctx = AudioUnlocker.getContext();
        if (!ctx) return;

        try {
            const eqParams = this.getEffectiveEqParams(slot);
            const specialParams = this.getEffectiveSpecialParams(slot);
            const voiceType = slot.ttsVoice || 'woman';
            const rate = slot.ttsRate || 1.0;
            const pitch = slot.ttsPitch || 1.0;

            const rawBuffer = TtsEngine.synthesizeToBuffer(slot.ttsText, ctx, voiceType, rate, pitch);
            const finalBuffer = VoiceEngine.processFull(rawBuffer, ctx, voiceParams, envParams, speed, eqParams, specialParams);

            const slotVol = this.getEffectiveSlotVolume(slot);
            const controller = this.playBufferViaHtmlAudio(
                finalBuffer,
                speed,
                () => { this.stopSlot(slot.id); },
                (err) => {
                    console.error('HTML5 Audio TTS playback error:', err);
                    this.stopSlot(slot.id);
                },
                slotVol
            );

            if (controller) {
                this.activeSources.set(slot.id, controller);
            } else {
                this.stopSlot(slot.id);
            }
        } catch (err) {
            console.error('TTS playback error:', err);
            this.stopSlot(slot.id);
        }
    }

    legacyPlayTts(slot, voiceParams, envParams, speed = 1.0) {
        if (!('speechSynthesis' in window)) {
            alert('お使いのブラウザは音声合成に対応していません。');
            return;
        }

        this.stopSlot(slot.id);
        window.speechSynthesis.cancel();

        const card = document.getElementById(`pad-${slot.id}`);
        if (card) {
            card.classList.add('playing');
            card.classList.add('is-playing');
        }

        const utter = new SpeechSynthesisUtterance(slot.ttsText);
        const allVoices = window.speechSynthesis.getVoices();
        if (allVoices.length > 0) this.ttsVoices = allVoices;

        const hasJapanese = /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uff9f\u4e00-\u9faf]/.test(slot.ttsText);
        const resolved = this.resolveTtsVoice(slot.ttsVoice || 'ayumi');
        let selectedVoice = resolved?.voice || null;
        const isFemaleFallbackForMale = resolved?.isFemaleFallbackForMale || false;

        if (selectedVoice) {
            utter.voice = selectedVoice;
            utter.lang = (hasJapanese && !selectedVoice.lang.startsWith('ja')) ? 'ja-JP' : (selectedVoice.lang || 'ja-JP');
        } else {
            utter.lang = 'ja-JP';
        }

        const vParams = voiceParams || VoiceEngine.defaultVoiceParams();
        const eParams = envParams || VoiceEngine.defaultEnvParams();
        const baseRate = slot.ttsRate || 1.0;
        const basePitch = slot.ttsPitch || 1.0;

        const semitones = vParams.pitchSemitones || 0;
        const formant = vParams.formantRatio || 1.0;
        const pitchFactor = Math.pow(2, semitones / 12) * Math.sqrt(formant);
        const malePitchAdjustment = isFemaleFallbackForMale ? 0.72 : 1.0;
        const calculatedPitch = Math.max(0.2, Math.min(2.0, basePitch * pitchFactor * malePitchAdjustment));

        let calculatedRate = baseRate * speed;
        if (vParams.roughness > 30) calculatedRate *= 0.92;
        utter.pitch = calculatedPitch;
        utter.rate = Math.max(0.5, Math.min(2.0, calculatedRate));

        const slotVol = this.getEffectiveSlotVolume(slot);
        const gVol = (this.globalVolume !== undefined && this.globalVolume !== null) ? this.globalVolume : 1.0;
        utter.volume = Math.max(0.0, Math.min(1.0, slotVol * gVol));

        const ttsController = {
            stop: () => {
                window.speechSynthesis.cancel();
                window._activeUtterance = null;
            },
            pause: () => {
                window.speechSynthesis.cancel();
                window._activeUtterance = null;
            },
            disconnect: () => {}
        };
        this.activeSources.set(slot.id, ttsController);

        window._activeUtterance = utter;

        utter.onend = () => {
            window._activeUtterance = null;
            this.stopSlot(slot.id);
        };
        utter.onerror = () => {
            window._activeUtterance = null;
            this.stopSlot(slot.id);
        };

        VoiceEngine.playAcousticFilterOverlay(eParams);

        setTimeout(() => {
            if (window.speechSynthesis.paused) {
                window.speechSynthesis.resume();
            }
            window.speechSynthesis.speak(utter);
        }, 50);
    }

    fallbackPlay(slot, slotId, speed = 1.0) {
        if (!slot || !slot.audioBlob) return;
        try {
            const slotVol = this.getEffectiveSlotVolume(slot);
            const gVol = (this.globalVolume !== undefined && this.globalVolume !== null) ? this.globalVolume : 1.0;
            const vol = Math.max(0.0, Math.min(1.0, slotVol * gVol));
            const audioUrl = BlobUrlTracker.create(slot.audioBlob, 'playback');
            const audio = new Audio();
            audio.src = audioUrl;
            audio.playbackRate = speed;
            audio.volume = vol;

            const card = document.getElementById(`pad-${slotId}`);
            if (card) {
                card.classList.add('playing');
                card.classList.add('is-playing');
            }

            let isCleanedUp = false;
            const cleanup = () => {
                if (isCleanedUp) return;
                isCleanedUp = true;
                if (card) {
                    card.classList.remove('playing');
                    card.classList.remove('is-playing');
                }
                BlobUrlTracker.revoke(audioUrl);
                this.activeSources.delete(slotId);
            };

            audio.onended = cleanup;
            audio.onerror = (e) => {
                console.warn('Fallback audio playback error:', e);
                cleanup();
            };

            const controller = {
                audio: audio,
                url: audioUrl,
                stop: () => {
                    try {
                        audio.pause();
                        audio.currentTime = 0;
                    } catch (e) {}
                    cleanup();
                },
                pause: () => {
                    try { audio.pause(); } catch (e) {}
                },
                disconnect: () => {
                    cleanup();
                }
            };
            this.activeSources.set(slotId, controller);

            const playPromise = audio.play();
            if (playPromise !== undefined) {
                playPromise.catch((e) => {
                    console.warn('audio.play() prevented:', e);
                    cleanup();
                });
            }
        } catch (e) {
            console.error('Fallback error:', e);
        }
    }

    /**
     * AudioBuffer を WAV Blob 化し、HTML5 Audio (new Audio) でネイティブ再生
     * （iPad/iOS Safari における Web Audio API 音量ダッキング・抑制を回避）
     * グローバル音量（0.1x〜3.0x）およびソフトクリッピング（音割れ防止）を適用
     */
    playBufferViaHtmlAudio(buffer, speed = 1.0, onEnded = null, onError = null, customVolume = null) {
        if (!buffer) return null;
        try {
            const slotVol = (customVolume !== null && customVolume !== undefined) ? customVolume : 1.0;
            const gVol = (this.globalVolume !== undefined && this.globalVolume !== null) ? this.globalVolume : 1.0;
            const vol = Math.max(0.0, Math.min(3.0, slotVol * gVol));
            const softClip = (this.globalSoftClip !== undefined) ? this.globalSoftClip : true;

            const numChannels = buffer.numberOfChannels;
            const length = buffer.length;
            const sampleRate = buffer.sampleRate;
            const ctx = AudioUnlocker.getContext();

            let workingBuffer = buffer;
            if (ctx) {
                workingBuffer = ctx.createBuffer(numChannels, length, sampleRate);
                for (let ch = 0; ch < numChannels; ch++) {
                    const src = buffer.getChannelData(ch);
                    const dst = workingBuffer.getChannelData(ch);
                    for (let i = 0; i < length; i++) {
                        let sample = src[i] * vol;
                        if (softClip) {
                            dst[i] = Math.tanh(sample);
                        } else {
                            dst[i] = Math.max(-1.0, Math.min(1.0, sample));
                        }
                    }
                }
            }

            const wavBlob = AudioUtils.audioBufferToWav(workingBuffer);
            const url = BlobUrlTracker.create(wavBlob, 'playback');
            const audio = new Audio();
            audio.src = url;
            audio.playbackRate = Math.max(0.5, Math.min(2.0, speed || 1.0));
            audio.volume = Math.max(0.0, Math.min(1.0, Math.min(vol, 1.0)));

            let isCleanedUp = false;
            const cleanup = () => {
                if (isCleanedUp) return;
                isCleanedUp = true;
                BlobUrlTracker.revoke(url);
            };

            const controller = {
                audio: audio,
                url: url,
                stop: () => {
                    try {
                        audio.pause();
                        audio.currentTime = 0;
                    } catch (e) {}
                    cleanup();
                },
                pause: () => {
                    try {
                        audio.pause();
                    } catch (e) {}
                },
                disconnect: () => {
                    cleanup();
                }
            };

            audio.onended = () => {
                cleanup();
                if (onEnded) onEnded();
            };

            audio.onerror = (e) => {
                console.warn('HTML5 Audio playback error:', e);
                cleanup();
                if (onError) onError(e);
            };

            const playPromise = audio.play();
            if (playPromise !== undefined) {
                playPromise.catch((err) => {
                    console.warn('HTML5 Audio play prevented:', err);
                    cleanup();
                    if (onError) onError(err);
                });
            }

            return controller;
        } catch (err) {
            console.error('playBufferViaHtmlAudio exception:', err);
            if (onError) onError(err);
            return null;
        }
    }

    stopSlot(slotId) {
        if (this.activeSources.has(slotId)) {
            const source = this.activeSources.get(slotId);
            try {
                if (source.stop) source.stop();
                if (source.pause) source.pause();
                if (source.disconnect) source.disconnect();
            } catch (e) {}
            this.activeSources.delete(slotId);
        }
        if ('speechSynthesis' in window) {
            try { window.speechSynthesis.cancel(); } catch (e) {}
        }
        const card = document.getElementById(`pad-${slotId}`);
        if (card) {
            card.classList.remove('playing');
            card.classList.remove('is-playing');
        }
    }

    /**
     * 🛑 全ての音声再生・プレビュー・合成音の完全停止とメモリクリーンアップ
     * - Web Audio ノードの切断 (.disconnect())
     * - HTML5 Audio の停止・破棄
     * - Web Speech API (speechSynthesis) のキャンセル
     * - 再生中・プレビュー用 Blob URL の一括解放
     * - UIの再生中インジケータ（.playing, .is-playing）の解除
     */
    stopAllAudioPlayback() {
        if (this.activeSources && this.activeSources.size > 0) {
            for (const [slotId, source] of this.activeSources.entries()) {
                try {
                    if (source.stop) source.stop();
                    if (source.pause) source.pause();
                    if (source.disconnect) source.disconnect();
                } catch (e) {}
            }
            this.activeSources.clear();
        }

        if (this.fxPreviewSource) {
            this.stopFxPreview();
        }
        if (this.waveformPreviewSource) {
            this.stopWaveformPreview();
        }
        if (this.incomingAudioPreviewNode) {
            this.stopIncomingAudioPreview();
        }

        if ('speechSynthesis' in window) {
            try {
                window.speechSynthesis.cancel();
            } catch (e) {}
        }
        window._activeTtsPreviewUtterance = null;
        window._activeUtterance = null;

        BlobUrlTracker.revokeCategory('playback');
        BlobUrlTracker.revokeCategory('preview');

        document.querySelectorAll('.pad-card.playing, .pad-card.is-playing').forEach(card => {
            card.classList.remove('playing');
            card.classList.remove('is-playing');
        });
    }

    // ==================== 5. 写真・エフェクト・スピード完全対応 3階層エクスポート＆インポート ====================
    blobToBase64(blob) {
        return new Promise((resolve) => {
            if (!blob) {
                resolve(null);
                return;
            }
            if (typeof blob === 'string') {
                resolve(blob);
                return;
            }
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(blob);
        });
    }

    /**
     * iOS / Safari / Android / PC 完全互換の安全な Base64 -> Blob 変換
     * - data:audio/...;base64, プレフィックスの有無を問わず対応
     * - 改行コードや空白文字の完全サニタイズ
     * - 異常データ時の安全な null フォールバック
     */
    base64ToBlob(base64Str) {
        if (!base64Str) return null;
        if (base64Str instanceof Blob) return base64Str;
        if (typeof base64Str !== 'string') return null;

        let contentType = 'audio/wav';
        let rawBase64 = base64Str.trim();

        if (rawBase64.includes(';base64,')) {
            const parts = rawBase64.split(';base64,');
            const typePart = parts[0].replace(/^data:/, '').trim();
            if (typePart) contentType = typePart;
            rawBase64 = parts[1] || '';
        } else if (rawBase64.startsWith('data:')) {
            const commaIdx = rawBase64.indexOf(',');
            if (commaIdx !== -1) {
                const header = rawBase64.substring(5, commaIdx);
                const type = header.split(';')[0];
                if (type) contentType = type;
                rawBase64 = rawBase64.substring(commaIdx + 1);
            }
        }

        // 改行や余分な空白を除去
        rawBase64 = rawBase64.replace(/\s+/g, '');
        if (!rawBase64) return null;

        try {
            const raw = window.atob(rawBase64);
            const rawLength = raw.length;
            const uInt8Array = new Uint8Array(rawLength);
            for (let i = 0; i < rawLength; ++i) {
                uInt8Array[i] = raw.charCodeAt(i);
            }
            return new Blob([uInt8Array], { type: contentType });
        } catch (e) {
            console.error('base64ToBlob decoding failed:', e);
            return null;
        }
    }

    /**
     * スロットオブジェクトからあらゆるフォーマットの音声を Blob として安全抽出
     */
    extractAudioBlob(item) {
        if (!item) return null;
        if (item.audioBlob instanceof Blob) return item.audioBlob;
        const rawAudio = item.audioBase64 || item.audioData || item.audio || item.audio_base64 || (typeof item.audioBlob === 'string' ? item.audioBlob : null);
        if (rawAudio) {
            return this.base64ToBlob(rawAudio);
        }
        return null;
    }

    async shareOrDownloadFile(fileName, jsonString, categoryName = 'データ') {
        const blob = new Blob([jsonString], { type: 'application/json' });
        const file = new File([blob], fileName, { type: 'application/json' });

        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            try {
                await navigator.share({
                    files: [file],
                    title: fileName,
                    text: `Voice Pad ${categoryName}: ${fileName}`
                });
                this.showToast(`📤 AirDrop / 共有メニューを開きました (${fileName})`);
                return;
            } catch (err) {
                if (err.name !== 'AbortError') {
                    console.warn('Share API error, fallback to download:', err);
                } else {
                    return;
                }
            }
        }

        const url = BlobUrlTracker.create(blob, 'download');
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.click();
        setTimeout(() => BlobUrlTracker.revoke(url), 1000);
        this.showToast(`💾 「${fileName}」を保存しました`);
    }

    // ファイル直接ダウンロード保存（WebRTC/P2P受信時・AirDropダイアログをスキップして即保存）
    downloadFileDirect(fileName, jsonString) {
        const blob = new Blob([jsonString], { type: 'application/json' });
        const url = BlobUrlTracker.create(blob, 'download');
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => BlobUrlTracker.revoke(url), 1000);
        this.showToast(`📥 「${fileName}」を保存しました`);
    }

    // ボタンの完全エクスポートオブジェクト構築ヘルパー
    async buildSlotExportObject(slot) {
        if (!slot) return null;
        let audioBase64 = null;
        if (slot.audioBlob instanceof Blob) {
            audioBase64 = await this.blobToBase64(slot.audioBlob);
        } else if (typeof slot.audioBase64 === 'string' && slot.audioBase64.length > 0) {
            audioBase64 = slot.audioBase64;
        } else if (slot.audioBlob && typeof slot.audioBlob === 'string') {
            audioBase64 = slot.audioBlob;
        }

        const slotData = {
            label: slot.label || 'ボタン',
            labelPosition: slot.labelPosition || 'bottom',
            emoji: slot.emoji || '🔊'
        };

        if (slot.imageUrl) slotData.imageUrl = slot.imageUrl;
        if (slot.imageScale !== undefined && slot.imageScale !== 1.0) slotData.imageScale = slot.imageScale;
        if (slot.imageOffsetX) slotData.imageOffsetX = slot.imageOffsetX;
        if (slot.imageOffsetY) slotData.imageOffsetY = slot.imageOffsetY;
        if (slot.imageFit && slot.imageFit !== 'cover') slotData.imageFit = slot.imageFit;
        if (slot.duration) slotData.duration = slot.duration;
        if (slot.voiceEffect && slot.voiceEffect !== 'inherit') slotData.voiceEffect = slot.voiceEffect;
        if (slot.voiceEffectMode && slot.voiceEffectMode !== 'inherit') slotData.voiceEffectMode = slot.voiceEffectMode;
        if (slot.voiceParams) slotData.voiceParams = slot.voiceParams;
        if (slot.envParams) slotData.envParams = slot.envParams;
        if (slot.eqParams) slotData.eqParams = slot.eqParams;
        if (slot.specialParams) slotData.specialParams = slot.specialParams;
        if (slot.playbackSpeed && slot.playbackSpeed !== 'inherit') slotData.playbackSpeed = slot.playbackSpeed;
        if (slot.volume !== undefined && slot.volume !== null && slot.volume !== 1.0) slotData.volume = parseFloat(slot.volume);
        if (slot.ttsText) slotData.ttsText = slot.ttsText;
        if (slot.ttsVoice) slotData.ttsVoice = slot.ttsVoice;
        if (slot.ttsRate !== undefined && slot.ttsRate !== 1.0) slotData.ttsRate = slot.ttsRate;
        if (slot.ttsPitch !== undefined && slot.ttsPitch !== 1.0) slotData.ttsPitch = slot.ttsPitch;
        if (audioBase64) slotData.audioBase64 = audioBase64;

        return {
            type: 'voicepad_slot',
            version: '2.4',
            exportedAt: new Date().toISOString(),
            slot: slotData
        };
    }

    // ① 単一スイッチのエクスポート (.vpad-button)
    async exportSingleSlot(slotId) {
        const slot = this.slots.find(s => s.id === slotId);
        if (!slot) return;

        const exportData = await this.buildSlotExportObject(slot);
        if (!exportData) return;

        const safeLabel = (slot.label || 'ボタン').replace(/[\\/:*?"<>|]/g, '_');
        const fileName = `VoicePad_ボタン_${safeLabel}.vpad-button`;
        await this.shareOrDownloadFile(fileName, JSON.stringify(exportData, null, 2), '単体ボタン');
    }

    // ==================== 📡 生徒側 Wi-Fi 直接送信モーダル ====================
    async openP2pSendModal(slotId) {
        this.stopP2pScanner();
        this.closeScrollModal();

        const slot = this.slots.find(s => s.id === slotId);
        if (!slot) return;

        const modal = document.getElementById('p2p-send-modal-backdrop');
        const canvas = document.getElementById('p2p-send-qr-canvas');
        const nameEl = document.getElementById('p2p-send-slot-name');
        const emojiEl = document.getElementById('p2p-send-slot-emoji');
        const metaEl = document.getElementById('p2p-send-slot-meta');
        const statusText = document.getElementById('p2p-send-status-text');
        const loadingSpinner = document.getElementById('p2p-send-qr-loading');

        if (!modal || !canvas) return;

        if (nameEl) nameEl.innerText = slot.label || 'ボタン';
        if (emojiEl) {
            if (slot.imageUrl) {
                emojiEl.innerHTML = `<img src="${slot.imageUrl}" style="width:28px;height:28px;object-fit:cover;border-radius:6px;">`;
            } else {
                emojiEl.innerText = slot.emoji || '🔊';
            }
        }
        if (metaEl) {
            const hasAudio = !!(slot.audioBlob || slot.audioBase64);
            const dur = slot.duration ? `${slot.duration.toFixed(1)}秒` : '未録音';
            metaEl.innerText = `🎙️ 音声: ${hasAudio ? dur : 'なし'} | ⚡ ${slot.playbackSpeed && slot.playbackSpeed !== 'inherit' ? slot.playbackSpeed + '倍速' : '標準'}`;
        }

        modal.classList.add('open');
        if (loadingSpinner) loadingSpinner.style.display = 'flex';
        if (statusText) statusText.innerText = 'Wi-Fi待受QRコードを準備中...';

        const exportObj = await this.buildSlotExportObject(slot);
        if (loadingSpinner) loadingSpinner.style.display = 'none';

        // Wi-Fi 1ステップ直接送信ホストを起動（1枚の静的QRコードを表示）
        await P2PDataEngine.startWifiSender(
            exportObj,
            (qrPayload) => {
                QrEngine.renderToCanvas(canvas, qrPayload, { size: 260, margin: 14, fgColor: '#000000', bgColor: '#ffffff' });
                if (statusText) statusText.innerText = '先生の端末のカメラでこのQRコード（1枚）を読み取ってください';
            },
            (statusMsg) => {
                if (statusText) statusText.innerText = statusMsg;
            },
            (completedObj) => {
                if (statusText) statusText.innerText = '🎉 送信完了しました！';
                this.showToast(`🎉 スイッチ「${slot.label || 'ボタン'}」のWi-Fi送信が完了しました！`);
            }
        );
    }

    cancelP2pSend() {
        QrEngine.stopCameraScanner();
        P2PDataEngine.stopWifiSession();
        document.getElementById('p2p-send-modal-backdrop')?.classList.remove('open');
    }

    // ==================== 📷 先生側 Wi-Fi 直接受信モーダル ====================
    async openP2pReceiveModal() {
        this.closeScrollModal();
        this.closeEditModal();
        this.cancelP2pSend();

        const modal = document.getElementById('p2p-receive-modal-backdrop');
        const video = document.getElementById('p2p-scanner-video');
        const canvas = document.getElementById('p2p-scanner-canvas');
        const statusText = document.getElementById('p2p-receive-status-text');

        if (!modal || !video) return;

        modal.classList.add('open');
        if (statusText) statusText.innerText = 'カメラを起動中...';

        try {
            await QrEngine.startCameraScanner(
                video,
                canvas,
                (qrPayload) => this.onP2pQrDetected(qrPayload),
                (statusMsg) => {
                    if (statusText) statusText.innerText = statusMsg;
                }
            );
        } catch (e) {
            window._lastCameraError = (e ? (e.name + ': ' + e.message) : 'Unknown') + '\n' + (e?.stack || '');
            console.error('Camera start in receive modal error:', e);
            this.showToast('⚠️ カメラへのアクセスが拒否されたか利用できません');
        }
    }

    stopP2pScanner() {
        QrEngine.stopCameraScanner();
        P2PDataEngine.stopWifiSession();
        document.getElementById('p2p-receive-modal-backdrop')?.classList.remove('open');
    }

    async onP2pQrDetected(qrText) {
        const statusText = document.getElementById('p2p-receive-status-text');
        if (!qrText || typeof qrText !== 'string') return;

        // ① Wi-Fi 1ステップ WebRTC 受信
        if (qrText.startsWith('vpad_p2p:')) {
            QrEngine.stopCameraScanner();
            if (statusText) statusText.innerText = '⚡ QRコード認識！Wi-Fi経由でデータ受信中...';

            await P2PDataEngine.handleWifiReceiverScan(
                qrText,
                (statusMsg) => {
                    if (statusText) statusText.innerText = statusMsg;
                },
                async (receivedData) => {
                    try {
                        this.stopP2pScanner();
                        const label = receivedData.slot?.label || receivedData.label || 'ボタン';
                        const fileName = `VoicePad_ボタン_${label.replace(/[\\/:*?"<>|]/g, '_')}.vpad-button`;
                        const jsonStr = JSON.stringify(receivedData, null, 2);
                        this.downloadFileDirect(fileName, jsonStr);

                        await this.showIncomingShareModal(receivedData, fileName);
                        this.showToast(`🎉 ボタン「${label}」を受信・保存しました！`);
                    } catch (err) {
                        console.error('P2P receive handle error:', err);
                    }
                }
            );
            return;
        }

        // ② 単一直接QRコード (小さいデータ / オフライン)
        const res = P2PDataEngine.processDetectedPayload(qrText);
        if (res && res.complete && res.data) {
            try {
                if (statusText) statusText.innerText = '✅ 受信完了！データを保存しています...';
                this.stopP2pScanner();

                const data = res.data;
                const label = data.slot?.label || data.label || 'ボタン';
                const fileName = res.fileName || `VoicePad_ボタン_${label.replace(/[\\/:*?"<>|]/g, '_')}.vpad-button`;
                const jsonStr = JSON.stringify(data, null, 2);
                this.downloadFileDirect(fileName, jsonStr);

                await this.showIncomingShareModal(data, fileName);
                this.showToast(`🎉 ボタン「${label}」を受信・保存しました！`);
            } catch (err) {
                console.error('P2P QR receive error:', err);
            }
        }
    }

    // ② スクロール単位のエクスポート (.vpad-page)
    async exportScroll(scrollId) {
        const scroll = this.scrolls.find(s => s.id === scrollId);
        if (!scroll) return;

        const targetSlots = this.slots.filter(s => s.scrollId === scrollId);
        const serializedSlots = [];

        for (const slot of targetSlots) {
            let audioBlob = slot.audioBlob;
            if (!audioBlob && slot.audioBase64) {
                audioBlob = this.base64ToBlob(slot.audioBase64);
            }
            const audioBase64 = await this.blobToBase64(audioBlob);
            serializedSlots.push({
                label: slot.label,
                labelPosition: slot.labelPosition || 'bottom',
                emoji: slot.emoji || '🔊',
                imageUrl: slot.imageUrl || null,
                imageScale: slot.imageScale !== undefined ? slot.imageScale : 1.0,
                imageOffsetX: slot.imageOffsetX !== undefined ? slot.imageOffsetX : 0,
                imageOffsetY: slot.imageOffsetY !== undefined ? slot.imageOffsetY : 0,
                imageFit: slot.imageFit || 'cover',
                duration: slot.duration || 0,
                voiceEffect: slot.voiceEffect || 'inherit',
                voiceEffectMode: slot.voiceEffectMode || 'inherit',
                voiceParams: slot.voiceParams || null,
                envParams: slot.envParams || null,
                eqParams: slot.eqParams || null,
                specialParams: slot.specialParams || null,
                playbackSpeed: slot.playbackSpeed || 'inherit',
                ttsText: slot.ttsText || null,
                ttsVoice: slot.ttsVoice || null,
                ttsRate: slot.ttsRate || 1.0,
                ttsPitch: slot.ttsPitch || 1.0,
                order: slot.order,
                audioBase64: audioBase64
            });
        }

        const exportData = {
            type: 'voicepad_scroll',
            version: '2.4',
            exportedAt: new Date().toISOString(),
            scroll: {
                name: scroll.name,
                voiceEffect: scroll.voiceEffect || 'inherit',
                voiceEffectMode: scroll.voiceEffectMode || 'inherit',
                voiceParams: scroll.voiceParams || null,
                envParams: scroll.envParams || null,
                eqParams: scroll.eqParams || null,
                specialParams: scroll.specialParams || null,
                playbackSpeed: scroll.playbackSpeed || 'inherit'
            },
            slots: serializedSlots
        };

        const safeName = (scroll.name || 'スクロール').replace(/[\\/:*?"<>|]/g, '_');
        const fileName = `VoicePad_スクロール_${safeName}.vpad-page`;
        await this.shareOrDownloadFile(fileName, JSON.stringify(exportData, null, 2), 'スクロール');
    }

    // ③ アプリ全体の完全エクスポート (.vpad)
    async exportAllData() {
        const serializedScrolls = [];
        const serializedSlots = [];

        for (const scroll of this.scrolls) {
            serializedScrolls.push({
                id: scroll.id,
                name: scroll.name,
                voiceEffect: scroll.voiceEffect || 'inherit',
                voiceEffectMode: scroll.voiceEffectMode || 'inherit',
                voiceParams: scroll.voiceParams || null,
                envParams: scroll.envParams || null,
                eqParams: scroll.eqParams || null,
                specialParams: scroll.specialParams || null,
                playbackSpeed: scroll.playbackSpeed || 'inherit',
                order: scroll.order
            });
        }

        for (const slot of this.slots) {
            let audioBlob = slot.audioBlob;
            if (!audioBlob && slot.audioBase64) {
                audioBlob = this.base64ToBlob(slot.audioBase64);
            }
            const audioBase64 = await this.blobToBase64(audioBlob);
            serializedSlots.push({
                id: slot.id,
                scrollId: slot.scrollId,
                label: slot.label,
                labelPosition: slot.labelPosition || 'bottom',
                emoji: slot.emoji || '🔊',
                imageUrl: slot.imageUrl || null,
                imageScale: slot.imageScale !== undefined ? slot.imageScale : 1.0,
                imageOffsetX: slot.imageOffsetX !== undefined ? slot.imageOffsetX : 0,
                imageOffsetY: slot.imageOffsetY !== undefined ? slot.imageOffsetY : 0,
                imageFit: slot.imageFit || 'cover',
                duration: slot.duration || 0,
                voiceEffect: slot.voiceEffect || 'inherit',
                voiceEffectMode: slot.voiceEffectMode || 'inherit',
                voiceParams: slot.voiceParams || null,
                envParams: slot.envParams || null,
                eqParams: slot.eqParams || null,
                specialParams: slot.specialParams || null,
                playbackSpeed: slot.playbackSpeed || 'inherit',
                ttsText: slot.ttsText || null,
                ttsVoice: slot.ttsVoice || null,
                ttsRate: slot.ttsRate || 1.0,
                ttsPitch: slot.ttsPitch || 1.0,
                order: slot.order,
                audioBase64: audioBase64
            });
        }

        const exportData = {
            type: 'voicepad_all',
            version: '2.4',
            exportedAt: new Date().toISOString(),
            settings: {
                pageSize: this.pageSize,
                effect: this.currentEffect,
                globalVoiceParams: this.globalVoiceParams,
                globalEnvParams: this.globalEnvParams,
                globalEqParams: this.globalEqParams,
                globalPlaybackSpeed: this.globalPlaybackSpeed,
                globalVolume: this.globalVolume,
                globalSoftClip: this.globalSoftClip,
                currentScrollId: this.currentScrollId,
                theme: this.currentTheme,
                aacScanActive: this.aacScanActive,
                aacScanSpeed: this.aacScanSpeed,
                aacScanMode: this.aacScanMode
            },
            scrolls: serializedScrolls,
            slots: serializedSlots
        };

        const dateStr = new Date().toISOString().slice(0, 10);
        const fileName = `VoicePad_全データ_${dateStr}.vpad`;
        await this.shareOrDownloadFile(fileName, JSON.stringify(exportData, null, 2), '全データバックアップ');
    }

    // アプリ内インポート処理
    async handleGlobalImport(file) {
        if (!file) return;

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
                voiceEffect: 'inherit',
                voiceEffectMode: 'inherit',
                voiceParams: null,
                envParams: null,
                eqParams: null,
                specialParams: null,
                playbackSpeed: 'inherit',
                order: currentSlots.length + 1
            };
            await this.storage.saveSlot(newSlot);
            this.slots.push(newSlot);
            this.currentPage = Math.ceil(newSlot.order / this.pageSize);
            this.renderSlots();
            this.renderScrollTabs();
            this.showToast(`🎵 音声「${slotName}」をスイッチとして追加しました`);
            return;
        }

        try {
            const text = await file.text();
            const data = JSON.parse(text);

            if (data.type === 'voicepad_all') {
                if (confirm('アプリ全体のバックアップデータを読み込みますか？（既存のデータに統合または上書きされます）')) {
                    if (data.settings?.pageSize) {
                        this.pageSize = data.settings.pageSize;
                        await this.storage.saveSetting('pageSize', this.pageSize);
                        const pageSizeSelect = document.getElementById('setting-page-size');
                        if (pageSizeSelect) pageSizeSelect.value = String(this.pageSize);
                    }
                    if (data.settings?.effect) {
                        this.currentEffect = data.settings.effect;
                        await this.storage.saveSetting('effect', this.currentEffect);
                        const effectEl = document.getElementById('voice-effect');
                        if (effectEl) effectEl.value = this.currentEffect;
                        const globalEffectSelect = document.getElementById('setting-global-effect');
                        if (globalEffectSelect) globalEffectSelect.value = this.currentEffect;
                    }
                    if (data.settings?.globalVoiceParams) {
                        this.globalVoiceParams = { ...VoiceEngine.defaultVoiceParams(), ...data.settings.globalVoiceParams };
                        await this.storage.saveSetting('globalVoiceParams', this.globalVoiceParams);
                    }
                    if (data.settings?.globalEnvParams) {
                        this.globalEnvParams = { ...VoiceEngine.defaultEnvParams(), ...data.settings.globalEnvParams };
                        await this.storage.saveSetting('globalEnvParams', this.globalEnvParams);
                    }
                    if (data.settings?.globalEqParams) {
                        this.globalEqParams = { bass: 0, mid: 0, treble: 0, ...data.settings.globalEqParams };
                        await this.storage.saveSetting('globalEqParams', this.globalEqParams);
                    }
                    if (data.settings?.globalPlaybackSpeed) {
                        this.globalPlaybackSpeed = data.settings.globalPlaybackSpeed;
                        await this.storage.saveSetting('globalPlaybackSpeed', this.globalPlaybackSpeed);
                        const globalSpeedSelect = document.getElementById('setting-global-speed');
                        if (globalSpeedSelect) globalSpeedSelect.value = String(this.globalPlaybackSpeed);
                    }
                    if (data.settings?.globalVolume !== undefined) {
                        this.globalVolume = parseFloat(data.settings.globalVolume) || 1.0;
                        await this.storage.saveSetting('globalVolume', this.globalVolume);
                    }
                    if (data.settings?.globalSoftClip !== undefined) {
                        this.globalSoftClip = !!data.settings.globalSoftClip;
                        await this.storage.saveSetting('globalSoftClip', this.globalSoftClip);
                    }
                    this.updateGlobalAudioUI();

                    if (Array.isArray(data.scrolls)) {
                        for (const s of data.scrolls) {
                            const existing = this.scrolls.find(sc => sc.id === s.id);
                            if (!existing) {
                                const scrollObj = {
                                    ...s,
                                    voiceEffectMode: s.voiceEffectMode || 'inherit',
                                    voiceParams: s.voiceParams || null,
                                    envParams: s.envParams || null,
                                    eqParams: s.eqParams || null,
                                    specialParams: s.specialParams || null
                                };
                                await this.storage.saveScroll(scrollObj);
                                this.scrolls.push(scrollObj);
                            }
                        }
                    }

                    if (Array.isArray(data.slots)) {
                        for (const s of data.slots) {
                            const blob = this.extractAudioBlob(s);
                            const slotObj = {
                                ...s,
                                audioBlob: blob,
                                voiceEffect: s.voiceEffect || 'inherit',
                                voiceEffectMode: s.voiceEffectMode || 'inherit',
                                voiceParams: s.voiceParams || null,
                                envParams: s.envParams || null,
                                eqParams: s.eqParams || null,
                                specialParams: s.specialParams || null,
                                playbackSpeed: s.playbackSpeed || 'inherit'
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
                    this.showToast('🎉 写真・声質・環境エフェクト・スピードを含む全データを復元しました！');
                }
            } else if (data.type === 'voicepad_scroll') {
                await this.showIncomingShareModal(data, file.name);
            } else if (data.type === 'voicepad_slot' || data.slot || data.label || data.audioBase64) {
                await this.showIncomingShareModal(data, file.name);
            } else {
                alert('対応していないファイル形式です。共有されたスクロールまたはボタンのファイル（.vpad-button / .vpad-page / .vpad / .json）を選択してください。');
            }
        } catch (err) {
            console.error('Import error:', err);
            alert('ファイルの読み込みに失敗しました。正しいVoice Pad共有ファイル（.vpad-button / .vpad-page / .vpad / .json）を選択してください。');
        }
    }

    // ==================== モーダルイベント初期化 ====================
    initModalEvents() {
        document.getElementById('close-modal-btn')?.addEventListener('click', () => this.closeEditModal());
        document.getElementById('modal-backdrop')?.addEventListener('click', (e) => {
            if (e.target.id === 'modal-backdrop') this.closeEditModal();
        });
        document.getElementById('save-slot-btn')?.addEventListener('click', () => this.saveEditModal());
        document.getElementById('export-single-slot-btn')?.addEventListener('click', () => {
            if (this.editingSlotId) this.exportSingleSlot(this.editingSlotId);
        });
        // 📡 生徒側 WebRTC P2P送信ボタン
        document.getElementById('btn-slot-webrtc-send')?.addEventListener('click', () => {
            if (this.editingSlotId) this.openP2pSendModal(this.editingSlotId);
        });
        document.getElementById('close-p2p-send-modal-btn')?.addEventListener('click', () => this.cancelP2pSend());
        document.getElementById('btn-cancel-p2p-send')?.addEventListener('click', () => this.cancelP2pSend());
        document.getElementById('p2p-send-modal-backdrop')?.addEventListener('click', (e) => {
            if (e.target.id === 'p2p-send-modal-backdrop') this.cancelP2pSend();
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

        // 🗣️ スイッチ専用クイック【声質】モーダル
        document.getElementById('btn-clear-slot-voice')?.addEventListener('click', () => this.clearSlotVoiceSettings());
        document.getElementById('close-slot-voice-modal-btn')?.addEventListener('click', () => this.closeSlotVoiceModal());
        document.getElementById('slot-voice-modal-backdrop')?.addEventListener('click', (e) => {
            if (e.target.id === 'slot-voice-modal-backdrop') this.closeSlotVoiceModal();
        });
        document.getElementById('save-slot-voice-btn')?.addEventListener('click', () => this.saveSlotVoiceModal());
        document.getElementById('btn-quick-voice-preview')?.addEventListener('click', () => this.previewQuickVoiceEffect());

        // ⛰️ スイッチ専用クイック【環境】モーダル
        document.getElementById('btn-clear-slot-env')?.addEventListener('click', () => this.clearSlotEnvSettings());
        document.getElementById('close-slot-env-modal-btn')?.addEventListener('click', () => this.closeSlotEnvModal());
        document.getElementById('slot-env-modal-backdrop')?.addEventListener('click', (e) => {
            if (e.target.id === 'slot-env-modal-backdrop') this.closeSlotEnvModal();
        });
        document.getElementById('save-slot-env-btn')?.addEventListener('click', () => this.saveSlotEnvModal());
        document.getElementById('btn-quick-env-preview')?.addEventListener('click', () => this.previewQuickEnvEffect());

        // 🤖 スイッチ専用クイック【AI音声 (TTS)】モーダル
        document.getElementById('btn-clear-slot-tts')?.addEventListener('click', () => this.clearSlotTtsSettings());
        document.getElementById('close-slot-tts-modal-btn')?.addEventListener('click', () => this.closeSlotTtsModal());
        document.getElementById('slot-tts-modal-backdrop')?.addEventListener('click', (e) => {
            if (e.target.id === 'slot-tts-modal-backdrop') this.closeSlotTtsModal();
        });
        document.getElementById('save-slot-tts-btn')?.addEventListener('click', () => this.saveSlotTtsModal());
        document.getElementById('btn-slot-tts-preview')?.addEventListener('click', () => this.previewSlotTtsModal());
        document.getElementById('delete-slot-tts-btn')?.addEventListener('click', () => this.deleteSlotTtsAudio());

        // 🎛️ パラメータ調整直下のインライン試聴ボタン一括バインド
        document.querySelectorAll('.btn-inline-voice-preview').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.previewQuickVoiceEffect();
            });
        });

        document.querySelectorAll('.btn-inline-env-preview').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.previewQuickEnvEffect();
            });
        });

        document.querySelectorAll('.btn-inline-scroll-preview').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.previewScrollEffect();
            });
        });

        // 🔊 スイッチ個別音量スライダーのイベントリスナー
        const editSlotVolume = document.getElementById('edit-slot-volume');
        const editSlotVolumeVal = document.getElementById('edit-slot-volume-val');
        if (editSlotVolume) {
            editSlotVolume.addEventListener('input', (e) => {
                const val = parseFloat(e.target.value);
                const percent = Math.round(val * 100);
                if (editSlotVolumeVal) {
                    if (val === 0) {
                        editSlotVolumeVal.innerText = '0% (消音)';
                        editSlotVolumeVal.style.color = '#ef4444';
                    } else if (val === 1.0) {
                        editSlotVolumeVal.innerText = '100% (標準)';
                        editSlotVolumeVal.style.color = '#38bdf8';
                    } else if (val > 1.0) {
                        editSlotVolumeVal.innerText = `${percent}% (ブースト)`;
                        editSlotVolumeVal.style.color = '#f59e0b';
                    } else {
                        editSlotVolumeVal.innerText = `${percent}%`;
                        editSlotVolumeVal.style.color = '#38bdf8';
                    }
                }
            });
        }

        // スクロールモーダル
        document.getElementById('close-scroll-modal-btn')?.addEventListener('click', () => this.closeScrollModal());
        document.getElementById('scroll-modal-backdrop')?.addEventListener('click', (e) => {
            if (e.target.id === 'scroll-modal-backdrop') this.closeScrollModal();
        });
        document.getElementById('move-scroll-left-btn')?.addEventListener('click', () => this.moveScrollOrder(-1));
        document.getElementById('move-scroll-right-btn')?.addEventListener('click', () => this.moveScrollOrder(1));
        document.getElementById('save-scroll-btn')?.addEventListener('click', () => this.saveScrollModal());
        document.getElementById('export-scroll-btn')?.addEventListener('click', () => {
            if (this.editingScrollId) this.exportScroll(this.editingScrollId);
        });
        // 📡 先生側 WebRTC P2Pインポートボタン（QRカメラ読取）
        document.getElementById('btn-scroll-webrtc-import')?.addEventListener('click', () => {
            this.openP2pReceiveModal();
        });
        document.getElementById('btn-p2p-receive-rescan')?.addEventListener('click', () => {
            this.openP2pReceiveModal();
        });
        document.getElementById('btn-p2p-receive-manual-camera')?.addEventListener('click', async () => {
            const video = document.getElementById('p2p-scanner-video');
            const canvas = document.getElementById('p2p-scanner-canvas');
            const statusText = document.getElementById('p2p-receive-status-text');
            if (video) {
                try {
                    await QrEngine.startCameraScanner(
                        video,
                        canvas,
                        (qrPayload) => this.onP2pQrDetected(qrPayload),
                        (statusMsg) => {
                            if (statusText) statusText.innerText = statusMsg;
                        }
                    );
                } catch (err) {
                    this.showToast('⚠️ カメラへのアクセスが拒否されたか利用できません');
                }
            }
        });
        document.getElementById('close-p2p-receive-modal-btn')?.addEventListener('click', () => this.stopP2pScanner());
        document.getElementById('btn-cancel-p2p-receive')?.addEventListener('click', () => this.stopP2pScanner());
        document.getElementById('p2p-receive-modal-backdrop')?.addEventListener('click', (e) => {
            if (e.target.id === 'p2p-receive-modal-backdrop') this.stopP2pScanner();
        });
        document.getElementById('duplicate-scroll-btn')?.addEventListener('click', () => this.duplicateCurrentScroll());
        document.getElementById('delete-scroll-btn')?.addEventListener('click', () => this.deleteScrollModal());

        // 全体設定モーダル
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
        document.getElementById('setting-global-effect')?.addEventListener('change', async (e) => {
            this.currentEffect = e.target.value;
            await this.storage.saveSetting('effect', this.currentEffect);
            const effectEl = document.getElementById('voice-effect');
            if (effectEl) effectEl.value = this.currentEffect;
            this.showToast(`全体のボイスエフェクトを「${this.getVoiceEffectLabel(this.currentEffect)}」に変更しました`);
        });
        document.getElementById('setting-global-speed')?.addEventListener('change', async (e) => {
            this.globalPlaybackSpeed = parseFloat(e.target.value);
            await this.storage.saveSetting('globalPlaybackSpeed', this.globalPlaybackSpeed);
            this.renderSlots();
            this.showToast(`全体の基本再生スピードを「${this.globalPlaybackSpeed}倍速」に変更しました`);
        });
        document.getElementById('export-all-btn')?.addEventListener('click', () => this.exportAllData());
        document.getElementById('open-guide-from-settings-btn')?.addEventListener('click', () => {
            this.openGuideModal();
        });
        document.getElementById('import-from-settings-btn')?.addEventListener('click', () => {
            this.closeSettingsModal();
            document.getElementById('global-import-input')?.click();
        });
        document.getElementById('reset-all-data-btn')?.addEventListener('click', async () => {
            if (confirm('すべてのスクロール・録音音声・設定を初期状態にリセットしますか？この操作は取り消せません。')) {
                await this.storage.clearAll();
                location.reload();
            }
        });

        // 📖 使い方ガイドモーダル
        document.getElementById('close-guide-modal-btn')?.addEventListener('click', () => this.closeGuideModal());
        document.getElementById('close-guide-modal-bottom-btn')?.addEventListener('click', () => this.closeGuideModal());
        document.getElementById('guide-modal-backdrop')?.addEventListener('click', (e) => {
            if (e.target.id === 'guide-modal-backdrop') this.closeGuideModal();
        });

        // 📱 QRモーダル ＆ 招待・共有アクション
        document.getElementById('close-qr-modal-btn')?.addEventListener('click', () => this.closeQrModal());
        document.getElementById('qr-modal-backdrop')?.addEventListener('click', (e) => {
            if (e.target.id === 'qr-modal-backdrop') this.closeQrModal();
        });

        const appShareUrl = 'https://galakutar.github.io/Voice-Pad/';
        const shareTitle = 'Voice Pad - 音声録音＆タッチサンプラー';
        const shareText = '音声録音＆タッチサンプラーアプリ「Voice Pad」を使ってみてね！写真・ボイスチェンジ・スピード調整対応のWebアプリです。\n' + appShareUrl;

        // ① スマホ共有メニュー起動（LINE・メール・SNS対応）
        document.getElementById('invite-share-btn')?.addEventListener('click', async () => {
            if (navigator.share) {
                try {
                    await navigator.share({
                        title: shareTitle,
                        text: '音声録音＆タッチサンプラーアプリ「Voice Pad」を使ってみてね！',
                        url: appShareUrl
                    });
                } catch (err) {
                    if (err.name !== 'AbortError') {
                        this.showToast('共有がキャンセルまたは失敗しました');
                    }
                }
            } else {
                // 未対応時はクリップボードコピー
                try {
                    await navigator.clipboard.writeText(appShareUrl);
                    this.showToast('📋 アプリURLをコピーしました！LINEやSNSに貼り付けて招待できます');
                } catch (e) {
                    alert(`URL: ${appShareUrl}`);
                }
            }
        });

        // ② LINEで送る
        document.getElementById('invite-line-btn')?.addEventListener('click', () => {
            const lineUrl = `https://line.me/R/msg/text/?${encodeURIComponent(shareText)}`;
            window.open(lineUrl, '_blank');
        });

        // ③ メールで招待
        document.getElementById('invite-mail-btn')?.addEventListener('click', () => {
            const mailSubject = '【招待】Voice Pad - 音声録音＆タッチサンプラーアプリ';
            const mailBody = `Voice Pad（音声録音＆タッチサンプラーWebアプリ）のご案内です。\n\nワンタップで音声録音・再生ができ、写真やボイスチェンジャーも使えるアプリです。\n\n以下のURLからアクセスしてください：\n${appShareUrl}\n\n※SafariやChromeで開き「ホーム画面に追加」すると全画面アプリとして使えます。`;
            const mailtoUrl = `mailto:?subject=${encodeURIComponent(mailSubject)}&body=${encodeURIComponent(mailBody)}`;
            window.location.href = mailtoUrl;
        });

        // ④ X (Twitter) でシェア
        document.getElementById('invite-x-btn')?.addEventListener('click', () => {
            const xUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}`;
            window.open(xUrl, '_blank');
        });

        // ⑤ アプリURLコピー
        document.getElementById('copy-url-btn')?.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(appShareUrl);
                this.showToast('📋 アプリURLをコピーしました！');
            } catch (e) {
                alert(`URL: ${appShareUrl}`);
            }
        });

        // ⑤ アップデート前バックアップ確認モーダル (YES / NO / キャンセル)
        document.getElementById('close-confirm-modal-btn')?.addEventListener('click', () => this.closeBackupConfirmModal());
        document.getElementById('btn-update-cancel')?.addEventListener('click', () => this.closeBackupConfirmModal());
        document.getElementById('backup-confirm-modal-backdrop')?.addEventListener('click', (e) => {
            if (e.target.id === 'backup-confirm-modal-backdrop') this.closeBackupConfirmModal();
        });

        // YES: バックアップしてから更新を連続で実行
        document.getElementById('btn-update-yes')?.addEventListener('click', async () => {
            this.closeBackupConfirmModal();
            this.showToast('📦 バックアップを作成中...');
            try {
                await this.exportAllData();
            } catch (err) {
                console.error('Backup error:', err);
            }
            this.showToast('🚀 バックアップ完了！最新バージョンへ更新して再起動します...');
            setTimeout(() => {
                this.performAppUpdate();
            }, 1200);
        });

        // NO: バックアップせずに直接更新
        document.getElementById('btn-update-no')?.addEventListener('click', () => {
            this.closeBackupConfirmModal();
            this.performAppUpdate();
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

        // スピード設定同期
        const speedSelect = document.getElementById('edit-slot-speed');
        if (speedSelect) {
            speedSelect.value = slot.playbackSpeed || 'inherit';
            const parentSpeed = this.getScrollEffectiveSpeed(slot.scrollId);
            speedSelect.options[0].text = `🔄 スクロール設定に従う (現在: ${parentSpeed}x)`;
        }

        // 🔊 スイッチ個別音量スライダー初期化
        const slotVol = this.getEffectiveSlotVolume(slot);
        const slotVolSlider = document.getElementById('edit-slot-volume');
        const slotVolBadge = document.getElementById('edit-slot-volume-val');
        if (slotVolSlider) {
            slotVolSlider.value = slotVol;
        }
        if (slotVolBadge) {
            const percent = Math.round(slotVol * 100);
            if (slotVol === 0) {
                slotVolBadge.innerText = '0% (消音)';
                slotVolBadge.style.color = '#ef4444';
            } else if (slotVol === 1.0) {
                slotVolBadge.innerText = '100% (標準)';
                slotVolBadge.style.color = '#38bdf8';
            } else if (slotVol > 1.0) {
                slotVolBadge.innerText = `${percent}% (ブースト)`;
                slotVolBadge.style.color = '#f59e0b';
            } else {
                slotVolBadge.innerText = `${percent}%`;
                slotVolBadge.style.color = '#38bdf8';
            }
        }

        const emojiInput = document.getElementById('edit-emoji');
        if (emojiInput) emojiInput.value = slot.emoji || '🔊';

        this.editingImageUrl = slot.imageUrl || null;
        this.editingImageScale = slot.imageScale !== undefined ? slot.imageScale : 1.0;
        this.editingImageOffsetX = slot.imageOffsetX !== undefined ? slot.imageOffsetX : 0;
        this.editingImageOffsetY = slot.imageOffsetY !== undefined ? slot.imageOffsetY : 0;
        this.editingImageFit = slot.imageFit || 'cover';

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
                statusEl.innerText = (slot.audioBlob || slot.ttsText) ? `${(slot.duration || 1.0).toFixed(1)}s` : '未録音';
            }
        }

        const currentPos = slot.labelPosition || 'bottom';
        const posInput = document.getElementById('edit-label-pos');
        if (posInput) posInput.value = currentPos;
        document.querySelectorAll('.pos-btn').forEach(btn => {
            if (btn.getAttribute('data-pos') === currentPos) btn.classList.add('active');
            else btn.classList.remove('active');
        });

        document.querySelectorAll('.emoji-opt').forEach(opt => {
            if (!this.editingImageUrl && opt.innerText === slot.emoji) opt.classList.add('selected');
            else opt.classList.remove('selected');
        });

        this.updateModalPhotoPreview();

        // ✂️ 波形エディターの同期＆描画（録音データがある時のみ）
        this.initWaveformForSlot(slot);

        const deleteAudioBtn = document.getElementById('delete-audio-btn');
        const downloadAudioBtn = document.getElementById('download-audio-btn');
        if (slot.audioBlob || slot.ttsText) {
            if (deleteAudioBtn) deleteAudioBtn.style.display = 'block';
            if (downloadAudioBtn) downloadAudioBtn.style.display = slot.audioBlob ? 'block' : 'none';
        } else {
            if (deleteAudioBtn) deleteAudioBtn.style.display = 'none';
            if (downloadAudioBtn) downloadAudioBtn.style.display = 'none';
        }

        document.getElementById('modal-backdrop')?.classList.add('open');
    }

    closeEditModal() {
        this.stopWaveformPreview();
        this.stopFxPreview();
        this.waveformAudioBuffer = null;
        if ('speechSynthesis' in window) {
            try { window.speechSynthesis.cancel(); } catch (e) {}
        }
        BlobUrlTracker.revokeCategory('preview');
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
        const speedSelect = document.getElementById('edit-slot-speed');

        slot.label = labelInput || `ボタン`;
        slot.labelPosition = labelPos;
        slot.emoji = emojiInput || '🔊';
        slot.imageUrl = this.editingImageUrl;
        slot.imageScale = this.editingImageScale;
        slot.imageOffsetX = this.editingImageOffsetX;
        slot.imageOffsetY = this.editingImageOffsetY;
        slot.imageFit = this.editingImageFit;

        if (speedSelect) {
            slot.playbackSpeed = speedSelect.value;
        }

        const volSlider = document.getElementById('edit-slot-volume');
        if (volSlider) {
            const v = parseFloat(volSlider.value);
            slot.volume = isNaN(v) ? 1.0 : Math.max(0.0, Math.min(2.0, v));
        }

        await this.storage.saveSlot(slot);
        this.renderSlots();
        this.closeEditModal();
        this.showToast(`💾 スイッチ「${slot.label}」の設定を保存しました`);
    }

    async deleteSlotAudio() {
        if (!this.editingSlotId) return;
        const slot = this.slots.find(s => s.id === this.editingSlotId);
        if (!slot) return;

        if (confirm('このスイッチの音声データ（録音またはAI音声）を消去しますか？')) {
            this.stopSlot(slot.id);
            slot.audioBlob = null;
            slot.ttsText = null;
            slot.ttsVoice = null;
            slot.duration = 0;
            await this.storage.saveSlot(slot);
            this.renderSlots();
            this.closeEditModal();
            this.showToast('🔇 音声を消去しました');
        }
    }

    downloadSlotAudio() {
        if (!this.editingSlotId) return;
        const slot = this.slots.find(s => s.id === this.editingSlotId);
        if (slot && slot.audioBlob) {
            const url = BlobUrlTracker.create(slot.audioBlob, 'download');
            const a = document.createElement('a');
            a.href = url;
            const ext = slot.audioBlob.type.includes('mp4') ? 'm4a' : (slot.audioBlob.type.includes('wav') ? 'wav' : 'webm');
            const safeLabel = (slot.label || 'voice').replace(/[\\/:*?"<>|]/g, '_');
            a.download = `${safeLabel}.${ext}`;
            a.click();
            setTimeout(() => BlobUrlTracker.revoke(url), 1000);
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

    initEditorEvents() {
        document.querySelectorAll('.pos-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.pos-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const posInput = document.getElementById('edit-label-pos');
                if (posInput) posInput.value = btn.getAttribute('data-pos');
                this.updateModalPhotoPreview();
            });
        });

        document.getElementById('edit-label')?.addEventListener('input', () => {
            this.updateModalPhotoPreview();
        });

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

        const zoomSlider = document.getElementById('photo-zoom-slider');
        if (zoomSlider) {
            zoomSlider.addEventListener('input', (e) => {
                this.editingImageScale = parseInt(e.target.value, 10) / 100;
                const zoomVal = document.getElementById('photo-zoom-val');
                if (zoomVal) zoomVal.innerText = `${e.target.value}%`;
                this.applyPhotoCropTransform();
            });
        }

        document.querySelectorAll('.dpad-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const moveType = btn.getAttribute('data-move');
                const step = 8;
                if (moveType === 'up') this.editingImageOffsetY -= step;
                else if (moveType === 'down') this.editingImageOffsetY += step;
                else if (moveType === 'left') this.editingImageOffsetX -= step;
                else if (moveType === 'right') this.editingImageOffsetX += step;
                else if (moveType === 'reset') {
                    this.editingImageOffsetX = 0;
                    this.editingImageOffsetY = 0;
                    this.editingImageScale = 1.0;
                    const zoomSlider = document.getElementById('photo-zoom-slider');
                    if (zoomSlider) {
                        zoomSlider.value = 100;
                        const zoomVal = document.getElementById('photo-zoom-val');
                        if (zoomVal) zoomVal.innerText = '100%';
                    }
                }
                this.applyPhotoCropTransform();
            });
        });

        const fitCover = document.getElementById('btn-fit-cover');
        const fitContain = document.getElementById('btn-fit-contain');
        if (fitCover && fitContain) {
            fitCover.addEventListener('click', () => {
                this.editingImageFit = 'cover';
                fitCover.classList.add('active');
                fitContain.classList.remove('active');
                this.applyPhotoCropTransform();
            });
            fitContain.addEventListener('click', () => {
                this.editingImageFit = 'contain';
                fitContain.classList.add('active');
                fitCover.classList.remove('active');
                this.applyPhotoCropTransform();
            });
        }

        const viewport = document.getElementById('photo-crop-viewport');
        if (viewport) {
            let isDragging = false;
            let startX = 0, startY = 0;
            let initialOffsetX = 0, initialOffsetY = 0;

            const onStart = (clientX, clientY) => {
                if (!this.editingImageUrl) return;
                isDragging = true;
                startX = clientX;
                startY = clientY;
                initialOffsetX = this.editingImageOffsetX || 0;
                initialOffsetY = this.editingImageOffsetY || 0;
            };
            const onMove = (clientX, clientY) => {
                if (!isDragging) return;
                const dx = clientX - startX;
                const dy = clientY - startY;
                this.editingImageOffsetX = initialOffsetX + dx;
                this.editingImageOffsetY = initialOffsetY + dy;
                this.applyPhotoCropTransform();
            };
            const onEnd = () => { isDragging = false; };

            viewport.addEventListener('mousedown', (e) => {
                e.preventDefault();
                onStart(e.clientX, e.clientY);
            });
            window.addEventListener('mousemove', (e) => onMove(e.clientX, e.clientY));
            window.addEventListener('mouseup', onEnd);

            viewport.addEventListener('touchstart', (e) => {
                if (e.touches.length === 1) {
                    onStart(e.touches[0].clientX, e.touches[0].clientY);
                }
            }, { passive: true });
            window.addEventListener('touchmove', (e) => {
                if (e.touches.length === 1 && isDragging) {
                    onMove(e.touches[0].clientX, e.touches[0].clientY);
                }
            }, { passive: true });
            window.addEventListener('touchend', onEnd);
        }
    }

    async handlePhotoUpload(file) {
        if (!file) return;
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                this.editingImageUrl = e.target.result;
                this.editingImageScale = 1.0;
                this.editingImageOffsetX = 0;
                this.editingImageOffsetY = 0;
                this.editingImageFit = 'cover';
                this.updateModalPhotoPreview();
                resolve();
            };
            reader.readAsDataURL(file);
        });
    }

    applyPhotoCropTransform() {
        const img = document.getElementById('photo-crop-img');
        if (img) {
            img.style.transform = `translate(${this.editingImageOffsetX || 0}px, ${this.editingImageOffsetY || 0}px) scale(${this.editingImageScale || 1.0})`;
            img.style.objectFit = this.editingImageFit || 'cover';
        }
    }

    updateModalPhotoPreview() {
        const adjustBox = document.getElementById('photo-adjust-box');
        const removePhotoBtn = document.getElementById('remove-photo-btn');
        const img = document.getElementById('photo-crop-img');
        const fitCover = document.getElementById('btn-fit-cover');
        const fitContain = document.getElementById('btn-fit-contain');
        const zoomSlider = document.getElementById('photo-zoom-slider');
        const zoomVal = document.getElementById('photo-zoom-val');

        if (this.editingImageUrl) {
            if (adjustBox) adjustBox.style.display = 'block';
            if (removePhotoBtn) removePhotoBtn.style.display = 'inline-block';
            if (img) img.src = this.editingImageUrl;

            if (zoomSlider) zoomSlider.value = Math.round((this.editingImageScale || 1.0) * 100);
            if (zoomVal) zoomVal.innerText = `${Math.round((this.editingImageScale || 1.0) * 100)}%`;

            if (this.editingImageFit === 'contain') {
                fitContain?.classList.add('active');
                fitCover?.classList.remove('active');
            } else {
                fitCover?.classList.add('active');
                fitContain?.classList.remove('active');
            }
            this.applyPhotoCropTransform();
        } else {
            if (adjustBox) adjustBox.style.display = 'none';
            if (removePhotoBtn) removePhotoBtn.style.display = 'none';
            if (img) img.src = '';
        }

        const label = document.getElementById('edit-label')?.value || '';
        const pos = document.getElementById('edit-label-pos')?.value || 'bottom';

        ['top', 'center', 'bottom'].forEach(p => {
            const el = document.getElementById(`preview-label-${p}`);
            if (el) {
                if (p === pos && label) {
                    el.innerText = label;
                    el.style.display = 'block';
                } else {
                    el.innerText = '';
                    el.style.display = 'none';
                }
            }
        });
    }

    // ==================== 🎙️ Voicemod スタイル ボイスラボ UIバインディング ＆ 試聴 ====================
    initVoiceEngineUIEvents() {
        this.bindFxSliders('scroll');
        this.bindFxSliders('global');
        this.bindFxSliders('quick-voice');
        this.bindFxSliders('quick-env');
        this.initVoicemodCategoryTabs();
        this.initEnvironmentCategoryTabs();

        // スクロールモーダルのモード切り替え
        document.getElementById('edit-scroll-effect-mode')?.addEventListener('change', (e) => {
            const panel = document.getElementById('scroll-fx-custom-panel');
            if (panel) panel.style.display = e.target.value === 'custom' ? 'flex' : 'none';
        });

        // スクロールエフェクト試聴ボタン
        document.getElementById('btn-scroll-fx-preview')?.addEventListener('click', () => {
            this.previewScrollEffect();
        });

        // グローバルエフェクト変更の自動保存
        const globalSliders = [
            'global-pitch-slider', 'global-formant-slider', 'global-rough-slider',
            'global-reverb-slider', 'global-filter-slider', 'global-mod-slider'
        ];
        globalSliders.forEach(id => {
            document.getElementById(id)?.addEventListener('change', () => this.saveGlobalFxSettings());
        });

        // 🗣️ クイック声質モーダル: スライダー入力イベント
        const qvPitch = document.getElementById('quick-voice-pitch-slider');
        const qvPitchVal = document.getElementById('quick-voice-pitch-val');
        if (qvPitch && qvPitchVal) {
            qvPitch.addEventListener('input', (e) => {
                const val = parseInt(e.target.value, 10);
                qvPitchVal.innerText = val > 0 ? `+${val} 半音` : val < 0 ? `${val} 半音` : '±0 半音';
            });
        }
        const qvFormant = document.getElementById('quick-voice-formant-slider');
        const qvFormantVal = document.getElementById('quick-voice-formant-val');
        if (qvFormant && qvFormantVal) {
            qvFormant.addEventListener('input', (e) => {
                const val = parseFloat(e.target.value);
                const desc = val <= 0.55 ? '極太/巨人・モンスター' : val <= 0.8 ? '太声/巨漢' : val >= 1.4 ? '超高域/妖精' : val >= 1.2 ? '子ども/女性' : '標準';
                qvFormantVal.innerText = `${val.toFixed(2)}x (${desc})`;
            });
        }
        const qvRough = document.getElementById('quick-voice-rough-slider');
        const qvRoughVal = document.getElementById('quick-voice-rough-val');
        if (qvRough && qvRoughVal) {
            qvRough.addEventListener('input', (e) => {
                const val = parseInt(e.target.value, 10);
                const desc = val === 0 ? 'クリア' : val <= 40 ? 'ハスキー' : 'かすれ・歪み';
                qvRoughVal.innerText = `${val}% (${desc})`;
            });
        }
        const qvSpeed = document.getElementById('quick-voice-speed-slider');
        const qvSpeedVal = document.getElementById('quick-voice-speed-val');
        if (qvSpeed && qvSpeedVal) {
            qvSpeed.addEventListener('input', (e) => {
                const val = parseFloat(e.target.value);
                const desc = val === 1.0 ? '等倍' : val < 1.0 ? 'ゆっくり' : '倍速';
                qvSpeedVal.innerText = `${val.toFixed(2)}x (${desc})`;
            });
        }

        // 🗣️ クイック声質プリセット
        document.querySelectorAll('#quick-voice-preset-chips .fx-chip-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const presetName = btn.getAttribute('data-preset');
                const preset = VoiceEngine.presetToParams(presetName).voice;
                if (qvPitch) { qvPitch.value = preset.pitchSemitones; qvPitch.dispatchEvent(new Event('input')); }
                if (qvFormant) { qvFormant.value = preset.formantRatio; qvFormant.dispatchEvent(new Event('input')); }
                if (qvRough) { qvRough.value = preset.roughness; qvRough.dispatchEvent(new Event('input')); }

                document.querySelectorAll('#quick-voice-preset-chips .fx-chip-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                const modeSelect = document.getElementById('slot-quick-voice-mode');
                if (modeSelect) modeSelect.value = 'custom';
            });
        });

        // 🗣️ スクロール声質プリセット
        document.querySelectorAll('#scroll-voice-preset-chips .fx-chip-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const presetName = btn.getAttribute('data-preset');
                const preset = VoiceEngine.presetToParams(presetName).voice;
                this.setFxParamsToUI('scroll', preset, null);
                document.querySelectorAll('#scroll-voice-preset-chips .fx-chip-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const modeSelect = document.getElementById('edit-scroll-effect-mode');
                if (modeSelect) modeSelect.value = 'custom';
            });
        });

        // ⛰️ クイック環境モーダル: スライダー入力イベント
        const qeReverb = document.getElementById('quick-env-reverb-slider');
        const qeReverbVal = document.getElementById('quick-env-reverb-val');
        if (qeReverb && qeReverbVal) {
            qeReverb.addEventListener('input', (e) => {
                const val = parseInt(e.target.value, 10);
                const desc = val === 0 ? '反響なし' : val <= 50 ? 'お風呂' : '大聖堂/洞窟';
                qeReverbVal.innerText = `${val}% (${desc})`;
            });
        }
        const qeFilter = document.getElementById('quick-env-filter-slider');
        const qeFilterVal = document.getElementById('quick-env-filter-val');
        if (qeFilter && qeFilterVal) {
            qeFilter.addEventListener('input', (e) => {
                const val = parseInt(e.target.value, 10);
                const desc = val === 0 ? '原音' : val <= 50 ? '水の中/こもり' : 'メガホン/電話';
                qeFilterVal.innerText = `${val}% (${desc})`;
            });
        }
        const qeMod = document.getElementById('quick-env-mod-slider');
        const qeModVal = document.getElementById('quick-env-mod-val');
        if (qeMod && qeModVal) {
            qeMod.addEventListener('input', (e) => {
                const val = parseInt(e.target.value, 10);
                const desc = val === 0 ? 'オフ' : val <= 50 ? '宇宙人/うねり' : '金属ロボット';
                qeModVal.innerText = `${val}% (${desc})`;
            });
        }
        const qeAmbVol = document.getElementById('quick-env-ambient-vol-slider');
        const qeAmbVolVal = document.getElementById('quick-env-ambient-vol-val');
        if (qeAmbVol && qeAmbVolVal) {
            qeAmbVol.addEventListener('input', (e) => {
                const val = parseInt(e.target.value, 10);
                qeAmbVolVal.innerText = `${val}%`;
            });
        }

        // ⛰️ クイック環境プリセット
        document.querySelectorAll('#quick-env-preset-chips .fx-chip-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const presetName = btn.getAttribute('data-preset');
                const preset = VoiceEngine.presetToParams(presetName).env;
                if (qeReverb) { qeReverb.value = preset.reverb; qeReverb.dispatchEvent(new Event('input')); }
                if (qeFilter) { qeFilter.value = preset.filter; qeFilter.dispatchEvent(new Event('input')); }
                if (qeMod) { qeMod.value = preset.modulation; qeMod.dispatchEvent(new Event('input')); }

                document.querySelectorAll('#quick-env-preset-chips .fx-chip-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                const modeSelect = document.getElementById('slot-quick-env-mode');
                if (modeSelect) modeSelect.value = 'custom';
            });
        });

        // ⛰️ スクロール環境プリセット
        document.querySelectorAll('#scroll-env-preset-chips .fx-chip-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const presetName = btn.getAttribute('data-preset');
                const preset = VoiceEngine.presetToParams(presetName).env;
                this.setFxParamsToUI('scroll', null, preset);
                document.querySelectorAll('#scroll-env-preset-chips .fx-chip-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const modeSelect = document.getElementById('edit-scroll-effect-mode');
                if (modeSelect) modeSelect.value = 'custom';
            });
        });

        // スピードドロップダウンとスライダーの双方向同期
        document.getElementById('edit-slot-speed')?.addEventListener('change', (e) => {
            const slider = document.getElementById('slot-speed-slider');
            if (slider && e.target.value !== 'inherit') {
                slider.value = parseFloat(e.target.value);
                slider.dispatchEvent(new Event('input'));
            }
        });
        document.getElementById('edit-scroll-speed')?.addEventListener('change', (e) => {
            const slider = document.getElementById('scroll-speed-slider');
            if (slider && e.target.value !== 'inherit') {
                slider.value = parseFloat(e.target.value);
                slider.dispatchEvent(new Event('input'));
            }
        });
    }

    /**
     * Voicemod風 カテゴリタブの初期化
     */
    initVoicemodCategoryTabs() {
        const tabConfigs = [
            { tabsId: 'slot-voicemod-tabs', gridId: 'slot-voicemod-grid', prefix: 'slot' },
            { tabsId: 'quick-voice-voicemod-tabs', gridId: 'quick-voice-voicemod-grid', prefix: 'quick-voice' },
            { tabsId: 'scroll-voicemod-tabs', gridId: 'scroll-voicemod-grid', prefix: 'scroll' }
        ];

        tabConfigs.forEach(({ tabsId, gridId, prefix }) => {
            document.querySelectorAll(`#${tabsId} .vm-tab-btn`).forEach(btn => {
                btn.addEventListener('click', () => {
                    document.querySelectorAll(`#${tabsId} .vm-tab-btn`).forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    const category = btn.getAttribute('data-category');
                    this.renderVoicemodPresetCards(gridId, category, prefix);
                });
            });
        });
    }

    /**
     * ⛰️ 環境カテゴリタブの初期化
     */
    initEnvironmentCategoryTabs() {
        document.querySelectorAll('#quick-env-voicemod-tabs .vm-tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('#quick-env-voicemod-tabs .vm-tab-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const category = btn.getAttribute('data-category');
                this.renderEnvironmentPresetCards('quick-env-voicemod-grid', category);
            });
        });
    }

    /**
     * Voicemod風 プリセットカード一覧の動的描画
     */
    renderVoicemodPresetCards(containerId, category = 'all', prefix = 'slot') {
        const container = document.getElementById(containerId);
        if (!container) return;

        const allPresets = VoiceEngine.getVoicemodPresets();
        const filtered = category === 'all' ? allPresets : allPresets.filter(p => p.category === category);

        container.innerHTML = '';
        filtered.forEach(preset => {
            const card = document.createElement('div');
            card.className = 'vm-card';
            card.setAttribute('data-vm-id', preset.id);

            card.innerHTML = `
                <div class="vm-card-icon">${preset.icon}</div>
                <div class="vm-card-name">${this.escapeHtml(preset.name)}</div>
                <div class="vm-card-desc">${this.escapeHtml(preset.desc)}</div>
            `;

            card.addEventListener('click', () => {
                container.querySelectorAll('.vm-card').forEach(c => c.classList.remove('active'));
                card.classList.add('active');
                this.applyVoicemodPresetToUI(preset, prefix);
                this.showToast(`✨ Voicemod「${preset.name}」を適用しました`);
            });

            container.appendChild(card);
        });
    }

    /**
     * 選択されたVoicemodプリセットのパラメータをスライダーUIへ一括適用
     */
    applyVoicemodPresetToUI(preset, prefix) {
        this.setFxParamsToUI(prefix, preset.voice, preset.env, preset.eq, preset.special);
        // モードを「個別に設定」に自動切り替え
        const modeSelectId = prefix === 'quick-voice' ? 'slot-quick-voice-mode' : `edit-${prefix}-effect-mode`;
        const modeSelect = document.getElementById(modeSelectId);
        if (modeSelect) {
            modeSelect.value = 'custom';
            modeSelect.dispatchEvent(new Event('change'));
        }
    }

    /**
     * ⛰️ 環境プリセットカード一覧の動的描画
     */
    renderEnvironmentPresetCards(containerId = 'quick-env-voicemod-grid', category = 'all') {
        const container = document.getElementById(containerId);
        if (!container) return;

        const allPresets = VoiceEngine.getEnvironmentPresets();
        const filtered = category === 'all' ? allPresets : allPresets.filter(p => p.category === category);

        container.innerHTML = '';
        filtered.forEach(preset => {
            const card = document.createElement('div');
            card.className = 'vm-card';
            card.setAttribute('data-vm-id', preset.id);

            card.innerHTML = `
                <div class="vm-card-icon">${preset.icon}</div>
                <div class="vm-card-name">${this.escapeHtml(preset.name)}</div>
                <div class="vm-card-desc">${this.escapeHtml(preset.desc)}</div>
            `;

            card.addEventListener('click', () => {
                container.querySelectorAll('.vm-card').forEach(c => c.classList.remove('active'));
                card.classList.add('active');
                this.applyEnvironmentPresetToUI(preset);
                this.showToast(`✨ 環境「${preset.name}」を適用しました（下のシークバーで微調整できます）`);
            });

            container.appendChild(card);
        });
    }

    /**
     * 選択された環境プリセットのパラメータをスライダーUIへ即時反映（シークバーは常に表示されて微調整可能）
     */
    applyEnvironmentPresetToUI(preset) {
        const env = preset.env || {};
        const reverbSlider = document.getElementById('quick-env-reverb-slider');
        const filterSlider = document.getElementById('quick-env-filter-slider');
        const modSlider = document.getElementById('quick-env-mod-slider');
        const ambVolSlider = document.getElementById('quick-env-ambient-vol-slider');
        const ambSoundSelect = document.getElementById('quick-env-ambient-sound-select');

        if (reverbSlider) { reverbSlider.value = env.reverb ?? 0; reverbSlider.dispatchEvent(new Event('input')); }
        if (filterSlider) { filterSlider.value = env.filter ?? 0; filterSlider.dispatchEvent(new Event('input')); }
        if (modSlider) { modSlider.value = env.modulation ?? 0; modSlider.dispatchEvent(new Event('input')); }
        if (ambVolSlider) { ambVolSlider.value = env.ambientVolume ?? 35; ambVolSlider.dispatchEvent(new Event('input')); }
        if (ambSoundSelect) { ambSoundSelect.value = env.ambientSound ?? 'none'; }

        // モードを「個別に設定」に自動切り替え
        const modeSelect = document.getElementById('slot-quick-env-mode');
        if (modeSelect) {
            modeSelect.value = 'custom';
            modeSelect.dispatchEvent(new Event('change'));
        }
    }

    bindFxSliders(prefix) {
        // ① ピッチシフト
        const pitchSlider = document.getElementById(`${prefix}-pitch-slider`);
        const pitchVal = document.getElementById(`${prefix}-pitch-val`);
        if (pitchSlider && pitchVal) {
            pitchSlider.addEventListener('input', (e) => {
                const val = parseInt(e.target.value, 10);
                pitchVal.innerText = val > 0 ? `+${val} 半音` : val < 0 ? `${val} 半音` : '±0 半音';
            });
        }

        // ② フォルマントシフト
        const formantSlider = document.getElementById(`${prefix}-formant-slider`);
        const formantVal = document.getElementById(`${prefix}-formant-val`);
        if (formantSlider && formantVal) {
            formantSlider.addEventListener('input', (e) => {
                const val = parseFloat(e.target.value);
                const desc = val <= 0.55 ? '極太/巨人・モンスター' : val <= 0.8 ? '太声/巨漢' : val >= 1.4 ? '超高域/妖精' : val >= 1.2 ? '子ども/女性' : '標準';
                formantVal.innerText = `${val.toFixed(2)}x (${desc})`;
            });
        }

        // ③ 質感・ざらつき
        const roughSlider = document.getElementById(`${prefix}-rough-slider`);
        const roughVal = document.getElementById(`${prefix}-rough-val`);
        if (roughSlider && roughVal) {
            roughSlider.addEventListener('input', (e) => {
                const val = parseInt(e.target.value, 10);
                const desc = val === 0 ? 'クリア' : val <= 40 ? 'ハスキー' : 'かすれ・歪み';
                roughVal.innerText = `${val}% (${desc})`;
            });
        }

        // ④ 再生スピード
        const speedSlider = document.getElementById(`${prefix}-speed-slider`);
        const speedVal = document.getElementById(`${prefix}-speed-val`);
        if (speedSlider && speedVal) {
            speedSlider.addEventListener('input', (e) => {
                const val = parseFloat(e.target.value);
                const desc = val === 1.0 ? '等倍' : val < 1.0 ? 'ゆっくり' : '倍速';
                speedVal.innerText = `${val.toFixed(2)}x (${desc})`;
                if (prefix === 'slot') {
                    const speedSelect = document.getElementById('edit-slot-speed');
                    if (speedSelect) {
                        const opt = Array.from(speedSelect.options).find(o => Math.abs(parseFloat(o.value) - val) < 0.01);
                        if (opt) speedSelect.value = opt.value;
                    }
                } else if (prefix === 'scroll') {
                    const speedSelect = document.getElementById('edit-scroll-speed');
                    if (speedSelect) {
                        const opt = Array.from(speedSelect.options).find(o => Math.abs(parseFloat(o.value) - val) < 0.01);
                        if (opt) speedSelect.value = opt.value;
                    }
                }
            });
        }

        // ⑤ リバーブ
        const reverbSlider = document.getElementById(`${prefix}-reverb-slider`);
        const reverbVal = document.getElementById(`${prefix}-reverb-val`);
        if (reverbSlider && reverbVal) {
            reverbSlider.addEventListener('input', (e) => {
                const val = parseInt(e.target.value, 10);
                const desc = val === 0 ? 'ドライ' : val <= 50 ? 'お風呂' : '大ホール/洞窟';
                reverbVal.innerText = `${val}% (${desc})`;
            });
        }

        // ⑥ フィルター
        const filterSlider = document.getElementById(`${prefix}-filter-slider`);
        const filterVal = document.getElementById(`${prefix}-filter-val`);
        if (filterSlider && filterVal) {
            filterSlider.addEventListener('input', (e) => {
                const val = parseInt(e.target.value, 10);
                const desc = val === 0 ? 'オフ' : val <= 50 ? '水の中/こもり' : 'メガホン/電話';
                filterVal.innerText = `${val}% (${desc})`;
            });
        }

        // ⑦ モジュレーション
        const modSlider = document.getElementById(`${prefix}-mod-slider`);
        const modVal = document.getElementById(`${prefix}-mod-val`);
        if (modSlider && modVal) {
            modSlider.addEventListener('input', (e) => {
                const val = parseInt(e.target.value, 10);
                const desc = val === 0 ? 'オフ' : val <= 50 ? '宇宙人' : '金属ロボット';
                modVal.innerText = `${val}% (${desc})`;
            });
        }

        // ⑧ 3バンドEQ (Bass / Mid / Treble)
        const eqBass = document.getElementById(`${prefix}-eq-bass-slider`);
        const eqBassVal = document.getElementById(`${prefix}-eq-bass-val`);
        if (eqBass && eqBassVal) {
            eqBass.addEventListener('input', (e) => {
                const val = parseInt(e.target.value, 10);
                eqBassVal.innerText = val > 0 ? `+${val} dB` : `${val} dB`;
            });
        }
        const eqMid = document.getElementById(`${prefix}-eq-mid-slider`);
        const eqMidVal = document.getElementById(`${prefix}-eq-mid-val`);
        if (eqMid && eqMidVal) {
            eqMid.addEventListener('input', (e) => {
                const val = parseInt(e.target.value, 10);
                eqMidVal.innerText = val > 0 ? `+${val} dB` : `${val} dB`;
            });
        }
        const eqTreble = document.getElementById(`${prefix}-eq-treble-slider`);
        const eqTrebleVal = document.getElementById(`${prefix}-eq-treble-val`);
        if (eqTreble && eqTrebleVal) {
            eqTreble.addEventListener('input', (e) => {
                const val = parseInt(e.target.value, 10);
                eqTrebleVal.innerText = val > 0 ? `+${val} dB` : `${val} dB`;
            });
        }

        // ⑨ 特殊エフェクト (Special FX)
        const chorusSlider = document.getElementById(`${prefix}-special-chorus-slider`);
        const chorusVal = document.getElementById(`${prefix}-special-chorus-val`);
        if (chorusSlider && chorusVal) {
            chorusSlider.addEventListener('input', (e) => {
                const val = parseInt(e.target.value, 10);
                const desc = val === 0 ? 'オフ' : val <= 50 ? '厚み/コーラス' : '分身・大合唱';
                chorusVal.innerText = `${val}% (${desc})`;
            });
        }

        const radioSlider = document.getElementById(`${prefix}-special-radio-slider`);
        const radioVal = document.getElementById(`${prefix}-special-radio-val`);
        if (radioSlider && radioVal) {
            radioSlider.addEventListener('input', (e) => {
                const val = parseInt(e.target.value, 10);
                const desc = val === 0 ? 'オフ' : val <= 50 ? '微弱無線' : '本格トランシーバー';
                radioVal.innerText = `${val}% (${desc})`;
            });
        }

        const trashSlider = document.getElementById(`${prefix}-special-trash-slider`);
        const trashVal = document.getElementById(`${prefix}-special-trash-val`);
        if (trashSlider && trashVal) {
            trashSlider.addEventListener('input', (e) => {
                const val = parseInt(e.target.value, 10);
                const desc = val === 0 ? 'オフ' : val <= 50 ? 'ドライブ' : '極限音割れ';
                trashVal.innerText = `${val}% (${desc})`;
            });
        }

        // ⑩ 環境背景音
        const ambientVolSlider = document.getElementById(`${prefix}-ambient-vol-slider`);
        const ambientVolVal = document.getElementById(`${prefix}-ambient-vol-val`);
        if (ambientVolSlider && ambientVolVal) {
            ambientVolSlider.addEventListener('input', (e) => {
                const val = parseInt(e.target.value, 10);
                ambientVolVal.innerText = `${val}%`;
            });
        }
    }

    setFxParamsToUI(prefix, voiceParams, envParams, eqParams = null, specialParams = null, speed = null) {
        const v = voiceParams ? { ...VoiceEngine.defaultVoiceParams(), ...voiceParams } : null;
        const e = envParams ? { ...VoiceEngine.defaultEnvParams(), ...envParams } : null;
        const eq = eqParams || (voiceParams || envParams ? { bass: 0, mid: 0, treble: 0 } : null);
        const sp = specialParams || (voiceParams || envParams ? { chorus: 0, radioNoise: 0, trash: 0 } : null);

        const pitchSlider = document.getElementById(`${prefix}-pitch-slider`);
        const formantSlider = document.getElementById(`${prefix}-formant-slider`);
        const roughSlider = document.getElementById(`${prefix}-rough-slider`);
        const speedSlider = document.getElementById(`${prefix}-speed-slider`);
        const reverbSlider = document.getElementById(`${prefix}-reverb-slider`);
        const filterSlider = document.getElementById(`${prefix}-filter-slider`);
        const modSlider = document.getElementById(`${prefix}-mod-slider`);
        const ambientVolSlider = document.getElementById(`${prefix}-ambient-vol-slider`);
        const ambientSoundSelect = document.getElementById(`${prefix}-ambient-sound-select`);

        const eqBass = document.getElementById(`${prefix}-eq-bass-slider`);
        const eqMid = document.getElementById(`${prefix}-eq-mid-slider`);
        const eqTreble = document.getElementById(`${prefix}-eq-treble-slider`);

        const spChorus = document.getElementById(`${prefix}-special-chorus-slider`);
        const spRadio = document.getElementById(`${prefix}-special-radio-slider`);
        const spTrash = document.getElementById(`${prefix}-special-trash-slider`);

        if (v) {
            if (pitchSlider) { pitchSlider.value = v.pitchSemitones; pitchSlider.dispatchEvent(new Event('input')); }
            if (formantSlider) { formantSlider.value = v.formantRatio; formantSlider.dispatchEvent(new Event('input')); }
            if (roughSlider) { roughSlider.value = v.roughness; roughSlider.dispatchEvent(new Event('input')); }
        }
        if (speed !== null && speed !== undefined && speedSlider) {
            speedSlider.value = parseFloat(speed) || 1.0;
            speedSlider.dispatchEvent(new Event('input'));
        }
        if (e) {
            if (reverbSlider) { reverbSlider.value = e.reverb ?? 0; reverbSlider.dispatchEvent(new Event('input')); }
            if (filterSlider) { filterSlider.value = e.filter ?? 0; filterSlider.dispatchEvent(new Event('input')); }
            if (modSlider) { modSlider.value = e.modulation ?? 0; modSlider.dispatchEvent(new Event('input')); }
            if (ambientVolSlider) { ambientVolSlider.value = e.ambientVolume ?? 35; ambientVolSlider.dispatchEvent(new Event('input')); }
            if (ambientSoundSelect) { ambientSoundSelect.value = e.ambientSound ?? 'none'; }
        }

        if (eq) {
            if (eqBass) { eqBass.value = eq.bass || 0; eqBass.dispatchEvent(new Event('input')); }
            if (eqMid) { eqMid.value = eq.mid || 0; eqMid.dispatchEvent(new Event('input')); }
            if (eqTreble) { eqTreble.value = eq.treble || 0; eqTreble.dispatchEvent(new Event('input')); }
        }

        if (sp) {
            if (spChorus) { spChorus.value = sp.chorus || 0; spChorus.dispatchEvent(new Event('input')); }
            if (spRadio) { spRadio.value = sp.radioNoise || 0; spRadio.dispatchEvent(new Event('input')); }
            if (spTrash) { spTrash.value = sp.trash || 0; spTrash.dispatchEvent(new Event('input')); }
        }
    }

    getFxParamsFromUI(prefix) {
        const pitchSlider = document.getElementById(`${prefix}-pitch-slider`);
        const formantSlider = document.getElementById(`${prefix}-formant-slider`);
        const roughSlider = document.getElementById(`${prefix}-rough-slider`);
        const speedSlider = document.getElementById(`${prefix}-speed-slider`);
        const reverbSlider = document.getElementById(`${prefix}-reverb-slider`);
        const filterSlider = document.getElementById(`${prefix}-filter-slider`);
        const modSlider = document.getElementById(`${prefix}-mod-slider`);
        const ambientVolSlider = document.getElementById(`${prefix}-ambient-vol-slider`);
        const ambientSoundSelect = document.getElementById(`${prefix}-ambient-sound-select`);

        const eqBass = document.getElementById(`${prefix}-eq-bass-slider`);
        const eqMid = document.getElementById(`${prefix}-eq-mid-slider`);
        const eqTreble = document.getElementById(`${prefix}-eq-treble-slider`);

        const spChorus = document.getElementById(`${prefix}-special-chorus-slider`);
        const spRadio = document.getElementById(`${prefix}-special-radio-slider`);
        const spTrash = document.getElementById(`${prefix}-special-trash-slider`);

        return {
            voiceParams: {
                pitchSemitones: pitchSlider ? parseInt(pitchSlider.value, 10) : 0,
                formantRatio: formantSlider ? parseFloat(formantSlider.value) : 1.0,
                roughness: roughSlider ? parseInt(roughSlider.value, 10) : 0
            },
            envParams: {
                reverb: reverbSlider ? parseInt(reverbSlider.value, 10) : 0,
                filter: filterSlider ? parseInt(filterSlider.value, 10) : 0,
                modulation: modSlider ? parseInt(modSlider.value, 10) : 0,
                ambientSound: ambientSoundSelect ? ambientSoundSelect.value : 'none',
                ambientVolume: ambientVolSlider ? parseInt(ambientVolSlider.value, 10) : 35
            },
            eqParams: {
                bass: eqBass ? parseInt(eqBass.value, 10) : 0,
                mid: eqMid ? parseInt(eqMid.value, 10) : 0,
                treble: eqTreble ? parseInt(eqTreble.value, 10) : 0
            },
            specialParams: {
                chorus: spChorus ? parseInt(spChorus.value, 10) : 0,
                radioNoise: spRadio ? parseInt(spRadio.value, 10) : 0,
                trash: spTrash ? parseInt(spTrash.value, 10) : 0
            },
            speed: speedSlider ? parseFloat(speedSlider.value) : 1.0
        };
    }

    async saveGlobalFxSettings() {
        const { voiceParams, envParams, eqParams } = this.getFxParamsFromUI('global');
        this.globalVoiceParams = voiceParams;
        this.globalEnvParams = envParams;
        this.globalEqParams = eqParams;
        await this.storage.saveSetting('globalVoiceParams', this.globalVoiceParams);
        await this.storage.saveSetting('globalEnvParams', this.globalEnvParams);
        await this.storage.saveSetting('globalEqParams', this.globalEqParams);
    }

    async previewSlotEffect() {
        if (!this.editingSlotId) return;
        const slot = this.slots.find(s => s.id === this.editingSlotId);
        await AudioUnlocker.unlock();
        const ctx = AudioUnlocker.getContext();
        if (!ctx) return;

        this.stopFxPreview();
        const { voiceParams, envParams, eqParams, specialParams, speed } = this.getFxParamsFromUI('slot');

        if (slot && slot.audioBlob) {
            try {
                const arr = await slot.audioBlob.arrayBuffer();
                const originalBuffer = await AudioUtils.decodeAudioDataSafe(ctx, arr);
                const processed = VoiceEngine.processFull(originalBuffer, ctx, voiceParams, envParams, speed, eqParams, specialParams);

                const slotVol = this.getEffectiveSlotVolume(slot);
                const controller = this.playBufferViaHtmlAudio(
                    processed,
                    speed,
                    () => { this.fxPreviewSource = null; },
                    (err) => {
                        console.error('Preview error:', err);
                        this.fxPreviewSource = null;
                    },
                    slotVol
                );
                this.fxPreviewSource = controller;
                this.showToast('▶️ 設定した声質・スピードで音声を試聴中...');
            } catch (err) {
                console.error('Preview error:', err);
            }
        } else {
            this.playTestVoicePreview(ctx, voiceParams, envParams, speed, eqParams, specialParams);
        }
    }

    stopFxPreview() {
        if (this.fxPreviewSource) {
            try {
                this.fxPreviewSource.stop();
                this.fxPreviewSource.disconnect();
            } catch (e) {}
            this.fxPreviewSource = null;
        }
        BlobUrlTracker.revokeCategory('preview');
    }

    // ==================== ⚙️ 全体設定・ガイド・QR・アップデートモーダル制御 ====================
    openSettingsModal() {
        const modal = document.getElementById('settings-modal-backdrop');
        if (modal) {
            modal.classList.add('open');
            const pageSizeSelect = document.getElementById('setting-page-size');
            if (pageSizeSelect) pageSizeSelect.value = String(this.pageSize);
            const globalSpeedSelect = document.getElementById('setting-global-speed');
            if (globalSpeedSelect) globalSpeedSelect.value = String(this.globalPlaybackSpeed);
            const themeSelect = document.getElementById('setting-theme-select');
            if (themeSelect) themeSelect.value = this.currentTheme;
            const aacToggle = document.getElementById('setting-aac-scan-toggle');
            if (aacToggle) aacToggle.checked = this.aacScanActive;
            const aacOptions = document.getElementById('aac-scan-options');
            if (aacOptions) aacOptions.style.display = this.aacScanActive ? 'block' : 'none';
            const aacSpeed = document.getElementById('setting-aac-scan-speed');
            if (aacSpeed) aacSpeed.value = this.aacScanSpeed;
            const aacSpeedVal = document.getElementById('aac-scan-speed-val');
            if (aacSpeedVal) aacSpeedVal.innerText = `${this.aacScanSpeed}秒`;
            const aacMode = document.getElementById('setting-aac-scan-mode');
            if (aacMode) aacMode.value = this.aacScanMode;
        }
    }

    closeSettingsModal() {
        document.getElementById('settings-modal-backdrop')?.classList.remove('open');
    }

    openGuideModal() {
        document.getElementById('guide-modal-backdrop')?.classList.add('open');
    }

    closeGuideModal() {
        document.getElementById('guide-modal-backdrop')?.classList.remove('open');
    }

    openBackupConfirmModal() {
        document.getElementById('backup-confirm-modal-backdrop')?.classList.add('open');
    }

    closeBackupConfirmModal() {
        document.getElementById('backup-confirm-modal-backdrop')?.classList.remove('open');
    }

    async performAppUpdate() {
        this.showToast('🔄 キャッシュをクリアして最新バージョンへ更新中...');
        try {
            if ('serviceWorker' in navigator) {
                const registrations = await navigator.serviceWorker.getRegistrations();
                for (const registration of registrations) {
                    await registration.unregister();
                }
            }
            if ('caches' in window) {
                const cacheKeys = await caches.keys();
                await Promise.all(cacheKeys.map(k => caches.delete(k)));
            }
        } catch (e) {
            console.warn('Update cache clear error:', e);
        }
        setTimeout(() => {
            window.location.reload(true);
        }, 600);
    }

    openQrModal() {
        const modal = document.getElementById('qr-modal-backdrop');
        if (modal) {
            modal.classList.add('open');
            this.renderQrCode();
        }
    }

    closeQrModal() {
        document.getElementById('qr-modal-backdrop')?.classList.remove('open');
    }

    renderQrCode() {
        const canvas = document.getElementById('qr-canvas');
        if (!canvas) return;
        const targetUrl = 'https://galakutar.github.io/Voice-Pad/';
        QrEngine.renderToCanvas(canvas, targetUrl, { size: 220, margin: 16, fgColor: '#000000', bgColor: '#ffffff' });
    }

    // ==================== 🗣️ スイッチ専用クイック【声質】モーダル制御 ====================
    openSlotVoiceModal(slotId) {
        this.editingVoiceSlotId = slotId;
        const slot = this.slots.find(s => s.id === slotId);
        if (!slot) return;

        const currentSlots = this.getCurrentSlots();
        const displayIndex = currentSlots.findIndex(s => s.id === slotId) + 1;
        const modalNumEl = document.getElementById('voice-modal-slot-num');
        if (modalNumEl) modalNumEl.innerText = displayIndex > 0 ? displayIndex : '';

        const modeSelect = document.getElementById('slot-quick-voice-mode');
        const isCustom = (slot.voiceEffectMode === 'custom' && (!!slot.voiceParams || !!slot.eqParams || !!slot.specialParams || (slot.playbackSpeed && slot.playbackSpeed !== 'inherit')));
        if (modeSelect) modeSelect.value = isCustom ? 'custom' : 'inherit';

        const effectiveVoice = this.getEffectiveVoiceParams(slot);
        const targetVoice = (isCustom && slot.voiceParams) ? slot.voiceParams : effectiveVoice;
        const effectiveEq = this.getEffectiveEqParams(slot);
        const targetEq = (isCustom && slot.eqParams) ? slot.eqParams : effectiveEq;
        const effectiveSpecial = this.getEffectiveSpecialParams(slot);
        const targetSpecial = (isCustom && slot.specialParams) ? slot.specialParams : effectiveSpecial;
        const effectiveSpeed = this.getEffectivePlaybackSpeed(slot);
        const targetSpeed = (isCustom && slot.playbackSpeed && slot.playbackSpeed !== 'inherit') ? parseFloat(slot.playbackSpeed) : effectiveSpeed;

        this.setFxParamsToUI('quick-voice', targetVoice, null, targetEq, targetSpecial, targetSpeed);

        // Voicemod風 プリセットカード一覧を描画
        this.renderVoicemodPresetCards('quick-voice-voicemod-grid', 'all', 'quick-voice');
        document.querySelectorAll('#quick-voice-voicemod-tabs .vm-tab-btn').forEach(b => {
            if (b.getAttribute('data-category') === 'all') b.classList.add('active');
            else b.classList.remove('active');
        });

        // プリセットチップスの選択リセット
        document.querySelectorAll('#quick-voice-preset-chips .fx-chip-btn').forEach(b => b.classList.remove('active'));

        document.getElementById('slot-voice-modal-backdrop')?.classList.add('open');
    }

    closeSlotVoiceModal() {
        this.stopFxPreview();
        document.getElementById('slot-voice-modal-backdrop')?.classList.remove('open');
        this.editingVoiceSlotId = null;
    }

    async saveSlotVoiceModal() {
        if (!this.editingVoiceSlotId) return;
        const slot = this.slots.find(s => s.id === this.editingVoiceSlotId);
        if (!slot) return;

        const modeSelect = document.getElementById('slot-quick-voice-mode');
        const mode = modeSelect ? modeSelect.value : 'inherit';

        if (mode === 'custom') {
            const { voiceParams, eqParams, specialParams, speed } = this.getFxParamsFromUI('quick-voice');

            slot.voiceEffectMode = 'custom';
            slot.voiceParams = voiceParams;
            slot.eqParams = eqParams;
            slot.specialParams = specialParams;
            slot.playbackSpeed = String(speed);
            slot.voiceEffect = 'custom';
        } else {
            slot.voiceParams = null;
            slot.eqParams = null;
            slot.specialParams = null;
            slot.playbackSpeed = 'inherit';
            if (slot.envParams) {
                slot.voiceEffectMode = 'custom';
            } else {
                slot.voiceEffectMode = 'inherit';
                slot.voiceEffect = 'inherit';
            }
        }

        await this.storage.saveSlot(slot);
        this.renderSlots();
        this.closeSlotVoiceModal();
        this.showToast(`🗣️ スイッチ「${slot.label}」のVoicemod・声質設定を保存しました`);
    }

    async previewQuickVoiceEffect() {
        if (!this.editingVoiceSlotId) return;
        const slot = this.slots.find(s => s.id === this.editingVoiceSlotId);
        await AudioUnlocker.unlock();
        const ctx = AudioUnlocker.getContext();
        if (!ctx) return;

        this.stopFxPreview();

        const { voiceParams, eqParams, specialParams, speed } = this.getFxParamsFromUI('quick-voice');
        const envParams = this.getEffectiveEnvParams(slot);

        if (slot && slot.audioBlob) {
            try {
                const arr = await slot.audioBlob.arrayBuffer();
                const originalBuffer = await AudioUtils.decodeAudioDataSafe(ctx, arr);
                const processed = VoiceEngine.processFull(originalBuffer, ctx, voiceParams, envParams, speed, eqParams, specialParams);

                const controller = this.playBufferViaHtmlAudio(
                    processed,
                    speed,
                    () => { this.fxPreviewSource = null; },
                    (err) => {
                        console.error('Preview error:', err);
                        this.fxPreviewSource = null;
                    }
                );
                this.fxPreviewSource = controller;
                this.showToast('▶️ 設定した声質・EQ・エフェクトで試聴中...');
            } catch (err) {
                console.error('Preview error:', err);
            }
        } else {
            this.playTestVoicePreview(ctx, voiceParams, envParams, speed, eqParams, specialParams);
        }
    }

    // ==================== ⛰️ スイッチ専用クイック【環境】モーダル制御 ====================
    openSlotEnvModal(slotId) {
        this.editingEnvSlotId = slotId;
        const slot = this.slots.find(s => s.id === slotId);
        if (!slot) return;

        const currentSlots = this.getCurrentSlots();
        const displayIndex = currentSlots.findIndex(s => s.id === slotId) + 1;
        const modalNumEl = document.getElementById('env-modal-slot-num');
        if (modalNumEl) modalNumEl.innerText = displayIndex > 0 ? displayIndex : '';

        const modeSelect = document.getElementById('slot-quick-env-mode');
        const isCustom = (slot.voiceEffectMode === 'custom' && !!slot.envParams);
        if (modeSelect) modeSelect.value = isCustom ? 'custom' : 'inherit';

        const effectiveEnv = this.getEffectiveEnvParams(slot);
        const targetEnv = (isCustom && slot.envParams) ? slot.envParams : effectiveEnv;

        const reverbSlider = document.getElementById('quick-env-reverb-slider');
        const filterSlider = document.getElementById('quick-env-filter-slider');
        const modSlider = document.getElementById('quick-env-mod-slider');
        const ambVolSlider = document.getElementById('quick-env-ambient-vol-slider');
        const ambSoundSelect = document.getElementById('quick-env-ambient-sound-select');

        if (reverbSlider) { reverbSlider.value = targetEnv.reverb || 0; reverbSlider.dispatchEvent(new Event('input')); }
        if (filterSlider) { filterSlider.value = targetEnv.filter || 0; filterSlider.dispatchEvent(new Event('input')); }
        if (modSlider) { modSlider.value = targetEnv.modulation || 0; modSlider.dispatchEvent(new Event('input')); }
        if (ambVolSlider) { ambVolSlider.value = targetEnv.ambientVolume !== undefined ? targetEnv.ambientVolume : 35; ambVolSlider.dispatchEvent(new Event('input')); }
        if (ambSoundSelect) { ambSoundSelect.value = targetEnv.ambientSound || 'none'; }

        // ⛰️ Environment プリセットカード一覧を描画
        this.renderEnvironmentPresetCards('quick-env-voicemod-grid', 'all');
        document.querySelectorAll('#quick-env-voicemod-tabs .vm-tab-btn').forEach(b => {
            if (b.getAttribute('data-category') === 'all') b.classList.add('active');
            else b.classList.remove('active');
        });

        // プリセットチップスの選択リセット
        document.querySelectorAll('#quick-env-preset-chips .fx-chip-btn').forEach(b => b.classList.remove('active'));

        document.getElementById('slot-env-modal-backdrop')?.classList.add('open');
    }

    closeSlotEnvModal() {
        this.stopFxPreview();
        document.getElementById('slot-env-modal-backdrop')?.classList.remove('open');
        this.editingEnvSlotId = null;
    }

    async saveSlotEnvModal() {
        if (!this.editingEnvSlotId) return;
        const slot = this.slots.find(s => s.id === this.editingEnvSlotId);
        if (!slot) return;

        const modeSelect = document.getElementById('slot-quick-env-mode');
        const mode = modeSelect ? modeSelect.value : 'inherit';

        if (mode === 'custom') {
            const reverbSlider = document.getElementById('quick-env-reverb-slider');
            const filterSlider = document.getElementById('quick-env-filter-slider');
            const modSlider = document.getElementById('quick-env-mod-slider');
            const ambVolSlider = document.getElementById('quick-env-ambient-vol-slider');
            const ambSoundSelect = document.getElementById('quick-env-ambient-sound-select');

            slot.voiceEffectMode = 'custom';
            slot.envParams = {
                reverb: reverbSlider ? parseInt(reverbSlider.value, 10) : 0,
                filter: filterSlider ? parseInt(filterSlider.value, 10) : 0,
                modulation: modSlider ? parseInt(modSlider.value, 10) : 0,
                ambientSound: ambSoundSelect ? ambSoundSelect.value : 'none',
                ambientVolume: ambVolSlider ? parseInt(ambVolSlider.value, 10) : 35
            };
            slot.voiceEffect = 'custom';
        } else {
            slot.envParams = null;
            if (slot.voiceParams || slot.eqParams || slot.specialParams) {
                slot.voiceEffectMode = 'custom';
            } else {
                slot.voiceEffectMode = 'inherit';
                slot.voiceEffect = 'inherit';
            }
        }

        await this.storage.saveSlot(slot);
        this.renderSlots();
        this.closeSlotEnvModal();
        this.showToast(`⛰️ スイッチ「${slot.label}」の環境設定を保存しました`);
    }

    async previewQuickEnvEffect() {
        if (!this.editingEnvSlotId) return;
        const slot = this.slots.find(s => s.id === this.editingEnvSlotId);
        await AudioUnlocker.unlock();
        const ctx = AudioUnlocker.getContext();
        if (!ctx) return;

        this.stopFxPreview();

        const reverbSlider = document.getElementById('quick-env-reverb-slider');
        const filterSlider = document.getElementById('quick-env-filter-slider');
        const modSlider = document.getElementById('quick-env-mod-slider');
        const ambVolSlider = document.getElementById('quick-env-ambient-vol-slider');
        const ambSoundSelect = document.getElementById('quick-env-ambient-sound-select');

        const envParams = {
            reverb: reverbSlider ? parseInt(reverbSlider.value, 10) : 0,
            filter: filterSlider ? parseInt(filterSlider.value, 10) : 0,
            modulation: modSlider ? parseInt(modSlider.value, 10) : 0,
            ambientSound: ambSoundSelect ? ambSoundSelect.value : 'none',
            ambientVolume: ambVolSlider ? parseInt(ambVolSlider.value, 10) : 35
        };
        const voiceParams = this.getEffectiveVoiceParams(slot);
        const eqParams = this.getEffectiveEqParams(slot);
        const specialParams = this.getEffectiveSpecialParams(slot);
        const speed = this.getEffectivePlaybackSpeed(slot);

        if (slot && slot.audioBlob) {
            try {
                const arr = await slot.audioBlob.arrayBuffer();
                const originalBuffer = await AudioUtils.decodeAudioDataSafe(ctx, arr);
                const processed = VoiceEngine.processFull(originalBuffer, ctx, voiceParams, envParams, speed, eqParams, specialParams);

                const controller = this.playBufferViaHtmlAudio(
                    processed,
                    speed,
                    () => { this.fxPreviewSource = null; },
                    (err) => {
                        console.error('Preview error:', err);
                        this.fxPreviewSource = null;
                    }
                );
                this.fxPreviewSource = controller;
                this.showToast('▶️ 設定した環境エフェクトで試聴中...');
            } catch (err) {
                console.error('Preview error:', err);
            }
        } else {
            this.playTestVoicePreview(ctx, voiceParams, envParams, speed, eqParams, specialParams);
        }
    }

    playTestVoicePreview(ctx, voiceParams, envParams, speed = 1.0, eqParams = null, specialParams = null) {
        this.stopFxPreview();
        const buffer = VoiceEngine.generateNaturalVowelBuffer(ctx, 1.1);
        const processed = VoiceEngine.processFull(buffer, ctx, voiceParams, envParams, speed, eqParams, specialParams);
        const controller = this.playBufferViaHtmlAudio(
            processed,
            speed,
            () => { this.fxPreviewSource = null; },
            (err) => {
                console.error('Preview error:', err);
                this.fxPreviewSource = null;
            }
        );
        this.fxPreviewSource = controller;
        this.showToast('▶️ 自然な肉声サンプル（あー）でエフェクトを試聴中...');
    }

    // ==================== 🗑️ モーダル用 オールクリア処理 ====================
    clearSlotVoiceSettings() {
        const modeSelect = document.getElementById('slot-quick-voice-mode');
        if (modeSelect) modeSelect.value = 'inherit';

        const pitchSlider = document.getElementById('quick-voice-pitch-slider');
        const formantSlider = document.getElementById('quick-voice-formant-slider');
        const roughSlider = document.getElementById('quick-voice-rough-slider');
        const speedSlider = document.getElementById('quick-voice-speed-slider');

        if (pitchSlider) { pitchSlider.value = 0; pitchSlider.dispatchEvent(new Event('input')); }
        if (formantSlider) { formantSlider.value = 1.0; formantSlider.dispatchEvent(new Event('input')); }
        if (roughSlider) { roughSlider.value = 0; roughSlider.dispatchEvent(new Event('input')); }
        if (speedSlider) { speedSlider.value = 1.0; speedSlider.dispatchEvent(new Event('input')); }

        const eqBass = document.getElementById('quick-voice-eq-bass-slider');
        const eqMid = document.getElementById('quick-voice-eq-mid-slider');
        const eqTreble = document.getElementById('quick-voice-eq-treble-slider');
        if (eqBass) { eqBass.value = 0; eqBass.dispatchEvent(new Event('input')); }
        if (eqMid) { eqMid.value = 0; eqMid.dispatchEvent(new Event('input')); }
        if (eqTreble) { eqTreble.value = 0; eqTreble.dispatchEvent(new Event('input')); }

        const spChorus = document.getElementById('quick-voice-special-chorus-slider');
        const spRadio = document.getElementById('quick-voice-special-radio-slider');
        const spTrash = document.getElementById('quick-voice-special-trash-slider');
        if (spChorus) { spChorus.value = 0; spChorus.dispatchEvent(new Event('input')); }
        if (spRadio) { spRadio.value = 0; spRadio.dispatchEvent(new Event('input')); }
        if (spTrash) { spTrash.value = 0; spTrash.dispatchEvent(new Event('input')); }

        document.querySelectorAll('#quick-voice-preset-chips .fx-chip-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('#quick-voice-voicemod-grid .vm-card').forEach(b => b.classList.remove('active'));

        this.showToast('🗑️ 声質設定をすべて初期化（クリア）しました');
    }

    clearSlotEnvSettings() {
        const modeSelect = document.getElementById('slot-quick-env-mode');
        if (modeSelect) modeSelect.value = 'inherit';

        const reverbSlider = document.getElementById('quick-env-reverb-slider');
        const filterSlider = document.getElementById('quick-env-filter-slider');
        const modSlider = document.getElementById('quick-env-mod-slider');
        const ambVolSlider = document.getElementById('quick-env-ambient-vol-slider');
        const ambSoundSelect = document.getElementById('quick-env-ambient-sound-select');

        if (reverbSlider) { reverbSlider.value = 0; reverbSlider.dispatchEvent(new Event('input')); }
        if (filterSlider) { filterSlider.value = 0; filterSlider.dispatchEvent(new Event('input')); }
        if (modSlider) { modSlider.value = 0; modSlider.dispatchEvent(new Event('input')); }
        if (ambVolSlider) { ambVolSlider.value = 35; ambVolSlider.dispatchEvent(new Event('input')); }
        if (ambSoundSelect) { ambSoundSelect.value = 'none'; }

        document.querySelectorAll('#quick-env-voicemod-grid .vm-card').forEach(b => b.classList.remove('active'));

        this.showToast('🗑️ 環境設定をすべて初期化（クリア）しました');
    }

    clearSlotTtsSettings() {
        const ttsInput = document.getElementById('slot-tts-input-text');
        if (ttsInput) {
            ttsInput.value = '';
            this.adjustTtsTextarea(ttsInput);
        }

        const rateSlider = document.getElementById('slot-tts-rate-slider');
        if (rateSlider) {
            rateSlider.value = 1.0;
            const rateVal = document.getElementById('slot-tts-rate-val');
            if (rateVal) rateVal.innerText = '1.00x (標準)';
        }

        const pitchSlider = document.getElementById('slot-tts-pitch-slider');
        if (pitchSlider) {
            pitchSlider.value = 1.0;
            const pitchVal = document.getElementById('slot-tts-pitch-val');
            if (pitchVal) pitchVal.innerText = '1.00 (標準)';
        }

        this.selectTtsVoiceChip('ayumi');

        this.showToast('🗑️ AI音声設定をすべてクリアしました');
    }

    // ==================== 🤖 AI音声合成 (TTS) エンジン ＆ 専用モーダル ====================
    initTTS() {
        if ('speechSynthesis' in window) {
            window.speechSynthesis.onvoiceschanged = () => {
                this.ttsVoices = window.speechSynthesis.getVoices();
            };
        }

        const ttsInput = document.getElementById('slot-tts-input-text');
        if (ttsInput) {
            ttsInput.addEventListener('input', () => {
                this.adjustTtsTextarea(ttsInput);
            });
        }

        const rateSlider = document.getElementById('slot-tts-rate-slider');
        if (rateSlider) {
            rateSlider.addEventListener('input', (e) => {
                const val = parseFloat(e.target.value);
                const valEl = document.getElementById('slot-tts-rate-val');
                if (valEl) {
                    let hint = '';
                    if (val < 0.8) hint = ' (ゆっくり)';
                    else if (val > 1.2) hint = ' (早口)';
                    else hint = ' (標準)';
                    valEl.innerText = `${val.toFixed(2)}x${hint}`;
                }
            });
        }

        const pitchSlider = document.getElementById('slot-tts-pitch-slider');
        if (pitchSlider) {
            pitchSlider.addEventListener('input', (e) => {
                const val = parseFloat(e.target.value);
                const valEl = document.getElementById('slot-tts-pitch-val');
                if (valEl) {
                    let hint = '';
                    if (val < 0.8) hint = ' (低い声)';
                    else if (val > 1.2) hint = ' (高い声)';
                    else hint = ' (標準)';
                    valEl.innerText = `${val.toFixed(2)}${hint}`;
                }
            });
        }

        // 🎙️ 日本語ベース音声（話者）スイッチボタン (あゆみ, はるか, いちろう, さやか, Google)
        document.querySelectorAll('#slot-tts-voice-chips .fx-chip-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const voiceKey = btn.getAttribute('data-tts-voice');
                if (voiceKey) {
                    this.selectTtsVoiceChip(voiceKey);
                }
            });
        });

        // イントネーション・ポーズ補助ツール
        document.querySelectorAll('.tts-pause-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const pauseType = btn.getAttribute('data-pause');
                const ttsTextarea = document.getElementById('slot-tts-input-text');
                if (!ttsTextarea) return;

                const start = ttsTextarea.selectionStart || ttsTextarea.value.length;
                const end = ttsTextarea.selectionEnd || ttsTextarea.value.length;
                let text = ttsTextarea.value;

                if (pauseType === 'comma') {
                    ttsTextarea.value = text.slice(0, start) + '、' + text.slice(end);
                    ttsTextarea.selectionStart = ttsTextarea.selectionEnd = start + 1;
                } else if (pauseType === 'space') {
                    ttsTextarea.value = text.slice(0, start) + ' ' + text.slice(end);
                    ttsTextarea.selectionStart = ttsTextarea.selectionEnd = start + 1;
                } else if (pauseType === 'period') {
                    ttsTextarea.value = text.slice(0, start) + '。' + text.slice(end);
                    ttsTextarea.selectionStart = ttsTextarea.selectionEnd = start + 1;
                } else if (pauseType === 'clear') {
                    ttsTextarea.value = text.replace(/[、。，． 　]/g, '');
                }
                this.adjustTtsTextarea(ttsTextarea);
                ttsTextarea.focus();
            });
        });
    }

    selectTtsVoiceChip(voiceKey = 'ayumi') {
        this._selectedTtsVoiceKey = voiceKey;
        document.querySelectorAll('#slot-tts-voice-chips .fx-chip-btn').forEach(btn => {
            if (btn.getAttribute('data-tts-voice') === voiceKey) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
    }

    resolveTtsVoice(voiceKey = 'ayumi') {
        const allVoices = ('speechSynthesis' in window) ? (window.speechSynthesis.getVoices() || []) : [];
        const jaVoices = allVoices.filter(v => v.lang && v.lang.startsWith('ja'));
        const key = (voiceKey || 'ayumi').toLowerCase();

        let matched = null;
        let isMaleRole = false;
        let isFemaleFallbackForMale = false;

        if (key === 'ayumi') {
            matched = jaVoices.find(v => /ayumi/i.test(v.name));
            if (!matched) matched = jaVoices.find(v => /female|kyoko|nanami|haruka|sayaka|mizuki/i.test(v.name));
        } else if (key === 'haruka') {
            matched = jaVoices.find(v => /haruka/i.test(v.name));
            if (!matched) matched = jaVoices.find(v => /female|kyoko|nanami|ayumi|sayaka/i.test(v.name));
        } else if (key === 'ichiro') {
            isMaleRole = true;
            matched = jaVoices.find(v => /ichiro/i.test(v.name));
            if (!matched) matched = jaVoices.find(v => /otoya|keita|takumi|kenji|daichi|male/i.test(v.name));
            // 男性音声が見つからない場合、女性音声にフォールバックしたことをフラグ化
            if (!matched) {
                matched = jaVoices.find(v => /female|kyoko|nanami|ayumi|sayaka|mizuki/i.test(v.name)) || jaVoices[0];
                isFemaleFallbackForMale = true;
            }
        } else if (key === 'sayaka') {
            matched = jaVoices.find(v => /sayaka/i.test(v.name));
            if (!matched) matched = jaVoices.find(v => /female|kyoko|nanami|haruka|ayumi/i.test(v.name));
        } else if (key === 'google') {
            matched = jaVoices.find(v => /google|日本語/i.test(v.name));
            if (!matched) matched = jaVoices.find(v => /kyoko/i.test(v.name));
        }

        if (!matched && jaVoices.length > 0) {
            matched = jaVoices[0];
        }

        return {
            voice: matched,
            isMaleRole,
            isFemaleFallbackForMale
        };
    }

    openSlotTtsModal(slotId) {
        this.editingTtsSlotId = slotId;
        const slot = this.slots.find(s => s.id === slotId);
        if (!slot) return;

        const currentSlots = this.getCurrentSlots();
        const displayIndex = currentSlots.findIndex(s => s.id === slotId) + 1;
        const modalNumEl = document.getElementById('tts-modal-slot-num');
        if (modalNumEl) modalNumEl.innerText = displayIndex > 0 ? displayIndex : '';

        // 過去の後方互換マッピング（girl->ayumi, boy->ichiro, woman->ayumi, man->ichiro）
        let initialVoice = slot.ttsVoice || 'ayumi';
        if (initialVoice === 'girl' || initialVoice === 'woman') initialVoice = 'ayumi';
        if (initialVoice === 'boy' || initialVoice === 'man') initialVoice = 'ichiro';
        this.selectTtsVoiceChip(initialVoice);

        const ttsInput = document.getElementById('slot-tts-input-text');
        if (ttsInput) {
            ttsInput.value = slot.ttsText || '';
            setTimeout(() => this.adjustTtsTextarea(ttsInput), 10);
        }

        const currentRate = slot.ttsRate || 1.0;
        const currentPitch = slot.ttsPitch || 1.0;

        const ttsRateSlider = document.getElementById('slot-tts-rate-slider');
        if (ttsRateSlider) {
            ttsRateSlider.value = currentRate;
            const rateVal = document.getElementById('slot-tts-rate-val');
            if (rateVal) {
                let hint = currentRate < 0.8 ? ' (ゆっくり)' : (currentRate > 1.2 ? ' (早口)' : ' (標準)');
                rateVal.innerText = `${parseFloat(currentRate).toFixed(2)}x${hint}`;
            }
        }

        const ttsPitchSlider = document.getElementById('slot-tts-pitch-slider');
        if (ttsPitchSlider) {
            ttsPitchSlider.value = currentPitch;
            const pitchVal = document.getElementById('slot-tts-pitch-val');
            if (pitchVal) {
                let hint = currentPitch < 0.8 ? ' (低い声)' : (currentPitch > 1.2 ? ' (高い声)' : ' (標準)');
                pitchVal.innerText = `${parseFloat(currentPitch).toFixed(2)}${hint}`;
            }
        }

        const deleteTtsBtn = document.getElementById('delete-slot-tts-btn');
        if (deleteTtsBtn) {
            deleteTtsBtn.style.display = slot.ttsText ? 'inline-block' : 'none';
        }

        document.getElementById('slot-tts-modal-backdrop')?.classList.add('open');
    }

    closeSlotTtsModal() {
        this.stopFxPreview();
        if ('speechSynthesis' in window) {
            try { window.speechSynthesis.cancel(); } catch (e) {}
        }
        window._activeTtsPreviewUtterance = null;
        BlobUrlTracker.revokeCategory('preview');
        document.getElementById('slot-tts-modal-backdrop')?.classList.remove('open');
        this.editingTtsSlotId = null;
    }

    adjustTtsTextarea(textarea) {
        if (!textarea) return;
        textarea.style.height = 'auto';
        const newHeight = Math.max(64, Math.min(220, textarea.scrollHeight));
        textarea.style.height = `${newHeight}px`;
    }

    async previewSlotTtsModal() {
        const text = document.getElementById('slot-tts-input-text')?.value.trim();
        if (!text) {
            this.showToast('⚠️ 読み上げるテキストを入力してください');
            return;
        }

        await AudioUnlocker.unlock();
        this.stopFxPreview();

        const rate = parseFloat(document.getElementById('slot-tts-rate-slider')?.value || '1.0');
        const pitch = parseFloat(document.getElementById('slot-tts-pitch-slider')?.value || '1.0');
        const selectedVoiceKey = this._selectedTtsVoiceKey || 'ayumi';

        // ① ブラウザ標準 Web Speech API による高品位・自然な日本語読み上げ
        if ('speechSynthesis' in window) {
            try {
                window.speechSynthesis.cancel();

                const utter = new SpeechSynthesisUtterance(text);
                const allVoices = window.speechSynthesis.getVoices();
                if (allVoices.length > 0) this.ttsVoices = allVoices;

                const resolved = this.resolveTtsVoice(selectedVoiceKey);
                const selectedVoice = resolved?.voice || null;
                const isFemaleFallbackForMale = resolved?.isFemaleFallbackForMale || false;

                if (selectedVoice) {
                    utter.voice = selectedVoice;
                    utter.lang = selectedVoice.lang || 'ja-JP';
                } else {
                    utter.lang = 'ja-JP';
                }

                // ピッチ（声の高さ）とスピード（話速）の完全独立制御
                const malePitchAdjustment = isFemaleFallbackForMale ? 0.72 : 1.0;
                utter.rate = Math.max(0.5, Math.min(2.0, rate));
                utter.pitch = Math.max(0.2, Math.min(2.0, pitch * malePitchAdjustment));
                utter.volume = 1.0;

                window._activeTtsPreviewUtterance = utter;
                utter.onend = () => { window._activeTtsPreviewUtterance = null; };
                utter.onerror = (e) => {
                    console.warn('TTS preview utterance error:', e);
                    window._activeTtsPreviewUtterance = null;
                };

                const voiceNames = {
                    ayumi: 'あゆみ',
                    haruka: 'はるか',
                    ichiro: 'いちろう',
                    sayaka: 'さやか',
                    google: 'Google'
                };
                const vName = voiceNames[selectedVoiceKey] || selectedVoiceKey;
                this.showToast(`🗣️ [${vName}] 「${text.slice(0, 15)}${text.length > 15 ? '...' : ''}」を試聴中...`);

                setTimeout(() => {
                    if (window.speechSynthesis.paused) {
                        window.speechSynthesis.resume();
                    }
                    window.speechSynthesis.speak(utter);
                }, 50);
                return;
            } catch (speechErr) {
                console.warn('speechSynthesis preview fallback to WebAudio:', speechErr);
            }
        }

        // ② Web Speech API 非対応時、またはフォールバック：
        const ctx = AudioUnlocker.getContext();
        if (!ctx) return;
        const slot = this.editingTtsSlotId ? this.slots.find(s => s.id === this.editingTtsSlotId) : null;
        const voiceParams = slot ? this.getEffectiveVoiceParams(slot) : VoiceEngine.defaultVoiceParams();
        const envParams = slot ? this.getEffectiveEnvParams(slot) : VoiceEngine.defaultEnvParams();
        const eqParams = slot ? this.getEffectiveEqParams(slot) : { bass: 0, mid: 0, treble: 0 };
        const specialParams = slot ? this.getEffectiveSpecialParams(slot) : null;
        const speed = slot ? this.getEffectivePlaybackSpeed(slot) : 1.0;

        try {
            this.showToast(`🗣️ 「${text.slice(0, 15)}...」を合成中...`);
            const rawBuffer = TtsEngine.synthesizeToBuffer(text, ctx, selectedVoiceKey, rate, pitch);
            const finalBuffer = VoiceEngine.processFull(rawBuffer, ctx, voiceParams, envParams, speed, eqParams, specialParams);

            const controller = this.playBufferViaHtmlAudio(
                finalBuffer,
                speed,
                () => { this.fxPreviewSource = null; },
                (err) => {
                    console.error('HTML5 Audio preview error:', err);
                    this.fxPreviewSource = null;
                    this.showToast('⚠️ 音声プレビューに失敗しました');
                }
            );

            this.fxPreviewSource = controller;
        } catch (err) {
            console.error('TTS preview error:', err);
            this.showToast('⚠️ 音声プレビューに失敗しました');
        }
    }

    async saveSlotTtsModal() {
        if (!this.editingTtsSlotId) {
            this.showToast('⚠️ 登録先のスロットが見つかりません');
            return;
        }

        const slot = this.slots.find(s => s.id === this.editingTtsSlotId);
        if (!slot) {
            this.showToast('⚠️ 登録先のスロットが見つかりません');
            return;
        }

        const text = document.getElementById('slot-tts-input-text')?.value.trim();
        if (!text) {
            this.showToast('⚠️ 読み上げるテキストを入力してください');
            return;
        }

        await AudioUnlocker.unlock();

        const rate = parseFloat(document.getElementById('slot-tts-rate-slider')?.value || '1.0');
        const pitch = parseFloat(document.getElementById('slot-tts-pitch-slider')?.value || '1.0');
        const selectedVoiceKey = this._selectedTtsVoiceKey || 'ayumi';

        try {
            slot.ttsText = text;
            slot.ttsVoice = selectedVoiceKey;
            slot.ttsRate = rate;
            slot.ttsPitch = pitch;
            slot.audioBlob = null;
            slot.audioBase64 = null;
            slot.duration = Math.max(0.5, (text.length * 0.18) / rate);

            // ラベルが初期値「ボタン」等ならテキスト先頭を反映
            if (!slot.label || slot.label.startsWith('ボタン')) {
                slot.label = text.slice(0, 14);
            }

            await this.storage.saveSlot(slot);
            this.renderSlots();
            this.closeSlotTtsModal();
            this.showToast(`✨ スイッチ「${slot.label}」にAI音声を登録しました！`);
        } catch (err) {
            console.error('Save TTS error:', err);
            this.showToast('⚠️ 音声の登録に失敗しました');
        }
    }

    async deleteSlotTtsAudio() {
        if (!this.editingTtsSlotId) return;
        const slot = this.slots.find(s => s.id === this.editingTtsSlotId);
        if (!slot) return;

        if (confirm(`スイッチ「${slot.label}」のAI音声を消去しますか？`)) {
            this.stopSlot(slot.id);
            slot.ttsText = null;
            slot.ttsVoice = null;
            slot.duration = 0;
            await this.storage.saveSlot(slot);
            this.renderSlots();
            this.closeSlotTtsModal();
            this.showToast('🔇 AI音声を消去しました');
        }
    }

    // ==================== ✂️ 音声波形エディター ＆ トリム ====================
    initWaveformEvents() {
        const startSlider = document.getElementById('trim-start-slider');
        const endSlider = document.getElementById('trim-end-slider');

        if (startSlider) {
            startSlider.addEventListener('input', (e) => {
                const val = parseFloat(e.target.value);
                if (val >= this.trimEndSec - 0.1) {
                    this.trimStartSec = Math.max(0, this.trimEndSec - 0.1);
                    startSlider.value = this.trimStartSec;
                } else {
                    this.trimStartSec = val;
                }
                const label = document.getElementById('trim-start-val');
                if (label) label.innerText = `${this.trimStartSec.toFixed(2)}s`;
                this.renderWaveform();
            });
        }

        if (endSlider) {
            endSlider.addEventListener('input', (e) => {
                const val = parseFloat(e.target.value);
                if (val <= this.trimStartSec + 0.1) {
                    this.trimEndSec = this.trimStartSec + 0.1;
                    endSlider.value = this.trimEndSec;
                } else {
                    this.trimEndSec = val;
                }
                const label = document.getElementById('trim-end-val');
                if (label) label.innerText = `${this.trimEndSec.toFixed(2)}s`;
                this.renderWaveform();
            });
        }

        document.getElementById('btn-waveform-preview')?.addEventListener('click', () => this.previewTrimmedAudio());
        document.getElementById('btn-waveform-normalize')?.addEventListener('click', () => this.normalizeWaveformAudio());
        document.getElementById('btn-waveform-fade')?.addEventListener('click', () => this.applyWaveformFade());
        document.getElementById('btn-waveform-save')?.addEventListener('click', () => this.saveTrimmedAudio());
    }

    async initWaveformForSlot(slot) {
        const card = document.getElementById('waveform-editor-card');
        if (!card) return;

        if (!slot || !slot.audioBlob) {
            card.style.display = 'none';
            this.waveformAudioBuffer = null;
            return;
        }

        card.style.display = 'flex';
        await AudioUnlocker.unlock();
        const ctx = AudioUnlocker.getContext();

        try {
            const arr = await slot.audioBlob.arrayBuffer();
            this.waveformAudioBuffer = await AudioUtils.decodeAudioDataSafe(ctx, arr);
            const duration = this.waveformAudioBuffer.duration;

            this.trimStartSec = 0;
            this.trimEndSec = duration;

            const badge = document.getElementById('waveform-duration-badge');
            if (badge) badge.innerText = `${duration.toFixed(2)}s`;

            const startSlider = document.getElementById('trim-start-slider');
            const endSlider = document.getElementById('trim-end-slider');
            const startVal = document.getElementById('trim-start-val');
            const endVal = document.getElementById('trim-end-val');

            if (startSlider) {
                startSlider.min = 0;
                startSlider.max = duration;
                startSlider.step = 0.01;
                startSlider.value = 0;
            }
            if (endSlider) {
                endSlider.min = 0;
                endSlider.max = duration;
                endSlider.step = 0.01;
                endSlider.value = duration;
            }
            if (startVal) startVal.innerText = '0.00s';
            if (endVal) endVal.innerText = `${duration.toFixed(2)}s`;

            this.renderWaveform();
        } catch (e) {
            console.warn('Waveform decode error:', e);
            card.style.display = 'none';
        }
    }

    renderWaveform() {
        const canvas = document.getElementById('waveform-canvas');
        if (!canvas || !this.waveformAudioBuffer) return;
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;
        const midY = h / 2;

        ctx.clearRect(0, 0, w, h);

        // 背景
        ctx.fillStyle = '#090e17';
        ctx.fillRect(0, 0, w, h);

        // 中心線
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, midY);
        ctx.lineTo(w, midY);
        ctx.stroke();

        const channelData = this.waveformAudioBuffer.getChannelData(0);
        const totalDuration = this.waveformAudioBuffer.duration;
        const totalSamples = channelData.length;
        const samplesPerPixel = Math.floor(totalSamples / w);

        const trimStartX = Math.floor((this.trimStartSec / totalDuration) * w);
        const trimEndX = Math.floor((this.trimEndSec / totalDuration) * w);

        // トリム選択外の暗転領域
        ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
        if (trimStartX > 0) ctx.fillRect(0, 0, trimStartX, h);
        if (trimEndX < w) ctx.fillRect(trimEndX, 0, w - trimEndX, h);

        // 波形バーの描画
        for (let x = 0; x < w; x++) {
            let min = 1.0, max = -1.0;
            const startIdx = x * samplesPerPixel;
            for (let j = 0; j < samplesPerPixel; j++) {
                const val = channelData[startIdx + j] || 0;
                if (val < min) min = val;
                if (val > max) max = val;
            }

            const inTrim = (x >= trimStartX && x <= trimEndX);
            const barHeight = Math.max(2, (max - min) * (h * 0.44));

            if (inTrim) {
                const grad = ctx.createLinearGradient(0, midY - barHeight, 0, midY + barHeight);
                grad.addColorStop(0, '#38bdf8');
                grad.addColorStop(0.5, '#60a5fa');
                grad.addColorStop(1, '#a855f7');
                ctx.fillStyle = grad;
            } else {
                ctx.fillStyle = 'rgba(148, 163, 184, 0.25)';
            }

            ctx.fillRect(x, midY - barHeight, 1.2, barHeight * 2);
        }

        // トリム境界線マーカー
        ctx.strokeStyle = '#f43f5e';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(trimStartX, 0);
        ctx.lineTo(trimStartX, h);
        ctx.moveTo(trimEndX, 0);
        ctx.lineTo(trimEndX, h);
        ctx.stroke();
    }

    previewTrimmedAudio() {
        if (!this.waveformAudioBuffer) return;
        this.stopWaveformPreview();

        const ctx = AudioUnlocker.getContext();
        const duration = this.trimEndSec - this.trimStartSec;
        if (duration <= 0) return;

        const source = ctx.createBufferSource();
        source.buffer = this.waveformAudioBuffer;

        const gainNode = ctx.createGain();
        const slot = this.editingSlotId ? this.slots.find(s => s.id === this.editingSlotId) : null;
        const slotVol = this.getEffectiveSlotVolume(slot);
        const gVol = (this.globalVolume !== undefined && this.globalVolume !== null) ? this.globalVolume : 1.0;
        gainNode.gain.value = Math.max(0.0, Math.min(3.0, slotVol * gVol));
        source.connect(gainNode);
        gainNode.connect(ctx.destination);

        source.start(0, this.trimStartSec, duration);
        this.waveformPreviewSource = source;

        // プレイヘッドアニメーション
        const playhead = document.getElementById('waveform-playhead');
        const canvas = document.getElementById('waveform-canvas');
        if (playhead && canvas) {
            playhead.style.display = 'block';
            const totalDuration = this.waveformAudioBuffer.duration;
            const startTime = performance.now();

            const updatePlayhead = () => {
                const elapsed = (performance.now() - startTime) / 1000;
                const currentSec = this.trimStartSec + elapsed;
                if (currentSec <= this.trimEndSec) {
                    const percent = (currentSec / totalDuration) * 100;
                    playhead.style.left = `${percent}%`;
                    this.waveformPlayheadAnim = requestAnimationFrame(updatePlayhead);
                } else {
                    playhead.style.display = 'none';
                }
            };
            this.waveformPlayheadAnim = requestAnimationFrame(updatePlayhead);
        }

        source.onended = () => {
            this.stopWaveformPreview();
        };

        this.showToast(`▶️ トリム区間（${duration.toFixed(2)}秒）を試聴中`);
    }

    stopWaveformPreview() {
        if (this.waveformPreviewSource) {
            try {
                this.waveformPreviewSource.stop();
                this.waveformPreviewSource.disconnect();
            } catch (e) {}
            this.waveformPreviewSource = null;
        }
        if (this.waveformPlayheadAnim) {
            cancelAnimationFrame(this.waveformPlayheadAnim);
            this.waveformPlayheadAnim = null;
        }
        const playhead = document.getElementById('waveform-playhead');
        if (playhead) playhead.style.display = 'none';
    }

    normalizeWaveformAudio() {
        if (!this.waveformAudioBuffer) return;
        AudioUtils.normalizeAudioBuffer(this.waveformAudioBuffer);
        this.renderWaveform();
        this.showToast('📈 音量を均一・最大化（ノーマライズ）しました');
    }

    applyWaveformFade() {
        if (!this.waveformAudioBuffer) return;
        AudioUtils.applyFade(this.waveformAudioBuffer, 0.05, 0.05);
        this.renderWaveform();
        this.showToast('🌊 前後0.05秒にフェードを適用しました');
    }

    async saveTrimmedAudio() {
        if (!this.editingSlotId || !this.waveformAudioBuffer) return;
        const slot = this.slots.find(s => s.id === this.editingSlotId);
        if (!slot) return;

        const ctx = AudioUnlocker.getContext();
        const sliced = AudioUtils.sliceAudioBuffer(ctx, this.waveformAudioBuffer, this.trimStartSec, this.trimEndSec);
        const wavBlob = AudioUtils.audioBufferToWav(sliced);

        slot.audioBlob = wavBlob;
        slot.duration = Math.max(0.2, this.trimEndSec - this.trimStartSec);

        await this.storage.saveSlot(slot);
        this.renderSlots();

        // 再度波形バッファを同期
        await this.initWaveformForSlot(slot);
        this.showToast(`✂️ トリムを適用保存しました（${slot.duration.toFixed(2)}秒）`);
    }

    // ==================== 🎹 外部キーボード ＆ Web MIDI ＆ AAC ====================
    initKeyboardAndMidi() {
        // キーボード演奏リスナー
        const keyMap = {
            '1': 0, '2': 1, '3': 2, '4': 3, '5': 4, '6': 5, '7': 6, '8': 7, '9': 8,
            '0': 9, 'q': 10, 'w': 11, 'e': 12, 'r': 13, 't': 14, 'y': 15, 'u': 16,
            'i': 17, 'o': 18, 'p': 19, 'a': 20, 's': 21, 'd': 22, 'f': 23, 'g': 24,
            'h': 25, 'j': 26, 'k': 27, 'l': 28, 'z': 29, 'x': 30, 'c': 31
        };

        window.addEventListener('keydown', (e) => {
            const activeEl = document.activeElement;
            if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT')) {
                return;
            }

            // モーダルが開いているときは無視
            if (document.querySelector('.modal-backdrop.open')) {
                if (e.key === 'Escape') {
                    this.closeEditModal();
                    this.closeScrollModal();
                    this.closeSettingsModal();
                    this.closeGuideModal();
                    this.closeIncomingShareModal();
                    this.cancelP2pSend();
                    this.stopP2pScanner();
                }
                return;
            }

            // AACスキャン中のトリガー (Space / Enter)
            if (this.aacScanActive && (e.key === ' ' || e.key === 'Enter')) {
                e.preventDefault();
                this.triggerAACScanSelection();
                return;
            }

            // ページ送り (ArrowLeft / ArrowRight)
            if (e.key === 'ArrowLeft') {
                if (this.currentPage > 1) {
                    this.currentPage--;
                    this.renderSlots();
                }
                return;
            }
            if (e.key === 'ArrowRight') {
                const totalPages = this.getTotalPages();
                if (this.currentPage < totalPages) {
                    this.currentPage++;
                    this.renderSlots();
                }
                return;
            }

            // キーによるスロット演奏
            const key = e.key.toLowerCase();
            if (key in keyMap) {
                e.preventDefault();
                this.triggerSlotByIndex(keyMap[key]);
            }
        });

        // Web MIDI API 初期化
        if (navigator.requestMIDIAccess) {
            navigator.requestMIDIAccess().then((access) => {
                this.midiAccess = access;
                const badge = document.getElementById('midi-status-badge');
                let deviceCount = 0;
                for (let input of access.inputs.values()) {
                    deviceCount++;
                    input.onmidimessage = (msg) => this.handleMidiMessage(msg);
                }
                if (badge) {
                    badge.innerText = deviceCount > 0 ? `🎹 MIDI接続中 (${deviceCount}台)` : '🎹 MIDI待機中';
                }

                access.onstatechange = (e) => {
                    if (e.port.type === 'input') {
                        e.port.onmidimessage = (msg) => this.handleMidiMessage(msg);
                    }
                };
            }).catch(() => {
                const badge = document.getElementById('midi-status-badge');
                if (badge) badge.innerText = '🎹 MIDI未サポート';
            });
        }
    }

    handleMidiMessage(event) {
        const [status, note, velocity] = event.data;
        const command = status >> 4;
        if ((command === 9 || status === 144) && velocity > 0) {
            // Note On
            const currentSlots = this.getCurrentSlots();
            if (currentSlots.length === 0) return;
            const slotIdx = note % currentSlots.length;
            this.triggerSlotByIndex(slotIdx);
        }
    }

    triggerSlotByIndex(index) {
        const currentSlots = this.getCurrentSlots();
        const startIndex = (this.currentPage - 1) * this.pageSize;
        const targetSlot = currentSlots[startIndex + index];
        if (!targetSlot) return;

        const card = document.getElementById(`pad-${targetSlot.id}`);
        if (card) {
            // リップルを演出
            const ripple = document.createElement('span');
            ripple.className = 'pad-ripple';
            ripple.style.width = '120px';
            ripple.style.height = '120px';
            ripple.style.left = '50%';
            ripple.style.top = '50%';
            ripple.style.transform = 'translate(-50%, -50%)';
            card.appendChild(ripple);
            setTimeout(() => ripple.remove(), 600);
        }

        if (this.currentMode === 'play') {
            this.playSlot(targetSlot.id);
        } else {
            this.toggleRecording(targetSlot.id);
        }
    }

    // ==================== 🎯 AAC オンスクリーンスイッチスキャン ====================
    initAACScanController() {
        const toggle = document.getElementById('setting-aac-scan-toggle');
        const speedSlider = document.getElementById('setting-aac-scan-speed');
        const speedVal = document.getElementById('aac-scan-speed-val');
        const modeSelect = document.getElementById('setting-aac-scan-mode');
        const optionsBox = document.getElementById('aac-scan-options');

        if (toggle) {
            toggle.checked = this.aacScanActive;
            if (optionsBox) optionsBox.style.display = this.aacScanActive ? 'block' : 'none';

            toggle.addEventListener('change', async (e) => {
                this.aacScanActive = e.target.checked;
                if (optionsBox) optionsBox.style.display = this.aacScanActive ? 'block' : 'none';
                await this.storage.saveSetting('aacScanActive', this.aacScanActive);
                this.toggleAACScan(this.aacScanActive);
                this.showToast(this.aacScanActive ? '🎯 AACスイッチスキャンを開始しました' : '⏹️ AACスイッチスキャンを停止しました');
            });
        }

        if (speedSlider) {
            speedSlider.value = this.aacScanSpeed;
            if (speedVal) speedVal.innerText = `${this.aacScanSpeed}秒`;
            speedSlider.addEventListener('input', async (e) => {
                this.aacScanSpeed = parseFloat(e.target.value);
                if (speedVal) speedVal.innerText = `${this.aacScanSpeed}秒`;
                await this.storage.saveSetting('aacScanSpeed', this.aacScanSpeed);
                if (this.aacScanActive) {
                    this.stopAACScanLoop();
                    this.startAACScanLoop();
                }
            });
        }

        if (modeSelect) {
            modeSelect.value = this.aacScanMode;
            modeSelect.addEventListener('change', async (e) => {
                this.aacScanMode = e.target.value;
                await this.storage.saveSetting('aacScanMode', this.aacScanMode);
                if (this.aacScanActive) {
                    this.stopAACScanLoop();
                    if (this.aacScanMode === 'auto') this.startAACScanLoop();
                }
            });
        }

        if (this.aacScanActive) {
            this.toggleAACScan(true);
        }
    }

    toggleAACScan(enable) {
        if (enable) {
            this.aacScanIndex = 0;
            this.updateAACScanFocusUI();
            if (this.aacScanMode === 'auto') {
                this.startAACScanLoop();
            }
        } else {
            this.stopAACScanLoop();
            this.aacScanIndex = -1;
            document.querySelectorAll('.pad-card.aac-scan-focused').forEach(c => c.classList.remove('aac-scan-focused'));
        }
    }

    startAACScanLoop() {
        this.stopAACScanLoop();
        this.aacScanTimer = setInterval(() => {
            this.advanceAACScan();
        }, Math.max(500, this.aacScanSpeed * 1000));
    }

    stopAACScanLoop() {
        if (this.aacScanTimer) {
            clearInterval(this.aacScanTimer);
            this.aacScanTimer = null;
        }
    }

    advanceAACScan() {
        const cards = Array.from(document.querySelectorAll('.pad-grid .pad-card:not(.pad-card-add-new)'));
        if (cards.length === 0) return;

        this.aacScanIndex = (this.aacScanIndex + 1) % cards.length;
        this.updateAACScanFocusUI();
    }

    updateAACScanFocusUI() {
        const cards = Array.from(document.querySelectorAll('.pad-grid .pad-card:not(.pad-card-add-new)'));
        cards.forEach((c, idx) => {
            if (idx === this.aacScanIndex) {
                c.classList.add('aac-scan-focused');
            } else {
                c.classList.remove('aac-scan-focused');
            }
        });
    }

    triggerAACScanSelection() {
        const cards = Array.from(document.querySelectorAll('.pad-grid .pad-card:not(.pad-card-add-new)'));
        if (cards.length === 0 || this.aacScanIndex < 0 || this.aacScanIndex >= cards.length) return;

        const targetCard = cards[this.aacScanIndex];
        const slotId = targetCard.getAttribute('data-slot-id');
        if (!slotId) return;

        if (this.currentMode === 'play') {
            this.playSlot(slotId);
        } else {
            this.toggleRecording(slotId);
        }
    }

    // ==================== 📲 受信データ（AirDrop / ドロップ）プレビュー ＆ インポート ====================
    initIncomingShareAndDropzone() {
        // グローバルドラッグ＆ドロップリスナー
        const dropzone = document.getElementById('global-dropzone');
        let dragCounter = 0;

        window.addEventListener('dragenter', (e) => {
            e.preventDefault();
            dragCounter++;
            if (dropzone) dropzone.style.display = 'flex';
        });

        window.addEventListener('dragleave', (e) => {
            e.preventDefault();
            dragCounter--;
            if (dragCounter <= 0 && dropzone) {
                dropzone.style.display = 'none';
                dragCounter = 0;
            }
        });

        window.addEventListener('dragover', (e) => {
            e.preventDefault();
        });

        window.addEventListener('drop', async (e) => {
            e.preventDefault();
            dragCounter = 0;
            if (dropzone) dropzone.style.display = 'none';

            if (e.dataTransfer && e.dataTransfer.files.length > 0) {
                await this.handleGlobalImport(e.dataTransfer.files[0]);
            }
        });

        // モーダルボタン
        document.getElementById('close-incoming-modal-btn')?.addEventListener('click', () => this.closeIncomingShareModal());
        document.getElementById('btn-incoming-cancel')?.addEventListener('click', () => this.closeIncomingShareModal());
        document.getElementById('incoming-share-modal')?.addEventListener('click', (e) => {
            if (e.target.id === 'incoming-share-modal') this.closeIncomingShareModal();
        });

        document.getElementById('btn-incoming-add-current')?.addEventListener('click', () => this.applyIncomingToSelectedScroll());
        document.getElementById('btn-incoming-add-new-scroll')?.addEventListener('click', () => this.applyIncomingToNewScroll());
    }

    async showIncomingShareModal(data, fileName) {
        this.incomingData = data;
        const modal = document.getElementById('incoming-share-modal');
        const titleEl = document.getElementById('incoming-modal-title');
        const previewCard = document.getElementById('incoming-preview-card');
        const scrollSelect = document.getElementById('incoming-target-scroll');
        const targetGroup = document.getElementById('incoming-scroll-target-group');
        const addCurrentBtn = document.getElementById('btn-incoming-add-current');

        if (!modal || !previewCard) return;

        // スクロール先セレクトボックスの生成
        if (scrollSelect) {
            scrollSelect.innerHTML = '';
            this.scrolls.forEach(s => {
                const opt = document.createElement('option');
                opt.value = s.id;
                opt.innerText = s.name;
                if (s.id === this.currentScrollId) opt.selected = true;
                scrollSelect.appendChild(opt);
            });
        }

        if (data.type === 'voicepad_slot' || data.slot || data.label || data.audioBase64) {
            const s = data.slot || data;
            if (titleEl) titleEl.innerText = `📲 ボタン「${s.label || 'ボタン'}」を受信`;
            if (targetGroup) targetGroup.style.display = 'block';
            if (addCurrentBtn) addCurrentBtn.style.display = 'block';

            const photoHtml = s.imageUrl
                ? `<img src="${s.imageUrl}" alt="photo">`
                : (s.emoji || '🔊');

            const hasAudio = !!(s.audioBlob || s.audioBase64 || s.audioData || s.audio);
            const effLabel = this.getVoiceEffectLabel(s.voiceEffect || 'inherit');
            const speedLabel = s.playbackSpeed && s.playbackSpeed !== 'inherit' ? `${s.playbackSpeed}x` : '標準';

            previewCard.innerHTML = `
                <div class="incoming-preview-slot">
                    <div class="incoming-slot-icon">${photoHtml}</div>
                    <div class="incoming-slot-meta">
                        <div class="incoming-slot-title">${this.escapeHtml(s.label || 'ボタン')}</div>
                        <div class="incoming-slot-sub">🎙️ 音声: ${hasAudio ? `${(s.duration || 1.0).toFixed(1)}s` : '未録音'} | ⚡ ${speedLabel}</div>
                    </div>
                </div>
                ${hasAudio ? `
                    <button type="button" id="btn-incoming-preview-audio" class="action-btn download-btn" style="margin-top:4px;">
                        ▶️ 音声を試聴する
                    </button>
                ` : ''}
            `;

            document.getElementById('btn-incoming-preview-audio')?.addEventListener('click', () => {
                const rawAudio = s.audioBase64 || s.audioData || s.audio || s.audioBlob;
                this.previewIncomingAudio(rawAudio, s);
            });

        } else if (data.type === 'voicepad_scroll') {
            const scrollName = data.scroll?.name || '受信スクロール';
            const slotsCount = Array.isArray(data.slots) ? data.slots.length : 0;
            if (titleEl) titleEl.innerText = `📲 スクロール「${scrollName}」を受信`;
            if (targetGroup) targetGroup.style.display = 'none';
            if (addCurrentBtn) addCurrentBtn.style.display = 'none';

            previewCard.innerHTML = `
                <div class="incoming-preview-slot">
                    <div class="incoming-slot-icon">📂</div>
                    <div class="incoming-slot-meta">
                        <div class="incoming-slot-title">${this.escapeHtml(scrollName)}</div>
                        <div class="incoming-slot-sub">スイッチ数: ${slotsCount}個 | エフェクト: ${this.getVoiceEffectLabel(data.scroll?.voiceEffect || 'normal')}</div>
                    </div>
                </div>
            `;
        }

        modal.classList.add('open');
    }

    closeIncomingShareModal() {
        this.stopIncomingAudioPreview();
        document.getElementById('incoming-share-modal')?.classList.remove('open');
        this.incomingData = null;
    }

    async previewIncomingAudio(audioInput, slotData = null) {
        if (!audioInput) return;
        this.stopIncomingAudioPreview();

        try {
            await AudioUnlocker.unlock();
            const ctx = AudioUnlocker.getContext();
            const blob = (audioInput instanceof Blob) ? audioInput : this.base64ToBlob(audioInput);
            if (!blob) return;

            const arrayBuffer = await blob.arrayBuffer();
            const audioBuffer = await AudioUtils.decodeAudioDataSafe(ctx, arrayBuffer);

            let playBuffer = audioBuffer;
            const speed = (slotData && slotData.playbackSpeed && slotData.playbackSpeed !== 'inherit') ? parseFloat(slotData.playbackSpeed) : 1.0;
            const customVol = (slotData && slotData.volume !== undefined) ? parseFloat(slotData.volume) : 1.0;

            if (slotData && (slotData.voiceParams || slotData.envParams || slotData.eqParams || slotData.specialParams)) {
                playBuffer = VoiceEngine.processFull(
                    audioBuffer,
                    ctx,
                    slotData.voiceParams || {},
                    slotData.envParams || {},
                    speed,
                    slotData.eqParams || {},
                    slotData.specialParams || {}
                );
            }

            const controller = this.playBufferViaHtmlAudio(
                playBuffer,
                speed,
                () => { this.incomingAudioPreviewNode = null; },
                (err) => console.warn('Incoming preview audio error:', err),
                customVol
            );
            this.incomingAudioPreviewNode = controller;
        } catch (e) {
            console.warn('Incoming audio preview error, fallback to HTMLAudio:', e);
            try {
                const blob = (audioInput instanceof Blob) ? audioInput : this.base64ToBlob(audioInput);
                if (!blob) return;
                const url = BlobUrlTracker.create(blob, 'incoming');
                const audio = new Audio(url);
                audio.play().catch(err => console.warn('HTMLAudio play blocked:', err));

                this.incomingAudioPreviewNode = {
                    audio,
                    url,
                    stop: () => {
                        try {
                            audio.pause();
                            audio.currentTime = 0;
                        } catch (e) {}
                        BlobUrlTracker.revoke(url);
                    },
                    pause: () => {
                        try { audio.pause(); } catch (e) {}
                        BlobUrlTracker.revoke(url);
                    },
                    disconnect: () => {
                        BlobUrlTracker.revoke(url);
                    }
                };
                audio.onended = () => {
                    BlobUrlTracker.revoke(url);
                    this.incomingAudioPreviewNode = null;
                };
                audio.onerror = () => {
                    BlobUrlTracker.revoke(url);
                    this.incomingAudioPreviewNode = null;
                };
            } catch (err) {
                console.error('All incoming preview attempts failed:', err);
            }
        }
    }

    stopIncomingAudioPreview() {
        if (this.incomingAudioPreviewNode) {
            try {
                if (this.incomingAudioPreviewNode.stop) this.incomingAudioPreviewNode.stop();
                else if (this.incomingAudioPreviewNode.pause) this.incomingAudioPreviewNode.pause();
                if (this.incomingAudioPreviewNode.disconnect) this.incomingAudioPreviewNode.disconnect();
            } catch (e) {}
            this.incomingAudioPreviewNode = null;
        }
        BlobUrlTracker.revokeCategory('incoming');
    }

    async applyIncomingToSelectedScroll() {
        if (!this.incomingData) return;
        const targetScrollId = document.getElementById('incoming-target-scroll')?.value || this.currentScrollId;
        const s = this.incomingData.slot || this.incomingData;

        const blob = this.extractAudioBlob(s);
        const targetSlots = this.slots.filter(sl => sl.scrollId === targetScrollId);
        const newSlot = {
            id: 'slot_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
            scrollId: targetScrollId,
            label: s.label || 'ボタン',
            labelPosition: s.labelPosition || 'bottom',
            emoji: s.emoji || '🔊',
            imageUrl: s.imageUrl || null,
            imageScale: s.imageScale !== undefined ? s.imageScale : 1.0,
            imageOffsetX: s.imageOffsetX !== undefined ? s.imageOffsetX : 0,
            imageOffsetY: s.imageOffsetY !== undefined ? s.imageOffsetY : 0,
            imageFit: s.imageFit || 'cover',
            audioBlob: blob,
            duration: s.duration || 0,
            voiceEffect: s.voiceEffect || 'inherit',
            voiceEffectMode: s.voiceEffectMode || 'inherit',
            voiceParams: s.voiceParams || null,
            envParams: s.envParams || null,
            eqParams: s.eqParams || null,
            specialParams: s.specialParams || null,
            playbackSpeed: s.playbackSpeed || 'inherit',
            volume: (s.volume !== undefined && s.volume !== null) ? parseFloat(s.volume) : 1.0,
            ttsText: s.ttsText || null,
            ttsVoice: s.ttsVoice || null,
            ttsRate: s.ttsRate || 1.0,
            ttsPitch: s.ttsPitch || 1.0,
            order: targetSlots.length + 1
        };

        await this.storage.saveSlot(newSlot);
        this.slots.push(newSlot);

        if (this.currentScrollId !== targetScrollId) {
            await this.switchScroll(targetScrollId);
        } else {
            this.currentPage = Math.ceil(newSlot.order / this.pageSize);
            this.renderSlots();
            this.renderScrollTabs();
        }

        this.closeIncomingShareModal();
        this.showToast(`✨ スイッチ「${newSlot.label}」を追加しました！`);
    }

    async applyIncomingToNewScroll() {
        if (!this.incomingData) return;

        if (this.incomingData.type === 'voicepad_scroll') {
            const newScrollId = 'scroll_' + Date.now();
            const newScroll = {
                id: newScrollId,
                name: this.incomingData.scroll?.name || '受信スクロール',
                voiceEffect: this.incomingData.scroll?.voiceEffect || 'inherit',
                voiceEffectMode: this.incomingData.scroll?.voiceEffectMode || 'inherit',
                voiceParams: this.incomingData.scroll?.voiceParams || null,
                envParams: this.incomingData.scroll?.envParams || null,
                eqParams: this.incomingData.scroll?.eqParams || null,
                specialParams: this.incomingData.scroll?.specialParams || null,
                playbackSpeed: this.incomingData.scroll?.playbackSpeed || 'inherit',
                order: this.scrolls.length,
                createdAt: Date.now()
            };
            await this.storage.saveScroll(newScroll);
            this.scrolls.push(newScroll);

            if (Array.isArray(this.incomingData.slots)) {
                for (const s of this.incomingData.slots) {
                    const blob = this.extractAudioBlob(s);
                    const slotObj = {
                        id: 'slot_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
                        scrollId: newScrollId,
                        label: s.label || 'ボタン',
                        labelPosition: s.labelPosition || 'bottom',
                        emoji: s.emoji || '🔊',
                        imageUrl: s.imageUrl || null,
                        imageScale: s.imageScale !== undefined ? s.imageScale : 1.0,
                        imageOffsetX: s.imageOffsetX !== undefined ? s.imageOffsetX : 0,
                        imageOffsetY: s.imageOffsetY !== undefined ? s.imageOffsetY : 0,
                        imageFit: s.imageFit || 'cover',
                        audioBlob: blob,
                        duration: s.duration || 0,
                        voiceEffect: s.voiceEffect || 'inherit',
                        voiceEffectMode: s.voiceEffectMode || 'inherit',
                        voiceParams: s.voiceParams || null,
                        envParams: s.envParams || null,
                        eqParams: s.eqParams || null,
                        specialParams: s.specialParams || null,
                        playbackSpeed: s.playbackSpeed || 'inherit',
                        ttsText: s.ttsText || null,
                        ttsVoice: s.ttsVoice || null,
                        ttsRate: s.ttsRate || 1.0,
                        ttsPitch: s.ttsPitch || 1.0,
                        order: s.order || 1
                    };
                    await this.storage.saveSlot(slotObj);
                    this.slots.push(slotObj);
                }
            }

            await this.switchScroll(newScrollId);
            this.closeIncomingShareModal();
            this.showToast(`✨ 新規スクロール「${newScroll.name}」を作成して追加しました！`);
            return;
        }

        // 単体ボタンの場合: 新規スクロールを作ってそこに配置
        const s = this.incomingData.slot || this.incomingData;
        const scrollName = `受信_${s.label || 'ボタン'}`;
        const newScrollId = 'scroll_' + Date.now();
        const newScroll = {
            id: newScrollId,
            name: scrollName,
            order: this.scrolls.length,
            voiceEffect: 'inherit',
            voiceEffectMode: 'inherit',
            voiceParams: null,
            envParams: null,
            eqParams: null,
            specialParams: null,
            playbackSpeed: 'inherit',
            createdAt: Date.now()
        };
        await this.storage.saveScroll(newScroll);
        this.scrolls.push(newScroll);

        const blob = this.extractAudioBlob(s);
        const newSlot = {
            id: 'slot_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
            scrollId: newScrollId,
            label: s.label || 'ボタン',
            labelPosition: s.labelPosition || 'bottom',
            emoji: s.emoji || '🔊',
            imageUrl: s.imageUrl || null,
            imageScale: s.imageScale !== undefined ? s.imageScale : 1.0,
            imageOffsetX: s.imageOffsetX !== undefined ? s.imageOffsetX : 0,
            imageOffsetY: s.imageOffsetY !== undefined ? s.imageOffsetY : 0,
            imageFit: s.imageFit || 'cover',
            audioBlob: blob,
            duration: s.duration || 0,
            voiceEffect: s.voiceEffect || 'inherit',
            voiceEffectMode: s.voiceEffectMode || 'inherit',
            voiceParams: s.voiceParams || null,
            envParams: s.envParams || null,
            eqParams: s.eqParams || null,
            specialParams: s.specialParams || null,
            playbackSpeed: s.playbackSpeed || 'inherit',
            volume: (s.volume !== undefined && s.volume !== null) ? parseFloat(s.volume) : 1.0,
            ttsText: s.ttsText || null,
            ttsVoice: s.ttsVoice || null,
            ttsRate: s.ttsRate || 1.0,
            ttsPitch: s.ttsPitch || 1.0,
            order: 1
        };
        await this.storage.saveSlot(newSlot);
        this.slots.push(newSlot);

        await this.switchScroll(newScrollId);
        this.closeIncomingShareModal();
        this.showToast(`✨ 新規スクロール「${scrollName}」にスイッチを追加しました！`);
    }

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
function initVoicePad() {
    window.AudioUtils = AudioUtils;
    window.AudioUnlocker = AudioUnlocker;
    window.VoiceEngine = VoiceEngine;
    window.TtsEngine = TtsEngine;
    window.QrEngine = QrEngine;
    window.WebRtcEngine = WebRtcEngine;
    window.P2PDataEngine = P2PDataEngine;
    window.BlobUrlTracker = BlobUrlTracker;

    if (!window.app) {
        window.app = new VoicePadApp();
        window.voicePadApp = window.app;
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initVoicePad);
} else {
    initVoicePad();
}
