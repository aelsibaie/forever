import unittest
from compare_gear import without_gear


class ComparisonTests(unittest.TestCase):
    def test_equipment_is_removed_but_build_and_swap_stats_stay(self):
        request = {'raid': {'parties': [{'players': [{'talentsString': 'build', 'equipment': {'items': [{'id': 1}]}, 'itemSwap': {'items': [{'id': 2}], 'prepullBonusStats': {'stats': [3]}}}]}]}}
        result = without_gear(request)
        player = result['raid']['parties'][0]['players'][0]
        self.assertNotIn('equipment', player)
        self.assertNotIn('items', player['itemSwap'])
        self.assertEqual(player['talentsString'], 'build')
        self.assertEqual(player['itemSwap']['prepullBonusStats'], {'stats': [3]})
        self.assertIn('equipment', request['raid']['parties'][0]['players'][0])

    def test_non_gear_changes_remain_visible(self):
        a = {'raid': {'parties': [{'players': [{'race': 'A', 'equipment': {'items': []}}]}]}}
        b = {'raid': {'parties': [{'players': [{'race': 'B', 'equipment': {'items': []}}]}]}}
        self.assertNotEqual(without_gear(a), without_gear(b))


if __name__ == '__main__':
    unittest.main()
