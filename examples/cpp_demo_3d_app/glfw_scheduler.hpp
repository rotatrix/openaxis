#pragma once
#include <GLFW/glfw3.h>
#include <map>
#include <mutex>
#include <openaxis/diagnostics.hpp>
#include <openaxis/scheduler.hpp>
// GLFW only executes these callbacks on the thread running drain(). Transport
// threads enqueue and wake GLFW; deadlines use the SDK's monotonic clock.
class MyApplicationScheduler final : public openaxis::Scheduler {
    std::mutex mutex;
    std::multimap<double, Callback> queue;

  public:
    void post(Callback f) override { post_at(openaxis::diagnostic_time(), std::move(f)); }
    void post_at(double t, Callback f) override {
        {
            std::lock_guard<std::mutex> lock(mutex);
            queue.emplace(t, std::move(f));
        }
        glfwPostEmptyEvent();
    }
    void drain() {
        // Bound each dispatch turn so sustained input cannot starve rendering.
        for (int budget = 64; budget > 0; --budget) {
            Callback f;
            {
                std::lock_guard<std::mutex> lock(mutex);
                if (queue.empty() || queue.begin()->first > openaxis::diagnostic_time())
                    return;
                f = std::move(queue.begin()->second);
                queue.erase(queue.begin());
            }
            f();
        }
    }
    std::optional<double> deadline() {
        std::lock_guard<std::mutex> lock(mutex);
        return queue.empty() ? std::nullopt : std::optional<double>(queue.begin()->first);
    }
};
