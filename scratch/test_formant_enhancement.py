import urllib.request
import subprocess

def test():
    print("Testing Voice Pad formant enhancements...")
    
    # 1. Fetch index.html
    req = urllib.request.urlopen("http://127.0.0.1:8080/index.html")
    html = req.read().decode('utf-8')
    print("index.html length:", len(html))
    print("Has slot-formant-slider min 0.35:", 'id="slot-formant-slider" min="0.35"' in html)
    print("Has quick-voice-formant-slider min 0.35:", 'id="quick-voice-formant-slider" min="0.35"' in html)
    print("Has scroll-formant-slider min 0.35:", 'id="scroll-formant-slider" min="0.35"' in html)
    
    # 2. Fetch app.js
    req_js = urllib.request.urlopen("http://127.0.0.1:8080/app.js?v=20260917_6")
    js = req_js.read().decode('utf-8')
    print("app.js length:", len(js))
    print("app.js version match:", "const APP_VERSION = '2026.09.17.0006';" in js)
    print("Has resonance enhancer:", "極太・声道/胸腔共鳴エンハンサー" in js)
    
    # 3. Headless Edge check
    edge_path = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
    command = [edge_path, "--headless", "--disable-gpu", "--dump-dom", "http://127.0.0.1:8080/index.html"]
    res = subprocess.run(command, capture_output=True, encoding='utf-8', errors='replace', timeout=10)
    dom = res.stdout
    print("Rendered DOM length:", len(dom))
    print("Slot cards rendered:", dom.count('class="pad-card'))
    print("Quick voice formant slider rendered with 0.35:", 'id="quick-voice-formant-slider" min="0.35"' in dom)
    
    assert 'id="slot-formant-slider" min="0.35"' in dom
    assert 'id="quick-voice-formant-slider" min="0.35"' in dom
    assert 'id="scroll-formant-slider" min="0.35"' in dom
    print("ALL FORMANTH ENHANCEMENT CHECKS PASSED SUCCESSFULLY!")

if __name__ == "__main__":
    test()
