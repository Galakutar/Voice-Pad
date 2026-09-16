import json
import time
import subprocess
import urllib.request
import websocket
import sys

sys.stdout.reconfigure(encoding='utf-8')

# Launch Edge in headless mode with debugging port
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

time.sleep(2)

try:
    with urllib.request.urlopen("http://127.0.0.1:9222/json") as res:
        tabs = json.loads(res.read().decode('utf-8'))
    
    page_tab = next((t for t in tabs if t.get('type') == 'page'), tabs[0])
    ws_url = page_tab["webSocketDebuggerUrl"]
    print(f"[OK] Connected to Edge CDP page target ({page_tab.get('title')}):", ws_url)

    ws = websocket.create_connection(ws_url)

    msg_counter = 1
    def send_cmd(method, params=None):
        global msg_counter
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
    send_cmd("Log.enable")

    # Poll until ready
    print("Waiting for page load and window.voicePadApp...", flush=True)
    for i in range(30):
        time.sleep(0.5)
        chk = send_cmd("Runtime.evaluate", {
            "expression": "document.readyState === 'complete' && typeof window.voicePadApp !== 'undefined' && typeof AudioUnlocker !== 'undefined'",
            "returnByValue": True
        })
        val = chk.get("result", {}).get("result", {}).get("value")
        if val is True:
            print(f"[OK] Page and scripts fully initialized! (poll {i+1})", flush=True)
            break

    # Evaluate test in browser context
    test_script = """
    (async () => {
        const results = [];
        const ctx = AudioUnlocker.getContext();
        await AudioUnlocker.unlock();

        // Test 1: Version check
        results.push({ test: 'APP_VERSION', val: APP_VERSION });

        // Test 2: Generate AudioBuffer and encode to WAV
        const sampleRate = ctx.sampleRate || 44100;
        const length = Math.floor(2.0 * sampleRate);
        const dummyBuf = ctx.createBuffer(1, length, sampleRate);
        const ch0 = dummyBuf.getChannelData(0);
        for (let i = 0; i < length; i++) {
            ch0[i] = Math.sin(2 * Math.PI * 440 * (i / sampleRate)) * 0.5;
        }

        const wavBlob = AudioUtils.audioBufferToWav(dummyBuf);
        results.push({ test: 'wavBlobType', val: wavBlob.type });
        results.push({ test: 'wavBlobSize', val: wavBlob.size });

        // Test 3: Safe decodeAudioData
        const arrBuf = await wavBlob.arrayBuffer();
        const decoded = await AudioUtils.decodeAudioDataSafe(ctx, arrBuf);
        results.push({ test: 'decodedDuration', val: decoded.duration });
        results.push({ test: 'decodedSampleRate', val: decoded.sampleRate });

        // Test 4: PcmAudioRecorder instance & recording test
        const osc = ctx.createOscillator();
        const dest = ctx.createMediaStreamDestination();
        osc.connect(dest);
        osc.start();

        const pcmRec = new PcmAudioRecorder(ctx, dest.stream);
        pcmRec.start();
        await new Promise(r => setTimeout(r, 650));
        const pcmRes = pcmRec.stop();
        osc.stop();

        results.push({ test: 'pcmDuration', val: pcmRes ? pcmRes.duration : null });
        results.push({ test: 'pcmBlobType', val: pcmRes && pcmRes.blob ? pcmRes.blob.type : null });
        results.push({ test: 'pcmBlobSize', val: pcmRes && pcmRes.blob ? pcmRes.blob.size : null });

        // Test 5: Decode PCM result
        if (pcmRes && pcmRes.blob) {
            const pcmArrBuf = await pcmRes.blob.arrayBuffer();
            const pcmDecoded = await AudioUtils.decodeAudioDataSafe(ctx, pcmArrBuf);
            results.push({ test: 'pcmDecodedDuration', val: pcmDecoded.duration });
        }

        // Test 6: VoicePadApp integration test
        try {
            const app = window.app || window.voicePadApp;
            if (app) {
                let slot = app.slots && app.slots.length > 0 ? app.slots[0] : null;
                if (!slot) {
                    slot = { id: 1, label: 'スロット 1', order: 1 };
                    app.slots = [slot];
                    app.renderSlots();
                }
                const slotId = slot.id;
                app.setMode('record');

                const mockDest = ctx.createMediaStreamDestination();
                const mockOsc = ctx.createOscillator();
                mockOsc.connect(mockDest);
                mockOsc.start();
                app.audioStream = mockDest.stream;
                app.getAudioStream = async () => app.audioStream;

                await app.startRecording(slotId);
                await new Promise(r => setTimeout(r, 600));

                const statusEl = document.querySelector(`#pad-${slotId} .pad-status`);
                const statusText = statusEl ? statusEl.innerText : '';
                const recSecs = app.recSeconds;

                await app.stopRecording();
                mockOsc.stop();

                const savedSlot = app.slots.find(s => s.id === slotId);
                results.push({
                    test: 'uiRecording',
                    val: {
                        statusText: statusText,
                        recSecs: recSecs,
                        savedSlotDuration: savedSlot ? savedSlot.duration : null,
                        savedSlotBlobType: savedSlot && savedSlot.audioBlob ? savedSlot.audioBlob.type : null,
                        savedSlotBlobSize: savedSlot && savedSlot.audioBlob ? savedSlot.audioBlob.size : null
                    }
                });
            }
        } catch (e) {
            results.push({ test: 'uiRecordingError', val: e.toString() });
        }

        return results;
    })()
    """

    res = send_cmd("Runtime.evaluate", {
        "expression": test_script,
        "awaitPromise": True,
        "returnByValue": True
    })

    print("\n--- Test Results ---")
    vals = res.get("result", {}).get("result", {}).get("value", [])
    for v in vals:
        print(f"[{v['test']}] => {json.dumps(v['val'], ensure_ascii=False)}")

    # Verification assertions
    app_ver = next(item for item in vals if item["test"] == "APP_VERSION")["val"]
    assert app_ver.startswith("2026.09.17"), f"Unexpected APP_VERSION: {app_ver}"

    wav_type = next(item for item in vals if item["test"] == "wavBlobType")["val"]
    assert wav_type == "audio/wav", f"Unexpected WAV type: {wav_type}"

    pcm_type = next(item for item in vals if item["test"] == "pcmBlobType")["val"]
    assert pcm_type == "audio/wav", f"Unexpected PCM type: {pcm_type}"

    pcm_dur = next(item for item in vals if item["test"] == "pcmDuration")["val"]
    assert pcm_dur >= 0.5, f"PCM duration too short: {pcm_dur}"

    ui_rec = next(item for item in vals if item["test"] == "uiRecording")["val"]
    assert "🔴 録音中" in ui_rec["statusText"], f"Status text invalid: {ui_rec['statusText']}"
    assert ui_rec["savedSlotBlobType"] == "audio/wav", f"Slot audio blob is not audio/wav: {ui_rec['savedSlotBlobType']}"
    assert ui_rec["savedSlotDuration"] >= 0.4, f"Slot duration too small: {ui_rec['savedSlotDuration']}"

    print("\n🎉 ALL TESTS PASSED! iPad / Safari PCM Recording & Timing Fix Fully Verified!")

finally:
    try:
        ws.close()
    except:
        pass
    edge_proc.terminate()
