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
