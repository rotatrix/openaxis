#pragma once
#include <array>
#include <functional>
#include <nlohmann/json.hpp>
#include <openaxis/geometry.hpp>
#include <optional>
#include <string>
#include <vector>

// The host application has no client/session dependency. Its own input controls
// work with or without the OpenAxis integration in integration.hpp.
class MyApplication {
  public:
    using Vec3 = openaxis::Vec3;
    using Pose = openaxis::Pose;
    using Quat = openaxis::Quat;
    using Json = nlohmann::json;
    struct Mesh {
        std::string name;
        Pose initial, pose;
        unsigned color;
        std::vector<Vec3> vertices, normals;
        std::vector<unsigned> indices;
    };
    struct Hit {
        Vec3 point;
        int object = -1;
        double distance = 0;
    };
    struct Bounds {
        Vec3 min, max;
        bool valid = false;
        void add(Vec3);
        Json value() const;
    };
    std::vector<Mesh> meshes;
    std::function<void()> on_camera_changed, on_object_changed, on_context_changed;
    Pose camera, initial_camera;
    double initial_extent = 14;
    Vec3 target{};
    double ground_size = 80, ground_step = 2, ground_y = 0;
    std::vector<Vec3> diagnostic_points;
    Bounds ground_bounds() const;
    std::array<double, 2> clipping() const;
    int selected = -1, editing = -1;
    unsigned generation = 0;
    Pose edit_start;
    std::vector<std::pair<int, Pose>> undo;
    int width = 1200, height = 800;
    double cursor_x = 600, cursor_y = 400;
    bool diagnostics = false, free_camera = false;
    std::optional<Vec3> pivot, object_pivot;
    explicit MyApplication(const std::string &scene);
    void reset();
    void begin_edit();
    void finish_edit(bool accept);
    void undo_edit();
    void toggle_projection();
    Bounds bounds(int object = -1) const;
    std::optional<Hit> pick(double x, double y, bool selected_only = false, bool ground = true,
                            std::array<Vec3, 2> *ray = nullptr) const;
    std::optional<std::array<double, 2>> project(Vec3) const;
    bool clip_segment(Vec3 &start, Vec3 &end) const;
    void drag(double dx, double dy, bool rotate);
    void wheel(double delta);
    void render() const;
};
