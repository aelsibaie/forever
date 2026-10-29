"""DPS gaps between race means within matching simulation conditions."""


def summarize_gaps(groups, races):
    gaps = {race: [] for race in races}
    runner_up, spread, leaders_by_case = [], [], []
    for group in groups:
        rows = sorted(group['rows'], key=lambda row: (-row['meanDps'], row['race']))
        if {row['race'] for row in rows} != set(races) or len(rows) != len(races):
            raise ValueError('A gap comparison must contain every legal race exactly once.')
        best = rows[0]['meanDps']
        if best <= 0:
            raise ValueError('A gap comparison needs positive leading DPS.')
        leaders_by_case.append(tuple(row['race'] for row in rows if row['meanDps'] == best))
        for row in rows:
            gaps[row['race']].append(max(0, 100 * (best - row['meanDps']) / best))
        if len(rows) > 1:
            runner_up.append(100 * (best - rows[1]['meanDps']) / best)
            spread.append(100 * (best - rows[-1]['meanDps']) / best)
    bounds = lambda values: {'min': min(values), 'max': max(values)} if values else None
    return {
        'conditions': len(groups),
        'leaders': sorted({race for case in leaders_by_case for race in case}),
        'leaderChanges': len(set(leaders_by_case)) > 1,
        'runnerUpGapPercent': bounds(runner_up),
        'fullSpreadPercent': bounds(spread),
        'races': [{'race': race, 'gapPercent': bounds(gaps[race])} for race in races],
    }


def gap_range(bounds):
    if bounds is None:
        return 'No comparison'
    def number(value):
        return '<0.01' if 0 < value < .005 else f'{value:.2f}'
    low, high = number(bounds['min']), number(bounds['max'])
    return (low if low == high else low + '–' + high) + '%'
