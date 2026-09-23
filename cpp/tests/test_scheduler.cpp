#include "host_fixture.hpp"
#include "../src/scheduled_work.hpp"
#include <iostream>
#include <map>
#include <mutex>
#include <openaxis/navigation.hpp>
#include <stdexcept>
#include <thread>
using namespace openaxis;
void check(bool b, const char *m) {
    if (!b)
        throw std::runtime_error(m);
}
struct Fake : Scheduler {
    double now = 0;
    std::mutex mutex;
    std::multimap<double, Callback> jobs;
    void post(Callback f) override { post_at(now, std::move(f)); }
    void post_at(double t, Callback f) override {
        std::lock_guard<std::mutex> l(mutex);
        jobs.emplace(t, std::move(f));
    }
    void drain() {
        int budget = 100;
        while (budget--) {
            Callback f;
            {
                std::lock_guard<std::mutex> l(mutex);
                if (jobs.empty() || jobs.begin()->first > now)
                    return;
                f = std::move(jobs.begin()->second);
                jobs.erase(jobs.begin());
            }
            f();
        }
        throw std::runtime_error("scheduler spins");
    }
};
struct Host : TestHost {
    Pose camera{{0, 0, 5}, {}, .8}, object{{0, 0, 0}, {}};
    std::string context = "a";
    int reads = 0, writes = 0, pivots = 0, object_reads = 0;
    bool fail_context = false;
    std::thread::id thread = std::this_thread::get_id();
    std::string context_key() const override {
        if (fail_context)
            throw std::runtime_error("context failure");
        return context;
    }
    Value fact(const std::string &) override { return nullptr; }
    std::optional<Pose> read_camera() override {
        check(thread == std::this_thread::get_id(), "wrong thread");
        ++reads;
        return camera;
    }
    std::optional<Pose> read_object() override {
        ++object_reads;
        return object;
    }
    bool write_camera(const Pose &p) override {
        ++writes;
        camera = p;
        return true;
    }
    void pivot(std::optional<Vec3>) override { ++pivots; }
};
int main() try {
    {
        Fake loop;
        int runs = 0;
        detail::ScheduledWork work(&loop, [&] { ++runs; });
        std::vector<std::thread> producers;
        for (int i = 0; i < 4; ++i)
            producers.emplace_back([&] {
                for (int k = 0; k < 100; ++k)
                    work.request();
            });
        for (auto &thread : producers)
            thread.join();
        check(loop.jobs.size() == 1 && runs == 0, "transport wakeups not deferred/coalesced");
        loop.drain();
        check(runs == 1, "deferred transport drain");
        work.at(10);
        work.at(5);
        loop.now = 5;
        loop.drain();
        check(runs == 2, "earlier deadline did not replace timer");
        loop.now = 10;
        loop.drain();
        check(runs == 2, "obsolete deadline ran");
        work.request();
        work.at(11);
        work.reset();
        loop.now = 12;
        loop.drain();
        check(runs == 2, "reset did not retire queued work");
    }
    {
        Fake loop;
        Host host;
        host.fail_context = true;
        std::vector<Value> responses;
        NavigationOptions options;
        options.scheduler = &loop;
        TestSession session(
            host,
            [&](const Value &m) {
                responses.push_back(m);
                return true;
            },
            nullptr, options);
        session.receive({{"type", "motion_start"}, {"gesture_id", 1}});
        session.receive({{"type", "request"},
                         {"id", 10},
                         {"method", "navigation.query"},
                         {"params", {{"gesture_id", 1}, {"values", {"camera.pose"}}}}});
        loop.drain();
        check(responses.size() == 1 && responses[0]["id"] == 10 &&
                  responses[0]["result"]["values"].empty(),
              "unavailable capture should omit its facts");
        check(session.active(), "unavailable facts cancelled the gesture");
        host.fail_context = false;
        session.receive({{"type", "request"}, {"id", 11}, {"method", "navigation.query"},
                         {"params", {{"gesture_id", 1}, {"values", {"camera.pose"}}}}});
        loop.drain();
        check(responses.back()["result"]["values"].contains("camera.pose"),
              "query scheduler did not recover after unavailable capture");
    }
    Fake scheduler;
    {
        Fake loop;
        Host host;
        std::vector<Value> sent;
        NavigationOptions options;
        options.scheduler = &loop;
        options.drain_budget = 1;
        TestSession session(host, [&](const Value &m) { sent.push_back(m); return true; }, nullptr, options);
        session.receive({{"type", "motion_start"}, {"gesture_id", 1}});
        const Value query{{"type", "request"}, {"id", 1}, {"method", "navigation.query"},
                          {"params", {{"gesture_id", 1}, {"values", {"camera.pose"}}}}};
        session.receive(query);
        auto pose = pose_value(host.camera);
        pose["type"] = "camera.pose"; pose["gesture_id"] = 1; pose["seq"] = 1; pose["t"][0] = 3;
        session.receive(pose);
        session.receive({{"type", "motion_end"}, {"gesture_id", 1}});
        check(!session.active(), "gesture end was deferred until host drain");
        pose["seq"] = 2; pose["t"][0] = 4; session.receive(pose);
        auto late_query = query; late_query["id"] = 2; session.receive(late_query);
        check(sent.back()["id"] == 2 && sent.back()["error"]["code"] == "unavailable", "late query accepted after end");
        loop.drain();
        check(host.writes == 1 && host.camera.t.x == 3, "gesture end lost accepted work or applied late output");
        session.receive({{"type", "request"}, {"id", 3}, {"method", "navigation.query"}});
        const auto replies = sent.size();
        session.connection_changed();
        loop.drain();
        check(sent.size() == replies, "retired query replied on replacement connection");
        session.receive({{"type", "request"}, {"id", 4}, {"method", "navigation.query"}});
        session.close();
        loop.drain();
        check(sent.size() == replies, "queued query replied after close");
    }
    {
        Fake loop;
        Host host;
        std::vector<Value> responses;
        NavigationOptions options;
        options.scheduler = &loop;
        options.max_work = 1;
        options.max_queries = 1;
        TestSession session(host, [&](const Value &m) { responses.push_back(m); return true; }, nullptr, options);
        session.receive({{"type", "motion_start"}, {"gesture_id", 1}});
        auto request = [](int id) {
            return Value{{"type", "request"}, {"id", id}, {"method", "navigation.query"},
                         {"params", {{"gesture_id", 1}, {"values", {"camera.pose", "object.pose"}}}}};
        };
        session.receive(request(1));
        session.receive(request(2));
        check(responses.size() == 1 && responses.back()["id"] == 2 &&
              responses.back()["error"]["code"] == "unavailable", "query pressure reply missing");
        auto pose = pose_value(host.camera);
        pose["type"] = "camera.pose"; pose["gesture_id"] = 1;
        for (int i = 1; i <= 100; ++i) {
            pose["seq"] = i; pose["t"][0] = i;
            session.receive(pose);
        }
        loop.drain();
        check(session.active() && host.writes == 1 && host.camera.t.x == 100,
              "full query queue blocked or duplicated reserved pose work");
        // A query between poses stays before the replacement pose.
        pose["seq"] = 101; pose["t"][0] = 101; session.receive(pose);
        session.receive(request(3));
        pose["seq"] = 102; pose["t"][0] = 102; session.receive(pose);
        loop.drain();
        check(responses.back()["id"] == 3 && responses.back()["result"]["values"]["camera.pose"]["t"][0] == 100 &&
              host.camera.t.x == 102 && host.writes == 2, "pose coalescing crossed query arrival order");
    }
    Host host;
    std::vector<Value> sent;
    NavigationOptions o;
    o.scheduler = &scheduler;
    o.clock = [&] { return scheduler.now; };
    o.drain_budget = 1;
    auto start = [](TestSession &s, int id) {
        s.receive({{"type", "motion_start"}, {"gesture_id", id}});
        s.receive({{"type", "request"},
                   {"id", id},
                   {"method", "navigation.query"},
                   {"params", {{"gesture_id", id}, {"values", {"camera.pose", "object.pose"}}}}});
    };
    {
        TestSession s(
            host,
            [&](const Value &m) {
                sent.push_back(m);
                return true;
            },
            nullptr, o);
        start(s, 1);
        check(host.reads == 0 && host.pivots == 0, "host callback ran inline");
        scheduler.drain();
        check(host.reads == 1, "query was not scheduled");
        check(scheduler.jobs.empty(), "idle session scheduled periodic work");
        auto object_reads = host.object_reads;
        host.camera.t.x += 1;
        for (int i = 0; i < 100; ++i)
            s.native_camera_changed();
        check(scheduler.jobs.size() == 1, "native notifications not coalesced");
        scheduler.drain();
        check(host.object_reads == object_reads, "camera event observed object stream");
        check(sent.back()["type"] == "camera.delta", "native input correction missing");
        host.object.t.y += 2;
        s.native_object_changed();
        scheduler.drain();
        check(sent.back()["type"] == "object.delta", "object notification correction missing");
        scheduler.now = .5;
        auto early = std::move(scheduler.jobs.begin()->second);
        scheduler.jobs.erase(scheduler.jobs.begin());
        early();
        check(s.active() && !scheduler.jobs.empty(), "early timeout was not rearmed");
        scheduler.now = 1;
        scheduler.drain();
        check(sent.back()["type"] == "motion_cancel", "deadline did not cancel without polling");
        check(!s.active(), "timed out session active");
        start(s, 2);
        start(s, 3);
        scheduler.drain();
        check(sent.back()["id"] == 3, "replacement gesture did not invalidate queued query");
        auto pose = pose_value(host.camera);
        pose["type"] = "camera.pose";
        pose["gesture_id"] = 3;
        pose["seq"] = 1;
        s.receive(pose);
        host.context = "b";
        s.context_changed();
        scheduler.drain();
        check(host.writes == 0 && !s.active(), "stale context write survived notification");
        start(s, 4);
        scheduler.drain();
        host.camera.t.x += 1;
        s.native_camera_changed();
        scheduler.drain();
        const auto delta = sent.back().at("delta_id");
        auto ack = pose_value(host.camera);
        ack["type"] = "camera.pose";
        ack["gesture_id"] = 4;
        ack["seq"] = 2; // Sequence numbers span gestures, including retired queued poses.
        ack["applied_delta_id"] = delta;
        s.receive(ack);
        scheduler.drain();
        const auto sent_count = sent.size();
        scheduler.now = 10;
        scheduler.drain();
        check(s.active() && sent.size() == sent_count, "acknowledged deadline was not retired");
        s.native_camera_changed();
        s.close();
        auto reads = host.reads, pivots = host.pivots;
        scheduler.drain();
        check(host.reads == reads && host.pivots == pivots, "callbacks survived close");
    }
    {
        TestSession s(host, [](const Value &) { return true; }, nullptr, o);
        start(s, 5);
    }
    auto reads = host.reads;
    scheduler.now = 100;
    scheduler.drain();
    check(host.reads == reads, "callbacks survived destruction");
    std::cout
        << "Deferred drains, coalescing, native notifications, deadlines and lifecycle passed\n";
} catch (const std::exception &e) {
    std::cerr << e.what() << '\n';
    return 1;
}
