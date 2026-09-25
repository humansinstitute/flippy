# Flippy native protocol

The browser Native Messaging envelope is a four-byte little-endian length
followed by one UTF-8 JSON object. Browser-to-host messages contain `id`,
`method`, `{documentId, origin}` context, and `params`. Every response echoes
`id` and contains exactly one of `result` or `{error:{code,message}}`.

Operations:

- `grant.connect`, `grant.disconnect`, `document.disconnect`
- `request.open`, `request.write`, `request.finish`, `request.pull`, `request.cancel`
- `socket.open`, `socket.send`, `socket.next`, `socket.close`

Grant and resource ownership is checked again in the host. A browser broker
bug therefore cannot use another document's grant or request. Messages are
bounded to 1 MiB, upload chunks to 64 KiB, WebSocket frames to 1 MiB, and each
document to eight grants and 32 active resources.
