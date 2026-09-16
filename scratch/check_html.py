import re

with open('index.html', 'r', encoding='utf-8') as f:
    content = f.read()

ids = re.findall(r'id=["\']([^"\']*(?:voicemod|special|eq|stage)[^"\']*)["\']', content, re.I)
for i in sorted(set(ids)):
    print(i)
