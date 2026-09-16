import sys
import json
import time
import subprocess
import urllib.request
import websocket

sys.stdout.reconfigure(encoding='utf-8')

edge_path = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
proc = subprocess.Popen([
    edge_path,
    "--headless=new",
    "--remote-debugging-port=9222",
    "--remote-allow-origins=*",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "http://127.0.0.1:8080/index.html"
])

time.sleep(3)

try:
    with urllib.request.urlopen("http://localhost:9222/json") as res:
        tabs = json.loads(res.read().decode('utf-8'))
    target_tab = next((t for t in tabs if "8080" in t.get("url", "")), tabs[0])
    ws_url = target_tab["webSocketDebuggerUrl"]

    ws = websocket.create_connection(ws_url, timeout=5)

    test_js = """
    (() => {
        // Implementation of TtsEngine
        class TestTtsEngine {
            static textToKana(rawText) {
                if (!rawText) return '';
                let text = String(rawText);
                
                // 1. Common Japanese Kanji & Word replacements
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
                    ['お父さん', 'おとうさん'], ['お母さん', 'おかあさん'],
                    ['音声', 'おんせい'], ['録音', 'ろくおん'], ['再生', 'さいせい'],
                    ['怪獣', 'かいじゅう'], ['大聖堂', 'だいせいどう'], ['洞窟', 'どうくつ'],
                    ['宇宙人', 'うちゅうじん'], ['ロボット', 'ろぼっと'], ['電話', 'でんわ'],
                    ['行くよ', 'いくよ'], ['いくよ', 'いくよ'], ['止まる', 'とまる'], ['とまる', 'とまる'],
                    ['見て', 'みて'], ['聞いて', 'きいて'], ['嬉しい', 'うれしい'], ['楽しい', 'たのしい'],
                    ['悲しい', 'かなしい'], ['面白い', 'おもしろい'], ['好き', 'すき'], ['嫌い', 'きらい'],
                    ['疲れた', 'つかれた'], ['眠い', 'ねむい'], ['暑い', 'あつい'], ['寒い', 'さむい'],
                    ['学校', 'がっこう'], ['家', 'いえ'], ['車', 'くるま'], ['電車', 'でんしゃ'],
                    ['時間', 'じかん'], ['今', 'いま'], ['何', 'なに'], ['誰', 'だれ'], ['どこ', 'どこ']
                ];
                
                for (const [k, v] of words) {
                    text = text.split(k).join(v);
                }
                
                // Numbers
                const numMap = {
                    '0': 'ぜろ', '1': 'いち', '2': 'に', '3': 'さん', '4': 'よん',
                    '5': 'ご', '6': 'ろく', '7': 'なな', '8': 'はち', '9': 'きゅう',
                    '１': 'いち', '２': 'に', '３': 'さん', '４': 'よん', '５': 'ご',
                    '６': 'ろく', '７': 'なな', '８': 'はち', '９': 'きゅう', '０': 'ぜろ'
                };
                text = text.replace(/[0-9０-９]/g, m => numMap[m] || m);
                
                // English / Romaji to Kana
                const romajiMap = {
                    'ok': 'おーけー', 'ai': 'えーあい', 'sos': 'えすおーえす',
                    'voice': 'ぼいす', 'pad': 'ぱっど', 'yes': 'いえす', 'no': 'のー',
                    'hello': 'はろー', 'bye': 'ばいばい', 'good': 'ぐっど'
                };
                text = text.replace(/\\b[a-zA-Z]+\\b/g, m => romajiMap[m.toLowerCase()] || m);
                
                // Katakana to Hiragana
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
                    
                    if (c1 === '、' || c1 === '，' || c1 === ',' || c1 === ' ') {
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
                        // Fallback vowel
                        morae.push({ v: 'a', char: c1, duration: 0.13 });
                        i++;
                    }
                }
                return morae;
            }

            static synthesizeToBuffer(text, ctx, voiceType = 'girl', rate = 1.0, pitchMod = 1.0) {
                const sampleRate = ctx ? ctx.sampleRate : 44100;
                const kana = this.textToKana(text);
                const morae = this.parseMorae(kana);
                
                if (morae.length === 0) {
                    return ctx.createBuffer(1, Math.floor(sampleRate * 0.1), sampleRate);
                }

                // Voice characteristics
                let basePitch = 240; // Hz
                let formantScale = 1.15;
                if (voiceType === 'boy') { basePitch = 220; formantScale = 1.10; }
                else if (voiceType === 'woman') { basePitch = 200; formantScale = 1.0; }
                else if (voiceType === 'man') { basePitch = 125; formantScale = 0.85; }
                
                basePitch *= pitchMod;
                const durScale = 1.0 / Math.max(0.5, Math.min(2.5, rate));

                // Calculate total samples
                let totalDur = 0.06; // initial silence
                morae.forEach(m => {
                    m.scaledDur = (m.duration || 0.14) * durScale;
                    totalDur += m.scaledDur;
                });
                totalDur += 0.08; // tail silence

                const totalSamples = Math.floor(sampleRate * totalDur);
                const buffer = ctx.createBuffer(1, totalSamples, sampleRate);
                const out = buffer.getChannelData(0);

                // Formants table: [F1, F2, F3, F4]
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

                    // Consonant burst duration
                    const consDur = mora.c ? Math.min(moraSamples * 0.45, sampleRate * 0.055) : 0;
                    
                    // Pitch intonation
                    let pitchFactor = 1.0;
                    if (mIdx === 0 && morae.length > 1) pitchFactor = 0.94; // initial rise
                    else if (mIdx === 1) pitchFactor = 1.05; // peak accent
                    else pitchFactor = 1.0 - (mIdx / morae.length) * 0.12; // declination

                    const moraF0 = basePitch * pitchFactor;

                    for (let s = 0; s < moraSamples; s++) {
                        const targetIdx = currentSample + s;
                        if (targetIdx >= totalSamples) break;

                        const tMora = s / moraSamples;
                        // Glottal source pulse train
                        phase += moraF0 / sampleRate;
                        if (phase >= 1.0) phase -= 1.0;

                        // Rosenberg pulse excitation
                        let glottal = 0;
                        if (phase < 0.4) {
                            glottal = Math.sin(Math.PI * phase / 0.4);
                        } else if (phase < 0.6) {
                            glottal = Math.cos(Math.PI * (phase - 0.4) / 0.4);
                        } else {
                            glottal = 0;
                        }

                        // Formant resonance sum
                        const tSec = targetIdx / sampleRate;
                        const vRes = Math.sin(2 * Math.PI * f1 * tSec) * 0.45
                                   + Math.sin(2 * Math.PI * f2 * tSec) * 0.28
                                   + Math.sin(2 * Math.PI * f3 * tSec) * 0.16
                                   + Math.sin(2 * Math.PI * f4 * tSec) * 0.08;

                        let val = glottal * vRes;

                        // Consonant noise overlay
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

                        // Mora envelope
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

        // Test running
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const text = 'こんにちは、怪獣です！1 2 3';
        const rawBuffer = TestTtsEngine.synthesizeToBuffer(text, ctx, 'girl', 1.0, 1.0);
        
        // Apply full VoiceEngine pipeline
        const voiceParams = { pitchSemitones: -4, formantRatio: 0.7, roughness: 20 };
        const envParams = { reverb: 40, filter: 10, modulation: 0 };
        const eqParams = { bass: 5, mid: 2, treble: 3 };
        const specialParams = { chorus: 50, radioNoise: 0, trash: 0 };
        
        const finalBuffer = VoiceEngine.processFull(rawBuffer, ctx, voiceParams, envParams, 1.0, eqParams, specialParams);

        return {
            text: text,
            rawLen: rawBuffer.length,
            rawDuration: rawBuffer.duration,
            finalLen: finalBuffer.length,
            finalDuration: finalBuffer.duration,
            sampleRate: finalBuffer.sampleRate
        };
    })()
    """

    req = {"id": 1, "method": "Runtime.evaluate", "params": {"expression": test_js, "returnByValue": True}}
    ws.send(json.dumps(req))
    resp = json.loads(ws.recv())
    print("Full TTS Synthesis Test Result:", json.dumps(resp.get("result", {}).get("result", {}).get("value", resp), indent=2, ensure_ascii=False))

    ws.close()
finally:
    proc.terminate()
