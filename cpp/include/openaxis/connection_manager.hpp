#pragma once
#include "client.hpp"

namespace openaxis {
struct RetryPolicy {
    double initial_delay = 2, max_delay = 4, multiplier = 2, jitter = .2;
};
struct ConnectionStatus {
    std::string state = "stopped", error;
    std::optional<double> retry_at;
};
struct ConnectionMetadata {
    std::vector<std::string> tags, capabilities;
    std::optional<std::vector<std::string>> axes;
    std::optional<bool> focused;
};
struct OpenAxisConnectionManagerOptions {
    std::function<ConnectionMetadata()> metadata;
    RetryPolicy retry;
    double startup_timeout = 5;
    std::function<void(const std::string &, const std::string &)> log;
};
// Owns connection attempts and metadata replay for one existing client.
// All calls, metadata providers and observers run on the application thread.
// The client and its scheduler must outlive the manager. Do not independently
// connect/disconnect the client while the manager is running.
class OpenAxisConnectionManager {
  public:
    explicit OpenAxisConnectionManager(OpenAxisClient &client, OpenAxisConnectionManagerOptions options);
    ~OpenAxisConnectionManager();
    OpenAxisConnectionManager(const OpenAxisConnectionManager &) = delete;
    OpenAxisConnectionManager &operator=(const OpenAxisConnectionManager &) = delete;
    void start();
    void stop();
    void refresh_metadata();
    ConnectionStatus status() const;
    std::function<void(const ConnectionStatus &)> on_state;

  private:
    void dispatch_pending();
    struct Impl;
    std::unique_ptr<Impl> impl_;
    void changed(bool connected, const std::string &error);
    void notify(ConnectionStatus status);
    void begin_attempt();
};
} // namespace openaxis
