import re

with open(r'c:\Users\gyala\.antigravity-ide\voice-pad\app.js', 'r', encoding='utf-8') as f:
    code = f.read()

# Find class VoicePadApp methods
class_match = re.search(r'class VoicePadApp\s*\{(.*)', code, re.DOTALL)
if class_match:
    class_code = class_match.group(1)
    # find all defined methods: name(...) {
    defined_methods = set(re.findall(r'^\s*(?:async\s+)?([a-zA-Z0-9_]+)\s*\([^)]*\)\s*\{', class_code, re.MULTILINE))
    # find all called methods: this.name(...)
    called_methods = set(re.findall(r'this\.([a-zA-Z0-9_]+)\(', class_code))

    # exclude built-ins or properties that might be functions
    missing = called_methods - defined_methods
    print("Defined methods count:", len(defined_methods))
    print("Potentially missing methods called on this:", missing)
