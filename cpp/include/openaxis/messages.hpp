#pragma once
#include <vector>
#include "protocol.hpp"

namespace openaxis {
enum class ConnectionState { Disconnected, Connecting, Connected, Disconnecting };
struct Frame {
    std::int64_t seq, t_us;
    std::vector<double> values;
};
struct Request {
    std::int64_t id;
    std::string method;
    Value params = Value::object();
};
struct Response {
    std::int64_t id;
    Value result, error;
};
struct NavigationPose : Pose {
    std::int64_t gesture_id;
    std::optional<std::int64_t> seq, applied_delta_id;
};
struct CameraPose : NavigationPose {};
struct ObjectPose : NavigationPose {};
struct CameraPivot { std::int64_t gesture_id; Vec3 point; };
struct ObjectPivot { std::int64_t gesture_id; Vec3 point; };
struct CameraNavigationState {
    std::string mode;
    std::optional<bool> lock_roll, lock_translation_plane;
    std::optional<double> translation_scale;
};
struct ObjectNavigationState { bool allow_translation, allow_rotation; };
struct NavigationState {
    std::int64_t gesture_id;
    std::optional<CameraNavigationState> camera;
    std::optional<ObjectNavigationState> object;
};
inline Value message_value(const Request &v) {
    return {{"type", "request"}, {"id", v.id}, {"method", v.method}, {"params", v.params}};
}
template <class T> Value pose_message_value(const T &v, const char *type) {
    auto result = pose_value(v);
    result["type"] = type;
    result["gesture_id"] = v.gesture_id;
    if (v.seq) result["seq"] = *v.seq;
    if (v.applied_delta_id) result["applied_delta_id"] = *v.applied_delta_id;
    return result;
}
inline Value message_value(const CameraPose &v) { return pose_message_value(v, "camera.pose"); }
inline Value message_value(const ObjectPose &v) { return pose_message_value(v, "object.pose"); }
inline Value message_value(const CameraPivot &v) {
    return {{"type", "camera.pivot"}, {"gesture_id", v.gesture_id}, {"point", vector_value(v.point)}};
}
inline Value message_value(const ObjectPivot &v) {
    return {{"type", "object.pivot"}, {"gesture_id", v.gesture_id}, {"point", vector_value(v.point)}};
}
inline Value message_value(const NavigationState &v) {
    Value result = {{"type", "navigation.state"}, {"gesture_id", v.gesture_id}};
    if (v.camera) {
        auto &camera = result["camera"];
        camera = {{"mode", v.camera->mode}};
        if (v.camera->lock_roll) camera["lock_roll"] = *v.camera->lock_roll;
        if (v.camera->lock_translation_plane) camera["lock_translation_plane"] = *v.camera->lock_translation_plane;
        if (v.camera->translation_scale) camera["translation_scale"] = *v.camera->translation_scale;
    }
    if (v.object) result["object"] = {{"allow_translation", v.object->allow_translation}, {"allow_rotation", v.object->allow_rotation}};
    return result;
}
} // namespace openaxis
