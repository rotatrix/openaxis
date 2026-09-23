#pragma once
#include <openaxis/navigation.hpp>
#include "pump_scheduler.hpp"
// Mutable host fixtures expose simple reads/writes; these adapters connect them
// to the same public captured-context API used by applications.
using namespace openaxis;
struct TestHost {
    virtual ~TestHost() = default;
    virtual std::string context_key() const = 0;
    virtual Value fact(const std::string &name) = 0;
    virtual std::optional<Pose> read_camera() = 0;
    virtual bool write_camera(const Pose &) { return false; }
    virtual std::optional<Pose> read_object() { return {}; }
    virtual bool write_object(const Pose &) { return false; }
    virtual WriteResult apply_camera(const Pose &pose, const Value &, std::optional<Vec3>) {
        bool success = write_camera(pose);
        std::optional<Pose> actual;
        if (success)
            try {
                actual = read_camera();
            } catch (...) {
            }
        return {success, actual};
    }
    virtual WriteResult apply_object(const Pose &pose, const Value &, std::optional<Vec3>) {
        bool success = write_object(pose);
        std::optional<Pose> actual;
        if (success)
            try {
                actual = read_object();
            } catch (...) {
            }
        return {success, actual};
    }
    virtual void pivot(std::optional<Vec3>) {}
    virtual void object_pivot(std::optional<Vec3>) {}
};
struct TestAdapter : NavigationAdapter {
    TestHost &host;
    bool camera;
    TestAdapter(TestHost &h, bool c) : host(h), camera(c) {}
    NavigationContext capture_context() override { return host.context_key(); }
    bool is_current(const NavigationContext &c) override {
        return std::any_cast<const std::string &>(c) == host.context_key();
    }
    struct Capture : NavigationCapture {
        TestAdapter &adapter;
        std::optional<Pose> pose;
        explicit Capture(TestAdapter &a) : adapter(a) {}
        Value resolve(const std::string &name) override {
            if (name == (adapter.camera ? "camera.pose" : "object.pose")) {
                pose = adapter.camera ? adapter.host.read_camera() : adapter.host.read_object();
                return pose ? pose_value(*pose) : Value{};
            }
            return adapter.host.fact(name);
        }
        std::optional<Pose> initial_observation() override { return pose; }
    };
    std::unique_ptr<NavigationCapture> begin_query(const NavigationContext &) override {
        return std::make_unique<Capture>(*this);
    }
    WriteResult apply_pose(const NavigationContext &, const NavigationPose &pose, const Value &state,
                           std::optional<Vec3> pivot) override {
        return camera ? host.apply_camera(pose, state, pivot) : host.apply_object(pose, state, pivot);
    }
    void show_pivot(const NavigationContext &, std::optional<Vec3> point) override {
        if (camera) host.pivot(point); else host.object_pivot(point);
    }
};

struct TestAdapters {
    PumpScheduler scheduler;
    TestAdapter camera, object;
    explicit TestAdapters(TestHost &host) : camera(host, true), object(host, false) {}
    NavigationOptions configure(TestHost &host, NavigationOptions options) {
        if (!options.scheduler) {
            scheduler.clock = options.clock;
            options.scheduler = &scheduler;
        }
        options.object_adapter = &object;
        options.observation = [&host](const NavigationContext &) { return host.read_camera(); };
        options.object_observation = [&host](const NavigationContext &) { return host.read_object(); };
        return options;
    }
};
struct TestSession : private TestAdapters, NavigationSession {
    void drain() { scheduler.drain(); }
    TestSession(TestHost &host, Sender sender, NavigationDiagnostics *collector = nullptr, NavigationOptions options = {})
        : TestAdapters(host), NavigationSession(camera, std::move(sender), collector, configure(host, std::move(options))) {}
    TestSession(OpenAxisClient &client, TestHost &host, NavigationDiagnostics *collector = nullptr, NavigationOptions options = {})
        : TestAdapters(host), NavigationSession(client, camera, collector, configure(host, std::move(options))) {}
};
