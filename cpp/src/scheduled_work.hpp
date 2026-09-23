#pragma once
#include <cstdint>
#include <memory>
#include <mutex>
#include <openaxis/scheduler.hpp>
#include <optional>
#include <utility>
#include <stdexcept>
namespace openaxis::detail {
// Coalesces transport-thread wakeups. Never calls the host scheduler under a
// lock. Execution, reset and destruction belong to the application thread.
class ScheduledWork {
    struct State {
        std::mutex mutex;
        Scheduler *scheduler;
        Scheduler::Callback run;
        bool posted = false;
        std::uint64_t generation = 0, timer_generation = 0;
        std::optional<double> deadline;
        State(Scheduler *s, Scheduler::Callback f) : scheduler(s), run(std::move(f)) {}
    };
    std::shared_ptr<State> state;

  public:
    ScheduledWork(Scheduler *s, Scheduler::Callback f)
        : state(std::make_shared<State>(s, std::move(f))) {
        if (!s) throw std::invalid_argument("scheduler is required");
    }
    ~ScheduledWork() {
        reset();
        state->run = {};
    }
    void reset() {
        std::lock_guard<std::mutex> lock(state->mutex);
        ++state->generation;
        ++state->timer_generation;
        state->posted = false;
        state->deadline.reset();
    }
    void request() {
        auto &s = *state;
        std::uint64_t generation;
        {
            std::lock_guard<std::mutex> lock(s.mutex);
            if (s.posted)
                return;
            s.posted = true;
            generation = s.generation;
        }
        std::weak_ptr<State> weak = state;
        s.scheduler->post([weak, generation] {
            auto s = weak.lock();
            if (!s)
                return;
            {
                std::lock_guard<std::mutex> lock(s->mutex);
                if (s->generation != generation)
                    return;
                s->posted = false;
            }
            if (s->run)
                s->run();
        });
    }
    void at(std::optional<double> deadline) {
        auto &s = *state;
        std::uint64_t generation, timer;
        {
            std::lock_guard<std::mutex> lock(s.mutex);
            // Keep an earlier wakeup instead of accumulating timers on every pose.
            if (deadline && s.deadline && *s.deadline <= *deadline)
                return;
            if (!deadline && !s.deadline)
                return;
            s.deadline = deadline;
            timer = ++s.timer_generation;
            generation = s.generation;
        }
        if (!deadline)
            return;
        std::weak_ptr<State> weak = state;
        s.scheduler->post_at(*deadline, [weak, generation, timer] {
            auto s = weak.lock();
            if (!s)
                return;
            {
                std::lock_guard<std::mutex> lock(s->mutex);
                if (s->generation != generation || s->timer_generation != timer)
                    return;
                s->deadline.reset();
            }
            if (s->run)
                s->run();
        });
    }
};
} // namespace openaxis::detail
