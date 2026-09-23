#ifndef NOMINMAX
#define NOMINMAX
#endif
// Loopback test peer only; this is not an OpenAxis server implementation.
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <iostream>
#include <ixwebsocket/IXGetFreePort.h>
#include <ixwebsocket/IXNetSystem.h>
#include <ixwebsocket/IXWebSocketServer.h>
#include <map>
#include <mutex>
#include <openaxis/connection_manager.hpp>
#include <openaxis/diagnostics.hpp>
#include <thread>
// Credential verification is stubbed in this lifecycle test runtime.
inline openaxis::Value test_proof(const openaxis::Value &) { return openaxis::Value::object(); }
using namespace openaxis;
using namespace std::chrono_literals;
void check(bool v, const char *message) {
    if (!v)
        throw std::runtime_error(message);
}
void send(ix::WebSocket &ws, const Value &m) {
    auto bytes = Value::to_msgpack(m);
    ws.sendBinary(std::string(bytes.begin(), bytes.end()));
}
struct EventLoop : Scheduler {
    std::mutex mutex;
    std::condition_variable changed;
    std::multimap<double, Callback> queue;
    void post(Callback f) override { post_at(diagnostic_time(), std::move(f)); }
    void post_at(double t, Callback f) override {
        {
            std::lock_guard<std::mutex> lock(mutex);
            queue.emplace(t, std::move(f));
        }
        changed.notify_one();
    }
    void run_one(double until) {
        std::unique_lock<std::mutex> lock(mutex);
        for (;;) {
            auto now = diagnostic_time();
            if (!queue.empty() && queue.begin()->first <= now) {
                auto f = std::move(queue.begin()->second);
                queue.erase(queue.begin());
                lock.unlock();
                f();
                return;
            }
            if (now >= until)
                return;
            changed.wait_for(
                lock, std::chrono::duration<double>(
                          (queue.empty() ? until : std::min(until, queue.begin()->first)) - now));
        }
    }
};
int main() try {
    ix::initNetSystem();
    auto port = ix::getFreePort();
    ix::WebSocketServer server(port, "127.0.0.1");
    std::mutex mutex;
    std::vector<Value> received;
    std::atomic<int> connections{0};
    std::atomic<bool> origin_seen{false};
    std::atomic<bool> respond_to_hello{true};
    server.setOnClientMessageCallback([&](auto, ix::WebSocket &ws,
                                          const ix::WebSocketMessagePtr &e) {
        if (e->type == ix::WebSocketMessageType::Open) {
            for (const auto &header : e->openInfo.headers) {
                auto name=header.first;
                std::transform(name.begin(),name.end(),name.begin(),[](unsigned char c){return static_cast<char>(std::tolower(c));});
                if(name=="origin")origin_seen=true;
            }
        }
        if (e->type != ix::WebSocketMessageType::Message)
            return;
        auto m = Value::from_msgpack(e->str);
        {
            std::lock_guard<std::mutex> lock(mutex);
            received.push_back(m);
        }
        if (m["type"] == "hello") {
            ++connections;
            if (!respond_to_hello) return;
            send(ws,
                 {{"type", "hello_ack"}, {"proto", "openaxis/1.0"}, {"server_name", "test-peer"}});
        } else if (m["type"] == "request" && m["method"] == "q")
            send(ws, {{"type","response"},{"id",m["id"]},{"result",test_proof(m["params"]["c"])}});
        else if (m["type"] == "request" && (m["method"] == "echo" || m["method"] == "command.execute"))
            send(ws, {{"type", "response"}, {"id", m["id"]}, {"result", m["params"]}});
    });
    check(server.listen().first, "listen failed");
    server.start();
    EventLoop scheduler;
    const auto host_thread = std::this_thread::get_id();
    OpenAxisClientOptions options{"transport-test", "ws://127.0.0.1:" + std::to_string(port)};
    options.scheduler = &scheduler;
    options.client_version = "2.3.4";
    options.target = {{"app", "CAD"}, {"app_version", "2027.1"}};
    OpenAxisClient c(options);
    ConnectionMetadata metadata;
    metadata.tags = {"before"};
    metadata.capabilities = {"navigation"};
    metadata.focused = false;
    metadata.axes = std::vector<std::string>{"rx"};
    OpenAxisConnectionManager connection(c, {[&] { return metadata; }, {.02, .04, 2, 0}});
    bool duplicate_rejected = false;
    try { OpenAxisConnectionManager duplicate(c, {[&] { return metadata; }}); }
    catch (const std::logic_error &) { duplicate_rejected = true; }
    check(duplicate_rejected, "two managers acquired the same client");
    std::vector<ConnectionStatus> states;
    connection.on_state = [&](const ConnectionStatus &s) {
        check(std::this_thread::get_id() == host_thread, "transport callback thread");
        states.push_back(s);
    };
    check(connection.status().state == "stopped", "initial status");
    connection.start();
    connection.start(); // Idempotent: one transport attempt.
    auto wait = [&](auto condition) {
        auto deadline = std::chrono::steady_clock::now() + 5s;
        while (!condition()) {
            scheduler.run_one(diagnostic_time() + .1);
            if (std::chrono::steady_clock::now() > deadline)
                throw std::runtime_error("loopback timeout");
        }
    };
    wait([&] { return c.connected(); });
    {
        std::lock_guard<std::mutex> lock(mutex);
        const auto &hello = received.front();
        check(hello.at("client_version") == "2.3.4", "missing client version");
        check(hello.at("target").at("app_version") == "2027.1", "missing application version");
        check(hello.at("sdk").at("name") == "openaxis-cpp" && !hello.at("sdk").at("version").get<std::string>().empty(), "missing SDK identity");
    }
    check(!origin_seen, "native client sent Origin");
    metadata.tags = {"live-update"};
    connection.refresh_metadata();
    wait([&] {
        std::lock_guard<std::mutex> lock(mutex);
        return std::any_of(received.begin(), received.end(), [](const Value &m) {
            return m["type"] == "tags" && m["tags"] == Value::array({"live-update"});
        });
    });
    bool replied = false;
    c.request("echo", {{"value", 42}}, [&](const Value &r, const Value &e) {
        check(e.is_null() && r["value"] == 42, "correlation failed");
        replied = true;
    });
    wait([&] { return replied; });
    bool command_replied = false;
    c.execute_command("fit-view", {{"selection", true}}, [&](const Value &r, const Value &e) {
        check(e.is_null() && r == Value{{"name", "fit-view"}, {"selection", true}}, "command helper lost parameters");
        command_replied = true;
    });
    wait([&] { return command_replied; });
    const std::vector<Value> expected_helpers = {
        {{"type", "tags"}, {"tags", {"helper-test"}}},
        {{"type", "capabilities"}, {"capabilities", {"navigation"}}},
        {{"type", "focus"}, {"focused", true}},
        {{"type", "subscribe"}, {"axes", {"rx"}}},
        {{"type", "motion_cancel"}, {"gesture_id", 7}, {"reason", "native-input"}},
        {{"type", "viewport.settled"}},
        {{"type", "camera.pose"}, {"gesture_id", 7}, {"t", {1, 2, 3}}, {"r", {0, 0, 0}}, {"fov", .8}},
        {{"type", "camera.pose"}, {"gesture_id", 7}, {"t", {1, 2, 3}}, {"r", {0, 0, 0}}, {"ortho_extent", 4}},
        {{"type", "camera.delta"}, {"gesture_id", 7}, {"t", {1, 0, 0}}, {"r", {0, 0, 0}}, {"ortho_extent_scale", 2}, {"delta_id", 0}},
        {{"type", "object.pose"}, {"gesture_id", 7}, {"t", {1, 2, 3}}, {"r", {0, 0, 0}}},
        {{"type", "object.delta"}, {"gesture_id", 7}, {"t", {1, 0, 0}}, {"r", {0, 0, 0}}, {"delta_id", 0}},
        {{"type", "response"}, {"id", 700}, {"result", {{"done", true}}}},
        {{"type", "response"}, {"id", 701}, {"error", {{"code", "unsupported"}, {"message", "not implemented"}}}}
    };
    check(c.send_tags({"helper-test"}) && c.send_capabilities({"navigation"}) && c.send_focus(true) && c.subscribe({"rx"}), "metadata helper send");
    check(c.send_motion_cancel(7, "native-input") && c.send_viewport_settled(), "control helper send");
    check(c.send_camera_pose(7, {1,2,3}, {}, .8) && c.send_camera_pose(7, {1,2,3}, {}, {}, 4), "camera pose helper send");
    check(c.send_camera_delta(7, {1,0,0}, {}, 2, 0), "camera delta helper send");
    check(c.send_object_pose(7, {1,2,3}, {}) && c.send_object_delta(7, {1,0,0}, {}, 0), "object helper send");
    check(c.send_response(700, {{"done", true}}) && c.send_response_error(701, "unsupported", "not implemented"), "response helper send");
    wait([&] {
        std::lock_guard<std::mutex> lock(mutex);
        return std::all_of(expected_helpers.begin(), expected_helpers.end(), [&](const Value &expected) {
            return std::find(received.begin(), received.end(), expected) != received.end();
        });
    });
    bool no_deadline_completed = false;
    auto no_deadline = c.request("unanswered", Value::object(), [&](const Value &, const Value &error) {
        check(error["code"] == "cancelled", "disabled deadline timed out");
        no_deadline_completed = true;
    }, std::nullopt);
    auto no_deadline_until = diagnostic_time() + .05;
    while (diagnostic_time() < no_deadline_until) scheduler.run_one(no_deadline_until);
    check(!no_deadline_completed, "disabled deadline completed without a response");
    c.cancel_request(no_deadline);
    check(no_deadline_completed, "disabled deadline request could not be cancelled");
    bool expired = false;
    c.request(
        "unanswered", Value::object(),
        [&](const Value &, const Value &e) { expired = e["code"] == "timeout"; }, .02);
    wait([&] { return expired; });
    const auto old_sender = c.capture_navigation_sender();
    connection.stop();
    metadata.tags = {"after"};
    metadata.focused = true;
    connection.start();
    wait([&] { return c.connected(); });
    check(!old_sender({{"type", "tags"}, {"tags", {"retired"}}}), "old sender wrote to a replacement connection");
    wait([&] {
        std::lock_guard<std::mutex> lock(mutex);
        for (const auto &m : received)
            if (m["type"] == "tags" && m["tags"] == Value::array({"after"}))
                return true;
        return false;
    });
    wait([&] {
        std::lock_guard<std::mutex> lock(mutex);
        for (const auto &m : received)
            if (m["type"] == "heartbeat")
                return true;
        return false;
    });
    int disconnect_events = 0;
    c.on_connection = [&](bool connected) {
        if (!connected)
            ++disconnect_events;
    };
    for (const auto &peer : server.getClients())
        peer->close(1001, "restart test");
    wait([&] { return disconnect_events > 0; });
    check(connection.status().state == "retrying" && connection.status().retry_at.has_value(),
          "retry status missing");
    metadata.tags = {"automatic-reconnect"};
    wait([&] { return c.connected() && connections == 3; });
    wait([&] {
        std::lock_guard<std::mutex> lock(mutex);
        for (const auto &m : received)
            if (m["type"] == "tags" && m["tags"] == Value::array({"automatic-reconnect"}))
                return true;
        return false;
    });
    bool cancelled = false;
    auto cancelled_id =
        c.request("unanswered", Value::object(), [&](const Value &, const Value &error) {
            cancelled = error["code"] == "cancelled";
        });
    c.cancel_request(cancelled_id);
    check(cancelled, "RPC cancellation failed");
    bool disconnected = false;
    c.request("unanswered", Value::object(),
              [&](const Value &, const Value &e) { disconnected = e["code"] == "disconnected"; });
    connection.stop();
    check(disconnected, "pending RPC survived stop");
    check(connection.status().state == "stopped", "stop status missing");
    check(connections == 3, "unexpected connection count");
    auto state_count = states.size();
    scheduler.run_one(diagnostic_time() + 1.1);
    check(states.size() == state_count, "queued callbacks restarted stopped client");

    // A bare client is a one-shot transport: no automatic metadata or retries.
    {
        std::lock_guard<std::mutex> lock(mutex);
        received.clear();
    }
    OpenAxisClient raw(options);
    raw.connect();
    wait([&] { return raw.connected(); });
    {
        std::lock_guard<std::mutex> lock(mutex);
        check(std::none_of(received.begin(), received.end(), [](const Value &m) {
            return m["type"] == "tags" || m["type"] == "capabilities" || m["type"] == "subscribe";
        }), "bare client replayed manager metadata");
    }
    for (const auto &peer : server.getClients()) peer->close(1001, "one-shot test");
    wait([&] { return !raw.connected(); });
    auto attempt_count = connections.load();
    auto until = diagnostic_time() + 2.5;
    while (diagnostic_time() < until) scheduler.run_one(until);
    check(connections == attempt_count, "bare client retried without a manager");
    raw.disconnect();

    // Provider failure is retried; stopping in backoff cancels the deadline.
    OpenAxisClient failing(options);
    int snapshots = 0;
    OpenAxisConnectionManager broken(failing, {[&]() -> ConnectionMetadata {
        ++snapshots;
        throw std::runtime_error("snapshot unavailable");
    }, {.02, .04, 2, 0}});
    broken.start();
    wait([&] { return broken.status().state == "retrying"; });
    check(broken.status().error == "snapshot unavailable", "provider error was lost");
    broken.stop();
    until = diagnostic_time() + .15;
    while (diagnostic_time() < until) scheduler.run_one(until);
    check(snapshots == 1 && broken.status().state == "stopped", "stop left a retry armed");

    // Startup includes the handshake and metadata, and is bounded by the manager.
    respond_to_hello = false;
    OpenAxisClient stalled(options);
    int stalled_snapshots = 0;
    OpenAxisConnectionManagerOptions startup_options;
    startup_options.metadata = [&] { ++stalled_snapshots; return metadata; };
    startup_options.startup_timeout = .03;
    startup_options.log = [](const auto &, const auto &) { throw std::runtime_error("log sink"); };
    OpenAxisConnectionManager stalled_manager(stalled, startup_options);
    stalled_manager.start();
    wait([&] { return stalled_manager.status().state == "retrying"; });
    check(stalled_manager.status().error == "Connection startup timed out", "missing startup deadline");
    check(!stalled.connected() && stalled_snapshots == 0, "unfinished handshake announced metadata");
    stalled_manager.stop();
    respond_to_hello = true;

    OpenAxisClient slow(options);
    startup_options.startup_timeout = .2;
    startup_options.metadata = [&] { std::this_thread::sleep_for(250ms); return metadata; };
    OpenAxisConnectionManager slow_manager(slow, startup_options);
    bool slow_ready = false;
    slow_manager.on_state = [&](const auto &status) { slow_ready |= status.state == "ready"; };
    slow_manager.start();
    wait([&] { return slow_manager.status().state == "retrying"; });
    check(!slow_ready && !slow.connected(), "metadata startup overrun became ready");
    slow_manager.stop();

    // Invalid timing is rejected without acquiring the client.
    OpenAxisClient invalid_options_client(options);
    for (auto timeout : {0., -1., std::numeric_limits<double>::infinity()}) {
        startup_options.startup_timeout = timeout;
        bool rejected = false;
        try { OpenAxisConnectionManager invalid(invalid_options_client, startup_options); }
        catch (const std::invalid_argument &) { rejected = true; }
        check(rejected, "invalid startup deadline accepted");
    }

    // A host may pump its event loop inside a metadata callback. Retire that
    // snapshot when a reentrant stop/start replaces the connection.
    OpenAxisClient reentrant(options);
    OpenAxisConnectionManager *reentrant_manager = nullptr;
    bool replace_during_snapshot = false;
    ConnectionMetadata current_metadata;
    current_metadata.tags = {"original-snapshot"};
    OpenAxisConnectionManager replacement(reentrant, {[&] {
        auto snapshot = current_metadata;
        if (replace_during_snapshot) {
            replace_during_snapshot = false;
            snapshot.tags = {"stale-snapshot"};
            reentrant_manager->stop();
            current_metadata.tags = {"replacement-snapshot"};
            reentrant_manager->start();
            wait([&] { return reentrant_manager->status().state == "ready"; });
        }
        return snapshot;
    }});
    reentrant_manager = &replacement;
    int ready_notifications = 0;
    reentrant.on_connection = [&](bool connected) { if (connected) ++ready_notifications; };
    replacement.start();
    wait([&] { return replacement.status().state == "ready"; });
    replace_during_snapshot = true;
    replacement.refresh_metadata();
    wait([&] {
        std::lock_guard<std::mutex> lock(mutex);
        return std::any_of(received.begin(), received.end(), [](const Value &m) {
            return m["type"] == "tags" && m["tags"] == Value::array({"replacement-snapshot"});
        });
    });
    {
        std::lock_guard<std::mutex> lock(mutex);
        check(std::none_of(received.begin(), received.end(), [](const Value &m) {
            return m["type"] == "tags" && m["tags"] == Value::array({"stale-snapshot"});
        }), "retired metadata was announced on the replacement connection");
    }
    check(ready_notifications == 2, "duplicate ready notification after replacement");
    replacement.stop();

    // A missing scheduler is rejected instead of enabling a second dispatch path.
    auto missing_scheduler = options;
    missing_scheduler.scheduler = nullptr;
    bool rejected_scheduler = false;
    try { OpenAxisClient invalid(missing_scheduler); }
    catch (const std::invalid_argument &) { rejected_scheduler = true; }
    check(rejected_scheduler, "client accepted a missing scheduler");
    std::function<bool(const Value &)> destroyed_sender;
    {
        auto temporary_options = options;
        temporary_options.scheduler = &scheduler;
        OpenAxisClient temporary(temporary_options);
        temporary.connect();
        wait([&] { return temporary.connected(); });
        destroyed_sender = temporary.capture_navigation_sender();
    }
    check(!destroyed_sender({{"type", "heartbeat"}}), "sender outlived its client unsafely");
    server.stop();
    std::cout << "Loopback handshake, metadata replay, RPC, heartbeat and shutdown passed\n";
    return 0;
} catch (const std::exception &e) {
    std::cerr << e.what() << '\n';
    return 1;
}
