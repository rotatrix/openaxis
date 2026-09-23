#include <openaxis/connection_manager.hpp>
#include <openaxis/diagnostics.hpp>
#include <openaxis/logging.hpp>
#include "scheduled_work.hpp"
#include <random>

namespace openaxis {
struct OpenAxisConnectionManager::Impl {
    OpenAxisClient &client;
    OpenAxisConnectionManagerOptions options;
    detail::ScheduledWork work;
    ConnectionStatus status;
    bool running = false, outage_logged = false;
    double delay;
    std::optional<double> startup_deadline;
    std::uint64_t generation = 0;
    std::mt19937 random{std::random_device{}()};
    Impl(OpenAxisClient &c, OpenAxisConnectionManagerOptions o, Scheduler *s, Scheduler::Callback run)
        : client(c), options(std::move(o)), work(s, std::move(run)), delay(options.retry.initial_delay) {}
};
OpenAxisConnectionManager::OpenAxisConnectionManager(OpenAxisClient &client, OpenAxisConnectionManagerOptions options)
    : impl_(std::make_unique<Impl>(client, std::move(options), client.scheduler(), [this] { dispatch_pending(); })) {
    const auto &r = impl_->options.retry;
    if (!impl_->options.metadata)
        throw std::invalid_argument("metadata provider is required");
    if (!std::isfinite(impl_->options.startup_timeout) || impl_->options.startup_timeout <= 0)
        throw std::invalid_argument("startup_timeout must be positive and finite");
    if (!std::isfinite(r.initial_delay) || !std::isfinite(r.max_delay) ||
        !std::isfinite(r.multiplier) || !std::isfinite(r.jitter) || r.initial_delay <= 0 ||
        r.max_delay < r.initial_delay || r.multiplier < 1 || r.jitter < 0 || r.jitter > 1)
        throw std::invalid_argument("invalid retry policy");
    if (client.lifecycle_ || client.running())
        throw std::logic_error("client already in use");
    client.lifecycle_ = [this](bool connected, const std::string &error) { changed(connected, error); };
}
OpenAxisConnectionManager::~OpenAxisConnectionManager() {
    on_state = {};
    stop();
    impl_->client.lifecycle_ = {};
}
ConnectionStatus OpenAxisConnectionManager::status() const { return impl_->status; }
void OpenAxisConnectionManager::notify(ConnectionStatus status) {
    auto &p = *impl_;
    p.status = std::move(status);
    try {
        const auto log = p.options.log ? p.options.log : DiagnosticLog::emit;
        if (p.status.state == "connecting" && !p.outage_logged)
            log("info", "connecting to " + p.client.url());
        else if (p.status.state == "ready")
            log("info", "connected to " + p.client.url() + " \xC2\xB7 openaxis/1.0");
        else if (p.status.state == "retrying" && !p.outage_logged) {
            std::ostringstream delay;
            delay.imbue(std::locale::classic());
            delay << std::fixed << std::setprecision(3)
                  << std::max(0., p.status.retry_at.value_or(diagnostic_time()) - diagnostic_time());
            log("warning", "connection failed \xE2\x80\x94 " + p.status.error +
                " \xC2\xB7 retrying in " + delay.str() + " s");
        }
        else if (p.status.state == "stopped")
            log("info", "connection stopped");
    } catch (...) {}
    if (p.status.state == "retrying") p.outage_logged = true;
    else if (p.status.state == "ready" || p.status.state == "stopped") p.outage_logged = false;
    try { if (on_state) on_state(p.status); } catch (...) {}
}
void OpenAxisConnectionManager::start() {
    auto &p = *impl_;
    if (p.running || p.status.state == "stopping") return;
    if (p.client.running()) throw std::logic_error("client already in use");
    p.running = true;
    p.delay = p.options.retry.initial_delay;
    begin_attempt();
}
void OpenAxisConnectionManager::begin_attempt() {
    auto &p = *impl_;
    ++p.generation;
    p.startup_deadline = diagnostic_time() + p.options.startup_timeout;
    notify({"connecting", {}, {}});
    if (p.running) {
        p.work.at(p.startup_deadline);
        p.client.connect();
    }
}
void OpenAxisConnectionManager::stop() {
    auto &p = *impl_;
    if (!p.running) return;
    p.running = false;
    ++p.generation;
    p.startup_deadline.reset();
    p.work.reset();
    notify({"stopping", {}, {}});
    p.client.disconnect();
    notify({"stopped", {}, {}});
}
void OpenAxisConnectionManager::refresh_metadata() {
    auto &p = *impl_;
    if (!p.running || !p.client.connected()) return;
    const auto generation = p.generation;
    const auto send = p.client.capture_navigation_sender();
    const auto metadata = p.options.metadata();
    if (!p.running || generation != p.generation || !p.client.connected()) return;
    if (p.startup_deadline && diagnostic_time() >= *p.startup_deadline)
        throw std::runtime_error("Connection startup timed out");
    auto announce = [&](const Value &message) {
        if (!send(message)) throw std::runtime_error("metadata connection retired");
    };
    announce({{"type", "tags"}, {"tags", metadata.tags}});
    announce({{"type", "capabilities"}, {"capabilities", metadata.capabilities}});
    if (metadata.axes) announce({{"type", "subscribe"}, {"axes", *metadata.axes}});
    if (metadata.focused) announce({{"type", "focus"}, {"focused", *metadata.focused}});
}
void OpenAxisConnectionManager::changed(bool connected, const std::string &error) {
    auto &p = *impl_;
    if (!p.running) return;
    if (connected) {
        const auto generation = p.generation;
        if (p.startup_deadline && diagnostic_time() >= *p.startup_deadline) {
            changed(false, "Connection startup timed out");
            return;
        }
        try { refresh_metadata(); }
        catch (const std::exception &e) {
            if (generation != p.generation) return;
            changed(false, e.what());
            return;
        } catch (...) {
            if (generation != p.generation) return;
            changed(false, "metadata provider failed");
            return;
        }
        if (!p.running || generation != p.generation || !p.client.connected()) return;
        if (p.startup_deadline && diagnostic_time() >= *p.startup_deadline) {
            changed(false, "Connection startup timed out");
            return;
        }
        p.startup_deadline.reset();
        p.work.reset();
        p.delay = p.options.retry.initial_delay;
        notify({"ready", {}, {}});
    } else {
        if (p.status.state == "retrying") return;
        p.startup_deadline.reset();
        p.work.reset();
        const auto &r = p.options.retry;
        const double delay = std::min(r.max_delay, p.delay *
            std::uniform_real_distribution<double>(1 - r.jitter, 1 + r.jitter)(p.random));
        p.delay = std::min(r.max_delay, p.delay * r.multiplier);
        const double retry_at = diagnostic_time() + delay;
        notify({"retrying", error, retry_at});
        if (p.running && p.status.state == "retrying") {
            p.client.disconnect();
            if (p.running && p.status.state == "retrying") p.work.at(retry_at);
        }
    }
}
void OpenAxisConnectionManager::dispatch_pending() {
    auto &p = *impl_;
    if (!p.running) return;
    if (p.running && p.startup_deadline && diagnostic_time() >= *p.startup_deadline)
        changed(false, "Connection startup timed out");
    if (p.running && p.status.state == "retrying" && p.status.retry_at &&
        diagnostic_time() >= *p.status.retry_at) {
        p.client.disconnect();
        if (!p.running) return;
        begin_attempt();
    }
}
} // namespace openaxis
