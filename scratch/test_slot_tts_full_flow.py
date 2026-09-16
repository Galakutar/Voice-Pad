import sys
import json
import time
import subprocess
import urllib.request
import websocket
import tempfile

sys.stdout.reconfigure(encoding='utf-8')

def run_slot_tts_flow_test():
    tmp_dir = tempfile.mkdtemp()
    edge_path = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
    port = 9228
    proc = subprocess.Popen([
        edge_path,
        "--headless=new",
        f"--user-data-dir={tmp_dir}",
        f"--remote-debugging-port={port}",
        "--remote-allow-origins=*",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "http://127.0.0.1:8080/index.html"
    ])

    time.sleep(3)

    try:
        with urllib.request.urlopen(f"http://localhost:{port}/json") as res:
            tabs = json.loads(res.read().decode('utf-8'))
        target_tab = next((t for t in tabs if "8080" in t.get("url", "")), tabs[0])
        ws_url = target_tab["webSocketDebuggerUrl"]

        ws = websocket.create_connection(ws_url, timeout=10)

        test_flow_script = """
        (async () => {
            try {
                const results = {};
                const app = window.app;
                if (!app) return { error: "app not found" };

                await AudioUnlocker.unlock();

                // 1. Get first slot
                const currentSlots = app.getCurrentSlots();
                const slot = currentSlots[0];
                results.targetSlotId = slot.id;

                // 2. Open edit modal for this slot
                app.openEditModal(slot.id);

                // 3. Set TTS input
                const ttsInput = document.getElementById('tts-input-text');
                ttsInput.value = "怪獣の咆哮！";

                // 4. Select Voicemod Monster Preset
                const monsterPreset = VoiceEngine.getVoicemodPresets().find(p => p.id === 'monster_titan');
                app.applyVoicemodPresetToUI(monsterPreset, 'slot');

                // 5. Apply TTS to Slot
                await app.applyTtsToSlot();
                results.applyFinished = true;

                // 6. Verify slot in app.slots
                const updatedSlot = app.slots.find(s => s.id === slot.id);
                results.updatedSlot = {
                    id: updatedSlot.id,
                    label: updatedSlot.label,
                    hasAudioBlob: !!updatedSlot.audioBlob,
                    blobSize: updatedSlot.audioBlob ? updatedSlot.audioBlob.size : 0,
                    blobType: updatedSlot.audioBlob ? updatedSlot.audioBlob.type : null,
                    duration: updatedSlot.duration,
                    ttsText: updatedSlot.ttsText,
                    ttsVoice: updatedSlot.ttsVoice,
                    voiceEffectMode: updatedSlot.voiceEffectMode,
                    hasVoiceParams: !!updatedSlot.voiceParams,
                    hasEnvParams: !!updatedSlot.envParams,
                    hasEqParams: !!updatedSlot.eqParams,
                    hasSpecialParams: !!updatedSlot.specialParams
                };

                // 7. Test playSlot
                await app.playSlot(updatedSlot.id);
                results.playTriggered = true;

                return results;
            } catch (e) {
                return { error: e.message, stack: e.stack };
            }
        })()
        """

        req = {"id": 1, "method": "Runtime.evaluate", "params": {"expression": test_flow_script, "awaitPromise": True, "returnByValue": True}}
        ws.send(json.dumps(req))
        resp = json.loads(ws.recv())
        val = resp.get("result", {}).get("result", {}).get("value", {})
        print("🎯 Full Slot TTS & Voicemod Flow Results:")
        print(json.dumps(val, indent=2, ensure_ascii=False))

        assert val.get("updatedSlot", {}).get("hasAudioBlob") == True, "Slot audioBlob was not created"
        assert val.get("updatedSlot", {}).get("blobSize", 0) > 1000, "Slot audioBlob size is invalid"
        assert val.get("updatedSlot", {}).get("duration", 0) > 0.5, "Slot duration invalid"
        assert val.get("updatedSlot", {}).get("hasVoiceParams") == True, "VoiceParams not saved"
        assert val.get("updatedSlot", {}).get("hasEqParams") == True, "EqParams not saved"
        assert val.get("playTriggered") == True, "playSlot failed"

        print("🎉 Full Slot TTS assignment and playback test PASSED!")

        ws.close()
    finally:
        proc.terminate()

if __name__ == "__main__":
    run_slot_tts_flow_test()
