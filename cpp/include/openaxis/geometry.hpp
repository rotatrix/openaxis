#pragma once
#include <algorithm>
#include <cmath>
#include <optional>
#include <stdexcept>

namespace openaxis {
struct Vec3 {
    double x = 0, y = 0, z = 0;
    Vec3 operator+(Vec3 b) const { return {x + b.x, y + b.y, z + b.z}; }
    Vec3 operator-(Vec3 b) const { return {x - b.x, y - b.y, z - b.z}; }
    Vec3 operator-() const { return {-x, -y, -z}; }
    Vec3 operator*(double s) const { return {x * s, y * s, z * s}; }
    double dot(Vec3 b) const { return x * b.x + y * b.y + z * b.z; }
    Vec3 cross(Vec3 b) const { return {y * b.z - z * b.y, z * b.x - x * b.z, x * b.y - y * b.x}; }
    double length() const { return std::sqrt(dot(*this)); }
    Vec3 normalized() const {
        auto n = length();
        return n > 1e-12 ? *this * (1 / n) : Vec3{};
    }
};
struct Quat {
    double w = 1, x = 0, y = 0, z = 0;
    Quat normalized() const {
        double n = std::sqrt(w * w + x * x + y * y + z * z);
        if (n < 1e-12)
            return {};
        return {w / n, x / n, y / n, z / n};
    }
    Quat inverse() const {
        auto q = normalized();
        return {q.w, -q.x, -q.y, -q.z};
    }
    Quat operator*(Quat b) const {
        return {w * b.w - x * b.x - y * b.y - z * b.z, w * b.x + x * b.w + y * b.z - z * b.y,
                w * b.y - x * b.z + y * b.w + z * b.x, w * b.z + x * b.y - y * b.x + z * b.w};
    }
    Quat slerp(Quat other, double t) const {
        double dot = w * other.w + x * other.x + y * other.y + z * other.z;
        if (dot < 0) { other = {-other.w, -other.x, -other.y, -other.z}; dot = -dot; }
        if (dot > .9995)
            return Quat{w + t * (other.w - w), x + t * (other.x - x),
                        y + t * (other.y - y), z + t * (other.z - z)}.normalized();
        const double angle = std::acos(std::min(dot, 1.));
        const double denominator = std::sin(angle);
        const double a = std::sin((1 - t) * angle) / denominator;
        const double b = std::sin(t * angle) / denominator;
        return {a * w + b * other.w, a * x + b * other.x,
                a * y + b * other.y, a * z + b * other.z};
    }
    Vec3 rotate(Vec3 v) const {
        auto q = normalized();
        auto p = q * Quat{0, v.x, v.y, v.z} * q.inverse();
        return {p.x, p.y, p.z};
    }
    static Quat from_rotvec(Vec3 r) {
        double a = r.length();
        double s = a < 1e-8 ? .5 - a * a / 48 : std::sin(a * .5) / a;
        return Quat{std::cos(a * .5), r.x * s, r.y * s, r.z * s}.normalized();
    }
    Vec3 rotvec() const {
        auto q = normalized();
        if (q.w < 0)
            q = {-q.w, -q.x, -q.y, -q.z};
        double s = std::sqrt(q.x * q.x + q.y * q.y + q.z * q.z);
        double k = s < 1e-12 ? 2 : 2 * std::atan2(s, q.w) / s;
        return {q.x * k, q.y * k, q.z * k};
    }
    static Quat from_basis(Vec3 right, Vec3 up, Vec3 back) {
        double a[3][3] = {
            {right.x, up.x, back.x}, {right.y, up.y, back.y}, {right.z, up.z, back.z}};
        double trace = a[0][0] + a[1][1] + a[2][2];
        Quat q;
        if (trace > 0) {
            double s = std::sqrt(trace + 1) * 2;
            q = {s / 4, (a[2][1] - a[1][2]) / s, (a[0][2] - a[2][0]) / s, (a[1][0] - a[0][1]) / s};
        } else {
            int i = a[1][1] > a[0][0] ? 1 : 0;
            if (a[2][2] > a[i][i])
                i = 2;
            int j = (i + 1) % 3, k = (i + 2) % 3;
            double s = std::sqrt(1 + a[i][i] - a[j][j] - a[k][k]) * 2;
            double v[3]{};
            v[i] = s / 4;
            v[j] = (a[j][i] + a[i][j]) / s;
            v[k] = (a[k][i] + a[i][k]) / s;
            q = {(a[k][j] - a[j][k]) / s, v[0], v[1], v[2]};
        }
        return q.normalized();
    }
};
struct Pose {
    Vec3 t, r;
    // Object poses have neither; camera poses have exactly one.
    double fov = 0, ortho_extent = 0;
};
inline Pose pose_from_look_at(Vec3 eye, Vec3 target, Vec3 up, double fov = 0, double extent = 0) {
    for (const auto vector : {eye, target, up})
        if (!std::isfinite(vector.x) || !std::isfinite(vector.y) || !std::isfinite(vector.z))
            throw std::invalid_argument("eye, target and up must be finite");
    if (!std::isfinite(fov) || !std::isfinite(extent) || fov < 0 || extent < 0 || (fov > 0 && extent > 0))
        throw std::invalid_argument("invalid camera projection");
    if ((eye - target).length() < 1e-12)
        return {eye, {}, fov, extent};
    auto back = (eye - target).normalized();
    auto right = up.cross(back);
    if (right.length() < 1e-12)
        right = (std::abs(back.y) < .9 ? Vec3{0, 1, 0} : Vec3{1, 0, 0}).cross(back);
    right = right.normalized();
    return {eye, Quat::from_basis(right, back.cross(right), back).rotvec(), fov, extent};
}
struct CameraBasis {
    Vec3 right, up, backward;
};
inline CameraBasis camera_basis(Vec3 rotation, bool left_handed = false) {
    auto q = Quat::from_rotvec(rotation);
    return {q.rotate({left_handed ? -1. : 1., 0, 0}), q.rotate({0, 1, 0}), q.rotate({0, 0, 1})};
}
struct LookAt {
    Vec3 eye, target, up;
};
inline LookAt look_at_from_pose(const Pose &pose, double default_distance = 10,
                                std::optional<Vec3> pivot = {}) {
    auto q = Quat::from_rotvec(pose.r);
    const auto backward = q.rotate({0, 0, 1});
    const double distance = pivot ? std::max((pose.t - *pivot).dot(backward), .01) : default_distance;
    return {pose.t, pose.t - backward * distance, q.rotate({0, 1, 0})};
}
} // namespace openaxis
