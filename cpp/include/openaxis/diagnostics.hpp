#pragma once
#include "protocol.hpp"
#include <array>
#include <functional>
#include <map>
#include <vector>

namespace openaxis {
struct PoseDifference {
    Vec3 t, r;
    double scale = 1;
    bool changed = false, rebase = false;
};
// The coordinator and diagnostic readback use the same comparison policy.
struct ComparisonOptions {
    double absolute = 1e-7, relative = 1e-9, angular = 1e-7, projection = 1e-7;
};
PoseDifference compare_poses(const Pose &, const Pose &, ComparisonOptions = {});
PoseDifference compare_object_poses(const Pose &, const Pose &, ComparisonOptions = {});
struct DiagnosticLine {
    std::string text, tone;
};
struct DiagnosticSegment {
    Vec3 start, end;
    std::string tone;
    double width = 2;
    double opacity = 1; // Candidate emphasis does not imply server selection.
};
struct DiagnosticMarker {
    std::string label;
    std::array<double, 2> point;
    std::string tone;
};
struct DiagnosticPresentation {
    std::string context;
    std::vector<DiagnosticLine> lines;
    std::vector<DiagnosticSegment> segments;
    std::vector<DiagnosticMarker> markers;
    std::uint64_t revision = 0;
    std::optional<double> expires_at;
};
struct DiagnosticHistoryEntry {
    double time;
    std::string level, message;
};
struct PickEvidence {
    std::optional<std::array<double, 2>> screen;
    std::optional<std::array<Vec3, 2>> ray;
};
struct DiagnosticOptions {
    bool enabled = false, debug = false;
    std::size_t history_limit = 30;
    double retention = 1;
    std::function<double()> clock;
    std::function<void(const std::string &, const std::string &)> log;
};
const std::map<std::string, std::array<int, 3>> &diagnostic_colors();
double diagnostic_time();
// Passive, detached evidence. All methods belong to the application thread.
// The collector must outlive a session that refers to it.
class NavigationDiagnostics {
  public:
    using Comparison = std::function<PoseDifference(const Pose &, const Pose &)>;
    explicit NavigationDiagnostics(DiagnosticOptions options = {});
    void bind(Comparison camera = {}, Comparison object = {});
    void set_enabled(bool);
    bool enabled() const { return options_.enabled; }
    void clear() noexcept;
    void set_context(const std::string &) noexcept;
    void observe(const std::string &event, const Value &values = {}) noexcept;
    void pick(std::int64_t request, const std::string &name, const PickEvidence &) noexcept;
    void pick(const std::string &name, const PickEvidence &) noexcept;
    DiagnosticPresentation presentation() const;
    std::vector<DiagnosticHistoryEntry> history() const { return history_; }
    std::function<void()> on_changed;

  private:
    struct Fact {
        Value value;
        double duration = 0;
        std::string error;
    };
    struct Query {
        std::int64_t id = 0;
        std::optional<std::int64_t> gesture;
        std::vector<std::string> values, first, order, pick_order;
        std::map<std::string, Fact> facts;
        std::map<std::string, PickEvidence> picks;
        std::string context, selected, error;
        double duration = 0;
        bool complete = false;
    };
    struct Correction {
        std::int64_t id;
        std::string state;
        std::optional<double> until;
    };
    DiagnosticOptions options_;
    Comparison compare_camera_, compare_object_;
    std::uint64_t revision_ = 0;
    std::optional<Query> query_;
    std::string context_, status_;
    std::vector<DiagnosticHistoryEntry> history_;
    std::map<std::string, DiagnosticLine> writes_;
    std::map<std::string, Correction> corrections_;
    std::map<std::string, std::string> logged_corrections_;
    std::map<std::string, bool> unknown_;
    void touch() noexcept;
    void log(std::string level, std::string message, bool retain = true);
    void consume(const std::string &, const Value &);
};
} // namespace openaxis
