#include "scheduled_work.hpp"
#include "session_state.hpp"
#include "navigation_performance.hpp"
#include <algorithm>
#include <deque>
#include <openaxis/navigation.hpp>
namespace openaxis {
namespace {
Value context_value(const NavigationContext &context) {
    const auto *label = std::any_cast<std::string>(&context);
    return label ? Value(*label) : Value{};
}
}
struct NavigationSession::Impl {
    NavigationSession &owner;
    NavigationAdapter *adapter;
    Sender send;
    std::function<void()> detach;
    NavigationDiagnostics *collector;
    NavigationOptions options;
    detail::ScheduledWork work;
    bool closed = false, visuals_dirty = false, camera_dirty = false, object_dirty = false;
    detail::SessionState camera, object;
    detail::NavigationPerformance performance;
    NavigationContext context, object_context;
    std::vector<std::pair<NavigationAdapter *, NavigationContext>> cleanup;
    std::optional<Vec3> pivot, object_pivot;
    Value navigation;
    std::optional<detail::Accepted> deferred;
    std::int64_t last_gesture = -1;
    bool draining = false;
    struct Queued {
        Value message;
        std::optional<detail::Accepted> pose;
        unsigned epoch;
    };
    std::deque<Queued> queue;
    std::size_t active_queries = 0;
    Impl(NavigationSession &o, NavigationAdapter &h, Sender s, NavigationDiagnostics *c,
         NavigationOptions opts)
        : owner(o), adapter(&h), send(std::move(s)), collector(c), options(std::move(opts)),
          work(options.scheduler, [this] { update(); }),
          camera("camera", options.timeout, options.compare_camera),
          object("object", options.timeout, options.compare_object) {
        if (!options.clock || !options.max_work || !options.drain_budget || !options.max_queries)
            throw std::invalid_argument("invalid navigation options");
        if (collector)
            collector->bind(options.compare_camera, options.compare_object);
    }
    void arm() {
        if (closed)
            return;
        auto next = camera.deadline;
        if (object.deadline && (!next || *object.deadline < *next))
            next = object.deadline;
        work.at(next);
        if (!queue.empty() || visuals_dirty || camera.ending)
            work.request();
    }
    void evidence(const std::string &event, const Value &v = {}, NavigationContext captured = {}) {
        if (collector)
            try { collector->observe(event, v); } catch (...) {}
        if (!options.on_event)
            return;
        auto notify = [&](const std::string &name, const Value &values) {
            try { options.on_event({name, values, captured}); } catch (...) {}
        };
        if (event == "correction") {
            auto name = v.value("stream", "camera") == "object" ? "object_correction_" : "correction_";
            notify(name + v.at("state").get<std::string>(), v);
        } else {
            notify(event, v);
            if ((event == "camera_write" || event == "object_write") && v.value("success", false))
                notify(event == "camera_write" ? "camera_applied" : "object_applied", v);
        }
    }
    void emit(std::string event, std::string target = {}, std::string detail = {}) {
        try {
            if (owner.diagnostics)
                owner.diagnostics({event, target, detail, camera.gesture});
        } catch (...) {
        }
    }
    bool transmit(const Value &m) {
        try {
            return send(m);
        } catch (...) {
            return false;
        }
    }
    void clear_visuals() {
        if (context.has_value()) cleanup.emplace_back(adapter, context);
        if (object_context.has_value()) cleanup.emplace_back(options.object_adapter, object_context);
        context.reset();
        object_context.reset();
        pivot.reset();
        object_pivot.reset();
        navigation = {};
        deferred.reset();
        if (!draining && !closed) {
            visuals_dirty = true;
            work.request();
            return;
        }
        clear_host_visuals();
    }
    void clear_host_visuals() {
        visuals_dirty = false;
        auto pending = std::move(cleanup);
        cleanup.clear();
        for (const auto &item : pending) {
            try { if (item.first) item.first->show_pivot(item.second, {}); } catch (...) {}
        }
    }
    void cancel(const std::string &reason) {
        auto id = camera.gesture;
        const auto reply = send;
        const auto epoch = camera.epoch;
        performance.finish(reason, options.clock(), camera.token());
        camera.cancel(camera.token(), reason);
        object.cancel(object.token(), reason);
        clear_visuals();
        if (id) {
            evidence("cancelled", {{"gesture_id", *id}, {"reason", reason}});
            evidence("gesture_finished", {{"gesture_id", *id}, {"reason", reason}});
            if (!closed && camera.epoch == epoch)
                try { reply({{"type", "motion_cancel"}, {"gesture_id", *id}, {"reason", reason}}); } catch (...) {}
            emit("cancel", {}, reason);
        }
    }
    bool valid(detail::Token token) {
        if (closed || !camera.current(token))
            return false;
        if (context.has_value() || object_context.has_value()) {
            bool matches = false;
            try {
                const auto camera_bound = context, object_bound = object_context;
                matches = (!camera_bound.has_value() || adapter->is_current(camera_bound)) &&
                    (!object_bound.has_value() || options.object_adapter->is_current(object_bound));
            } catch (...) {
            }
            if (!camera.current(token))
                return false;
            if (!matches) {
                cancel("context_changed");
                if (collector)
                    collector->clear();
                return false;
            }
        }
        return camera.current(token);
    }
    std::optional<Pose> read(bool cam) {
        const auto captured_context = cam ? context : object_context;
        const bool measured = captured_context.has_value() && bool(cam ? options.observation : options.object_observation);
        auto *perf = performance.stream(camera.token(), !cam);
        const auto started = measured ? options.clock() : 0;
        auto record = [&] { if (measured && perf) perf->observation.add(options.clock() - started); };
        try {
            const auto captured = cam ? context : object_context;
            const auto &observe = cam ? options.observation : options.object_observation;
            auto result = captured.has_value() && observe ? observe(captured) : std::optional<Pose>{};
            record(); return result;
        } catch (...) {
            record(); return {};
        }
    }
    void effect(detail::SessionState &state, const detail::Effect &e, bool cam) {
        std::string target = cam ? "camera" : "object";
        if (e.kind == "cancel") {
            performance.finish(e.reason, options.clock(), e.token);
            auto &other = cam ? object : camera;
            other.cancel(other.token(), e.reason);
            clear_visuals();
            evidence("cancelled", {{"gesture_id", *e.gesture}, {"reason", e.reason}});
            evidence("gesture_finished", {{"gesture_id", *e.gesture}, {"reason", e.reason}});
            transmit({{"type", "motion_cancel"}, {"gesture_id", *e.gesture}, {"reason", e.reason}});
            return;
        }
        if (e.kind != "delta" && e.kind != "rebase")
            return;
        if (!state.current(e.token) || state.pending != e.delta)
            return;
        auto d = *e.difference;
        evidence("correction",
                 {{"stream", target},
                  {"state", "sent"},
                  {"delta_id", *e.delta},
                  {"difference",
                   {{"t", vector_value(d.t)}, {"r", vector_value(d.r)}, {"scale", d.scale}}}});
        if (e.kind == "rebase") {
            auto m = pose_value(*e.pose);
            m["type"] = target + ".pose";
            m["gesture_id"] = *e.gesture;
            if (!transmit(m)) {
                effect(state, state.send_failed(e.token, *e.delta), cam);
                return;
            }
        }
        if (!state.current(e.token) || state.pending != e.delta)
            return;
        Value m = {{"type", target + ".delta"},
                   {"gesture_id", *e.gesture},
                   {"delta_id", *e.delta},
                   {"t", vector_value(d.t)},
                   {"r", vector_value(d.r)}};
        if (cam && std::abs(d.scale - 1) > 1e-7)
            m["ortho_extent_scale"] = d.scale;
        if (!transmit(m))
            effect(state, state.send_failed(e.token, *e.delta), cam);
        emit("delta", target);
    }
    bool needs_pivot() const {
        return navigation.contains("camera") && navigation["camera"].value("mode", "") == "orbit" &&
               !pivot;
    }
    void apply(detail::Accepted accepted, bool cam) {
        auto &state = cam ? camera : object;
        if (!valid(accepted.token))
            return;
        if (cam && needs_pivot()) {
            deferred = accepted;
            return;
        }
        auto *perf = performance.stream(accepted.token, !cam);
        const auto received_at = perf ? perf->process(accepted.seq, options.clock()) : std::optional<double>{};
        auto actual = read(cam);
        if (!valid(accepted.token))
            return;
        auto pending = state.pending;
        auto e = state.process(accepted, actual, options.clock());
        const std::string target = cam ? "camera" : "object";
        if (pending && pending != state.pending && accepted.ack && *accepted.ack >= *pending)
            evidence("correction",
                     {{"stream", target}, {"state", "applied"}, {"delta_id", *pending}});
        if (e.kind == "apply") {
            if (!valid(accepted.token)) {
                state.complete(e.write, {}, options.clock(), false);
                return;
            }
            WriteResult result;
            const auto captured = cam ? context : object_context;
            try {
                auto *target_adapter = cam ? adapter : options.object_adapter;
                NavigationPose pose;
                static_cast<Pose &>(pose) = accepted.pose;
                pose.gesture_id = *state.gesture;
                pose.seq = accepted.seq;
                pose.applied_delta_id = accepted.ack;
                if (target_adapter && captured.has_value()) {
                    const auto started = options.clock();
                    try { result = target_adapter->apply_pose(captured, pose, navigation, cam ? pivot : object_pivot); }
                    catch (...) { if (perf) perf->applied(started, options.clock(), false, received_at); throw; }
                    if (perf) perf->applied(started, options.clock(), result.success, received_at);
                }
            } catch (...) {
            }
            bool current = valid(accepted.token);
            e = state.complete(e.write, !cam || options.observation ? result.realized : std::optional<Pose>{},
                               options.clock(), result.success);
            if (current) {
                evidence(cam ? "camera_write" : "object_write",
                         {{"context", context_value(cam ? context : object_context)},
                          {"desired", pose_value(accepted.pose)},
                          {"success", result.success},
                          {"realized", result.realized ? pose_value(*result.realized) : Value{}}}, captured);
                emit("write", target);
            }
        }
        if (e.kind == "hold" && state.pending)
            evidence("correction",
                     {{"stream", target}, {"state", "waiting"}, {"delta_id", *state.pending}});
        effect(state, e, cam);
    }
    void query(const Value &m) {
        ++active_queries;
        struct QueryGuard { std::size_t &count; ~QueryGuard() { --count; } } guard{active_queries};
        auto params = m.value("params", Value::object());
        auto token = camera.token();
        const auto reply = send;
        auto respond = [&](const Value &response) {
            if (closed || camera.epoch != token.epoch) return false;
            try { return reply(response); } catch (...) { return false; }
        };
        bool scoped = params.contains("gesture_id");
        auto reject = [&] {
            evidence("query_failed", {{"request_id", m["id"]}, {"error", "Navigation context unavailable"}});
            respond({{"type", "response"}, {"id", m["id"]},
                      {"error", {{"code", "unavailable"}}}});
        };
        if (scoped && (!camera.gesture || integer(params["gesture_id"]) != *camera.gesture ||
                       !valid(token))) {
            reject();
            return;
        }
        double started = options.clock();
        auto info = params;
        info["request_id"] = m["id"];
        evidence("query_started", info);
        struct Capture {
            NavigationContext context;
            std::unique_ptr<NavigationCapture> facts;
            std::optional<Pose> supplied, observation;
        };
        Capture captures[2];
        auto result = evaluate_query(params, [&](const std::string &name) -> Value {
            double begin = options.clock();
            Value value;
            try {
                if (closed || camera.epoch != token.epoch || (scoped && !valid(token))) return nullptr;
                const bool cam = name.rfind("object.", 0) != 0;
                auto *target = cam ? adapter : options.object_adapter;
                auto &item = captures[cam ? 0 : 1];
                const auto &bound = cam ? context : object_context;
                if (target) {
                    if (!item.facts) {
                        item.context = scoped && bound.has_value() ? bound : target->capture_context();
                        if (item.context.has_value() && target->is_current(item.context)) {
                            item.facts = target->begin_query(item.context);
                            const auto label = context_value(item.context);
                            if (collector && label.is_string()) collector->set_context(label.get<std::string>());
                            evidence("query_context", {{"request_id", m["id"]}, {"context", label}}, item.context);
                        }
                    }
                    if (item.facts) value = item.facts->resolve(name);
                    if (!value.is_null() && name == (cam ? "camera.pose" : "object.pose"))
                        item.supplied = pose_from(value, cam);
                }
                evidence("fact", {{"request_id", m["id"]},
                                  {"name", name},
                                  {"value", value},
                                  {"duration_ms", (options.clock() - begin) * 1000}});
            } catch (const std::exception &e) {
                evidence("fact", {{"request_id", m["id"]},
                                  {"name", name},
                                  {"error", e.what()},
                                  {"duration_ms", (options.clock() - begin) * 1000}});
                value = nullptr;
            }
            return value;
        });
        bool current = !closed && camera.epoch == token.epoch && (!scoped || valid(token));
        for (bool cam : {true, false}) {
            auto &item = captures[cam ? 0 : 1];
            if (!item.facts) continue;
            auto *target = cam ? adapter : options.object_adapter;
            const auto &observe = cam ? options.observation : options.object_observation;
            try { if (observe) item.observation = item.facts->initial_observation(); } catch (...) {}
            try { current = target->is_current(item.context) && current; } catch (...) { current = false; }
        }
        current = current && !closed && camera.epoch == token.epoch && (!scoped || valid(token));
        if (!current) {
            if (scoped && camera.current(token)) cancel("context_changed");
            reject();
            return;
        }
        if (scoped) for (bool cam : {true, false}) {
            auto &item = captures[cam ? 0 : 1];
            if (!item.facts) continue;
            (cam ? context : object_context) = item.context;
            if (item.supplied) {
                const auto initial = !cam && !options.object_observation ? item.supplied : item.observation;
                (cam ? camera : object).query(token, initial, true, true, true);
            }
        }
        if (!respond({{"type", "response"}, {"id", m["id"]}, {"result", result}}) && scoped) {
            cancel("query_send_failed");
            return;
        }
        info = {{"request_id", m["id"]}, {"result", result},
                {"duration_ms", (options.clock() - started) * 1000}};
        if (result.contains("first") && result["first"].is_object())
            info["selected"] = result["first"]["name"];
        evidence("query_completed", info);
        emit("query", {}, result.dump());
    }
    void process(const Queued &queued) {
        if (closed || queued.epoch != camera.epoch) return;
        const auto &m = queued.message;
        auto type = m.at("type").get<std::string>();
        if (type == "request") {
            if (m.at("method") == "navigation.query")
                query(m);
            else
                transmit(
                    {{"type", "response"}, {"id", m["id"]}, {"error", {{"code", "unsupported"}}}});
            return;
        }
        auto token = camera.token();
        if (!camera.gesture || !m.contains("gesture_id") ||
            integer(m["gesture_id"]) != *camera.gesture || !valid(token)) {
            if (m.contains("gesture_id"))
                evidence("output_rejected", {{"kind", type},
                                             {"gesture_id", m["gesture_id"]},
                                             {"reason", "inactive_or_stale_output"}});
            return;
        }
        if (type == "camera.pose" || type == "object.pose") {
            const bool cam = type == "camera.pose";
            if (!(cam ? context : object_context).has_value()) return;
            if (queued.pose) apply(*queued.pose, cam);
        } else if (type == "camera.pivot" || type == "object.pivot") {
            auto point = vector_from(m.at("point"));
            if (type == "camera.pivot") {
                pivot = point;
                try {
                    if (context.has_value()) adapter->show_pivot(context, point);
                } catch (...) {
                }
            } else {
                object_pivot = point;
                try {
                    if (object_context.has_value()) options.object_adapter->show_pivot(object_context, point);
                } catch (...) {
                }
            }
        } else if (type == "navigation.state") {
            navigation = m;
            evidence("navigation_state", {{"state", m}});
        }
        if (valid(token) && deferred && !needs_pivot()) {
            auto d = *deferred;
            deferred.reset();
            apply(d, true);
        }
    }
    void finish_ending() {
        if (!queue.empty() || !camera.ending || !camera.gesture) return;
        const auto id = *camera.gesture;
        performance.finish("motion_end", options.clock());
        camera.finish(camera.token());
        object.finish(object.token());
        clear_visuals();
        evidence("gesture_finished", {{"gesture_id", id}, {"reason", "ended"}});
        emit("end");
    }
    void receive(const Value &m) {
        auto entry_token = camera.token();
        try {
            validate_message(m);
            if (m.at("type") == "motion_start") {
                auto id = integer(m["gesture_id"]);
                if (id <= last_gesture)
                    return;
                const auto reply = send;
                const auto previous = camera.gesture;
                last_gesture = id;
                camera.start(id);
                object.start(id);
                performance.begin(id, camera.token(), options.clock());
                // Keep unscoped requests; retire old gesture work immediately.
                std::deque<Queued> retained;
                std::vector<Value> replies;
                auto retired = std::move(queue);
                queue.clear();
                for (const auto &item : retired) {
                    const auto &pending = item.message;
                    if (pending.at("type") != "request") continue;
                    if (!pending.value("params", Value::object()).contains("gesture_id"))
                        retained.push_back(item);
                    else
                        replies.push_back({{"type", "response"}, {"id", pending["id"]},
                                           {"error", {{"code", "unavailable"}}}});
                }
                queue = std::move(retained);
                clear_visuals();
                if (previous) evidence("gesture_finished", {{"gesture_id", *previous}, {"reason", "superseded"}});
                evidence("gesture_started", {{"gesture_id", id}});
                emit("start");
                for (const auto &message : replies) { try { reply(message); } catch (...) {} }
                return;
            }
            const auto type = m.at("type");
            if (type == "motion_end") {
                if (!camera.gesture || integer(m.at("gesture_id")) != *camera.gesture) return;
                camera.end(camera.token());
                object.end(object.token());
                work.request();
                return;
            }
            const auto pose = [](const Value &value) {
                return value.at("type") == "camera.pose" || value.at("type") == "object.pose";
            };
            const auto query = [](const Value &value) {
                return value.at("type") == "request" && value.value("method", "") == "navigation.query";
            };
            const auto rejected_output = [&] {
                evidence("output_rejected", {{"kind", type}, {"gesture_id", m.at("gesture_id")},
                                             {"reason", "inactive_or_stale_output"}});
            };
            if (type == "navigation.state" || type == "camera.pivot" || type == "object.pivot") {
                if (!camera.gesture || camera.ending || integer(m.at("gesture_id")) != *camera.gesture) return;
                if (!queue.empty() && queue.back().message.at("type") == type &&
                    queue.back().message.at("gesture_id") == m.at("gesture_id")) {
                    queue.back().message = m;
                    return;
                }
            }
            std::optional<detail::Accepted> accepted;
            if (pose(m)) {
                if (!camera.gesture || integer(m.at("gesture_id")) != *camera.gesture) { rejected_output(); return; }
                const bool cam = type == "camera.pose";
                if (!cam && !options.object_adapter) { cancel("object_navigation_unsupported"); return; }
                auto &stream = cam ? camera : object;
                accepted = stream.receive(stream.epoch, integer(m.at("gesture_id")), integer(m.at("seq")),
                                          pose_from(m, cam), m.contains("applied_delta_id")
                                            ? std::optional<std::int64_t>(integer(m.at("applied_delta_id"))) : std::nullopt);
                if (!accepted) { rejected_output(); return; }
                if (auto *perf = performance.stream(accepted->token, !cam)) {
                    if (cam && deferred && deferred->token == accepted->token && perf->pending == deferred->seq) ++perf->coalesced;
                    perf->receive(accepted->seq, options.clock());
                }
                // One reserved slot per stream. Append at the latest arrival
                // position so intervening queries retain their order.
                for (auto it = queue.begin(); it != queue.end();) {
                    if (it->message.at("type") == type && it->message.at("gesture_id") == m.at("gesture_id")) {
                        if (integer(it->message.at("seq")) >= integer(m.at("seq"))) return;
                        if (auto *perf = performance.stream(accepted->token, !cam)) ++perf->coalesced;
                        it = queue.erase(it);
                    } else ++it;
                }
            }
            if (query(m) && m.value("params", Value::object()).contains("gesture_id") &&
                (!camera.gesture || camera.ending || integer(m["params"]["gesture_id"]) != *camera.gesture)) {
                evidence("query_failed", {{"request_id", m["id"]}, {"error", "Navigation context unavailable"}});
                transmit({{"type", "response"}, {"id", m["id"]}, {"error", {{"code", "unavailable"}}}});
                return;
            }
            const auto queries = static_cast<std::size_t>(std::count_if(queue.begin(), queue.end(),
                [&](const Queued &item) { return query(item.message); }));
            const auto work_count = static_cast<std::size_t>(std::count_if(queue.begin(), queue.end(), [&](const Queued &item) {
                return !pose(item.message);
            }));
            if ((query(m) && queries + active_queries >= options.max_queries) ||
                (!pose(m) && work_count >= options.max_work)) {
                if (m.at("type") == "request")
                {
                    if (query(m)) evidence("query_failed", {{"request_id", m["id"]}, {"error", "Navigation queue capacity exceeded"}});
                    transmit({{"type", "response"},
                              {"id", m["id"]},
                              {"error", {{"code", "unavailable"}}}});
                }
                return;
            }
            queue.push_back({m, accepted, camera.epoch});
            work.request();
        } catch (const std::exception &e) {
            draining = false;
            if (m.value("method", "") == "navigation.query" && m.contains("id")) {
                evidence("query_failed", {{"request_id", m["id"]}, {"error", e.what()}});
                transmit({{"type", "response"},
                          {"id", m["id"]},
                          {"error", {{"code", "bad_request"}, {"message", e.what()}}}});
            }
            emit("error", {}, e.what());
            if (camera.current(entry_token))
                cancel("invalid_navigation");
        }
    }
    void update() {
        if (closed)
            return;
        struct Rearm {
            Impl &s;
            ~Rearm() { if (!s.draining) s.performance.flush(); s.arm(); }
        } rearm{*this};
        if (draining)
            return;
        const bool observe_camera = std::exchange(camera_dirty, false);
        const bool observe_object = std::exchange(object_dirty, false);
        if (visuals_dirty) {
            draining = true;
            clear_host_visuals();
            draining = false;
        }
        if (!queue.empty()) {
            draining = true;
            std::size_t budget = options.drain_budget;
            while (!closed && !queue.empty() && budget--) {
                auto next = std::move(queue.front());
                queue.pop_front();
                auto entry_token = camera.token();
                try {
                    process(next);
                } catch (const std::exception &e) {
                    if (next.message.value("method", "") == "navigation.query" && next.message.contains("id")) {
                        evidence("query_failed", {{"request_id", next.message["id"]}, {"error", e.what()}});
                        transmit({{"type", "response"},
                                  {"id", next.message["id"]},
                                  {"error", {{"code", "bad_request"}, {"message", e.what()}}}});
                    }
                    emit("error", {}, e.what());
                    if (camera.current(entry_token))
                        cancel("invalid_navigation");
                    break;
                } catch (...) {
                    if (camera.current(entry_token))
                        cancel("invalid_navigation");
                    break;
                }
            }
            draining = false;
        }
        finish_ending();
        auto token = camera.token();
        if (!valid(token))
            return;
        draining = true;
        struct Guard {
            bool &flag;
            ~Guard() { flag = false; }
        } guard{draining};
        for (bool cam : {true, false}) {
            auto &s = cam ? camera : object;
            if (s.pending)
                effect(s, s.expire(s.token(), *s.pending, options.clock()), cam);
            if (!valid(token))
                return;
            if (s.ready && (cam ? observe_camera : observe_object)) {
                auto actual = read(cam);
                if (!valid(token))
                    return;
                effect(s, s.observe(token, actual, options.clock()), cam);
            }
        }
    }
};
NavigationSession::NavigationSession(NavigationAdapter &a, Sender s, NavigationDiagnostics *c,
                                     NavigationOptions o)
    : impl_(std::make_unique<Impl>(*this, a, std::move(s), c, std::move(o))) {}
namespace {
struct SessionListener : OpenAxisListener {
    std::function<void(ConnectionState)> state;
    std::function<void(const Value &)> receive;
    void on_state_change(ConnectionState value) override { state(value); }
    void on_motion_start(std::int64_t id) override { receive({{"type", "motion_start"}, {"gesture_id", id}}); }
    void on_motion_end(std::int64_t id) override { receive({{"type", "motion_end"}, {"gesture_id", id}}); }
    void on_camera_pose(const CameraPose &value) override { receive(message_value(value)); }
    void on_object_pose(const ObjectPose &value) override { receive(message_value(value)); }
    void on_camera_pivot(const CameraPivot &value) override { receive(message_value(value)); }
    void on_object_pivot(const ObjectPivot &value) override { receive(message_value(value)); }
    void on_navigation_state(const NavigationState &value) override { receive(message_value(value)); }
    bool on_navigation_query(NavigationQuery query) override {
        query.claim();
        receive(message_value(query.request()));
        return true;
    }
};
}
NavigationSession::NavigationSession(OpenAxisClient &client, NavigationAdapter &adapter,
                                     NavigationDiagnostics *collector, NavigationOptions options)
    : NavigationSession(adapter, [](const Value &) { return false; }, collector, std::move(options)) {
    attach(client);
}
void NavigationSession::attach(OpenAxisClient &client) {
    auto listener = std::make_shared<SessionListener>();
    listener->receive = [this](const Value &message) { receive(message); };
    listener->state = [this, &client](ConnectionState state) {
        impl_->send = state == ConnectionState::Connected ? client.capture_navigation_sender()
                                                        : Sender([](const Value &) { return false; });
        connection_changed();
    };
    impl_->detach = client.attach_navigation(listener);
    if (client.state() == ConnectionState::Connected) listener->state(client.state());
}
NavigationSession::~NavigationSession() { close(); }
void NavigationSession::close() {
    auto &s = *impl_;
    if (s.closed)
        return;
    s.performance.finish("closed", s.options.clock());
    s.closed = true;
    if (s.detach) { s.detach(); s.detach = {}; }
    s.work.reset();
    s.queue.clear();
    const auto gesture = s.camera.gesture;
    s.camera.connection();
    s.object.connection();
    s.clear_visuals();
    if (gesture) s.evidence("gesture_finished", {{"gesture_id", *gesture}, {"reason", "closed"}});
    if (s.collector)
        s.collector->clear();
    if (!s.draining) s.performance.flush();
}
void NavigationSession::native_camera_changed() {
    auto &s = *impl_;
    if (s.closed)
        return;
    s.camera_dirty = true;
    s.work.request();
}
void NavigationSession::native_object_changed() {
    auto &s = *impl_;
    if (s.closed)
        return;
    s.object_dirty = true;
    s.work.request();
}
void NavigationSession::check_context() {
    auto &s = *impl_;
    if (s.closed)
        return;
    s.work.request();
}
void NavigationSession::context_changed() { cancel("context_changed"); }
bool NavigationSession::active() const { return impl_->camera.gesture && !impl_->camera.ending; }
void NavigationSession::receive(const Value &m) {
    if (!impl_->closed) {
        impl_->receive(m);
        impl_->arm();
        if (!impl_->draining) impl_->performance.flush();
    }
}
void NavigationSession::cancel(const std::string &reason) {
    if (!impl_->closed) {
        impl_->cancel(reason);
        impl_->arm();
        if (!impl_->draining) impl_->performance.flush();
    }
}
void NavigationSession::connection_changed() {
    auto &s = *impl_;
    if (s.closed)
        return;
    s.work.reset();
    const auto previous = s.camera.gesture;
    s.performance.finish("connection_changed", s.options.clock());
    s.camera.connection();
    s.object.connection();
    s.last_gesture = -1;
    s.queue.clear();
    s.clear_visuals();
    if (previous) s.evidence("gesture_finished", {{"gesture_id", *previous}, {"reason", "connection_changed"}});
    if (!s.draining) s.performance.flush();
    if (s.collector)
        s.collector->clear();
    s.emit("connection");
    s.arm();
}
void NavigationSession::viewport_settled() {
    if (!impl_->closed)
        impl_->transmit({{"type", "viewport.settled"}});
}
} // namespace openaxis
