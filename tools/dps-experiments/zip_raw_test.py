import hashlib
import importlib.util
import json
import random
import tempfile
import unittest
import zipfile
from pathlib import Path


spec = importlib.util.spec_from_file_location('zip_raw', Path(__file__).with_name('zip_raw.py'))
zip_raw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(zip_raw)


class RawArchiveTest(unittest.TestCase):
    def test_parts_reconstruct_original_files_and_checksums(self):
        with tempfile.TemporaryDirectory(prefix='wow-raw-parts-') as temp:
            root = Path(temp)
            source = root / 'source'
            source.mkdir()
            expected = {}
            rng = random.Random(32)
            for index in range(6):
                data = rng.randbytes(300)
                name = f'results/case-{index}.json'
                file = source / name
                file.parent.mkdir(exist_ok=True)
                file.write_bytes(data)
                expected[name] = data
            (source / 'engine.exe').write_bytes(b'local binary')
            (source / 'incomplete.pending').write_bytes(b'incomplete')
            receipts = zip_raw.package({'source': str(source), 'output': str(root / 'run-raw.zip'), 'url': 'https://example.com/run-raw.zip', 'complete': True, 'maxPartBytes': 400})
            self.assertGreater(len(receipts), 1)
            observed = {}
            for receipt in receipts:
                self.assertEqual(zip_raw.package(receipt), [receipt])
                file = Path(receipt['output'])
                self.assertEqual(receipt['sha256'], hashlib.sha256(file.read_bytes()).hexdigest())
                self.assertEqual(file.name, receipt['url'].rsplit('/', 1)[-1])
                with zipfile.ZipFile(file) as part:
                    self.assertIsNone(part.testzip())
                    hashes = json.loads(part.read('raw-sha256.json'))
                    for name, checksum in hashes.items():
                        data = part.read(name)
                        self.assertNotIn(name, observed)
                        self.assertEqual(hashlib.sha256(data).hexdigest(), checksum)
                        observed[name] = data
            self.assertEqual(observed, expected)


if __name__ == '__main__':
    unittest.main()
