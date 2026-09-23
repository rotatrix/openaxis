#pragma once
#include "session_state.hpp"
#include <openaxis/logging.hpp>

namespace openaxis::detail {
struct PerformanceTiming {
    std::uint64_t count = 0;
    double total = 0, maximum = 0;
    void add(double seconds) { auto ms = std::max(0.0, seconds * 1000); ++count; total += ms; maximum = std::max(maximum, ms); }
    std::string text() const {
        std::ostringstream out; out.imbue(std::locale::classic());
        out << std::fixed << std::setprecision(1) << (count ? total / count : 0) << '/' << maximum << " [" << count << ']';
        return out.str();
    }
};
struct PerformanceStream {
    std::uint64_t received = 0, coalesced = 0, succeeded = 0, failed = 0;
    PerformanceTiming incoming_gap, queue_wait, observation, apply, apply_start_gap, turnaround;
    std::optional<double> last_received, last_apply;
    std::optional<std::int64_t> pending;
    double queued_at = 0;
    void receive(std::int64_t sequence, double now) {
        ++received;
        if (last_received) incoming_gap.add(now - *last_received);
        last_received = queued_at = now; pending = sequence;
    }
    std::optional<double> process(std::int64_t sequence, double now) {
        if (pending != sequence) return {};
        queue_wait.add(now - queued_at); pending.reset();
        return queued_at;
    }
    void applied(double start, double end, bool success, std::optional<double> received_at = {}) {
        if (last_apply) apply_start_gap.add(start - *last_apply);
        last_apply = start; apply.add(end - start);
        if (success) { ++succeeded; if (received_at) turnaround.add(end - *received_at); } else ++failed;
    }
    std::string text(const std::string &name) const {
        if (!received && !observation.count && !apply.count) return name + ": no activity";
        std::ostringstream headline; headline.imbue(std::locale::classic());
        headline << std::fixed << std::setprecision(1) << name << " responsiveness: ";
        if (turnaround.count) headline << "turnaround avg " << turnaround.total / turnaround.count
            << " ms, max " << turnaround.maximum << " ms [" << turnaround.count << " applied]";
        else headline << "no updates applied";
        headline << "; pending poses replaced " << (received ? 100.0 * coalesced / received : 0) << "%\n";
        return headline.str() + name + ": poses " + std::to_string(received) + ", coalesced " + std::to_string(coalesced)
            + ", writes " + std::to_string(succeeded) + " ok/" + std::to_string(failed) + " failed\n"
            + "  timings avg/max ms [samples]: input gap " + incoming_gap.text() + "; queue wait " + queue_wait.text()
            + "; observation " + observation.text() + "; apply " + apply.text() + "; apply gap " + apply_start_gap.text();
    }
};
struct PerformanceGesture {
    std::int64_t id;
    Token token;
    double started, ended = 0;
    std::string reason;
    PerformanceStream camera, object;
    std::string text() const {
        std::ostringstream out; out.imbue(std::locale::classic());
        out << "navigation.performance gesture=" << id << " reason=" << reason << " duration="
            << std::fixed << std::setprecision(1) << std::max(0.0, (ended - started) * 1000) << " ms\n"
            << camera.text("camera") << '\n' << object.text("object");
        return out.str();
    }
};
// All calls belong to the coordinator thread. Retired objects survive in-flight
// host calls; flush runs only after those calls return, outside reentrant drains.
class NavigationPerformance {
    std::shared_ptr<PerformanceGesture> active;
    std::vector<std::shared_ptr<PerformanceGesture>> retired;
public:
    void begin(std::int64_t id, Token token, double now) {
        finish("superseded", now);
        active = std::make_shared<PerformanceGesture>(); active->id = id; active->token = token; active->started = now;
    }
    PerformanceStream *stream(Token token, bool objects = false) {
        return active && active->token == token ? (objects ? &active->object : &active->camera) : nullptr;
    }
    void finish(const std::string &reason, double now, std::optional<Token> token = {}) {
        if (!active || (token && !(active->token == *token))) return;
        active->reason = reason; active->ended = now; retired.push_back(std::move(active));
    }
    void flush() noexcept {
        if (retired.empty()) return;
        auto ready = std::move(retired); retired.clear();
        for (const auto &g : ready) try { DiagnosticLog::emit("info", g->text()); } catch (...) {}
    }
};
}
