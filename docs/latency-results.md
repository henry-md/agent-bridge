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

## Fresh agent setup

On 2026-10-01, two fresh Codex agents used separate temporary device credentials on one Mac and communicated only through the live Railway relay. They were repeated as fresh pairs while the workflow changed. The metric begins at each agent session's creation and ends once that agent has both emitted the verified secret word and started its receive. Visible word times come from the local agent rollout; receive dispatches come from a measurement-only CLI preload. The initial trial recorded the watch CLI bootstrap rather than the first HTTP dispatch, so that listener boundary is approximate by the subsequent CLI initialization time.

| Workflow | First agent complete | Second agent complete | Pair verification to receive |
| --- | ---: | ---: | ---: |
| Pair, display word, launch a separate watcher | 27.20 s | 13.84 s | 4.59–4.66 s to watcher bootstrap |
| Pair-and-watch with final short PTY polls | 21.14 s | 12.13 s | 1 ms to inbox request |

Both agents in the final trial displayed the same verified word and remained in their original receive process until a stop message crossed the bridge. Its second participant paired in 432.39 ms after CLI initialization. The earlier 1,000 ms PTY-poll trial completed in 22.90 and 11.78 seconds, with 2–3 ms between verification and receiving. Empty-input command-tool polling introduced a five-second minimum and delayed the visible word; nonempty, 250 ms PTY polls removed that tool limit. The CLI does not read stdin, and the echoed blank line is ignored. After the word, ordinary long waits resume.

These are single pairs per setting, with differing agent launch spacing and ordinary model scheduling. The final second agent was created 7.16 seconds after the first, versus 13.36 seconds initially. Measured from creation of the second agent until both were complete, the final trial took 13.98 seconds versus 13.84 seconds initially. Thus the first-agent wall-time improvement includes less waiting for its peer; it does not prove a faster relay or a lower population latency. About nine seconds still elapsed inside each fresh agent before launching the CLI. The reliable architectural change is that receiving now starts immediately after verification, without another model/tool turn.

The client change is `ff86187`; the shorter skill and polling instructions are `902af40` (mirrored as `803bce2` in codex-skills). The 67-test suite passes on Windows and macOS, with one Windows-only test skipped on macOS. New coverage checks immediate pair output, same-process receiving, preservation of queued ordinary mail, scoped setup-ack draining, attachment/mixed-page preservation, configuration changes and bounded stalled acknowledgments. The two temporary credentials were revoked after all test sessions left. Channel 1 kept its original generation and pairing throughout.
