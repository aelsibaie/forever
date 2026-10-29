import unittest
from race_gap_summary import gap_range, summarize_gaps


def case(a, b, c):
    return {'rows': [{'race': race, 'meanDps': value} for race, value in zip(['a', 'b', 'c'], [a, b, c])]}


class GapSummaryTests(unittest.TestCase):
    def test_winning_race_can_have_zero_loss_with_large_racial_spread(self):
        summary = summarize_gaps([case(1000, 990, 980)], ['a', 'b', 'c'])
        self.assertEqual(summary['leaders'], ['a'])
        self.assertEqual(summary['runnerUpGapPercent'], {'min': 1, 'max': 1})
        self.assertEqual(summary['fullSpreadPercent'], {'min': 2, 'max': 2})
        self.assertEqual([row['gapPercent']['max'] for row in summary['races']], [0, 1, 2])

    def test_ranges_keep_each_setups_own_dps_denominator(self):
        summary = summarize_gaps([case(1000, 990, 980), case(800, 1000, 900)], ['a', 'b', 'c'])
        self.assertTrue(summary['leaderChanges'])
        self.assertEqual(summary['leaders'], ['a', 'b'])
        self.assertEqual(summary['runnerUpGapPercent'], {'min': 1, 'max': 10})
        self.assertEqual(summary['fullSpreadPercent'], {'min': 2, 'max': 20})
        self.assertEqual(summary['races'][0]['gapPercent'], {'min': 0, 'max': 20})

    def test_different_gear_budgets_do_not_create_a_cross_set_dps_gap(self):
        summary = summarize_gaps([case(1000, 990, 980), case(2000, 1980, 1960)], ['a', 'b', 'c'])
        self.assertEqual(summary['fullSpreadPercent'], {'min': 2, 'max': 2})

    def test_one_legal_race_has_no_competitor_gap(self):
        summary = summarize_gaps([{'rows': [{'race': 'a', 'meanDps': 1000}]}], ['a'])
        self.assertIsNone(summary['runnerUpGapPercent'])
        self.assertIsNone(summary['fullSpreadPercent'])

    def test_empty_pool_keeps_gaps_unavailable(self):
        summary = summarize_gaps([], ['a', 'b'])
        self.assertEqual(summary['conditions'], 0)
        self.assertEqual(summary['leaders'], [])
        self.assertTrue(all(row['gapPercent'] is None for row in summary['races']))

    def test_exact_tie_is_not_a_setup_reversal(self):
        summary = summarize_gaps([case(1000, 1000, 980)], ['a', 'b', 'c'])
        self.assertFalse(summary['leaderChanges'])
        self.assertEqual(summary['leaders'], ['a', 'b'])
        self.assertEqual(summary['runnerUpGapPercent']['max'], 0)

    def test_tiny_nonzero_gaps_are_not_printed_as_zero(self):
        self.assertEqual(gap_range({'min': .001, 'max': .004}), '<0.01%')
        self.assertEqual(gap_range({'min': 0, 'max': 0}), '0.00%')

    def test_incomplete_race_sets_fail(self):
        with self.assertRaises(ValueError):
            summarize_gaps([case(1000, 990, 980)], ['a', 'b'])


if __name__ == '__main__':
    unittest.main()
