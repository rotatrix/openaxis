#include "host_fixture.hpp"
#include <fstream>
#include <iostream>
#include <openaxis/navigation.hpp>
using namespace openaxis;
void check(bool v, const std::string &message) {
    if (!v)
        throw std::runtime_error(message);
}
nlohmann::ordered_json fixture(const char *name) {
    std::ifstream in(std::string(OPENAXIS_FIXTURES) + "/" + name + ".json");
    nlohmann::ordered_json f;
    in >> f;
    return f;
}
Value rows(const DiagnosticPresentation &p) {
    Value a = Value::array();
    for (const auto &l : p.lines)
        a.push_back({{"text", l.text}, {"tone", l.tone}});
    return a;
}
void presentation_fixture() {
    auto f = fixture("diagnostic-presentation");
    DiagnosticOptions o;
    o.enabled = true;
    NavigationDiagnostics d(o);
    std::vector<std::string> names;
    for (auto it = f["facts"].begin(); it != f["facts"].end(); ++it)
        names.push_back(it.key());
    d.observe("query_started", {{"request_id", 9}, {"gesture_id", 7}, {"values", names}});
    d.set_context("view");
    for (auto it = f["facts"].begin(); it != f["facts"].end(); ++it)
        d.observe("fact", {{"request_id", 9},
                           {"name", it.key()},
                           {"value", Value(it.value())},
                           {"duration_ms", 0}});
    d.pick(9, "pick.cursor",
           PickEvidence{std::array<double, 2>{20, 30},
                        std::array<Vec3, 2>{Vec3{0, 0, 5}, Vec3{1, 1, 1}}});
    d.pick(9, "pick.cursor.selection", PickEvidence{std::array<double, 2>{20, 30}, {}});
    d.observe("query_completed", {{"request_id", 9}, {"duration_ms", 0}});
    auto p = d.presentation();
    check(rows(p) == Value(f["rows"]), "shared rows differ:\n" + rows(p).dump(2));
    Value markers = Value::array();
    for (auto &m : p.markers)
        markers.push_back({{"label", m.label}, {"point", m.point}, {"tone", m.tone}});
    check(markers == Value(f["markers"]), "shared markers differ");
    check(Value(diagnostic_colors()) == Value(f["colors"]), "shared colors differ");
    check(p.segments.size() == f["segments"].size(), "shared segment count");
    for (std::size_t i = 0; i < p.segments.size(); ++i) {
        const auto &s = p.segments[i];
        const auto &e = f["segments"][i];
        check(s.tone == e["tone"] && s.width == e["width"] && s.opacity == e["opacity"], "segment style");
        check((s.start - vector_from(Value(e["start"]))).length() < 1e-12 &&
                  (s.end - vector_from(Value(e["end"]))).length() < 1e-12,
              "segment geometry");
    }
    p.lines[0].text = "mutated";
    p.segments[0].start.x = 999;
    check(d.presentation().lines[0].text != "mutated" &&
              d.presentation().segments[0].start.x != 999,
          "detached frame");
    d.set_context("other");
    check(d.presentation().segments.empty() && d.presentation().markers.empty(), "stale geometry");
}
void lifecycle_fixture() {
    auto f = fixture("diagnostics");
    double now = 0;
    DiagnosticOptions o;
    o.enabled = true;
    o.clock = [&] { return now; };
    NavigationDiagnostics d(o);
    for (auto &s : f["corrections"]) {
        now = s["time"];
        d.observe("correction",
                  {{"stream", s["stream"]}, {"state", s["state"]}, {"delta_id", s["id"]}});
        check(d.presentation().lines.size() == s["visible"], "shared correction retention");
    }
    now = f["expire_at"];
    check(d.presentation().lines.empty(), "expiry");
    std::vector<std::pair<std::string, std::string>> logs;
    o.log = [&](const auto &level, const auto &message) { logs.emplace_back(level, message); };
    NavigationDiagnostics life(o);
    int changes = 0;
    life.on_changed = [&] { ++changes; };
    for (auto &s : f["lifecycle"]) {
        life.observe(s["event"],
                     {{"gesture_id", s["id"]}, {"reason", s["reason"]}, {"kind", "camera.pose"}});
        check(logs.back().first == s["level"] && logs.back().second == s["message"],
              "shared lifecycle logging");
        check(life.presentation().lines.back().text == s["status"], "shared lifecycle status");
    }
    check(changes == int(f["lifecycle"].size()), "one notification per lifecycle event");
}
void collector_behavior() {
    double now = 10;
    int changes = 0;
    DiagnosticOptions o;
    o.enabled = true;
    o.history_limit = 2;
    o.retention = 2.5;
    o.clock = [&] { return now; };
    o.log = [](const auto &, const auto &) { throw std::runtime_error("sink"); };
    NavigationDiagnostics d(o);
    d.on_changed = [&] {
        ++changes;
        throw std::runtime_error("UI");
    };
    d.observe("query_started",
              {{"request_id", 4},
               {"values", {"model.bounds"}},
               {"first", {"pick.cursor.selection", "pick.cursor", "pick.viewport_center"}}});
    d.set_context("A");
    Value b = {{"min", {0, 0, 0}}, {"max", {2, 2, 2}}};
    d.observe("fact", {{"request_id", 4}, {"name", "model.bounds"}, {"value", b}});
    b["max"][0] = 999;
    d.observe("fact", {{"request_id", 4}, {"name", "pick.cursor.selection"}, {"value", nullptr}});
    d.observe("fact",
              {{"request_id", 4}, {"name", "pick.cursor"}, {"value", {{"point", {1, 1, 1}}}}});
    d.observe("query_completed", {{"request_id", 4}, {"selected", "pick.cursor"}});
    auto text = rows(d.presentation()).dump();
    check(text.find("skipped") != std::string::npos && text.find("miss") != std::string::npos &&
              text.find("999") == std::string::npos,
          "query ordering/detachment");
    d.clear();
    for (int i = 0; i < 5; ++i)
        d.observe("correction", {{"stream", "camera"}, {"delta_id", i}, {"state", "sent"}});
    check(d.history().size() == 2, "bounded history");
    d.observe("correction", {{"stream", "camera"}, {"delta_id", 4}, {"state", "applied"}});
    check(d.presentation().expires_at == 12.5, "expiry deadline");
    auto count = changes;
    now = 12.5;
    check(d.presentation().lines.empty() && changes == count, "expiry does not emit change");
    Pose p{{0, 0, 10}, {}, 1};
    auto desired = pose_value(p);
    d.observe("camera_write", {{"desired", desired}, {"success", true}});
    check(d.presentation().lines[0].text.find("unknown readback") != std::string::npos,
          "unknown write");
    p.t.x += 1;
    d.observe("camera_write",
              {{"desired", desired}, {"realized", pose_value(p)}, {"success", true}});
    check(d.presentation().lines[0].text.find("differs") != std::string::npos, "write comparison");
    d.observe("camera_write", {{"desired", desired}, {"realized", desired}, {"success", true}});
    check(d.presentation().lines[0].tone == "pass", "equivalent write");
    d.observe("camera_write", {{"desired", desired}, {"success", false}});
    check(d.presentation().lines[0].tone == "missing", "failed write");
    d.set_enabled(false);
    check(d.presentation().lines.empty() && d.presentation().segments.empty(),
          "disable clears presentation");
}
struct Host : TestHost {
    int reads = 0, picks = 0;
    Pose pose{{0, 0, 10}, {}, 1};
    NavigationDiagnostics *collector;
    std::string context_key() const override { return "view"; }
    Value fact(const std::string &name) override {
        ++picks;
        collector->pick(name, PickEvidence{std::array<double, 2>{20, 30}, {}});
        return {{"point", {0, 0, 0}}};
    }
    std::optional<Pose> read_camera() override {
        ++reads;
        return pose;
    }
    bool write_camera(const Pose &p) override {
        pose = p;
        pose.t.x = std::min(p.t.x, 1.);
        return true;
    }
};
void session_evidence() {
    DiagnosticOptions o;
    o.enabled = true;
    NavigationDiagnostics d(o);
    Host h;
    h.collector = &d;
    std::vector<Value> sent;
    std::vector<NavigationEvent> events;
    NavigationOptions session_options;
    session_options.on_event = [&](const NavigationEvent &event) {
        events.push_back(event);
        throw std::runtime_error("passive structured observer");
    };
    TestSession s(
        h,
        [&](const Value &v) {
            sent.push_back(v);
            return true;
        },
        &d, session_options);
    s.diagnostics = [](const auto &) { throw std::runtime_error("observer"); };
    s.receive({{"type", "motion_start"}, {"gesture_id", 1}});
    s.drain();
    s.receive({{"type", "request"},
               {"id", 1},
               {"method", "navigation.query"},
               {"params",
                {{"gesture_id", 1},
                 {"values", {"camera.pose", "pick.cursor"}},
                 {"first", {"pick.cursor", "pick.viewport_center"}}}}});
    s.drain();
    check(h.reads == 1 && h.picks == 1, "collector caused extra reads/picks");
    check(d.presentation().markers.size() == 1, "actual pick evidence");
    auto m = pose_value(h.pose);
    m["type"] = "camera.pose";
    m["gesture_id"] = 1;
    m["seq"] = 1;
    m["t"][0] = 2;
    s.receive(m);
    s.drain();
    check(h.reads == 3, "write observation/readback duplicated");
    check(s.active() && h.pose.t.x == 1, "diagnostics altered navigation");
    check(rows(d.presentation()).dump().find("differs") != std::string::npos,
          "realized write evidence");
    check(sent.back().value("type", "") == "camera.delta", "clamp correction missing");
    auto find_event = [&](const std::string &name) -> Value {
        for (const auto &event : events)
            if (event.event == name) return event.values;
        throw std::runtime_error("missing structured event: " + name);
    };
    check(find_event("gesture_started")["gesture_id"] == 1, "gesture event payload");
    check(find_event("query_completed")["result"].contains("values"), "query result omitted");
    check(find_event("query_context").contains("context"), "query context omitted");
    check(find_event("camera_write")["realized"]["t"][0] == 1, "realized pose omitted");
    check(find_event("camera_applied")["success"] == true, "successful write event omitted");
    check(find_event("correction_sent").contains("difference"), "correction evidence omitted");
    s.connection_changed();
    check(d.presentation().segments.empty() && d.presentation().markers.empty(),
          "disconnect stale graphics");
}
void pick_marker_result() {
    const std::vector<std::string> names = {"pick.cursor.selection", "pick.cursor", "pick.viewport_center", "pick.viewport_center.selection"};
    DiagnosticOptions options; options.enabled = true;
    NavigationDiagnostics d(options);
    d.observe("query_started", {{"request_id", 7}, {"first", names}});
    const std::vector<Value> samples = {nullptr, {{"markerPosition", {-.5, .25}}},
        {{"point", {1, 2, 3}}, {"markerPosition", {0, 0}}}};
    std::vector<std::string> calls;
    auto result = evaluate_query(Value{{"values", {names[0], names[1]}}, {"first", names}}, [&](const std::string &name) {
        calls.push_back(name);
        auto value = samples.at(std::find(names.begin(), names.end(), name) - names.begin());
        d.observe("fact", {{"request_id", 7}, {"name", name}, {"value", value}});
        return value;
    });
    check(calls == std::vector<std::string>(names.begin(), names.begin()+3), "miss memoization and short circuit");
    check(result == Value{{"values", Value::object()}, {"first", {{"name", names[2]}, {"value", {{"point", {1,2,3}}}}}}}, "local metadata on wire");
    check(samples[2].contains("markerPosition"), "mutated resolver result");
    const auto frame = d.presentation();
    check(frame.markers.size() == 2 && frame.segments.size() == 3, "hit/miss/skip marker evidence");
}
int main() try {
    {
        DiagnosticOptions options;
        options.enabled = true;
        NavigationDiagnostics diagnostics(options);
        Host host;
        NavigationOptions navigation;
        int comparisons = 0;
        navigation.compare_camera = [&](const Pose &a, const Pose &b) {
            ++comparisons;
            return compare_poses(a, b, ComparisonOptions{1});
        };
        TestSession session(host, [](const Value &) { return true; }, &diagnostics, navigation);
        auto desired = pose_value(host.pose), realized = desired;
        realized["t"][0] = desired["t"][0].get<double>() + .5;
        diagnostics.observe("camera_write", {{"desired", desired}, {"realized", realized}, {"success", true}});
        check(comparisons == 1 && rows(diagnostics.presentation()).dump().find("equivalent") != std::string::npos,
              "diagnostics ignored the session's native camera comparison");
    }
    pick_marker_result();
    presentation_fixture();
    lifecycle_fixture();
    collector_behavior();
    session_evidence();
    std::cout << "Shared diagnostic presentation/lifecycle fixtures and passive session evidence "
                 "passed\n";
    return 0;
} catch (const std::exception &e) {
    std::cerr << e.what() << '\n';
    return 1;
}
