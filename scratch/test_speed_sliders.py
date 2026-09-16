import urllib.request
import subprocess

def test():
    print("Testing Voice Pad frontend via HTTP fetch and Edge CDP...")
    
    # 1. Fetch index.html
    req = urllib.request.urlopen("http://127.0.0.1:8080/index.html")
    html = req.read().decode('utf-8')
    print("index.html length:", len(html))
    print("Has slot-speed-slider:", 'id="slot-speed-slider"' in html)
    print("Has quick-voice-speed-slider:", 'id="quick-voice-speed-slider"' in html)
    print("Has scroll-speed-slider:", 'id="scroll-speed-slider"' in html)
    
    # 2. Fetch app.js
    req_js = urllib.request.urlopen("http://127.0.0.1:8080/app.js?v=20260917_5")
    js = req_js.read().decode('utf-8')
    print("app.js length:", len(js))
    print("app.js version match:", "const APP_VERSION = '2026.09.17.0005';" in js)
    
    # 3. Headless Edge check
    edge_path = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
    command = [edge_path, "--headless", "--disable-gpu", "--dump-dom", "http://127.0.0.1:8080/index.html"]
    res = subprocess.run(command, capture_output=True, encoding='utf-8', errors='replace', timeout=10)
    dom = res.stdout
    print("Rendered DOM length:", len(dom))
    print("Slot cards rendered:", dom.count('class="pad-card'))
    print("Add button rendered:", 'class="pad-card-add"' in dom)
    print("Quick voice speed slider:", 'id="quick-voice-speed-slider"' in dom)
    print("Slot speed slider:", 'id="slot-speed-slider"' in dom)
    print("Scroll speed slider:", 'id="scroll-speed-slider"' in dom)
    
    assert 'id="quick-voice-speed-slider"' in dom
    assert 'id="slot-speed-slider"' in dom
    assert 'id="scroll-speed-slider"' in dom
    print("ALL VERIFICATION CHECKS PASSED SUCCESSFULLY!")

if __name__ == "__main__":
    test()
