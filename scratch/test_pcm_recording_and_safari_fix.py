import urllib.request
import json
import asyncio
from playwright.async_api import async_playwright

async def run_test():
    print("=== Testing Voice Pad 2026.09.17.0010 iPad / Safari Recording Fix ===")
    
    # 1. Check HTTP server and version
    req_v = urllib.request.urlopen("http://127.0.0.1:8080/version.json")
    v_data = json.loads(req_v.read().decode('utf-8'))
    print(f"Server version: {v_data['version']}")
    assert v_data['version'] == "2026.09.17.0010", "version.json is not 2026.09.17.0010"

    req_js = urllib.request.urlopen("http://127.0.0.1:8080/app.js?v=20260917_10")
    js_content = req_js.read().decode('utf-8')
    assert "class PcmAudioRecorder" in js_content, "PcmAudioRecorder class missing in app.js"
    assert "decodeAudioDataSafe" in js_content, "decodeAudioDataSafe missing in app.js"
    assert "APP_VERSION = '2026.09.17.0010'" in js_content, "APP_VERSION constant mismatch"
    print("Static verification passed: PcmAudioRecorder, decodeAudioDataSafe, and version match.")

    # 2. Browser E2E Test
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            permissions=["microphone"]
        )
        page = await context.new_page()
        
        page_errors = []
        page.on("pageerror", lambda err: page_errors.append(str(err)))
        
        await page.goto("http://127.0.0.1:8080/index.html")
        await page.wait_for_timeout(1000)

        # Evaluate PCM recorder and AudioUtils.decodeAudioDataSafe
        test_result = await page.evaluate('''async () => {
            const results = {};
            const ctx = AudioUnlocker.getContext();
            await AudioUnlocker.unlock();

            // Test 1: Generate dummy 2.5s AudioBuffer and test AudioUtils.audioBufferToWav
            const sampleRate = ctx.sampleRate || 44100;
            const length = Math.floor(2.5 * sampleRate);
            const dummyBuf = ctx.createBuffer(1, length, sampleRate);
            const ch0 = dummyBuf.getChannelData(0);
            for (let i = 0; i < length; i++) {
                ch0[i] = Math.sin(2 * Math.PI * 440 * (i / sampleRate)) * 0.5;
            }

            const wavBlob = AudioUtils.audioBufferToWav(dummyBuf);
            results.wavBlobType = wavBlob.type;
            results.wavBlobSize = wavBlob.size;

            // Test 2: Test AudioUtils.decodeAudioDataSafe
            const arrayBuffer = await wavBlob.arrayBuffer();
            const decoded = await AudioUtils.decodeAudioDataSafe(ctx, arrayBuffer);
            results.decodedDuration = decoded.duration;
            results.decodedChannels = decoded.numberOfChannels;
            results.decodedSampleRate = decoded.sampleRate;

            // Test 3: Test PcmAudioRecorder logic with dummy AudioNode stream
            const osc = ctx.createOscillator();
            const dest = ctx.createMediaStreamDestination();
            osc.connect(dest);
            osc.start();

            const pcmRec = new PcmAudioRecorder(ctx, dest.stream);
            pcmRec.start();
            await new Promise(r => setTimeout(r, 600)); // record 600ms
            const pcmRes = pcmRec.stop();
            osc.stop();

            results.pcmDuration = pcmRes.duration;
            results.pcmBlobType = pcmRes.blob.type;
            results.pcmBlobSize = pcmRes.blob.size;

            // Test 4: Decode PCM record result
            const pcmArrBuf = await pcmRes.blob.arrayBuffer();
            const pcmDecoded = await AudioUtils.decodeAudioDataSafe(ctx, pcmArrBuf);
            results.pcmDecodedDuration = pcmDecoded.duration;

            return results;
        }''')

        print("Browser Execution Results:")
        for k, v in test_result.items():
            print(f"  {k}: {v}")

        assert test_result["wavBlobType"] == "audio/wav", "WAV Blob type mismatch"
        assert abs(test_result["decodedDuration"] - 2.5) < 0.05, f"Decoded duration unexpected: {test_result['decodedDuration']}"
        assert test_result["pcmBlobType"] == "audio/wav", "PCM Blob type is not audio/wav"
        assert test_result["pcmDuration"] >= 0.5, f"PCM duration too short: {test_result['pcmDuration']}"
        assert abs(test_result["pcmDecodedDuration"] - test_result["pcmDuration"]) < 0.05, "PCM decoded duration mismatch"

        # 3. Test VoicePadApp recording state & UI
        ui_test = await page.evaluate('''async () => {
            const app = window.voicePadApp;
            if (!app) return { error: "app not found" };

            // Start recording slot 1
            const slot = app.slots[0];
            const slotId = slot.id;
            
            // Trigger mode record
            app.setMode('record');
            
            // Mock getAudioStream
            const ctx = AudioUnlocker.getContext();
            const dest = ctx.createMediaStreamDestination();
            const osc = ctx.createOscillator();
            osc.connect(dest);
            osc.start();
            app.audioStream = dest.stream;

            await app.startRecording(slotId);
            
            // Wait 500ms
            await new Promise(r => setTimeout(r, 550));
            
            const statusEl = document.querySelector(`#pad-${slotId} .pad-status`);
            const statusText = statusEl ? statusEl.innerText : '';
            const recSecs = app.recSeconds;

            await app.stopRecording();
            osc.stop();

            const savedSlot = app.slots.find(s => s.id === slotId);
            
            return {
                statusText,
                recSecs,
                savedSlotDuration: savedSlot ? savedSlot.duration : null,
                savedSlotBlobType: savedSlot && savedSlot.audioBlob ? savedSlot.audioBlob.type : null,
                savedSlotBlobSize: savedSlot && savedSlot.audioBlob ? savedSlot.audioBlob.size : null
            };
        }''')

        print("UI Recording Test Results:")
        for k, v in ui_test.items():
            print(f"  {k}: {v}")

        assert "🔴 録音中..." in ui_test["statusText"], f"Status text invalid: {ui_test['statusText']}"
        assert ui_test["savedSlotBlobType"] == "audio/wav", f"Slot audio blob is not audio/wav: {ui_test['savedSlotBlobType']}"
        assert ui_test["savedSlotDuration"] >= 0.4, f"Slot duration too small: {ui_test['savedSlotDuration']}"

        assert len(page_errors) == 0, f"Page errors encountered: {page_errors}"
        await browser.close()

    print("\n✅ All automated verification tests passed successfully!")

if __name__ == '__main__':
    asyncio.run(run_test())
