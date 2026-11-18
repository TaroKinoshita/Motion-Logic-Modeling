import json
import tempfile
import unittest
from pathlib import Path
import cv2
import numpy as np
from track.__main__ import track
from track.fit import fit_track
from track.easing import fit_eased_track


class TrackingTests(unittest.TestCase):
    def make_clip(self, directory, blank_after=None):
        file = Path(directory) / 'motion.avi'
        writer = cv2.VideoWriter(str(file), cv2.VideoWriter_fourcc(*'MJPG'), 30, (320, 240))
        self.assertTrue(writer.isOpened())
        tile = np.random.default_rng(42).integers(50, 255, (64, 64, 3), dtype=np.uint8)
        for i in range(30):
            frame = np.zeros((240, 320, 3), np.uint8)
            if blank_after is None or i < blank_after:
                frame[80+i:144+i, 60+2*i:124+2*i] = tile
            writer.write(frame)
        writer.release()
        return file

    def test_translation_and_fit(self):
        with tempfile.TemporaryDirectory() as directory:
            result = track(self.make_clip(directory), (60, 80, 64, 64), 1.25, 30)
        self.assertIsNone(result['stoppedReason'])
        self.assertEqual(len(result['samples']), 30)
        error = max(max(abs(s['x']-(92+2*i)), abs(s['y']-(112+i))) for i, s in enumerate(result['samples']))
        self.assertLess(error, 1)
        fitted = fit_track(result['samples'])
        self.assertEqual(len(fitted['tracks']['x']), 2)
        self.assertEqual(len(fitted['tracks']['y']), 2)
        self.assertEqual(fitted['tracks']['x'][0]['t'], 1.25)
        print(json.dumps(dict(translationMaxErrorPx=error, keys={k:len(v) for k,v in fitted['tracks'].items()})))

    def test_disappearance_stops(self):
        with tempfile.TemporaryDirectory() as directory:
            result = track(self.make_clip(directory, blank_after=15), (60,80,64,64), 0, 30)
        self.assertIsNotNone(result['stoppedReason'])
        self.assertLessEqual(len(result['samples']), 16)

    def test_invalid_region_and_rate(self):
        with tempfile.TemporaryDirectory() as directory:
            file = self.make_clip(directory)
            for region, fps in [((0,0,400,400),30), ((60,80,64,64),24), ((60,80,64,64),float('nan'))]:
                with self.assertRaises(ValueError):
                    track(file, region, 0, fps)

    def test_fit_preserves_hold_and_bounded_error(self):
        samples = [dict(t=i/30, x=min(i,10)*2, y=0, scale=1, rotation=0) for i in range(30)]
        fitted = fit_track(samples)
        self.assertEqual([k['t'] for k in fitted['tracks']['x']], [0,10/30,29/30])
        self.assertAlmostEqual(fitted['maxSampleError']['x'], 0)
        with self.assertRaises(ValueError):
            fit_track([samples[0],samples[0]])

    def test_cubic_fit_compresses_eased_motion(self):
        samples = [dict(t=p,x=120*(3*p*p-2*p**3),y=0,scale=1,widthScale=1,rotation=0) for p in np.linspace(0,1,13)]
        result = fit_eased_track(samples)
        self.assertEqual(len(result['tracks']['x']),2)
        self.assertIn('cubic',result['tracks']['x'][0]['easing'])
        self.assertLess(result['maxSampleError']['x'],1e-6)


if __name__ == '__main__':
    unittest.main()
