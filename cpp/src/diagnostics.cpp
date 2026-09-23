#include <chrono>
#include <iomanip>
#include <locale>
#include <openaxis/diagnostics.hpp>
#include <openaxis/logging.hpp>
#include <sstream>

namespace openaxis {
void NavigationDiagnostics::bind(Comparison camera, Comparison object) {
    compare_camera_ = std::move(camera);
    compare_object_ = std::move(object);
}
PoseDifference compare_poses(const Pose &a, const Pose &b, ComparisonOptions options) {
    PoseDifference d;
    d.t = b.t - a.t;
    d.r = (Quat::from_rotvec(b.r) * Quat::from_rotvec(a.r).inverse()).rotvec();
    d.rebase = (a.fov > 0) != (b.fov > 0) || std::abs(a.fov - b.fov) > options.projection;
    if (a.ortho_extent > 0 && b.ortho_extent > 0)
        d.scale = b.ortho_extent / a.ortho_extent;
    double epsilon =
        std::max(options.absolute, options.relative * std::max({1., a.t.length(), b.t.length()}));
    d.changed = d.t.length() > epsilon || d.r.length() > options.angular ||
                std::abs(d.scale - 1) > options.projection;
    return d;
}
PoseDifference compare_object_poses(const Pose &a, const Pose &b, ComparisonOptions options) {
    auto first = a, second = b;
    first.fov = second.fov = 0;
    first.ortho_extent = second.ortho_extent = 1;
    return compare_poses(first, second, options);
}

double diagnostic_time() {
    return std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch())
        .count();
}
const std::map<std::string, std::array<int, 3>> &diagnostic_colors() {
    static const std::map<std::string, std::array<int, 3>> colors = {
        {"text", {245, 245, 245}},     {"missing", {255, 130, 130}},  {"skipped", {165, 165, 165}},
        {"pass", {80, 255, 110}},      {"selection", {255, 150, 40}}, {"model", {40, 210, 255}},
        {"target", {255, 70, 220}},    {"cursor", {255, 235, 40}},    {"center", {100, 170, 255}},
        {"object", {255, 70, 220}},    {"sketch", {190, 120, 255}},   {"axis_x", {255, 60, 60}},
        {"axis_y", {60, 255, 60}},     {"axis_z", {60, 130, 255}},    {"ray", {175, 175, 175}},
        {"correction", {255, 210, 40}}};
    return colors;
}
namespace {
std::string number(double v, int precision = 3, bool fixed = true) {
    std::ostringstream s;
    s.imbue(std::locale::classic());
    if (fixed)
        s << std::fixed;
    s << std::setprecision(precision) << v;
    return s.str();
}
std::optional<Vec3> point(const Value &v) {
    try {
        return vector_from(v);
    } catch (...) {
        return {};
    }
}
std::optional<std::array<Vec3, 2>> bounds(const Value &v) {
    if (!v.is_object() || !v.contains("min") || !v.contains("max"))
        return {};
    auto a = point(v["min"]), b = point(v["max"]);
    if (!a || !b || a->x > b->x || a->y > b->y || a->z > b->z)
        return {};
    return std::array<Vec3, 2>{*a, *b};
}
std::string tone(const std::string &name) {
    if (name.rfind("pick.", 0) == 0)
        return name.find("cursor") != std::string::npos ? "cursor" : "center";
    static const std::map<std::string, std::string> tones = {
        {"selection.bounds", "selection"}, {"model.bounds", "model"},  {"object.bounds", "object"},
        {"object.pose", "object"},         {"scene.cursor", "target"}, {"sketch.plane", "sketch"},
        {"camera.view_target", "target"}};
    auto it = tones.find(name);
    return it == tones.end() ? "text" : it->second;
}
std::string value_text(const Value &v) {
    if (auto p = point(v))
        return "(" + number(p->x) + ", " + number(p->y) + ", " + number(p->z) + ")";
    if (bounds(v))
        return value_text(v["min"]) + " … " + value_text(v["max"]);
    if (v.is_null())
        return "missing";
    if (v.is_boolean())
        return v.get<bool>() ? "yes" : "no";
    if (v.is_number())
        return number(v.get<double>());
    if (v.is_string())
        return v.get<std::string>();
    std::string text;
    if (v.is_object()) {
        // Stable semantic order matches the shared presentation fixture.
        std::vector<std::string> keys;
        for (const auto *key : {"t", "r", "fov", "ortho_extent", "origin", "normal", "x_axis",
                                "forward", "up", "handedness"})
            if (v.contains(key))
                keys.emplace_back(key);
        for (auto it = v.begin(); it != v.end(); ++it)
            if (std::find(keys.begin(), keys.end(), it.key()) == keys.end())
                keys.push_back(it.key());
        for (auto key : keys)
            if (!v[key].is_null()) {
                auto label = key;
                std::replace(label.begin(), label.end(), '_', ' ');
                if (!text.empty())
                    text += "; ";
                text += label + ": " + value_text(v[key]);
            }
    } else if (v.is_array())
        for (const auto &item : v) {
            if (!text.empty())
                text += ", ";
            text += value_text(item);
        }
    return text;
}
std::string fact_text(const std::string &name, const Value &v, double ms,
                      const std::string &error) {
    std::string result;
    if (!error.empty())
        result = "error: " + error;
    else if (v.is_null())
        result = name.rfind("pick.", 0) == 0 ? "miss" : "missing";
    else if (v.is_object() && v.contains("point") && point(v["point"])) {
        result = "hit at " + value_text(v["point"]);
        if (v.contains("bounds") && bounds(v["bounds"]))
            result += " | bounds " + value_text(v["bounds"]);
    } else
        result = "found " + value_text(v);
    return "  " + name + " — " + result + " · " + number(ms) + " ms";
}
} // namespace
NavigationDiagnostics::NavigationDiagnostics(DiagnosticOptions o) : options_(std::move(o)) {
    if (!options_.history_limit || !std::isfinite(options_.retention) || options_.retention < 0)
        throw std::invalid_argument("invalid diagnostic limits");
    if (!options_.log) options_.log = DiagnosticLog::emit;
    if (!options_.clock)
        options_.clock = diagnostic_time;
}
void NavigationDiagnostics::touch() noexcept {
    ++revision_;
    try {
        if (on_changed)
            on_changed();
    } catch (...) {
    }
}
void NavigationDiagnostics::clear() noexcept {
    query_.reset();
    context_.clear();
    status_.clear();
    writes_.clear();
    corrections_.clear();
    history_.clear();
    touch();
}
void NavigationDiagnostics::set_enabled(bool v) {
    if (options_.enabled != v) {
        options_.enabled = v;
        clear();
    }
}
void NavigationDiagnostics::set_context(const std::string &c) noexcept {
    try {
        if (!options_.enabled)
            return;
        if (c == context_ && (!query_ || query_->complete || query_->context == c))
            return;
        if (c != context_) {
            writes_.clear();
            corrections_.clear();
        }
        context_ = c;
        if (query_ && !query_->complete)
            query_->context = c;
        touch();
    } catch (...) {
    }
}
void NavigationDiagnostics::log(std::string level, std::string message, bool retain) {
    if (level != "debug" || options_.debug)
        try {
            if (options_.log)
                options_.log(level, message);
        } catch (...) {
        }
    if (options_.enabled && retain) {
        history_.push_back({options_.clock(), std::move(level), std::move(message)});
        if (history_.size() > options_.history_limit)
            history_.erase(history_.begin());
    }
}
void NavigationDiagnostics::pick(std::int64_t id, const std::string &name,
                                 const PickEvidence &p) noexcept {
    try {
        if (!options_.enabled || !query_ || query_->complete || query_->id != id)
            return;
        if (!query_->picks.count(name))
            query_->pick_order.push_back(name);
        query_->picks[name] = p;
        touch();
    } catch (...) {
    }
}
void NavigationDiagnostics::pick(const std::string &name, const PickEvidence &p) noexcept {
    if (query_)
        pick(query_->id, name, p);
}
void NavigationDiagnostics::observe(const std::string &e, const Value &v) noexcept {
    try {
        consume(e, v);
    } catch (...) { /* Evidence cannot change navigation outcomes. */
    }
}
void NavigationDiagnostics::consume(const std::string &e, const Value &v) {
    if (e == "gesture_started") {
        logged_corrections_.clear();
        unknown_.clear();
        log("info", "gesture_started: gesture_id=" + v.at("gesture_id").dump(), false);
        if (options_.enabled) {
            query_.reset();
            context_.clear();
            writes_.clear();
            corrections_.clear();
            history_.clear();
            status_ = "gesture " + v.at("gesture_id").dump() + " started";
        }
    } else if (e == "gesture_finished" || e == "cancelled") {
        auto reason = v.value("reason", "ended");
        log("info", e + ": gesture_id=" + v.at("gesture_id").dump() + ", reason=" + reason);
        if (options_.enabled) {
            status_ = "gesture finished: " + reason;
            for (auto &[_, c] : corrections_) {
                c.state = "ended";
                c.until = options_.clock() + options_.retention;
            }
        }
    } else if (e == "output_rejected") {
        auto message = e + ": kind=" + v.at("kind").get<std::string>() +
                       ", gesture_id=" + v.at("gesture_id").dump() +
                       ", reason=" + v.at("reason").get<std::string>();
        log("warning", message);
        if (options_.enabled)
            status_ = message;
    } else if (e == "query_started") {
        if (options_.enabled) {
            Query q;
            q.id = integer(v.at("request_id"));
            if (v.contains("gesture_id"))
                q.gesture = integer(v["gesture_id"]);
            q.values = v.value("values", std::vector<std::string>{});
            q.first = v.value("first", std::vector<std::string>{});
            query_ = std::move(q);
        }
    } else if (e == "fact") {
        auto name = v.at("name").get<std::string>();
        auto val = v.value("value", Value{});
        if (name.rfind("pick.", 0) == 0 && val.is_object() && val.contains("markerPosition")) {
            const auto &p = val["markerPosition"];
            if (p.is_array() && p.size() == 2 && p[0].is_number() && p[1].is_number() &&
                std::isfinite(p[0].get<double>()) && std::isfinite(p[1].get<double>()))
                pick(integer(v.at("request_id")), name, PickEvidence{std::array<double, 2>{p[0].get<double>(), p[1].get<double>()}, {}});
        }
        val = wire_fact_value(name, std::move(val));
        auto error = v.value("error", "");
        auto ms = v.value("duration_ms", 0.0);
        log("info", fact_text(name, val, ms, error), false);
        if (options_.enabled && query_ && query_->id == integer(v.at("request_id"))) {
            if (!query_->facts.count(name))
                query_->order.push_back(name);
            query_->facts[name] = {val, ms, error};
        }
    } else if (e == "query_completed" || e == "query_failed") {
        auto error = v.value("error", "");
        auto selected = v.value("selected", "");
        auto duration = v.value("duration_ms", 0.0);
        log(error.empty() ? "info" : "warning",
            error.empty()
                ? "query complete" + (selected.empty() ? std::string{} : " — first: " + selected) +
                      " · " + number(duration) + " ms · request " + v.at("request_id").dump()
                : "query_failed: error=" + error + ", duration_ms=" + number(duration, 6, false));
        if (options_.enabled && query_ && query_->id == integer(v.at("request_id"))) {
            query_->complete = true;
            query_->duration = v.value("duration_ms", 0.0);
            query_->selected = v.value("selected", "");
            query_->error = error;
        }
    } else if (e == "camera_write" || e == "object_write") {
        auto stream = e == "camera_write" ? "camera" : "object";
        bool success = v.at("success").get<bool>(), known = v.contains("realized") && !v["realized"].is_null();
        bool unknown = success && !known, previous = unknown_[stream];
        unknown_[stream] = unknown;
        if (!success || previous != unknown) log(!success              ? "warning"
            : previous != unknown ? "info"
                                  : "debug",
            std::string(stream) + " write: " +
                (!success   ? "failed"
                 : unknown  ? "unknown readback"
                 : previous ? "readback recovered"
                            : "succeeded"),
            false);
        if (options_.enabled) {
            std::string state = !success ? "failed"
                                : !known ? "unknown readback"
                                         : "equivalent",
                        detail;
            if (success && known) {
                const bool camera = e == "camera_write";
                const auto desired = pose_from(v.at("desired"), camera);
                const auto realized = pose_from(v.at("realized"), camera);
                const auto &comparison = camera ? compare_camera_ : compare_object_;
                auto d = comparison ? comparison(desired, realized)
                                    : camera ? compare_poses(desired, realized)
                                             : compare_object_poses(desired, realized);
                state = d.changed || d.rebase ? "differs" : "equivalent";
                detail = " | translation " + number(d.t.length(), 3, false) +
                         " application units | rotation " +
                         number(d.r.length() * 180 / 3.141592653589793, 3, false) + " deg";
            }
            writes_[stream] = {std::string(stream) + " write: " + state + detail,
                               state == "failed"       ? "missing"
                               : state == "equivalent" ? "pass"
                                                       : "correction"};
        }
    } else if (e == "correction") {
        auto stream = v.at("stream").get<std::string>(), state = v.at("state").get<std::string>();
        auto id = integer(v.at("delta_id"));
        if (state == "applied")
            state = "acknowledged";
        auto key = std::to_string(id) + ":" + state;
        if (logged_corrections_[stream] != key) {
            auto message = stream + " correction " + std::to_string(id) + ": " + state;
            if (v.contains("difference")) {
                const auto &d = v["difference"];
                message += " | translation " + d.at("t").dump() + " | rotation " +
                           d.at("r").dump() + " rad | scale " +
                           number(d.at("scale").get<double>(), 6, false);
            }
            log("debug", message);
            logged_corrections_[stream] = key;
        }
        if (options_.enabled)
            corrections_[stream] = {
                id, state,
                state == "acknowledged"
                    ? std::optional<double>(options_.clock() + options_.retention)
                    : std::nullopt};
    } else
        return;
    if (options_.enabled)
        touch();
}
DiagnosticPresentation NavigationDiagnostics::presentation() const {
    DiagnosticPresentation f;
    f.revision = revision_;
    if (!options_.enabled)
        return f;
    f.context = context_;
    auto line = [&](std::string text, std::string t = "text") {
        f.lines.push_back({std::move(text), std::move(t)});
    };
    auto seg = [&](Vec3 a, Vec3 b, std::string t, double width = 2, double opacity = 1) {
        f.segments.push_back({a, b, std::move(t), width, opacity});
    };
    if (query_ && query_->context == context_) {
        const auto &q = *query_;
        line("Navigation diagnostics | gesture " +
             (q.gesture ? std::to_string(*q.gesture) : "None") + " | query " +
             std::to_string(q.id) + " | " + number(q.duration, 1) + " ms");
        if (!q.error.empty())
            line(q.error, "missing");
        auto names = q.values;
        for (auto &n : q.first)
            if (std::find(names.begin(), names.end(), n) == names.end())
                names.push_back(n);
        for (auto &n : names) {
            auto it = q.facts.find(n);
            if (it == q.facts.end()) {
                bool skipped = q.complete && !q.selected.empty() &&
                               std::find(q.first.begin(), q.first.end(), n) >
                                   std::find(q.first.begin(), q.first.end(), q.selected);
                line(n + (skipped ? ": skipped" : ": not evaluated"), "skipped");
            } else {
                const auto &v = it->second;
                line(fact_text(n, v.value, v.duration, v.error) +
                         (n == q.selected ? " < returned candidate" : ""),
                     !v.error.empty() || v.value.is_null() ? "missing" : tone(n));
            }
        }
        double scale = 1;
        for (auto n : {"selection.bounds", "model.bounds", "object.bounds"}) {
            auto it = q.facts.find(n);
            if (it == q.facts.end())
                continue;
            if (auto b = bounds(it->second.value)) {
                scale = std::max(.0001, ((*b)[1] - (*b)[0]).length() * .1);
                break;
            }
        }
        auto box = [&](const std::array<Vec3, 2> &b, const std::string &t) {
            Vec3 c[8];
            int i = 0;
            for (auto x : {b[0].x, b[1].x})
                for (auto y : {b[0].y, b[1].y})
                    for (auto z : {b[0].z, b[1].z})
                        c[i++] = {x, y, z};
            for (i = 0; i < 8; ++i)
                for (int bit : {1, 2, 4})
                    if (!(i & bit))
                        seg(c[i], c[i | bit], t, 1, .35);
        };
        for (const auto &name : q.order) {
            const auto &v = q.facts.at(name).value;
            auto color = tone(name);
            if (name == "world.orientation" && v.is_object()) {
                auto forward = point(v.value("forward", Value{})),
                     up = point(v.value("up", Value{}));
                if (forward && up) {
                    seg({},
                        forward->cross(*up) *
                            (v.value("handedness", "") == "left" ? -scale : scale),
                        "axis_x");
                    seg({}, *up * scale, "axis_y");
                    seg({}, *forward * scale, "axis_z");
                }
            }
            if (name == "object.pose" && v.is_object()) {
                auto o = point(v.value("t", Value{})), r = point(v.value("r", Value{}));
                if (o && r) {
                    auto rotation = Quat::from_rotvec(*r);
                    int i = 0;
                    for (auto axis : {Vec3{1, 0, 0}, Vec3{0, 1, 0}, Vec3{0, 0, 1}})
                        seg(*o, *o + rotation.rotate(axis) * scale,
                            std::array<std::string, 3>{"axis_x", "axis_y", "axis_z"}[i++]);
                }
            }
            if (name == "sketch.plane" && v.is_object()) {
                auto o = point(v.value("origin", Value{})), n = point(v.value("normal", Value{})),
                     x = point(v.value("x_axis", Value{}));
                if (o && n && x && n->length() > 1e-15 && x->length() > 1e-15 &&
                    n->cross(*x).length() > 1e-15) {
                    auto nn = n->normalized(), xx = x->normalized(), yy = nn.cross(xx).normalized();
                    for (double step : {-1., -.5, 0., .5, 1.})
                        for (auto axes : {std::array<Vec3, 2>{xx, yy}, std::array<Vec3, 2>{yy, xx}})
                            seg(*o + axes[0] * (step * scale) - axes[1] * scale,
                                *o + axes[0] * (step * scale) + axes[1] * scale, "sketch", 1);
                    seg(*o, *o + nn * scale, "target");
                }
            }
            if (auto b = bounds(v))
                box(*b, color);
            auto p = name == "camera.view_target" || name == "scene.cursor" ? point(v)
                     : v.is_object() ? point(v.value("point", Value{}))
                                     : std::nullopt;
            if (p)
                for (auto axis : {Vec3{1, 0, 0}, Vec3{0, 1, 0}, Vec3{0, 0, 1}})
                    seg(*p - axis * (scale * .08), *p + axis * (scale * .08), color, 1, .35);
            if (v.is_object())
                if (auto b = bounds(v.value("bounds", Value{})))
                    box(*b, color);
        }
        for (const auto &name : q.pick_order) {
            const auto &p = q.picks.at(name);
            auto color = tone(name);
            if (p.screen) {
                auto it = std::find_if(f.markers.begin(), f.markers.end(), [&](const auto &m) {
                    return m.point == *p.screen && m.tone == color;
                });
                if (it == f.markers.end())
                    f.markers.push_back({name, *p.screen, color});
                else
                    it->label += "\n" + name;
            }
        }
    }
    if (!status_.empty())
        line(status_);
    for (const auto &[_, w] : writes_)
        f.lines.push_back(w);
    auto now = options_.clock();
    for (const auto &[stream, c] : corrections_)
        if (!c.until || now < *c.until) {
            line(stream + " correction " + std::to_string(c.id) + ": " + c.state, "correction");
            if (c.until)
                f.expires_at = f.expires_at ? std::min(*f.expires_at, *c.until) : c.until;
        }
    return f;
}
} // namespace openaxis
