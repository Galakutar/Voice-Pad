import json
import time
import subprocess
import urllib.request
import websocket
import sys

sys.stdout.reconfigure(encoding='utf-8')

def run_suite():
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
        
        print("Waiting for page load and window.voicePadApp...", flush=True)
        for i in range(30):
            time.sleep(0.5)
            chk = send_cmd("Runtime.evaluate", {
                "expression": "document.readyState === 'complete' && typeof window.voicePadApp !== 'undefined'",
                "returnByValue": True
            })
            val = chk.get("result", {}).get("result", {}).get("value")
            if val:
                print(f"[OK] Ready after {i*0.5:.1f}s")
                break

        test_script = """
        (async () => {
            const results = {
                appVersion: APP_VERSION,
                tests: []
            };

            const app = window.voicePadApp;
            const ctx = AudioUnlocker.getContext();
            await AudioUnlocker.unlock();

            // Create reference sine wave PCM WAV
            const sampleRate = 44100;
            const numSamples = Math.floor(sampleRate * 0.4);
            const audioBuffer = ctx.createBuffer(1, numSamples, sampleRate);
            const channel = audioBuffer.getChannelData(0);
            for (let i = 0; i < numSamples; i++) {
                channel[i] = Math.sin(2 * Math.PI * 523.25 * i / sampleRate) * 0.6; // C5 tone
            }
            const wavBlob = AudioUtils.audioBufferToWav(audioBuffer);
            const wavB64 = await app.blobToBase64(wavBlob);

            // Test Suite 1: Single Slot Export & Import Roundtrip
            const slotToExport = app.slots[0];
            slotToExport.audioBlob = wavBlob;
            slotToExport.label = '往復テスト1';
            slotToExport.eqParams = { bass: 3, mid: -2, treble: 4 };
            slotToExport.voiceParams = { pitchSemitones: 2, formantRatio: 1.1 };
            await app.storage.saveSlot(slotToExport);

            // Mock shareOrDownloadFile to capture payload
            let capturedDownload = null;
            const origShare = app.shareOrDownloadFile;
            app.shareOrDownloadFile = (fileName, jsonString, cat) => {
                capturedDownload = { fileName, data: JSON.parse(jsonString), cat };
            };

            await app.exportSingleSlot(slotToExport.id);
            results.tests.push({
                name: 'exportSingleSlot_captured',
                pass: !!(capturedDownload && capturedDownload.data && capturedDownload.data.slot.audioBase64),
                hasB64: !!(capturedDownload?.data?.slot?.audioBase64),
                eqSaved: !!(capturedDownload?.data?.slot?.eqParams?.bass === 3)
            });

            // Re-import the exported single slot
            if (capturedDownload) {
                const importFile = new File([JSON.stringify(capturedDownload.data)], 'ImportedTest.vpad-button', { type: 'application/json' });
                const prevSlotCount = app.slots.length;
                await app.handleGlobalImport(importFile);
                const reimported = app.slots[app.slots.length - 1];

                let canPlay = false;
                if (reimported && reimported.audioBlob instanceof Blob) {
                    await app.playSlot(reimported.id);
                    canPlay = app.activeSources.has(reimported.id);
                    app.stopSlot(reimported.id);
                }

                results.tests.push({
                    name: 'reimport_singleSlot_and_play',
                    pass: canPlay && reimported.label === '往復テスト1',
                    label: reimported ? reimported.label : null,
                    blobSize: reimported?.audioBlob ? reimported.audioBlob.size : 0,
                    canPlay: canPlay
                });
            }

            // Test Suite 2: Scroll Export & Import Roundtrip
            capturedDownload = null;
            await app.exportScroll(app.currentScrollId);
            results.tests.push({
                name: 'exportScroll_captured',
                pass: !!(capturedDownload && capturedDownload.data && Array.isArray(capturedDownload.data.slots)),
                slotsCount: capturedDownload?.data?.slots?.length || 0
            });

            if (capturedDownload) {
                const scrollFile = new File([JSON.stringify(capturedDownload.data)], 'ScrollTest.vpad-page', { type: 'application/json' });
                const prevScrollCount = app.scrolls.length;
                await app.handleGlobalImport(scrollFile);
                const newScroll = app.scrolls[app.scrolls.length - 1];
                const newScrollSlots = app.slots.filter(s => s.scrollId === newScroll.id);

                let firstSlotCanPlay = false;
                const slotWithAudio = newScrollSlots.find(s => s.audioBlob instanceof Blob && s.audioBlob.size > 0);
                if (slotWithAudio) {
                    await app.playSlot(slotWithAudio.id);
                    firstSlotCanPlay = app.activeSources.has(slotWithAudio.id);
                    app.stopSlot(slotWithAudio.id);
                }

                results.tests.push({
                    name: 'reimport_scroll_and_play',
                    pass: (app.scrolls.length > prevScrollCount) && firstSlotCanPlay,
                    scrollName: newScroll ? newScroll.name : null,
                    slotsCount: newScrollSlots.length,
                    firstSlotCanPlay: firstSlotCanPlay
                });
            }

            // Restore mock
            app.shareOrDownloadFile = origShare;

            return results;
        })()
        """

        eval_res = send_cmd("Runtime.evaluate", {
            "expression": test_script,
            "awaitPromise": True,
            "returnByValue": True
        })

        val = eval_res.get("result", {}).get("result", {}).get("value", {})
        print("=== COMPREHENSIVE SUITE RESULTS ===")
        print(json.dumps(val, indent=2, ensure_ascii=False))

        all_passed = True
        for t in val.get("tests", []):
            if not t.get("pass"):
                all_passed = False
                print(f"FAILED: {t['name']}")
            else:
                print(f"PASSED: {t['name']}")

        assert all_passed, "Some suite tests failed!"
        print("\n🎉 ALL ROUNDTRIP IMPORT/EXPORT & PLAYBACK TESTS PASSED!")

    finally:
        edge_proc.kill()

if __name__ == '__main__':
    run_suite()
