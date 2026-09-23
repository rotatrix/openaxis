#pragma once
#include <stdexcept>
#include <string>
#include <regex>
#if defined(_WIN32)
#include <process.h>
#else
#include <unistd.h>
#endif

namespace openaxis {
inline std::string current_process_id() {
#if defined(__linux__)
    char buffer[128];
    auto size = ::readlink("/proc/self/ns/pid", buffer, sizeof(buffer));
    if (size <= 0 || size >= static_cast<ssize_t>(sizeof(buffer)))
        throw std::runtime_error("PID namespace unavailable");
    std::string ns(buffer, static_cast<std::size_t>(size));
    std::smatch match;
    if (!std::regex_match(ns, match, std::regex(R"(pid:\[([1-9][0-9]*)\])")))
        throw std::runtime_error("PID namespace unavailable");
    return match[1].str() + ":" + std::to_string(::getpid());
#elif defined(_WIN32)
    return std::to_string(::_getpid());
#elif defined(__APPLE__)
    return std::to_string(::getpid());
#else
    throw std::runtime_error("Unsupported process identity platform");
#endif
}
}
