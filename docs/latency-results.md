# Measured latency improvements

Measured on 2026-10-01 using the existing Mac and Windows agent connection. The live conversation retained its channel generation, pairing and credentials through the server migration and deployments. Each response measurement starts before submission and stops when a matching nonce arrives on the initiating computer's monotonic clock.

| Measurement | Before | After | Samples |
| --- | ---: | ---: | --- |
| Mac-to-Windows automatic response median, US East | 233.57 ms | 114.31 ms | 20 per trial, plus 2 warmups |
| Mac-to-Windows automatic response p95, US East | 714.08 ms | 170.34 ms | Same trials |
| Actual Windows AI response median | 17.11 s | 6.82 s | 3 per trial |
| Windows pairing command, including Node boot | No controlled prior measurement | 998.39 ms | 1, peer already present |

The automatic response trial excludes AI processing. The original US East trial used `37c84b0`; the optimized trial used `c68665e`, combining inbox connection metadata and bounded lease writes. Both had zero failed exchanges. The observed median improved 51%, and p95 improved 76%.

The actual AI trial includes model scheduling, processing and tools. Background notifications required the Windows agent to read a task output file in an additional model turn; its three responses took 13.10, 17.11 and 22.44 seconds. With foreground receives and the one-process `send --ack --watch` flow from `f16231e`, responses took 6.83, 6.66 and 6.82 seconds, with no failures. The peer confirmed that each incoming page arrived directly in its PowerShell tool result and no output-file Read was needed. This is a small, observed comparison of the combined workflow; it does not establish a population p95 or isolate each factor's contribution.

The Windows startup measurement used an external `System.Diagnostics.Stopwatch` around `channel pair`, including native-command launch and Node boot. Pairing after CLI initialization took 565.17 ms, of which the word exchange and final check took 296.37 ms. The other participant was already waiting. Waiting for an absent participant and generating the agent's visible response are separate costs. A separate startup trial measured 608.93 ms after CLI initialization and a 362.23 ms word exchange.

The relay also moved from Singapore to Virginia. In a controlled Mac-to-relay-to-Mac automatic echo trial with the original compiled client retained, median response time fell from 771.42 ms to 265.31 ms; p95 fell from 799.93 ms to 356.77 ms. Each trial had 20 measured samples plus 2 warmups and no failures. These Mac-only trials are distinct from the Windows comparison above.

The implementation retains 25-second HTTP long polling, authenticated streaming uploads, checksum-verified downloads, explicit durable acknowledgments and per-device revocation. SQLite still uses `synchronous=FULL`. A 1 MiB test upload survived the regional move and subsequent deployments and downloaded byte-for-byte with the expected SHA-256. The temporary test token was revoked and then rejected with HTTP 401; its local configuration and the temporary Railway SSH key were removed.

The 64-test suite passed on Windows and macOS, with the Windows file-lock test skipped on macOS. Tests cover authentication, folder escapes, interrupted uploads, duplicate retries, offline devices, persistence, legacy relay fallback, reconnect deadlines, pairing churn, preservation of ordinary mail and recovery after a failed acknowledgment. Railway watch patterns now skip client, skill, documentation and test-only pushes. Active exchanges use a short foreground receive; idle Claude sessions return to a background watcher so the local user can continue working.
