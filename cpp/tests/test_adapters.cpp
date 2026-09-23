#include <openaxis/navigation.hpp>
#include "pump_scheduler.hpp"
#include <iostream>
using namespace openaxis;
void check(bool value, const char *message) { if (!value) throw std::runtime_error(message); }
// Native contexts need not be strings or JSON-serializable.
struct Context { int viewport, operation; };
struct Adapter : NavigationAdapter {
    Context current{3, 1};
    Pose pose{{0, 0, 5}, {}, .8};
    bool object = false, available = true;
    int captures = 0, queries = 0, writes = 0, observations = 0;
    std::optional<std::int64_t> last_gesture, last_sequence;
    std::vector<int> cleared;
    std::vector<std::string> facts;
    std::function<void()> during_resolve, during_write;
    NavigationContext capture_context() override { ++captures; return available ? NavigationContext(current) : NavigationContext{}; }
    bool is_current(const NavigationContext &value) override {
        const auto &c = std::any_cast<const Context &>(value);
        return available && c.viewport == current.viewport && c.operation == current.operation;
    }
    struct Capture : NavigationCapture {
        Adapter &adapter;
        Pose initial;
        explicit Capture(Adapter &a) : adapter(a), initial(a.pose) {}
        Value resolve(const std::string &name) override {
            adapter.facts.push_back(name);
            if (adapter.during_resolve) adapter.during_resolve();
            if (name == (adapter.object ? "object.pose" : "camera.pose")) return pose_value(initial);
            if (name == "unavailable") return nullptr;
            if (name == "broken") throw std::runtime_error("native fact failed");
            return 42;
        }
        std::optional<Pose> initial_observation() override { ++adapter.observations; return initial; }
    };
    std::unique_ptr<NavigationCapture> begin_query(const NavigationContext &context) override {
        check(is_current(context), "begin_query used a stale context");
        ++queries; return std::make_unique<Capture>(*this);
    }
    WriteResult apply_pose(const NavigationContext &context, const NavigationPose &value, const Value &, std::optional<Vec3>) override {
        check(is_current(context), "write used a replacement context");
        ++writes; pose = value;
        last_gesture = value.gesture_id; last_sequence = value.seq;
        if (during_write) during_write();
        return {true, pose};
    }
    void show_pivot(const NavigationContext &context, std::optional<Vec3> point) override {
        if (!point) cleared.push_back(std::any_cast<const Context &>(context).operation);
    }
};
Value query(int id, Value params) {
    return {{"type", "request"}, {"id", id}, {"method", "navigation.query"}, {"params", std::move(params)}};
}
Value output(const char *type, const Pose &pose, int gesture, int seq) {
    auto m = pose_value(pose); m["type"] = type; m["gesture_id"] = gesture; m["seq"] = seq; return m;
}
int main() try {
    Adapter camera, object; object.object = true; object.pose.fov = 0;
    bool rejected_scheduler = false;
    try { NavigationSession invalid(camera, [](const Value &) { return true; }); }
    catch (const std::invalid_argument &) { rejected_scheduler = true; }
    check(rejected_scheduler, "session accepted a missing scheduler");
    PumpScheduler scheduler;
    NavigationOptions options;
    options.scheduler = &scheduler;
    options.object_adapter = &object;
    std::vector<NavigationEvent> events;
    options.on_event = [&](const NavigationEvent &event) { events.push_back(event); };
    options.observation = [&](const NavigationContext &c) -> std::optional<Pose> {
        check(camera.is_current(c), "observation used stale context"); return camera.pose;
    };
    std::vector<Value> sent;
    NavigationSession session(camera, [&](const Value &m) { sent.push_back(m); return true; }, nullptr, options);
    session.receive({{"type", "motion_start"}, {"gesture_id", 1}});
    scheduler.drain();
    session.receive(query(1, {{"gesture_id", 1}, {"values", {"camera.pose", "object.pose", "unavailable"}},
                              {"first", {"unavailable", "answer", "never"}}}));
    scheduler.drain();
    check(camera.captures == 1 && object.captures == 1 && camera.queries == 1 && object.queries == 1,
          "query did not capture independently once per adapter");
    check(camera.observations == 1 && object.observations == 0, "optional observation contract");
    check(camera.facts == std::vector<std::string>({"camera.pose", "unavailable", "answer"}), "fact memoization/laziness");
    check(sent.back()["result"]["first"]["value"] == 42, "first result missing");
    session.receive(query(2, {{"gesture_id", 1}, {"values", {"camera.pose"}}}));
    scheduler.drain();
    check(camera.captures == 1 && camera.queries == 2, "scoped query recaptured bound viewport");
    auto desired = camera.pose; desired.t.x = 2;
    session.receive(output("camera.pose", desired, 1, 1));
    scheduler.drain();
    auto desired_object = object.pose; desired_object.t.x = 4;
    session.receive(output("object.pose", desired_object, 1, 1));
    scheduler.drain();
    check(camera.writes == 1 && object.writes == 1, "independent adapter writes missing");
    check(camera.last_gesture == 1 && camera.last_sequence == 1 && object.last_gesture == 1,
          "adapter lost pose message metadata");
    int contextual_events = 0;
    for (const auto &event : events) {
        if (event.event == "query_context" || event.event == "camera_write" || event.event == "object_write") {
            check(std::any_cast<const Context &>(event.context).operation == 1, "observer lost native context");
            ++contextual_events;
        }
    }
    check(contextual_events >= 4, "contextual observer events missing");
    ++object.current.operation;
    session.check_context(); scheduler.drain();
    check(!session.active(), "object context change did not cancel shared gesture");
    check(camera.cleared.back() == 1 && object.cleared.back() == 1, "cleanup lost original contexts");
    session.receive(output("camera.pose", desired, 1, 2));
    scheduler.drain();
    check(camera.writes == 1, "retired output wrote to host");

    // Unscoped queries validate their capture too, without binding a gesture.
    camera.during_resolve = [&] { ++camera.current.operation; };
    session.receive(query(3, {{"values", {"camera.pose"}}}));
    scheduler.drain();
    check(sent.back().contains("error"), "unscoped stale capture returned a result");
    camera.during_resolve = {};
    session.receive(query(4, {{"values", {"broken", "camera.pose"}}}));
    scheduler.drain();
    check(sent.back()["result"]["values"].contains("camera.pose") &&
          !sent.back()["result"]["values"].contains("broken"), "one failed fact discarded other facts");

    session.receive({{"type", "motion_start"}, {"gesture_id", 2}});
    scheduler.drain();
    session.receive(query(5, {{"gesture_id", 2}, {"values", {"camera.pose"}}}));
    scheduler.drain();
    camera.during_write = [&] { ++camera.current.operation; session.check_context(); };
    desired.t.x = 3;
    session.receive(output("camera.pose", desired, 2, 2));
    scheduler.drain();
    check(!session.active() && sent.back()["type"] == "motion_cancel", "reentrant write kept retired context active");
    camera.during_write = {};

    Adapter only;
    NavigationOptions camera_options; camera_options.scheduler = &scheduler;
    NavigationSession camera_only(only, [&](const Value &m) { sent.push_back(m); return true; }, nullptr, camera_options);
    camera_only.receive({{"type", "motion_start"}, {"gesture_id", 7}});
    scheduler.drain();
    camera_only.receive(query(6, {{"gesture_id", 7}, {"values", {"camera.pose", "object.pose"}}}));
    scheduler.drain();
    check(!sent.back()["result"]["values"].contains("object.pose"), "missing object adapter supplied a pose");
    camera_only.receive(output("object.pose", object.pose, 7, 1));
    scheduler.drain();
    check(!camera_only.active() && sent.back()["reason"] == "object_navigation_unsupported", "unsupported object output not cancelled");
    Adapter retiring;
    NavigationSession closing(retiring, [&](const Value &m) { sent.push_back(m); return true; }, nullptr, camera_options);
    closing.receive({{"type", "motion_start"}, {"gesture_id", 8}});
    scheduler.drain();
    retiring.during_resolve = [&] { closing.close(); };
    const auto before_close = sent.size();
    closing.receive(query(8, {{"gesture_id", 8}, {"values", {"camera.pose"}}}));
    scheduler.drain();
    check(!closing.active() && sent.size() == before_close, "reentrant close emitted retired query or cancellation");
    std::cout << "Captured context, independent adapters, query snapshots and stale work passed\n";
} catch (const std::exception &e) { std::cerr << e.what() << '\n'; return 1; }
