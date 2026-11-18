import tempfile
import unittest
from pathlib import Path
import numpy as np
import soundfile as sf
from beats.__main__ import analyze, structure_candidates


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

    def test_accent_phase_and_tone_change_are_candidates(self):
        sr, hop = 22050, 256
        beats = np.arange(.5, 12.5, .5)
        frames = (beats * sr / hop).astype(int)
        clock = np.arange(sr * 13) / sr
        samples = np.where(clock < 6, np.sin(2*np.pi*220*clock), np.sin(2*np.pi*370*clock))
        envelope = np.zeros(len(samples) // hop + 1)
        envelope[frames] = 1
        envelope[frames[::4]] = 3
        downbeats, sections = structure_candidates(samples, sr, hop, envelope, beats, np.ones_like(envelope))
        self.assertEqual(downbeats, beats[::4].tolist())
        self.assertTrue(any(abs(t - 6.0) <= .5 for t in sections), sections)


if __name__ == '__main__':
    unittest.main()
