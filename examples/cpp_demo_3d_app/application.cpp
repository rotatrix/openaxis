#include "application.hpp"
#include <GLFW/glfw3.h>
#include <algorithm>
#include <fstream>
#include <limits>
namespace {
using V = openaxis::Vec3;
using Q = openaxis::Quat;
V vec(const nlohmann::json &j) { return {j[0], j[1], j[2]}; }
void vertex(V v) { glVertex3d(v.x, v.y, v.z); }
void rotation(Q q) {
    auto x = q.rotate({1, 0, 0}), y = q.rotate({0, 1, 0}), z = q.rotate({0, 0, 1});
    double m[] = {x.x, x.y, x.z, 0, y.x, y.y, y.z, 0, z.x, z.y, z.z, 0, 0, 0, 0, 1};
    glMultMatrixd(m);
}
} // namespace
MyApplication::MyApplication(const std::string &path) {
    std::ifstream input(path);
    if (!input)
        throw std::runtime_error("Cannot open scene.json: " + path);
    Json scene;
    input >> scene;
    ground_size = scene["ground"]["size"];
    ground_step = scene["ground"]["step"];
    ground_y = scene["ground"]["y"];
    auto c = scene.at("camera");
    initial_camera = {vec(c["t"]), vec(c["r"]), c["fov"], 0};
    initial_extent = scene["orthoExtent"];
    for (const auto &j : scene["objects"]) {
        Mesh m;
        m.name = j["name"];
        m.color = j["color"];
        // Shared scene stores intrinsic XYZ Euler angles, not rotation vectors.
        auto e = vec(j["rotation"]);
        auto q =
            Q::from_rotvec({e.x, 0, 0}) * Q::from_rotvec({0, e.y, 0}) * Q::from_rotvec({0, 0, e.z});
        m.initial = {vec(j["position"]), q.rotvec()};
        m.pose = m.initial;
        for (std::size_t i = 0; i < j["vertices"].size(); i += 3)
            m.vertices.push_back({j["vertices"][i], j["vertices"][i + 1], j["vertices"][i + 2]});
        if (j.contains("normals"))
            for (std::size_t i = 0; i < j["normals"].size(); i += 3)
                m.normals.push_back({j["normals"][i], j["normals"][i + 1], j["normals"][i + 2]});
        m.indices = j["indices"].get<std::vector<unsigned>>();
        meshes.push_back(std::move(m));
    }
    reset();
}
void MyApplication::Bounds::add(Vec3 p) {
    if (!valid) {
        min = max = p;
        valid = true;
        return;
    }
    min = {std::min(min.x, p.x), std::min(min.y, p.y), std::min(min.z, p.z)};
    max = {std::max(max.x, p.x), std::max(max.y, p.y), std::max(max.z, p.z)};
}
MyApplication::Json MyApplication::Bounds::value() const {
    if (!valid)
        return nullptr;
    return {{"min", {min.x, min.y, min.z}}, {"max", {max.x, max.y, max.z}}};
}
MyApplication::Bounds MyApplication::bounds(int index) const {
    Bounds b;
    for (std::size_t i = 0; i < meshes.size(); ++i) {
        if (index >= 0 && int(i) != index)
            continue;
        const auto &m = meshes[i];
        auto q = Q::from_rotvec(m.pose.r);
        for (auto v : m.vertices)
            b.add(q.rotate(v) + m.pose.t);
    }
    return b;
}
void MyApplication::reset() {
    camera = initial_camera;
    target = {};
    for (auto &m : meshes)
        m.pose = m.initial;
    selected = editing = -1;
    undo.clear();
    pivot.reset();
    object_pivot.reset();
    ++generation;
    if (on_context_changed) on_context_changed();
}
void MyApplication::begin_edit() {
    if (selected < 0 || editing >= 0)
        return;
    editing = selected;
    edit_start = meshes[editing].pose;
    ++generation;
    if (on_context_changed) on_context_changed();
}
void MyApplication::finish_edit(bool accept) {
    if (editing < 0)
        return;
    if (accept)
        undo.emplace_back(editing, edit_start);
    else
        meshes[editing].pose = edit_start;
    editing = selected = -1;
    ++generation;
    if (on_context_changed) on_context_changed();
}
void MyApplication::undo_edit() {
    if (editing >= 0) {
        finish_edit(false);
        return;
    }
    if (undo.empty())
        return;
    auto e = undo.back();
    undo.pop_back();
    meshes[e.first].pose = e.second;
    ++generation;
    if (on_context_changed) on_context_changed();
}
void MyApplication::toggle_projection() {
    if (camera.fov > 0) {
        camera.fov = 0;
        camera.ortho_extent = initial_extent;
    } else {
        camera.fov = initial_camera.fov;
        camera.ortho_extent = 0;
    }
    if (on_camera_changed) on_camera_changed();
}
std::optional<MyApplication::Hit> MyApplication::pick(double x, double y, bool only, bool ground,
                                                  std::array<Vec3, 2> *ray) const {
    if (width <= 0 || height <= 0 || x < 0 || x > width || y < 0 || y > height)
        return {};
    double nx = 2 * x / width - 1, ny = 1 - 2 * y / height, aspect = double(width) / height;
    auto q = Q::from_rotvec(camera.r);
    V origin = camera.t, direction;
    if (camera.fov > 0)
        direction =
            q.rotate(V{nx * aspect * std::tan(camera.fov / 2), ny * std::tan(camera.fov / 2), -1}
                         .normalized());
    else {
        origin = origin +
                 q.rotate({nx * aspect * camera.ortho_extent / 2, ny * camera.ortho_extent / 2, -clipping()[0]});
        direction = q.rotate({0, 0, -1});
    }
    std::optional<Hit> hit;
    if (ray)
        *ray = {origin, origin + direction * 10000};
    for (std::size_t i = 0; i < meshes.size(); ++i) {
        if (only && int(i) != selected)
            continue;
        const auto &m = meshes[i];
        auto inv = Q::from_rotvec(m.pose.r).inverse();
        auto o = inv.rotate(origin - m.pose.t), d = inv.rotate(direction);
        for (std::size_t k = 0; k < m.indices.size(); k += 3) {
            auto a = m.vertices[m.indices[k]], b = m.vertices[m.indices[k + 1]],
                 c = m.vertices[m.indices[k + 2]];
            auto e1 = b - a, e2 = c - a, h = d.cross(e2);
            double det = e1.dot(h);
            if (std::abs(det) < 1e-12)
                continue;
            auto s = o - a;
            double u = s.dot(h) / det;
            if (u < 0 || u > 1)
                continue;
            auto r = s.cross(e1);
            double v = d.dot(r) / det;
            if (v < 0 || u + v > 1)
                continue;
            double t = e2.dot(r) / det;
            if (t > 0 && (!hit || t < hit->distance))
                hit = Hit{origin + direction * t, int(i), t};
        }
    }
    if (ground && !only && std::abs(direction.y) > 1e-12) {
        double t = (ground_y - origin.y) / direction.y;
        auto p = origin + direction * t;
        if (t > 0 && std::abs(p.x) <= ground_size / 2 && std::abs(p.z) <= ground_size / 2 &&
            (!hit || t < hit->distance))
            hit = Hit{p, -1, t};
    }
    return hit;
}
void MyApplication::drag(double dx, double dy, bool rotate) {
    auto q = Q::from_rotvec(camera.r);
    auto center = editing >= 0 ? meshes[editing].pose.t : target;
    double extent = camera.fov > 0 ? 2 * std::max(.01, -q.inverse().rotate(center - camera.t).z) *
                                         std::tan(camera.fov / 2)
                                   : camera.ortho_extent;
    if (rotate) {
        double sign = editing >= 0 ? 1 : -1;
        auto delta = Q::from_rotvec(q.rotate({sign * dy * .006, sign * dx * .006, 0}));
        if (editing >= 0) {
            auto &p = meshes[editing].pose;
            p.r = (delta * Q::from_rotvec(p.r)).rotvec();
        } else {
            camera.t = center + delta.rotate(camera.t - center);
            camera.r = (delta * q).rotvec();
        }
    } else {
        auto move =
            q.rotate({dx * extent / std::max(height, 1), -dy * extent / std::max(height, 1), 0});
        if (editing >= 0)
            meshes[editing].pose.t = meshes[editing].pose.t + move;
        else {
            camera.t = camera.t - move;
            target = target - move;
        }
    }
    auto &changed = editing >= 0 ? on_object_changed : on_camera_changed;
    if (changed) changed();
}
void MyApplication::wheel(double d) {
    auto q = Q::from_rotvec(camera.r);
    auto forward = q.rotate({0, 0, -1});
    if (editing >= 0) {
        auto &p = meshes[editing].pose;
        double span = camera.fov > 0 ? 2 * std::max(.01, -q.inverse().rotate(p.t - camera.t).z) *
                                           std::tan(camera.fov / 2)
                                     : camera.ortho_extent;
        p.t = p.t + forward * (d * span * .08);
    } else if (camera.ortho_extent > 0)
        camera.ortho_extent = std::clamp(camera.ortho_extent * std::pow(.85, d), .01, 10000.);
    else {
        auto b = bounds(selected);
        double distance = std::max(.02, -q.inverse().rotate((b.min + b.max) * .5 - camera.t).z);
        camera.t = camera.t + forward * (distance * (1 - std::pow(.85, d)));
    }
    auto &changed = editing >= 0 ? on_object_changed : on_camera_changed;
    if (changed) changed();
}
MyApplication::Bounds MyApplication::ground_bounds() const {
    Bounds b;
    b.add({-ground_size / 2, ground_y, -ground_size / 2});
    b.add({ground_size / 2, ground_y, ground_size / 2});
    return b;
}
std::array<double, 2> MyApplication::clipping() const {
    if (camera.fov > 0)
        return {.01, 10000};
    auto b = bounds();
    auto g = ground_bounds();
    b.add(g.min);
    b.add(g.max);
    auto q = Q::from_rotvec(camera.r).inverse();
    double low = std::numeric_limits<double>::infinity(), high = -low;
    auto add = [&](V p) {
        double z = -q.rotate(p - camera.t).z;
        low = std::min(low, z);
        high = std::max(high, z);
    };
    for (double x : {b.min.x, b.max.x})
        for (double y : {b.min.y, b.max.y})
            for (double z : {b.min.z, b.max.z})
                add({x, y, z});
    for (auto p : diagnostic_points)
        add(p);
    double margin = std::max(1., (high - low) * .1);
    return {low - margin, high + margin};
}
void MyApplication::render() const {
    glEnable(GL_DEPTH_TEST);
    glClearColor(20 / 255.f, 31 / 255.f, 46 / 255.f, 1);
    glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
    glMatrixMode(GL_PROJECTION);
    glLoadIdentity();
    double aspect = double(width) / std::max(height, 1);
    if (camera.fov > 0) {
        double h = .01 * std::tan(camera.fov / 2);
        glFrustum(-h * aspect, h * aspect, -h, h, .01, 10000);
    } else {
        double h = camera.ortho_extent / 2;
        auto range = clipping();
        glOrtho(-h * aspect, h * aspect, -h, h, range[0], range[1]);
    }
    glMatrixMode(GL_MODELVIEW);
    glLoadIdentity();
    rotation(Q::from_rotvec(camera.r).inverse());
    glTranslated(-camera.t.x, -camera.t.y, -camera.t.z);
    glDisable(GL_LIGHTING);
    glBegin(GL_LINES);
    for (double i = -ground_size / 2; i <= ground_size / 2; i += ground_step) {
        bool major = std::abs(std::remainder(i, 10.)) < 1e-8;
        glColor3f(major ? 107 / 255.f : 61 / 255.f, major ? 122 / 255.f : 77 / 255.f,
                  major ? 143 / 255.f : 94 / 255.f);
        vertex({i, ground_y, -ground_size / 2});
        vertex({i, ground_y, ground_size / 2});
        vertex({-ground_size / 2, ground_y, i});
        vertex({ground_size / 2, ground_y, i});
    }
    glEnd();
    glEnable(GL_LIGHTING);
    glEnable(GL_LIGHT0);
    glEnable(GL_COLOR_MATERIAL);
    glEnable(GL_NORMALIZE);
    glColorMaterial(GL_FRONT_AND_BACK, GL_AMBIENT_AND_DIFFUSE);
    const GLfloat ambient[] = {.45f, .45f, .45f, 1}, sun[] = {.7f, .7f, .7f, 1},
                  direction[] = {1, 2, 3, 0};
    glLightModelfv(GL_LIGHT_MODEL_AMBIENT, ambient);
    glLightfv(GL_LIGHT0, GL_DIFFUSE, sun);
    glLightfv(GL_LIGHT0, GL_POSITION, direction);
    for (std::size_t i = 0; i < meshes.size(); ++i) {
        const auto &m = meshes[i];
        glPushMatrix();
        glTranslated(m.pose.t.x, m.pose.t.y, m.pose.t.z);
        rotation(Q::from_rotvec(m.pose.r));
        float r = ((m.color >> 16) & 255) / 255.f, g = ((m.color >> 8) & 255) / 255.f,
              b = (m.color & 255) / 255.f;
        if (int(i) == selected) {
            r = 1;
            g = .85f;
            b = .3f;
        }
        if (int(i) == editing) {
            r = 1;
            g = .25f;
            b = .75f;
        }
        glColor3f(r, g, b);
        glBegin(GL_TRIANGLES);
        for (std::size_t k = 0; k < m.indices.size(); k += 3) {
            auto face = (m.vertices[m.indices[k + 1]] - m.vertices[m.indices[k]])
                            .cross(m.vertices[m.indices[k + 2]] - m.vertices[m.indices[k]])
                            .normalized();
            for (int j = 0; j < 3; ++j) {
                auto index = m.indices[k + j];
                auto n = index < m.normals.size() ? m.normals[index] : face;
                glNormal3d(n.x, n.y, n.z);
                vertex(m.vertices[index]);
            }
        }
        glEnd();
        glPopMatrix();
    }
    glDisable(GL_LIGHTING);
    // World-space billboards use the scene depth, unlike the ImGui overlay.
    glPushAttrib(GL_ENABLE_BIT | GL_DEPTH_BUFFER_BIT | GL_COLOR_BUFFER_BIT | GL_CURRENT_BIT);
    glDepthMask(GL_FALSE);
    glEnable(GL_BLEND);
    glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
    glDisable(GL_CULL_FACE);
    auto orientation = Q::from_rotvec(camera.r);
    auto right = orientation.rotate({1, 0, 0});
    auto up = orientation.rotate({0, 1, 0});
    for (auto point : {pivot, object_pivot}) {
        if (!point || !project(*point)) continue;
        auto local = orientation.inverse().rotate(*point - camera.t);
        double span = camera.fov > 0 ? 2 * -local.z * std::tan(camera.fov / 2) : camera.ortho_extent;
        double radius = 4 * span / std::max(height, 1);
        for (bool hidden : {false, true}) {
            glDepthFunc(hidden ? GL_GREATER : GL_LEQUAL);
            float alpha = hidden ? .2f : 1.f;
            glColor4f(0, 1, 0, alpha);
            glBegin(GL_TRIANGLE_FAN);
            vertex(*point);
            for (int i = 0; i <= 64; ++i) {
                double a = i * 6.283185307179586 / 64;
                vertex(*point + (right * std::cos(a) + up * std::sin(a)) * radius);
            }
            glEnd();
            glColor4f(0, 0, 0, alpha);
            glBegin(GL_TRIANGLE_STRIP);
            for (int i = 0; i <= 64; ++i) {
                double a = i * 6.283185307179586 / 64;
                auto offset = (right * std::cos(a) + up * std::sin(a)) * radius;
                vertex(*point + offset);
                vertex(*point + offset * (5.5 / 4));
            }
            glEnd();
        }
    }
    glPopAttrib();
}

std::optional<std::array<double, 2>> MyApplication::project(Vec3 p) const {
    if (width <= 0 || height <= 0)
        return {};
    auto v = Q::from_rotvec(camera.r).inverse().rotate(p - camera.t);
    double depth = -v.z;
    auto range = clipping();
    if (depth < range[0] - 1e-9 || depth > range[1] + 1e-9)
        return {};
    double half = camera.fov > 0 ? depth * std::tan(camera.fov / 2) : camera.ortho_extent / 2;
    if (half <= 0)
        return {};
    return std::array<double, 2>{width * .5 + v.x * height / (2 * half),
                                 height * .5 - v.y * height / (2 * half)};
}
bool MyApplication::clip_segment(Vec3 &a, Vec3 &b) const {
    if (width <= 0 || height <= 0)
        return false;
    auto q = Q::from_rotvec(camera.r).inverse();
    auto av = q.rotate(a - camera.t), bv = q.rotate(b - camera.t);
    auto planes = [&](Vec3 p) {
        double z = -p.z,
               h = camera.fov > 0 ? z * std::tan(camera.fov / 2) : camera.ortho_extent / 2;
        double w = h * double(width) / height;
        auto range = clipping();
        return std::array<double, 6>{z - range[0], range[1] - z, w + p.x,
                                     w - p.x,      h + p.y,      h - p.y};
    };
    auto pa = planes(av), pb = planes(bv);
    double low = 0, high = 1;
    for (int i = 0; i < 6; ++i) {
        if (pa[i] < 0 && pb[i] < 0)
            return false;
        if (pa[i] < 0)
            low = std::max(low, pa[i] / (pa[i] - pb[i]));
        if (pb[i] < 0)
            high = std::min(high, pa[i] / (pa[i] - pb[i]));
    }
    if (low > high)
        return false;
    auto original = a, delta = b - a;
    a = original + delta * low;
    b = original + delta * high;
    return true;
}
