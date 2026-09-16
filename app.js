/**
 * Voice Pad - 音声録音＆タッチサンプラー
 * 完全ローカル完結・AudioContext自動復帰・スクロール管理・長押しドラッグ並び替え
 * 写真・ボイスチェンジャー・再生スピードの階層的個別設定＆完全エクスポート・インポート対応
 */

const APP_VERSION = '2026.09.17.0003';

// ==================== 0. 音声エンコード＆波形編集ユーティリティ ====================
class AudioUtils {
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

// ==================== 2. 完全クライアントサイド 2ステージ直列音声DSPエンジン ====================
class VoiceEngine {
    /**
     * 声質デフォルトパラメータ（中身）
     */
    static defaultVoiceParams() {
        return {
            pitchSemitones: 0,   // -12 〜 +12 半音 (速度不変)
            formantRatio: 1.0,   // 0.5x (巨漢/太声) 〜 1.8x (妖精/子ども)
            roughness: 0         // 0% 〜 100% (倍音サチュレーション＋息ノイズ)
        };
    }

    /**
     * 環境デフォルトパラメータ（外側）
     */
    static defaultEnvParams() {
        return {
            reverb: 0,           // 0% 〜 100% (残響の深さ・ディケイ)
            filter: 0,           // 0% 〜 100% (こもり・電話・ラジオ・メガホン)
            modulation: 0        // 0% 〜 100% (ロボット・宇宙人・リングモジュレーション)
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
            'man': { pitchSemitones: -3, formantRatio: 0.82, roughness: 20 },
            'woman': { pitchSemitones: 3, formantRatio: 1.2, roughness: 10 },
            'old_man': { pitchSemitones: -4, formantRatio: 0.82, roughness: 55 },
            'old_woman': { pitchSemitones: 3, formantRatio: 1.12, roughness: 45 },
            'monster': { pitchSemitones: -8, formantRatio: 0.58, roughness: 75 }
        };

        const envPresets = {
            'none': { reverb: 0, filter: 0, modulation: 0 },
            'cave': { reverb: 85, filter: 20, modulation: 0 },
            'hall': { reverb: 65, filter: 0, modulation: 0 },
            'telephone': { reverb: 0, filter: 85, modulation: 0 },
            'radio': { reverb: 0, filter: 68, modulation: 15 },
            'megaphone': { reverb: 5, filter: 95, modulation: 0 },
            'robot': { reverb: 10, filter: 0, modulation: 80 },
            'alien': { reverb: 45, filter: 15, modulation: 60 },
            'underwater': { reverb: 35, filter: 48, modulation: 0 }
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
        const formantRatio = Math.max(0.5, Math.min(2.0, params.formantRatio || 1.0));
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
     * 【ステージ2】環境フィルターパラメータ処理（リバーブ・フィルター・モジュレーション）
     */
    static processEnvStage(buffer, envParams, ctx) {
        if (!buffer || !ctx) return buffer;
        const params = { ...this.defaultEnvParams(), ...(envParams || {}) };

        const reverbAmt = Math.max(0, Math.min(100, params.reverb || 0)) / 100;
        const filterAmt = Math.max(0, Math.min(100, params.filter || 0)) / 100;
        const modAmt = Math.max(0, Math.min(100, params.modulation || 0)) / 100;

        if (reverbAmt === 0 && filterAmt === 0 && modAmt === 0) {
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

        // 3. プロシージャルリバーブ（残響・大ホール・洞窟）
        if (reverbAmt > 0) {
            workingBuffer = this.applySchroederReverb(workingBuffer, reverbAmt, ctx);
        }

        return workingBuffer;
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
     * 本格 Freeverb / Schroeder プロシージャル空間リバーブ
     * 8基の独立LPFフィードバック・コムフィルター ＋ 4基のオールパス・ディフューザー
     */
    static applySchroederReverb(buffer, reverbAmt, ctx) {
        if (!buffer || !ctx || reverbAmt <= 0) return buffer;
        const numChannels = buffer.numberOfChannels;
        const sampleRate = buffer.sampleRate;
        const numSamples = buffer.length;

        const amt = Math.max(0, Math.min(100, reverbAmt)) / 100; // 0.0 〜 1.0

        // 残響テイル時間の計算（最大1.8秒拡張）
        const tailSec = 0.4 + (amt * 1.5);
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

        // フィードバック係数（0.68 〜 0.93：豊かなロング残響テイル）
        const feedback = 0.68 + (amt * 0.25);
        // 高域ダンピング（壁の吸音: 0.25）
        const damp = 0.28;

        for (let ch = 0; ch < numChannels; ch++) {
            const src = buffer.getChannelData(ch);
            const dst = outputBuffer.getChannelData(ch);

            // コムフィルター用ディレイライン
            const combBuffers = combTuning.map(len => new Float32Array(len));
            const combIndices = new Int32Array(combTuning.length);
            const combFilterStore = new Float32Array(combTuning.length);

            // オールパス用ディレイライン
            const apBuffers = allpassTuning.map(len => new Float32Array(len));
            const apIndices = new Int32Array(allpassTuning.length);

            // ドライ・ウェット比率
            const wetGain = (0.35 + amt * 0.85) / Math.sqrt(combTuning.length);
            const dryGain = Math.max(0.15, 1.0 - (amt * 0.45));

            for (let i = 0; i < totalSamples; i++) {
                const inSample = (i < numSamples) ? src[i] : 0;
                let combOutSum = 0;

                // 8基のコムフィルター並列処理
                for (let c = 0; c < combTuning.length; c++) {
                    const cBuf = combBuffers[c];
                    const cLen = combTuning[c];
                    const cIdx = combIndices[c];

                    const delayed = cBuf[cIdx];
                    // ダンピングローパス
                    combFilterStore[c] = (delayed * (1 - damp)) + (combFilterStore[c] * damp);
                    cBuf[cIdx] = inSample + (combFilterStore[c] * feedback);

                    combIndices[c] = (cIdx + 1) % cLen;
                    combOutSum += delayed;
                }

                // 4基のオールパスフィルター直列処理（空間拡散・ディフュージョン）
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

                dst[i] = (inSample * dryGain) + (apOut * wetGain);
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
     * Voicemodスタイル 統合ボイスプリセット定義マスター
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
                env: { reverb: 5, filter: 0, modulation: 0 },
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
                env: { reverb: 5, filter: 95, modulation: 0 },
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
                env: { reverb: 0, filter: 88, modulation: 0 },
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
                env: { reverb: 0, filter: 68, modulation: 15 },
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
                env: { reverb: 0, filter: 30, modulation: 0 },
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
                env: { reverb: 5, filter: 0, modulation: 0 },
                eq: { bass: -4, mid: 2, treble: 6 },
                special: { chorus: 0, radioNoise: 0, trash: 0 }
            },
            {
                id: 'monster_titan',
                name: '怪獣 / タイタン',
                category: 'character',
                icon: '👹',
                desc: '巨体の咆哮＆重低音ガラガラ声',
                voice: { pitchSemitones: -9, formantRatio: 0.55, roughness: 80 },
                env: { reverb: 30, filter: 0, modulation: 0 },
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
                env: { reverb: 5, filter: 0, modulation: 0 },
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
                env: { reverb: 10, filter: 10, modulation: 0 },
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
                env: { reverb: 90, filter: 25, modulation: 30 },
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
                env: { reverb: 15, filter: 0, modulation: 80 },
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
                env: { reverb: 50, filter: 15, modulation: 65 },
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
                env: { reverb: 35, filter: 0, modulation: 0 },
                eq: { bass: 2, mid: 3, treble: 4 },
                special: { chorus: 90, radioNoise: 0, trash: 0 }
            },

            // 🏛️ 空間・音楽系
            {
                id: 'cathedral',
                name: '大聖堂 (Cathedral)',
                category: 'music',
                icon: '⛪',
                desc: '神秘的で圧倒的な超ロング残響',
                voice: { pitchSemitones: 0, formantRatio: 1.0, roughness: 0 },
                env: { reverb: 95, filter: 0, modulation: 0 },
                eq: { bass: 4, mid: 2, treble: 6 },
                special: { chorus: 20, radioNoise: 0, trash: 0 }
            },
            {
                id: 'cave',
                name: '洞窟 (Cave)',
                category: 'music',
                icon: '⛰️',
                desc: '岩肌に反響するディープエコー',
                voice: { pitchSemitones: -1, formantRatio: 0.95, roughness: 0 },
                env: { reverb: 85, filter: 20, modulation: 0 },
                eq: { bass: 5, mid: -1, treble: -2 },
                special: { chorus: 0, radioNoise: 0, trash: 0 }
            },
            {
                id: 'underwater',
                name: '水の中 (Underwater)',
                category: 'meme',
                icon: '🫧',
                desc: '深い水底の極限こもり音響',
                voice: { pitchSemitones: -2, formantRatio: 0.85, roughness: 0 },
                env: { reverb: 40, filter: 48, modulation: 0 },
                eq: { bass: 7, mid: -6, treble: -12 },
                special: { chorus: 30, radioNoise: 0, trash: 0 }
            }
        ];
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
                whiteNoise.start();
            }
        } catch (e) {}
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

// ==================== 4. メインアプリケーションロジック ====================
class VoicePadApp {
    constructor() {
        this.storage = new StorageManager();
        this.audioCtx = null;
        this.mediaRecorder = null;
        this.audioStream = null;

        this.currentMode = 'play';
        this.recordingSlotId = null;
        this.recordedChunks = [];
        this.recTimer = null;
        this.recSeconds = 0;

        // 🎙️ Voicemod / 2ステージ直列DSP & EQパラメータ（全体基本）
        this.globalVoiceParams = VoiceEngine.defaultVoiceParams();
        this.globalEnvParams = VoiceEngine.defaultEnvParams();
        this.globalEqParams = { bass: 0, mid: 0, treble: 0 };
        this.currentEffect = 'normal'; // 旧プリセット名（互換用）
        this.globalPlaybackSpeed = 1.0; // 全体基本再生スピード

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
        this.initWaveformEvents();
        this.initKeyboardAndMidi();
        this.initAACScanController();
        this.initIncomingShareAndDropzone();
        this.initVoiceEngineUIEvents();
    }

    async loadAllData() {
        this.pageSize = await this.storage.getSetting('pageSize', 32);
        this.globalPlaybackSpeed = await this.storage.getSetting('globalPlaybackSpeed', 1.0);
        
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
                voiceEffectMode: 'inherit',
                voiceParams: VoiceEngine.defaultVoiceParams(),
                envParams: VoiceEngine.defaultEnvParams(),
                playbackSpeed: 'inherit',
                createdAt: Date.now()
            };
            await this.storage.saveScroll(initialScroll);
            this.scrolls.push(initialScroll);
            this.currentScrollId = initialScroll.id;
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
                const tag = (slot.ttsText && !slot.audioBlob) ? '🤖 ' : '';
                statusText = `${tag}${(slot.duration || 1.0).toFixed(1)}s${speedLabel}`;
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
        this.setFxParamsToUI('scroll', initialVoice, initialEnv, initialEq, initialSpecial);

        // スピード設定同期
        const speedSelect = document.getElementById('edit-scroll-speed');
        if (speedSelect) {
            speedSelect.value = scroll.playbackSpeed || 'inherit';
            speedSelect.options[0].text = `🔄 全体設定に従う (現在: ${this.globalPlaybackSpeed}x)`;
        }

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

        const modeSelect = document.getElementById('edit-scroll-effect-mode');
        scroll.voiceEffectMode = modeSelect ? modeSelect.value : 'inherit';

        if (scroll.voiceEffectMode === 'custom') {
            const { voiceParams, envParams, eqParams, specialParams } = this.getFxParamsFromUI('scroll');
            scroll.voiceParams = voiceParams;
            scroll.envParams = envParams;
            scroll.eqParams = eqParams;
            scroll.specialParams = specialParams;
            scroll.voiceEffect = 'custom';
        } else {
            scroll.voiceEffect = 'inherit';
        }

        const speedSelect = document.getElementById('edit-scroll-speed');
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

    // ==================== 音声再生制御（階層エフェクト＆スピード反映） ====================
    async playSlot(slotId) {
        await AudioUnlocker.unlock();
        const ctx = AudioUnlocker.getContext();

        const slot = this.slots.find(s => s.id === slotId);
        if (!slot || (!slot.audioBlob && !slot.ttsText)) {
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

        // ① AI音声合成 (TTS) スロットの場合
        if (slot.ttsText && !slot.audioBlob) {
            this.playTtsSlot(slot, voiceParams, envParams, effectiveSpeed);
            return;
        }

        // ② 録音・取り込み音声の場合
        try {
            const arrayBuffer = await slot.audioBlob.arrayBuffer();
            const originalBuffer = await ctx.decodeAudioData(arrayBuffer);

            // フルDSPエフェクト適用（声質 -> 環境 -> 3-Band EQ -> Special FX）
            const finalBuffer = VoiceEngine.processFull(originalBuffer, ctx, voiceParams, envParams, effectiveSpeed, eqParams, specialParams);

            const source = ctx.createBufferSource();
            source.buffer = finalBuffer;

            // 再生スピード設定
            source.playbackRate.value = effectiveSpeed;

            const gainNode = ctx.createGain();
            source.connect(gainNode);
            gainNode.connect(ctx.destination);

            source.start(0);

            const card = document.getElementById(`pad-${slotId}`);
            if (card) {
                card.classList.add('playing');
                card.classList.add('is-playing');
            }

            this.activeSources.set(slotId, source);

            source.onended = () => {
                this.stopSlot(slotId);
            };
        } catch (err) {
            console.error('Audio play error, using fallback:', err);
            this.fallbackPlay(slot, slotId, effectiveSpeed);
        }
    }

    playTtsSlot(slot, voiceParams, envParams, speed = 1.0) {
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

        // 音声の特定
        const allVoices = window.speechSynthesis.getVoices();
        if (allVoices.length > 0) this.ttsVoices = allVoices;

        const hasJapanese = /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uff9f\u4e00-\u9faf]/.test(slot.ttsText);

        let selectedVoice = null;
        if (slot.ttsVoice) {
            selectedVoice = this.ttsVoices.find(v => v.name === slot.ttsVoice || v.voiceURI === slot.ttsVoice);
        }

        // 日本語テキストなのに非日本語音声が選ばれている場合は、音が出ないエラーを防ぐため安全な日本語音声に自動フォールバック
        if (hasJapanese && selectedVoice && !selectedVoice.lang.startsWith('ja')) {
            const jaVoice = this.ttsVoices.find(v => v.lang.startsWith('ja'));
            if (jaVoice) {
                selectedVoice = jaVoice;
            }
        }

        if (!selectedVoice) {
            selectedVoice = this.ttsVoices.find(v => v.lang.startsWith('ja')) || this.ttsVoices[0];
        }

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

        // ピッチシフト（半音数＋フォルマントからUtterance.pitchへのマッピング）
        const semitones = vParams.pitchSemitones || 0;
        const formant = vParams.formantRatio || 1.0;
        const pitchFactor = Math.pow(2, semitones / 12) * Math.sqrt(formant);
        const calculatedPitch = Math.max(0.1, Math.min(2.0, basePitch * pitchFactor));

        // 話速計算
        let calculatedRate = baseRate * speed;
        if (vParams.roughness > 30) calculatedRate *= 0.92;
        utter.pitch = calculatedPitch;
        utter.rate = Math.max(0.1, Math.min(3.0, calculatedRate));

        const ttsController = {
            stop: () => {
                window.speechSynthesis.cancel();
            }
        };
        this.activeSources.set(slot.id, ttsController);

        utter.onend = () => {
            this.stopSlot(slot.id);
        };
        utter.onerror = () => {
            this.stopSlot(slot.id);
        };

        // 空間・環境エフェクト（リバーブ、フィルター、ロボットモジュレーション）をWeb Audio APIで並行重畳
        VoiceEngine.playAcousticFilterOverlay(eParams);

        setTimeout(() => {
            if (window.speechSynthesis.paused) {
                window.speechSynthesis.resume();
            }
            window.speechSynthesis.speak(utter);
        }, 50);
    }

    fallbackPlay(slot, slotId, speed = 1.0) {
        try {
            const audioUrl = URL.createObjectURL(slot.audioBlob);
            const audio = new Audio(audioUrl);
            audio.playbackRate = speed;
            audio.play();
            const card = document.getElementById(`pad-${slotId}`);
            if (card) {
                card.classList.add('playing');
                card.classList.add('is-playing');
            }
            audio.onended = () => {
                if (card) {
                    card.classList.remove('playing');
                    card.classList.remove('is-playing');
                }
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
                if (source.disconnect) source.disconnect();
            } catch (e) {}
            this.activeSources.delete(slotId);
        }
        if ('speechSynthesis' in window) {
            window.speechSynthesis.cancel();
        }
        const card = document.getElementById(`pad-${slotId}`);
        if (card) {
            card.classList.remove('playing');
            card.classList.remove('is-playing');
        }
    }

    // ==================== 5. 写真・エフェクト・スピード完全対応 3階層エクスポート＆インポート ====================
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

        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(url);
        this.showToast(`💾 「${fileName}」を保存しました`);
    }

    // ① 単一スイッチのエクスポート (.vpad-button)
    async exportSingleSlot(slotId) {
        const slot = this.slots.find(s => s.id === slotId);
        if (!slot) return;

        const audioBase64 = await this.blobToBase64(slot.audioBlob);
        const exportData = {
            type: 'voicepad_slot',
            version: '2.2',
            exportedAt: new Date().toISOString(),
            slot: {
                label: slot.label,
                labelPosition: slot.labelPosition,
                emoji: slot.emoji,
                imageUrl: slot.imageUrl || null,
                imageScale: slot.imageScale !== undefined ? slot.imageScale : 1.0,
                imageOffsetX: slot.imageOffsetX !== undefined ? slot.imageOffsetX : 0,
                imageOffsetY: slot.imageOffsetY !== undefined ? slot.imageOffsetY : 0,
                imageFit: slot.imageFit || 'cover',
                duration: slot.duration,
                voiceEffect: slot.voiceEffect || 'inherit',
                voiceEffectMode: slot.voiceEffectMode || 'inherit',
                voiceParams: slot.voiceParams || null,
                envParams: slot.envParams || null,
                playbackSpeed: slot.playbackSpeed || 'inherit',
                ttsText: slot.ttsText || null,
                ttsVoice: slot.ttsVoice || null,
                ttsRate: slot.ttsRate || 1.0,
                ttsPitch: slot.ttsPitch || 1.0,
                audioBase64: audioBase64
            }
        };

        const safeLabel = (slot.label || 'ボタン').replace(/[\\/:*?"<>|]/g, '_');
        const fileName = `VoicePad_ボタン_${safeLabel}.vpad-button`;
        await this.shareOrDownloadFile(fileName, JSON.stringify(exportData, null, 2), '単体ボタン');
    }

    // ② スクロール単位のエクスポート (.vpad-page)
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
                imageUrl: slot.imageUrl || null,
                imageScale: slot.imageScale !== undefined ? slot.imageScale : 1.0,
                imageOffsetX: slot.imageOffsetX !== undefined ? slot.imageOffsetX : 0,
                imageOffsetY: slot.imageOffsetY !== undefined ? slot.imageOffsetY : 0,
                imageFit: slot.imageFit || 'cover',
                duration: slot.duration,
                voiceEffect: slot.voiceEffect || 'inherit',
                voiceEffectMode: slot.voiceEffectMode || 'inherit',
                voiceParams: slot.voiceParams || null,
                envParams: slot.envParams || null,
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
            version: '2.3',
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
            const audioBase64 = await this.blobToBase64(slot.audioBlob);
            serializedSlots.push({
                id: slot.id,
                scrollId: slot.scrollId,
                label: slot.label,
                labelPosition: slot.labelPosition,
                emoji: slot.emoji,
                imageUrl: slot.imageUrl || null,
                imageScale: slot.imageScale !== undefined ? slot.imageScale : 1.0,
                imageOffsetX: slot.imageOffsetX !== undefined ? slot.imageOffsetX : 0,
                imageOffsetY: slot.imageOffsetY !== undefined ? slot.imageOffsetY : 0,
                imageFit: slot.imageFit || 'cover',
                duration: slot.duration,
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
            version: '2.3',
            exportedAt: new Date().toISOString(),
            settings: {
                pageSize: this.pageSize,
                effect: this.currentEffect,
                globalVoiceParams: this.globalVoiceParams,
                globalEnvParams: this.globalEnvParams,
                globalEqParams: this.globalEqParams,
                globalPlaybackSpeed: this.globalPlaybackSpeed,
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
                playbackSpeed: 'inherit',
                order: currentSlots.length + 1
            };
            await this.storage.saveSlot(newSlot);
            this.slots.push(newSlot);
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
                            const blob = this.base64ToBlob(s.audioBase64);
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
                const newScrollId = 'scroll_' + Date.now();
                const newScroll = {
                    id: newScrollId,
                    name: data.scroll?.name || 'インポートスクロール',
                    voiceEffect: data.scroll?.voiceEffect || 'inherit',
                    voiceEffectMode: data.scroll?.voiceEffectMode || 'inherit',
                    voiceParams: data.scroll?.voiceParams || null,
                    envParams: data.scroll?.envParams || null,
                    eqParams: data.scroll?.eqParams || null,
                    specialParams: data.scroll?.specialParams || null,
                    playbackSpeed: data.scroll?.playbackSpeed || 'inherit',
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
                this.showToast(`✨ スクロール「${newScroll.name}」を復元・インポートしました！`);
            } else if (data.type === 'voicepad_slot' || data.slot) {
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
                    playbackSpeed: s.playbackSpeed || 'inherit',
                    ttsText: s.ttsText || null,
                    ttsVoice: s.ttsVoice || null,
                    ttsRate: s.ttsRate || 1.0,
                    ttsPitch: s.ttsPitch || 1.0,
                    order: currentSlots.length + 1
                };

                await this.storage.saveSlot(newSlot);
                this.slots.push(newSlot);
                this.renderSlots();
                this.renderScrollTabs();
                this.showToast(`✨ 写真・声質設定付きスイッチ「${newSlot.label}」をインポートしました！`);
            } else {
                alert('対応していないファイル形式です。共有されたスクロールまたはボタンのファイル（.json）を選択してください。');
            }
        } catch (err) {
            console.error('Import error:', err);
            alert('ファイルの読み込みに失敗しました。正しいVoice Pad共有ファイル（.json）を選択してください。');
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
        document.getElementById('close-slot-voice-modal-btn')?.addEventListener('click', () => this.closeSlotVoiceModal());
        document.getElementById('slot-voice-modal-backdrop')?.addEventListener('click', (e) => {
            if (e.target.id === 'slot-voice-modal-backdrop') this.closeSlotVoiceModal();
        });
        document.getElementById('save-slot-voice-btn')?.addEventListener('click', () => this.saveSlotVoiceModal());
        document.getElementById('btn-quick-voice-preview')?.addEventListener('click', () => this.previewQuickVoiceEffect());

        // ⛰️ スイッチ専用クイック【環境】モーダル
        document.getElementById('close-slot-env-modal-btn')?.addEventListener('click', () => this.closeSlotEnvModal());
        document.getElementById('slot-env-modal-backdrop')?.addEventListener('click', (e) => {
            if (e.target.id === 'slot-env-modal-backdrop') this.closeSlotEnvModal();
        });
        document.getElementById('save-slot-env-btn')?.addEventListener('click', () => this.saveSlotEnvModal());
        document.getElementById('btn-quick-env-preview')?.addEventListener('click', () => this.previewQuickEnvEffect());

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

        // ボイスエフェクトモード＆2ステージパラメータ同期
        const modeSelect = document.getElementById('edit-slot-effect-mode');
        const panel = document.getElementById('slot-fx-custom-panel');
        const isCustom = (slot.voiceEffectMode === 'custom') || (slot.voiceEffect && slot.voiceEffect !== 'inherit');
        if (modeSelect) modeSelect.value = isCustom ? 'custom' : 'inherit';
        if (panel) panel.style.display = isCustom ? 'flex' : 'none';

        const initialVoice = slot.voiceParams || (slot.voiceEffect ? VoiceEngine.presetToParams(slot.voiceEffect).voice : VoiceEngine.defaultVoiceParams());
        const initialEnv = slot.envParams || (slot.voiceEffect ? VoiceEngine.presetToParams(slot.voiceEffect).env : VoiceEngine.defaultEnvParams());
        const initialEq = slot.eqParams || (slot.voiceEffect ? VoiceEngine.presetToParams(slot.voiceEffect).eq : { bass: 0, mid: 0, treble: 0 });
        const initialSpecial = slot.specialParams || (slot.voiceEffect ? VoiceEngine.presetToParams(slot.voiceEffect).special : null);
        this.setFxParamsToUI('slot', initialVoice, initialEnv, initialEq, initialSpecial);

        // Voicemod風 プリセットカード一覧を描画
        this.renderVoicemodPresetCards('slot-voicemod-grid', 'all', 'slot');
        document.querySelectorAll('#slot-voicemod-tabs .vm-tab-btn').forEach(b => {
            if (b.getAttribute('data-category') === 'all') b.classList.add('active');
            else b.classList.remove('active');
        });

        // スピード設定同期
        const speedSelect = document.getElementById('edit-slot-speed');
        if (speedSelect) {
            speedSelect.value = slot.playbackSpeed || 'inherit';
            const parentSpeed = this.getScrollEffectiveSpeed(slot.scrollId);
            speedSelect.options[0].text = `🔄 スクロール設定に従う (現在: ${parentSpeed}x)`;
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

        // 🤖 AI TTS設定の同期
        this.populateTtsVoices();
        const ttsInput = document.getElementById('tts-input-text');
        if (ttsInput) {
            ttsInput.value = slot.ttsText || '';
            setTimeout(() => this.adjustTtsTextarea(ttsInput), 10);
        }
        const ttsVoiceSelect = document.getElementById('tts-voice-select');
        if (ttsVoiceSelect && slot.ttsVoice) ttsVoiceSelect.value = slot.ttsVoice;
        const currentRate = slot.ttsRate || 1.0;
        const currentPitch = slot.ttsPitch || 1.0;
        const ttsRateSlider = document.getElementById('tts-rate-slider');
        if (ttsRateSlider) {
            ttsRateSlider.value = currentRate;
            const rateVal = document.getElementById('tts-rate-val');
            if (rateVal) rateVal.innerText = `${parseFloat(currentRate).toFixed(2)}x`;
        }
        const ttsPitchSlider = document.getElementById('tts-pitch-slider');
        if (ttsPitchSlider) {
            ttsPitchSlider.value = currentPitch;
            const pitchVal = document.getElementById('tts-pitch-val');
            if (pitchVal) pitchVal.innerText = `${parseFloat(currentPitch).toFixed(2)}`;
        }

        // プリセットチップのアクティブ状態判定
        this.clearTtsPresetActiveState();
        if (Math.abs(currentPitch - 1.40) < 0.08) {
            document.querySelector('#tts-preset-chips button[data-tts-preset="girl"]')?.classList.add('active');
        } else if (Math.abs(currentPitch - 1.25) < 0.08) {
            document.querySelector('#tts-preset-chips button[data-tts-preset="boy"]')?.classList.add('active');
        } else if (Math.abs(currentPitch - 0.65) < 0.08) {
            document.querySelector('#tts-preset-chips button[data-tts-preset="man"]')?.classList.add('active');
        } else if (Math.abs(currentPitch - 1.0) < 0.08 && Math.abs(currentRate - 1.0) < 0.08) {
            document.querySelector('#tts-preset-chips button[data-tts-preset="woman"]')?.classList.add('active');
        }

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
        if ('speechSynthesis' in window) {
            window.speechSynthesis.cancel();
        }
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
        const modeSelect = document.getElementById('edit-slot-effect-mode');
        const speedSelect = document.getElementById('edit-slot-speed');

        slot.label = labelInput || `ボタン`;
        slot.labelPosition = labelPos;
        slot.emoji = emojiInput || '🔊';
        slot.imageUrl = this.editingImageUrl;
        slot.imageScale = this.editingImageScale;
        slot.imageOffsetX = this.editingImageOffsetX;
        slot.imageOffsetY = this.editingImageOffsetY;
        slot.imageFit = this.editingImageFit;

        slot.voiceEffectMode = modeSelect ? modeSelect.value : 'inherit';

        if (slot.voiceEffectMode === 'custom') {
            const { voiceParams, envParams, eqParams, specialParams } = this.getFxParamsFromUI('slot');
            slot.voiceParams = voiceParams;
            slot.envParams = envParams;
            slot.eqParams = eqParams;
            slot.specialParams = specialParams;
            slot.voiceEffect = 'custom';
        } else {
            slot.voiceEffect = 'inherit';
        }

        if (speedSelect) {
            slot.playbackSpeed = speedSelect.value;
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
        this.bindFxSliders('slot');
        this.bindFxSliders('scroll');
        this.bindFxSliders('global');
        this.initVoicemodCategoryTabs();

        // スロットモーダルのモード切り替え
        document.getElementById('edit-slot-effect-mode')?.addEventListener('change', (e) => {
            const panel = document.getElementById('slot-fx-custom-panel');
            if (panel) panel.style.display = e.target.value === 'custom' ? 'flex' : 'none';
        });

        // スクロールモーダルのモード切り替え
        document.getElementById('edit-scroll-effect-mode')?.addEventListener('change', (e) => {
            const panel = document.getElementById('scroll-fx-custom-panel');
            if (panel) panel.style.display = e.target.value === 'custom' ? 'flex' : 'none';
        });

        // スロット個別エフェクト試聴ボタン
        document.getElementById('btn-slot-fx-preview')?.addEventListener('click', () => {
            this.previewSlotEffect();
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
                const desc = val <= 0.8 ? '太声/巨漢' : val >= 1.25 ? '妖精/子ども' : '標準';
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
    }

    /**
     * Voicemod風 カテゴリタブの初期化
     */
    initVoicemodCategoryTabs() {
        document.querySelectorAll('#slot-voicemod-tabs .vm-tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('#slot-voicemod-tabs .vm-tab-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const category = btn.getAttribute('data-category');
                this.renderVoicemodPresetCards('slot-voicemod-grid', category, 'slot');
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
        const modeSelect = document.getElementById(`edit-${prefix}-effect-mode`);
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
                const desc = val <= 0.8 ? '太声/巨漢' : val >= 1.25 ? '妖精/子ども' : '標準';
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

        // ④ リバーブ
        const reverbSlider = document.getElementById(`${prefix}-reverb-slider`);
        const reverbVal = document.getElementById(`${prefix}-reverb-val`);
        if (reverbSlider && reverbVal) {
            reverbSlider.addEventListener('input', (e) => {
                const val = parseInt(e.target.value, 10);
                const desc = val === 0 ? 'ドライ' : val <= 50 ? 'お風呂' : '大ホール/洞窟';
                reverbVal.innerText = `${val}% (${desc})`;
            });
        }

        // ⑤ フィルター
        const filterSlider = document.getElementById(`${prefix}-filter-slider`);
        const filterVal = document.getElementById(`${prefix}-filter-val`);
        if (filterSlider && filterVal) {
            filterSlider.addEventListener('input', (e) => {
                const val = parseInt(e.target.value, 10);
                const desc = val === 0 ? 'オフ' : val <= 50 ? '水の中/こもり' : 'メガホン/電話';
                filterVal.innerText = `${val}% (${desc})`;
            });
        }

        // ⑥ モジュレーション
        const modSlider = document.getElementById(`${prefix}-mod-slider`);
        const modVal = document.getElementById(`${prefix}-mod-val`);
        if (modSlider && modVal) {
            modSlider.addEventListener('input', (e) => {
                const val = parseInt(e.target.value, 10);
                const desc = val === 0 ? 'オフ' : val <= 50 ? '宇宙人' : '金属ロボット';
                modVal.innerText = `${val}% (${desc})`;
            });
        }

        // ⑦ 3バンドEQ (Bass / Mid / Treble)
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
    }

    setFxParamsToUI(prefix, voiceParams, envParams, eqParams = null, specialParams = null) {
        const v = { ...VoiceEngine.defaultVoiceParams(), ...(voiceParams || {}) };
        const e = { ...VoiceEngine.defaultEnvParams(), ...(envParams || {}) };
        const eq = eqParams || { bass: 0, mid: 0, treble: 0 };

        const pitchSlider = document.getElementById(`${prefix}-pitch-slider`);
        const formantSlider = document.getElementById(`${prefix}-formant-slider`);
        const roughSlider = document.getElementById(`${prefix}-rough-slider`);
        const reverbSlider = document.getElementById(`${prefix}-reverb-slider`);
        const filterSlider = document.getElementById(`${prefix}-filter-slider`);
        const modSlider = document.getElementById(`${prefix}-mod-slider`);

        const eqBass = document.getElementById(`${prefix}-eq-bass-slider`);
        const eqMid = document.getElementById(`${prefix}-eq-mid-slider`);
        const eqTreble = document.getElementById(`${prefix}-eq-treble-slider`);

        if (pitchSlider) { pitchSlider.value = v.pitchSemitones; pitchSlider.dispatchEvent(new Event('input')); }
        if (formantSlider) { formantSlider.value = v.formantRatio; formantSlider.dispatchEvent(new Event('input')); }
        if (roughSlider) { roughSlider.value = v.roughness; roughSlider.dispatchEvent(new Event('input')); }
        if (reverbSlider) { reverbSlider.value = e.reverb; reverbSlider.dispatchEvent(new Event('input')); }
        if (filterSlider) { filterSlider.value = e.filter; filterSlider.dispatchEvent(new Event('input')); }
        if (modSlider) { modSlider.value = e.modulation; modSlider.dispatchEvent(new Event('input')); }

        if (eqBass) { eqBass.value = eq.bass || 0; eqBass.dispatchEvent(new Event('input')); }
        if (eqMid) { eqMid.value = eq.mid || 0; eqMid.dispatchEvent(new Event('input')); }
        if (eqTreble) { eqTreble.value = eq.treble || 0; eqTreble.dispatchEvent(new Event('input')); }

        this._currentSpecialParams = specialParams || null;
    }

    getFxParamsFromUI(prefix) {
        const pitchSlider = document.getElementById(`${prefix}-pitch-slider`);
        const formantSlider = document.getElementById(`${prefix}-formant-slider`);
        const roughSlider = document.getElementById(`${prefix}-rough-slider`);
        const reverbSlider = document.getElementById(`${prefix}-reverb-slider`);
        const filterSlider = document.getElementById(`${prefix}-filter-slider`);
        const modSlider = document.getElementById(`${prefix}-mod-slider`);

        const eqBass = document.getElementById(`${prefix}-eq-bass-slider`);
        const eqMid = document.getElementById(`${prefix}-eq-mid-slider`);
        const eqTreble = document.getElementById(`${prefix}-eq-treble-slider`);

        return {
            voiceParams: {
                pitchSemitones: pitchSlider ? parseInt(pitchSlider.value, 10) : 0,
                formantRatio: formantSlider ? parseFloat(formantSlider.value) : 1.0,
                roughness: roughSlider ? parseInt(roughSlider.value, 10) : 0
            },
            envParams: {
                reverb: reverbSlider ? parseInt(reverbSlider.value, 10) : 0,
                filter: filterSlider ? parseInt(filterSlider.value, 10) : 0,
                modulation: modSlider ? parseInt(modSlider.value, 10) : 0
            },
            eqParams: {
                bass: eqBass ? parseInt(eqBass.value, 10) : 0,
                mid: eqMid ? parseInt(eqMid.value, 10) : 0,
                treble: eqTreble ? parseInt(eqTreble.value, 10) : 0
            },
            specialParams: this._currentSpecialParams || null
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
        const { voiceParams, envParams, eqParams, specialParams } = this.getFxParamsFromUI('slot');

        if (slot && slot.audioBlob) {
            try {
                const arr = await slot.audioBlob.arrayBuffer();
                const originalBuffer = await ctx.decodeAudioData(arr.slice(0));
                const processed = VoiceEngine.processFull(originalBuffer, ctx, voiceParams, envParams, 1.0, eqParams, specialParams);

                const src = ctx.createBufferSource();
                src.buffer = processed;
                src.connect(ctx.destination);
                src.start(0);
                this.fxPreviewSource = src;
                this.showToast('▶️ Voicemod設定で音声を試聴中...');
                src.onended = () => { this.fxPreviewSource = null; };
            } catch (err) {
                console.error('Preview error:', err);
            }
        } else {
            this.playTestVoicePreview(ctx, voiceParams, envParams, 1.0, eqParams, specialParams);
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
        const isCustom = (slot.voiceEffectMode === 'custom' && !!slot.voiceParams);
        if (modeSelect) modeSelect.value = isCustom ? 'custom' : 'inherit';

        const effectiveVoice = this.getEffectiveVoiceParams(slot);
        const targetVoice = (isCustom && slot.voiceParams) ? slot.voiceParams : effectiveVoice;

        const pitchSlider = document.getElementById('quick-voice-pitch-slider');
        const formantSlider = document.getElementById('quick-voice-formant-slider');
        const roughSlider = document.getElementById('quick-voice-rough-slider');

        if (pitchSlider) { pitchSlider.value = targetVoice.pitchSemitones || 0; pitchSlider.dispatchEvent(new Event('input')); }
        if (formantSlider) { formantSlider.value = targetVoice.formantRatio !== undefined ? targetVoice.formantRatio : 1.0; formantSlider.dispatchEvent(new Event('input')); }
        if (roughSlider) { roughSlider.value = targetVoice.roughness || 0; roughSlider.dispatchEvent(new Event('input')); }

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
            const pitchSlider = document.getElementById('quick-voice-pitch-slider');
            const formantSlider = document.getElementById('quick-voice-formant-slider');
            const roughSlider = document.getElementById('quick-voice-rough-slider');

            slot.voiceEffectMode = 'custom';
            slot.voiceParams = {
                pitchSemitones: pitchSlider ? parseInt(pitchSlider.value, 10) : 0,
                formantRatio: formantSlider ? parseFloat(formantSlider.value) : 1.0,
                roughness: roughSlider ? parseInt(roughSlider.value, 10) : 0
            };
            slot.voiceEffect = 'custom';
        } else {
            slot.voiceParams = null;
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
        this.showToast(`🗣️ スイッチ「${slot.label}」の声質設定を保存しました`);
    }

    async previewQuickVoiceEffect() {
        if (!this.editingVoiceSlotId) return;
        const slot = this.slots.find(s => s.id === this.editingVoiceSlotId);
        await AudioUnlocker.unlock();
        const ctx = AudioUnlocker.getContext();
        if (!ctx) return;

        this.stopFxPreview();

        const pitchSlider = document.getElementById('quick-voice-pitch-slider');
        const formantSlider = document.getElementById('quick-voice-formant-slider');
        const roughSlider = document.getElementById('quick-voice-rough-slider');

        const voiceParams = {
            pitchSemitones: pitchSlider ? parseInt(pitchSlider.value, 10) : 0,
            formantRatio: formantSlider ? parseFloat(formantSlider.value) : 1.0,
            roughness: roughSlider ? parseInt(roughSlider.value, 10) : 0
        };
        const envParams = this.getEffectiveEnvParams(slot);
        const speed = this.getEffectivePlaybackSpeed(slot);

        if (slot && slot.audioBlob) {
            try {
                const arr = await slot.audioBlob.arrayBuffer();
                const originalBuffer = await ctx.decodeAudioData(arr.slice(0));
                const processed = VoiceEngine.processFull(originalBuffer, ctx, voiceParams, envParams, speed);

                const src = ctx.createBufferSource();
                src.buffer = processed;
                src.playbackRate.value = speed;
                src.connect(ctx.destination);
                src.start(0);
                this.fxPreviewSource = src;
                this.showToast('▶️ 設定した声質で試聴中...');
                src.onended = () => { this.fxPreviewSource = null; };
            } catch (err) {
                console.error('Preview error:', err);
            }
        } else {
            this.playTestVoicePreview(ctx, voiceParams, envParams, speed);
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

        if (reverbSlider) { reverbSlider.value = targetEnv.reverb || 0; reverbSlider.dispatchEvent(new Event('input')); }
        if (filterSlider) { filterSlider.value = targetEnv.filter || 0; filterSlider.dispatchEvent(new Event('input')); }
        if (modSlider) { modSlider.value = targetEnv.modulation || 0; modSlider.dispatchEvent(new Event('input')); }

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

            slot.voiceEffectMode = 'custom';
            slot.envParams = {
                reverb: reverbSlider ? parseInt(reverbSlider.value, 10) : 0,
                filter: filterSlider ? parseInt(filterSlider.value, 10) : 0,
                modulation: modSlider ? parseInt(modSlider.value, 10) : 0
            };
            slot.voiceEffect = 'custom';
        } else {
            slot.envParams = null;
            if (slot.voiceParams) {
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

        const envParams = {
            reverb: reverbSlider ? parseInt(reverbSlider.value, 10) : 0,
            filter: filterSlider ? parseInt(filterSlider.value, 10) : 0,
            modulation: modSlider ? parseInt(modSlider.value, 10) : 0
        };
        const voiceParams = this.getEffectiveVoiceParams(slot);
        const speed = this.getEffectivePlaybackSpeed(slot);

        if (slot && slot.audioBlob) {
            try {
                const arr = await slot.audioBlob.arrayBuffer();
                const originalBuffer = await ctx.decodeAudioData(arr.slice(0));
                const processed = VoiceEngine.processFull(originalBuffer, ctx, voiceParams, envParams, speed);

                const src = ctx.createBufferSource();
                src.buffer = processed;
                src.playbackRate.value = speed;
                src.connect(ctx.destination);
                src.start(0);
                this.fxPreviewSource = src;
                this.showToast('▶️ 設定した環境エフェクトで試聴中...');
                src.onended = () => { this.fxPreviewSource = null; };
            } catch (err) {
                console.error('Preview error:', err);
            }
        } else {
            this.playTestVoicePreview(ctx, voiceParams, envParams, speed);
        }
    }

    playTestVoicePreview(ctx, voiceParams, envParams, speed = 1.0) {
        const dur = 0.85;
        const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
        const data = buffer.getChannelData(0);
        const freq = 340;
        for (let i = 0; i < data.length; i++) {
            const t = i / ctx.sampleRate;
            const env = Math.sin((t / dur) * Math.PI);
            const harm = Math.sin(2 * Math.PI * freq * t) + 0.5 * Math.sin(4 * Math.PI * freq * t) + 0.25 * Math.sin(6 * Math.PI * freq * t);
            data[i] = harm * env * 0.35;
        }
        const processed = VoiceEngine.processFull(buffer, ctx, voiceParams, envParams, speed);
        const src = ctx.createBufferSource();
        src.buffer = processed;
        src.playbackRate.value = speed;
        src.connect(ctx.destination);
        src.start(0);
        this.fxPreviewSource = src;
        this.showToast('▶️ サンプル音でエフェクトを試聴中...');
        src.onended = () => { this.fxPreviewSource = null; };
    }

    // ==================== 🤖 AI音声合成 (TTS) エンジン ====================
    initTTS() {
        if ('speechSynthesis' in window) {
            this.populateTtsVoices();
            window.speechSynthesis.onvoiceschanged = () => {
                this.populateTtsVoices();
            };
        }

        const ttsInput = document.getElementById('tts-input-text');
        if (ttsInput) {
            ttsInput.addEventListener('input', () => {
                this.adjustTtsTextarea(ttsInput);
            });
        }

        const rateSlider = document.getElementById('tts-rate-slider');
        if (rateSlider) {
            rateSlider.addEventListener('input', (e) => {
                const valEl = document.getElementById('tts-rate-val');
                if (valEl) valEl.innerText = `${parseFloat(e.target.value).toFixed(2)}x`;
                this.clearTtsPresetActiveState();
            });
        }

        const pitchSlider = document.getElementById('tts-pitch-slider');
        if (pitchSlider) {
            pitchSlider.addEventListener('input', (e) => {
                const valEl = document.getElementById('tts-pitch-val');
                if (valEl) valEl.innerText = `${parseFloat(e.target.value).toFixed(2)}`;
                this.clearTtsPresetActiveState();
            });
        }

        // 🎭 声のキャラクター・クイックプリセットボタン
        document.querySelectorAll('#tts-preset-chips .fx-chip-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const presetKey = btn.getAttribute('data-tts-preset');
                if (presetKey) {
                    this.applyTtsPreset(presetKey);
                }
            });
        });

        // イントネーション・ポーズ補助ツール
        document.querySelectorAll('.tts-pause-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const pauseType = btn.getAttribute('data-pause');
                const ttsTextarea = document.getElementById('tts-input-text');
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

        document.getElementById('btn-tts-preview')?.addEventListener('click', () => this.previewTts());
        document.getElementById('btn-tts-apply')?.addEventListener('click', () => this.applyTtsToSlot());
    }

    adjustTtsTextarea(textarea) {
        if (!textarea) return;
        textarea.style.height = 'auto';
        const newHeight = Math.max(64, Math.min(220, textarea.scrollHeight));
        textarea.style.height = `${newHeight}px`;
    }

    clearTtsPresetActiveState() {
        document.querySelectorAll('#tts-preset-chips .fx-chip-btn').forEach(btn => {
            btn.classList.remove('active');
        });
    }

    applyTtsPreset(presetKey) {
        const presets = {
            girl: { label: '👧 女の子', rate: 1.05, pitch: 1.40, formant: 1.25, roughness: 0, gender: 'female', semitones: 3 },
            boy: { label: '👦 男の子', rate: 1.05, pitch: 1.25, formant: 1.15, roughness: 0, gender: 'child', semitones: 2 },
            woman: { label: '👩 おとな女', rate: 1.00, pitch: 1.00, formant: 1.00, roughness: 0, gender: 'female', semitones: 0 },
            man: { label: '👨 おとな男', rate: 0.95, pitch: 0.65, formant: 0.85, roughness: 10, gender: 'male', semitones: -2 }
        };

        const config = presets[presetKey];
        if (!config) return;

        // アクティブ表示の切り替え
        document.querySelectorAll('#tts-preset-chips .fx-chip-btn').forEach(btn => {
            if (btn.getAttribute('data-tts-preset') === presetKey) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });

        // 話速・音程スライダーへの反映
        const rateSlider = document.getElementById('tts-rate-slider');
        const rateVal = document.getElementById('tts-rate-val');
        if (rateSlider) {
            rateSlider.value = config.rate;
            if (rateVal) rateVal.innerText = `${config.rate.toFixed(2)}x`;
        }

        const pitchSlider = document.getElementById('tts-pitch-slider');
        const pitchVal = document.getElementById('tts-pitch-val');
        if (pitchSlider) {
            pitchSlider.value = config.pitch;
            if (pitchVal) pitchVal.innerText = `${config.pitch.toFixed(2)}`;
        }

        // システム音声（OS音声）の自動セレクション（該当する性別の音声があれば切り替え）
        const select = document.getElementById('tts-voice-select');
        if (select && this.ttsVoices && this.ttsVoices.length > 0) {
            const jaVoices = this.ttsVoices.filter(v => v.lang.startsWith('ja'));
            if (jaVoices.length > 0) {
                let matchedVoice = null;
                if (config.gender === 'male') {
                    matchedVoice = jaVoices.find(v => /otoya|ichiro|keita|takumi|kenji|daichi|male/i.test(v.name));
                } else if (config.gender === 'female') {
                    matchedVoice = jaVoices.find(v => /kyoko|ayumi|nanami|haruka|sayaka|mizuki|female/i.test(v.name));
                }
                if (matchedVoice) {
                    select.value = matchedVoice.name;
                } else {
                    // 男声指定で男性専用音声が無い場合でも、標準日本語音声（Kyoko等）を選択（ピッチ0.65で男声化）
                    const defaultJa = jaVoices[0];
                    if (defaultJa) select.value = defaultJa.name;
                }
            }
        }

        // スロットモーダルの声質・環境スライダーも連動更新（より自然で迫力ある声質へ）
        const formantSlider = document.getElementById('slot-formant-slider');
        const formantVal = document.getElementById('slot-formant-val');
        if (formantSlider) {
            formantSlider.value = config.formant;
            if (formantVal) formantVal.innerText = `${config.formant.toFixed(2)}x`;
        }

        const pitchSemiSlider = document.getElementById('slot-pitch-slider');
        const pitchSemiVal = document.getElementById('slot-pitch-val');
        if (pitchSemiSlider) {
            pitchSemiSlider.value = config.semitones || 0;
            if (pitchSemiVal) pitchSemiVal.innerText = `${config.semitones > 0 ? '+' : ''}${config.semitones}半音`;
        }

        const modSlider = document.getElementById('slot-mod-slider');
        const modVal = document.getElementById('slot-mod-val');
        if (modSlider) {
            const modValNum = config.mod || 0;
            modSlider.value = modValNum;
            if (modVal) modVal.innerText = `${modValNum}%`;
        }

        this.showToast(`🎭 声質を「${config.label}」に設定しました`);
    }

    populateTtsVoices() {
        if (!('speechSynthesis' in window)) return;
        const select = document.getElementById('tts-voice-select');
        if (!select) return;

        this.ttsVoices = window.speechSynthesis.getVoices();
        const currentVal = select.value;
        select.innerHTML = '';

        if (this.ttsVoices.length === 0) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.innerText = '標準の日本語音声 (Kyoko / システムデフォルト)';
            select.appendChild(opt);
            return;
        }

        const jaVoices = this.ttsVoices.filter(v => v.lang.startsWith('ja'));

        const formatVoiceLabel = (v) => {
            const name = v.name;
            let icon = '🎙️';
            let label = name;

            if (/kyoko|nanami|ayumi|haruka|sayaka|mizuki|female/i.test(name)) {
                icon = '👩';
                label = `${icon} ${name} (女性 / 日本語)`;
            } else if (/otoya|ichiro|keita|takumi|kenji|daichi|male/i.test(name)) {
                icon = '👨';
                label = `${icon} ${name} (男性 / 日本語)`;
            } else if (v.lang.startsWith('ja')) {
                icon = '🇯🇵';
                label = `${icon} ${name} (日本語)`;
            }
            return label;
        };

        if (jaVoices.length > 0) {
            jaVoices.forEach(v => {
                const opt = document.createElement('option');
                opt.value = v.name;
                opt.innerText = formatVoiceLabel(v);
                select.appendChild(opt);
            });
        } else {
            // 日本語音声が明示的に見つからない場合のフォールバック（第1音声）
            const opt = document.createElement('option');
            opt.value = this.ttsVoices[0].name;
            opt.innerText = `🇯🇵 ${this.ttsVoices[0].name} (デフォルト日本語)`;
            select.appendChild(opt);
        }

        // 以前の選択値があれば復元、無ければ日本語音声を最優先
        if (currentVal && jaVoices.some(v => v.name === currentVal)) {
            select.value = currentVal;
        } else if (jaVoices.length > 0) {
            select.value = jaVoices[0].name;
        }
    }

    previewTts() {
        const text = document.getElementById('tts-input-text')?.value.trim();
        if (!text) {
            this.showToast('⚠️ 読み上げるテキストを入力してください');
            return;
        }

        if (!('speechSynthesis' in window)) {
            alert('お使いのブラウザは音声合成に対応していません。');
            return;
        }

        window.speechSynthesis.cancel();

        const utter = new SpeechSynthesisUtterance(text);
        
        const allVoices = window.speechSynthesis.getVoices();
        if (allVoices.length > 0) this.ttsVoices = allVoices;

        const hasJapanese = /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uff9f\u4e00-\u9faf]/.test(text);
        const voiceName = document.getElementById('tts-voice-select')?.value;
        let selectedVoice = null;
        if (voiceName) {
            selectedVoice = this.ttsVoices.find(v => v.name === voiceName || v.voiceURI === voiceName);
        }

        // 日本語テキストなのに非日本語音声が選ばれている場合は、安全な日本語音声にフォールバック（音が出ないエラー防止）
        if (hasJapanese && selectedVoice && !selectedVoice.lang.startsWith('ja')) {
            const jaVoice = this.ttsVoices.find(v => v.lang.startsWith('ja'));
            if (jaVoice) {
                selectedVoice = jaVoice;
            }
        }

        if (!selectedVoice) {
            selectedVoice = this.ttsVoices.find(v => v.lang.startsWith('ja')) || this.ttsVoices[0];
        }

        if (selectedVoice) {
            utter.voice = selectedVoice;
            utter.lang = (hasJapanese && !selectedVoice.lang.startsWith('ja')) ? 'ja-JP' : (selectedVoice.lang || 'ja-JP');
        } else {
            utter.lang = 'ja-JP';
        }

        const rate = parseFloat(document.getElementById('tts-rate-slider')?.value || '1.0');
        const pitch = parseFloat(document.getElementById('tts-pitch-slider')?.value || '1.0');

        // スロットモーダルの声質・環境パラメータも重ねがけ反映
        const { voiceParams, envParams } = this.getFxParamsFromUI('slot');
        const semitones = voiceParams.pitchSemitones || 0;
        const formant = voiceParams.formantRatio || 1.0;
        const pitchFactor = Math.pow(2, semitones / 12) * Math.sqrt(formant);

        utter.rate = Math.max(0.1, Math.min(3.0, rate));
        utter.pitch = Math.max(0.1, Math.min(2.0, pitch * pitchFactor));

        // 空間・環境エフェクトの重畳
        VoiceEngine.playAcousticFilterOverlay(envParams);

        setTimeout(() => {
            if (window.speechSynthesis.paused) {
                window.speechSynthesis.resume();
            }
            window.speechSynthesis.speak(utter);
        }, 50);

        this.showToast(`🗣️ 「${text.slice(0, 20)}」を試聴中...`);
    }

    async applyTtsToSlot() {
        if (!this.editingSlotId) return;
        const slot = this.slots.find(s => s.id === this.editingSlotId);
        if (!slot) return;

        const text = document.getElementById('tts-input-text')?.value.trim();
        if (!text) {
            this.showToast('⚠️ 読み上げるテキストを入力してください');
            return;
        }

        const voiceName = document.getElementById('tts-voice-select')?.value || '';
        const rate = parseFloat(document.getElementById('tts-rate-slider')?.value || '1.0');
        const pitch = parseFloat(document.getElementById('tts-pitch-slider')?.value || '1.0');

        slot.ttsText = text;
        slot.ttsVoice = voiceName;
        slot.ttsRate = rate;
        slot.ttsPitch = pitch;
        slot.audioBlob = null;
        slot.duration = Math.max(1.0, (text.length * 0.25) / rate);

        // ボタンのラベルが空または初期値ならテキストを反映
        const labelInput = document.getElementById('edit-label');
        if (labelInput && (!labelInput.value || labelInput.value.startsWith('ボタン'))) {
            labelInput.value = text.slice(0, 14);
            slot.label = text.slice(0, 14);
        }

        // 現在設定されている声質・環境エフェクトも反映
        const modeSelect = document.getElementById('edit-slot-effect-mode');
        slot.voiceEffectMode = modeSelect ? modeSelect.value : 'inherit';
        if (slot.voiceEffectMode === 'custom') {
            const { voiceParams, envParams } = this.getFxParamsFromUI('slot');
            slot.voiceParams = voiceParams;
            slot.envParams = envParams;
            slot.voiceEffect = 'custom';
        }

        await this.storage.saveSlot(slot);
        this.renderSlots();

        const deleteAudioBtn = document.getElementById('delete-audio-btn');
        const downloadAudioBtn = document.getElementById('download-audio-btn');
        if (deleteAudioBtn) deleteAudioBtn.style.display = 'block';
        if (downloadAudioBtn) downloadAudioBtn.style.display = 'none';

        this.previewTts();
        this.showToast(`✨ 声質＆環境エフェクトを重ねて「${slot.label}」に登録しました！`);
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
            this.waveformAudioBuffer = await ctx.decodeAudioData(arr.slice(0));
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

        if (data.type === 'voicepad_slot' || data.slot) {
            const s = data.slot || data;
            if (titleEl) titleEl.innerText = `📲 ボタン「${s.label || 'ボタン'}」を受信`;
            if (targetGroup) targetGroup.style.display = 'block';
            if (addCurrentBtn) addCurrentBtn.style.display = 'block';

            const photoHtml = s.imageUrl
                ? `<img src="${s.imageUrl}" alt="photo">`
                : (s.emoji || '🔊');

            const hasAudio = !!s.audioBase64;
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
                this.previewIncomingAudio(s.audioBase64);
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

    previewIncomingAudio(base64Str) {
        if (!base64Str) return;
        this.stopIncomingAudioPreview();

        try {
            const blob = this.base64ToBlob(base64Str);
            const url = URL.createObjectURL(blob);
            const audio = new Audio(url);
            audio.play();
            this.incomingAudioPreviewNode = audio;
            audio.onended = () => {
                URL.revokeObjectURL(url);
                this.incomingAudioPreviewNode = null;
            };
        } catch (e) {
            console.warn('Incoming audio preview error:', e);
        }
    }

    stopIncomingAudioPreview() {
        if (this.incomingAudioPreviewNode) {
            this.incomingAudioPreviewNode.pause();
            this.incomingAudioPreviewNode = null;
        }
    }

    async applyIncomingToSelectedScroll() {
        if (!this.incomingData) return;
        const targetScrollId = document.getElementById('incoming-target-scroll')?.value || this.currentScrollId;
        const s = this.incomingData.slot || this.incomingData;

        const blob = this.base64ToBlob(s.audioBase64);
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
            playbackSpeed: s.playbackSpeed || 'inherit',
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
                playbackSpeed: this.incomingData.scroll?.playbackSpeed || 'inherit',
                order: this.scrolls.length,
                createdAt: Date.now()
            };
            await this.storage.saveScroll(newScroll);
            this.scrolls.push(newScroll);

            if (Array.isArray(this.incomingData.slots)) {
                for (const s of this.incomingData.slots) {
                    const blob = this.base64ToBlob(s.audioBase64);
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
            playbackSpeed: 'inherit',
            createdAt: Date.now()
        };
        await this.storage.saveScroll(newScroll);
        this.scrolls.push(newScroll);

        const blob = this.base64ToBlob(s.audioBase64);
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
            playbackSpeed: s.playbackSpeed || 'inherit',
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
window.addEventListener('DOMContentLoaded', () => {
    window.app = new VoicePadApp();
});
