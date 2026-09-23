#pragma once
#include "client.hpp"
#include "diagnostics.hpp"
#include <chrono>
#include <any>
#include <optional>

namespace openaxis {
// Implement adapters on the application's scene thread.
struct WriteResult {
    bool success = false;
    std::optional<Pose> realized;
};
// An empty context means unavailable. Capture native handles and operation
// generations by value; is_current must validate them before host work.
using NavigationContext = std::any;
struct NavigationCapture {
    virtual ~NavigationCapture() = default;
    virtual Value resolve(const std::string &name) = 0;
    virtual std::optional<Pose> initial_observation() { return {}; }
};
struct NavigationAdapter {
    virtual ~NavigationAdapter() = default;
    virtual NavigationContext capture_context() = 0;
    virtual bool is_current(const NavigationContext &) = 0;
    virtual std::unique_ptr<NavigationCapture> begin_query(const NavigationContext &) = 0;
    virtual WriteResult apply_pose(const NavigationContext &, const NavigationPose &,
                                   const Value &navigation, std::optional<Vec3> pivot) = 0;
    virtual void show_pivot(const NavigationContext &, std::optional<Vec3>) {}
};
using NavigationObjectAdapter = NavigationAdapter;
struct NavigationEvent {
    std::string event;
    Value values;
    // Native captured context for query_context and write/applied events.
    // Kept separately because host handles need not be JSON-serializable.
    NavigationContext context;
};
using NavigationObserver = std::function<void(const NavigationEvent &)>;
struct NavigationOptions {
    double timeout = 1;
    std::size_t max_work = 64, drain_budget = 32, max_queries = 32;
    std::function<double()> clock = diagnostic_time;
    std::function<PoseDifference(const Pose &, const Pose &)> compare_camera, compare_object;
    Scheduler *scheduler = nullptr; // Required; must outlive the session.
    NavigationObserver on_event;
    NavigationObjectAdapter *object_adapter = nullptr;
    std::function<std::optional<Pose>(const NavigationContext &)> observation, object_observation;
};
struct Diagnostic {
    std::string event, target, detail;
    std::optional<std::int64_t> gesture;
};
class NavigationSession {
  public:
    using Sender = std::function<bool(const Value &)>;
    // Owns exclusive attachment; client and adapters outlive the session.
    NavigationSession(OpenAxisClient &client, NavigationAdapter &adapter,
                      NavigationDiagnostics *collector = nullptr, NavigationOptions options = {});
    NavigationSession(NavigationAdapter &adapter, Sender sender,
                      NavigationDiagnostics *collector = nullptr, NavigationOptions options = {});
    ~NavigationSession();
    // Call for every connection transition before delivering new messages.
    void connection_changed();
    void receive(const Value &message);
    // All public methods run on the application thread. A scheduler defers
    // drains and deadline checks. Without one, service update() regularly.
    // Notifications coalesce and never manufacture input deltas.
    void native_camera_changed();
    void native_object_changed();
    void context_changed();
    void check_context();
    // Call while host resources still exist; invalidates all scheduled work.
    void close();
    void cancel(const std::string &reason = "context_changed");
    void viewport_settled();
    bool active() const;
    std::function<void(const Diagnostic &)> diagnostics;

  private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
    void attach(OpenAxisClient &client);
};
} // namespace openaxis
