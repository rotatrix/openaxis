#ifndef NOMINMAX
#define NOMINMAX
#endif
#include "verify.hpp"
#include <openaxis/version.hpp>
#include "scheduled_work.hpp"
#include <chrono>
#include <climits>
#include <deque>
#include <ixwebsocket/IXNetSystem.h>
#include <ixwebsocket/IXWebSocket.h>
#include <map>
#include <mutex>
#include <openaxis/client.hpp>
#include <openaxis/diagnostics.hpp>
#include <openaxis/logging.hpp>

namespace openaxis {
using Clock = std::chrono::steady_clock;
struct OpenAxisClient::Impl {
    explicit Impl(OpenAxisClientOptions o, Scheduler::Callback run)
        : options(std::move(o)), work(options.scheduler, std::move(run)) {}
    OpenAxisClientOptions options;
    detail::ScheduledWork work;
    bool failed = false;
    std::shared_ptr<int> lifetime = std::make_shared<int>(0);
    std::uint64_t generation = 0;
    struct Listeners {
        std::map<std::uint64_t, std::shared_ptr<OpenAxisListener>> ordinary;
        std::shared_ptr<OpenAxisListener> navigation;
        std::uint64_t next_id = 0, navigation_id = 0;
    };
    std::shared_ptr<Listeners> listeners = std::make_shared<Listeners>();
    ConnectionState state = ConnectionState::Disconnected;
    std::vector<std::shared_ptr<OpenAxisListener>> snapshot(bool navigation_only = false) const {
        if (navigation_only && listeners->navigation) return {listeners->navigation};
        std::vector<std::shared_ptr<OpenAxisListener>> result;
        for (const auto &[_, listener] : listeners->ordinary)
            if (std::find(result.begin(), result.end(), listener) == result.end()) result.push_back(listener);
        return result;
    }
    ix::WebSocket socket;
    std::mutex mutex;
    struct Event {
        std::uint64_t epoch;
        Value message;
        bool local = false;
    };
    std::deque<Event> events;
    std::uint64_t network_epoch = 0, epoch = 0;
    std::optional<std::int64_t> latest_gesture;
    bool overflow = false, running = false, ready = false;
    bool verifying = false;
    verification::Bytes nonce;
    std::string last_verification_failure;
    void report_verification_failure(const std::string &message) {
        if (message == last_verification_failure) return;
        last_verification_failure = message;
        DiagnosticLog::emit("warning", message);
    }
    std::int64_t proof_id = 0;
    std::optional<double> verification_expiry;
    double verification_deadline = 0;
    Clock::time_point last_send = Clock::now(), opened = Clock::now();
    struct Pending {
        Reply reply;
        std::optional<Clock::time_point> deadline;
    };
    std::map<std::int64_t, Pending> pending;
    std::uint64_t next_id = 0;
    std::int64_t allocate_request_id() {
        if (next_id > static_cast<std::uint64_t>(max_integer))
            throw std::overflow_error("OpenAxis request IDs exhausted");
        return static_cast<std::int64_t>(next_id++);
    }
    void arm() {
        std::optional<double> next;
        auto consider = [&](double t) {
            if (!next || t < *next)
                next = t;
        };
        auto seconds = [](Clock::time_point t) {
            return std::chrono::duration<double>(t.time_since_epoch()).count();
        };
        if (running) {
            if (ready)
                consider(seconds(last_send) + 1);
            else if (socket.getReadyState() == ix::ReadyState::Open)
                consider(seconds(opened) + (verifying ? 10 : options.handshake_timeout));
            for (const auto &entry : pending)
                if (entry.second.deadline) consider(seconds(*entry.second.deadline));
        }
        work.at(next);
    }
    void fail_pending(const char *code) {
        auto old = std::move(pending);
        pending.clear();
        for (auto &entry : old)
            if (entry.second.reply)
                entry.second.reply(nullptr, {{"code", code}});
    }
    bool write(const Value &m) {
        auto bytes = Value::to_msgpack(m);
        auto sent = socket.sendBinary(std::string(bytes.begin(), bytes.end()));
        if (sent.success)
            last_send = Clock::now();
        return sent.success;
    }
};
OpenAxisClient::OpenAxisClient(OpenAxisClientOptions options, std::shared_ptr<OpenAxisListener> listener)
    : impl_(std::make_unique<Impl>(std::move(options), [this] { dispatch_pending(); })) {
    static const bool initialized = ix::initNetSystem();
    if (!initialized)
        throw std::runtime_error("socket initialization failed");
    auto &s = *impl_;
    if (s.options.max_queue < 8)
        throw std::invalid_argument("max_queue must be at least 8");
    if (s.options.client_name.find_first_not_of(" \t\r\n") == std::string::npos)
        throw std::invalid_argument("client_name is required");
    if (!std::isfinite(s.options.handshake_timeout) || s.options.handshake_timeout <= 0 ||
        s.options.handshake_timeout > INT_MAX)
        throw std::invalid_argument("handshake_timeout must be positive and finite");
    Value hello = {{"type", "hello"}, {"proto", "openaxis/1.0"}, {"client_name", s.options.client_name}};
    if (!s.options.target.is_null()) hello["target"] = s.options.target;
    if (s.options.client_version) hello["client_version"] = *s.options.client_version;
    validate_message(hello);
    if (listener) add_listener(std::move(listener));
    s.socket.setUrl(s.options.url);
    s.socket.disablePerMessageDeflate();
    s.socket.setHandshakeTimeout(static_cast<int>(std::ceil(s.options.handshake_timeout)));
    s.socket.disableAutomaticReconnection();
    s.socket.setOnMessageCallback([this](const ix::WebSocketMessagePtr &event) {
        auto &p = *impl_;
        Value message;
        bool local = event->type != ix::WebSocketMessageType::Message;
        try {
            if (event->type == ix::WebSocketMessageType::Open)
                message = {{"type", "_open"}};
            else if (event->type == ix::WebSocketMessageType::Close)
                message = {{"type", "_close"}};
            else if (event->type == ix::WebSocketMessageType::Error)
                message = {{"type", "_error"}, {"message", event->errorInfo.reason}};
            else if (event->type == ix::WebSocketMessageType::Message) {
                if (!event->binary || event->str.size() > 1024 * 1024)
                    throw std::invalid_argument("expected binary message <= 1 MiB");
                message = Value::from_msgpack(event->str);
                validate_message(message, true);
                if (message["type"] == "request" && !message.contains("params"))
                    message["params"] = Value::object();
            } else
                return;
        } catch (const std::exception &e) {
            std::optional<std::int64_t> request_id;
            if (message.is_object() && message.value("type", Value()) == "request" && message.contains("id")) {
                try { request_id = integer(message["id"]); } catch (...) {}
            }
            local = true;
            if (request_id) message = {{"type", "_bad_request"}, {"id", *request_id}, {"message", e.what()}};
            else {
                message = {{"type", "_error"}, {"message", e.what()}};
                p.socket.close(1002, "invalid OpenAxis message");
            }
        }
        [&] {
            std::lock_guard<std::mutex> lock(p.mutex);
            if (local && message["type"] == "_open") {
                ++p.network_epoch;
                p.events.clear();
                p.latest_gesture.reset();
            }
            if (message["type"] == "motion_start") {
                auto id = integer(message["gesture_id"]);
                if (!p.latest_gesture || id > *p.latest_gesture)
                    p.latest_gesture = id;
            }
            // Replace only adjacent poses: never move a pose across a
            // query/end/barrier.
            if (!p.events.empty() &&
                (message["type"] == "camera.pose" || message["type"] == "object.pose")) {
                auto &tail = p.events.back();
                if (tail.epoch == p.network_epoch && tail.message["type"] == message["type"] &&
                    tail.message.value("gesture_id", Value()) == message["gesture_id"] &&
                    integer(message["seq"]) > integer(tail.message["seq"])) {
                    tail.message = std::move(message);
                    return;
                }
            }
            if (p.events.size() >= p.options.max_queue) {
                p.overflow = true;
                p.events.clear();
                return;
            }
            p.events.push_back({p.network_epoch, std::move(message), local});
        }();
        p.work.request();
    });
}
OpenAxisClient::~OpenAxisClient() {
    on_connection = {};
    on_message = {};
    on_error = {};
    impl_->pending.clear();
    impl_->listeners->ordinary.clear();
    impl_->listeners->navigation.reset();
    disconnect();
}
void OpenAxisClient::connect() {
    if (!impl_->running && impl_->state != ConnectionState::Disconnecting) {
        ++impl_->generation;
        impl_->running = true;
        impl_->failed = false;
        impl_->verifying = false;
        impl_->verification_expiry.reset();
        const auto generation = impl_->generation;
        set_state(ConnectionState::Connecting);
        if (impl_->running && impl_->generation == generation) impl_->socket.start();
    }
}
Scheduler *OpenAxisClient::scheduler() const { return impl_->options.scheduler; }
bool OpenAxisClient::running() const { return impl_->running; }
void OpenAxisClient::disconnect() {
    auto &p = *impl_;
    if (!p.running)
        return;
    ++p.generation;
    p.running = false;
    bool was = p.ready;
    p.ready = false;
    set_state(ConnectionState::Disconnecting);
    p.socket.stop();
    p.work.reset();
    {
        std::lock_guard<std::mutex> lock(p.mutex);
        p.events.clear();
        p.overflow = false;
    }
    p.fail_pending("disconnected");
    if (was && on_connection)
        on_connection(false);
    if (lifecycle_) lifecycle_(false, "connection stopped");
    set_state(ConnectionState::Disconnected);
}
bool OpenAxisClient::connected() const { return impl_->ready; }
ConnectionState OpenAxisClient::state() const { return impl_->state; }
std::function<void()> OpenAxisClient::add_listener(std::shared_ptr<OpenAxisListener> listener) {
    if (!listener) throw std::invalid_argument("listener is required");
    auto &registry = *impl_->listeners;
    auto id = ++registry.next_id;
    for (const auto &[existing, item] : registry.ordinary)
        if (item == listener) { id = existing; break; }
    registry.ordinary[id] = std::move(listener);
    return [weak = std::weak_ptr<Impl::Listeners>(impl_->listeners), id] {
        if (auto registry = weak.lock()) registry->ordinary.erase(id);
    };
}
std::function<void()> OpenAxisClient::attach_navigation(std::shared_ptr<OpenAxisListener> listener) {
    if (!listener) throw std::invalid_argument("navigation listener is required");
    auto &registry = *impl_->listeners;
    if (registry.navigation) throw std::logic_error("a NavigationSession is already attached");
    const auto id = registry.navigation_id = ++registry.next_id;
    registry.navigation = std::move(listener);
    return [weak = std::weak_ptr<Impl::Listeners>(impl_->listeners), id] {
        if (auto registry = weak.lock(); registry && registry->navigation_id == id)
            registry->navigation.reset();
    };
}
void OpenAxisClient::set_state(ConnectionState state) {
    auto &p = *impl_;
    if (state == p.state) return;
    p.state = state;
    const auto generation = p.generation;
    auto listeners = p.snapshot();
    if (p.listeners->navigation && std::find(listeners.begin(), listeners.end(), p.listeners->navigation) == listeners.end())
        listeners.insert(listeners.begin(), p.listeners->navigation);
    for (const auto &listener : listeners) {
        if (generation != p.generation || p.state != state) break;
        try { listener->on_state_change(state); } catch (...) {}
    }
}
const std::string &OpenAxisClient::url() const { return impl_->options.url; }
std::function<bool(const Value &)> OpenAxisClient::capture_navigation_sender() {
    if (!connected()) throw std::logic_error("client is not connected");
    return [this, life = std::weak_ptr<int>(impl_->lifetime), generation = impl_->generation](const Value &message) {
        return !life.expired() && generation == impl_->generation && send(message);
    };
}
bool OpenAxisClient::send(const Value &m) {
    validate_message(m);
    auto &p = *impl_;
    if (p.verification_expiry &&
        (diagnostic_time() >= p.verification_deadline ||
         std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch())
                 .count() >= *p.verification_expiry))
        return false;
    return p.ready && p.write(m);
}
bool OpenAxisClient::send_tags(std::vector<std::string> v) {
    return send({{"type", "tags"}, {"tags", v}});
}
bool OpenAxisClient::send_capabilities(std::vector<std::string> v) {
    return send({{"type", "capabilities"}, {"capabilities", v}});
}
bool OpenAxisClient::send_focus(bool v) {
    return send({{"type", "focus"}, {"focused", v}});
}
bool OpenAxisClient::subscribe(std::vector<std::string> v) {
    return send({{"type", "subscribe"}, {"axes", v}});
}
bool OpenAxisClient::send_motion_cancel(std::int64_t id, std::optional<std::string> reason) {
    Value message = {{"type", "motion_cancel"}, {"gesture_id", id}};
    if (reason) message["reason"] = *reason;
    return send(message);
}
bool OpenAxisClient::send_viewport_settled() { return send({{"type", "viewport.settled"}}); }
bool OpenAxisClient::send_camera_pose(std::int64_t id, Vec3 t, Vec3 r,
                                    std::optional<double> fov, std::optional<double> extent) {
    Value message = {{"type", "camera.pose"}, {"gesture_id", id}, {"t", vector_value(t)}, {"r", vector_value(r)}};
    if (fov) message["fov"] = *fov;
    if (extent) message["ortho_extent"] = *extent;
    return send(message);
}
bool OpenAxisClient::send_camera_delta(std::int64_t id, Vec3 t, Vec3 r,
                                     std::optional<double> scale, std::optional<std::int64_t> delta) {
    Value message = {{"type", "camera.delta"}, {"gesture_id", id}, {"t", vector_value(t)}, {"r", vector_value(r)}};
    if (scale) message["ortho_extent_scale"] = *scale;
    if (delta) message["delta_id"] = *delta;
    return send(message);
}
bool OpenAxisClient::send_object_pose(std::int64_t id, Vec3 t, Vec3 r) {
    return send({{"type", "object.pose"}, {"gesture_id", id}, {"t", vector_value(t)}, {"r", vector_value(r)}});
}
bool OpenAxisClient::send_object_delta(std::int64_t id, Vec3 t, Vec3 r, std::optional<std::int64_t> delta) {
    Value message = {{"type", "object.delta"}, {"gesture_id", id}, {"t", vector_value(t)}, {"r", vector_value(r)}};
    if (delta) message["delta_id"] = *delta;
    return send(message);
}
bool OpenAxisClient::send_response(std::int64_t id, Value result) {
    return send({{"type", "response"}, {"id", id}, {"result", std::move(result)}});
}
bool OpenAxisClient::send_response_error(std::int64_t id, std::string code, std::optional<std::string> message) {
    Value error = {{"code", std::move(code)}};
    if (message) error["message"] = *message;
    return send({{"type", "response"}, {"id", id}, {"error", std::move(error)}});
}
std::int64_t OpenAxisClient::execute_command(std::string name, Value params, Reply reply, std::optional<double> seconds) {
    if (name.find_first_not_of(" \t\r\n") == std::string::npos || !params.is_object() || params.contains("name"))
        throw std::invalid_argument("command name is required and params must not contain name");
    params["name"] = std::move(name);
    return request("command.execute", std::move(params), std::move(reply), seconds);
}
std::int64_t OpenAxisClient::request(std::string method, Value params, Reply reply, std::optional<double> seconds) {
    if (seconds && (!std::isfinite(*seconds) || *seconds < 0))
        throw std::invalid_argument("invalid RPC timeout");
    if (seconds && *seconds > std::chrono::duration<double>(Clock::time_point::max() - Clock::now()).count())
        throw std::invalid_argument("RPC timeout exceeds the clock range");
    auto &p = *impl_;
    auto id = p.allocate_request_id();
    if (!send({{"type", "request"}, {"id", id}, {"method", method}, {"params", params}})) {
        if (reply)
            reply(nullptr, {{"code", "disconnected"}});
        return id;
    }
    std::optional<Clock::time_point> deadline;
    if (seconds) deadline = Clock::now() + std::chrono::duration_cast<Clock::duration>(std::chrono::duration<double>(*seconds));
    p.pending.emplace(id, Impl::Pending{std::move(reply), deadline});
    p.arm();
    return id;
}
void OpenAxisClient::cancel_request(std::int64_t id) {
    auto &p = *impl_;
    auto it = p.pending.find(id);
    if (it != p.pending.end()) {
        auto cb = std::move(it->second.reply);
        p.pending.erase(it);
        if (cb)
            cb(nullptr, {{"code", "cancelled"}});
    }
}
void OpenAxisClient::dispatch(const Value &m) {
    auto &p = *impl_;
    const auto generation = p.generation;
    const auto type = m.at("type").get<std::string>();
    const bool lifecycle = type == "motion_start" || type == "motion_end";
    const bool navigation = type == "navigation.state" || type == "camera.pose" || type == "object.pose" ||
        type == "camera.pivot" || type == "object.pivot";
    auto notify = [&](auto callback) {
        auto listeners = p.snapshot(navigation);
        if (lifecycle && p.listeners->navigation && std::find(listeners.begin(), listeners.end(), p.listeners->navigation) == listeners.end())
            listeners.insert(listeners.begin(), p.listeners->navigation);
        for (const auto &listener : listeners) {
            if (generation != p.generation || !p.ready) break;
            try { callback(*listener); } catch (...) {}
        }
    };
    if (type == "request") {
        const Request request{integer(m.at("id")), m.at("method").get<std::string>(), m.value("params", Value::object())};
        const auto send = capture_navigation_sender();
        std::optional<NavigationQuery> query;
        auto error = [&](const std::string &code, const std::string &message) {
            if (query && query->completed()) return;
            send({{"type", "response"}, {"id", request.id}, {"error", {{"code", code}, {"message", message}}}});
        };
        try {
            bool handled = false;
            if (request.method == "navigation.query") {
                query.emplace(request, send);
                for (const auto &listener : p.snapshot(true)) {
                    if (generation != p.generation || !p.ready) return;
                    try { handled = listener->on_navigation_query(*query); }
                    catch (...) { if (query->completed()) return; throw; }
                    if (handled || query->completed()) { handled = true; break; }
                }
            }
            if (!handled) {
                for (const auto &listener : p.snapshot()) {
                    if (generation != p.generation || !p.ready) return;
                    if (listener->on_request(request) || (query && query->completed())) { handled = true; break; }
                }
            }
            // Preserve the explicitly installed raw handler for low-level users.
            if (!handled && on_message && !p.listeners->navigation) { on_message(m); handled = true; }
            if (!handled) error("unsupported", "Unsupported method: " + request.method);
        } catch (const std::invalid_argument &e) { error("bad_request", e.what()); }
          catch (const std::exception &e) { error("unavailable", e.what()); }
          catch (...) { error("unavailable", "request handler failed"); }
        return;
    }
    if (type == "frame") {
        const Frame value{integer(m.at("seq")), integer(m.at("t_us")), m.at("values").get<std::vector<double>>()};
        notify([&](auto &l) { l.on_frame(value); });
    } else if (type == "axes") {
        const auto axes = m.at("axes").get<std::vector<std::string>>();
        notify([&](auto &l) { l.on_axes(axes); });
    } else if (type == "buttons") notify([&](auto &l) { l.on_buttons(integer(m.at("buttons"))); });
    else if (type == "motion_start") notify([&](auto &l) { l.on_motion_start(integer(m.at("gesture_id"))); });
    else if (type == "motion_end") notify([&](auto &l) { l.on_motion_end(integer(m.at("gesture_id"))); });
    else if (type == "camera.pose" || type == "object.pose") {
        auto fill = [&](auto &value) {
            static_cast<Pose &>(value) = pose_from(m, type == "camera.pose");
            value.gesture_id = integer(m.at("gesture_id"));
            if (m.contains("seq")) value.seq = integer(m["seq"]);
            if (m.contains("applied_delta_id")) value.applied_delta_id = integer(m["applied_delta_id"]);
        };
        if (type == "camera.pose") { CameraPose value; fill(value); notify([&](auto &l) { l.on_camera_pose(value); }); }
        else { ObjectPose value; fill(value); notify([&](auto &l) { l.on_object_pose(value); }); }
    } else if (type == "camera.pivot") {
        const CameraPivot value{integer(m.at("gesture_id")), vector_from(m.at("point"))};
        notify([&](auto &l) { l.on_camera_pivot(value); });
    } else if (type == "object.pivot") {
        const ObjectPivot value{integer(m.at("gesture_id")), vector_from(m.at("point"))};
        notify([&](auto &l) { l.on_object_pivot(value); });
    } else if (type == "navigation.state") {
        NavigationState value{integer(m.at("gesture_id")), {}, {}};
        if (m.contains("camera")) {
            const auto &camera = m["camera"];
            CameraNavigationState state{camera.at("mode").get<std::string>(), {}, {}, {}};
            if (camera.contains("lock_roll")) state.lock_roll = camera["lock_roll"].get<bool>();
            if (camera.contains("lock_translation_plane")) state.lock_translation_plane = camera["lock_translation_plane"].get<bool>();
            if (camera.contains("translation_scale")) state.translation_scale = camera["translation_scale"].get<double>();
            value.camera = state;
        }
        if (m.contains("object")) value.object = ObjectNavigationState{m["object"]["allow_translation"].get<bool>(), m["object"]["allow_rotation"].get<bool>()};
        notify([&](auto &l) { l.on_navigation_state(value); });
    } else if (type == "response") {
        const Response value{integer(m.at("id")), m.value("result", Value{}), m.value("error", Value{})};
        notify([&](auto &l) { l.on_response(value); });
    } else if (type == "error") notify([&](auto &l) {
        l.on_error(m.at("code").get<std::string>(), m.at("message").get<std::string>());
    });
    else if (type != "heartbeat" && type != "hello" && type != "hello_ack" && type != "tags" &&
             type != "capabilities" && type != "subscribe" && type != "motion_cancel" &&
             type != "viewport.settled" && type != "camera.delta" && type != "object.delta")
        notify([&](auto &l) { l.on_extension(type, m); });
    if (generation == p.generation && p.ready && on_message && !(navigation && p.listeners->navigation))
        on_message(m);
}
void OpenAxisClient::dispatch_pending() {
    auto &p = *impl_;
    if (!p.running)
        return;
    const auto poll_generation = p.generation;
    struct Rearm {
        Impl &p;
        ~Rearm() { p.arm(); }
    } rearm{p};
    std::deque<Impl::Event> events;
    bool overflow;
    {
        std::lock_guard<std::mutex> lock(p.mutex);
        events.swap(p.events);
        overflow = p.overflow;
        p.overflow = false;
    }
    auto failed = [&](const std::string &error) {
        if (!p.running || p.failed) return;
        p.failed = true;
        if (lifecycle_) lifecycle_(false, error);
    };
    auto disconnected = [&]() {
        bool was = p.ready;
        p.ready = false;
        p.verifying = false;
        p.verification_expiry.reset();
        p.fail_pending("disconnected");
        if (was && on_connection)
            on_connection(false);
        set_state(ConnectionState::Disconnected);
    };
    if (overflow) {
        disconnected();
        p.socket.close(1008, "host queue overflow");
        failed("OpenAxis host queue overflow");
        if (on_error)
            on_error("OpenAxis host queue overflow");
        return;
    }
    for (const auto &e : events) {
        if (!p.running || p.failed || p.generation != poll_generation) break;
        const auto &m = e.message;
        auto type = m["type"].get<std::string>();
        std::optional<std::int64_t> latest_gesture;
        {
            std::lock_guard<std::mutex> lock(p.mutex);
            if (e.epoch != p.network_epoch)
                continue;
            latest_gesture = p.latest_gesture;
        }
        if (!e.local && p.socket.getReadyState() != ix::ReadyState::Open)
            continue;
        // A replacement gesture invalidates old UI work as soon as networking
        // receives it, even if the host has not drained the replacement start.
        if (latest_gesture) {
            if ((type == "motion_start" || type == "motion_end" || type == "navigation.state" ||
                 type == "camera.pose" || type == "object.pose" || type == "camera.pivot" || type == "object.pivot") &&
                integer(m["gesture_id"]) < *latest_gesture)
                continue;
            if (type == "request" && m["method"] == "navigation.query" &&
                m["params"].contains("gesture_id") &&
                integer(m["params"]["gesture_id"]) < *latest_gesture) {
                send({{"type", "response"}, {"id", m["id"]}, {"error", {{"code", "cancelled"}}}});
                continue;
            }
        }
        if (e.local && type == "_open") {
            if (p.ready) disconnected();
            p.epoch = e.epoch;
            p.opened = Clock::now();
            Value hello = {
                {"type", "hello"}, {"proto", "openaxis/1.0"}, {"client_name", p.options.client_name},
                {"sdk", {{"name", "openaxis-cpp"}, {"version", sdk_version}}}};
            if (p.options.client_version) hello["client_version"] = *p.options.client_version;
            if (!p.options.target.is_null())
                hello["target"] = p.options.target;
            p.write(hello);
        } else if (e.epoch != p.epoch)
            continue;
        else if (e.local && type == "_bad_request") {
            p.write({{"type", "response"}, {"id", m["id"]}, {"error", {{"code", "bad_request"}, {"message", m["message"]}}}});
        } else if (e.local && (type == "_close" || type == "_error")) {
            disconnected();
            failed(m.value("message", "connection lost"));
            if (type == "_error" && on_error)
                on_error(m.value("message", "connection error"));
        } else if (type == "hello_ack") {
            if (p.ready || p.verifying || m.value("proto", "") != "openaxis/1.0") {
                disconnected();
                p.socket.close(1002, "invalid hello_ack");
                continue;
            }
            try {
                p.nonce = verification::challenge();
                p.proof_id = p.allocate_request_id();
                p.verifying = true;
                p.opened = Clock::now();
                p.write({{"type", "request"},
                         {"id", p.proof_id},
                         {"method", "q"},
                         {"params", {{"v", 1}, {"c", Value::binary(p.nonce)}}}});
            } catch (...) {
                disconnected();
                p.socket.close(1008, "verification failed");
            }
        } else if (p.verifying && type == "response" && integer(m.at("id")) == p.proof_id) {
            try {
                if (m.contains("error")) {
                    const auto code = m["error"].value("code", "");
                    const auto reason = code == "unavailable" || code == "busy" || code == "forbidden" || code == "bad_request" ? code : "remote_error";
                    p.report_verification_failure("verification.failed stage=server_response reason=" + reason);
                    throw std::runtime_error("verification denied");
                }
                if (Value::to_msgpack(m).size() > 20 * 1024) {
                    p.report_verification_failure("verification.failed stage=envelope reason=response_too_large");
                    throw std::runtime_error("verification denied");
                }
                p.verification_expiry = verification::verify(m.at("result"), p.nonce, verification::bundled_roots(), -1,
                    [&p](const std::string &message) { p.report_verification_failure(message); });
                p.last_verification_failure.clear();
                if (p.verification_expiry) {
                    auto wall = std::chrono::duration<double>(
                                    std::chrono::system_clock::now().time_since_epoch())
                                    .count();
                    p.verification_deadline =
                        diagnostic_time() + std::max(0., *p.verification_expiry - wall);
                }
            } catch (...) {
                disconnected();
                p.socket.close(1008, "verification failed");
                continue;
            }
            p.verifying = false;
            p.ready = true;
            set_state(ConnectionState::Connected);
            if (p.generation != poll_generation || !p.ready) continue;
            if (lifecycle_) lifecycle_(true, {});
            if (p.generation == poll_generation && p.ready && on_connection)
                on_connection(true);
        } else if (p.ready) {
            if (p.verification_expiry &&
                (diagnostic_time() >= p.verification_deadline ||
                 std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch())
                         .count() >= *p.verification_expiry)) {
                disconnected();
                p.socket.close(1008, "verification expired");
                continue;
            }
            if (type == "response") {
                auto it = p.pending.find(integer(m.at("id")));
                if (it != p.pending.end()) {
                    auto cb = std::move(it->second.reply);
                    p.pending.erase(it);
                    if (cb)
                        cb(m.value("result", Value()), m.value("error", Value()));
                } else dispatch(m);
            } else dispatch(m);
        }
    }
    if (p.generation != poll_generation) return;
    auto now = Clock::now();
    if (p.verification_expiry &&
        (diagnostic_time() >= p.verification_deadline ||
         std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch())
                 .count() >= *p.verification_expiry)) {
        disconnected();
        p.socket.close(1008, "verification expired");
    }
    if (p.ready && now - p.last_send >= std::chrono::seconds(1))
        send({{"type", "heartbeat"}});
    if (!p.ready && p.socket.getReadyState() == ix::ReadyState::Open &&
        now - p.opened >= std::chrono::duration<double>(p.verifying ? 10 : p.options.handshake_timeout))
        p.socket.close(1002, "connection verification timeout");
    std::vector<std::int64_t> expired;
    for (const auto &e : p.pending)
        if (e.second.deadline && now >= *e.second.deadline)
            expired.push_back(e.first);
    for (auto id : expired) {
        auto it = p.pending.find(id);
        if (it == p.pending.end())
            continue;
        auto cb = std::move(it->second.reply);
        p.pending.erase(it);
        if (cb)
            cb(nullptr, {{"code", "timeout"}});
    }
}
} // namespace openaxis
