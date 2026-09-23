import unittest

from openaxis.navigation import UNAVAILABLE, NavigationQuery
from openaxis.types import Request


class NavigationQueryTest(unittest.TestCase):
    def test_evaluates_values_then_short_circuits_first(self):
        query = NavigationQuery.from_request(
            Request(
                id=4,
                method="navigation.query",
                params={
                    "gesture_id": 8,
                    "values": ["camera.pose", "selection.bounds"],
                    "first": [
                        "pick.cursor.selection",
                        "pick.viewport_center.selection",
                        "pick.cursor",
                    ],
                },
            )
        )
        calls: list[str] = []
        available = {
            "camera.pose": {"t": [0, 0, 0]},
            "selection.bounds": {"min": [0, 0, 0], "max": [2, 2, 2]},
            "pick.viewport_center.selection": {"point": [1, 1, 1]},
            "pick.cursor": {"point": [9, 9, 9]},
        }

        def resolve(name: str):
            calls.append(name)
            return available.get(name, UNAVAILABLE)

        self.assertEqual(
            query.evaluate(resolve),
            {
                "values": {
                    "camera.pose": {"t": [0, 0, 0]},
                    "selection.bounds": {"min": [0, 0, 0], "max": [2, 2, 2]},
                },
                "first": {
                    "name": "pick.viewport_center.selection",
                    "value": {"point": [1, 1, 1]},
                },
            },
        )
        self.assertEqual(
            calls,
            [
                "camera.pose",
                "selection.bounds",
                "pick.cursor.selection",
                "pick.viewport_center.selection",
            ],
        )

    def test_memoizes_duplicate_names_within_request(self):
        query = NavigationQuery.from_request(
            Request(
                id=5,
                method="navigation.query",
                params={"values": ["pick.cursor"], "first": ["pick.cursor"]},
            )
        )
        calls = 0

        def resolve(_name: str):
            nonlocal calls
            calls += 1
            return {"point": [1, 2, 3]}

        result = query.evaluate(resolve)
        self.assertEqual(calls, 1)
        self.assertEqual(result["first"]["name"], "pick.cursor")

    def test_included_empty_first_returns_null(self):
        query = NavigationQuery.from_request(
            Request(
                id=6,
                method="navigation.query",
                params={"first": []},
            )
        )
        self.assertEqual(query.evaluate(lambda _name: UNAVAILABLE), {"values": {}, "first": None})

    def test_omitted_first_stays_omitted(self):
        query = NavigationQuery.from_request(Request(id=7, method="navigation.query", params={}))
        self.assertEqual(query.evaluate(lambda _name: None), {"values": {}})
        self.assertFalse(query.scoped)

    def test_validates_query_shape(self):
        bad_requests = [
            Request(id=1, method="other.method"),
            Request(id=1, method="navigation.query", params={"gesture_id": True}),
            Request(id=1, method="navigation.query", params={"values": "camera.pose"}),
            Request(id=1, method="navigation.query", params={"first": [""]}),
        ]
        for request in bad_requests:
            with self.subTest(request=request), self.assertRaises(ValueError):
                NavigationQuery.from_request(request)

    def test_completion_is_exactly_once(self):
        completed = []
        query = NavigationQuery.from_request(
            Request(id=8, method="navigation.query"),
            complete_callback=completed.append,
        )
        query.complete({"values": {}})
        self.assertEqual(completed, [{"values": {}}])
        with self.assertRaises(RuntimeError):
            query.complete({"values": {}})


class AsyncNavigationQueryTest(unittest.IsolatedAsyncioTestCase):
    async def test_evaluates_values_then_short_circuits_first(self):
        query = NavigationQuery.from_request(
            Request(
                id=9,
                method="navigation.query",
                params={
                    "values": ["camera.pose", "pick.cursor"],
                    "first": ["pick.cursor", "pick.viewport_center"],
                },
            )
        )
        calls: list[str] = []
        available = {
            "camera.pose": {"t": [0, 0, 0]},
            "pick.cursor": {"point": [1, 2, 3]},
            "pick.viewport_center": {"point": [9, 9, 9]},
        }

        async def resolve(name: str):
            calls.append(name)
            return available.get(name, UNAVAILABLE)

        self.assertEqual(
            await query.evaluate_async(resolve),
            {
                "values": {
                    "camera.pose": {"t": [0, 0, 0]},
                    "pick.cursor": {"point": [1, 2, 3]},
                },
                "first": {
                    "name": "pick.cursor",
                    "value": {"point": [1, 2, 3]},
                },
            },
        )
        self.assertEqual(calls, ["camera.pose", "pick.cursor"])

    async def test_unavailable_candidates_are_awaited_in_order(self):
        query = NavigationQuery.from_request(
            Request(
                id=10,
                method="navigation.query",
                params={"first": ["pick.cursor", "pick.viewport_center", "model.bounds"]},
            )
        )
        calls: list[str] = []

        async def resolve(name: str):
            calls.append(name)
            if name == "pick.viewport_center":
                return {"point": [4, 5, 6]}
            return UNAVAILABLE

        self.assertEqual(
            await query.evaluate_async(resolve),
            {
                "values": {},
                "first": {
                    "name": "pick.viewport_center",
                    "value": {"point": [4, 5, 6]},
                },
            },
        )
        self.assertEqual(calls, ["pick.cursor", "pick.viewport_center"])


if __name__ == "__main__":
    unittest.main()
