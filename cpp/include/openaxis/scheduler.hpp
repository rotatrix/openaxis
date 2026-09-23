#pragma once
#include <functional>
namespace openaxis {
// Implement using the host event loop. Both methods must be thread-safe and
// enqueue callbacks, never invoke them inline. Deadlines are absolute monotonic
// seconds, on the same clock as the caller (diagnostic_time by default).
// The scheduler must outlive every client/session using it. Queued callbacks
// become inert when those objects stop/close; no host timer cancellation is required.
struct Scheduler {
    using Callback = std::function<void()>;
    virtual ~Scheduler() = default;
    virtual void post(Callback) = 0;
    virtual void post_at(double deadline, Callback) = 0;
};
} // namespace openaxis
