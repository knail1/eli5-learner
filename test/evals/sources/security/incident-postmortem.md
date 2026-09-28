# Post-incident review: credential stuffing against the partner portal

Synthetic document for evaluation. Example Widgets Inc. is a fictional company.

## Summary

On 3 August the security operations team detected a credential stuffing campaign against the partner portal. Attackers replayed username and password pairs leaked from unrelated sites. 41 partner accounts were accessed before the portal forced password resets. No customer payment data was stored in the portal, and no data left the network.

## Timeline

| Time (UTC) | Event |
| --- | --- |
| 02:10 | Login failures jump from 300 to 18,000 per hour |
| 02:25 | SIEM correlation rule fires on failures from 900 distinct IP addresses |
| 03:05 | On-call analyst confirms the pattern and blocks the top 40 source networks |
| 04:40 | EDR on one partner-facing jump server flags an unusual PowerShell process |
| 05:15 | Jump server isolated; no lateral movement found beyond it |
| 07:30 | Forced password reset for all 2,300 partner accounts |

## What went well

- The SIEM rule caught the spike within 15 minutes.
- EDR isolation of the jump server took 35 minutes from alert to containment.
- IOCs (IP ranges, user agents, the PowerShell script hash) were shared with two industry peers the same day.

## What went wrong

- The portal had no MFA for partner accounts, so a correct password was enough.
- Rate limiting applied per IP address only, so the distributed attack stayed under it.
- MTTR for the whole incident was 5 hours 20 minutes against a target of 4 hours.

## Actions

1. Require MFA for every partner account by 30 September.
2. Add rate limiting per account, not just per IP address.
3. Check new passwords against a list of known breached passwords.
4. Rehearse the portal playbook every quarter to bring MTTR under 4 hours.
