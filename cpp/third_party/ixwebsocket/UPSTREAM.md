# Private IXWebSocket source

OpenAxis vendors the complete `ixwebsocket/` source directory from IXWebSocket
v11.4.6 and its unchanged `LICENSE.txt` (BSD-3-Clause). Embedded third-party
notices, including the Base64 helper's MIT license, remain in their source files.

Upstream archive:
https://github.com/machinezone/IXWebSocket/archive/refs/tags/v11.4.6.tar.gz

SHA-256: `c024334f8e45980836c67008979a884d6dcc5ef067dd2eb1fa7241f4c17ddc32`

## Local changes

- Rename the source directory to `openaxis_ixwebsocket/` and namespace `ix` to
  `openaxis_ix`. SDK implementation and transport tests use the private headers.
- Rename the embedded `macaron` namespace to `openaxis_ix_macaron` and its
  Base64 header guard to `OPENAXIS_IX_MACARON_BASE64_H_`.
- Place the otherwise global `WebSocketHandshakeKeyGen` helper in `openaxis_ix`.
  Its original zlib license notice remains in the header.
- Prefix `IXWEBSOCKET_` macros with `OPENAXIS_` so application-wide upstream
  feature definitions cannot change this copy's configuration. Also prefix
  `IX_WEBSOCKET_VERSION` with `OPENAXIS_`.
- Remove automatic `Origin` generation in `IXWebSocketHandshake.cpp`. Explicit
  extra headers still work. OpenAxis's native identity-proof request requires
  the header to be absent, not empty.
- Replace upstream's build configuration with a private static target,
  `openaxis_ixwebsocket`. Use the upstream non-TLS source list, position-independent
  code and hidden visibility where supported. TLS and compression are disabled;
  there are no install rules, downloads, or global feature/cache options.

IXWebSocket is an implementation detail, not part of the OpenAxis public API.
Do not substitute an installed IXWebSocket package. OpenAxis source archives
include this directory and its license; no separate download is needed.

## Updating

1. Download a chosen upstream release archive and record its version and SHA-256.
2. Compare the new upstream source tree with v11.4.6 (or the version recorded
   above after an update), preserving upstream copyright and license notices.
3. Import the full source directory and reapply the local changes above. Review
   changes to upstream's source list and platform libraries against our CMake file.
   Audit new namespaces, externally linked symbols and feature macros for isolation.
4. Run OpenAxis's C++ tests in Debug on Windows, macOS and Linux. The transport
   test checks that the handshake contains no Origin header. Also build a consumer
   linking both ordinary upstream IXWebSocket and OpenAxis, and verify a clean
   extracted C++ source archive builds and tests successfully.
5. Update this document and review the source diff before committing the import.
