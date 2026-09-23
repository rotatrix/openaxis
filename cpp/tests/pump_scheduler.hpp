#pragma once
#include <openaxis/diagnostics.hpp>
#include <openaxis/scheduler.hpp>
#include <map>
#include <mutex>

// A host-owned update loop can service this scheduler without an SDK polling API.
struct PumpScheduler : openaxis::Scheduler {
    std::function<double()> clock = openaxis::diagnostic_time;
    std::mutex mutex;
    std::multimap<double, Callback> queue;
    bool draining = false;
    void post(Callback callback) override { post_at(clock(), std::move(callback)); }
    void post_at(double deadline, Callback callback) override {
        std::lock_guard<std::mutex> lock(mutex);
        queue.emplace(deadline, std::move(callback));
    }
    void drain() {
        if (draining) return;
        draining = true;
        struct Guard { bool &flag; ~Guard() { flag = false; } } guard{draining};
        for (;;) {
            Callback callback;
            {
                std::lock_guard<std::mutex> lock(mutex);
                if (queue.empty() || queue.begin()->first > clock()) return;
                callback = std::move(queue.begin()->second);
                queue.erase(queue.begin());
            }
            callback();
        }
    }
};
