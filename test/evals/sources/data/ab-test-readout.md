# Experiment readout: one-page checkout

Synthetic document for evaluation. Example Widgets Inc. is a fictional company.

## Result in one line

The one-page checkout raised conversion from 3.10% to 3.24%, but the result is not statistically significant (p = 0.21), so we recommend running two more weeks rather than shipping now.

## Setup

- Test ran 14 days, 50/50 split, 186,000 visitors per arm.
- Primary metric: checkout conversion rate. Guardrail: average order value.
- The minimum detectable effect (MDE) we designed for was a 5% relative lift; the observed lift was 4.5%.

## Results

| Arm | Visitors | Orders | Conversion | Average order value |
| --- | --- | --- | --- | --- |
| Control (three pages) | 186,000 | 5,766 | 3.10% | $84.20 |
| One-page checkout | 186,000 | 6,026 | 3.24% | $83.90 |

- Relative lift: +4.5%, 95% confidence interval from -2.5% to +11.9%.
- The interval includes zero, so a real effect of nothing (or a small loss) is still plausible.
- Average order value did not move meaningfully (-0.4%).

## Recommendation

Extend the test by 14 days. With twice the sample the interval should narrow enough to confirm or rule out a lift of 4.5%. Do not stop early if the result crosses significance on a single day: peeking inflates false positives.
