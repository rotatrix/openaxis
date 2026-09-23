# OpenAxis Protocol Specification

* **Status:** OpenAxis 1.0 Release Candidate 1
* **Date:** 2026-09-10
* **Integration scope:** Compatible application clients. Applicable server
  rights are reserved; document reuse is dual-licensed under ELv2 or GPLv3 (see [Legal Notice](#legal-notice)).

## Abstract

OpenAxis is the publicly documented Rotatrix integration protocol: a local,
bidirectional WebSocket protocol for continuous multi-parameter input. It
offers Axis Streaming for applications that consume mapped rate controls and
Navigation as an additional spatial layer for consistent server-computed
camera and object control across CAD and 3D applications. This document defines
the wire format, message ordering, extension rules, requirements for compatible
application clients, and the observable behavior of the OpenAxis server.

## 1. Introduction

OpenAxis is a local WebSocket protocol between an input server and application
clients. It exposes two complementary interfaces:

- **Axis Streaming** sends named, gain-mapped device rates for general
  continuous application control. It is the small interface for clients that
  want to interpret the input themselves.
- **Navigation** adds spatial interpretation for CAD and 3D applications. It
  sends server-computed camera and object poses; the client reports facts about
  its document and viewport, while the server owns navigation policy and math.

The interfaces share the same server configuration, mappings, tags, motion
lifecycle, and transport. A client may use either or both. Navigation includes
camera control, pivot selection, and object manipulation; these are not
separate protocols.

### 1.1. Interfaces

Axis Streaming supplies mapped input rates; Navigation exchanges scene facts
and camera or object poses. A Navigation client does not need to subscribe to
Axis Streaming. A connection MAY implement both interfaces.

For application selection guidance, see
[Choosing an interface](docs/src/content/docs/index.md).

### 1.2. Scope and non-goals

OpenAxis specifies communication between an input server and application
clients. It does not specify device discovery, hardware reports, calibration,
the server's configuration UI, or application-specific scene APIs. It also
does not standardize the server policy that selects profiles, navigation modes,
pivot priorities, or mappings; it standardizes the messages through which that
policy observes an application and controls supported targets.

OpenAxis 1.0 is designed for trusted local-machine use. Remote deployment,
cross-machine discovery, user authentication, and authorization are outside its
scope. The security consequences of that limited deployment model are stated
in Section 12.

### 1.3. Typical sessions

An Axis Streaming client subscribes once, then receives rate frames during
each motion gesture:

```text
Client                                      Server
  |--- hello --------------------------------->|
  |<------------------------------- hello_ack--|
  |--- tags ----------------------------------->|
  |--- subscribe ------------------------------>|
  |<------------------------------------- axes--|
  |<----------------------------- motion_start--|
  |<----------------------------------- frame*--|
  |<------------------------------- motion_end--|
```

A Navigation client declares its capability. At each gesture, the server asks
for the application facts required by its current policy before streaming
poses:

```text
Client                                      Server
  |--- hello --------------------------------->|
  |<------------------------------- hello_ack--|
  |--- tags, capabilities -------------------->|
  |<----------------------------- motion_start--|
  |<-------------------- navigation.query RPC--|
  |--- response ------------------------------>|
  |<------------------------- navigation.state--|
  |<----------------------------- camera.pose*--|
  |<------------------------------- motion_end--|
```

Tags and capabilities MAY be sent in either order after `hello_ack`. A client
using both interfaces also sends `subscribe`; Axis frames MAY begin while the
Navigation query is still pending.

## 2. Conformance and terminology

### 2.1. Requirements language

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**,
**SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **NOT RECOMMENDED**, **MAY**, and
**OPTIONAL** in this document are to be interpreted as described in BCP 14
[RFC2119] [RFC8174] when, and only when, they appear in all capitals.

Examples and session diagrams are informative unless accompanying text says
otherwise. If an example conflicts with normative prose or a field table, the
normative prose or table takes precedence.

Paragraphs and subsections labeled **Implementation note** are informative.
They offer integration guidance but do not add conformance requirements.

### 2.2. Client conformance and server guarantees

Client conformance is claimed per role:

| Role | Required behavior |
|---|---|
| Axis Streaming client | Subscribes to named axes and processes `axes`, `frame`, and motion lifecycle messages. |
| Navigation client | Declares the `navigation` capability, answers supported facts requested through `navigation.query`, and applies at least one supported pose target. |
| Commands client | Declares the `commands` capability, executes supported named commands, and rejects unknown names with `unsupported`. |

Normative server requirements define the externally observable guarantees that
compatible clients may rely upon from the Rotatrix server. These requirements
describe protocol behavior; they do not grant a server-implementation patent
license. See the [Legal Notice](#legal-notice).

A client MAY implement more than one role on one connection. The server sends
Axis Streaming output only after `subscribe`, Navigation output only after the
client declares `navigation`, and `command.execute` only after the client
declares `commands`. The legacy `buttons` message is independently optional.

### 2.3. Terminology

| Term | Meaning |
|---|---|
| server | The process that owns the input device, user mappings, and Navigation policy. |
| client | An application integration connected to the server. |
| active client | The one connected client currently receiving active input. |
| gesture | One server-identified interval of related input, begun by `motion_start` and ended by the next `motion_start`, the matching `motion_end`, or connection loss. |
| target | A camera or object whose pose the server may control. |
| fact | Application state returned as a value from `navigation.query`. |
| pose | A complete target pose in client world coordinates. |
| delta | Independent world-space position and orientation increments applied to current server state. |

## 3. Transport and connection

### 3.1. Endpoints

The default native endpoint is `ws://localhost:6607`. A server MAY also expose
the protocol over TLS for browser clients; the default endpoint, when enabled,
is `wss://localhost:6609`. OpenAxis assumes a trusted localhost connection; it
does not define authentication or authorization.

### 3.2. Framing and common types

OpenAxis uses WebSocket [RFC6455]. Each OpenAxis message is exactly one
MessagePack map carried in one WebSocket binary message. A top-level map MUST
contain a string `type`. Text WebSocket messages are not OpenAxis messages.

Unless a field definition says otherwise:

- strings are MessagePack strings;
- identifiers, sequence numbers, and integer timestamps are MessagePack integers
  in the inclusive range 0 through 2^53 − 1 (9007199254740991);
- numeric geometry values may use MessagePack integer or floating-point
  encodings but MUST be finite; and
- arrays have the exact lengths stated by their definitions.

A receiver MUST ignore unknown fields and unknown top-level message types.
Unknown RPC methods receive an `unsupported` response instead. This is the
primary forward-compatibility rule: new optional facts and server functions do
not require changes to unrelated clients.

OpenAxis 1.x MAY add optional fields, message types, RPC methods, query names,
capabilities, commands, and axis names under those rules. It MUST NOT change
the meaning or required shape of a 1.0 item. Such a change requires a new major
protocol version.

### 3.3. Version negotiation

Published specification revisions use major.minor.patch numbering. Patch
revisions clarify the existing contract without changing its requirements;
minor revisions add backward-compatible extensions; major revisions change
existing wire requirements or semantics incompatibly. SDK package versions
evolve independently of these specification revisions.

`openaxis/1.0` identifies the OpenAxis 1.x wire-compatibility series.
Backward-compatible specification revisions MUST retain this identifier. A new
identifier is used only for a wire-incompatible major revision (for example,
`openaxis/2.0`). SDK package versions and specification minor revisions are
independent of this identifier. Acceptance does not imply support for optional
extensions; peers use capability declarations and `unsupported` RPC responses.

Senders MUST NOT emit identifiers or counters outside the range in Section 3.2.
Monotonic counters MUST NOT wrap within their defined scope. On exhaustion,
the sender MUST stop the affected operation without emitting an out-of-range
value. An active Navigation gesture whose delta counter is exhausted MUST be
cancelled; starting another gesture does not reset a connection-scoped counter.
A new connection is required to reset connection-scoped counters.
RPC identifiers MAY be reused only when they
cannot be confused with an outstanding request or a late response.

#### `hello` (Client → Server)

The first message on a connection:

```javascript
{
  "type": "hello",
  "proto": "openaxis/1.0",
  "client_name": "Example CAD",
  "client_version": "2.3.4",
  "sdk": { "name": "openaxis-csharp", "version": "1.0.0" },
  "target": { "pid": "18432", "app": "Inventor", "app_version": "2027.1" }
}
```

`client_version`, `sdk`, and `target.app_version` are OPTIONAL diagnostic metadata.
`client_version` identifies the integration/plugin release; `target.app_version`
identifies the application receiving input. Integrations SHOULD provide both
when available; they MAY be identical for a built-in integration. SDK clients
SHOULD populate `sdk` automatically from their own release metadata. When `sdk`
is present, it MUST be a map containing non-empty string `name` and `version`.
Version fields MUST be non-empty strings, are opaque, and have no standardized
ordering or semantic-version interpretation. Unavailable values SHOULD be
omitted rather than replaced by placeholders. These self-reported values MUST
NOT be used for authentication or target identity matching, and MUST NOT be
interpreted as capability declarations. Unknown fields in these maps are ignored.

`target` is OPTIONAL. It describes the application that receives input, which
may differ from the process hosting this connection. `pid`, when present, MUST
be a canonical string identifying that target process: on Linux,
`<pid-namespace-inode>:<namespace-local-pid>`; on Windows and macOS, `<pid>`.
Each component MUST contain ASCII decimal digits, start with 1–9, and have no
leading zeros, whitespace, sign, or OS prefix. Numeric wire values are invalid.
Linux SDK helpers read the namespace inode from `/proc/self/ns/pid` and the PID
from the operating system. Servers compare the foreground process's namespace
and its PID in that namespace, not the host-visible PID alone. Identities are
scoped to one running OS/kernel, are not authentication credentials, and may be
reused after process exit. Servers MUST invalidate cached identities when the
process exits and MUST NOT reinterpret an unresolved Linux identity as a host PID.
SDK helpers MUST report failure if identity cannot be determined; browser clients
omit `pid` rather than inventing an OS process identity. A server MUST NOT compare it with a local foreground PID when the
target application is on another machine. `app`, when present, MUST be a
non-empty application identifier suitable for comparison with the server's
foreground application identifier; it is not a window title or `client_name`.
At least one of `pid` or `app` MUST be present if `target` is present.

The client fixes its target declaration for this connection; to change it, the
client reconnects with a new `hello`. Omitting `target` does not request
background control. A server MAY use target identity to select a recipient for
exclusive control. Selection policy is implementation-specific. When both
identifiers are available for comparison, a known PID mismatch MUST NOT be
overridden by an `app` match.

#### `hello_ack` (Server → Client)

```javascript
{
  "type": "hello_ack",
  "proto": "openaxis/1.0",
  "server_name": "rotatrix-core"
}
```

The server rejects a protocol version it does not support with `error`.

The server MUST NOT process any other OpenAxis message before accepting
`hello`. After `hello_ack`, either peer may send messages permitted by the
connection state and the interfaces enabled by the client.

### 3.4. Liveness

#### `heartbeat` (Client → Server)

```javascript
{ "type": "heartbeat" }
```

Clients SHOULD send a heartbeat every 1–2 seconds while otherwise idle. Any
message counts as activity. A server MAY drop a silent connection; the
reference timeout is 5 seconds.

### 3.5. Uncorrelated errors

#### `error` (Either direction)

```javascript
{
  "type": "error",
  "code": "bad_request",
  "message": "human-readable detail"
}
```

An `error` is for a message-level or connection-level failure. RPC failures use
the correlated `response.error` form below.

## 4. Context and capability declaration

### 4.1. `tags` (Client → Server)

```javascript
{
  "type": "tags",
  "tags": ["app.blender", "workspace.modeling", "interaction.object.translate"]
}
```

Tags are a full replacement set of low-cardinality current context facts and
discrete user preferences. The server reevaluates its policy whenever they
change. Tags do not select an authoritative camera mode or controlled target.
Server policy may respond to a tag by controlling the camera, an object, both,
or neither.

Names are open-ended. Recommended conventions include:

- `app.<name>`
- `viewspace.2d` for a view restricted to fixed-orientation pan/zoom; this tag
  carries the client requirements in §8.1.1, not just a naming convention
- `workspace.modeling`, `workspace.drawing`, `workspace.sketch` for workflow context
- `interaction.object.translate`, `interaction.object.rotate`
- `navigation.hint.orbit`, `navigation.hint.free_camera`

The navigation hint tags are mutually exclusive and report an
application-facing user preference. Server policy MAY honor or override that
preference. The effective mode is reported by `navigation.state`.

`viewspace.2d` is independent of workspace naming: a drawing or sketch
workspace may still expose a 3D-capable view, while another kind of workspace
may contain a 2D-only viewport.

An application entering a grab/translate/rotate interaction SHOULD update its
tags immediately. Server policy MAY begin a motion gesture from that context
transition, so an application-originated interaction can activate Navigation
without inventing a client-selected mode.

`interaction.object.translate` and `interaction.object.rotate` mean that the
application has a live object-transform target and that the current interaction
permits the corresponding component. Both tags may be present. They neither
identify the target nor request object output: the target is bound through
`object.pose`, and server policy may drive the object, the camera, both, or
neither.

High-cardinality identity and changing measurements do not belong in tags.
They are returned as queried Navigation facts.

### 4.2. `focus` (Client → Server)

A client that can observe whether the application, document, or viewport it
controls has input focus MAY report that state:

```javascript
{ "type": "focus", "focused": true }
```

`focused` MUST be a boolean. A connection's focus state is unknown until its
first `focus` message and is cleared when the connection closes. The client
SHOULD send its current state after `hello_ack` and MUST send a new message
when that state changes. A client MUST NOT report `true` merely because it is
connected; it must have a focus signal from the target application. A server
MAY use a unique positive focus declaration to select exclusive control when
foreground process identity cannot select a recipient. Multiple positive
declarations do not imply an ordering; a server SHOULD select no recipient
until the ambiguity is resolved. This message does not request background
control and is independent of application context tags. A known local target
PID mismatch still excludes the connection even if it reports focus.

### 4.3. `capabilities` (Client → Server)

```javascript
{
  "type": "capabilities",
  "capabilities": ["navigation", "commands"]
}
```

Capabilities describe protocol interfaces the client implements:

| Capability | Meaning |
|---|---|
| `navigation` | Can answer Navigation queries and apply Navigation messages. |
| `commands` | Can execute named `command.execute` requests. |

All are optional. Axis Streaming is enabled separately by `subscribe`. New
optional query names under an existing capability do not require another
capability token. Camera and object support are discovered from the availability
of `camera.pose` and `object.pose`: the server MUST NOT stream a target whose
initial pose the client could not provide.

Each `capabilities` message is a full replacement set; omission of a previously
declared capability removes it. Order and duplicates have no significance.
Clients SHOULD normally declare capabilities once after `hello_ack`, but MAY
replace them later. An identical set MUST NOT interrupt an active gesture.
When a changed set arrives during a gesture, the server MUST retire that gesture
before emitting output under the new set, by sending its `motion_end` or a
replacement `motion_start`. It MUST cancel pending Navigation work for the old
gesture and ignore late results. Clients MUST continue accepting already-sent
messages until that lifecycle boundary. Already-issued command requests retain
their normal response/error lifecycle; removal of `commands` prevents new
command requests and does not cancel requests already dispatched.

## 5. Correlated requests

OpenAxis uses a small RPC envelope for information or work that one peer needs
from the other. It avoids implicit association between unrelated messages and
also avoids defining a new message pair for every future server function.

### 5.1. `request` (Either direction)

```javascript
{
  "type": "request",
  "id": 17,
  "method": "navigation.query",
  "params": { ... }
}
```

### 5.2. `response` (Either direction)

Successful response:

```javascript
{
  "type": "response",
  "id": 17,
  "result": { ... }
}
```

Failed response:

```javascript
{
  "type": "response",
  "id": 17,
  "error": {
    "code": "unsupported",
    "message": "optional detail"
  }
}
```

`id` is chosen by the requester and is unique among that peer's outstanding
requests. Exactly one of `result` or `error` MUST be present. Requests and
responses may be interleaved with streaming messages. The responder SHOULD
preserve request order where its application threading model requires it, but
correlation does not depend on ordering.

Every Navigation client MUST answer `navigation.query`. The generic envelope
is intentionally usable by later methods and by named commands.

## 6. Protocol lifecycle

### 6.1. Active client

Multiple clients may connect. A server MAY select zero or one connection to
receive an exclusive control stream, using target identity and foreground
application state. Merely connecting or subscribing does not grant exclusive
control. The selection algorithm is implementation policy and is not
represented on the wire. Context tags describe a connection's application
state; they do not identify its target process. A server may use the selected
connection's tags when resolving input mappings.

When active control changes, the server ends motion on the old client before
starting it on the new one. Each new motion gesture has a distinct
`gesture_id`, allowing clients to reject Navigation output associated with an
old document, viewport, selection target, or interaction.

Selecting a connection does not itself require a Navigation gesture. A server
starts one when its current input mapping enables Navigation; non-Navigation
input such as scrolling or button delivery does not by itself require one.
This does not preclude a server policy that begins a Navigation gesture on an
application context transition as described in Section 4.1.

Exclusive control selection does not restrict independent subscriptions or
explicitly selected background recipients. This version does not define a
request for background control.

### 6.2. Connection and gesture states

| State | Entered by | Permitted activity | Leaves by |
|---|---|---|---|
| Awaiting hello | WebSocket opens | Client sends only `hello`. | Accepted `hello` enters Idle; rejection or transport loss enters Closed. |
| Idle | `hello_ack` or completed gesture | Context declarations, subscriptions, heartbeats, `viewport.settled`, and RPC without gesture-scoped Navigation output. | `motion_start` enters Gesture active. |
| Gesture active | `motion_start` | Context declarations and `viewport.settled` remain permitted. Axis frames may stream immediately; Navigation queries and ready target streams may proceed independently. | A new `motion_start` atomically replaces the active gesture; the matching `motion_end` enters Idle; connection loss enters Closed. |
| Closed | WebSocket closes | No protocol activity. | New WebSocket connection. |

Within an active gesture, each Navigation target is independently **waiting**
until the server receives the required query facts, **streaming** once ready,
or **unavailable** when the client omitted its required pose. The server MUST
NOT stream a target while it is waiting or unavailable.

### 6.3. Motion lifecycle messages

#### `motion_start` (Server → Client)

```javascript
{ "type": "motion_start", "gesture_id": 73 }
```

The server decides when a gesture begins. Common triggers are entering a
device mode, the first non-zero input under an always-on policy, or a policy
transition caused by application context tags.

If the client already has an active gesture, a new `motion_start` atomically
ends that gesture and starts the new one. The server does not send
`motion_end` for the superseded gesture. This restart represents continuous
input whose routing or Navigation policy changed; it does not imply that the
physical motion stopped. The client MUST immediately reject queued or later
messages carrying the superseded `gesture_id`.

Axis frames may begin immediately. Navigation pose output begins only when the
server has obtained enough state through `navigation.query`.

`gesture_id` is a server-chosen integer that increases monotonically for the
connection and is never reused. Every gesture-scoped Navigation request, pose,
delta, and pivot carries it. When answering the initial query, the client binds
the ID to its current local document, viewport, and camera or object target.
Before applying a Navigation pose, the client MUST verify that the ID is still
active and that the bound local context is still current.

#### `motion_end` (Server → Client)

```javascript
{ "type": "motion_end", "gesture_id": 73 }
```

Stops Axis Streaming and Navigation output for the gesture. The client SHOULD
hide transient navigation indicators. The server sends `motion_end` when the
motion actually stops or the active client loses control. It MUST identify the
currently active gesture; a client MUST ignore an end for any other ID.

#### `motion_cancel` (Client → Server)

```javascript
{
  "type": "motion_cancel",
  "gesture_id": 73,
  "reason": "context_changed"
}
```

If the bound local context changes during a gesture, the client MUST stop
applying its Navigation output and send `motion_cancel`. The server stops that
gesture and sends the matching `motion_end`. If input remains active, it may
start a new gesture with a new ID and query the new context. `reason` is an
optional diagnostic string.

## 7. Axis Streaming

### 7.1. Convention and units

The server's logical coordinate convention is right-handed: `+x` right, `+y`
up, and `-z` forward. The server applies the user's device calibration, axis
mapping, and gains before streaming.

OpenAxis 1.0 standardizes six logical rate axes:

- `tx`, `ty`, `tz`: ball rates mapped to logical translation controls
- `rx`, `ry`, `rz`: ball rates mapped to logical rotation controls

Every value is a gain-mapped **ball angular rate in radians per second**. In
particular, `t*` does not mean metres, document units, or scene distance per
second. An Axis Streaming client integrates `value * dt` to obtain device
travel and chooses how that travel affects its application. This single unit
keeps integrations independent of document scale.

### 7.2. `subscribe` (Client → Server) and `axes` (Server → Client)

```javascript
{
  "type": "subscribe",
  "axes": ["tx", "ty", "tz", "rx", "ry", "rz"]
}
```

The server confirms the effective order:

```javascript
{
  "type": "axes",
  "axes": ["tx", "ty", "tz", "rx", "ry", "rz"]
}
```

The client MAY resubscribe at any time. Unsupported names MUST remain in the
confirmed order and produce zero unless their extension defines another
behavior.

### 7.3. `frame` (Server → Client)

```javascript
{
  "type": "frame",
  "seq": 12345,
  "t_us": 1234567,
  "values": [0.1, 0.0, -0.3, 0.0, 0.5, 0.0]
}
```

- `values` matches the last confirmed `axes` order.
- `seq` increases monotonically; clients SHOULD discard older frames.
- `t_us` is monotonic microseconds since server start. Compute
  `dt = (t_us - previous_t_us) / 1_000_000`.

## 8. Navigation

Navigation centralizes camera, pivot, and object behavior in the server. A
client is a sensor and actuator: it answers queries using its application API,
applies pose streams, and renders optional feedback. It does not choose the
authoritative camera mode, pivot priority, constraints, or translation
policy. Client-reported preferences and scale are inputs to that server policy,
not commands that the server must honor.

### 8.1. Navigation data model

All Navigation vectors, points, bounds, and poses are expressed in the client's
world coordinate system. The client reports that system through the required
`world.orientation` query value; the server returns poses in the same system.

A `vec3` is a three-element numeric array `[x, y, z]`. An AABB is
`{min: vec3, max: vec3}`. All numeric geometry values MUST be finite.

A pose contains:

- `t`: position in client world coordinates, as a `vec3`;
- `r`: orientation rotation vector `[rx, ry, rz]`, whose direction is the
  rotation axis and whose magnitude is the angle in radians.

Rotation vectors use the ordinary right-handed exponential map on their
numeric components, including when the client world is left-handed. Let
`A = Exp(r)` be that proper 3×3 rotation matrix and let `h` be `+1` for a
right-handed client world or `-1` for a left-handed client world.

For a camera pose, `A` and `h` define the camera axes in client coordinates:

```text
camera_right    = h * A * [1, 0, 0]
camera_up       =     A * [0, 1, 0]
camera_backward =     A * [0, 0, 1]
camera_forward  = -camera_backward
```

The semantic camera frame is therefore always right-handed: `+X` is screen
right, `+Y` is screen up, and `+Z` is backward. For a left-handed client,
`A` is the proper-rotation factor of the full camera-to-world transform;
`world.orientation.handedness` supplies the reflection that a rotation vector
cannot represent.

An eye/target/up client can construct `A` entirely in its own numeric
coordinates. Normalize `backward = eye - target`, orthogonalize and normalize
`up` against it, compute `x = up × backward` using the ordinary right-handed
numeric cross product, and form `A` with columns `[x, up, backward]`. This same
construction works for either client handedness; in a left-handed world `x`
is the negative of semantic screen-right. Client APIs that expose a native
camera quaternion or matrix MUST convert it to this representation when their
local-axis or handedness convention differs.

OpenAxis defines two camera Navigation modes:

- `orbit`: pivot-relative camera control. Rotation moves the camera about an
  authoritative server-selected pivot; three-axis translation changes the
  camera's relation to that pivot.
- `free_camera`: camera-relative spatial control without a pivot. Rotation is
  about the camera and translation moves the camera through the scene.

Object manipulation is orthogonal to camera mode. Server mappings may drive an
object, the camera, or both; object control may therefore remain active while
the camera uses either `orbit` or `free_camera`. Object translation and
rotation are normally interpreted relative to the current camera frame, while
object poses, deltas, and pivots remain expressed in client world coordinates.
Ground-plane translation and horizon locking are independent free-camera
preferences or server constraints.

OpenAxis does not assign a semantic Front view to the identity rotation. For a
camera, `r = [0, 0, 0]` means the numeric basis alignment defined above and
need not look along `world.orientation.forward`. An object's identity
orientation remains specific to the bound application target. Implementations
compose orientations as rotations, not by adding rotation-vector components.

Every `camera.pose`, whether a nested query value or a top-level message, MUST
contain exactly one projection:

- `fov`: vertical perspective field of view in radians; or
- `ortho_extent`: full visible vertical world-space extent in the client's
  scene units (`top - bottom`).

`ortho_extent` is not a client application's zoom factor. Clients MUST derive
it from their actual model-to-viewport transform. Navigation translations are
returned in the same scene units as `t` and the reported extents.

For native projection conversion guidance, see
[Coordinates and camera poses](docs/src/content/docs/concepts/coordinates.md#projection-describes-the-rendered-view).

`viewport.aspect` is the positive, finite ratio of the renderable camera
viewport's width to its height. It is dimensionless and does not imply a pixel
coordinate system. Together with the vertical `fov` or `ortho_extent`, it
defines the corresponding horizontal field of view or visible extent.

#### 8.1.1. 2D viewports

A client MUST report `viewspace.2d` only for a viewport restricted to
fixed-orientation camera pan/zoom. The viewport may have any orientation in
client world coordinates; it need not face the world XY plane. Editing a
sketch or using an orthographic camera alone does not imply `viewspace.2d`:
a viewport that permits camera rotation remains a 3D-capable view.

This version supports orthographic camera navigation for `viewspace.2d`.
Clients reporting the tag MUST provide `ortho_extent`, not `fov`, in camera
snapshots and MUST supply `viewport.aspect` when queried. Support may be
extended to perspective 2D viewports in a future version.

The camera orientation defines the view-plane directions. Together with
`ortho_extent` and `viewport.aspect`, it supplies the projection needed for
camera pan/zoom without identifying a physical drawing plane or its depth.
Clients are not required to supply `sketch.plane` or a drawing-plane origin
for this purpose. They MAY supply `viewport.cursor` when queried, as defined
in §8.2.

### 8.2. `navigation.query` (Server → Client)

The method batches two kinds of query:

```javascript
{
  "type": "request",
  "id": 21,
  "method": "navigation.query",
  "params": {
    "gesture_id": 73,
    "values": [
      "document.id",
      "world.orientation",
      "camera.pose",
      "viewport.aspect",
      "navigation.translation_scale",
      "navigation.preferences",
      "selection.bounds",
      "model.bounds"
    ],
    "first": [
      "pick.cursor.selection",
      "pick.viewport_center.selection",
      "pick.cursor",
      "pick.viewport_center"
    ]
  }
}
```

- Every name in `values` is evaluated independently. These are facts the
  server wants even if they do not supply the pivot.
- Names in `first` are evaluated in order. Evaluation MUST stop as soon as one
  produces a value. This is how expensive picks short-circuit without
  putting pivot policy in the client.
- An unsupported or currently unavailable value is omitted. Unavailability of
  an individual name is not an RPC error.
- The server MAY omit either list. It MAY issue another query before streaming
  or later in the gesture. For example, a future policy may first inspect model
  and viewport extents, then decide whether any pick is needed.

The server MUST include `gesture_id` when the result will supply facts for an
active gesture. It identifies the gesture whose bound local context the
returned facts describe; the client cancels rather than answering if that
context is no longer current.

The server MAY omit `gesture_id` when a query is not associated with a gesture.
The client evaluates such an unscoped request from its current application
state. The result is not bound to a gesture and does not by itself authorize
gesture-scoped Navigation output.

Response:

```javascript
{
  "type": "response",
  "id": 21,
  "result": {
    "values": {
      "document.id": "opaque-document-id",
      "world.orientation": {
        "forward": [0, 0, -1],
        "up": [0, 1, 0],
        "handedness": "right"
      },
      "camera.pose": {
        "t": [x, y, z],
        "r": [rx, ry, rz],
        "ortho_extent": 10.0
      },
      "viewport.aspect": 1.7777778,
      "navigation.translation_scale": 5.0,
      "navigation.preferences": {
        "lock_roll": true,
        "lock_translation_plane": true
      },
      "selection.bounds": {
        "min": [x, y, z],
        "max": [x, y, z]
      },
      "model.bounds": {
        "min": [x, y, z],
        "max": [x, y, z]
      }
    },
    "first": {
      "name": "pick.cursor.selection",
      "value": {
        "point": [x, y, z],
        "bounds": {
          "min": [x, y, z],
          "max": [x, y, z]
        }
      }
    }
  }
}
```

For application-thread capture and lazy fact resolution, see the
[query-handling guide](docs/src/content/docs/guide/picking-pivots.mdx#query-handling).

If the request included `first`, `result.first` is `null` when none resolves.
If the request omitted `first`, the response MAY omit `result.first`. The
server determines query order from its configuration. Locked pivot, last-used
pivot, world origin, and other server-known terminal values are never query
names: they remain entirely on the server.

#### Standard value shapes

| Query name | Value | Requirement |
|---|---|---|
| `document.id` | Opaque string stable for the open document | Optional; scopes server caches only. |
| `world.orientation` | `{forward, up, handedness}` | Required for Navigation; vectors are in client coordinates. |
| `camera.pose` | `{t, r, fov}` or `{t, r, ortho_extent}` | Required for camera navigation and as view reference for object navigation. |
| `viewport.aspect` | Positive width-to-height ratio | Required when queried for `viewspace.2d`; otherwise optional. Completes the viewport projection without introducing pixel units. |
| `viewport.cursor` | `{x, y}` normalized viewport coordinates | Optional; cursor position within the renderable camera viewport. Omit when outside or unavailable. |
| `navigation.translation_scale` | Positive finite number in client world units | Optional; application-provided translation scale, principally for `free_camera`. |
| `navigation.preferences` | `{lock_roll?, lock_translation_plane?}` booleans | Optional client preferences for free-camera constraints; explicit server policy may override either value. |
| `object.pose` | `{t, r}` | Required when manipulating the current logical object target. |
| `selection.bounds` | `{min, max}` world-space AABB | Optional. Omit for no selection. Allows the server to derive selection-center and viewport-intersection policy. |
| `model.bounds` | `{min, max}` world-space AABB | Optional; supports server-side model-center and viewport-intersection policy. |
| `object.bounds` | `{min, max}` world-space AABB | Optional; bounds of the same target as `object.pose`. |
| `camera.view_target` | World-space vec3 | Optional. |
| `scene.cursor` | World-space vec3, e.g. Blender's 3D cursor | Optional. |
| `sketch.plane` | `{origin, normal, x_axis?}` in world space | Optional; active drawing plane. |
| `pick.cursor.selection` | `{point, bounds?}` | Optional; nearest visible cursor pick restricted to selected geometry. |
| `pick.viewport_center.selection` | `{point, bounds?}` | Optional; nearest visible viewport-center pick restricted to selected geometry. |
| `pick.cursor` | `{point, bounds?}` | Optional; nearest visible cursor pick. |
| `pick.viewport_center` | `{point, bounds?}` | Optional; nearest visible viewport-center pick. |

For mapping native world conventions, see
[Coordinates and camera poses](docs/src/content/docs/concepts/coordinates.md).

`viewport.cursor` uses two-dimensional normalized device coordinates (NDC):
the viewport center is `(0, 0)`, bottom-left is `(-1, -1)`, and top-right is
`(1, 1)`. Each component MUST be finite and within `[-1, 1]`; positive X is
screen-right and positive Y is screen-up, regardless of the client's world
handedness or native pixel-coordinate convention. Each axis is normalized
independently over the same renderable camera viewport used for
`viewport.aspect`, excluding surrounding application UI. No pixel dimensions
or DPI information are transmitted.

Clients MUST report the fact as unavailable when the cursor is outside that
viewport or its position cannot be determined, rather than clamping it to an
edge or substituting the center. Like other query facts, it is a snapshot of
the queried viewport; it does not introduce continuous cursor reporting or
require updates during a gesture. It is available to both 2D and 3D clients
and does not require a geometry hit. It is distinct from `scene.cursor`, which
is a world-space scene point.

`navigation.translation_scale` is deliberately independent of any particular
device motion or rotational unit. It supplies a characteristic translation
distance in the client's world coordinate system; server policy defines how it
scales mapped input. Rotatrix-specific scaling policy is described in the
[free-camera guide](docs/src/content/docs/guide/free-camera.mdx#translation-distance).

`navigation.preferences.lock_roll` requests that the camera remain upright
relative to `world.orientation.up`.
`navigation.preferences.lock_translation_plane` requests that free-camera
translation remain parallel to the ground plane perpendicular to that up
direction. They are user preferences, not authoritative constraints. For
refreshing facts after native preference changes, see
[Settings and controls](docs/src/content/docs/experience/settings.md).

`document.id` is intentionally not a revision or epoch. When it changes, the
server clears document-scoped state such as last-used and locked camera pivots.
If a client cannot provide it, such state is scoped to the connection and may
be cleared conservatively on a relevant tag change.

In a pick result, `point` is on the nearest visible applicable surface at the
specified viewport location. The optional `bounds` is the world-space AABB of
the application's smallest meaningful independently transformable object or
body containing that same hit. It MUST describe the same hit as `point`; omit
it when the application has no such enclosing target or cannot determine its
bounds. `.selection` variants restrict hits to selected geometry, but their
optional `bounds` still describes the hit object or body rather than the whole
selection. Apply that restriction before nearest-hit ordering: unselected
geometry is outside the candidate set and does not occlude a selected hit.

Pick results describe the queried snapshot; the server requests a new snapshot
through a new query. Within the applicable candidate set, back faces of closed
solids should not win through foreground geometry. For native hit testing and
construction-plane support, see
[Choosing a native picking operation](docs/src/content/docs/guide/picking-pivots.mdx#choosing-a-native-picking-operation).

### 8.3. `viewport.settled` (Client → Server)

```javascript
{ "type": "viewport.settled" }
```

A Navigation client MAY send `viewport.settled` when it observes that changes
to the active viewport have settled. It MAY send the message again after later
viewport changes settle. The message does not change the connection or gesture
state.

Some applications cannot obtain every viewport-derived fact quickly enough on
the motion-start path. This optional notification allows the server to prepare
for later Navigation work while the viewport is settled, without assigning the
choice of facts or Navigation policy to the client.

### 8.4. `navigation.state` (Server → Client)

After resolving the initial query values and server policy, the server sends
the effective Navigation state for the gesture before its first Navigation
pose:

```javascript
{
  "type": "navigation.state",
  "gesture_id": 73,
  "camera": {
    "mode": "free_camera",
    "lock_roll": true,
    "lock_translation_plane": false,
    "translation_scale": 5.0
  },
  "object": {
    "allow_translation": false,
    "allow_rotation": true
  }
}
```

`camera` is present when server policy actively controls the camera. Its
`mode` is either `orbit` or `free_camera`. Free-camera state MUST include both
effective `lock_roll` and `lock_translation_plane` booleans. If the server uses
an application translation scale, `translation_scale` is the effective base
scale in client world units before per-axis mappings and gains; otherwise it is
omitted. Orbit omits the free-camera-only fields.

`object` is present when server policy actively controls the bound object
target. `allow_translation` and `allow_rotation` report the effective component
constraints.

The server MUST send exactly one `navigation.state` for a gesture that produces
Navigation pose output, after it has obtained the values needed to resolve that
state and before the first pose. The state is immutable for its `gesture_id`.
If the effective camera mode, target set, constraints, or base translation
scale changes, the server begins a replacement gesture.

This message reports resolved behavior after client preferences, mode defaults,
and server profile or active-binding overrides. Clients MAY display it but
MUST apply the pose and pivot messages they actually receive rather than
implementing the reported behavior themselves.

### 8.5. `camera.pose` (Either direction)

```javascript
{
  "type": "camera.pose",
  "gesture_id": 73,
  "seq": 204,
  "t": [x, y, z],
  "r": [rx, ry, rz],
  "ortho_extent": 10.0
}
```

| Sender | Meaning |
|---|---|
| Server | Computed absolute camera pose stream. |
| Client | Absolute rebase after a discontinuity such as a bookmark or projection-type change. |

Field requirements depend on direction:

| Field | Server | Client |
|---|---|---|
| `type` | `"camera.pose"` | `"camera.pose"` |
| `gesture_id` | Required | Required |
| `seq` | Required | Omitted |
| `t`, `r` | Required | Required |
| Exactly one of `fov`, `ortho_extent` | Required | Required |
| `applied_delta_id` | Conditional | Omitted |

`gesture_id` MUST identify the active gesture. A server `seq` increases
monotonically for the camera target and connection. Every `camera.pose` is
absolute, self-contained, and includes its projection even when it has not
changed.

A client `camera.pose` is a hard rebase after a discontinuity such as a
bookmark, fit-view command, FOV change, or switch between perspective and
orthographic projection.

### 8.6. `camera.delta` (Client → Server)

Reports an incremental application-side change, including motion from another
controller or an enforced correction such as collision or snapping:

```javascript
{
  "type": "camera.delta",
  "gesture_id": 73,
  "t": [dx, dy, dz],
  "r": [drx, dry, drz],
  "ortho_extent_scale": 0.8,
  "delta_id": 17
}
```

A `camera.delta` MUST contain `gesture_id`, `t`, and `r`.
`ortho_extent_scale` and `delta_id` are optional. It does not contain `seq`,
`fov`, `ortho_extent`, or `applied_delta_id`.

A `camera.delta` contains a world-space translation increment and a world-space
rotation increment. The server adds `t` to current position and left-multiplies
current orientation by the rotation represented by `r`:

```text
C.t = C.t + dt
C.R = dR * C.R
```

Position and orientation increments are independent; `dR` does not rotate the
current position. A delta does not change the server-owned camera pivot.

For an orthographic camera, `camera.delta` MAY include a positive
`ortho_extent_scale`. The server composes it multiplicatively with its current
extent:

```text
C.ortho_extent = C.ortho_extent * ortho_extent_scale
```

Values below one zoom in and values above one zoom out. Perspective zoom
normally moves the camera and is represented by `t`.

A delta MAY include a client-chosen non-negative integer `delta_id`, increasing
monotonically for the camera target and connection. The server applies the
complete delta atomically and MUST promptly emit a `camera.pose` even if no
device input is active. That pose and every later camera pose in the same gesture
carry the greatest ID applied to that target in that gesture as `applied_delta_id`.
The watermark resets at the beginning of each gesture; the field MUST be omitted
until the first identified delta in that gesture has been applied. Sequence
numbers and client delta ID allocators remain connection-scoped and MUST NOT
reset at gesture boundaries. A client MUST validate the active `gesture_id`
before interpreting a watermark. Within that gesture, a pose whose
`applied_delta_id` is at least a sent `delta_id` includes that delta and provides
an ordering barrier for the client.

A successful transport send does not acknowledge a delta; acknowledgement is
provided by the server's `applied_delta_id` watermark as defined above. The
watermark persists across later poses in the same gesture and does not represent a new application
of the same delta.

Observation loops, native-write suppression, single-flight correction barriers,
coalescing, and comparison tolerances are implementation strategies. See
[Reconciling navigation](docs/src/content/docs/concepts/reconciliation.md) and
[Concurrent input and constraints](docs/src/content/docs/guide/concurrent-input.mdx)
for the SDK strategy and application binding guidance.

### 8.7. `camera.pivot` (Server → Client)

```javascript
{
  "type": "camera.pivot",
  "gesture_id": 73,
  "point": [x, y, z]
}
```

Reports the server-selected pivot for rendering and for server-driven movement
such as recenter-on-pan. Clients return candidates through `navigation.query`;
they do not select or send the authoritative pivot.

### 8.8. `object.pose` (Either direction)

```javascript
{
  "type": "object.pose",
  "gesture_id": 73,
  "seq": 91,
  "t": [x, y, z],
  "r": [rx, ry, rz]
}
```

Every `object.pose` is absolute and MUST contain `gesture_id`, `t`, and `r`. A
server pose also MUST contain its target-local monotonic `seq` and, after
applying an identified delta, the greatest applied ID as `applied_delta_id`. A
client pose omits both fields and is a hard rebase of the object state. Object
poses MUST NOT contain `fov`, `ortho_extent`, or `ortho_extent_scale`.

The object target is one logical rigid transform target in the client's current
application context. It may be one object or an application-provided rigid
group; `t` is its transform origin and `r` is its orientation. When answering
the initial query, the client binds that target to the gesture. `object.bounds`
describes the same target. If the target changes, the client MUST stop applying
the gesture and send `motion_cancel`. Independently transformed multiple-object
output is outside OpenAxis 1.0 unless the client exposes those objects as one
logical rigid group.

### 8.9. `object.delta` (Client → Server)

```javascript
{
  "type": "object.delta",
  "gesture_id": 73,
  "t": [dx, dy, dz],
  "r": [drx, dry, drz],
  "delta_id": 18
}
```

An `object.delta` follows the position, orientation, atomic-application, and
applied-delta watermark rules of `camera.delta`. It MUST NOT contain `fov`,
`ortho_extent`, or `ortho_extent_scale`, and it does not change the server-owned
object pivot.

### 8.10. `object.pivot` (Server → Client)

```javascript
{
  "type": "object.pivot",
  "gesture_id": 73,
  "point": [x, y, z]
}
```

Reports the server-selected object pivot. Object facts and candidates use the
same query mechanism.

Camera and object pose streams are independent and MAY be active together. A
client's object-interaction tag does not force object-only output; server policy
and axis mappings may continue camera control, select object control, or drive
both simultaneously.

### 8.11. Pivot feedback

Pivot feedback uses the authoritative point from `camera.pivot` or `object.pivot`.
Pose application must not depend on the ability to render feedback.

Marker appearance, depth behavior, sizing, and lifecycle guidance are maintained
in the [SDK visual-feedback guide](docs/src/content/docs/experience/pivots-diagnostics.md#pivot-marker-appearance).
These are integration presentation recommendations, not wire-protocol requirements.

## 9. Commands and button state

### 9.1. `command.execute` (Either direction)

For clients declaring `commands`, the server MAY invoke an application-native
named command without assigning a numeric virtual button:

```javascript
{
  "type": "request",
  "id": 18,
  "method": "command.execute",
  "params": { "name": "view.fit" }
}
```

Command names and optional method-specific parameters are open-ended. A client
MUST return `unsupported` for an unknown name. A successful result SHOULD be
`{ "accepted": true }`; completion of a long-running application command need
not block the response.

A client MAY use the same method to invoke a named server command. OpenAxis 1.0
defines `navigation.pivot.lock` and `navigation.pivot.clear`. A lock command
applies to the server's last authoritative camera pivot and returns
`unavailable` if no pivot has been selected yet. Further command names MAY be
added without changing the RPC envelope.

### 9.2. `buttons` (Server → Client)

```javascript
{ "type": "buttons", "buttons": 5 }
```

This preserves the compact virtual-button bitmask for clients that consume
button state. Bit 0 is virtual button 1. For choosing named commands versus
virtual buttons in a new integration, see
[Migration guidance](docs/src/content/docs/reference/migration-1-0.md#application-actions).

## 10. Extensibility and name handling

OpenAxis uses open-ended strings for message types, RPC methods, capabilities,
tags, query facts, commands, and axis names. Names defined by this document are
standard OpenAxis names. A future 1.x revision MAY define additional standard
names, but MUST preserve the behavior of existing names.

Private extensions SHOULD use a collision-resistant prefix controlled by their
author, such as a reverse-DNS name. Extension fields SHOULD be nested under one
such name when practical. An extension MUST NOT assign a new meaning to a
standard name.

The `navigation.state.camera.mode` values `orbit` and `free_camera` form a closed
set in 1.0. An additional mode requires explicit negotiation of an extension
that defines its semantics, or a new major protocol version; it cannot be sent
to a 1.0 peer merely as an additive string value.

Unknown items are handled by category:

| Unknown item | Required receiver behavior |
|---|---|
| Field in a known message | Ignore the field and process the rest of the message. |
| Top-level message type | Ignore the message. |
| RPC method | Return `response.error.code = "unsupported"`. |
| `navigation.query` fact | Omit that fact; continue evaluating other requested facts. |
| Command name | Return `unsupported`. |
| Capability | Ignore it. |
| Axis name in `subscribe` | Preserve it in `axes` and report zero values unless its extension defines other behavior. |
| Tag | Preserve it as context available to server policy; no standard behavior is implied. |

These rules apply only to unknown names and fields. A malformed use of a known
item is handled as an error under Section 11.

## 11. Error handling

### 11.1. Error codes

| Code | Meaning |
|---|---|
| `bad_request` | A known message or method has malformed or invalid fields, parameters, values, or state. |
| `unsupported` | An RPC method or command name is not implemented. |
| `unavailable` | A recognized operation cannot be performed in the current state. |

An uncorrelated `error` reports a message-level or connection-level failure. An
RPC failure MUST use `response.error` with the request's `id`. Error messages
are diagnostic and MUST NOT be parsed to determine behavior.

### 11.2. Invalid input and state

- A receiver of a malformed known top-level message SHOULD send
  `error.code = "bad_request"`. It MAY close the connection when continuing
  would be unsafe or message boundaries cannot be trusted.
- A responder to a malformed RPC request with a usable `id` MUST return a
  correlated `bad_request` response.
- A peer MUST NOT apply a pose, delta, pivot, or query result carrying an
  inactive or mismatched `gesture_id`. It MAY report `bad_request` and SHOULD
  otherwise discard the message.
- Clients SHOULD discard a `frame` or pose whose stream-local `seq` is not
  newer than the last one they accepted.
- Invalid input MUST NOT partially update Navigation state or execute part of
  a command.

## 12. Security and privacy considerations

OpenAxis 1.0 has no peer authentication or authorization. Binding a service to
loopback limits remote reachability but does not distinguish trusted software
from another local process running as the same user. Clients provide their own
context tags and requested scene facts to the server; OpenAxis does not expose
one client's application context to another client. The server may send mapped
input, Navigation output, and supported command requests to an eligible client.

For OpenAxis 1.0 Release Candidate 1, this open local endpoint is an explicit
design decision. The protocol does not require client pairing or an origin
allowlist. Browser permission controls may gate local access where supported,
but such controls are outside OpenAxis and do not authenticate a client to the
server.

- A plaintext native endpoint MUST bind only to loopback addresses. It MUST
  NOT listen on a wildcard or non-loopback interface.
- The optional browser endpoint intentionally permits connections from
  arbitrary origins. OpenAxis does not define an origin allowlist or pairing
  mechanism. Browser permission controls may govern whether an origin can
  reach a local endpoint, but support and behavior are browser-defined. TLS
  authenticates and protects the server connection but is not client or origin
  authorization.
- `command.execute` implementations MUST dispatch exact registered names.
  They MUST NOT interpolate command names or parameters into a shell, `eval`,
  or an equivalent reflective execution mechanism.
- Both peers MUST treat commands received from an unauthenticated OpenAxis
  peer as originating from untrusted software and SHOULD NOT expose commands
  with security-sensitive effects through an unauthenticated endpoint.
- Implementations SHOULD bound MessagePack nesting, message size, collection
  lengths, outstanding RPC requests, and message rate. Resource-limit failures
  MAY close the offending connection.
- Clients SHOULD make `document.id` opaque and avoid placing filenames, user
  data, or other high-cardinality content in tags. Query results reveal only
  facts the server requested, but may still describe private document state.
- Server logs may include context tags, queried scene facts, document
  identifiers, and command parameters for diagnostics and troubleshooting.
  Such logs may therefore contain application or document information and
  should be handled accordingly.

Remote deployment requires an authentication and authorization layer outside
OpenAxis 1.0 and is not conformant to its assumed deployment model merely by
adding TLS.

## 13. Conformance summary

This checklist assists client implementers and audits the server behavior they
may rely upon; the detailed normative sections remain authoritative.

### 13.1. Client and server checklist

| Feature | Applies to | Status | Section |
|---|---|---|---|
| Binary WebSocket MessagePack framing and `hello` negotiation | All | Required | 3 |
| Unknown-item and invalid-input handling | All | Required | 10, 11 |
| Tags and active-client lifecycle | Server and active-input clients | Required | 4, 6 |
| `subscribe`, `axes`, `frame`, and rate units | Axis Streaming | Required | 7 |
| `navigation` capability and `navigation.query` | Navigation | Required | 4, 8 |
| `world.orientation` fact | Navigation client | Required | 8 |
| `viewport.settled` notification | Navigation client | Optional | 8 |
| `navigation.state` resolved gesture behavior | Navigation server | Required when producing Navigation poses | 8 |
| Camera pose support | Navigation client | Optional target | 8 |
| Object pose support | Navigation client | Optional target | 8 |
| Deltas and applied-delta watermarks | Navigation server; capable clients | Optional client use, required server handling | 8 |
| `command.execute` | Commands | Required within role | 9 |
| Legacy `buttons` | Server and consuming clients | Optional | 9 |

### 13.2. Message summary

| Message / method | Direction | Purpose |
|---|---|---|
| `hello`, `heartbeat` | Client → Server | Establish and keep alive a session |
| `hello_ack` | Server → Client | Accept the protocol session |
| `error` | Either | Uncorrelated message or connection failure |
| `tags`, `focus`, `capabilities` | Client → Server | Context, target focus, and supported actuators |
| `request`, `response` | Either | Correlated extensible RPC envelope |
| `subscribe` | Client → Server | Select Axis Streaming names |
| `axes`, `frame` | Server → Client | Confirmed axis order and rate stream |
| `motion_start` | Server → Client | Begin or atomically replace an identified gesture |
| `motion_end` | Server → Client | End the active gesture when motion stops or control transfers |
| `motion_cancel` | Client → Server | Reject a gesture after local context changes |
| `navigation.query` | Server → Client | Batched client-observable facts |
| `viewport.settled` | Client → Server | Report that changes to the active viewport have settled |
| `navigation.state` | Server → Client | Effective immutable behavior for the gesture |
| `camera.pose`, `object.pose` | Either | Absolute Navigation pose streams and client rebases |
| `camera.delta`, `object.delta` | Client → Server | Incremental application-side changes |
| `camera.pivot`, `object.pivot` | Server → Client | Authoritative selected pivots |
| `command.execute` | Either | Named application or server action |
| `buttons` | Server → Client | Legacy virtual-button state |

## 14. Normative references

- **[RFC2119]** S. Bradner, ["Key words for use in RFCs to Indicate
  Requirement Levels"](https://www.rfc-editor.org/rfc/rfc2119), BCP 14,
  RFC 2119.
- **[RFC8174]** B. Leiba, ["Ambiguity of Uppercase vs Lowercase in RFC 2119
  Key Words"](https://www.rfc-editor.org/rfc/rfc8174), BCP 14, RFC 8174.
- **[RFC6455]** I. Fette and A. Melnikov, ["The WebSocket
  Protocol"](https://www.rfc-editor.org/rfc/rfc6455), RFC 6455.
- **[MSGPACK]** MessagePack project, ["MessagePack
  specification"](https://github.com/msgpack/msgpack/blob/master/spec.md).

## Appendix A. Compatibility with draft 0.2

Draft 0.2 and 1.0 are not wire-compatible. Clients MUST use the
`openaxis/1.0` protocol identifier and the 1.0 message contracts.

For the full change list and migration guidance, see
[Migrating from 0.2 to 1.0](/reference/migration-1-0/).

---

## Legal Notice

This specification is distributed under [Elastic License 2.0 or GPLv3, at your option](LICENSE).
See the [legal notices](LEGAL.md) for pending patent applications,
server rights, and trademark policy.
