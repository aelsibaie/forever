import unittest
from tier_groups import comparison_tier, tier_groups


class TierGroupsTest(unittest.TestCase):
    def test_unverified_labels_never_become_comparison_tiers(self):
        for label in ["Developer testing", "Pre-raid placeholder", "", "P1", "Custom gear experiment"]:
            self.assertIsNone(comparison_tier({"gearTier": label}))

    def test_tier_order_is_independent_of_dps(self):
        profiles = [{"gearTier": "Developer P1", "dps": 1000}, {"gearTier": "Developer pre-raid", "dps": 600}, {"gearTier": "Developer testing", "dps": 2000}, {"gearTier": "Developer P1", "dps": 900}]
        groups = tier_groups(profiles, key=lambda p: p["dps"])
        self.assertEqual([tier for tier, _ in groups], ["Developer pre-raid", "Developer P1"])
        self.assertEqual([[p["dps"] for p in rows] for _, rows in groups], [[600], [1000, 900]])

    def test_future_phases_remain_separate_and_sort_numerically(self):
        profiles = [{"gearTier": tier} for tier in ["Developer P10", "Developer P2", "Developer P1"]]
        self.assertEqual([tier for tier, _ in tier_groups(profiles, key=lambda p: 0)], ["Developer P1", "Developer P2", "Developer P10"])


if __name__ == "__main__":
    unittest.main()
