#pragma once
#include "version.hpp"
// Optional, header-only local logging. No transport dependency.
#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iomanip>
#include <memory>
#include <map>
#include <optional>
#include <cctype>
#include <mutex>
#include <regex>
#include <set>
#include <sstream>
#include <string>
#include <vector>
#include <tuple>
#include <fcntl.h>
#ifdef _WIN32
#include <io.h>
#include <share.h>
#include <sys/stat.h>
#else
#include <unistd.h>
#endif

namespace openaxis {
class DiagnosticLog {
    using Path = std::filesystem::path;
    inline static std::recursive_mutex registry_;
    inline static std::map<std::string, std::shared_ptr<DiagnosticLog>> configured_;
    inline static std::shared_ptr<DiagnosticLog> current_;
    std::mutex gate_;
    Path path_;
    bool closed_ = false;
    std::string error_;
    std::uintmax_t max_bytes_;
    std::string header_;
    static std::string env(const char *name) {
#ifdef _WIN32
        char *value = nullptr;
        std::size_t size = 0;
        const auto result = _dupenv_s(&value, &size, name);
        std::unique_ptr<char, decltype(&std::free)> owned(value, &std::free);
        return result == 0 && owned ? std::string(owned.get()) : "";
#else
        auto p = std::getenv(name);
        return p ? p : "";
#endif
    }
    static int open_file(const Path &p, bool create) {
#ifdef _WIN32
        int fd = -1;
        const auto result = _wsopen_s(&fd, p.c_str(),
            _O_RDWR | _O_BINARY | (create ? _O_CREAT | _O_EXCL : 0),
            _SH_DENYNO, _S_IREAD | _S_IWRITE);
        return result == 0 ? fd : -1;
#else
        return ::open(p.c_str(), O_RDWR | (create ? O_CREAT | O_EXCL : 0), 0600);
#endif
    }
    static void close_file(int fd) {
#ifdef _WIN32
        _close(fd);
#else
        ::close(fd);
#endif
    }
    static std::string timestamp(const char *format) {
        auto now = std::time(nullptr); std::tm tm{};
#ifdef _WIN32
        gmtime_s(&tm, &now);
#else
        gmtime_r(&now, &tm);
#endif
        std::ostringstream out; out << std::put_time(&tm, format); return out.str();
    }
    static void cleanup(const Path &directory, const std::string &client, std::size_t keep, const Path &current) {
        std::vector<Path> files;
        std::regex pattern(client + "-[0-9]{8}T[0-9]{6}Z(-([2-9]|[1-9][0-9]+))?\\.log");
        for (const auto &entry : std::filesystem::directory_iterator(directory))
            if (!entry.is_symlink() && entry.is_regular_file() && std::regex_match(entry.path().filename().string(), pattern))
                files.push_back(entry.path());
        std::sort(files.begin(), files.end(), [](const Path &a, const Path &b) {
            auto key = [](const Path &p) {
                std::smatch m; auto name = p.filename().string();
                std::regex_search(name, m, std::regex("([0-9]{8}T[0-9]{6}Z)(-([0-9]+))?\\.log$"));
                auto suffix = m[3].str();
                return std::make_tuple(m[1].str(), suffix.size(), suffix);
            };
            return key(a) > key(b);
        });
        std::size_t retained = 1;
        for (auto &path : files) {
            if (path == current) continue;
            if (++retained > std::max<std::size_t>(1, keep)) {
                std::error_code error;
                std::filesystem::remove(path, error);
                if (!error) { Path backup = path; backup += ".1"; std::filesystem::remove(backup, error); }
            }
        }
    }
  public:
    using Sink = std::function<void(const std::string &, const std::string &)>;
    bool debug = false;
    std::vector<Sink> sinks;
    Sink sink; // Optional console/UI mirror; called after releasing the file mutex.
    static Path default_directory() {
        if (auto custom = env("ROTATRIX_LOG_DIR"); !custom.empty()) return custom;
#ifdef _WIN32
        auto root = env("LOCALAPPDATA");
        if (root.empty()) root = env("USERPROFILE") + "/AppData/Local";
#elif defined(__APPLE__)
        auto root = env("HOME") + "/Library/Application Support";
#else
        auto root = env("XDG_DATA_HOME");
        if (root.empty()) root = env("HOME") + "/.local/share";
#endif
        return Path(root) / "Rotatrix" / "logs";
    }
    explicit DiagnosticLog(const std::string &client, Path directory = {}, std::uintmax_t max_bytes = 5*1024*1024, std::size_t keep = 10, const std::string &client_version = "unknown")
        : max_bytes_(max_bytes) {
        if (!std::regex_match(client, std::regex("[a-z0-9][a-z0-9_-]*")) || !max_bytes)
            throw std::invalid_argument("Invalid diagnostic log options");
        try {
            if (directory.empty()) directory = default_directory();
            directory = std::filesystem::absolute(directory);
            std::filesystem::create_directories(directory);
            header_ = format_record("info", std::string("OpenAxis SDK ") + sdk_version + " (C++); client=" + client + "; client_version=" + client_version);
            auto stem = client + "-" + timestamp("%Y%m%dT%H%M%SZ");
            std::lock_guard<std::recursive_mutex> guard(registry_);
            int first = 1;
            std::regex same_session(stem + "(-([0-9]+))?\\.log");
            for (const auto &entry : std::filesystem::directory_iterator(directory)) {
                std::smatch match; auto name = entry.path().filename().string();
                if (std::regex_match(name, match, same_session))
                    first = std::max(first, (match[2].matched ? std::stoi(match[2].str()) : 1) + 1);
            }
            for (int index = first; index < first + 10000; ++index) {
                auto path = directory / (stem + (index == 1 ? "" : "-" + std::to_string(index)) + ".log");
                int log = open_file(path, true);
                if (log < 0) { if (std::filesystem::exists(path)) continue; break; }
                close_file(log); path_ = path; break;
            }
            if (!path_.empty()) {
                std::ofstream out(path_, std::ios::binary | std::ios::app);
                out.exceptions(std::ios::failbit | std::ios::badbit);
                out << header_; out.flush();
                cleanup(directory, client, keep, path_);
            }
            if (path_.empty()) error_ = "Cannot create log session";
        } catch (const std::exception &e) { error_ = e.what(); }
    }
    DiagnosticLog(const DiagnosticLog &) = delete;
    ~DiagnosticLog() { close(); }
    void close() {
        std::lock_guard<std::mutex> writing(gate_);
        closed_ = true;
    }
    std::string error() { std::lock_guard<std::mutex> guard(gate_); return error_; }
    static std::string normalize_level(std::string level) {
        for (auto &c : level) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        if (level == "warn") return "warning";
        if (level == "critical") return "error";
        if (level == "debug" || level == "warning" || level == "error") return level;
        return "info";
    }
    static std::string format_record(std::string level, std::string message,
        std::chrono::system_clock::time_point now = std::chrono::system_clock::now(),
        std::optional<int> offset_minutes = std::nullopt) {
        level = normalize_level(level);
        for (auto &c : level) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
        static const std::regex ansi("\\x1b\\[[0-?]*[ -/]*[@-~]");
        message = std::regex_replace(message, ansi, "");
        std::string text;
        for (std::size_t i = 0; i < message.size(); ++i) {
            if (message[i] == '\r') { text += "\n    "; if (i + 1 < message.size() && message[i+1] == '\n') ++i; }
            else if (message[i] == '\n') text += "\n    ";
            else text += message[i];
        }
        auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()).count();
        auto seconds = ms / 1000; auto fraction = ms % 1000;
        if (fraction < 0) { --seconds; fraction += 1000; }
        std::time_t t = static_cast<std::time_t>(seconds); std::tm tm{};
        if (!offset_minutes) {
#ifdef _WIN32
            localtime_s(&tm, &t);
            offset_minutes = static_cast<int>((_mkgmtime(&tm) - t) / 60);
#else
            localtime_r(&t, &tm);
            offset_minutes = static_cast<int>(tm.tm_gmtoff / 60);
#endif
        }
        t += *offset_minutes * 60;
#ifdef _WIN32
        gmtime_s(&tm, &t);
#else
        gmtime_r(&t, &tm);
#endif
        auto offset = std::abs(*offset_minutes);
        std::ostringstream out;
        out << std::put_time(&tm, "%Y-%m-%d %H:%M:%S") << '.' << std::setfill('0') << std::setw(3) << fraction
            << ' ' << (*offset_minutes < 0 ? '-' : '+') << std::setw(2) << offset / 60 << ':' << std::setw(2) << offset % 60
            << ' ' << level << ' ' << text << '\n';
        return out.str();
    }
    const Path &path() const { return path_; }
    void write(const std::string &input_level, const std::string &message) noexcept {
        auto level = normalize_level(input_level);
        if (level == "debug" && !debug) return;
        try {
            auto line = format_record(level, message);
            {
                std::lock_guard<std::mutex> guard(gate_);
                if (closed_) return;
                if (!path_.empty()) {
                    auto size = std::filesystem::file_size(path_);
                    if (size > header_.size() && size + line.size() > max_bytes_) {
                        Path backup = path_; backup += ".1";
                        std::filesystem::remove(backup); std::filesystem::rename(path_, backup); size = 0;
                    }
                    std::ofstream out(path_, std::ios::binary | std::ios::app);
                    out.exceptions(std::ios::failbit | std::ios::badbit);
                    if (!size) out << header_;
                    out << line; out.flush(); error_.clear();
                }
            }
        } catch (const std::exception &e) {
            std::lock_guard<std::mutex> guard(gate_); error_ = e.what();
        }
        try { if (sink) sink(level, message); } catch (...) { }
        for (const auto &observer : sinks) try { observer(level, message); } catch (...) { }
    }
    static std::shared_ptr<DiagnosticLog> configure(const std::string &client, Path directory = {}, const std::string &client_version = "unknown") {
        std::lock_guard<std::recursive_mutex> guard(registry_);
        auto &entry = configured_[client];
        if (!entry || entry->closed_) entry = std::make_shared<DiagnosticLog>(client, directory, 5*1024*1024, 10, client_version);
        current_ = entry;
        return current_;
    }
    static void emit(const std::string &level, const std::string &message) noexcept {
        std::shared_ptr<DiagnosticLog> log;
        { std::lock_guard<std::recursive_mutex> guard(registry_); log = current_; }
        if (log) log->write(level, message);
    }
};
} // namespace openaxis
