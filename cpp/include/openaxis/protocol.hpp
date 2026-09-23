#pragma once
#include "geometry.hpp"
#include <cstdint>
#include <regex>
#include <nlohmann/json.hpp>

namespace openaxis {
using Value = nlohmann::json;
inline constexpr std::int64_t max_integer = 9007199254740991LL;
inline Value vector_value(Vec3 v) { return Value::array({v.x, v.y, v.z}); }
inline Vec3 vector_from(const Value &v) {
    if (!v.is_array() || v.size() != 3)
        throw std::invalid_argument("expected vec3");
    for (const auto &component : v)
        if (!component.is_number())
            throw std::invalid_argument("expected numeric vec3 components");
    Vec3 r{v.at(0).get<double>(), v.at(1).get<double>(), v.at(2).get<double>()};
    if (!std::isfinite(r.x) || !std::isfinite(r.y) || !std::isfinite(r.z))
        throw std::invalid_argument("non-finite vec3");
    return r;
}
inline Value pose_value(const Pose &p) {
    Value v = {{"t", vector_value(p.t)}, {"r", vector_value(p.r)}};
    if (p.fov > 0)
        v["fov"] = p.fov;
    if (p.ortho_extent > 0)
        v["ortho_extent"] = p.ortho_extent;
    return v;
}
inline Pose pose_from(const Value &v, bool camera) {
    Pose p{vector_from(v.at("t")), vector_from(v.at("r"))};
    if (camera) {
        if (v.contains("fov") == v.contains("ortho_extent"))
            throw std::invalid_argument("camera needs exactly one projection");
        if (v.contains("fov")) {
            if (!v.at("fov").is_number()) throw std::invalid_argument("invalid fov");
            p.fov = v.at("fov").get<double>();
            if (!std::isfinite(p.fov) || p.fov <= 0)
                throw std::invalid_argument("invalid fov");
        } else {
            if (!v.at("ortho_extent").is_number()) throw std::invalid_argument("invalid extent");
            p.ortho_extent = v.at("ortho_extent").get<double>();
            if (!std::isfinite(p.ortho_extent) || p.ortho_extent <= 0)
                throw std::invalid_argument("invalid extent");
        }
    } else if (v.contains("fov") || v.contains("ortho_extent") || v.contains("ortho_extent_scale"))
        throw std::invalid_argument("object projection");
    return p;
}
inline std::int64_t integer(const Value &v) {
    if (!v.is_number_integer() || (v.is_number_unsigned() && v.get<std::uint64_t>() > max_integer) ||
        (!v.is_number_unsigned() && (v.get<std::int64_t>() < 0 || v.get<std::int64_t>() > max_integer)))
        throw std::invalid_argument("expected integer from 0 through 9007199254740991");
    return v.get<std::int64_t>();
}
inline void validate_message(const Value &m, bool incoming = false) {
    if (!m.is_object() || !m.contains("type") || !m["type"].is_string())
        throw std::invalid_argument("expected message map/type");
    const auto type = m["type"].get<std::string>();
    if (type.empty())
        throw std::invalid_argument("empty message type");
    auto strings = [](const Value &v) {
        if (!v.is_array())
            throw std::invalid_argument("expected string array");
        for (const auto &n : v)
            if (!n.is_string() || n.get<std::string>().empty())
                throw std::invalid_argument("expected string");
    };
    auto positive = [](const Value &v) {
        if (!v.is_number() || !std::isfinite(v.get<double>()) || v.get<double>() <= 0)
            throw std::invalid_argument("expected positive finite number");
    };
    if (type == "camera.pose" || type == "object.pose") {
        integer(m.at("gesture_id"));
        if (incoming || m.contains("seq"))
            integer(m.at("seq"));
        pose_from(m, type == "camera.pose");
        if (m.contains("applied_delta_id") && integer(m["applied_delta_id"]) < 0)
            throw std::invalid_argument("negative acknowledgement");
    } else if (type == "camera.delta" || type == "object.delta") {
        if (type == "object.delta" && (m.contains("fov") || m.contains("ortho_extent") || m.contains("ortho_extent_scale")))
            throw std::invalid_argument("object projection");
        integer(m.at("gesture_id"));
        vector_from(m.at("t"));
        vector_from(m.at("r"));
        if (m.contains("delta_id") && integer(m["delta_id"]) < 0)
            throw std::invalid_argument("negative delta ID");
        if (m.contains("ortho_extent_scale")) {
            if (type == "object.delta")
                throw std::invalid_argument("object scale");
            positive(m["ortho_extent_scale"]);
        }
    } else if (type == "motion_start" || type == "motion_end" || type == "motion_cancel" ||
               type == "navigation.state" || type == "camera.pivot" || type == "object.pivot") {
        integer(m.at("gesture_id"));
        if (type == "motion_cancel" && m.contains("reason") && !m["reason"].is_string())
            throw std::invalid_argument("invalid cancellation reason");
        if (type == "camera.pivot" || type == "object.pivot")
            vector_from(m.at("point"));
        if (type == "navigation.state") {
            if (!m.contains("camera") && !m.contains("object"))
                throw std::invalid_argument("empty navigation state");
            if (m.contains("camera")) {
                const auto &c = m["camera"];
                auto mode = c.at("mode").get<std::string>();
                if (mode != "orbit" && mode != "free_camera")
                    throw std::invalid_argument("unknown camera mode");
                if (mode == "orbit" &&
                    (c.contains("lock_roll") || c.contains("lock_translation_plane") ||
                     c.contains("translation_scale")))
                    throw std::invalid_argument("orbit constraints");
                if (mode == "free_camera" && (!c.at("lock_roll").is_boolean() ||
                                              !c.at("lock_translation_plane").is_boolean()))
                    throw std::invalid_argument("invalid camera constraints");
                if (c.contains("translation_scale"))
                    positive(c["translation_scale"]);
            }
            if (m.contains("object") && (!m["object"].at("allow_translation").is_boolean() ||
                                         !m["object"].at("allow_rotation").is_boolean()))
                throw std::invalid_argument("invalid object constraints");
        }
    } else if (type == "request") {
        integer(m.at("id"));
        if (!m.at("method").is_string() || m.at("method").get<std::string>().empty() ||
            (m.contains("params") && !m.at("params").is_object()))
            throw std::invalid_argument("invalid RPC");
        if (m["method"] == "navigation.query" && m.contains("params")) {
            const auto &p = m["params"];
            if (p.contains("gesture_id"))
                integer(p["gesture_id"]);
            for (auto key : {"values", "first"})
                if (p.contains(key)) {
                    if (!p[key].is_array())
                        throw std::invalid_argument("invalid fact list");
                    for (const auto &n : p[key])
                        if (!n.is_string())
                            throw std::invalid_argument("invalid fact name");
                }
        }
    } else if (type == "response") {
        integer(m.at("id"));
        if (m.contains("result") == m.contains("error"))
            throw std::invalid_argument("invalid response");
        if (m.contains("result") && !m["result"].is_object())
            throw std::invalid_argument("expected response result map");
        if (m.contains("error")) {
            const auto &error = m["error"];
            if (!error.is_object() || !error.at("code").is_string() || error.at("code").get<std::string>().empty() ||
                (error.contains("message") && !error["message"].is_string()))
                throw std::invalid_argument("invalid response error");
        }
    } else if (type == "hello" || type == "hello_ack") {
        auto diagnostic_string = [](const Value &v) {
            if (!v.is_string() || v.get<std::string>().find_first_not_of(" \t\r\n\f\v") == std::string::npos)
                throw std::invalid_argument("expected non-empty diagnostic string");
        };
        if (type == "hello") {
            if (m.contains("client_version")) diagnostic_string(m["client_version"]);
            if (m.contains("sdk")) {
                const auto &sdk = m["sdk"];
                if (!sdk.is_object()) throw std::invalid_argument("hello.sdk must be a map");
                diagnostic_string(sdk.at("name"));
                diagnostic_string(sdk.at("version"));
            }
        }
        if (m.at("proto") != "openaxis/1.0")
            throw std::invalid_argument("unsupported protocol");
        const auto &name = m.at(type == "hello" ? "client_name" : "server_name");
        if (!name.is_string() || name.get<std::string>().empty())
            throw std::invalid_argument("invalid peer name");
        if (type == "hello" && m.contains("target")) {
            const auto &t = m["target"];
            if (!t.is_object() || (!t.contains("pid") && !t.contains("app")))
                throw std::invalid_argument("empty target");
            if (t.contains("pid") && (!t["pid"].is_string() || !std::regex_match(t["pid"].get<std::string>(), std::regex(R"([1-9][0-9]*(?::[1-9][0-9]*)?)"))))
                throw std::invalid_argument("invalid PID");
            if (t.contains("app") && (!t["app"].is_string() || t["app"].get<std::string>().empty()))
                throw std::invalid_argument("invalid app");
            if (t.contains("app_version")) diagnostic_string(t["app_version"]);
        }
    } else if (type == "buttons") {
        integer(m.at("buttons"));
    } else if (type == "error") {
        if (!m.at("code").is_string() || m.at("code").get<std::string>().empty() ||
            !m.at("message").is_string())
            throw std::invalid_argument("invalid error message");
    } else if (type == "focus") {
        if (!m.at("focused").is_boolean())
            throw std::invalid_argument("invalid focus");
    } else if (type == "tags")
        strings(m.at("tags"));
    else if (type == "capabilities")
        strings(m.at("capabilities"));
    else if (type == "subscribe" || type == "axes")
        strings(m.at("axes"));
    else if (type == "frame") {
        integer(m.at("seq"));
        integer(m.at("t_us"));
        if (!m.at("values").is_array())
            throw std::invalid_argument("invalid axis frame");
        for (const auto &v : m["values"])
            if (!v.is_number() || !std::isfinite(v.get<double>()))
                throw std::invalid_argument("invalid axis value");
    }
}
// markerPosition is local renderer metadata. Marker-only picks are tested misses.
inline Value wire_fact_value(const std::string &name, Value value) {
    if ((name == "pick.cursor" || name == "pick.viewport_center" || name == "pick.cursor.selection" || name == "pick.viewport_center.selection") && value.is_object()) {
        value.erase("markerPosition");
        if (!value.contains("point") || value["point"].is_null()) return nullptr;
    }
    return value;
}
// A null fact is unavailable. The cache also memoizes unavailable results.
template <class Resolver> Value evaluate_query(const Value &params, Resolver resolve) {
    Value cache = Value::object(), result = {{"values", Value::object()}};
    auto get = [&](const std::string &name) -> Value {
        if (!cache.contains(name))
            cache[name] = wire_fact_value(name, resolve(name));
        return cache[name];
    };
    for (const auto &n : params.value("values", Value::array())) {
        auto name = n.template get<std::string>();
        auto v = get(name);
        if (!v.is_null())
            result["values"][name] = v;
    }
    if (params.contains("first")) {
        result["first"] = nullptr;
        for (const auto &n : params["first"]) {
            auto name = n.template get<std::string>();
            auto v = get(name);
            if (!v.is_null()) {
                result["first"] = {{"name", name}, {"value", v}};
                break;
            }
        }
    }
    return result;
}
} // namespace openaxis
