#include "application.hpp"
#include "integration.hpp"
#include <fstream>
#include <iostream>
#include <openaxis/protocol.hpp>
void check(bool value, const std::string &message) {
    if (!value)
        throw std::runtime_error(message);
}
int main() try {
    MyApplication app(std::string(SCENE_DIR) + "/scene.json");
    check(app.meshes.size() == 30, "shared scene object count");
    std::ifstream input(std::string(SCENE_DIR) + "/probes.json");
    nlohmann::json probes;
    input >> probes;
    for (const auto &probe : probes) {
        app.camera = openaxis::pose_from(probe["camera"], true);
        app.selected = probe["index"];
        auto hit = app.pick(app.width / 2., app.height / 2., true, false);
        check(bool(hit) != probe["hit"].is_null(),
              "probe hit mismatch: " + std::to_string(app.selected));
        if (hit)
            check((hit->point - openaxis::vector_from(probe["hit"])).length() < 1e-5,
                  "probe location mismatch");
    }
    app.reset();
    for (bool ortho : {false, true}) {
        app.camera = {{0, 0, 5}, {}, ortho ? 0. : 1., ortho ? 10. : 0.};
        auto center = app.project({0, 0, 0});
        check(center && std::abs((*center)[0] - app.width * .5) < 1e-8 &&
                  std::abs((*center)[1] - app.height * .5) < 1e-8,
              "overlay projection");
        check(bool(app.project({0, 0, 6})) == ortho,
              "orthographic clipping must retain behind-camera geometry");
        openaxis::Vec3 a{0, 0, 6}, b{0, 0, 0};
        check(app.clip_segment(a, b) && app.project(a) && app.project(b),
              "near-plane crossing lost");
        a = {1000, 0, 0};
        b = {1001, 0, 0};
        check(!app.clip_segment(a, b), "offscreen segment not clipped");
        a = {-1000, 0, 0};
        b = {1000, 0, 0};
        check(app.clip_segment(a, b), "side-plane crossing lost");
        auto pa = app.project(a), pb = app.project(b);
        check(pa && pb && std::abs((*pa)[0]) < 1e-6 && std::abs((*pb)[0] - app.width) < 1e-6,
              "viewport clip incorrect");
    }
    app.reset();
    app.camera = {{0, 0, 10}, {}, 0, 10};
    app.selected = 0;
    app.begin_edit();
    app.meshes[0].pose = {{0, 0, 0}, {}};
    app.drag(10, 0, true);
    check(std::abs(app.meshes[0].pose.r.y - .06) < 1e-10, "object rotation sign and sensitivity");
    app.wheel(1);
    check(std::abs(app.meshes[0].pose.t.z + .8) < 1e-10, "object wheel span scaling");
    app.undo_edit();
    check(app.editing < 0, "undo must cancel active edit");
    app.camera = {{0, 0, 10}, {}, 0, 10};
    app.wheel(1);
    check(std::abs(app.camera.ortho_extent - 8.5) < 1e-10, "shared zoom factor");
    app.diagnostic_points = {{0, 0, 50000}};
    check(app.clipping()[0] < -49000, "diagnostic evidence missing from ortho clipping");
    app.diagnostic_points.clear();
    app.reset();
    auto before = app.bounds().value();
    app.pivot = openaxis::Vec3{1000, 1000, 1000};
    app.object_pivot = openaxis::Vec3{-1000, 0, 0};
    check(app.bounds().value() == before, "pivot included in model bounds");
    app.reset();
    check(!app.pivot && !app.object_pivot, "reset leaves stale pivots");
    app.selected = 0;
    auto original = app.meshes[0].pose;
    app.begin_edit();
    auto first = app.generation;
    app.drag(20, 10, false);
    check((app.meshes[0].pose.t - original.t).length() > 0, "native object move");
    app.finish_edit(false);
    check((app.meshes[0].pose.t - original.t).length() == 0, "cancel restore");
    app.selected = 0;
    app.begin_edit();
    check(app.generation != first, "operation identity reused");
    app.drag(30, 10, true);
    app.finish_edit(true);
    app.undo_edit();
    check((app.meshes[0].pose.r - original.r).length() < 1e-12, "undo restore");
    app.toggle_projection();
    auto extent = app.camera.ortho_extent;
    app.wheel(.25);
    check(app.camera.ortho_extent < extent, "fractional wheel lost");
    app.reset();
    check(app.camera.fov > 0 && app.selected == -1 && app.editing == -1 && app.undo.empty(),
          "reset incomplete");
    MyNavigationAdapter camera_adapter(app);
    MyObjectAdapter object_adapter(app);
    auto camera_context = camera_adapter.capture_context();
    auto camera_query = camera_adapter.begin_query(camera_context);
    const auto captured_camera = camera_query->resolve("camera.pose");
    app.camera.t.x += 1;
    check(camera_query->resolve("camera.pose") == captured_camera, "camera query snapshot changed");
    check(!object_adapter.capture_context().has_value(), "object context outside an edit");
    app.selected = 0;
    app.begin_edit();
    check(!camera_adapter.is_current(camera_context), "camera capture survived edit replacement");
    auto object_context = object_adapter.capture_context();
    auto object_query = object_adapter.begin_query(object_context);
    const auto captured_object = object_query->resolve("object.pose");
    const auto captured_bounds = object_query->resolve("object.bounds");
    NavigationPose moved;
    static_cast<Pose &>(moved) = app.meshes[0].pose;
    moved.gesture_id = 1;
    moved.t.x += 1;
    check(object_adapter.apply_pose(object_context, moved, {}, {}).success, "object adapter write");
    check(object_query->resolve("object.pose") == captured_object &&
          object_query->resolve("object.bounds") == captured_bounds, "object query snapshot changed");
    app.finish_edit(false);
    app.selected = 1;
    app.begin_edit();
    const auto replacement = app.meshes[1].pose;
    check(!object_adapter.apply_pose(object_context, moved, {}, {}).success &&
          (app.meshes[1].pose.t - replacement.t).length() == 0, "stale adapter redirected write");
    app.finish_edit(false);
    {
        MyOpenAxisIntegration integration(app, true);
        app.diagnostics = true;
        integration.update(true);
        auto query = [&](int id) {
            integration.session->receive({{"type", "motion_start"}, {"gesture_id", id}});
            integration.session->receive({{"type", "request"}, {"id", id},
                {"method", "navigation.query"}, {"params", {{"gesture_id", id},
                    {"values", {"camera.pose", "model.bounds", "object.bounds"}}}}});
            integration.update(true);
            const auto frame = integration.collector.presentation();
            check(frame.context == integration.context_key(), "diagnostics context mismatch");
            check(std::any_of(frame.lines.begin(), frame.lines.end(), [](const auto &line) {
                return line.text.find("Navigation diagnostics |") != std::string::npos;
            }), "completed query diagnostics hidden");
            check(!frame.segments.empty(), "query bounds diagnostics hidden");
        };
        query(1);
        app.selected = 0;
        app.begin_edit();
        query(2);
        app.finish_edit(false);
        integration.update(true);
        check(integration.collector.presentation().segments.empty(), "stale query bounds displayed");
    }
    std::cout
        << "Shared scene probes, native editing, undo, projection and fractional wheel passed\n";
    return 0;
} catch (const std::exception &e) {
    std::cerr << e.what() << '\n';
    return 1;
}
