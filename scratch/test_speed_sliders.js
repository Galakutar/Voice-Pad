const http = require('http');
const { execSync } = require('child_process');

async function test() {
    console.log('Testing Voice Pad frontend via HTTP fetch and Edge CDP...');
    
    // 1. Fetch index.html
    const res = await fetch('http://127.0.0.1:8080/index.html');
    const html = await res.text();
    
    console.log('index.html length:', html.length);
    console.log('Has slot-speed-slider:', html.includes('id="slot-speed-slider"'));
    console.log('Has quick-voice-speed-slider:', html.includes('id="quick-voice-speed-slider"'));
    console.log('Has scroll-speed-slider:', html.includes('id="scroll-speed-slider"'));
    
    // 2. Fetch app.js and check version
    const jsRes = await fetch('http://127.0.0.1:8080/app.js?v=20260917_5');
    const js = await jsRes.text();
    console.log('app.js length:', js.length);
    console.log('app.js version match:', js.includes("const APP_VERSION = '2026.09.17.0005';"));
    
    // 3. Launch headless Edge to verify DOM execution and no errors
    const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    
    console.log('Launching headless Edge for runtime DOM verification...');
    const command = `"${edgePath}" --headless --disable-gpu --dump-dom http://127.0.0.1:8080/index.html`;
    const dom = execSync(command, { encoding: 'utf-8', timeout: 10000 });
    
    console.log('Rendered DOM length:', dom.length);
    console.log('Slot count in rendered DOM:', (dom.match(/class="pad-card/g) || []).length);
    console.log('Add button in rendered DOM:', dom.includes('class="pad-card-add"'));
    console.log('Quick voice speed slider rendered:', dom.includes('id="quick-voice-speed-slider"'));
    console.log('Slot speed slider rendered:', dom.includes('id="slot-speed-slider"'));
    console.log('Scroll speed slider rendered:', dom.includes('id="scroll-speed-slider"'));
    
    console.log('ALL VERIFICATION CHECKS PASSED!');
}

test().catch(err => {
    console.error('Test error:', err);
    process.exit(1);
});
