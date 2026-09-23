#pragma once
#include "navigation_query.hpp"

namespace openaxis {
// Callbacks run on the client's application thread. Return true from a request
// callback after taking responsibility for its response. Unclaimed requests are
// answered unsupported. The client retains listeners until explicitly detached.
struct OpenAxisListener {
    virtual ~OpenAxisListener() = default;
    virtual void on_frame(const Frame &) {}
    virtual void on_buttons(std::int64_t) {}
    virtual void on_motion_start(std::int64_t) {}
    virtual void on_motion_end(std::int64_t) {}
    virtual void on_navigation_state(const NavigationState &) {}
    virtual void on_camera_pose(const CameraPose &) {}
    virtual void on_camera_pivot(const CameraPivot &) {}
    virtual void on_object_pose(const ObjectPose &) {}
    virtual void on_object_pivot(const ObjectPivot &) {}
    virtual void on_axes(const std::vector<std::string> &) {}
    virtual bool on_navigation_query(NavigationQuery) { return false; }
    virtual bool on_request(const Request &) { return false; }
    virtual void on_response(const Response &) {}
    virtual void on_extension(const std::string &, const Value &) {}
    virtual void on_state_change(ConnectionState) {}
    virtual void on_error(const std::string &, const std::string &) {}
};
} // namespace openaxis
