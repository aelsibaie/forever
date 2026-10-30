"""Group profiles only by documented developer progression tiers."""

import re


def comparison_tier(profile):
    tier = profile.get("gearTier", "")
    return tier if tier == "Developer pre-raid" or re.fullmatch(r"Developer P[1-9][0-9]*", tier) else None


def tier_groups(profiles, key):
    groups = {}
    for profile in profiles:
        tier = comparison_tier(profile)
        if tier:
            groups.setdefault(tier, []).append(profile)
    order = lambda tier: 0 if tier == "Developer pre-raid" else int(tier.removeprefix("Developer P"))
    return [(tier, sorted(groups[tier], key=key, reverse=True)) for tier in sorted(groups, key=order)]


def tier_slug(tier):
    return re.sub(r"[^a-z0-9]+", "-", tier.lower()).strip("-")
