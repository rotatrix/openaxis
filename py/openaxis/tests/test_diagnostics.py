import datetime
import unittest

from openaxis.diagnostics import format_event, format_log_line


class DiagnosticsTest(unittest.TestCase):
    def test_formats_fact_as_prose_with_wire_name(self):
        self.assertEqual(
            format_event(
                "navigation.fact",
                fact="model.bounds",
                result="ok",
                value={
                    "min": (-1.6649999618, -0.6940374374, -0.007499963),
                    "max": (1.4941880703, 0.595210433, 1.239323497),
                },
                duration_ms=1.082,
                gesture=3,
                request=3,
            ),
            "  model.bounds — found (-1.665, -0.694, -0.007) … "
            "(1.494, 0.595, 1.239) · 1.082 ms",
        )

    def test_formats_selected_pivot_with_trailing_context(self):
        self.assertEqual(
            format_event(
                "navigation.pivot",
                source="query:pick.cursor",
                result="selected",
                point=(0.8999999762, 0.0005832684, 0.6752421856),
                client="Blender",
                request=38,
                gesture=43,
            ),
            "  pick.cursor — selected at (0.900, 0.001, 0.675) "
            "· Blender, gesture 43, request 38",
        )

    def test_formats_query_summary_with_wire_names(self):
        self.assertEqual(
            format_event(
                "navigation.query.complete",
                missing=("selection.bounds",),
                first="pick.cursor",
                duration_ms=2.0,
                gesture=3,
                request=3,
            ),
            "query complete — missing selection.bounds; first: pick.cursor "
            "· 2.000 ms · request 3",
        )

    def test_formats_local_timestamp_without_info_or_timezone(self):
        now = datetime.datetime(
            2026,
            9,
            4,
            11,
            56,
            59,
            321000,
            tzinfo=datetime.timezone(datetime.timedelta(hours=-4)),
        )
        self.assertEqual(
            format_log_line("motion started · gesture 3", "info", now=now),
            "2026-09-04 11:56:59.321  motion started · gesture 3",
        )
        self.assertEqual(
            format_log_line("motion canceled", "warn", now=now),
            "2026-09-04 11:56:59.321  WARN motion canceled",
        )
