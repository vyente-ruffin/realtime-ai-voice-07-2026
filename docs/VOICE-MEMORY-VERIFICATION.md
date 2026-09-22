# Voice memory verification

The focused memory checks passed. The existing 500 ms interruption benchmark remains failed; this update does not claim to fix it.

| Check | Result |
| --- | --- |
| Four known facts | Correct answer text and received speech; zero delegations or waiting phrases. |
| Same-question speed | Candidate median 1,801 ms; baseline 1,812 ms, within the 200 ms allowance. |
| Automatic correction | The open session accepted the new context in 60.6 seconds and answered the corrected fact aloud by 67.7 seconds, without a lookup or unsolicited announcement. |
| Reconnect | Correct updated answer without lookup. One reply took 12.5 seconds; the outlier remains recorded. |
| Existing 300-second refresh interval | Summary changed in 85.9 seconds; open-session context updated in 99.8 seconds; correct spoken answer by 106.6 seconds. A fresh session also answered correctly. Those replies began in 1.19 and 1.29 seconds. |
| Deeper memory | A fact absent from the three loaded summaries was retrieved by Hermes and spoken correctly. |
| Background work | The sum of the first twenty square numbers was correctly calculated and announced as 2,870. Another request was accepted while the memory lookup was running. |
| Ordinary conversation | The familiar preference answer began in 1.30 seconds. |
| Settings | Voice, pace, noise reduction, persona/custom instructions persisted through reload; Start/End remained visible at a phone-sized viewport. |
| Interruption behavior | The story stopped and the requested replacement reply followed. The separate 500 ms silence-gap test failed on both previous and candidate builds. That timing target and absence of a timing regression are not established. |
| Regression suite | All 37 tests passed, including update acknowledgment, duplicate prevention, reconnect, retention, and last-good context on refresh failure. |
| Deployment | Three prepared summaries and the worker were ready. Served browser modules matched tested files. A real muted connect/end cycle produced matching records in both existing local destinations. Stored data and protected-source/configuration checks were preserved. |

## Limits retained

Real browser audio used the existing provider and a fictional memory bank. Content was checked against the provider's accompanying transcript; recordings were not independently transcribed. These are not physical phone, Bluetooth, or lock-screen checks, and the small speed sample is not a broad performance guarantee.

The configuration freeze was respected. The three focused test summaries retained their existing zero-second interval and verified full refresh plus quiet per-section updates. A separate existing test summary verified the native 300-second interval using delta refresh. Production's focused summaries remain full refresh with a 300-second minimum. This is component coverage, not a claim that the exact production summary configuration was recreated in the test bank.

Earlier failures remain in private evidence: memory processing stalled, one initially silent session produced text without recorded speech, and page/session setup timed out. Later tests ran one at a time and excluded external font downloads. No cause is claimed for the processing stall or silent response; no runtime audio workaround was added. Passing checks do not erase those failures.

No Hermes or Hindsight source, settings, images, versions, providers, or services were changed during the resumed verification/deployment work. Normal fictional memory writes used the existing test bank. Detailed deployment records, identifiers, paths, recordings, and logs remain local. Graylog receipt remains unverified.
