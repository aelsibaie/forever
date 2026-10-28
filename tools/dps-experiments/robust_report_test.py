import unittest

from robust_report import assess


def group(gap, error):
    return {'key': 'case', 'setId': 'gear', 'leader': 'a', 'comparisons': [
        {'race': 'a', 'percent': 0, 'halfWidthPercent': 0},
        {'race': 'b', 'percent': gap, 'halfWidthPercent': error},
    ]}


class RecommendationBoundsTest(unittest.TestCase):
    def test_noisy_highest_mean_does_not_certify_the_race(self):
        result = assess([group(-.05, .4)], ['a', 'b'])
        self.assertEqual(result['safe'], [])
        self.assertTrue(result['precisionLimited'])
        self.assertGreater(next(r for r in result['losses'] if r['race'] == 'a')['worstUpperLoss'], .2)

    def test_a_clear_lead_and_a_precise_practical_tie_stay_distinct(self):
        self.assertEqual(assess([group(-1, .05)], ['a', 'b'])['safe'], ['a'])
        self.assertEqual(set(assess([group(-.04, .03)], ['a', 'b'])['safe']), {'a', 'b'})

    def test_a_single_legal_race_has_no_competitor_loss(self):
        case = group(0, 0)
        case['comparisons'] = case['comparisons'][:1]
        result = assess([case], ['a'])
        self.assertEqual(result['safe'], ['a'])
        self.assertEqual(result['losses'][0]['worstUpperLoss'], 0)


if __name__ == '__main__':
    unittest.main()
