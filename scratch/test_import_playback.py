import json
import time
import subprocess
import urllib.request
import websocket
import sys

sys.stdout.reconfigure(encoding='utf-8')

def run_test():
    edge_path = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
    edge_proc = subprocess.Popen([
        edge_path,
        "--headless=new",
        "--remote-debugging-port=9222",
        "--remote-allow-origins=*",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--autoplay-policy=no-user-gesture-required",
        "http://127.0.0.1:8080/index.html"
    ])
    
    try:
        time.sleep(2)
        with urllib.request.urlopen("http://127.0.0.1:9222/json") as res:
            tabs = json.loads(res.read().decode('utf-8'))
        
        page_tab = next((t for t in tabs if t.get('type') == 'page'), tabs[0])
        ws_url = page_tab["webSocketDebuggerUrl"]
        print(f"[OK] Connected to Edge CDP: {ws_url}")
        
        ws = websocket.create_connection(ws_url)
        
        msg_counter = 1
        def send_cmd(method, params=None):
            nonlocal msg_counter
            mid = msg_counter
            msg_counter += 1
            req = {"id": mid, "method": method, "params": params or {}}
            ws.send(json.dumps(req))
            while True:
                resp = json.loads(ws.recv())
                if resp.get("id") == mid:
                    return resp
        
        send_cmd("Runtime.enable")
        send_cmd("Page.enable")
        
        # Wait for page ready
        print("Waiting for page load and window.voicePadApp...", flush=True)
        for i in range(30):
            time.sleep(0.5)
            chk = send_cmd("Runtime.evaluate", {
                "expression": "document.readyState === 'complete' && typeof window.voicePadApp !== 'undefined' && typeof AudioUnlocker !== 'undefined'",
                "returnByValue": True
            })
            val = chk.get("result", {}).get("result", {}).get("value")
            if val:
                print(f"[OK] Page and voicePadApp ready after {i*0.5:.1f}s")
                break

        test_script = """
        (async () => {
            const results = {
                appVersion: APP_VERSION,
                tests: []
            };

            const app = window.voicePadApp;
            if (!app) {
                results.tests.push({ name: 'app_exists', pass: false, error: 'window.voicePadApp not found' });
                return results;
            }

            // Test 1: Generate small 16-bit PCM WAV in memory
            const ctx = AudioUnlocker.getContext();
            await AudioUnlocker.unlock();

            const sampleRate = 44100;
            const duration = 0.5;
            const numSamples = Math.floor(sampleRate * duration);
            const audioBuffer = ctx.createBuffer(1, numSamples, sampleRate);
            const channel = audioBuffer.getChannelData(0);
            for (let i = 0; i < numSamples; i++) {
                channel[i] = Math.sin(2 * Math.PI * 440 * i / sampleRate) * 0.5;
            }

            const wavBlob = AudioUtils.audioBufferToWav(audioBuffer);
            results.tests.push({
                name: 'wav_generation',
                pass: (wavBlob instanceof Blob) && wavBlob.size > 100,
                size: wavBlob ? wavBlob.size : 0
            });

            // Test 2: AudioUtils.decodeWavDirect
            const wavArrayBuffer = await wavBlob.arrayBuffer();
            const directDecoded = AudioUtils.decodeWavDirect(ctx, wavArrayBuffer);
            results.tests.push({
                name: 'decodeWavDirect',
                pass: !!(directDecoded && directDecoded.length === numSamples && directDecoded.sampleRate === sampleRate),
                decodedLength: directDecoded ? directDecoded.length : 0
            });

            // Test 3: AudioUtils.decodeAudioDataSafe
            const safeDecoded = await AudioUtils.decodeAudioDataSafe(ctx, wavArrayBuffer);
            results.tests.push({
                name: 'decodeAudioDataSafe',
                pass: !!(safeDecoded && safeDecoded.length === numSamples),
                decodedLength: safeDecoded ? safeDecoded.length : 0
            });

            // Test 4: base64ToBlob with data-URI, raw base64, and base64 with newlines
            const b64DataUri = await app.blobToBase64(wavBlob);
            const blobFromDataUri = app.base64ToBlob(b64DataUri);
            
            const rawB64 = b64DataUri.split(',')[1];
            const blobFromRaw = app.base64ToBlob(rawB64);

            const b64WithNewlines = rawB64.slice(0, 50) + "\\r\\n\\t " + rawB64.slice(50);
            const blobFromNewlines = app.base64ToBlob(b64WithNewlines);

            results.tests.push({
                name: 'base64ToBlob_dataUri',
                pass: (blobFromDataUri instanceof Blob) && blobFromDataUri.size === wavBlob.size,
                size: blobFromDataUri ? blobFromDataUri.size : 0
            });

            results.tests.push({
                name: 'base64ToBlob_raw',
                pass: (blobFromRaw instanceof Blob) && blobFromRaw.size === wavBlob.size,
                size: blobFromRaw ? blobFromRaw.size : 0
            });

            results.tests.push({
                name: 'base64ToBlob_newlines',
                pass: (blobFromNewlines instanceof Blob) && blobFromNewlines.size === wavBlob.size,
                size: blobFromNewlines ? blobFromNewlines.size : 0
            });

            // Test 5: Global import single button (.vpad-button payload)
            const buttonPayload = {
                type: 'voicepad_slot',
                version: '2.4',
                exportedAt: new Date().toISOString(),
                slot: {
                    label: 'テストインポートボタン',
                    emoji: '🚀',
                    duration: 0.5,
                    audioBase64: b64DataUri,
                    voiceEffect: 'radio',
                    playbackSpeed: 1.2
                }
            };

            const jsonFile = new File([JSON.stringify(buttonPayload)], 'TestButton.vpad-button', { type: 'application/json' });
            await app.handleGlobalImport(jsonFile);

            const importedSlot = app.slots.find(s => s.label === 'テストインポートボタン');
            results.tests.push({
                name: 'handleGlobalImport_single_slot',
                pass: !!(importedSlot && importedSlot.audioBlob instanceof Blob && importedSlot.audioBlob.size > 0),
                slotLabel: importedSlot ? importedSlot.label : null,
                hasBlob: !!(importedSlot && importedSlot.audioBlob)
            });

            // Test 6: Playback of the imported slot
            if (importedSlot) {
                let playbackStarted = false;
                try {
                    await app.playSlot(importedSlot.id);
                    playbackStarted = app.activeSources.has(importedSlot.id);
                } catch(e) {
                    playbackStarted = false;
                }
                results.tests.push({
                    name: 'importedSlot_playSlot',
                    pass: playbackStarted,
                    isActiveSource: playbackStarted
                });

                // Stop playback
                app.stopSlot(importedSlot.id);
            }

            // Test 7: Auto-repair when slot.audioBlob is missing but audioBase64 exists
            const repairSlot = {
                id: 'slot_test_repair_' + Date.now(),
                scrollId: app.currentScrollId,
                label: '修復テストボタン',
                emoji: '🛠️',
                duration: 0.5,
                audioBlob: null,
                audioBase64: b64DataUri,
                order: 999
            };
            app.slots.push(repairSlot);
            await app.playSlot(repairSlot.id);
            const repairPass = app.activeSources.has(repairSlot.id) && (repairSlot.audioBlob instanceof Blob);
            app.stopSlot(repairSlot.id);
            results.tests.push({
                name: 'playSlot_auto_repair',
                pass: repairPass,
                repairedBlob: !!(repairSlot.audioBlob)
            });

            return results;
        })()
        """

        eval_res = send_cmd("Runtime.evaluate", {
            "expression": test_script,
            "awaitPromise": True,
            "returnByValue": True
        })

        val = eval_res.get("result", {}).get("result", {}).get("value", {})
        print("=== TEST EXECUTION RESULTS ===")
        print(json.dumps(val, indent=2, ensure_ascii=False))

        all_passed = True
        for t in val.get("tests", []):
            if not t.get("pass"):
                all_passed = False
                print(f"FAILED: {t['name']}")
            else:
                print(f"PASSED: {t['name']}")

        assert all_passed, "Some tests failed!"
        print("\n🎉 ALL TESTS PASSED SUCCESSFULLY!")

    finally:
        edge_proc.kill()

if __name__ == '__main__':
    run_test()
