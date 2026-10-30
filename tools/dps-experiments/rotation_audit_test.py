import importlib.util
from pathlib import Path
import unittest
spec = importlib.util.spec_from_file_location('rotation_audit', Path(__file__).with_name('rotation_audit.py'))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)

class RotationAuditTests(unittest.TestCase):
    def setUp(self):
        self.rows = [{'key': 'a', 'race': 'A', 'meanDps': 100}, {'key': 'b', 'race': 'B', 'meanDps': 100}]
        self.damage = {'a': [], 'b': []}
    def test_missing_shared_cooldown_blocks_the_comparison(self):
        found = audit.missing_shared_actions(self.rows, {'a': {10: 0}, 'b': {10: 1}}, {10}, {10}, self.damage)
        self.assertEqual(found[0]['kind'], 'missing-shared-cooldown')
    def test_racial_and_uniformly_unused_cooldowns_do_not_create_findings(self):
        self.assertEqual(audit.missing_shared_actions(self.rows, {'a': {11: 1}, 'b': {}}, {10}, {10}, self.damage), [])
    def test_major_damage_action_missing_in_one_race_is_detected(self):
        self.damage['b'] = [{'id': {'spellId': 20}, 'dps': 12}]
        found = audit.missing_shared_actions(self.rows, {'a': {}, 'b': {20: 4}}, set(), {20}, self.damage)
        self.assertEqual(found[0]['kind'], 'missing-shared-damage-action')
    def test_minor_damage_does_not_establish_a_rotation_failure(self):
        self.damage['b'] = [{'id': {'spellId': 20}, 'dps': 2}]
        self.assertEqual(audit.missing_shared_actions(self.rows, {'a': {}, 'b': {20: 4}}, set(), {20}, self.damage), [])
    def test_partial_usage_disparity_is_advisory(self):
        found = audit.scheduling_disparities(self.rows, {'a': {10: 1}, 'b': {10: .25}}, {10})
        self.assertEqual(found[0]['spellId'], 10)
        self.assertEqual(audit.scheduling_disparities(self.rows, {'a': {10: 1}, 'b': {10: 0}}, {10}), [])

    def test_diagnostics_and_blocked_conditions_never_enter_recommendations(self):
        self.assertTrue(audit.rotation_suitable({'referencePolicy': 'developer'}))
        for group in [{'referencePolicy': 'explicit'}, {'rotationExcluded': True}, {'diagnosticOnly': True}]:
            self.assertFalse(audit.rotation_suitable(group))

if __name__ == '__main__':
    unittest.main()
