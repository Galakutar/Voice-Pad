import json
import math

# Vowel Formants in Hz: [F1, F2, F3, F4]
VOWEL_FORMANTS = {
    'a': [800, 1250, 2600, 3500],
    'i': [300, 2300, 3000, 3700],
    'u': [360, 1250, 2400, 3500],
    'e': [500, 1900, 2600, 3600],
    'o': [500, 900, 2400, 3500],
    'N': [250, 1000, 2200, 3200]
}

print("Vowel definitions ready:", list(VOWEL_FORMANTS.keys()))
