import sys
import json
import time
import subprocess
import urllib.request
import websocket

sys.stdout.reconfigure(encoding='utf-8')

def run_browser_verification():
    edge_path = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
    proc = subprocess.Popen([
        edge_path,
        "--headless=new",
        "--remote-debugging-port=9225",
        "--remote-allow-origins=*",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "http://127.0.0.1:8080/index.html"
    ])

    time.sleep(3)

    try:
        with urllib.request.urlopen("http://localhost:9225/json") as res:
            tabs = json.loads(res.read().decode('utf-8'))
        target_tab = next((t for t in tabs if "8080" in t.get("url", "")), tabs[0])
        ws_url = target_tab["webSocketDebuggerUrl"]

        ws = websocket.create_connection(ws_url, timeout=10)

        test_script = """
        (async () => {
            try {
                const results = {};

                // Test 1: Check if TtsEngine is loaded and textToKana works
                const kanaResult = TtsEngine.textToKana("こんにちは、怪獣です！1 2 3 OK");
                results.kana = kanaResult;

                // Test 2: Synthesize AudioBuffer via TtsEngine
                const ctx = new (window.AudioContext || window.webkitAudioContext)();
                const rawBuffer = TtsEngine.synthesizeToBuffer("こんにちは、怪獣です！1 2 3", ctx, "girl", 1.0, 1.0);
                results.rawBuffer = {
                    duration: rawBuffer.duration,
                    length: rawBuffer.length,
                    sampleRate: rawBuffer.sampleRate
                };

                // Test 3: Process synthesized buffer through Voicemod Monster preset
                const monsterPreset = VoiceEngine.getVoicemodPresets().find(p => p.id === 'monster_titan');
                const processedMonster = VoiceEngine.processFull(
                    rawBuffer, ctx,
                    monsterPreset.voice,
                    monsterPreset.env,
                    1.0,
                    monsterPreset.eq,
                    monsterPreset.special
                );
                results.monsterProcessed = {
                    duration: processedMonster.duration,
                    length: processedMonster.length
                };

                // Test 4: Process synthesized buffer through Voicemod Walkie-Talkie preset
                const radioPreset = VoiceEngine.getVoicemodPresets().find(p => p.id === 'walkie_talkie');
                const processedRadio = VoiceEngine.processFull(
                    rawBuffer, ctx,
                    radioPreset.voice,
                    radioPreset.env,
                    1.0,
                    radioPreset.eq,
                    radioPreset.special
                );
                results.radioProcessed = {
                    duration: processedRadio.duration,
                    length: processedRadio.length
                };

                // Test 5: Convert AudioBuffer to WAV Blob
                const wavBlob = AudioUtils.audioBufferToWav(rawBuffer);
                results.wavBlob = {
                    type: wavBlob.type,
                    size: wavBlob.size
                };

                // Test 6: Check App instance and modal UI
                results.appLoaded = !!window.app;
                results.appVersion = APP_VERSION;

                return results;
            } catch (e) {
                return { error: e.message, stack: e.stack };
            }
        })()
        """

        req = {"id": 1, "method": "Runtime.evaluate", "params": {"expression": test_script, "awaitPromise": True, "returnByValue": True}}
        ws.send(json.dumps(req))
        resp = json.loads(ws.recv())
        val = resp.get("result", {}).get("result", {}).get("value", {})
        print("🎯 In-Browser DSP & TTS Test Results:")
        print(json.dumps(val, indent=2, ensure_ascii=False))

        assert val.get("appVersion") == "2026.09.17.0008", "Version mismatch"
        assert val.get("rawBuffer", {}).get("duration", 0) > 1.0, "TTS synthesis failed"
        assert val.get("monsterProcessed", {}).get("duration", 0) > 1.0, "Monster DSP failed"
        assert val.get("radioProcessed", {}).get("duration", 0) > 1.0, "Radio DSP failed"
        assert val.get("wavBlob", {}).get("size", 0) > 1000, "WAV encoding failed"

        print("🎉 All in-browser TTS & DSP tests PASSED with 100% success!")

        ws.close()
    finally:
        proc.terminate()

if __name__ == "__main__":
    run_browser_verification()
