#pragma once
#include "application.hpp"
#include <openaxis/diagnostics.hpp>
// Native renderer only: all rows, colors and evidence come from the SDK.
void render_navigation_overlay(const MyApplication &, const openaxis::DiagnosticPresentation &);
