import unittest
from report_details import pair_evidence


class ConfirmationTests(unittest.TestCase):
    def test_confirmation_cannot_cross_faction_or_duration(self):
        primary = {'faction':'alliance','profileId':'same','duration':60}
        wrong_faction = {**primary,'faction':'horde'}
        wrong_duration = {**primary,'duration':180}
        self.assertIsNone(pair_evidence(primary,[wrong_faction,wrong_duration])['confirmation'])
        self.assertIs(pair_evidence(primary,[wrong_faction,primary])['confirmation'],primary)


if __name__ == '__main__':
    unittest.main()
