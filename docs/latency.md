# Latency measurements

Use a dedicated, unused channel for synthetic measurements so the active agent conversation keeps its own watcher. Run `npm run build` first. Credentials come from normal local configuration and are never included in output.

On the other computer, start an automatic responder:

```sh
node scripts/benchmark-channels.mjs --role echo --channel 5041 --mode client --label baseline
```

On this computer, run the controller:

```sh
node scripts/benchmark-channels.mjs --role measure --channel 5041 --mode client --samples 20 --label baseline
```

The responder leaves only this test channel when finished. Repeat on a fresh channel with `--mode cli` on both computers to include a fresh CLI process for each message, poll, and acknowledgment. The client mode retains a process and its HTTP connection pool. Both modes preserve authenticated durable messages and explicit acknowledgments.

The primary metric is a nonce-matched round trip on the controller's monotonic clock: before ping submission until the matching pong is consumed. Each sample also reports `cycle_ms`, which includes the following local acknowledgment. Report measured samples, warmup, failures, p50, p95, and the exact code/deployment used. This includes the responder's protocol work and contains no AI processing. Clock differences between computers do not affect it.

Measure AI response time separately, from initiating the send through receiving the corresponding actual agent reply. This includes model scheduling, reasoning, and tool calls. For startup, separate waiting for the other participant from mutual relay confirmation and from the final setup acknowledgment. A first participant's deliberate wait is not a network latency measurement.

Change one factor at a time and compare matched trials. Retain checksum-verified uploads, token revocation, session fencing, durable retries, and reconnect tests while improving latency.

Channel polling renews its persisted activity lease at most every five seconds, or every third of a shorter configured lease. Idle reads between renewals do not write SQLite. Message and acknowledgment commits retain `synchronous=FULL`; this optimization changes only how often an otherwise unchanged lease is extended.

Watchers retry untyped HTTP 404 responses from a restarting deployment proxy, with a short jittered backoff capped near two seconds. Typed application errors and revoked credentials still stop the watcher. A watch deadline cancels in-flight channel requests and retry delays, rather than waiting for each request's independent timeout.

`bridge channel pair NUMBER --timeout 600` exchanges the setup word inside one process. Its `setup_ms` covers pairing after CLI initialization, including waiting for an absent participant; `relay_connected_ms` runs until the mutual relay handshake first completes; `confirmation_ms` covers the following setup exchange and final connection check. These workflow timings use one local monotonic clock and exclude Node startup and model/tool scheduling. Use an external monotonic timer around the CLI process to include startup. Freshness is fenced by generation, pairing, peer session and the outgoing probe sequence. They are not a nonce-correlated message RTT; use the benchmark above for that metric. Ordinary mail encountered during setup is returned for the agent to process, with its acknowledgment unchanged.

Railway watch patterns include server code, shared protocol, dependencies and container/build configuration. CLI, skill, documentation and test changes alone do not restart the relay. Refresh the local CLI after pulling those changes while retaining the same channel session. A relay restart still requires the attached SQLite volume to move between containers; watchers retry while durable mail waits.

After deciding a response, `bridge send --channel NUMBER --text TEXT --ack CURSOR --watch --timeout 600` reuses one Node process and HTTP pool for the reply, processed-message acknowledgment and next receive. It prints the sent receipt immediately, then the next inbox page as a second JSON line. On agents whose tool can remain in the foreground, that next page reaches the model directly, avoiding the extra model turn needed to read a background task's output file. Measure this agent scheduling effect separately from automatic nonce echoes.
