#include "host_fixture.hpp"
#include <openaxis/navigation.hpp>
#include <openaxis/logging.hpp>
#include <deque>
#include <fstream>
#include <iostream>
#include <stdexcept>
using namespace openaxis;

struct Loop : Scheduler {
    std::deque<Callback> queue;
    std::vector<std::pair<double, Callback>> timers;
    void post(Callback callback) override { queue.push_back(std::move(callback)); }
    void post_at(double deadline, Callback callback) override { timers.emplace_back(deadline, std::move(callback)); }
    void drain() {
        for (int i = 0; !queue.empty(); ++i) {
            if (i == 100) throw std::runtime_error("scheduler busy loop");
            auto callback = std::move(queue.front()); queue.pop_front(); callback();
        }
    }
};
struct Host : TestHost {
    Pose camera{{10, 0, 0}, {}, 1};
    Value writes = Value::array();
    std::function<void()> on_write, on_read;
    Pose object_pose{{0,0,0}, {}};
    std::optional<Pose> read_object() override { return object_pose; }
    bool write_object(const Pose &p) override { object_pose = p; return true; }
    std::string context = "context";
    std::string context_key() const override { return context; }
    Value fact(const std::string &) override { return nullptr; }
    std::optional<Pose> read_camera() override { auto callback = std::move(on_read); on_read = {}; if (callback) callback(); return camera; }
    bool write_camera(const Pose &p) override {
        camera = p; writes.push_back(p.t.x);
        auto callback = std::move(on_write); on_write = {};
        if (callback) callback();
        return true;
    }
};
void performance_subset(const Value &actual, const Value &expected) {
    if (actual.is_string() && expected.is_array()) {
        for (const auto &part : expected) if (actual.get<std::string>().find(part.get<std::string>()) == std::string::npos) throw std::runtime_error("performance missing " + part.dump() + ": " + actual.get<std::string>());
    } else if (expected.is_object()) { for (auto it = expected.begin(); it != expected.end(); ++it) performance_subset(actual.at(it.key()), it.value()); }
    else if (expected.is_array()) {
        if (actual.size() != expected.size()) throw std::runtime_error("performance report count");
        for (std::size_t i = 0; i < expected.size(); ++i) performance_subset(actual.at(i), expected.at(i));
    } else if (expected.is_number()) {
        if (std::abs(actual.get<double>() - expected.get<double>()) > 1e-6) throw std::runtime_error("performance " + actual.dump() + " != " + expected.dump());
    } else if (actual != expected) throw std::runtime_error("performance " + actual.dump() + " != " + expected.dump());
}
int main() try {
    std::ifstream input(std::string(OPENAXIS_FIXTURES) + "/coordinator.json");
    Value fixture; input >> fixture;
    if (fixture.at("version") != 1) throw std::runtime_error("fixture version");
    std::ifstream perf_input(std::string(OPENAXIS_FIXTURES) + "/performance.json");
    Value perf_fixture; perf_input >> perf_fixture;
    for (const auto &scenario : perf_fixture.at("scenarios")) fixture["scenarios"].push_back(scenario);
    auto log_directory = std::filesystem::temp_directory_path() / ("openaxis-performance-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    for (const auto &scenario : fixture.at("scenarios")) {
        auto logger = DiagnosticLog::configure("performance-tests", log_directory);
        logger->debug = true;
        Value reports = Value::array();
        logger->sink = [&](const std::string &, const std::string &message) {
            if (message.rfind("navigation.performance ", 0) == 0) reports.push_back(message);
        };
        Host host; Loop loop; Value sent = Value::array();
        double now = 0;
        NavigationOptions options; options.scheduler = &loop; options.clock = [&] { return now; };
        TestSession session(host, [&](const Value &m) { sent.push_back(m); return true; }, nullptr, options);
        std::function<void(const Value &)> dispatch = [&](const Value &e) {
            std::string op = e.at("op"); auto gesture = e.value("gesture", 7);
            if (op == "orbit") session.receive({{"type", "navigation.state"}, {"gesture_id", gesture}, {"camera", {{"mode", "orbit"}}}});
            else if (op == "pivot") session.receive({{"type", "camera.pivot"}, {"gesture_id", gesture}, {"point", {0,0,0}}});
            else if (op == "write_error") throw std::runtime_error("host write failed");
            else if (op == "end") session.receive({{"type", "motion_end"}, {"gesture_id", gesture}});
            else if (op == "start") session.receive({{"type", "motion_start"}, {"gesture_id", gesture}});
            else if (op == "query") session.receive({{"type", "request"}, {"id", gesture}, {"method", "navigation.query"},
                {"params", {{"gesture_id", gesture}, {"values", e.value("values", Value::array({"camera.pose"}))}}}});
            else if (op == "on_read") host.on_read = [&, events = e.at("events")] { for (const auto &item : events) dispatch(item); };
            else if (op == "object_pose") session.receive({{"type", "object.pose"}, {"gesture_id", gesture}, {"seq", e.at("seq")}, {"t", {e.at("x"),0,0}}, {"r", {0,0,0}}});
            else if (op == "pose") session.receive({{"type", "camera.pose"}, {"gesture_id", gesture}, {"seq", e.at("seq")},
                {"t", {e.at("x"), 0, 0}}, {"r", {0, 0, 0}}, {"fov", 1}});
            else if (op == "context_changed") { host.context += "changed"; session.context_changed(); }
            else if (op == "close") session.close();
            else if (op == "native_camera") { host.camera.t.x = e.at("x"); session.native_camera_changed(); }
            else if (op == "advance") {
                double next = e.at("time");
                if (next < now) throw std::runtime_error("clock went backwards");
                now = next;
                std::vector<Scheduler::Callback> due;
                for (auto it = loop.timers.begin(); it != loop.timers.end();) {
                    if (it->first <= now) { due.push_back(std::move(it->second)); it = loop.timers.erase(it); }
                    else ++it;
                }
                for (auto &callback : due) callback();
            }
            else if (op == "drain") loop.drain();
            else if (op == "on_write") host.on_write = [&, events = e.at("events")] { for (const auto &item : events) dispatch(item); };
            else if (op == "expect") {
                int cancels = 0, deltas = 0;
                for (const auto &m : sent) { if (m.at("type") == "motion_cancel") ++cancels; if (m.at("type") == "camera.delta") ++deltas; }
                Value actual{{"performance", reports}, {"summaries", reports.size()}, {"writes", host.writes}, {"pending", loop.queue.size()}, {"cancels", cancels}, {"deltas", deltas}};
                for (auto it = e.begin(); it != e.end(); ++it) {
                    if (it.key() == "op") continue;
                    if (it.key() == "performance") { performance_subset(actual.at(it.key()), it.value()); continue; }
                    if (actual.at(it.key()) != it.value()) throw std::runtime_error(it.key() + ": expected " + it.value().dump() + ", got " + actual.at(it.key()).dump());
                }
            } else throw std::runtime_error("Unknown operation " + op);
        };
        int index = 0;
        for (const auto &event : scenario.at("events")) {
            try { dispatch(event); }
            catch (const std::exception &e) { throw std::runtime_error(scenario.at("name").get<std::string>() + " step " + std::to_string(index) + ": " + e.what()); }
            ++index;
        }
        session.close(); loop.drain(); logger->close();
    }
    std::cout << "Shared coordinator traces passed: " << fixture.at("scenarios").size() << '\n';
} catch (const std::exception &e) { std::cerr << e.what() << '\n'; return 1; }
