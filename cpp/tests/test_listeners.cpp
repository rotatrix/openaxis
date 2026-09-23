#ifndef NOMINMAX
#define NOMINMAX
#endif
#include "host_fixture.hpp"
#include <openaxis/connection_manager.hpp>
#include <openaxis/navigation.hpp>
#include <openaxis_ixwebsocket/IXNetSystem.h>
#include <openaxis_ixwebsocket/IXGetFreePort.h>
#include <openaxis_ixwebsocket/IXWebSocketServer.h>
#include <condition_variable>
#include <iostream>
#include <fstream>
#include <map>
#include <mutex>
#include <thread>
using namespace openaxis;
void check(bool condition, const char *message) { if (!condition) throw std::runtime_error(message); }
void send(openaxis_ix::WebSocket &socket, const Value &message) {
    const auto bytes = Value::to_msgpack(message);
    socket.sendBinary(std::string(bytes.begin(), bytes.end()));
}
struct Loop : Scheduler {
    std::mutex mutex;
    std::condition_variable wake;
    std::multimap<double, Callback> queue;
    void post(Callback f) override { post_at(diagnostic_time(), std::move(f)); }
    void post_at(double t, Callback f) override {
        { std::lock_guard<std::mutex> lock(mutex); queue.emplace(t, std::move(f)); }
        wake.notify_one();
    }
    template <class Condition> void until(Condition condition) {
        const double deadline = diagnostic_time() + 3;
        while (!condition()) {
            std::unique_lock<std::mutex> lock(mutex);
            if (diagnostic_time() >= deadline) throw std::runtime_error("listener test timed out");
            if (queue.empty() || queue.begin()->first > diagnostic_time()) {
                const double next = queue.empty() ? deadline : std::min(deadline, queue.begin()->first);
                wake.wait_for(lock, std::chrono::duration<double>(std::min(.02, next - diagnostic_time())));
            } else {
                auto f = std::move(queue.begin()->second); queue.erase(queue.begin());
                lock.unlock(); f();
            }
        }
    }
};
struct Listener : OpenAxisListener {
    OpenAxisClient *client = nullptr;
    std::vector<std::string> axes;
    std::vector<Frame> frames;
    std::vector<ConnectionState> states;
    std::optional<NavigationQuery> query;
    std::vector<Response> responses;
    int poses = 0, queries = 0, extensions = 0;
    bool throw_extension = false;
    bool complete_inline = false;
    std::vector<std::string> motions;
    std::thread::id thread = std::this_thread::get_id();
    bool wrong_thread = false;
    void on_axes(const std::vector<std::string> &v) override { axes = v; }
    void on_frame(const Frame &frame) override {
        wrong_thread |= thread != std::this_thread::get_id(); frames.push_back(frame);
    }
    void on_camera_pose(const CameraPose &pose) override { ++poses; check(pose.fov == .8, "typed projection"); }
    void on_state_change(ConnectionState state) override { states.push_back(state); if (throw_extension) throw std::runtime_error("passive state"); }
    void on_motion_start(std::int64_t id) override { motions.push_back("start:" + std::to_string(id)); if (throw_extension) throw std::runtime_error("passive motion"); }
    void on_motion_end(std::int64_t id) override { motions.push_back("end:" + std::to_string(id)); }
    void on_response(const Response &response) override { responses.push_back(response); }
    bool on_navigation_query(NavigationQuery value) override {
        ++queries; query = std::move(value);
        if (complete_inline) { query->complete(Value::object()); return false; }
        return true;
    }
    bool on_request(const Request &request) override {
        if (request.method != "test.handled") return false;
        return client->send_response(request.id, {{"ok", true}});
    }
    void on_extension(const std::string &, const Value &) override {
        ++extensions;
        if (throw_extension) throw std::runtime_error("passive listener failure");
    }
};
struct Host : TestHost {
    Pose camera{{0,0,5}, {}, .8};
    int writes = 0;
    std::string context_key() const override { return "viewport"; }
    Value fact(const std::string &) override { return nullptr; }
    std::optional<Pose> read_camera() override { return camera; }
    bool write_camera(const Pose &value) override { camera = value; ++writes; return true; }
};
int main() try {
    openaxis_ix::initNetSystem();
    const auto port = openaxis_ix::getFreePort();
    openaxis_ix::WebSocketServer server(port, "127.0.0.1");
    std::mutex mutex;
    std::vector<Value> received;
    server.setOnClientMessageCallback([&](auto, openaxis_ix::WebSocket &socket, const openaxis_ix::WebSocketMessagePtr &event) {
        if (event->type != openaxis_ix::WebSocketMessageType::Message) return;
        const auto m = Value::from_msgpack(event->str);
        { std::lock_guard<std::mutex> lock(mutex); received.push_back(m); }
        if (m["type"] == "hello") send(socket, {{"type", "hello_ack"}, {"proto", "openaxis/1.0"}, {"server_name", "test-peer"}});
        else if (m["type"] == "request" && m["method"] == "q")
            send(socket, {{"type", "response"}, {"id", m["id"]}, {"result", Value::object()}});
    });
    check(server.listen().first, "listen failed"); server.start();
    Loop loop;
    OpenAxisClientOptions options{"listener-test", "ws://127.0.0.1:" + std::to_string(port)};
    options.scheduler = &loop;
    auto listener = std::make_shared<Listener>();
    OpenAxisClient client(options, listener); listener->client = &client;
    auto extra = std::make_shared<Listener>(); extra->client = &client;
    const auto detach_extra = client.add_listener(extra);
    OpenAxisConnectionManager connection(client, {[] { return ConnectionMetadata{}; }});
    connection.start(); loop.until([&] { return connection.status().state == "ready"; });
    auto publish = [&](const Value &message) { for (const auto &peer : server.getClients()) send(*peer, message); };
    auto response = [&](std::int64_t id) -> Value {
        std::lock_guard<std::mutex> lock(mutex);
        for (const auto &m : received) if (m["type"] == "response" && m["id"] == id) return m;
        return nullptr;
    };
    std::ifstream client_file(std::string(OPENAXIS_FIXTURES) + "/client.json");
    Value client_fixture; client_file >> client_fixture;
    for (const auto &m : client_fixture["malformed_requests"]) {
        publish(m);
        loop.until([&] { return !response(integer(m["id"])).is_null(); });
        check(response(integer(m["id"]))["error"]["code"] == "bad_request", "malformed RPC correlation");
    }
    listener->complete_inline = true;
    publish({{"type", "request"}, {"id", 89}, {"method", "navigation.query"}});
    loop.until([&] { return !response(89).is_null(); });
    listener->complete_inline = false; listener->query.reset();
    publish({{"type", "axes"}, {"axes", {"rx", "ry"}}});
    publish({{"type", "frame"}, {"seq", 1}, {"t_us", 10}, {"values", {.2, -.3}}});
    loop.until([&] { return listener->frames.size() == 1 && extra->frames.size() == 1; });
    check(listener->axes == std::vector<std::string>({"rx", "ry"}) && listener->frames[0].values[1] == -.3 && !listener->wrong_thread,
          "typed streaming callbacks failed");
    publish({{"type", "request"}, {"id", 100}, {"method", "test.unknown"}});
    publish({{"type", "request"}, {"id", 101}, {"method", "test.handled"}});
    loop.until([&] { return !response(100).is_null() && !response(101).is_null(); });
    check(response(100)["error"]["code"] == "unsupported" && response(101)["result"]["ok"] == true, "request routing failed");
    publish({{"type", "request"}, {"id", 102}, {"method", "navigation.query"},
             {"params", {{"values", {"skip"}}, {"first", {"skip", "hit", "never"}}}}});
    loop.until([&] { return listener->query.has_value(); });
    auto query = *listener->query;
    auto duplicate = query;
    std::vector<std::string> facts;
    auto result = query.evaluate([&](const std::string &name) -> Value {
        facts.push_back(name); return name == "skip" ? Value{} : Value(42);
    });
    check(facts == std::vector<std::string>({"skip", "hit"}) && result["first"]["value"] == 42, "query laziness/memoization");
    check(query.complete(result), "deferred query completion failed");
    bool rejected = false;
    try { duplicate.fail("unavailable"); } catch (const std::logic_error &) { rejected = true; }
    check(rejected, "copied query completed twice");
    loop.until([&] { return !response(102).is_null(); });
    listener->query.reset();
    publish({{"type", "request"}, {"id", 103}, {"method", "navigation.query"}});
    loop.until([&] { return listener->query.has_value(); });
    auto retired_query = *listener->query;
    listener->throw_extension = true;
    publish({{"type", "_open"}, {"gesture_id", "extension-owned"}});
    publish({{"type", "heartbeat"}, {"gesture_id", "extension-owned"}});
    publish({{"type", "response"}, {"id", 999}, {"result", {{"unsolicited", true}}}});
    loop.until([&] { return extra->extensions == 1 && !listener->responses.empty(); });
    check(listener->extensions == 1 && listener->responses.back().id == 999, "passive listener isolation");
    detach_extra();
    const auto ordinary_queries = listener->queries;
    Host host;
    NavigationOptions navigation; navigation.scheduler = &loop;
    {
        TestSession session(client, host, nullptr, navigation);
        rejected = false;
        try { TestSession duplicate_session(client, host, nullptr, navigation); }
        catch (const std::logic_error &) { rejected = true; }
        check(rejected, "duplicate navigation owner accepted");
        publish(client_fixture["lifecycle"][0]);
        publish({{"type", "request"}, {"id", 201}, {"method", "navigation.query"}, {"params", {{"gesture_id", 7}, {"values", {"camera.pose"}}}}});
        loop.until([&] { return !response(201).is_null(); });
        auto pose = pose_value(host.camera); pose["type"] = "camera.pose"; pose["gesture_id"] = 7; pose["seq"] = 1; pose["t"][0] = 2;
        publish(pose);
        publish({{"type", "frame"}, {"seq", 2}, {"t_us", 20}, {"values", {.4, .5}}});
        loop.until([&] { return host.writes == 1 && listener->frames.size() == 2; });
        check(listener->queries == ordinary_queries && listener->poses == 0 && extra->frames.size() == 1,
              "navigation ownership stole ordinary events or leaked owned events");
        publish(client_fixture["lifecycle"][1]);
        loop.until([&] { return listener->motions.size() == 2; });
        check(listener->motions == std::vector<std::string>({"start:7", "end:7"}), "axis listener missed lifecycle");
        {
            std::lock_guard<std::mutex> lock(mutex);
            check(std::count_if(received.begin(), received.end(), [](const Value &m) { return m["type"] == "response" && m["id"] == 89; }) == 1, "completion followed by fallback");
        }
        connection.stop();
        check(!session.active(), "disconnect left session active");
        connection.start(); loop.until([&] { return connection.status().state == "ready"; });
        check(!retired_query.complete(Value::object()), "old query replied on a new connection");
        check(response(103).is_null(), "retired query response reached peer");
    }
    // Destruction detaches the owner, allowing a replacement without stale callbacks.
    TestSession replacement(client, host, nullptr, navigation);
    replacement.close();
    connection.stop(); server.stop();
    check(listener->states.front() == ConnectionState::Connecting && listener->states.back() == ConnectionState::Disconnected, "typed lifecycle notifications");
    std::cout << "Typed listeners, query ownership, session attachment and reconnect passed\n";
    return 0;
} catch (const std::exception &e) { std::cerr << e.what() << '\n'; return 1; }
