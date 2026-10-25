# DPS reports

[Current DPS comparisons by gear tier](2026-10-25-cc61e6b628/developer-presets/report.html) · [Update comparison within matching tiers](2026-10-25-cc61e6b628/report.html)

- Simulator source: cc61e6b628871949c33997088ac98a5f7985c2d1
- Simulation analytics revision: c203df19ff07b24ffd73b452b056ac752d132c5c
- Forty saved profiles at 60/180/300 seconds and 10,000 iterations per cell.
- Independent tier comparisons: 12 developer pre-raid builds and 17 developer P1 builds. Nine testing/placeholder profiles remain outside comparisons. Two unsupported Rogue profiles remain diagnostic.
- The table selects one tier; tier-comparison.csv resets its ordering within each tier and duration. Raw metrics remain in summary.csv.
- Saved-input comparison: 24 compatible profiles and 72 identical requests. Eighteen profiles have matching documented tiers for the comparison. Sixteen historical profiles use equipment IDs removed upstream; no replacement items were selected.
- The original runs completed 192 cells and 1,920,000 fights with zero simulation errors. The tier-only reports reuse those saved results.

Open the HTML files locally. Reports contain their charts and table data and need no network connection. The snapshot includes exact requests and summaries. Full raw distributions, debug logs and native binaries remain in the local archive recorded in raw-data-location.json.

Generated report bytes are preserved for the recorded hashes and excluded from formatting. The analytics workflow and update command are documented in [tools/dps-experiments](../../tools/dps-experiments/README.md).
