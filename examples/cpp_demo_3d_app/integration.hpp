#pragma once
#include "application.hpp"
#include "glfw_scheduler.hpp"
#include <openaxis/navigation.hpp>
#include <openaxis/connection_manager.hpp>
#include <openaxis/logging.hpp>
#include <iomanip>
#include <iostream>
#include <sstream>
using namespace openaxis;

struct MyNavigationContext {
    MyApplication *application;
    unsigned generation;
    int object = -1;
};

struct MyQueryCapture : NavigationCapture {
    MyApplication &app;
    Pose initial;
    explicit MyQueryCapture(MyApplication &application) : app(application), initial(app.camera) {}
    std::optional<Pose> initial_observation() override { return initial; }
    Value resolve(const std::string &name) override {
        if (name == "camera.pose") return pose_value(initial);
        if (name == "navigation.translation_scale")
            return 4.0;
        if (name == "document.id")
            return "cpp-demo-scene";
        if (name == "world.orientation")
            return {{"forward", {0, 0, -1}}, {"up", {0, 1, 0}}, {"handedness", "right"}};
        if (name == "viewport.aspect" && app.height > 0)
            return double(app.width) / app.height;
        if (name == "viewport.cursor" && app.width > 0 && app.height > 0 && app.cursor_x >= 0 &&
            app.cursor_x <= app.width && app.cursor_y >= 0 && app.cursor_y <= app.height)
            return {{"x", 2 * app.cursor_x / app.width - 1},
                    {"y", 1 - 2 * app.cursor_y / app.height}};

        if (name == "model.bounds")
            return app.bounds().value();
        if (name == "selection.bounds" && app.selected >= 0)
            return app.bounds(app.selected).value();
        if (name.rfind("pick.", 0) == 0) {
            bool center = name.find("viewport_center") != std::string::npos,
                 only = name.find("selection") != std::string::npos;
            if (name != "pick.cursor" && name != "pick.viewport_center" &&
                name != "pick.cursor.selection" && name != "pick.viewport_center.selection")
                return nullptr;
            double x = center ? app.width / 2. : app.cursor_x,
                   y = center ? app.height / 2. : app.cursor_y;
            if (app.width <= 0 || app.height <= 0 || x < 0 || y < 0 ||
                y >= app.height || x >= app.width || (only && app.selected < 0))
                return nullptr;
            auto hit = app.pick(x, y, only);
            if (hit) {
                Value v = {{"point", vector_value(hit->point)}, {"markerPosition", {x, y}}};
                v["bounds"] = hit->object >= 0 ? app.bounds(hit->object).value()
                                               : app.ground_bounds().value();
                return v;
            }
            return Value{{"markerPosition", {x, y}}};
        }
        return nullptr;
    }
};

struct MyNavigationAdapter : NavigationAdapter {
    MyApplication &app;
    explicit MyNavigationAdapter(MyApplication &application) : app(application) {}
    NavigationContext capture_context() override {
        if (app.width <= 0 || app.height <= 0) return {};
        return MyNavigationContext{&app, app.generation};
    }
    bool is_current(const NavigationContext &context) override {
        const auto &captured = std::any_cast<const MyNavigationContext &>(context);
        return captured.application == &app && captured.generation == app.generation
            && app.width > 0 && app.height > 0;
    }
    std::unique_ptr<NavigationCapture> begin_query(const NavigationContext &context) override {
        if (!is_current(context)) return {};
        return std::make_unique<MyQueryCapture>(app);
    }
    std::optional<Pose> read_camera(const NavigationContext &context) {
        return is_current(context) ? std::optional<Pose>(app.camera) : std::nullopt;
    }
    WriteResult apply_pose(const NavigationContext &context, const NavigationPose &pose,
                           const Value &, std::optional<Vec3>) override {
        if (!is_current(context)) return {};
        app.camera = pose;
        return {true, app.camera};
    }
    void show_pivot(const NavigationContext &context, std::optional<Vec3> point) override {
        if (point && !is_current(context)) return;
        app.pivot = point;
        if (point) app.target = *point;
    }
};

struct MyObjectCapture : NavigationCapture {
    Pose initial;
    Value bounds;
    MyObjectCapture(MyApplication &application, int target)
        : initial(application.meshes.at(target).pose), bounds(application.bounds(target).value()) {}
    Value resolve(const std::string &name) override {
        if (name == "object.pose") return pose_value(initial);
        if (name == "object.bounds") return bounds;
        return nullptr;
    }
    std::optional<Pose> initial_observation() override { return initial; }
};

struct MyObjectAdapter : NavigationObjectAdapter {
    MyApplication &app;
    explicit MyObjectAdapter(MyApplication &application) : app(application) {}
    NavigationContext capture_context() override {
        if (app.editing < 0) return {};
        return MyNavigationContext{&app, app.generation, app.editing};
    }
    bool is_current(const NavigationContext &context) override {
        const auto &captured = std::any_cast<const MyNavigationContext &>(context);
        return captured.application == &app && captured.generation == app.generation
            && captured.object >= 0 && captured.object == app.editing;
    }
    std::unique_ptr<NavigationCapture> begin_query(const NavigationContext &context) override {
        if (!is_current(context)) return {};
        return std::make_unique<MyObjectCapture>(app, std::any_cast<const MyNavigationContext &>(context).object);
    }
    std::optional<Pose> read_object(const NavigationContext &context) {
        if (!is_current(context)) return {};
        return app.meshes.at(std::any_cast<const MyNavigationContext &>(context).object).pose;
    }
    WriteResult apply_pose(const NavigationContext &context, const NavigationPose &pose,
                           const Value &, std::optional<Vec3>) override {
        if (!is_current(context)) return {};
        auto &target = app.meshes.at(std::any_cast<const MyNavigationContext &>(context).object);
        target.pose = pose;
        return {true, target.pose};
    }
    void show_pivot(const NavigationContext &context, std::optional<Vec3> point) override {
        if (!point || is_current(context)) app.object_pivot = point;
    }
};

struct MyOpenAxisIntegration {
    MyApplication &app;
    MyApplicationScheduler scheduler;
    OpenAxisClient client;
    MyNavigationAdapter adapter;
    MyObjectAdapter objects;
    NavigationDiagnostics collector;
    std::unique_ptr<NavigationSession> session;
    ConnectionMetadata metadata;
    OpenAxisConnectionManager connection;
    explicit MyOpenAxisIntegration(MyApplication &a, bool offline = false, bool debug = false,
                                   const std::string &url = "ws://127.0.0.1:6607")
        : app(a), client([this, &url] {
              OpenAxisClientOptions options{"demo 3D app (C++)", url, {{"pid", current_process_id()}}};
              options.scheduler = &scheduler;
              return options;
          }()), adapter(app), objects(app),
          collector([debug] {
              DiagnosticOptions options;
              options.debug = debug;
              auto log = DiagnosticLog::configure("cpp-demo");
              log->debug = debug;
              log->sink = [](const std::string &level, const std::string &message) {
                  std::clog << level << ": " << message << std::endl;
              };
              return options;
          }()), connection(client, {[this] { return metadata; }}) {
        NavigationOptions options;
        options.scheduler = &scheduler;
        options.object_adapter = &objects;
        options.observation = [this](const NavigationContext &context) { return adapter.read_camera(context); };
        options.object_observation = [this](const NavigationContext &context) { return objects.read_object(context); };
        options.on_event = [this](const NavigationEvent &event) {
            if (event.event == "query_context") {
                const auto &context = std::any_cast<const MyNavigationContext &>(event.context);
                // Bind evidence before the query completes, using its captured generation.
                collector.set_context("reference/" + std::to_string(context.generation));
            }
        };
        // Offline smoke tests inject messages without a server.
        if (offline)
            session = std::make_unique<NavigationSession>(adapter, [](const Value &) { return true; }, &collector, options);
        else
            session = std::make_unique<NavigationSession>(client, adapter, &collector, options);
        app.on_camera_changed = [this] { session->native_camera_changed(); };
        app.on_object_changed = [this] { session->native_object_changed(); };
        app.on_context_changed = [this] { session->context_changed(); };
        metadata.capabilities = {"navigation"};
        if (!offline) connection.start();
    }
    ~MyOpenAxisIntegration() {
        connection.stop();
        session->close();
        app.on_camera_changed = {};
        app.on_object_changed = {};
        app.on_context_changed = {};
    }
    void add_log(std::string text) { DiagnosticLog::emit("info", text); }
    std::string status_text() const {
        auto status = connection.status();
        if (status.state == "retrying") {
            std::ostringstream text;
            text << "Reconnecting in " << std::fixed << std::setprecision(1)
                 << std::max(0., status.retry_at.value_or(diagnostic_time()) - diagnostic_time())
                 << "s";
            if (!status.error.empty())
                text << ": " << status.error;
            return text.str();
        }
        return status.state;
    }
    std::string context_key() const { return "reference/" + std::to_string(app.generation); }
    void update(bool focused) {
        collector.set_enabled(app.diagnostics);
        collector.set_context(context_key());

        std::vector<std::string> tags = {"demo-3d-services"};
        if (app.free_camera)
            tags.push_back("navigation.hint.free_camera");
        if (app.editing >= 0) {
            tags.push_back("interaction.object.translate");
            tags.push_back("interaction.object.rotate");
        }
        if (metadata.focused != focused || metadata.tags != tags) {
            metadata.focused = focused;
            metadata.tags = std::move(tags);
            connection.refresh_metadata();
        }
        scheduler.drain();
    }
};
