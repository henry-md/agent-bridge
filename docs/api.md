# HTTP API

All `/v1` endpoints require `Authorization: Bearer <token>`. Registration and revocation require the administrator token; other routes require a device token. `/healthz` is public. Errors return `{ "error": { "code": "...", "message": "..." } }` with an appropriate HTTP status. File IDs are UUIDs. Device names and root aliases contain letters, numbers, hyphens, or underscores (maximum 64 characters).

| Method and path | Purpose / body |
| --- | --- |
| `POST /v1/devices` | Admin registers `{name}`; returns `{device, token}` once |
| `DELETE /v1/devices/:name` | Admin revokes a device |
| `GET /v1/devices` | Returns `{devices}` with roots and online status |
| `POST /v1/heartbeat` | Connector advertises `{roots: ["alias"]}` |
| `POST /v1/messages` | `{to, text, file_ids: []}`; returns `{message}` |
| `GET /v1/messages?after=0&wait=25` | Recipient-only inbox; returns `{messages, cursor}` |
| `POST /v1/requests` | `{to, operation: "read" or "list" or "search", root, path, query?, limit?}`; returns `{request}` |
| `GET /v1/requests/:id?wait=25` | Source/target reads request status, result, or error |
| `GET /v1/connector/requests?wait=25` | Target claims a request with a fenced `lease_token`; returns `{requests}` |
| `POST /v1/requests/:id/result` | Target submits `{lease_token, result}` or `{lease_token, error: {code,message}}` |
| `POST /v1/files` | Multipart form field `file`; returns `{file}` after completion |
| `GET /v1/files` | Lists workspace attachments as `{files}` |
| `GET /v1/files/:id` | Metadata as `{file}` including size and SHA-256 |
| `GET /v1/files/:id/content` | Authenticated streamed download |
| `DELETE /v1/files/:id` | Uploader deletes an attachment |

Message and file-context submissions accept `Idempotency-Key`. Repeating a key with the same normalized payload returns the original object; different payloads conflict. Uploads do not automatically retry: a network failure after completion may require inspecting `GET /v1/files` before retrying.

`wait` is bounded to 25 seconds. Inbox reads do not delete messages. Remote request states are `pending`, `running`, `completed`, `failed`, or `expired`. Result submission requires the current lease token and target identity; file requests expire after 60 seconds. An offline target returns a clear error rather than pretending context was available.

Remote context paths are relative to a target's named shared root. Absolute host paths are not exposed in results. Text reads return source device, root, path, mtime, byte size, UTF-8 content, and `truncated`. A binary file must be explicitly uploaded as an attachment. No endpoint executes shell commands or modifies a shared folder.

## Numbered channels

Channel IDs are canonical nonnegative decimal strings (up to 64 digits); sessions and generations are UUIDs. IDs are stored as strings, so they are independent of TCP port limits and JavaScript integer precision. Every route below requires an authenticated device. A session is bound to its device, channel, and generation.

| Method and path | Purpose / body |
| --- | --- |
| `POST /v1/channels/:channel/join` | `{session_id, secret_word}`; joins or renews a two-session pairing |
| `GET /v1/channels/:channel` | Query `session_id`, `generation`, `wait`; waits for handshake status |
| `POST /v1/channels/:channel/confirm` | `{session_id, generation, pairing_id, secret_word}`; acknowledges the current shared word and peer pairing |
| `DELETE /v1/channels/:channel/sessions/:session_id` | Query `generation` and `pairing_id`; leaves this session |
| `POST /v1/channels/:channel/messages` | `{session_id, generation, text, file_ids}`; sends to the paired session, supports `Idempotency-Key` |
| `GET /v1/channels/:channel/messages` | Query `session_id`, `generation`, optional `after`, `wait`, `state=1`; returns `{messages, cursor, acknowledged_cursor}` plus `connection` when requested |
| `POST /v1/channels/:channel/ack` | `{session_id, generation, cursor}`; advances only this recipient's acknowledged cursor |

Join, confirm, and status return `{channel, generation, pairing_id, session_id, secret_word, status, peer, lease_expires_at}`. `status` is `waiting` until two active sessions acknowledge the same word, then `connected`. `peer` is `{device, session_id}` or `null`. New or replacement peers invalidate earlier confirmations and change `pairing_id`, including a peer returning with the same session ID. Delayed confirmations and active leave requests for an earlier pairing are rejected. Repeating an already-completed leave remains harmless. Sessions stay joined until they leave: the activity lease defaults to ten years and is configurable with `CHANNEL_LEASE_MS`. Joining an empty expired channel creates a fresh generation. A join from a different session on a device that is already a member replaces that device's earlier session in the same generation; the earlier session then receives `409 channel_session_replaced`. A pending message long poll also returns early, with no messages, when the pairing changes so the reader can confirm the new peer. Device revocation invalidates channel access too.

With `state=1`, the inbox includes the same connection snapshot as status, from the same transaction as the messages. It wakes immediately when this session needs to confirm an already present peer, when mutual confirmation completes, or when the pairing changes. A connected idle inbox still waits for messages. This lets a watcher receive and reconfirm without a separate status request before every poll. Watchers fall back to the older status-plus-inbox flow when a relay rejects or omits this optional metadata.

Channel messages include `id`, `seq`, `channel`, `generation`, `from`, `from_session`, `to`, `to_session`, `text`, `file_ids`, and `created_at`. They use a separate mailbox from legacy device messages. Acknowledgment is explicit and monotonic; ordinary polling resumes from the persisted acknowledged cursor. Explicit `after` is for replay and does not acknowledge delivery. Generation fencing prevents stale sessions from sending or acknowledging a later pairing. Channel numbers and words are identifiers and confirmation material, not credentials.
