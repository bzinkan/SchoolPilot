# ClassPilot compatibility fixtures

These fixtures preserve non-sensitive, representative request bodies from the
published protocol-v2 extension lines that SchoolPilot must continue to accept
during the protocol-v3 rollout.

| Fixture | ClassPilot source | Provenance |
|---|---|---|
| `classpilot-2.6.1.json` | `6564deb946d9df90f3ce42e6be6f7ea472f7576c` | `extension/manifest.json`; `CLIENT_PROTOCOL_VERSION`, `EXTENSION_CAPABILITIES`, `extensionProtocolDescriptor()`, registration, heartbeat, and WebSocket auth builders in `extension/service-worker.js` |
| `classpilot-2.6.9.json` | `bd2cb1d2cc5ae483318ff92ed91585a63116f5b1` | Same source locations at the exact audited 2.6.9 baseline |

The request keys and protocol values are derived from those immutable Git
objects. Identifiers, URLs, timestamps, and credentials are synthetic. In
particular, `fixture-not-a-real-token` is deliberately not a JWT or usable
credential.

The two releases intentionally have the same protocol descriptor. Compatibility
must be selected by protocol and accepted-capability intersection, never by the
extension version string. Update or add a fixture only from a named immutable
ClassPilot commit, and keep the source SHA in the fixture.
