#include "host_fixture.hpp"
#include <fstream>
#include <openaxis/process_identity.hpp>
#include <iostream>
#include <openaxis/navigation.hpp>
#include <stdexcept>
#include <thread>
using namespace openaxis;
#define CHECK(x)                                                                                   \
    do {                                                                                           \
        if (!(x))                                                                                  \
            throw std::runtime_error("check failed: " #x);                                         \
    } while (false)
struct Host : TestHost {
    Pose camera{{0, 5, 15}, {}, .8, 0}, object{{1, 2, 3}, {}};
    std::string context = "doc/viewport/edit-1";
    int writes = 0, object_writes = 0, picks = 0;
    bool editing = true, clamp = false;
    std::string context_key() const override { return context; }
    Value fact(const std::string &name) override {
        if (name == "pick") {
            ++picks;
            return Value{{"point", {1, 2, 3}}};
        }
        return nullptr;
    }
    std::optional<Pose> read_camera() override { return camera; }
    bool write_camera(const Pose &p) override {
        camera = p;
        if (clamp)
            camera.t.y = 0;
        ++writes;
        return true;
    }
    std::optional<Pose> read_object() override {
        return editing ? std::optional<Pose>(object) : std::nullopt;
    }
    bool write_object(const Pose &p) override {
        object = p;
        ++object_writes;
        return true;
    }
};
Value stream(const char *target, int gesture, int seq, const Pose &p) {
    auto m = pose_value(p);
    m["type"] = std::string(target) + ".pose";
    m["gesture_id"] = gesture;
    m["seq"] = seq;
    return m;
}
void parity_checks() {
    struct ParityHost : Host {
        bool unavailable = false, throw_pivot = false;
        std::function<void()> during_write;
        std::optional<Pose> read_camera() override {
            return unavailable ? std::nullopt : std::optional<Pose>(camera);
        }
        bool write_camera(const Pose &p) override {
            Host::write_camera(p);
            if (during_write) {
                auto f = std::move(during_write);
                f();
            }
            return true;
        }
        void pivot(std::optional<Vec3>) override {
            if (throw_pivot)
                throw std::runtime_error("renderer");
        }
    } h;
    std::vector<Value> sent;
    TestSession s(h, [&](const Value &m) {
        sent.push_back(m);
        return true;
    });
    auto start = [&](int id) {
        s.receive({{"type", "motion_start"}, {"gesture_id", id}});
        s.drain();
        s.receive({{"type", "request"},
                   {"id", id},
                   {"method", "navigation.query"},
                   {"params", {{"gesture_id", id}, {"values", {"camera.pose"}}}}});
        s.drain();
    };
    start(1);
    s.receive({{"type", "navigation.state"}, {"gesture_id", 1}, {"camera", {{"mode", "orbit"}}}});
    s.drain();
    auto p = h.camera;
    p.t.x = 2;
    s.receive(stream("camera", 1, 1, p));
    s.drain();
    CHECK(h.writes == 0);
    h.throw_pivot = true;
    s.receive({{"type", "camera.pivot"}, {"gesture_id", 1}, {"point", {0, 0, 0}}});
    s.drain();
    CHECK(h.writes == 1 && s.active());
    h.unavailable = true;
    p.t.x = 3;
    s.receive(stream("camera", 1, 2, p));
    s.drain();
    CHECK(h.writes == 2 && s.active());
    h.camera.t.x = 4;
    h.unavailable = false;
    s.native_camera_changed();
    s.drain();
    CHECK(sent.back()["type"] == "camera.delta" && sent.back()["t"][0] == 1);
    h.during_write = [&] {
        s.receive({{"type", "motion_start"}, {"gesture_id", 2}});
        s.drain();
    };
    auto ack = stream("camera", 1, 3, p);
    ack["applied_delta_id"] = sent.back()["delta_id"];
    s.receive(ack);
    s.drain();
    CHECK(s.active());
    start(3);
    p.t.x = 5;
    s.receive(stream("camera", 3, 4, p));
    s.drain();
    CHECK(h.camera.t.x == 5);
    h.during_write = [&] {
        s.receive({{"type","motion_end"},{"gesture_id",3}});
        s.drain();
        CHECK(!s.active());
        h.camera.t.x += 1;
    };
    auto count=sent.size(); p.t.x=6; s.receive(stream("camera",3,5,p));
    s.drain();
    CHECK(!s.active() && sent.size()==count);
    s.cancel();
    CHECK(!s.active());
    auto a = h.camera, b = a;
    b.t.x += 5e-7;
    CHECK(compare_poses(a, b).changed);
    CHECK(!compare_poses(a, b, ComparisonOptions{1e-3}).changed);
}
int main() try {
    PumpScheduler scheduler;
    {
        OpenAxisClientOptions client_options{"helper-validation"};
        client_options.scheduler = &scheduler;
        OpenAxisClient client(client_options);
        const std::vector<std::function<void()>> invalid = {
            [&] { client.send_camera_pose(1, {}, {}); },
            [&] { client.send_camera_pose(1, {}, {}, .8, 4); },
            [&] { client.send_object_delta(-1, {}, {}); },
            [&] { client.send_camera_delta(1, {}, {}, -1); },
            [&] { client.execute_command("fit-view", {{"name", "override"}}, {}); },
            [&] { client.execute_command(" ", Value::object(), {}); },
            [&] { client.request("example", Value::object(), {}, -1); },
            [&] { client.request("example", Value::object(), {}, 1e300); },
            [&] { auto options = client_options; options.client_name.clear(); OpenAxisClient unnamed(options); },
            [&] { auto options = client_options; options.handshake_timeout = 0; OpenAxisClient bad(options); },
        };
        for (const auto &operation : invalid) {
            bool rejected = false;
            try { operation(); } catch (const std::invalid_argument &) { rejected = true; }
            CHECK(rejected);
        }
        CHECK(!client.send_viewport_settled());
    }
    auto identity = current_process_id();
    CHECK(std::regex_match(identity, std::regex(R"([1-9][0-9]*(?::[1-9][0-9]*)?)")));
#if defined(__linux__)
    CHECK(identity.substr(identity.find(':') + 1) == std::to_string(::getpid()));
#endif
    parity_checks();
    CHECK(Vec3{}.normalized().length() == 0);
    CHECK((Quat{0, 0, 0, 0}.normalized().w == 1));
    const auto quarter_turn = Quat::from_rotvec({0, 0, 1.5707963267948966});
    const auto halfway = Quat{}.slerp(quarter_turn, .5).rotate({1, 0, 0});
    CHECK(std::abs(halfway.x - std::sqrt(.5)) < 1e-12 && std::abs(halfway.y - std::sqrt(.5)) < 1e-12);
    CHECK(std::abs(Quat{}.slerp({-1, 0, 0, 0}, .5).w - 1) < 1e-12);
    {
        const Pose camera{{0, 0, 10}, {}, .8};
        const auto off_axis = look_at_from_pose(camera, 7, Vec3{100, 0, 0});
        CHECK((off_axis.target - Vec3{0, 0, 0}).length() < 1e-12);
        const auto behind = look_at_from_pose(camera, 7, Vec3{0, 0, 20});
        CHECK(std::abs(behind.target.z - 9.99) < 1e-12);
        CHECK(std::abs(look_at_from_pose(camera, 7).target.z - 3) < 1e-12);
        for (const auto &invalid : std::vector<std::function<void()>>{
            [] { pose_from_look_at({}, {}, {}, .8, 5); },
            [] { pose_from_look_at({}, {}, {}, -1); },
            [] { pose_from_look_at({INFINITY, 0, 0}, {}, {}); },
        }) {
            bool rejected = false;
            try { invalid(); } catch (const std::invalid_argument &) { rejected = true; }
            CHECK(rejected);
        }
    }
    for (const Value &invalid : {Value(-1), Value(true), Value(1.5), Value(UINT64_MAX), Value(max_integer + 1), Value(INT64_MAX)}) {
        bool rejected = false;
        try { integer(invalid); } catch (const std::invalid_argument &) { rejected = true; }
        CHECK(rejected);
    }
    CHECK(integer(Value(0)) == 0);
    CHECK(integer(Value(max_integer)) == max_integer);
    for (const Value &message : {
        Value{{"type", "motion_start"}, {"gesture_id", -1}},
        Value{{"type", "request"}, {"id", -1}, {"method", "example"}, {"params", Value::object()}},
        Value{{"type", "frame"}, {"seq", -1}, {"t_us", 0}, {"values", Value::array()}},
        Value{{"type", "camera.pose"}, {"gesture_id", 1}, {"t", {true, 0, 0}}, {"r", {0, 0, 0}}, {"fov", .8}},
        Value{{"type", "camera.pose"}, {"gesture_id", 1}, {"t", {0, 0, 0}}, {"r", {0, 0, 0}}, {"fov", true}},
        Value{{"type", "buttons"}, {"buttons", -1}},
        Value{{"type", "buttons"}, {"buttons", true}},
        Value{{"type", "response"}, {"id", 1}, {"result", 4}},
        Value{{"type", "response"}, {"id", 1}, {"error", {{"code", ""}}}},
        Value{{"type", "request"}, {"id", 1}, {"method", ""}},
        Value{{"type", "error"}, {"code", "example"}, {"message", 42}},
        Value{{"type", "tags"}, {"tags", {""}}}
    }) {
        bool rejected = false;
        try { validate_message(message); } catch (const std::invalid_argument &) { rejected = true; }
        CHECK(rejected);
    }
    validate_message({{"type", "request"}, {"id", 1}, {"method", "example"}});
    validate_message({{"type", "request"}, {"id", 2}, {"method", "navigation.query"}});
    // Wire projection validation matches the other SDKs: positive and finite.
    // Native hosts may impose narrower projection limits when applying a pose.
    validate_message({{"type", "camera.pose"}, {"gesture_id", 1}, {"t", {0, 0, 0}},
                      {"r", {0, 0, 0}}, {"fov", 4.0}});
    std::ifstream file(std::string(OPENAXIS_FIXTURES) + "/messages.json");
    Value fixture;
    file >> fixture;
    for (const auto &c : fixture["valid_messages"]) {
        try {
            validate_message(c["message"]);
            CHECK(Value::from_msgpack(Value::to_msgpack(c["message"])) == c["message"]);
        } catch (const std::exception &e) {
            throw std::runtime_error(c["name"].get<std::string>() + ": " + e.what());
        }
    }
    for (const auto &c : fixture["invalid_messages"]) {
        bool rejected = false;
        try {
            validate_message(c["message"]);
        } catch (...) {
            rejected = true;
        }
        if (!rejected)
            throw std::runtime_error("accepted invalid fixture: " + c["name"].get<std::string>());
    }
    for (const auto &c : fixture["unknown_messages"])
        validate_message(c["message"]);
    std::ifstream wire_file(std::string(OPENAXIS_FIXTURES) + "/wire.json");
    Value wire_fixture; wire_file >> wire_fixture;
    for (const auto &c : wire_fixture["cases"]) {
        const auto hex = c["hex"].get<std::string>();
        std::vector<std::uint8_t> bytes;
        for (std::size_t i = 0; i < hex.size(); i += 2) bytes.push_back(static_cast<std::uint8_t>(std::stoul(hex.substr(i, 2), nullptr, 16)));
        bool accepted = true;
        try { validate_message(Value::from_msgpack(bytes)); } catch (...) { accepted = false; }
        if (accepted != c["valid"].get<bool>()) throw std::runtime_error("wire: " + c["name"].get<std::string>());
    }
    std::ifstream query_file(std::string(OPENAXIS_FIXTURES) + "/queries.json");
    Value query_fixture; query_file >> query_fixture;
    for (const auto &c : query_fixture["cases"]) {
        NavigationQuery q({1, "navigation.query", c["params"]}, [](const Value &) { return true; });
        Value calls = Value::array();
        auto result = q.evaluate([&](const std::string &name) { calls.push_back(name); return c["facts"].value(name, Value()); });
        CHECK(result == c["result"] && calls == c["calls"]);
    }
    NavigationQuery terminal({1, "navigation.query", Value::object()}, [](const Value &) -> bool { throw std::runtime_error("send failed"); });
    try { terminal.complete(Value::array()); } catch (const std::invalid_argument &) {}
    CHECK(!terminal.completed());
    try { terminal.complete(Value::object()); } catch (const std::runtime_error &) {}
    CHECK(terminal.completed());
    std::ifstream geometry_file(std::string(OPENAXIS_FIXTURES) + "/geometry.json");
    Value geometry;
    geometry_file >> geometry;
    for (const auto &c : geometry["camera_basis_from_rotvec"]) {
        auto q = Quat::from_rotvec(vector_from(c["r"]));
        double h = c["handedness"] == "left" ? -1 : 1;
        CHECK((q.rotate({h, 0, 0}) - vector_from(c["expected"]["right"])).length() < 1e-12);
        CHECK((q.rotate({0, 1, 0}) - vector_from(c["expected"]["up"])).length() < 1e-12);
        CHECK((q.rotate({0, 0, 1}) - vector_from(c["expected"]["backward"])).length() < 1e-12);
    }
    for (const auto &c : geometry["pose_from_look_at"]) {
        auto projection = c["projection"];
        auto actual = pose_from_look_at(vector_from(c["eye"]), vector_from(c["target"]), vector_from(c["up"]),
                              projection.value("fov", 0.), projection.value("ortho_extent", 0.));
        auto expected = pose_from(c["expected"], true);
        CHECK((actual.t - expected.t).length() < 1e-12);
        CHECK((Quat::from_rotvec(actual.r) * Quat::from_rotvec(expected.r).inverse())
                  .rotvec()
                  .length() < 1e-12);
    }
    for (const auto &c : geometry["look_at_from_pose"]) {
        std::optional<Vec3> pivot;
        if (!c["pivot"].is_null())
            pivot = vector_from(c["pivot"]);
        auto result = look_at_from_pose(pose_from(c["pose"], true), c["default_distance"], pivot);
        CHECK((result.eye - vector_from(c["expected"]["eye"])).length() < 1e-12);
        CHECK((result.target - vector_from(c["expected"]["target"])).length() < 1e-12);
        CHECK((result.up - vector_from(c["expected"]["up"])).length() < 1e-12);
    }
    for (auto v : {Vec3{1e-12, 0, 0}, Vec3{.2, -.8, 1.7}, Vec3{3.141592653589793, 0, 0}})
        CHECK((Quat::from_rotvec(v).rotvec() - v).length() < 1e-10);
    auto p = pose_from_look_at({0, 0, 10}, {0, 0, 0}, {0, 1, 0}, .8);
    CHECK(p.r.length() < 1e-12);
    int calls = 0;
    auto result = evaluate_query(
        Value{{"values", {"missing", "hit"}}, {"first", {"missing", "hit", "expensive"}}},
        [&](const std::string &n) -> Value {
            ++calls;
            return n == "hit" ? Value(42) : Value();
        });
    CHECK(calls == 2);
    CHECK(result["first"]["name"] == "hit");
    bool rejected = false;
    try {
        pose_from(Value{{"t", {0, 0, 0}}, {"r", {0, 0, 0}}, {"fov", .8}, {"ortho_extent", 1}},
                  true);
    } catch (...) {
        rejected = true;
    }
    CHECK(rejected);
    Host h;
    std::vector<Value> sent;
    TestSession s(h, [&](const Value &m) {
        sent.push_back(m);
        return true;
    });
    auto start = [&](int id) {
        s.receive({{"type", "motion_start"}, {"gesture_id", id}});
        s.drain();
        s.receive({{"type", "request"},
                   {"id", id},
                   {"method", "navigation.query"},
                   {"params", {{"gesture_id", id}, {"values", {"camera.pose", "object.pose"}}}}});
        s.drain();
    };
    start(1);
    auto next = h.camera;
    next.t.x = 4;
    s.receive(stream("camera", 1, 1, next));
    s.drain();
    CHECK(h.writes == 1);
    s.receive(stream("camera", 1, 1, next));
    s.drain();
    CHECK(h.writes == 1);
    h.camera.t.x = 5;
    s.native_camera_changed();
    s.drain();
    CHECK(sent.back()["type"] == "camera.delta");
    auto delta = sent.back()["delta_id"];
    next.t.x = 8;
    s.receive(stream("camera", 1, 2, next));
    s.drain();
    CHECK(h.camera.t.x == 5);
    h.camera.t.x = 6;
    auto ack = stream("camera", 1, 3, next);
    ack["applied_delta_id"] = delta;
    s.receive(ack);
    s.drain();
    CHECK(h.camera.t.x == 6);
    CHECK(sent.back()["t"][0] == 1);
    auto delta2 = sent.back()["delta_id"];
    ack["seq"] = 4;
    ack["applied_delta_id"] = delta2;
    ack["t"][0] = 9;
    s.receive(ack);
    s.drain();
    CHECK(h.camera.t.x == 9);
    auto obj = h.object;
    obj.t.z = 8;
    s.receive(stream("object", 1, 1, obj));
    s.drain();
    CHECK(h.object.t.z == 8);
    h.context = "doc/new-viewport";
    next.t.x = 20;
    s.receive(stream("camera", 1, 5, next));
    s.drain();
    CHECK(h.camera.t.x == 9);
    CHECK(sent.back()["type"] == "motion_cancel");
    start(2);
    s.receive(stream("camera", 1, 6, next));
    s.drain();
    CHECK(h.camera.t.x == 9);
    s.receive({{"type", "motion_end"}, {"gesture_id", 1}});
    s.drain();
    CHECK(s.active());
    s.receive({{"type", "motion_end"}, {"gesture_id", 2}});
    s.drain();
    CHECK(!s.active());
    s.connection_changed();
    start(1);
    h.clamp = true;
    next.t.y = 10;
    s.receive(stream("camera", 1, 1, next));
    s.drain();
    CHECK(h.camera.t.y == 0);
    CHECK(sent.back()["type"] == "camera.delta");
    CHECK(sent.back()["t"][1] == -10);
    auto bytes = Value::to_msgpack(sent.back());
    CHECK(Value::from_msgpack(bytes) == sent.back());
    // Shutdown remains bounded while retrying an unavailable loopback endpoint.
    OpenAxisClientOptions options{"test", "ws://127.0.0.1:1"};
    options.scheduler = &scheduler;
    OpenAxisClient c(options);
    c.connect();
    scheduler.drain();
    c.disconnect();
    CHECK(!c.connected());
    std::cout << "OpenAxis geometry, query, reconciliation, context and lifecycle tests passed\n";
    return 0;
} catch (const std::exception &e) {
    std::cerr << e.what() << '\n';
    return 1;
}
