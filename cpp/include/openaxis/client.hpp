#pragma once
#include "protocol.hpp"
#include "process_identity.hpp"
#include "scheduler.hpp"
#include "listener.hpp"
#include <functional>
#include <memory>
#include <vector>

namespace openaxis {
struct OpenAxisClientOptions {
    std::string client_name, url = "ws://127.0.0.1:6607";
    Value target = nullptr;
    std::size_t max_queue = 256;
    Scheduler *scheduler = nullptr; // Required; must outlive the client.
    double handshake_timeout = 5;
    std::optional<std::string> client_version;
};
// All public calls and callbacks belong to the host thread. A scheduler is required
// to dispatch queued transport events and deadlines on that thread.
// connect() starts one nonblocking attempt; use OpenAxisConnectionManager for retries.
// Send helpers publish only on the current connection and report send success.
// disconnect() joins networking; no user callbacks run on the network thread.
class OpenAxisClient {
  public:
    explicit OpenAxisClient(OpenAxisClientOptions options, std::shared_ptr<OpenAxisListener> listener = {});
    ~OpenAxisClient();
    OpenAxisClient(const OpenAxisClient &) = delete;
    OpenAxisClient &operator=(const OpenAxisClient &) = delete;
    void connect();
    void disconnect();
    bool connected() const;
    ConnectionState state() const;
    std::function<void()> add_listener(std::shared_ptr<OpenAxisListener> listener);
    // Only one NavigationSession may own navigation messages at a time.
    std::function<void()> attach_navigation(std::shared_ptr<OpenAxisListener> listener);
    const std::string &url() const;
    bool send(const Value &message);
    // A retained sender never writes to a replacement connection, even if the
    // client reconnects or is destroyed before deferred work completes.
    std::function<bool(const Value &)> capture_navigation_sender();
    bool send_tags(std::vector<std::string> tags);
    bool send_capabilities(std::vector<std::string> capabilities);
    bool send_focus(bool focused);
    bool subscribe(std::vector<std::string> axes);
    bool send_motion_cancel(std::int64_t gesture_id, std::optional<std::string> reason = {});
    bool send_viewport_settled();
    bool send_camera_pose(std::int64_t gesture_id, Vec3 t, Vec3 r,
                          std::optional<double> fov = {}, std::optional<double> ortho_extent = {});
    bool send_camera_delta(std::int64_t gesture_id, Vec3 t, Vec3 r,
                           std::optional<double> ortho_extent_scale = {}, std::optional<std::int64_t> delta_id = {});
    bool send_object_pose(std::int64_t gesture_id, Vec3 t, Vec3 r);
    bool send_object_delta(std::int64_t gesture_id, Vec3 t, Vec3 r,
                           std::optional<std::int64_t> delta_id = {});
    bool send_response(std::int64_t request_id, Value result);
    bool send_response_error(std::int64_t request_id, std::string code, std::optional<std::string> message = {});
    using Reply = std::function<void(const Value &result, const Value &error)>;
    // nullopt disables the deadline; disconnect/cancel still complete the callback.
    std::int64_t request(std::string method, Value params, Reply reply, std::optional<double> timeout_seconds = 5);
    std::int64_t execute_command(std::string name, Value params, Reply reply, std::optional<double> timeout_seconds = 5);
    void cancel_request(std::int64_t id);
    std::function<void(const Value &)> on_message;
    std::function<void(bool)> on_connection;
    std::function<void(const std::string &)> on_error;

  private:
    void dispatch_pending();
    friend class OpenAxisConnectionManager;
    std::function<void(bool, const std::string &)> lifecycle_;
    Scheduler *scheduler() const;
    bool running() const;
    void set_state(ConnectionState state);
    void dispatch(const Value &message);
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
} // namespace openaxis
