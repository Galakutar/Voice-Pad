with open('app.js', 'r', encoding='utf-8') as f:
    code = f.read()

funcs = [
    'initVoiceEngineUIEvents',
    'initVoicemodCategoryTabs',
    'renderVoicemodPresetCards',
    'applyVoicemodPresetToUI',
    'bindFxSliders',
    'setFxParamsToUI',
    'getFxParamsFromUI',
    'openSlotVoiceModal',
    'saveSlotVoiceModal',
    'previewQuickVoiceEffect',
    'openScrollModal',
    'saveScrollModal'
]

for fn in funcs:
    idx = code.find(fn)
    print(f"Function {fn}: found at char {idx}")
