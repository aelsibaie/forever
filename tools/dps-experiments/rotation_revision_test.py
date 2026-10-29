from copy import deepcopy
import importlib.util
from pathlib import Path
import unittest
spec = importlib.util.spec_from_file_location('rotation_revision', Path(__file__).with_name('rotation_revision.py'))
revision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(revision)

class RotationRevisionTests(unittest.TestCase):
    def test_only_exact_cell_references_are_prefixed(self):
        value = {'key': 'old', 'race': 'Orc', 'notes': 'old result', 'nested': ['old']}
        result = revision.remap(value, {'old': 'new'})
        self.assertEqual(result, {'key': 'new', 'race': 'Orc', 'notes': 'old result', 'nested': ['new']})
        self.assertEqual(value['key'], 'old')
    def test_changed_cooldown_layout_requires_review(self):
        rotation = {'priorityList': [{'action': {'castSpell': {'spellId': {'spellId': 13750}}}}]}
        with self.assertRaises(ValueError):
            revision.cooldown_block(rotation)

if __name__ == '__main__':
    unittest.main()
