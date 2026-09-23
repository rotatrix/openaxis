#include "diagnostic_view.hpp"
#include <imgui.h>
#include <sstream>

namespace {
ImU32 color(const std::string &tone, double opacity = 1) {
    auto &c = openaxis::diagnostic_colors().at(tone);
    return IM_COL32(c[0], c[1], c[2], int(255 * opacity));
}
ImVec2 pixel(const std::array<double, 2> &p) { return {float(p[0]), float(p[1])}; }
} // namespace
void render_navigation_overlay(const MyApplication &app,
                               const openaxis::DiagnosticPresentation &frame) {
    auto *draw = ImGui::GetBackgroundDrawList();
    draw->PushClipRect({0, 0}, {float(app.width), float(app.height)}, true);
    if (frame.context == "reference/" + std::to_string(app.generation)) {
        float y = 240;
        for (const auto &line : frame.lines) {
            draw->AddText({31, y + 1}, IM_COL32_BLACK, line.text.c_str());
            draw->AddText({30, y}, color(line.tone), line.text.c_str());
            y += 17;
        }
        for (auto &segment : frame.segments) {
            auto a = segment.start, b = segment.end;
            if (!app.clip_segment(a, b))
                continue;
            auto pa = app.project(a), pb = app.project(b);
            if (pa && pb)
                draw->AddLine(pixel(*pa), pixel(*pb), color(segment.tone, segment.opacity), float(segment.width));
        }
        for (auto &marker : frame.markers) {
            auto p = pixel(marker.point);
            auto c = color(marker.tone, .65);
            draw->AddLine({p.x - 9, p.y}, {p.x + 9, p.y}, IM_COL32_BLACK, 4);
            draw->AddLine({p.x, p.y - 9}, {p.x, p.y + 9}, IM_COL32_BLACK, 4);
            draw->AddLine({p.x - 9, p.y}, {p.x + 9, p.y}, c, 2);
            draw->AddLine({p.x, p.y - 9}, {p.x, p.y + 9}, c, 2);
            std::istringstream labels(marker.label);
            std::string label;
            float y = p.y - 8;
            while (std::getline(labels, label)) {
                draw->AddText({p.x + 13, y + 1}, IM_COL32_BLACK, label.c_str());
                draw->AddText({p.x + 12, y}, c, label.c_str());
                y += 15;
            }
        }
    }
    // Pivots are drawn against scene depth in MyApplication::render().
    draw->PopClipRect();
}
