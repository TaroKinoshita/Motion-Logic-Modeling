import tempfile
import unittest
from pathlib import Path
import numpy as np
import soundfile as sf
from beats.__main__ import analyze


class AudioBoundaryTests(unittest.TestCase):
    def run_audio(self, samples, sr=22050):
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder) / 'test.wav'
            sf.write(file, samples, sr, subtype='FLOAT')
            return analyze(file)

    def test_silence_does_not_invent_beats(self):
        result = self.run_audio(np.zeros(22050))
        self.assertEqual(result['bpm'], 0)
        self.assertEqual(result['beats'], [])
        self.assertEqual(result['onsets'], [])

    def test_short_audio_stays_in_bounds(self):
        result = self.run_audio(np.zeros(100))
        self.assertTrue(all(0 <= t < result['duration'] for t in result['beats']))
        self.assertEqual(result['beats'], [])

    def test_invalid_samples_are_rejected(self):
        with self.assertRaises(ValueError):
            self.run_audio(np.array([np.nan, 0.0]))

    def test_empty_audio_is_rejected(self):
        with self.assertRaises(ValueError):
            self.run_audio(np.array([]))


if __name__ == '__main__':
    unittest.main()
